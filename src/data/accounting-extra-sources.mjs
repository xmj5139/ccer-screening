const cets=(code,name,path,kind='list')=>({code,name:'全国碳市场信息网·'+name,url:'https://www.cets.org.cn/'+path,authority:'全国碳市场信息网（生态环境部应对气候变化司指导）',allowed_domains:['www.cets.org.cn','cets.org.cn'],source_type:kind,category:'cets',fetch_kind:'mcp_fetch',note:'公开信息栏目；实际采集状态单独记录，企业账户内数据不采集。'});
export const EXTRA_SOURCES=[
 cets('cets_standards','标准规范','bzgf/index.jhtml'),cets('cets_policies','政策文件','zcwjx/index.jhtml'),cets('cets_notices','通知公告','tzgg/index.jhtml'),
 cets('cets_faq_general','共性问答','gxwt/index.jhtml'),cets('cets_faq_power','发电行业MRV问答','fdxyMRVxgwt/index.jhtml'),
 cets('cets_enterprise_guide','企业办事指南','zdpfdwbszn/index.jhtml'),cets('cets_ccer_guide','CCER办事指南','ccerbszn/index.jhtml'),
 cets('cets_compliance','履约公开查询','tpfpeqjwchclqkgk/index.jhtml','portal'),cets('cets_verifiers','核查机构公开查询','hcjgxxgk/index.jhtml','portal'),cets('cets_entities','重点排放单位公开查询','zdpfdwxxgk/index.jhtml','portal'),cets('cets_ccer_public','CCER公开查询','CCERxxgk/index.jhtml','portal'),
 {code:'samr_standards',name:'国家标准全文公开系统',url:'https://openstd.samr.gov.cn/',authority:'国家市场监督管理总局、国家标准化管理委员会',allowed_domains:['openstd.samr.gov.cn','std.samr.gov.cn'],source_type:'portal',category:'standard_metadata',fetch_kind:'direct_html',note:'只收集公开元数据；不绕过版权限制获取标准全文。'}
];
export const EXTRA_STANDARDS=[
 {code:'GB/T 32150-2025',title:'工业企业温室气体排放核算和报告通则',publish_date:'2025-12-31',effective_date:'2026-07-01',replaces_code:'GB/T 32150-2015',url:'https://openstd.samr.gov.cn/bzgk/std/newGbInfo?hcno=6E4997D6B3118055931BC13C71B9A452',full_text_available:true},
 {code:'GB/T 24067-2024',title:'温室气体 产品碳足迹 量化要求和指南',publish_date:'2024-08-23',effective_date:'2024-10-01',url:'https://openstd.samr.gov.cn/bzgk/std/newGbInfo?hcno=73912F93FD4874CC426CEBFCE2898493',full_text_available:false}
].map(x=>({...x,issuer:'国家市场监督管理总局、国家标准化管理委员会',sector:'跨行业',standard_type:'accounting',status:'formal',published_status:'现行',source_kind:'national_standard',version:x.code.split('-').at(-1),announcement_url:x.url,original_url:x.url,body_status:'metadata_only',announcement_code:'samr_standards',metadata_origin:'verified-public-metadata-20261015',applicability:x.code.includes('24067')?'产品碳足迹量化；官方因国际标准版权不提供文本阅读。':'工业企业通用核算；不自动替代全国碳市场行业履约指南。'}));
