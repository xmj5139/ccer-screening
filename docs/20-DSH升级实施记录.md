# DSH 升级实施记录（CCER 公开信息平台 v2.1）

> **后续记录**：本文记录首轮（v2.1）实施。Codex 独立验收后的 17 项整改与
> 博查 / Firecrawl v2 MCP 接入见 **`docs/24-DSH二轮整改实施记录.md`**（v2.2），
> 其中与本文冲突处（如密钥文件路径、首页收录方式、核验缓存规则、启动命令）
> 一律以 docs/24 为准。

任务依据：`docs/19-公开信息整合平台升级任务.md`（用户最新授权需求，覆盖旧的人工审批要求）。
执行：本机 DeepSeek Harness（DSH）。记录目的：便于 Codex 逐步核查「已做 / 尚缺 / 真实限制」。

约定：
- 本文只记录**实际执行过的命令与真实结果**；未执行或失败的内容明确标注。
- **不记录、不输出任何凭据值、API Key 或环境变量值**；只记录「是否已配置」。
- 「真实联网」「真实模型调用」「模拟/打桩」三类证据分开标注，不混为一谈。

---

## 0. 起始状态侦察

| 项目 | 结果 |
| --- | --- |
| 工作目录 | `D:\AI workspace\ccer-screening` |
| Node | v24.14.1（内置 `node:sqlite`，项目零 npm 依赖） |
| 起始版本 | v2「六模块」：总览 / 政策和方法学 / 项目信息 / 交易信息 / 碳减排测算 / 后台管理 |
| 数据库 | `data/ccer_v2.db`（7.8 MB）；`data/ccer.db`（v1 生产库，**本次未读写、未迁移**） |
| 起始数据量 | public_project 294、policy_document 9、methodology_version 20、trade_daily 150、trade_dimension 300、source_snapshot 673、**review_task 650（pending 506）**、internal_project 5 |
| 备份 | `data/backups/v2-upgrade-20260929-094957/`（含 -wal/-shm，12.0 MB）——改动前完成 |
| 联网 | PowerShell/curl 直连失败；**Node fetch 经环境代理可联网**（`NODE_USE_ENV_PROXY` 已设置） |
| 凭据 | `DEEPSEEK_API_KEY` / `CCER_SECRET_KEY` / `TAVILY_API_KEY` / `FIRECRAWL_API_KEY` **均未设置**（仅检查存在性，未读取值） |
| 技能 | `.dsh/skills` 下 frontend-design / webapp-testing / systematic-debugging / mcp-builder 均已加载并按需使用 |

---

## 1. 数据库（schema v2.1，幂等增量）

新增 `src/db/schema-public.sql`，由 `src/core/db.mjs` 的 `migrate()` 在 `CCER_ENABLE_V2=1` 时加载；
全部 `CREATE TABLE IF NOT EXISTS` + 幂等加列。新增表：

| 表 | 用途 |
| --- | --- |
| `content_item` | 统一公开内容表（类型/标题/机构/作者/发布日/发现与采集时间/源 URL/正文快照/公开文件/主题标签/关联方法学/摘要·观点·预测/核验冗余状态/demo 标记/转载关联） |
| `content_version` | 同 URL 原文变化的版本与变化摘要（不覆盖历史） |
| `content_source_link` | 同一篇多站转载关联（不重复统计） |
| `search_provider` | 搜索服务配置（Tavily / Firecrawl Search / 自建 JSON）：限额、超时、重试、凭据密文 |
| `web_fetch_connection` | 网页抓取连接（Firecrawl Scrape / **直连 HTTP** / 远端 MCP）：工具名、只读白名单、握手发现清单 |
| `auto_verify_rule` | 自动核验规则（内置 10 条，不可删、可停用；**非人工审批**） |
| `auto_verify_config` | 核验策略参数 |
| `verification_result` | 唯一内容核验记录（verified / insufficient / conflict / unavailable） |
| `dataset_cursor` | 各数据集最近成功时间、失败原因、增量窗口（幂等） |

幂等加列：`public_project.link_status/link_checked_at/link_note/auto_verify_status/auto_verify_at`、
`policy_document.auto_verify_status/auto_verify_at`、`methodology_version.auto_verify_status/auto_verify_at`、
`llm_provider.use_content_verify`、`web_fetch_connection.note`、`search_provider.note`。

