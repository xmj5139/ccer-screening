/**
 * 40-v2-pdf-parse.test.mjs —— 统一异步 PDF 解析（docs/36 第 2、3、5 条）真实回归
 * ============================================================================
 * 用**真实生成的 PDF 文件**（本机 poppler: pdfinfo / pdftotext 真跑）验证：
 *   1. 文字页 / 扫描页（无文本层）/ 混合页三种真实形态；
 *   2. **缺页不判全文**：只要有一页没有可用正文就是 partial，不用整篇字数阈值掩盖；
 *   3. 逐页判断缺文字 / 乱码（(cid:…) 占位、替换符比例、过短页）；
 *   4. OCR 缓存按「原件 SHA-256 + 页码 + 解析版本」命中，**不重复计费**；
 *   5. quota / timeout 中止时**没有任何残留写**（不写页缓存、不写整篇结果 JSON）；
 *   6. OCR 未配置时诚实失败，**不影响已有的可读页**；
 *   7. 解析结果 JSON 记录 hash / parser / 版本 / 哪些页成功 / 失败原因与时间。
 *
 * OCR 部分打到本机 HTTP stub（127.0.0.1），不访问真实百度接口、不产生真实计费。
 */
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  setupV2, test, testAsync, assert, assertEqual, assertIncludes, assertNotIncludes, finish,
} from './v2-helpers.mjs';

const ctx = await setupV2();
const { db, dbPath } = ctx;

console.log('\n[v2-40] 统一异步 PDF 解析：逐页判定 / 缺页不 full / 缓存不重复计费 / 中止无残留写');

/* ==================================================================== */
/*  1) 真实 PDF 生成（含文字页与无文本层的扫描页）                        */
/* ==================================================================== */

const esc = (s) => String(s).replace(/([\\()])/g, '\\$1');

/**
 * 生成一个结构完整、可被 pdfinfo/pdftotext 正常读取的 PDF。
 *
 * 说明：页面用 Helvetica 基础字体，只能承载 Latin-1 字符；因此文字页使用 ASCII
 * 正文（中文需要嵌入 CJK 字体，属于另一条渲染链路）。本文件验证的是**逐页文本层
 * 判定与 OCR 编排**，与字符集无关；中文正文的链路在 41/42 与既有 CEA 用例中覆盖。
 *
 * @param {Array<{text?:string|null}>} pages text 为字符串 → 文字页；null/省略 → 无文本层（模拟扫描页）
 */
