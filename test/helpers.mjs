/**
 * 测试公共环境：使用独立临时数据库，避免污染演示库。
 * 必须在任何 src 模块被导入之前设置 CCER_DB_PATH，
 * 因此本文件只导出「延迟导入」的初始化函数。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * ⚠ 必须在**模块加载时**（而不是 setup() 里）就设置 CCER_DB_PATH。
 * ESM 会先求值测试文件的全部 import：若等到 setup() 才设置，而被更早求值的
 * test/fixtures.mjs 已经静态 import 了 src/core/db.mjs，那么 core/db.mjs 会在
 * 模块加载时把 DEFAULT_DB_PATH 固定为 data/ccer.db —— 之后改环境变量不再生效，
 * 测试（含 seedAll 的 wipe + 重建）会真的写进在用库。
 * 这里在顶层落到临时库，并由 assertIsolatedDb() 兜底校验，双重保险。
 */
const dir = mkdtempSync(join(tmpdir(), 'ccer-test-'));
const DB_FILE = join(dir, 'test.db');
process.env.CCER_DB_PATH = DB_FILE;

let mods = null;

/** 兜底校验：实际生效的库路径必须是本次运行的临时库，否则拒绝继续（宁可不跑也不污染） */
function assertIsolatedDb(db) {
  const actual = resolve(db.dbPath());
  if (actual.toLowerCase() !== resolve(DB_FILE).toLowerCase()) {
    throw new Error(
      `测试库隔离失败：期望 ${DB_FILE}，实际 ${actual}。\n` +
        '  测试会执行 seedAll（wipe + 重建），绝不允许写到临时库之外的数据库，已中止。'
    );
  }
}

export async function setup({ withDemo = true } = {}) {
  if (mods) return mods;

  const db = await import('../src/core/db.mjs');
  assertIsolatedDb(db);
  const seed = await import('../src/services/seed.mjs');
  const projects = await import('../src/services/project-svc.mjs');
  const engine = await import('../src/services/engine.mjs');
  const calc = await import('../src/services/calc-svc.mjs');
  const reports = await import('../src/services/report-svc.mjs');
  const radar = await import('../src/services/radar-svc.mjs');
  const methodologies = await import('../src/methodologies/index.mjs');
  const calcKit = await import('../src/methodologies/lib/calc-kit.mjs');
  const catalog = await import('../src/data/catalog.mjs');
  const factFields = await import('../src/data/fact-fields.mjs');

  db.getDb();
  seed.seedAll({ withDemo });

  mods = { db, seed, projects, engine, calc, reports, radar, methodologies, calcKit, catalog, factFields, dir };
  return mods;
}

export function teardown() {
  try {
    if (mods) mods.db.closeDb();
  } catch {
    /* ignore */
  }
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

export function projectByCode(projects, code) {
  const list = projects.listProjects({ role: 'admin', team_id: 'team-carbon' });
  const p = list.find((x) => x.code === code);
  if (!p) throw new Error(`未找到示例项目 ${code}`);
  return p;
}

export const ADMIN = { id: 'user-admin', name: '系统管理员', role: 'admin', team_id: 'team-carbon' };
export const ANALYST = { id: 'user-analyst', name: '投资分析师', role: 'analyst', team_id: 'team-invest' };
export const RESEARCHER = { id: 'user-researcher', name: '政策研究员', role: 'researcher', team_id: 'team-carbon' };
export const REVIEWER = { id: 'user-reviewer', name: '领域复核人', role: 'reviewer', team_id: 'team-carbon' };
export const OUTSIDER = { id: 'user-other', name: '其他团队成员', role: 'viewer', team_id: 'team-other' };

/**
 * 合规措辞检查：被禁止的表述只能以「否定/免责」形式出现，或出现在明确允许的复合表述中。
 * 例如：
 *   「不是预计减排量、预计可签发量或可交易量」 —— 合规（否定形式）
 *   「业主公示预计减排量」                     —— 合规（设计文档规定的专用表述）
 *   「本项目预计可签发量 12 万吨」             —— 违规
 *
 * @param {string} text
 * @param {string[]} phrases 被禁止的表述
 * @param {string[]} allowedCompounds 明确允许的复合表述（先剔除再扫描）
 * @returns {string[]} 违规出现的片段（空数组表示全部合规）
 */
export function findUnnegatedPhrases(
  text,
  phrases,
  allowedCompounds = ['业主公示预计减排量', '非确定现金流']
) {
  const NEGATIONS = [
    '不是', '不得', '不能', '禁止', '不代表', '并非', '不作为', '不可',
    '不构成', '不称', '而不是', '不得称', '未登记', '不等于', '不与',
  ];
  let scan = text;
  for (const a of allowedCompounds) scan = scan.split(a).join('〖允许〗');
  const violations = [];
  for (const p of phrases) {
    let idx = scan.indexOf(p);
    while (idx !== -1) {
      const window = scan.slice(Math.max(0, idx - 18), idx);
      if (!NEGATIONS.some((n) => window.includes(n))) {
        violations.push(`${p} @ ${idx}：「…${window}${p}…」`);
      }
      idx = scan.indexOf(p, idx + p.length);
    }
  }
  return violations;
}
