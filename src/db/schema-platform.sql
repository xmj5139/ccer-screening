-- ============================================================================
-- v2.6 碳市场信息平台增量（docs/44）
-- ============================================================================
-- 本文件只做**加法**：CREATE TABLE / CREATE INDEX IF NOT EXISTS，不含任何
-- ALTER / UPDATE / DELETE，重复执行安全，不触碰在用库的任何既有表与数据。
--
-- 四张新表：
--   1) entity_summary   统一摘要缓存/状态表（实体类型 + ID + 输入哈希 + 提示词版本 + 模型）
--   2) admin_revision   管理员修订**覆盖层**（原始快照与官方数值保持不动）
--   3) chat_turn        平台问答日志（限流、审计与真实调用留痕）
--   4) official_domain  官方域名登记（hostname 精确 / 受控子域匹配的唯一依据）
-- ============================================================================

/* ---------------------------------------------------------------------------
 * 1. 统一摘要缓存 / 状态表
 * ---------------------------------------------------------------------------
 * 缓存键 = (entity_type, entity_id) → input_hash + prompt_version + model_key。
 * 语义：
 *   · input_hash 与当前输入不一致 → 旧摘要失效（stale），必须重算；
 *   · prompt_version 变化 → 全部重算（提示词口径变更不得复用旧结论）；
 *   · status=skipped 表示「未配置模型」：如实记录，绝不写入伪造的模型摘要；
 *   · 正文/数据哈希只存摘要（sha256），不复制原始快照。
 */
