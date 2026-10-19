-- ============================================================================
-- CCER 信息与测算平台 —— schema v2.0（增量迁移）
-- ============================================================================
-- 【迁移说明】
--   本文件**只做增量**：全部使用 CREATE TABLE IF NOT EXISTS，
--   不修改、不删除 schema.sql（v1.0）中的任何表与列。
--   因此对已有 data/ccer.db 执行本文件是安全的、可重复执行的；
--   但按交付要求，v2 的验证与运行使用**独立数据库**（见 CCER_DB_PATH 与 v2:seed 脚本）。
--
--   回滚路径：v2 新增表全部以 `v2_` 语义分组，回滚只需 DROP 这些表；
--   若需删除列级变更（本文件没有列级变更），v1 schema 不受影响。
--
-- 【v2 新增实体对应关系】（《CCER 信息与测算平台：第二版需求规格》第 5 节）
--   PolicyDocument   → policy_document / policy_attachment / policy_change
--   PublicProject    → public_project / project_event / reduction_batch
--   TradeDaily       → trade_daily
--   TradeDimension   → trade_dimension
--   InternalProject  → internal_project / internal_project_link
--   Evidence         → evidence（公开项目证据）与既有 project_evidence（机构项目证据）
--   SourceSnapshot   → source_snapshot
--   IngestionJob     → ingestion_job / ingestion_step
--   ReviewTask       → review_task
--   User/Role/Team   → app_user（v1）/ app_team / user_audit（登录记录）
--   AuditLog         → audit_log（v1，复用）
--   LLM 配置         → llm_provider / llm_call_log
--   API 密钥         → api_credential
--
-- 【证据标签统一】（需求规格第 0 节）
--   official_registry  官方登记/发布事实
--   project_material   业主公示或项目材料
--   third_party        第三方信息
--   model_estimate     模型估算
--   unverified         待核实
-- ============================================================================

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- A. 政策库（政策和方法学模块）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS policy_document (
  id                 TEXT PRIMARY KEY,
  policy_key         TEXT NOT NULL UNIQUE,   -- 稳定业务键，供种子幂等写入
  title              TEXT NOT NULL,
  doc_number         TEXT,                   -- 文号，例如 环办气候函〔2025〕1号
  issuing_authority  TEXT,
  category           TEXT NOT NULL,          -- 见 POLICY_CATEGORIES
  doc_status         TEXT NOT NULL DEFAULT 'effective',
                     -- effective|superseded|repealed|draft_consultation|notice
  publish_date       TEXT,
  effective_date     TEXT,
  repeal_date        TEXT,
  summary            TEXT,
  official_url       TEXT,
  source_id          TEXT REFERENCES source_document(id),
  source_tier        INTEGER NOT NULL DEFAULT 1,
  original_file_hash TEXT,
  local_path         TEXT,
  version_label      TEXT,
  supersedes_id      TEXT REFERENCES policy_document(id),
  duplicate_of       TEXT REFERENCES policy_document(id), -- 重复收录关系，不代表政策废止
  -- 人工确认留痕（需求规格 1.2：每条保存采集时间、人工确认人、变更记录）
  confirmed_by       TEXT,
  confirmed_at       TEXT,
  collected_at       TEXT NOT NULL,
  collect_note       TEXT,
  change_log         TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_policy_cat ON policy_document(category);
CREATE INDEX IF NOT EXISTS idx_policy_status ON policy_document(doc_status);
CREATE INDEX IF NOT EXISTS idx_policy_publish ON policy_document(publish_date);

CREATE TABLE IF NOT EXISTS policy_attachment (
  id            TEXT PRIMARY KEY,
  policy_id     TEXT NOT NULL REFERENCES policy_document(id),
  file_name     TEXT NOT NULL,
  file_type     TEXT,                        -- pdf|html|xlsx|docx|other
  url           TEXT,
  file_hash     TEXT,
  local_path    TEXT,
  parse_quality TEXT,                        -- good|partial|failed|not_attempted
  parse_note    TEXT,
  fetched_at    TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_policy_att ON policy_attachment(policy_id);

CREATE TABLE IF NOT EXISTS policy_change (
  id           TEXT PRIMARY KEY,
  policy_id    TEXT NOT NULL REFERENCES policy_document(id),
  detected_at  TEXT NOT NULL,
  change_kind  TEXT NOT NULL,   -- new|revised|repealed|version_change|attachment_change|fetch_failed
  old_value    TEXT,
  new_value    TEXT,
  diff_summary TEXT,
  -- 政策变更自动列出受影响的方法学、项目和测算版本，待研究员确认后发布（需求规格 1.2）
  impact_json  TEXT,
  review_status TEXT NOT NULL DEFAULT 'pending',  -- pending|confirmed|ignored
  reviewed_by  TEXT,
  reviewed_at  TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_policy_change ON policy_change(policy_id, review_status);

-- ---------------------------------------------------------------------------
-- B. 公开项目库（项目信息模块）—— 与机构内部项目库严格分离的实体
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public_project (
  id                    TEXT PRIMARY KEY,
  registry_project_no   TEXT,                  -- 官方项目唯一 ID / 登记编号
  name                  TEXT NOT NULL,
  owner_name            TEXT,
  owner_credit_code     TEXT,                  -- 统一社会信用代码
  province              TEXT,
  city                  TEXT,
  domain                TEXT,                  -- 领域（能源工业/矿业/交通运输/林业…）
  industry              TEXT,
  methodology_id        TEXT,
  methodology_version   TEXT,
  technology_route      TEXT,
  boundary_desc         TEXT,
  start_operation_date  TEXT,                  -- 开工/投产时间
  design_doc_url        TEXT,
  -- ---- 注册登记链条：分列存储，禁止合并成一个「阶段」标签 ----
  stage_project_public      INTEGER NOT NULL DEFAULT 0,  -- 项目公示
  stage_validated           INTEGER NOT NULL DEFAULT 0,  -- 审定
  stage_project_registered  INTEGER NOT NULL DEFAULT 0,  -- 项目登记
  stage_reduction_public    INTEGER NOT NULL DEFAULT 0,  -- 减排量公示
  stage_verified            INTEGER NOT NULL DEFAULT 0,  -- 核查
  stage_reduction_registered INTEGER NOT NULL DEFAULT 0, -- 减排量登记
  stage_cancelled           INTEGER NOT NULL DEFAULT 0,  -- 注销状态
  current_stage             TEXT,              -- 派生：最靠后的已完成阶段（仅供展示与筛选）
  -- ---- 三套数字分开存储（单位 tCO2e）----
  owner_announced_estimate  REAL,              -- 业主公示预计量
  verified_amount           REAL,              -- 核查确定量
  registered_amount         REAL,              -- 减排量登记量
  -- ---- 证据与核对 ----
  evidence_level        TEXT NOT NULL DEFAULT 'unverified',
                        -- official_registry|project_material|third_party|model_estimate|unverified
  official_url          TEXT,
  source_id             TEXT REFERENCES source_document(id),
  source_snapshot_id    TEXT,
  last_checked_at       TEXT,
  last_checked_result   TEXT,                   -- ok|changed|failed|never
  review_status         TEXT NOT NULL DEFAULT 'pending', -- pending|confirmed|rejected
  reviewed_by           TEXT,
  reviewed_at           TEXT,
  note                  TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pp_stage ON public_project(current_stage);
CREATE INDEX IF NOT EXISTS idx_pp_mid ON public_project(methodology_id);
CREATE INDEX IF NOT EXISTS idx_pp_prov ON public_project(province);

-- 官方注册登记系统公开栏目观测记录：按 applyId + 栏目保留原始阶段，不靠项目名称合并。
CREATE TABLE IF NOT EXISTS registry_observation (
  apply_id TEXT NOT NULL,
  data_type TEXT NOT NULL,
  public_project_id TEXT NOT NULL REFERENCES public_project(id),
  list_hash TEXT NOT NULL,
  detail_hash TEXT,
  status_name TEXT,
  source_snapshot_id TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY (apply_id, data_type)
);
CREATE INDEX IF NOT EXISTS idx_registry_observation_project ON registry_observation(public_project_id);

CREATE TABLE IF NOT EXISTS ai_review_result (
  id TEXT PRIMARY KEY,
  object_type TEXT NOT NULL,
  object_id TEXT NOT NULL,
  provider_id TEXT,
  model TEXT,
  input_hash TEXT NOT NULL,
  result TEXT NOT NULL, -- pass|flag|unavailable
  summary TEXT,
  issues_json TEXT,
  source_snapshot_id TEXT,
  reviewed_at TEXT NOT NULL,
  raw_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_ai_review_object ON ai_review_result(object_type,object_id,reviewed_at);

CREATE TABLE IF NOT EXISTS project_event (
  id                    TEXT PRIMARY KEY,
  public_project_id     TEXT NOT NULL REFERENCES public_project(id),
  event_type            TEXT NOT NULL,
      -- project_public|validation|project_registration|reduction_public|verification|reduction_registration|cancellation
  event_date            TEXT,
  period_start          TEXT,
  period_end            TEXT,
  amount                REAL,          -- 该事件对应的减排量（公示预计/核查/登记），无则为空
  amount_kind           TEXT,          -- owner_announced_estimate|verified_amount|registered_amount|none
  registry_ref          TEXT,          -- 官方公告编号 / 公示编号
  official_url          TEXT,
  source_snapshot_id    TEXT,
  evidence_level        TEXT NOT NULL DEFAULT 'unverified',
  review_status         TEXT NOT NULL DEFAULT 'pending',
  reviewed_by           TEXT,
  reviewed_at           TEXT,
  note                  TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pe_project ON project_event(public_project_id);
CREATE INDEX IF NOT EXISTS idx_pe_type ON project_event(event_type);

CREATE TABLE IF NOT EXISTS reduction_batch (
  id                    TEXT PRIMARY KEY,
  public_project_id     TEXT NOT NULL REFERENCES public_project(id),
  batch_no              TEXT,          -- 官方批次号 / 期次
  period_start          TEXT,
  period_end            TEXT,
  owner_announced_estimate REAL,       -- 公示预计量
  verified_amount       REAL,          -- 核查确定量
  registered_amount     REAL,          -- 登记量
  registration_date     TEXT,
  cancellation_status   TEXT,          -- none|partial|full
  cancelled_amount      REAL,
  registry_ref          TEXT,
  official_url          TEXT,
  evidence_level        TEXT NOT NULL DEFAULT 'unverified',
  review_status         TEXT NOT NULL DEFAULT 'pending',
  reviewed_by           TEXT,
  reviewed_at           TEXT,
  note                  TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rb_project ON reduction_batch(public_project_id);

-- ---------------------------------------------------------------------------
-- C. 机构内部项目库（项目信息模块）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS internal_project (
  id                   TEXT PRIMARY KEY,
  code                 TEXT UNIQUE,
  name                 TEXT NOT NULL,
  owner_name           TEXT,
  owner_credit_code    TEXT,
  province             TEXT,
  domain               TEXT,
  methodology_id       TEXT,
  stage                TEXT,
  owner_announced_estimate REAL,
  -- 投资分析字段（需求规格 1.3）
  checklist_json       TEXT,          -- 资料清单 [{item, required, received, evidence_id}]
  evidence_index_json  TEXT,          -- 证据来源与页码 [{evidence_id, file_name, page, excerpt}]
  credibility          TEXT,          -- high|medium|low|unknown
  ownership_risk_note  TEXT,          -- 权属与重复申报线索
  economics_json       TEXT,          -- 经济性假设 {capex, opex, carbon_price, discount_rate, ...}
  screening_conclusion TEXT,          -- 筛选结论
  follow_up_owner      TEXT,          -- 跟进负责人
  supplementary_note   TEXT,          -- 补充材料
  version              INTEGER NOT NULL DEFAULT 1,
  review_status        TEXT NOT NULL DEFAULT 'draft', -- draft|pending_review|approved|rejected
  reviewed_by          TEXT,
  reviewed_at          TEXT,
  confidentiality      TEXT NOT NULL DEFAULT 'internal', -- internal|confidential|restricted
  team_id              TEXT NOT NULL DEFAULT 'team-default',
  analyst              TEXT NOT NULL DEFAULT '未指派',
  -- 与 v1 项目档案（project 表）的关联：内部项目若同时有完整档案（事实/证据/测算运行），
  -- 通过该列指向 project.id，避免两套数据各自维护。
  dossier_project_id   TEXT,
  industry             TEXT,
  note                 TEXT,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ip_team ON internal_project(team_id);

-- 内部项目 ↔ 公开项目：**只能人工建立**，禁止按名称相似度自动关联
CREATE TABLE IF NOT EXISTS internal_project_link (
  id                   TEXT PRIMARY KEY,
  internal_project_id  TEXT NOT NULL REFERENCES internal_project(id),
  public_project_id    TEXT NOT NULL REFERENCES public_project(id),
  link_kind            TEXT NOT NULL DEFAULT 'manual_confirmed',
                       -- manual_confirmed|manual_suspected|rejected
  match_basis          TEXT,     -- 关联依据（登记编号一致 / 业主与地址一致 等）
  name_mismatch_note   TEXT,     -- 同名异项、业主变更的核对说明
  linked_by            TEXT NOT NULL,
  linked_at            TEXT NOT NULL,
  note                 TEXT
);
CREATE INDEX IF NOT EXISTS idx_ipl_internal ON internal_project_link(internal_project_id);
CREATE INDEX IF NOT EXISTS idx_ipl_public ON internal_project_link(public_project_id);

-- ---------------------------------------------------------------------------
-- D. 证据（公开项目与测算共用；机构项目证据沿用 v1 的 project_evidence）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS evidence (
  id            TEXT PRIMARY KEY,
  object_type   TEXT NOT NULL,      -- public_project|reduction_batch|project_event|internal_project|policy|methodology
  object_id     TEXT NOT NULL,
  file_name     TEXT NOT NULL,
  file_hash     TEXT,
  file_type     TEXT,
  file_size     INTEGER,
  local_path    TEXT,
  doc_type      TEXT,
  page          INTEGER,            -- 页码级证据定位
  page_to       INTEGER,
  line_ref      TEXT,
  excerpt       TEXT,
  evidence_level TEXT NOT NULL DEFAULT 'project_material',
  source_url    TEXT,
  source_snapshot_id TEXT,
  uploaded_by   TEXT,
  uploaded_at   TEXT NOT NULL,
  -- AI 抽取必须人工确认才能变为项目事实（需求规格 1.6）
  extraction    TEXT NOT NULL DEFAULT 'manual',  -- manual|llm_draft|import
  confirmed_by  TEXT,
  confirmed_at  TEXT,
  confidentiality TEXT NOT NULL DEFAULT 'internal',
  retention_note TEXT
);
CREATE INDEX IF NOT EXISTS idx_ev_object ON evidence(object_type, object_id);
CREATE INDEX IF NOT EXISTS idx_ev_hash ON evidence(file_hash);

-- ---------------------------------------------------------------------------
-- E. 交易信息（交易信息模块）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS trade_daily (
  id            TEXT PRIMARY KEY,
  trade_date    TEXT NOT NULL,
  trade_method  TEXT NOT NULL DEFAULT '挂牌协议',
                -- 来源实际字段；有不同交易方式时分行存储，不自行补值
  volume        REAL,          -- 成交量 tCO2e；NULL 表示「数据暂缺」，0 表示「有交易日但无成交」
  turnover      REAL,          -- 成交额 元
  avg_price     REAL,          -- 当日成交均价 元/tCO2e（= 成交额/成交量）；不是收盘价
  market        TEXT NOT NULL DEFAULT 'CCER',
  session_state TEXT NOT NULL DEFAULT 'traded',
                -- traded 有成交 | no_trade 无成交交易日 | closed 休市 | missing 数据暂缺
  source_id     TEXT REFERENCES source_document(id),
  source_url    TEXT,
  source_snapshot_id TEXT,
  published_at  TEXT,          -- 官方发布时间
  collected_at  TEXT NOT NULL,
  verify_status TEXT NOT NULL DEFAULT 'pending', -- pending|verified|mismatch
  verify_note   TEXT,
  verified_by   TEXT,
  verified_at   TEXT,
  revision      INTEGER NOT NULL DEFAULT 1,
  note          TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE(trade_date, trade_method, market)
);
CREATE INDEX IF NOT EXISTS idx_td_date ON trade_daily(trade_date);
CREATE INDEX IF NOT EXISTS idx_td_status ON trade_daily(verify_status);

-- 历史修订留痕：旧值不得被静默覆盖（需求规格第 2 节）
CREATE TABLE IF NOT EXISTS trade_revision (
  id            TEXT PRIMARY KEY,
  trade_daily_id TEXT NOT NULL REFERENCES trade_daily(id),
  revised_at    TEXT NOT NULL,
  revised_by    TEXT,
  field         TEXT NOT NULL,
  old_value     TEXT,
  new_value     TEXT,
  reason        TEXT NOT NULL,
  official_ref  TEXT
);
CREATE INDEX IF NOT EXISTS idx_tr_daily ON trade_revision(trade_daily_id);

CREATE TABLE IF NOT EXISTS trade_dimension (
  id            TEXT PRIMARY KEY,
  trade_date    TEXT NOT NULL,
  dimension     TEXT NOT NULL,   -- industry|project_type|trade_method|region
  dimension_value TEXT NOT NULL,
  volume        REAL,
  turnover      REAL,
  avg_price     REAL,
  source_id     TEXT REFERENCES source_document(id),
  source_url    TEXT,
  collected_at  TEXT NOT NULL,
  note          TEXT,
  UNIQUE(trade_date, dimension, dimension_value)
);
CREATE INDEX IF NOT EXISTS idx_tdim_date ON trade_dimension(trade_date);

-- 交易日历：区分休市、无成交、数据暂缺
CREATE TABLE IF NOT EXISTS trade_calendar (
  trade_date    TEXT PRIMARY KEY,
  day_type      TEXT NOT NULL,   -- trading|closed|weekend|holiday
  note          TEXT,
  confirmed_by  TEXT,
  confirmed_at  TEXT
);

-- ---------------------------------------------------------------------------
-- F. 采集管线：原始快照、任务、步骤
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS source_snapshot (
  id            TEXT PRIMARY KEY,
  source_id     TEXT REFERENCES source_document(id),
  url           TEXT NOT NULL,
  fetched_at    TEXT NOT NULL,
  http_status   INTEGER,
  content_type  TEXT,
  content_hash  TEXT,            -- sha256（原始响应体）
  content_bytes INTEGER,
  storage_kind  TEXT NOT NULL DEFAULT 'db',  -- db|file|db+file
  body_text     TEXT,            -- 文本响应（截断保存，容量受控）
  body_path     TEXT,            -- 大文件落盘路径
  parser_version TEXT,
  parse_quality TEXT,            -- good|partial|failed|not_attempted
  parse_note    TEXT,
  error         TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ss_source ON source_snapshot(source_id, fetched_at);
CREATE INDEX IF NOT EXISTS idx_ss_hash ON source_snapshot(content_hash);

CREATE TABLE IF NOT EXISTS ingestion_job (
  id             TEXT PRIMARY KEY,
  job_key        TEXT NOT NULL,      -- policy_daily|project_daily|trade_daily|factor_watch
  title          TEXT NOT NULL,
  trigger_kind   TEXT NOT NULL,      -- schedule|manual|cli
  triggered_by   TEXT,
  started_at     TEXT NOT NULL,
  finished_at    TEXT,
  status         TEXT NOT NULL,      -- running|success|partial|failed
  datasets       TEXT,               -- JSON array
  items_found    INTEGER NOT NULL DEFAULT 0,
  items_parsed   INTEGER NOT NULL DEFAULT 0,
  items_validated INTEGER NOT NULL DEFAULT 0,
  items_queued   INTEGER NOT NULL DEFAULT 0,
  items_published INTEGER NOT NULL DEFAULT 0,
  error_count    INTEGER NOT NULL DEFAULT 0,
  error_summary  TEXT,
  data_as_of     TEXT,               -- 数据截至日期
  detail_json    TEXT,
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ij_key ON ingestion_job(job_key, started_at);

CREATE TABLE IF NOT EXISTS ingestion_step (
  id            TEXT PRIMARY KEY,
  job_id        TEXT NOT NULL REFERENCES ingestion_job(id),
  step_order    INTEGER NOT NULL,
  stage         TEXT NOT NULL,   -- collect|parse|validate|review|publish
  target        TEXT,
  status        TEXT NOT NULL,   -- ok|skipped|failed|pending
  started_at    TEXT NOT NULL,
  finished_at   TEXT,
  items         INTEGER NOT NULL DEFAULT 0,
  message       TEXT,
  snapshot_id   TEXT,
  detail_json   TEXT
);
CREATE INDEX IF NOT EXISTS idx_is_job ON ingestion_step(job_id, step_order);

-- 数据核对差异（每日核对产生，人工处理）
CREATE TABLE IF NOT EXISTS data_reconciliation (
  id            TEXT PRIMARY KEY,
  dataset       TEXT NOT NULL,   -- trade|project|policy|factor
  object_id     TEXT,
  object_label  TEXT,
  check_kind    TEXT NOT NULL,   -- duplicate|amount_relation|cumulative_gap|status_regression|missing_attachment|stale|unit
  severity      TEXT NOT NULL,   -- info|warning|critical
  detail        TEXT NOT NULL,
  expected      TEXT,
  actual        TEXT,
  detected_at   TEXT NOT NULL,
  detected_by   TEXT,
  status        TEXT NOT NULL DEFAULT 'open',  -- open|confirmed|ignored|resolved
  resolved_by   TEXT,
  resolved_at   TEXT,
  resolution    TEXT
);
CREATE INDEX IF NOT EXISTS idx_dr_status ON data_reconciliation(status, severity);

-- ---------------------------------------------------------------------------
-- G. 审核任务（每日流程的「待审核」环节）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS review_task (
  id            TEXT PRIMARY KEY,
  task_type     TEXT NOT NULL,  -- policy_publish|methodology_publish|project_confirm|trade_verify|catalog_gap|factor_enable|reconciliation
  object_type   TEXT NOT NULL,
  object_id     TEXT NOT NULL,
  title         TEXT NOT NULL,
  detail        TEXT,
  payload_json  TEXT,
  severity      TEXT NOT NULL DEFAULT 'normal',  -- info|normal|high|critical
  status        TEXT NOT NULL DEFAULT 'pending', -- pending|approved|rejected|returned
  created_at    TEXT NOT NULL,
  created_by    TEXT,
  -- 职责分离：管理员角色与数据审核角色分离（需求规格 1.6）
  required_role TEXT,           -- researcher|reviewer|admin
  decided_by    TEXT,
  decided_at    TEXT,
  decision_note TEXT
);
CREATE INDEX IF NOT EXISTS idx_rt_status ON review_task(status, task_type);

-- ---------------------------------------------------------------------------
-- H. 用户 / 团队 / 登录记录（后台管理）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app_team (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL
);

-- 团队 ↔ 项目授权（内部项目按团队隔离）
CREATE TABLE IF NOT EXISTS project_grant (
  id           TEXT PRIMARY KEY,
  team_id      TEXT NOT NULL,
  object_type  TEXT NOT NULL,   -- internal_project|public_project
  object_id    TEXT NOT NULL,
  granted_by   TEXT,
  granted_at   TEXT NOT NULL,
  note         TEXT,
  UNIQUE(team_id, object_type, object_id)
);
CREATE INDEX IF NOT EXISTS idx_pg_team ON project_grant(team_id);

CREATE TABLE IF NOT EXISTS user_login_log (
  id          TEXT PRIMARY KEY,
  user_id     TEXT,
  user_name   TEXT,
  at          TEXT NOT NULL,
  result      TEXT NOT NULL,   -- ok|bad_credentials|disabled|locked
  method      TEXT NOT NULL,   -- password|sso_assertion|dev
  ip          TEXT,
  user_agent  TEXT,
  session_id  TEXT,
  detail      TEXT
);
CREATE INDEX IF NOT EXISTS idx_ull_at ON user_login_log(at);

CREATE TABLE IF NOT EXISTS export_log (
  id           TEXT PRIMARY KEY,
  at           TEXT NOT NULL,
  actor        TEXT NOT NULL,
  actor_role   TEXT,
  dataset      TEXT NOT NULL,
  format       TEXT NOT NULL,   -- xlsx|csv|json|markdown
  row_count    INTEGER,
  filters_json TEXT,
  object_type  TEXT,
  object_id    TEXT,
  ip           TEXT,
  note         TEXT
);
CREATE INDEX IF NOT EXISTS idx_el_at ON export_log(at);

-- ---------------------------------------------------------------------------
-- I. LLM / 外部 API 配置（后台管理）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS llm_provider (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  provider_kind     TEXT NOT NULL DEFAULT 'openai_compatible',
                    -- openai_compatible|anthropic|ollama|azure_openai|custom
  base_url          TEXT NOT NULL,
  model             TEXT NOT NULL,
  credential_ref    TEXT,          -- 密钥引用名（真正的密钥在服务端密钥库 / 环境变量）
  credential_cipher TEXT,          -- 可选的加密存储（AES-256-GCM，密钥来自 CCER_SECRET_KEY）
  timeout_ms        INTEGER NOT NULL DEFAULT 30000,
  max_calls_per_day INTEGER NOT NULL DEFAULT 200,
  enabled           INTEGER NOT NULL DEFAULT 0,
  -- 逐用途开关（需求规格 1.6）
  use_policy_summary     INTEGER NOT NULL DEFAULT 0,
  use_methodology_extract INTEGER NOT NULL DEFAULT 0,
  use_project_extract    INTEGER NOT NULL DEFAULT 0,
  use_qa_draft           INTEGER NOT NULL DEFAULT 0,
  allow_sensitive    INTEGER NOT NULL DEFAULT 0,  -- 敏感项目资料是否允许外发
  allowed_domains    TEXT,          -- JSON array：出站白名单，防止任意地址
  last_test_at       TEXT,
  last_test_result   TEXT,
  last_test_message  TEXT,
  calls_today        INTEGER NOT NULL DEFAULT 0,
  calls_today_date   TEXT,
  note               TEXT,
  created_by         TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS llm_call_log (
  id            TEXT PRIMARY KEY,
  provider_id   TEXT REFERENCES llm_provider(id),
  at            TEXT NOT NULL,
  purpose       TEXT NOT NULL,   -- policy_summary|methodology_extract|project_extract|qa_draft|test
  actor         TEXT,
  model         TEXT,
  request_chars INTEGER,
  response_chars INTEGER,
  latency_ms    INTEGER,
  status        TEXT NOT NULL,   -- ok|error|disabled|blocked_sensitive|rate_limited
  error         TEXT,
  object_type   TEXT,
  object_id     TEXT,
  -- LLM 输出必须附来源片段和页码，经过人工确认才能变为项目事实或规则
  citations_json TEXT,
  draft_json    TEXT,
  confirmed_by  TEXT,
  confirmed_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_llm_at ON llm_call_log(at);

-- 外部 API 接入（数据源连接器的凭据与开关）
CREATE TABLE IF NOT EXISTS api_credential (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,
  purpose       TEXT NOT NULL,   -- datasource|llm|webhook
  base_url      TEXT,
  auth_kind     TEXT NOT NULL DEFAULT 'none',  -- none|bearer|header|basic|query
  header_name   TEXT,
  credential_ref TEXT,
  credential_cipher TEXT,
  enabled       INTEGER NOT NULL DEFAULT 0,
  rate_limit_per_min INTEGER,
  timeout_ms    INTEGER NOT NULL DEFAULT 15000,
  allowed_domains TEXT,
  note          TEXT,
  created_by    TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- J. 数据源连接器配置（后台管理：数据源配置）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS datasource_config (
  id             TEXT PRIMARY KEY,
  source_id      TEXT REFERENCES source_document(id),
  name           TEXT NOT NULL,
  source_kind    TEXT NOT NULL,   -- official_page|file_download|authorized_api|manual_upload
  url            TEXT,
  method         TEXT NOT NULL DEFAULT 'GET',
  headers_json   TEXT,
  field_mapping  TEXT,            -- JSON：来源字段 → 内部字段
  parser         TEXT NOT NULL DEFAULT 'html_list',  -- html_list|html_table|pdf|json|manual
  frequency      TEXT NOT NULL DEFAULT 'daily',      -- daily|hourly|weekly|manual
  rate_limit_per_min INTEGER NOT NULL DEFAULT 6,
  timeout_ms     INTEGER NOT NULL DEFAULT 15000,
  retry_max      INTEGER NOT NULL DEFAULT 2,
  license_note   TEXT,            -- 许可说明与使用条件
  data_owner     TEXT,            -- 数据责任人
  enabled        INTEGER NOT NULL DEFAULT 0,
  paused         INTEGER NOT NULL DEFAULT 0,
  last_run_at    TEXT,
  last_success_at TEXT,
  last_status    TEXT,            -- ok|failed|never|paused
  last_error     TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  allowed_domains TEXT,           -- 出站白名单（防止管理员配置任意地址造成内网访问）
  created_by     TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ds_enabled ON datasource_config(enabled, paused);

-- 采集任务的回滚点（需求规格 1.6：提供暂停和回滚）
CREATE TABLE IF NOT EXISTS datasource_rollback (
  id            TEXT PRIMARY KEY,
  datasource_id TEXT NOT NULL REFERENCES datasource_config(id),
  created_at    TEXT NOT NULL,
  created_by    TEXT,
  reason        TEXT,
  payload_json  TEXT NOT NULL,   -- 变更前的配置或受影响记录快照
  restored_at   TEXT,
  restored_by   TEXT
);
CREATE INDEX IF NOT EXISTS idx_dsr_ds ON datasource_rollback(datasource_id);

-- ---------------------------------------------------------------------------
-- K. 订阅与通知（沿用 v1 subscription；补充投递记录）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notification (
  id            TEXT PRIMARY KEY,
  subscription_id TEXT REFERENCES subscription(id),
  kind          TEXT NOT NULL,   -- new_policy|methodology_revision|new_project|trade_ready|ingestion_alert|reconciliation
  severity      TEXT NOT NULL DEFAULT 'info',
  title         TEXT NOT NULL,
  detail        TEXT,
  object_type   TEXT,
  object_id     TEXT,
  created_at    TEXT NOT NULL,
  read_at       TEXT,
  read_by       TEXT,
  impact_level  TEXT             -- high|medium|low（按影响等级排序）
);
CREATE INDEX IF NOT EXISTS idx_notif_created ON notification(created_at);

-- ---------------------------------------------------------------------------
-- L. 图表 / 指标口径说明（界面「来源与口径」按钮）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS metric_definition (
  key            TEXT PRIMARY KEY,
  module         TEXT NOT NULL,
  label          TEXT NOT NULL,
  caliber        TEXT NOT NULL,   -- 口径说明
  unit           TEXT,
  source_note    TEXT,
  updated_at     TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- M. 方法学相关统计（方法学分布：各方法学公开项目数量）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS methodology_project_stat (
  id             TEXT PRIMARY KEY,
  methodology_id TEXT NOT NULL,
  version        TEXT,
  computed_at    TEXT NOT NULL,
  public_projects INTEGER NOT NULL DEFAULT 0,
  registered_projects INTEGER NOT NULL DEFAULT 0,
  announced_reductions REAL,
  verified_reductions REAL,
  registered_reductions REAL,
  source_note    TEXT,
  UNIQUE(methodology_id, version)
);

-- ---------------------------------------------------------------------------
-- N. 方法学解读层（AI 草稿 / 已复核）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS methodology_interpretation (
  id            TEXT PRIMARY KEY,
  methodology_id TEXT NOT NULL,
  version       TEXT,
  section       TEXT NOT NULL,   -- applicability|exclusions|required_data|carbon_impact
  content       TEXT NOT NULL,
  origin        TEXT NOT NULL,   -- manual|llm_draft
  status        TEXT NOT NULL DEFAULT 'draft',  -- draft|reviewed
  citations_json TEXT,           -- 来源片段与页码
  reviewed_by   TEXT,
  reviewed_at   TEXT,
  updated_at    TEXT NOT NULL,
  UNIQUE(methodology_id, version, section)
);

-- ---------------------------------------------------------------------------
-- O. 数据缺口台账（如实标注真实缺口，需求规格 1.2）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS data_gap (
  id            TEXT PRIMARY KEY,
  dataset       TEXT NOT NULL,
  gap_key       TEXT NOT NULL UNIQUE,
  title         TEXT NOT NULL,
  description   TEXT NOT NULL,
  impact        TEXT,
  -- 无法稳定自动获取时的替代路径
  manual_path   TEXT,
  import_template TEXT,          -- 导入模板名（CSV 表头在 src/data/import-templates.mjs）
  severity      TEXT NOT NULL DEFAULT 'normal',
  status        TEXT NOT NULL DEFAULT 'open',  -- open|mitigated|closed
  detected_at   TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- P. 累计口径官方披露值（用于与系统累计数核对）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS trade_cumulative_reference (
  id            TEXT PRIMARY KEY,
  as_of_date    TEXT NOT NULL,
  volume_total  REAL,
  turnover_total REAL,
  source_id     TEXT REFERENCES source_document(id),
  source_url    TEXT,
  note          TEXT,
  collected_at  TEXT NOT NULL,
  UNIQUE(as_of_date)
);

-- ---------------------------------------------------------------------------
-- Q. 方法学原文对照台账（P0 验收：原文条款 → 输入字段 → 规则/公式 → 测试样例）
--    evidence_level 是业务测算的硬门槛之一：只有
--    'official_original_verified' 才允许进入审批与放行流程。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS methodology_doc_verification (
  id                  TEXT PRIMARY KEY,
  methodology_version_id TEXT NOT NULL REFERENCES methodology_version(id),
  evidence_level      TEXT NOT NULL DEFAULT 'unverified',
  official_url        TEXT,
  doc_number          TEXT,
  publish_date        TEXT,
  artifact_hash       TEXT,          -- 官方 PDF / 原件的 SHA-256
  sections_verified   TEXT,          -- JSON array，例如 ["§2 适用条件","§6 基准线与计算"]
  traceability_doc    TEXT,          -- 逐条对照表文档路径
  independent_impl    TEXT,          -- 独立实现文件路径
  independent_runner  TEXT,          -- 独立复算运行脚本路径
  independent_result  TEXT,          -- 最近一次复算结论
  coverage_json       TEXT,          -- 规则/公式/参数/样例数量统计
  remaining_blockers  TEXT,          -- JSON array：对照完成后仍未结清的阻断项
  note                TEXT,
  verified_by         TEXT,          -- 领域复核人（人工签字）
  verified_at         TEXT,
  recorded_at         TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  UNIQUE(methodology_version_id)
);
