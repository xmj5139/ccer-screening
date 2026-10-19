# CEA 开发实施记录

需求：docs/31-CEA扩展开发规范.md（含 2026-10-14 新增的「官方公开 JSON」段与 CEA-16）。架构决策：docs/decisions/ADR-002。
开发：DSH（DeepSeek Harness）；独立验收：Codex。本轮范围：**阶段A（后端）**。

2026-10-14：Codex已完成需求与ADR。云端服务基线active，Node24.14.1，磁盘剩余约34GB。本地未检测到8910/8911/8902/3080监听。DSH headless入口已确认。

## 阶段A：DSH后端实现

状态：**已完成**（2026-10-14，DSH），含 Codex 首轮复核提出的全部阶段A后续项。以下为实际修改、实际执行的命令与真实结果；未执行的检查不写为通过。

### A0. 本轮实际遵守的约束

|约束|实际执行情况|
|---|---|
|只写本地代码与 CEA 开发库|全部写入 `data/cea-dev-20261014.db`。|
|不读写旧 `data/ccer.db`|会话结束复核文件时间戳：`data/ccer.db` 仍为 **2026-09-30 9:37:10**，`data/ccer_v2.db` 仍为 **2026-09-30 15:08:37**（本轮会话为 2026-10-14 15:2x—16:1x）。两库均未被打开或写入。|
|不改账号/密钥|未调用任何改密、重置、`--reset` seed、密钥初始化入口。只读取行数用于断言。|
|不打印凭据、不读大批环境变量|只读取 `CCER_DB_PATH`/`CCER_ENABLE_V2`/`TZ`；所有输出经检查不含密钥或密钥路径。|
|不 SSH、不部署云端|未执行任何远程命令。|
|无大型新依赖|`package.json` `dependencies` 仍为 `{}`；仅用 node:sqlite / node:crypto / node:child_process / 内置 fetch。PDF 文本提取复用**系统已安装**的 `pdftotext`（poppler），不引入 npm 依赖。|
|不修改前端|`web/` 目录本轮**零改动**（阶段B 处理）。|
|GraphFlow|本会话未暴露 `mcp__graphflow__*` 工具，`npx @roarpeng/graphflow` 因沙箱拒绝写 npm 缓存（EPERM）不可用；按用户许可改用锚点文件。|

### A1. 新增与修改文件

**新增（源码）**

|文件|作用|
|---|---|
|`src/db/schema-cea.sql`|CEA 增量结构：`cea_source`、`cea_trade_daily`、`cea_trade_revision`、`cea_check`、`cea_document`、`cea_event`、`cea_entity`、`cea_entity_revision`、`cea_intention`、`cea_daily_overview`（概览分层）、`cea_calendar`（CEA 独立日历）、`cea_quote_source`（来源层级），以及同日对比视图 `cea_ccer_same_day`。全部 `IF NOT EXISTS`，纯增量。|
|`src/data/cea-sources.mjs`|13 个 HTML/PDF 官方来源 + 6 个官方公开 JSON 通道 + 6 条已确认政策元数据（含**行业×年度配对覆盖**）+ 3 条履约日历事件 + 情景口径与有界默认值。**不含任何行情数值、名录行或意向行。**|
|`src/services/cea-parse.mjs`|官方日报解析（模板句式优先 + 通用标签回退）、精确十进制单位换算、日期优先级、CEA/CCER 页面归属判定、确定性核对、名录页面判定与结构化提取。纯函数。|
|`src/services/cea-json.mjs`|官方公开 JSON 解析：业务码判定、`querySubStat`（COMCEA 三行聚合，保留逐方法分项）、`queryMarketByDate`（OHLC + 挂牌口径单列，复用字段名不采用）、`dailyov`（概览分层，容差按显示精度）、`tradeIntent`（方向语义、价格/主体 null）、`holidays`、`hiskline`（发现交易日）。纯函数。|
|`src/services/cea-svc.mjs`|来源与基础数据、行情入库（幂等 + 修订留痕 + 核对落库）、概览层与跨层核对、日历证据、来源层级、序列/汇总/同日对比、总览与状态、政策（含**配对适用性判定**、附件关联、计数去重）/日历/名录/意向、情景计算、导出列定义、缺口登记与结清。|
|`src/services/cea-collect-svc.mjs`|有界采集：HTML 日报通道、**公开 JSON 通道**、政策/PDF/名录/意向采集、PDF 原件落盘与 `pdftotext` 自动提取、事件日期**语义锚定**核对、候选 URL 发现、任务重入与僵死收尾、配额、共享总 deadline。|
|`src/services/http-guard.mjs`|`readGuard`/`writeGuard` 单一实现（原在 routes-v2.mjs 内部，抽出供 CEA 路由共用）。|
|`src/routes-cea.mjs`|CEA API：12 个只读接口 + 导出 + 情景 + 管理员配置/采集/任务/核验/解析预览。|
|`scripts/cea.mjs`|CEA CLI：`status/sources/seed/collect/parse/verify/scenario/export/jobs/gaps/close-stale`。|
|`scripts/cea-verify-parser.mjs`|用**已保存的真实快照**重解析并与入库行逐字段对照。|
|`scripts/cea-verify-detail.mjs`|AI 核验详情：是否真实调用模型、引文是否可定位、调用日志。|
|`scripts/cea-evidence-preview.mjs`|打印送入模型的「聚焦证据」，核对 AI 到底看到了什么。|
|`scripts/cea-check-cumulative.mjs`|确定性复算：COMCEA 分项之和 == 存储的累计值。|
|`scripts/cea-coverage-check.mjs`|展示政策配对覆盖与行业×年度适用性判定结果。|
|`scripts/cea-daily-report.mjs`|阶段A 状态一览（行情/概览/来源层级/日历/政策/事件/名录意向/缺口/核验/任务）。|
|`backup-scripts/cea-reset-trade.mjs`、`cea-reset-entities.mjs`、`cea-drop-json-docs.mjs`|**开发排错脚本**（非生产维护功能）：仅 Windows、目标库必须**精确等于**开发库白名单、需 `--confirm`；结尾逐表查询断言影响范围，不凭想象声称「未触碰」。|
|`test/30-v2-cea-parse.test.mjs`（24 项）|解析与确定性核对。|
|`test/31-v2-cea-service.test.mjs`（29 项）|增量库/服务/情景/导出。|
|`test/32-v2-cea-api.test.mjs`（24 项）|API 契约与权限（端到端 HTTP）。|
|`test/33-v2-cea-json.test.mjs`（16 项）|公开 JSON 通道、概览分层、配对覆盖、PDF 提取、采集预算。|

**修改**

|文件|改动|
|---|---|
|`src/core/db.mjs`|幂等加载 `schema-cea.sql`（写 `schema_version_cea_applied`，版本 `2.2.0`）；补列 `source_snapshot.cea_source_id`、`cea_source.method`/`body_template`、`cea_document.coverage_json`/`coverage_source`/`attachment_of`/`count_in_stats`。|
|`src/services/collect-svc.mjs`|`recordSnapshot` 增加可选 `ceaSourceId`（`source_id` 外键指向 v1 `source_document`）。既有调用行为不变。|
|`src/services/verification-svc.mjs`|CEA 核验：6 条 `cea.*` 规则、`cea_document`/`cea_trade_daily` 读取器与字段映射、CEA 提示词、四态回写、`cea` scope、`saveVerifyConfig` 接受 `cea`；**多通道快照证据**与 JSON 结构化聚焦；**累计值可复算分解**；字段口径说明；`timeoutMs`/`maxTokens` 参数；`change_pct` 不纳入非负检查。|
|`src/routes-v2.mjs`|改用 `services/http-guard.mjs`；导入 `CEA_RAW_ROUTES` 在同一张表装配（`/api/v2/admin/cea/*` 自动套用既有 admin 守卫）。|
|`test/10-v2-isolation-and-schema.test.mjs`|版本断言由硬编码 `2.1.0` 改为「≥2.1.0 且逐项验证增量表存在」，并补验 CEA 表与新列。|
|`package.json`|新增 `cea*` 脚本（见 A6）。|

### A2. 真实采集证据（本地，非 Mock）

