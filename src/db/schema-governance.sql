-- ============================================================================
-- 信息治理、历史补采与方法学版本跟踪（docs/74）—— 增量 schema
-- ============================================================================
-- 本文件只做加法：CREATE TABLE / CREATE INDEX IF NOT EXISTS 与幂等加列。
-- 不修改、不删除既有表、列或数据；对既有 v2 库重复执行安全。
--
-- 表：
--   processing_stage            发现 / 获取 / 解析 / 摘要 / 核验 的可查询阶段状态
--   governance_lease            每日任务与历史补采共享的单实例租约
--   backfill_task / backfill_window
--                               历史补采任务与每个日期窗口/页的持久游标
--   methodology_version_relation
--                               版本关系候选/确认（必须有原文证据与既有核验）
--   methodology_version_diff    版本实质差异与逐条来源定位
-- ============================================================================

PRAGMA foreign_keys = ON;

/* ---------------------------------------------------------------------------
 * 1. 处理阶段
 * ---------------------------------------------------------------------------
 * 阶段值的含义（与界面一致）：
 *   discovered  已发现（有真实 URL / 官方记录）
 *   fetched     正文获取或附件下载完成
 *   parsed      解析 / OCR 完成（正文条目为正文归一化；附件类为解析文本）
 *   summarized  摘要完成（entity_summary.status='ok' 且输入哈希匹配）
 *   verified    核验完成（verification_result 有结果，含 insufficient/conflict/unavailable）
 *
 * status：done | pending | running | failed | blocked | stale | skipped
 * 失败必须保留原因与下次重试时间；正文变更后 summarized/verified 置为 stale，
 * 不得沿用旧的「已完成」。
 */
CREATE TABLE IF NOT EXISTS processing_stage (
  object_type     TEXT NOT NULL,
  object_id       TEXT NOT NULL,
  stage           TEXT NOT NULL,
  status          TEXT NOT NULL,
  input_hash      TEXT,
  input_version   TEXT,
  source_locator  TEXT,
  completed_at    TEXT,
  failure_reason  TEXT,
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_retry_at   TEXT,
  detail_json     TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  PRIMARY KEY (object_type, object_id, stage)
);
CREATE INDEX IF NOT EXISTS idx_processing_stage_status
  ON processing_stage(stage, status, next_retry_at);
CREATE INDEX IF NOT EXISTS idx_processing_stage_object
  ON processing_stage(object_type, object_id);

/* ---------------------------------------------------------------------------
 * 2. 单实例租约
 * ---------------------------------------------------------------------------
 * 每日采集与历史补采共用 lease_key='collection'：
 *   - 单任务并发 1（2 核 2GB 约束），不并行抢占；
 *   - 租约到期后才允许接续；未到期不得抢走运行中的活任务；
 *   - 进程中断后租约到期，下一次恢复任务会重新取得租约并从游标继续。
 */
CREATE TABLE IF NOT EXISTS governance_lease (
  lease_key    TEXT PRIMARY KEY,
  owner        TEXT NOT NULL,
  purpose      TEXT,
  acquired_at  TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL,
  expires_at   TEXT NOT NULL
);

/* ---------------------------------------------------------------------------
 * 3. 历史补采任务
 * ---------------------------------------------------------------------------
 * 完成（completed）只表示**计划窗口已处理**，不代表全网资料完整；
 * 有失败/阻塞窗口时任务为 partial，不得标为 completed。
 */
