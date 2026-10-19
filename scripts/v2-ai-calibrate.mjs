/** 手动执行本地差异规则复查 + 大模型证据核对；每日任务也会自动运行同一路径。 */
import { initV2Env, parseArgs } from './v2-env.mjs';
const args = parseArgs();
await initV2Env({ temp: !!args.temp });
const db = await import('../src/core/db.mjs');
const reconcile = await import('../src/services/reconcile-svc.mjs');
const ai = await import('../src/services/reconciliation-ai-svc.mjs');
db.getDb();
const { syncOfficialClosures } = await import('../src/services/trade-calendar-svc.mjs');
const calendar = await syncOfficialClosures({ actor: 'system:ai-calibration-cli' });
const checks = reconcile.runAllChecks({ actor: 'system:ai-calibration-cli' });
const result = await ai.calibrateOpenIssues({ actor: 'system:ai-calibration-cli', limit: Number(args.limit) || 60, force: !!args.force });
console.log(JSON.stringify({ calendar, checks: checks.stats, ai: result }, null, 2));
db.closeDb();
