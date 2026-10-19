# DeepSeek 能力扩展实施记录

2026-10-19｜本地开发与隔离测试，未访问或修改云端部署、未读取或调用任何实际凭据、未启动其他代理、未部署。
配套要求：`docs/54-DeepSeek能力扩展开发要求.md`。

## 1. 本轮结果摘要

| 能力 | 状态 | 说明 |
|---|---|---|
| 复用已保存官方 DeepSeek 凭据 | 已实现 | Search/Fetch/视觉/工具问答只保存 `provider_id`；调用时通过既有 `resolveCredential` 解析 |
| DeepSeek Search / Fetch | 已实现（协议） | 固定官方端点、失败分类与有限退避、402 停止、3xx 不跟随；接入问答、公开资讯采集与种子来源 |
| 文档视觉补充 + Files 复用 | 已实现（本地协议） | `pdftoppm` 异步有界转页图；逐页记录；可并入正文；Files 按图片 hash 复用，默认关闭 |
| 工具化多轮问答 | 已实现 | 白名单只读工具；最多 4 轮、调用数/时长上限；证据复用既有引用校验；阶段进度前端可见 |
| JSON 可靠性 / 思考 / 缓存观测 | 已实现 | 空 content、截断、非 JSON、缺字段；最多一次修复；usage/cache/token/tool 留痕 |
| 后台入口 | 已实现 | 新「DeepSeek 能力」页签；采集连接表单支持引用官方模型与备用；PDF/OCR 页新增指定页视觉入口 |

**本轮没有真实调用 DeepSeek。** 新增测试全部使用本机回环桩验证协议、失败与回退行为；真实联网最小验收由 Codex 执行，见第 7 节清单。

## 2. 数据与迁移

- 新增 `src/db/schema-deepseek.sql`，在 `src/core/db.mjs` 中于 platform schema 之后执行；全部 `CREATE TABLE IF NOT EXISTS`，可重复执行。
- 新表：
  - `deepseek_capability`：按能力保存开关、`provider_id`、预算、超时、最近调用/成功/失败、402 当日停止标记。
  - `deepseek_vision_page`：`doc_hash + page + model` 唯一；保存图像 hash/字节、结构化文字/表格/限制、是否并入、错误与延迟。
  - `deepseek_file_cache`：`provider_id + image_hash` 唯一；保存 Files `file_id`、有效期、删除状态，不做独立文件管理页面。
  - `chat_tool_call`：每次工具调用留痕（参数、结果长度、证据引用、延迟、错误）。
- 幂等加列：
  - `search_provider` / `web_fetch_connection`：`provider_id`、`is_fallback`、`fallback_priority`、`last_call_at`、`last_success_at`、`total_calls`、`total_success`、`last_usage_json`。
  - `llm_provider`：`thinking_policy`、`reasoning_effort`。
  - `llm_call_log`：`prompt_tokens`、`completion_tokens`、`total_tokens`、`cache_hit_tokens`、`cache_miss_tokens`、`tool_calls`、`thinking_enabled`、`finish_reason`、`estimated_cost_cny`、`cost_estimated`、`retry_count`。
  - `chat_turn`：`session_id`、`tools_json`、`tool_call_count`、`thinking`、`cache_hit_tokens`、`cache_miss_tokens`、`as_of`。
- 版本标记：`schema_version_deepseek_applied`，`schema_version` 记为 `2.7.0`；旧库重复打开安全。
- 既有 Bocha、Firecrawl、百度 OCR 与旧凭据字段全部保留；不改写历史数据。

## 3. 默认值与自动配置

- 初始能力行：Search / Fetch / JSON 默认启用；Vision / 工具问答默认关闭（避免未确认就产生付费调用）。
- 预算默认：Search 300 次/日、最多 2 次尝试；Fetch 300 次/日、最多 2 次尝试；Vision 120 次/日、单文档 3 页、单页 8MB、144 DPI；工具问答 300 次/日、最多 4 轮、8 次工具调用、45 秒总时长；JSON 最多重试 1 次、修复输出上限 2200 tokens。
- 自动引用：当数据库中存在**启用且官方**（host 精确 `api.deepseek.com`、HTTPS）的模型配置时，系统会幂等创建：
  - `DS-SEARCH-AUTO`（`provider_kind=deepseek_search`，`is_fallback=1`，priority 100）
  - `DS-FETCH-AUTO`（`conn_kind=deepseek_fetch`，`is_fallback=1`，priority 100）
