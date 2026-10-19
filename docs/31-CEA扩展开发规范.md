# CEA 扩展开发规范

日期：2026-10-14。产品负责人和独立验收：Codex；实现负责人：本机 DeepSeek Harness（DSH）。

用户已授权：按公开资料研究建议实现 CEA 功能，编写开发文档，直接交由 DSH 开发；Codex 跟踪与独立核验；本地测试通过后更新云服务器。本文件覆盖旧文档与本任务冲突的约定。

## 产品范围

平台整合全国碳排放配额 CEA 与全国温室气体自愿减排 CCER 的公开信息。对象为投资机构和项目筛选团队。CEA 是配额与履约市场，不能仿造 CCER 项目方法学结构。所有统计必须注明来源、数据截止日、品种、年度与价格口径。

本次交付范围：

1. CEA 日行情、交易方式结构、历史序列、区间汇总、CSV/JSON 下载。
2. CEA 政策和配额规则库，按行业、适用年度、文档状态筛选；保留原始文件和版本。
3. 履约日历，区分排放年度、配额年度、执行日期和纳管名录年度。
4. CEA/CCER 同日价格对比，分别展示官方综合收盘价与程序计算的成交均价。
5. 重点排放单位公开名录及公开交易意向的基础检索、来源覆盖与缺口状态。不要求一次抓齐所有省份，但必须真实采集可获取的样本并给出覆盖数。
6. CEA 研报与行业动态，复用已配置搜索、抓取和大模型服务。
7. 轻量履约成本情景工具，输入为临时情景参数，不建私有企业或项目台账。
8. 管理员采集配置、自动补证/核对、运行记录；普通用户只能看公开信息与使用无持久化的情景工具。

不承诺公开数据没有提供的实时盘口、逐笔交易对手、企业持仓、全量企业实际盈缺。未披露字段为 null；不能用 AI 推测后冒充事实。

## 官方来源清单（已完成公开资料初查）

|代码|用途|地址|说明|
|---|---|---|---|
|cea_daily_2026|官方日行情目录|https://overview.cneeex.com/qgtpfqjy/mrgk/2026n/|列表可能动态加载，使用配置服务补采；不要编造页面URL|
|cea_daily_query|官方查询页|https://shyx.cneeex.com/qdata.html|存在日期与标的选择；未公开API协议不能宣称已接入授权行情API|
|cea_daily_sample_1|真实日报样本|https://overview.cneeex.com/c/2026-07-30/498086.shtml|OHLC、挂牌/大宗/单向竞价、日/年/历史累计|
|cea_daily_sample_2|真实日报样本|https://overview.cneeex.com/c/2026-08-11/498128.shtml|用于独立验证解析结果|
|cea_monthly|官方月报目录|https://overview.cneeex.com/qgtpfqjy/jysj/ydgk/2026n/|月报必须单独标记period，不能混入每日数据|
|cea_price_regime|2026版行情编制方案|https://overview.cneeex.com/c/2025-12-29/496985.shtml|2026-01-05起CEA25权重1，其他年度权重0|
|cea_allocation|最新正式分配方案|https://www.mee.gov.cn/xxgk2018/xxgk/xxgk03/202609/t20260903_1165029.html|国环规气候〔2026〕1号，印发日2026-09-01|
|cea_allocation_pdf|官方配额原件|https://www.mee.gov.cn/xxgk2018/xxgk/xxgk03/202609/W020260903551498752549.pdf|发电2025/2026；钢铁水泥铝冶炼2026，不能误用于2025新增行业|
|cea_annual_work|年度管理工作|https://www.mee.gov.cn/xxgk2018/xxgk/xxgk06/202602/t20260209_1143900.html|2025年度清缴2026-12-31，2027名录公布2026-10-31；后续修订优先|
|cea_carryover|配额结转|https://overview.cneeex.com/c/2026-01-04/497013.shtml|时效性规则，过期仍作为历史保留|
|cea_intentions|公开交易意向|https://shyx.cneeex.com/|意向不等于成交，不计入成交额/量|
|cea_entity_fujian_2026|省级名录样本|https://sthjt.fujian.gov.cn/zwgk/gsgg/202510/P020251030551328818102.pdf|PDF可能获取失败，失败就登记缺口；可通过搜索找到官方HTML/其他省官方样本|
|cea_research_iigf|公开研究原文|https://iigf.cufe.edu.cn/info/1012/10973.htm|2025中国碳市场年报；属于研究观点，不是现行规则|
|cea_annual_closures_2026|正式全国CEA休市公告|https://overview.cneeex.com/c/2025-12-24/496961.shtml|沪环境交〔2025〕44号；优先于日期选择器的机器辅助列表|

