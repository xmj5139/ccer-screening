/**
 * v2 每日更新脚本（采集 → 解析 → 校验 → 待审核 → 发布）
 * ============================================================================
 * 默认动作：
 *   1. 采集官方「每日行情」公告（新增交易日；--limit 控制单次最多抓取天数）
 *   2. 采集分行业行情维度
 *   3. 巡检已收录政策的官方页面（内容哈希变化 → 生成待确认变更）
 *   4. 巡检官方公告栏目（发现待收录公告；栏目页不可用时如实记录失败）
 *   5. 执行交易 / 项目 / 政策 / 因子四组核对，生成待核任务与提醒
 *
 * 用法：
 *   npm run v2:daily                    # 增量（只抓未入库的交易日），最多 40 天
 *   npm run v2:daily -- --limit=400     # 全量补齐（官方列表共约 381 条公告，注意限流）
 *   npm run v2:daily -- --datasets=trade,policy
 *   npm run v2:daily -- --no-dimension  # 不抓分行业维度
 *   npm run v2:daily -- --checks-only   # 只跑核对，不联网
 *
 * 【纪律】本脚本只写入独立库；采集结果一律进入「待核对」，不会自动改写正式规则或历史报告。
 */
import { initV2Env, parseArgs } from './v2-env.mjs';

const args = parseArgs();
const { dbPath } = await initV2Env({ temp: !!args.temp });

const db = await import('../src/core/db.mjs');
const collect = await import('../src/services/collect-svc.mjs');
const reconcile = await import('../src/services/reconcile-svc.mjs');
const seedV2 = await import('../src/services/seed-v2.mjs');

db.getDb();
if (!seedV2.v2Seeded()) {
  console.error('✗ v2 数据尚未初始化：请先运行 npm run v2:seed');
  process.exit(3);
}

const actor = String(args.actor || 'system:v2-daily');
const datasets = args.datasets ? String(args.datasets).split(',').map((s) => s.trim()).filter(Boolean) : collect.DAILY_DATASETS;
const limit = Number(args.limit) || 40;

console.log(`[v2:daily] 库：${dbPath}`);
console.log(`[v2:daily] 数据集：${datasets.join('、')}｜单次最多抓取 ${limit} 个交易日｜分行业维度：${args['no-dimension'] ? '否' : '是'}`);

if (args['checks-only']) {
  const checks = reconcile.runAllChecks({ actor });
  const auto = reconcile.autoCheckCleanTradeRows({ actor: 'system:auto-reconcile' });
  console.log('[v2:daily] 仅执行核对：');
  for (const k of ['trade', 'project', 'policy', 'factor']) {
    console.log(`  ${k}: 检查 ${checks[k].checked} 项，差异 ${checks[k].issues} 项（严重 ${checks[k].critical}）`);
  }
  console.log(`  未结清差异合计：${JSON.stringify(checks.stats)}`);
  console.log(`  行情自动核对：${JSON.stringify(auto)}`);
  db.closeDb();
  process.exit(0);
}

const out = await collect.runDailyJob({
  actor,
  trigger: 'cli',
  datasets,
  tradeLimit: limit,
  onlyNew: args.all ? false : true,
  withDimension: !args['no-dimension'],
  projectMaxDetails: Number(args['project-limit']) || 500,
  projectArchiveFiles: !!args['project-files'] || (!!process.env.CCER_REGISTRY_COOKIE && !args['no-project-files']),
  contentMaxItems: Number(args['content-limit']) || 30,
  contentWindowDays: Number(args['content-window-days']) || 7,
});

console.log('');
console.log('  每日更新完成');
console.log('  ─────────────────────────────────────────────');
console.log(`  任务 ID：${out.job_id}｜状态：${out.status}`);
console.log(`  统计：${JSON.stringify(out.stats)}`);
if (out.detail?.trade) {
  const t = out.detail.trade;
  console.log(`  行情：官方公告列表 ${t.list_total} 条；本次采集 ${t.collected_count} 个交易日；核对由系统自动执行（人工任务 0 条）`);
  for (const c of (t.collected || []).slice(-6)) {
    console.log(`    ${c.trade_date}  成交量 ${c.volume} tCO₂e｜成交额 ${c.turnover} 元｜均价 ${c.avg_price ?? '官方未披露'}`);
  }
  if (t.notes?.length) for (const n of t.notes) console.log(`    注：${n}`);
}
if (out.detail?.policy) {
  const p = out.detail.policy;
  console.log(`  政策巡检：核对 ${p.patrol.stats.parsed} 篇，内容变化 ${p.patrol.changes.length} 篇；栏目发现 ${p.discovery.discovered.length} 条待收录`);
}
if (out.detail?.reconciliation) {
  const r = out.detail.reconciliation;
  const part = (k) => (r[k] ? `${r[k].issues}` : '—');
  console.log(`  核对：交易 ${part('trade')}｜项目 ${part('project')}｜政策 ${part('policy')}｜因子 ${part('factor')} 项差异`);
  console.log(`  未结清差异：${JSON.stringify(r.stats)}`);
}
if (out.detail?.evidence_loop) {
  const e = out.detail.evidence_loop;
  console.log(`  证据补全循环：${e.rounds?.length || 0} 轮；${e.evidence_gained ? '取得新证据并重新核验' : '未取得新证据'}；停止原因：${e.stop_reason || e.error || '—'}`);
}
console.log('  ─────────────────────────────────────────────');
console.log('  提示：结果已自动入库与核验；证据不足、来源冲突或调用失败会单独标记，可在后台查看。');
db.closeDb();
