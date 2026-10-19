-- ============================================================================
-- 公开碳核算资料库（docs/39 第 1 条）
-- ============================================================================
-- 目标：为「碳计算与因子」模块提供独立的公开资料存储，与 v1 正式 CCER 因子、
--       33 条历史门禁、CCER/CEA 既有表**完全分开**：
--   · 本文件只做 CREATE TABLE / CREATE INDEX IF NOT EXISTS，重复执行安全；
--   · 由 src/core/db.mjs 在 CCER_ENABLE_V2=1 时作为 v2.4 增量执行；
--   · 不修改、不引用 v1/v2/CEA 的任何表结构，也不写入这些表的数据。
--
-- 数据纪律（与界面/接口一致，不得放宽）：
--   1. 只有**真实读取到的公开资料**才能写入；seed 只允许写来源登记、规范元数据
--      与已核实并附原件哈希/页码的静态值，且必须标明 metadata_origin；
--   2. 绝不 seed 编造的「抓取成功状态」或「模型已核验」；
--   3. 电力 CO2 因子（kgCO2/kWh）不是产品全生命周期碳足迹因子，也不是
--      CCER 区域电网基准线因子；三种口径不得互换，由 caliber 字段显式区分；
--   4. 本库的排放计算结果**不得**当作 CCER 预计签发量，也不自动解除正式门禁。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 一、来源登记（门户 / 列表页 / 详情页 / PDF 分别记录）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS accounting_source (
  id                TEXT PRIMARY KEY,
  code              TEXT NOT NULL UNIQUE,
  name              TEXT NOT NULL,
  url               TEXT NOT NULL,
  authority         TEXT,                       -- 权威主体（原文表述）
  allowed_domains   TEXT NOT NULL DEFAULT '[]', -- JSON 数组：仅这些域名允许抓取
  source_type       TEXT NOT NULL,              -- portal|list|detail|pdf|json|search
  category          TEXT NOT NULL,              -- crc|ncsc_factor|cets|standard|mee_factor
  fetch_kind        TEXT,                       -- direct_html|pdf|search_fallback|mcp_fetch
  cets_relation     TEXT,                       -- 与全国碳市场管理平台（CETS）的公开关联说明
  enabled           INTEGER NOT NULL DEFAULT 1,
  status            TEXT NOT NULL DEFAULT 'registered', -- registered|ok|blocked|error|stale|empty
  status_note       TEXT,
  last_attempt_at   TEXT,
  last_success_at   TEXT,
  last_http_status  INTEGER,
  last_error        TEXT,
  last_url          TEXT,                       -- 实际请求的完整 URL（含参数）
  last_content_hash TEXT,                       -- 原始响应体 sha256
  last_content_bytes INTEGER,
  last_file_path    TEXT,                       -- 原件落盘路径（DB 旁 official-originals/accounting）
  last_page_url     TEXT,                       -- 详情页实际 URL（列表页发现）
  collected_count   INTEGER NOT NULL DEFAULT 0, -- 最近一次成功采集到的对象数
  blocked_kind      TEXT,                       -- http_412_challenge|login_required|http_403|timeout|null
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_acc_source_cat ON accounting_source(category, status);
CREATE INDEX IF NOT EXISTS idx_acc_source_code ON accounting_source(code);

-- ---------------------------------------------------------------------------
-- 二、排放因子
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS emission_factor (
  id                TEXT PRIMARY KEY,
  -- 稳定身份：同一来源同一口径同一地区同一年度同一版本重复采集命中同一行
  identity_key      TEXT NOT NULL UNIQUE,
  -- 来源身份：来源 + 原件 URL + 页码/表号，用于回溯「这一行具体来自哪一页」
  source_identity   TEXT NOT NULL,
  source_id         TEXT REFERENCES accounting_source(id),
  source_code       TEXT NOT NULL,
  name              TEXT NOT NULL,
  value             REAL NOT NULL,
  original_unit     TEXT NOT NULL,              -- 原文单位（如 kgCO2/kWh）
  standard_unit     TEXT,                       -- 规范单位（发生换算时非空）
  conversion_factor REAL,                       -- 换算系数（original → standard）
  conversion_note   TEXT,
  gas               TEXT NOT NULL DEFAULT 'CO2',-- CO2|CO2e；不得把 CO2 自动标成 CO2e
  category          TEXT NOT NULL,              -- national_average|regional_average|provincial_average
                                                -- |national_excl_market_nonfossil|national_fossil
  caliber           TEXT NOT NULL,              -- 口径原文说明
  region            TEXT,
  region_level      TEXT,                       -- national|region|province
  industry          TEXT,
  data_year         INTEGER NOT NULL,
  publish_date      TEXT,
  effective_date    TEXT,
  version           TEXT NOT NULL,
  applicability     TEXT,                       -- 适用说明与限制
  page_physical     INTEGER,                    -- PDF 物理页（1 起）
  page_printed      TEXT,                       -- 打印页码（如 '3'）
  locator           TEXT,                       -- 表号/行标题（如 '表3 省级… 北京'）
  original_url      TEXT NOT NULL,
  original_sha256   TEXT,
  snapshot_path     TEXT,
  evidence_level    TEXT NOT NULL DEFAULT 'metadata_only', -- full|partial|metadata_only
  model_verify_status TEXT NOT NULL DEFAULT 'unavailable', -- verified|insufficient|conflict|unavailable|unverified
  model_verify_at   TEXT,
  is_current        INTEGER NOT NULL DEFAULT 1,
  supersedes_id     TEXT REFERENCES emission_factor(id),
  superseded_by_id  TEXT REFERENCES emission_factor(id),
  metadata_origin   TEXT,                       -- 该行的元数据来源（如 verified-source-manifest）
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ef_filter ON emission_factor(category, data_year, region);
CREATE INDEX IF NOT EXISTS idx_ef_current ON emission_factor(is_current, data_year);
CREATE INDEX IF NOT EXISTS idx_ef_source ON emission_factor(source_code, identity_key);

-- ---------------------------------------------------------------------------
-- 三、标准与技术规范
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS accounting_standard (
  id                TEXT PRIMARY KEY,
  code              TEXT,                       -- 规范编号，如 CETS-AG-01.01-V04-2026
  identity_key      TEXT NOT NULL UNIQUE,
  title             TEXT NOT NULL,
  issuer            TEXT,                       -- 发布机构（原文表述）
  sector            TEXT,                       -- 发电|钢铁|水泥|铝冶炼
  standard_type     TEXT NOT NULL,              -- accounting|verification|update_note|policy
  status            TEXT NOT NULL,              -- formal|draft|consultation|historical|superseded
  version           TEXT,
  publish_date      TEXT,                       -- 网页发布日
  issue_date        TEXT,                       -- 落款/成文日
  effective_year    INTEGER,                    -- 自哪个核算年度适用
  applicable_years  TEXT,                       -- JSON 数组
  applicability     TEXT,                       -- 适用说明（原文口径；不可推断时留空）
  announcement_url  TEXT,                       -- 发布公告页（真实 HTML）
  original_url      TEXT,                       -- 原 PDF URL（真实 href，不拼猜）
  body_text         TEXT,
  body_status       TEXT NOT NULL DEFAULT 'metadata_only', -- full|partial|metadata_only
  sha256            TEXT,
  pages_total       INTEGER,
  chars             INTEGER,
  source_id         TEXT REFERENCES accounting_source(id),
  source_locator    TEXT,                       -- 公告页内的锚文本/附件名
  model_verify_status TEXT NOT NULL DEFAULT 'unavailable',
  model_verify_at   TEXT,
  replaces_code     TEXT,
  related_codes     TEXT,                       -- JSON 数组
  cets_relation     TEXT,                       -- 与 CETS 的公开关联（编号体系）
  metadata_origin   TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_std_filter ON accounting_standard(sector, status, standard_type);
CREATE INDEX IF NOT EXISTS idx_std_code ON accounting_standard(code);

-- ---------------------------------------------------------------------------
-- 四、中碳登（CRC）清结算日报
-- ---------------------------------------------------------------------------
-- 口径纪律：这是「全国碳排放权交易市场」清结算口径的**独立来源**，
--   · 不覆盖 CCER/CEA 主行情的综合收盘价；
--   · 与上海环境能源交易所同日成交量**分列两方原值**，绝不直接相加；
--   · 「自愿注销公示」量与交易/履约清缴分开，公示量不计入成交。
CREATE TABLE IF NOT EXISTS crc_clearing_daily (
  id                TEXT PRIMARY KEY,
  source_id         TEXT REFERENCES accounting_source(id),
  source_code       TEXT NOT NULL,
  detail_url        TEXT NOT NULL,
  title             TEXT,
  trade_date        TEXT NOT NULL,              -- 数据日期（YYYY-MM-DD）
  published_at      TEXT,                       -- 网页发布时间
  daily_volume_t    REAL,                       -- 本日成交总量（吨）
  daily_amount_yuan REAL,                       -- 本日成交总额（元）
  daily_avg_price_published REAL,               -- 原文公布均价（元/吨）
  daily_avg_price_derived   REAL,               -- 由本日量额复算的均价
  avg_price_origin  TEXT,                       -- published|derived|none
  cumulative_volume_t    REAL,
  cumulative_amount_yuan REAL,
  caliber           TEXT NOT NULL,              -- 口径原文（如「全国碳排放权交易市场（清结算日报）」）
  scope             TEXT NOT NULL DEFAULT 'market_total', -- market_total（交易合计行）
  snapshot_path     TEXT,
  content_hash      TEXT,
  revision_of       TEXT REFERENCES crc_clearing_daily(id),
  revision_no       INTEGER NOT NULL DEFAULT 1,
  is_current        INTEGER NOT NULL DEFAULT 1,
  parse_note        TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_crc_daily_ident
  ON crc_clearing_daily(source_code, trade_date, scope, revision_no);
CREATE INDEX IF NOT EXISTS idx_crc_daily_date ON crc_clearing_daily(trade_date, is_current);

-- 日报分层明细：按年度配额品种 × 交易方式的「本日/累计」量额（含小计行）。
-- 用途：证明「明细 → 小计 → 交易合计」的加总关系，并据此**不重复加总**。
CREATE TABLE IF NOT EXISTS crc_clearing_component (
  id                TEXT PRIMARY KEY,
  daily_id          TEXT NOT NULL REFERENCES crc_clearing_daily(id),
  year_label        TEXT NOT NULL,              -- 如「碳排放配额25」
  trade_method      TEXT NOT NULL,              -- 挂牌协议交易|大宗协议交易|单向竞价|小计
  is_subtotal       INTEGER NOT NULL DEFAULT 0,
  daily_volume_t    REAL,
  daily_amount_yuan REAL,
  cumulative_volume_t    REAL,
  cumulative_amount_yuan REAL,
  counts_to_total   INTEGER NOT NULL DEFAULT 0, -- 只有小计行参与「明细→合计」复核
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_crc_comp_daily ON crc_clearing_component(daily_id);

-- ---------------------------------------------------------------------------
-- 五、CETS 公开资料（政策/标准列表、共性/发电 MRV 问答、正文文章、入口页）
-- ---------------------------------------------------------------------------
-- 纪律（docs/41）：
--   · 公开门户名称为**全国碳市场信息网**；企业管理系统链接与公开信息网站分开，
--     www.cets.org.cn 不再被概括为「登录管理平台」；
--   · 直接 HTTP 会被 412 拦截，公开栏目由**已配置抓取连接**（Firecrawl/MCP）读取，
--     这不是突破验证：只使用公开白名单 URL，不登录任何企业账户；
--   · 列表页只记**实际获得**条数（`observed_count`），栏目宣称总数放在
--     `announced_count` 并明确标注「宣称总量 ≠ 本平台实际入库」；
--   · 正文提取必须去导航去页脚；问答按结构拆分（question/answer）；
--   · 菜单/栏目索引**不是全文**：`body_status='index_only'`。
--   · 页面渲染成功（HTTP 200 / 抓取 ok）**不等于**资料成功：14 字 loading shell
--     一律 `ok=false`（见 assessFetchedDocument），不入库。
CREATE TABLE IF NOT EXISTS accounting_public_document (
  id                TEXT PRIMARY KEY,
  source_id         TEXT REFERENCES accounting_source(id),
  source_code       TEXT NOT NULL,
  doc_key           TEXT NOT NULL UNIQUE,       -- 稳定身份：来源 + 规范化 URL
  doc_type          TEXT NOT NULL,              -- policy|standard_list|policy_list|faq_list|faq_article
                                                -- |article|guide_list|disclosure|faq_index
  category          TEXT NOT NULL,              -- policy|standard|notice|faq|guide|ccer_guide
                                                -- |disclosure|compliance|verifier_disclosure
  title             TEXT NOT NULL,
  url               TEXT NOT NULL,              -- 原文 URL（公开白名单内）
  published_at      TEXT,                       -- 页面/列表标注的发布日期
  issuer            TEXT,
  summary           TEXT,
  body_text         TEXT,                       -- 去导航后的正文（问答含「问/答」结构）
  body_status       TEXT NOT NULL DEFAULT 'metadata_only', -- full|partial|index_only|metadata_only|unavailable
  content_kind      TEXT,                       -- html_article|list|faq|menu
  observed_count    INTEGER,                    -- 本页**实际获得**条数（列表/问答）
  announced_count   INTEGER,                    -- 页面宣称总量（如「共40条」）—— 与实际入库分列
  announced_note    TEXT,
  fetch_method      TEXT,                       -- direct_http|configured_fetch|static_capture
  http_status       INTEGER,
  content_hash      TEXT,                       -- 抓取内容 sha256（正文级）
  snapshot_path     TEXT,                       -- 原件落盘路径（DB 旁 official-originals/accounting）
  captured_at       TEXT,                       -- 真实抓取时间（静态复核件记独立读取时间）
  evidence_level    TEXT NOT NULL DEFAULT 'metadata_only', -- full_text|partial_text|rendered_capture
                                                -- |list_only|metadata_only|unavailable
  model_verify_status TEXT NOT NULL DEFAULT 'unavailable',
  model_verify_at   TEXT,
  revision_no       INTEGER NOT NULL DEFAULT 1,
  revision_of       TEXT REFERENCES accounting_public_document(id),
  is_current        INTEGER NOT NULL DEFAULT 1,
  metadata_origin   TEXT,
  limitation        TEXT,                       -- 能力限制原文说明（如隐藏面板、分页 #）
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_apd_filter ON accounting_public_document(category, doc_type, is_current);
CREATE INDEX IF NOT EXISTS idx_apd_source ON accounting_public_document(source_code, url);

-- 问答条目（按结构从真实抓取正文中拆分；不生成、不摘编）
CREATE TABLE IF NOT EXISTS accounting_public_qa (
  id                TEXT PRIMARY KEY,
  document_id       TEXT NOT NULL REFERENCES accounting_public_document(id),
  ordinal           INTEGER NOT NULL,           -- 页内顺序（原文顺序）
  question          TEXT NOT NULL,
  answer            TEXT,
  category          TEXT,                       -- 与所属文档一致的栏目分类
  source_url        TEXT NOT NULL,
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_apq_doc ON accounting_public_qa(document_id, ordinal);

-- 规范正文历史（正文/哈希变化时保留旧版本，不静默覆盖）
CREATE TABLE IF NOT EXISTS accounting_standard_body_revision (
  id                TEXT PRIMARY KEY,
  standard_id       TEXT NOT NULL REFERENCES accounting_standard(id),
  revision_no       INTEGER NOT NULL,
  body_status       TEXT NOT NULL,
  sha256            TEXT,
  pages_total       INTEGER,
  pages_read        INTEGER,
  extraction_complete INTEGER NOT NULL DEFAULT 0,
  chars             INTEGER,
  source            TEXT,
  source_url        TEXT,
  origin            TEXT NOT NULL,              -- admin_upload|official_fetch|official_capture
  content_hash      TEXT,
  note              TEXT,
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_asbr_std ON accounting_standard_body_revision(standard_id, revision_no);

-- 管理员上传的规范原件（真实 file 输入 → 受控保存；与官方 URL 字节一致才提升来源层级）
CREATE TABLE IF NOT EXISTS accounting_standard_upload (
  id                TEXT PRIMARY KEY,
  standard_id       TEXT NOT NULL REFERENCES accounting_standard(id),
  file_name         TEXT,
  file_hash         TEXT NOT NULL,
  file_size         INTEGER NOT NULL,
  local_path        TEXT NOT NULL,
  source_status     TEXT NOT NULL,              -- admin_supplied_unverified|official_hash_match
  source_claim_url  TEXT,
  matches_original  INTEGER NOT NULL DEFAULT 0, -- 与公告官方 URL 的 sha256 是否一致
  diff_note         TEXT,
  parse_quality     TEXT,
  parse_detail_json TEXT,
  uploaded_by       TEXT,
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_asup_std ON accounting_standard_upload(standard_id, created_at);
