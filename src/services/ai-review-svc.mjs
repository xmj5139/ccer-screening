/** 用已配置的大模型复核公开项目字段与文件摘录；只把异常送人工队列。 */
import { createHash } from 'node:crypto';
import { all, get, run, getDb, metaValue, setMeta, audit } from '../core/db.mjs';
import { newId, nowIso, j, uj, todayCst } from '../core/util.mjs';
import { resolveCredential } from './admin-v2-svc.mjs';
import { checkOutboundUrl, createReviewTask } from './collect-svc.mjs';

const KEY = 'registry_ai_review_config';
const DEFAULT = { enabled:false, provider_id:null, review_new_projects:true, max_per_run:30 };
export function reviewConfig() {
  return { ...DEFAULT, ...uj(metaValue(KEY,'{}'),{}) };
}
export function saveReviewConfig(user, patch={}) {
  if (user?.role !== 'admin') return {error:'仅管理员可配置 AI 复核',status:403};
  const next={...reviewConfig()};
  if (patch.enabled!==undefined) next.enabled=!!patch.enabled;
  if (patch.provider_id!==undefined) next.provider_id=patch.provider_id || null;
  if (patch.review_new_projects!==undefined) next.review_new_projects=!!patch.review_new_projects;
  if (patch.max_per_run!==undefined) {
    const n=Number(patch.max_per_run);
    if (!Number.isInteger(n)||n<1||n>200) return {error:'单次复核上限须为 1—200',status:400};
    next.max_per_run=n;
  }
  if (next.enabled && !get('SELECT id FROM llm_provider WHERE id=? AND enabled=1',[next.provider_id]))
    return {error:'请先选择已启用的大模型',status:400};
  setMeta(getDb(),KEY,j(next));
  audit({actor:user.name,actorRole:user.role,action:'ai_review.config',objectType:'system_meta',objectId:KEY,detail:next});
  return {ok:true,config:next};
}
function parseJsonContent(text) {
  const cleaned=String(text||'').trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'');
  return JSON.parse(cleaned);
}
function safeProviderUrl(p) {
  let url;
  try {url=new URL(p.base_url);} catch {throw new Error('模型 Base URL 不合法');}
  const domains=uj(p.allowed_domains,[]);
  const loopback=['localhost','127.0.0.1'].includes(url.hostname);
  if (!(loopback && p.provider_kind==='ollama')) {
    const chk=checkOutboundUrl(url.href,domains);
    if(!chk.ok) throw new Error(chk.reason);
  }
  if(url.protocol!=='https:' && !loopback)
    throw new Error('外部模型连接须使用 HTTPS');
  return url;
}
export async function reviewProject(projectId,{actor='system:ai-review'}={}) {
  const cfg=reviewConfig();
  if(!cfg.enabled) return {ok:false,skipped:true,reason:'AI 复核未启用'};
  const p=get('SELECT * FROM llm_provider WHERE id=? AND enabled=1',[cfg.provider_id]);
  if(!p) return {ok:false,skipped:true,reason:'模型未启用'};
  const cred=resolveCredential(p);
  if(!cred.ok) return {ok:false,skipped:true,reason:cred.reason};
  const project=get('SELECT * FROM public_project WHERE id=?',[projectId]);
  if(!project||!projectId.startsWith('REG-')) return {error:'只能复核自动采集的公开项目',status:400};
  const evidence=all(`SELECT id,file_name,file_hash,excerpt,source_url,retention_note FROM evidence
    WHERE object_type='public_project' AND object_id=? ORDER BY uploaded_at DESC LIMIT 12`,[projectId]);
  const input={project_id:project.id,name:project.name,owner_name:project.owner_name,province:project.province,
    methodology_id:project.methodology_id,methodology_version:project.methodology_version,
    stage:project.current_stage,announced_amount:project.owner_announced_estimate,
    verified_amount:project.verified_amount,registered_amount:project.registered_amount,
    official_url:project.official_url,source_snapshot_id:project.source_snapshot_id,
    evidence:evidence.map(e=>({id:e.id,file_name:e.file_name,source_url:e.source_url,excerpt:e.excerpt?.slice(0,1500)||null,
      extraction_note:e.retention_note}))};
  const inputHash=createHash('sha256').update(JSON.stringify(input)).digest('hex');
  const prev=get(`SELECT result,summary,issues_json FROM ai_review_result WHERE object_type='public_project' AND object_id=? AND input_hash=? ORDER BY reviewed_at DESC LIMIT 1`,
    [projectId,inputHash]);
  if(prev) return {ok:true,cached:true,result:prev.result,summary:prev.summary,issues:uj(prev.issues_json,[])};
  const today=todayCst();
  const used=p.calls_today_date===today?Number(p.calls_today||0):0;
  if(used>=Number(p.max_calls_per_day||200)) return {ok:false,skipped:true,reason:'模型今日调用已达上限'};
  const url=safeProviderUrl(p);
  const prompt=`你是 CCER 公开项目资料复核助手。只比较下列结构化字段与附件摘录的一致性，不推断未给出的事实。`+
    `附件无文本时不得称已读其正文。返回严格 JSON：{\"consistent\":true/false,\"summary\":\"...\",`+
    `\"issues\":[{\"field\":\"...\",\"reason\":\"...\",\"evidence_id\":\"...或null\"}]}.`+
    `发现阶段、业主、方法学、金额矛盾时 consistent=false。不要把项目公示预计量当登记量。\n资料：${JSON.stringify(input)}`;
  const started=Date.now();let status='ok',error=null,raw=null,decision='unavailable',issues=[],summary='';
  try {
    const headers={'content-type':'application/json'};
    if(cred.secret)headers.authorization=`Bearer ${cred.secret}`;
    const res=await fetch(url.href,{method:'POST',headers,
      body:JSON.stringify({model:p.model,messages:[{role:'user',content:prompt}],temperature:0,max_tokens:700}),
      signal:AbortSignal.timeout(Math.min(Number(p.timeout_ms)||30000,60000))});
    if(!res.ok) throw new Error(`模型 HTTP ${res.status}`);
    const body=await res.json();
    raw=body.choices?.[0]?.message?.content;
    const parsed=parseJsonContent(raw);
    if(typeof parsed.consistent!=='boolean'||!Array.isArray(parsed.issues)) throw new Error('模型未返回预期 JSON 结构');
    issues=parsed.issues.slice(0,20).map(x=>({field:String(x.field||''),reason:String(x.reason||''),
      evidence_id:x.evidence_id&&evidence.some(e=>e.id===x.evidence_id)?x.evidence_id:null}));
    summary=String(parsed.summary||'').slice(0,1000);
    decision=parsed.consistent&&issues.length===0?'pass':'flag';
  } catch(e) {status='error';error=e.message;summary=`模型复核失败：${error}`;}
  run(`INSERT INTO llm_call_log (id,provider_id,at,purpose,actor,model,request_chars,response_chars,latency_ms,status,error,
    object_type,object_id,citations_json,draft_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [newId('LLC'),p.id,nowIso(),'project_review',actor,p.model,prompt.length,String(raw||'').length,
      Date.now()-started,status,error,'public_project',projectId,j(evidence.map(e=>e.id)),raw]);
  run('UPDATE llm_provider SET calls_today=?,calls_today_date=? WHERE id=?',[used+1,today,p.id]);
  run(`INSERT INTO ai_review_result (id,object_type,object_id,provider_id,model,input_hash,result,summary,issues_json,
    source_snapshot_id,reviewed_at,raw_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [newId('AIR'),'public_project',projectId,p.id,p.model,inputHash,decision,summary,j(issues),project.source_snapshot_id,
      nowIso(),raw]);
  if(decision==='flag') {
    run("UPDATE public_project SET review_status='pending' WHERE id=?",[projectId]);
    createReviewTask({task_type:'project_ai_flag',object_type:'public_project',object_id:projectId,
      title:`AI 发现项目资料疑点：${project.name.slice(0,40)}`,detail:summary,severity:'medium',
      required_role:'researcher',created_by:actor,payload:{issues}});
  }
  return {ok:decision!=='unavailable',result:decision,summary,issues,model:p.model};
}
export async function reviewRecent({actor='system:ai-review',limit=null}={}) {
  const cfg=reviewConfig();
  const max=Math.min(Number(limit||cfg.max_per_run),200);
  const rows=all(`SELECT id FROM public_project WHERE id LIKE 'REG-%' AND review_status IN ('auto_checked','pending')
    ORDER BY last_checked_at DESC LIMIT ?`,[max]);
  const results=[];
  for(const row of rows) results.push({id:row.id,...await reviewProject(row.id,{actor})});
  return {count:results.length,pass:results.filter(r=>r.result==='pass').length,
    flag:results.filter(r=>r.result==='flag').length,unavailable:results.filter(r=>r.result==='unavailable'||r.skipped).length,
    results};
}
