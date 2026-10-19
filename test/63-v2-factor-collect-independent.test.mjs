import {readFileSync} from 'node:fs';import {setupV2,testAsync,assertEqual,assert,finish} from './v2-helpers.mjs';
const {db}=await setupV2();const acc=await import('../src/services/accounting-svc.mjs');const collect=await import('../src/services/accounting-collect-svc.mjs');acc.seedAccountingBase();
await testAsync('Actual factor PDF flows through collector, persistence and calculable fields without losing provenance',async()=>{
 const pdf=readFileSync(new URL('./fixtures/accounting/electricity-co2-2023.pdf',import.meta.url));const real=globalThis.fetch;
 globalThis.fetch=async()=>new Response(pdf,{status:200,headers:{'content-type':'application/pdf'}});
 try{const out=await collect.collectElectricityFactorPdf({cfg:{verify_with_model:false},deadlineAt:Date.now()+10000});assertEqual(out.ok,true);assertEqual(out.rows,40);const rows=acc.listFactors({limit:100}).rows;assertEqual(rows.length,40);assert(rows.every(r=>r.calculable&&r.source_code&&r.original_url&&r.original_sha256?.length===64&&r.snapshot_path));assertEqual(db.get('SELECT COUNT(*) c FROM emission_factor WHERE source_code IS NULL').c,0);}finally{globalThis.fetch=real;}
});
await testAsync('A real reparse of forty already-seeded factors is a successful task with forty parsed rows',async()=>{
 const pdf=readFileSync(new URL('./fixtures/accounting/electricity-co2-2023.pdf',import.meta.url));const real=globalThis.fetch;
 globalThis.fetch=async()=>new Response(pdf,{status:200,headers:{'content-type':'application/pdf'}});
 try{const out=await collect.runAccountingCollectTarget({target:'factor_pdf',cfg:{verify_with_model:false,batch_budget_ms:10000},deadlineAt:Date.now()+10000});assertEqual(out.stats.parsed,40);assertEqual(out.detail.factor_pdf.written,0);assertEqual(collect.summarizeAccountingOutcome(out).status,'success');}finally{globalThis.fetch=real;}
 assertEqual(collect.summarizeAccountingOutcome({status:'success',stats:{parsed:0,cached:10,errors:0}}).status,'success');
 assertEqual(collect.summarizeAccountingOutcome({status:'partial',stats:{parsed:3,errors:0}}).status,'partial');
 assertEqual(collect.summarizeAccountingOutcome({stats:{parsed:0,errors:1}}).status,'failed');
});
finish('63-v2-factor-collect-independent.test.mjs');
