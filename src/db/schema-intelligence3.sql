-- ============================================================================
-- 公开信息智能化 · 第三阶段增量（docs/86，2026-10-29）
-- ============================================================================
-- 纯增量：只新建独立表/索引/触发器，不修改、不删除既有表、列或数据。
-- 既有库重复执行安全（IF NOT EXISTS / INSERT OR IGNORE）。
--
-- 本文件解决第二阶段末尾暴露的索引新鲜度问题：
--   1. 源表（含管理覆盖层 admin_revision）的写入通过 SQLite 触发器写入
--      search_index_dirty；查询只做“有界消费”，剩余 dirty 时如实回退 legacy，
--      绝不把旧 payload 当成最新文本；
--   2. 每日/后台批次使用每类型旋转游标，旧 ID 的更新不会被 offset=0 永久漏掉；
--   3. 末批清理按“整个合法来源 ID 集合”判断，不能用本批 seen 删除前批索引。
-- 另有第三阶段的企业档案别名、语义扩展配额/留痕、第三方行情候选表。
-- ============================================================================

PRAGMA foreign_keys = ON;

/* ---------------------------------------------------------------------------
 * 1. 索引 dirty 队列（源表触发器写入）
 * ------------------------------------------------------------------------- */
CREATE TABLE IF NOT EXISTS search_index_dirty (
  type       TEXT NOT NULL,               -- policy|methodology|project|content|cea_document|factor|entity
  entity_id  TEXT NOT NULL,
  reason     TEXT,                        -- 表名:insert/update/delete 或 admin_revision:*
  queued_at  TEXT NOT NULL,
  PRIMARY KEY(type, entity_id)
);
CREATE INDEX IF NOT EXISTS idx_search_index_dirty_at
  ON search_index_dirty(queued_at, type, entity_id);
CREATE INDEX IF NOT EXISTS idx_search_index_dirty_type
  ON search_index_dirty(type, queued_at);