function buildPdf(pages) {
  const objects = [];
  const pageObjNums = pages.map((_, i) => 4 + i * 2);
  const fontNum = 3;
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = `<< /Type /Pages /Kids [${pageObjNums.map((n) => `${n} 0 R`).join(' ')}] /Count ${pages.length} >>`;
  objects[fontNum] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  pages.forEach((p, i) => {
    const pageNum = 4 + i * 2;
    const contentNum = 5 + i * 2;
    const hasText = typeof p.text === 'string' && p.text.length > 0;
    objects[pageNum] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 420 200] ` +
      `/Resources << ${hasText ? `/Font << /F1 ${fontNum} 0 R >>` : ''} >> /Contents ${contentNum} 0 R >>`;
    const stream = hasText
      ? `BT /F1 11 Tf 14 170 Td ${p.text.split('\n').map((line, k) => `${k ? '0 -16 Td ' : ''}(${esc(line)}) Tj`).join(' ')} ET`
      : '0.25 0.25 0.25 rg 12 12 396 176 re f'; // 纯图形页：没有任何文本层
    objects[contentNum] = `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`;
  });

  let pdf = '%PDF-1.4\n';
  const offsets = [];
  for (let n = 1; n < objects.length; n += 1) {
    if (!objects[n]) continue;
    offsets[n] = pdf.length;
    pdf += `${n} 0 obj\n${objects[n]}\nendobj\n`;
  }
  const maxNum = objects.length;
  const xrefStart = pdf.length;
  pdf += `xref\n0 ${maxNum}\n0000000000 65535 f \n`;
  for (let n = 1; n < maxNum; n += 1) {
    pdf += `${String(offsets[n] ?? 0).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${maxNum} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

const ROOT = join(dirname(dbPath), 'official-originals');
mkdirSync(ROOT, { recursive: true });

const { sha256 } = await import('../src/services/collect-svc.mjs');
const pdfParse = await import('../src/services/pdf-parse-svc.mjs');
const ocr = await import('../src/services/baidu-ocr-svc.mjs');

function writePdf(name, pages) {
  const buf = buildPdf(pages);
  const p = join(ROOT, name);
  writeFileSync(p, buf);
  return { path: p, hash: sha256(buf), bytes: buf.length };
}

const TEXT_A = 'Huaneng Fuzhou Power Plant 2026 Key Emitting Units List\nsecond line verifying per-page text layer extraction\nthird line with enough visible characters for the threshold';
const TEXT_B = 'Fujian Sangang Minguang Co Ltd 2026 Key Emitting Units List\nsecond line for per-page parsing verification\nthird line above the minimum visible character count';

const fText = writePdf('text-only.pdf', [{ text: TEXT_A }]);
const fScan = writePdf('scan-only.pdf', [{ text: null }]);
const fMixed = writePdf('mixed.pdf', [{ text: TEXT_A }, { text: null }]);
const fMissing = writePdf('missing-pages.pdf', [{ text: TEXT_A }, { text: null }, { text: null }]);

/* ==================================================================== */
/*  2) OCR 打桩（真实 HTTP，只在本机回环）                               */
/* ==================================================================== */

const ocrCalls = [];
const stub = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const form = Object.fromEntries(new URLSearchParams(body));
    res.setHeader('content-type', 'application/json');
    if (url.pathname === '/oauth/2.0/token') {
      res.end(JSON.stringify({ access_token: `tok-${ocrCalls.length}`, expires_in: 3600 }));
      return;
    }
    ocrCalls.push({ page: form.pdf_file_num, at: Date.now() });
    res.end(JSON.stringify({ words_result: [{ words: `OCR识别正文第${form.pdf_file_num}页` }, { words: '第二行扫描件文字' }] }));
  });
});
await new Promise((r) => stub.listen(0, '127.0.0.1', r));
process.env.CCER_ALLOW_LOOPBACK_OUTBOUND = '1';
process.env.CCER_BAIDU_OCR_BASE_URL = `http://127.0.0.1:${stub.address().port}`;
process.env.CCER_SECRET_KEY = 'test-master-key-for-pdf-parse-regression';

const ADMIN = { id: 'A1', name: 'admin', role: 'admin' };

function enableOcr(over = {}) {
  ocr.resetTokenCache();
  ocr.resetBaiduOcrCounters();
  ocrCalls.length = 0;
  const out = ocr.saveBaiduOcrConfig(ADMIN, {
    api_key: 'AK-PDF', secret_key: 'SK-PDF', enabled: true, mode: 'accurate_basic',
    max_pages_per_doc: 50, ocr_min_chars: 12, daily_page_limit: 500,
    ...over,
  });
  assertEqual(out.ok, true, `启用 OCR 失败：${out.error || ''}`);
}

function disableOcr() {
  ocr.saveBaiduOcrConfig(ADMIN, { enabled: false });
}

const noWrites = (hash) => {
  assertEqual(existsSync(pdfParse.docResultPath(hash)), false, '不应写出整篇结果 JSON（残留写）');
  assertEqual(existsSync(join(pdfParse.ocrRoot(), hash)), false, '不应写出任何页缓存（残留写）');
};

/* ==================================================================== */
/*  3) 逐页文本质量判定（纯函数）                                        */
/* ==================================================================== */

test('逐页判定：空页 / CID 占位 / 乱码 / 过短页都判为「需要 OCR」', () => {
  assertEqual(pdfParse.assessPageText('').reason, 'page_empty');
  assertEqual(pdfParse.assessPageText('   \n  \t ').reason, 'page_empty');
  assertEqual(pdfParse.assessPageText('(cid:123)(cid:456)(cid:789)').reason, 'page_cid_placeholder');
  assertEqual(pdfParse.assessPageText('(cid:123)').garbled, true);
  const garbled = `正常文字${'\uFFFD'.repeat(40)}`;
  assertEqual(pdfParse.assessPageText(garbled).reason, 'page_garbled');
  assertEqual(pdfParse.assessPageText('短').reason, 'page_too_short');
  const ok = pdfParse.assessPageText('这是一页足够长的正常中文正文内容');
  assertEqual(ok.usable, true);
  assertEqual(ok.needs_ocr, false);
  assertEqual(ok.chars, 16);
});