全部经真实网络抓取，保存原始快照（sha256 + 抓取时间）。

**行情（4 个交易日，覆盖两条通道）**

|交易日|通道|来源|快照|sha256（前16）|核对|AI|
|---|---|---|---|---|---|---|
|2026-07-30|HTML 日报|`overview.cneeex.com/c/2026-07-30/498086.shtml`|`SS-0mv7srjh6-bc063453`|`b0c81c509230d7ea`|pass|verified（5/5 引文）|
|2026-08-11|HTML 日报|`overview.cneeex.com/c/2026-08-11/498128.shtml`|`SS-0mv7srnaq-34b24b75`|`2a34cb7ac03c88c1`|pass|verified|
|2026-10-13|公开 JSON|`shyx.cneeex.com/gateway/common/querySubStat`|`SS-0mv7tmdgd-37d97e23`|—|pass|verified（5/5，confidence 0.93–0.95）|
|2026-10-14|公开 JSON|同上|`SS-0mv7tlk01-11ee2c4c`|—|pass|conflict（见 A2-3）|

- **CEA-02 / CEA-03 与官方原文逐字段一致**（`node scripts/cea-verify-parser.mjs` 实测，`入库行与解析一致：true`）：
  - 2026-07-30：开 96.00 / 高 97.00 / 低 95.90 / 收 96.61 / 涨跌 +1.00%；挂牌 544,313 吨 / 52,585,579 元；大宗 500,000 吨 / 47,575,000 元；无单向竞价；总 1,044,313 吨 / 100,160,579 元；年 68,966,986 吨 / 5,499,968,391.61 元；历史 933,833,506 吨 / 63,162,586,623.18 元。
  - 2026-08-11：开 98.30 / 高 98.50 / 低 98.30 / 收 98.32 / 涨跌 −0.20%；挂牌 244,814 吨 / 24,069,216.20 元；大宗 100,000 吨 / 9,810,000 元；总 344,814 吨 / 33,879,216.20 元。
- **CEA-16 与 Codex 独立实测值逐字段一致**（2026-10-13）：开 99 / 高 99 / 低 97.80 / 收 98.25 / 涨跌 −0.15% / 昨收 98.40；挂牌 1,224,197 吨 / 120,276,511.33 元；大宗 1,749,245 吨 / 167,737,299.35 元；竞价 0；总 2,973,442 吨 / 288,013,810.68 元；年 134,207,049 吨 / 11,626,412,779.18 元；历史 999,073,569 吨 / 69,289,031,010.75 元。**年度/历史累计由 COMCEA 三行分项相加得到，未与年度标的行重复计数**；`node scripts/cea-check-cumulative.mjs` 逐项复算全部一致。
- **概览分层**：`dailyov` 为 `297.34万吨 / 2.88亿元 / 9.99亿吨 / 692.89亿元`，与精确值差异分别为 42 / 13,810.68 / 73,569 / 31,010.75，全部落在**按显示精度计算的舍入容差**（50 / 500,000 / 500,000 / 500,000）内；概览单独存表，精确值未被覆盖。

**政策 / 技术 / 研报（6 条计入统计 + 1 条附件行）**

|文件|文号|证据|正文|说明|
|---|---|---|---|---|
|2025、2026 年度配额总量与分配方案|国环规气候〔2026〕1号|full_text|2,504 字|HTML 正文|
|同上（官方 PDF 原件）|国环规气候〔2026〕1号|**full_text**|**23,012 字**|落盘 1,290,497 字节，sha256 与快照一致；`pdftotext` 自动提取；作为主行附件，`count_in_stats=0`|
|年度管理工作通知|环办气候函〔2026〕32号|full_text|5,107 字|2 条日历事件被原文锚定核对|
|配额结转规定|沪环境交〔2026〕1号|full_text|1,286 字|—|
|2026 版行情编制方案|沪环境交〔2025〕47号|full_text|1,949 字|1 条事件被原文锚定核对|
|2025 中国碳市场年报|—|full_text|17,484 字|研究观点，不作规则依据|

- **配对覆盖**（`node scripts/cea-coverage-check.mjs`）：发电 2025 ✓/2026 ✓；钢铁 2025 ✗/2026 ✓；水泥 2025 ✗/2026 ✓；铝冶炼 2025 ✗/2026 ✓；石化 2026 ✗。PDF 原件正文首句独立印证该配对：「全国碳排放权交易市场 **2025、2026 年度发电行业**以及 **2026 年度钢铁、水泥、铝冶炼行业**配额总量和分配方案」。
- 政策计数 6 条（全部行 7 条，附件行不重复计）。
- 省级名录 PDF（福建）已下载 131,209 字节，`pdftotext` 提取为空 → 判定扫描件，**如实登记缺口**，0 行入库。

**日历 / 名录 / 意向**

- CEA 独立日历：`holidays.json` 真实取得 **101 个**官方休市日期（2021-09-20 … 2026-10-14），写入 `cea_calendar`（不复用 CCER 日历）。
- 3 条履约事件的日期**均已在官方原文中定位到锚定句**（`date_verify_status=verified`），例如 2025 年度清缴：「（三）配额清缴 2026年12月31日前，……按时足额完成2025年度碳排放配额清缴。」
- 名录：0 行（真实尝试福建 PDF、黑龙江/浙江官方页、搜索发现的 *.gov.cn 候选，全部无可解析名录行）→ 缺口。
- 意向：0 行（`tradeIntent.json` 通道已接入并有单元测试覆盖；开发库本轮未复采）。

**AI 核验为真实调用**（`node scripts/cea-verify-detail.mjs`）：provider `LLM-0mumc91ws-da0ca2e7` / `deepseek-flash`，每次 1 次真实调用（2.7–6.2 s），引文全部可在提供的官方正文中原位定位（`match=exact`）。

**A2-3：2026-10-14 的 `conflict` 是有效发现，不是误报。** 官方 `holidays.json` 把 2026-10-14 列为休市日，而当日公开 JSON 行情显示有成交（2,861,440 吨）。模型据此判 `conflict` 并要求人工确认；我进一步把它补成**确定性核对** `calendar_conflict`（warn），不依赖模型也能看到。两侧数据均保留，不做取舍。

### A3. 实际执行的命令与结果

```
# 环境（本轮全程）
$env:CCER_DB_PATH="D:\AI workspace\ccer-screening\data\cea-dev-20261014.db"; $env:CCER_ENABLE_V2="1"

node scripts/cea.mjs status / seed / gaps / jobs / close-stale
node scripts/cea.mjs collect --target=json                       # hiskline 发现真实交易日 → substat/marketByDate 精确入库 → dailyov 概览 → holidays 日历
node scripts/cea.mjs collect --target=json --dates=2026-10-13    # 与 Codex 实测值逐字段一致
node scripts/cea.mjs collect --target=daily --sources=cea_daily_sample_1,cea_daily_sample_2
node scripts/cea.mjs collect --target=documents                  # 6 个 HTML/PDF 来源；PDF 自动提取成功
node scripts/cea.mjs collect --target=entities [--discover]      # 真实尝试 → 0 行 + 缺口（不伪造）
node scripts/cea.mjs collect --target=intentions                 # 真实尝试 → 0 行 + 缺口（不伪造）
node scripts/cea.mjs verify --object_type=cea_trade_daily --id=<id> --force
node scripts/cea-verify-parser.mjs / cea-verify-detail.mjs / cea-evidence-preview.mjs
node scripts/cea-check-cumulative.mjs / cea-coverage-check.mjs / cea-daily-report.mjs

# 隔离测试（系统临时库，运行后删除）
node scripts/v2-test.mjs          # 合计 23/24 通过（唯一失败见 A7-1，为环境限制）
# 30: 通过 24 / 31: 通过 29 / 32: 通过 24 / 33: 通过 16

# 库保护核对
Get-ChildItem data -File | Select Name,LastWriteTime
# ccer.db=2026-09-30 9:37:10（未变）；ccer_v2.db=2026-09-30 15:08:37（未变）；仅 cea-dev-20261014.db 本轮写入
```