`V2_REQUIRED_TABLES` 加入上述 9 张表 → 表结构不完整时守卫直接返回 503。

**验证**：`schema_version=2.1.0`；`schema_version_public_applied=2026-09-29T01:54:17.175Z`；
重复迁移后表数量不变（测试 10 断言）。

> 旧表 `review_task` / `policy_change` / `ai_review_result` / `internal_project*` **保留为历史备份**
> （未 DROP、未删除数据），但新版代码不再写入，也不以其 `approved` 状态作为发布前提。

---

## 2. 移除内部项目与全部人工审核链路

### 2.1 服务端路由（`src/routes-v2.mjs`，共 130 条）

统一 `RETIRED` 信封（**HTTP 410** + 说明），停用 33 条旧业务入口：

- 内部项目：`/api/v2/internal-projects*`（含 `/review`）、`/api/v2/project-links`
- 项目人工核对：`POST /api/v2/public-projects/:id/confirm`
- 政策/方法学人工确认：`POST /api/v2/policies/:id/confirm`、`POST /api/v2/policy-changes/:id/confirm`
- 行情人工核对：`POST /api/v2/trade/:id/verify`、`/trade/verify-bulk`、`/trade/amend/:id`、`/trade/calendar/:date`
- 审核任务与差异人工处理：`GET /api/v2/admin/reviews`、`POST /api/v2/admin/reviews/:id/decide`、`POST /api/v2/admin/reconciliations/:id/resolve`
- 内部项目导入：`POST /api/v2/import/internal-project`
- 旧测算链路（依赖内部项目档案 + 专家签字）：`/api/v2/measure/run`、`/runs*`、`/precheck*`、`/form-fields`、`/prefill/:id`
- 团队项目授权：`POST /api/v2/admin/teams`、`/admin/grants*`
- 旧 AI 复核：`/api/v2/admin/ai-review*`

保留为**只读**：`GET /api/v2/policy-changes`（官方原文变化的自动检测记录，无任何确认动作）。

新增公开数据导入：`POST /api/v2/import/:template`（仅 `trade-daily` / `public-project`；
`internal-project` 模板返回 410）。

### 2.2 服务层

- `admin-v2-svc.mjs`：删除 `reviewsDashboard()` / `decideTask()`；`ROLES` 去掉 `reviewer`；
  用途开关以 `use_content_verify`（公开内容自动核验）取代项目复核主用途。
- `collect-svc.mjs`：`runDailyJob` 不再导入 `ai-review-svc`、不再创建审核任务；
  `syncStatus()` 改为返回四态核验统计与公开内容条数。
- `dashboard-svc.mjs`：地域视图删除内部项目统计；更新流改读 `verification_result`
  的 conflict/unavailable（运行状态，不是待办）。
- `ai-review-svc.mjs`、`project-v2-svc` 的内部项目函数：**源码保留作历史**，已无路由可达。

### 2.3 前端

- 导航 6 → **7 个模块**：`项目信息`→`公开项目`，`碳减排测算`→`减排粗估`，新增 `研报与行业动态`。
- `projects.js`：删除内部项目页签与抽屉、删除「标记为已核对」按钮、删除项目创建/同步，
  人工核对筛选 → 自动核验四态筛选。
- `policies.js`：删除「变更待确认」页签与确认/忽略按钮（改为只读「原文变化（自动检测）」）、
  删除「人工确认」「领域签字」「领域复核签字」，AI 解读改标「自动生成」。
- `admin.js`：删除「审核任务」「项目更新与 AI 复核」页签；新增「采集连接（搜索 API / 抓取 MCP）」
  与「自动核验策略」；「用户与团队」→「用户管理」（去项目授权）。
- `measure.js`：重写为简表置顶 + 可选高级参数。
- `app.js`：顶栏改为「内容条目 / 来源冲突 / 未结清差异」；页脚改口径说明；`index.html` 标题更新。

### 2.4 测试断言调整（有选择的改）