test('逐页判定：字数下限可配置，且只影响该页（不是整篇阈值）', () => {
  const judge = pdfParse.assessPageText('十二个字符的正文内容', { minChars: 20 });
  assertEqual(judge.usable, false);
  assertEqual(judge.reason, 'page_too_short');
  assertEqual(pdfParse.assessPageText('十二个字符的正文内容', { minChars: 5 }).usable, true);
});

/* ==================================================================== */
/*  4) 真实 PDF：文字页 / 扫描页 / 混合页                                */
/* ==================================================================== */

await testAsync('纯文字页：全部页取得正文 → full，source=text，不需要 OCR', async () => {
  enableOcr();
  const r = await pdfParse.parsePdfDocument({ filePath: fText.path, sha256: fText.hash });
  assertEqual(r.status, 'full', `应判 full：${JSON.stringify(r.failed_pages || r.error)}`);
  assertEqual(r.pages_total, 1, 'pdfinfo 应报告 1 页');
  assertEqual(r.pages_text, 1);
  assertEqual(r.pages_ocr, 0);
  assertEqual(r.pages_failed, 0);
  assertIncludes(r.text, 'Huaneng Fuzhou Power Plant');
  assertIncludes(r.text, '【第 1 页｜文本层】', '正文带页码标记，便于按页引用');
  assertIncludes(r.raw_text, 'Huaneng Fuzhou Power Plant');
  assertEqual(ocrCalls.length, 0, '文本层可用时不得调用 OCR（不重复计费）');
});

await testAsync('纯扫描页（无文本层）：走 OCR 后 → full，且记录 OCR 来源', async () => {
  enableOcr();
  const r = await pdfParse.parsePdfDocument({ filePath: fScan.path, sha256: fScan.hash });
  assertEqual(r.status, 'full', `应通过 OCR 判 full：${JSON.stringify(r.failed_pages)}`);
  assertEqual(r.pages_total, 1);
  assertEqual(r.pages_ocr, 1);
  assertIncludes(r.text, 'OCR识别正文第1页');
  assertIncludes(r.text, '【第 1 页｜OCR】');
  assertEqual(ocrCalls.length, 1, '应恰好 1 次 OCR 调用');
  assertEqual(ocrCalls[0].page, '1', 'pdf_file_num 从 1 起');
});

await testAsync('混合页（1 页文字 + 1 页扫描）：两页都成功 → full，逐页来源分别标注', async () => {
  enableOcr();
  const r = await pdfParse.parsePdfDocument({ filePath: fMixed.path, sha256: fMixed.hash });
  assertEqual(r.status, 'full', JSON.stringify(r.failed_pages));
  assertEqual(r.pages_total, 2);
  assertEqual(r.pages_text, 1, '第 1 页来自文本层');
  assertEqual(r.pages_ocr, 1, '第 2 页来自 OCR');
  assertEqual(ocrCalls.length, 1);
  assertEqual(ocrCalls[0].page, '2', '只对缺文字的第 2 页调用 OCR');
  assertEqual(r.pages[0].source, 'text');
  assertEqual(r.pages[1].source, 'ocr');
});

/* ==================================================================== */
/*  5) 缺页不 full（docs/36 第 2 条核心回归）                             */
/* ==================================================================== */

await testAsync('缺页不判全文：3 页只有 1 页成功 → partial，失败页逐页列明', async () => {
  disableOcr(); // OCR 未配置 → 扫描页取不到正文
  const r = await pdfParse.parsePdfDocument({ filePath: fMissing.path, sha256: fMissing.hash });
  assertEqual(r.status, 'partial', '仅部分页成功只能是 partial');
  assertEqual(r.pages_total, 3);
  assertEqual(r.pages_text, 1);
  assertEqual(r.pages_ocr, 0);
  assertEqual(r.pages_failed, 2, '两页无可用正文');
  assertEqual(r.failed_pages.map((p) => p.page).join(','), '2,3');
  assertEqual(r.ok, false);
  assertEqual(r.needs_ocr_pages.join(','), '2,3');
  assert(r.text.length > 0, '已成功的页仍要保留正文（不影响已有可读页）');
  assertNotIncludes(r.text, '第 2 页', '失败页不得伪造正文');
});

