/**
 * CEA 阶段A 状态一览（开发/验收自检用）
 * ============================================================================
 * 一次打印：行情行（含核对与 AI 状态）、概览层跨层核对、来源层级、日历证据、
 * 政策配对覆盖计数、缺口与最近任务。用于逐项对照 docs/32 的实施记录。
 *
 * 用法：node scripts/cea-daily-report.mjs
 */
import { initV2Env } from './v2-env.mjs';

if (!process.env.CCER_DB_PATH) process.env.CCER_DB_PATH = 'data/cea-dev-20261014.db';
await initV2Env({ quiet: true });

const db = await import('../src/core/db.mjs');
const { uj } = await import('../src/core/util.mjs');
db.getDb();

const line = (s) => console.log(s);
line('═'.repeat(86));
line(`数据库：${db.dbPath()}｜schema_version=${db.metaValue('schema_version', '?')}｜CEA 迁移于 ${db.metaValue('schema_version_cea_applied', '?')}`);
line('═'.repeat(86));

line('\n【行情行】（官方值与推导值分列；缺失为 null，不用 0 填充）');
const rows = db.all('SELECT * FROM cea_trade_daily ORDER BY trade_date');
if (!rows.length) line('  （暂无）');
for (const r of rows) {
  line(`  ${r.trade_date}｜${r.instrument}/${r.price_regime}`);
  line(`    开/高/低/收 ${r.open}/${r.high}/${r.low}/${r.close}｜涨跌 ${r.change_pct}%｜昨收 ${r.prev_close ?? 'null'}`);
  line(`    挂牌 ${r.listed_volume} 吨 / ${r.listed_turnover} 元｜大宗 ${r.block_volume} / ${r.block_turnover}｜竞价 ${r.auction_volume} / ${r.auction_turnover}`);
  line(`    总 ${r.total_volume} 吨 / ${r.total_turnover} 元｜计算均价 ${r.computed_avg_price}`);
  line(`    年累计 ${r.year_volume} / ${r.year_turnover}｜历史累计 ${r.lifetime_volume} / ${r.lifetime_turnover}`);
  line(`    核对=${r.check_status}｜AI=${r.verification_status}｜修订=${r.revision}｜来源=${r.source_code || '—'}｜快照=${r.snapshot_id || '—'}`);
  line(`    来源URL=${r.source_url}`);
  const failed = db.all('SELECT check_key,detail FROM cea_check WHERE object_type=? AND object_id=? AND ok=0', ['cea_trade_daily', r.id]);
  if (failed.length) for (const f of failed) line(`    ⚠ ${f.check_key}：${f.detail}`);
}

line('\n【概览层】（官方舍入展示值；与精确值跨层核对，不覆盖精确值）');
const ovs = db.all('SELECT * FROM cea_daily_overview ORDER BY trade_date');
if (!ovs.length) line('  （暂无。dailyov.json 可能滞后于最新交易日）');
for (const o of ovs) {
  line(`  ${o.trade_date}｜今日 ${o.today_qty_text} / ${o.today_amt_text}｜累计 ${o.total_qty_text} / ${o.total_amt_text}`);
  for (const c of uj(o.cross_check_json, [])) {
    line(`    ${c.within_rounding ? '✓' : '✗'} ${c.field}：概览「${c.overview_text}」(${c.overview_approx}) vs 精确 ${c.precise}｜差 ${c.diff} ≤ 容差 ${c.tolerance}`);
  }
}

line('\n【来源层级】（精确通道 / 概览通道分别标记）');
for (const q of db.all('SELECT trade_date,channel,source_code,is_precise,is_overview,snapshot_id FROM cea_quote_source ORDER BY trade_date,channel')) {
  line(`  ${q.trade_date}｜${q.channel.padEnd(22)}｜精确=${q.is_precise} 概览=${q.is_overview}｜${q.source_code || '—'}｜${q.snapshot_id || '—'}`);
}