- **保留**：权限（401/403/CSRF）、原始状态区分（公示量/核查量/登记量）、数值复算、库隔离。
- **改写**：「必须人工审核/领域签字」→ 自动核验四态 + 旧路由 410；
  `pending_review` 计数 → 四态核验计数；`schema_version` 2.0.0 → 2.1.0；
  `16-v2-ai-review` 重写为 `16-v2-verify-and-model`（真实连接测试 + 四态核验 + 无人工任务）。

---

## 3. 自动采集与核验链路（新增服务）

| 文件 | 作用 |
| --- | --- |
| `src/core/secrets.mjs` | 凭据库：主密钥来自 `CCER_SECRET_KEY` 或**本机受限密钥文件**（`data/keys/master.key`，0600，已 gitignore）；AES-256-GCM；`keyStatus()` 只返回来源与可用性 |
| `src/services/search-svc.mjs` | 搜索适配器：Tavily（`POST /search`）、Firecrawl Search（`POST /v1/search`）、generic_json；限额/超时/重试/鉴权/白名单；`normalizeSearchResults()` 纯函数 |
| `src/services/web-fetch-svc.mjs` | 抓取连接：Firecrawl Scrape、**直连 HTTP**（本服务自行 GET + 确定性正文抽取，无需第三方密钥）、**远端 Streamable HTTP MCP**（initialize → tools/list → tools/call，兼容 JSON 与 SSE，只读白名单） |
| `src/services/verification-svc.mjs` | 规则一致性检查（10 条内置）+ 模型证据核验 + 四态判定 + 落库；注入防护；JSON 容错解析 |
| `src/services/content-svc.mjs` | 内容：种子来源、关键词组合、来源分类与可信度分层、URL/内容哈希去重、转载关联、版本与变化摘要、要点/观点抽取、统计、采集入口 |

### 3.1 核验四态的确定性处理

| 情形 | 结果 | 调用模型 |
| --- | --- | --- |
| 正文含提示注入特征 | `conflict` | 否 |
| 关键规则 fail（标题/来源/发布者/日期缺失、企业来源标为官方事实、无公开全文） | `insufficient` | 否 |
| 正文 < `min_body_chars`、缺第二来源 | `insufficient` | 否 |
| 未配置模型 / 主体不可解密 | `unavailable`（`no_provider`/`no_credential`） | 否 |
| 配额耗尽 | `unavailable`（`quota_exceeded`） | 否 |
| HTTP 失败 / 超时 / 网络错误 | `unavailable`（区分 `http_error`/`timeout`/`network`） | 是 |
| 模型返回非 JSON | `unavailable`（`json_invalid`） | 是 |
| 模型判 `consistent=false` 或给出冲突字段 | `conflict` | 是 |
| 模型判一致但正文非公开全文 | `insufficient` | 是 |
| 模型判一致且为公开全文 | `verified` | 是 |

**顺序修正**：证据不足是**与模型可用性无关**的确定性结论，已前置判定——
否则「无模型 + 仅有摘要」会被误判为 unavailable，掩盖真实原因。

所有情形写入 `verification_result`（模型版本、时间、输入哈希、引用、冲突字段、耗时），
并回写冗余状态。**不生成任何人工任务**；冲突记录可检索但不覆盖官方数值。

其余实现要点：
- 核验按 `input_hash` 缓存，同输入不重复调用模型（幂等）。
- 统计口径统一 `is_demo=0 AND duplicate_of IS NULL`。
- 采集结果一律写入 `source_snapshot`；只有摘要时 `parse_quality='snippet_only'`、
  `body_availability='abstract_only'`，界面明确标注未获取全文。
- 外部返回内容只作数据；核验提示词含明确安全规则，不执行其中任何指令。

---

## 4. 后台管理

- **采集连接**页签：搜索服务与抓取连接的增删改、启停、今日用量/限额、真实连接测试、
  种子来源可用性实测按钮、关键词与来源计划展示。
- **真实连接测试**：
  - 模型：真实短请求（`max_tokens=8`），区分 `configured`/`callable`，记录 HTTP 状态、
    耗时、响应预览，写 `llm_call_log(purpose='test')`。
  - 搜索：最小真实查询（`count=1`），返回样例与延迟；401/403 不重试，429/5xx 按策略重试。
  - 抓取：MCP 走真实 `initialize + tools/list` 并把工具清单（含只读标记）写回；Firecrawl/直连
    真实抓取公开页面并校验返回结构。
