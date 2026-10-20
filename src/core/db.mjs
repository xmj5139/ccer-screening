/**
 * 数据访问层：SQLite 连接、schema 初始化、查询助手、审计日志写入。
 * 使用 Node 内置 node:sqlite，无需任何 npm 依赖。
 */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bind, newId, nowIso, j } from './util.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = resolve(__dirname, '..', '..');
export const DEFAULT_DB_PATH = process.env.CCER_DB_PATH || join(PROJECT_ROOT, 'data', 'ccer.db');

let _db = null;

export function dbPath() {
  return DEFAULT_DB_PATH;
}

export function getDb() {
  if (_db) return _db;
  const p = dbPath();
  mkdirSync(dirname(p), { recursive: true });
  _db = new DatabaseSync(p);
  _db.exec('PRAGMA foreign_keys = ON;');
  try {
    _db.exec('PRAGMA journal_mode = WAL;');
  } catch {
    /* 内存库不支持 WAL，忽略 */
  }
  migrate(_db);
  return _db;
}

export function closeDb() {
  if (_db) {
    try {
      _db.close();
    } catch {
      /* ignore */
    }
    _db = null;
  }
}

/**
 * 建表与迁移（幂等）。
 * ============================================================================
 * v1.0 → v2.0 为**纯增量迁移**：
 *   - schema.sql     仍然只有 CREATE TABLE IF NOT EXISTS，不做任何列级变更；
 *   - schema-v2.sql  只新增表（政策库、公开项目库、行情、采集管线、审核任务、
 *     团队与授权、LLM / 数据源配置、数据缺口台账等），不触碰 v1 的任何表与列。
 *
 * 因此：
 *   1. 对已有 data/ccer.db 执行本迁移是安全的、可重复的，历史数据与历史报告不受影响；
 *   2. 回滚只需 DROP schema-v2.sql 定义的这些表，v1 表结构与数据完整保留；
 *   3. v2 的功能验证与运行使用独立数据库（CCER_DB_PATH=data/ccer_v2.db，
 *      见 npm run v2:seed / v2:start），不与在用的 data/ccer.db 混淆。
 */
const V2_SCHEMA_FILE = 'schema-v2.sql';
const PUBLIC_SCHEMA_FILE = 'schema-public.sql';
const CEA_SCHEMA_FILE = 'schema-cea.sql';
const ACCOUNTING_SCHEMA_FILE = 'schema-accounting.sql';
const PLATFORM_SCHEMA_FILE = 'schema-platform.sql';
const DEEPSEEK_SCHEMA_FILE = 'schema-deepseek.sql';
const REGIONAL_SCHEMA_FILE = 'schema-regional.sql';