开发库最终计数：`trade_days=4`、`documents=6`（+1 附件行）、`events=3`、`entities=0`、`intentions=0`、`checks=36`、`revisions=0`、`overview=1`、`quote_source=7`、`calendar holidays=101`；当日抓取 22/60。

### A4. Codex 首轮复核提出的阶段A后续项 — 逐项处理结果

|Codex 意见|处理结果|
|---|---|
|新增公共 JSON 通道需要接入，最新行情不能停留在目录旧日期|**已接入 6 个官方 JSON 通道**（hiskline/dailyov/queryMarketByDate/querySubStat/tradeIntent/holidays），并作为 `collect --target=json` 与 `runCeaDailyStep` 的**首选**通道；hiskline 实测已发现 2026-10-14（原始目录当时最新仅到 2026-08-14）。`cea_source` 增加 `method`/`body_template` 以支持 POST 网关。|
|配额文件应加行业/年度**配对**覆盖，钢铁 2025 不能命中 2026 分配方案|**已实现** `coverage_json`（发电 2025/2026；钢铁/水泥/铝冶炼 2026）+ `documentApplicability()`；API `?sector=&year=` 返回适用性；测试守护。|
|通知与其 PDF 两条 policy 须关联附件/去重计数，保留完整正式标题|**已实现** `attachment_of` + `count_in_stats`；PDF 行不计入政策计数；`/documents` 默认隐藏附件行并说明；正式标题完整保留（含「（官方 PDF 原件）」）。|
|PDF 须自动 pdftotext 提取，扫描件才交管理员|**已实现**：原件按**原始字节**落盘并校验 sha256 与快照一致，再调 `pdftotext` 提取；本例提取 23,012 字 → full_text。福建扫描件提取为空 → 判 `scan_suspected` 并登记缺口交管理员。含 `blocked`/`unavailable`/`failed`/`scan_suspected` 四态如实区分。|
|AI 核验循环没有 deadline，120 秒之外还可能附加 8 次 45 秒模型等待|**已实现**共享总 deadline：`collectCeaJsonDaily`/`runCeaDailyStep` 计算统一 `deadlineAt`，`verifyCollectedCea` 在预算不足时**不发起调用**并把剩余条目 `deferred` 留待下一批，模型请求时限取「剩余批次时间」与 provider 配置的较小值。测试守护。|
|`scripts/cea-reset-trade.mjs` 须限制为 Windows 且非 production、确切 CEA 开发库；移入备份目录；`api_credential` 表名须核实|**已处理**：三个排错脚本移入 `backup-scripts/`，改为**白名单精确比对**开发库（`data/ccer_v2.db` 实测被拒绝）、仅 Windows、`--confirm` 才执行；结尾**逐表查询**断言影响范围（不再凭想象）。`api_credential` 相关断言已删除——原脚本用 `SELECT COUNT(*)` 读该表本身是安全的，但「未触碰」的结论必须来自查询证据，现改为对 `trade_daily`/`app_user`/`cea_*` 的真实前后计数比对。|
|所有新入口/上传权限、日期/范围参数校验须独立 HTTP 复验|API 权限已由 test 32（24 项）端到端覆盖：未登录 15 条路径全 401、普通用户只读全 200、管理员 6 条路径全 403、CSRF 跨站 403、导出审计。**日期/范围参数的边界校验仍需 Codex 独立复验**（见 A7-6）。|

### A5. 实现过程中发现并修复的真实缺陷

均为**实测暴露**，非推测。前 9 项为首轮，后 6 项为接入 JSON 通道/PDF 时新发现：

1. **外键错配导致采集全部失败**：`source_snapshot.source_id` 外键指向 v1 `source_document`，写入 `cea_source.id` 触发 FK 失败。→ 补列 `cea_source_id` 并由 `recordSnapshot` 接收。
2. **AI 核验把页面导航当证据**：直接把原始 HTML 前 6000 字符送模型，而那只是导航栏 → 全部 `insufficient`。→ 先转正文并聚焦行情段落。
3. **涨跌幅被当成负值异常**：`change_pct` 可为负，原规则把它纳入非负检查，2026-08-11（−0.20%）被判 `numeric_sanity=FAIL`。→ 解析侧与核验侧同步修正并加测试。
4. **交易日被年度区间起点污染**：正文「2026年1月1日至7月30日」使首个中文日期匹配到 2026-01-01，两条日报互相覆盖成一行。→ 日期优先级改为「标题紧凑日期 → URL → 截至日期 → 兜底」并排除区间起点；输出 `date_candidates`/`date_consistent`；新增 `date_consistency` 核对。
5. **CCER 页面可被 CEA 解析器接收**：句式相似导致 CCER 累计量被写进 CEA 字段。→ 加页面归属判定，归属失败时**清空**所有已匹配字段；累计类句式再加句内守卫。
6. **名录解析把行业词当企业名**：政策正文里「…发电、钢铁、水泥、铝冶炼行业重点排放单位名录…」被当成企业行入库。→ 名录页面必须同时含名录标识与年度/行业信息，企业名必须以组织机构后缀结尾，识别行数 <3 不入库。
7. **事件日期「假核验」**：只按「日期是否出现」标 `verified`，把「2026年12月31日前制定2027年度数据质量控制方案」当成了「2025年度配额清缴」的依据。→ 改为**语义锚定**（同句内须同时出现目标日期与事件类型锚点词 + 对应年度词），找不到就保持 `unverified` 并登记缺口；每次重跑重新评估可纠正历史误标。
8. **任务僵死永久阻塞采集**：一次异常退出使任务停在 `running`，重入保护随后的所有采集都被合并进死任务。→ 异常必定收尾；超过 30 分钟的 `running` 任务自动标记失败；新增 `close-stale` 恢复入口。
9. **CLI 直接 `process.exit` 触发 libuv 断言**。→ 退出码在 `finally` 中设置，先关库再退出。
10. **GET 带 body 导致 JSON 通道全部失败**：来源的 `method`/`body_template` 未持久化，POST 网关被当成 GET，fetch 直接报 `Request with GET/HEAD method cannot have body`。→ `cea_source` 增加并持久化 `method`/`body_template`。
11. **PDF 经字符串往返被损坏**：原本保存的是 `fetchText` 解码后的字符串，二进制被 UTF-8 替换字符撑大（1,290,497 → 2,333,376 字节）且无法解析。→ 保留并保存**原始字节**，落盘后校验 sha256 与快照一致，不一致则丢弃并登记缺口。
12. **`pdftotext` 管道捕获被拒**：受限运行环境不允许通过管道捕获子进程输出（Node 默认 `stdio:'pipe'` → EPERM）。→ 改为让 `pdftotext` 写临时文件再 `readFileSync` 读回（同时避免大 PDF 的 maxBuffer 限制）。修复后成功提取 23,012 字。
13. **AI 证据不全导致假阴性**：JSON 通道下 OHLC 与精确量额来自**两个不同快照**，只给一个时模型如实回答「无法核验另一部分」。→ 汇总该交易日**所有通道**快照作为证据；并对 `querySubStat` 做结构化聚焦（只保留 COMCEA 汇总行，年度标的行折叠为计数），避免按字符截断把汇总行切掉。
14. **模型输出被 max_tokens 截断**：CEA 行情要逐项核对十几字段，默认 1200 tokens 不够，模型 JSON 不完整 → `unavailable`。→ CEA 行情核验输出预算提到 2600，并限制单通道证据长度（3500 字/通道、合计 9000 字）。
15. **累计字段被模型误判不一致**：模型把 `year_volume` 与当日 `tradeVolume` 之和比较（正确口径是三行 `yearVolume` 之和）。→ 在核验输入中给出**字段口径说明**与**累计值可复算分解**（列出每个加项及其来源通道），模型据此逐项核对加项是否在证据中。修复后 2026-10-13 由 `insufficient` 转为 `verified`（confidence 0.93–0.95）。
16. **公开 JSON 被误当政策文件**：`holidays.json` 的 dataset 也叫 calendar，被 `collectCeaDocuments` 收成一条"政策"。→ 采集侧排除 `kind='official_json'`，并用 `backup-scripts/cea-drop-json-docs.mjs` 按同一规则清理已写入行。
17. **文号被页面标签污染**：提取到「号环办气候函〔2026〕32号」（页面「文 号」标签残留）。→ 正则去前缀 + `isValidDocNumber()` 校验，已存值不合法时用本次正文重新派生（可自愈）。
18. **陈旧的失败记录残留**：概览跨层核对容差修正后，此前的失败项仍在 `cea_check` 里；PDF 提取成功后的缺口也未结清。→ 通过与否都写回核对结果，成功时按前缀结清缺口。

