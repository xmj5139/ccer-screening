/** Codex独立验收：区间统计与实际日期口径、未知采集日期。 */
import {setupV2,test,testAsync,assertEqual,finish} from './v2-helpers.mjs';
const ctx=await setupV2({withPublicDemo:false}),{db}=ctx;const tools=await import('../src/services/tool-chat-svc.mjs');const chat=await import('../src/services/chat-svc.mjs');
const at=new Date().toISOString();
try{
 db.run(`INSERT INTO trade_daily(id,trade_date,trade_method,volume,turnover,avg_price,market,session_state,source_url,collected_at,verify_status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,['TD-113','2026-10-15','挂牌协议',100,9000,90,'CCER','traded','https://www.ccer.com.cn/fixture113.shtml',at,'verified',at,at]);
 await testAsync('区间统计可以引用区间内真实覆盖日期，不要求请求首尾日都有交易',async()=>{
  const o=await tools.executeTool('market_statistics',{market:'ccer',from:'2026-10-01',to:'2026-10-15'},{dates:['2026-10-01','2026-10-15']});const e=o.evidence[0];
  const p={answerable:true,paragraphs:[{text:'该区间库内存在行情。',source_ids:[e.source_id],quotes:[{source_id:e.source_id,quote:e.text.slice(0,70)}]}]};
  assertEqual(chat.validateAnswer(p,o.evidence,{question:'统计2026-10-01至2026-10-15的CCER情况'}).ok,true);
  assertEqual(chat.validateAnswer(p,o.evidence,{question:'提供2035-10-19的CCER均价'}).ok,false,'不能把已经匹配别的问题的date_match直接复用到2035');
 });
 test('未知库内采集日期不冒充本轮问答日期',()=>{const e=tools.toolEvidence({sourceKey:'policy',entityType:'policy_document',id:'synthetic',title:'合成测试'});assertEqual(e.collected_at,null);});
 test('日明细不能挤掉回答所需的两个市场程序汇总',()=>{
  const rows=Array.from({length:8},(_,i)=>({source_id:'daily:'+i,kind:'full_text',text:'某日明细'}));
  const chosen=tools.finalEvidenceForPrompt([...rows,{source_id:'sum:cea',kind:'calculated',text:'CEA汇总'},{source_id:'sum:ccer',kind:'calculated',text:'CCER汇总'}]);
  assertEqual(chosen.some(e=>e.source_id==='sum:cea'),true);assertEqual(chosen.some(e=>e.source_id==='sum:ccer'),true);
 });
 await testAsync('未来实际行情直接说明无数据，不联网、不生成虚假日期',async()=>{
  const old=globalThis.fetch;let calls=0;globalThis.fetch=()=>{calls++;throw Error('Must not call');};
  try{const out=await chat.ask({user:{id:'u-viewer',name:'viewer',role:'viewer'},question:'请提供2099年10月19日CCER的实际成交均价和官方原文'});
   assertEqual(out.refused,true);assertEqual(out.as_of,null);assertEqual(out.sources.length,0);assertEqual(calls,0);
  }finally{globalThis.fetch=old;}
 });
 finish('113-v2-tool-date-independent');
}finally{await ctx.cleanup();}