- 若已存在任意 DeepSeek Search/Fetch 配置则不重复创建；不会覆盖用户已有主服务。排序始终为主服务优先、备用按 `fallback_priority`。
- 能力行的 `provider_id` 仅在为空时补齐，不覆盖管理员已有选择。
- 402（余额不足）会写入 `budget_stopped_date=今日`，当日停止该能力调用；管理员保存配置或次日自动解除。401/403 不重试。

## 4. 关键实现

### A. 凭据引用

- 服务端只保存 `provider_id`；`resolveCapabilityCredential()` 读取对应 `llm_provider`，再调用既有 `resolveCredential()`。
- 只允许绑定启用、官方 `https://api.deepseek.com` 模型配置；代理商/自建接口返回 400 并说明原因。
- 引用模型凭据只允许用于 `deepseek_search` / `deepseek_fetch` 官方连接，防止把同一 Key 转发给其它搜索/抓取 host。
- 模型 Key 轮换后，引用连接无需改动；数据库中没有复制明文/密文。
- 管理 API 只返回 `credential_configured/source`，不返回密钥、密文、请求头或服务端路径。

### B. Search / Fetch

- 固定端点：`POST https://api.deepseek.com/v1/tools/search`、`POST https://api.deepseek.com/v1/tools/fetch`；Bearer。
- Search：`query` 截断到 128 Unicode 字符且不切代理对；`count` 1—50；`need_content`、`ori_question`；响应适配官方 `results[]` 的 `title/url/snippet/summary/content/site_name/date/rerank_score/authority`。
- Fetch：JSON `{url}`；响应 `title/content`（Markdown）；正文截断上限可配。
- 失败分类：400/401/402/403/404/408/413/429/5xx/3xx/网络/超时；仅 408/429/5xx/网络/超时有限退避，402 停止，其余 4xx 不重试；共享整轮 deadline。
- 3xx 使用 `redirect: 'manual'`，不把 Authorization 带给其它 host。
- 抓取目标校验：拒绝 localhost、私网 IPv4/IPv6、云 metadata、`*.internal`、凭据 URL、非 HTTP(S)、超长 URL；模型不能传任意服务器 URL 获取管理员 Key。
- 回退编排：`runSearchWithFallback` / `fetchWithFallback` 主服务失败/空结果/缺正文时尝试备用；每次尝试单独记录；同一 canonical URL 去重，不因多引擎返回同 URL 视为多源验证。
- 接入：AI 问答联网兜底、公开资讯 `collectFromSearch`、种子来源与来源文章抓取。
- Search 只返回摘要时明确标为搜索摘要；Fetch 成功且正文存在才升级全文。空结果不计“成功次数”。

### C. 视觉与 Files

- 仍以 PDF 文本层优先、百度 OCR 保留；视觉补充是额外链路。
- `pdftoppm` 异步有界转换：单页、DPI、单页字节、整批 deadline 硬上限；Windows 缺工具返回可操作错误（安装 poppler-utils 或设置 `CCER_PDFTOPPM`）。
- 逐页记录：原件 hash、物理页码、图像 hash、图像字节、模型、结构化文字/表格、限制说明、置信度、延迟、是否并入。
- 输出标记 `machine_read=1`、`understanding=1`、`official_fact=false`；不自动改写正式因子，不冒充官方事实。
- 可并入现有逐页文档结果：正文标注「视觉模型补充」，状态仍为 partial/机器抽取，失败页不伪造成功；合并后仍走既有 `persistParseResult` 与核验入口。
- 自动回退：OCR/文本层仍有失败页、视觉能力显式启用且预算允许时，按对象自动补 **一页**；管理员可在 PDF/OCR 页对指定物理页手动触发。
- Files：默认 base64；启用后按 `provider_id + image_hash` 缓存 `file_id`，TTL 3600—2592000 秒；过期清理先 DELETE 远端再标记本地；只上传页图，不上传整份 PDF；没有独立文件管理页面。

### D. 工具化多轮问答

