import assert from'node:assert/strict';
import{mkdtemp,readFile}from'node:fs/promises';import{tmpdir}from'node:os';import{join}from'node:path';
process.env.CCER_DB_PATH=join(await mkdtemp(join(tmpdir(),'ccer-ocr-independent-')),'test.db');process.env.CCER_ENABLE_V2='1';process.env.CCER_DAILY_SYNC='0';
const db=await import('../src/core/db.mjs');
const {extractHtmlText}=await import('../src/services/web-fetch-svc.mjs');const {parseEntityRows}=await import('../src/services/cea-parse.mjs');const cea=await import('../src/services/cea-svc.mjs');const {persistParseResult}=await import('../src/services/pdf-parse-svc.mjs');
const checks=[];
try{
 const article=extractHtmlText(await readFile(new URL('./fixtures/ocr/iigf-2025-official.html',import.meta.url),'utf8'));
 assert.ok(article.content.length>16000,`Only ${article.content.length} chars extracted`);assert.match(article.content,/2025年，全国碳市场/);assert.doesNotMatch(article.content,/English Version/);checks.push('真实大学CMS正文不被外层form一并剥除');
 const pages=JSON.parse(await readFile(new URL('./fixtures/ocr/fujian-2026-accurate-pages.json',import.meta.url),'utf8'));
 const rows=parseEntityRows(pages.map(p=>p.text).join('\n'),{listYear:2026,province:'福建'});
 assert.equal(rows.length,84,'经典OCR逐单元格输出应得到84个企业');assert.equal(rows.filter(r=>r.credit_code).length,79,'4个原表短代码及1个OCR失真代码不能猜测修补');assert.ok(rows.every(r=>r.city&&r.list_year===2026));assert.equal(rows.filter(r=>r.status==='new').length,2);assert.equal(rows.find(r=>r.source_row===34).sector,null,'不能把原识别词发屯猜测成发电');checks.push('三页经典OCR保留84行，异常代码和行业不猜测修补');
 const md=JSON.parse(await readFile(new URL('./fixtures/ocr/fujian-2026-structured-pages.json',import.meta.url),'utf8'));
 const structured=parseEntityRows(md.map(p=>p.text).join('\n'),{listYear:2026,province:'福建'});assert.equal(structured.length,84);assert.equal(structured.filter(r=>r.credit_code).length,80);checks.push('Markdown表格同样保持84行，不把整行拼成企业名');
 db.getDb();cea.seedCeaBaseData();
 const {buildObjectInput}=await import('../src/services/verification-svc.mjs');
 const partial=buildObjectInput('cea_document',{title:'研报预览',doc_type:'research',body_snapshot:'公开展示页摘要。'.repeat(100),evidence_level:'partial'});
 assert.equal(partial.body_availability,'partial','长摘要不能因字符多而变成全文');checks.push('研报预览证据等级不被正文长度覆盖');
 const allocation=db.get("SELECT * FROM cea_document WHERE source_code='cea_allocation'");
 const allocationInput=buildObjectInput('cea_document',allocation);assert.deepEqual(allocationInput.coverage.find(c=>c.sector==='钢铁').years,[2026]);checks.push('模型输入保留行业与年度配对，避免笛卡尔积误判');
 for(const row of rows)cea.upsertCeaEntity({...row,source_code:'cea_entity_fujian_2026'});
 const one=rows.find(r=>r.credit_code);cea.upsertCeaEntity({...one,credit_code:null,source_code:'cea_entity_fujian_2026'});assert.equal(db.get('SELECT COUNT(*) n FROM cea_entity').n,84);checks.push('同一来源重采丢失代码不产生重复主体');
 const doc=db.get("SELECT id FROM cea_document WHERE source_code='cea_allocation_pdf'");assert.ok(doc);const body='已从实际原件提取的PDF正文，仅用于隔离数据库持久化回归。';
 await persistParseResult({status:'full',text:body,raw_text:body,chars:body.length,pages_total:1,pages:[{page:1,text:body}],hash:'a'.repeat(64)}, {kind:'cea_document',id:doc.id,actor:'test:independent'});
 const saved=db.get('SELECT body_snapshot,ai_status FROM cea_document WHERE id=?',[doc.id]);assert.equal(saved.body_snapshot,body);assert.equal(saved.ai_status,'unverified');checks.push('CEA正文落库使用真实字段，OCR不直接标模型通过');
 process.env.CCER_SECRET_KEY=Buffer.alloc(32,9).toString('base64');
 const ocr=await import('../src/services/baidu-ocr-svc.mjs');
 const config=ocr.saveBaiduOcrConfig({role:'admin',name:'test:config'},{api_key:'A'.repeat(24),secret_key:'B'.repeat(32),enabled:true});assert.ok(config.ok);
 const before=ocr.baiduOcrConfig().credential_cipher;assert.ok(before);
 const realFetch=globalThis.fetch;globalThis.fetch=async url=>new Response(JSON.stringify(String(url).includes('/oauth/')?{access_token:'test-token',expires_in:3600}:{error_code:0,result:{task_id:'test-parser-task'}}),{status:200,headers:{'content-type':'application/json'}});
 try{const probe=await ocr.probeDocParserCapability({actor:'test:probe',deadlineAt:Date.now()+5000});assert.ok(probe.ok);assert.equal(ocr.baiduOcrConfig().credential_cipher,before);assert.equal(ocr.baiduOcrPublicConfig().credential_configured,true);}finally{globalThis.fetch=realFetch;}
 checks.push('文档解析能力探测不删除原有加密凭据');
}finally{db.closeDb();}
console.log(checks.map(x=>'PASS '+x).join('\n'));console.log('Independent evidence checks: '+checks.length);
