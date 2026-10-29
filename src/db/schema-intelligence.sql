-- ============================================================================
-- 公开信息智能化 · 第一阶段增量（docs/86，2026-10-29）
-- ============================================================================
-- 纯增量：只新建独立表与索引，不修改、不删除既有表/列/数据。
-- 列级补充由 src/core/db.mjs 的 addColumnIfMissing 幂等完成：
--   content_item     : body_fingerprint / substantive_fingerprint / attachment_fingerprint /
--                      extractor / extractor_version / extraction_status / extraction_note /
--                      raw_html_hash / cleaned_at / event_group_id
--   content_version  : body_fingerprint / substantive_fingerprint / attachment_fingerprint /
--                      raw_html / extractor / extractor_version / extraction_status / extraction_note
--
-- 设计口径：
--   · 正文指纹 = sha256(归一化清洗后正文)；实质指纹 = sha256(去掉日期页脚/版权行后的正文)。
--     **只有实质指纹变化才重生成摘要**；日期页脚变化只记录提取信息与快照。
--   · 附件指纹 = sha256(按 URL + 已知文件哈希排序后的清单)；同 URL 换附件记 attachment_change。
--   · 同文不同 URL 不合并、不删除：保留每条来源记录，事件组只做可解释的关联。
--   · 字段证据必须带逐字引句与字符区间；无法定位的记录 status='invalid'，不进入前台。
--   · RSS 只提供候选元数据；订阅摘要不是全文，必须再走既有抓取/摘要流程。
-- ============================================================================

PRAGMA foreign_keys = ON;

/* ---------------------------------------------------------------------------
 * 1. 正文提取记录：原始 HTML / 原始文本 / 清洗后文本 / 提取器与状态
 * ------------------------------------------------------------------------- */