- 白名单工具：`search_library`、`get_library_record`、`market_prices`、`market_statistics`、`web_search`、`web_fetch`、`estimate_emissions`。
- 服务端参数 schema/范围校验；缺参返回“请询问用户”，不猜因子/单位；`web_fetch` 只能抓本轮 `web_search` 返回的 URL。
- 最多 4 轮、8 次工具调用、45 秒总时长；达到限制停止调用并返回已有证据与缺口，不无限循环。
- 每个工具结果转为既有证据结构；最终回答继续走 `validateAnswer` 的来源存在、引句逐字定位、数值有据、年份/日期冲突校验。
- 多轮上下文只来自当前用户 + 当前会话的服务端 `chat_turn`；客户端提交的 assistant/system 仍丢弃；会话 ID 经格式校验。
- 「只看官方」过滤为官方来源；「对比上年」/「同比」向工具传入上年同期；行情按问题日期重新查询，不使用过期缓存。
- 思考模式：工具能力配置 `auto` 时简单问题关闭、复杂/对比问题开启；带tools时把上一轮 `reasoning_content` 完整回传；思维链不显示、不作为答案或证据。
- 前端：显示真实阶段（查库/联网/抓取/计算/核对）轮询、工具轨迹、来源、数据截至日期；不显示内部 prompt 或思维链。

### E. JSON / 思考 / 缓存

- 结构化输出先检查空 content、`finish_reason=length`/截断、非 JSON、必填字段、类型/长度；只对输出形态问题最多重试一次，第二次增大输出预算并简化修复提示。
- 401/402/403、配额、网络、超时不重试；不采用无界续写。
- `response_format={type:'json_object'}` 只对 DeepSeek 官方端点添加；其它供应商保持原有行为。
- 摘要/视觉/JSON 显式关闭 thinking；复杂工具问答按需开启并记录 `reasoning_effort`。
- `llm_call_log` 记录延迟、prompt/completion/total tokens、cache hit/miss、tool_calls、thinking、finish_reason、错误；只有存在 usage 且配置了 token 单价时才估算费用，并标注“估算”。
- Search/Fetch 按官方公开价 5 元/千次成功请求注明“估算，价格可能调整”，不承诺永久价。

## 5. 修改文件

新增：

- `src/db/schema-deepseek.sql`
- `src/services/deepseek-capability-svc.mjs`
- `src/services/deepseek-fallback-svc.mjs`
- `src/services/structured-model-svc.mjs`
- `src/services/tool-chat-svc.mjs`
- `src/services/vision-svc.mjs`
- `test/96-v2-deepseek-capability.test.mjs`
- `test/97-v2-deepseek-vision-tools-json.test.mjs`
- `test/98-v2-deepseek-http-guard.test.mjs`
- `docs/55-DeepSeek能力扩展实施记录.md`

修改：

- `src/core/db.mjs`（迁移/加列/版本）
- `src/services/search-svc.mjs`（DeepSeek Search 预设、引用凭据、备用排序、状态与统计）
- `src/services/web-fetch-svc.mjs`（DeepSeek Fetch 预设、引用凭据、备用排序、目标校验接入）
- `src/services/verification-svc.mjs`（messages/tools/thinking/json 参数、usage 与缓存日志、redirect: manual）
- `src/services/summary-svc.mjs`（结构化摘要是用统一 JSON 可靠性）
- `src/services/chat-svc.mjs`（工具问答接入、进度、会话、阶段/工具/截至日期、fallback 联网、日志字段）
- `src/services/content-svc.mjs`（公开资讯/种子来源接入备用链）
- `src/services/ocr-backfill-svc.mjs`（视觉自动回退一页）
- `src/services/pdf-parse-svc.mjs`（视觉页计数与持久化说明）
- `src/services/cea-svc.mjs`（CEA 混合价格口径不合并、未披露量额保持 null）
- `src/services/admin-v2-svc.mjs`（测试回环端点 seam；不改变生产官方地址）
- `test/43-v2-ocr-frontend.test.mjs`（OCR 页新增视觉入口的渲染契约）
- `test/109-v2-deepseek-independent.test.mjs`（Codex 独立故障验收夹具；本轮只运行、未改写）
- `src/routes-platform.mjs`（问答 session/progress、能力状态）
- `src/routes-v2.mjs`（DeepSeek 后台概览/配置/测试/清理）
- `src/routes-ocr.mjs`（视觉状态/工具检测/指定页触发/清理）
- `web/v2/modules/admin.js`（DeepSeek 页签、连接引用与备用、视觉入口、观测表）
- `web/v2/platform.js`（阶段轮询、工具轨迹、数据截至日期）
- `web/v2/styles.css`（工具轨迹/截至日期样式）
- `README.md`、`PRODUCT.md`
- `package.json`（新增 `deepseek:test` 脚本）

