# DSH 二轮整改实施记录（CCER 公开信息平台 v2.2）

整改依据：`docs/22-Codex验收整改任务.md`（17 项）与 `docs/23-博查与Firecrawl接入要求.md`（用户最新指定）。
执行：本机 DeepSeek Harness（DSH）。首轮记录见 `docs/20-DSH升级实施记录.md`；两者冲突处以本文为准。

记录约定（与 docs/20 相同，逐项核对用）：

- 只记录**实际执行过的命令与真实结果**；未执行或失败的内容明确标注；
- **不记录、不输出任何凭据值 / 环境变量秘密值**；只写「是否已配置」；
- 「真实联网」「真实模型调用」「模拟/打桩」「浏览器」四类证据分开标注；
- 修复均**在原代码基础上**进行：**未删除任何数据库文件、未清空历史表、未删除有效测试**；
  历史记录中遗留的人工流程措辞只在**展示层**改写（数据库原文不动）。

---

## 0. 本轮验收环境与事实基线

| 项目 | 事实 |
| --- | --- |
| 工作目录 | `D:\AI workspace\ccer-screening` |
| Node | v24.14.1（`node:sqlite`，零 npm 依赖） |
| 数据库 | `data/ccer_v2.db`（现有公开库，**本轮读写**）；`data/ccer.db`（v1 在用库，**未读写**） |
| 起始数据基线（只读探测） | public_project 294（含 3 条演示 = 业务 291）；content_item 5 条全部是「来源首页归档」且 `published_at`=采集日；review_task 650；data_gap 6 条（5 条 open）；trade_daily 150（pending 6）；search_provider 0；web_fetch_connection 1（direct_http）；llm_provider 2（deepseek 无凭据）；`data/keys/master.key` 不存在 |
| 凭据状态（只检查存在性，未读取值） | `DEEPSEEK_API_KEY` / `BOCHA_API_KEY` / `FIRECRAWL_API_KEY` **均未配置** |
| 真实联网 | Node fetch 可联网；`ceep.bit.edu.cn` 首次 ECONNRESET、第 3 次成功（已记录） |
| 浏览器 | 本沙箱仍无法启动 Chromium（Mojo 命名管道被拒，docs/20 §7.4 已定位）；本轮**未尝试绕过**，浏览器与手机视图验收由 Codex 负责 |

> 说明：`data/ccer_v2.db` 在整改期间同时被 root 启动的验收服务（8902）使用；该服务重启后
> 以新代码执行了每日任务（真实联网采集 + 统一核验），因此下文统计数字随时间推进而增长，
> 均为**真实运行结果**，不是脚本造数。

---

## 1. docs/22 十七项逐项处理结果

### 1) 核验缓存：不缓存 unavailable，缓存键含策略/模型/证据 —— 已修复

- `verification-svc.mjs`：新增 `INPUT_HASH_SCHEME='v2'`、`policyHashOf()`、`evidenceHashOf()`、`modelKeyOf()`；
  输入哈希包含 `{策略哈希, 模型键, 证据版本}`；`cachedVerification()` 增加
  `result != 'unavailable'` 与 scheme/policy/model 三重匹配；
  `verification_result` 新增列 `input_hash_scheme / policy_hash / model_key / evidence_hash`。
- `verifyContentBatch()` 默认对全部正文条目跑一遍（缓存命中直接返回，不重复调用模型），
  因此 `unavailable` 与「策略/证据变化过」的条目都会自动重算。
- 证据哈希**不含模型生成的 auto_summary**（否则会自我失效），来源摘要与正文才计入。
- 回归测试：test/16「模型从『未配置』变为『已配置』后必须能重试（不缓存 unavailable）」
  「策略变化后 insufficient 会重算」；test/18 仍保留同输入缓存幂等断言。

### 2) 首页冒充文章 + published_at=today —— 已修复

- `collectFromSeedSources()` 重写：首页/栏目页只写 `record_kind=source_homepage|source_index`、
  `published_at=NULL`，注明「不作为一篇文章/研报，不计入文章数量与图表」；
  再用确定性规则 `discoverArticleLinks()` 发现候选正文 URL，逐篇抓取内容页。
