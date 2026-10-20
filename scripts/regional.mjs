/**
 * 省域地图 · 排放资料 CLI（docs/59）
 * ============================================================================
 * 用法：
 *   node scripts/regional.mjs status [--json]
 *   node scripts/regional.mjs import --file=<path> [--format=json|csv]
 *                                   [--dry-run] [--actor=<name>]
 *   node scripts/regional.mjs bootstrap [--dry-run] [--actor=<name>]
 *   node scripts/regional.mjs collect [--dry-run] [--json] [--archive-dir=<path>]
 *
 * 安全约束：
 *   - 只使用 CCER_DB_PATH 指向的独立库；默认与其它 v2 脚本一致为 data/ccer_v2.db；
 *   - 若指向在用生产库 data/ccer.db，initV2Env 直接退出；
 *   - 不读取、不打印任何凭据；
 *   - 导入先完整校验，任一行不通过则**整批不写**；
 *   - 不把管理员录入自动标成官方核实；source_kind 按来源声明原样保存，
 *     verification_status 固定为 source_recorded；
 *   - 修订不覆盖旧行：旧 active 行标记 superseded，新行 revision_of 指向旧行。
 *
 * 虚构示例（非真实值，运行时不会自动种入；JSON 数组或 { "records": [...] }）：
 *   [{
 *     "province": "北京市", "scope": "region_co2", "year": 2022,
 *     "value_tco2": 12345678, "unit": "tCO2",
 *     "methodology": "CEADs 省级部门核算清单", "boundary": "30省47部门；研究核算",
 *     "dataset_key": "ceads-2022-provincial",
 *     "source_name": "CEADs", "source_url": "https://www.ceads.net/data/carbon-inventory/provincial-level/",
 *     "source_kind": "research", "published_at": "2024-12-31",
 *     "excerpt": "原文证据片段（至少 12 字，包含排放/CO2/单位关键词）"
 *   }]
 *   其中 12345678 是虚构示例，非真实值；请勿据此声明任何省份的真实排放量。
 */
import { readFileSync, statSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { initV2Env, parseArgs } from './v2-env.mjs';

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0] || 'status';

await initV2Env({ temp: !!args.temp, quiet: true });
const db = await import('../src/core/db.mjs');
const regional = await import('../src/services/region-map-svc.mjs');
const regionalCollect = await import('../src/services/regional-collect-svc.mjs');

let exitCode = 0;
const printJson = (v) => console.log(JSON.stringify(v, null, 2));

function printStatus(st) {
  console.log('');
  console.log('  省域排放资料状态');
  console.log('  ═════════════════════════════════════════════');
  console.log(`  数据库              ${st.database || db.dbPath()}`);
  console.log(`  region_emission     ${st.table_ready ? '✓ 就绪' : '✗ 未迁移'}`);
  if (!st.ok) {
    console.log(`  状态                ${st.message || st.error || '不可用'}`);
    return;
  }
  console.log(`  有效记录            ${st.counts.active}`);
  console.log(`  修订历史            ${st.counts.superseded}`);
  console.log(`  最新年度            ${st.coverage.latest_year ?? '（尚无排放记录）'}`);
  console.log(`  项目库              ${st.projects.count} 个（${st.projects.provinces} 个省份文本）`);
  console.log(`  全国碳市场名录      ${st.directory.total} 条｜年度 ${st.directory.years.join('、') || '—'}｜省份 ${st.directory.provinces} 个`);
  if (st.datasets.length) {
    console.log('  ─────────────────────────────────────────────');
    console.log('  数据集：');
    for (const d of st.datasets) {
      console.log(
        `    ${d.scope.padEnd(12, ' ')} ${d.dataset_key.padEnd(28, ' ')} `
        + `${d.min_year}–${d.max_year}｜${d.provinces} 省｜${d.source_kind}｜${d.source_name}`
      );
    }
  }
  if (st.counts.active === 0) {
    console.log('  ─────────────────────────────────────────────');
    console.log('  说明：尚无通过校验的省级排放记录；不显示 0 或演示热力。');
  }
  console.log('  ═════════════════════════════════════════════');
  console.log('');
}

function readImportFile(file) {
  const full = resolve(process.cwd(), file);
  const st = statSync(full);
  if (!st.isFile()) throw new Error(`不是普通文件：${full}`);
  if (st.size > 5 * 1024 * 1024) throw new Error('导入文件超过 5 MB，已拒绝');
  return { full, text: readFileSync(full, 'utf8') };
}