## 6. 隔离测试结果

全部在独立临时库、本机回环桩中运行；未访问真实 DeepSeek，未读取凭据值。

| 测试 | 结果 | 覆盖 |
|---|---|---|
| `test/96-v2-deepseek-capability.test.mjs` | 13/13 | 凭据引用/轮换、非官方拒绝、admin 权限、响应适配、私网/重定向、402、主备回退、统计 |
| `test/97-v2-deepseek-vision-tools-json.test.mjs` | 16/16 | JSON 空/截断/401/字段、视觉页/缺工具/页数上限、Files 复用与清理、工具参数/边界/会话隔离/轮次/思考回传、chat.ask 校验 |
| `test/98-v2-deepseek-http-guard.test.mjs` | 6/6 | 新接口匿名 401、普通用户 403、管理员 200、返回不含凭据/请求头、参数校验 |
| `test/65-v2-summary-cache.test.mjs` | 11/11 | 摘要缓存、失效、JSON 结构化摘要回归 |
| `test/66-v2-chat-evidence.test.mjs` | 12/12 | 库内优先、联网兜底、引句/来源/数值校验、历史丢弃、限流 |
| `test/67-v2-admin-maintenance.test.mjs` | 8/8 | 后台维护与权限 |
| `test/68-v2-platform-http.test.mjs` | 7/7 | 平台 HTTP 与后台 admin-only |
| `test/69-v2-platform-frontend.test.mjs` | 10/10 | 前端文案、摘要/问答入口、样式静态回归 |
| `test/16-v2-verify-and-model.test.mjs` | 24/24 | 模型请求、thinking、真实连接测试、核验 |
| `test/17-v2-public-content.test.mjs` | 19/19 | 公开内容采集/去重 |
| `test/18-v2-connectors-adapter.test.mjs` | 48/48 | 搜索/抓取/MCP/凭据安全 |
| `test/39` / `40` / `41` / `43` | 通过 | 百度 OCR / PDF 逐页 / 补跑 / 前端渲染（OCR 页 + DeepSeek 能力页，DOM 桩） |
| `test/90` / `91` / `94` | 通过 | 独立来源、问答证据、Unicode 截断 |
| `test/109-v2-deepseek-independent.test.mjs` | 13/13 | Codex 独立故障验收：后台凭据状态/IPv6/凭据绑定/解绑/deadline/超时保留/402 独立厂商/项目日期/演示项目/CEA 口径 |

全量 `npm run v2:test` 最后一次运行结果为 **59/61**：`test/22-v2-independent-final.test.mjs` 的 Windows ACL 实际初始化被当前沙箱拒绝（测试自身按安全设计拒绝留下权限过宽的私钥），与本轮改动无关；`test/109` 在同轮运行后由独立验收新增“后台凭据状态必须使用完整服务端凭据引用”断言，暴露了 `deepseekOverview` 只 `SELECT` 公开字段导致凭据状态误判的缺陷。已改为读取完整模型配置后解析，`test/109` 单独复跑 **13/13**；其余未改动文件均通过，因此除 `test/22` 的环境限制外，其余 60 个测试文件通过。未为通过测试而放宽密钥权限。

已执行 JS 语法检查（`node --check`）覆盖所有新增/修改的 `.mjs` 与 `web/v2` 脚本。真实浏览器截图验收本轮未完成：本机沙箱下 CDP 检查超时（`Page.enable`），不把它当作通过；Codex 需按第 7 节执行浏览器验收。

未完成/已知限制：

- 未进行真实 DeepSeek 网络调用；Search/Fetch/Files/视觉的真实响应字段、计费与 QPS 仍需 Codex 最小验收确认。
- Search 响应适配同时兼容 `results` 与少量常见包装；官方若调整字段需按实际响应更新。
- Fetch 目标校验为字面/协议/私网/元数据检查；未实现完整 DNS rebinding 防护，生产仍应配合网络层出站策略。
- 视觉自动回退每个文档仅补一页；更多页需管理员手动指定。视觉结果不是官方事实，不自动改写正式因子。
- Files 复用默认关闭；开启后若上传失败会回退 base64 并在结果中说明。
- 工具问答仅对启用并绑定官方 DeepSeek 模型时启用；其它既有模型仍走原单轮证据问答。
- 真实浏览器（桌面/移动）运行验收、管理员入口点击与真实模型视觉页比对交由 Codex。