另有两处由测试夹具自身错误暴露（已修夹具，非代码缺陷）：构造样本 `4.7575亿元` 与 47,575,000 元不等价（应为 `0.47575亿元`）；`--all-versions` 下 `onlyNew` 跳过分支未结清已消除缺口。

### A6. CLI / API 入口

```
npm run cea -- status | sources | seed | gaps | jobs | close-stale
npm run cea -- collect --target=json|daily|documents|entities|intentions|all \
                       [--sources=...] [--dates=YYYY-MM-DD,...] [--limit=8] [--discover] [--query=...] [--all-versions]
npm run cea -- parse --file=<本地原文> [--url=...] [--date=YYYY-MM-DD]      # 只解析，不发网络、不写库
npm run cea -- verify [--object_type=cea_document|cea_trade_daily] [--id=...] [--force]
npm run cea -- scenario --E=.. --A=.. --C=.. --U=.. --r=.. --P1=.. --P2=.. [--extra-cost=..]
npm run cea -- export --dataset=trade|entities|intentions|documents|events [--format=csv|json] [--out=path]
npm run cea:verify-parser | cea:verify-detail | cea:evidence | cea:cumulative | cea:coverage
npm run cea:collect-json
npm run cea:test
node scripts/cea-daily-report.mjs        # 阶段A 状态一览
```

API（挂 `/api/v2`；登录用户只读，`admin` 前缀仅管理员）：

- `GET /cea/overview | /trade | /trade/:id | /series | /summary | /comparison | /documents | /documents/:id | /events | /entities | /intentions | /calendar | /sources/status | /scenario/presets`
- `GET /cea/export?dataset=trade|entities|intentions|documents|events&format=csv|json`
- `POST /cea/scenario`（登录用户；只计算、无持久化、无采集/配置副作用，含同源校验）
- 管理员：`GET|POST /admin/cea/config`、`POST /admin/cea/collect`（target=json|daily|documents|entities|intentions|all）、`GET /admin/cea/jobs`、`GET /admin/cea/jobs/:id`、`POST /admin/cea/verify`、`POST /admin/cea/parse-preview`
- `/cea/trade/:id` 返回 `quote_sources`（精确/概览通道分层）与 `overview`（概览层 + 跨层核对）
- `/cea/documents?sector=&year=` 返回 `applicability`（按配对判定）；`include_attachments=true` 才显示附件行

### A7. 验收用例对照（本轮实测）

|编号|状态|证据|
|---|---|---|
|CEA-01|**通过**|测试 31：CEA 12 张表建立；`migrate()` 连续执行 2 次账号/日历/来源计数不变；`data/ccer.db`、`data/ccer_v2.db` 时间戳未变。|
|CEA-02|**通过**|测试 30/32 逐字段断言 + 真实快照核对（A2）。|
|CEA-03|**通过**|同上。|
|CEA-04|**通过**|测试 30：万吨/亿吨/万元/亿元换算、千分位、明确无竞价为 0、未披露为 null、无目标内容失败不产零值、CCER 页与月报被拒、单位错配留痕。|
|CEA-05|**通过**|测试 30/31/32/33：口径分离核对项、区间/序列不补 0、同日对比缺一侧为 null 且价差为 null、概览不覆盖精确值。|
|CEA-06|**通过**|测试 31：同 URL 同哈希幂等（revision 不增、无修订记录）、数值变化进修订表且旧值保留、缺 `source_url` 拒绝。|
|CEA-07|**通过**|测试 32（24 项）：未登录 15 条路径全 401；普通用户只读全 200、管理员路径全 403；CSRF 跨站 403、同源放行；导出写审计。|
|CEA-08|**通过**|测试 31/32/33：配置越界被拒；出站白名单/私网/非法协议/非白名单拒绝；任务重入与僵死收尾；无模型时 `unavailable` 且不覆盖官方数值；共享 deadline 超出时不发起调用。|
|CEA-09|**通过**|真实调用 deepseek-flash，4 条行情中 3 条 `verified`（5/5 引文可定位，confidence 0.93–0.95），1 条基于真实来源不一致判 `conflict`；伪造/无法定位引文由 `validateCitations` 驳回（沿用既有实现，test 16 守护）；无凭据时按 `unavailable` 处理（测试 31 实测）。**对抗样本（伪造引文/提示注入）仍未覆盖，见 A8-5。**|
|CEA-10|**通过（数据侧为真实缺口）**|测试 30/31/32/33：名录判定拦截政策/采购页、信用代码+年度为标识、更名留痕、不同法人不合并、缺代码为 null；意向不进成交表且不改统计、方向不猜、价格/主体 null。真实名录覆盖数 0（无可解析公开样本，扫描件已识别），已登记缺口。|
|CEA-11|**通过**|测试 31/32：D=0、额度耗尽、U>E·r 剩余额度 0、P2>P1 差额为正且不建议购买、负数/NaN/Infinity/过大数/比例越界拒绝、缺 r 必须显式选择。|
|CEA-12|**通过**|测试 31/32：CSV 表头带单位、元信息含口径、`= + - @` 公式注入加前缀转义、导出范围一致、JSON 带列定义、导出写审计、无凭据字段。|
|CEA-13|**通过（后端回归）**|`node scripts/v2-test.mjs`：**23/24 通过**，既有 10—21、23—29 全部通过；测试 32 内含 CCER 总览/行情/政策与后台隔离回归。浏览器/手机验收属阶段B/C。|
|CEA-14|**通过**|真实采集：2 份官方日报（CEA-02/03 基准页）+ 2 个最新交易日（JSON 通道）+ 正式配额分配方案（HTML 与 PDF 原件，PDF 已自动提取）+ 年度管理工作通知 + 结转规定 + 行情编制方案 + 研究原文；名录/意向按实际可获取情况登记缺口，**未使用任何种子/Mock 行情**。|
|CEA-15|**不适用/未执行**|阶段C（Codex）职责；本轮不部署、不备份云端。|
|**CEA-16**|**通过**|测试 33（16 项）+ 真实采集：6 个官方 JSON 通道接入；业务码失败不按 HTTP 200 假定成功；`querySubStat` 只聚合 COMCEA 三行（`instrument_rows_excluded=2`）且与 Codex 实测值逐字段一致；`queryMarketByDate` 挂牌口径单列、复用字段名列入 `ignored_fields`；概览舍入层级与精确值分层保存并按显示精度跨层核对；hiskline 用于发现交易日且数量不当作全方式成交量；tradeIntent 方向/价格/主体口径正确；holidays 作为 CEA 独立日历证据。|

### A8. 未解决问题与剩余缺口（如实记录）

