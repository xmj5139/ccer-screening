import {createServer} from 'node:http';
import {setupV2,testAsync,assert,assertEqual,summary,teardownV2} from './v2-helpers.mjs';
const {db}=await setupV2();const acc=await import('../src/services/accounting-svc.mjs');const col=await import('../src/services/accounting-collect-svc.mjs');acc.seedAccountingBase();
const quote='本文件适用于企业温室气体排放核算与报告工作';const body=quote+'。\n适用指南为独立文件，具体实施时间以发布通知为准。';
let reply={};const stub=createServer((req,res)=>{req.resume();req.on('end',()=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({choices:[{message:{content:JSON.stringify(reply)}}],usage:{total_tokens:10}}));});});
await new Promise(r=>stub.listen(0,'127.0.0.1',r));process.env.CCER_ALLOW_LOOPBACK_OUTBOUND='1';db.run('UPDATE llm_provider SET enabled=0');const now=new Date().toISOString();db.run(`INSERT INTO llm_provider(id,name,provider_kind,base_url,model,enabled,allowed_domains,use_content_verify,created_at,updated_at)VALUES(?,?,?,?,?,1,'[]',1,?,?)`,['acc-independent-model','independent local model','ollama',`http://127.0.0.1:${stub.address().port}/v1/chat/completions`,'local-test',now,now]);
const s=db.get('SELECT id FROM accounting_standard ORDER BY id LIMIT 1');
const attach=(complete=true)=>acc.attachStandardBody(s.id,{bodyText:body,pagesTotal:complete?1:3,pagesRead:1,extractionComplete:complete,source:'https://www.mee.gov.cn/test.pdf'});
try{
 await testAsync('Missing explicit consistent=true cannot be promoted by a locatable quote',async()=>{attach();reply={confidence:.99,summary:'校验结果',citations:[{quote,field:'title'}]};const r=await col.verifyStandardWithModel(s.id);assertEqual(r.result,'insufficient');});
 await testAsync('A valid citation does not rescue a fabricated citation',async()=>{attach();reply={consistent:true,confidence:.99,summary:'一致',citations:[{quote,field:'title'},{quote:'从未出现在原始资料中的完全虚构文字内容',field:'issue_date'}]};const r=await col.verifyStandardWithModel(s.id);assert(r.result!=='verified');assert(r.citations_rejected>=1);});
 await testAsync('Partial evidence cannot become a verified complete document',async()=>{attach(false);reply={consistent:true,confidence:.99,summary:'一致',citations:[{quote,field:'title'}]};const r=await col.verifyStandardWithModel(s.id);assertEqual(r.result,'insufficient');const v=db.get("SELECT * FROM verification_result WHERE object_id=? ORDER BY created_at DESC LIMIT 1",[s.id]);if(v)assert(v.evidence_level!=='full_text');});
 await testAsync('Explicit model conflict is retained and does not rewrite official metadata',async()=>{attach();const before=db.get('SELECT code,issue_date,publish_date FROM accounting_standard WHERE id=?',[s.id]);reply={consistent:false,confidence:.99,summary:'存在冲突',conflict_fields:[{field:'issue_date',body_value:'unknown',doc_value:'2026-06-23'}],citations:[{quote,field:'title'}]};const r=await col.verifyStandardWithModel(s.id);assertEqual(r.result,'conflict');assertEqual(JSON.stringify(db.get('SELECT code,issue_date,publish_date FROM accounting_standard WHERE id=?',[s.id])),JSON.stringify(before));});
 await testAsync('A source-located code with equivalent dash typography is not a material conflict',async()=>{
  const code=db.get('SELECT code FROM accounting_standard WHERE id=?',[s.id]).code;assert(code);const printed=code.replace(/-/g,'—');
  acc.attachStandardBody(s.id,{bodyText:body+'\n标准编号：'+printed,pagesTotal:1,pagesRead:1,extractionComplete:true});
  reply={consistent:true,summary:'编号一致，仅连接符排版不同',conflict_fields:[{field:'code',values:[{value:code},{value:printed}]}],citations:[{quote,field:'title'}]};
  const r=await col.verifyStandardWithModel(s.id);assertEqual(r.result,'verified');assertEqual(r.formatting_differences.length,1);
 });
}finally{await new Promise(r=>stub.close(r));}
process.exitCode=summary('62-v2-accounting-verdict-independent.test.mjs')?1:0;
teardownV2();