## 7. Codex 真实本地/真实模型最小验收清单

> 以下步骤使用**已授权的本地环境与真实模型**；不要把 Key、Cookie、请求头或数据库密文写入日志/报告。真实联网失败也要如实记录，不能用桩结果冒充。

1. **快照与启动**
   - 确认备份存在：`data/backups/deepseek-capabilities-20261019/code-before.tar.gz`、`local-before.db`。
   - 使用独立库启动（不要用生产库）：`node scripts/v2-start.mjs --temp --port=8931`。
   - 浏览器打开 `http://127.0.0.1:8931/v2`，管理员登录；确认现有绿色前端、八个导航与移动端布局未回退。

2. **引用与权限**
   - 「模型配置」中确认已有启用的官方 `https://api.deepseek.com` 配置（`deepseek-flash` 或既有模型）；不要新建重复 Key。
   - 打开「DeepSeek 能力」：确认五类能力、provider 名称/ID、只读凭据状态；确认页面源码/网络响应中没有 Key、`credential_cipher`、`authorization`。
   - 普通用户访问 `/api/v2/admin/deepseek`、`/api/v2/admin/vision/status` 应为 403；匿名 401。

3. **Search / Fetch**
   - 「采集连接」一键填入 DeepSeek Search/Fetch 备用；保存后点真实测试。
   - Search 测试应区分“返回 0 条（空结果）”和失败；Fetch 测试应返回真实 `title/content` 摘要。
   - 主搜索断开/指向无效后测试回退，确认失败尝试与备用成功分别留痕，且同一 URL 只显示一条。
   - 404/429/402 各触发一次（或查看日志留痕）；确认 402 后当日停止、401/403 不重试。

4. **库内查价与 CEA/CCER 统计**
   - 问：`CEA 2026-09-30 的官方综合收盘价和全方式量加权均价分别是多少？` 确认回答引用行情证据、数字可在证据中逐字定位、显示数据截至日期。
   - 问 CCER 某区间成交量/成交额/均价；确认调用 `market_statistics`，说明“程序计算”，缺失日不补 0。
   - 问库内政策数字；确认引用 `policy:<id>`，引句与正文一致。

5. **联网补证与缺证拒答**
   - 问一个库内没有、但可公开检索到的事实；确认先查库、再联网，来源区分库内/联网，搜索摘要不被说成全文。
   - 问一个无公开证据的问题；确认拒答并说明缺口，不凭记忆作答。

6. **多轮筛选**
   - 追问「只看官方」；确认第三方来源被排除、没有官方结果时拒答/说明。
   - 追问「和上年同期对比」；确认查询上年同期日期范围，不把今年数据当上年。
   - 修改日期或市场后追问；确认重新查行情，不复用旧价格。
   - 用另一个用户/会话确认拿不到上一用户会话内容。

7. **视觉已知测试页**
   - 选一份受限根内、有已知文字/表格的 PDF；在「PDF 解析/OCR」页选择对象与物理页，触发视觉补充。
   - 对照页图核验：文字/表格是否来自该页；小字/遮挡是否进入 limitations；结果是否标记“模型理解、非官方事实”；是否并入正文且状态仍为部分/机器抽取。
   - 删除/改名 `CCER_PDFTOPPM` 或临时指向不存在工具，确认返回可操作错误且不写正文。
   - 若启用 Files 复用：同页第二次触发应复用 file_id；把 expires_at 改为过去后清理，确认远端 DELETE 与本地状态。

8. **JSON 与观测**
   - 用本地桩或真实模型制造空 content/截断/非 JSON，确认最多一次重试、失败单条留痕，不把整批故障显示为成功。
   - 查看「DeepSeek 能力 → 调用观测」：延迟、token、cache hit/miss、tool_calls、thinking、finish_reason、错误与费用估算（若配置单价）。
   - 确认思维链不出现在答复、来源或证据中。

## 8. 官方依据（2026-10-19 阅读）

