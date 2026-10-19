import assert from 'node:assert/strict';
import { all, get, run, closeDb } from '../src/core/db.mjs';
import { ensureAccountingSeeded } from '../src/services/accounting-svc.mjs';
import { SUMMARY_ENTITIES, loadSummaryInput, summaryInputHash, runSummaryBatch } from '../src/services/summary-svc.mjs';
import { RETRIEVAL_SOURCES, retrieveEvidence } from '../src/services/retrieval-svc.mjs';
import { maintenanceOverview, EDITABLE_ENTITIES, previewEdit } from '../src/services/admin-maintenance-svc.mjs';
import { sourceDisplay } from '../src/services/source-display-svc.mjs';

assert(process.env.CCER_DB_PATH && process.env.CCER_ENABLE_V2 === '1', 'Explicit isolated test database required');
ensureAccountingSeeded();
for(const url of ['https://www.chinacrc.net.cn/','https://data.ncsc.org.cn/factories/index','https://www.gov.cn/']){
  assert.equal(sourceDisplay({url}).kind,'official',`Known official source must be classified: ${url}`);
}
const now = new Date().toISOString();
run(`INSERT INTO public_project(id,name,registry_project_no,province,current_stage,official_url,created_at,updated_at)
 VALUES(?,?,?,?,?,?,?,?)`,['INDEPENDENT-PROJECT','独立核验煤矿低浓度瓦斯公开项目','CCER-INDEPENDENT-001','山西','project_public','https://ccer.cets.org.cn/projectPublicity/projectPublicityList',now,now]);

// Every supported database branch must compile against the actual migrated schema.
// Returning no records after swallowing a schema error would silently disable database-first answers.
for(const src of RETRIEVAL_SOURCES) {
  assert.doesNotThrow(()=>all(`${src.sql} LIMIT 1`), `retrieval schema mismatch: ${src.key}`);
}
for(const [kind,cfg] of Object.entries(SUMMARY_ENTITIES)) {
  assert.doesNotThrow(()=>all(`SELECT ${cfg.select} FROM ${cfg.table} LIMIT 1`), `summary schema mismatch: ${kind}`);
}
const admin={id:'independent-admin',name:'independent-admin',role:'admin'};
assert.doesNotThrow(()=>maintenanceOverview(admin),'Maintenance dashboard queries use actual schema');
for(const [kind,cfg] of Object.entries(EDITABLE_ENTITIES)){
  const first=get(`SELECT id FROM ${cfg.table} LIMIT 1`);
  if(first) assert.doesNotThrow(()=>previewEdit(admin,{entity_type:kind,entity_id:first.id}),`Actual editable fields: ${kind}`);
}

const project = loadSummaryInput('public_project','INDEPENDENT-PROJECT');
assert(project && project.text.includes('CCER-INDEPENDENT-001'));
assert.equal(project.url,'https://ccer.cets.org.cn/projectPublicity/projectPublicityList','Public project answers retain their official source');
const factorId = get("SELECT id FROM emission_factor WHERE category='national_average' AND data_year=2023")?.id;
assert(factorId,'Official factor seed exists');
const factor = loadSummaryInput('emission_factor',factorId);
assert.match(factor.text,/0\.5306/);
assert.match(factor.text,/kgCO2\/kWh/);
assert(retrieveEvidence('CCER-INDEPENDENT-001').evidence.some(e=>e.entity_id==='INDEPENDENT-PROJECT'),'Exact public project identifier retrieved');
assert(retrieveEvidence('2023年全国电力排放因子').evidence.some(e=>e.entity_type==='emission_factor'),'Factors participate in database-first answers');

// Changing a clause after the model input cutoff still invalidates the original-document cache.
run(`INSERT INTO policy_document(id,policy_key,title,category,body_snapshot,collected_at,created_at,updated_at)
 VALUES(?,?,?,?,?,?,?,?)`,['HASH-POLICY','hash-policy','正文尾部变化核验','management','正文'.repeat(4000)+'旧条款',now,now,now]);
const before=loadSummaryInput('policy_document','HASH-POLICY');
run('UPDATE policy_document SET body_snapshot=? WHERE id=?',['正文'.repeat(4000)+'新条款','HASH-POLICY']);
const after=loadSummaryInput('policy_document','HASH-POLICY');
assert.notEqual(summaryInputHash(before),summaryInputHash(after),'Full source hash, including text outside the input window, affects freshness');
const bounded=await runSummaryBatch({limit:1,budgetMs:5000,actor:'independent-budget-check'});
assert.equal(bounded.scanned,1,'A nonempty eligible database must attempt a candidate even when no model is configured');
assert(bounded.scanned<=1,`Global batch limit=1 must cover all entity types together, got ${bounded.scanned}`);
console.log('Independent actual-schema, public-source, database-first and full-source-hash checks passed');
closeDb();
