/**
 * 42-v2-evidence-gap-and-registry.test.mjs
 * —— 证据缺口判定修正 + 0 行采集状态修正（docs/36 第 7、8 条）真实回归
 * ============================================================================
 * 第 7 条：网页已有可核对 full_text 不得仅因 PDF 附件为空就被算成「PDF 未解析」；
 *         明确 HTML 正文与 PDF 附件是**两种独立证据**；旧 not_attempted 附件被新的
 *         有效归档替代时，展示层标为「历史/已替代」，**不删除旧证据**。
 * 第 8 条：采集结果 rows=0 必须保留 parse gap，`ingestion_job` 不能是 success；
 *         PDF 名录必须**按 PDF 识别后解析**，不得把二进制当 HTML；
 *         名称/年度/省份必须有原文或来源登记依据，不凭猜测填主体。
 *
 * 注册登记系统与名录来源都打到本机 HTTP stub（仅回环，不访问任何真实官方站点）。
 */
import { createServer } from 'node:http';
import { join } from 'node:path';
import {
  setupV2, test, testAsync, assert, assertEqual, assertIncludes, assertNotIncludes, finish,
} from './v2-helpers.mjs';

const ctx = await setupV2();
const { db } = ctx;

console.log('\n[v2-42] 证据缺口修正（HTML/PDF 两种证据）与 0 行采集状态修正');

/* ==================================================================== */
/*  0) 本机 stub：注册登记系统 + 名录 PDF                                 */
/* ==================================================================== */

const pEsc = (s) => String(s).replace(/([\\()])/g, '\\$1');
/** 纯 ASCII 的简单 PDF（用于「扫描版」：整页只有图形，没有文本层） */
function buildPdf(pages) {
  const objects = [];
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = `<< /Type /Pages /Kids [${pages.map((_, i) => `${4 + i * 2} 0 R`).join(' ')}] /Count ${pages.length} >>`;
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  pages.forEach((p, i) => {
    const pageNum = 4 + i * 2;
    const contentNum = 5 + i * 2;
    const hasText = typeof p.text === 'string' && p.text.length > 0;
    objects[pageNum] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 480 240] /Resources << ${hasText ? '/Font << /F1 3 0 R >>' : ''} >> /Contents ${contentNum} 0 R >>`;
    const stream = hasText
      ? `BT /F1 10 Tf 14 210 Td ${p.text.split('\n').map((l, k) => `${k ? '0 -14 Td ' : ''}(${pEsc(l)}) Tj`).join(' ')} ET`
      : '0.3 0.3 0.3 rg 12 12 456 216 re f';
    objects[contentNum] = `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`;
  });
  return assemblePdf(objects);
}

/**
 * 可承载**中文文本层**的 PDF：Type0 / Identity-H 字体 + ToUnicode CMap。
 * 真实中文公文就是这样把字符映射回 Unicode 的；pdftotext 依此还原中文。
 * 仅在测试里生成最小可用结构（无嵌入字形，只保证文本抽取链路真实）。
 * @param {Array<{lines:string[]}|{blank:true}>} pages
 */
function buildCjkPdf(pages) {
  const cids = new Map();
  const cidOf = (ch) => {
    if (!cids.has(ch)) cids.set(ch, cids.size + 1);
    return cids.get(ch);
  };
  const contents = pages.map((p) => {
    if (p.blank) return '0.3 0.3 0.3 rg 12 12 456 216 re f';
    const parts = p.lines.map((line, k) => {
      const hex = [...line].map((ch) => cidOf(ch).toString(16).padStart(4, '0')).join('');
      return `${k ? '0 -16 Td ' : ''}<${hex}> Tj`;
    });
    return `BT /F1 11 Tf 14 210 Td ${parts.join(' ')} ET`;
  });
  const bf = [...cids.entries()]
    .map(([ch, cid]) => `<${cid.toString(16).padStart(4, '0')}> <${ch.codePointAt(0).toString(16).padStart(4, '0')}>`)
    .join('\n');
  const cmap = `/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n`
    + `/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n`
    + `/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n`
    + `1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n`
    + `${cids.size} beginbfchar\n${bf}\nendbfchar\n`
    + `endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n`;

  const objects = [];
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = `<< /Type /Pages /Kids [${pages.map((_, i) => `${7 + i * 2} 0 R`).join(' ')}] /Count ${pages.length} >>`;
  objects[3] = '<< /Type /Font /Subtype /Type0 /BaseFont /SimSun /Encoding /Identity-H /DescendantFonts [4 0 R] /ToUnicode 5 0 R >>';
  objects[4] = '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /SimSun '
    + '/CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> '
    + '/FontDescriptor 6 0 R /DW 1000 >>';
  objects[5] = `<< /Length ${Buffer.byteLength(cmap, 'latin1')} >>\nstream\n${cmap}\nendstream`;
  objects[6] = '<< /Type /FontDescriptor /FontName /SimSun /Flags 4 /FontBBox [0 0 1000 1000] '
    + '/ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 700 /StemV 80 >>';
  pages.forEach((p, i) => {
    const pageNum = 7 + i * 2;
    const contentNum = 8 + i * 2;
    objects[pageNum] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 480 300] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentNum} 0 R >>`;
    const stream = contents[i];
    objects[contentNum] = `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`;
  });
  return assemblePdf(objects);
}

