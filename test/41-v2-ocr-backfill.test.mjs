/**
 * 41-v2-ocr-backfill.test.mjs —— OCR/PDF 历史补跑（docs/36 第 6 条）真实回归
 * ============================================================================
 * 逐条验证：
 *   1. **防任意路径**：只允许当前数据库目录下 official-originals / registry-files
 *      两个受限根；上跳、绝对路径、目录、非 PDF、文件头不是 %PDF- 一律拒绝；
 *      `backups/**` 之类同级目录**不在**扫描范围内（不读取任何备份目录内容）；
 *   2. 真实缺口扫描：本地有 PDF 原件但正文缺失的对象才会出现；已有正文的不出现；
 *   3. 按对象 ID 重解析：取得正文后写回目标对象，缺页写 partial；
 *   4. 异步受理：立即返回 202 语义 + task_id + 轮询；**单并发**、重入合并且不改动原任务状态；
 *   5. 每日**有界**补跑并保留**未完成游标**（dataset_cursor）；
 *   6. quota / timeout 中止时不留残留写；
 *   7. CLI 支持 status / config / reparse；**默认不指向生产库**，且没有 reset 类破坏性命令。
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  setupV2, test, testAsync, assert, assertEqual, assertIncludes, assertNotIncludes, finish,
} from './v2-helpers.mjs';

const ctx = await setupV2();
const { db, dbPath } = ctx;

console.log('\n[v2-41] OCR 历史补跑：受限根 / 202 异步 / 单并发重入 / 游标 / CLI');

const { sha256 } = await import('../src/services/collect-svc.mjs');
const pdfParse = await import('../src/services/pdf-parse-svc.mjs');
const ocr = await import('../src/services/baidu-ocr-svc.mjs');
const backfill = await import('../src/services/ocr-backfill-svc.mjs');
const { runToolToFile } = await import('../src/services/exec-tool.mjs');

process.env.CCER_SECRET_KEY = 'test-master-key-for-ocr-backfill';
const ADMIN = { id: 'A1', name: 'admin', role: 'admin' };

const DB_DIR = dirname(dbPath);
const ROOT = join(DB_DIR, 'official-originals');
const REG_ROOT = join(DB_DIR, 'registry-files');
mkdirSync(ROOT, { recursive: true });
mkdirSync(REG_ROOT, { recursive: true });

/* ---------------- 真实 PDF（含文字页 / 无文本层页） ---------------- */

const pEsc = (s) => String(s).replace(/([\\()])/g, '\\$1');
function buildPdf(pages) {
  const objects = [];
  const kids = pages.map((_, i) => `${4 + i * 2} 0 R`).join(' ');
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`;
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  pages.forEach((p, i) => {
    const pageNum = 4 + i * 2;
    const contentNum = 5 + i * 2;
    const hasText = typeof p.text === 'string' && p.text.length > 0;
    objects[pageNum] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 420 200] /Resources << ${hasText ? '/Font << /F1 3 0 R >>' : ''} >> /Contents ${contentNum} 0 R >>`;
    const stream = hasText
      ? `BT /F1 11 Tf 14 170 Td ${p.text.split('\n').map((l, k) => `${k ? '0 -16 Td ' : ''}(${pEsc(l)}) Tj`).join(' ')} ET`
      : '0.3 0.3 0.3 rg 12 12 396 176 re f';
    objects[contentNum] = `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`;
  });
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

function putPdf(relDir, name, pages) {
  const dir = join(ROOT, relDir);
  mkdirSync(dir, { recursive: true });
  const buf = buildPdf(pages);
  const p = join(dir, name);
  writeFileSync(p, buf);
  return { path: p, hash: sha256(buf) };
}