- Search/Fetch 指南：https://api-docs.deepseek.com/zh-cn/guides/search/
- Search API：https://api-docs.deepseek.com/zh-cn/api/search/
- Fetch API：https://api-docs.deepseek.com/zh-cn/api/fetch/
- 图像理解：https://api-docs.deepseek.com/zh-cn/guides/vision/
- Files API：https://api-docs.deepseek.com/zh-cn/guides/files_api/
- Tool Calls：https://api-docs.deepseek.com/zh-cn/guides/tool_calls/
- JSON Output：https://api-docs.deepseek.com/zh-cn/guides/json_mode/
- 思考模式：https://api-docs.deepseek.com/zh-cn/guides/thinking_mode/
- 多轮对话：https://api-docs.deepseek.com/zh-cn/guides/multi_round_chat/
- 上下文硬盘缓存：https://api-docs.deepseek.com/zh-cn/guides/kv_cache/

## 9. 快照与清理

- 改动前代码快照：`data/backups/deepseek-capabilities-20261019/code-before.tar.gz`
- 本地独立库快照：`data/backups/deepseek-capabilities-20261019/local-before.db`
- 未覆盖/删除上述备份与既有数据；未启动长期服务；临时验证服务已停止。
- 文档、代码与测试中未写入任何实际 Key；示例只使用占位环境变量名。

## 10. 结束状态

本轮在本地完成实现、迁移、隔离测试与实施记录后停止。未访问或修改云端部署，未部署，未使用生产/本地实际凭据，未运行全量采集。真实联网与真实模型验收由 Codex 按第 7 节执行。

## 11. 2026-10-19 真实联调追加修复（docs/57）

依据：`docs/57-DeepSeek真实联调修复要求.md` 与 `data/backups/deepseek-capabilities-20261019/live-http-acceptance.json`。本轮仍只做本地代码、夹具测试与文档记录；未调用真实凭据/外部服务，未部署，未修改 `docs/54`。

### 11.1 修复内容

1. **工具问答最终输出**
   - `runToolChat` 的工具阶段只负责发现/执行只读工具；结束后统一在剩余时间内发起一次**无工具 + `response_format=json_object`** 的最终总结，不再把带 tools 的普通文本直接当最终答复。
   - 复杂统计/对比问题最终输出预算至少 3200 tokens（默认配置从 1600 调整为 2800），普通问题至少 2400，硬上限 4096；最终证据最多 8 条、每条 900 字，并要求最多 4 段、每段 1 条短引句。
   - 最终 JSON 为空、不可解析、缺少 `answerable/paragraphs` 或 `finish_reason=length` 时，只在剩余预算内重试一次并增加输出预算；401/402/403 不重试；重试仍失败则如实返回已有证据与缺口。
   - 工具轮次或调用数达到上限时，先停止工具，再在剩余预算内做一次无工具证据总结；成功时返回 `limit_reached=true` 与总结，而不是立即返回 `tool_round_limit`。最终答复仍由 `chat-svc.validateAnswer` 校验来源、逐字引句与数值。

2. **空区间与数据截至日期**
   - `market_statistics` 对 CEA/CCER 都先查询库内实际覆盖范围；覆盖交易日为 0 时返回 `evidence=[]`、`gap=no_market_rows`，不构造 0 数据证据，不使用请求 `to` 作为数据日期。
   - 有样本时证据 `published_at`、`data.current.from/to` 使用实际 `MIN/MAX(trade_date)`；请求区间保存在 `requested_from/requested_to`，仅用于说明。
   - CEA/CCER 统计文本均注明“已入库覆盖交易日 N 个”，缺失日不补零；无证据时 `latestAsOf` 返回 `null`，不再回退到“今天”。

3. **只看官方过滤**
   - `officialOnlyFilter` 改为只按 `source_display.kind==='official'` 过滤，不再要求 `origin==='db'`；官方联网结果可引用，第三方库内/联网结果仍排除。
   - 新增回归覆盖官方联网页保留、第三方联网页排除。

4. **公开记录详情范围**
   - `get_library_record` 的 `content` 增加 `is_demo=0`、`duplicate_of IS NULL`、`record_kind='article'`、`process_status<>'failed_fetch'`；`policy` 增加 `duplicate_of IS NULL`。
   - 因子详情只读取 `is_current=1`；数值+单位按 `metadata_only` 返回，不再把数值元数据标成 `full_text`，历史/占位因子与检索公开范围一致。
   - 未新增/扩大检索表或关键词范围。