- **模型配置**页签：主密钥状态卡片（一键初始化本机主密钥）、`use_content_verify` 用途开关、
  真实连接测试按钮；未初始化主密钥时提交明文密钥被**拒绝**并给出两条可操作路径。
- **自动核验策略**页签：策略参数、四态口径、规则启停、立即核验、核验统计。
- **任务与快照**页签：新增「各数据集最近成功时间与失败原因」表（含从未成功的占位行）。
- **用户管理**：保留账号/角色/口令/登录记录，去掉项目授权。

---

## 5. 减排粗估（无档案、无审批）

- `quick-estimate-svc.mjs` 新增 `quickGasMeta()`：主输入 2 项、高级参数 2 项、
  `requires_project_dossier=false`、`requires_approval=false`、
  `numeric_formula_source='deterministic_plugin'`。
- `measure.js` 重写：简表置顶，两项主要参数并排（手机宽度单列），高级参数进折叠区；
  结果区含规模量级、计算过程、因子出处、未包含项、口径提示。
- 界面明确写入：**数值由确定性程序计算，大模型不参与数值公式或结果的生成**。

**实测**：`{annual_gas_m3: 50000000, ch4_pct: 1.2}` → `annual_tco2e=9135.45`、`methane_input_t=402`、
`baseline=11256`、`oxidation=994.95`、`unoxidized=1125.6`（测试 19 用手算独立复算校验）。

---

## 6. 每日任务与运维

- `DAILY_DATASETS = ['policy','project','trade','factor','content']`；`content` 走
  「搜索发现 → 抓取正文 → 去重 → 抽取 → 模型自动核验 → 状态标记」，另抓 3 个种子来源首页。
- 数据集游标记录 `last_success_at` / `last_attempt_at` / `last_status` / `last_error` / 增量窗口。
- 幂等：日期窗口 + URL 哈希 + 内容哈希去重；核验按输入哈希缓存。

---

## 7. 验证结果（实际执行）

### 7.1 测试

| 命令 | 结果 |
| --- | --- |
| `npm test`（v1 五个文件） | **66 项断言全部通过**（11+10+13+24+8，fail 0） |
| `npm run v2:test`（11 个 v2 文件） | **11/11 文件通过** |
| `npm run v2:acceptance` | **93 项端到端验收全部通过**（随机端口 + 同进程，杜绝打到旧进程） |
| `node scripts/v2-test.mjs test/18-…` | 46 项（本机真实 HTTP 打桩：请求真发出、鉴权头正确、重试/限额生效；真实 MCP 握手 JSON+SSE） |
| `node scripts/v2-test.mjs test/20-…` | 14 项（真实 HTTP 下发的 HTML/JS/CSS 断言 + 全部数据接口 200 + 410 校验） |

v2 各文件通过项数：10→8、11→14、12→13、13→30、14→15、15→2、16→18、17→19、18→46、19→17、20→14。

新增/重写测试文件：
- `test/17-v2-public-content.test.mjs`（19 项）：去重、转载关联、版本、demo 排除、来源分层、关键词组合
- `test/18-v2-connectors-adapter.test.mjs`（46 项）：供应商真实结构、真实 HTTP、MCP 白名单、四态、凭据不泄漏
- `test/19-v2-daily-idempotent.test.mjs`（17 项）：日更幂等、demo/内部排除、旧路由 410、无档案粗估
- `test/20-v2-frontend-verification.test.mjs`（14 项）：页面级验证（见 7.4 限制说明）
- `test/16-v2-verify-and-model.test.mjs`（18 项，重写）：真实连接测试 + 四态 + 无人工任务

### 7.2 真实联网采集

```
node scripts/v2-real-collect.mjs
```

- 种子来源官网可用性实测：**5/10 可用**（同一脚本两次运行结果一致）
  - ✓ `ccer.cets.org.cn`、`www.ccer.com.cn`、`www.mee.gov.cn`、`www.cneeex.com`、`www.tanjiaoyi.com`
  - ✗ `www.tanpaifang.com`、`www.chinacoal.gov.cn`、`www.cresa.org.cn`：`ECONNRESET`
  - ✗ `www.hcyjs.com`、`www.cicc.com`：域名不在出站白名单（种子默认停用，需逐一验证后启用）
