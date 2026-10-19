-- ---------------------------------------------------------------------------
-- DeepSeek 能力扩展（docs/54，2026-10-19）
-- ---------------------------------------------------------------------------
-- 纯增量：只新建能力配置、视觉逐页结果、Files 复用缓存与工具调用留痕表。
-- 既有 search_provider / web_fetch_connection / llm_provider 的 provider_id 等列
-- 由 src/core/db.mjs 的幂等 addColumnIfMissing 补充，便于旧库平滑升级。
-- 本文件可重复执行。
-- ---------------------------------------------------------------------------

/* 1. 各能力的开关、预算与最近调用状态（search/fetch/vision/chat_tools/json）。 */
CREATE TABLE IF NOT EXISTS deepseek_capability (
  kind              TEXT PRIMARY KEY,              -- search|fetch|vision|chat_tools|json
  label             TEXT NOT NULL,
  enabled           INTEGER NOT NULL DEFAULT 1,
  provider_id       TEXT REFERENCES llm_provider(id),
  provider_bound    INTEGER NOT NULL DEFAULT 0,     -- 1=管理员明确绑定/解绑过，自动初始化不得再覆盖
  config_json       TEXT NOT NULL DEFAULT '{}',
  daily_quota       INTEGER NOT NULL DEFAULT 0,    -- 0 表示不额外限制（仍受连接/模型自身限额约束）
  max_per_turn      INTEGER NOT NULL DEFAULT 4,
  timeout_ms        INTEGER NOT NULL DEFAULT 45000,
  calls_today       INTEGER NOT NULL DEFAULT 0,
  calls_today_date  TEXT,
  total_calls       INTEGER NOT NULL DEFAULT 0,
  total_success     INTEGER NOT NULL DEFAULT 0,
  last_call_at      TEXT,
  last_success_at   TEXT,
  last_failure_at   TEXT,
  last_error        TEXT,
  budget_stopped_date TEXT,                        -- 402 后当日停止调用；次日或管理员保存后解除
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

/* 2. 视觉补充的逐页结果：图像 hash、物理页码、模型/工具、结构化文字与限制说明。 */
CREATE TABLE IF NOT EXISTS deepseek_vision_page (
  id              TEXT PRIMARY KEY,
  object_kind     TEXT NOT NULL,                   -- policy_attachment|policy_document|methodology_version|cea_document
  object_id       TEXT NOT NULL,
  doc_hash        TEXT NOT NULL,
  page            INTEGER NOT NULL,
  image_hash      TEXT NOT NULL DEFAULT '',
  image_bytes     INTEGER NOT NULL DEFAULT 0,
  image_format    TEXT NOT NULL DEFAULT 'png',
  provider_id     TEXT,
  model           TEXT NOT NULL DEFAULT 'deepseek-flash',
  status          TEXT NOT NULL,                   -- ok|failed|blocked
  text            TEXT,
  tables_json     TEXT,
  limitations_json TEXT,
  confidence      REAL,
  file_id         TEXT,
  files_reused    INTEGER NOT NULL DEFAULT 0,
  applied         INTEGER NOT NULL DEFAULT 0,      -- 是否已并入逐页文档正文
  machine_read    INTEGER NOT NULL DEFAULT 1,
  understanding   INTEGER NOT NULL DEFAULT 1,      -- 模型理解，不是官方事实
  latency_ms      INTEGER,
  error           TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_dsvp_doc_page_model
  ON deepseek_vision_page(doc_hash, page, model);
CREATE INDEX IF NOT EXISTS idx_dsvp_object ON deepseek_vision_page(object_kind, object_id);

/* 3. Files API 复用缓存：按「凭据归属 + 图片 hash」缓存 file_id，不建独立文件管理页面。 */
CREATE TABLE IF NOT EXISTS deepseek_file_cache (
  id              TEXT PRIMARY KEY,
  provider_id     TEXT NOT NULL,
  image_hash      TEXT NOT NULL,
  file_id         TEXT NOT NULL,
  bytes           INTEGER NOT NULL DEFAULT 0,
  filename        TEXT,
  purpose         TEXT NOT NULL DEFAULT 'user_data',
  expires_at      TEXT,
  uploaded_at     TEXT NOT NULL,
  last_used_at    TEXT,
  deleted_at      TEXT,
  status          TEXT NOT NULL DEFAULT 'active',   -- active|expired|deleted|error
  error           TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_dsfc_provider_hash
  ON deepseek_file_cache(provider_id, image_hash);
CREATE INDEX IF NOT EXISTS idx_dsfc_expires ON deepseek_file_cache(status, expires_at);

/* 4. 工具调用留痕：每次白名单工具调用都记录参数、结果与证据引用，便于追溯。 */
CREATE TABLE IF NOT EXISTS chat_tool_call (
  id              TEXT PRIMARY KEY,
  turn_id         TEXT,
  user_id         TEXT,
  session_id      TEXT,
  round           INTEGER NOT NULL DEFAULT 1,
  tool_name       TEXT NOT NULL,
  args_json       TEXT,
  ok              INTEGER NOT NULL DEFAULT 0,
  result_chars    INTEGER NOT NULL DEFAULT 0,
  evidence_refs_json TEXT,
  latency_ms      INTEGER,
  error           TEXT,
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_tool_turn ON chat_tool_call(turn_id);
CREATE INDEX IF NOT EXISTS idx_chat_tool_user_at ON chat_tool_call(user_id, created_at);
