// Codex independent regression cases. Fixtures are deliberately synthetic and isolated.
import {setupV2,test,assert,assertEqual,finish} from './v2-helpers.mjs';
const {db}=await setupV2({withPublicDemo:false});
const c=await import('../src/services/content-svc.mjs');
const stages=await import('../src/services/processing-stage-svc.mjs');
const summaries=await import('../src/services/summary-svc.mjs');
const search=await import('../src/services/unified-search-svc.mjs');
const versions=await import('../src/services/methodology-version-svc.mjs');
const searchProviders=await import('../src/services/search-svc.mjs');
const backfill=await import('../src/services/history-backfill-svc.mjs');
const verification=await import('../src/services/verification-svc.mjs');
const {id}=c.upsertContent({title:'独立核验碳市场测试',source_url:'https://www.cets.org.cn/tzgg/independent-fixture.html',body_snapshot:'这是独立核验用的公开资料正文。'.repeat(35),body_availability:'full_text',published_at:'2026-10-01',content_type:'industry_news'});
db.run('UPDATE content_item SET updated_at=? WHERE id=?',['2020-01-01T00:00:00.000Z',id]);
const hash=summaries.summaryInputHash(summaries.loadSummaryInput('content_item',id));
db.run(`INSERT INTO entity_summary(id,entity_type,entity_id,input_hash,prompt_version,model_key,status,summary,generated_at,created_at,updated_at)
 VALUES(?,?,?,?,?,?,'ok',?,?,?,?)`,['independent-summary','content_item',id,hash,summaries.PROMPT_VERSION,summaries.currentModelKey(),'合成测试摘要','2020-01-02T00:00:00.000Z','2020-01-02T00:00:00.000Z','2020-01-02T00:00:00.000Z']);
const stage=(name)=>db.get('SELECT * FROM processing_stage WHERE object_id=? AND stage=?',[id,name]);

test('Updating processing metadata does not invalidate a summary with identical actual input',()=>{
 db.run('UPDATE content_item SET updated_at=? WHERE id=?',['2020-01-03T00:00:00.000Z',id]);
 assertEqual(summaries.getSummary('content_item',id).stale,false,'fixture summary must match actual input');
 stages.syncContentStages(id);
 assertEqual(stage('summarized').status,'done','state-only timestamp must not invalidate valid input');
});

test('A newer generated timestamp cannot rescue an invalid summary input hash',()=>{
 db.run('UPDATE entity_summary SET input_hash=?,generated_at=? WHERE id=?',['unrelated-old-input','2099-01-01T00:00:00.000Z','independent-summary']);
 stages.syncContentStages(id);
 assert(stage('summarized').status!=='done','hash mismatch must invalidate even a newer timestamp');
});

test('Read/sync preserves backoff on unchanged content',()=>{
 stages.upsertStage({objectId:id,stage:'verified',status:'blocked',nextRetryAt:'2099-02-01T00:00:00.000Z',incrementAttempts:true,failureReason:'quota exhausted'});
 stages.syncContentStages(id);
 assertEqual(stage('verified').next_retry_at,'2099-02-01T00:00:00.000Z','read must not reset retry schedule');
 assertEqual(stage('verified').attempts,1);
});

test('Search page number agrees with its effective offset for large page requests',()=>{
 const r=search.searchUnified({q:'碳',page:25,page_size:50,types:'content'});
 if(r.error)return;
 assertEqual(r.offset,(r.page-1)*r.page_size,'clamping offset without clamping page repeats prior pages');
});

test('Methodology relationship cannot be confirmed from a mutable status flag or URL prefix',()=>{
 const rows=db.all('SELECT id FROM methodology_version LIMIT 2');
 assertEqual(rows.length,2);
 const quote='本版本正式替代旧版本方法学';
 db.run('UPDATE methodology_version SET body_snapshot=?,official_url=?,auto_verify_status=? WHERE id=?',[quote,'https://www.mee.gov.cn/official.pdf','verified',rows[0].id]);
 db.run('UPDATE methodology_version SET auto_verify_status=NULL WHERE id=?',[rows[1].id]);
 const r=versions.evaluateRelation({from_version_id:rows[0].id,to_version_id:rows[1].id,relation_type:'supersedes',evidence_url:'https://www.mee.gov.cn/official.pdf.evil.example/fake',evidence_locator:'正文第1段',evidence_quote:quote});
 assertEqual(r.confirmable,false,'source URL must match actual archived source and current verified input');
});

