# CEA 独立验收追加问题

Codex在阶段B开发期间只读检查发现。阶段B结束后交给DSH继续修复，不与正在编辑的任务并发写代码。

## 发布前必须解决

1. **JSON请求日期必须与响应一致。** `collectCeaJsonDaily`用请求参数d写入trade_date，却没有判定quote.trade_date、stat.trade_date是否等于d。若上游忽略查询日期或缓存串日，会把其他日期行情写成请求日期。每个通道分别核对日期，串日通道不入该日字段，登记可追溯缺口；同日正确通道可以保留为partial。parseSubStat还需确认COMCEA汇总行的日期一致、方式不重复、方式缺失保持未知而不是把少数行合成完整总量。用真实响应改动日期/删一行/重复一行做故障夹具，验证不会制造完整日统计。

2. **剩余deadline必须传到实际网络和重试。** 已修callVerifyModel，但collectCeaJsonDaily内多个fetchJsonChannel仍用完整cfg.request_timeout_ms，collectCeaIntentions未接受deadlineAt；research传fetchUrlContent opts.timeoutMs但该函数实际忽略它（direct_http、Firecrawl REST、MCP三个分支均采用conn原值），runSearch也忽略剩余deadline且重试重置时限。让CEA批次统一传deadlineAt，底层兼容可选opts.deadlineAt/timeoutMs/AbortSignal，每次请求、MCP初始化与工具调用、重试等待均不超出剩余时间。超限收尾真实任务，不仅Promise.race提前返回留下继续写库的后台请求。补慢响应测试覆盖模型+JSON/搜索+MCP路径；默认非CEA调用保持兼容。

3. **research后台指定服务必须生效。** collectCeaResearch使用pickSearchProvider()、pickFetchConnection()，没有读cfg.search_provider_id和fetch_connection_id；与后台状态显示的服务可能不一致。按配置选择实际服务，指定服务不存在/禁用应明确失败，不能悄悄切另一个；验证config保存和实际调用选中的两个服务。

4. **research CEA配额及异常任务收尾。** research检验ceaQuotaState但获取正文后没有计入CEA当日调用数，可能绕过CEA daily_fetch_limit；网络失败尝试也要按定义计数。主体未加try/catch/finally，异常可能留running，靠30分钟扫僵死任务不能代替本次收尾。job.reused分支现在closeCeaJob会把另一个仍运行的任务标结束，重入不得关闭原任务。请一并检查其他CEA采集器的reused分支，保持任务唯一和真实状态。

5. **研报截止日期不补造日。** deriveResearchMeta把“截至2023年12月”写成2023-12-01，把“截至2023年”写成2023-12-01带说明；原文精度不足时不应生成精确日期。保留原文cutoff值或YYYY/YYYY-MM并记录precision；有明确年月日才YYYY-MM-DD。需要兼容新增schema字段、展示与导出；全文里的业务日期不得随意当发布日期。转载站原始出处未知时first_source_url应为null，当前页面URL另存，不能把转载页写成第一来源后只在备注否认。

6. **管理员采集立即返回任务。** 阶段B当前POST /api/v2/admin/cea/collect仍直接await外部采集，UI请求可能等待120秒而反代超时，未达到34的task_id约定。改后台异步启动有界任务，POST立即返回202/task_id，GET后台jobs能看到queued/running/结束与错误；任务重入合并，不多抓、不把旧运行任务提前关闭。补慢采集响应测试，保证普通用户仍403。UI按实际task_id轮询，并展示失败原因；无采集结果时不得显示完成。

7. **收盘后配置需要真实调度。** 当前after_close_enabled/after_close_time只有配置、校验和状态显示，daily-scheduler只有06:30定时器。落实北京时间默认16:30的CEA轻量增量更新（至少行情+意向、任务共享deadline），与早上全平台更新分开。CCER_DAILY_SYNC=0要一并停用，本地开发不得误触发；后台改开关/时间后要实际生效并显示下一次运行时间。保护重入，stopDailyScheduler停止所有新定时器，测试时区跨天、关闭和动态配置，不改既有06:30更新。

8. **成本表单P2不能用CEA报价。** 当前priceField给P1/P2同一行情选择，applyMarketPrice两者都取CEA latest，P2用提示承认它是CEA价。这个控件应修成读取CCER独立交易接口的可用报价/计算均价并标注CCER日期、来源、口径；如无可靠CCER参考则仅手动输入并说明缺失。不能让CCER价格下拉带入CEA指数。验证真实浏览器选择P2数据来自CCER，与P1不同来源；计算结果、输入参数与结果来源文案一致。研究资料在政策列表的状态应用“已发布/研究观点”，不能显示“现行正式规则”；官方通知标题保留完整原名。

9. **文件采集后的默认AI核验需实际触发。** 干净库配置auto_verify=true、模型真实可用，采集5个CEA政策原件后界面4个全文仍全部ai_status=unverified。collectCeaDocuments未调用verifyCeaDocuments，默认verifyAllBatch的scopes也不含CEA。把本批实际取得全文的CEA文件按共享deadline送入既有模型核验，并对预算不足的已入库待核验条目于每日后续有界补跑。真实无法核实保留insufficient/unavailable，不能仅把日期规则通过当模型通过。至少以本地一个官方文件的实际LLM日志证明自动调用，不要求反复强制同一证据。

## 17:00之后的独立故障注入追加

- `data/backups/cea-20261014/independent-fault-check.mjs`：串日、缺方式、重复方式、年度行额外增加已通过；仍有两项失败。tradeMethod=20的tradeVolume=null时parseSubStat过滤掉null再把其他方式加成“完整总量”，应针对每个累计/总量字段要求三方法全部披露才给该字段合计；其余已完整的字段可单独保留。queryMarketByDate只有CEA25、没有COMCEA时仍ok，应拒绝拿年度标的冒充综合行情。请跑这个独立脚本，保留正确夹具，不改弱断言。
- 日历来源真实更正：旧holidays.json 101项包含10月14日，最新独立holidays-current.json 100项已删该日（参见33）。当前upsertCeaCalendarDates只增改，旧库中的被来源删除日期会继续作为“当前机器列表”并永久告警。每次成功完整来源快照需同步当前有效集合，保留旧证据/快照但标为过期，reconcile/list仅用当前有效集合；失败/不完整结果不能清空原集合。新增101→100的变化测试，历史原文仍可追溯，当前异常自动结清。

## 已通过的Codex独立检查（不需要反复外部调用）

- 两份完整官方HTML日报，准确到日期、OHLC、分方式量额、年度及历史累计。
- 69条真实交易意向，47买入/22卖出，方向错误0。
- 官方历史价格末120个点，逐点核对OHLC，不生成成交额/全方式成交量。
- 正式2026休市公告7个范围、33休市日、7开市日、6明示周末日均正确，10月14日不属于正式休市范围。
- 干净验收库真实采集7月30日、8月11日、10月13/14日已由实际DeepSeek核验；原始v2库mtime与文件大小未变。
- 真实HTTP验收10组通过：既有管理员密码登录、普通注册与固定viewer角色、未登录401、普通用户管理403、行情金标准、非法参数400、导出、同日缺失null、成本情景负差额、旧模块API回归。

验收记录在data/backups/cea-20261014/independent-*.json。干净验收服务目前由Codex监听8912（库cea-review-20261014.db），DSH只使用开发库及独立端口，不能修改验收库、旧v2库或云端。