const PDF_OK = putPdf('', 'backfill-text.pdf', [
  { text: 'Key Emitting Units List 2026 backfill page one\nsecond line of extractable text\nthird line for the threshold' },
]);
const PDF_PARTIAL = putPdf('', 'backfill-partial.pdf', [
  { text: 'Page one has a real text layer for backfill\nsecond line of text\nthird line of text' },
  { text: null },
]);
const PDF_REG = (() => {
  const buf = buildPdf([{ text: 'Registry file PDF with extractable text layer\nsecond line\nthird line of content' }]);
  const p = join(REG_ROOT, 'sample-registry-file.pdf');
  writeFileSync(p, buf);
  return { path: p, hash: sha256(buf) };
})();

const now = () => new Date().toISOString();

/* ==================================================================== */
/*  1) 防任意路径                                                       */
/* ==================================================================== */

test('受限根：只允许当前数据库目录下的 official-originals / registry-files', () => {
  const roots = backfill.restrictedRoots();
  assertEqual(roots.length, 2);
  assert(roots.some((r) => r.toLowerCase().endsWith('official-originals')), '必须包含 official-originals');
  assert(roots.some((r) => r.toLowerCase().endsWith('registry-files')), '必须包含 registry-files');
  // 受限根跟随当前数据库目录，不是硬编码仓库路径
  assertEqual(resolve(roots[0]).toLowerCase().startsWith(resolve(DB_DIR).toLowerCase()), true,
    '受限根必须落在当前数据库目录下');
});

test('防任意路径：上跳 / 绝对路径 / 目录 / 非 PDF / 假 PDF 一律拒绝', () => {
  // 上跳逃逸
  const escape = backfill.assertRestrictedPath(join(ROOT, '..', '..', 'Windows', 'System32', 'drivers', 'etc', 'hosts'));
  assertEqual(escape.ok, false);
  assertIncludes(escape.reason, '不在受限根内');
  // 同级 backups 目录（内容完全不读取，只做路径判定）
  const backups = backfill.assertRestrictedPath(join(DB_DIR, 'backups', 'ocr-20261015', 'anything.pdf'));
  assertEqual(backups.ok, false, 'backups/** 不在受限根内');
  assertIncludes(backups.reason, '只允许当前数据库目录下的 official-originals / registry-files');
  // 目录而非文件
  const dirOut = backfill.assertRestrictedPath(ROOT);
  assertEqual(dirOut.ok, false);
  // 非 PDF 扩展名
  const txt = join(ROOT, 'note.txt');
  writeFileSync(txt, 'hello');
  const notPdf = backfill.assertRestrictedPath(txt);
  assertEqual(notPdf.ok, false);
  assertIncludes(notPdf.reason, '只处理 PDF 原件');
  // 伪装成 .pdf 但不是 PDF
  const fake = join(ROOT, 'fake.pdf');
  writeFileSync(fake, 'THIS IS NOT A PDF AT ALL');
  const badHead = backfill.assertRestrictedPath(fake);
  assertEqual(badHead.ok, false);
  assertIncludes(badHead.reason, '不是 %PDF-');
  // 不存在的文件
  assertEqual(backfill.assertRestrictedPath(join(ROOT, 'nope.pdf')).ok, false);
  // 合法路径放行
  const ok = backfill.assertRestrictedPath(PDF_OK.path);
  assertEqual(ok.ok, true, ok.reason || '');
  assertEqual(ok.root, join(DB_DIR, 'official-originals'));
  // registry-files 同样允许
  assertEqual(backfill.assertRestrictedPath(PDF_REG.path).ok, true);
});

/* ==================================================================== */
/*  2) 真实缺口扫描                                                     */
/* ==================================================================== */

