/**
 * 测试 169（docs/86 第二阶段）：真实 pdfplumber 表格 worker。
 * 使用验收样本：1 页 4 家企业湖南钢铁 PDF、53 页 methane 方法学 PDF。
 * 只用 setupV2 临时库；不联网；不安装依赖；不调用模型。
 */
import {
  existsSync, mkdirSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  setupV2, PROJECT_ROOT, testAsync, assert, assertEqual, assertIncludes, finish,
} from './v2-helpers.mjs';

process.env.CCER_PDF_TABLE_ALLOW_SAMPLES = '1';

const ctx = await setupV2({ withPublicDemo: false });
const pdf = await import('../src/services/pdf-table-svc.mjs');

console.log('\n[v2-169] PDF 表格 worker：真实页码/行列、coverage/partial、路径与超限');

const samples = join(PROJECT_ROOT, 'data', 'backups', 'intelligence-20261029', 'samples');
const hunan = join(samples, 'hunan-steel-2026.pdf');
const methane = join(samples, 'methane-methodology.pdf');
const admin = { id: 'U-169-A', name: '管理员169', role: 'admin' };
const viewer = { id: 'U-169-V', name: '普通用户169', role: 'viewer' };
const root = join(ctx.dir, 'official-originals');
mkdirSync(root, { recursive: true });

function cellsText(detail) {
  return detail.tables.flatMap((t) => t.cells.map((c) => c.text)).join('｜');
}

