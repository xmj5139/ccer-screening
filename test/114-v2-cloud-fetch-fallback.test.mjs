/** 云端验收回归：两个主连接不可用时工具必须到达第三个备用；全部连接前校验目标。 */
import {setupV2,testAsync,assert,assertEqual,finish} from './v2-helpers.mjs';
const ctx=await setupV2({withPublicDemo:false}),{db}=ctx;
const ds=await import('../src/services/deepseek-capability-svc.mjs');
const tools=await import('../src/services/tool-chat-svc.mjs');
const fallback=await import('../src/services/deepseek-fallback-svc.mjs');
const original=globalThis.fetch,at=new Date().toISOString();
process.env.CLOUD_FIXTURE_114='synthetic-only';
db.run(`INSERT INTO llm_provider(id,name,provider_kind,base_url,model,credential_ref,enabled,allowed_domains,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,['LLM114','Fixture114','openai_compatible','https://api.deepseek.com','deepseek-flash','CLOUD_FIXTURE_114',1,'["api.deepseek.com"]',at,at]);
ds.ensureDeepSeekDefaults();
for(const id of ['MAIN114-A','MAIN114-B'])db.run(`INSERT INTO web_fetch_connection(id,name,conn_kind,base_url,auth_kind,enabled,allowed_domains,is_fallback,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,[id,id,'direct_http','https://www.mee.gov.cn','none',1,'["mee.gov.cn"]',0,at,at]);
const requests=[];
globalThis.fetch=async url=>{requests.push(String(url));assertEqual(new URL(url).hostname,'api.deepseek.com');return Response.json({title:'测试正文',content:'隔离测试的公开资料正文，不是真实政策。'.repeat(100)});};
try{
 await testAsync('两个主通道白名单不含目标，仍能调用第三个DeepSeek备用',async()=>{
  const url='https://www.gov.cn/independent-114.html';
  const out=await tools.executeTool('web_fetch',{url},{officialOnly:true,webUrls:new Set([url]),webEvidenceByUrl:new Map(),deadlineAt:Date.now()+10000});
  assertEqual(out.ok,true,JSON.stringify(out));assert(out.evidence.length);assertEqual(requests.length,1);
  const row=db.get("SELECT total_success FROM web_fetch_connection WHERE id='DS-FETCH-AUTO'");assertEqual(row.total_success,1);
 });
 await testAsync('私网或localhost变体在任何主/备用请求之前拒绝',async()=>{
  const n=requests.length;
  for(const url of ['http://[fd12::1]/','http://[::ffff:127.0.0.1]/','http://localhost./']){const out=await fallback.fetchWithFallback(url);assertEqual(out.ok,false);assertEqual(out.reason,'blocked_url');assertEqual(out.attempts.length,0);}
  assertEqual(requests.length,n);
 });
 finish('114-v2-cloud-fetch-fallback');
}finally{globalThis.fetch=original;await ctx.cleanup();}
