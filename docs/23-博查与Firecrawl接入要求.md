# 用户指定：博查搜索 API 与 Firecrawl MCP

2026-09-29 用户确认：搜索使用博查，MCP 采用 Firecrawl。替换默认选项和配置引导；保留其他适配器可选。本文与 docs/22 均是本轮必须实现的后续任务。

## 已核对的资料

- 用户提供的文档：https://bocha-ai.feishu.cn/wiki/HmtOw1z6vik14Fkdu5uc9VaInBb （Codex 浏览工具无法访问，不能称已读其全文）。
- 博查维护的 DSH 搜索适配器：https://github.com/bocha-ai/dsh-web-search-bocha
- 博查搜索 Skill 的 API 说明：https://github.com/Bocha-Labs/bocha-skills/blob/main/bocha-web-search/SKILL.md
- Firecrawl 官方：https://docs.firecrawl.dev/mcp-server/keyless 与 https://docs.firecrawl.dev/mcp-server/tools

## 博查

- 新增独立 `provider_kind=bocha`，后台选择项显示“博查 Web Search”；默认地址 `https://api.bocha.cn/v1/web-search`，白名单 `api.bocha.cn`，凭据引用 `BOCHA_API_KEY`。
- POST JSON；Authorization Bearer；参数 query、summary=true、count（1至50）、freshness；允许配置旧地址 api.bochaai.com，但不要静默替换或自动跨域发送密钥。
- 响应数组 `data.webPages.value`，映射 name→title、url、summary（缺失时snippet）、siteName→publisher、datePublished→published_at。**摘要不是全文**，后续由 Firecrawl 获取正文。不要用 dateLastCrawled 冒充发布日期。
- HTTP200但业务 code非200也算失败，保留可公开的log_id用于排错。鉴权、余额不足、限流、空结果、超时分别显示；401/403不要无意义重试。
- 在隔离测试中模拟真实响应格式，校验实际发送的请求和结果映射。

## Firecrawl MCP

- 预设 `conn_kind=mcp_http`；默认 endpoint `https://mcp.firecrawl.dev/v2/mcp`，白名单 `mcp.firecrawl.dev`，工具 `firecrawl_scrape`，只读白名单仅抓取所需工具；获取并读取 tools/list 返回的 inputSchema，正确映射 url/formats。
- 官方支持该 endpoint 无密钥的限额试用。允许这个**固定官方地址**的显式 keyless模式，后台须标注试用限额，不能因此放宽任意远端MCP免鉴权或任意工具调用。
- 日常生产允许 Bearer + `FIRECRAWL_API_KEY`，只在服务端解析；禁止URL携带API Key，不公开连接密钥、日志不输出Authorization或MCP session标识。
- test按钮必须执行真实initialize/tools/list并确认所选工具存在，不只是能连通HTTP；文章抓取读取markdown及metadata，错误时保留失败状态，不能从字符数判断全文。
- 首次可以使用官方keyless做最小真实抓取验收（1到2篇docs/21的公开文章）；如遭限流/网络失败如实记录，勿伪造成功。无博查密钥时，博查实测仍应显示缺凭据，不能称已通。

## 验收与配置便捷性

- 后台提供“填入博查默认配置”“填入Firecrawl MCP默认配置”，填入上述公开参数，用户只需在后台配置凭据；不自动读取DSH凭据库。
- 日更接通博查发现→Firecrawl正文→去重→模型验证；已有官方数据采集保留。模型不可用不阻止公开信息展示。
- 更新实施记录、README、配置指南；明确“代码/模拟测试通过”与“真实外部调用通过”的区别。


## Codex 本机实测结果（10:22）

Firecrawl 官方 v2 MCP 无密钥 initialize 与 tools/list 成功，协议2025-06-18，发现 firecrawl_scrape/search/parse。随后调用 firecrawl_scrape 抓取 docs/21 的 BIT 研报页，返回 isError=true：Anonymous keyless access is unavailable for this request，明确要求 API Key。因此只能确认协议/工具发现通过，不能声称真实抓取成功。应用test须把‘连接及工具可用’与‘抓取授权和实际调用成功’区分；生产采用 FIRECRAWL_API_KEY。不要反复无密钥请求或伪造可用。
