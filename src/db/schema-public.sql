-- ============================================================================
-- CCER 公开信息平台 —— schema v2.1（公开信息整合增量）
-- ============================================================================
-- 【设计边界】（docs/19-公开信息整合平台升级任务.md）
--   1. 本平台只整合**公开资料**；不建立、不管理机构的私有项目档案。
--   2. 采集与核验**完全自动化**；本文件不新增任何人工审批表，
--      也不为既有 review_task / policy_change 增加新的写入路径。
--   3. 既有政府来源 / 公开项目 / 交易记录全部保留，不做破坏性变更；
--      本文件只做 CREATE TABLE IF NOT EXISTS 与幂等加列。
--
-- 【与旧表的关系】
--   - content_item 是本轮新增的**统一公开内容表**，承载政策、方法学之外的
--     公开研报、行业动态、机构观点与企业公告。政策与方法学仍沿用
--     policy_document / methodology_version（口径更严格，不混表统计）。
--   - verification_result 取代「人工复核」成为唯一的内容核验记录；
--     既有 ai_review_result 仅作为历史数据保留，不再写入。
--   - review_task / policy_change 保留为历史备份，新版链路不再产生新任务。
--
-- 【核验状态取值】（需求规格：不能一律盖「真实可靠」章）
--   verified     模型与规则一致性检查通过
--   insufficient 证据不足（只给搜索摘要、正文缺失、第二来源缺失）
--   conflict     来源之间互相矛盾
--   unavailable  模型或正文不可用（未配置 / 配额耗尽 / 调用失败 / JSON 非法）
-- ============================================================================

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- P1. 公开内容主表（研报 / 行业动态 / 机构观点 / 企业公告）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS content_item (
  id                  TEXT PRIMARY KEY,
  -- research_report 公开研报 | industry_news 行业动态 | institution_view 机构观点
  -- enterprise_news 企业公告与项目主体新闻 | policy_notice 政策通告（非正式文件）
  content_type        TEXT NOT NULL,
  -- 记录性质（二轮整改）：article 正文条目（进入业务列表与统计）
  --   source_homepage 来源首页归档 | source_index 栏目/列表页归档
  -- 首页与栏目页只作来源发现/快照留痕，**不得当作一篇「今天发布的研报」**。
  record_kind         TEXT NOT NULL DEFAULT 'article',
  title               TEXT NOT NULL,
  -- 发布机构 / 作者：二次转载必须归到**原始发布者**，不得标为转载站
  publisher           TEXT,
  author              TEXT,
  published_at        TEXT,               -- 原始发布日期 YYYY-MM-DD
  discovered_at       TEXT NOT NULL,      -- 首次被发现时间
  collected_at        TEXT,               -- 正文/元数据实际采集时间
  source_url          TEXT NOT NULL,      -- 原始发布页 URL（唯一去重键之一）
  canonical_url       TEXT,               -- 归一化 URL（去 utm / 跟踪参数）
  url_hash            TEXT NOT NULL,      -- sha256(canonical_url)
  content_hash        TEXT,               -- sha256(正文归一化文本)：内容级去重
  -- 来源性质：official 政府/主管机构 | institution 研究机构/证券 | association 行业协会
  --           exchange 交易机构 | media 专业媒体 | enterprise 企业自述
  source_category     TEXT NOT NULL DEFAULT 'media',
  -- 可信度分层：official_fact 官方事实 | institution_analysis 机构分析
  --             media_report 媒体报道 | enterprise_claim 企业主张 | unknown 未判定
  -- 关键约束：企业主张与二次转载**不得**升格为 official_fact。
  authority_tier      TEXT NOT NULL DEFAULT 'unknown',
  -- 正文可获得性：full_text 公开全文已归档 | partial 部分正文 | abstract_only 仅摘要
  --               metadata_only 仅元数据（付费墙/需登录）
  body_availability   TEXT NOT NULL DEFAULT 'metadata_only',
  language            TEXT NOT NULL DEFAULT 'zh',
  summary             TEXT,               -- 摘要（可来自来源本身）
  -- 自动生成的摘要与来源原始摘要**分开存放**（二轮整改）：
  --   summary            = 来源公开摘要/元数据描述（原样保留，未改写）
  --   auto_summary       = 自动生成/抽取的摘要；auto_summary_kind = model|extractive
  auto_summary        TEXT,
  auto_summary_kind   TEXT,
  auto_summary_at     TEXT,
  -- 跨来源核验是否成立：仅当第二来源**取得了正文/字段**时才为 1；
  -- 只有 URL 时不得宣称已跨来源验证（二轮整改）。
  cross_source_verified INTEGER NOT NULL DEFAULT 0,
  citations_validated INTEGER NOT NULL DEFAULT 0,   -- 可在证据中定位的引文数
  citations_rejected  INTEGER NOT NULL DEFAULT 0,   -- 无法在证据中定位、已降级的引文数
  key_points_json     TEXT,               -- JSON array：要点
  -- 观点/预测与已发生事实分开存放（需求规格第 6 条）
  claims_json         TEXT,               -- JSON array：{text, kind: opinion|forecast|fact, evidence}
  topics_json         TEXT,               -- JSON array：主题标签
  methodology_ids_json TEXT,              -- JSON array：关联方法学编号
  industry            TEXT,               -- 关联行业（煤矿瓦斯 / 碳汇 / 新能源 …）
  body_snapshot       TEXT,               -- 已归档的公开正文（纯文本，截断保存）
  body_chars          INTEGER NOT NULL DEFAULT 0,
  public_files_json   TEXT,               -- JSON array：公开文件 {name,url,kind,status}
  -- 与之同源的其它转载（同一篇多站转载建关联，不重复统计）
  duplicate_of        TEXT,               -- 指向代表条目 content_item.id
  -- 处理状态：new 已发现 | fetched 已抓取 | verified_ok | verified_insufficient
  --           verified_conflict | verification_unavailable | skipped_duplicate | failed_fetch
  process_status      TEXT NOT NULL DEFAULT 'new',
  -- 冗余自最近一次核验结果，便于列表直接筛选（权威值在 verification_result）
  verification_status TEXT,               -- verified|insufficient|conflict|unavailable|null
  verification_at     TEXT,
  confidence          REAL,               -- 0—1，模型自评的证据一致性置信度
  is_demo             INTEGER NOT NULL DEFAULT 0,  -- 演示条目：**不进入业务统计**
  source_provider_id  TEXT,               -- 发现该条目的搜索/抓取连接
  snapshot_id         TEXT,               -- 正文快照（source_snapshot.id）
  first_seen_job_id   TEXT,               -- 首次发现的每日任务
  note                TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  UNIQUE(url_hash)
);
CREATE INDEX IF NOT EXISTS idx_ci_type ON content_item(content_type, published_at);
CREATE INDEX IF NOT EXISTS idx_ci_status ON content_item(process_status, verification_status);