- `extractPublishedDate()` 只接受来源页面声明：meta（`article:published_time` 等）/ JSON-LD
  `datePublished` → 正文可见「发布时间/发布日期」→ URL 中的**完整日期**（标注为低可信）；
  取不到返回 `null`。**绝不使用采集时间、也不从年份臆造日期**。
- 现有库幂等迁移：旧 5 条首页记录 `record_kind='source_homepage'`，
  误填的 `published_at` 置空并把原值写入备注留痕（不删除行、不删除快照）。
- 抓取到的正文 < 60 字符（跳转/错误页）不算成功采集，标记 `process_status='failed_fetch'`
  并退出文章列表与统计（行与快照保留可审计）。
- 回归测试：test/21「来源首页只作归档：不生成『今天发布的研报』」「正文页链接发现与发布日期抽取」
  「可获得性以采集器返回为准」。

### 3) ccer.com.cn 来源定性 + 研究机构来源 —— 已修复

- `SEED_SOURCES`：`ccer.com.cn` 更正为**全国温室气体自愿减排交易系统**、类别 `exchange`
  （不再叫「中国碳排放交易网」、不再是 media）；`classifySource()` 同步把 `ccer.com.cn` 归入交易所。
- 新增北京理工大学能源与环境政策研究中心（`ceep.bit.edu.cn`，原始发布页）与
  「上海环境能源交易所：碳市场报告栏目」（栏目页，逐篇读取）为启用种子；
  无法验证的券商首页（华创、中金）保留但停用并在名称中标注原因。

### 4) 第二来源需正文/字段 + 统一核验接入每日任务 —— 已修复

- `content_source_link` 新增 `body_snapshot/body_chars/published_at/fetch_status/fetched_at`；
  发现转载（内容哈希一致）时把**第二来源正文一并留存**；只有 URL 的来源标记 `url_only`。
- 核验能力说明区分：`cross_source_verified=1` 仅当第二来源取得正文；
  否则明确写「第二来源仅登记 URL、未取得正文，**跨来源验证未完成**」，不据此宣称交叉验证。
- 通用核验：新增 `verifyObject()`（政策 / 方法学 / 公开项目）与 `verifyAllBatch()`，
  与 content 共用同一四态、同一外呼出口、同一缓存键；新增 11 条 scope 规则
  （policy/methodology/project）；每日任务新增 `verify` 数据集；后台「立即核验」改为全量统一核验。
- 实测（现有库，`npm run v2:db-verify -- --run-verify`）：
  内容 10 条（insufficient 8 / 命中缓存 2）｜policy 9 条（insufficient 1 / unavailable 8）｜
  methodology 10 条（insufficient 2 / unavailable 8）｜project 10 条（unavailable 10，
  未配置模型凭据，如实记录，不伪造通过）。

### 5) Windows 密钥 ACL 与隔离 —— 已修复

- 密钥文件路径改为**跟随当前数据库目录**（`<数据库目录>/keys/master.key`，可用 `CCER_KEY_DIR` 覆盖），
  自动化测试使用临时库 → 不再污染真实密钥；`keyStatus()` 新增 `isolated_key_dir`。
- Windows：生成文件后用 PowerShell 执行 `Set-Acl`（关闭继承、只授予当前用户），
  **回读 ACL 校验**（`AreAccessRulesProtected=True` 且无 Everyone/Users 等宽泛主体）；
  POSIX：chmod 0600 并校验权限位。
- **无法设置或校验 ACL 时拒绝初始化**，并删除刚生成的文件（不留弱权限私钥），
  返回可操作替代方案（改用 `CCER_SECRET_KEY`）。
- 事实说明：本沙箱禁止子进程打开命名管道，PowerShell/icacls 的 ACL 命令在当前环境**无法完成校验**，
  因此本机 `initMasterKeyFile()` 会**按设计拒绝**并提示改用环境变量（未读取/未输出任何密钥值）。
  真实 Windows 桌面环境下该路径为 icacls/Set-Acl 标准流程；测试覆盖了「无主密钥加密返回 null」
  「加密往返」「keyStatus 不回传密钥值」。

### 6) 旧入口停用状态 + 不再生成人工任务 —— 已修复

- 交易/政策/因子/项目核对链路中的 `createReviewTask()` 调用**全部移除**（collect-svc 4 处、
  reconcile-svc 1 处）；`autoCheckCleanTradeRows()` 不再改写 `review_task`，只写
  `trade_daily.verify_status='verified'`（备注「系统自动核对…非人工确认」）。