await testAsync('缺口扫描：本地有 PDF 但正文缺失的对象才出现；路径越界的单独列为 rejected', async () => {
  db.run(
    `INSERT INTO policy_document (id,policy_key,title,category,doc_status,collected_at,created_at,updated_at)
     VALUES ('POL-BF-1','pol-bf-1','补跑缺口测试政策','management','effective',?,?,?)`, [now(), now(), now()]
  );
  // 有本地 PDF + 哈希，但 parse_quality=not_attempted 且政策无正文 → 真缺口
  db.run(
    `INSERT INTO policy_attachment (id,policy_id,file_name,file_type,url,file_hash,local_path,parse_quality,parse_note,created_at)
     VALUES ('PAT-BF-1','POL-BF-1','a.pdf','pdf','https://www.mee.gov.cn/a.pdf',?,?,'not_attempted','已归档原件，尚未获得可核验文本',?)`,
    [PDF_OK.hash, PDF_OK.path, now()]
  );
  // 路径越界（指向仓库外）→ 必须被拒绝
  db.run(
    `INSERT INTO policy_attachment (id,policy_id,file_name,file_type,url,file_hash,local_path,parse_quality,created_at)
     VALUES ('PAT-BF-OUT','POL-BF-1','out.pdf','pdf','https://www.mee.gov.cn/out.pdf','deadbeef','C:\\Windows\\Temp\\out.pdf','not_attempted',?)`,
    [now()]
  );
  // 已有正文的政策不得进入缺口
  db.run(
    `INSERT INTO policy_document (id,policy_key,title,category,doc_status,body_snapshot,collected_at,created_at,updated_at)
     VALUES ('POL-BF-2','pol-bf-2','已有正文的政策','management','effective',?,?,?,?)`,
    ['正文'.repeat(200), now(), now(), now()]
  );
  db.run(
    `INSERT INTO policy_attachment (id,policy_id,file_name,file_type,url,file_hash,local_path,parse_quality,created_at)
     VALUES ('PAT-BF-2','POL-BF-2','b.pdf','pdf','https://www.mee.gov.cn/b.pdf',?,?,'not_attempted',?)`,
    [PDF_PARTIAL.hash, PDF_PARTIAL.path, now()]
  );

  const scan = backfill.scanOcrCandidates({ limit: 200 });
  const ids = scan.candidates.map((c) => c.id);
  assert(ids.includes('PAT-BF-1'), '缺正文且有本地 PDF 的附件必须进入候选');
  assertEqual(ids.includes('PAT-BF-2'), false, '同一政策已有可核对正文 → 不是真缺口');
  const rej = scan.rejected.find((r) => r.id === 'PAT-BF-OUT');
  assert(rej, '路径越界条目必须出现在 rejected 里（如实列出，不静默忽略）');
  assertIncludes(rej.reject_reason, '不在受限根内');
  // 候选里的路径全部经过校验后的绝对路径
  assert(scan.candidates.every((c) => c.local_path && existsSync(c.local_path)));
});

/* ==================================================================== */
/*  3) 按对象 ID 重解析                                                  */
/* ==================================================================== */

await testAsync('按对象重解析：取得正文后写回 policy_attachment（parse_quality=good）', async () => {
  ocr.saveBaiduOcrConfig(ADMIN, { enabled: false }); // 关闭 OCR：本例只验证文本层补跑
  const out = await backfill.reparseObject({ kind: 'policy_attachment', id: 'PAT-BF-1', actor: 'test' });
  assertEqual(out.ok, true, `应取得正文：${JSON.stringify(out)}`);
  assertEqual(out.status, 'full');
  assertEqual(out.pages_text, 1);
  assertEqual(out.verify_eligible, true);
  const att = db.get("SELECT * FROM policy_attachment WHERE id='PAT-BF-1'");
  assertEqual(att.parse_quality, 'good');
  assertIncludes(att.parse_note, '逐页解析完成');
});