await testAsync('回归对照：同一份 PDF 在 OCR 可用后由 partial → full（缺页被真实补齐）', async () => {
  enableOcr();
  const r = await pdfParse.parsePdfDocument({ filePath: fMissing.path, sha256: fMissing.hash });
  assertEqual(r.status, 'full', JSON.stringify(r.failed_pages));
  assertEqual(r.pages_text, 1);
  assertEqual(r.pages_ocr, 2);
  assertEqual(ocrCalls.length, 2);
});

await testAsync('OCR 未配置时诚实失败：说明原因，不影响已有可读页（不整篇失败）', async () => {
  disableOcr();
  await pdfParse.clearOcrArtifacts(fMixed.hash); // 清掉此前测试写入的 OCR 缓存，确保真的走未配置分支
  ocrCalls.length = 0;
  const r = await pdfParse.parsePdfDocument({ filePath: fMixed.path, sha256: fMixed.hash });
  assertEqual(r.ocr_ready, false);
  assertIncludes(r.ocr_note, 'OCR 未启用');
  assertEqual(r.status, 'partial', '已有可读页仍然可用，不因 OCR 未配置而整篇失败');
  assertEqual(r.pages_failed, 1);
  assertEqual(r.failed_pages[0].error_category, 'not_configured');
  assertIncludes(r.text, 'Huaneng Fuzhou Power Plant', '可读页不受影响');
  assertEqual(ocrCalls.length, 0, '未配置时不得发出 OCR 请求');
});

/* ==================================================================== */
/*  6) 缓存：按原件 SHA-256 + 页码 + 解析版本，不重复计费                 */
/* ==================================================================== */

await testAsync('缓存不重复计费：第二次解析同一原件不再调用 OCR，且标注命中缓存', async () => {
  enableOcr();
  await pdfParse.clearOcrArtifacts(fScan.hash);
  const first = await pdfParse.parsePdfDocument({ filePath: fScan.path, sha256: fScan.hash });
  assertEqual(first.ok, true);
  assertEqual(ocrCalls.length, 1, '首次应真实调用 1 次');
  assertEqual(first.cached_pages, 0);
  const cachePage = pdfParse.pageCachePath(fScan.hash, 1);
  assertEqual(existsSync(cachePage), true, '成功的页应写入缓存');

  const second = await pdfParse.parsePdfDocument({ filePath: fScan.path, sha256: fScan.hash });
  assertEqual(second.status, 'full');
  assertEqual(ocrCalls.length, 1, '第二次必须命中缓存，不得再次调用 OCR（不重复计费）');
  assertEqual(second.cached_pages, 1);
  assertEqual(second.ocr_calls, 0);
  assertEqual(second.pages[0].cached, true);
  assertIncludes(second.pages[0].reason_text, '命中 OCR 缓存');

  const third = await pdfParse.parsePdfDocument({ filePath: fScan.path, sha256: fScan.hash, force: true });
  assertEqual(ocrCalls.length, 2, 'force 才重新调用');
  assertEqual(third.cached_pages, 0);
});

test('缓存键包含解析版本：版本变化后旧缓存自动失效', () => {
  const row = JSON.parse(readFileSync(pdfParse.pageCachePath(fScan.hash, 1), 'utf8'));
  assertEqual(row.sha256, fScan.hash);
  assertEqual(row.page, 1);
  assertEqual(row.version, ocr.recordParserVersion());
  assertEqual(pdfParse.readPageCache(fScan.hash, 1, '另一个版本') , null, '解析版本不同时必须视为未命中');
  assertEqual(pdfParse.readPageCache('不存在的hash', 1), null);
  assertEqual(pdfParse.readPageCache(fScan.hash, 99), null, '页码不同不得串用缓存');
});

/* ==================================================================== */
/*  7) 中止时无残留写（quota / timeout）                                 */
/* ==================================================================== */

