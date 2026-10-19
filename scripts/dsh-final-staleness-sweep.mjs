#!/usr/bin/env node
/**
 * 只读终检：四项整改相关的**所有**提醒/告警/缺口/差异是否还有「已结清却仍待关注」
 * 或「与实时状态矛盾」的陈旧内容。不写库。
 */
process.env.CCER_ENABLE_V2 = process.env.CCER_ENABLE_V2 || '1';
process.env.CCER_DB_PATH = process.env.CCER_DB_PATH || 'data/ccer_v2.db';

const { all, get, closeDb } = await import('../src/core/db.mjs');
const collect = await import('../src/services/collect-svc.mjs');
const dash = await import('../src/services/dashboard-svc.mjs');
const archiveSvc = await import('../src/services/policy-archive-svc.mjs');

const out = { problems: [], notes: [] };

console.log('=== 1. 提醒 → 所指对象状态 ===');
for (const n of all('SELECT * FROM notification ORDER BY created_at DESC')) {
  const st = collect.notificationSubjectState(n);
  const settled = collect.notificationSettled(n);
  const flag = !n.resolved_at && settled ? '✗ 已结清却未记录' : n.resolved_at && !settled ? '✗ 记录了结清但对象仍未结清' : '✓';
  console.log(`${flag} ${n.id}｜${n.title}｜对象 ${n.object_type}/${n.object_id}｜状态 ${st?.status ?? '(不可判定)'}｜resolved_at=${n.resolved_at ? '有' : '无'}`);
  if (flag.startsWith('✗')) out.problems.push(`notification ${n.id}: ${flag}`);
}

console.log('\n=== 2. 告警（open）与实时状态一致性 ===');
for (const a of all("SELECT * FROM alert WHERE status='open' ORDER BY created_at")) {
  // 「（无人工待办）」是现行口径的正向表述，不属于人工待办措辞
  const manual = /须由研究员|需人工|须人工|人工核对|人工按周期|(?<!无)人工待办/.test(`${a.title}${a.detail}`);
  const blocked = /自动核验受阻/.test(`${a.detail}`);
  console.log(`${manual ? '✗' : '✓'} [${a.severity}] ${a.kind}｜${a.title}${blocked ? '（已标注自动核验受阻）' : ''}`);
  if (manual) out.problems.push(`alert ${a.id}: 仍含人工待办措辞`);
}

console.log('\n=== 3. 缺口：台账 vs 实时状态 ===');
for (const g of all("SELECT * FROM data_gap WHERE status='open' ORDER BY gap_key")) {
  if (g.gap_key === 'gap-policy-original-archive') {
    const live = archiveSvc.policyArchiveGapState();
    const same = g.title === live.title && g.status === live.status;
    console.log(`${same ? '✓' : '✗'} ${g.gap_key}｜台账：${g.title}`);
    console.log(`   实时：${live.title}（未归档 ${live.pending.length}，正文不可提取 ${live.unparsed.length}）`);
    if (!same) out.problems.push(`data_gap ${g.gap_key}: 台账与实时状态不一致`);
    continue;
  }
  console.log(`· ${g.gap_key}｜${g.title}`);
}

console.log('\n=== 4. 未结清差异（按数据集/检查类型汇总） ===');
for (const r of all(`SELECT dataset, check_kind, severity, COUNT(*) c FROM data_reconciliation WHERE status='open' GROUP BY 1,2,3 ORDER BY 1,2`)) {
  console.log(`  ${r.dataset}/${r.check_kind} [${r.severity}] × ${r.c}`);
}

console.log('\n=== 5. 总览更新流（浏览器「自动运行状态」同路径） ===');
const feed = dash.updateFeed({ limit: 12 });
console.log('counts:', JSON.stringify(feed.counts));
for (const i of feed.items) console.log(`  [${i.severity}] ${i.kind}｜${i.status}｜${i.title}`);
const pendingStale = all('SELECT * FROM notification').filter((n) => !n.resolved_at && collect.notificationSettled(n));
console.log(`\n仍被当作待关注但所指问题已结清的提醒：${pendingStale.length} 条`);

console.log('\n=== 6. 「四项整改」相关残留 ===');
const related = all(
  `SELECT id, dataset, object_id, object_label, check_kind, severity, status, substr(detail,1,110) detail
   FROM data_reconciliation
   WHERE status='open' AND (
     object_id LIKE '%2025-03%' OR object_label LIKE '%淤地坝%' OR object_id LIKE '%14-005%'
     OR object_label LIKE '%CCER-10-00%' OR check_kind LIKE '%attachment%' OR check_kind LIKE '%catalog%'
     OR object_label LIKE '%2025-03-2%')`
);
if (!related.length) console.log('  无与交易日/淤地坝/目录编号/原件归档相关的未结清差异 ✓');
for (const r of related) console.log(`  [${r.severity}] ${r.dataset}/${r.check_kind}｜${r.object_label}｜${r.status}\n     ${r.detail}`);

console.log('\n=== 7. policy_change（原文变化自动检测） ===');
const pc = all("SELECT review_status, COUNT(*) c FROM policy_change GROUP BY review_status");
console.log(JSON.stringify(pc));

console.log('\n=== 结论 ===');
console.log(out.problems.length ? `✗ 发现 ${out.problems.length} 处问题：\n  ${out.problems.join('\n  ')}` : '✓ 未发现「已结清却仍待关注」或与实时状态矛盾的陈旧内容');
closeDb();
