# DeepSeek 能力扩展：开发与验收要求

2026-10-19。用户已授权按上一轮建议新增开发，并询问已保存的API Key能否复用。本轮由DSH本地开发，Codex独立核验；保持此前本地验证、用户复核、再部署的流程。本轮不访问或修改云端。

## 目标与边界

平台是公开碳市场资料整合服务，已有CCER、CEA、因子/标准、公开项目、资讯、测算、AI问答和后台。保留已验收绿色前端及现有角色权限，不恢复自有项目管理、人工复核或无依据确认功能。

本轮实现：DeepSeek搜索/抓取备用通道、复杂文档图像理解补充、工具化多轮AI问答、JSON输出可靠性加固。配套支持按任务控制思考模式、观测输入缓存及各能力预算。Files API用于确有需要的图片复用，不做无用的独立文件管理页面。前缀续写和FIM不在范围。

## 当前工程锚点

- Node.js ESM，内置SQLite、fetch，无框架依赖；package.json要求Node>=22.5，本机Node24。沿用当前路由、数据访问、迁移和独立测试运行器。
- src/core/secrets.mjs:395 resolveStoredCredential；src/services/admin-v2-svc.mjs:345 resolveCredential。凭据在服务端AES-GCM加密，credential_ref是环境变量名，不能拿来填写Key值。
- src/services/search-svc.mjs：SEARCH_KINDS、upsertSearchProvider、buildSearchRequest、normalizeSearchResults、runSearch、pickSearchProvider、testSearchProvider。
- src/services/web-fetch-svc.mjs：FETCH_KINDS、upsertFetchConnection、fetchUrlContent、pickFetchConnection、testFetchConnection。保留原有出站、配额、超时、MCP授权纪律。
- src/services/chat-svc.mjs：现有引用式AI问答；src/services/summary-svc.mjs：当前摘要、缓存键、持久任务与失效检测；src/services/verification-svc.mjs：模型与引用核验；沿用而非另造平行问答系统。
- src/services/pdf-parse-svc.mjs、baidu-ocr-svc.mjs、ocr-backfill-svc.mjs：文本提取、OCR、逐页解析与归档。
- src/routes-v2.mjs及现有后台/平台路由，web/v2/modules/admin.js、web/v2/platform.js、当前摘要/问答前端。
- 现有有意义回归：test/65、66、67、68、69、90、91、94以及搜索、抓取、OCR相关用例。只选择被改行为需要的用例。
- 项目已有.dsh/skills/frontend-design、impeccable、webapp-testing。前端遵守这些skill及DESIGN.md，保持现有绿色、清爽信息终端风格。

## 官方依据（先阅读，不凭记忆实现）

1. Search/Fetch：https://api-docs.deepseek.com/zh-cn/guides/search/ ，以及 /zh-cn/api/search/、/zh-cn/api/fetch/。
   - POST https://api.deepseek.com/v1/tools/search，Bearer鉴权；query、count、need_content、ori_question；query最长128Unicode字符，count 1—50。
   - POST https://api.deepseek.com/v1/tools/fetch，JSON {url}，返回title、content（Markdown）。
   - 分别按成功有结果请求计费，当前均5元/千次；账号各5 QPS，Fetch另有目标域名限制。价格页面为依据，界面不能承诺永久价。
   - 408/429/5xx有限退避，402停止预算调用，其他4xx原样重试没有意义。超时共享整批deadline。
2. 图像：https://api-docs.deepseek.com/zh-cn/guides/vision/ 。deepseek-flash支持JPEG/PNG/GIF/WebP，可base64、公开图片URL、file_id；不要假定Pro支持视觉。图像缩放可能丢失小字，需要按页/区域处理。
3. Files：https://api-docs.deepseek.com/zh-cn/guides/files_api/ 。POST /files multipart，purpose=user_data，仅图片；可指定expires_after，DELETE /files/:id。不是PDF/Word通用解析接口。
4. 工具：https://api-docs.deepseek.com/zh-cn/guides/tool_calls/ 。模型返回调用建议，服务端实际执行白名单函数。strict为Beta，只能在独立能力配置中显式启用，不能全局更改现有模型base URL。
5. JSON：https://api-docs.deepseek.com/zh-cn/guides/json_mode/ 。response_format={type:json_object}；提示包含json与格式示例；仍可能空内容或截断。
6. 思考：https://api-docs.deepseek.com/zh-cn/guides/thinking_mode/ 。thinking.enabled/disabled与reasoning_effort；本轮对简单摘要显式关闭、复杂分析按需开启。携带tools时必须正确保留协议要求的reasoning_content，不将它展示为用户答案/证据。
7. 多轮：https://api-docs.deepseek.com/zh-cn/guides/multi_round_chat/ 。API无状态，需要客户端/服务端传递历史；不能将Key或其他用户会话拼入请求。
8. 缓存：https://api-docs.deepseek.com/zh-cn/guides/kv_cache/ 。默认启用，固定公共前缀并记录usage的cache_hit/miss，不能把输入缓存当成事实库或输出缓存。