真实网页、PDF或接口响应须保存来源快照/哈希及获取时间。测试夹具必须注明来源与采集日期；模拟数据只能进入临时测试库。不要创建任何能被误认为正式交易日行情的生产种子行情。

### 独立取样新增：官方网页使用的公开JSON（2026-10-14实测200）

Codex读取官网公开 pa-home.js、pa-qdata.js、common.js 后直接调用网站自己使用的无登录公共数据路径，响应与源码已保存到 data/backups/cea-20261014/acceptance-sources/。这不是商用行情API授权承诺；上游结构变更需如实报错。

- GET https://shyx.cneeex.com/assets/json/hiskline.json：历史数组，首元素为日期。优先用于发现真正交易日及最近日期；其中数量不能擅自当全国全方式成交量。
- GET https://shyx.cneeex.com/assets/json/dailyov.json：最新日期/OHLC和概览，数量/金额含“万吨/亿元/亿吨”的四舍五入展示值。仅作为概览/交叉核对，不能覆盖精确原始成交量额。
- POST https://shyx.cneeex.com/gateway/common/queryMarketByDate：JSON请求 `{ "tradeDate":"20261013", "goodsCode":"COMCEA" }`；success=true时data[0]包含subjCode、quotPoin、openPric/highPric/lowPric/closPric/lastClosPric/chanRate。其dealQty/dealAmt是挂牌口径，不能当全方式成交。其他字段名有复用，不能按averPric名称推定为均价。
- POST https://shyx.cneeex.com/gateway/common/querySubStat：JSON请求 `{ "tradeDate":"20261013" }`；data包含年度标的及COMCEA汇总。tradeMethod 10挂牌、20大宗、21单向竞价（语义由官网displayStat源码确认）。取COMCEA三行聚合volume/amount/year/total，不再把年度行与COMCEA重复相加。
- GET https://shyx.cneeex.com/assets/json/tradeIntent.json：真实意向列表，id、startTime、goodsName、dir、volume、areaName。独立原始69条样本仅含dir=1和dir=2，结合官网显示源码证明1为买入、2为卖出；其他值应null/未识别，不能猜为卖出或假定0为正常卖出。
- GET https://shyx.cneeex.com/assets/json/holidays.json：官方查询页使用的非周末休市日期，允许加入CEA独立日历证据。

2026-10-13独立实测：综合open99/high99/low97.80/close98.25/change-0.15%；挂牌1224197吨/120276511.33元，大宗1749245吨/167737299.35元，竞价0；总2973442吨/288013810.68元。COMCEA累计分项相加年成交134207049吨/11626412779.18元，历史999073569吨/69289031010.75元。dailyov仅显示297.34万吨/2.88亿元，因此单位换算并不等同于精确成交值。

新增CEA-16验收：上述最新公开JSON真实取样，分项聚合不重复，保留精确数值与概览舍入层级，网站业务码失败不按HTTP200假定成功。源目录可能滞后（本次原始目录最新仅2026-08-14），必须用公开JSON发现当前行情日期；不能宣称目录老数据是最新市场数据。

2026-10-14独立复核：holidays.json将10月14日列为休市，同时官方queryMarketByDate/querySubStat/hiskline有该日交易记录。正式全国CEA全年休市公告（沪环境交〔2025〕44号）公布的国庆休市范围为10月1日至7日、10月8日起开市。保留机器列表异常原文与自动告警；日历应以正式公告和实际交易证据核对，不能让一个机器辅助列表把实际交易日改成已确认休市，也不能把该异常直接判成行情数值不真实。不创建人工确认任务。

## 页面与交互

