-- ============================================================================
-- schema-cea.sql —— CEA（全国碳排放配额）增量结构
-- ============================================================================
-- 依据：docs/31-CEA扩展开发规范.md、docs/decisions/ADR-002-CEA独立行情与共享公开证据.md
--
-- 纪律（与本文件的所有设计相关）：
--   1. **纯增量**：本文件只做 CREATE TABLE / CREATE INDEX IF NOT EXISTS，
--      不改写、不删除 v1/v2/v2.1 的任何表、列与数据。重复执行安全。
--   2. **CEA 不放 CCER trade_daily**：CEA 是配额与履约市场，累计口径、
--      品种年度与交易方式结构与 CCER 不同，混表会造成累计数互换。
--   3. **原文值与推导值分列**：官方公布的数值写入 *_volume/*_turnover/OHLC 列；
--      由程序计算得到的值（如全方式量加权均价）单独写入 computed_* 列，
--      任何情况下不得用推导值覆盖官方值。
--   4. **未披露为 NULL**：公开资料没有给出的字段一律 NULL，不用 0 或 AI 推测填补。
--      「官方明确说无单向竞价」→ 0（有依据）；「页面没有该字段」→ NULL（未披露）。
--   5. **来源快照**：所有行情行必须能回溯到 source_snapshot（哈希 + 抓取时间）。
--   6. 只允许 CCER_ENABLE_V2=1 且 CCER_DB_PATH 非 data/ccer.db 时加载（见 db.mjs / v2-guard.mjs）。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- C1. CEA 官方来源登记
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cea_source (
  id               TEXT PRIMARY KEY,
  code             TEXT NOT NULL,              -- 稳定代码，如 cea_daily_sample_1
  name             TEXT NOT NULL,
  url              TEXT NOT NULL,
  dataset          TEXT NOT NULL,              -- daily|monthly|policy|allocation|calendar|entity|intention|research|regime
  kind             TEXT,                       -- official_html|official_pdf|official_portal|official_list|official_json
  method           TEXT NOT NULL DEFAULT 'GET',-- 公开 JSON 网关需要 POST
  body_template    TEXT,                       -- JSON 请求体模板（含 {YYYYMMDD} 占位）
  authority        TEXT,                       -- 发布机构（生态环境部 / 上海环境能源交易所）
  allowed_domains  TEXT,                       -- JSON 数组：该来源允许出站的域名白名单
  enabled          INTEGER NOT NULL DEFAULT 1,
  priority         INTEGER NOT NULL DEFAULT 100, -- 数值越小优先级越高
  note             TEXT,
  -- 运行状态（真实采集后回填；失败如实记录，不伪造成功）
  last_success_at  TEXT,
  last_attempt_at  TEXT,
  last_error       TEXT,
  last_status      TEXT,                       -- ok|failed|never
  items_ok         INTEGER NOT NULL DEFAULT 0,
  items_failed     INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  UNIQUE(code)
);
CREATE INDEX IF NOT EXISTS idx_cea_source_dataset ON cea_source(dataset, enabled);

-- ---------------------------------------------------------------------------
-- C2. CEA 日行情（独立表，不复用 CCER trade_daily）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cea_trade_daily (
  id                 TEXT PRIMARY KEY,
  trade_date         TEXT NOT NULL,            -- YYYY-MM-DD
  instrument         TEXT NOT NULL DEFAULT 'CEA',  -- 标的；2026 综合行情权重指向 CEA25
  market_scope       TEXT NOT NULL DEFAULT 'national',
  price_regime       TEXT NOT NULL DEFAULT 'CEA_COMPOSITE_2026',
                     -- 行情编制口径版本；2026-01-05 起 CEA25 权重 1，其他年度权重 0

  -- ---- 官方公布值（原文值；未披露为 NULL）----
  open               REAL,                     -- 开盘价 元/吨
  high               REAL,                     -- 最高价
  low                REAL,                     -- 最低价
  close              REAL,                     -- 官方收盘价（综合指数收盘价，不是量加权均价）
  change_pct         REAL,                     -- 官方公布涨跌幅 %
  prev_close         REAL,                     -- 昨收（来源给出时记录）

  -- 交易方式分项：挂牌协议（listed）/ 大宗协议（block）/ 单向竞价（auction）
  listed_volume      REAL,                     -- 吨
  listed_turnover    REAL,                     -- 元
  block_volume       REAL,                     -- 吨
  block_turnover     REAL,                     -- 元
  auction_volume     REAL,                     -- 吨；官方明确「无」→ 0，未披露 → NULL
  auction_turnover   REAL,                     -- 元

  -- 合计（官方口径）
  total_volume       REAL,                     -- 吨
  total_turnover     REAL,                     -- 元
  year_volume        REAL,                     -- 当年累计 吨
  year_turnover      REAL,                     -- 当年累计 元
  lifetime_volume    REAL,                     -- 历史累计 吨
  lifetime_turnover  REAL,                     -- 历史累计 元

  -- ---- 程序推导值（绝不覆盖官方值）----
  computed_avg_price REAL,                     -- 全方式量加权均价 = total_turnover / total_volume；无成交 → NULL
  sum_volume         REAL,                     -- 分项合计（吨，程序计算，用于核对）
  sum_turnover       REAL,                     -- 分项合计（元，程序计算，用于核对）

  -- ---- 来源与追溯 ----
  source_url         TEXT NOT NULL,
  source_id          TEXT REFERENCES cea_source(id),
  source_code        TEXT,                     -- 冗余来源代码，便于按来源统计
  snapshot_id        TEXT,                     -- source_snapshot.id（原始响应快照）
  content_hash       TEXT,                     -- 原始响应 sha256
  fetched_at         TEXT,                     -- 真实抓取时间
  published_at       TEXT,                     -- 官方发布时间（来源给出时）
  data_as_of         TEXT,                     -- 数据截止日

  -- ---- 状态 ----
  parse_status       TEXT NOT NULL DEFAULT 'pending',   -- ok|partial|failed|pending
  parse_note         TEXT,
  check_status       TEXT NOT NULL DEFAULT 'pending',   -- pass|warn|fail|pending（确定性核对）
  verification_status TEXT NOT NULL DEFAULT 'unverified',
                     -- unverified|verified|insufficient|conflict|unavailable（AI 证据一致性，独立于官方值）
  verification_note  TEXT,
  ai_checked_at      TEXT,
  session_state      TEXT NOT NULL DEFAULT 'traded',    -- traded|no_trade|missing

  revision           INTEGER NOT NULL DEFAULT 1,        -- 官方修订次数（历史值走 cea_trade_revision）
  units_json         TEXT,                              -- 原文出现的单位与展示串，便于审计换算
  raw_fields_json    TEXT,                              -- 解析出的原文键值（含千分位/单位原文）
  note               TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  UNIQUE(trade_date, instrument, market_scope, price_regime)
);
CREATE INDEX IF NOT EXISTS idx_cea_td_date ON cea_trade_daily(trade_date);
CREATE INDEX IF NOT EXISTS idx_cea_td_regime ON cea_trade_daily(price_regime, trade_date);
CREATE INDEX IF NOT EXISTS idx_cea_td_check ON cea_trade_daily(check_status);
CREATE INDEX IF NOT EXISTS idx_cea_td_verify ON cea_trade_daily(verification_status);

-- 历史修订留痕：官方改数或重采得到不同数值时，旧值不得被静默覆盖
CREATE TABLE IF NOT EXISTS cea_trade_revision (
  id            TEXT PRIMARY KEY,
  trade_daily_id TEXT NOT NULL REFERENCES cea_trade_daily(id),
  revised_at    TEXT NOT NULL,
  revised_by    TEXT,
  field         TEXT NOT NULL,
  old_value     TEXT,
  new_value     TEXT,
  reason        TEXT NOT NULL,
  official_ref  TEXT,                          -- 官方来源 URL
  snapshot_id   TEXT
);
CREATE INDEX IF NOT EXISTS idx_cea_trv_daily ON cea_trade_revision(trade_daily_id);

-- 确定性核对结果（每条规则一行；不改写官方数值，只标注）
CREATE TABLE IF NOT EXISTS cea_check (
  id            TEXT PRIMARY KEY,
  object_type   TEXT NOT NULL,        -- cea_trade_daily|cea_document|cea_entity|cea_intention
  object_id     TEXT NOT NULL,
  check_key     TEXT NOT NULL,
  label         TEXT,
  ok            INTEGER NOT NULL DEFAULT 0,
  severity      TEXT NOT NULL DEFAULT 'warn',   -- info|warn|fail
  detail        TEXT,
  expected      TEXT,
  actual        TEXT,
  checked_at    TEXT NOT NULL,
  UNIQUE(object_type, object_id, check_key)
);
CREATE INDEX IF NOT EXISTS idx_cea_check_obj ON cea_check(object_type, object_id);
CREATE INDEX IF NOT EXISTS idx_cea_check_ok ON cea_check(ok, severity);

-- ---------------------------------------------------------------------------
-- C3. CEA 政策 / 技术文件 / 研报（配额分配方案、履约通知、行情编制方案等）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cea_document (
  id                TEXT PRIMARY KEY,
  doc_key           TEXT,                       -- 稳定键（来源代码或官方文号），用于幂等 upsert
  doc_type          TEXT NOT NULL,              -- policy|technical|research|news
  category          TEXT,                       -- allocation|annual_work|carryover|price_regime|research|other
  title             TEXT NOT NULL,
  doc_number        TEXT,                       -- 文号，如 国环规气候〔2026〕1号
  issuer            TEXT,                       -- 发布机关
  publish_date      TEXT,                       -- 印发日 YYYY-MM-DD（由原文核对）
  effective_date    TEXT,                       -- 施行日
  covered_sectors   TEXT,                       -- JSON 数组：发电/钢铁/水泥/铝冶炼…
  applicable_years  TEXT,                       -- JSON 数组：[2025,2026]（**书面清单**，判定适用性必须用 coverage_json 配对）
  -- 行业 × 年度**配对**覆盖：[{sector:'发电',years:[2025,2026]},{sector:'钢铁',years:[2026]}]
  -- 规范要求：不得把 covered_sectors × applicable_years 做笛卡尔积
  coverage_json     TEXT,
  coverage_source   TEXT,                       -- 配对依据的真实来源说明
  -- 同一份通知的正文页与官方 PDF 原件：PDF 行以 attachment_of 指向正文行，
  -- count_in_stats=0，避免政策计数重复
  attachment_of     TEXT REFERENCES cea_document(id),
  count_in_stats    INTEGER NOT NULL DEFAULT 1,
  doc_status        TEXT NOT NULL DEFAULT 'formal',  -- formal|draft|consultation|historical|superseded
  version           TEXT,
  supersedes_id     TEXT REFERENCES cea_document(id),  -- 明确的修订关系（不凭模型删除旧记录）
  official_url      TEXT,
  source_id         TEXT REFERENCES cea_source(id),
  source_code       TEXT,
  snapshot_id       TEXT,
  content_hash      TEXT,
  fetched_at        TEXT,
  body_snapshot     TEXT,                       -- 官方原文正文（真实抓取；未获取 → NULL）
  attachment_path   TEXT,                       -- 官方 PDF 等原件落盘路径
  attachment_hash   TEXT,
  attachment_url    TEXT,
  evidence_level    TEXT NOT NULL DEFAULT 'metadata_only',
                    -- full_text|partial|abstract_only|metadata_only（决定 AI 核验能力上限）
  ai_status         TEXT NOT NULL DEFAULT 'unverified',
                    -- unverified|verified|insufficient|conflict|unavailable
  ai_summary        TEXT,
  ai_checked_at     TEXT,
  provenance_note   TEXT,                       -- 本行元数据的真实来源说明（禁止含糊）
  note              TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  UNIQUE(doc_key)
);
CREATE INDEX IF NOT EXISTS idx_cea_doc_type ON cea_document(doc_type, doc_status);
CREATE INDEX IF NOT EXISTS idx_cea_doc_pub ON cea_document(publish_date);
CREATE INDEX IF NOT EXISTS idx_cea_doc_cat ON cea_document(category);

-- ---------------------------------------------------------------------------
-- C4. CEA 履约日历事件（排放年度 / 配额年度 / 名录年度 / 执行日期分别记录）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cea_event (
  id                TEXT PRIMARY KEY,
  event_key         TEXT,                       -- 稳定键，幂等 upsert
  event_type        TEXT NOT NULL,
                    -- allocation_plan_issued|list_published|preallocation|adjustment|
                    -- surrender_deadline|carryover_deadline|data_report_deadline|other
  title             TEXT NOT NULL,
  deadline          TEXT,                       -- 执行日期 YYYY-MM-DD
  emission_year     INTEGER,                    -- 排放年度
  quota_year        INTEGER,                    -- 配额年度
  list_year         INTEGER,                    -- 纳管名录年度
  industry          TEXT,                       -- 行业（空表示全行业）
  source_document_id TEXT REFERENCES cea_document(id),
  source_url        TEXT,
  source_quote      TEXT,                       -- 原文片段（日期依据；不能只按标题年份识别）
  date_extract_status TEXT NOT NULL DEFAULT 'unverified', -- quoted|extracted|inferred|unverified
  date_verify_status  TEXT NOT NULL DEFAULT 'unverified',
                    -- verified|insufficient|conflict|unavailable|unverified
  verify_note       TEXT,
  note              TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  UNIQUE(event_key)
);
CREATE INDEX IF NOT EXISTS idx_cea_event_dl ON cea_event(deadline);
CREATE INDEX IF NOT EXISTS idx_cea_event_year ON cea_event(emission_year, quota_year, list_year);

-- ---------------------------------------------------------------------------
-- C5. 重点排放单位公开名录
-- ---------------------------------------------------------------------------
-- 标识：统一社会信用代码 + 名录年度；名称变化保留来源，不合并集团旗下不同法人。
-- 名录数量 ≠ 买家数量；不提供企业持仓或实际盈缺。
CREATE TABLE IF NOT EXISTS cea_entity (
  id                TEXT PRIMARY KEY,
  entity_key        TEXT NOT NULL,              -- COALESCE(credit_code, 'name:'||name)
  name              TEXT NOT NULL,
  credit_code       TEXT,                       -- 统一社会信用代码（未披露为 NULL，不推测）
  province          TEXT,
  city              TEXT,
  sector            TEXT,                       -- 行业
  list_year         INTEGER NOT NULL,           -- 名录年度（与 credit_code 共同构成标识）
  status            TEXT NOT NULL DEFAULT 'existing',  -- new|existing|exit|unknown
  source_id         TEXT REFERENCES cea_source(id),
  source_url        TEXT,
  source_code       TEXT,
  snapshot_id       TEXT,
  source_hash       TEXT,
  data_as_of        TEXT,                       -- 数据截止日
  verify_status     TEXT NOT NULL DEFAULT 'unverified',
  note              TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  UNIQUE(entity_key, list_year)
);
CREATE INDEX IF NOT EXISTS idx_cea_entity_prov ON cea_entity(province, list_year);
CREATE INDEX IF NOT EXISTS idx_cea_entity_sector ON cea_entity(sector, list_year);
CREATE INDEX IF NOT EXISTS idx_cea_entity_cc ON cea_entity(credit_code);

-- 名录版本留痕：同一主体同一年的名称/行业变化保留历史，不静默改写
CREATE TABLE IF NOT EXISTS cea_entity_revision (
  id            TEXT PRIMARY KEY,
  entity_id     TEXT NOT NULL REFERENCES cea_entity(id),
  revised_at    TEXT NOT NULL,
  revised_by    TEXT,
  field         TEXT NOT NULL,
  old_value     TEXT,
  new_value     TEXT,
  reason        TEXT NOT NULL,
  source_url    TEXT
);
CREATE INDEX IF NOT EXISTS idx_cea_entr_entity ON cea_entity_revision(entity_id);

-- ---------------------------------------------------------------------------
-- C6. 公开交易意向（**绝不进入成交表**；意向 ≠ 成交）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cea_intention (
  id                TEXT PRIMARY KEY,
  intention_key     TEXT,                       -- 稳定键，幂等
  source_id         TEXT REFERENCES cea_source(id),
  source_code       TEXT,
  published_date    TEXT,                       -- 发布日期
  instrument_label  TEXT,                       -- 来源标注的品种（原文，如 CEA / 配额年度）
  quota_year        INTEGER,
  direction         TEXT NOT NULL,              -- buy|sell|unknown
  volume            REAL,                       -- 吨
  price             REAL,                       -- 元/吨；未公开为 NULL（不得用 0 代替）
  participant       TEXT,                       -- 主体；未公开为 NULL
  source_url        TEXT,
  source_hash       TEXT,
  snapshot_id       TEXT,
  last_seen_at      TEXT,
  first_seen_at     TEXT,
  verify_status     TEXT NOT NULL DEFAULT 'unverified',
  note              TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  UNIQUE(intention_key)
);
CREATE INDEX IF NOT EXISTS idx_cea_intent_date ON cea_intention(published_date);
CREATE INDEX IF NOT EXISTS idx_cea_intent_dir ON cea_intention(direction, quota_year);

-- ---------------------------------------------------------------------------
-- C8. 概览层（dailyov.json）——舍入展示值与精确值分层保存
-- ---------------------------------------------------------------------------
-- 官方概览的数量/金额是「万吨/亿元/亿吨」四舍五入展示值（例：精确 2,973,442 吨
-- 显示为「297.34万吨」）。规范要求保留精确值与概览舍入层级，且概览**不得覆盖**精确值，
-- 因此单独成表：精确成交仍在 cea_trade_daily，本表只存概览与其舍入文本。
CREATE TABLE IF NOT EXISTS cea_daily_overview (
  id                TEXT PRIMARY KEY,
  trade_date        TEXT NOT NULL,
  open              REAL,
  high              REAL,
  low               REAL,
  close             REAL,
  prev_close        REAL,
  before_close      REAL,
  change_pct        REAL,
  -- 舍入展示层：原文串 + 换算后的近似基准值（仅供展示/交叉核对）
  today_qty_text    TEXT,
  today_qty_approx  REAL,
  today_amt_text    TEXT,
  today_amt_approx  REAL,
  total_qty_text    TEXT,
  total_qty_approx  REAL,
  total_amt_text    TEXT,
  total_amt_approx  REAL,
  source_url        TEXT NOT NULL,
  source_code       TEXT,
  snapshot_id       TEXT,
  content_hash      TEXT,
  fetched_at        TEXT,
  -- 与精确值的交叉核对结果（超过舍入容差才提示，不覆盖任何一侧）
  cross_check_json  TEXT,
  note              TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  UNIQUE(trade_date, source_code)
);
CREATE INDEX IF NOT EXISTS idx_cea_ov_date ON cea_daily_overview(trade_date);

-- ---------------------------------------------------------------------------
-- C9. CEA 独立日历证据（holidays.json 等）
-- ---------------------------------------------------------------------------
-- CEA 与 CCER 的休市口径可能不同，因此使用独立表，不复用 CCER trade_calendar。
CREATE TABLE IF NOT EXISTS cea_calendar (
  trade_date    TEXT NOT NULL,
  day_type      TEXT NOT NULL,          -- holiday（官方公布的非周末休市日）| trading | unknown
  evidence_kind TEXT NOT NULL,          -- holidays_json|official_notice|manual
  evidence_url  TEXT,
  source_code   TEXT,
  snapshot_id   TEXT,
  note          TEXT,
  -- v2.3 来源修订：完整来源快照采集成功后同步「当前有效集合」。
  --   source_state='current'    = 该证据仍在来源当前列表中（reconcile / list / 统计只看这一层）
  --   source_state='superseded' = 来源已删除该日；历史证据保留可追溯，但不再作为当前事实或告警依据
  source_state  TEXT NOT NULL DEFAULT 'current',
  superseded_at TEXT,
  superseded_by_snapshot TEXT,          -- 触发过期的完整快照 id（可回溯到原始快照）
  superseded_reason      TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (trade_date, evidence_kind)
);
CREATE INDEX IF NOT EXISTS idx_cea_cal_type ON cea_calendar(day_type);
-- 注意：source_state 是本轮新增列，旧库的 cea_calendar 已存在（CREATE TABLE IF NOT EXISTS 不会补列）。
-- 因此 (evidence_kind, source_state) 索引必须由 src/core/db.mjs 在 addColumnIfMissing 之后创建，
-- 不能写在这里：否则旧库在补列之前执行本文件会因「no such column: source_state」而无法打开。

-- ---------------------------------------------------------------------------
-- C10. 行情数据来源层级（同一交易日可同时有 HTML 日报与公开 JSON 通道）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cea_quote_source (
  id            TEXT PRIMARY KEY,
  trade_date    TEXT NOT NULL,
  channel       TEXT NOT NULL,        -- daily_html|dailyov_json|market_by_date_json|substat_json|hiskline_json
  source_code   TEXT,
  source_url    TEXT,
  snapshot_id   TEXT,
  content_hash  TEXT,
  fetched_at    TEXT,
  parsed_json   TEXT,                 -- 该通道解析出的结构化结果（留痕，便于逐字段对照）
  is_precise    INTEGER NOT NULL DEFAULT 0,  -- 1=可作精确成交量额依据
  is_overview   INTEGER NOT NULL DEFAULT 0,  -- 1=仅概览/舍入展示
  note          TEXT,
  created_at    TEXT NOT NULL,
  UNIQUE(trade_date, channel, source_code)
);
CREATE INDEX IF NOT EXISTS idx_cea_qs_date ON cea_quote_source(trade_date, channel);

-- ---------------------------------------------------------------------------
-- C11. CEA 真实历史价格序列（官网公开 hiskline.json，长期真实价格点）
-- ---------------------------------------------------------------------------
-- 口径纪律（CEA-16 / 阶段B 尾项6）：
--   1. `hiskline` 是**官方公开历史价格序列**（ECharts K 线数组：[date, open, close, low, high, volume]），
--      其中的 volume 是参考数量，**不是**全国全方式成交量，禁止写进 total_volume 或据此计算成交额；
--   2. 没有金额的历史点**不得**生成 turnover / 全方式均价（本表因此没有 turnover/vwap 列）；
--   3. 最新一个交易日仍以 querySubStat 的精确分方式成交为准（cea_trade_daily），
--      本表只补历史价格序列，`is_precise=0`，界面上必须与精确日统计分开图例；
--   4. 每个点保留来源快照与抓取时间，可回溯。
CREATE TABLE IF NOT EXISTS cea_price_history (
  id                TEXT PRIMARY KEY,
  trade_date        TEXT NOT NULL,
  open              REAL,
  high              REAL,
  low               REAL,
  close             REAL,
  volume_reference  REAL,                       -- 参考数量（非全方式成交量，禁止当作成交量使用）
  price_regime      TEXT NOT NULL DEFAULT 'CEA_HISKLINE',  -- 历史报价口径标记（与 2026 版编制方案区分）
  quote_caliber     TEXT NOT NULL DEFAULT 'source_history',
  -- source_history = 来源直接给出的历史报价序列；precise_daily = querySubStat 精确日统计
  is_precise        INTEGER NOT NULL DEFAULT 0,
  source_code       TEXT,                       -- cea_json_hiskline
  source_url        TEXT NOT NULL,
  snapshot_id       TEXT,
  content_hash      TEXT,
  fetched_at        TEXT,
  note              TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  UNIQUE(trade_date, source_code)
);
CREATE INDEX IF NOT EXISTS idx_cea_ph_date ON cea_price_history(trade_date);
CREATE INDEX IF NOT EXISTS idx_cea_ph_regime ON cea_price_history(price_regime, trade_date);

-- ---------------------------------------------------------------------------
-- C12. CEA 日历核对（正式休市公告 vs 机器辅助列表 vs 实际成交）
-- ---------------------------------------------------------------------------
-- 规范要求（docs/31 第 60 行补充段）：
--   - 正式全国 CEA 全年休市公告（沪环境交〔2025〕44号）**优先于**查询页使用的机器辅助列表；
--   - 机器列表异常（把实际有成交的交易日标成休市）要**独立告警**，保留原文，不抹掉；
--   - 不生成人工复核任务，不因为一个机器辅助列表就把可靠行情数值判成不真实。
CREATE TABLE IF NOT EXISTS cea_calendar_check (
  trade_date        TEXT NOT NULL,
  check_key         TEXT NOT NULL,              -- notice_vs_machine|notice_vs_trades|machine_vs_trades
  severity          TEXT NOT NULL DEFAULT 'warn',  -- info|warn
  effective_state   TEXT NOT NULL,              -- trading|closed|unknown（综合正式公告与实际成交后的结论）
  detail            TEXT NOT NULL,              -- 人可读说明（保留两侧原文）
  evidence_json     TEXT,                       -- 各证据来源与原始取值（不覆盖、不删除）
  resolved_by       TEXT,                       -- official_notice|actual_trades|none
  manual_review     INTEGER NOT NULL DEFAULT 0, -- 恒为 0：本平台不产生人工复核任务
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  PRIMARY KEY (trade_date, check_key)
);
CREATE INDEX IF NOT EXISTS idx_cea_cc_sev ON cea_calendar_check(severity, trade_date);

-- ---------------------------------------------------------------------------
-- C7. CEA/CCER 同日价格对比（只在**同日都有数据**时成对，缺一则该点为 NULL）
-- ---------------------------------------------------------------------------
-- 该视图不沿用前值、不填 0：任一侧缺失即对应列为 NULL。
CREATE VIEW IF NOT EXISTS cea_ccer_same_day AS
SELECT
  c.trade_date                                        AS trade_date,
  c.close                                             AS cea_composite_close,     -- 官方综合收盘价
  c.computed_avg_price                                AS cea_computed_avg_price,  -- CEA 全方式计算均价
  c.total_volume                                      AS cea_volume,
  c.total_turnover                                    AS cea_turnover,
  c.price_regime                                      AS cea_price_regime,
  t.avg_price                                         AS ccer_computed_avg_price, -- CCER 计算均价
  t.volume                                            AS ccer_volume,
  t.turnover                                          AS ccer_turnover
FROM cea_trade_daily c
LEFT JOIN (
  -- CCER 侧：同日跨交易方式合计后再算均价，避免把某一种方式的均价当作全市场均价
  SELECT trade_date,
         SUM(volume)   AS volume,
         SUM(turnover) AS turnover,
         CASE WHEN SUM(volume) > 0 THEN SUM(turnover) / SUM(volume) ELSE NULL END AS avg_price
  FROM trade_daily
  WHERE market = 'CCER'
  GROUP BY trade_date
) t ON t.trade_date = c.trade_date;
