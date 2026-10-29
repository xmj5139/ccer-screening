// Codex independent regression: same-body replacement, repeated quotes and dates.
import {setupV2,test,testAsync,assert,assertEqual,finish} from './v2-helpers.mjs';
const {db}=await setupV2();
const {upsertContent}=await import('../src/services/content-svc.mjs');
const {extractFieldsWithModel,getFieldEvidence,validateQuote,upsertFieldEvidence}=await import('../src/services/field-evidence-svc.mjs');
const now=new Date().toISOString();
db.run(`INSERT INTO llm_provider (id,name,provider_kind,base_url,model,enabled,use_content_verify,max_calls_per_day,created_at,updated_at) VALUES (?,?,?,?,?,1,1,100,?,?)`,['provider-195','Independent offline stub','ollama','http://127.0.0.1:9/v1/chat/completions','stub-195',now,now]);
const body='本文介绍广东省的煤矿瓦斯公开资料。'+ '数据来自公开文件，字段只是正文提及。'.repeat(10);
const item=upsertContent({title:'公开资料字段更新测试',source_url:'https://example.gov.cn/195-fields.html',content_type:'industry_news',body_snapshot:body,body_availability:'full_text'});
const extract=(reply)=>extractFieldsWithModel('content_item',item.id,{providerId:'provider-195',force:true,callModel:async()=>reply,actor:'test:independent-195'});
const modelFields=()=>getFieldEvidence('content_item',item.id).fields.filter(x=>x.method==='model');

await testAsync('同正文成功重抽取为空集合会撤销旧模型字段，失败调用保留已有证据',async()=>{
  const good={ok:true,parsed:{fields:[{field:'region',value:'广东省',quote:'本文介绍广东省的煤矿瓦斯公开资料。'}]}};
  await extract(good); assertEqual(modelFields().length,1);
  await extract({ok:false,reason:'timeout'}); assertEqual(modelFields().length,1);
  await extract({ok:true,parsed:{fields:[]}}); assertEqual(modelFields().length,0,'不能把上次已撤销的模型字段继续当作当前字段');
});

test('重复引句的码点位置和浏览器UTF16位置必须对应同一处',()=>{
  const text='🌳前句：广东省。\n后句：广东省。';
  const second=Array.from(text.slice(0,text.lastIndexOf('广东省'))).length;
  const r=validateQuote(text,'广东省',{charStart:second,charEnd:second+3,value:'广东省'});
  assert(r.ok); assertEqual(r.utf16_start,text.lastIndexOf('广东省'));
  const inconsistent=validateQuote(text,'广东省',{charStart:second,charEnd:second+3,utf16Start:text.indexOf('广东省'),utf16End:text.indexOf('广东省')+3});
  assertEqual(inconsistent.ok,false,'不能允许两组偏移各自匹配不同的同文片段');
});

test('格式正确但日历上不存在的日期不能成为有效模型日期',()=>{
  const text='发布日期：2026-02-31。';
  const out=upsertFieldEvidence({entityType:'content_item',entityId:item.id,bodyHash:'invalid-calendar',fieldKey:'publish_date',fieldValue:'2026-02-31',valueType:'date',quote:text,text,method:'model',model:'stub-195'});
  assertEqual(out.ok,false);
});
finish('195-v2-field-refresh-independent.test.mjs');