当前应用实际为七个主模块：总览、政策和方法学、公开项目、交易信息、减排粗估、研报与行业动态、后台管理。允许增加独立“CEA市场”专题作为入口，并在已有模块加明确的CEA入口/切换，避免两套业务数据重复维护。

CEA专题含行情、政策配额、履约日历、企业名录、交易意向、成本情景页签。总览增加CEA卡片；交易页可切换CEA/CCER/对比；政策页增加CEA入口；项目页区分CCER项目与CEA单位名录；内容页支持CEA筛选；粗估页链接成本情景。所有新增入口必须可点击并具有空/加载/失败状态。

行情图：综合收盘价折线、成交量柱形、交易方式占比、区间成交额/量和加权均价。显示元/吨、吨、元，万吨/亿元仅用于展示。K线仅在来源确实提供OHLC且语义明确时使用。支持日期范围、表格分页、下载和来源钻取。用户看得到数据截止日和缺失/未核验状态。

CEA/CCER对比默认仅同日连接；任一品种缺数据时该点为null，不沿用前值冒充同日交易，不填0。CEA综合收盘价、CEA全方式计算均价、CCER计算均价必须不同字段/图例。价差仅是不同市场报价的比较，不标为确定套利收益。

企业名录按省、行业、名录年度检索；以统一社会信用代码与名录年度建立标识，名称变化保留来源，不能合并集团旗下不同法人/分公司。名录数量不等于买家数量。交易意向保留配额年度、方向、数量、发布日期、来源；公开未给价格或主体时为null。

界面延续现有登录、权限、字体、图表库，优化视觉层次和手机布局，不引入大型框架。DSH可用本项目 .dsh/skills/frontend-design 和 webapp-testing。

## 数据模型和口径

使用增量SQLite迁移；新增CEA独立交易表，避免扩展CCER trade_daily导致累计数/字段混用。建议新增 schema-cea.sql，并在CCER_ENABLE_V2=1下幂等加载。

最低字段：

- cea_trade_daily：id、trade_date、instrument/market_scope、price_regime、open/high/low/close/change_pct、挂牌/大宗/竞价 volume/turnover、total_volume/turnover、year_volume/turnover、lifetime_volume/turnover、source_url/snapshot_id/content_hash/fetched_at、parse_status/verification_status/revision。金额统一元，数量吨。保持原文值与推导值分列。
- cea_source：code、url、dataset、allowed_domains、enabled、priority、last_success_at、last_attempt_at、last_error；源地址变更必须经URL白名单与SSRF检查。
- cea_document（或复用带market_scope的现有文档）：type policy/technical/research/news、title、doc_number、issuer、publish/effective_date、covered_sectors、applicable_years、formal/draft/historical、official_url、body_snapshot、attachment/path/hash、AI状态/摘要、版本。
- 对跨行业且不同年度生效的文件必须存行业/年度配对（coverage_json或关联表），不能把covered_sectors×applicable_years做笛卡尔积。例如2026年9月分配方案的钢铁2025不适用，发电2025适用。
- cea_event：事件类型、deadline、emission_year/quota_year/list_year、industry、source_document_id、原文片段、日期提取/核验状态。不能只按标题年份识别履约年度。
- cea_entity：name、credit_code、province/city、sector、list_year、new/existing/exit、source_url/hash、数据截止日/核验状态。
- cea_intention：source_id、published_date、instrument_label/quota_year、buy/sell、volume、price可空、participant可空、source_url/hash、last_seen_at；不能写入成交表。
- 来源与AI调用可复用已有source_snapshot、dataset_cursor、ingestion_job、verification_result及审计，不能储存明文API密钥。

最低确定性核对：量价金额非负，OHLC上下界自洽；有完整交易方式时校验分项合计等于官方总量/额（考虑最小币单位舍入）；本期累计算差前确认区间覆盖完整；累计上升不能自动推断漏采日交易值；无成交时计算均价=null。若综合指数收盘存在而全方式均价不同，不得判为冲突。

2026年版综合行情是年度标的价格的指定权重指数，不是全方式量加权均价。存储 `price_regime=CEA_COMPOSITE_2026`；2026-01-05起当前样本权重指向CEA25。2025旧口径保留标记，未来变更通过版本升级。

## 采集、AI核验与每日调度