try {
  if (args.help || cmd === 'help') {
    console.log('用法：');
    console.log('  node scripts/regional.mjs status [--json] [--temp]');
    console.log('  node scripts/regional.mjs import --file=<path> [--format=json|csv] [--dry-run] [--actor=<name>] [--temp]');
    console.log('  node scripts/regional.mjs bootstrap [--file=<path>] [--dry-run] [--actor=<name>] [--temp]');
    console.log('  node scripts/regional.mjs collect [--dry-run] [--json] [--archive-dir=<path>] [--temp]');
    exitCode = 0;
  } else if (cmd === 'status') {
    db.getDb();
    const st = regional.regionMapStatus();
    if (args.json) printJson(st);
    else printStatus(st);
    exitCode = st.ok ? 0 : 1;
  } else if (cmd === 'import') {
    const file = args.file;
    if (!file || file === true) throw new Error('缺少 --file=<path>');
    const { full, text } = readImportFile(file);
    const inferred = extname(full).toLowerCase() === '.json' ? 'json'
      : extname(full).toLowerCase() === '.csv' ? 'csv' : null;
    const format = String(args.format || inferred || '').toLowerCase();
    if (!['json', 'csv'].includes(format)) throw new Error('无法判断格式，请显式传 --format=json 或 --format=csv');
    let records;
    if (format === 'json') {
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch (e) {
        throw new Error(`JSON 解析失败：${e.message}`);
      }
      records = Array.isArray(parsed) ? parsed : parsed?.records;
      if (!Array.isArray(records)) throw new Error('JSON 必须是记录数组或 { "records": [...] }');
    } else {
      const parsed = regional.rowsFromRegionCsv(text);
      if (!parsed.ok) throw new Error(parsed.error);
      records = parsed.rows;
    }
    db.getDb();
    const actor = String(args.actor || 'cli:regional');
    const out = regional.importRegionRecords(records, { actor, dryRun: !!args['dry-run'] });
    if (args.json) printJson({ ...out, file: full, format, actor });
    if (!args.json) {
      if (!out.ok) {
        console.log('');
        console.log(`  ✗ 导入未写入：${out.error}`);
        for (const e of out.errors.slice(0, 20)) console.log(`    第 ${e.row} 行：${e.error}`);
        if (out.errors.length > 20) console.log(`    ……另有 ${out.errors.length - 20} 条错误`);
        console.log('');
      } else if (out.dry_run) {
        console.log('');
        console.log(`  ✓ 校验通过（dry-run，未写库）：${out.valid} 条`);
        console.log('');
      } else {
        console.log('');
        console.log(`  ✓ 导入完成：总计 ${out.total} 条｜新增 ${out.inserted}｜修订 ${out.revised}｜未变 ${out.unchanged}`);
        console.log('');
      }
    }
    exitCode = out.ok ? 0 : 1;
  } else if (cmd === 'bootstrap') {
    // 显式导入 src/data 中已核实的公开 bootstrap；不在任何新库/日更中自动执行。
    const file = args.file && args.file !== true
      ? args.file
      : 'src/data/regional-carbonmonitor-annual.json';
    const { full, text } = readImportFile(file);
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      throw new Error(`bootstrap JSON 解析失败：${e.message}`);
    }
    const records = Array.isArray(parsed) ? parsed : parsed?.records;
    if (!Array.isArray(records)) throw new Error('bootstrap JSON 必须是记录数组或 { "records": [...] }');
    db.getDb();
    const actor = String(args.actor || 'cli:regional-bootstrap');
    const out = regional.importRegionRecords(records, { actor, dryRun: !!args['dry-run'] });
    if (args.json) printJson({ ...out, file: full, actor, source: 'bootstrap' });
    if (!args.json) {
      if (!out.ok) {
        console.log(`  ✗ bootstrap 未写入：${out.error}`);
        for (const e of out.errors.slice(0, 20)) console.log(`    第 ${e.row} 行：${e.error}`);
      } else if (out.dry_run) {
        console.log(`  ✓ bootstrap 校验通过（dry-run，未写库）：${out.valid} 条`);
      } else {
        console.log(`  ✓ bootstrap 导入完成：总计 ${out.total} 条｜新增 ${out.inserted}｜修订 ${out.revised}｜未变 ${out.unchanged}`);
      }
    }
    exitCode = out.ok ? 0 : 1;
  } else if (cmd === 'collect') {
    db.getDb();
    const actor = String(args.actor || 'cli:regional-collect');
    const archiveDir = args['archive-dir'] && args['archive-dir'] !== true
      ? String(args['archive-dir']) : undefined;
    const out = await regionalCollect.runRegionalDailyCollect({
      actor, archiveDir, dryRun: !!args['dry-run'],
    });
    if (args.json) {
      printJson(out);
    } else {
      console.log('');
      console.log(`  省域公开源采集｜${out.status === 'ok' ? '成功' : out.status === 'skipped' ? '跳过入库' : '失败'}`);
      console.log(`  来源              ${out.source_url || regionalCollect.CARBONMONITOR_SOURCE_URL}`);
      console.log(`  最后一次检查      ${out.last_check || '—'}`);
      if (out.sha256) console.log(`  原件 SHA-256      ${out.sha256}`);
      console.log(`  覆盖年份          ${(out.coverage?.years || []).join('、') || '未取得完整年份'}`);
      console.log(`  覆盖省份/记录     ${out.coverage?.provinces || 0} 省 / ${out.coverage?.records || 0} 条`);
      if (out.import?.skipped) console.log(`  跳过原因          ${out.import.reason || '未导入'}`);
      else if (out.import) console.log(`  入库             新增 ${out.import.inserted || 0}｜修订 ${out.import.revised || 0}｜未变 ${out.import.unchanged || 0}`);
      if (out.error) console.log(`  错误              ${out.error}`);
      console.log(`  回执              ${out.receipt_path || '—'}`);
      console.log('');
    }
    exitCode = out.ok ? 0 : 1;
  } else {
    console.error(`未知命令：${cmd}。可用命令：status / import / bootstrap / collect`);
    exitCode = 2;
  }
} catch (e) {
  console.error(`✗ ${e.message}`);
  exitCode = 2;
} finally {
  try { db.closeDb(); } catch { /* ignore */ }
}
process.exitCode = exitCode;
