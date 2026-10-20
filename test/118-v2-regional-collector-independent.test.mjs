/** Codex独立核验：省域采集下载完整期限与同hash缺失补采。纯临时库/协议夹具。 */
import {setupV2,testAsync,assert,assertEqual,finish} from './v2-helpers.mjs';
import {createHash} from 'node:crypto';
const ctx=await setupV2({withPublicDemo:false});
const collect=await import('../src/services/regional-collect-svc.mjs');
const region=await import('../src/services/region-map-svc.mjs');
await testAsync('下载期限包括响应正文，不能只限制获取响应头',async()=>{
 let streamController;
 const pending=collect.downloadCarbonMonitorCsv({timeoutMs:25,fetchImpl:async(_url,{signal})=>new Response(new ReadableStream({start(c){streamController=c;signal.addEventListener('abort',()=>c.error(new DOMException('aborted','AbortError')),{once:true});}}),{headers:{'content-type':'text/csv'}})}).then(()=>({failed:false}),error=>({failed:true,error:error.message}));
 let handle;
 const result=await Promise.race([pending,new Promise(resolve=>{handle=setTimeout(()=>resolve({late:true}),180);})]);
 clearTimeout(handle);
 if(result.late){streamController.error(new Error('test cleanup'));await pending;}
 assert(!result.late,'响应头已返回后正文仍必须受同一超时约束');
 assert(result.failed,'正文无数据且不结束时下载应超时失败');
});
await testAsync('同源文件hash相同但库内只导入部分地区时仍须补齐',async()=>{
 const lines=['state,date,sector,value,'];
 for(const state of ['Shanxi','Shaanxi'])for(let i=0;i<365;i++){
  const d=new Date(Date.UTC(2025,0,1+i));const date=`${String(d.getUTCDate()).padStart(2,'0')}/${String(d.getUTCMonth()+1).padStart(2,'0')}/2025`;
  for(const sector of collect.CARBONMONITOR_SECTORS)lines.push(`"${state}","${date}","${sector}","0.000001",`);
 }
 const csv=lines.join('\n');const sha=createHash('sha256').update(csv).digest('hex');
 const parsed=collect.parseCarbonMonitorCsv(csv,{lastCompleteYear:2025,now:'2026-10-19T00:00:00.000Z',snapshotHash:sha});
 assert(parsed.ok);assertEqual(parsed.annual.length,2);
 assert(region.importRegionRecords([parsed.annual[0]]).ok);
 const out=await collect.collectCarbonMonitor({csvText:csv,archiveDir:ctx.dir+'/partial-hash',now:'2026-10-19T00:00:00.000Z'});
 assert(out.ok,JSON.stringify(out));
 const count=ctx.db.get("SELECT COUNT(*) n FROM region_emission WHERE status='active' AND dataset_key=?",[collect.CARBONMONITOR_DATASET_KEY]).n;
 assertEqual(count,2,'hash相同不能成为跳过缺失省份的理由');
});
await testAsync('多次重定向共享总下载期限，不逐跳重置',async()=>{
 let hops=0;let rejected=false;
 try{await collect.downloadCarbonMonitorCsv({timeoutMs:35,fetchImpl:async(url,{signal})=>{
  const hop=++hops;await new Promise((resolve,reject)=>{const t=setTimeout(resolve,hop===1?20:25);signal.addEventListener('abort',()=>{clearTimeout(t);reject(new DOMException('aborted','AbortError'));},{once:true});});
  return hop===1?new Response(null,{status:302,headers:{location:url}}):new Response('state,date,sector,value,\n',{headers:{'content-type':'text/csv'}});
 }});}catch{rejected=true;}
 assert(rejected,'重定向不能把35ms总期限延长为逐跳35ms');
});
finish('test/118-v2-regional-collector-independent.test.mjs');