-- 管理员补充的公开文件副本。保留上传来源与官方来源校验的区别。
-- v2.2 CEA 阶段B：target_kind 增加 cea_document（CEA 政策/配额文件 PDF 与 OCR 副本）。
-- 既有库由 db.mjs 的 migrateDocumentUploadTargetKinds 幂等重建约束，不丢数据。
CREATE TABLE IF NOT EXISTS document_upload (
  id TEXT PRIMARY KEY,
  target_kind TEXT NOT NULL CHECK(target_kind IN ('policy','methodology','cea_document')),
  target_id TEXT NOT NULL,
  file_name TEXT NOT NULL,
  file_hash TEXT NOT NULL,
  file_size INTEGER NOT NULL,
  local_path TEXT NOT NULL,
  text_content TEXT,
  text_source TEXT NOT NULL, -- pdf_extract|admin_transcript|none
  parse_quality TEXT NOT NULL, -- good|partial|failed
  source_status TEXT NOT NULL, -- official_hash_match|admin_supplied_unverified
  source_claim_url TEXT,
  ai_result TEXT,
  ai_summary TEXT,
  uploaded_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_document_upload_target ON document_upload(target_kind,target_id,created_at);
CREATE INDEX IF NOT EXISTS idx_ci_hash ON content_item(content_hash);
CREATE INDEX IF NOT EXISTS idx_ci_pub ON content_item(publisher);
CREATE INDEX IF NOT EXISTS idx_ci_published ON content_item(published_at);
CREATE INDEX IF NOT EXISTS idx_ci_demo ON content_item(is_demo);
CREATE INDEX IF NOT EXISTS idx_ci_dup ON content_item(duplicate_of);

-- ---------------------------------------------------------------------------
-- P2. 内容版本（同 URL 原文变化 → 保存版本与变化摘要，不覆盖历史）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS content_version (
  id             TEXT PRIMARY KEY,
  content_item_id TEXT NOT NULL REFERENCES content_item(id),
  version_no     INTEGER NOT NULL,
  content_hash   TEXT NOT NULL,
  title          TEXT,
  body_snapshot  TEXT,
  body_chars     INTEGER NOT NULL DEFAULT 0,
  change_kind    TEXT NOT NULL DEFAULT 'initial',  -- initial|updated|minor_edit
  change_summary TEXT,
  diff_chars     INTEGER NOT NULL DEFAULT 0,
  snapshot_id    TEXT,
  fetched_at     TEXT NOT NULL,
  UNIQUE(content_item_id, version_no)
);
CREATE INDEX IF NOT EXISTS idx_cv_item ON content_version(content_item_id, version_no);

-- ---------------------------------------------------------------------------
-- P3. 内容 ↔ 其它来源（同一篇多站转载：建关联、不重复统计）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS content_source_link (
  id              TEXT PRIMARY KEY,
  content_item_id TEXT NOT NULL REFERENCES content_item(id),
  url             TEXT NOT NULL,
  url_hash        TEXT NOT NULL,
  publisher       TEXT,
  source_category TEXT,
  relation        TEXT NOT NULL DEFAULT 'reprint',  -- original|reprint|reference|corroborating
  similarity      REAL,
  -- 第二来源的正文与字段（二轮整改）：只有 URL 不足以做跨来源核验，
  -- 因此把实际取得的正文快照/日期/抓取状态一并留痕，核验时据实声明能力边界。
  body_snapshot   TEXT,
  body_chars      INTEGER NOT NULL DEFAULT 0,
  published_at    TEXT,
  fetch_status    TEXT,                             -- ok|failed|not_fetched|url_only
  fetched_at      TEXT,
  note            TEXT,
  created_at      TEXT NOT NULL,
  UNIQUE(content_item_id, url_hash)
);
CREATE INDEX IF NOT EXISTS idx_csl_item ON content_source_link(content_item_id);

-- ---------------------------------------------------------------------------
-- P4. 搜索服务配置（博查 Web Search / Tavily / Firecrawl Search / 其它兼容 JSON API）
-- 默认推荐：bocha（POST https://api.bocha.cn/v1/web-search，Bearer，凭据引用 BOCHA_API_KEY）
-- 响应数组 data.webPages.value；summary/snippet 只是摘要，不是全文。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS search_provider (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  -- bocha | tavily | firecrawl_search | generic_json
  provider_kind     TEXT NOT NULL,
  base_url          TEXT NOT NULL,
  -- 真实请求端点（默认按 provider_kind 推导，后台可覆盖）
  search_path       TEXT,
  http_method       TEXT NOT NULL DEFAULT 'POST',
  auth_kind         TEXT NOT NULL DEFAULT 'bearer',  -- bearer|header|query|none
  auth_header       TEXT,                            -- auth_kind=header/query 时的字段名
  credential_ref    TEXT,
  credential_cipher TEXT,
  -- 请求参数映射（JSON）：{query_field, count_field, days_field, topic_field, extra:{...}}
  param_map_json    TEXT,
  -- 响应路径（JSON）：{results_path, url_field, title_field, content_field,
  --                    published_field, score_field}
  response_map_json TEXT,
  timeout_ms        INTEGER NOT NULL DEFAULT 25000,
  retry_max         INTEGER NOT NULL DEFAULT 2,
  daily_quota       INTEGER NOT NULL DEFAULT 1000,   -- 调用限额（按日）
  calls_today       INTEGER NOT NULL DEFAULT 0,
  calls_today_date  TEXT,
  enabled           INTEGER NOT NULL DEFAULT 0,
  allowed_domains   TEXT,                            -- 出站白名单
  last_test_at      TEXT,
  last_test_result  TEXT,                            -- ok|failed|never
  last_test_message TEXT,
  last_error        TEXT,
  created_by        TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sp_enabled ON search_provider(enabled);

-- ---------------------------------------------------------------------------
-- P5. 网页抓取连接（Firecrawl v2 MCP / Firecrawl Scrape API / 远端 Streamable HTTP MCP）
-- 生产推荐：firecrawl_mcp（https://mcp.firecrawl.dev/v2/mcp，工具 firecrawl_scrape，
-- Bearer + FIRECRAWL_API_KEY）；官方固定地址允许显式 keyless 试用（受官方限额限制）。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS web_fetch_connection (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  -- firecrawl_mcp | firecrawl_scrape | mcp_streamable_http | direct_http
  conn_kind         TEXT NOT NULL,
  base_url          TEXT NOT NULL,
  -- firecrawl_scrape：抓取端点（默认 /v1/scrape）
  -- mcp_streamable_http：MCP 端点（同一 URL 上做 JSON-RPC 的 initialize/tools/list/tools/call）
  endpoint_path     TEXT,
  http_method       TEXT NOT NULL DEFAULT 'POST',
  auth_kind         TEXT NOT NULL DEFAULT 'bearer',
  auth_header       TEXT,
  credential_ref    TEXT,
  credential_cipher TEXT,
  -- MCP 专用：只允许调用下列**只读**工具；未被列出的工具一律拒绝调用
  mcp_tool_name     TEXT,             -- 抓取工具名，例如 firecrawl_scrape / fetch
  mcp_list_tool     TEXT,             -- 列出工具用的方法（固定 tools/list，此处仅记录）
  mcp_allowed_tools TEXT,             -- JSON array：白名单（只读工具）
  -- 参数映射（JSON）：{url_arg, format_arg, format_value, extra:{...}}
  param_map_json    TEXT,
  response_map_json TEXT,             -- {content_path,title_path,status_path}
  timeout_ms        INTEGER NOT NULL DEFAULT 30000,
  retry_max         INTEGER NOT NULL DEFAULT 2,
  daily_quota       INTEGER NOT NULL DEFAULT 500,
  calls_today       INTEGER NOT NULL DEFAULT 0,
  calls_today_date  TEXT,
  enabled           INTEGER NOT NULL DEFAULT 0,
  allowed_domains   TEXT,
  -- 真实测试结果：连接测试会执行真实的 initialize + tools/list，并记录工具清单摘要
  discovered_tools_json TEXT,
  last_test_at      TEXT,
  last_test_result  TEXT,
  last_test_message TEXT,
  last_error        TEXT,
  note              TEXT,
  created_by        TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wfc_enabled ON web_fetch_connection(enabled);

-- ---------------------------------------------------------------------------
-- P6. 自动核验规则（**非人工审批**：供自动一致性检查与模型提示使用）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS auto_verify_rule (
  id            TEXT PRIMARY KEY,
  rule_key      TEXT NOT NULL,
  scope         TEXT NOT NULL DEFAULT 'content',  -- content|policy|methodology|project|trade
  rule_type     TEXT NOT NULL,   -- required_field|source_required|numeric_sanity|terminology|
                                 -- date_window|official_precedence|prompt_injection_guard
  label         TEXT NOT NULL,
  description   TEXT,
  params_json   TEXT,
  -- fail 直接判 insufficient/conflict；warn 只记录提示
  severity      TEXT NOT NULL DEFAULT 'fail',
  enabled       INTEGER NOT NULL DEFAULT 1,
  builtin       INTEGER NOT NULL DEFAULT 0,   -- 内置规则不可删除，可停用
  updated_by    TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE(rule_key)
);
CREATE INDEX IF NOT EXISTS idx_avr_scope ON auto_verify_rule(scope, enabled);

-- 采集 / 核验策略（键值形式的运行参数）
CREATE TABLE IF NOT EXISTS auto_verify_config (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- P7. 自动核验结果（唯一的内容核验记录；取代人工复核）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS verification_result (
  id                TEXT PRIMARY KEY,
  object_type       TEXT NOT NULL,     -- content_item|policy_document|methodology_version|public_project|trade_daily
  object_id         TEXT NOT NULL,
  -- verified | insufficient | conflict | unavailable
  result            TEXT NOT NULL,
  -- 与 result 对应的界面文案来源：auto_verified|evidence_insufficient|source_conflict|not_verified
  ui_state          TEXT NOT NULL,
  rules_ok          INTEGER NOT NULL DEFAULT 0,   -- 规则一致性检查是否通过
  rules_json        TEXT,                          -- 规则明细 [{rule_key,ok,severity,message}]
  model_used        INTEGER NOT NULL DEFAULT 0,    -- 本次是否真的调用了模型
  provider_id       TEXT,
  model             TEXT,
  model_version     TEXT,
  -- 证据充分性：full_text|partial|abstract_only|metadata_only|none
  evidence_level    TEXT NOT NULL DEFAULT 'none',
  -- 只给搜索摘要时必须明确「核验能力有限」
  capability_note   TEXT,
  confidence        REAL,
  summary           TEXT,
  conflict_fields_json TEXT,           -- 冲突字段 [{field,values:[{source,value}],note}]
  citations_json    TEXT,              -- 引用证据 [{kind,url,title,quote,locator}]
  input_hash        TEXT NOT NULL,
  -- 缓存键组成（二轮整改）：只有「输入哈希 + 策略版本 + 模型 + 证据版本」全部一致
  -- 才复用旧结论；unavailable 永不缓存，模型配置好之后必须能重试。
  input_hash_scheme TEXT NOT NULL DEFAULT 'v2',
  policy_hash       TEXT,               -- 核验策略（阈值/开关/规则集）哈希
  model_key         TEXT,               -- provider_id::model
  evidence_hash     TEXT,               -- 正文+摘要+第二来源证据哈希
  citations_validated INTEGER NOT NULL DEFAULT 0,
  citations_rejected  INTEGER NOT NULL DEFAULT 0,
  prompt_chars      INTEGER NOT NULL DEFAULT 0,
  latency_ms        INTEGER,
  error             TEXT,              -- 调用失败原因（result=unavailable 时）
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_vr_object ON verification_result(object_type, object_id, created_at);
CREATE INDEX IF NOT EXISTS idx_vr_result ON verification_result(result);
CREATE INDEX IF NOT EXISTS idx_vr_input ON verification_result(object_id, input_hash);

-- ---------------------------------------------------------------------------
-- P8. 每日任务数据集游标（增量更新幂等：记录窗口与最近成功时间）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dataset_cursor (
  dataset          TEXT PRIMARY KEY,
  last_window_from TEXT,
  last_window_to   TEXT,
  last_success_at  TEXT,
  last_attempt_at  TEXT,
  last_status      TEXT,     -- ok|partial|failed|never
  last_error       TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  items_seen       INTEGER NOT NULL DEFAULT 0,
  items_new        INTEGER NOT NULL DEFAULT 0,
  note             TEXT
);
-- 大模型对数据核对差异的逐项判断；保留每次校准的证据与结论，不改写官方数据。
CREATE TABLE IF NOT EXISTS reconciliation_ai_review (
  id TEXT PRIMARY KEY,
  reconciliation_id TEXT NOT NULL REFERENCES data_reconciliation(id),
  input_hash TEXT NOT NULL,
  result TEXT NOT NULL,
  summary TEXT,
  citations_json TEXT,
  provider_id TEXT,
  model TEXT,
  evidence_note TEXT,
  error TEXT,
  reviewed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reconciliation_ai_review_issue_at
  ON reconciliation_ai_review(reconciliation_id, reviewed_at DESC);