优先官方HTML/PDF；搜索只用于发现候选URL/补证，搜索摘要不能替代阅读全文。复用 pickSearchProvider/runSearch、pickFetchConnection/fetchUrlContent、verifyConfig/pickVerifyProvider/callVerifyModel/validateCitations。优先选择后台已启用且凭据可用的服务，不建立新密钥输入流程。

动态列表失败时可以使用博查检索指定官方域名，随后实际读取命中原文再入库。Firecrawl是正文获取后备；无服务、鉴权失败、超时、空结果分别记录。AI仅能依据提供原文/连续引文核对结构化数据和摘要；证据不足为insufficient，服务失败为unavailable，矛盾为conflict；不得因“来自官方”直接伪造模型核验通过。网页提示注入只作为数据处理。

AI结论缓存绑定输入哈希、模型和策略。每次有新正文再核验；不能用循环次数替代证据。有界默认：1轮新增采集+最多2轮补证、每轮≤8条；单个任务必须有总时间与数量上限（建议≤120秒首期CEA批次，超限留待次日，不阻塞CCER每日任务）。配置超时、日限额和抓取数量要服务端校验。

CEA每日校准接入现有06:30任务，并允许管理员手动增量采集。另可增加北京时间收盘后采集：设计默认16:30、需有重入保护，不改变既有CCER调度。某一来源失败不能中断全站采集或把上一日行情标成当日。浏览器操作只启动后台有界任务/立即返回状态，不能卡住前端数分钟。

政策最新正式文件、历史文件、征求意见稿分列；日期由原文核对。只根据明确修订关系关联版本，不凭模型把旧记录删掉。获取不到PDF时允许管理员上传，上传副本保留来源层级，自动解析/模型核对沿用现有补充机制。若选择独立cea_document需扩展上传target类型和每日重试，普通用户必须403。

同一正式政策的通知HTML和附件PDF关联为一个政策及其附件，不以两个“政策”增加计数。必须保留官方完整标题，不能将跨行业/年度的复杂名称缩写成会误导适用范围的标题。干净可提取文字的官方PDF须自动使用已安装pdftotext解析；扫描件自动解析失败保留“已下载但无法识别”，允许管理员上传副本/OCR补充，不能把二进制转字符串当正文。

## 成本情景（无持久化）

输入：应清缴量E、可用于该年度清缴的配额A、符合该年度规则的CCER可用数量C、已使用抵销量U、抵销比例r、参考CEA价格P1、CCER价格P2及新增费用。

缺口D=max(E-A,0)；可抵销数量Q=min(D,C,max(E*r-U,0))。用户输入选择已获证据支持的比例或明确“自定义情景假设”；不得把历史5%无条件写成所有年度现行规则。

仅买CEA成本=D*P1；组合参考成本=(D-Q)*P1+Q*P2+新增费用。差额是情景结果，可能为负，不自动建议购买，不等于真实成交/最终履约费用。所有输入必须有限、非负，比例范围0..1，U>E*r时剩余抵销额度0。缺省价格来源与日期显示，允许用户明确覆盖参考价格。参数不写入用户台账。

## API契约（建议，可在兼容前提下合理细化）

登录用户只读：GET /api/v2/cea/overview、/trade、/series、/comparison、/documents、/documents/:id、/events、/entities、/intentions、/sources/status；GET /api/v2/cea/export?dataset=trade|entities|intentions&format=csv|json&from=&to=。

所有登录用户POST /api/v2/cea/scenario：仅计算，无持久化、无采集/配置副作用，遵守现有同源检查。

管理员：GET/POST /api/v2/admin/cea/config、POST /api/v2/admin/cea/collect、GET /api/v2/admin/cea/jobs。写接口复用guard和requireRole，非admin返回403。现有后台前缀统一admin守卫不可削弱。请求响应不能暴露凭据/会话令牌/本地密钥路径。导出CSV处理以=,+,-,@或制表符开头文本的公式注入，列名/单位/口径稳定且可审计。

## 分阶段交付与责任

阶段A（DSH）：增量数据结构、数据服务、官方真实原文解析与有界采集、缓存AI核验、API、CLI和隔离测试。提供31/32文档对应记录。只写本地代码与临时/cea-dev数据库，不部署云端。