1. **`test/22-v2-independent-final.test.mjs` 失败（环境限制，非本轮代码问题）**：该文件的「Windows ACL 实际初始化及加密往返」用例需要修改文件 ACL；本会话沙箱禁止 `icacls` **设置**操作（实测 `icacls <file> /inheritance:r` → `Access is denied.`，exit 5；读取正常）。该文件全文不含 CEA 引用，`src/core/secrets.mjs` 本轮零改动。**需在有完整 ACL 权限的环境复核。**
2. **名录覆盖数为 0**：真实尝试福建（扫描件 PDF，131,209 字节，`pdftotext` 为空）、黑龙江/浙江官方页（无名录内容）、搜索发现的 *.gov.cn 候选（河南政府采购页等被名录页面判定拒绝）。均登记缺口。建议阶段B/C 由管理员上传官方原件，或引入 OCR/PDF 表格解析（会引入依赖，需另行决策）。
3. **意向数据本轮未在开发库复采**：`tradeIntent.json` 通道代码与单测已完成（16 项测试含方向/年度/价格/主体口径），但开发库 `cea_intention` 仍为 0 行（首轮采集时该通道尚未接入）。下一批 `--target=intentions` 即可取得真实意向。
4. **官方 HTML 日行情目录仍不可用**：`overview.cneeex.com/qgtpfqjy/mrgk/2026n/` 未解析出日报链接（动态加载），且原始目录最新仅到 2026-08-14。JSON 通道已解决问题（hiskline 发现最新交易日），HTML 目录降级链保留但未跑通增量多日。
5. **AI 核验对抗样本未覆盖**（CEA-09）：未构造「模型编造引文」「正文提示注入」的端到端对抗用例，仅依赖既有 `validateCitations` 与注入规则。建议 Codex 用桩 provider 补测。
6. **API 日期/范围参数的边界校验未独立复验**：`from`/`to`/`limit`/`offset`/`year` 目前只做基本数值转换，未对非法日期串、倒置区间、超大 limit 做统一校验与 400 返回。建议 Codex 独立 HTTP 复验后决定是否需要收紧。
7. **`price_regime` 历史口径迁移未实测**：目前仅 `CEA_COMPOSITE_2026` 有数据；2025 旧口径样本未采集，版本升级路径已预留。
8. **履约日历事件仅 3 条**：均为已采集文件可锚定的条目；后续修订版本（规范要求「后续修订优先」）尚未采集到，需持续批次发现。
9. **情景工具的参考价未与行情自动联动**：需调用方显式传 P1/P2（避免把某一日价格默默当默认值）。阶段B 前端应显示所选价格来源与日期。
10. **`data/cea-attachments/` 落盘原件未纳入备份/清理策略**：当前 1 个 PDF（约 1.29 MB）。部署前需与既有附件目录一并纳入备份与保留策略。

### A9. 阶段B 待办（下一轮 DSH，本轮未做）

- CEA 专题页签（行情/政策配额/履约日历/企业名录/交易意向/成本情景）与总览 CEA 卡片、既有模块入口与品种切换；所有新增入口需有空/加载/失败状态。
- 行情图（综合收盘价折线、成交量柱、交易方式占比、区间成交额/量与加权均价）、日期范围、分页、下载与来源钻取；**数据截止日、概览层（舍入展示）与精确值的区分、缺失/未核验状态必须对用户可见**。
- 管理员采集配置与任务进度页（含 JSON 通道与 deadline）、对比图表、轻量情景表单、第二层信息展示。
- 保持登录流程与普通用户后台隔离；手机布局与既有图表库复用，不引入大型框架。

## 阶段B：DSH界面与集成

状态：**待启动**（下一轮 DSH 任务；本轮按用户指令未修改 `web/` 任何文件）。

## Codex独立验收

状态：未开始；不得部署未验收代码。

建议优先复核：
1. A5 的 18 项缺陷修复是否彻底（尤其第 4、5、7、11、13、15 项口径类问题）；
2. CEA-16 与 Codex 独立实测值的逐字段对照（2026-10-13）；
3. A8 的 1、2、3、5、6 项；
4. `backup-scripts/` 三个排错脚本的白名单与影响范围断言是否可接受，或按意见删除/继续收窄。

---

# 阶段B：界面、集成与尾项整改（DSH 实际实施）

## B1. 阶段B 实际交付内容（已在代码中）

- **CEA 专题（第八个导航模块「CEA市场」）**：行情、政策配额、履约日历、企业名录、交易意向、成本情景、研报动态 7 个页签 + 来源与缺口页；普通用户可读，管理员可进后台设置（`web/v2/modules/cea.js`、`web/v2/app.js`）。
- **总览 CEA 卡片**：最新 CEA、真实行情截止日、官方综合收盘价与全方式计算均价分列、成交量/额、采集与核验状态，并链接到专题（`web/v2/modules/overview.js`）。
- **图片表**：行情折线/柱形/方式占比复用既有内联 SVG 辅助器（零依赖、无 CDN、无 ECharts）；390px 手机断点；来源钻取、筛选、分页、CSV/JSON 下载。
- **管理员后台**：CEA 采集配置（开关/时限/条数/服务选择）、采集按钮、任务与步骤、缺口、原件上传（PDF/OCR）、手动核验、解析预览。
- **接口**：`/api/v2/cea/*` 只读与情景（登录用户）、`/api/v2/admin/cea/*`（仅 admin，普通用户 403）；CCER 既有页面/接口保持工作，未重置账号与密钥。
- 阶段B 期间由 **Codex 独立验收**完成 8 页桌面与 390px、管理员原密码登录、后台入口、0 运行时异常（见 docs/35）。

## B2. 本轮（docs/35 九项尾项）实际整改

| # | 问题 | 实际改动 | 证明 |
|---|---|---|---|
| 1 | JSON 串日 / 方式缺失 / 方式重复 | `cea-json.mjs`：`parseSubStat` 先校验 COMCEA 汇总行日期**全部可解析且一致**（不一致→整通道失败、不产任何数值），再按 tradeMethod 去重（重复行拒绝合计）、识别未知方式；10/20/21 任一缺失或存在重复/未知行时 `complete=false`，**total/year/lifetime 一律 null**（已见方式的分项照实保留）。`collectCeaJsonDaily`：逐通道核对 `quote.trade_date === 请求日`，串日通道的字段全部保持 null、按响应自身日期留痕并登记 `cea:json:date_mismatch:<date>:<channel>` 缺口；同日正确的通道保留，整行标 `partial`（`parse_status=partial`、`date_consistent=false`）；两通道都无法确认日期则不留行、不写 0。 | test/36 尾项1：真实响应夹具（`acceptance-sources/querySubStat-20261014.json`）改日期/删一行/复制一行 + 真实 HTTP 桩采集链路 7 项 |
| 2 | 共享 deadline 未传到网络与重试 | `fetchText` 支持 `deadlineAt`：每次请求取 min(配置时限, 剩余时间)、重试等待受剩余时间约束、剩余不足直接返回 `deadline_exceeded`（不传时行为与旧版一致）；`fetchJsonChannel/fetchAndSnapshot/collectOneCeaDaily/collectCeaDocumentByCode/collectCeaEntities*/discoverLatest/discoverForDates/collectCeaIntentions/collectCeaResearch` 全部接收并下传 deadline；`runSearch` 重试不再重置时限；`fetchUrlContent` 真正使用 `opts.timeoutMs/deadlineAt`（直连、Firecrawl REST、MCP 三分支；MCP 的 initialize/tools/list/tools/call 每次往返都取最小值）；`extractPdfText` 也按剩余时间设限。 | test/36 尾项2：慢响应桩覆盖 fetchText/搜索/直连/MCP（含 MCP 正常路径），实测在剩余时间内真实中止 |
| 3 | 后台指定服务未生效 | `collectCeaResearch` 改为读 `cfg.search_provider_id` / `cfg.fetch_connection_id`；指定的服务不存在/未启用/已归档 → **明确失败并说明「不自动改用其他服务」**，不再静默切换；返回体标注实际选中的服务与来源（config/auto）。`discoverEntityCandidates` 同样处理。 | test/36 尾项3（5 项，含"实际请求打到配置的服务"） |
| 4 | 研究配额/异常收尾/重入关闭原任务 | 新增 `bumpCeaFetchAttempts`（按日计数，**失败尝试也计**），`ceaFetchUsedToday/ceaQuotaState` 合并官方快照与研究类尝试并给出明细；研究主体包在 try/catch/finally 中，异常必定收尾（不留 running）；`collectCeaIntentions` 同样加 finally 收尾；**全部 CEA 采集器的重入分支不再调用 closeCeaJob**，改为 `ceaReentryResult`（合并到运行中任务、原任务状态不变）。 | test/36 尾项4（4 项：配额计数、两类异常收尾、6 个采集器重入不关闭原任务） |
| 5 | 研报截止日补造日 / 转载站冒充第一来源 | `deriveResearchMeta` 按原文精度记录：仅到月 → `YYYY-MM`（precision=month）、仅到年 → `YYYY`（precision=year）、明确到日才 `YYYY-MM-DD`，并保存 `data_cutoff_raw`；新增列 `data_cutoff_precision/data_cutoff_raw/page_url`（增量迁移）；转载站的 `first_source_url` 保持 **null**、本页 URL 记在 `page_url`，列表/详情/导出分别展示（`data_cutoff_display`）。 | test/34（精度断言已按 docs/35 更新）+ test/36 尾项5（落库→列表→导出列） |
| 6 | 管理员采集同步等待 | `POST /api/v2/admin/cea/collect` 改为后台有界任务 + **立即 202 + task_id**；进程内任务表记录 queued/running/结束与错误，`GET /admin/cea/jobs?task_id=` 可轮询；同目标重入合并（同一 task_id、不重复抓取、不关闭原任务）；UI（`admin.js`）按真实 task_id 轮询并展示失败原因，**无结果不得显示完成**；普通用户仍 403。 | test/36 尾项6（端到端 HTTP：202 时延 <500ms、合并、queued/running→结束、失败任务带原因、普通用户 403） |
| 7 | 收盘后配置无真实调度 | `daily-scheduler.mjs` 新增 CEA 收盘后轻量增量定时器（北京时间默认 16:30，独立于 06:30 全平台更新），只跑行情 + 意向并共享同一 deadline/配额/重入保护；`CCER_DAILY_SYNC=0` 一并停用，另提供 `CCER_CEA_AFTER_CLOSE=0` 单独停用；后台改开关/时间立即重排并在配置接口返回**由真实定时器计算的**下一次运行时间（`after_close.next_run_at / next_run_beijing`）；`stopDailyScheduler` 停掉全部定时器；06:30 既有行为未改。 | test/36 尾项7（跨天/跨年、关闭、动态改时间、stop） |
| 8 | P2 使用 CEA 报价 / 研究资料状态措辞 | 新增只读 `GET /api/v2/cea/scenario/ccer-quotes`：只读 `trade_daily.market='CCER'`，返回 CCER 交易日、成交均价、来源 URL、核验状态与区间量加权**计算均价**（标注为计算值）；无可靠 CCER 参考时 `available=false` 并说明缺失。前端 P2 改为「手动输入 / 从 CCER 独立行情选择」，**不再提供 CEA 行情口径**，缺失时明确写「不会用 CEA 价格顶替 CCER 价格」；P1 仍取 CEA 行情。研究资料在政策列表/详情用「已发布 / 研究观点」，不显示「现行正式」；官方通知标题保留完整原名（列表截断仅显示层，补 title 提示；抽屉标题不截断）。 | test/36 尾项8（接口 + 前端源码契约）+ test/35 B6 按新契约更新 |
| 9 | 文件采集后默认 AI 核验未触发 | `collectCeaDocuments` 采集后对本批**实际取得全文**的文件调用既有核验链路（共享 deadline；未配置模型保持 unverified，不伪造通过），并把核验结果写入任务步骤与 detail；新增 `verifyCeaDocumentsCatchUp`（每日有界补跑，仍受共享 deadline）；`verifyAllBatch` 默认 scopes 增加 `cea`；`verifyCeaDocuments` 支持按 id、按剩余时间 defer。 | test/36 尾项9（本机桩模型真实 HTTP：attempts≥1、prompt 含真实正文、ai_status/ai_checked_at/llm_call_log 落库；无模型时不伪造）+ **真实 DeepSeek 实证**（见下） |