- 抓取种子来源首页：**5 成功 / 1 失败**（失败原因如实记录）
- 当前真实内容库（`is_demo=0 AND duplicate_of IS NULL`）：**5 条**
  - 按类型：行业动态 3、政策通告 2
  - 按来源类别：exchange 2、media 2、official 1
  - 按正文可获得性：`full_text` 3、`partial` 2
- 去重自检：通过（无重复 URL / 内容哈希）
- 核验：5 条均 `insufficient`（真实原因：来源首页缺发布日期 / 缺第二来源 / 正文不足 1200 字符）——
  **界面如实显示「证据不足」，未伪造「核验通过」**

### 7.2.1 每日任务与「最近成功时间 / 失败原因」

通过真实 HTTP 调用 `POST /api/v2/admin/daily`（`datasets=["content"]`）：

- 修复后的结果：`status=success ok=true errors=0`
- 数据集游标（后台「任务与快照」页签可见）：

| 数据集 | 状态 | 最近成功 | 备注 |
| --- | --- | --- | --- |
| `content_discovery` | `never` | 从未 | 未配置搜索 API，如实显示「尚未运行」 |
| `content_seed` | `ok` | 2026-09-29 02:33 | 种子来源首页归档：抓取成功 3/3 |
| `seed_source_probe` | `partial` | 2026-09-29 02:34 | 可用 5/10，写明每个不可用来源的原因 |
| `verify_content` | `ok` | 2026-09-29 02:34 | 核验批次记录 |

> **修复的缺陷**：初次实现把「未配置搜索服务」计为任务错误，导致每日任务整体判 `failed`，
> 尽管种子来源抓取成功。已改为：未配置属**已知限制**（写入 `detail.content_not_configured`
> 并在界面说明），不计错误；只有真实的网络/解析失败才计错误。
> 同时为种子来源抓取补上独立的 `content_seed` 游标，保证每个数据集都有准确的最近成功时间。

### 7.3 模型调用验证

- **实际厂商模型调用：未执行**。原因：`DEEPSEEK_API_KEY` 未设置，且数据库中 `deepseek` 配置的
  `credential_ref=DEEPSEEK_API_KEY` 解析不到凭据。后台「真实连接测试」如实返回：
  `configured=false, callable=false, real_call_performed=false`，并给出可操作提示。
  （**未读取、未输出任何凭据值**。）
- **调用链路本身已用本机 OpenAI 兼容桩服务验证**（真实 HTTP 往返，非替换 fetch）：

```
node scripts/v2-verify-model-path.mjs
```

| 步骤 | 真实结果 |
| --- | --- |
| 真实连接测试 | `configured=true callable=true real_call=true`，HTTP 200，30 ms；桩服务收到 `model=stub-verifier, max_tokens=8, Bearer` |
| 模型判一致 | `verified`（自动核验通过），`model_used=是`，1 次 HTTP 调用，`llm_call_log` 记录 `status=ok latency=4ms chars=4432→416` |
| 模型判矛盾 | `conflict`（来源冲突），记录冲突字段，`status=ok latency=6ms chars=4432→194` |
| 关闭桩服务 | `unavailable`（暂未自动核验），说明「模型网络请求失败（ECONNRESET），可稍后自动重试」，`status=error` |
| 人工审核任务 | **0 条**（`review_task` 无新记录） |

- 搜索 API：**未配置**（无 Tavily/Firecrawl 密钥）。采集接口如实返回
  `no_search_provider` 并声明「不会用空结果假装采集成功」；因此**没有**走搜索发现路径。
- 网页抓取连接：**已配置且可用**（`direct_http` 类别，无需第三方密钥），真实抓取官方与行业页面成功。

### 7.4 页面验证与真实限制

**真实浏览器无法在本沙箱启动**——根因已定位（systematic-debugging Phase 1）：

```
chrome-headless-shell ... --remote-debugging-port=9788 --no-sandbox
[FATAL:mojo\public\cpp\platform_channel.cc:108] Check failed: . : 拒绝访问。 (0x5)
```

