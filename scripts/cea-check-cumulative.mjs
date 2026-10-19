/**
 * 校验 CEA 累计字段的可复算性（确定性，不依赖模型）。
 * 逐项核对：COMCEA 三行分项之和 == cea_trade_daily 中存储的累计值。
 * 用法：node scripts/cea-check-cumulative.mjs [--date=YYYY-MM-DD]
 */
import { initV2Env, parseArgs } from './v2-env.mjs';

const args = parseArgs(process.argv.slice(2));
if (!process.env.CCER_DB_PATH) process.env.CCER_DB_PATH = 'data/cea-dev-20261014.db';
await initV2Env({ quiet: true });

const db = await import('../src/core/db.mjs');
const { buildCumulativeAggregation } = await import('../src/services/verification-svc.mjs');
db.getDb();

const rows = args.date
  ? db.all('SELECT * FROM cea_trade_daily WHERE trade_date=?', [String(args.date)])
  : db.all('SELECT * FROM cea_trade_daily ORDER BY trade_date');

let failed = 0;
for (const row of rows) {
  const agg = buildCumulativeAggregation(row);
  console.log('─'.repeat(78));
  console.log(`交易日 ${row.trade_date}（记录 ${row.id}）`);
  if (!agg.rule) {
    console.log(`  ⚠ ${agg.note}`);
    continue;
  }
  const sums = {
    total_volume: agg.addend_values.total_volume,
    total_turnover: agg.addend_values.total_turnover,
    year_volume: agg.addend_values.year_volume,
    year_turnover: agg.addend_values.year_turnover,
    lifetime_volume: agg.addend_values.lifetime_volume,
    lifetime_turnover: agg.addend_values.lifetime_turnover,
  };
  for (const [field, addends] of Object.entries(sums)) {
    if (!addends || !addends.length) continue;
    const sum = addends.reduce((a, b) => a + b, 0);
    const stated = Number(agg.stated_value[field]);
    const rounded = /turnover/.test(field) ? Math.round(sum * 100) / 100 : sum;
    const ok = Math.abs(rounded - stated) <= (/turnover/.test(field) ? 0.011 : 1e-6);
    if (!ok) failed += 1;
    console.log(`  ${ok ? '✓' : '✗'} ${field}：分项 ${addends.map((n) => n.toLocaleString('en-US')).join(' + ')} = ${rounded.toLocaleString('en-US')}；存储值 ${stated.toLocaleString('en-US')}`);
  }
  console.log(`  挂牌/大宗/竞价 分项：${['listed', 'block', 'auction'].map((m) => `${m}=${agg.addends[m] ? agg.addends[m].volume : '—'}`).join('，')}`);
}
console.log('─'.repeat(78));
console.log(failed === 0 ? '全部累计字段均可由官方分项复算一致。' : `✗ ${failed} 个累计字段与分项之和不一致。`);
db.closeDb();
process.exit(failed === 0 ? 0 : 1);