test('Existing Bocha preset can send and declare an exact historical date range',()=>{
 // Official API: https://github.com/BochaAI/bocha-search-mcp (freshness supports YYYY-MM-DD..YYYY-MM-DD).
 // Additional review scope is recorded in data/backups/information-governance-20261021/codex-review-findings.md.
 db.run('UPDATE search_provider SET enabled=0');
 const saved=searchProviders.upsertSearchProvider({name:'fixture-admin',role:'admin'},{name:'independent-bocha',provider_kind:'bocha',enabled:true});
 assert(!saved.error,JSON.stringify(saved));
 const p=searchProviders.pickSearchProvider();
 assertEqual(p.provider_kind,'bocha');
 const req=searchProviders.buildSearchRequest(p,'CCER',{start_date:'2025-01-01',end_date:'2025-01-31',count:2});
 const body=typeof req.body==='string'?JSON.parse(req.body):req.body;
 assertEqual(body.freshness,'2025-01-01..2025-01-31','must send actual historical interval rather than noLimit');
 assertEqual(backfill.backfillCapabilities().date_filter_supported,true,'configured Bocha must be usable without a new provider');
});

test('Newer verification timestamp does not validate an unrelated input signature',()=>{
 verification.recordVerification({objectType:'content_item',objectId:id,result:'verified',modelUsed:true,inputHash:'unrelated-old-body-signature'});
 db.run("UPDATE verification_result SET created_at='2099-01-01T00:00:00.000Z' WHERE object_type='content_item' AND object_id=?",[id]);
 stages.syncContentStages(id);
 assert(stage('verified').status!=='done','current source signature must match the verified input');
});

test('Relationship evidence must bind the quoted source and its current verification together',()=>{
 const rows=db.all('SELECT id FROM methodology_version LIMIT 2');
 const quote='本版本正式替代旧版本方法学';
 db.run('UPDATE methodology_version SET body_snapshot=?,official_url=? WHERE id=?',['来源甲没有替代声明','https://www.mee.gov.cn/source-a.pdf',rows[0].id]);
 db.run('UPDATE methodology_version SET body_snapshot=?,official_url=? WHERE id=?',[quote,'https://www.mee.gov.cn/source-b.pdf',rows[1].id]);
 verification.recordVerification({objectType:'methodology_version',objectId:rows[0].id,result:'verified',inputHash:'unrelated-version-signature',modelUsed:true});
 db.run("UPDATE verification_result SET created_at='2099-01-01T00:00:00.000Z' WHERE object_type='methodology_version' AND object_id=?",[rows[0].id]);
 const r=versions.evaluateRelation({from_version_id:rows[0].id,to_version_id:rows[1].id,relation_type:'supersedes',evidence_url:'https://www.mee.gov.cn/source-a.pdf',evidence_locator:'正文第1段',evidence_quote:quote});
 assertEqual(r.confirmable,false,'quote from B cannot be confirmed with source A and an unrelated verification');
});

test('Cross-type stage rows are isolated even when public object IDs collide',()=>{
 const original=db.get('SELECT * FROM policy_document LIMIT 1');
 const policy={...original,id,policy_key:'independent-collision-key',title:'跨资料隔离政策测试',doc_number:'TEST-INDEPENDENT-COLLISION',body_snapshot:'这是政策原文中的明确适用范围和监测要求。'.repeat(30),official_url:'https://www.mee.gov.cn/independent-policy.html'};
 const columns=Object.keys(policy);
 db.run(`INSERT INTO policy_document (${columns.join(',')}) VALUES (${columns.map(()=>'?').join(',')})`,columns.map(k=>policy[k]));
 stages.syncObjectStages('policy_document',id);
 stages.syncObjectStages('content_item',id);
 assertEqual(db.get('SELECT count(*) n FROM processing_stage WHERE object_id=? AND object_type=?',[id,'policy_document']).n,5);
 assertEqual(db.get('SELECT count(*) n FROM processing_stage WHERE object_id=? AND object_type=?',[id,'content_item']).n,5);
 const policyStage=db.get("SELECT * FROM processing_stage WHERE object_type='policy_document' AND object_id=? AND stage='discovered'",[id]);
 assert(policyStage.source_locator?.includes('independent-policy'),'policy must retain its own source');
});