- `ensureBuiltinRules` 之外，旧 `createReviewTask()` 函数体保留（历史工具，无调用点）
  —— test/21 断言 collect-svc 中该标识符只出现 1 次（即定义本身）。
- v2 侧旧入口 `/api/v2/measure/readiness`、`/api/v2/measure/targets`（依赖内部档案与领域签字）
  改为明确 **410**，不再保留会 403/500 的半成品入口。
- 回归测试：test/12「严重差异写入未结清差异与自动通知，但**不生成任何人工任务**」；
  test/21「内容采集 + 全量核验前后 review_task 行数不变」。

### 7) 虚假引文 —— 已修复

- 新增 `validateCitations()`：模型 `quote` 必须能在**实际提供给模型的证据**（正文/摘要/第二来源正文）
  中定位（归一化子串，或 ≥24 字时 8 字分片覆盖率 ≥0.6）；
  可定位的保留并记 `validated/match`，不可定位的过滤并计数。
- 判定收紧：`consistent=true` 但**没有任何可定位引文**时一律降级为 `insufficient`
  （区分「未提供引文」与「引文疑似编造」两种说明）；`verification_result` 记录
  `citations_validated / citations_rejected`，内容条目冗余列同步回写；界面显示
  「引用证据（已在证据中定位）」与已过滤条数。
- 回归测试：test/16 伪引文降级、无引文不判通过、可定位引文才判 verified；
  `npm run v2:verify-model-path` 新增 ①b 伪引文用例（真实 HTTP 桩服务）。

### 8) 全文判定与摘要来源 —— 已修复

- `availabilityFromFetch()`：**采集器返回的可获得性优先于长度猜测**；
  Firecrawl/MCP 返回整页内容 → `full_text`；直连 HTTP 用 `<1200 字符 → partial`；
  无正文 → `metadata_only`。
- 摘要拆分：`summary` = 来源公开摘要（meta description，原样保留）；
  `auto_summary` + `auto_summary_kind`（model|extractive）+ `auto_summary_at` = 自动摘要，
  模型摘要写回库并在界面「自动生成摘要」区单独展示，**不覆盖来源摘要**。

### 9) DeepSeek thinking —— 已修复

- `buildModelRequestBody()` / `isDeepSeekEndpoint()`（核验）与 `isDeepSeekBase()`（连接测试）：
  仅对 `*.deepseek.com` 显式设置 `thinking:{type:'disabled'}`，
  连接测试 `max_tokens` 由 8 调整为 16（仍为短请求），**不向其它供应商强塞该参数**。
- 依据：https://api-docs.deepseek.com/guides/thinking_mode/ （docs/22 第 9 条，2026-09-29 核实）。
- 回归测试：test/16「DeepSeek 端点关闭 thinking；其它供应商不加该参数」。

### 10) 列表发布日期回退 + 根路径 —— 已修复

- `web/v2/modules/content.js`：取消 `published_at || collected_at.slice(0,10)` 回退；
  列表新增「采集时间」列，发布日未披露显示**「未披露」**（含 title 说明）。
- 总览「最新研报与动态」同样区分「发布 X」与「发布日期未披露」。
- 根路径：v2 启用时 `/` 与 `/index.html` → **302 `/v2`**；旧 `web/app.js`、`web/styles.css` 返回 410。

### 11) **一万倍气量单位错误** —— 已修复（关键数值）

- 根因：元数据把主输入写成「万 m³/年」，前端直接把该数值交给按 m³ 计算的
  `quickGasEstimate`，结果缩小 10000 倍。
- 修复：主输入单位改回 **m³/年**；新增独立键 `annual_gas_10k_m3`（万 m³/年，服务端严格 ×10000）；
  两个键**只能提交一个**，同时提交返回 400；界面提供单位下拉（m³/年 ↔ 万 m³/年），
  提交时写入对应口径的键；结果同时给出 m³ 与万 m³ 等效值及 `unit_note`；
  元数据新增 `unit_contract` 明确单位口径。
