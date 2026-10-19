/**
 * 用**已保存的真实来源快照**重新解析 CEA 日报，核对解析结果与官方原文的对应关系。
 * ============================================================================
 * 用途：不发起任何网络请求，直接读 source_snapshot 中的真实响应体，
 *       重跑解析 + 确定性核对，便于开发自检与独立验收逐字段对照。
 *
 * 用法：
 *   node scripts/cea-verify-parser.mjs                 # 全部 cneeex 快照
 *   node scripts/cea-verify-parser.mjs --url=<片段>     # 只核对 URL 含该片段的快照
 *   node scripts/cea-verify-parser.mjs --id=<快照ID>
 *   node scripts/cea-verify-parser.mjs --json           # 输出 JSON（便于比对）
 */
import { initV2Env, parseArgs } from './v2-env.mjs';

const args = parseArgs(process.argv.slice(2));
if (!process.env.CCER_DB_PATH) process.env.CCER_DB_PATH = 'data/cea-dev-20261014.db';
await initV2Env({ quiet: true });

const db = await import('../src/core/db.mjs');
const { parseCeaDailyReport, deriveDaily, runDailyChecks } = await import('../src/services/cea-parse.mjs');

db.getDb();
const where = [];
const params = [];
if (args.id) { where.push('id = ?'); params.push(String(args.id)); }
else if (args.url) { where.push('url LIKE ?'); params.push(`%${args.url}%`); }
else { where.push("url LIKE '%cneeex%'"); }
const snaps = db.all(
  `SELECT id,url,fetched_at,content_hash,body_text FROM source_snapshot
   ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY fetched_at`,
  params
);

if (!snaps.length) {
  console.error('未找到匹配的来源快照。请先运行：node scripts/cea.mjs collect --target=daily --sources=cea_daily_sample_1,cea_daily_sample_2');
  process.exit(2);
}

const report = { db: db.dbPath(), snapshots: snaps.length, results: [] };
for (const s of snaps) {
  const p = parseCeaDailyReport(s.body_text, { url: s.url });
  const d = deriveDaily(p.fields);
  const checks = runDailyChecks({ ...p.fields, ...d }, {
    dateInfo: { candidates: p.date_candidates, consistent: p.date_consistent, source: p.date_source },
  });
  const stored = db.get(
    'SELECT id,trade_date,open,high,low,close,change_pct,listed_volume,listed_turnover,block_volume,block_turnover,auction_volume,auction_turnover,total_volume,total_turnover,year_volume,year_turnover,lifetime_volume,lifetime_turnover,computed_avg_price,check_status FROM cea_trade_daily WHERE snapshot_id=?',
    [s.id]
  );
  report.results.push({
    snapshot_id: s.id, url: s.url, fetched_at: s.fetched_at, content_hash: s.content_hash,
    trade_date: p.trade_date, date_source: p.date_source, date_candidates: p.date_candidates,
    date_consistent: p.date_consistent, data_as_of: p.data_as_of,
    parse_status: p.parse_status, period: p.period,
    fields: p.fields, derived: d, raw_fields: p.raw_fields, units: p.units,
    missing_fields: p.missing_fields, explicit_none: p.explicit_none,
    unexpected_units: p.unexpected_units, invalid_fields: p.invalid_fields,
    checks: { status: checks.status, failed: checks.checks.filter((c) => !c.ok) },
    stored_row: stored || null,
    stored_matches_parse: stored
      ? ['open', 'high', 'low', 'close', 'change_pct', 'listed_volume', 'listed_turnover', 'block_volume',
        'block_turnover', 'auction_volume', 'auction_turnover', 'total_volume', 'total_turnover',
        'year_volume', 'year_turnover', 'lifetime_volume', 'lifetime_turnover'].every(
        (k) => (stored[k] === null && p.fields[k] === null) || Math.abs(Number(stored[k]) - Number(p.fields[k])) <= 1e-9
      )
      : null,
  });
}

if (args.json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`数据库：${report.db}`);
  console.log(`核对快照：${report.snapshots} 条\n`);
  for (const r of report.results) {
    console.log('─'.repeat(78));
    console.log(`来源：${r.url}`);
    console.log(`快照：${r.snapshot_id}｜抓取 ${r.fetched_at}｜sha256 ${String(r.content_hash).slice(0, 16)}…`);
    console.log(`交易日：${r.trade_date}（来源 ${r.date_source}）｜数据截止：${r.data_as_of}｜日期一致：${r.date_consistent}`);
    if (r.date_candidates?.length) console.log(`日期候选：${r.date_candidates.map((c) => `${c.date}(${c.source})`).join(', ')}`);
    console.log(`解析状态：${r.parse_status}｜周期：${r.period}｜确定性核对：${r.checks.status}`);
    const f = r.fields;
    console.log(`  开/高/低/收：${f.open} / ${f.high} / ${f.low} / ${f.close}｜涨跌幅 ${f.change_pct}`);
    console.log(`  挂牌：${f.listed_volume} 吨 / ${f.listed_turnover} 元`);
    console.log(`  大宗：${f.block_volume} 吨 / ${f.block_turnover} 元`);
    console.log(`  竞价：${f.auction_volume} 吨 / ${f.auction_turnover} 元  （明确无竞价字段：${r.explicit_none.join('、') || '无'}）`);
    console.log(`  合计：${f.total_volume} 吨 / ${f.total_turnover} 元｜计算均价 ${r.derived.computed_avg_price}`);
    console.log(`  年累计：${f.year_volume} 吨 / ${f.year_turnover} 元`);
    console.log(`  历史累计：${f.lifetime_volume} 吨 / ${f.lifetime_turnover} 元`);
    if (r.missing_fields.length) console.log(`  未披露（null）：${r.missing_fields.join('、')}`);
    if (r.unexpected_units.length) console.log(`  ⚠ 单位不符：${r.unexpected_units.join('、')}`);
    if (r.invalid_fields.length) console.log(`  ⚠ 被拒绝的候选值：${JSON.stringify(r.invalid_fields)}`);
    if (r.checks.failed.length) console.log(`  ✗ 未通过核对：${r.checks.failed.map((c) => `${c.check_key}(${c.detail})`).join('；')}`);
    console.log(`  入库行：${r.stored_row ? r.stored_row.id : '（无）'}｜与解析一致：${r.stored_matches_parse}`);
    console.log('  原文片段：');
    for (const [k, v] of Object.entries(r.raw_fields)) console.log(`    ${k}: ${String(v).slice(0, 130)}`);
  }
}
db.closeDb();
