/** Codex独立核验：省域地图的口径一致性与修订链，不访问外网。 */
import { setupV2, testAsync, assert, assertEqual, finish } from './v2-helpers.mjs';
const ctx=await setupV2({withPublicDemo:false});
const svc=await import('../src/services/region-map-svc.mjs');
const base=(patch={})=>({province:'山西',scope:'region_co2',year:2024,value_tco2:100,unit:'tCO2',dataset_key:'independent-dataset',source_name:'公开来源协议夹具',source_url:'https://example.org/province/2024',source_kind:'research',methodology:'五部门日数据年度汇总',boundary:'仅五部门二氧化碳排放研究估算，不含其他部门',excerpt:'测试原文证据：2024年山西五部门排放100 tCO2，非真实排放统计。',...patch});
await testAsync('同一数据集同年不能混用核算边界',async()=>{
 const out=svc.importRegionRecords([base({dataset_key:'mixed-boundaries'}),base({province:'河北',dataset_key:'mixed-boundaries',boundary:'仅电力行业排放'})],{actor:'test:independent'});
 assert(!out.ok,'不同核算边界不得合并为同一地图数据集');
 assertEqual(ctx.db.get("SELECT COUNT(*) n FROM region_emission WHERE dataset_key='mixed-boundaries'").n,0,'无效批次必须原子拒绝');
});
await testAsync('新增省份不能改变已有数据集口径或来源等级',async()=>{
 assert(svc.importRegionRecords([base({dataset_key:'existing-boundary'})]).ok);
 const out=svc.importRegionRecords([base({province:'河北',dataset_key:'existing-boundary',source_kind:'official',source_name:'生态环境部',source_url:'https://www.mee.gov.cn/example',boundary:'电力行业全国碳市场纳管排放'})]);
 assert(!out.ok,'不能把现有研究数据集混入官方/不同边界记录');
});
await testAsync('同毫秒多次修订保留唯一有效值和完整修订链',async()=>{
 const originalIso=Date.prototype.toISOString;
 Date.prototype.toISOString=function(){return '2026-10-19T00:00:00.000Z';};
 try {
  for(let i=0;i<12;i++){
   const r=svc.importRegionRecords([base({dataset_key:'same-instant-revisions',value_tco2:100+i})],{actor:'test:revision'});
   assert(r.ok,`第${i+1}次修订应成功：${r.error||''}`);
  }
 } finally { Date.prototype.toISOString=originalIso; }
 const rows=ctx.db.all("SELECT * FROM region_emission WHERE dataset_key='same-instant-revisions'");
 assertEqual(rows.length,12);
 assertEqual(rows.filter(r=>r.status==='active').length,1);
 assertEqual(rows.find(r=>r.status==='active').value_tco2,111);
 let current=rows.find(r=>r.status==='active'),visited=new Set();
 while(current){assert(!visited.has(current.id),'修订链不得成环');visited.add(current.id);current=rows.find(r=>r.id===current.revision_of);}
 assertEqual(visited.size,12,'最新有效值必须能追溯每次修订');
});
await testAsync('无效日历日期不得成为来源发布日期',async()=>{
 assert(!svc.validateImportRecord(base({published_at:'2025-02-30'})).ok);
});
await testAsync('研究来源URL不能包含回环地址的变体',async()=>{
 for(const source_url of ['http://localhost./x','http://[::ffff:127.0.0.1]/x']){
  assert(!svc.validateImportRecord(base({source_url})).ok,`拒绝 ${source_url}`);
 }
});
await testAsync('null/空数值不能导入为零，真实0允许',async()=>{
 for(const value_tco2 of [null,'',undefined,true,NaN,Infinity,-1])assert(!svc.validateImportRecord(base({value_tco2})).ok);
 assert(svc.validateImportRecord(base({value_tco2:0})).ok);
});
await testAsync('历史脏数据不能混用不同边界生成一张热力图',async()=>{
 assert(svc.importRegionRecords([base({dataset_key:'legacy-mixed'}),base({province:'河北',dataset_key:'legacy-mixed'})]).ok);
 ctx.db.run("UPDATE region_emission SET boundary='仅电力行业，非五部门口径' WHERE dataset_key='legacy-mixed' AND province_code='130000'");
 const result=svc.buildRegionMap({metric:'region_co2',year:'2024',dataset:'legacy-mixed'});
 assert(Boolean(result.error) || (Array.isArray(result.regions)&&result.regions.every(r=>r.value===null)), '读取历史脏数据也必须隔离不同边界，不能混合绘图');
});
finish('test/116-v2-region-map-independent.test.mjs');