/* --- 源数据表：insert / update / delete 均入 dirty 队列 --- */
CREATE TRIGGER IF NOT EXISTS trg_search_dirty_policy_ai
AFTER INSERT ON policy_document BEGIN
  INSERT OR REPLACE INTO search_index_dirty(type,entity_id,reason,queued_at)
  VALUES ('policy', new.id, 'policy_document:insert', strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
CREATE TRIGGER IF NOT EXISTS trg_search_dirty_policy_au
AFTER UPDATE ON policy_document BEGIN
  INSERT OR REPLACE INTO search_index_dirty(type,entity_id,reason,queued_at)
  VALUES ('policy', new.id, 'policy_document:update', strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
CREATE TRIGGER IF NOT EXISTS trg_search_dirty_policy_ad
AFTER DELETE ON policy_document BEGIN
  INSERT OR REPLACE INTO search_index_dirty(type,entity_id,reason,queued_at)
  VALUES ('policy', old.id, 'policy_document:delete', strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;

CREATE TRIGGER IF NOT EXISTS trg_search_dirty_methodology_ai
AFTER INSERT ON methodology_version BEGIN
  INSERT OR REPLACE INTO search_index_dirty(type,entity_id,reason,queued_at)
  VALUES ('methodology', new.id, 'methodology_version:insert', strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
CREATE TRIGGER IF NOT EXISTS trg_search_dirty_methodology_au
AFTER UPDATE ON methodology_version BEGIN
  INSERT OR REPLACE INTO search_index_dirty(type,entity_id,reason,queued_at)
  VALUES ('methodology', new.id, 'methodology_version:update', strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
CREATE TRIGGER IF NOT EXISTS trg_search_dirty_methodology_ad
AFTER DELETE ON methodology_version BEGIN
  INSERT OR REPLACE INTO search_index_dirty(type,entity_id,reason,queued_at)
  VALUES ('methodology', old.id, 'methodology_version:delete', strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;

CREATE TRIGGER IF NOT EXISTS trg_search_dirty_project_ai
AFTER INSERT ON public_project BEGIN
  INSERT OR REPLACE INTO search_index_dirty(type,entity_id,reason,queued_at)
  VALUES ('project', new.id, 'public_project:insert', strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
CREATE TRIGGER IF NOT EXISTS trg_search_dirty_project_au
AFTER UPDATE ON public_project BEGIN
  INSERT OR REPLACE INTO search_index_dirty(type,entity_id,reason,queued_at)
  VALUES ('project', new.id, 'public_project:update', strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
CREATE TRIGGER IF NOT EXISTS trg_search_dirty_project_ad
AFTER DELETE ON public_project BEGIN
  INSERT OR REPLACE INTO search_index_dirty(type,entity_id,reason,queued_at)
  VALUES ('project', old.id, 'public_project:delete', strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;

CREATE TRIGGER IF NOT EXISTS trg_search_dirty_content_ai
AFTER INSERT ON content_item BEGIN
  INSERT OR REPLACE INTO search_index_dirty(type,entity_id,reason,queued_at)
  VALUES ('content', new.id, 'content_item:insert', strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
CREATE TRIGGER IF NOT EXISTS trg_search_dirty_content_au
AFTER UPDATE ON content_item BEGIN
  INSERT OR REPLACE INTO search_index_dirty(type,entity_id,reason,queued_at)
  VALUES ('content', new.id, 'content_item:update', strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
CREATE TRIGGER IF NOT EXISTS trg_search_dirty_content_ad
AFTER DELETE ON content_item BEGIN
  INSERT OR REPLACE INTO search_index_dirty(type,entity_id,reason,queued_at)
  VALUES ('content', old.id, 'content_item:delete', strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;

CREATE TRIGGER IF NOT EXISTS trg_search_dirty_cea_doc_ai
AFTER INSERT ON cea_document BEGIN
  INSERT OR REPLACE INTO search_index_dirty(type,entity_id,reason,queued_at)
  VALUES ('cea_document', new.id, 'cea_document:insert', strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
CREATE TRIGGER IF NOT EXISTS trg_search_dirty_cea_doc_au
AFTER UPDATE ON cea_document BEGIN
  INSERT OR REPLACE INTO search_index_dirty(type,entity_id,reason,queued_at)
  VALUES ('cea_document', new.id, 'cea_document:update', strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
CREATE TRIGGER IF NOT EXISTS trg_search_dirty_cea_doc_ad
AFTER DELETE ON cea_document BEGIN
  INSERT OR REPLACE INTO search_index_dirty(type,entity_id,reason,queued_at)
  VALUES ('cea_document', old.id, 'cea_document:delete', strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;

CREATE TRIGGER IF NOT EXISTS trg_search_dirty_factor_ai
AFTER INSERT ON emission_factor BEGIN
  INSERT OR REPLACE INTO search_index_dirty(type,entity_id,reason,queued_at)
  VALUES ('factor', new.id, 'emission_factor:insert', strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
CREATE TRIGGER IF NOT EXISTS trg_search_dirty_factor_au
AFTER UPDATE ON emission_factor BEGIN
  INSERT OR REPLACE INTO search_index_dirty(type,entity_id,reason,queued_at)
  VALUES ('factor', new.id, 'emission_factor:update', strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
CREATE TRIGGER IF NOT EXISTS trg_search_dirty_factor_ad
AFTER DELETE ON emission_factor BEGIN
  INSERT OR REPLACE INTO search_index_dirty(type,entity_id,reason,queued_at)
  VALUES ('factor', old.id, 'emission_factor:delete', strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;

CREATE TRIGGER IF NOT EXISTS trg_search_dirty_entity_ai
AFTER INSERT ON cea_entity BEGIN
  INSERT OR REPLACE INTO search_index_dirty(type,entity_id,reason,queued_at)
  VALUES ('entity', new.id, 'cea_entity:insert', strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
CREATE TRIGGER IF NOT EXISTS trg_search_dirty_entity_au
AFTER UPDATE ON cea_entity BEGIN
  INSERT OR REPLACE INTO search_index_dirty(type,entity_id,reason,queued_at)
  VALUES ('entity', new.id, 'cea_entity:update', strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
CREATE TRIGGER IF NOT EXISTS trg_search_dirty_entity_ad
AFTER DELETE ON cea_entity BEGIN
  INSERT OR REPLACE INTO search_index_dirty(type,entity_id,reason,queued_at)
  VALUES ('entity', old.id, 'cea_entity:delete', strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;

/* --- 管理覆盖层：admin_revision 的插入/状态变化/恢复也入队 --- */
CREATE TRIGGER IF NOT EXISTS trg_search_dirty_admin_rev_ai
AFTER INSERT ON admin_revision
WHEN new.entity_type IN ('policy_document','methodology_version','public_project','content_item','cea_document','emission_factor','cea_entity')
BEGIN
  INSERT OR REPLACE INTO search_index_dirty(type,entity_id,reason,queued_at)
  VALUES (
    CASE new.entity_type
      WHEN 'policy_document' THEN 'policy'
      WHEN 'methodology_version' THEN 'methodology'
      WHEN 'public_project' THEN 'project'
      WHEN 'content_item' THEN 'content'
      WHEN 'cea_document' THEN 'cea_document'
      WHEN 'emission_factor' THEN 'factor'
      WHEN 'cea_entity' THEN 'entity'
    END,
    new.entity_id, 'admin_revision:insert', strftime('%Y-%m-%dT%H:%M:%fZ','now')
  );
END;
CREATE TRIGGER IF NOT EXISTS trg_search_dirty_admin_rev_au
AFTER UPDATE ON admin_revision
WHEN new.entity_type IN ('policy_document','methodology_version','public_project','content_item','cea_document','emission_factor','cea_entity')
BEGIN
  INSERT OR REPLACE INTO search_index_dirty(type,entity_id,reason,queued_at)
  VALUES (
    CASE new.entity_type
      WHEN 'policy_document' THEN 'policy'
      WHEN 'methodology_version' THEN 'methodology'
      WHEN 'public_project' THEN 'project'
      WHEN 'content_item' THEN 'content'
      WHEN 'cea_document' THEN 'cea_document'
      WHEN 'emission_factor' THEN 'factor'
      WHEN 'cea_entity' THEN 'entity'
    END,
    new.entity_id, 'admin_revision:update', strftime('%Y-%m-%dT%H:%M:%fZ','now')
  );
END;
CREATE TRIGGER IF NOT EXISTS trg_search_dirty_admin_rev_ad
AFTER DELETE ON admin_revision
WHEN old.entity_type IN ('policy_document','methodology_version','public_project','content_item','cea_document','emission_factor','cea_entity')
BEGIN
  INSERT OR REPLACE INTO search_index_dirty(type,entity_id,reason,queued_at)
  VALUES (
    CASE old.entity_type
      WHEN 'policy_document' THEN 'policy'
      WHEN 'methodology_version' THEN 'methodology'
      WHEN 'public_project' THEN 'project'
      WHEN 'content_item' THEN 'content'
      WHEN 'cea_document' THEN 'cea_document'
      WHEN 'emission_factor' THEN 'factor'
      WHEN 'cea_entity' THEN 'entity'
    END,
    old.entity_id, 'admin_revision:delete', strftime('%Y-%m-%dT%H:%M:%fZ','now')
  );
END;

/* --- 迁移时给既有公开记录补一次 dirty；只执行一次，之后由触发器维护 --- */
INSERT OR IGNORE INTO search_index_dirty(type,entity_id,reason,queued_at)
SELECT 'policy', id, 'migration-seed', strftime('%Y-%m-%dT%H:%M:%fZ','now')
  FROM policy_document
 WHERE NOT EXISTS (SELECT 1 FROM search_index_meta WHERE key='search_dirty_seeded_v3');
INSERT OR IGNORE INTO search_index_dirty(type,entity_id,reason,queued_at)
SELECT 'methodology', id, 'migration-seed', strftime('%Y-%m-%dT%H:%M:%fZ','now')
  FROM methodology_version
 WHERE NOT EXISTS (SELECT 1 FROM search_index_meta WHERE key='search_dirty_seeded_v3');
INSERT OR IGNORE INTO search_index_dirty(type,entity_id,reason,queued_at)
SELECT 'project', id, 'migration-seed', strftime('%Y-%m-%dT%H:%M:%fZ','now')
  FROM public_project
 WHERE NOT EXISTS (SELECT 1 FROM search_index_meta WHERE key='search_dirty_seeded_v3');
INSERT OR IGNORE INTO search_index_dirty(type,entity_id,reason,queued_at)
SELECT 'content', id, 'migration-seed', strftime('%Y-%m-%dT%H:%M:%fZ','now')
  FROM content_item
 WHERE NOT EXISTS (SELECT 1 FROM search_index_meta WHERE key='search_dirty_seeded_v3');
INSERT OR IGNORE INTO search_index_dirty(type,entity_id,reason,queued_at)
SELECT 'cea_document', id, 'migration-seed', strftime('%Y-%m-%dT%H:%M:%fZ','now')
  FROM cea_document
 WHERE NOT EXISTS (SELECT 1 FROM search_index_meta WHERE key='search_dirty_seeded_v3');
INSERT OR IGNORE INTO search_index_dirty(type,entity_id,reason,queued_at)
SELECT 'factor', id, 'migration-seed', strftime('%Y-%m-%dT%H:%M:%fZ','now')
  FROM emission_factor
 WHERE NOT EXISTS (SELECT 1 FROM search_index_meta WHERE key='search_dirty_seeded_v3');
INSERT OR IGNORE INTO search_index_dirty(type,entity_id,reason,queued_at)
SELECT 'entity', id, 'migration-seed', strftime('%Y-%m-%dT%H:%M:%fZ','now')
  FROM cea_entity
 WHERE NOT EXISTS (SELECT 1 FROM search_index_meta WHERE key='search_dirty_seeded_v3');
INSERT OR IGNORE INTO search_index_meta(key,value,updated_at)
VALUES ('search_dirty_seeded_v3','1',strftime('%Y-%m-%dT%H:%M:%fZ','now'));

/* ---------------------------------------------------------------------------
 * 2. 企业档案别名（只保存来源明确写出的别名/历史名称）
 * ------------------------------------------------------------------------- */
CREATE TABLE IF NOT EXISTS cea_entity_alias (
  id            TEXT PRIMARY KEY,
  entity_id     TEXT NOT NULL REFERENCES cea_entity(id) ON DELETE CASCADE,
  alias         TEXT NOT NULL,
  source_code   TEXT,
  source_url    TEXT,
  evidence_note TEXT,
  created_by    TEXT,
  created_at    TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_cea_entity_alias
  ON cea_entity_alias(entity_id, alias, COALESCE(source_code, ''));
CREATE INDEX IF NOT EXISTS idx_cea_entity_alias_entity
  ON cea_entity_alias(entity_id, created_at);

/* ---------------------------------------------------------------------------
 * 3. 语义检索配额与留痕（只记录查询词/扩展词与调用结果，不保存密钥）
 * ------------------------------------------------------------------------- */
CREATE TABLE IF NOT EXISTS search_expansion_quota (
  user_id    TEXT NOT NULL,
  window_key TEXT NOT NULL,             -- m:YYYY-MM-DDTHH:MM / d:YYYY-MM-DD（CST）
  count      INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(user_id, window_key)
);

CREATE TABLE IF NOT EXISTS search_expansion_log (
  id          TEXT PRIMARY KEY,
  user_id     TEXT,
  query       TEXT,
  terms_json  TEXT,
  mode        TEXT NOT NULL,            -- semantic_expansion|keyword|fallback
  reason      TEXT,
  model       TEXT,
  provider_id TEXT,
  latency_ms  INTEGER,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_search_expansion_log_user
  ON search_expansion_log(user_id, created_at DESC);

/* ---------------------------------------------------------------------------
 * 4. 第三方行情候选（独立表；绝不写 cea_trade_daily）
 * ------------------------------------------------------------------------- */
CREATE TABLE IF NOT EXISTS market_candidate_import (
  id            TEXT PRIMARY KEY,
  source_name   TEXT NOT NULL,
  source_url    TEXT,
  as_of         TEXT,
  format        TEXT NOT NULL,           -- csv|json
  file_name     TEXT,
  file_hash     TEXT NOT NULL,
  byte_size     INTEGER NOT NULL,
  row_count     INTEGER NOT NULL,
  status        TEXT NOT NULL,           -- imported|rejected
  stale         INTEGER NOT NULL DEFAULT 0,
  counts_json   TEXT,
  created_by    TEXT NOT NULL,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_market_candidate_import_at
  ON market_candidate_import(created_at DESC);

CREATE TABLE IF NOT EXISTS market_candidate_row (
  id                  TEXT PRIMARY KEY,
  import_id           TEXT NOT NULL REFERENCES market_candidate_import(id) ON DELETE CASCADE,
  row_no              INTEGER NOT NULL,
  trade_date          TEXT,
  instrument          TEXT,
  unit                TEXT,
  volume              REAL,
  turnover            REAL,
  avg_price           REAL,
  cumulative_volume   REAL,
  cumulative_turnover REAL,
  source_name         TEXT,
  source_url          TEXT,
  source_as_of        TEXT,
  stale               INTEGER NOT NULL DEFAULT 0,
  diff_status         TEXT NOT NULL,     -- missing|conflict|match|unsupported
  diff_json           TEXT,
  raw_json            TEXT,              -- 原始行（留痕，不参与正式行情）
  notes               TEXT,
  created_at          TEXT NOT NULL,
  UNIQUE(import_id, row_no)
);
CREATE INDEX IF NOT EXISTS idx_market_candidate_row_import
  ON market_candidate_row(import_id, row_no);
CREATE INDEX IF NOT EXISTS idx_market_candidate_row_status
  ON market_candidate_row(diff_status, trade_date DESC);
