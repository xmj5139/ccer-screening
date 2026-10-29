/** Codex独立故障验收：临时库、纯fetch夹具，无外网、无实际凭据。 */
import {setupV2,test,testAsync,assert,assertEqual,finish} from './v2-helpers.mjs';
const ctx=await setupV2({withPublicDemo:false}),{db}=ctx;
const ds=await import('../src/services/deepseek-capability-svc.mjs');
const fallback=await import('../src/services/deepseek-fallback-svc.mjs');
const tools=await import('../src/services/tool-chat-svc.mjs');
const beforeFetch=globalThis.fetch;
process.env.INDEPENDENT_DS_KEY='synthetic-key-no-account';
const at=new Date().toISOString(),admin={id:'u-admin',name:'independent',role:'admin'};
db.run(`INSERT INTO llm_provider (id,name,provider_kind,base_url,model,credential_ref,enabled,allowed_domains,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,['LLM-INDEP-109','独立协议测试','openai_compatible','https://api.deepseek.com','deepseek-flash','INDEPENDENT_DS_KEY',1,'["api.deepseek.com"]',at,at]);
ds.ensureDeepSeekDefaults();
test('后台凭据状态必须使用完整的服务端凭据引用判断',()=>{
 const p=ds.deepseekOverview().providers.find(x=>x.id==='LLM-INDEP-109');assert(p);assertEqual(p.credential_configured,true,'不能只SELECT公开字段后错误地判断Key未配置');
});
const success={results:[{url:'https://www.mee.gov.cn/independent-test.html',title:'隔离测试记录',summary:'协议夹具，不是真实政策',content:'隔离测试正文',date:'2026-10-19'}]};
let mode='ok',requests=[];
globalThis.fetch=async(url,opts={})=>{
 const u=new URL(String(url));requests.push({host:u.hostname,path:u.pathname});
 if(u.hostname==='api.deepseek.com'){
  if(opts.method==='DELETE')return Response.json({deleted:true});
  if(mode==='ds402')return Response.json({error:{message:'synthetic balance error'}},{status:402});
  return Response.json(success);
 }
 if(u.hostname==='primary.invalid'){
  if(mode==='slow')return new Promise((resolve,reject)=>{
   const t=setTimeout(()=>resolve(Response.json(success)),5000);
   const abort=()=>{clearTimeout(t);reject(opts.signal?.reason||new Error('Aborted'));};
   if(opts.signal?.aborted)abort();else opts.signal?.addEventListener('abort',abort,{once:true});
  });
  return Response.json(success);
 }
 throw Error('Unexpected outbound host blocked by independent fixture');
};
const reset=()=>{requests=[];mode='ok';db.run("UPDATE deepseek_capability SET budget_stopped_date=NULL,calls_today=0");db.run("UPDATE search_provider SET enabled=CASE WHEN id='DS-SEARCH-AUTO' THEN 1 ELSE 0 END");};
try{
 test('引用Key不能发送到其它厂商/通用JSON连接',()=>{
  const conf={...db.get("SELECT * FROM search_provider WHERE id='DS-SEARCH-AUTO'"),provider_kind:'generic_json',base_url:'https://unrelated.invalid'};
  assert(!ds.resolveCapabilityCredential(conf).ok,'通用连接不应解析出官方DeepSeek凭据');
 });
 test('拒绝私网IPv6及mapped/尾点localhost目标',()=>{
  for(const url of ['http://[fd12::1]/','http://[::ffff:127.0.0.1]/','http://localhost./'])assert(!ds.assertSafeFetchTarget(url,{allowLoopback:false}).ok,'私网目标未拒绝：'+url);
 });
 await testAsync('Files删除也必须校验官方凭据绑定',async()=>{
  requests=[];const p={...db.get("SELECT * FROM llm_provider WHERE id='LLM-INDEP-109'"),base_url:'https://unrelated.invalid'};
  const out=await ds.deleteVisionFile(p,'file-synthetic-test');assert(!out.ok,'不能向官方发送其它模型配置的Key');assertEqual(requests.length,0);
 });
 test('管理员解绑不会被默认配置初始化重新绑定',()=>{
  ds.saveDeepSeekCapability(admin,'vision',{provider_id:null});ds.ensureDeepSeekDefaults();
  const id=db.get("SELECT provider_id FROM deepseek_capability WHERE kind='vision'").provider_id;
  db.run("UPDATE deepseek_capability SET provider_id='LLM-INDEP-109' WHERE kind='vision'");assertEqual(id,null);
 });
 await testAsync('deadlineAt:null不应直接跳过全部通道',async()=>{
  reset();const out=await fallback.runSearchWithFallback('CCER',{deadlineAt:null,attempts:1,totalMs:1500});assert(out.ok,'显式null应按默认总预算执行');assertEqual(requests.length,1);
 });
 db.run(`INSERT INTO search_provider (id,name,provider_kind,base_url,search_path,http_method,auth_kind,credential_ref,param_map_json,response_map_json,timeout_ms,retry_max,daily_quota,enabled,allowed_domains,is_fallback,fallback_priority,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,['PRIMARY-INDEP-109','独立厂商','generic_json','https://primary.invalid','/search','POST','bearer','INDEPENDENT_DS_KEY','{}','{"results_path":"results","url_field":"url","title_field":"title","snippet_field":"summary"}',5000,0,100,1,'["primary.invalid"]',0,0,at,at]);
 await testAsync('主通道超时后保留备用尝试窗口',async()=>{
  reset();mode='slow';db.run("UPDATE search_provider SET enabled=1 WHERE id='PRIMARY-INDEP-109'");
  const start=Date.now(),out=await fallback.runSearchWithFallback('CCER',{attempts:2,totalMs:1500});
  assert(out.ok&&out.fallback_used,'第一源不能耗尽整轮预算');assert(Date.now()-start<2000,'总时限不应被单源超时突破');
 });
 await testAsync('某账号402不应熔断其它独立厂商',async()=>{
  reset();mode='ds402';db.run("UPDATE search_provider SET is_fallback=0,fallback_priority=0 WHERE id='DS-SEARCH-AUTO'");db.run("UPDATE search_provider SET enabled=1,is_fallback=1,fallback_priority=100 WHERE id='PRIMARY-INDEP-109'");
  const out=await fallback.runSearchWithFallback('CCER',{attempts:2,totalMs:2000});assert(out.ok,'独立备用厂商仍应可用');assert(requests.some(r=>r.host==='primary.invalid'));
 });
 db.run(`INSERT INTO public_project (id,name,boundary_desc,official_url,is_demo,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`,['PUB-INDEP-109','独立日期夹具','只有公开元数据，没有官方发布日期。','https://ccer.cets.org.cn/test',0,at,at]);
 db.run(`INSERT INTO public_project (id,name,boundary_desc,official_url,is_demo,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`,['DEMO-INDEP-109','演示记录','测试数据不得作为公开事实。','https://ccer.cets.org.cn/test-demo',1,at,at]);
 await testAsync('收录时间不能被工具标成项目发布日期',async()=>{
  const out=await tools.executeTool('get_library_record',{kind:'project',id:'PUB-INDEP-109'},{userId:'u-viewer'});assert(out.ok);assertEqual(out.evidence[0].published_at,null,'项目没有官方发布日期，不得使用created_at');
 });
 await testAsync('详情工具不能绕过公开范围读取演示项目',async()=>{
  const out=await tools.executeTool('get_library_record',{kind:'project',id:'DEMO-INDEP-109'},{userId:'u-viewer'});assert(!out.ok,'演示记录不应被当作公开证据');
 });
  for(const row of [
   ['CEA-LEGACY-INDEP-109','2025-12-31','LEGACY_TEST',85,null,null],
   ['CEA-COMPOSITE-INDEP-109','2026-10-16','CEA_COMPOSITE_2026',100,20,2000],
  ])db.run(`INSERT INTO cea_trade_daily (id,trade_date,instrument,market_scope,price_regime,close,total_volume,total_turnover,parse_status,source_url,created_at,updated_at) VALUES (?,?,'CEA','national',?,?,?,?,?,'https://overview.cneeex.com/independent-test',?,?)`,[...row,'partial',at,at]);
  await testAsync('旧版CEA收盘价不能标作2026综合收盘价',async()=>{
   const out=await tools.executeTool('market_prices',{market:'cea',from:'2025-12-31',to:'2025-12-31'},{userId:'u-viewer'});assert(out.ok);assert(!out.evidence.some(e=>/官方综合收盘价/.test(e.text||'')),'旧口径价格被错误标为综合价格');
  });
  await testAsync('CEA未披露量额不能统计成零',async()=>{
   const out=await tools.executeTool('market_statistics',{market:'cea',from:'2025-12-31',to:'2025-12-31'},{userId:'u-viewer'});assert(out.ok);assert(out.data.current.total_volume==null&&out.data.current.total_turnover==null,'只有收盘价的记录，未知量额仍应为null');
  });
  await testAsync('不同CEA价格口径不能直接合并成综合均价',async()=>{
   const out=await tools.executeTool('market_statistics',{market:'cea',from:'2025-12-31',to:'2026-10-16'},{userId:'u-viewer'});assert(out.ok);assert(out.data.current.avg_composite_close==null,'跨口径简单平均不能标为官方综合收盘价均值');
  });
}finally{globalThis.fetch=beforeFetch;}
finish('109-v2-deepseek-independent');