await testAsync('配额中止：不写页缓存、不写整篇结果 JSON（无残留写）', async () => {
  await pdfParse.clearOcrArtifacts(fMixed.hash);
  // 配额设为 1 并先真实消耗掉：这样解析时第 2 页的 OCR 一定被配额拒绝
  enableOcr({ daily_page_limit: 1, daily_doc_limit: 50 });
  const consume = await ocr.recognizePage({ pdfBuffer: readFileSync(fScan.path), pageNum: 1 });
  assertEqual(consume.ok, true, `前置消耗配额应成功：${consume.error || ''}`);
  assertEqual(ocr.baiduOcrQuotaState().pages_remaining, 0, '前置条件：配额已用尽');
  const r = await pdfParse.parsePdfDocument({ filePath: fMixed.path, sha256: fMixed.hash });
  assertEqual(r.aborted, 'quota_exceeded', `应以 quota 中止：${JSON.stringify(r.failed_pages)}`);
  assertEqual(r.result_written, false);
  assertEqual(ocrCalls.length, 1, '配额耗尽后不得再发出 OCR 请求（只有前置那一次）');
  noWrites(fMixed.hash);
  assertIncludes(r.note, '无残留写');
  assertIncludes(r.text, 'Huaneng Fuzhou Power Plant', '中止不影响已经解析出来的文本层页');
});

await testAsync('超时中止：整批 deadline 到点后不再发请求，同样无残留写', async () => {
  await pdfParse.clearOcrArtifacts(fMixed.hash);
  enableOcr();
  const r = await pdfParse.parsePdfDocument({
    filePath: fMixed.path, sha256: fMixed.hash, deadlineAt: Date.now() + 400,
  });
  assertEqual(r.aborted, 'deadline_exceeded', `应以 deadline 中止：${JSON.stringify(r.failed_pages)}`);
  assertEqual(r.result_written, false);
  noWrites(fMixed.hash);
  assertEqual(ocrCalls.length, 0, 'deadline 不足时不得发出 OCR 请求');
  assertIncludes(r.note, '无残留写');
});

await testAsync('全部页都取不到正文：不写结果 JSON（不给「失败」留成功形状的产物）', async () => {
  await pdfParse.clearOcrArtifacts(fScan.hash);
  disableOcr();
  const r = await pdfParse.parsePdfDocument({ filePath: fScan.path, sha256: fScan.hash });
  assertEqual(r.status, 'failed');
  assertEqual(r.ok, false);
  assertEqual(r.result_written, false);
  noWrites(fScan.hash);
});

await testAsync('成功时结果 JSON 记录 hash / parser / 版本 / 成功页 / 失败原因与时间', async () => {
  enableOcr();
  await pdfParse.clearOcrArtifacts(fMissing.hash);
  const r = await pdfParse.parsePdfDocument({ filePath: fMissing.path, sha256: fMissing.hash });
  assertEqual(r.result_written, true);
  const saved = pdfParse.readDocResult(fMissing.hash);
  assert(saved, '应写出整篇结果 JSON');
  assertEqual(saved.hash, fMissing.hash);
  assertEqual(saved.parser, 'pdf-parse-svc');
  assertEqual(saved.parser_version, pdfParse.PDF_TEXT_PARSER_VERSION);
  assertEqual(saved.record_parser_version, ocr.recordParserVersion());
  assertEqual(saved.pages_total, 3);
  assertEqual(saved.pages_text, 1);
  assertEqual(saved.pages_ocr, 2);
  assertEqual(saved.pages_failed, 0);
  assert(Array.isArray(saved.pages) && saved.pages.length === 3, '逐页信息应保留');
  assert(saved.at, '应记录时间');
  assert(saved.pages.every((p) => Number.isInteger(p.page) && p.page >= 1), '页码从 1 起');
  assert(saved.pages.every((p) => p.source === 'text' || p.source === 'ocr'), '每页标注来源');
  assertIncludes(saved.note, '原件字节未被修改');
});

/* ==================================================================== */
/*  8) 落库纪律：有正文才写，OCR 成功 ≠ 模型已核验                        */
/* ==================================================================== */

