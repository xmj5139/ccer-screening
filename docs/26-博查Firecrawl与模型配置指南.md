# 博查、Firecrawl 与大模型配置指南

当前平台入口：http://127.0.0.1:8902/v2 。

博查与 Firecrawl 的连接记录已经建立，公开参数已经填好，目前为停用状态。无需重新新增同名记录。

## 最简单的配置步骤

1. 使用管理员账号进入“后台管理 → 模型配置”，点击“初始化本机主密钥”。这用于加密保存服务凭据，不是向第三方申请 API Key。
2. 进入“后台管理 → 采集连接”，打开“博查 Web Search”，在密钥栏填写博查实际 API Key，保存并启用，然后执行真实连接测试。
3. 同样打开“Firecrawl MCP”，填写 Firecrawl API Key，保存并启用，执行真实连接测试。应检查实际抓取是否成功，只有工具清单可读不代表正文抓取已授权。
4. 在“模型配置”中填写所用大模型的地址、模型名与密钥，启用公开资料核验用途，再测试连接。
5. 执行一次每日更新并查看各数据集状态；正文或证据不足的内容会保持相应状态，不会被自动标成已通过。

## 可直接核对的公开参数

| 字段 | 博查搜索 | Firecrawl MCP |
|---|---|---|
| 类型 | 博查 Web Search | MCP HTTP |
| 服务地址 | https://api.bocha.cn | https://mcp.firecrawl.dev |
| 接口路径 | /v1/web-search | /v2/mcp |
| 完整地址 | https://api.bocha.cn/v1/web-search | https://mcp.firecrawl.dev/v2/mcp |
| 白名单域名 | api.bocha.cn | mcp.firecrawl.dev |
| 凭据环境变量名 | BOCHA_API_KEY | FIRECRAWL_API_KEY |
| 鉴权方式 | Bearer | Bearer |
| MCP 工具名及白名单 | 不适用 | firecrawl_scrape |

“白名单域名”只填主机名，不带 https:// 或接口路径。“凭据环境变量名”是服务端保存真实密钥所用的名称，不是密钥本身，也不是网站账号。若直接在后台密钥栏保存加密凭据，可以保留预填的引用名称，无需另在聊天中提供密钥。

若由运维通过服务器环境变量注入密钥，设置上述变量后重启服务即可；大模型常用引用名为 DEEPSEEK_API_KEY。服务端加密主密钥可使用 CCER_SECRET_KEY，或使用后台生成的受限本机密钥文件。

## 文档与本次验证边界

- 博查官方维护的技能与 API 使用说明：https://github.com/Bocha-Labs/bocha-skills/blob/main/bocha-web-search/SKILL.md
- 用户提供的文档：https://bocha-ai.feishu.cn/wiki/HmtOw1z6vik14Fkdu5uc9VaInBb （本次工具未直接读到飞书正文，因此使用官方维护仓库交叉核实接口。）
- Firecrawl MCP：https://docs.firecrawl.dev/mcp-server
- Firecrawl 工具：https://docs.firecrawl.dev/mcp-server/tools

本次尚无真实供应商密钥，不能声称三个服务已真实调用通过。Firecrawl 的匿名抓取实际返回需要凭据，因此请配置 API Key 后使用。