function assemblePdf(objects) {
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  for (let n = 1; n < objects.length; n += 1) {
    if (!objects[n]) continue;
    offsets[n] = pdf.length;
    pdf += `${n} 0 obj\n${objects[n]}\nendobj\n`;
  }
  const xrefStart = pdf.length;
  pdf += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let n = 1; n < objects.length; n += 1) pdf += `${String(offsets[n] ?? 0).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

/**
 * 名录 PDF（文本层为中文，逐行一个主体）：
 * 统一解析服务取出文本后，`parseEntityRows` 依赖「结构化表格」才入库——
 * 逐行一个主体是可核对的结构化形态，因此这里应当真的产出企业行。
 */
const ENTITY_PDF = buildCjkPdf([{
  lines: [
    '2026年度重点排放单位名录（发电、钢铁、水泥）',
    '华能福州电厂',
    '福建三钢闽光股份有限公司',
    '福建水泥股份有限公司',
  ],
}]);
/** 扫描版名录 PDF：无任何文本层 */
const ENTITY_PDF_SCAN = buildPdf([{ text: null }, { text: null }]);

const stubState = { registryRows: 0, entityFile: 'pdf' };
const stub = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/entity-list.pdf') {
      const buf = stubState.entityFile === 'pdf' ? ENTITY_PDF : ENTITY_PDF_SCAN;
      res.writeHead(200, { 'content-type': 'application/pdf', 'content-length': buf.length });
      res.end(buf);
      return;
    }
    // 注册登记系统公开接口
    res.setHeader('content-type', 'application/json');
    const rows = [];
    for (let i = 0; i < stubState.registryRows; i += 1) {
      rows.push({ applyId: `9000${i}`, projectName: `Stub Project ${i}`, dataType: '1' });
    }
    res.end(JSON.stringify({
      flag: '1', successful: true, total: rows.length,
      dataInfo: url.pathname.endsWith('getOpeningApplyDetail')
        ? { projectName: 'Stub Project', projectCode: 'PC-1' }
        : rows,
    }));
  });
});
await new Promise((r) => stub.listen(0, '127.0.0.1', r));
const STUB = `http://127.0.0.1:${stub.address().port}`;
process.env.CCER_ALLOW_LOOPBACK_OUTBOUND = '1';
process.env.CCER_REGISTRY_BASE_URL = STUB;
process.env.CCER_SECRET_KEY = 'test-master-key-for-gap-regression';
// 隔离：CEA 原件落盘目录默认在仓库 data/ 下，测试必须改写到自己的一次性目录，
// 否则会在真实 data/official-originals/cea 里留下测试产物。
process.env.CCER_CEA_ATTACHMENT_DIR = join(ctx.dir, 'official-originals', 'cea');

