/**
 * v2 数据导入脚本（CSV → 独立库）
 * ============================================================================
 * 用法：
 *   npm run v2:import -- --template=trade-daily --file=./daily.csv
 *   npm run v2:import -- --template=public-project --file=./projects.csv
 *   npm run v2:import -- --template=internal-project --file=./internal.csv
 *   npm run v2:import -- --template=trade-daily --file=./daily.csv --dry-run
 *   npm run v2:import -- --template=trade-daily --template-out=./模板.csv   # 只导出模板
 *
 * 【纪律】
 *   - 导入的行一律为「待核对」，不会直接成为正式口径；
 *   - 逐行校验（日期/数值范围/量价关系/唯一 ID），错误逐行列出，不静默丢弃；
 *   - 只写独立库；--dry-run 只校验不写库。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { initV2Env, parseArgs } from './v2-env.mjs';

const args = parseArgs();
const { dbPath } = await initV2Env({ temp: !!args.temp });

const db = await import('../src/core/db.mjs');
const templates = await import('../src/data/import-templates.mjs');
const trade = await import('../src/services/trade-svc.mjs');
const projectsV2 = await import('../src/services/project-v2-svc.mjs');

db.getDb();

if (args['template-out']) {
  const key = args['template-out'] === true ? args.template : args['template-out'];
  const csv = templates.templateCsv(key || 'trade-daily');
  if (!csv) {
    console.error(`✗ 未知模板：${key}`);
    process.exit(3);
  }
  const out = `./模板_${key}.csv`;
  writeFileSync(out, csv, 'utf8');
  console.log(`已导出模板：${out}`);
  db.closeDb();
  process.exit(0);
}

const key = args.template ? String(args.template) : null;
const file = args.file ? String(args.file) : null;
if (!key || !file) {
  console.error('用法：npm run v2:import -- --template=trade-daily --file=./daily.csv [--dry-run]');
  console.error(`可用模板：${Object.keys(templates.IMPORT_TEMPLATES).join('、')}`);
  process.exit(3);
}
const t = templates.getTemplate(key);
if (!t) {
  console.error(`✗ 未知模板：${key}`);
  process.exit(3);
}

let text;
try {
  text = readFileSync(file, 'utf8');
} catch (e) {
  console.error(`✗ 读取文件失败：${file}｜${e.message}`);
  process.exit(3);
}

const parsed = templates.rowsFromCsv(key, text);
console.log(`[v2:import] 库：${dbPath}`);
console.log(`[v2:import] 模板：${t.name}｜文件：${file}`);
console.log(`[v2:import] 解析：${parsed.rows.length} 行｜匹配列 ${parsed.matched_columns.length} 个${
  parsed.unknown_headers.length ? `｜未识别列：${parsed.unknown_headers.join('、')}` : ''
}`);
if (parsed.errors.length) {
  console.error(`✗ ${parsed.errors.join('；')}`);
  process.exit(4);
}

const user = { name: String(args.actor || 'cli-import'), role: 'admin', team_id: 'team-carbon' };

if (args['dry-run']) {
  // 干跑：只做行级校验，不写库
  let ok = 0;
  const rejected = [];
  for (const r of parsed.rows) {
    const errs = [];
    if (key === 'trade-daily') {
      if (!r.trade_date || !/^\d{4}-\d{2}-\d{2}$/.test(String(r.trade_date))) errs.push('交易日期格式');
      const v = Number(String(r.volume ?? '').replace(/[,，]/g, ''));
      if (r.volume !== null && !Number.isFinite(v)) errs.push('成交量非数值');
    } else if (!r.name) errs.push('缺少名称');
    if (errs.length) rejected.push({ row: r.__row, errors: errs });
    else ok += 1;
  }
  console.log(`[v2:import] --dry-run：通过 ${ok} 行，异常 ${rejected.length} 行（未写库）`);
  for (const r of rejected.slice(0, 20)) console.log(`    第 ${r.row} 行：${r.errors.join('；')}`);
  db.closeDb();
  process.exit(rejected.length ? 1 : 0);
}

if (key === 'trade-daily') {
  const out = trade.importTradeRows(user, parsed.rows, { sourceKind: `cli:${file}` });
  console.log(`[v2:import] 导入完成：接收 ${out.accepted_count} 行（新增 ${out.inserted}｜未变 ${out.unchanged}｜修订 ${out.revised}），拒绝 ${out.rejected_count} 行`);
  for (const r of out.rejected.slice(0, 20)) console.log(`    第 ${r.row} 行：${r.errors.join('；')}`);
  console.log(`    ${out.note}`);
  db.closeDb();
  process.exit(out.rejected_count ? 1 : 0);
}

if (key === 'public-project') {
  const out = projectsV2.importPublicProjects(user, parsed.rows);
  console.log(`[v2:import] 导入完成：接收 ${out.accepted_count} 行，拒绝 ${out.rejected_count} 行`);
  for (const r of out.rejected.slice(0, 20)) console.log(`    第 ${r.row} 行：${r.errors.join('；')}`);
  console.log(`    ${out.note}`);
  db.closeDb();
  process.exit(out.rejected_count ? 1 : 0);
}

if (key === 'internal-project') {
  let ok = 0;
  const errs = [];
  for (const r of parsed.rows) {
    const out = projectsV2.createInternalProject(user, {
      code: r.code, name: r.name, owner_name: r.owner_name, province: r.province, domain: r.domain,
      methodology_id: r.methodology_id, stage: r.stage, owner_announced_estimate: r.owner_announced_estimate,
      team_id: r.team_id, analyst: r.analyst, confidentiality: r.confidentiality,
      screening_conclusion: r.screening_conclusion, note: r.note,
    });
    if (out.error) errs.push({ row: r.__row, error: out.error });
    else ok += 1;
  }
  console.log(`[v2:import] 内部项目导入完成：成功 ${ok} 行，失败 ${errs.length} 行`);
  for (const e of errs.slice(0, 20)) console.log(`    第 ${e.row} 行：${e.error}`);
  db.closeDb();
  process.exit(errs.length ? 1 : 0);
}

db.closeDb();
