# CEA 独立验收与云端发布

本记录由Codex维护，DSH负责实现；开发任务在31、34及35，实际实现记录在32。2026-10-15本地软件验收通过，真实联网补验发现的研报任务摘要误判已由DSH修复并由Codex独立复验。2.3.0已于北京时间10:40更新云端，公网验收完成。

## 数据与发布边界

- 原本地库data/ccer_v2.db以readOnly连接执行VACUUM INTO，生成data/cea-review-20261014.db；原库文件大小与mtime未变化，quick_check为ok。DSH仅使用cea-dev-20261014.db。
- 不运行旧data/ccer.db，不重置管理员、不替换服务密钥。云端发布只传代码，云端数据库、用户、凭据、附件留在原地；发布前另建一致性数据备份与代码回滚包。
- CEA精确日统计、公开历史价格、舍入概览分别保存。收盘价与成交额/成交量计算均价分列，CCER对比只连接同日，不用前值填缺。

## Codex独立证据

| 检查 | 实际结果 | 可复验记录 |
|---|---|---|
| 完整网页日报解析 | 2026-07-30和2026-08-11，日期、OHLC、分项/总量额、累计无差异 | independent-parser-result.json |
| 精确官方JSON与69条意向 | 10月13日金标准无差异；47买入22卖出，错误0；价格和主体未披露保持null | independent-json-result.json |
| 另一交易日与120个历史点 | 10月14日只合计COMCEA三方式，不重复加年度标的；历史OHLC逐点一致，不生成全方式量额 | independent-source-layer-result.json |
| 实际模型 | 干净库4个日期有实际DeepSeek调用，model_used=1、latency_ms>0，最终verified；并非规则检查冒充模型 | independent-persisted-evidence-result.json |
| 官方PDF | 1,290,497字节，独立下载与平台归档SHA256均091fd2d14b975e42da6f68d0f7659cb817cdf76530fe57e77038434a3d464935；可读正文23,012字；附件默认不重复计数 | independent-persisted-evidence-result.json |
| 行业年度配对 | 钢铁2025不命中新2026分配方案，钢铁2026与发电2025正确命中 | independent-persisted-evidence-result.json |
| HTTP/API与角色 | 10组通过：真实管理员登录、普通注册固定viewer、未登录401、普通管理403、金标准、错误参数400、下载、同日缺失null、成本计算、既有模块 | independent-live-api-result.json |
| Windows密钥ACL回归 | Codex环境test/22独立执行5项通过；DSH沙箱的ACL失败未据此修改密钥存储 | codex-test22.log或工具执行记录 |

上表json及原始HTML/JSON/PDF均位于data/backups/cea-20261014/，作为本地验收证据，不随代码传入云端生产库。

### 日历来源在验收期间发生更正

较早抓取的官方辅助holidays.json有101项、包含2026-10-14；正式全年休市公告不包含该日，实际行情有成交。DSH开发库保留三方差异并按实际交易显示，未生成人工任务。

Codex于2026-10-14 16:40重新下载，辅助列表已经变为100项、删除10月14日，SHA256为d936ec8fa8cd1d6e9f7ed5e06901f37a0384c993834a41c5944f547c130fa6b1。干净验收库取得更正后的来源，当前无该异常。旧快照holidays.json与最新holidays-current.json分别保留，不能以旧来源断言官方现在仍错误。

## 2026-10-15 本地补验

- Codex完整回归：28/28个测试文件通过，包括Windows密钥ACL、现有CCER功能、CEA迁移、接口、采集deadline和日历版本修订。
- 真实Chrome：页面检查12/12、交互检查7/7通过。覆盖八个专题、390px移动端、管理员登录、普通用户权限、来源详情、CSV下载、P1/P2独立价格来源和860100元成本情景；未出现JS异常。已目视检查最终桌面截图。
- 独立故障输入6/6通过：缺方式、重复方式、混合日期、字段未披露、无COMCEA、年度标的重复合计。
- 真实异步采集6ms返回202，相同目标重入合并；精确行情与1268个历史价格点正常。10月14日dailyov现披露108.80万吨，精确COMCEA为2861440吨，差异超出舍入容差；平台分层保留并标记partial，不以概览覆盖精确成交值。辅助休市列表本次又返回101项，按本次快照处理，不以昨日100项结论代替实时来源。
- 博查真实搜索返回3条结果，Firecrawl MCP取得2条正文并入库；发现任务摘要把skipped数组误判为整批跳过，交DSH追加回归。
- 生态环境部年度工作通知取得5107字正文，自动调用模型。DeepSeek本次先超时，最小请求复测明确返回HTTP503/service_unavailable_error（服务繁忙）。保留unavailable状态及调用记录，不能将模型失败计为核验通过。此前官方PDF和四个交易日的真实模型成功证据仍保留，不能据此声称今天模型服务正常。
- 新写入dailyov的snapshot_id与ISO fetched_at正确。验收库旧行来自修复前代码，未将测试库整体部署到生产。
- 追加尾项：DSH将整批跳过条件限定为布尔true，独立test38的11项通过；Codex重新启动真实服务后，research任务11ms受理，10618ms完成，success、published=1，原误判未再出现。对应既有API/JSON/有界采集回归由DSH复验通过。完整回归28个文件与追加1个文件合计覆盖29个文件，未将两次执行描述成同一命令。