/** 生成一页无文本层/无表格的最小 PDF（测试扫描/空白页口径）。 */
function blankPdfBuffer() {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << >> >>',
    '<< /Length 0 >>\nstream\n\nendstream',
  ];
  let body = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((obj, i) => {
    offsets.push(Buffer.byteLength(body, 'latin1'));
    body += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xref = Buffer.byteLength(body, 'latin1');
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i += 1) {
    body += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

await testAsync('普通用户不能触发解析写动作；管理员可读取受限候选', async () => {
  const denied = await pdf.runPdfTableJob(viewer, { path: hunan, maxPages: 1 });
  assertEqual(denied.ok, false);
  assertEqual(denied.status, 403);
  const candidates = pdf.listPdfTableCandidates({ limit: 10 });
  assert(Array.isArray(candidates.candidates));
  assert(candidates.roots.some((r) => r.includes('official-originals')));
});

await testAsync('1 页湖南钢铁样本：真实页码、表格行列、4 家企业与 coverage=100%', async () => {
  const out = await pdf.runPdfTableJob(admin, {
    path: hunan, maxPages: 5, timeoutMs: 60000,
  });
  assertEqual(out.ok, true, JSON.stringify(out).slice(0, 800));
  assertEqual(out.job.status, 'done');
  assertEqual(out.job.pages_total, 1);
  assertEqual(out.job.pages_processed, 1);
  assertEqual(out.job.coverage_ratio, 1);
  assertEqual(out.job.partial_reason, null);
  assertEqual(out.job.zero_enterprises_claim_allowed, true);
  assertEqual(out.job.enterprise_conclusion, 'tables_extracted');
  assert(out.job.table_count >= 1, '应至少提取一张表');
  assertEqual(out.job.pages_failed, 0);

  const detail = pdf.getPdfTableJob(out.job.id, { includeTables: true });
  assertEqual(detail.ok, true);
  assertEqual(detail.pages.length, 1);
  assertEqual(detail.pages[0].page, 1);
  assertEqual(detail.pages[0].has_text_layer, true);
  assert(detail.pages[0].table_count >= 1);
  assert(detail.tables.length >= 1);
  const table = detail.tables[0];
  assertEqual(table.page, 1);
  assertEqual(table.table_index, 0);
  assert(table.rows >= 5, `表格应含表头+4 行，实际 ${table.rows}`);
  assert(table.cols >= 5, `表格应含多列，实际 ${table.cols}`);
  const cellText = cellsText(detail);
  for (const name of [
    '湖南华菱湘潭钢铁有限公司', '衡阳华菱钢管有限公司',
    '冷水江钢铁有限责任公司', '湖南华菱涟源钢铁有限公司',
  ]) {
    assertIncludes(cellText, name);
  }
  assert(table.cells.some((c) => c.row === 1 && c.col === 1 && c.text.includes('华菱')), '单元格必须含真实行列');
  assert(table.cells.every((c) => Number.isInteger(c.row) && Number.isInteger(c.col)), '每个单元格必须有 0 起行列');
});

await testAsync('53 页样本按 2 页上限：status=partial，真实 pages_total=53，不推断零企业', async () => {
  const out = await pdf.runPdfTableJob(admin, {
    path: methane, maxPages: 2, timeoutMs: 90000,
  });
  assertEqual(out.ok, true, JSON.stringify(out).slice(0, 800));
  assertEqual(out.job.status, 'partial');
  assertEqual(out.job.pages_total, 53);
  assertEqual(out.job.pages_processed, 2);
  assertEqual(out.job.partial_reason, 'page_limit');
  assert(out.job.coverage_ratio > 0 && out.job.coverage_ratio < 1, 'coverage 必须是真实部分覆盖率');
  assertEqual(out.job.zero_enterprises_claim_allowed, false);
  assertIncludes(out.note, 'partial');
});

await testAsync('扫描/空白页：status=partial，不推断零家企业，逐页标 no_text_layer', async () => {
  const blank = join(root, 'blank-scan.pdf');
  writeFileSync(blank, blankPdfBuffer());
  const out = await pdf.runPdfTableJob(admin, { path: blank, maxPages: 1, timeoutMs: 30000 });
  assertEqual(out.ok, true, JSON.stringify(out).slice(0, 800));
  assertEqual(out.job.status, 'partial');
  assertEqual(out.job.partial_reason, 'no_text_layer_or_tables');
  assertEqual(out.job.zero_enterprises_claim_allowed, false);
  assertEqual(out.job.enterprise_conclusion, 'unknown_no_text_layer');
  assertIncludes(out.note, '不能解释为“零家企业”');
  const detail = pdf.getPdfTableJob(out.job.id);
  assertEqual(detail.pages.length, 1);
  assertEqual(detail.pages[0].status, 'empty');
  assertEqual(detail.pages[0].has_text_layer, false);
  assertEqual(detail.tables.length, 0);
});

await testAsync('单进程并发限制：已有任务运行时第二个请求返回 409，不并行解析', async () => {
  const first = pdf.runPdfTableJob(admin, {
    path: methane, maxPages: 53, timeoutMs: 5000,
  });
  const second = await pdf.runPdfTableJob(admin, {
    path: hunan, maxPages: 1, timeoutMs: 30000,
  });
  assertEqual(second.ok, false);
  assertEqual(second.status, 409);
  assertIncludes(second.error, '并发');
  const firstOut = await first;
  assert(['failed', 'partial', 'done'].includes(firstOut.job.status), `首个任务必须有真实终态，实际 ${firstOut.job.status}`);
});

await testAsync('路径越界、伪造扩展名、超大小与损坏 PDF 都明确失败且保留原件', async () => {
  const outside = pdf.resolveRestrictedPdf(join(PROJECT_ROOT, 'package.json'));
  assertEqual(outside.ok, false);
  assertEqual(outside.status, 403);

  const fake = join(root, 'not-really.pdf');
  writeFileSync(fake, 'this is not a pdf');
  const bad = await pdf.runPdfTableJob(admin, { path: fake, maxPages: 1, timeoutMs: 30000 });
  assertEqual(bad.ok, false);
  assertEqual(bad.job.status, 'failed');
  assert(bad.job.error, '损坏 PDF 必须有真实错误');
  assert(existsSync(fake), '失败时不得删除原件');
  const badDetail = pdf.getPdfTableJob(bad.job.id);
  assertEqual(badDetail.tables.length, 0, '失败时不得写入伪造表格');

  const oversize = join(root, 'oversize.pdf');
  writeFileSync(oversize, Buffer.alloc(pdf.PDF_TABLE_LIMITS.max_bytes + 1));
  const tooBig = pdf.resolveRestrictedPdf(oversize);
  assertEqual(tooBig.ok, false);
  assertEqual(tooBig.status, 413);
  assert(existsSync(oversize));
});

finish('169-v2-pdf-table.test.mjs');