## B3. 真实 LLM 实证（docs/35 尾项9 要求）

一次性有界实证（只采集 1 个官方文件、随后 1 次有界补跑；不重跑大批采集）：

- 脚本：`data/backups/cea-20261014/dsh-fixes-20261014/cea-auto-verify-evidence.mjs`
- 结果：`data/backups/cea-20261014/dsh-fixes-20261014/cea-auto-verify-evidence.json`
- 实际结论：真实抓取 `cea_annual_work`（full_text，5,107 字）→ **自动核验被真实调用**（provider=`LLM-0mumc91ws-da0ca2e7`/`deepseek-flash`，prompt 6,318 字，latency ≈4.3s，`llm_call_log.purpose=cea_verify`）→ 结论 `insufficient`（模型指出条目标题/适用年度与正文不一致、`covered_sectors` 为空），`ai_status=insufficient`、`ai_checked_at` 已落库；随后 `verifyCeaDocumentsCatchUp` 真实执行（pending_before=6 → attempts=1、cached=1）。
- 说明：**不追求通过率**；`insufficient` 是按真实证据得到的结论，未被改写成 verified。

## B4. 本轮回归与验证结果

- 新增 `test/36-v2-cea-dsh-fixes.test.mjs`：**36/36 通过**（串日故障注入、慢响应 deadline、服务选择、配额/重入/异常收尾、截止日精度、202 异步、调度、P2 CCER、自动核验）。
- CEA 既有回归：`test/30`（24）、`test/31`（29）、`test/32`（25）、`test/33`（16）、`test/34`（14，精度断言按 docs/35 更新）、`test/35`（17，DOM 桩段在本轮修好挂载后真实运行并更新到新契约）全部通过。
- 全量 `node scripts/v2-test.mjs`：**26/27 个文件通过**；唯一失败 `test/22-v2-independent-final.test.mjs` 仅因本会话沙箱禁止 `icacls` 设置 ACL（docs/34 第 31 行已记录，Codex 在自己环境复验 5 项通过），与本轮改动无关。为反映 docs/34 新增的 CEA 导航，`test/20` 的导航断言由 7 模块更正为 8 模块（含「CEA市场」）。
- 开发库：`data/cea-dev-20261014.db`（本轮未触碰 `data/ccer.db`、`data/ccer_v2.db`、`cea-review-20261014.db`、云端与密钥）。

## B5. 仍未验证 / 留给 Codex 的事项（不得当作通过）

1. **真实浏览器交互**（8 页点击路径、390px、P2 下拉实际选择、后台 202 轮询 UI）：本轮未做真实浏览器验收，由 Codex 用 Playwright 独立复验。
2. **真实 16:30 到点触发**：只验证了排程计算与动态重排（跨天/跨年、关闭、stop），未等到真实时刻；生产首次触发需观察日志 `[cea:after-close]`。
3. **真实网络下的 deadline 中止**：用本机慢响应桩覆盖（直连/搜索/MCP/模型），未对真实上游做慢响应注入。
4. **反代超时下的 202 行为**：验证了 POST 时延 <500ms，未在真实反代（Nginx 等）后复验。
5. **AI 核验对抗样本**（编造引文/提示注入）：仍未覆盖（见 A8-5），建议用桩 provider 补测。
6. **研报截止日新列的历史数据**：旧行 `data_cutoff_precision` 为空（按 `day` 兜底展示行为未逐一复核），需要时按原文重新采集。
7. `docs/31` 的「每日轻量增量」与「06:30 全平台更新」在部署侧的进程守护/备份策略仍属阶段C。

## Codex独立验收（阶段B 已完成的只读检查，docs/35 记录）

8 页桌面与 390px、管理员原密码登录与后台入口、0 运行时异常；两份官方 HTML 日报逐字段；69 条真实意向方向；历史价格末 120 点；2026 休市公告 7 范围/33 休市日/7 开市日；干净验收库 4 个交易日真实 DeepSeek 核验；真实 HTTP 10 组（登录/注册/401/403/金标准/400/导出/同日缺失 null/负差额/旧模块回归）。验收库 `cea-review-20261014.db` 与 8912 端口由 Codex 持有，本轮未触碰。

---

# C 轮：docs/35「17:00 之后的独立故障注入追加」+ 界面整理 + v2.3.0

> 本轮范围严格限定为 docs/35 末尾追加的两项独立故障、日历来源修订、夹具随代码包可复现、
> 版本号与八模块文案、CEA 行情页的小幅整理，以及这些改动对应的回归。
> 阶段B 九项（B1—B5）已交付并通过 36 项回归，本轮**不重做**。

## C1. 实际改动

