#!/usr/bin/env node
/** 只读复查：指定的历史核对记录是否已结清，以及政策原件归档明细。 */
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
const db = new DatabaseSync(process.env.CCER_DB_PATH || path.resolve('data/ccer_v2.db'), { readOnly: true });
const IDS = [
  'REC-0mumdubqw-8c1f98d9', 'REC-0mumdubqz-f5ee4c35',
  'REC-0mumduc6c-5bc248c3', 'REC-0muf7h96y-8c48cb7a', 'REC-0muf7h96z-63e65674',
];
console.log('=== 指定历史核对记录 ===');
for (const id of IDS) {
  const r = db.prepare('SELECT id,dataset,check_kind,severity,status,object_label,resolved_at,resolution FROM data_reconciliation WHERE id = ?').get(id);
  console.log(JSON.stringify(r || { id, missing: true }));
}
console.log('\n=== 已结清（cumulative / policy duplicate / missing_*） ===');
for (const r of db.prepare(
  `SELECT id,dataset,check_kind,severity,status,object_label,resolved_at,resolution FROM data_reconciliation
   WHERE id IN (${IDS.map(() => '?').join(',')}) OR check_kind LIKE 'cumulative%' OR (dataset='policy')
   ORDER BY COALESCE(resolved_at, detected_at) DESC LIMIT 25`
).all(...IDS)) {
  console.log(`- ${r.status} [${r.severity}] ${r.dataset}/${r.check_kind} | ${r.object_label}`);
  console.log(`    ${r.resolution || '(未结清)'}${r.resolved_at ? ` @ ${r.resolved_at}` : ''}`);
}
console.log('\n=== 政策原件归档（有本地文件 + 哈希） ===');
for (const r of db.prepare(
  `SELECT a.id,a.policy_id,p.title,a.file_type,a.file_hash,a.local_path,a.parse_quality,a.parse_note,a.fetched_at
   FROM policy_attachment a JOIN policy_document p ON p.id=a.policy_id
   WHERE a.local_path IS NOT NULL ORDER BY a.created_at`
).all()) {
  console.log(`- ${r.policy_id} | ${String(r.file_type).toUpperCase()} | ${r.parse_quality} | ${r.file_hash}`);
  console.log(`    ${r.local_path}`);
  console.log(`    ${String(r.title).slice(0, 50)} | ${r.parse_note || ''}`);
}
console.log('\n=== 占位附件记录（无本地文件） ===');
for (const r of db.prepare(
  `SELECT a.id,a.policy_id,p.doc_status,a.file_name,a.parse_quality FROM policy_attachment a
   JOIN policy_document p ON p.id=a.policy_id WHERE a.local_path IS NULL ORDER BY a.created_at`
).all()) console.log(JSON.stringify(r));
console.log('\n=== 政策目录状态 ===');
for (const r of db.prepare(
  `SELECT doc_status, COUNT(*) c, SUM(CASE WHEN official_url IS NULL THEN 1 ELSE 0 END) no_url,
          SUM(CASE WHEN local_path IS NULL THEN 1 ELSE 0 END) no_local
   FROM policy_document GROUP BY 1`
).all()) console.log(JSON.stringify(r));
db.close();
