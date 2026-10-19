#!/usr/bin/env node
/**
 * 只读排查：总览「自动运行状态」与「数据缺口」为何仍显示已结清/过期内容。
 * 不写库。用法：node scripts/dsh-inspect-stale-feed.mjs
 */
process.env.CCER_ENABLE_V2 = process.env.CCER_ENABLE_V2 || '1';
process.env.CCER_DB_PATH = process.env.CCER_DB_PATH || 'data/ccer_v2.db';

const { all, get, dbPath, closeDb } = await import('../src/core/db.mjs');
const collect = await import('../src/services/collect-svc.mjs');

console.log(`库：${dbPath()}\n`);

const dump = (label, rows) => {
  console.log(`--- ${label}（${rows.length}） ---`);
  for (const r of rows) console.log(JSON.stringify(r));
  console.log('');
};

dump('alert 全部（按时间倒序）', all('SELECT * FROM alert ORDER BY created_at DESC LIMIT 50'));
dump('data_reconciliation 提及 2025-03 / trade', all(
  "SELECT id,dataset,object_id,object_label,check_kind,severity,status,detected_at,resolved_at,resolved_by,substr(detail,1,160) detail FROM data_reconciliation WHERE dataset='trade' ORDER BY detected_at DESC LIMIT 60"
));
dump('notification 全部 kind/object', all(
  'SELECT id,kind,severity,impact_level,title,object_type,object_id,created_at,read_at,substr(detail,1,200) detail FROM notification ORDER BY created_at DESC LIMIT 60'
));
dump('data_gap 全部', all('SELECT * FROM data_gap ORDER BY severity, gap_key'));

console.log('--- updateFeed 当前输出（界面同路径） ---');
const feed = collect && null;
const dash = await import('../src/services/dashboard-svc.mjs');
const uf = dash.updateFeed({ limit: 30 });
console.log('counts:', JSON.stringify(uf.counts));
for (const it of uf.items) {
  console.log(`[${it.severity}] ${it.kind} | ${it.status} | ${it.title} | object=${it.id} | at=${it.at}`);
  if (it.detail) console.log(`    ${String(it.detail).slice(0, 220)}`);
}
console.log('\n--- regionView().data_gaps（界面同路径） ---');
for (const g of dash.regionView(dash.parseFilters({})).data_gaps) {
  console.log(`[${g.severity}] ${g.gap_key} | ${g.status} | ${g.title}`);
  console.log(`   impact: ${g.impact}`);
  console.log(`   auto_action: ${g.auto_action}`);
  console.log(`   description: ${String(g.description).slice(0, 400)}`);
}
void feed;
closeDb();