await testAsync('缺页写 partial：PDF 有一页无文本层时不得判 good', async () => {
  db.run(
    `INSERT INTO policy_attachment (id,policy_id,file_name,file_type,url,file_hash,local_path,parse_quality,created_at)
     VALUES ('PAT-BF-3','POL-BF-1','c.pdf','pdf','https://www.mee.gov.cn/c.pdf',?,?,'not_attempted',?)`,
    [PDF_PARTIAL.hash, PDF_PARTIAL.path, now()]
  );
  const out = await backfill.reparseObject({ kind: 'policy_attachment', id: 'PAT-BF-3', actor: 'test' });
  assertEqual(out.ok, true);
  assertEqual(out.status, 'partial');
  assertEqual(out.pages_failed, 1);
  assertEqual(db.get("SELECT parse_quality FROM policy_attachment WHERE id='PAT-BF-3'").parse_quality, 'partial');
});

await testAsync('越界对象：直接拒绝，不解析、不读文件', async () => {
  const out = await backfill.reparseObject({ kind: 'policy_attachment', id: 'PAT-BF-OUT', actor: 'test' });
  assertEqual(out.status, 400, `越界路径应被拒绝：${JSON.stringify(out)}`);
  assertEqual(out.path_rejected, true);
  assertIncludes(out.error, '不在受限根内');
});

await testAsync('无本地 PDF 的对象：404，不猜测路径', async () => {
  const out = await backfill.reparseObject({ kind: 'cea_document', id: 'CEADOC-NOT-EXIST', actor: 'test' });
  assertEqual(out.status, 404);
  const bad = await backfill.reparseObject({ kind: 'no_such_kind', id: 'x' });
  assertEqual(bad.status, 400);
  assertIncludes(bad.error, 'kind 须为');
});

/* ==================================================================== */
/*  4) 异步受理：202 + task_id + 单并发 + 重入合并                        */
/* ==================================================================== */

test('异步受理：立即返回 202 语义（accepted/queued/task_id），不阻塞', () => {
  const accepted = backfill.startOcrBackfillTask({ actor: 'test', body: { limit: 1 } });
  assertEqual(accepted.accepted, true);
  assertEqual(accepted.http_status, 202);
  assert(accepted.task_id, '应返回 task_id');
  assertEqual(accepted.status, 'queued', '受理时应是 queued（尚未开始执行）');
  assertEqual(accepted.merged, undefined);
  // 轮询接口能查到
  const t = backfill.getOcrBackfillTask(accepted.task_id);
  assert(t, '应能按 task_id 查到任务');
  assertEqual(t.task_id, accepted.task_id);
});

test('重入合并：同一时刻只有一个任务，重复请求合并且不改动原任务状态', () => {
  const first = backfill.startOcrBackfillTask({ actor: 'test', body: { limit: 1 } });
  const second = backfill.startOcrBackfillTask({ actor: 'test', body: { limit: 1 } });
  assertEqual(second.merged, true, '第二个请求必须合并到运行中的任务');
  assertEqual(second.task_id, first.task_id, '合并后 task_id 必须相同（不新建任务）');
  assertEqual(second.accepted, true);
  assertEqual(second.http_status, 202);
  assertIncludes(second.message, '不重复解析');
  // 原任务状态不被改动（仍处于 queued/running，没有被提前收尾）
  const t = backfill.getOcrBackfillTask(first.task_id);
  assert(['queued', 'running'].includes(t.status), `原任务状态不得被改动，实际 ${t.status}`);
  const list = backfill.listOcrBackfillTasks({ limit: 50 });
  assertEqual(list.filter((x) => ['queued', 'running'].includes(x.status)).length, 1, '单并发：运行中的任务至多 1 个');
});

