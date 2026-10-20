/**
 * v2 环境守卫
 * ============================================================================
 * 背景（本轮开发的硬约束）：
 *   在用的生产库是 `data/ccer.db`（v1，含历史报告与审计）。v2 的功能验证、
 *   采集、seed、测试**一律不得**写这个文件。为此：
 *
 *   1. `src/core/db.mjs` 只在 `CCER_ENABLE_V2=1` 时执行 v2 增量迁移；
 *   2. 本模块的 `assertIsolatedEnv()` 会在任何 v2 写库动作前检查：
 *        - CCER_ENABLE_V2 === '1'
 *        - CCER_DB_PATH 已被显式指向 **非** data/ccer.db 的库（独立库或临时库）
 *      任一不满足即抛出，宁可不跑也不污染在用库；
 *   3. 服务端 v2 路由先调用 `v2Status()`：未开启 v2 时返回 503 与明确说明，
 *      而不是抛异常或静默写库。
 *
 * 说明：这里检查的是「库文件路径」，不检查库内容；对 ccer_v2.db / 临时库
 * 重复执行迁移是幂等的（CREATE TABLE IF NOT EXISTS）。
 */
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { dbPath, PROJECT_ROOT, getDb } from '../core/db.mjs';

/** v2 依赖的表（缺任意一张即认为 v2 未就绪） */
export const V2_REQUIRED_TABLES = [
  'policy_document', 'policy_attachment', 'policy_change',
  'public_project', 'project_event', 'reduction_batch',
  'internal_project', 'internal_project_link', 'evidence',
  'trade_daily', 'trade_revision', 'trade_dimension', 'trade_calendar',
  'source_snapshot', 'ingestion_job', 'ingestion_step', 'data_reconciliation',
  'review_task', 'app_team', 'project_grant', 'user_login_log', 'export_log',
  'llm_provider', 'llm_call_log', 'api_credential', 'datasource_config',
  'datasource_rollback', 'notification', 'metric_definition',
  'methodology_project_stat', 'methodology_interpretation', 'data_gap',
  'trade_cumulative_reference', 'methodology_doc_verification',
  // v2.1 公开信息整合（docs/19）
  'content_item', 'content_version', 'content_source_link',
  'search_provider', 'web_fetch_connection',
  'verification_result', 'auto_verify_rule', 'auto_verify_config', 'dataset_cursor',
  // v2.7 省域地图（docs/59）
  'region_emission',
];

/** 生产（在用）数据库的规范路径：任何 v2 命令都不允许指向它 */
export const PRODUCTION_DB_PATH = resolve(join(PROJECT_ROOT, 'data', 'ccer.db'));

export function normPath(p) {
  return resolve(String(p || '')).toLowerCase();
}

export function isProductionDb(p = dbPath()) {
  return normPath(p) === normPath(PRODUCTION_DB_PATH);
}

export function v2EnvEnabled() {
  return process.env.CCER_ENABLE_V2 === '1';
}

/**
 * 写库类命令的环境校验（脚本与 v2 服务写操作前调用）。
 * @param {string} [action] 用于错误信息的动作名
 * @returns {true} 通过时返回 true；不通过时抛出 Error（不返回错误对象，避免被忽略）
 */
export function assertIsolatedEnv(action = 'v2 操作') {
  const p = dbPath();
  if (!v2EnvEnabled()) {
    throw new Error(
      `${action}被拒绝：未设置 CCER_ENABLE_V2=1。\n` +
        '  v2 的迁移、采集、seed、测试都必须显式开启，避免误迁移在用库。'
    );
  }
  if (isProductionDb(p)) {
    throw new Error(
      `${action}被拒绝：CCER_DB_PATH 指向在用生产库 data/ccer.db。\n` +
        '  请改为独立库或临时库，例如：\n' +
        '    $env:CCER_DB_PATH="$PWD\\data\\ccer_v2.db"; $env:CCER_ENABLE_V2="1"'
    );
  }
  return true;
}

/** 当前库中实际存在的表名集合 */
export function existingTables() {
  try {
    const rows = getDb()
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all();
    return new Set(rows.map((r) => r.name));
  } catch {
    return new Set();
  }
}

/**
 * v2 可用性状态（服务端路由与界面共用）。
 * @returns {{enabled:boolean, db:string, production_db:boolean, tables_ok:boolean,
 *            missing_tables:string[], ok:boolean, message:string}}
 */
export function v2Status() {
  const db = dbPath();
  const production = isProductionDb(db);
  const enabled = v2EnvEnabled();
  let missing = [];
  let tablesOk = false;
  if (enabled) {
    const have = existingTables();
    missing = V2_REQUIRED_TABLES.filter((t) => !have.has(t));
    tablesOk = missing.length === 0;
  }
  const ok = enabled && tablesOk;
  let message;
  if (!enabled) {
    message =
      'v2 未启用（CCER_ENABLE_V2≠1）。为避免误迁移在用库，v2 的表结构与接口默认关闭；' +
      '请用 npm run v2:seed / v2:start 启动，它们会指向独立库并显式开启 v2。';
  } else if (!tablesOk) {
    message = `v2 表结构不完整（缺 ${missing.length} 张表）：${missing.slice(0, 6).join('、')}${missing.length > 6 ? ' 等' : ''}。请先运行 npm run v2:seed。`;
  } else {
    message = production
      ? '⚠ 当前库路径等于在用生产库 data/ccer.db：v2 只读展示可用，写操作会被拒绝。'
      : 'v2 已启用，使用独立数据库。';
  }
  return {
    enabled,
    db,
    db_exists: existsSync(db),
    production_db: production,
    tables_ok: tablesOk,
    missing_tables: missing,
    ok,
    message,
  };
}

/**
 * 路由守卫：返回 null 表示放行，否则返回可直接响应的错误信封。
 * @param {{write?:boolean}} [opts] write=true 时额外拒绝生产库
 */
export function guardV2(opts = {}) {
  const st = v2Status();
  if (!st.enabled) return { error: 'v2 功能未启用', message: st.message, status: 503, v2: st };
  if (!st.tables_ok) return { error: 'v2 表结构未就绪', message: st.message, status: 503, v2: st };
  if (opts.write && st.production_db) {
    return {
      error: '拒绝写入在用生产库',
      message:
        '当前 CCER_DB_PATH 指向 data/ccer.db。v2 的采集、导入与核对只允许写入独立库' +
        '（CCER_DB_PATH=data/ccer_v2.db）或临时库。',
      status: 409,
      v2: st,
    };
  }
  return null;
}
