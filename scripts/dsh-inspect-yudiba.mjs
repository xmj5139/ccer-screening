#!/usr/bin/env node
/** 只读盘点：淤地坝碳汇两条政策记录与其附件的当前状态。 */
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
const db = new DatabaseSync(process.env.CCER_DB_PATH || path.resolve('data/ccer_v2.db'), { readOnly: true });
console.log('=== policy_document ===');
for (const r of db.prepare(
  `SELECT id,policy_key,title,doc_number,doc_status,publish_date,effective_date,official_url,source_id,
          local_path,original_file_hash,supersedes_id,confirmed_by,change_log,collected_at,updated_at
   FROM policy_document WHERE doc_number = ? ORDER BY created_at`
).all('环办气候函〔2025〕438号')) {
  console.log(JSON.stringify(r, null, 1));
}
console.log('\n=== policy_attachment ===');
for (const r of db.prepare(
  `SELECT a.id,a.policy_id,a.file_name,a.file_type,a.url,a.file_hash,a.local_path,a.parse_quality,a.parse_note,a.fetched_at
   FROM policy_attachment a JOIN policy_document p ON p.id=a.policy_id WHERE p.doc_number = ? ORDER BY a.created_at`
).all('环办气候函〔2025〕438号')) {
  console.log(JSON.stringify(r));
}
console.log('\n=== methodology_version CCER-14-005 ===');
for (const r of db.prepare(
  `SELECT id,methodology_id,code_display,name,release_date,effective_date,official_url,catalog_confidence,is_candidate_eligible,exclusion_note,original_file_hash FROM methodology_version WHERE methodology_id='CCER-14-005'`
).all()) console.log(JSON.stringify(r));
db.close();
