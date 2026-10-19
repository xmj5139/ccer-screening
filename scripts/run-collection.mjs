#!/usr/bin/env node
/**
 * 官方来源定时采集任务入口
 * ============================================================================
 * 用法：
 *   node scripts/run-collection.mjs              # 真实受控抓取
 *   node scripts/run-collection.mjs --dry-run    # 演练（不发网络请求）
 *   node scripts/run-collection.mjs --timeout 20000
 *
 * 由机构内网的计划任务触发，例如：
 *   Windows 计划任务：powershell -Command "node D:\...\ccer-screening\scripts\run-collection.mjs"
 *   Linux cron：0 7 * * * cd /opt/ccer-screening && /usr/bin/node scripts/run-collection.mjs >> logs/collection.log 2>&1
 *
 * 安全约束（设计文档第 8 节）：
 *   - 外部站点采集须走受控出口，并由机构确认数据可否离开内网
 *   - 本脚本只发起对 source_document 表中已登记 URL 的 GET 请求，不做站点爬取
 *   - 抓取结果只写 source_change 与 alert，**不会**自动修改方法学状态或规则卡
 *   - 退出码：0 = 无变化；2 = 有变化或失败（便于计划任务告警）
 */
import { getDb, closeDb } from '../src/core/db.mjs';
import { ensureSeeded } from '../src/services/seed.mjs';
import { syncSources, listSourceChanges, listAlerts } from '../src/services/radar-svc.mjs';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const ti = args.indexOf('--timeout');
const timeoutMs = ti >= 0 && args[ti + 1] ? Number(args[ti + 1]) : 15000;

getDb();
const seeded = ensureSeeded();
if (seeded) console.log('空库已自动初始化。');

const scheduler = {
  id: 'system:scheduler',
  name: '定时采集任务',
  role: 'researcher',
  team_id: 'team-carbon',
};

console.log(`[${new Date().toISOString()}] 开始官方来源采集${dryRun ? '（演练模式）' : ''}，超时 ${timeoutMs} ms`);

const result = await syncSources(scheduler, { timeoutMs, dryRun });

if (result.error) {
  console.error(`采集失败：${result.error}`);
  closeDb();
  process.exit(3);
}

const s = result.summary;
console.log(`来源总数 ${s.total}　│　无变化 ${s.unchanged}　│　内容变化 ${s.changed}　│　失败 ${s.failed}　│　建立基线 ${s.baseline_recorded}　│　发现新编号 ${s.new_codes_found}`);

for (const r of result.results) {
  const marker = r.outcome === 'unchanged' ? '·' : r.outcome === 'fetch_failed' ? '✖' : '!';
  console.log(`${marker} [${r.outcome}] ${r.title}${r.detail ? `　— ${r.detail}` : ''}`);
}

const pending = listSourceChanges(50).filter((c) => c.review_status === 'pending');
if (pending.length) {
  console.log('');
  console.log(`待研究员确认的来源变更 ${pending.length} 条：`);
  for (const c of pending.slice(0, 20)) {
    console.log(`  · [${c.change_kind}] ${c.source_title || c.source_id} — ${c.diff_summary || ''}`);
  }
}

const openAlerts = listAlerts({ status: 'open' });
console.log('');
console.log(`当前待处理告警 ${openAlerts.length} 条（其中警示及以上 ${openAlerts.filter((a) => a.severity !== 'info').length} 条）`);
console.log(`[${new Date().toISOString()}] 采集结束。抓取结果不会自动修改方法学状态，请研究员在信息雷达页逐条确认。`);

closeDb();
process.exit(s.changed + s.failed + s.new_codes_found > 0 ? 2 : 0);