const policyArchive = await import('../src/services/policy-archive-svc.mjs');
const upload = await import('../src/services/document-upload-svc.mjs');
const registry = await import('../src/services/registry-svc.mjs');
const ceaParse = await import('../src/services/cea-parse.mjs');
const ceaCollect = await import('../src/services/cea-collect-svc.mjs');
const cea = await import('../src/services/cea-svc.mjs');
const collect = await import('../src/services/collect-svc.mjs');

const iso = () => new Date().toISOString();
const HTML_BODY = `政策正文（官方网页全文）${'用于满足可核对正文长度要求的填充内容。'.repeat(20)}`;

/* ==================================================================== */
/*  1) 第 7 条：HTML 正文与 PDF 附件是两种独立证据                        */
/* ==================================================================== */

test('源站固定性：未显式允许回环出站时，注入的注册登记系统基址被忽略', () => {
  const savedFlag = process.env.CCER_ALLOW_LOOPBACK_OUTBOUND;
  delete process.env.CCER_ALLOW_LOOPBACK_OUTBOUND;
  try {
    assertEqual(registry.registryOrigin(), 'https://ccer.cets.org.cn', '生产不得把注册登记接口改到私网');
    assertEqual(registry.registryAllowedDomains().join(','), 'ccer.cets.org.cn');
  } finally {
    if (savedFlag !== undefined) process.env.CCER_ALLOW_LOOPBACK_OUTBOUND = savedFlag;
  }
  assertEqual(registry.registryOrigin(), STUB, '测试环境下才采用本机 stub');
});

await testAsync('政策缺口：网页已有可核对 full_text 时，不因缺少 PDF 附件而判为「PDF 未解析」', async () => {
  const now = iso();
  db.run(
    `INSERT INTO policy_document (id,policy_key,title,category,doc_status,official_url,body_snapshot,collected_at,created_at,updated_at)
     VALUES ('POL-EV-1','pol-ev-1','网页正文已可核对的政策','management','effective','https://www.mee.gov.cn/ev1.html',?,?,?,?)`,
    [HTML_BODY, now, now, now]
  );
  const st = policyArchive.policyArchiveStatus('POL-EV-1');
  assertEqual(st.evidence.html_body.satisfied, true, '网页正文证据应成立');
  assertEqual(st.evidence.pdf_original.satisfied, false, '没有 PDF 附件，PDF 页码级证据不成立');
  assertEqual(st.evidence.body_satisfied, true, '两种证据取「或」：正文已满足，不是缺口');
  assertIncludes(st.evidence.html_body.required_for, '按章节引用');
  assertIncludes(st.evidence.pdf_original.required_for, '按页引用');
  assertEqual(st.archived, false, '但仍如实说明：原件（本地文件 + SHA-256）未归档');

  // 补充入口不应把它列成「PDF 未解析」缺口
  const gaps = upload.listDocumentGaps();
  const hit = gaps.policies.find((p) => p.id === 'POL-EV-1');
  assertEqual(hit, undefined, '网页已有可核对正文的政策不得出现在政策补充入口');
  assert(gaps.evidence_requirements.html_body && gaps.evidence_requirements.pdf_original,
    '接口必须明确列出 HTML 正文与 PDF 附件两种证据需求');

  // 缺口台账同样不应把它算进「正文不可提取」
  const state = policyArchive.policyArchiveGapState();
  assertEqual(state.unparsed.some((x) => x.id === 'POL-EV-1'), false, '不得计入正文不可提取');
  assert(state.html_body_only.some((x) => x.id === 'POL-EV-1'), '应单列为「以网页正文为正文证据」');
  assertIncludes(state.impact, '两种独立证据');
});

