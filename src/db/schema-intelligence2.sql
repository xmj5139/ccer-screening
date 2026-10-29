-- ============================================================================
-- 公开信息智能化 · 第二阶段增量（docs/86，2026-10-29）
-- ============================================================================
-- 纯增量：只新建独立表/虚拟表/索引/触发器，不修改、不删除既有表、列或数据。
-- 既有库重复执行安全（IF NOT EXISTS；FTS 外部内容表由触发器保持同步）。
--
-- 设计口径：
--   · 中文全文索引不是“每次查询全库重建”：search_index_doc 保存来源 hash，
--     search_index_fts 只负责 MATCH；后台/每日任务做有限批次增量。
--   · FTS5 的 token 由代码预切分：中文连续串输出双字词，另在串尾补单字，
--     英文/编号保留原样（含 - _ .），因此“瓦斯”“CCER-10-001”都可精确检索。
--   · 用户关注规则与已读游标都以 user_id 为所有权键；服务层再次校验，
--     不依赖前端隐藏或路由参数。
--   · PDF 表格 worker 的输入只允许受限原件根内路径；扫描空页只记录
--     “无文本层/表格”，不推断企业数为零。
-- ============================================================================

PRAGMA foreign_keys = ON;

/* ---------------------------------------------------------------------------
 * 1. 可重建全文索引：文档元数据 + FTS5 外部内容表
 * ------------------------------------------------------------------------- */
CREATE TABLE IF NOT EXISTS search_index_doc (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type    TEXT NOT NULL,
  entity_id      TEXT NOT NULL,
  type           TEXT NOT NULL,
  title          TEXT,
  body_text      TEXT,
  title_tokens   TEXT NOT NULL,
  body_tokens    TEXT NOT NULL,
  date_value     TEXT,
  source_text    TEXT,
  region_text    TEXT,
  source_category TEXT,
  payload_json   TEXT NOT NULL,
  source_hash    TEXT NOT NULL,
  indexed_at     TEXT NOT NULL,
  UNIQUE(type, entity_id)
);
CREATE INDEX IF NOT EXISTS idx_search_index_doc_type_date
  ON search_index_doc(type, date_value DESC);
CREATE INDEX IF NOT EXISTS idx_search_index_doc_entity
  ON search_index_doc(entity_type, entity_id);

CREATE VIRTUAL TABLE IF NOT EXISTS search_index_fts USING fts5(
  title_tokens,
  body_tokens,
  content='search_index_doc',
  content_rowid='id',
  tokenize="unicode61 tokenchars '-_.'"
);

CREATE TRIGGER IF NOT EXISTS search_index_doc_ai
AFTER INSERT ON search_index_doc BEGIN
  INSERT INTO search_index_fts(rowid, title_tokens, body_tokens)
  VALUES (new.id, new.title_tokens, new.body_tokens);
END;

CREATE TRIGGER IF NOT EXISTS search_index_doc_ad
AFTER DELETE ON search_index_doc BEGIN
  INSERT INTO search_index_fts(search_index_fts, rowid, title_tokens, body_tokens)
  VALUES ('delete', old.id, old.title_tokens, old.body_tokens);
END;

CREATE TRIGGER IF NOT EXISTS search_index_doc_au
AFTER UPDATE ON search_index_doc BEGIN
  INSERT INTO search_index_fts(search_index_fts, rowid, title_tokens, body_tokens)
  VALUES ('delete', old.id, old.title_tokens, old.body_tokens);
  INSERT INTO search_index_fts(rowid, title_tokens, body_tokens)
  VALUES (new.id, new.title_tokens, new.body_tokens);
END;

CREATE TABLE IF NOT EXISTS search_index_meta (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at TEXT NOT NULL
);

/* ---------------------------------------------------------------------------
 * 2. 用户关注规则与已读游标（普通用户只能读写自己的记录）
 * ------------------------------------------------------------------------- */
