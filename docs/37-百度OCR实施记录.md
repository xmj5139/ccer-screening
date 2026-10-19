# 百度 OCR 与公开资料补全实施记录

实施日期：2026-10-15。DSH 完成 OCR 服务、统一 PDF 解析、补跑任务、后台页签和回归测试；Codex 独立实测并修复接口、配置保存、正文提取、名录解析等问题。

## 解析流程

下载原件并保留 SHA-256 → 逐页提取文字层 → 对缺文字页调用百度 OCR → 保存原文、物理页码和引擎版本 → 更新正文 → 调用已配置模型核对。解析成功不自动等于内容核验通过。

默认使用 accurate_basic。异步 document parser 提供提交、查询、官方 BOS 结果下载与原页码核对，须先具备接口权限；真实测试通过，但不同扫描页识别质量不同。当前默认仍为高精度接口。超时任务不宣称完成；异步远程任务的跨进程恢复尚未实现。

原生文字 PDF 不调用收费 OCR。按文件哈希、物理页码和引擎版本缓存；每日补跑有文档数、页数和时间限制，未完成对象保留游标。超大文件先尝试拆页，不静默只读第一页。

## 运维入口

管理员：后台管理 → PDF 解析/OCR。可配置开关、模式、配额，测试连接，查看缺口、提交补跑并轮询任务。密钥字段留空表示保留；明确清除才删除。普通用户不能读写这些接口。

密钥经现有服务端 AES-GCM 主密钥加密保存；浏览器不回填明文或密文。环境变量 BAIDU_OCR_API_KEY / BAIDU_OCR_SECRET_KEY 也可使用。后台不提供任意 API 主机输入框。

补跑仅处理当前数据库目录下 official-originals 与 registry-files 的真实 PDF，校验符号链接后的路径，不开放任意服务器文件。管理员上传的原件仍使用既有上传入口及权限。

## 主要文件

- src/services/baidu-ocr-svc.mjs：鉴权、额度、接口调用和错误分类。
- src/services/pdf-parse-svc.mjs：逐页解析、缓存和正文落库。
- src/services/ocr-backfill-svc.mjs：受限扫描、单并发异步任务、每日游标、自动核验。
- src/routes-ocr.mjs：管理员 API。
- web/v2/modules/admin.js：PDF 解析/OCR 页签。
- scripts/ocr.mjs：运维命令；test/39—44：OCR、权限、实际公开资料回归。

## 官方接口依据

- [百度 OCR 文档](https://cloud.baidu.com/doc/OCR/s/Ek3h7xypm)
- [鉴权](https://cloud.baidu.com/doc/OCR/s/Ck3h7y2ia)
- [文档解析接口](https://cloud.baidu.com/doc/OCR/s/Klxag8wiy)

经典 pdf_file_num 从 1 起，文档解析 page_filter 与结果 page_num 从 0 起。BOS 签名结果链接不写入公开接口或测试报告。