line('\n【CEA 独立日历证据】（当前有效集合 / 来源修订后保留的历史证据分列）');
const hol = db.all(
  "SELECT evidence_kind, source_state, COUNT(*) AS c, MIN(trade_date) AS f, MAX(trade_date) AS t " +
  'FROM cea_calendar GROUP BY evidence_kind, source_state ORDER BY evidence_kind, source_state'
);
if (!hol.length) line('  （暂无）');
for (const h of hol) {
  const state = h.source_state === 'superseded' ? '历史证据（过期，不作当前事实/告警依据）' : '当前有效集合';
  line(`  ${h.evidence_kind}［${state}］：${h.c} 条（${h.f} … ${h.t}）`);
}

line('\n【政策/技术/研报文件】（配对覆盖 + 附件关联 + 计数）');
for (const d of db.all('SELECT doc_key,title,doc_number,evidence_level,ai_status,count_in_stats,attachment_of,coverage_json,length(body_snapshot) AS blen FROM cea_document ORDER BY doc_key')) {
  const cov = uj(d.coverage_json, []);
  line(`  ${d.doc_key}`);
  line(`    ${d.title}`);
  line(`    文号=${d.doc_number || '—'}｜证据=${d.evidence_level}｜AI=${d.ai_status}｜正文 ${d.blen || 0} 字｜计入统计=${d.count_in_stats}${d.attachment_of ? `｜附件→${d.attachment_of}` : ''}`);
  if (cov.length) line(`    配对覆盖：${cov.map((c) => `${c.sector} ${(c.years || []).join('/')}`).join('；')}`);
}

line('\n【履约日历事件】（排放/配额/名录年度分列；日期是否已用原文核对）');
for (const e of db.all('SELECT event_key,event_type,deadline,emission_year,quota_year,list_year,date_verify_status,source_quote FROM cea_event ORDER BY COALESCE(deadline,\'9999\')')) {
  line(`  ${e.event_key}｜${e.event_type}｜${e.deadline}｜排放=${e.emission_year ?? '—'} 配额=${e.quota_year ?? '—'} 名录=${e.list_year ?? '—'}｜${e.date_verify_status}`);
  line(`    原文片段：${e.source_quote ? String(e.source_quote).slice(0, 150) : '（未在原文核对）'}`);
}

line('\n【名录 / 意向 / 缺口】');
line(`  名录 ${db.get('SELECT COUNT(*) AS c FROM cea_entity').c} 行（覆盖省 ${db.get('SELECT COUNT(DISTINCT province) AS c FROM cea_entity WHERE province IS NOT NULL').c} 个）`);
line(`  意向 ${db.get('SELECT COUNT(*) AS c FROM cea_intention').c} 行（不计入成交统计）`);
for (const g of db.all("SELECT dataset,severity,title FROM data_gap WHERE dataset LIKE 'cea%' AND status='open' ORDER BY dataset,severity")) {
  line(`  [缺口/${g.severity}] ${g.dataset}｜${g.title}`);
}

line('\n【核验汇总】（真实调用日志见 npm run cea:verify-detail）');
for (const v of db.all("SELECT result, COUNT(*) AS c FROM verification_result WHERE object_type IN ('cea_trade_daily','cea_document') GROUP BY result ORDER BY result")) {
  line(`  ${v.result}：${v.c}`);
}
const calls = db.get("SELECT COUNT(*) AS c, SUM(latency_ms) AS ms FROM llm_call_log WHERE purpose LIKE 'cea%'");
line(`  真实模型调用：${calls.c} 次，累计 ${calls.ms || 0} ms`);

line('\n【最近任务】');
for (const j of db.all("SELECT job_key,status,started_at,items_found,items_published,error_count,error_summary FROM ingestion_job WHERE job_key LIKE 'cea%' ORDER BY started_at DESC LIMIT 8")) {
  line(`  ${j.started_at}｜${j.job_key}｜${j.status}｜发现 ${j.items_found} 发布 ${j.items_published} 错误 ${j.error_count}${j.error_summary ? `｜${String(j.error_summary).slice(0, 90)}` : ''}`);
}
line('');
db.closeDb();
