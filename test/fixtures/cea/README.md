# CEA公开来源故障与回归夹具

2026-10-14从官方公开站点取得，不含账号、会话或API凭据。

- annual-closures-2026.html：全国CEA正式2026全年休市公告，https://overview.cneeex.com/c/2025-12-24/496961.shtml 。
- queryMarketByDate-20261013.json、querySubStat-20261013.json：官网查询页使用的公共接口，https://shyx.cneeex.com/gateway/common/queryMarketByDate 及querySubStat；请求tradeDate=20261013，综合标的COMCEA。
- queryMarketByDate-20261014.json、querySubStat-20261014.json：同一组接口在tradeDate=20261014的响应，用于docs/35串日/缺方式/重复行故障注入与采集链路回归。
- tradeIntent.json、hiskline.json、holidays.json：官网静态公开数据，https://shyx.cneeex.com/assets/json/ 。
- holidays-current.json：同一天后续抓取的100项修订版本；较早holidays.json为101项，差别是辅助列表删除2026-10-14。两份保留，用于验证来源修订不会留下错误的当前休市标识。

这些是固定时点的测试证据，不是生产“当前”数据。禁止把测试行写入生产库。每次正式运行继续按当前来源更新。

回归测试（test/33、34、35、36、37）只读取本目录，`data/backups/` 下的独立验收证据不属于代码包，不再作为回归前置条件。
