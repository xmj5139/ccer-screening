import {all,get,run,metaValue,setMeta,getDb} from '../core/db.mjs';
import {newId,nowIso} from '../core/util.mjs';
import {getSource,ensureAccountingSeeded,recordSourceAttempt,writeAccountingOriginal} from './accounting-svc.mjs';
import {fetchAccountingUrl} from './accounting-collect-svc.mjs';
import {assessFetchedDocument,parseCetsListPage,parseCetsFaqPage,parseCetsArticlePage} from './accounting-parse.mjs';
import {digest,verifyAccountingEvidence} from './accounting-evidence-svc.mjs';

export function listPublicDocuments({q='',category='',doc_type='',limit=100,offset=0}={}){
 const w=['d.is_current=1'],p=[];
 if(q){w.push('(d.title LIKE ? OR d.body_text LIKE ?)');p.push('%'+String(q).slice(0,200)+'%','%'+String(q).slice(0,200)+'%');}
 if(category){w.push('d.category=?');p.push(category);}if(doc_type){w.push('d.doc_type=?');p.push(doc_type);}
 const where=w.join(' AND ');limit=Math.min(200,Math.max(1,Number(limit)||100));offset=Math.max(0,Number(offset)||0);
 return{total:get('SELECT COUNT(*) c FROM accounting_public_document d WHERE '+where,p).c,rows:all(`SELECT d.id,d.title,d.category,d.doc_type,d.url,d.published_at,d.body_status,d.model_verify_status,d.observed_count,d.announced_count,d.limitation,d.captured_at,(SELECT COUNT(*) FROM accounting_public_qa q WHERE q.document_id=d.id) qa_count FROM accounting_public_document d WHERE ${where} ORDER BY d.published_at DESC,d.captured_at DESC LIMIT ? OFFSET ?`,[...p,limit,offset]),limit,offset};
}
export function getPublicDocument(id){const document=get('SELECT * FROM accounting_public_document WHERE id=?',[id]);if(!document)return null;delete document.snapshot_path;return{document,qa:all('SELECT ordinal,question,answer,category,source_url FROM accounting_public_qa WHERE document_id=? ORDER BY ordinal',[id])};}

