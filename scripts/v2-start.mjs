/**
 * v2 服务启动脚本
 * ============================================================================
 * 与 `npm start` 的区别（安全边界）：
 *   - 本脚本把 CCER_DB_PATH 默认指向 **data/ccer_v2.db**（未显式设置时）；
 *   - 设置 CCER_ENABLE_V2=1，v2 增量迁移才会执行；
 *   - 若 CCER_DB_PATH 指向在用生产库 data/ccer.db → 直接拒绝启动；
 *   - 支持 `--temp`（临时库，用于隔离演示/验收）与 `--port=`。
 *
 * 用法：
 *   npm run v2:start
 *   npm run v2:start -- --port=8899
 *   npm run v2:start -- --temp          # 临时库启动（不影响任何已有库）
 */
import { initV2Env, parseArgs } from './v2-env.mjs';

const args = parseArgs();
const { dbPath } = await initV2Env({ temp: !!args.temp });
if (!process.env.CCER_DAILY_SYNC) process.env.CCER_DAILY_SYNC = '1';

if (args.port) process.env.PORT = String(args.port);
if (args.host) process.env.HOST = String(args.host);

const db = await import('../src/core/db.mjs');
const seedV2 = await import('../src/services/seed-v2.mjs');
db.getDb();
if (!seedV2.v2Seeded()) {
  console.log('[v2:start] 检测到 v2 数据尚未初始化，正在自动写入公开数据种子…');
  // 【二轮整改 docs/22 第 12 条】首次初始化**不再生成内部项目与人工审批记录**：
  //   - withDemo=false：不写入任何 demo/内部项目；
  //   - 不再调用旧的「内部项目档案 → 公开项目」同步函数。
  const seed = await import('../src/services/seed.mjs');
  seed.seedAll({ withDemo: false, actor: 'system:v2-start' });
  seedV2.seedV2({ withPublicDemo: false, calendarDays: 60 });
  console.log('[v2:start] 初始化完成：公开政策/方法学/交易日历/示例公开项目（无内部项目、无人工审批记录）。');
}
db.closeDb();

console.log(`[v2:start] 八模块公开信息平台：http://127.0.0.1:${process.env.PORT || 8787}/v2（根路径会自动跳转）`);
console.log(`[v2:start] 数据库：${dbPath}`);
const { startServer } = await import('../src/server.mjs');
await startServer({ port: Number(process.env.PORT || 8787), host: process.env.HOST || '127.0.0.1' });
