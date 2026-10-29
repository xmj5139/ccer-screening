// Codex independent regressions. All articles below are synthetic temporary fixtures.
import {createServer} from 'node:http';
import {setupV2,test,testAsync,assert,assertEqual,finish} from './v2-helpers.mjs';
const {db}=await setupV2({withPublicDemo:false});
const content=await import('../src/services/content-svc.mjs');
const queue=await import('../src/services/ingest-summary-svc.mjs');
const summary=await import('../src/services/summary-svc.mjs');
process.env.CCER_INGEST_SUMMARY_BATCH='1';
let counter=0;
function article(tag,opts={}){return content.upsertContent({title:'独立测试公开信息 '+tag,source_url:'https://www.cets.org.cn/test-independent/'+tag+'.html',body_snapshot:('合成测试资料 '+tag+'，不代表真实市场信息。').repeat(30),body_availability:'full_text',published_at:'2026-10-01',content_type:'industry_news',...opts});}

test('Daily fallback eventually reaches older missing articles beyond a large already-queued head',()=>{
 const old=article('old-missed',{published_at:'2001-01-01'});
 db.run('DELETE FROM ingest_summary_queue WHERE entity_id=?',[old.id]);
 for(let i=0;i<510;i++)article('newer-'+i);
 for(let pass=0;pass<8;pass++)queue.enqueueMissedContentSummaries({limit:100});
 assert(db.get('SELECT id FROM ingest_summary_queue WHERE entity_id=?',[old.id]),'older missing article must eventually enter queue; rescanning only the newest 500 is not a daily safety net');
});

const server=createServer(async(req,res)=>{
 let raw='';for await(const chunk of req)raw+=chunk;
 counter++;
 if(onCall)await onCall();
 res.writeHead(200,{'content-type':'application/json','connection':'close'});
 res.end(JSON.stringify({choices:[{message:{content:JSON.stringify({summary:'这是一条基于本机合成测试资料生成的摘要。'})}}]}));
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
let onCall=null;
process.env.CCER_ALLOW_LOOPBACK_OUTBOUND='1';
process.env.CCER_LLM_KEY_INDEPENDENT_INGEST='synthetic-local-test-key';
const now=new Date().toISOString();
db.run('UPDATE llm_provider SET enabled=0');
db.run(`INSERT INTO llm_provider(id,name,provider_kind,base_url,model,credential_ref,enabled,allowed_domains,use_content_verify,created_at,updated_at)
 VALUES(?,?,?,?,?,?,1,'[]',1,?,?)`,['independent-ingest','independent local stub','ollama',`http://127.0.0.1:${server.address().port}/v1/chat/completions`,'independent-stub','INDEPENDENT_INGEST',now,now]);
function clear(){queue.stopIngestSummaryWorker();db.run('DELETE FROM ingest_summary_queue');}
try{
 await testAsync('An article excluded after enqueue must not consume a model call',async()=>{
  clear();const row=article('reclassified');
  db.run("UPDATE content_item SET record_kind='source_archive' WHERE id=?",[row.id]);
  const before=counter;queue.startIngestSummaryWorker();await queue.runIngestSummaryWorkerOnce();queue.stopIngestSummaryWorker();
  assertEqual(counter,before,'execution must recheck article eligibility after queue wait');
  assert(!db.get("SELECT id FROM entity_summary WHERE entity_type='content_item' AND entity_id=?",[row.id]),'excluded source archive must not receive an article summary');
 });
 await testAsync('An in-flight old-body result cannot finish the replacement-body task',async()=>{
  clear();const row=article('in-flight');
  onCall=()=>{onCall=null;article('in-flight',{body_snapshot:'新版合成资料发生实质变化，不能沿用旧版摘要。'.repeat(40)});};
  queue.startIngestSummaryWorker();await queue.runIngestSummaryWorkerOnce();queue.stopIngestSummaryWorker();
  const replacement=db.get("SELECT * FROM ingest_summary_queue WHERE entity_id=? AND status='queued'",[row.id]);
  assert(replacement,'replacement task must survive the old result');
  assert(summary.getSummary('content_item',row.id)?.stale,'old-body summary must remain visibly stale');
  queue.startIngestSummaryWorker();await queue.runIngestSummaryWorkerOnce();queue.stopIngestSummaryWorker();
  assertEqual(summary.getSummary('content_item',row.id)?.stale,false,'replacement must be independently summarized');
  assertEqual(db.get('SELECT status FROM ingest_summary_queue WHERE id=?',[replacement.id]).status,'succeeded');
 });
}finally{queue.stopIngestSummaryWorker();server.closeAllConnections();await new Promise(r=>server.close(r));await new Promise(r=>setTimeout(r,50));}
finish('159-v2-ingest-independent.test.mjs');
