# 全量更新：CEA 日报发现与任务收尾修复

2026-10-17。用户已授权前端部署到云端并执行全量数据更新。前端已部署、公网19项检查与真实服务端角色检查通过；云端全量任务在重采历史CCER行情。

## 已核实的生产异常

今日06:30定时全量任务的detail.cea.daily.error为：`discovered.failed is not iterable (cannot read property undefined)`。对应CEA日行情采集任务从06:46起一直running，无步骤记录。应用14:55已重启，进程确认无旧CLI，因此是中断遗留任务。

根因位置：src/services/cea-collect-svc.mjs的discoverLatest在“目录成功解析出links”分支返回`{items,note}`，没有failed；collectCeaDaily在同一分支`result.failed.push(...discovered.failed)`。目录越正常越会报错。此外发现阶段的异常不经过任务close，造成running遗留。

## DSH仅修以下内容

1. discoverLatest所有返回分支保持契约一致，成功目录分支包含failed数组；调用端对可选失败列表可做合理数组防御，但不能掩盖真实异常。
2. collectCeaDaily对自己新建且实际执行的任务，在发现/采集/后处理意外抛错时调用既有closeCeaJob如实记录failed、异常与已有结果，留审计，然后将异常交由调用者处理。复用的running任务不能被本次请求关闭。保留30分钟陈旧任务自动结清机制。
3. 增加一个有行为意义的本地回归test/95-v2-cea-discovery-lifecycle.test.mjs：在独立临时库使用fetch夹具模拟官方目录正常返回真实格式日报链接，不进行外网请求或模型调用，验证不再出现failed不可迭代；另注入一个发现后意外异常，验证自己的任务不遗留running。复用已有测试环境和原文夹具，不只检查源码字符串。
4. 仅运行必要相关CEA回归，不重跑全量采集或前端美化；不要部署、调用生产数据库、使用凭据或启动其他代理/Codex CLI。Codex主会话将独立复测和发布补丁。
5. 更新本文末尾实施与测试记录，结束本轮。禁止改动前端、数据计算口径、账号/模型配置。当前云端正在更新，避免旁路写入。

## 实施与测试记录（DSH，2026-10-17）

### 代码修复

- `src/services/cea-collect-svc.mjs`
  - `discoverLatest`：官方目录成功解析出 links 的分支补齐 `failed` 数组，三个返回分支保持 `{items,note,failed}` 契约一致，目录正常时不再把 `undefined` 展开进 `result.failed`。
  - `collectCeaDaily`：调用端对 `discovered.failed` 只做 `Array.isArray` 防御，不吞掉发现阶段或后续阶段的真实异常。
  - `collectCeaDaily` 拆为「生命周期收尾包装 + 采集主体」：发现/采集/后处理意外抛错时，仅当任务由本次请求新建且未最终完成，调用既有 `closeCeaJob` 写为 `failed`，记录 `error_summary`、`exception`、`failed`、已发现候选数、已有采集结果与发现说明，并补一条失败步骤留审计；随后原异常继续抛给调用者。复用中的 running 任务不进入该收尾分支，仍只返回合并结果。30 分钟陈旧任务自动结清逻辑未改动。
  - 异常信息读取做了安全兜底，避免异常对象自身取值失败时再次阻断收尾。

### 行为回归

新增 `test/95-v2-cea-discovery-lifecycle.test.mjs`，使用 `setupV2()` 独立临时库、`v2-test` 隔离运行器与 `fetch` 夹具（官方目录 HTML + 2026-07-30 官方日报原文，原文与 test/31 夹具一致）；不发起外网请求、不调用模型、不使用凭据。覆盖：

1. 官方目录正常返回真实格式日报链接时，`collectCeaDaily` 正常走「目录 → 详情 → 解析 → 入库」，`result.failed` 始终为数组，状态为 success，不再出现 `failed is not iterable`。
2. 在发现成功之后、写 collect 步骤时用临时 SQLite 触发器注入意外异常：异常仍抛给调用者，本次新建任务被 close 为 failed、有结束时间、无 running 遗留；`detail.failed/exception/discovery/found` 与失败步骤均可审计。
3. 复用运行中的 `cea_daily` 任务时不重复抓取、不关闭原任务（仍为 running、无结束时间），测试结束后自行清理占位任务。

### 实际执行

- `node scripts/v2-test.mjs test/95-v2-cea-discovery-lifecycle.test.mjs` → 4/4 通过。
- 必要相关 CEA 回归：`test/31`（29 通过）、`test/34`（14 通过）、`test/36`（39 通过）、`test/38`（11 通过）、`test/95`（4 通过），合计 5/5 文件、97 项通过。
- 未运行全量采集、前端用例或联网用例；未部署、未访问云端、未连接生产库、未使用生产账号/密钥或模型凭据、未改动前端与数据计算口径。现有回归中的登录与模型均为独立临时库内的测试桩。生产全量更新由 Codex 主会话继续独立验证与发布。

## 独立复核与发布（Codex）

- 已逐项审阅实际源文件差异，独立重跑 test/95 与 test/31，共2个文件、33项通过。
- 补丁已发布至云端 `src/services/cea-collect-svc.mjs`，SHA256与本地一致：`51b5cc677cba26a05384c6aac96132e1b5d8b59c9d595b3341ac33b3c21b8e25`。
- 原文件保存在发布回退目录的 `cea-collect-before-fix.mjs`。重启后主服务active、健康接口正常，独立全量更新执行单元未中断。
- 真实CEA采集及任务收尾的最终结果随全量任务结束后记录于docs/52；不以本地夹具测试替代真实来源验收。
- 真实云端任务 `JOB-0mvc3hmsw-65fada4c` 已于北京时间15:48:38启动、15:49:30正常收尾为partial，发现17条官方日报链接，日行情表由7条增至13条；没有再次出现不可迭代异常，也未遗留running。
- 早间 `JOB-0mvbk5113-0e003de8` 由既有30分钟陈旧任务机制如实结清为failed，保留原失败记录。新任务的partial来自两页没有可识别CEA行情字段，分别是 `https://overview.cneeex.com/c/2025-02-19/488525.shtml` 与 `https://overview.cneeex.com/c/2026-01-09/497324.shtml`；没有以零值代替缺失数据。证据见 `data/backups/release-design-20261017/cea-real-update.json`。