await testAsync('政策缺口：只有 PDF 附件、正文提取失败时仍是缺口，不因「有页面」而声称已读原文', async () => {
  const now = iso();
  db.run(
    `INSERT INTO policy_document (id,policy_key,title,category,doc_status,official_url,collected_at,created_at,updated_at)
     VALUES ('POL-EV-2','pol-ev-2','只有 PDF 且正文未提取的政策','management','effective','https://www.mee.gov.cn/ev2.pdf',?,?,?)`,
    [now, now, now]
  );
  db.run(
    `INSERT INTO policy_attachment (id,policy_id,file_name,file_type,url,file_hash,local_path,parse_quality,parse_note,created_at)
     VALUES ('PAT-EV-2','POL-EV-2','ev2.pdf','pdf','https://www.mee.gov.cn/ev2.pdf','hash-ev-2','data/x.pdf','partial','已归档原件，但正文提取失败',?)`,
    [now]
  );
  const st = policyArchive.policyArchiveStatus('POL-EV-2');
  assertEqual(st.archived, true, '原件已归档');
  assertEqual(st.evidence.body_satisfied, false, '正文证据不成立');
  assertIncludes(st.body_reason, '两条证据路径都没有可核对正文');
  const state = policyArchive.policyArchiveGapState();
  assert(state.unparsed.some((x) => x.id === 'POL-EV-2'), '应计入正文不可提取');
});

await testAsync('CEA 文件：evidence_level=full_text 且有正文快照时，不因 attachment_path 为空而算「PDF 未解析」', async () => {
  const now = iso();
  db.run(
    `INSERT INTO cea_document (id,doc_key,doc_type,category,title,evidence_level,ai_status,count_in_stats,body_snapshot,created_at,updated_at)
     VALUES ('CEADOC-EV-1','cea_ev_1','policy','allocation','网页正文已可核对的 CEA 文件','full_text','unverified',1,?,?,?)`,
    [HTML_BODY, now, now]
  );
  db.run(
    `INSERT INTO cea_document (id,doc_key,doc_type,category,title,evidence_level,ai_status,count_in_stats,body_snapshot,attachment_path,created_at,updated_at)
     VALUES ('CEADOC-EV-2','cea_ev_2','policy','allocation','只有元数据的 CEA 文件','metadata_only','unverified',1,NULL,NULL,?,?)`,
    [now, now]
  );
  const out = upload.listCeaDocumentGaps();
  assertEqual(out.cea.some((r) => r.id === 'CEADOC-EV-1'), false,
    '已有可核对 full_text 的文件不得仅因 attachment_path 为空就要求补充');
  assert(out.optional_pdf_only.some((r) => r.id === 'CEADOC-EV-1'), '应单列为「仅缺 PDF 原件（可选补充）」');
  assert(out.cea.some((r) => r.id === 'CEADOC-EV-2'), '确实没有正文的文件仍应列出');
  const row = [...out.cea, ...out.optional_pdf_only].find((r) => r.id === 'CEADOC-EV-1');
  assertEqual(row.evidence.html_body.satisfied, true);
  assertEqual(row.needs_supplement, false);
  assertIncludes(row.note, '不因缺少 PDF 附件而判为「PDF 未解析」');
});

await testAsync('旧证据保留：not_attempted 附件被新的有效归档替代时标为「历史/已替代」，不删除原记录', async () => {
  const now = iso();
  db.run(
    `INSERT INTO policy_document (id,policy_key,title,category,doc_status,official_url,collected_at,created_at,updated_at)
     VALUES ('POL-EV-3','pol-ev-3','旧证据替代展示测试','management','effective','https://www.mee.gov.cn/ev3.pdf',?,?,?)`,
    [now, now, now]
  );
  db.run(
    `INSERT INTO policy_attachment (id,policy_id,file_name,file_type,url,file_hash,local_path,parse_quality,parse_note,created_at)
     VALUES ('PAT-EV-OLD','POL-EV-3','old.pdf','pdf','https://www.mee.gov.cn/old.pdf','hash-old','data/old.pdf','not_attempted','已归档原件，尚未获得可核验文本','2026-01-01T00:00:00.000Z')`
  );
  db.run(
    `INSERT INTO policy_attachment (id,policy_id,file_name,file_type,url,file_hash,local_path,parse_quality,parse_note,created_at)
     VALUES ('PAT-EV-NEW','POL-EV-3','new.pdf','pdf','https://www.mee.gov.cn/new.pdf','hash-new','data/new.pdf','good','逐页解析完成','2026-02-01T00:00:00.000Z')`
  );
  const st = policyArchive.policyArchiveStatus('POL-EV-3');
  const oldOne = st.attachments.find((a) => a.id === 'PAT-EV-OLD');
  const newOne = st.attachments.find((a) => a.id === 'PAT-EV-NEW');
  assertEqual(newOne.is_current_archive, true, '较新的有效归档是当前归档');
  assertEqual(oldOne.display_status, 'superseded_by_newer_archive', '旧 not_attempted 应标为历史/已替代');
  assertEqual(oldOne.superseded_by, 'PAT-EV-NEW');
  assertIncludes(oldOne.display_note, '记录保留，不删除');
  assertEqual(oldOne.local_path, 'data/old.pdf', '旧证据内容本身不被改写');
  assertEqual(oldOne.parse_quality, 'not_attempted', '旧 parse_quality 保持原值');
  // 数据库里两行都还在（不删除旧证据）
  assertEqual(db.get("SELECT COUNT(*) AS c FROM policy_attachment WHERE policy_id='POL-EV-3'").c, 2);
  assertEqual(st.evidence.pdf_original.satisfied, true, '有 good 归档时 PDF 页码级证据成立');

  // 展示层（补充入口）同样标注历史/已替代
  const gaps = upload.listDocumentGaps();
  const row = gaps.policies.find((p) => p.id === 'POL-EV-3');
  if (row) {
    const o = (row.attachments || []).find((a) => a.id === 'PAT-EV-OLD');
    if (o) assertEqual(o.display_status, 'superseded_by_newer_archive');
  }
});