export function migrate(db) {
  const sql = readFileSync(join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  db.exec(sql);
  const cur = getMeta(db, 'schema_version');
  if (!cur) setMeta(db, 'schema_version', '1.0.0');

  // V2 schema changes are opt-in so opening the existing v1 database cannot
  // silently migrate it. Development and tests set CCER_ENABLE_V2=1 together
  // with an isolated CCER_DB_PATH.
  if (process.env.CCER_ENABLE_V2 !== '1') return;

  // ---- v2 增量迁移 ----
  const v2Path = join(__dirname, '..', 'db', V2_SCHEMA_FILE);
  if (existsSync(v2Path)) {
    db.exec(readFileSync(v2Path, 'utf8'));
    if (!getMeta(db, 'schema_version_v2_applied')) {
      setMeta(db, 'schema_version_v2_applied', nowIso());
      setMeta(db, 'schema_version', '2.0.0');
    }
  }

  // ---- v2.1 公开信息整合增量（公开内容表 / 搜索与抓取连接 / 自动核验）----
  // 全部为 CREATE TABLE IF NOT EXISTS + 幂等加列，对既有 v2 库重复执行安全。
  const publicPath = join(__dirname, '..', 'db', PUBLIC_SCHEMA_FILE);
  if (existsSync(publicPath)) {
    db.exec(readFileSync(publicPath, 'utf8'));
    if (!getMeta(db, 'schema_version_public_applied')) {
      setMeta(db, 'schema_version_public_applied', nowIso());
      setMeta(db, 'schema_version', '2.1.0');
    }
  }
  // ---- v2.2 CEA（全国碳排放配额）独立增量（docs/31、ADR-002）----
  // CEA 行情不复用 CCER trade_daily：累计口径、年度标的与交易方式结构不同。
  // 本文件只 CREATE TABLE / CREATE INDEX / CREATE VIEW IF NOT EXISTS，重复执行安全。
  const ceaPath = join(__dirname, '..', 'db', CEA_SCHEMA_FILE);
  if (existsSync(ceaPath)) {
    db.exec(readFileSync(ceaPath, 'utf8'));
    if (!getMeta(db, 'schema_version_cea_applied')) {
      setMeta(db, 'schema_version_cea_applied', nowIso());
      setMeta(db, 'schema_version', '2.3.0');
    }
  }

  // ---- v2.4 公开碳核算资料库增量（docs/39：中碳登 / NCSC 因子库 / CETS / 标准规范）----
  // 与 v1 正式 CCER 因子、33 条历史门禁完全分开：本文件只新增 5 张独立表，
  // 不修改、不引用、不写入 v1/v2/CEA 的任何表；重复执行 `CREATE ... IF NOT EXISTS` 安全。
  const accountingPath = join(__dirname, '..', 'db', ACCOUNTING_SCHEMA_FILE);
  if (existsSync(accountingPath)) {
    db.exec(readFileSync(accountingPath, 'utf8'));
    if (!getMeta(db, 'schema_version_accounting_applied')) {
      setMeta(db, 'schema_version_accounting_applied', nowIso());
      setMeta(db, 'schema_version', '2.4.0');
    }
    // 列级补充（幂等）：首次发布后补入的列，旧库靠这里补齐。
    addColumnIfMissing(db, 'accounting_standard', 'applicability', 'TEXT');
    addColumnIfMissing(db, 'emission_factor', 'region_label', 'TEXT');
    // v2.5（docs/41）：完整性判定改为按**实际页覆盖**，核验记录需保留输入内容哈希、
    // 精确原文 URL 与引用定位；已核实/已发布状态与「一般国标」分列，不互相顶替。
    addColumnIfMissing(db, 'accounting_standard', 'pages_read', 'INTEGER');
    addColumnIfMissing(db, 'accounting_standard', 'official_sha256', 'TEXT');
    addColumnIfMissing(db, 'accounting_standard', 'extraction_complete', 'INTEGER NOT NULL DEFAULT 0');
    addColumnIfMissing(db, 'accounting_standard', 'content_hash', 'TEXT');
    addColumnIfMissing(db, 'accounting_standard', 'body_origin', 'TEXT');
    addColumnIfMissing(db, 'accounting_standard', 'source_kind', "TEXT NOT NULL DEFAULT 'cets_technical_spec'");
    addColumnIfMissing(db, 'accounting_standard', 'published_status', 'TEXT');   // 标准状态（如「现行」）
    addColumnIfMissing(db, 'accounting_standard', 'effective_date', 'TEXT');    // 实施日期（与发布日/适用年度分列）
    addColumnIfMissing(db, 'accounting_standard', 'full_text_available', 'INTEGER NOT NULL DEFAULT 0');
    addColumnIfMissing(db, 'accounting_standard', 'verify_input_hash', 'TEXT');
    addColumnIfMissing(db, 'accounting_standard', 'verify_source_url', 'TEXT');
    addColumnIfMissing(db, 'accounting_standard', 'body_revision_no', 'INTEGER NOT NULL DEFAULT 0');
    addColumnIfMissing(db, 'emission_factor', 'model_verify_input_hash', 'TEXT');
    addColumnIfMissing(db, 'emission_factor', 'source_changed', 'INTEGER NOT NULL DEFAULT 0');
    addColumnIfMissing(db, 'accounting_source', 'cets_role', 'TEXT');           // 公开门户/企业系统入口分列
  }

  // ---- v2.6 碳市场信息平台增量（docs/44）----
  // 摘要缓存 / 管理员修订覆盖层 / 问答日志 / 官方域名登记：**纯加法**，
  // 只新建 4 张独立表，不修改任何既有表、列或数据；旧库重复执行安全。
  const platformPath = join(__dirname, '..', 'db', PLATFORM_SCHEMA_FILE);
  if (existsSync(platformPath)) {
    db.exec(readFileSync(platformPath, 'utf8'));
    // 平台表的列级补充（幂等）：首版发布后追加的列，旧库靠这里补齐。
    addColumnIfMissing(db, 'entity_summary', 'cheap_sig', 'TEXT');
    if (!getMeta(db, 'schema_version_platform_applied')) {
      setMeta(db, 'schema_version_platform_applied', nowIso());
      setMeta(db, 'schema_version', '2.6.0');
    }
  }

  // ---- v2.7 DeepSeek 能力扩展（docs/54）----
  // 纯新增表 + 幂等加列。先建表（llm_provider 已在上方就绪），再补引用/观测列。
  const deepseekPath = join(__dirname, '..', 'db', DEEPSEEK_SCHEMA_FILE);
  if (existsSync(deepseekPath)) {
    db.exec(readFileSync(deepseekPath, 'utf8'));
    addColumnIfMissing(db, 'deepseek_capability', 'provider_bound', 'INTEGER NOT NULL DEFAULT 0');
    // A. 复用现有模型凭据：只存 provider_id，绝不复制明文/密文密钥到新表。
    addColumnIfMissing(db, 'search_provider', 'provider_id', 'TEXT REFERENCES llm_provider(id)');
    addColumnIfMissing(db, 'web_fetch_connection', 'provider_id', 'TEXT REFERENCES llm_provider(id)');
    // 备用通道顺序：主服务在前，备用在后；旧配置默认 primary（priority 100）。
    for (const table of ['search_provider', 'web_fetch_connection']) {
      addColumnIfMissing(db, table, 'is_fallback', 'INTEGER NOT NULL DEFAULT 0');
      addColumnIfMissing(db, table, 'fallback_priority', 'INTEGER NOT NULL DEFAULT 100');
      addColumnIfMissing(db, table, 'last_call_at', 'TEXT');
      addColumnIfMissing(db, table, 'last_success_at', 'TEXT');
      addColumnIfMissing(db, table, 'total_calls', 'INTEGER NOT NULL DEFAULT 0');
      addColumnIfMissing(db, table, 'total_success', 'INTEGER NOT NULL DEFAULT 0');
      addColumnIfMissing(db, table, 'last_usage_json', 'TEXT');
    }
    // E. 思考模式按任务控制（只对声明为 DeepSeek 官方端点的配置生效）。
    addColumnIfMissing(db, 'llm_provider', 'thinking_policy', "TEXT NOT NULL DEFAULT 'auto'");
    addColumnIfMissing(db, 'llm_provider', 'reasoning_effort', "TEXT NOT NULL DEFAULT 'high'");
    // 调用观测：token / 输入缓存 / 工具次数 / 截断原因 / 费用估算。
    for (const [col, decl] of [
      ['prompt_tokens', 'INTEGER'],
      ['completion_tokens', 'INTEGER'],
      ['total_tokens', 'INTEGER'],
      ['cache_hit_tokens', 'INTEGER'],
      ['cache_miss_tokens', 'INTEGER'],
      ['tool_calls', 'INTEGER NOT NULL DEFAULT 0'],
      ['thinking_enabled', 'INTEGER'],
      ['finish_reason', 'TEXT'],
      ['estimated_cost_cny', 'REAL'],
      ['cost_estimated', 'INTEGER NOT NULL DEFAULT 0'],
      ['retry_count', 'INTEGER NOT NULL DEFAULT 0'],
    ]) {
      addColumnIfMissing(db, 'llm_call_log', col, decl);
    }
    // D. 多轮会话与工具化回答留痕（兼容旧单轮请求：session_id 可为空）。
    for (const [col, decl] of [
      ['session_id', 'TEXT'],
      ['tools_json', 'TEXT'],
      ['tool_call_count', 'INTEGER NOT NULL DEFAULT 0'],
      ['thinking', 'INTEGER NOT NULL DEFAULT 0'],
      ['cache_hit_tokens', 'INTEGER'],
      ['cache_miss_tokens', 'INTEGER'],
      ['as_of', 'TEXT'],
    ]) {
      addColumnIfMissing(db, 'chat_turn', col, decl);
    }
    if (!getMeta(db, 'schema_version_deepseek_applied')) {
      setMeta(db, 'schema_version_deepseek_applied', nowIso());
      setMeta(db, 'schema_version', '2.7.0');
    }
  }

  // ---- v2.7 省域地图增量（docs/59）----
  // 省级排放记录与项目/名录分表保存，纯新增表；版本号保持 2.7.0，不另发标签。
  // 重复执行 CREATE ... IF NOT EXISTS / CREATE INDEX ... IF NOT EXISTS 安全。
  const regionalPath = join(__dirname, '..', 'db', REGIONAL_SCHEMA_FILE);
  if (existsSync(regionalPath)) {
    db.exec(readFileSync(regionalPath, 'utf8'));
    if (!getMeta(db, 'schema_version_regional_applied')) {
      setMeta(db, 'schema_version_regional_applied', nowIso());
    }
  }

  // v2 的少量列级变更：必须幂等（SQLite 无 ADD COLUMN IF NOT EXISTS）
  addColumnIfMissing(db, 'methodology_version', 'evidence_level', "TEXT NOT NULL DEFAULT 'unverified'");
  addColumnIfMissing(db, 'methodology_version', 'evidence_note', 'TEXT');
  addColumnIfMissing(db, 'methodology_version', 'body_snapshot', 'TEXT');
  addColumnIfMissing(db, 'methodology_version', 'original_file_path', 'TEXT');
  // 内部项目库与 v1 项目档案的关联列（v2 后补，见 src/services/project-v2-svc.mjs）
  addColumnIfMissing(db, 'internal_project', 'dossier_project_id', 'TEXT');
  addColumnIfMissing(db, 'internal_project', 'industry', 'TEXT');
  addColumnIfMissing(db, 'internal_project', 'note', 'TEXT');
  for (const [col, decl] of [
    ['display_name', 'TEXT'],
    ['email', 'TEXT'],
    ['password_hash', 'TEXT'],
    ['password_algo', 'TEXT'],
    ['must_change_password', 'INTEGER NOT NULL DEFAULT 0'],
    ['failed_attempts', 'INTEGER NOT NULL DEFAULT 0'],
    ['locked_until', 'TEXT'],
    ['last_login_at', 'TEXT'],
    ['created_at', 'TEXT'],
    ['updated_at', 'TEXT'],
  ]) {
    addColumnIfMissing(db, 'app_user', col, decl);
  }
  // v2.1：公开项目补充「官方链接可用性」与「最近一次自动核验」冗余列。
  // 附件/详情页取不到时必须展示真实状态，而不是隐藏或假装已获取。
  for (const [col, decl] of [
    ['link_status', 'TEXT'],              // ok|blocked|not_found|unreachable|unknown
    ['link_checked_at', 'TEXT'],
    ['link_note', 'TEXT'],
    ['auto_verify_status', 'TEXT'],       // verified|insufficient|conflict|unavailable
    ['auto_verify_at', 'TEXT'],
  ]) {
    addColumnIfMissing(db, 'public_project', col, decl);
  }
  // v2.1：公开项目「自动核验」取代人工确认；旧 review_status 仅作历史保留。
  addColumnIfMissing(db, 'policy_document', 'auto_verify_status', 'TEXT');
  addColumnIfMissing(db, 'policy_document', 'auto_verify_at', 'TEXT');
  // 同一公告的旧占位行与官方原文行保留双记录，用独立关系标记重复，
  // 不误用法律效力含义不同的 doc_status='superseded'。
  addColumnIfMissing(db, 'policy_document', 'duplicate_of', 'TEXT REFERENCES policy_document(id)');
  addColumnIfMissing(db, 'methodology_version', 'auto_verify_status', 'TEXT');
  addColumnIfMissing(db, 'methodology_version', 'auto_verify_at', 'TEXT');
  addColumnIfMissing(db, 'llm_provider', 'use_content_verify', 'INTEGER NOT NULL DEFAULT 0');
  for (const table of ['llm_provider', 'search_provider', 'web_fetch_connection']) {
    addColumnIfMissing(db, table, 'archived', 'INTEGER NOT NULL DEFAULT 0');
  }
  // v2.1：抓取连接的备注（首次发布时遗漏，幂等补上）
  addColumnIfMissing(db, 'web_fetch_connection', 'note', 'TEXT');
  addColumnIfMissing(db, 'search_provider', 'note', 'TEXT');
  // v2.2 CEA：source_snapshot.source_id 引用的是 v1 的 source_document，
  // 不能塞 cea_source.id（会触发外键失败）。CEA 快照用独立列指向 cea_source。
  addColumnIfMissing(db, 'source_snapshot', 'cea_source_id', 'TEXT REFERENCES cea_source(id)');
  // v2.2 CEA：公开 JSON 通道需要 HTTP 方法与请求体模板（GET 带 body 会被 fetch 直接拒绝）
  addColumnIfMissing(db, 'cea_source', 'method', "TEXT NOT NULL DEFAULT 'GET'");
  addColumnIfMissing(db, 'cea_source', 'body_template', 'TEXT');
  // v2.2 CEA：政策/配额文件的**行业 × 年度配对覆盖**（规范要求：不得把
  // covered_sectors × applicable_years 做笛卡尔积，例如 2026 分配方案的
  // 钢铁只适用 2026、发电适用 2025 与 2026）。保存后即可精确判定适用性。
  addColumnIfMissing(db, 'cea_document', 'coverage_json', 'TEXT');
  addColumnIfMissing(db, 'cea_document', 'coverage_source', 'TEXT');
  // v2.2 CEA：同一通知的正文行与官方 PDF 原件行必须能关联，且统计只计一次。
  addColumnIfMissing(db, 'cea_document', 'attachment_of', 'TEXT REFERENCES cea_document(id)');
  addColumnIfMissing(db, 'cea_document', 'count_in_stats', 'INTEGER NOT NULL DEFAULT 1');
  // v2.2 CEA 阶段B：研报/动态必须能标注「公开第一来源、机构、发布日期、数据截止日、观点」。
  // 这些字段只允许来自真实抓取的正文/来源页，不允许用模型推测填充。
  addColumnIfMissing(db, 'cea_document', 'first_source_url', 'TEXT');
  addColumnIfMissing(db, 'cea_document', 'data_cutoff_date', 'TEXT');
  addColumnIfMissing(db, 'cea_document', 'viewpoint', 'TEXT');           // research_opinion|market_news|institution_view|official_fact
  addColumnIfMissing(db, 'cea_document', 'discovery_json', 'TEXT');      // 发现通道（搜索/抓取连接）与查询词留痕
  // v2.2 CEA 阶段B 尾项5：数据截止日的**原文精度**与**当前页面 URL**。
  //   data_cutoff_precision：day|month|year（原文只到月/年时绝不补造成具体某一天）；
  //   data_cutoff_raw：原文片段（可追溯）；
  //   page_url：本条实际抓取的页面 URL；first_source_url 只在确认原始发布方时才有值，
  //             聚合/转载站保持 first_source_url=null，本页 URL 记在 page_url。
  addColumnIfMissing(db, 'cea_document', 'data_cutoff_precision', 'TEXT');
  addColumnIfMissing(db, 'cea_document', 'data_cutoff_raw', 'TEXT');
  addColumnIfMissing(db, 'cea_document', 'page_url', 'TEXT');
  // v2.3 CEA 日历来源修订：来源完整快照必须能同步「当前有效集合」。
  //   旧实现只增改，官方把某日从 holidays.json 删掉后，旧库中的该日会继续作为当前机器列表并永久告警。
  //   现在保留旧证据行（不删除、不改写原始 note/snapshot），只标记为 superseded；
  //   reconcile / list / 统计只使用 source_state='current' 的记录。
  addColumnIfMissing(db, 'cea_calendar', 'source_state', "TEXT NOT NULL DEFAULT 'current'");
  addColumnIfMissing(db, 'cea_calendar', 'superseded_at', 'TEXT');
  addColumnIfMissing(db, 'cea_calendar', 'superseded_by_snapshot', 'TEXT');
  addColumnIfMissing(db, 'cea_calendar', 'superseded_reason', 'TEXT');
  try {
    db.exec("CREATE INDEX IF NOT EXISTS idx_cea_cal_state ON cea_calendar(evidence_kind, source_state)");
  } catch {
    /* 表尚未就绪时忽略；下一次打开会重试 */
  }
  // v2.3 增量标记：列补齐之后记录一次，旧库同样反映当前 schema 版本（健康接口 version 独立于本标记）
  if (!getMeta(db, 'schema_version_cea_v23_applied')) {
    setMeta(db, 'schema_version_cea_v23_applied', nowIso());
    setMeta(db, 'schema_version', '2.3.0');
  }
  // v2.4 版本号归位：accounting 增量在上面已执行，但 v2.3 标记（以及旧库里的历史标记）
  // 可能把 schema_version 写回较低值。这里统一取**最高**已应用版本，避免版本号倒挂。
  if (getMeta(db, 'schema_version_accounting_applied')) {
    const cur = getMeta(db, 'schema_version');
    const parts = (v) => String(v || '0').split('.').map((n) => Number(n) || 0);
    const cmp = (a, b) => {
      const [x, y] = [parts(a), parts(b)];
      for (let i = 0; i < 3; i += 1) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
      return 0;
    };
    if (cmp(cur, '2.4.0') < 0) setMeta(db, 'schema_version', '2.4.0');
  }
  // v2.6 平台增量同样按**最高已应用版本**归位，避免版本号被前面的标记回写。
  if (getMeta(db, 'schema_version_platform_applied')) {
    const cur = getMeta(db, 'schema_version');
    const num = (v) => String(v || '0').split('.').map((n) => Number(n) || 0);
    const less = (a, b) => {
      const x = num(a); const y = num(b);
      for (let i = 0; i < 3; i += 1) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0);
      return false;
    };
    if (less(cur, '2.6.0')) setMeta(db, 'schema_version', '2.6.0');
  }
  // v2.2 CEA 阶段B：管理员补充原件需要支持 cea_document（CEA 政策 PDF / OCR 副本）。
  // SQLite 无法直接放宽已有 CHECK 约束，只能按官方迁移法重建同结构表并原样拷贝；幂等。
  migrateDocumentUploadTargetKinds(db);

  /* ---- 二轮整改（docs/22、docs/23）幂等列级变更 ---- */
  // 公开项目 demo 标记：把「演示条目：…」注释的历史行显式标记，
  // 业务统计一律排除；不删除数据、不改写原始注释。
  addColumnIfMissing(db, 'public_project', 'is_demo', 'INTEGER NOT NULL DEFAULT 0');
  // 公开内容：记录性质（正文条目 / 首页归档 / 栏目归档）与「自动摘要 ↔ 来源摘要」分离
  for (const [col, decl] of [
    ['record_kind', "TEXT NOT NULL DEFAULT 'article'"],
    ['auto_summary', 'TEXT'],
    ['auto_summary_kind', 'TEXT'],
    ['auto_summary_at', 'TEXT'],
    ['cross_source_verified', 'INTEGER NOT NULL DEFAULT 0'],
    ['citations_validated', 'INTEGER NOT NULL DEFAULT 0'],
    ['citations_rejected', 'INTEGER NOT NULL DEFAULT 0'],
  ]) {
    addColumnIfMissing(db, 'content_item', col, decl);
  }
  // 第二来源正文/字段（只有 URL 不足以宣称跨来源验证）
  for (const [col, decl] of [
    ['body_snapshot', 'TEXT'],
    ['body_chars', 'INTEGER NOT NULL DEFAULT 0'],
    ['published_at', 'TEXT'],
    ['fetch_status', 'TEXT'],
    ['fetched_at', 'TEXT'],
  ]) {
    addColumnIfMissing(db, 'content_source_link', col, decl);
  }
  // 核验缓存键组成与引文校验计数
  for (const [col, decl] of [
    ['input_hash_scheme', "TEXT NOT NULL DEFAULT 'v1'"],
    ['policy_hash', 'TEXT'],
    ['model_key', 'TEXT'],
    ['evidence_hash', 'TEXT'],
    ['citations_validated', 'INTEGER NOT NULL DEFAULT 0'],
    ['citations_rejected', 'INTEGER NOT NULL DEFAULT 0'],
  ]) {
    addColumnIfMissing(db, 'verification_result', col, decl);
  }
  // Firecrawl MCP 预设相关：keyless 试用标记、抓取授权状态、tools/list 的 inputSchema
  addColumnIfMissing(db, 'web_fetch_connection', 'keyless_trial', 'INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing(db, 'web_fetch_connection', 'scrape_authorized', 'INTEGER');
  addColumnIfMissing(db, 'web_fetch_connection', 'tool_schemas_json', 'TEXT');
  // 数据缺口：自动处理方式（取代旧的人工补录路径展示）
  addColumnIfMissing(db, 'data_gap', 'auto_action', 'TEXT');
  addColumnIfMissing(db, 'policy_document', 'body_snapshot', 'TEXT');
  addColumnIfMissing(db, 'policy_document', 'publish_date_note', 'TEXT');

  /* ---- 提醒生命周期（本轮回归修复）幂等列级变更 ----
   * notification 原本只有 read/unread，缺少「所指问题是否已结清」。
   * 结果：data_reconciliation 被自动结清后，对应的旧提醒仍在总览
   * 「自动运行状态」里以未读/待关注展示，正文还是结清前的错误数值对比。
   * 因此补三列记录结清事实（谁、何时、依据），原字段一律不改写。 */
  for (const [col, decl] of [
    ['resolved_at', 'TEXT'],
    ['resolved_by', 'TEXT'],
    ['resolution', 'TEXT'],
  ]) {
    addColumnIfMissing(db, 'notification', col, decl);
  }
  // 历史采集曾把「工作日没抓到公告」推断成法定假日；这不是休市证据。
  // 只纠正带该推断说明的旧行，保留有独立依据的休市记录。
  db.exec("UPDATE trade_calendar SET day_type='unknown', " +
    "note='公告清单未覆盖该工作日；交易或休市状态未核实，待搜索/抓取补证' " +
    "WHERE day_type='holiday' AND note LIKE '%凭官方当日无行情公告推断%'");

  // 幂等索引：必须在补列之后创建（旧库的 content_item 原本没有 record_kind）
  try {
    db.exec("UPDATE content_item SET record_kind='source_index', published_at=NULL, verification_status=NULL, " +
      "note=COALESCE(note,'') || '｜独立验收：栏目/产品页仅作来源归档，不计文章' WHERE record_kind='article' AND " +
      "(lower(source_url) LIKE '%/index.htm' OR lower(source_url) LIKE '%/index.html' OR lower(source_url) LIKE '%/index.shtml' " +
      "OR lower(source_url) LIKE '%/app' OR lower(source_url) LIKE '%/app/')");
    db.exec("UPDATE content_item SET note=COALESCE(note,'') || '｜原日期 ' || published_at || ' 仅来自URL候选，已置空留痕', published_at=NULL " +
      "WHERE published_at IS NOT NULL AND note LIKE '%URL 中的完整日期%低可信%'");
    db.exec('CREATE INDEX IF NOT EXISTS idx_ci_kind ON content_item(record_kind)');
  } catch {
    /* 表尚未就绪时忽略；下一次打开会重试 */
  }

  // 幂等回填（不删除、不改写原始证据；只补充结构化标记）：
  //   1) 历史演示项目（注释以「演示条目」开头）标记 is_demo=1，使其不再进入业务统计；
  //   2) 旧的「种子来源首页归档」条目改记为 source_homepage，并从业务列表/图表排除；
  //   3) 首页归档条目上被误填为采集日的 published_at 置空，原值写入备注留痕（只执行一次）。
  try {
    db.exec("UPDATE public_project SET is_demo=1 WHERE is_demo=0 AND note LIKE '演示条目%'");
    db.exec(
      "UPDATE content_item SET record_kind='source_homepage' " +
      "WHERE record_kind='article' AND note LIKE '种子来源首页归档%'"
    );
    db.exec(
      "UPDATE content_item SET note = COALESCE(note,'') || '｜原发布日期字段 ' || published_at || " +
      "' 实为采集日误填，已按「未披露」置空（二轮整改留痕）', published_at = NULL " +
      "WHERE record_kind='source_homepage' AND published_at IS NOT NULL"
    );
    // 4) 抓取质量不合格的正文条目（正文过短，疑似跳转/错误页）：标记为 failed_fetch，
    //    保留行与快照可审计，但不进入文章列表与统计（不改写原始正文）。
    db.exec(
      "UPDATE content_item SET process_status='failed_fetch', " +
      "note = COALESCE(note,'') || '｜抓取到的正文过短（疑似跳转/错误页），不计入文章统计（二轮整改留痕）' " +
      "WHERE record_kind='article' AND COALESCE(process_status,'')<>'failed_fetch' " +
      "AND body_chars > 0 AND body_chars < 60"
    );
  } catch {
    /* 表结构尚未就绪时忽略；下一次打开会重试 */
  }
}

/** 幂等加列。 */
function addColumnIfMissing(db, table, column, decl) {
  let cols;
  try {
    cols = db.prepare(`PRAGMA table_info(${table})`).all();
  } catch {
    return false;
  }
  if (!cols.length) return false;
  if (cols.some((c) => c.name === column)) return false;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  return true;
}

/**
 * 放宽 document_upload.target_kind 的取值集合（新增 cea_document）。
 *
 * SQLite 不支持修改已有的 CHECK 约束，因此按官方推荐的迁移法重建同结构表：
 * 建新表 → 原样 INSERT SELECT 拷贝 → 删旧表 → 改名 → 重建索引。
 * 只在旧 DDL 确实不接受 cea_document 时执行一次；拷贝前后校验行数一致，
 * 不一致即抛错回滚，绝不静默丢数据（CEA-01）。
 */
export function migrateDocumentUploadTargetKinds(db) {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='document_upload'").get();
  if (!row?.sql || row.sql.includes("'cea_document'")) return false;
  const before = db.prepare('SELECT COUNT(*) AS c FROM document_upload').get()?.c || 0;
  const DDL = `CREATE TABLE document_upload__cea (
  id TEXT PRIMARY KEY,
  target_kind TEXT NOT NULL CHECK(target_kind IN ('policy','methodology','cea_document')),
  target_id TEXT NOT NULL,
  file_name TEXT NOT NULL,
  file_hash TEXT NOT NULL,
  file_size INTEGER NOT NULL,
  local_path TEXT NOT NULL,
  text_content TEXT,
  text_source TEXT NOT NULL,
  parse_quality TEXT NOT NULL,
  source_status TEXT NOT NULL,
  source_claim_url TEXT,
  ai_result TEXT,
  ai_summary TEXT,
  uploaded_by TEXT NOT NULL,
  created_at TEXT NOT NULL
)`;
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec('BEGIN IMMEDIATE');
    db.exec(DDL);
    db.exec(`INSERT INTO document_upload__cea
      (id,target_kind,target_id,file_name,file_hash,file_size,local_path,text_content,text_source,
       parse_quality,source_status,source_claim_url,ai_result,ai_summary,uploaded_by,created_at)
      SELECT id,target_kind,target_id,file_name,file_hash,file_size,local_path,text_content,text_source,
       parse_quality,source_status,source_claim_url,ai_result,ai_summary,uploaded_by,created_at
      FROM document_upload`);
    db.exec('DROP TABLE document_upload');
    db.exec('ALTER TABLE document_upload__cea RENAME TO document_upload');
    db.exec('CREATE INDEX IF NOT EXISTS idx_document_upload_target ON document_upload(target_kind,target_id,created_at)');
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* 回滚失败时保留原始错误 */ }
    throw e;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
  const after = db.prepare('SELECT COUNT(*) AS c FROM document_upload').get()?.c || 0;
  if (after !== before) throw new Error(`document_upload 迁移行数不一致：${before} → ${after}`);
  return true;
}

