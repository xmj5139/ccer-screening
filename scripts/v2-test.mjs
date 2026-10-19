/**
 * v2 隔离测试运行器
 * ============================================================================
 * 作用：把每个测试文件放在**独立临时库**中运行，并强制：
 *   - CCER_DB_PATH = 系统临时目录下的独立库（每个测试文件一个库）
 *   - CCER_ENABLE_V2 = 1
 *   - 若环境里残留 CCER_DB_PATH 指向 data/ccer.db → 立即中止（不运行任何测试）
 *
 * 用法：
 *   npm run v2:test
 *   npm run v2:test -- test/11-v2-trade.test.mjs   # 只跑指定文件
 *   npm run v2:test -- --net                        # 允许联网测试（默认跳过联网用例）
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(SCRIPT_DIR, '..');
const PROD_DB = resolve(join(ROOT, 'data', 'ccer.db')).toLowerCase();

const args = process.argv.slice(2);
const allowNet = args.includes('--net');
const explicit = args.filter((a) => !a.startsWith('--'));

// 硬性隔离检查：环境变量若指向在用生产库，直接拒绝
if (process.env.CCER_DB_PATH && resolve(process.env.CCER_DB_PATH).toLowerCase() === PROD_DB) {
  console.error('✗ CCER_DB_PATH 指向在用生产库 data/ccer.db，已拒绝运行 v2 测试。');
  process.exit(2);
}

const testDir = join(ROOT, 'test');
const files = (explicit.length
  ? explicit.map((f) => resolve(f))
  : readdirSync(testDir)
      // v2 测试文件命名：<序号>-v2-<主题>.test.mjs（如 10-v2-…、20-v2-…）
      .filter((f) => /^\d+-v2-.*\.test\.mjs$/.test(f))
      .sort((a, b) => Number(a.split('-')[0]) - Number(b.split('-')[0]) || a.localeCompare(b))
      .map((f) => join(testDir, f))
).filter((f) => existsSync(f));

if (!files.length) {
  console.error('未找到 v2 测试文件（test/<n>-v2-*.test.mjs）');
  process.exit(2);
}

console.log('');
console.log('  CCER v2 隔离测试');
console.log('  ═════════════════════════════════════════════');
console.log(`  测试文件：${files.map((f) => f.replace(ROOT, '.')).join('、')}`);
console.log(`  联网用例：${allowNet ? '允许' : '跳过（加 --net 开启）'}`);
console.log('  数据库：每个文件独立临时库（系统临时目录，运行后删除）');
console.log('  ─────────────────────────────────────────────');

let failed = 0;
const results = [];
for (const file of files) {
  const dir = mkdtempSync(join(tmpdir(), 'ccer-v2-test-'));
  const dbPath = join(dir, 'v2-test.db');
  const started = Date.now();
  const res = spawnSync(process.execPath, [file], {
    cwd: ROOT,
    stdio: 'inherit',
    env: {
      ...process.env,
      CCER_DB_PATH: dbPath,
      CCER_ENABLE_V2: '1',
      CCER_AUTH_MODE: 'session',
      CCER_ALLOW_REMOTE: '',
      CCER_TEST_ALLOW_NET: allowNet ? '1' : '',
      // 允许出站访问回环地址：自动化测试用本机打桩服务器验证「请求真的发出、
      // 鉴权头与参数映射正确、重试与限额生效」。生产启动（v2-start / server）
      // 不会设置该变量，回环与内网地址默认仍被拒绝。
      CCER_ALLOW_LOOPBACK_OUTBOUND: '1',
      TZ: process.env.TZ || 'Asia/Shanghai',
    },
  });
  const ms = Date.now() - started;
  const ok = res.status === 0;
  if (!ok) failed += 1;
  results.push({ file: file.replace(`${ROOT}\\`, '').replace(`${ROOT}/`, ''), ok, ms, status: res.status });
  // 清理临时库（含 -wal / -shm）
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

console.log('  ─────────────────────────────────────────────');
for (const r of results) {
  console.log(`  ${r.ok ? '✓ 通过' : `✗ 失败（exit ${r.status}）`}  ${r.file}  ${r.ms} ms`);
}
console.log('  ═════════════════════════════════════════════');
console.log(`  合计：${results.length - failed}/${results.length} 个测试文件通过`);
console.log('');
process.exit(failed ? 1 : 0);
