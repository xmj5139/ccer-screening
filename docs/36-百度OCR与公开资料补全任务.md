# 百度 OCR 与公开资料补全

日期：2026-10-15。用户授权本地真实测试，通过后直接配置云端并补跑缺失资料。Codex验收，DSH实现。当前鉴权因截图转录返回invalid_client/unknown client id，已请用户在受限目录提供可复制凭据；不得猜测密钥或把鉴权失败声称可用。

GraphFlow MCP不可用时，本机已安装CLI：`node C:\Users\86139\.dsh\profiles\web\node_modules\@roarpeng\graphflow\dist\surfaces\cli\index.js context preview "query" --json`，无需npx或网络安装。

已知测试环境差异：DSH沙箱test22的icacls ACL断言先前反复失败，Codex宿主环境同一用例通过；不要为此修改现有主密钥ACL或反复排查基线。只需标记环境差异，继续新增功能。

## 实施范围

复用Node原生技术栈、现有AES-GCM主密钥和管理员权限。不得改原账号、密码、其他服务密钥、data/ccer.db；本地实现/测试只用独立新库或cea-dev-20261014.db，不写cea-review及云端库。禁止将秘密输出给浏览器、日志、异常、审计、导出，禁止硬编码。用户密钥由Codex单独注入，不交给DSH。

1. 新增百度OCR服务配置、真实连接测试、PDF解析及历史补跑状态页面，位于后台新“PDF解析/OCR”页签，普通用户403。配置返回仅credential_configured、接口模式、配额/限时、统计，绝不返回cipher或secret。保存时空密钥表示保留，单独显式clear_credentials才删除。两字段作为JSON整体通过encryptSecret存meta；支持服务端环境BAIDU_OCR_API_KEY/BAIDU_OCR_SECRET_KEY。
2. 统一异步PDF解析服务（独立src/services/pdf-parse-svc.mjs、baidu-ocr-svc.mjs等），先用execFile异步pdftotext/pdfinfo；每页text和页码（1起）保留，逐页判断缺文字/乱码，再走OCR。一个文档仅部分页成功只能partial，不用字数阈值把缺页判全文。配置未就绪诚实失败，不影响已有可读PDF。
3. 百度经典高精度接口为POST https://aip.baidubce.com/rest/2.0/ocr/v1/accurate_basic?access_token=...，form-urlencoded pdf_file(base64)及pdf_file_num(1起)，认证POST https://aip.baidubce.com/oauth/2.0/token 表单grant_type=client_credentials/client_id/client_secret。token仅内存缓存按expires_in提前刷新；110/111限一次刷新重试；鉴权/额度/权限/超时分列，不无限重试。单页读取，整批deadline传到真实fetch；配额按实际尝试计数，缓存按原件SHA256+页码+解析版本。4MB以上PDF用pdfseparate分离单页后调用或明确提示限制，禁止静默只处理第一页。
4. 支持可选文档解析模式（供后续能力探测）：官方https://cloud.baidu.com/doc/OCR/s/Klxag8wiy ，提交POST /rest/2.0/brain/online/v2/parser/task，表单file_data/file_name/page_filter(0起)，查询/task/query task_id。pending/running按5秒轮询；成功取parse_result_url的pages/page_num(0起)/text/tables等。返回链接必须HTTPS百度BOS官方域名并过私网/重定向保护；signed URL不得输出或落非加密日志。无权限不可标绿，不自动切换付费服务。本轮先优先把经典高精度模式做完整，文档解析可在配置中明确unsupported，不伪实现。
5. 接入CEA原件下载、管理员PDF上传、原有policy-archive、methodology-origin归档路径：当前同步extractPdfText保留为兼容工具但真实采集优先统一异步服务，已有测试仍能运行。原件不变，OCR结果/页码JSON存data/official-originals/ocr，记录hash、parser、版本、哪些页成功、失败原因与时间；有正文后才调用已有verifyObject，不能OCR成功直接标模型verified。OCR正文不作为已人工审核。
6. 历史补跑：扫描policy_document/policy_attachment/methodology_version/cea_document的真实缺正文及失败本地PDF，路径必须在当前DB目录的official-originals或registry-files受限根内，不开放任意服务器路径。按对象ID选择，单任务异步202+task_id+轮询，单并发、重入合并、配额、每文档页上限、整批限时；每日任务有界补跑并保留未完成游标。提供CLI支持status/config/reparse以便Codex部署，不得默认生产库或reset。
7. 修正缺口判断：网页已有可核对full_text不应仅因attachment_path空就算“PDF未解析”；明确HTML正文与PDF附件两种证据需求。旧policy_attachment not_attempted但同一policy已有新的有效归档，应在显示层显示历史/已替代，不删除旧证据。无法下载的PDF保持fetch_failed，不能用OCR解决。
8. 修正企业名录0行的状态：采集结果rows0要保留parse gap，ingestion_job不能success。PDF名录应按PDF识别后解析而非把二进制当HTML；需要结构化表格才可入企业，名称/年度/省份必须有原文，不凭猜测填主体。
9. Codex独立发现：extractHtmlText对IIGF官方年报页仅返回544字导航，真实正文位于div.v_news_content（外层#vsb_content_501）。需让该已确认的正文容器优先于导航抽取，并加真实公开HTML夹具测试，不能只用“长度超过400”认定正文完整。原件见data/backups/ocr-20261015/cea-iigf-2025.html（公开网页，无密钥）。切勿读取同目录credential、dpapi或enc文件。

## 官方资料

- 用户入口 https://cloud.baidu.com/doc/OCR/s/Ek3h7xypm
- 鉴权 https://cloud.baidu.com/doc/OCR/s/Ck3h7y2ia
- 高精度经典接口 https://aca.bce.baidu.com/doc/OCR/s/1k3h7y3db （主站该页抓取Internal Error，百度官方镜像可读）
- 异步文档解析 https://cloud.baidu.com/doc/OCR/s/Klxag8wiy
- PaddleOCR-VL是另一套接口/paddle-vl-parser/task，不能混用响应字段和页号约定。本次不必实现。

## 测试与交付

### Codex 已完成的真实能力探测（11:10）

用户已另存可复制凭据，鉴权已200。经典accurate_basic识别官方分配方案第一页21行543字。异步/parser/task已成功：分配方案page_filter=0返回1页；福建扫描名录完整3页返回page_num=0/1/2及各1张表，正文1894/1516/1272字，表格序号1至84。无凭据的公开解析结果夹具在data/backups/ocr-20261015/fujian-parser-pages.json。建议将document_parser模式做成真实可用，不能在本次交付中仍写unsupported；直接复用此已确认的接口和字段。注意表格识别出的个别统一信用代码长度不是18，必须保留原文、明确无效/缺失，不猜测补齐；序号和行数/页码可确定。

需要有意义的回归：真实PDF的文字页/扫描页/混合页、缺页不full、令牌过期一次刷新、quota和timeout无残留写、缓存不重复计费、角色403/未登录401、密钥保存不返回、补跑异步202/重入、防任意路径、旧功能兼容、HTML已有正文不误报附件缺口、0行企业不标成功。可用可重复的本机HTTP stub注入测试，生产接口域名固定不可后台任意改到私网。不要把实现字符串检查当主要验收。

DSH只执行本地实现和对应测试，不做云端操作或真实收费调用。输出涉及文件、执行结果、限制；更新docs/37-百度OCR实施记录.md。Codex会用真实凭据及公开PDF本地复验、浏览器复验、备份后发布并完成资料清单逐项处置。