test('An unchanged stale source does not repeatedly reset cross-type retry backoff',()=>{
 const input=summaries.loadSummaryInput('policy_document',id);
 const inputHash=summaries.summaryInputHash(input);
 db.run(`INSERT INTO entity_summary(id,entity_type,entity_id,input_hash,prompt_version,model_key,status,summary,generated_at,created_at,updated_at)
 VALUES(?,?,?,?,?,?,'ok',?,?,?,?)`,['independent-policy-summary','policy_document',id,inputHash,summaries.PROMPT_VERSION,summaries.currentModelKey(),'合成政策摘要','2020-01-02T00:00:00.000Z','2020-01-02T00:00:00.000Z','2020-01-02T00:00:00.000Z']);
 stages.syncObjectStages('policy_document',id);
 db.run('UPDATE policy_document SET body_snapshot=? WHERE id=?',['政策正文已经修订，需要重新生成当前摘要。'.repeat(30),id]);
 stages.syncObjectStages('policy_document',id);
 // An adapter throws before replacing the old cached summary; the worker records the failure.
 stages.recordStageAttempt({objectType:'policy_document',objectId:id,stage:'summarized',status:'failed',nextRetryAt:'2099-02-01T00:00:00.000Z',failureReason:'temporary adapter exception'});
 stages.syncObjectStages('policy_document',id);
 const row=db.get("SELECT * FROM processing_stage WHERE object_type='policy_document' AND object_id=? AND stage='summarized'",[id]);
 assertEqual(row.attempts,1,'attempts reset only on a new input change, not every read of the old stale cache');
 assertEqual(row.next_retry_at,'2099-02-01T00:00:00.000Z','existing backoff must survive refresh');
});

test('Methodology evidence URL preserves document IDs in query parameters',()=>{
 const template=db.get('SELECT * FROM methodology_version LIMIT 1');
 const quote='CCER-99-999-V02正式替代CCER-99-999-V01。';
 for(const version of ['V01','V02']){
  const row={...template,id:`independent-url-${version}`,methodology_id:'CCER-99-999',version,code_display:`CCER-99-999-${version}`,name:'独立来源身份测试方法学',body_snapshot:quote+'\nCCER-99-999-V02正式替代CCER-99-999-V00。',official_url:`https://www.mee.gov.cn/download?fileId=${version}`,updated_at:'2020-01-01T00:00:00.000Z',supersedes_id:null};
  const cols=Object.keys(row);db.run(`INSERT INTO methodology_version (${cols.join(',')}) VALUES (${cols.map(()=>'?').join(',')})`,cols.map(k=>row[k]));
 }
 const prepared=verification.objectVerificationInput('methodology_version','independent-url-V02');
 verification.recordVerification({objectType:'methodology_version',objectId:'independent-url-V02',result:'verified',inputHash:prepared.inputHash,modelUsed:true});
 const r={from_version_id:'independent-url-V02',to_version_id:'independent-url-V01',relation_type:'supersedes',evidence_url:'https://www.mee.gov.cn/download?fileId=V02',evidence_locator:'正文第1段',evidence_quote:quote};
 assertEqual(versions.evaluateRelation(r).confirmable,true,'fixture must contain a valid confirmed-source relationship');
 assertEqual(versions.evaluateRelation({...r,evidence_url:'https://www.mee.gov.cn/download?fileId=UNRELATED'}).confirmable,false,'same endpoint with another document ID is a different source');
 assertEqual(versions.evaluateRelation({...r,evidence_quote:'CCER-99-999-V02正式替代CCER-99-999-V00。'}).confirmable,false,'a statement about replacing V00 cannot prove replacement of V01');
});

finish('140-v2-governance-independent.test.mjs');