本地证据：codex-full-regression-20261015.log、independent-browser-result.json、independent-browser-interactions-result.json、live-task-json-local.json、live-task-documents-local.json、task-detail-check执行结果及llm_call_log；均在data/backups/cea-20261014。

## 发布闸门

1. 35中的日期串日、整批deadline、实际配置选择、配额/任务收尾、截止日精度、异步启动已实现且回归通过；追加修复研报任务摘要后单独复验。
2. 本地全套回归与浏览器已通过；第三方服务故障如实保留状态，不宣称服务可用或把未核验内容标成通过。
3. 云端一致性备份后更新代码，等待健康/迁移完成，验证原管理员、既有模块、CEA真实服务调用与采集、定时配置和新附件备份覆盖。

## 云端发布记录

- 地址：https://60.205.137.86/v2 。版本2.3.0；服务ccer-screening.service正常，NRestarts=0，补采后MemoryCurrent=124809216字节（约119MiB；为本次观测，非容量承诺）。
- 代码回滚包：`/opt/ccer-screening/data/backups/cea-release-20261015-104012/code-before.tar.gz`；同目录有发布前一致性数据备份日志、校验和与健康结果。只传src/web/scripts/docs/test/package.json/README，不传本地数据库、测试用户、凭据或密钥。
- 发布后再次执行一致性备份，integrity_check=ok：`/opt/ccer-screening/data/backups/ccer-v2-20261015-104457.tar.gz`。CEA PDF在data/official-originals/cea内，纳入原有每日备份范围。
- 发布前后独立摘要比对：7个用户、4个模型配置、3个搜索配置、3个抓取配置的账号/凭据字段与主密钥均未变化；未重置密码。CEA模块单独明确选择已存在的博查服务与Firecrawl v2 MCP连接，不新增密钥和服务。
- 原管理员真实口令登录200；现有普通用户的短期验收会话访问管理配置/补传缺口403、访问行情200；验收会话已撤销，没有新增云端测试账号。
- 公网API验收8/8：TLS、2.3.0、原管理员、15条既有/CEA路由、10月14日精确金标准、真实CSV附件、错误参数400、成本情景860100元及-39900元差额、CCER独立报价、真实定时器和未登录401。真实Chrome公网验收12/12，八专题及390px布局通过，JS异常与登录后控制台错误均0。
- 云端实际数据：1268个历史价格点，5个精确交易日（10月8/9/12/13/14），9条政策/技术/研究文件条目（含附件单独存储但默认不重复计数），69条交易意向，3条基础履约事件。只代表本次已采集范围，不宣称全国企业或研报已全覆盖。
- 10月14日精确值：收盘98.14元/吨、总量2861440吨、总额258301176.60元；真实DeepSeek调用model_used=1、latency_ms=6129，结果verified。概览与精确统计的差异仍如实标注，采集任务partial表示部分通道存在差异，不是丢弃已取得的精确数据。
- 五份官方文件均取得全文。分配方案PDF1290497字节，SHA256与独立下载一致；Linux pdftotext正文22254字，Windows23012字的差异为提取呈现差异，归档字节一致。五次自动模型核验结果为verified1、insufficient2、unavailable2，不能将“采集成功”等同“核验全部通过”。
- 云端明确配置博查与Firecrawl后再次真实采集：搜索3个候选、MCP取得1篇全文并写入更新，success、32628ms。另一次发现任务取得2篇全文；当前去重后文件总数见上。
- 日程：服务器实际日志确认全平台下次更新为2026-10-16 06:30北京时间；CEA收盘后增量next_run_at=2026-10-15T08:30:00Z，即10月15日16:30。已验证真实排程与本地调度回归，未声称已经观察到未来时点执行。

### 保留的数据缺口

- 福建名录页面虽成功抓取，未解析出可靠企业行，cea_entity=0。已登记来源快照与解析缺口，未将零行冒充全国覆盖。管理员可在后台补充原件；名录扩面仍依赖可读官方名单。
- 模型服务存在间歇超时，部分文档证据不足，历史行情补采在120秒预算内保留未核验/延后状态，次日有界任务继续；没有伪造全部通过。
- 公开价格历史与精确日成交统计是不同覆盖范围；1268个价格点不代表1268天的全方式成交量额已经补齐。公开意向不等于成交，也不等于真实买家身份。

本次云端原始验收记录在本地data/backups/cea-20261014的cloud-release.log、cloud-acceptance-result.json、cloud-browser-result.json、cloud-preservation-and-schedule.log、cloud-final-audit.log、cloud-firecrawl-proof.json及各live-task-*-cloud.log。