test('归档判定口径不变：只有本地文件 + SHA-256 才算已归档（占位记录不算）', () => {
  const now = iso();
  db.run(
    `INSERT INTO policy_document (id,policy_key,title,category,doc_status,official_url,collected_at,created_at,updated_at)
     VALUES ('POL-EV-4','pol-ev-4','占位记录不算归档','management','effective','https://www.mee.gov.cn/ev4.html',?,?,?)`,
    [now, now, now]
  );
  db.run(
    `INSERT INTO policy_attachment (id,policy_id,file_name,file_type,url,file_hash,local_path,parse_quality,parse_note,created_at)
     VALUES ('PAT-EV-4','POL-EV-4','page.html','html','https://www.mee.gov.cn/ev4.html',NULL,NULL,'good','官方页面已核对',?)`,
    [now]
  );
  const st = policyArchive.policyArchiveStatus('POL-EV-4');
  assertEqual(st.archived, false, '没有本地文件与哈希的占位记录不得算已归档');
  assertEqual(st.evidence.original_satisfied, false);
});

/* ==================================================================== */
/*  2) 第 8 条：注册登记系统 0 行 → parse gap，任务不判成功                */
/* ==================================================================== */

await testAsync('注册登记系统 rows=0：保留 parse gap，返回值 ok=false（ingestion_job 不能 success）', async () => {
  stubState.registryRows = 0;
  const r = await registry.syncRegistry({ actor: 'test', maxDetails: 5, archiveFiles: false });
  assertEqual(r.ok, false, '全部栏目返回 0 行时不得判成功');
  assertEqual(r.stats.listed, 0);
  assertEqual(r.stats.rows_zero_lists > 0, true, '应记录空栏目数');
  assert(r.stats.errors.some((e) => e.includes('0 行')), '应把 0 行写进错误摘要');
  const gap = db.get("SELECT * FROM data_gap WHERE gap_key='gap-registry-list-empty'");
  assert(gap, '必须登记 parse gap');
  assertEqual(gap.status, 'open');
  assertIncludes(gap.title, '0 行');
  assertIncludes(gap.description, '0 行不等于「没有项目」');
  assertIncludes(gap.description, '不把该任务标为成功');
});

await testAsync('每日任务：注册登记 0 行时 ingestion_job 不得为 success', async () => {
  stubState.registryRows = 0;
  const before = db.get("SELECT COUNT(*) AS c FROM ingestion_job").c;
  const out = await collect.runDailyJob({ actor: 'test', datasets: ['project'], projectArchiveFiles: false });
  assert(db.get("SELECT COUNT(*) AS c FROM ingestion_job").c > before, '每日任务应真实落库一个 ingestion_job');
  const job = db.get('SELECT * FROM ingestion_job ORDER BY started_at DESC LIMIT 1');
  assertEqual(job.job_key, 'daily_all');
  assert(job.status !== 'success', `0 行时任务状态不得是 success，实际 ${job.status}`);
  assert(job.error_count > 0, '应记录问题数');
  assertEqual(out.detail.project.stats.listed, 0);
});

