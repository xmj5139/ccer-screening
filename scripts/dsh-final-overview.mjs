#!/usr/bin/env node
/**
 * 只读终检：用界面同一条代码路径渲染「总览」与「政策/方法学」口径，
 * 确认整改后总览展示的未结清告警 / 缺口 / 差异即为最终状态。
 * 不写库、不建会话、不产生登录日志。
 */
process.env.CCER_ENABLE_V2 = process.env.CCER_ENABLE_V2 || '1';
process.env.CCER_DB_PATH = process.env.CCER_DB_PATH || 'data/ccer_v2.db';

const dash = await import('../src/services/dashboard-svc.mjs');
const collect = await import('../src/services/collect-svc.mjs');
const policy = await import('../src/services/policy-svc.mjs');
const reconcile = await import('../src/services/reconcile-svc.mjs');

const region = dash.regionView(dash.parseFilters({}));
console.log('=== 总览：系统状态横幅 ===');
console.log(JSON.stringify(region.banner ?? region.system ?? null, null, 1).slice(0, 1500));

console.log('\n=== 总览：数据缺口 ===');
for (const g of region.data_gaps || []) {
  console.log(`- [${g.severity}] ${g.gap_key} | ${g.status} | ${g.title}`);
  console.log(`    ${String(g.description).slice(0, 260)}`);
}

console.log('\n=== 总览：未结清告警 ===');
for (const a of region.alerts || []) {
  console.log(`- [${a.severity}] ${a.kind} | ${a.status_label || a.status} | ${a.title}`);
}

console.log('\n=== 同步状态口径 ===');
const sync = collect.syncStatus();
console.log(JSON.stringify({ data_as_of: sync.data_as_of, counts: sync.counts }, null, 1));

console.log('\n=== 政策统计 ===');
console.log(JSON.stringify(policy.policyStats(), null, 1));

console.log('\n=== 方法学目录计数 ===');
console.log(JSON.stringify(policy.listMethodologiesV2({}).counts, null, 1));

console.log('\n=== 未结清差异统计 ===');
console.log(JSON.stringify(reconcile.reconciliationStats(), null, 1));

const { closeDb } = await import('../src/core/db.mjs');
closeDb();
