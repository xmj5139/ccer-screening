/**
 * v2 种子脚本
 * ============================================================================
 * 作用：在**独立库**（默认 data/ccer_v2.db，或 --temp 临时库）中建表并写入
 *       v1 基础数据（方法学目录、规则卡、因子、示例项目）+ v2 数据
 *       （政策库、公开项目库示例、交易日历、数据缺口台账、数据源与模型占位配置、
 *         指标口径说明、内部项目库镜像、原文对照台账）。
 *
 * 用法：
 *   npm run v2:seed                 # data/ccer_v2.db，含演示公开项目
 *   npm run v2:seed -- --no-demo    # 不写公开项目示例
 *   npm run v2:seed -- --temp       # 系统临时库（用完即弃）
 *
 * 【纪律】本脚本不会、也不能对 data/ccer.db 执行任何操作（见 scripts/v2-env.mjs）。
 */
import { initV2Env, parseArgs, V2_DB_DEFAULT } from './v2-env.mjs';

const args = parseArgs();
const { dbPath } = await initV2Env({ temp: !!args.temp });

const db = await import('../src/core/db.mjs');
const seed = await import('../src/services/seed.mjs');
const seedV2 = await import('../src/services/seed-v2.mjs');
const projectsV2 = await import('../src/services/project-v2-svc.mjs');

db.getDb();
const withDemo = !args['no-demo'];
const withPublicDemo = args['no-public-demo'] ? false : true;

console.log('[v2] 写入 v1 基础数据（方法学目录 / 规则卡 / 因子 / 示例项目）…');
seed.seedAll({ withDemo, actor: 'system:v2-seed' });

console.log('[v2] 写入 v2 数据（政策库 / 公开项目示例 / 交易日历 / 缺口台账 / 配置）…');
const summary = seedV2.seedV2({ withPublicDemo, calendarDays: Number(args['calendar-days']) || 60 });

console.log('[v2] 镜像内部项目库（v1 project → v2 internal_project）…');
const mirror = projectsV2.syncInternalFromDossiers({ role: 'admin', name: 'system:v2-seed', team_id: 'team-carbon' });

db.setMeta(db.getDb(), 'schema_version_v2_seeded_at', new Date().toISOString());

const counts = {};
for (const t of [
  'methodology_version', 'rule', 'formula', 'factor_version', 'project',
  'policy_document', 'policy_attachment', 'methodology_doc_verification', 'methodology_interpretation',
  'data_gap', 'datasource_config', 'llm_provider', 'metric_definition', 'app_team',
  'public_project', 'project_event', 'reduction_batch', 'internal_project', 'trade_calendar',
]) {
  try {
    counts[t] = db.get(`SELECT COUNT(*) AS c FROM ${t}`)?.c ?? 0;
  } catch {
    counts[t] = null;
  }
}

console.log('');
console.log('  v2 种子完成');
console.log('  ─────────────────────────────────────────────');
console.log(`  数据库：${dbPath}${args.temp ? '（临时库，进程结束后可删除）' : ''}`);
console.log(`  基础数据：${JSON.stringify(summary)}`);
console.log(`  内部项目镜像：新增 ${mirror.inserted}，更新 ${mirror.updated}（共 ${mirror.total} 条 v1 档案）`);
console.log('  表计数：');
for (const [k, v] of Object.entries(counts)) console.log(`    ${k.padEnd(30, ' ')} ${v}`);
console.log('  ─────────────────────────────────────────────');
console.log('  下一步：');
console.log('    npm run v2:daily -- --limit=40     # 采集官方每日行情并执行核对');
console.log('    npm run v2:start                   # 启动服务，六模块工作台在 /v2');
console.log('');
if (!args.temp && dbPath !== V2_DB_DEFAULT) console.log(`  提示：当前使用的是自定义库路径 ${dbPath}`);
db.closeDb();