CREATE TABLE IF NOT EXISTS entity_summary (
  id            TEXT PRIMARY KEY,
  entity_type   TEXT NOT NULL,
  entity_id     TEXT NOT NULL,
  input_hash    TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  model_key     TEXT,
  status        TEXT NOT NULL,              -- ok | failed | skipped
  summary       TEXT,
  input_kind    TEXT,                       -- full_text | summary_only | metadata_only | data_range
  input_chars   INTEGER NOT NULL DEFAULT 0,
  scope_note    TEXT,                       -- 输入范围说明（让读者知道摘要据什么生成）
  cheap_sig     TEXT,                       -- 轻量来源签名（updated_at + 正文长度 + 首尾片段）
  provider_id   TEXT,
  model         TEXT,
  attempts      INTEGER NOT NULL DEFAULT 0,
  error         TEXT,
  generated_at  TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_entity_summary_key ON entity_summary(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_entity_summary_status ON entity_summary(entity_type, status);

/* ---------------------------------------------------------------------------
 * 2. 管理员修订覆盖层
 * ---------------------------------------------------------------------------
 * 需求（docs/44 第 5 条）：不得悄悄覆盖原始快照与官方数值；
 * 手工修订单独覆盖层并标记「管理员修订」，且有修改前后版本 / 可恢复历史。
 *
 * 实现：一行 = 一个字段的一次修订；同一 (entity_type, entity_id, field_key)
 * 只有一行 status='active'，历史行保留为 superseded（可 restore）。
 * original_value 记录修订前的公开显示值，用于「修改前后版本」与回滚。
 * 读路径通过 mergeOverlay 合并展示，**绝不 UPDATE 业务表本身**。
 */
CREATE TABLE IF NOT EXISTS admin_revision (
  id             TEXT PRIMARY KEY,
  entity_type    TEXT NOT NULL,
  entity_id      TEXT NOT NULL,
  field_key      TEXT NOT NULL,
  value          TEXT,
  original_value TEXT,
  revision_no    INTEGER NOT NULL DEFAULT 1,
  status         TEXT NOT NULL DEFAULT 'active',   -- active | superseded | reverted
  note           TEXT,
  actor          TEXT NOT NULL,
  actor_role     TEXT,
  created_at     TEXT NOT NULL,
  superseded_at  TEXT,
  superseded_by  TEXT,
  restored_from  TEXT
);
CREATE INDEX IF NOT EXISTS idx_admin_revision_target ON admin_revision(entity_type, entity_id, field_key, status);
CREATE INDEX IF NOT EXISTS idx_admin_revision_at ON admin_revision(created_at);

/* ---------------------------------------------------------------------------
 * 3. 平台问答日志
 * ---------------------------------------------------------------------------
 * 只记录服务端实际发生的事情：检索到几条库内证据、是否联网、是否拒答、
 * 模型是否真的被调用、耗时与错误。历史消息本身由前端内存持有（不落库），
 * 因此这里不保存整段多轮对话，只保存一次提问的输入与结果留痕。
 */
CREATE TABLE IF NOT EXISTS chat_turn (
  id             TEXT PRIMARY KEY,
  user_id        TEXT,
  user_name      TEXT,
  question       TEXT NOT NULL,
  mode           TEXT,                        -- db | web | db+web | refused
  evidence_count INTEGER NOT NULL DEFAULT 0,
  web_used       INTEGER NOT NULL DEFAULT 0,
  refused        INTEGER NOT NULL DEFAULT 0,
  refuse_reason  TEXT,
  model_used     INTEGER NOT NULL DEFAULT 0,
  provider_id    TEXT,
  model          TEXT,
  latency_ms     INTEGER,
  answer_json    TEXT,
  sources_json   TEXT,
  error          TEXT,
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_turn_user_at ON chat_turn(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_chat_turn_at ON chat_turn(created_at);

/* ---------------------------------------------------------------------------
 * 4. 官方域名登记
 * ---------------------------------------------------------------------------
 * 需求（docs/44 第 2 条）：官方域名必须按 **hostname 精确或受控子域** 匹配，
 * 不能用 contains、不能用「.gov.cn 字符串包含」、不能由模型自己判断，
 * 也不能把「转载官方」的第三方认定为官网。
 *
 * 因此匹配规则只有一条：host === domain 或 host 以 "." + domain 结尾。
 * 本表是唯一依据；第三方站点无论标题写什么都不会命中。
 */
CREATE TABLE IF NOT EXISTS official_domain (
  domain     TEXT PRIMARY KEY,
  label      TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'official',  -- official | exchange | registry
  match_mode TEXT NOT NULL DEFAULT 'subdomain', -- exact | subdomain
  enabled    INTEGER NOT NULL DEFAULT 1,
  note       TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

/* ---------------------------------------------------------------------------
 * 5. 摘要后台任务
 * ---------------------------------------------------------------------------
 * 需求（docs/46 第 11 条）：`/api/v2/admin/summaries/run` 不得同步 await 长时间批次
 * （云端 Nginx 60 秒会 504）。改为 202 + 任务 ID + 状态轮询：
 *   · 全局**单并发**（摘要任务与日任务刷新共用同一把锁）；
 *   · 状态持久化：进程重启后仍可看到任务结果与中断状态；
 *   · 中断恢复：打开库时把过期的 running 标记为 interrupted，可重新发起。
 */
CREATE TABLE IF NOT EXISTS summary_task (
  id               TEXT PRIMARY KEY,
  status           TEXT NOT NULL,              -- queued | running | success | partial | failed | interrupted
  entity_type      TEXT,                       -- NULL = 全部实体类型
  requested_ids    TEXT,                       -- JSON 数组（按选定 ID 补齐时记录）
  scope            TEXT NOT NULL DEFAULT 'batch',
  limit_count      INTEGER NOT NULL DEFAULT 8,
  force            INTEGER NOT NULL DEFAULT 0,
  scanned          INTEGER NOT NULL DEFAULT 0,
  generated        INTEGER NOT NULL DEFAULT 0,
  failed           INTEGER NOT NULL DEFAULT 0,
  skipped          INTEGER NOT NULL DEFAULT 0,
  model_configured INTEGER,
  reason           TEXT,
  error            TEXT,
  detail_json      TEXT,
  created_by       TEXT,
  created_at       TEXT NOT NULL,
  started_at       TEXT,
  heartbeat_at     TEXT,
  finished_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_summary_task_status ON summary_task(status, created_at);

