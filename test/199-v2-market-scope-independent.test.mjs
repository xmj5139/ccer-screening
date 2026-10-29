// Codex independent cross-market reconciliation acceptance.
import {setupV2,test,assert,assertEqual,finish} from './v2-helpers.mjs';
const {db}=await setupV2();
const {importMarketCandidates,listMarketCandidates}=await import('../src/services/market-candidate-svc.mjs');
const now=new Date().toISOString(), date='2021-02-17';
for(const [i,method,volume] of [[1,'挂牌协议',100000],[2,'大宗协议',50000]]) {
  db.run(`INSERT INTO trade_daily (id,trade_date,trade_method,volume,turnover,avg_price,market,collected_at,created_at,updated_at) VALUES (?,?,?,?,?,50,'CCER',?,?,?)`,[`T199-${i}`,date,method,volume,volume*50,now,now,now]);
}
const snapshot=()=>JSON.stringify({ccer:db.all('SELECT * FROM trade_daily ORDER BY id'),cea:db.all('SELECT * FROM cea_trade_daily ORDER BY id')});
const before=snapshot();
const ingest=(rows)=>{
  const out=importMarketCandidates({user:{id:'user-admin',name:'独立核验',role:'admin'},format:'json',text:JSON.stringify(rows),sourceName:'第三方测试来源',sourceUrl:'https://example.com/public-market-history',asOf:'2026-10-29'});
  assert(!out.error,JSON.stringify(out));
  return listMarketCandidates({importId:out.import_id||out.id||out.import?.id,limit:200});
};
test('CCER候选核对独立CCER正式表，并按日合计不同交易方式',()=>{
  const rows=ingest([{trade_date:date,instrument:'CCER',unit:'tCO2e',volume:150000,turnover:7500000,avg_price:50}]);
  assert(rows.some(x=>x.trade_date===date&&x.instrument==='CCER'&&x.diff_status==='match'),'不能只查CEA正式表而误报CCER缺口');
});
test('1吨差异不可用0.5%容差隐藏为一致',()=>{
  const rows=ingest([{trade_date:date,instrument:'CCER',unit:'tCO2e',volume:149999,turnover:7500000,avg_price:50}]);
  assert(rows.some(x=>x.instrument==='CCER'&&x.diff_status==='conflict'),'15万吨中的1吨差异也应保留');
});
test('不支持的标的与未来交易日标为unsupported，而非新增官方缺口',()=>{
  const rows=ingest([{trade_date:date,instrument:'GDEA',unit:'tCO2e',volume:20},{trade_date:'2026-12-30',instrument:'CEA',unit:'tCO2e',volume:20}]);
  assertEqual(rows.filter(x=>x.diff_status==='unsupported').length,2);
});
test('两套官方行情表在候选导入前后完全不变',()=>assertEqual(snapshot(),before));
finish('199-v2-market-scope-independent.test.mjs');
