/** 省域公开源 collector：纯 CSV 夹具 + 临时库，不访问真实服务。 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  setupV2, testAsync, assert, assertEqual, assertIncludes, finish,
} from './v2-helpers.mjs';

const ctx = await setupV2({ withPublicDemo: false });
const { db } = ctx;
const collector = await import('../src/services/regional-collect-svc.mjs');
const SECTORS = collector.CARBONMONITOR_SECTORS;
const NOW = '2026-10-19T12:00:00.000Z';
const ARCHIVE = mkdtempSync(join(tmpdir(), 'ccer-regional-117-'));

db.run('DELETE FROM region_emission');

const pad = (n) => String(n).padStart(2, '0');
const daysIn = (year) => (new Date(Date.UTC(year, 1, 29)).getUTCDate() === 29 ? 366 : 365);
const q = (v) => `"${String(v)}"`;

function rowsFor({
  states, years, skip = () => false, valueFor = () => 1, limitDays = null,
}) {
  const rows = [];
  for (const state of states) {
    for (const year of years) {
      const days = limitDays == null ? daysIn(year) : Math.min(limitDays, daysIn(year));
      for (let day = 1; day <= days; day += 1) {
        const dt = new Date(Date.UTC(year, 0, day));
        const month = dt.getUTCMonth() + 1;
        const dayOfMonth = dt.getUTCDate();
        const date = `${pad(dayOfMonth)}/${pad(month)}/${year}`;
        const iso = `${year}-${pad(month)}-${pad(dayOfMonth)}`;
        for (const sector of SECTORS) {
          if (skip({ state, year, iso, sector, day })) continue;
          const value = valueFor({ state, year, iso, sector, day });
          if (value === null) continue;
          rows.push(`${q(state)},${q(date)},${q(sector)},${q(value)}`);
        }
      }
    }
  }
  return rows;
}

const completeRows = rowsFor({
  states: ['Anhui', 'Shanxi', 'Shaanxi'],
  years: [2023, 2024],
  valueFor: ({ state }) => (state === 'Shaanxi' ? 2 : 1),
});
const beijingRows = rowsFor({
  states: ['Beijing'],
  years: [2024],
  skip: ({ sector }) => sector === 'Aviation',
});
const tianjinRows = rowsFor({
  states: ['Tianjin'],
  years: [2024],
  skip: ({ iso, sector }) => iso === '2024-12-31' && sector === 'Power',
});
const hebeiRows = rowsFor({ states: ['Hebei'], years: [2024] });
hebeiRows.push(`${q('Hebei')},${q('01/01/2024')},${q('Industry')},${q(9)}`); // 重复冲突
const liaoningRows = rowsFor({ states: ['Liaoning'], years: [2024] });
liaoningRows.push(`${q('Liaoning')},${q('01/01/2024')},${q('Power')},${q(-1)}`); // 非法负值
const partialRows = rowsFor({ states: ['Shanghai'], years: [2026], limitDays: 10 });

const HEADER = 'state,date,sector,value,';
const csv = [
  HEADER,
  ...completeRows, ...beijingRows, ...tianjinRows, ...hebeiRows,
  ...liaoningRows, ...partialRows,
].join('\n');

const subsetCsv = [HEADER, ...rowsFor({ states: ['Anhui'], years: [2023] })].join('\n');

async function expectReject(fn, includes) {
  try {
    await fn();
  } catch (e) {
    assertIncludes(e.message, includes);
    return;
  }
  throw new Error(`应抛出错误（包含「${includes}」）`);
}

console.log('\n[v2-117] 省域公开源 collector');

await testAsync('日期按 DD/MM/YYYY 解析，拒绝不存在的日历日', async () => {
  assertEqual(collector.parseCarbonMonitorDate('01/02/2024').iso, '2024-02-01');
  assertEqual(collector.parseCarbonMonitorDate('31/12/2024').iso, '2024-12-31');
  assertEqual(collector.parseCarbonMonitorDate('30/02/2024').ok, false);
  assertEqual(collector.parseCarbonMonitorDate('2024-02-01').ok, false);
});

await testAsync('CSV 错误体不能当 CSV', async () => {
  const html = collector.parseCarbonMonitorCsv('<html><body>upstream error</body></html>');
  assertEqual(html.ok, false);
  assertIncludes(html.error, '错误体');
  const json = collector.parseCarbonMonitorCsv('{"error":"rate limited"}');
  assertEqual(json.ok, false);
  const badHeader = collector.parseCarbonMonitorCsv('state,date,value\nA,01/01/2024,1');
  assertEqual(badHeader.ok, false);
});

await testAsync('完整年/闰年/缺部门/缺日/冲突/非法值/年中数据/山西陕西', async () => {
  const parsed = collector.parseCarbonMonitorCsv(csv, {
    lastCompleteYear: 2025, now: NOW, snapshotHash: 'a'.repeat(64),
  });
  assert(parsed.ok, parsed.error);
  assertEqual(parsed.annual.length, 6, '只应汇总 3 个完整省 × 2 个完整年');
  const find = (code, year) => parsed.annual.find((r) => r.province_code === code && r.year === year);
  const anhui2023 = find('340000', 2023);
  const anhui2024 = find('340000', 2024);
  assertEqual(anhui2023.value_tco2, 1825000000, '365 日 × 5 部门 × 1 Mt/day × 1e6');
  assertEqual(anhui2024.value_tco2, 1830000000, '闰年 366 日');
  assertEqual(find('140000', 2024).value_tco2, 1830000000, 'Shanxi = 山西省');
  assertEqual(find('610000', 2024).value_tco2, 3660000000, 'Shaanxi = 陕西省，不能与 Shanxi 混');

  const excluded = (state) => parsed.excluded.find((r) => r.state === state);
  assertIncludes(excluded('Beijing').reason, '缺少部门');
  assertIncludes(excluded('Beijing').reason, 'Aviation');
  assertIncludes(excluded('Tianjin').reason, 'Power');
  assertIncludes(excluded('Tianjin').reason, '365/366');
  assertIncludes(excluded('Hebei').reason, '重复冲突');
  assertIncludes(excluded('Liaoning').reason, '非法');
  const ignored = parsed.ignored.find((r) => r.state === 'Shanghai' && r.year === 2026);
  assert(ignored, '2026 年中数据必须单列');
  assertIncludes(ignored.reason, '未满全年');
  assert(parsed.anomalies.length >= 2, '重复冲突/负值应记录异常明细');
  assertEqual(parsed.stats.complete_records, 6);
});

await testAsync('采集成功：入库 6 条，元数据与 bootstrap 固定口径一致', async () => {
  const out = await collector.collectCarbonMonitor({
    csvText: csv, now: NOW, actor: 'test:117', archiveDir: ARCHIVE,
  });
  assert(out.ok, out.error || out.import?.error);
  assertEqual(out.status, 'ok');
  assertEqual(out.import.inserted, 6);
  assertEqual(out.coverage.years.join(','), '2023,2024');
  assertEqual(out.coverage.records, 6);
  assertEqual(out.coverage.days_by_year[2023], 365);
  assertEqual(out.coverage.days_by_year[2024], 366);

  const rows = db.all("SELECT * FROM region_emission WHERE status='active' ORDER BY province_code, year");
  assertEqual(rows.length, 6);
  for (const row of rows) {
    assertEqual(row.dataset_key, collector.CARBONMONITOR_DATASET_KEY);
    assertEqual(row.source_name, collector.CARBONMONITOR_SOURCE_NAME);
    assertEqual(row.methodology, collector.CARBONMONITOR_METHODOLOGY);
    assertEqual(row.boundary, collector.CARBONMONITOR_BOUNDARY);
    assertEqual(row.source_url, collector.CARBONMONITOR_SOURCE_URL);
    assertEqual(row.source_kind, 'research');
    assertEqual(row.snapshot_hash, out.sha256);
  }
  assert(existsSync(out.raw_path), '应保留最新原始 CSV');
  assert(existsSync(out.receipt_path), '应写出采集回执');
  const receipt = JSON.parse(readFileSync(out.receipt_path, 'utf8'));
  assertEqual(receipt.status, 'ok');
  assertEqual(receipt.sha256, out.sha256);
  assertEqual(receipt.coverage.years.join(','), '2023,2024');
  assert(receipt.excluded.some((r) => r.state === 'Beijing'), '回执应列出缺部门原因');
});

await testAsync('原件 hash 相同：跳过入库，只更新 last_check，记录不变', async () => {
  const before = db.get("SELECT COUNT(*) c, MAX(updated_at) u FROM region_emission WHERE status='active'");
  const out = await collector.collectCarbonMonitor({
    csvText: csv, now: '2026-10-20T12:00:00.000Z', actor: 'test:117', archiveDir: ARCHIVE,
  });
  assert(out.ok, out.error);
  assertEqual(out.status, 'skipped');
  assertIncludes(out.import.reason, 'same_source_hash');
  const after = db.get("SELECT COUNT(*) c, MAX(updated_at) u FROM region_emission WHERE status='active'");
  assertEqual(after.c, before.c);
  assertEqual(after.u, before.u, '同 hash 不得因检查时间产生修订');
  const receipt = JSON.parse(readFileSync(out.receipt_path, 'utf8'));
  assertEqual(receipt.status, 'skipped');
  assertIncludes(receipt.import.reason, 'same_source_hash');
});

await testAsync('下载失败：保留已有值，回执记录失败与 last_check', async () => {
  const before = db.get("SELECT COUNT(*) c, MAX(updated_at) u FROM region_emission WHERE status='active'");
  const out = await collector.collectCarbonMonitor({
    fetchImpl: async () => { throw new Error('network down'); },
    now: '2026-10-21T12:00:00.000Z', actor: 'test:117', archiveDir: ARCHIVE,
  });
  assertEqual(out.ok, false);
  assertEqual(out.status, 'failed');
  assertIncludes(out.error, 'network down');
  assertEqual(out.last_check, '2026-10-21T12:00:00.000Z');
  const after = db.get("SELECT COUNT(*) c, MAX(updated_at) u FROM region_emission WHERE status='active'");
  assertEqual(after.c, before.c);
  assertEqual(after.u, before.u, '失败不得覆盖或迁移已有值');
  const receipt = JSON.parse(readFileSync(out.receipt_path, 'utf8'));
  assertEqual(receipt.status, 'failed');
  assertIncludes(receipt.error, 'network down');
});

await testAsync('新文件缺少年份时不删除已有年份', async () => {
  const out = await collector.collectCarbonMonitor({
    csvText: subsetCsv, now: NOW, actor: 'test:117', archiveDir: ARCHIVE,
  });
  assert(out.ok, out.error);
  const active2024 = db.get(
    "SELECT COUNT(*) c FROM region_emission WHERE status='active' AND year=2024 AND dataset_key=?",
    [collector.CARBONMONITOR_DATASET_KEY]
  ).c;
  assertEqual(active2024, 3, '只提供部分年份时，原有 2024 年 3 条不得被删除');
});

await testAsync('下载有界：HTML/错误体、跨域名重定向、超限响应都被拒绝', async () => {
  await expectReject(() => collector.downloadCarbonMonitorCsv({
    fetchImpl: async () => new Response('<html>error</html>', {
      status: 200, headers: { 'content-type': 'text/html' },
    }),
  }), '不是 CSV');
  await expectReject(() => collector.downloadCarbonMonitorCsv({
    fetchImpl: async () => new Response(null, {
      status: 302, headers: { location: 'https://evil.example/steal.csv' },
    }),
  }), '越出固定公开源域名');
  await expectReject(() => collector.downloadCarbonMonitorCsv({
    fetchImpl: async () => new Response('state,date,sector,value\n', {
      status: 200,
      headers: {
        'content-type': 'text/csv',
        'content-length': String(collector.MAX_DOWNLOAD_BYTES + 1),
      },
    }),
  }), '超过上限');
  await expectReject(() => collector.downloadCarbonMonitorCsv({
    timeoutMs: 20,
    fetchImpl: (url, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        reject(err);
      });
    }),
  }), '下载超时');
  const htmlRun = await collector.collectCarbonMonitor({
    fetchImpl: async () => new Response('<html>error</html>', {
      status: 200, headers: { 'content-type': 'text/html' },
    }),
    now: '2026-10-23T12:00:00.000Z', actor: 'test:117', archiveDir: ARCHIVE,
  });
  assertEqual(htmlRun.ok, false);
  assertIncludes(htmlRun.error, '不是 CSV');
  const active = db.get(
    "SELECT COUNT(*) c FROM region_emission WHERE status='active' AND dataset_key=?",
    [collector.CARBONMONITOR_DATASET_KEY]
  ).c;
  assertEqual(active, 6, '失败后已有活动记录仍在');
});

rmSync(ARCHIVE, { recursive: true, force: true });
finish('test/117-v2-regional-collector.test.mjs');
