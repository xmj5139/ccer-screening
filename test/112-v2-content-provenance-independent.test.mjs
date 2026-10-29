/** Codex独立验收：备用搜索实际归属与快照外键；无外网。 */
import {setupV2,testAsync,assert,assertEqual,finish} from './v2-helpers.mjs';
const ctx=await setupV2({withPublicDemo:false}),{db}=ctx;const before=globalThis.fetch;
const content=await import('../src/services/content-svc.mjs');
const at=new Date().toISOString();process.env.INDEPENDENT_SEARCH_112='synthetic-only';
for(const [id,fallback]of[['PRIMARY112',0],['BACKUP112',1]])db.run(`INSERT INTO search_provider (id,name,provider_kind,base_url,search_path,http_method,auth_kind,credential_ref,param_map_json,response_map_json,timeout_ms,retry_max,daily_quota,enabled,allowed_domains,is_fallback,fallback_priority,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,[id,id,'generic_json','https://'+id.toLowerCase()+'.invalid','/search','POST','bearer','INDEPENDENT_SEARCH_112','{}','{"results_path":"results","url_field":"url","title_field":"title","snippet_field":"summary","content_field":"content","published_at_field":"date"}',1500,0,100,1,JSON.stringify([id.toLowerCase()+'.invalid']),fallback,fallback?5:0,at,at]);
globalThis.fetch=async url=>Response.json({results:String(url).includes('primary112')?[]:[{url:'https://www.mee.gov.cn/independent-112.html',title:'CCER 独立采集测试资料',summary:'CCER 隔离协议测试摘要，非真实政策资料。',date:at.slice(0,10)}]});
try{
 await testAsync('备用成功记录实际服务并创建有效快照',async()=>{
  const out=await content.collectFromSearch({maxQueries:1,maxItems:1,fetchBody:false,verify:false});
  assert(out.ok&&out.inserted===1,JSON.stringify(out));
  const row=db.get('SELECT source_provider_id,snapshot_id FROM content_item WHERE source_url=?',['https://www.mee.gov.cn/independent-112.html']);assert(row);assertEqual(row.source_provider_id,'BACKUP112');assert(row.snapshot_id,'快照不能因搜索连接ID外键错误而静默丢失');
  const snap=db.get('SELECT source_id,parse_note FROM source_snapshot WHERE id=?',[row.snapshot_id]);assertEqual(snap.source_id,null);assert(snap.parse_note.includes('BACKUP112'));
  assertEqual(db.all('PRAGMA foreign_key_check').length,0);
 });finish('112-v2-content-provenance-independent');
}finally{globalThis.fetch=before;await ctx.cleanup();}