| # | 问题 | 实际改动 | 证明 |
|---|---|---|---|
| 1 | `tradeMethod=20` 的 `tradeVolume=null` 时仍把其余方式加成「完整总量」 | `cea-json.mjs` 的 `parseSubStat` 增加**逐字段披露判定**：方式齐全只是前提，`total_volume/total_turnover/year_*/lifetime_*` 每个字段还必须三行都披露该字段才给合计；未披露的字段保持 `null`（不把缺项当 0），其余已完整披露的字段照常单独保留。返回值新增 `field_disclosure` / `fields_undisclosed`（含未披露方式与原因），`caliber_note` 如实说明。`collectCeaJsonDaily` 对该情形登记 `cea:json:substat_field_undisclosed:<date>` 缺口，字段补齐后自动结清。 | `independent-fault-check.mjs` 6/6；test/36 追加用例；test/37 无关 |
| 2 | `queryMarketByDate` 只有 `CEA25`、没有 `COMCEA` 时仍 `ok=true` | `parseMarketByDate` **必须有 COMCEA 行**：没有即判失败，返回可用年度标的清单与明确原因（「年度标的行情不得冒充全国综合行情」），不产出任何 OHLC 数值；调用方按通道失败处理（不写字段、登记缺口）。 | `independent-fault-check.mjs` 第 5 项；test/36 追加用例 |
| 3 | `holidays.json` 101→100 来源修订后旧日期永久当「当前」并永久告警 | `cea_calendar` 增量新增 `source_state / superseded_at / superseded_by_snapshot / superseded_reason`（旧库由 `addColumnIfMissing` 补列；索引在补列之后创建，见 C3）。`upsertCeaCalendarDates` 新增 `complete` 语义：**成功且完整**（解析 ok、无非法日期、非空）的快照才同步当前有效集合——本次列表内保持/恢复 `current`，来源已删除的旧日期标 `superseded`（**行、原 note、原 snapshot_id 一字不改**，只加过期原因），并返回 `superseded/restored/kept_superseded/current_total`。失败 / 不完整结果**绝不清空**、不改写、不复活已过期证据。`listCeaCalendar`（含 `include_superseded` 追溯开关）、`reconcileCeaCalendar`、`ceaCalendarLayered`、`ceaOverview().counts`、采集链路里的休市日冲突检查、`scripts/cea-daily-report.mjs` 一律只看 `current`；核对时新增「过期遗留告警清理」（`stale_checks_closed`），只由旧机器列表产生的 `machine_list_vs_actual` 永久告警自动结清。 | 新增 `test/37-v2-cea-calendar-revision.test.mjs`（10/10，含真实夹具 101→100、失败/不完整不清空、改回可逆、采集链路 stub 端到端） |
| 4 | `test/34`、`test/35` 仍依赖 `data/backups` | `test/34`（`SAMPLE_DIR`）、`test/35`（休市公告）、`test/36`（`SRC_DIR`）统一改为 **`test/fixtures/cea/`**；把 `queryMarketByDate-20261014.json`、`querySubStat-20261014.json` 两份官方公开响应逐字副本补进夹具目录（无账号/会话/API 凭据），`test/fixtures/cea/README.md` 更新说明。完整回归自此**从代码包即可复现**，不再依赖运行期 `data/backups`。 | 全量 `node scripts/v2-test.mjs`（见 C4） |
| 5 | 版本与模块文案 | `package.json`、`src/core/db.mjs`（`schema_version`）、`/api/health`（`version` + `version_note`）统一升到 **2.3.0**；前端 `web/v2/app.js`（`v2.3` 角标）、`web/v2/index.html` 标题同步；启动横幅与 `scripts/v2-start.mjs` 由「七模块」改为 **「八模块」**（含 CEA市场）；`scripts/v2-acceptance.mjs` 的导航断言由 7 项更正为 8 项（顺序含 CEA市场）。历史版本记录（docs/20、docs/24、README v2.1/v2.2 章节）**不作修改**。 | test/31（schema_version=2.3.0）、test/21（启动文案八模块）、test/20（8 模块导航）、真实启动横幅、真实 `/api/health` |
| 6 | 行情概览里把原始核对 JSON 铺在页面上、把 sha256 当「抓取时间」显示 | **根因修复（后端）**：`upsertCeaOverview` 的 UPDATE 分支参数整体错位（UPDATE 比 INSERT 少一列，却用 `vals.slice(1, len-3)` 直接喂参）——`snapshot_id ← sourceCode`、`content_hash ← snapshotId`、`fetched_at ← contentHash`（sha256 被当抓取时间）、`cross_check_json ← fetchedAt`、`note ← 核对 JSON`。改为按列显式取值。**展示整理（前端）**：`cea.js` 新增 `ceaTimeText()`——只有真正的时间值才按时间展示，UUID/哈希/快照号一律回落「—」；概览层 `note` 若是原始 JSON 则收进 `<details>`（中文核对结论表默认展示），抽屉内同理。图表、具体统计、来源钻取、导出全部保留。 | test/36（概览链路用例仍通过）+ 开发库实际修复（C2） |
| 7 | （本轮发现）旧库无法打开：`no such column: source_state` | 起初把 `(evidence_kind, source_state)` 索引写在 `schema-cea.sql` 里，而该文件在**补列之前**整段执行；旧库的 `cea_calendar` 已存在（`CREATE TABLE IF NOT EXISTS` 不补列），于是迁移直接报错、服务无法打开任何既有库。已把该索引移到 `src/core/db.mjs` 的 `addColumnIfMissing` 之后创建，并在 schema 文件里写明原因。 | 开发库真实打开（C2）+ 全量回归 |

## C2. 开发库维护（仅 `data/cea-dev-20261014.db`）

一次性、可追溯的维护（脚本执行后即删除，不在代码中留下改写逻辑；旧 `ccer.db`、原 `ccer_v2.db`、验收库 `cea-review-20261014.db`、8912 服务与密钥均未触碰）：

1. **日历来源修订落地**：以 docs/33 记录的 2026-10-14 16:40 重新下载结果为来源（100 项，SHA256 `d936ec8f…fab6b1`，逐字副本即 `test/fixtures/cea/holidays-current.json`）同步当前有效集合：
   `holidays_json` 由 101 条 current → **100 current + 1 superseded**；`2026-10-14` 保留原行、原 `note`、原快照 `SS-0mv7tkj23-59973ae2`，标注过期原因与触发快照；`reconcileCeaCalendar` 后 `cea_calendar_check` 的 `machine_list_vs_actual` 告警**自动结清**（anomalies=0）。
2. **概览行错位还原**：`cea_daily_overview`（2026-10-13）按原语义一次性还原——`fetched_at` = 真实抓取时间、`cross_check_json` = 跨层核对 JSON、`note` = 中文口径说明、`snapshot_id`/`content_hash` 互换回来（`SS-0mv7tlni4-…` / sha256）。此后新采集由修复后的代码写正确值，无需再人工干预。

## C3. 迁移与兼容

- `cea_calendar` 四个新列对旧库是**纯增量**（`addColumnIfMissing`，默认 `source_state='current'`），旧行语义不变。
  列补齐后另记一次增量标记 `schema_version_cea_v23_applied` 并把 `schema_version` 更新为 `2.3.0`，
  因此既有库（含开发库）再次打开后版本元数据与代码一致；健康接口 `version` 独立返回 2.3.0。
- `upsertCeaCalendarDates` 的新参数 `complete` **默认 false**：旧调用点（test/33、test/34、test/35 的夹具写入）行为与之前一致，不会被误判为完整快照而清空集合。
- `parseMarketByDate` 收紧后，采集链路把「无 COMCEA」按通道失败处理（原本也会因 `trade_date` 不匹配或字段缺失而留缺口），不影响真实来源（真实响应含 COMCEA）。
- `parseSubStat` 的 `complete` 语义保持不变（只表示三方式齐全）；新增的是**逐字段**披露判定，真实完整响应（2026-10-13/14 两份夹具）的合计值与之前完全一致。

## C4. 本轮回归结果

