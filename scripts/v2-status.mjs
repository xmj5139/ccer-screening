/**
 * v2 状态自检脚本
 * ============================================================================
 * 输出：库路径与隔离状态、表就绪情况、各数据集条数、最新交易日行情、
 *       待核对/待审核/未结清差异、数据缺口清单、官方数据源连通性（--probe）。
 *
 * 用法：
 *   npm run v2:status
 *   npm run v2:status -- --probe      # 额外做一次官方来源连通性探测（只读网络）
 */
import { initV2Env, parseArgs } from './v2-env.mjs';

const args = parseArgs();
const { dbPath } = await initV2Env({ temp: !!args.temp, quiet: true });

const db = await import('../src/core/db.mjs');
const guard = await import('../src/services/v2-guard.mjs');
const trade = await import('../src/services/trade-svc.mjs');
const collect = await import('../src/services/collect-svc.mjs');
const reconcile = await import('../src/services/reconcile-svc.mjs');

db.getDb();
const st = guard.v2Status();
const sync = collect.syncStatus();
const rec = reconcile.reconciliationStats();

const counts = {};
if (st.tables_ok) {
  for (const t of [
    'policy_document', 'policy_attachment', 'policy_change',
    'methodology_version', 'methodology_doc_verification', 'methodology_interpretation',
    'public_project', 'project_event', 'reduction_batch', 'internal_project', 'internal_project_link',
    'trade_daily', 'trade_dimension', 'trade_calendar', 'trade_cumulative_reference', 'trade_revision',
    'source_snapshot', 'ingestion_job', 'ingestion_step', 'data_reconciliation', 'review_task',
    'notification', 'data_gap', 'datasource_config', 'llm_provider',
  ]) {
    try {
      counts[t] = db.get(`SELECT COUNT(*) AS c FROM ${t}`)?.c ?? 0;
    } catch {
      counts[t] = null;
    }
  }
}

console.log('');
console.log('  CCER 平台 v2 状态自检');
console.log('  ═════════════════════════════════════════════');
console.log(`  数据库路径        ${dbPath}`);
console.log(`  隔离检查          ${st.production_db ? '✗ 指向在用生产库（写操作被拒绝）' : '✓ 非在用生产库'}`);
console.log(`  CCER_ENABLE_V2    ${process.env.CCER_ENABLE_V2}`);
console.log(`  v2 表结构         ${st.tables_ok ? '✓ 完整' : `✗ 缺 ${st.missing_tables.length} 张：${st.missing_tables.slice(0, 5).join('、')}`}`);
console.log(`  数据截至          ${sync.data_as_of || '（尚无行情）'}`);
console.log(`  最后成功同步      ${sync.last_success_sync || '（从未）'}`);
console.log(`  待审核任务        ${sync.counts.pending_review}`);
console.log(`  待核对行情        ${sync.counts.pending_trade_verify}`);
console.log(`  未结清差异        ${sync.counts.open_issues}（严重 ${rec.critical}｜警告 ${rec.warning}｜提示 ${rec.info}）`);
if (sync.alert) console.log(`  ⚠ 告警            ${sync.alert}`);

if (st.tables_ok) {
  console.log('  ─────────────────────────────────────────────');
  console.log('  表计数：');
  for (const [k, v] of Object.entries(counts)) {
    console.log(`    ${k.padEnd(30, ' ')} ${v === null ? '（不存在）' : v}`);
  }
  const latest = trade.tradeOverview({ range_days: 365 });
  if (latest.latest_traded) {
    const l = latest.latest_traded;
    console.log('  ─────────────────────────────────────────────');
    console.log(`  最新有成交交易日  ${l.trade_date}｜成交量 ${l.volume} tCO₂e｜成交额 ${l.turnover} 元｜披露均价 ${l.avg_price ?? '—'} 元/tCO₂e`);
    console.log(`  官方累计（披露）  ${latest.cumulative.official_latest ? `${latest.cumulative.official_latest.volume_total} 吨 / ${latest.cumulative.official_latest.turnover_total} 元（截至 ${latest.cumulative.official_latest.as_of_date}）` : '（未采集）'}`);
  }
  const gaps = db.all("SELECT gap_key, title, severity FROM data_gap WHERE status = 'open' ORDER BY severity DESC");
  if (gaps.length) {
    console.log('  ─────────────────────────────────────────────');
    console.log(`  未结清数据缺口 ${gaps.length} 项：`);
    for (const g of gaps) console.log(`    [${g.severity}] ${g.title}`);
  }
}

if (args.probe) {
  console.log('  ─────────────────────────────────────────────');
  console.log('  官方数据源连通性（只读探测，不写库）：');
  const probes = [
    { name: '交易系统 · 每日行情公告列表', url: trade.TRADE_SOURCES.list_json, parser: 'ccer_trade_list_json' },
    { name: '交易系统 · 分行业行情（示例日）', url: trade.TRADE_SOURCES.dimension_json('20260923'), parser: 'ccer_trade_first_json' },
    { name: '生态环境部 · 方法学发布通知（示例）', url: 'https://www.mee.gov.cn/xxgk2018/xxgk/xxgk06/202501/t20250103_1099965.html', parser: 'html_document' },
    { name: '生态环境部 · 气候司栏目页', url: 'https://www.mee.gov.cn/xxgk2018/xxgk/xxgk06/', parser: 'html_list' },
  ];
  for (const p of probes) {
    const out = await collect.testDatasourceConnection({
      url: p.url, parser: p.parser, timeout_ms: 15000, retry_max: 1, rate_limit_per_min: 12,
      allowed_domains: '["www.ccer.com.cn","www.mee.gov.cn"]',
    });
    const ok = out.ok ? '✓' : '✗';
    console.log(`    ${ok} ${p.name}`);
    console.log(`        ${out.ok ? `HTTP ${out.status}｜${out.bytes} 字节｜${out.elapsed_ms} ms｜${out.parse_note || '未解析'}` : out.error}`);
  }
}

console.log('  ═════════════════════════════════════════════');
console.log('');
db.closeDb();
