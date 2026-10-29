-- ============================================================================
-- 入库即时摘要队列与 CEA 非目标页排除（docs/80，2026-10-21）
-- ============================================================================
-- 纯增量：只新建独立表与索引；不修改、不删除既有表/列/数据。
-- 迁移标记由 src/core/db.mjs 写入；版本号保持 2.7.0，沿用既有增量做法。
--
-- ingest_summary_queue
--   · dedupe_key = entity_type + entity_id + 实际输入签名 + prompt_version + model_key；
--   · status = queued | running | succeeded | failed | blocked | dead | superseded；
--   · 跨进程领取靠 lease_owner/lease_until，不抢未过期运行态；
--   · attempts 只在真实模型/无模型结果后递增，租约忙/重启回收不消耗次数。
--
-- cea_page_exclusion
--   · 只记录确定性规则判定的非目标页（标题/主内容），保留来源、快照、规则与证据摘录；
--   · 不写行情行；用于停止同 URL parse 缺口反复重试与后台审计。
-- ============================================================================

CREATE TABLE IF NOT EXISTS ingest_summary_queue (
  id                TEXT PRIMARY KEY,
  entity_type       TEXT NOT NULL,
  entity_id         TEXT NOT NULL,
  dedupe_key        TEXT NOT NULL,
  input_hash        TEXT NOT NULL,
  prompt_version    TEXT NOT NULL,
  model_key         TEXT,
  status            TEXT NOT NULL DEFAULT 'queued',
  priority          INTEGER NOT NULL DEFAULT 50,
  source            TEXT,
  reason            TEXT,
  attempts          INTEGER NOT NULL DEFAULT 0,
  max_attempts      INTEGER,
  last_error        TEXT,
  last_error_kind   TEXT,
  next_attempt_at   TEXT,
  lease_owner       TEXT,
  lease_until       TEXT,
  worker_started_at TEXT,
  last_attempt_at   TEXT,
  finished_at       TEXT,
  result_json       TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  UNIQUE(dedupe_key)
);
CREATE INDEX IF NOT EXISTS idx_ingest_summary_status
  ON ingest_summary_queue(status, next_attempt_at, created_at);
CREATE INDEX IF NOT EXISTS idx_ingest_summary_entity
  ON ingest_summary_queue(entity_type, entity_id, status);
CREATE INDEX IF NOT EXISTS idx_ingest_summary_lease
  ON ingest_summary_queue(status, lease_until);

CREATE TABLE IF NOT EXISTS cea_page_exclusion (
  id               TEXT PRIMARY KEY,
  url              TEXT NOT NULL,
  url_hash         TEXT NOT NULL UNIQUE,
  source_code      TEXT,
  snapshot_id      TEXT,
  content_hash     TEXT,
  title            TEXT,
  rule             TEXT NOT NULL,
  evidence         TEXT,
  snapshot_excerpt TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cea_page_exclusion_created
  ON cea_page_exclusion(created_at DESC);