- 实测：`{annual_gas_10k_m3: 10000, ch4_pct: 1.2}` → **18270.9 tCO₂e/年**
  （与 `{annual_gas_m3: 100000000, ch4_pct: 1.2}` 完全一致），不再是 1.82709。
- 回归测试：test/21 三项（单位契约 / 一万倍回归 / 单位冲突拒绝）。

### 12) 人工任务措辞与首轮初始化 —— 已修复

- `trades.js`：删除「批量核对本页待核对」按钮与「待核对任务 +N」提示，改为
  「执行自动核对」（调用 `/api/v2/trade/checks/run`）；指标改为「行情自动核对」，
  明细列「自动核对」，并注明平台不设人工核对按钮；`ui.js` 状态文案改为
  「待自动核对 / 系统自动核对通过 / 与官方不符（已自动标注）」。
- `scripts/v2-start.mjs`：日志改「七模块公开信息平台」；首次初始化
  `withDemo:false` + `withPublicDemo:false`，**移除内部项目同步**；
  `package.json` 描述改为公开信息平台，`start` 指向 v2 隔离启动器（`start:v1` 保留旧版）。
- 测试保留并加强：权限/CSRF、原始状态区分、数值复算、库隔离断言未删；
  旧功能改为 410 验收（test/14、test/19、test/21）。

### 13) 全量重跑 —— 已完成

`npm run v2:test` **12/12 文件通过**（含新增 test/21）；`npm test`（v1）exit 0；
`npm run v2:acceptance` **93/93**；`npm run v2:db-verify` **34/34**（`--run-verify` 时 36/36）。

### 14) 幂等与四态的**真断言** —— 已加强

- test/16 用 `await testAsync`，断言**真实模型 HTTP 调用次数**（桩服务收到的请求数）、
  `citations_validated/rejected` 落库值、缓存命中/未命中、`unavailable` 可重试；
- test/12/test/21 用**采集与核对前后 `review_task` 行数比较**证明不产生人工任务（不只扫源码）；
- test/18 断言真实发出的请求体、鉴权头、重试与限额、MCP 白名单与 schema 写回；
- 四态测试使用真实 mock 模型返回（本机 HTTP 桩服务），含伪引文降级、
  模型配置变化与策略变化导致的缓存失效。

### 15) 首页归档记录口径 + `--no-write` —— 已修复

- 旧首页记录已改记为来源列表/归档（`record_kind`）、退出文章业务列表与图表统计；
  **保留原快照与行**，发布日不再等于采集日。
- `scripts/v2-real-collect.mjs --no-write`：只读探测——不创建连接、不写快照、
  不写任何 `dataset_cursor`、不执行核验；仅打印当前库真实统计与配置状态。
- 真实联网：`npm run v2:ingest-docs21` 用 docs/21 的两篇真实文章做可验证验收（见 §3）。

### 16) 现有库总览与后台去人工/demo 污染 —— 已修复并**用现有库实测**

- `public_project` 新增 `is_demo`，幂等回填「演示条目」注释的历史行（**只标记，不删除**）；
  总览 KPI/项目进度/地域/方法学项目数/筛选项/公开项目列表与导出**全部排除演示条目**；
  减排量批次统计通过 join 排除演示项目批次。
- 实测：294 → **业务 291**，总览「公示项目数」子文案写明「已排除演示条目 3 条」。
- 文案与动态指标：删除「待人工复核 N 个」「待确认变更」「须人工核对后到后台处理」
  「人工路径」等措辞；数据缺口改为「自动处理方式 + 历史留痕（旧流程文案仅存档）」；
  旧库 `data_reconciliation.detail`、`alert.detail`、`data_gap.title` 中遗留的人工流程措辞
  在**展示层**统一改写（`sanitizeLegacyWording`，数据库原文不动）。
- 现有库实测（`npm run v2:db-verify`）：总览接口 JSON 不含
  「待人工复核 / 人工核对 / 人工补录 / 须人工 / 签字 / 审批 / 人工路径 / 待领域」；
  缺口接口 `manual_path=null` 且保留 `legacy_manual_path` 作历史留痕。

### 17) 粗估页真实浏览器问题 —— 已修复

- 单位问题见第 11 项（输入 10000 万 m³/年、1.2% → 18270.9 tCO₂e/年）。
- 删除「为什么新版不再提供『从项目档案测算』」整张解释卡；产品文案不再出现
  内部项目、专家签字、`deterministic_plugin` 等实现细节；
  仅保留简短估算口径与「正式申报量按方法学与监测数据计算」的差别说明。