## A. 复用已保存的官方DeepSeek凭据

- 增加明确的“引用现有模型凭据”关系（provider_id），服务端调用时通过既有resolveCredential读取。不得复制明文Key到新表、前端、日志、文档或env示例；不得要求用户重复填Key。
- 可选绑定必须是有效、启用的官方https://api.deepseek.com模型配置；不把代理商/自建接口Key转发给DeepSeek。域名、协议和固定endpoint服务端校验，跟随重定向不得携带鉴权到其他host。
- 后台仅展示模型名称/ID、引用关系、是否配置/可调用；配置和测试API均admin-only。普通用户、匿名不得读取密文/明文、服务端路径或请求头。
- 新字段迁移须幂等，兼容既有Bocha、Firecrawl、百度OCR及旧凭据。编辑关联模型Key后引用自动使用新值；关联配置不可用时真实显示原因。
- 以现有模型配置引用方式自动提供一套初始DeepSeek能力配置。不要后台创建多份同名服务，不默认替换用户已配置主服务；默认fallback明确可控，迁移不能覆盖已有设置。

## B. DeepSeek Search/Fetch 与真正接入采集链

- 支持搜索与抓取两个独立能力的启用、测试、额度、超时、失败分类、最近调用/成功时间、用量。可复用现有search_provider/web_fetch_connection结构，新增引用字段与官方类型。
- 成功返回必须走既有规范化、快照/来源留痕与去重。Search摘要与Fetch正文分开，不凭搜索摘要宣布已读全文，不因多引擎返回同一URL而当作多源验证。
- 接入公开资讯采集与AI问答联网路径：主服务失败/无结果/缺正文时根据配置尝试备用；404等既有失败日志保留，备用成功另记。限制整体尝试次数、请求总数和总时长；不是只加一个后台测试按钮。
- fetch目标需是允许的公开HTTP(S)地址，拒绝私网、localhost、凭据URL、metadata地址、危险重定向；不能让模型传任意服务器URL后发送管理员Key。
- 同源官方接口/直连继续可用；不得破坏既有CEA/CCER官方数值采集口径。

## C. 文档视觉补充与Files复用

- PDF文本层优先，百度OCR保留；某页抽取/OCR为空、质量不足或复杂表格时，可在已启用、预算允许时调用DeepSeek Flash视觉补充。管理员可手动对已有受限文档的指定页触发，不能伪造“已解析”。
- PDF先通过既有异步有界转换工具转成页图。每文档页数、图片字节、单页/整批时间有硬上限；Windows/云端工具缺失时给出可操作错误，不能同步无限转换耗尽2GB服务器。
- 结果保留原文件hash、物理页码、图像hash、工具/model、结构化文字/表格及限制说明；区分机器抽取与模型理解。单位/数量关系与原文校验，不能从图像推算没有披露的数字，不自动改写正式因子。
- 视觉输出只能作为有明确页图依据的抽取材料，不能把模型推断当作官方事实。识别结果接回现有逐页文档归档/核验流程，使其能用于检索与摘要。
- 默认单次base64传图即可；如实现Files复用，按图片hash+凭据归属缓存file_id，设置有限有效期、过期重传/删除、独立测试与配额，不上传整个PDF，不额外搭建文件管理服务界面。

## D. 受约束的工具化多轮问答

