import {setupV2,test,assert,assertEqual,finish} from './v2-helpers.mjs';
await setupV2({withPublicDemo:false});
const c=await import('../src/services/content-svc.mjs');
const p=await import('../src/services/accounting-parse.mjs');
const display=await import('../src/services/source-display-svc.mjs');
const base='https://www.cets.org.cn/';
test('MCP Markdown discovers real notices without counting navigation, images or another site',()=>{
 const text=[
  '[CCER信息公开](https://www.cets.org.cn/CCERxxgk/index.jhtml)',
  '[全国碳市场通知目录](https://www.cets.org.cn/tzgg/index_2.jhtml)',
  '![全国碳市场图片](https://www.cets.org.cn/tzgg/9000.jhtml)',
  '[碳市场官方通知](https://evil.example/tzgg/7499.jhtml)',
  '[关于公开征求CCER方法学意见的函](https://www.cets.org.cn/tzgg/7499.jhtml)',
  '[全国碳市场建设行业动态](/hjywt/7481.jhtml)',
 ].join('\n');
 const rows=c.discoverArticleLinks(text,base,{max:8});assertEqual(rows.length,2);
 assert(rows.every(x=>new URL(x.url).hostname==='www.cets.org.cn'));
 assertEqual(c.discoverArticleLinks(text,base,{max:8,pathPrefixes:['/tzgg/']}).length,1);
 assertEqual(c.discoverArticleLinks(text,base,{max:8,pathPrefixes:['/hjywt/']}).length,1);
});
test('HTML discovery remains compatible and the same link in two formats is deduplicated',()=>{
 const url=base+'tzgg/7499.jhtml',title='关于公开征求CCER方法学意见的函';
 const html=`<a href="${url}">${title}</a>\n[${title}](${url})`;
 assertEqual(c.discoverArticleLinks(html,base,{max:3}).length,1);
});
test('CETS daily sources fit the twelve-source daily batch and use public exact host',()=>{
 const seeds=c.SEED_SOURCES.filter(s=>s.id.startsWith('src-cets-'));
 assertEqual(seeds.length,3);assert(seeds.every(s=>s.enabled&&s.source_category==='official'&&new URL(s.url).hostname==='www.cets.org.cn'));
 assert(c.SEED_SOURCES.filter(s=>s.enabled).length<=12);
 assertEqual(seeds.find(s=>s.id==='src-cets-portal').max_articles,0);
 assert(seeds.filter(s=>s.is_index).every(s=>s.discovery_url===base&&s.article_paths.length));
});
test('Known source-index URL forms cannot become articles',()=>{
 for(const path of ['xwzx/index.jhtml','tzgg/index_2.jhtml','bzgf/index.html'])assert(c.isSourceIndexUrl(base+path));
 assert(!c.isSourceIndexUrl(base+'tzgg/7499.jhtml'));
});
test('Information portal and CCER registry have distinct official source labels',()=>{
 assertEqual(display.sourceDisplay({url:base}).official_label,'全国碳市场信息网');
 assert(display.sourceDisplay({url:'https://ccer.cets.org.cn/'}).official_label.includes('自愿减排注册登记'));
 assert(display.sourceDisplay({url:'https://www.cets.org.cn.evil.example/'}).kind!=='official');
});
test('Article parsing uses page publication date rather than the different document issue date',()=>{
 const text='当前位置：\n[首页](https://www.cets.org.cn/)\n2026-10-16\n来源：生态环境部\n[打印]\n# 关于公开征求CCER方法学意见的函\n为规范全国温室气体自愿减排交易市场，现公开征求意见。\n生态环境部办公厅\n2026年10月15日\n网站地图\n业务审核单位：测试';
 const r=p.parseCetsArticlePage(text,{baseUrl:base+'tzgg/7499.jhtml'});
 assertEqual(r.published_at,'2026-10-16');assert(r.title.includes('征求'));assert(!r.body_text.includes('业务审核单位'));
});
finish('123-v2-cets-news-source.test.mjs');