Chromium 的多进程架构必须通过**命名管道**创建 Mojo IPC 通道，而当前 DSH 沙箱禁止子进程
打开命名管道；因此 Python Playwright（`spawn EPERM`）、Node Playwright
（`--remote-debugging-pipe`）与原生 CDP 启动（`--remote-debugging-port`）**都无法启动浏览器**。
这不是代码缺陷，是环境限制。

替代验证（已完成，可复现）：

1. **端到端验收** `npm run v2:acceptance`（93 项）：在**同一进程内**用随机端口启动真实 HTTP 服务，
   逐项验收健康检查/权限/七模块接口/口径/旧入口停用/快捷估算/连接配置/四态/每日任务游标/
   内容库口径/凭据不泄漏/前端静态资源。随机端口 + 同进程的设计可**杜绝「验收打到旧进程」**的假通过。
2. **真实 HTTP 下发的静态资源断言**（测试 20 与验收脚本）：读取服务实际返回的 `index.html`、
   `app.js`、`styles.css` 与 6 个模块 JS，断言
   - 导航恰为 7 个模块且顺序正确；
   - 不含 `机构内部项目库`、`项目更新与 AI 复核`、`变更待确认`、`标记为已核对`、`领域已签字`、
     `内部项目关联` 等入口文案与 `data-confirm`/`data-approve`/`data-reject` 属性；
   - 不再调用任何已停用接口；后台**页签定义**中不含「审核任务」「AI 复核」
     （注释里说明「旧页签已删除」不算入口）；
   - 新模块含四态文案、筛选项、观点/预测/事实分离、转载不重复统计；
   - 简表结构顺序为「主要参数 → 高级参数」；
   - 手机断点 `@media (max-width:720px)` 下 `.quick-primary` 变单列、大数字缩小。
3. **数据面验证**：七模块接口 + 采集连接/核验策略/主密钥/游标等接口在真实 HTTP 层全部 200；
   15 条旧入口全部不可达（410/404）。
4. **控制台错误**：因无法启动浏览器，**未能采集真实控制台日志**——这是遗留限制。

在有浏览器权限的环境执行实机验证（现有脚本）：

```powershell
npm run v2:start -- --port=8899        # 另开一个终端
python scripts/v2-browser-check.py http://127.0.0.1:8899
```

> 本次曾编写 `scripts/v2-browser-verify.mjs`（7 模块 + 手机宽度 + 控制台错误断言）
> 与零依赖 CDP 客户端 `scripts/lib/cdp.mjs`，因沙箱无法启动浏览器而**已删除**，
> 避免留下不可执行的脚本；其断言已被测试 20 与验收脚本覆盖。

**遗留进程说明**：调试期间多次启动的 `node src/server.mjs` 中有若干进程未被沙箱允许终止
（`Get-CimInstance`/`Win32_Process` 查询被拒），仍占用 8899/8902 端口并运行**改动中途的代码**。
因此所有最终验收均改用**随机端口 + 同进程**（`v2-acceptance.mjs`）执行，结论不受影响。
在正常环境下重启服务即可清掉这些进程。

### 7.5 其他真实限制

1. 种子来源中 `tanpaifang.com` / `chinacoal.gov.cn` / `cresa.org.cn` 出现 `ECONNRESET`
   （网络或对方站点限制），已如实记录并在后台显示为不可用；未伪造成功。
2. 券商研报站点（华创、中金）需人工逐一验证可用性后才启用，当前保持停用。
3. 直连 HTTP 抓取不执行 JS，动态渲染页面取不到正文时会返回 `empty_content`，不伪造正文。
4. PDF 附件不做解析，如实标注 `pdf_not_supported`，交由专门解析器处理。
5. 官方来源首页抓取得到的标题是站点名（取自 `<title>`），条目为「首页归档」性质；
   真正的逐篇研报/动态采集需要配置搜索 API。
6. `data/keys/master.key` 尚未初始化（本次未提交任何凭据），因此库内加密保存凭据的能力
   已实现但**未在本机验证过一次真实加密入库**（测试 18/16 覆盖了加密往返与拒绝明文路径）。
7. 未接入机构 SSO/OIDC，仍是原型身份机制（沿用既有边界，未在本轮扩大范围）。

---

## 8. 改动文件清单