await testAsync('等待后台任务收尾：状态落到终态且不残留 running', async () => {
  for (let i = 0; i < 80; i += 1) {
    const list = backfill.listOcrBackfillTasks({ limit: 50 });
    if (!list.some((t) => ['queued', 'running'].includes(t.status))) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('后台补跑任务未在 20 秒内收尾（不应残留 running/queued）');
});

test('任务终态与真实结果一致：没有取得正文时不得报 success', () => {
  const list = backfill.listOcrBackfillTasks({ limit: 50 });
  const done = list.filter((t) => ['success', 'partial', 'failed'].includes(t.status));
  assert(done.length > 0, '应至少有一个已收尾任务');
  for (const t of done) {
    const r = t.result || {};
    const idle = t.mode === 'scan' && r.candidates === 0 && !r.error && !r.rejected_by_path;
    const singleOk = t.mode === 'single' && r.ok === true;
    if (t.status === 'success') assert(Number(r.ok_count) > 0 || singleOk || idle, '有缺口的任务 success 必须有真实取得正文的对象');
    if (!Number(r.ok_count) && !singleOk && !idle) assertEqual(t.status, 'failed', `存在缺口但未取得正文时状态应为 failed，实际 ${t.status}`);
    assert(t.finished_at, '收尾任务必须有 finished_at');
  }
});

/* ==================================================================== */
/*  5) 每日有界补跑与未完成游标                                          */
/* ==================================================================== */

await testAsync('每日有界补跑：受 daily_docs 限制，未完成部分写入游标', async () => {
  backfill.saveOcrBackfillConfig(ADMIN, { daily_docs: 1, max_pages_per_doc: 5 });
  // 造出多个真缺口，确保「有界」可被观测
  for (let i = 0; i < 3; i += 1) {
    const f = putPdf('', `daily-${i}.pdf`, [{ text: `Daily bounded backfill sample ${i} page text\nsecond line\nthird line of text` }]);
    db.run(
      `INSERT INTO policy_attachment (id,policy_id,file_name,file_type,url,file_hash,local_path,parse_quality,created_at)
       VALUES (?,?,?,'pdf','https://www.mee.gov.cn/d.pdf',?,?,'not_attempted',?)`,
      [`PAT-BF-D${i}`, 'POL-BF-1', `d${i}.pdf`, f.hash, f.path, now()]
    );
  }
  const before = backfill.readBackfillCursor();
  const out = await backfill.runDailyOcrBackfill({ actor: 'test' });
  assertEqual(out.daily_budget, 1, '本轮应受 daily_docs=1 限制');
  assertEqual(out.selected, 1, '有界补跑每轮只处理 daily_docs 个对象');
  assert(out.candidates > 1, '前置条件：确实存在多个缺口');
  assertIncludes(out.note, '有界补跑');
  const after = backfill.readBackfillCursor();
  assert(after.pending_ids.length > 0, '未完成部分必须写入游标（保留未完成游标）');
  assertEqual(after.last_status, 'ok');
  assert(after.last_attempt_at, '游标应记录最近尝试时间');
  // 游标待处理数应等于「本轮结束后仍未被处理的真实缺口数」
  const remainingNow = backfill.scanOcrCandidates({ limit: 500 }).candidates.length;
  assertEqual(after.pending_ids.length, remainingNow,
    `游标待处理数应等于剩余真实缺口数：${after.pending_ids.length} vs ${remainingNow}`);
  assert(after.pending_ids.length < out.candidates, '有界补跑后剩余缺口应少于本轮开始时的缺口数');
});

await testAsync('每日补跑关闭（daily_docs=0）：如实跳过，不执行', async () => {
  backfill.saveOcrBackfillConfig(ADMIN, { daily_docs: 0 });
  const out = await backfill.runDailyOcrBackfill({ actor: 'test' });
  assertEqual(out.skipped, true);
  assertEqual(out.reason, 'daily_docs_disabled');
  backfill.saveOcrBackfillConfig(ADMIN, { daily_docs: 10 });
});

/* ==================================================================== */
/*  6) 中止无残留写                                                     */
/* ==================================================================== */

await testAsync('整批 deadline 已过：不解析、不写结果 JSON、不写页缓存', async () => {
  const f = putPdf('', 'deadline.pdf', [{ text: null }]);
  db.run(
    `INSERT INTO policy_attachment (id,policy_id,file_name,file_type,url,file_hash,local_path,parse_quality,created_at)
     VALUES ('PAT-BF-DL','POL-BF-1','dl.pdf','pdf','https://www.mee.gov.cn/dl.pdf',?,?,'not_attempted',?)`,
    [f.hash, f.path, now()]
  );
  ocr.saveBaiduOcrConfig(ADMIN, { api_key: 'AK', secret_key: 'SK', enabled: true });
  await pdfParse.clearOcrArtifacts(f.hash);
  const out = await backfill.runBackfillBatch({ actor: 'test', deadlineAt: Date.now() - 1000, limit: 5 });
  assert(out.docs.length <= 1, 'deadline 已过时不应继续处理后续对象');
  assertEqual(existsSync(pdfParse.docResultPath(f.hash)), false, '不应写出整篇结果 JSON');
  assertEqual(existsSync(join(pdfParse.ocrRoot(), f.hash)), false, '不应写出任何页缓存');
  assert(!out.docs.some((d) => d.ok), 'deadline 已过时不得声称取得正文');
});

/* ==================================================================== */
/*  7) CLI：status / config / reparse，默认不指向生产库                   */
/* ==================================================================== */

const CLI = () => join(process.cwd(), 'scripts', 'ocr.mjs');
const runCli = (args, extraEnv = null) =>
  runToolToFile(process.execPath, [CLI(), ...args], {
    timeoutMs: 90000, tag: 'cli', ...(extraEnv ? { env: { ...process.env, ...extraEnv } } : {}),
  });

await testAsync('CLI status --temp：在独立临时库上输出真实缺口、受限根与游标', async () => {
  const r = await runCli(['status', '--temp']);
  assertEqual(r.ok, true, `CLI 应成功退出：${r.stderr || r.stdout}`);
  assertIncludes(r.stdout, '数据库');
  assertIncludes(r.stdout, '受限根');
  assertIncludes(r.stdout, 'official-originals');
  assertIncludes(r.stdout, 'registry-files');
  assertIncludes(r.stdout, 'candidates');
  assertIncludes(r.stdout, 'cursor');
  assertNotIncludes(r.stdout, 'credential_cipher');
  assertIncludes(r.stdout, '临时库=是');
});

await testAsync('CLI config：能读写配置且不回显密钥；--clear-credentials 才清理', async () => {
  const set = await runCli(['config', '--temp', '--enable', '--max-docs=3']);
  assertEqual(set.ok, true, set.stderr || set.stdout);
  assertIncludes(set.stdout, '"max_docs_per_run": 3');
  assertIncludes(set.stdout, '"enabled": true');
  assertIncludes(set.stdout, 'credential_configured');
  assertNotIncludes(set.stdout, 'credential_cipher');
  const help = await runCli(['--help']);
  assertIncludes(help.stdout, 'reparse');
  assertIncludes(help.stdout, 'status');
  assertIncludes(help.stdout, 'config');
});

await testAsync('CLI 无破坏性命令：reset/drop/wipe 一律拒绝', async () => {
  for (const bad of ['reset', 'drop', 'wipe']) {
    const r = await runCli([bad]);
    assertEqual(r.ok, false, `CLI 不得接受 ${bad}`);
    assertIncludes(`${r.stdout}${r.stderr}`, '未知子命令');
  }
});

await testAsync('CLI 默认不指向生产库：显式指向 data/ccer.db 时拒绝执行（exit 2）', async () => {
  const prod = resolve(join(process.cwd(), 'data', 'ccer.db'));
  const r = await runCli(['status'], { CCER_DB_PATH: prod });
  assertEqual(r.ok, false, '指向生产库时必须拒绝执行');
  assertEqual(r.code, 2, `应以 exit 2 拒绝，实际 ${r.code}`);
  assertIncludes(`${r.stdout}${r.stderr}`, '生产库');
});

/* ==================================================================== */

finish('41-v2-ocr-backfill.test.mjs');