- **独立故障注入**：`node data/backups/cea-20261014/independent-fault-check.mjs` → **6/6 通过**（未改弱任何断言；脚本本身未改动）。
- **新增** `test/37-v2-cea-calendar-revision.test.mjs`：**10/10**（夹具差异核对、基线告警、完整快照同步、只读 current、旧告警结清、失败/不完整不清空、采集链路三条路径）。
- `test/36-v2-cea-dsh-fixes.test.mjs`：**39/39**（阶段B 九项 36 项 + 本轮追加 3 项：逐字段未披露、年度行不改变总量、无 COMCEA 判失败）。
- CEA 既有回归 `test/30`—`test/35` 全部通过（34/35 已改用 `test/fixtures/cea/`；test/35 新增 A8 静态契约：时间字段防伪 + 原始 JSON 折叠 + 图表/统计/钻取保留，**18/18**）。
- **全量** `node scripts/v2-test.mjs`：**27/28 个文件通过**；唯一失败仍是 `test/22-v2-independent-final.test.mjs`（本会话沙箱禁止 `icacls` 设置 ACL，docs/34 已记录，与本轮改动无关）。
- **端到端验收**（`scripts/v2-acceptance.mjs`，在**临时种子库**上运行，未使用任何既有库）：90 项、通过 88；`/api/health` 版本 **2.3.0** ✔、「导航为八个主模块（含 CEA 市场）」✔。未通过的 2 项是环境数据期望（种子库未配置模型、未做真实联网种子抓取），与本轮改动无关。
- **真实启动**：`node scripts/v2-start.mjs`（临时库、独立端口）实测横幅为「公开信息平台（八模块）」，`/api/health` 返回 2.3.0。

## C5. 仍未验证 / 留给 Codex（不得当作通过）

1. **真实浏览器验收**：本轮未再尝试浏览器安装 / CDP / 新的 DOM 桩。CSV 下载、来源钻取、表单负差额、P1/P2 分别取 CEA/CCER、普通角色隔离与 0 JS 异常，已由 Codex 用真实浏览器验证（docs/35 记录），本轮改动后由 Codex 在自己的环境复验。
2. **真实上游的 101→100 修订**：本轮用逐字夹具 + 本机桩验证了行为与链路，真实网络的重新抓取由 Codex 的实服务验收确认。
3. **概览层实时重采**：开发库的历史错位行已按原语义还原；下一次真实 `dailyov` 采集应写入正确字段，需在实服务上确认一次。
4. 版本号只改了健康接口 / schema_version / package / 前端角标与标题；`scripts/v2-status.mjs` 等 CLI 若另有版本展示，以健康接口为准（未发现其他硬编码 2.2.0）。

---

# D 轮：CEA 尾项 —— 采集任务摘要「skipped」语义修复（仅 `summarizeCeaResult`）

> 范围严格限定：只改 `summarizeCeaResult` 一处判定、只加一个独立回归文件、只更新本记录。
> 未改密钥、数据库、网络实现、8912 验收服务与任何其他实现；未跑全套、未开浏览器。

## D1. 问题与真实证据

真实留档（本机 8912 真实任务，2026-10-15T02:33:15Z，任务 `CEATASK-0mv8xcch8-f7d9fba6`，`data/backups/cea-20261014/live-task-research-local.log`）：
target=research、elapsed_ms=**73446**、final_status=**skipped**、`summary={status:"skipped", note:"本次未执行"}`、error="真实任务失败：本次未执行"。
该轮真实搜索/取正文跑了 73 秒，却被判成整批未执行。（同名 `.json` 已被修复后的成功复跑覆盖，见 D3 末条；失败原始留档以 `.log` 为准。）

根因：`summarizeCeaResult` 用 `if (out.skipped)` 真值判断。research 采集器把 `skipped` 初始化为**逐条跳过原因数组**（`cea-collect-svc.mjs:1472` 的 `skipped: []`；daily 通道 `:525` 同理），空数组在 JS 中也是真值 → 任何 research（及 daily）结果都先被判为「整批 skipped」，published 计数与失败原因一律不再计算。

## D2. 实际改动

| 文件 | 改动 |
|---|---|
| `src/services/cea-collect-svc.mjs` | `summarizeCeaResult` 整批跳过判定由 `if (out.skipped)` 改为 `if (out.skipped === true)`（第 2738 行），并加注释说明数组语义：只有布尔 `true`（预算到点 / 停用 / 收盘后关闭）表示整批未执行，数组（含空数组）不再触发，按目标真实计数汇总。 |
| `test/38-v2-cea-collect-summary.test.mjs`（新增，11 项） | 独立回归：只调用纯函数，不建库、不发网络请求、不碰 8912。 |
| `docs/32-CEA开发实施记录.md` | 本段。 |

未改动：`web/`、`src/routes-cea.mjs`、schema、`data/` 下任何库、密钥与后台配置、8912 验收服务。

## D3. 回归（先复现失败，再验证修复）

- **修复前**：`node scripts/v2-test.mjs test/38-v2-cea-collect-summary.test.mjs` → **通过 2，失败 9**（research/daily 的真实数组形状全部被判 skipped；`skipped===true` 用例本来就通过）。用例非空转。
- **修复后**：同命令 → **11/11 通过**。覆盖：
  1. research `published>0` 且 `skipped=[]` → `success`，note「取得 N 项结果」，不含「本次未执行」；
  2. research `published>0` 且 `skipped` 非空条目数组（`repost_not_first_source` / `body_too_short` / `already_collected_same_hash`）→ `success`；再叠加 `failed` → `partial`；
  3. research `published=0` 两种情况（`skipped=[]` + `failed` 真实原因；`skipped` 非空、正文全被跳过）→ `failed` 且保留真实原因；
  4. `skipped===true`（预算到点 / disabled / after_close_disabled）在 7 个目标上仍必须是 `skipped`，message 优先、reason 兜底；
  5. 非布尔真值（`1` / `"true"`）不触发整批跳过；daily 的 `skipped=[]` 同样不触发（同根因，防止只修 research 分支）；
  6. 静态契约：函数内为 `out.skipped === true`，且不再出现 `if (out.skipped)`。
- **对应既有回归**（本机真实执行，全部通过）：`test/32-v2-cea-api.test.mjs` **25/25**、`test/33-v2-cea-json.test.mjs` **16/16**、`test/36-v2-cea-dsh-fixes.test.mjs` **39/39**（含尾项6 的后台 202 + task_id + `result_summary` 链路）。
- 按要求**未跑全套**，未开浏览器，未启动/触碰 8912 服务，未做任何真实网络采集。
- **并发独立复验（Codex，非 DSH 执行）**：2026-10-15T02:38:12Z 在真实 8912 服务上重跑 research 任务（task `CEATASK-0mv8xiq20-3b56b1cf`）→ `final_status=success`、`published=1`、`failed=0`、`note="取得 1 项结果"`、`error=null`、elapsed_ms=10618；留档 `data/backups/cea-20261014/live-task-research-local.json` 与 `live-task-research-fixed.log`。同一时段 `codex-test38.log` 显示验收方独立执行本文件 **11/11 通过**。以上为对方在自己的环境/服务上产生，DSH 本轮未触碰 8912 与 `cea-review-20261014.db`。

## D4. 仍未验证 / 留给 Codex（不得当作通过）

1. ~~真实 8912 服务上的 research 复跑~~ → 已由 Codex 于 2026-10-15T02:38:12Z 复验通过（见 D3 末条留档）；DSH 侧仍只做了纯函数回归。
2. **前端展示**：轮询展示走 `web/v2/modules/admin.js` 的 `result_summary.status/note`，本轮未改前端、未做浏览器复核（success/partial 文案沿用既有逻辑）。
3. **daily 通道的真实收益**：同根因一并修好，但本轮没有可比的真实 daily 任务留档。
4. 云端部署与真实上游搜索未验证。

## D5. 本会话工具与环境记录

- **GraphFlow**：本会话未暴露 `mcp__graphflow__*` 工具，`npx @roarpeng/graphflow` 因沙箱拒绝写 npm 缓存（EPERM）不可用；改用已安装包 `C:\Users\86139\.dsh\profiles\web\node_modules\@roarpeng\graphflow\dist\surfaces\cli\index.js` 真实执行 `context preview`，返回的关键锚点即 `data/backups/cea-20261014/live-task-research-local.json` 与 `web/v2/modules/admin.js` 的 `pollCeaTask`/`ceaResultSummary`，据此定位真实留档与展示链路。