CREATE TABLE IF NOT EXISTS backfill_task (
  id                TEXT PRIMARY KEY,
  dataset           TEXT NOT NULL DEFAULT 'content',
  status            TEXT NOT NULL,
                    -- queued|running|paused|cancelled|completed|partial|failed|interrupted
  source_ids_json   TEXT,
  query             TEXT,
  group_keys_json   TEXT,
  terms_json        TEXT,
  options_json      TEXT,
  date_from         TEXT NOT NULL,
  date_to           TEXT NOT NULL,
  window_days       INTEGER NOT NULL,
  page_size         INTEGER NOT NULL,
  max_pages         INTEGER NOT NULL,
  page_supported    INTEGER NOT NULL DEFAULT 0,
  search_calls      INTEGER NOT NULL DEFAULT 0,
  planned_windows   INTEGER NOT NULL DEFAULT 0,
  processed_windows  INTEGER NOT NULL DEFAULT 0,
  hits              INTEGER NOT NULL DEFAULT 0,
  inserted          INTEGER NOT NULL DEFAULT 0,
  updated           INTEGER NOT NULL DEFAULT 0,
  duplicates        INTEGER NOT NULL DEFAULT 0,
  outside_window    INTEGER NOT NULL DEFAULT 0,
  failed            INTEGER NOT NULL DEFAULT 0,
  blocked           INTEGER NOT NULL DEFAULT 0,
  unknown_dates     INTEGER NOT NULL DEFAULT 0,
  cursor_window     INTEGER NOT NULL DEFAULT 0,
  coverage_note     TEXT,
  last_error        TEXT,
  created_by        TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  started_at        TEXT,
  paused_at         TEXT,
  finished_at       TEXT,
  updated_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_backfill_task_status
  ON backfill_task(status, created_at);

CREATE TABLE IF NOT EXISTS backfill_window (
  id              TEXT PRIMARY KEY,
  task_id         TEXT NOT NULL REFERENCES backfill_task(id) ON DELETE CASCADE,
  seq             INTEGER NOT NULL,
  window_from     TEXT NOT NULL,
  window_to       TEXT NOT NULL,
  status          TEXT NOT NULL,  -- pending|running|done|failed|blocked|paused
  cursor_page     INTEGER NOT NULL DEFAULT 1,
  pages_done      INTEGER NOT NULL DEFAULT 0,
  search_calls    INTEGER NOT NULL DEFAULT 0,
  attempts        INTEGER NOT NULL DEFAULT 0,
  hits            INTEGER NOT NULL DEFAULT 0,
  inserted        INTEGER NOT NULL DEFAULT 0,
  updated         INTEGER NOT NULL DEFAULT 0,
  duplicates      INTEGER NOT NULL DEFAULT 0,
  outside_window  INTEGER NOT NULL DEFAULT 0,
  failed          INTEGER NOT NULL DEFAULT 0,
  blocked         INTEGER NOT NULL DEFAULT 0,
  unknown_dates   INTEGER NOT NULL DEFAULT 0,
  error           TEXT,
  started_at      TEXT,
  finished_at     TEXT,
  updated_at      TEXT NOT NULL,
  UNIQUE(task_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_backfill_window_task
  ON backfill_window(task_id, status, seq);

/* ---------------------------------------------------------------------------
 * 4. 方法学版本关系
 * ---------------------------------------------------------------------------
 * 关系不按编号相邻推断；只有满足以下全部条件才可 status='confirmed'：
 *   - relation_type 在白名单内；
 *   - 保存了 http(s) 原文 URL、可定位的段落/页码、逐字引文；
 *   - 引文能在该方法学版本的已归档正文中定位，或来源文件哈希与版本原件一致；
 *   - 该版本存在既有自动核验 verified 记录。
 * 否则保持 candidate，界面明确「待核实」。
 */
CREATE TABLE IF NOT EXISTS methodology_version_relation (
  id                TEXT PRIMARY KEY,
  relation_key      TEXT NOT NULL UNIQUE,
  from_version_id   TEXT NOT NULL REFERENCES methodology_version(id),
  to_version_id     TEXT NOT NULL REFERENCES methodology_version(id),
  relation_type     TEXT NOT NULL,
                    -- supersedes|revises|replaces|repeals|consults|supplements
  evidence_url      TEXT,
  evidence_locator  TEXT,
  evidence_quote    TEXT,
  evidence_hash     TEXT,
  status            TEXT NOT NULL DEFAULT 'candidate', -- candidate|confirmed|rejected
  confirmation_basis TEXT,
  confirmed_at      TEXT,
  created_by        TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  UNIQUE(from_version_id, to_version_id, relation_type)
);
CREATE INDEX IF NOT EXISTS idx_mv_relation_from
  ON methodology_version_relation(from_version_id, status);
CREATE INDEX IF NOT EXISTS idx_mv_relation_to
  ON methodology_version_relation(to_version_id, status);

/* ---------------------------------------------------------------------------
 * 5. 方法学版本差异
 * ---------------------------------------------------------------------------
 * 每条差异必须带来源定位；证据不足时 change_kind='insufficient'，明确写
 * 「无法比较」，不能仅凭标题或相邻编号编造。
 */
CREATE TABLE IF NOT EXISTS methodology_version_diff (
  id                TEXT PRIMARY KEY,
  version_id        TEXT NOT NULL REFERENCES methodology_version(id),
  compare_version_id TEXT NOT NULL REFERENCES methodology_version(id),
  aspect            TEXT NOT NULL,
                    -- applicability|boundary|parameters|crediting_period|monitoring|other
  change_kind       TEXT NOT NULL,  -- same|changed|insufficient
  summary           TEXT NOT NULL,
  evidence_json     TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  UNIQUE(version_id, compare_version_id, aspect)
);
CREATE INDEX IF NOT EXISTS idx_mv_diff_pair
  ON methodology_version_diff(version_id, compare_version_id);