- 回归测试：test/20 断言旧解释卡与实现细节**必须不存在**，并保留口径说明。

### 18) 主启动命令与旧 API 停用 —— 已修复

- `npm start` = `node scripts/v2-start.mjs`（默认 `data/ccer_v2.db`，不触碰 `data/ccer.db`）；
  旧版启动保留为 `npm run start:v1`。
- v2 启用时旧私有/审批 API 统一 **410**：`/api/projects*`、`/api/reviews*`、`/api/calculations*`、
  `/api/reports*`、`/api/dashboard`、`/api/subscriptions*`、`/api/admin/plugins`、
  `/api/admin/demo-channel`（实测 410 + `retired:true`）。
- README 只给用户主平台路径与必要配置，历史版本说明移到维护附录。

---

## 2. docs/23：博查搜索 + Firecrawl v2 MCP

### 2.1 博查（独立适配，默认推荐）

- 新增 `provider_kind=bocha`：`POST https://api.bocha.cn/v1/web-search`，白名单 `api.bocha.cn`，
  凭据引用 `BOCHA_API_KEY`；后台选择项显示「博查 Web Search（用户指定默认）」。
- 请求映射：`query / summary / count(1—50) / freshness`；`freshness` 由日期窗口推导
  （1 天 oneDay、7 天 oneWeek、30 天 oneMonth、1 年 oneYear、更长 noLimit）。
- 响应映射：`data.webPages.value` → `name→title、url、summary(缺失回退 snippet)、
  siteName→publisher、datePublished→published_at`；**`dateLastCrawled` 不作为发布日期**
  （测试显式断言）；摘要**不是全文**（`raw_content=null`），正文由抓取连接获取。
- 失败语义：HTTP 200 但 `code≠200` 也判失败，401→auth_error、403→insufficient_balance、
  429→rate_limited、5xx→provider_error，错误信息保留可公开 `log_id`；
  401/403 不重试；空结果 `ok=true` 且 `empty=true`（与失败区分，界面显示「空结果」）。
- 旧地址 `api.bochaai.com` 允许手工改写（预设备注说明），系统不静默替换、不跨域发送密钥。
- 回归测试：test/21 三项（预设与请求映射 / 响应映射与 dateLastCrawled / 业务码与 log_id）；
  test/18 原有归一化用例继续覆盖通用路径。
- **真实调用状态**：本机无 `BOCHA_API_KEY`，后台测试会如实返回「未配置凭据」；
  **未进行**真实博查调用（不伪造「已通」）。

### 2.2 Firecrawl v2 MCP（抓取默认推荐）

- 新增预设 `conn_kind=mcp_http`（别名 `firecrawl_mcp`）：`https://mcp.firecrawl.dev/v2/mcp`，
  只读工具 `firecrawl_scrape`（白名单同），凭据引用 `FIRECRAWL_API_KEY`，
  标注**官方固定地址的 keyless 限额试用**。
- 参数映射：抓取时读取并缓存 `tools/list` 返回的 `inputSchema`，按 schema 类型映射
  `url` 与 `formats`（array/string 对齐）；schema 缺失时退回参数映射。
- 返回解析：`tools/call` 的 `content[].text` 若为 JSON（Firecrawl scrape 结果）则解析
  `markdown` / `metadata.title` / `links`，否则按纯文本；不再用字符数猜全文。
- 测试语义分离：`initialize + tools/list` 成功 → `connection_ok`、`tools_ok`；
  仅有凭据（或显式 `probe_scrape`）时才发起一次真实抓取 → `scrape_call_performed`、
  `scrape_authorized`；被官方拒绝时 `last_test_result='tools_ok_scrape_failed'`，
  界面显示「连接/工具可用 · 抓取未授权」，**不反复无密钥重试、不伪造成功**。
- keyless 限制：`keylessAllowed()` 只认 `https://mcp.firecrawl.dev` 且白名单恰为该域；
  其它远端 MCP 未配置凭据一律拒绝；相似域名（`mcp.firecrawl.dev.evil.com`）、http、放宽白名单均拒绝。