CREATE TABLE IF NOT EXISTS content_extraction (
  id                TEXT PRIMARY KEY,
  content_item_id   TEXT NOT NULL REFERENCES content_item(id),
  content_version_id TEXT,
  source_url        TEXT,
  raw_hash          TEXT,
  raw_html          TEXT,
  raw_text          TEXT,
  cleaned_text      TEXT,
  extractor         TEXT NOT NULL,              -- deterministic_html|markdown|plain|trafilatura
  extractor_version TEXT NOT NULL,
  status            TEXT NOT NULL,              -- ok|fallback|failed
  quality           TEXT,                       -- article|list|navigation|empty
  chars             INTEGER NOT NULL DEFAULT 0,
  note              TEXT,
  fetched_at        TEXT NOT NULL,
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_content_extraction_item
  ON content_extraction(content_item_id, fetched_at DESC);
CREATE INDEX IF NOT EXISTS idx_content_extraction_status
  ON content_extraction(status);

/* ---------------------------------------------------------------------------
 * 2. 正文附件：页面引用的 PDF / Office 文件清单（同 URL 换附件可比较）
 * ------------------------------------------------------------------------- */
CREATE TABLE IF NOT EXISTS content_attachment (
  id              TEXT PRIMARY KEY,
  content_item_id TEXT NOT NULL REFERENCES content_item(id),
  url             TEXT NOT NULL,
  url_hash        TEXT NOT NULL,
  file_name       TEXT,
  file_type       TEXT,
  file_hash       TEXT,
  file_size       INTEGER,
  fingerprint     TEXT NOT NULL,
  discovered_at   TEXT NOT NULL,
  last_seen_at    TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'referenced', -- referenced|fetched|failed|missing
  note            TEXT,
  UNIQUE(content_item_id, url_hash)
);
CREATE INDEX IF NOT EXISTS idx_content_attachment_item
  ON content_attachment(content_item_id);

/* ---------------------------------------------------------------------------
 * 3. 事件组：同一篇内容的多个来源 URL（转载）建组，保留每条来源与时间
 * ------------------------------------------------------------------------- */
CREATE TABLE IF NOT EXISTS content_event_group (
  id                        TEXT PRIMARY KEY,
  event_key                 TEXT NOT NULL,
  representative_content_id TEXT NOT NULL REFERENCES content_item(id),
  match_basis               TEXT NOT NULL,
  created_at                TEXT NOT NULL,
  updated_at                TEXT NOT NULL,
  UNIQUE(event_key)
);
CREATE INDEX IF NOT EXISTS idx_content_event_rep
  ON content_event_group(representative_content_id);

CREATE TABLE IF NOT EXISTS content_event_member (
  id              TEXT PRIMARY KEY,
  event_group_id  TEXT NOT NULL REFERENCES content_event_group(id),
  content_item_id TEXT NOT NULL REFERENCES content_item(id),
  relation        TEXT NOT NULL,               -- representative|reprint
  match_basis     TEXT NOT NULL,
  added_at        TEXT NOT NULL,
  UNIQUE(event_group_id, content_item_id)
);
CREATE INDEX IF NOT EXISTS idx_content_event_member_item
  ON content_event_member(content_item_id);

/* ---------------------------------------------------------------------------
 * 4. 字段证据：逐字引句 + Unicode 码点区间 + 可选 UTF-16 区间
 * ------------------------------------------------------------------------- */
CREATE TABLE IF NOT EXISTS field_evidence (
  id                TEXT PRIMARY KEY,
  entity_type       TEXT NOT NULL,             -- content_item|policy_document|methodology_version|public_project
  entity_id         TEXT NOT NULL,
  body_hash         TEXT NOT NULL,
  field_key         TEXT NOT NULL,
  field_label       TEXT,
  field_value       TEXT NOT NULL,
  value_type        TEXT,                      -- text|number|date|year|enum
  quote             TEXT NOT NULL,
  char_start        INTEGER,                   -- Unicode 码点偏移（含）
  char_end          INTEGER,                   -- Unicode 码点偏移（不含）
  utf16_start       INTEGER,                   -- 便于浏览器高亮（含）
  utf16_end         INTEGER,                   -- 便于浏览器高亮（不含）
  offset_unit       TEXT NOT NULL DEFAULT 'unicode_code_point',
  page              INTEGER,
  method            TEXT NOT NULL,             -- deterministic_rule|model
  model             TEXT,
  provider_id       TEXT,
  prompt_version    TEXT,
  extractor_version TEXT,
  status            TEXT NOT NULL DEFAULT 'valid', -- valid|invalid|stale
  validation_error  TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  UNIQUE(entity_type, entity_id, body_hash, field_key, method, quote)
);
CREATE INDEX IF NOT EXISTS idx_field_evidence_entity
  ON field_evidence(entity_type, entity_id, status, field_key);
CREATE INDEX IF NOT EXISTS idx_field_evidence_body
  ON field_evidence(entity_type, entity_id, body_hash, status);

/* ---------------------------------------------------------------------------
 * 5. RSS / Atom 来源与候选
 * ------------------------------------------------------------------------- */
CREATE TABLE IF NOT EXISTS rss_source (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  url              TEXT NOT NULL,
  url_hash         TEXT NOT NULL UNIQUE,
  enabled          INTEGER NOT NULL DEFAULT 1,
  status           TEXT NOT NULL DEFAULT 'never', -- never|ok|partial|failed
  last_attempt_at  TEXT,
  last_success_at  TEXT,
  last_error       TEXT,
  last_item_at     TEXT,
  items_seen       INTEGER NOT NULL DEFAULT 0,
  items_new        INTEGER NOT NULL DEFAULT 0,
  created_by       TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rss_source_enabled
  ON rss_source(enabled, last_success_at);

CREATE TABLE IF NOT EXISTS rss_candidate (
  id              TEXT PRIMARY KEY,
  rss_source_id   TEXT NOT NULL REFERENCES rss_source(id),
  url             TEXT NOT NULL,
  url_hash        TEXT NOT NULL,
  title           TEXT,
  published_at    TEXT,
  summary         TEXT,
  content_item_id TEXT REFERENCES content_item(id),
  status          TEXT NOT NULL DEFAULT 'candidate', -- candidate|inserted|existing|failed
  note            TEXT,
  discovered_at   TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  UNIQUE(rss_source_id, url_hash)
);
CREATE INDEX IF NOT EXISTS idx_rss_candidate_source
  ON rss_candidate(rss_source_id, discovered_at DESC);
CREATE INDEX IF NOT EXISTS idx_rss_candidate_content
  ON rss_candidate(content_item_id);