- 扩展现有AI窗口，保留已有库内优先、联网补充、引用核验、中文展示。不要另做一个仅靠模型自由回答的聊天页面。
- 白名单只读工具至少包含：库内资料检索/详情、CEA/CCER按日期行情、程序化区间统计、公开网页搜索/抓取；可调用现有估算器，但必须传明确参数、单位，缺参询问，不让模型发明公式/数值。库内工具不可接受任意SQL、代码、文件路径或后台写操作。
- 参数用服务端schema/范围校验，工具最多4轮、总调用数/总时长有限，达到限制返回已有证据与缺口。权限与配额在服务端落实，不信任模型给出的用户角色。
- 每个工具结果转成既有证据结构，引用必须指向实际返回的记录、URL/页码/摘录，回答数字可回溯。拒绝捏造引用、无材料作确定性回答或听从外部网页中的操作指令。
- 多轮只保留当前用户会话、当前问题必要上下文与证据，追问“只看官方”“对比上年”有效；修订时间/市场后重新查询，不能复用过期价格。兼容旧前端单轮请求，现有匿名401、普通用户后台403保持。
- 前端显示正在查库/联网/计算等实际阶段，答案有来源和截至日期；不展示思维链或内部prompt。现有视觉风格、移动端可用性不回退。

## E. JSON可靠性、思考和缓存

- 摘要/抽取等结构化任务统一检查JSON语法、必填字段、内容长度/类型，处理空content、finish_reason=length或截断、非JSON包装。保持现有Unicode与引用回归。
- 只对可恢复失败有限重试（最多一次），适当增大输出预算或简化提示；401/402/403不盲目重试。失败单条留痕并继续后续条目，不能把整批故障隐藏为成功，不采用无界续写。
- 按purpose配置思考开关/强度，摘要默认非思考、复杂对比可思考。记录调用延迟、token/cache命中、工具次数及成功/失败；只在实际有计费字段/明确单价时估算费用，并注明估算，不声称免费。
- 不把所有模型请求切到Beta，不破坏普通OpenAI兼容/Ollama等既有配置。

## 验收与交付

1. 先阅读本文件、相关官方文档及当前代码。不得启动Codex/其他代理或并行子代理，不部署、不使用生产/本地实际Key，不读取凭据值，不运行全量采集。Codex负责真实联网最小验收。
2. 新增有行为意义的隔离测试：凭据引用/轮换及权限；Search/Fetch真实响应格式适配与失败回退接入；私网/重定向拒绝；视觉逐页回退、缺工具/限额/Files生命周期；工具参数/轮次/会话隔离/引用证据；JSON截断/空值/单次重试/Unicode。测试桩用于协议和故障行为，不得冒充真实服务可用性。
3. 与修改点相关回归通过，JS语法检查通过。补充一组可由Codex使用真实本地数据和真实模型执行的小型验收脚本/清单，覆盖库内查价、CEA/CCER分市场统计、联网补证、缺证拒答、多轮筛选、视觉已知测试页；不得把模拟响应称为真实验收。
4. 后台能操作新增能力的引用、测试、配置，普通用户能在现有AI窗口使用工具问答，视觉补充有实际管理员入口并能接回文档链；只写服务函数或静态前端不算交付。
5. 新建docs/55-DeepSeek能力扩展实施记录.md，列出修改文件、迁移、默认值、真实/模拟测试区分、已实现与限制、官方来源；更新必要产品说明。禁止写任何Key。
6. 代码变化前快照：data/backups/deepseek-capabilities-20261019/code-before.tar.gz；本地独立库快照local-before.db。不得覆盖/删除这些备份或现有数据。开发完停止，不启动长期服务，不自行发布云端。

## Codex同步独立复核补充

Codex已新增`test/109-v2-deepseek-independent.test.mjs`，全部使用临时库与无外网fetch夹具，初次实跑9项失败。开发结束前一并阅读并修复，不能删除或放宽这些业务断言来通过：

- 凭据引用不得用于非DeepSeek类型或其它目标host；Files删除也须校验官方绑定。
- 拒绝IPv6私网、mapped IPv6和尾点localhost目标。
- 管理员显式解绑provider_id:null不能被初始化重新绑定。
- deadlineAt:null按未提供处理；第一源超时后仍须保留备用窗口。
- 某账号402只停止该账号通道，独立厂商的备用仍可尝试。
- 项目created_at是收录时间，不能充作官方发布日期；详情工具不能读取演示项目充作公开事实。

其他已发现待核对项记录在`data/backups/deepseek-capabilities-20261019/independent-review-notes.md`，包括实际来源通道留痕、快照外键、按能力实测按钮、公共记录有效范围及CEA统计口径。