- **Codex 已实测**（docs/23 §Codex 本机实测结果）：官方 v2 MCP 无密钥 `initialize` 与
  `tools/list` 成功（协议 2025-06-18，发现 firecrawl_scrape/search/parse），随后抓取返回
  `isError=true：Anonymous keyless access is unavailable`。本轮**未重复该无密钥抓取**；
  应用内测试路径的行为已按上述分离语义实现，并由 test/18 用本机桩 MCP 覆盖。

### 2.3 配置便捷性

- 后台「采集连接」新增 **「填入博查默认配置」** 与 **「填入 Firecrawl MCP 默认配置」** 按钮，
  只填公开参数（地址/路径/工具/白名单/凭据引用名）与预设说明，**不读取任何 DSH 凭据库、不填任何密钥**；
  切换连接类型时也会按预设刷新表单。
- 未配置凭据时如实显示「未配置 / 不可调用」，公开原始信息仍可浏览；
  模型不可用不阻断公开信息展示。

---

## 3. 真实联网数据与日期来源验证

命令：`npm run v2:ingest-docs21`（真实公网抓取 → 落库 → 自动核验）

| 条目（docs/21） | 抓取结果 | 发布日期 | 日期依据 | 核验结果 |
| --- | --- | --- | --- | --- |
| 北京理工大学能源与环境政策研究中心《全球和中国碳市场回顾与展望（2026）》 | 成功（293 字符，直连 HTTP；首次/二次 ECONNRESET，第三次成功） | **2026-01-12** | 页面 `meta` 标签（`2026-01-12 17:31:00`） | 证据不足（正文短于核验下限 400，未取得 PDF 全文） |
| 全国温室气体自愿减排交易系统「为地球降温—全民参与碳抵销行动」正式上线 | 成功（752 字符） | **2026-09-20** | 页面正文声明「时间：2026-09-20」 | 证据不足（partial 正文 + 缺第二来源） |

- 与 docs/21 记载日期**逐条一致**（脚本内断言 `日期一致性：2 项通过，0 项异常`）；发布日与
  「活动发生于 9 月 14 日」在备注中区分。
- 两篇均如实为 insufficient，**未伪造「核验通过」**（模型凭据未配置，规则先判证据不足）。
- BIT 页面声明转载需事先同意：只归档元数据与简短摘要（293 字符为页面可见文本），不重新分发 PDF。

### 3.1 现有 v2 库的真实运行结果（截至 2026-09-29 03:10 CST，root 启动的验收服务同步采集）

| 指标 | 数值 |
| --- | --- |
| 公开项目 | 294 总计 / 3 演示 / **业务 291** |
| 内容条目 | 22 文章（含 3 条验证脚本痕迹已标记 is_demo）+ 7 首页归档 + 1 栏目归档 |
| 文章抓取质量 | 19 条正常；3 条正文过短已标 `failed_fetch`（保留可审计，不计入文章统计） |
| 发布日期 | 19 条有来源声明日期；3 条未披露（界面显示「未披露」） |
| 自动核验记录 | content 30（conflict 1 / insufficient 28 / unavailable 1）、policy 9、methodology 10、project 10 |
| 数据集游标 | `content_seed`、`verify_content`、`verify_policy`、`verify_methodology`、`verify_project` 均 ok（有最近成功时间） |
| 人工任务 | `review_task` 仍为 650（**全部为历史行，本轮新增 0**） |
| 模型 | deepseek 已配置但**无凭据** → 核验如实 unavailable；桩配置已停用 |

真实公开文章示例（现有库）：生态环境部 9 月例行新闻发布会全文实录（2026-09-23）、
最新情况通报（2026-09-22）、上海环交所碳市场报告栏目文章（2025-11-18 等）、
中国碳交易网转载（2025-09-24，正文日期取自页面）。

---

## 4. 本轮改动文件

**新增**

- `test/21-v2-second-round.test.mjs`（17 项二轮回归：单位/首页归档/博查/MCP/去 demo 去人工/无人工任务/启动入口）
- `scripts/v2-db-verify.mjs`（现有 v2 库接口验收，46 项，`--run-verify` 可跑统一核验）
- `scripts/v2-ingest-docs21.mjs`（docs/21 真实文章入库与日期来源验证）
- `scripts/v2-cleanup-verify-artifacts.mjs`（幂等清理链路验证脚本遗留的桩配置/验证条目，不删除行）
- `docs/24-DSH二轮整改实施记录.md`（本文件）

