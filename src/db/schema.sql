-- ============================================================================
-- CCER 投资筛选 AI 应用 —— 结构化数据库 schema v1.0
-- 设计基线：《CCER 投资筛选 AI 应用：产品与技术设计 v1.0》第 8 节
-- 引擎：SQLite (node:sqlite DatabaseSync)
--
-- 核心约定：
--   1. 所有实体有稳定 ID（前缀 + 时间有序随机段），报告引用「运行快照」而非最新库值。
--   2. 正式发布 / 征求意见 / 修订 / 废止 分列存储，永不互相覆盖。
--   3. 项目公示 / 审定 / 项目登记 / 减排量公示 / 核查 / 减排量登记 分列状态字段。
--   4. 业主公示预计量 / 核查确定量 / 登记量 分开存储。
-- ============================================================================

PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

-- ---------------------------------------------------------------------------
-- 1. 来源文档（SourceDocument）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS source_document (
  id                  TEXT PRIMARY KEY,
  url                 TEXT,
  title               TEXT NOT NULL,
  issuing_authority   TEXT,
  doc_number          TEXT,
  publish_date        TEXT,
  effective_date      TEXT,
  fetched_at          TEXT NOT NULL,
  original_file_hash  TEXT,
  file_type           TEXT,
  is_official         INTEGER NOT NULL DEFAULT 0,   -- 0/1
  tier                INTEGER NOT NULL DEFAULT 1,   -- 1 一级来源 2 二级来源
  status              TEXT NOT NULL,                -- draft|formal|revised|repealed|notice
  parse_quality       TEXT,                         -- good|partial|failed
  parse_note          TEXT,
  local_path          TEXT,
  domain              TEXT,
  region              TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_source_status ON source_document(status);
CREATE INDEX IF NOT EXISTS idx_source_publish ON source_document(publish_date);

-- 来源变更检测记录（定时抓取后的去重与差异比对）
CREATE TABLE IF NOT EXISTS source_change (
  id            TEXT PRIMARY KEY,
  source_id     TEXT NOT NULL REFERENCES source_document(id),
  detected_at   TEXT NOT NULL,
  change_kind   TEXT NOT NULL,   -- new|content_revised|status_changed|withdrawn|fetch_failed|structure_changed
  old_hash      TEXT,
  new_hash      TEXT,
  diff_summary  TEXT,
  review_status TEXT NOT NULL DEFAULT 'pending', -- pending|confirmed|ignored
  reviewed_by   TEXT,
  reviewed_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_change_source ON source_change(source_id);

-- ---------------------------------------------------------------------------
-- 2. 方法学版本（MethodologyVersion）
--    同一 methodology_id 保留全部版本，版本间用 supersedes_id 串联。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS methodology_version (
  id                  TEXT PRIMARY KEY,
  methodology_id      TEXT NOT NULL,               -- 例如 CCER-10-001
  code_display        TEXT,                        -- 例如 CCER-10-001-V01
  name                TEXT NOT NULL,
  version             TEXT NOT NULL,               -- V01
  document_status     TEXT NOT NULL,               -- formal|draft|revised_draft|repealed
  domain              TEXT,
  project_types       TEXT,                        -- JSON array
  tech_routes         TEXT,                        -- JSON array
  scale_note          TEXT,
  crediting_note      TEXT,
  release_date        TEXT,
  effective_date      TEXT,
  repeal_date         TEXT,
  official_url        TEXT,
  source_id           TEXT REFERENCES source_document(id),
  original_file_hash  TEXT,
  approved_by         TEXT,
  approved_at         TEXT,
  rulecard_status     TEXT NOT NULL DEFAULT 'none',      -- none|candidate|approved
  rulecard_approved_by TEXT,
  rulecard_approved_at TEXT,
  calculator_status   TEXT NOT NULL DEFAULT 'none',      -- none|unverified|approved
  calculator_approved_by TEXT,
  calculator_approved_at TEXT,
  supersedes_id       TEXT REFERENCES methodology_version(id),
  catalog_confidence  TEXT NOT NULL DEFAULT 'verified_from_official_notice',
                       -- verified_from_official_notice|name_only_pending_code|pending_registry_confirmation
  is_candidate_eligible INTEGER NOT NULL DEFAULT 1,      -- 是否可进入「可申报候选」
  exclusion_note      TEXT,
  change_log          TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  UNIQUE(methodology_id, version)
);
CREATE INDEX IF NOT EXISTS idx_mv_status ON methodology_version(document_status);
CREATE INDEX IF NOT EXISTS idx_mv_mid ON methodology_version(methodology_id);

-- ---------------------------------------------------------------------------
-- 3. 规则卡：规则（Rule）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rule (
  id                    TEXT PRIMARY KEY,
  methodology_version_id TEXT REFERENCES methodology_version(id), -- NULL => 通用门槛
  layer                 TEXT NOT NULL,            -- common|specific|conflict
  rule_id               TEXT NOT NULL,
  title                 TEXT NOT NULL,
  condition_text        TEXT NOT NULL,            -- 条件文本（人读）
  expression_text       TEXT NOT NULL,            -- 逻辑表达式（人读）
  expr                  TEXT NOT NULL,            -- JSON 表达式树（机器执行）
  required_fields       TEXT NOT NULL DEFAULT '[]', -- JSON array
  evidence_policy       TEXT NOT NULL DEFAULT 'normal', -- strict|normal
  evidence_requirement  TEXT,
  clause_ref            TEXT,
  severity              TEXT NOT NULL,            -- blocking|major|minor
  fail_conclusion       TEXT,
  unknown_action        TEXT,
  sort_order            INTEGER NOT NULL DEFAULT 100,
  created_at            TEXT NOT NULL,
  UNIQUE(methodology_version_id, rule_id)
);
CREATE INDEX IF NOT EXISTS idx_rule_mv ON rule(methodology_version_id);
CREATE INDEX IF NOT EXISTS idx_rule_layer ON rule(layer);

-- ---------------------------------------------------------------------------
-- 4. 公式与因子版本
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS formula (
  id                     TEXT PRIMARY KEY,
  methodology_version_id TEXT NOT NULL REFERENCES methodology_version(id),
  formula_id             TEXT NOT NULL,
  title                  TEXT,
  expression             TEXT NOT NULL,
  unit                   TEXT,
  rounding               TEXT,
  applicable_period      TEXT,
  clause_ref             TEXT,
  created_at             TEXT NOT NULL,
  UNIQUE(methodology_version_id, formula_id)
);

CREATE TABLE IF NOT EXISTS factor_version (
  id                     TEXT PRIMARY KEY,
  factor_key             TEXT NOT NULL,
  name                   TEXT NOT NULL,
  value                  REAL,
  unit                   TEXT,
  methodology_version_id TEXT NOT NULL DEFAULT '',  -- '' => 全局因子
  scope                  TEXT NOT NULL DEFAULT 'global', -- global|methodology|project
  source_ref             TEXT,
  source_year            INTEGER,
  gwp_assessment_report  TEXT,
  value_status           TEXT NOT NULL,   -- verified|placeholder|deprecated
  verification_note      TEXT,
  verified_by            TEXT,
  verified_at            TEXT,
  reasonable_min         REAL,
  reasonable_max         REAL,
  created_at             TEXT NOT NULL,
  UNIQUE(factor_key, methodology_version_id)
);
CREATE INDEX IF NOT EXISTS idx_factor_key ON factor_version(factor_key);

-- ---------------------------------------------------------------------------
-- 5. 项目（Project）与证据、事实
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS project (
  id                TEXT PRIMARY KEY,
  code              TEXT UNIQUE,
  name              TEXT NOT NULL,
  owner_name        TEXT,
  province          TEXT,
  city              TEXT,
  project_type      TEXT,
  technology_route  TEXT,
  industry          TEXT,
  stage             TEXT,           -- 立项|可研|建设|试运行|运营
  capacity_note     TEXT,
  boundary_desc     TEXT,
  -- 注册登记链条状态（分列，禁止合并）
  registry_project_public INTEGER NOT NULL DEFAULT 0,  -- 项目公示
  registry_validated      INTEGER NOT NULL DEFAULT 0,  -- 审定
  registry_project_registered INTEGER NOT NULL DEFAULT 0, -- 项目登记
  registry_reduction_public   INTEGER NOT NULL DEFAULT 0, -- 减排量公示
  registry_verified           INTEGER NOT NULL DEFAULT 0, -- 核查
  registry_reduction_registered INTEGER NOT NULL DEFAULT 0, -- 减排量登记
  registry_public_url       TEXT,
  -- 三套数字分开存储（单位 tCO2e）
  owner_announced_estimate  REAL,   -- 业主公示预计减排量
  verified_amount           REAL,   -- 核查报告确定的量
  registered_amount         REAL,   -- 登记量
  confidentiality   TEXT NOT NULL DEFAULT 'internal', -- public|internal|confidential|restricted
  team_id           TEXT NOT NULL DEFAULT 'team-default',
  analyst           TEXT NOT NULL DEFAULT '未指派',
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_project_team ON project(team_id);

CREATE TABLE IF NOT EXISTS project_evidence (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES project(id),
  file_name       TEXT NOT NULL,
  file_hash       TEXT,
  doc_type        TEXT,            -- 项目建议书|可研|环评|能源台账|监测台账|合同|公示截图|其他
  page            INTEGER,
  line_ref        TEXT,
  excerpt         TEXT,
  uploaded_by     TEXT,
  uploaded_at     TEXT NOT NULL,
  confidentiality TEXT NOT NULL DEFAULT 'internal',
  retention_note  TEXT
);
CREATE INDEX IF NOT EXISTS idx_evidence_project ON project_evidence(project_id);

CREATE TABLE IF NOT EXISTS project_fact (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES project(id),
  field_key     TEXT NOT NULL,
  value_text    TEXT,
  value_num     REAL,
  value_type    TEXT NOT NULL,   -- date|number|text|bool|enum
  unit          TEXT,
  source_kind   TEXT NOT NULL,   -- official|project_doc|owner_claim|analyst|assumption
  evidence_id   TEXT REFERENCES project_evidence(id),
  asserted_by   TEXT,
  asserted_at   TEXT NOT NULL,
  note          TEXT,
  UNIQUE(project_id, field_key)
);
CREATE INDEX IF NOT EXISTS idx_fact_project ON project_fact(project_id);

-- 项目事实字段字典（供「项目事实字段表」交付与前端表单渲染）
CREATE TABLE IF NOT EXISTS fact_field (
  key            TEXT PRIMARY KEY,
  label          TEXT NOT NULL,
  group_name     TEXT NOT NULL DEFAULT '通用',
  value_type     TEXT NOT NULL,   -- date|number|text|bool|enum
  unit           TEXT,
  enum_values    TEXT,            -- JSON array
  applies_to     TEXT NOT NULL DEFAULT '[]', -- JSON array of methodology_id, [] => 全部
  required_for   TEXT NOT NULL DEFAULT '[]', -- JSON array of methodology_id
  evidence_policy TEXT NOT NULL DEFAULT 'normal', -- strict => 必须附证据
  description    TEXT,
  sort_order     INTEGER NOT NULL DEFAULT 100
);

-- ---------------------------------------------------------------------------
-- 6. 运行记录：匹配 / 条件检查 / 计算 / 报告 / 审核
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS match_run (
  id                  TEXT PRIMARY KEY,
  project_id          TEXT NOT NULL REFERENCES project(id),
  analysis_base_date  TEXT NOT NULL,
  run_at              TEXT NOT NULL,
  operator            TEXT,
  result_json         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_match_project ON match_run(project_id);

CREATE TABLE IF NOT EXISTS eligibility_run (
  id                     TEXT PRIMARY KEY,
  project_id             TEXT NOT NULL REFERENCES project(id),
  methodology_version_id TEXT REFERENCES methodology_version(id),
  analysis_base_date     TEXT NOT NULL,
  run_at                 TEXT NOT NULL,
  operator               TEXT,
  conclusion             TEXT NOT NULL,   -- 可继续尽调|存在明确障碍|资料不足暂无法判断|无已发布适用方法学
  blocking_failures      INTEGER NOT NULL DEFAULT 0,
  unknown_count          INTEGER NOT NULL DEFAULT 0,
  summary                TEXT,
  result_json            TEXT NOT NULL,
  review_status          TEXT NOT NULL DEFAULT 'pending'
);
CREATE INDEX IF NOT EXISTS idx_elig_project ON eligibility_run(project_id);

CREATE TABLE IF NOT EXISTS calculation_run (
  id                     TEXT PRIMARY KEY,
  project_id             TEXT NOT NULL REFERENCES project(id),
  methodology_version_id TEXT NOT NULL REFERENCES methodology_version(id),
  plugin_key             TEXT NOT NULL,
  plugin_version         TEXT NOT NULL,
  scenario               TEXT NOT NULL,   -- conservative|base|optimistic
  analysis_base_date     TEXT NOT NULL,
  run_at                 TEXT NOT NULL,
  operator               TEXT,
  status                 TEXT NOT NULL,   -- ok|rejected
  rejection_reason       TEXT,
  inputs_json            TEXT NOT NULL,
  result_json            TEXT NOT NULL,
  factor_snapshot_json   TEXT NOT NULL,
  audit_status           TEXT NOT NULL DEFAULT 'pending', -- pending|reviewed|rejected
  review_status          TEXT NOT NULL DEFAULT 'pending'
);
CREATE INDEX IF NOT EXISTS idx_calc_project ON calculation_run(project_id);

CREATE TABLE IF NOT EXISTS report (
  id                 TEXT PRIMARY KEY,
  project_id         TEXT NOT NULL REFERENCES project(id),
  analysis_base_date TEXT NOT NULL,
  generated_at       TEXT NOT NULL,
  generated_by       TEXT,
  status             TEXT NOT NULL DEFAULT 'draft', -- draft|approved|superseded
  snapshot_json      TEXT NOT NULL,  -- 引用的 eligibility_run / calculation_run 快照 ID
  content_json       TEXT NOT NULL,
  revision           INTEGER NOT NULL DEFAULT 1,
  supersedes_id      TEXT
);
CREATE INDEX IF NOT EXISTS idx_report_project ON report(project_id);

CREATE TABLE IF NOT EXISTS review_decision (
  id           TEXT PRIMARY KEY,
  object_type  TEXT NOT NULL,   -- eligibility_run|calculation_run|methodology_version|rulecard|plugin|report
  object_id    TEXT NOT NULL,
  decision     TEXT NOT NULL,   -- approved|rejected|needs_info
  reviewer     TEXT NOT NULL,
  reviewer_role TEXT,
  comment      TEXT,
  decided_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_review_object ON review_decision(object_type, object_id);

-- ---------------------------------------------------------------------------
-- 7. 信息雷达：告警与订阅
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS alert (
  id               TEXT PRIMARY KEY,
  kind             TEXT NOT NULL,   -- new|revised|repealed|draft_consultation|fetch_failed|structure_changed|withdrawn|catalog_gap
  severity         TEXT NOT NULL,   -- info|warning|critical
  title            TEXT NOT NULL,
  detail           TEXT,
  source_id        TEXT REFERENCES source_document(id),
  methodology_id   TEXT,
  domain           TEXT,
  region           TEXT,
  project_types    TEXT,            -- JSON array
  created_at       TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'open'  -- open|ack|closed
);
CREATE INDEX IF NOT EXISTS idx_alert_status ON alert(status);

CREATE TABLE IF NOT EXISTS subscription (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  owner         TEXT,
  domains       TEXT NOT NULL DEFAULT '[]',
  regions       TEXT NOT NULL DEFAULT '[]',
  project_types TEXT NOT NULL DEFAULT '[]',
  channel       TEXT NOT NULL DEFAULT 'in_app',
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- 8. 治理：审计日志 / 用户
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_log (
  id           TEXT PRIMARY KEY,
  at           TEXT NOT NULL,
  actor        TEXT NOT NULL,
  actor_role   TEXT,
  action       TEXT NOT NULL,
  object_type  TEXT,
  object_id    TEXT,
  detail       TEXT,
  ip           TEXT,
  result       TEXT NOT NULL DEFAULT 'ok'
);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at);
CREATE INDEX IF NOT EXISTS idx_audit_object ON audit_log(object_type, object_id);

CREATE TABLE IF NOT EXISTS app_user (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  role       TEXT NOT NULL,   -- admin|researcher|analyst|reviewer|viewer
  team_id    TEXT NOT NULL,
  active     INTEGER NOT NULL DEFAULT 1
);

-- 服务端会话（身份的唯一来源）
-- ---------------------------------------------------------------------------
-- 安全约定（不得违反）：
--   1. 库里只存令牌的 SHA-256 摘要（token_hash），**永不落盘明文令牌**；
--      明文令牌只在登录响应中返回一次，由浏览器以 Cookie 或 Authorization 头回传。
--   2. 身份不再来自客户端可伪造的请求头 x-user-id / 查询参数 user（见
--      src/services/auth-svc.mjs 的 session 模式；dev 模式仅为本地演示保留旧行为）。
--   3. 过期（expires_at <= 当前时间）与已撤销（revoked_at 非空）的会话一律视为无效。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_session (
  id            TEXT PRIMARY KEY,
  token_hash    TEXT NOT NULL UNIQUE,          -- sha256(令牌) 十六进制，绝不存明文
  user_id       TEXT NOT NULL REFERENCES app_user(id),
  created_at    TEXT NOT NULL,
  expires_at    TEXT NOT NULL,                 -- ISO 时间戳，<= 当前时间即过期
  last_seen_at  TEXT,                          -- 最近一次成功解析会话的时间
  ip            TEXT,                          -- 建立会话时的来源地址
  revoked_at    TEXT,                          -- 非空表示已注销 / 被管理员撤销
  revoke_reason TEXT                           -- logout|admin_revoke|...
);
CREATE INDEX IF NOT EXISTS idx_session_hash ON user_session(token_hash);
CREATE INDEX IF NOT EXISTS idx_session_user ON user_session(user_id);
CREATE INDEX IF NOT EXISTS idx_session_expires ON user_session(expires_at);

-- ---------------------------------------------------------------------------
-- 9. 系统元数据（迁移版本、目录基线说明等）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS system_meta (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