阶段B（DSH）：CEA专题界面、现有模块入口/总览、管理配置与任务进度、对比图表与导出、轻量情景、第二层信息基础展示。保持登录流程和普通用户后台隔离。完成真实采集样本与实际命令记录。

阶段C（Codex）：独立代码检查、迁移重入与旧数据保留、真实采集字段对照、服务调用真实性、API权限、浏览器与导出验收；修复未过项目后再部署。不得把DSH自报“完成”当验收。

## 验收用例与发布门禁

|编号|必须通过的检查|
|---|---|
|CEA-01|重复迁移不丢旧CCER数据、账号、凭据、附件；旧data/ccer.db未读写|
|CEA-02|2026-07-30样本：open96.00/high97.00/low95.90/close96.61/change1.00%；挂牌544313吨/52585579元，大宗500000吨/47575000元，无单向竞价；总1044313吨/100160579元；年68966986吨/5499968391.61元；历史933833506吨/63162586623.18元|
|CEA-03|2026-08-11样本：open98.30/high98.50/low98.30/close98.32/change-0.20%；总344814吨/33879216.20元；挂牌244814吨/24069216.20元，大宗100000吨/9810000元|
|CEA-04|解析正确区分万吨/亿元、数字千分位、无竞价与字段未披露；月报不能进入日行情；body无目标内容则失败，不能生成零值|
|CEA-05|全方式均价与综合收盘价不同不误报；缺日期不补0、不自动前填；同日对比保留日期和口径|
|CEA-06|来源修订保存revision与快照，同URL同哈希重采幂等；不根据模型覆盖官方数值|
|CEA-07|普通用户能看CEA各页、运行情景/下载；所有管理员配置/采集/上传入口对普通用户403；未登录401|
|CEA-08|源白名单/SSRF拒绝私网和非法协议，超时有界，任务重入拒绝或复用当前任务；无密钥时保持unavailable不伪造成功|
|CEA-09|AI核验必须真实调用现有provider并有可定位引文；伪造引文降级，注入正文不得变成工具指令|
|CEA-10|名录信用代码与年度分列、意向不计入成交；无法获取原件显示真实缺口|
|CEA-11|情景边界：D=0；额度用完；CCER价格高于CEA；负数/NaN/无穷/过大数拒绝；5%不是无条件现行承诺|
|CEA-12|CSV/JSON下载内容与页面范围一致，字段单位明确，CSV文本不执行公式|
|CEA-13|登录、CCER行情/政策/项目、既有后台和PDF上传回归；桌面与手机浏览器无新增控制台错误/横向溢出|
|CEA-14|本地真实采集至少两个官方日报、正式政策及年度工作通知；名录或意向按实际可获取情况记录，不能全以种子/Mock通过|
|CEA-15|发布前备份代码、SQLite一致性快照与云端附件/密钥；仅传代码，不覆盖云端数据库/密钥；云端健康、普通/管理员关键路径与一次CEA真实增量采集复验|
|CEA-17|配额文件按行业年度配对筛选，钢铁2025不能命中新版2026分配规则；通知与PDF只统计一条政策；完整标题与原件一致；官方PDF自动解析，扫描件及管理员OCR保留来源分级|

## 运行和数据保护

项目根目录 D:\AI workspace\ccer-screening，无Git仓库，修改前保存代码快照。
开发测试库建议 data/cea-dev-20261014.db（从本地v2库做SQLite一致性快照），与原data/ccer_v2.db隔离但复用同data目录密钥文件。单元测试用setupV2临时库。启动本地端口8910或空闲端口，session认证，测试阶段关闭每日自动任务。

禁止重置管理员账号、打印任何密钥、修改DSH全局凭据、运行带reset的seed、复制临时库覆盖云端库。云端为root@60.205.137.86，/opt/ccer-screening，ccer-screening.service；只有Codex在验收后可部署。回滚用本次代码与数据库备份，保留用户新增资料。

DSH持续更新 docs/32-CEA开发实施记录.md，记录状态、修改文件、命令和真实结果、失败原因与剩余缺口。Codex记录独立验收和发布证据到 docs/33-CEA独立验收与云端发布.md。