await testAsync('persistParseResult：只有取得正文才写 body；证据等级按真实状态，不冒充人工审核', async () => {
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO cea_document (id,doc_key,doc_type,category,title,publish_date,doc_status,evidence_level,
       ai_status,count_in_stats,body_snapshot,created_at,updated_at)
     VALUES ('CEADOC-PDF-1','cea_pdf_1','policy','allocation','PDF 解析落库测试','2026-01-01','formal','metadata_only',
       'unverified',1,NULL,?,?)`,
    [now, now]
  );
  enableOcr();
  await pdfParse.clearOcrArtifacts(fMixed.hash);
  const full = await pdfParse.parsePdfDocument({ filePath: fMixed.path, sha256: fMixed.hash });
  const p1 = await pdfParse.persistParseResult(full, { kind: 'cea_document', id: 'CEADOC-PDF-1', actor: 'test' });
  assertEqual(p1.verify_eligible, true);
  const row = db.get("SELECT * FROM cea_document WHERE id='CEADOC-PDF-1'");
  assert(row.body_snapshot, '取得正文后应写入 body_snapshot');
  assertEqual(row.evidence_level, 'full_text');
  assertEqual(row.ai_status, 'unverified',
    'OCR/文本层成功只说明拿到了正文，不等于模型已核验，也不构成已人工审核');
  assertIncludes(String(row.provenance_note || ''), '不构成已人工审核');

  // 失败结果不得写 body
  db.run("UPDATE cea_document SET body_snapshot=NULL, evidence_level='metadata_only' WHERE id='CEADOC-PDF-1'");
  await pdfParse.clearOcrArtifacts(fScan.hash);
  disableOcr();
  const failed = await pdfParse.parsePdfDocument({ filePath: fScan.path, sha256: fScan.hash });
  const p2 = await pdfParse.persistParseResult(failed, { kind: 'cea_document', id: 'CEADOC-PDF-1', actor: 'test' });
  assertEqual(p2.verify_eligible, false, '没有正文就不应进入核验');
  assertEqual(db.get("SELECT body_snapshot FROM cea_document WHERE id='CEADOC-PDF-1'").body_snapshot, null,
    '解析失败不得写入伪造正文');
});

await testAsync('缺页写回 partial：policy_attachment 的 parse_quality 如实反映成功页数', async () => {
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO policy_document (id,policy_key,title,category,doc_status,collected_at,created_at,updated_at)
     VALUES ('POL-PDF-1','pol-pdf-1','PDF 缺页回写测试','management','effective',?,?,?)`, [now, now, now]
  );
  db.run(
    `INSERT INTO policy_attachment (id,policy_id,file_name,file_type,url,file_hash,local_path,parse_quality,created_at)
     VALUES ('PAT-PDF-1','POL-PDF-1','a.pdf','pdf','https://www.mee.gov.cn/a.pdf',?,'not-attempted-path','not_attempted',?)`,
    [fMissing.hash, now]
  );
  disableOcr();
  await pdfParse.clearOcrArtifacts(fMissing.hash);
  const r = await pdfParse.parsePdfDocument({ filePath: fMissing.path, sha256: fMissing.hash });
  await pdfParse.persistParseResult(r, { kind: 'policy_attachment', id: 'PAT-PDF-1', actor: 'test' });
  const att = db.get("SELECT * FROM policy_attachment WHERE id='PAT-PDF-1'");
  assertEqual(att.parse_quality, 'partial', '缺页只能写 partial，不能写 good');
  assertIncludes(att.parse_note, '仅部分页取得正文');
  assertIncludes(att.parse_note, '"pages_failed":2');
});

/* ==================================================================== */
/*  9) 真实文件缺失 / 无哈希：拒绝在不可信输入上缓存                      */
/* ==================================================================== */

await testAsync('本地原件不存在 / 缺 SHA-256：如实失败，不缓存', async () => {
  const a = await pdfParse.parsePdfDocument({ filePath: join(ROOT, 'not-exist.pdf'), sha256: 'x' });
  assertEqual(a.ok, false);
  assertIncludes(a.error, '本地原件不存在');
  const b = await pdfParse.parsePdfDocument({ filePath: fText.path, sha256: '' });
  assertEqual(b.ok, false);
  assertIncludes(b.error, '缺少原件 SHA-256');
});

/* ==================================================================== */

stub.close();
enableOcr({ daily_page_limit: 500 });
finish('40-v2-pdf-parse.test.mjs');