await testAsync('回归对照：注册登记系统返回行时不再产生「0 行」缺口（缺口如实关闭/保留由真实数据决定）', async () => {
  stubState.registryRows = 2;
  const r = await registry.syncRegistry({ actor: 'test', maxDetails: 1, archiveFiles: false });
  assert(r.stats.listed > 0, '应真实读到行');
  assertEqual(r.stats.rows_zero_lists, 0, '有行时不得记为空栏目');
  assert(!r.stats.errors.some((e) => e.includes('所有栏目均返回 0 行')), '不得再报 0 行缺口');
});

/* ==================================================================== */
/*  3) 第 8 条：名录 PDF 按 PDF 识别后解析，0 行不标成功                  */
/* ==================================================================== */

test('主体字段必须有原文/登记依据：无年度时不入库、不拿当前年份顶替', () => {
  const withoutYear = '<p>重点排放单位名录（发电、钢铁、水泥）</p><table>'
    + '<tr><td>1</td><td>华能福州电厂</td><td>91350100123456789X</td></tr>'
    + '<tr><td>2</td><td>福建三钢闽光股份有限公司</td><td>91350400123456789Y</td></tr>'
    + '<tr><td>3</td><td>福建水泥股份有限公司</td><td>91350000123456789Z</td></tr></table>';
  assertEqual(ceaParse.parseEntityRows(withoutYear, {}).length, 0,
    '原文与来源登记都没有年度时必须不产出（不得用 new Date().getFullYear() 顶替）');
  const withYear = ceaParse.parseEntityRows(withoutYear, { listYear: 2026 });
  assertEqual(withYear.length, 3, '来源登记年度可用时正常产出');
  assertEqual(withYear[0].list_year, 2026);
  assertEqual(withYear[0].year_source, '来源登记年度');
  assertEqual(withYear[0].province, null, '省份没有依据时保留 NULL，不猜测');
  assertEqual(withYear[0].credit_code, '91350100123456789X', '信用代码原样来自原文');
  assertEqual(withYear[2].name, '福建水泥股份有限公司', '名称原样来自原文，不做改写');
});

test('年度优先取原文：正文出现「20XX 年(度)」时以原文为准', () => {
  const rows = ceaParse.parseEntityRows(
    '<p>2025年度重点排放单位名录（发电、钢铁、水泥）</p><table>'
    + '<tr><td>1</td><td>华能福州电厂</td><td>91350100123456789X</td></tr>'
    + '<tr><td>2</td><td>福建三钢闽光股份有限公司</td><td>91350400123456789Y</td></tr>'
    + '<tr><td>3</td><td>福建水泥股份有限公司</td><td>91350000123456789Z</td></tr></table>',
    { listYear: 2026 }
  );
  assertEqual(rows.length, 3);
  assertEqual(rows[0].list_year, 2025, '原文年度优先于来源登记年度');
  assertEqual(rows[0].year_source, '原文');
});

test('来源登记信息提取：省份与年度来自来源名称/说明，不是请求参数', () => {
  const meta = ceaCollect.sourceEntityMeta({ name: '福建省 2026 年度重点排放单位名录（省级样本，PDF）' });
  assertEqual(meta.list_year, 2026);
  assertEqual(meta.province, '福建');
  assertEqual(ceaCollect.sourceEntityMeta({ name: '某省名录' }).list_year, null);
  assertEqual(ceaCollect.isPdfResponse({ content_type: 'application/pdf' }), true);
  assertEqual(ceaCollect.isPdfResponse({ buf: Buffer.from('%PDF-1.4') }), true);
  assertEqual(ceaCollect.isPdfResponse({ content_type: 'text/html', buf: Buffer.from('<html>') }), false);
});