export function savePublicDocument(row,qa=[]){
 const key=row.source_code+'|'+row.url;const old=get('SELECT * FROM accounting_public_document WHERE doc_key=?',[key]);
 const hash=digest(JSON.stringify({body:row.body_text,title:row.title,published:row.published_at,qa}));
 if(old?.content_hash===hash)return{id:old.id,unchanged:true};
 if(old)run('UPDATE accounting_public_document SET doc_key=?,is_current=0 WHERE id=?',[key+'@'+old.id,old.id]);
 const id=newId('APD'),at=nowIso();const cols={id,source_id:row.source_id,source_code:row.source_code,doc_key:key,doc_type:row.doc_type,category:row.category,title:row.title,url:row.url,published_at:row.published_at||null,issuer:row.issuer||'全国碳市场信息网',body_text:row.body_text||null,body_status:row.body_status||'metadata_only',content_kind:row.doc_type,observed_count:row.observed_count??null,announced_count:row.announced_count??null,fetch_method:row.fetch_method||'configured_fetch',http_status:row.http_status??null,content_hash:hash,snapshot_path:row.snapshot_path||null,captured_at:at,evidence_level:row.body_status==='full'?'full_text':'list_only',model_verify_status:'unavailable',revision_no:Number(old?.revision_no||0)+1,revision_of:old?.id||null,is_current:1,limitation:row.limitation||null,metadata_origin:'actual_public_fetch',created_at:at,updated_at:at};
 const names=Object.keys(cols);run(`INSERT INTO accounting_public_document(${names.join(',')})VALUES(${names.map(()=>'?').join(',')})`,Object.values(cols));
 qa.forEach((r,i)=>run('INSERT INTO accounting_public_qa(id,document_id,ordinal,question,answer,category,source_url,created_at)VALUES(?,?,?,?,?,?,?,?)',[newId('AQA'),id,i+1,r.question,r.answer,row.category,row.url,at]));return{id,unchanged:false};
}
export async function verifyPublicDocument(id,{actor,deadlineAt}={}){
 const d=get('SELECT * FROM accounting_public_document WHERE id=?',[id]);if(!d||d.body_status!=='full')return{result:'insufficient',reason:'not_full_body'};
 const result=await verifyAccountingEvidence({objectType:'accounting_public_document',objectId:id,body:d.body_text,metadata:{title:d.title,source:d.issuer,published_at:d.published_at,category:d.category},url:d.url,complete:true,actor,deadlineAt});run('UPDATE accounting_public_document SET model_verify_status=?,model_verify_at=? WHERE id=?',[result.result,nowIso(),id]);return result;
}
const SECTIONS=[['cets_standards','standard'],['cets_policies','policy'],['cets_faq_general','faq'],['cets_faq_power','faq']];
export async function collectCetsPublic({actor='system:cets-public',cfg={},deadlineAt=Date.now()+120000}={}){
 ensureAccountingSeeded();const rotation=Number(metaValue('accounting_cets_rotation',0))||0;const [code,category]=SECTIONS[rotation%SECTIONS.length];setMeta(getDb(),'accounting_cets_rotation',String(rotation+1));const source=getSource(code);
 const out={ok:true,source:code,found:0,parsed:0,unchanged:0,qa:0,failures:[],truncated:false,verification:[]};
 if(!source?.enabled)return{...out,ok:false,failures:[{error:'source_disabled_or_missing'}]};
 const fetchOne=async(url)=>{
  if(Date.now()>deadlineAt-1000){out.truncated=true;return null;}
  const r=await fetchAccountingUrl(url,{source,deadlineAt,timeoutMs:12000,retryMax:0});
  const guard=r.ok?assessFetchedDocument({httpStatus:r.http_status,html:r.text,url:r.url,contentType:r.content_type}):{ok:false,reason:r.reason,message:r.error};
  if(!guard.ok){out.failures.push({url,http_status:r.http_status,reason:guard.reason,error:guard.message});return null;}
  r.snapshot_path=writeAccountingOriginal(r.hash,r.buf,r.content_type==='text/markdown'?'md':'html');return r;
 };
 const index=await fetchOne(source.url);
 if(!index){recordSourceAttempt(code,{status:'error',url:source.url,error:out.failures[0]?.error||'deadline'});return{...out,ok:false};}
 const provenance={source_id:source.id,source_code:code,url:source.url,category,fetch_method:index.fetch_method||'direct_http',http_status:index.http_status,snapshot_path:index.snapshot_path};
 if(category==='faq'){
  const parsed=parseCetsFaqPage(index.text,{baseUrl:source.url});out.found=parsed.qa.length;
  if(!parsed.qa.length){out.failures.push({url:source.url,error:'未找到完整问答块，未将导航入库'});out.ok=false;}
  else{
   const body=`【原网页标题】${parsed.title}\n`+parsed.qa.map((x,i)=>`第${i+1}问：${x.question}\n答：${x.answer}`).join('\n\n');
   const row=savePublicDocument({...provenance,title:source.name+' · '+parsed.title,doc_type:'faq',body_text:body,body_status:'full',observed_count:parsed.qa.length,announced_count:parsed.announced_count,limitation:parsed.note},parsed.qa);out.parsed=row.unchanged?0:1;out.unchanged=row.unchanged?1:0;out.qa=parsed.qa.length;
   if(cfg.verify_with_model!==false&&Date.now()<deadlineAt-2000)out.verification.push(await verifyPublicDocument(row.id,{actor,deadlineAt}));
  }
 }else{
  const list=parseCetsListPage(index.text,{baseUrl:source.url});out.found=list.entries.length;
  savePublicDocument({...provenance,title:source.name+'（当前页目录）',doc_type:'index',body_status:'index_only',observed_count:list.observed_count,announced_count:list.announced_count,limitation:'仅当前页真实条目；分页依赖原站脚本，未将栏目宣称总量视为已入库数量。'});
  for(const entry of list.entries.slice(0,Math.min(6,Number(cfg.max_details_per_source)||6))){
   if(Date.now()>deadlineAt-2000){out.truncated=true;break;}
   const existing=get("SELECT id,captured_at,model_verify_status FROM accounting_public_document WHERE url=? AND is_current=1 AND body_status='full'",[entry.url]);
   if(existing?.model_verify_status==='verified'&&Date.now()-Date.parse(existing.captured_at)<86400000){out.unchanged++;continue;}
   const f=await fetchOne(entry.url);if(!f)continue;
   const a=parseCetsArticlePage(f.text,{baseUrl:entry.url});
   if(!a.title||!a.body_text||a.body_text.length<60){out.failures.push({url:entry.url,error:'正文结构不完整，未把导航当全文'});continue;}
   const limitation=/30天后|30日后/.test(a.body_text)?'公告包含延后生效及原项目过渡条款，请查阅原文；不自动替代旧方法学。':null;
   const body_text=`【原网页标题】${a.title}\n【原网页发布日期】${a.published_at||entry.published_at||'原站未标注'}\n【原网页来源】${a.issuer||'原站未标注'}\n【文章正文】\n${a.body_text}`;
   const saved=savePublicDocument({...provenance,url:entry.url,title:a.title,doc_type:'article',body_text,body_status:'full',published_at:a.published_at||entry.published_at,issuer:a.issuer,fetch_method:f.fetch_method||'direct_http',http_status:f.http_status,snapshot_path:f.snapshot_path,limitation});
   saved.unchanged?out.unchanged++:out.parsed++;
   if(cfg.verify_with_model!==false&&Date.now()<deadlineAt-2000)out.verification.push(await verifyPublicDocument(saved.id,{actor,deadlineAt}));
  }
 }
 out.ok=!out.failures.length;
 recordSourceAttempt(code,{status:out.ok?'ok':'error',success:out.ok,http_status:index.http_status,url:source.url,content_hash:index.hash,content_bytes:index.bytes,file_path:index.snapshot_path,collected_count:out.found,status_note:`当前页实际条目${out.found}，新增正文${out.parsed}，问答${out.qa}；未取得其他分页不代表已完整覆盖栏目。`,error:out.failures.length?out.failures.map(x=>`${x.url}：${x.http_status||x.reason||'解析'} ${x.error}`).join('；').slice(0,1800):null});return out;
}
