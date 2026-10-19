#!/usr/bin/env node
/** 只读：按界面同路径打印总览「自动运行状态」与「数据缺口」，并扫描净化后的病句。 */
process.env.CCER_ENABLE_V2 = process.env.CCER_ENABLE_V2 || '1';
process.env.CCER_DB_PATH = process.env.CCER_DB_PATH || 'data/ccer_v2.db';

const dash = await import('../src/services/dashboard-svc.mjs');
const { closeDb } = await import('../src/core/db.mjs');

const feed = dash.updateFeed({ limit: 12 });
console.log('counts:', JSON.stringify(feed.counts));
for (const i of feed.items) {
  console.log(`[${i.severity}] ${i.kind} | ${i.status} | ${i.title}`);
  if (i.detail) console.log(`    ${i.detail}`);
}
console.log('\nnote:', feed.note);

const region = dash.regionView(dash.parseFilters({}));
console.log('\n=== 数据缺口（总览「数据缺口与自动补全状态」） ===');
for (const g of region.data_gaps) {
  console.log(`[${g.severity}] ${g.gap_key} | ${g.status} | ${g.title}`);
  console.log(`   impact: ${g.impact}`);
  console.log(`   auto_action: ${g.auto_action}`);
  console.log(`   description: ${String(g.description).slice(0, 300)}`);
}

/* 病句扫描：净化后不该出现「无自动运行状态」「不设自动运行状态」等否定式被改写 */
const bad = [];
const scan = (where, s) => {
  if (typeof s !== 'string') return;
  for (const pat of ['无自动运行状态', '不设自动运行状态', '不需要自动运行状态']) {
    if (s.includes(pat)) bad.push({ where, pat, s: s.slice(0, 160) });
  }
};
for (const i of feed.items) { scan(`feed:${i.id}`, i.title); scan(`feed:${i.id}`, i.detail); }
for (const g of region.data_gaps) { scan(`gap:${g.gap_key}`, g.title); scan(`gap:${g.gap_key}`, g.impact); scan(`gap:${g.gap_key}`, g.description); scan(`gap:${g.gap_key}`, g.auto_action); }
console.log('\n=== 病句扫描 ===');
console.log(bad.length ? JSON.stringify(bad, null, 1) : '未发现被净化规则改写的病句 ✓');
closeDb();