await testAsync('PDF 名录：按 PDF 识别并用统一解析服务取文本，产出真实主体行', async () => {
  const now = iso();
  db.run(
    `INSERT INTO cea_source (id,code,name,url,dataset,kind,authority,allowed_domains,enabled,priority,created_at,updated_at)
     VALUES ('SRC-TEST-ENT','test_entity_pdf','福建省 2026 年度重点排放单位名录（回归 stub）',?,'entity','official_pdf','测试机关',?,1,1,?,?)`,
    [`${STUB}/entity-list.pdf`, JSON.stringify(['127.0.0.1']), now, now]
  );
  stubState.entityFile = 'pdf';
  const out = await ceaCollect.collectCeaEntities({ actor: 'test', codes: ['test_entity_pdf'], trigger: 'manual' });
  assertEqual(out.entities_created + out.entities_updated > 0, true,
    `应解析出真实主体行：${JSON.stringify(out.sources)}`);
  assertEqual(out.sources[0].kind, 'pdf', '必须按 PDF 识别后解析，不得把二进制当 HTML');
  assertEqual(out.status, 'success');
  const job = db.get('SELECT * FROM ingestion_job WHERE id=?', [out.job_id]);
  assertEqual(job.status, 'success');
  const entities = db.all("SELECT * FROM cea_entity WHERE source_code='test_entity_pdf'");
  assertEqual(entities.length, 3, '应写入 3 个主体');
  assert(entities.every((e) => e.name && e.list_year === 2026), '名称与年度必须来自原文');
  assertIncludes(String(entities[0].province || ''), '福建', '省份来自来源登记信息');
  assert(entities.every((e) => /电厂|公司$/.test(e.name)), '主体名称必须原样来自 PDF 原文');
});

await testAsync('扫描版 PDF 名录（无文本层）：保留 parse gap，0 行不得标成功', async () => {
  stubState.entityFile = 'scan';
  const out = await ceaCollect.collectCeaEntities({ actor: 'test', codes: ['test_entity_pdf'], trigger: 'manual' });
  assertEqual(out.entities_created + out.entities_updated, 0, '无文本层时不得写入任何推测行');
  assertEqual(out.status, 'failed', `0 行时任务状态不得是 success，实际 ${out.status}`);
  assert(out.parse_gaps.length > 0, '必须保留 parse gap');
  assertEqual(out.parse_gaps[0].reason, 'no_text', '失败原因必须如实记录（无可用正文）');
  const job = db.get('SELECT * FROM ingestion_job WHERE id=?', [out.job_id]);
  assertEqual(job.status, 'failed');
  assertIncludes(String(job.error_summary || ''), 'test_entity_pdf');
  assertIncludes(String(job.error_summary || ''), 'no_text');
  const gap = db.get("SELECT * FROM data_gap WHERE gap_key='cea:entity:parse:test_entity_pdf'");
  assert(gap, '应登记可见的 parse gap');
  assertIncludes(gap.description, '结构化表格');
  assertIncludes(gap.impact, '不凭猜测填主体');
  // 断言「真的一行都没写」，而不是把旧行当成本次产出
  assertEqual(db.get("SELECT COUNT(*) AS c FROM cea_entity WHERE source_code='test_entity_pdf'").c, 3,
    '本次扫描版未新增任何行（3 行为上一用例真实解析所得）');
});

await testAsync('回归对照：同一来源在可解析 PDF 下任务恢复 success（缺口由真实数据决定）', async () => {
  stubState.entityFile = 'pdf';
  const out = await ceaCollect.collectCeaEntities({ actor: 'test', codes: ['test_entity_pdf'], trigger: 'manual' });
  assert(out.entities_created + out.entities_updated > 0);
  assertEqual(out.status, 'success');
  const job = db.get('SELECT * FROM ingestion_job WHERE id=?', [out.job_id]);
  assertEqual(job.status, 'success');
  assertEqual(job.items_published >= 1, true, '任务应记录真实入库数');
});

/* ==================================================================== */

stub.close();
process.env.CCER_REGISTRY_BASE_URL = STUB;
finish('42-v2-evidence-gap-and-registry.test.mjs');