CREATE TABLE IF NOT EXISTS user_follow_rule (
  id                 TEXT PRIMARY KEY,
  user_id            TEXT NOT NULL,
  name               TEXT,
  keywords_json      TEXT,                    -- JSON array：关键词（OR）
  regions_json       TEXT,                    -- JSON array：省份/地区
  industries_json    TEXT,                    -- JSON array：行业
  methodologies_json TEXT,                    -- JSON array：方法学编号
  content_types_json TEXT,                    -- JSON array：内容类型
  include_updates    INTEGER NOT NULL DEFAULT 1,
  enabled            INTEGER NOT NULL DEFAULT 1,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_user_follow_rule_user
  ON user_follow_rule(user_id, enabled, updated_at DESC);

CREATE TABLE IF NOT EXISTS user_follow_read (
  user_id         TEXT NOT NULL,
  content_item_id TEXT NOT NULL,
  read_body_hash  TEXT,
  read_at         TEXT NOT NULL,
  PRIMARY KEY(user_id, content_item_id)
);
CREATE INDEX IF NOT EXISTS idx_user_follow_read_item
  ON user_follow_read(content_item_id);

/* ---------------------------------------------------------------------------
 * 3. PDF 表格解析任务（独立 python/pdfplumber worker）
 * ------------------------------------------------------------------------- */
CREATE TABLE IF NOT EXISTS pdf_table_job (
  id             TEXT PRIMARY KEY,
  target_kind    TEXT,                        -- policy|methodology|cea_document|document_upload|path
  target_id      TEXT,
  file_path      TEXT NOT NULL,
  file_name      TEXT,
  file_hash      TEXT NOT NULL,
  file_size      INTEGER NOT NULL,
  status         TEXT NOT NULL,               -- queued|running|done|partial|failed|rejected
  parser         TEXT,
  parser_version TEXT,
  pages_total    INTEGER NOT NULL DEFAULT 0,
  pages_processed INTEGER NOT NULL DEFAULT 0,
  pages_with_tables INTEGER NOT NULL DEFAULT 0,
  pages_failed   INTEGER NOT NULL DEFAULT 0,
  table_count    INTEGER NOT NULL DEFAULT 0,
  row_count      INTEGER NOT NULL DEFAULT 0,
  cell_count     INTEGER NOT NULL DEFAULT 0,
  coverage_ratio REAL NOT NULL DEFAULT 0,
  partial_reason TEXT,
  output_json    TEXT,                         -- worker 真实输出（可能较大；接口默认不整段返回）
  error          TEXT,
  requested_by   TEXT NOT NULL,
  started_at     TEXT,
  finished_at    TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pdf_table_job_created
  ON pdf_table_job(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pdf_table_job_status
  ON pdf_table_job(status, created_at DESC);

CREATE TABLE IF NOT EXISTS pdf_table_page (
  id             TEXT PRIMARY KEY,
  job_id         TEXT NOT NULL REFERENCES pdf_table_job(id),
  page           INTEGER NOT NULL,
  width          REAL,
  height         REAL,
  table_count    INTEGER NOT NULL DEFAULT 0,
  row_count      INTEGER NOT NULL DEFAULT 0,
  cell_count     INTEGER NOT NULL DEFAULT 0,
  text_chars     INTEGER NOT NULL DEFAULT 0,
  has_text_layer INTEGER NOT NULL DEFAULT 0,
  status         TEXT NOT NULL,               -- ok|empty|failed
  error          TEXT,
  created_at     TEXT NOT NULL,
  UNIQUE(job_id, page)
);
CREATE INDEX IF NOT EXISTS idx_pdf_table_page_job
  ON pdf_table_page(job_id, page);

CREATE TABLE IF NOT EXISTS pdf_table (
  id          TEXT PRIMARY KEY,
  job_id      TEXT NOT NULL REFERENCES pdf_table_job(id),
  page        INTEGER NOT NULL,
  table_index INTEGER NOT NULL,
  row_count   INTEGER NOT NULL,
  col_count   INTEGER NOT NULL,
  cells_json  TEXT NOT NULL,                  -- [{row,col,text}]，行列均 0 起
  rows_json   TEXT NOT NULL,                  -- 原始二维数组
  bbox_json   TEXT,
  created_at  TEXT NOT NULL,
  UNIQUE(job_id, page, table_index)
);
CREATE INDEX IF NOT EXISTS idx_pdf_table_job_page
  ON pdf_table(job_id, page, table_index);
