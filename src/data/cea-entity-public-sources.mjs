/** Official public national ETS directories, verified from source files on 2026-10-20.
 * Province/year coverage is partial; names and source hashes are retained at import.
 */
export const CEA_ENTITY_PUBLIC_SOURCES = [
  {
    code: 'cea_entity_cets_public_portal',
    name: '全国碳市场信息网重点排放单位信息公开',
    url: 'https://www.cets.org.cn/zdpfdwxxgk/index.jhtml',
    dataset: 'entity', kind: 'official_portal', authority: '全国碳市场信息网',
    allowed_domains: ['www.cets.org.cn'], priority: 80, enabled: true,
    note: '公开名录补查入口。2026-10-20经已配置Firecrawl可读页面，但企业查询表仍为动态模板，未取得有效行。模板为空不代表没有企业；不能将导航、占位行或公开状态汇总当企业明细。',
  },
  {
    "code": "cea_entity_public_shanghai",
    "name": "上海2026年度全国碳市场重点排放单位名录（发电、钢铁）",
    "url": "https://sthj.sh.gov.cn/hbzhywpt2025/20251027/a4a1e57c3e6c4d228563b8eef025b91b.html",
    "dataset": "entity",
    "kind": "official_html",
    "authority": "上海市生态环境局",
    "allowed_domains": [
      "sthj.sh.gov.cn"
    ],
    "priority": 30,
    "enabled": true,
    "note": "2026名录年度；上海；官方公开原文。行业按原表名录分组，不等同企业主业代码。2026-10-20采集时原表提取33条；同一主体可能跨行业列示，信用代码+年度去重；不代表全国/全省完整覆盖。"
  },
  {
    "code": "cea_entity_public_chongqing",
    "name": "重庆2026年度全国碳市场重点排放单位名录（发电、钢铁、水泥、铝冶炼）",
    "url": "https://sthjj.cq.gov.cn/zwgk_249/zfxxgkml/zcwj/qtwj/202510/t20251029_15123170.html",
    "dataset": "entity",
    "kind": "official_html",
    "authority": "重庆市生态环境局",
    "allowed_domains": [
      "sthjj.cq.gov.cn"
    ],
    "priority": 31,
    "enabled": true,
    "note": "2026名录年度；重庆；官方公开原文。行业按原表名录分组，不等同企业主业代码。2026-10-20采集时原表提取67条；同一主体可能跨行业列示，信用代码+年度去重；不代表全国/全省完整覆盖。"
  },
  {
    "code": "cea_entity_public_guizhou",
    "name": "贵州2026年度全国碳市场重点排放单位名录（发电、钢铁、铝冶炼、水泥）",
    "url": "https://sthj.guizhou.gov.cn/xwzx/tzgg/202510/t20251030_88885067.html",
    "dataset": "entity",
    "kind": "official_html",
    "authority": "贵州省生态环境厅",
    "allowed_domains": [
      "sthj.guizhou.gov.cn"
    ],
    "priority": 32,
    "enabled": true,
    "note": "2026名录年度；贵州；官方公开原文。行业按原表名录分组，不等同企业主业代码。2026-10-20采集时原表提取108条；同一主体可能跨行业列示，信用代码+年度去重；不代表全国/全省完整覆盖。"
  },
  {
    "code": "cea_entity_public_beijing_a1",
    "name": "北京2026年度全国碳市场重点排放单位名录（发电、水泥）",
    "url": "https://sthjj.beijing.gov.cn/bjhrb/index/xxgk69/zfxxgk43/fdzdgknr2/325924085/743817059/2025103018254537954.docx",
    "dataset": "entity",
    "kind": "official_docx",
    "authority": "北京市生态环境局",
    "allowed_domains": [
      "sthjj.beijing.gov.cn"
    ],
    "priority": 33,
    "enabled": true,
    "note": "2026名录年度；北京；官方公开原文。行业按原表名录分组，不等同企业主业代码。2026-10-20采集时原表提取16条；同一主体可能跨行业列示，信用代码+年度去重；不代表全国/全省完整覆盖。"
  },
  {
    "code": "cea_entity_public_neimenggu_a1",
    "name": "内蒙古2026年度全国碳市场重点排放单位名录（发电）",
    "url": "https://sthjt.nmg.gov.cn/stbh2021/ydqhbh/202510/P020251023615027790811.docx",
    "dataset": "entity",
    "kind": "official_docx",
    "authority": "内蒙古自治区生态环境厅",
    "allowed_domains": [
      "sthjt.nmg.gov.cn"
    ],
    "priority": 34,
    "enabled": true,
    "note": "2026名录年度；内蒙古；官方公开原文。行业按原表名录分组，不等同企业主业代码。2026-10-20采集时原表提取190条；同一主体可能跨行业列示，信用代码+年度去重；不代表全国/全省完整覆盖。"
  },
  {
    "code": "cea_entity_public_neimenggu_a2",
    "name": "内蒙古2026年度全国碳市场重点排放单位名录（钢铁）",
    "url": "https://sthjt.nmg.gov.cn/stbh2021/ydqhbh/202510/P020251023615027853500.docx",
    "dataset": "entity",
    "kind": "official_docx",
    "authority": "内蒙古自治区生态环境厅",
    "allowed_domains": [
      "sthjt.nmg.gov.cn"
    ],
    "priority": 35,
    "enabled": true,
    "note": "2026名录年度；内蒙古；官方公开原文。行业按原表名录分组，不等同企业主业代码。2026-10-20采集时原表提取3条；同一主体可能跨行业列示，信用代码+年度去重；不代表全国/全省完整覆盖。"
  },
  {
    "code": "cea_entity_public_neimenggu_a3",
    "name": "内蒙古2026年度全国碳市场重点排放单位名录（钢铁）",
    "url": "https://sthjt.nmg.gov.cn/stbh2021/ydqhbh/202510/P020251023615027912070.docx",
    "dataset": "entity",
    "kind": "official_docx",
    "authority": "内蒙古自治区生态环境厅",
    "allowed_domains": [
      "sthjt.nmg.gov.cn"
    ],
    "priority": 36,
    "enabled": true,
    "note": "2026名录年度；内蒙古；官方公开原文。行业按原表名录分组，不等同企业主业代码。2026-10-20采集时原表提取8条；同一主体可能跨行业列示，信用代码+年度去重；不代表全国/全省完整覆盖。"
  },
  {
    "code": "cea_entity_public_neimenggu_a4",
    "name": "内蒙古2026年度全国碳市场重点排放单位名录（钢铁）",
    "url": "https://sthjt.nmg.gov.cn/stbh2021/ydqhbh/202510/P020251023615027964819.docx",
    "dataset": "entity",
    "kind": "official_docx",
    "authority": "内蒙古自治区生态环境厅",
    "allowed_domains": [
      "sthjt.nmg.gov.cn"
    ],
    "priority": 37,
    "enabled": true,
    "note": "2026名录年度；内蒙古；官方公开原文。行业按原表名录分组，不等同企业主业代码。2026-10-20采集时原表提取1条；同一主体可能跨行业列示，信用代码+年度去重；不代表全国/全省完整覆盖。"
  },
  {
    "code": "cea_entity_public_neimenggu_a5",
    "name": "内蒙古2026年度全国碳市场重点排放单位名录（水泥）",
    "url": "https://sthjt.nmg.gov.cn/stbh2021/ydqhbh/202510/P020251023615028013577.docx",
    "dataset": "entity",
    "kind": "official_docx",
    "authority": "内蒙古自治区生态环境厅",
    "allowed_domains": [
      "sthjt.nmg.gov.cn"
    ],
    "priority": 38,
    "enabled": true,
    "note": "2026名录年度；内蒙古；官方公开原文。行业按原表名录分组，不等同企业主业代码。2026-10-20采集时原表提取37条；同一主体可能跨行业列示，信用代码+年度去重；不代表全国/全省完整覆盖。"
  },
  {
    "code": "cea_entity_public_neimenggu_a6",
    "name": "内蒙古2026年度全国碳市场重点排放单位名录（铝冶炼）",
    "url": "https://sthjt.nmg.gov.cn/stbh2021/ydqhbh/202510/P020251023615028056964.docx",
    "dataset": "entity",
    "kind": "official_docx",
    "authority": "内蒙古自治区生态环境厅",
    "allowed_domains": [
      "sthjt.nmg.gov.cn"
    ],
    "priority": 39,
    "enabled": true,
    "note": "2026名录年度；内蒙古；官方公开原文。行业按原表名录分组，不等同企业主业代码。2026-10-20采集时原表提取9条；同一主体可能跨行业列示，信用代码+年度去重；不代表全国/全省完整覆盖。"
  },
  {
    "code": "cea_entity_public_xinjiang2026_a1",
    "name": "新疆2026年度全国碳市场重点排放单位名录（发电、钢铁、水泥、铝冶炼）",
    "url": "https://sthjt.xinjiang.gov.cn/xjepd/gwggqt/202510/6ed1d9681c8d4e33b39addb2274fca45/files/新疆维吾尔自治区2026年度全国碳排放权交易市场发电、钢铁、水泥、铝冶炼行业重点排放单位名单-20251030200718258.docx",
    "dataset": "entity",
    "kind": "official_docx",
    "authority": "新疆维吾尔自治区生态环境厅",
    "allowed_domains": [
      "sthjt.xinjiang.gov.cn"
    ],
    "priority": 40,
    "enabled": true,
    "note": "2026名录年度；新疆；官方公开原文。行业按原表名录分组，不等同企业主业代码。2026-10-20采集时原表提取167条；同一主体可能跨行业列示，信用代码+年度去重；不代表全国/全省完整覆盖。"
  },
  {
    "code": "cea_entity_public_shanxi_a1",
    "name": "山西2026年度全国碳市场重点排放单位名录（发电、钢铁、水泥、铝冶炼）",
    "url": "https://sthjt.shanxi.gov.cn/tfwj2/jinhuanhan2/202510/P020251031420588710095.pdf",
    "dataset": "entity",
    "kind": "official_pdf",
    "authority": "山西省生态环境厅",
    "allowed_domains": [
      "sthjt.shanxi.gov.cn"
    ],
    "priority": 41,
    "enabled": true,
    "note": "2026名录年度；山西；官方公开原文。行业按原表名录分组，不等同企业主业代码。2026-10-20采集时原表提取184条；同一主体可能跨行业列示，信用代码+年度去重；不代表全国/全省完整覆盖。"
  },
  {
    "code": "cea_entity_public_ningxia_a1",
    "name": "宁夏2026年度全国碳市场重点排放单位名录（发电）",
    "url": "https://sthjt.nx.gov.cn/zwgk/hjjc/zdpwdwml/202510/P020251029549442758731.pdf",
    "dataset": "entity",
    "kind": "official_pdf",
    "authority": "宁夏回族自治区生态环境厅",
    "allowed_domains": [
      "sthjt.nx.gov.cn"
    ],
    "priority": 42,
    "enabled": true,
    "note": "2026名录年度；宁夏；官方公开原文。行业按原表名录分组，不等同企业主业代码。2026-10-20采集时原表提取46条；同一主体可能跨行业列示，信用代码+年度去重；不代表全国/全省完整覆盖。"
  },
  {
    "code": "cea_entity_public_ningxia_a2",
    "name": "宁夏2026年度全国碳市场重点排放单位名录（钢铁）",
    "url": "https://sthjt.nx.gov.cn/zwgk/hjjc/zdpwdwml/202510/P020251029549442816230.pdf",
    "dataset": "entity",
    "kind": "official_pdf",
    "authority": "宁夏回族自治区生态环境厅",
    "allowed_domains": [
      "sthjt.nx.gov.cn"
    ],
    "priority": 43,
    "enabled": true,
    "note": "2026名录年度；宁夏；官方公开原文。行业按原表名录分组，不等同企业主业代码。2026-10-20采集时原表提取3条；同一主体可能跨行业列示，信用代码+年度去重；不代表全国/全省完整覆盖。"
  },
  {
    "code": "cea_entity_public_ningxia_a3",
    "name": "宁夏2026年度全国碳市场重点排放单位名录（钢铁）",
    "url": "https://sthjt.nx.gov.cn/zwgk/hjjc/zdpwdwml/202510/P020251029549442847637.pdf",
    "dataset": "entity",
    "kind": "official_pdf",
    "authority": "宁夏回族自治区生态环境厅",
    "allowed_domains": [
      "sthjt.nx.gov.cn"
    ],
    "priority": 44,
    "enabled": true,
    "note": "2026名录年度；宁夏；官方公开原文。行业按原表名录分组，不等同企业主业代码。2026-10-20采集时原表提取1条；同一主体可能跨行业列示，信用代码+年度去重；不代表全国/全省完整覆盖。"
  },
  {
    "code": "cea_entity_public_ningxia_a4",
    "name": "宁夏2026年度全国碳市场重点排放单位名录（水泥）",
    "url": "https://sthjt.nx.gov.cn/zwgk/hjjc/zdpwdwml/202510/P020251029549442884250.pdf",
    "dataset": "entity",
    "kind": "official_pdf",
    "authority": "宁夏回族自治区生态环境厅",
    "allowed_domains": [
      "sthjt.nx.gov.cn"
    ],
    "priority": 45,
    "enabled": true,
    "note": "2026名录年度；宁夏；官方公开原文。行业按原表名录分组，不等同企业主业代码。2026-10-20采集时原表提取15条；同一主体可能跨行业列示，信用代码+年度去重；不代表全国/全省完整覆盖。"
  },
  {
    "code": "cea_entity_public_ningxia_a5",
    "name": "宁夏2026年度全国碳市场重点排放单位名录（铝冶炼）",
    "url": "https://sthjt.nx.gov.cn/zwgk/hjjc/zdpwdwml/202510/P020251029549442935218.pdf",
    "dataset": "entity",
    "kind": "official_pdf",
    "authority": "宁夏回族自治区生态环境厅",
    "allowed_domains": [
      "sthjt.nx.gov.cn"
    ],
    "priority": 46,
    "enabled": true,
    "note": "2026名录年度；宁夏；官方公开原文。行业按原表名录分组，不等同企业主业代码。2026-10-20采集时原表提取3条；同一主体可能跨行业列示，信用代码+年度去重；不代表全国/全省完整覆盖。"
  },
  {
    "code": "cea_entity_public_jilin_a1",
    "name": "吉林2026年度全国碳市场重点排放单位名录（发电）",
    "url": "https://sthjt.jl.gov.cn/ywdt/tzgg/202510/P020251031575266121614.pdf",
    "dataset": "entity",
    "kind": "official_pdf",
    "authority": "吉林省生态环境厅",
    "allowed_domains": [
      "sthjt.jl.gov.cn"
    ],
    "priority": 47,
    "enabled": true,
    "note": "2026名录年度；吉林；官方公开原文。行业按原表名录分组，不等同企业主业代码。2026-10-20采集时原表提取46条；同一主体可能跨行业列示，信用代码+年度去重；不代表全国/全省完整覆盖。"
  },
  {
    "code": "cea_entity_public_jilin_a3",
    "name": "吉林2026年度全国碳市场重点排放单位名录（钢铁）",
    "url": "https://sthjt.jl.gov.cn/ywdt/tzgg/202510/P020251031575268700398.pdf",
    "dataset": "entity",
    "kind": "official_pdf",
    "authority": "吉林省生态环境厅",
    "allowed_domains": [
      "sthjt.jl.gov.cn"
    ],
    "priority": 48,
    "enabled": true,
    "note": "2026名录年度；吉林；官方公开原文。行业按原表名录分组，不等同企业主业代码。2026-10-20采集时原表提取9条；同一主体可能跨行业列示，信用代码+年度去重；不代表全国/全省完整覆盖。"
  },
  {
    "code": "cea_entity_public_jilin_a4",
    "name": "吉林2026年度全国碳市场重点排放单位名录（水泥）",
    "url": "https://sthjt.jl.gov.cn/ywdt/tzgg/202510/P020251031575269189787.pdf",
    "dataset": "entity",
    "kind": "official_pdf",
    "authority": "吉林省生态环境厅",
    "allowed_domains": [
      "sthjt.jl.gov.cn"
    ],
    "priority": 49,
    "enabled": true,
    "note": "2026名录年度；吉林；官方公开原文。行业按原表名录分组，不等同企业主业代码。2026-10-20采集时原表提取11条；同一主体可能跨行业列示，信用代码+年度去重；不代表全国/全省完整覆盖。"
  },
  {
    "code": "cea_entity_public_sichuan_power",
    "name": "四川2026年度全国碳市场重点排放单位名录（发电）",
    "url": "https://sthjt.sc.gov.cn/sthjt/c103951/2025/10/22/f65fe9bea74944d895c5657f5ce4b2f3/files/%E5%8F%91%E7%94%B5%E8%A1%8C%E4%B8%9A.pdf",
    "dataset": "entity",
    "kind": "official_pdf",
    "authority": "四川省生态环境厅",
    "allowed_domains": [
      "sthjt.sc.gov.cn"
    ],
    "priority": 50,
    "enabled": true,
    "note": "2026名录年度；四川；官方公开原文。行业按原表名录分组，不等同企业主业代码。2026-10-20采集时原表提取56条；同一主体可能跨行业列示，信用代码+年度去重；不代表全国/全省完整覆盖。"
  },
  {
    "code": "cea_entity_public_sichuan_steel",
    "name": "四川2026年度全国碳市场重点排放单位名录（钢铁）",
    "url": "https://sthjt.sc.gov.cn/sthjt/c103951/2025/10/22/f65fe9bea74944d895c5657f5ce4b2f3/files/%E9%92%A2%E9%93%81%E8%A1%8C%E4%B8%9A.pdf",
    "dataset": "entity",
    "kind": "official_pdf",
    "authority": "四川省生态环境厅",
    "allowed_domains": [
      "sthjt.sc.gov.cn"
    ],
    "priority": 51,
    "enabled": true,
    "note": "2026名录年度；四川；官方公开原文。行业按原表名录分组，不等同企业主业代码。2026-10-20采集时原表提取5条；同一主体可能跨行业列示，信用代码+年度去重；不代表全国/全省完整覆盖。"
  },
  {
    "code": "cea_entity_public_sichuan_cement",
    "name": "四川2026年度全国碳市场重点排放单位名录（水泥）",
    "url": "https://sthjt.sc.gov.cn/sthjt/c103951/2025/10/22/f65fe9bea74944d895c5657f5ce4b2f3/files/%E6%B0%B4%E6%B3%A5%E8%A1%8C%E4%B8%9A.pdf",
    "dataset": "entity",
    "kind": "official_pdf",
    "authority": "四川省生态环境厅",
    "allowed_domains": [
      "sthjt.sc.gov.cn"
    ],
    "priority": 52,
    "enabled": true,
    "note": "2026名录年度；四川；官方公开原文。行业按原表名录分组，不等同企业主业代码。2026-10-20采集时原表提取66条；同一主体可能跨行业列示，信用代码+年度去重；不代表全国/全省完整覆盖。"
  },
  {
    "code": "cea_entity_public_sichuan_aluminium",
    "name": "四川2026年度全国碳市场重点排放单位名录（铝冶炼）",
    "url": "https://sthjt.sc.gov.cn/sthjt/c103951/2025/10/22/f65fe9bea74944d895c5657f5ce4b2f3/files/%E9%93%9D%E5%86%B6%E7%82%BC%E8%A1%8C%E4%B8%9A.pdf",
    "dataset": "entity",
    "kind": "official_pdf",
    "authority": "四川省生态环境厅",
    "allowed_domains": [
      "sthjt.sc.gov.cn"
    ],
    "priority": 53,
    "enabled": true,
    "note": "2026名录年度；四川；官方公开原文。行业按原表名录分组，不等同企业主业代码。2026-10-20采集时原表提取6条；同一主体可能跨行业列示，信用代码+年度去重；不代表全国/全省完整覆盖。"
  },
  {
    "code": "cea_entity_public_henan_power",
    "name": "河南2026年度全国碳市场重点排放单位名录（发电）",
    "url": "https://xcoss.henan.gov.cn/typtfile/20251031/16310a8600264530bc6ac397bf67a696.pdf",
    "dataset": "entity",
    "kind": "official_pdf",
    "authority": "河南省生态环境厅",
    "allowed_domains": [
      "xcoss.henan.gov.cn"
    ],
    "priority": 54,
    "enabled": true,
    "note": "2026名录年度；河南；官方公开原文。行业按原表名录分组，不等同企业主业代码。2026-10-20采集时原表提取114条；同一主体可能跨行业列示，信用代码+年度去重；不代表全国/全省完整覆盖。仅发电与钢铁行业。"
  },
  {
    "code": "cea_entity_public_henan_steel",
    "name": "河南2026年度全国碳市场重点排放单位名录（钢铁）",
    "url": "https://xcoss.henan.gov.cn/typtfile/20251031/4f5b2daa839c48ffaa8beb8651cc36e9.pdf",
    "dataset": "entity",
    "kind": "official_pdf",
    "authority": "河南省生态环境厅",
    "allowed_domains": [
      "xcoss.henan.gov.cn"
    ],
    "priority": 55,
    "enabled": true,
    "note": "2026名录年度；河南；官方公开原文。行业按原表名录分组，不等同企业主业代码。2026-10-20采集时原表提取10条；同一主体可能跨行业列示，信用代码+年度去重；不代表全国/全省完整覆盖。仅发电与钢铁行业。"
  },
  {
    "code": "cea_entity_public_guangdong_pdf",
    "name": "广东2026年度全国碳市场重点排放单位名录（发电）",
    "url": "https://gdee.gd.gov.cn/attachment/0/597/597116/4791070.pdf",
    "dataset": "entity",
    "kind": "official_pdf",
    "authority": "广东省生态环境厅",
    "allowed_domains": [
      "gdee.gd.gov.cn"
    ],
    "priority": 56,
    "enabled": true,
    "note": "2026名录年度；广东；官方公开原文。行业按原表名录分组，不等同企业主业代码。2026-10-20采集时原表提取140条；同一主体可能跨行业列示，信用代码+年度去重；不代表全国/全省完整覆盖。仅发电行业。"
  },
  {
    "code": "cea_entity_public_liaoning_amendment",
    "name": "辽宁2026年度全国碳市场重点排放单位名录（发电、钢铁、水泥、铝冶炼）",
    "url": "https://sthj.ln.gov.cn/sthj/hjgl/ydqhbh/2025103115093681768/2025123112590650378.pdf",
    "dataset": "entity",
    "kind": "official_pdf",
    "authority": "辽宁省生态环境厅",
    "allowed_domains": [
      "sthj.ln.gov.cn"
    ],
    "priority": 57,
    "enabled": true,
    "note": "2026名录年度；辽宁；官方公开原文。行业按原表名录分组，不等同企业主业代码。2026-10-20采集时原表提取127条；同一主体可能跨行业列示，信用代码+年度去重；不代表全国/全省完整覆盖。"
  }
];