5. **连接测试语义**
   - 视觉/工具问答/JSON 按钮与返回统一标为“鉴权与模型连接测试”：`test_scope='auth_and_model_connectivity'`、`capability_verified=false`，并明确不等于视觉页图、工具协议或 JSON 字段完整验收。
   - 该测试通过 `reserveCapabilityCall` 占用能力配额，通过 `callVerifyModel` 受 provider 配额/超时约束并写入 `llm_call_log`（purpose=`deepseek_test_<kind>`），不再直接裸 fetch 绕过限制。
   - Search/Fetch 路由仍调用各自真实能力测试，返回 `test_scope='capability'`、`capability_verified=ok`、`test_label='真实能力测试'`。

### 11.2 修改文件

- `src/services/tool-chat-svc.mjs`（最终 JSON 总结、预算/引句限制、有界重试、官方过滤、统计日期、详情范围）
- `src/services/chat-svc.mjs`（无证据 `as_of=null`；answerable=false 时保留缺口说明，仍先过逐字校验）
- `src/services/deepseek-capability-svc.mjs`（连接测试语义/配额/日志、工具输出默认预算）
- `src/services/verification-svc.mjs`（连接测试可 `requireJson=false`，其它调用默认严格 JSON）
- `src/routes-v2.mjs`（Search/Fetch 真实能力测试字段）
- `web/v2/modules/admin.js`（按钮/结果文案、`test_scope`/`capability_verified` 展示、工具输出默认值）
- `test/97-v2-deepseek-vision-tools-json.test.mjs`（工具上限行为改为“停止工具后无工具总结”；未改 109）
- `test/110-v2-deepseek-live-fixes-independent.test.mjs`（新增独立回归）
- `package.json`（`deepseek:test` 纳入 110）
- `docs/55-DeepSeek能力扩展实施记录.md`（本节）

### 11.3 本轮测试结果

均为临时库、本机回环夹具；无真实凭据、无外网。按 docs/57 只跑相关测试，不重跑全量。

| 测试 | 结果 | 覆盖 |
|---|---|---|
| `test/96-v2-deepseek-capability.test.mjs` | 13/13 | Search/Fetch 协议、凭据引用、回退、402 |
| `test/97-v2-deepseek-vision-tools-json.test.mjs` | 16/16 | JSON 重试、视觉/Files、工具上限后无工具总结、`chat.ask` 逐字校验 |
| `test/98-v2-deepseek-http-guard.test.mjs` | 6/6 | DeepSeek/视觉接口权限与返回纪律 |
| `test/109-v2-deepseek-independent.test.mjs` | 13/13 | 未修改文件，独立断言原样保留（SHA-256 仍为 `741BF2329153DCA1CBFF821EE93A39EA03D7982BE51A0979D0C2F10EA74013F1`） |
| `test/110-v2-deepseek-live-fixes-independent.test.mjs` | 10/10 | 空区间日期、实际 MAX 日期、官方联网过滤、公开详情范围、工具上限/截断重试/401、连接测试配额与日志、Search/Fetch 真实能力字段 |
| `test/66-v2-chat-evidence.test.mjs` | 12/12 | 既有问答证据/引句/数值校验回归 |
| `test/91-v2-chat-evidence-independent.test.mjs` | 通过 | 独立小数/引句配对回归 |
| `test/43-v2-ocr-frontend.test.mjs` | 7/7 | DeepSeek 能力页与 OCR 前端渲染 |

另对修改的 `.mjs` 与 `web/v2/modules/admin.js` 执行了 `node --check`，均通过。

### 11.4 未做与边界

- 未重新调用真实 DeepSeek，未启动长期服务，未部署云端；真实 Search/Fetch、工具问答、浏览器验收仍由 Codex 按 docs/56 执行。
- 未修改 `test/109` 的任何断言；未删除或放宽既有业务断言。
- 未修改 `docs/54` 的原始开发边界。


## 12. Codex最终验收与补充修正

真实调用、数值独立复算、浏览器、配置保护、后续小修复与限制以docs/56末尾“最终验收结果”为准。专项共65项通过，相关既有回归通过；真实HTTP15项、正向官方联网回答、官方PDF单页视觉已通过。原有官方Key可直接复用。Codex补充了视觉原文保护、实际来源快照外键修复、统计日期口径、最终历史上下文及程序汇总优先、未来实际行情前置拒答、区间行情引用跳转和窄屏/历史文案修正。本地8921使用独立验收库，等待用户复核，未部署云端。