**修改（主要）**

- `src/core/db.mjs`：二轮幂等迁移（content `record_kind/auto_summary/cross_source_verified/citations_*`、
  `content_source_link` 正文列、`verification_result` 缓存键列、`public_project.is_demo`、
  `data_gap.auto_action`、`web_fetch_connection` keyless/schema 列）+ 幂等回填（demo 标记、
  首页归档改记、采集日误填置空、正文过短标记）
- `src/core/secrets.mjs`：密钥目录跟随数据库、Windows ACL 真实设置+回读校验、校验失败拒绝初始化
- `src/core/util.mjs`：`sanitizeLegacyWording/sanitizeDeep`（历史人工措辞的展示层净化）
- `src/data/policy-catalog.mjs`、`src/services/seed-v2.mjs`：缺口改为自动处理口径、演示项目显式 `is_demo=1`
- `src/services/quick-estimate-svc.mjs`：单位口径（m³/年 + 万 m³/年严格换算、互斥校验、unit_contract）
- `src/services/search-svc.mjs`：博查适配、publisher/snippet 回退、业务码、freshness、空结果、log_id
- `src/services/web-fetch-svc.mjs`：Firecrawl v2 MCP 预设、schema 参数映射、结果解析、
  keyless 限制、测试语义分离、采集器可获得性
- `src/services/content-svc.mjs`：正文页发现、日期抽取、归档口径、可获得性、摘要拆分、
  第二来源正文、抓取质量门槛、来源更正
- `src/services/verification-svc.mjs`：缓存键 v2、引文校验、统一对象核验、DeepSeek thinking、
  摘要写回、跨来源标志
- `src/services/collect-svc.mjs` / `reconcile-svc.mjs`：移除人工任务生成、`verify` 数据集、
  新游标、自动核对不再改写人工任务
- `src/services/dashboard-svc.mjs` / `admin-v2-svc.mjs` / `project-v2-svc.mjs`：demo 排除、
  去人工措辞、缺口自动口径、公开项目导出字段
- `src/routes-v2.mjs`：MCP 测试传参、统一核验、停用旧 measure/readiness+targets、规则全 scope
- `src/server.mjs`：根路径 302 `/v2`、旧静态 410、v1 私有/审批 API 410、启动横幅
- `web/v2/modules/{measure,content,trades,overview,admin}.js`、`web/v2/ui.js`：单位、未披露日期、
  自动摘要、引文校验展示、自动核对、预设填入、缺口自动口径、主密钥 ACL 状态
- `scripts/v2-start.mjs`、`scripts/v2-real-collect.mjs`、`scripts/v2-verify-model-path.mjs`（默认临时库）、
  `scripts/v2-daily.mjs`、`scripts/v2-acceptance.mjs`（版本断言改为 2.x，避免升级即误报）、
  `package.json`（2.2.0）、`README.md`、`web/v2/index.html` 与 `web/v2/app.js`（版本标识 v2.2）、`docs/20`（指向本文）
- 测试调整（保留有效断言）：`test/12`（严重差异不再建人工任务）、`test/13`（演示条目默认排除、
  显式 include_demo 可查看）、`test/16`（引文校验/缓存失效/DeepSeek）、`test/18`（MCP 测试语义、
  keyless 限制、schema 写回；修正测试夹具未更新 credential 的缺陷）、`test/20`（旧解释卡必须删除 +
  单位选择器）

**未改动**：`data/ccer.db`（v1 在用库，全程未读写）；`src/methodologies/*`、`src/rules/*`；
未删除任何历史表、历史行或既有测试文件。

---

## 5. 实际执行的验证与结果

