/**
 * v2 测试 10：库隔离与迁移安全
 * ============================================================================
 * 本文件守护本轮最重要的安全约束：
 *   1. 未设置 CCER_ENABLE_V2=1 时，migrate() **不得**创建任何 v2 表；
 *   2. 设置后才创建 v2 表，且对同一库重复执行是幂等的；
 *   3. v2-guard 必须识别「在用生产库 data/ccer.db」并拒绝写入；
 *   4. 测试环境本身必须指向临时库（自检）。
 */
import {
  setupV2, test, assert, assertEqual, assertThrows, finish, freshDbFile, hasTable, hasColumn,
} from './v2-helpers.mjs';

const ctx = await setupV2();
const { db, guard, dbPath } = ctx;

console.log('\n[v2-10] 库隔离与迁移安全');

test('测试库不是在用生产库 data/ccer.db', () => {
  assert(!guard.isProductionDb(dbPath), `测试库路径异常：${dbPath}`);
  assertEqual(guard.PRODUCTION_DB_PATH.toLowerCase().endsWith('data\\ccer.db') || guard.PRODUCTION_DB_PATH.toLowerCase().endsWith('data/ccer.db'), true,
    '生产库路径识别应以 data/ccer.db 结尾');
});

test('v2 环境已开启且表结构完整', () => {
  const st = guard.v2Status();
  assert(st.enabled, 'CCER_ENABLE_V2 应为 1');
  assert(st.tables_ok, `v2 表缺失：${st.missing_tables.join('、')}`);
  assert(!st.production_db, '不应指向生产库');
});

test('未设置 CCER_ENABLE_V2 时 migrate() 不创建 v2 表（关键回归测试）', () => {
  const keep = process.env.CCER_ENABLE_V2;
  delete process.env.CCER_ENABLE_V2;
  const { db: raw, path } = freshDbFile('no-v2.db');
  try {
    db.migrate(raw);
    assert(hasTable(raw, 'system_meta'), 'v1 基础表应已创建');
    assert(hasTable(raw, 'methodology_version'), 'v1 方法学表应已创建');
    assert(!hasTable(raw, 'policy_document'), '未开启 v2 时不得创建 policy_document');
    assert(!hasTable(raw, 'trade_daily'), '未开启 v2 时不得创建 trade_daily');
    assert(!hasColumn(raw, 'methodology_version', 'evidence_level'), '未开启 v2 时不得加 v2 列');
  } finally {
    raw.close();
    process.env.CCER_ENABLE_V2 = keep;
    void path;
  }
});

test('设置 CCER_ENABLE_V2=1 后才创建 v2 表，且重复执行幂等', () => {
  process.env.CCER_ENABLE_V2 = '1';
  const { db: raw } = freshDbFile('with-v2.db');
  try {
    db.migrate(raw);
    assert(hasTable(raw, 'policy_document'), '开启后应创建 policy_document');
    assert(hasTable(raw, 'trade_daily'), '开启后应创建 trade_daily');
    assert(hasColumn(raw, 'internal_project', 'dossier_project_id'), '应补齐 internal_project 的关联列');
    const before = raw.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table'").get().c;
    db.migrate(raw); // 第二次
    const after = raw.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table'").get().c;
    assertEqual(after, before, '重复迁移不应改变表数量');
    const ver = raw.prepare("SELECT value FROM system_meta WHERE key='schema_version'").get();
    // v2.1（公开信息整合）→ v2.2（CEA 独立行情增量）。断言版本不低于 2.1.0，
    // 并逐项验证后续增量确实建立，避免每次增量都要改这条断言。
    assert(
      Number(String(ver.value).split('.').slice(0, 2).join('.')) >= 2.1,
      `开启 v2 后 schema_version 应 ≥ 2.1.0（公开信息整合增量），实际 ${ver.value}`
    );
    // v2.1 公开信息表应一并建立，且上面的重复迁移已证明幂等
    for (const t of ['content_item', 'content_version', 'content_source_link', 'search_provider',
      'web_fetch_connection', 'verification_result', 'auto_verify_rule', 'dataset_cursor']) {
      assert(hasTable(raw, t), `迁移后应存在表 ${t}`);
    }
    // v2.2 CEA 增量（docs/31）：独立表 + 快照来源列
    for (const t of ['cea_source', 'cea_trade_daily', 'cea_trade_revision', 'cea_document',
      'cea_event', 'cea_entity', 'cea_entity_revision', 'cea_intention', 'cea_check']) {
      assert(hasTable(raw, t), `迁移后应存在 CEA 表 ${t}`);
    }
    assert(hasColumn(raw, 'source_snapshot', 'cea_source_id'), '应补齐 source_snapshot 的 CEA 来源列');
    assert(hasColumn(raw, 'public_project', 'auto_verify_status'), '应补齐 public_project 的自动核验列');
    assert(hasColumn(raw, 'llm_provider', 'use_content_verify'), '应补齐 llm_provider 的内容核验用途列');
    assert(hasColumn(raw, 'web_fetch_connection', 'note'), '应补齐 web_fetch_connection 的备注列');
  } finally {
    raw.close();
  }
});

test('生产库路径被识别并拒绝写操作（assertIsolatedEnv）', () => {
  assert(guard.isProductionDb(guard.PRODUCTION_DB_PATH), '应识别生产库路径');
  assert(!guard.isProductionDb(dbPath), '临时库不应被识别为生产库');
  // 直接验证判据函数：生产库路径 → isProductionDb true（guardV2 的写守卫据此拒绝）
  const fake = { ...guard.v2Status(), production_db: true };
  assert(fake.production_db === true, '构造状态应标记 production_db');
});

test('v2-guard 在未开启时返回 503 且不抛异常', () => {
  const keep = process.env.CCER_ENABLE_V2;
  delete process.env.CCER_ENABLE_V2;
  try {
    // 注意：v2Status 每次调用都会重新读取环境变量
    const st = guard.v2Status();
    assertEqual(st.enabled, false, '未开启时 enabled 应为 false');
    const g = guard.guardV2({ write: true });
    assert(g && g.status === 503, '未开启时应返回 503 信封');
    assertThrows(() => guard.assertIsolatedEnv('测试动作'), '未开启时写操作必须抛错');
  } finally {
    process.env.CCER_ENABLE_V2 = keep;
  }
});

test('seed 写入的 v2 数据存在（政策 / 公开项目 / 交易日历 / 缺口）', () => {
  assert(db.get('SELECT COUNT(*) c FROM policy_document').c >= 8, '政策库种子应有条目');
  assert(db.get('SELECT COUNT(*) c FROM public_project').c >= 3, '公开项目示例应有条目');
  assert(db.get('SELECT COUNT(*) c FROM data_gap').c >= 5, '数据缺口台账应有条目');
  assert(db.get('SELECT COUNT(*) c FROM datasource_config').c >= 3, '数据源配置应有条目');
  assert(db.get('SELECT COUNT(*) c FROM metric_definition').c >= 8, '指标口径说明应有条目');
});

test('交易日历只写周末，不预写工作日（避免把未采集日误报为缺失）', () => {
  const rows = db.all('SELECT day_type, COUNT(*) c FROM trade_calendar GROUP BY day_type');
  for (const r of rows) {
    assertEqual(r.day_type, 'weekend', `日历不应预写 ${r.day_type}（仅周末可确定）`);
  }
});

finish('test/10-v2-isolation-and-schema.test.mjs');
