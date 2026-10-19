import {setupV2,test,assert,assertEqual,finish} from './v2-helpers.mjs';
const {db,admin}=await setupV2();
const fetchSvc=await import('../src/services/web-fetch-svc.mjs');
const archive=await import('../src/services/methodology-archive-svc.mjs');
test('归档模型退出界面，历史配置仍可追溯',()=>{
 const p=db.get('SELECT id FROM llm_provider LIMIT 1');
 db.run('UPDATE llm_provider SET archived=1,enabled=0 WHERE id=?',[p.id]);
 assert(!admin.listLlmProviders().some(x=>x.id===p.id));
 assert(db.get('SELECT id FROM llm_provider WHERE id=?',[p.id]));
});
test('官方附件解析拒绝站外链接，保留相对 PDF 原文地址',()=>{
 const a=archive.parseMethodAttachments('<a href="./x.pdf">方法学（CCER-10-001-V01）</a><a href="https://evil.example/x.pdf">伪附件</a>','https://www.mee.gov.cn/notice/a.html');
 assertEqual(a.length,1); assertEqual(a[0].url,'https://www.mee.gov.cn/notice/x.pdf');
});
test('已通过真实抓取测试的 MCP 优先于直连模板',()=>{
 const user={name:'test',role:'admin'};
 fetchSvc.upsertFetchConnection(user,{name:'fallback',conn_kind:'http_direct',base_url:'https://www.mee.gov.cn',allowed_domains:['www.mee.gov.cn'],enabled:true});
 const r=fetchSvc.upsertFetchConnection(user,{name:'tested-mcp',conn_kind:'mcp_http',enabled:true});
 assert(r.ok);
 db.run("UPDATE web_fetch_connection SET scrape_authorized=1,last_test_result='ok' WHERE id=?",[r.id]);
 assertEqual(fetchSvc.pickFetchConnection().id,r.id);
});
finish('test/24-v2-service-cleanup.test.mjs');