| 命令 | 真实结果 |
| --- | --- |
| `npm test`（v1） | exit 0（5 个测试文件全部通过；auth 文件 165 项断言） |
| `npm run v2:test` | **12/12 文件通过**（10→8、11→14、12→13、13→30、14→16、15→assert 脚本、16→23、17→19、18→48、19→17、20→14、21→17） |
| `npm run v2:acceptance` | **93 项通过，0 失败**（随机端口 + 同进程，含前端静态资源断言） |
| `npm run v2:db-verify` | **46 项通过，0 失败**（现有 `data/ccer_v2.db`：302/410/demo 排除/去人工措辞/前端资源无旧入口/真实 HTTP 粗估 18270.9） |
| `npm run v2:db-verify -- --run-verify` | **48 项通过**（并写入内容/政策/方法学/项目四类核验记录） |
| `npm run v2:ingest-docs21` | 2/2 篇日期与 docs/21 一致；均如实 insufficient |
| `npm run v2:verify-model-path` | 10/10 检查通过（真实 HTTP 桩服务：verified / 伪引文降级 / conflict / unavailable / 不缓存 unavailable / 0 人工任务） |
| `npm run v2:cleanup-verify-artifacts` | 停用桩配置 1 条、策略 provider_id 复位、标记验证条目 3 条（行与快照保留） |

---

## 6. 真实剩余限制（如实记录，未伪造）

1. **无三方凭据**：`BOCHA_API_KEY`、`FIRECRAWL_API_KEY`、`DEEPSEEK_API_KEY` 均未配置。
   - 博查：适配与映射已用真实响应结构做隔离测试，**未进行真实调用**；
   - Firecrawl：官方 keyless 已被官方拒绝（Codex 实测），本轮未重复尝试；生产需 API Key；
   - 模型：真实厂商调用未执行；调用链路用本机真实 HTTP 桩服务验证并通过。
2. **本机 Windows ACL 校验未能在沙箱内完成**：沙箱禁止子进程管道，PowerShell ACL 命令无法回读校验，
   因此 `initMasterKeyFile()` 按设计**拒绝初始化**并提示改用 `CCER_SECRET_KEY`（未留下弱权限文件）。
   在正常 Windows 桌面/服务器环境按 icacls/Set-Acl 流程可完成；此路径未在本机取得「成功」证据。
3. **浏览器验收**：本沙箱仍无法启动 Chromium（Mojo 命名管道被拒），
   浏览器整页/手机视图验收由 Codex 执行；本轮提供的是真实 HTTP 下发静态资源 + 接口层断言。
4. **部分来源不可达**：`ceep.bit.edu.cn` 前两次 ECONNRESET（第三次成功）；
   `tanpaifang.com` / `chinacoal.gov.cn` / `cresa.org.cn` 仍可能失败，失败一律如实记录。
5. **PDF 与动态页**：PDF 附件不解析（如实标注）；直连 HTTP 不执行 JS，动态渲染页取不到正文时
   返回 `empty_content`，不伪造正文。
6. **模型核验深度**：政策/方法学/公开项目目前多为 `insufficient`（缺全文/仅元数据）或
   `unavailable`（无凭据）——这是四态口径下的**真实结论**，不是脚本错误；
   归档官方原文并配置模型后会转为可核验。
7. **现有库中 3 条验证脚本痕迹**已标记为演示数据（保留可审计），未删除；
   其中 1 条曾以 `linkcheck.example.com` 为来源，属验证数据而非公开信息。
8. **运行中的 8902 验收服务**由 root 管理，本轮未干预其进程；它与本轮验收共用
   `data/ccer_v2.db`，因此库内计数会随时间增长。

---

## 7. 启动方式（交付口径）

```powershell
npm start                                  # 新版公开信息平台 → http://127.0.0.1:8787/v2
npm start -- --port=8899                   # 指定端口
npm run v2:db-verify                       # 现有库接口口径验收（只读）
npm run v2:ingest-docs21                   # docs/21 真实文章入库与日期验证（真实联网）
npm run v2:daily                           # 每日更新（官方数据 + 动态 + 统一核验）
```

凭据配置（只存服务端，页面/日志/导出不出现明文）：

- 搜索：`BOCHA_API_KEY`（后台「采集连接 → 填入博查默认配置」后只需配置该环境变量或加密保存）
- 抓取：`FIRECRAWL_API_KEY`（后台「填入 Firecrawl MCP 默认配置」）
- 模型：`DEEPSEEK_API_KEY` 或后台加密保存；DeepSeek 端点自动关闭 thinking
- 主密钥：优先 `CCER_SECRET_KEY`；本机密钥文件位于当前数据库目录下的 `keys/`，
  Windows 需 ACL 校验通过才会保留
