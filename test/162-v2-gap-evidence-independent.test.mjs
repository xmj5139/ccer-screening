// Synthetic historical ledger + archived source: classification must consume actual evidence.
import {setupV2,test,testAsync,assertEqual,finish} from './v2-helpers.mjs';
const {db}=await setupV2({withPublicDemo:false});
const triage=await import('../src/services/gap-triage-svc.mjs');
const now=new Date().toISOString(),url='https://overview.cneeex.com/c/2025-02-19/independent-company.shtml';
db.run(`INSERT INTO source_snapshot(id,url,fetched_at,http_status,content_hash,body_text,created_at) VALUES(?,?,?,200,?,?,?)`,['independent-company-snapshot',url,now,'synthetic-hash','<title>基本信息-上海环境能源交易所</title><main><h1>基本信息</h1><p>企业名称：上海环境能源交易所股份有限公司。企业类型：股份有限公司。成立时间：2008年8月5日。</p></main>',now]);
for(const [id,key,title] of [['independent-source-gap','cea:trade:parse:'+url,'CEA 日报解析失败'],['independent-real-conflict','cea:trade:cumulative:'+url,'累计差异尚未核实']]){
 db.run(`INSERT INTO data_gap(id,dataset,gap_key,title,description,impact,severity,status,detected_at,updated_at) VALUES(?,'cea_trade',?,?,?,'不得生成零值行','critical','open',?,?)`,[id,key,title,'正文中没有可识别的行情字段。'+url,now,now]);
}
test('An archived same-URL company page is classified even when old ledger only says parse failure',()=>{
 const gap=db.get('SELECT * FROM data_gap WHERE id=?',['independent-source-gap']);
 assertEqual(triage.classifyGap(gap).category,'non_target','use the archived title/main text, not only regexes over the old alert');
});
test('Periodic persisted triage mitigates only the proven non-target parse alert',()=>{
 triage.triageGaps({persist:true});
 assertEqual(db.get('SELECT status FROM data_gap WHERE id=?',['independent-source-gap']).status,'mitigated');
 assertEqual(db.get('SELECT status FROM data_gap WHERE id=?',['independent-real-conflict']).status,'open','a cumulative discrepancy is not fixed by excluding an unrelated candidate');
});
await testAsync('The actual daily governance entry performs evidence-based gap upkeep',async()=>{
 db.run("UPDATE data_gap SET status='open' WHERE id=?",['independent-source-gap']);
 const governance=await import('../src/services/governance-svc.mjs');
 await governance.runDailyGovernance({limit:1,budgetMs:1000});
 assertEqual(db.get('SELECT status FROM data_gap WHERE id=?',['independent-source-gap']).status,'mitigated','a manual triage function alone does not provide daily calibration');
 assertEqual(db.get('SELECT status FROM data_gap WHERE id=?',['independent-real-conflict']).status,'open');
});
finish('162-v2-gap-evidence-independent.test.mjs');