/* ------------------------------ 查询助手 ------------------------------ */

export function run(sql, params = []) {
  return getDb().prepare(sql).run(...params.map(bind));
}

export function all(sql, params = []) {
  return getDb().prepare(sql).all(...params.map(bind));
}

export function get(sql, params = []) {
  const row = getDb().prepare(sql).get(...params.map(bind));
  return row === undefined ? null : row;
}

export function tx(fn) {
  const db = getDb();
  db.exec('BEGIN');
  try {
    const out = fn(db);
    db.exec('COMMIT');
    return out;
  } catch (e) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* ignore */
    }
    throw e;
  }
}

export function tableCount(table) {
  const r = get(`SELECT COUNT(*) AS c FROM ${table}`);
  return r ? r.c : 0;
}

export function isEmpty() {
  return tableCount('methodology_version') === 0;
}

/* ------------------------------ 元数据 ------------------------------ */

export function getMeta(db, key) {
  const d = db || getDb();
  const row = d.prepare('SELECT value FROM system_meta WHERE key = ?').get(key);
  return row ? row.value : null;
}

/** 便捷读取：直接读当前连接的系统元数据 */
export function metaValue(key, fallback = null) {
  const v = getMeta(null, key);
  return v === null || v === undefined ? fallback : v;
}

export function setMeta(db, key, value) {
  db.prepare(
    `INSERT INTO system_meta (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(key, String(value), nowIso());
}

/* ------------------------------ 审计日志 ------------------------------ */

/**
 * 写审计日志。所有会改变判断结果或导出数据的动作都必须调用。
 * @param {{actor?:string, actorRole?:string, action:string, objectType?:string,
 *          objectId?:string, detail?:any, ip?:string, result?:string}} e
 */
export function audit(e) {
  run(
    `INSERT INTO audit_log (id, at, actor, actor_role, action, object_type, object_id, detail, ip, result)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [
      newId('AUD'),
      nowIso(),
      e.actor || 'system',
      e.actorRole || null,
      e.action,
      e.objectType || null,
      e.objectId || null,
      e.detail === undefined ? null : typeof e.detail === 'string' ? e.detail : j(e.detail),
      e.ip || null,
      e.result || 'ok',
    ]
  );
}

export function recentAudit(limit = 100, filters = {}) {
  const where = [];
  const params = [];
  if (filters.objectType) {
    where.push('object_type = ?');
    params.push(filters.objectType);
  }
  if (filters.objectId) {
    where.push('object_id = ?');
    params.push(filters.objectId);
  }
  const sql = `SELECT * FROM audit_log ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
               ORDER BY at DESC LIMIT ?`;
  return all(sql, [...params, limit]);
}

export { existsSync };