**新增**
- `src/db/schema-public.sql`
- `src/core/secrets.mjs`
- `src/services/search-svc.mjs`
- `src/services/web-fetch-svc.mjs`
- `src/services/verification-svc.mjs`
- `src/services/content-svc.mjs`
- `web/v2/modules/content.js`
- `scripts/v2-acceptance.mjs`（93 项端到端验收，随机端口 + 同进程）
- `scripts/v2-real-collect.mjs`
- `scripts/v2-verify-model-path.mjs`
- `test/17-v2-public-content.test.mjs`
- `test/18-v2-connectors-adapter.test.mjs`
- `test/19-v2-daily-idempotent.test.mjs`
- `test/20-v2-frontend-verification.test.mjs`
- `test/16-v2-verify-and-model.test.mjs`（由 `16-v2-ai-review.test.mjs` 重写更名）
- `docs/20-DSH升级实施记录.md`（本文件）

**修改**
- `src/core/db.mjs`（加载 v2.1 schema + 幂等加列）
- `src/services/v2-guard.mjs`（必需表清单）
- `src/routes-v2.mjs`（+新模块路由 / 33 条旧入口 410 / 恢复公开导入）
- `src/services/admin-v2-svc.mjs`（凭据存储改造、真实连接测试、删除人审、`normalizeHostname`/`isLoopbackHost`）
- `src/services/collect-svc.mjs`（日更含 content、不再建人审任务、游标、`loopbackOutboundAllowed`）
- `src/services/dashboard-svc.mjs`（去内部项目、更新流改核验状态、最新政策与动态）
- `src/services/verification-svc.mjs`（四态顺序修正、统一返回信封）
- `src/services/project-v2-svc.mjs`（`auto_verify_status` / `exclude_demo` 筛选）
- `src/services/quick-estimate-svc.mjs`（`quickGasMeta`）
- `web/v2/app.js`、`web/v2/index.html`、`web/v2/styles.css`
- `web/v2/modules/projects.js`、`policies.js`、`admin.js`、`measure.js`、`overview.js`
- `scripts/v2-test.mjs`（测试文件发现规则 + 回环出站开关）
- `src/server.mjs`（健康检查产品标识改为「CCER 公开信息平台」v2.1 + 启动横幅）
- `package.json`（`v2:real-collect`、`v2:verify-model-path`、`v2:acceptance`）
- `README.md`（新增 v2.1 章节：七模块、自动核验四态、启动与运维、凭据与限制；旧内容标注为历史）
- `test/10-v2-isolation-and-schema.test.mjs`、`test/12-v2-daily-and-reconcile.test.mjs`、`test/14-v2-http-auth.test.mjs`

**未改动**：`data/ccer.db`（v1 生产库）、`src/db/schema.sql`、`src/methodologies/*`、`src/rules/*`

---

## 9. 尚缺项（需用户或后续处理）

1. **搜索 API 凭据**：配置 `TAVILY_API_KEY` 或 `FIRECRAWL_API_KEY`（或后台用主密钥加密保存）后，
   「研报与行业动态」方能按关键词组合自动发现内容。当前 5 条内容均来自种子来源首页，
   `content_discovery` 游标如实显示「尚未运行」。
2. **模型凭据**：配置 `DEEPSEEK_API_KEY` 后，「自动核验」才会真正调用厂商模型；
   当前 5 条真实内容为 `insufficient`（证据不足），非模型结论。
3. **环境变量式搜索 MCP 端点**：MCP 客户端（initialize/tools/list/tools/call + SSE + 只读白名单）
   已用本机桩服务验证；接入真实远端 MCP 需提供端点与工具名。
4. **真实浏览器实机验证**：需在有浏览器权限的环境运行（本沙箱 Mojo 管道被拒）。
5. **本机主密钥初始化**：`data/keys/master.key` 未生成；如需库内加密保存凭据，
   可在后台「模型配置 → 初始化本机主密钥」一键完成。
6. 券商研报来源需逐一验证官网可用性后启用（`SEED_SOURCES` 中已预留并默认停用）。
7. `web/v2/modules/overview.js` 的「最新政策」卡片依赖 `overview.policies`，
   当政策库为空时显示空状态；本轮政策库非空，已验证渲染。
