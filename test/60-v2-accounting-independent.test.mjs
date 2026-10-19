// Independent checks against a separately extracted and visually checked official PDF.
import {readFileSync} from 'node:fs';
import {setupV2,test,assert,assertEqual,assertThrows,finish} from './v2-helpers.mjs';
const ctx=await setupV2();
const acc=await import('../src/services/accounting-svc.mjs');
const calc=await import('../src/services/carbon-calc-svc.mjs');
const parse=await import('../src/services/accounting-parse.mjs');
const golden=JSON.parse(readFileSync(new URL('./fixtures/electricity-2023-independent-golden.json',import.meta.url),'utf8').replace(/^\uFEFF/,''));
acc.seedAccountingBase();
const rows=acc.listFactors({limit:1000}).rows;
test('40 factor values, scopes, years and physical page locators match independently extracted official PDF',()=>{
 assertEqual(rows.length,40);
 const categories={1:'national_average',2:'regional_average',3:'provincial_average',4:'national_excl_market_nonfossil',5:'national_fossil'};
 for(const g of golden.rows){const r=rows.find(r=>r.category===categories[g.table]&&(r.region||'全国')===g.region);assert(r,JSON.stringify(g));assertEqual(r.value,g.value);assertEqual(r.data_year,2023);assertEqual(r.gas,'CO2');assertEqual(r.original_unit,g.unit);assertEqual(r.page_physical,g.physical_page);assertEqual(String(r.page_printed),String(g.printed_page));assertEqual(r.original_sha256,golden.sha256);}
 assert(!rows.some(r=>r.region==='西藏'),'do not invent a Tibet factor');
});
const national=rows.find(r=>r.category==='national_average');
const base={energy:100,energy_unit:'万kWh',factor_id:national.id,target_year:2023};
test('Arithmetic, conversions and year boundaries are explicit',()=>{
 assertEqual(calc.calculateElectricity(base).total_tco2,530.6);
 assertEqual(calc.calculateElectricity({...base,energy:1000,energy_unit:'MWh'}).total_tco2,530.6);
 assertThrows(()=>calc.calculateElectricity({...base,target_year:2026}));
 assertEqual(calc.calculateElectricity({...base,target_year:2026,accept_reference_year:true}).total_tco2,530.6);
 for(const year of [undefined,null,'',true,[],0,2101]) assertThrows(()=>calc.calculateElectricity({...base,target_year:year}));
 assertThrows(()=>calc.calculateElectricity({...base,data_year:[2023]}));
});
test('No source-only or failed-ID fallback to a silently selected factor',()=>{
 assertThrows(()=>calc.calculateElectricity({...base,factor_id:null,source_code:national.source_code}));
 assertThrows(()=>calc.calculateElectricity({...base,factor_id:'does-not-exist',source_code:national.source_code,category:national.category}));
 assertThrows(()=>calc.calculateElectricity({...base,region:'西藏'}));
});
test('Wrong carbon unit or missing manual electricity unit cannot silently produce CO2',()=>{
 assertThrows(()=>calc.calculateElectricity({energy:100,energy_unit:'kWh',factor_value:0.5306,target_year:2023}));
 const f={amount:100,amount_unit:'t',ncv:20,ncv_unit:'GJ/t',carbon_content:25.8,carbon_content_unit:'tC/TJ',oxidation_rate:0.98};
 assert(Math.abs(calc.calculateFuelCombustion(f).total_tco2-185.416)<1e-8);
 assertThrows(()=>calc.calculateFuelCombustion({...f,carbon_content_unit:'kgC/GJ'}));
 assertThrows(()=>calc.calculateFuelCombustion({...f,carbon_content_unit:undefined}));
});
test('HTTP200 NCSC loading shell is not a successful public document',()=>{
 const x=parse.assessFetchedDocument({httpStatus:200,html:'正在加载系统资源，请耐心等待',url:'https://data.ncsc.org.cn/factories/index'});
 assertEqual(x.ok,false);
});
test('Completeness depends on physical coverage, and changed text invalidates a previous model verdict',()=>{
 const s=ctx.db.get('SELECT id FROM accounting_standard WHERE pages_total>40 LIMIT 1');
 assert(s);
 const x=acc.attachStandardBody(s.id,{bodyText:'截断正文'.repeat(1000),pagesTotal:51,pagesRead:40,extractionComplete:false,source:'https://www.mee.gov.cn/example.pdf'});
 assertEqual(x.body_status,'partial');
 ctx.db.run("UPDATE accounting_standard SET model_verify_status='verified' WHERE id=?",[s.id]);
 acc.attachStandardBody(s.id,{bodyText:'不同的完整正文'.repeat(400),pagesTotal:3,pagesRead:3,extractionComplete:true,source:'https://www.mee.gov.cn/example.pdf'});
 const r=ctx.db.get('SELECT * FROM accounting_standard WHERE id=?',[s.id]);
 assertEqual(r.body_status,'full');assert(r.model_verify_status!=='verified');
});
finish('60-v2-accounting-independent.test.mjs');
