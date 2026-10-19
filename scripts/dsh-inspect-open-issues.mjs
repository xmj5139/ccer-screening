#!/usr/bin/env node
/** 只读盘点：未结清核对差异 + 未结清告警 + 缺口（按 dataset 分组）。 */
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
const db = new DatabaseSync(process.env.CCER_DB_PATH || path.resolve('data/ccer_v2.db'), { readOnly: true });
const args = process.argv.slice(2);
const ds = args.find((a) => a.startsWith('--dataset='))?.split('=')[1] || null;
const sql = `SELECT id,dataset,object_id,object_label,check_kind,severity,status,detail,expected,actual,detected_at,resolved_at,resolution
             FROM data_reconciliation WHERE status='open' ${ds ? 'AND dataset = ?' : ''}
             ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, dataset, detected_at DESC`;
const rows = ds ? db.prepare(sql).all(ds) : db.prepare(sql).all();
console.log(`未结清核对差异 ${rows.length} 条${ds ? `（dataset=${ds}）` : ''}`);
const byKind = {};
for (const r of rows) byKind[`${r.dataset}/${r.check_kind}/${r.severity}`] = (byKind[`${r.dataset}/${r.check_kind}/${r.severity}`] || 0) + 1;
console.log(JSON.stringify(byKind, null, 1));
for (const r of rows) {
  console.log(`- [${r.severity}] ${r.dataset}/${r.check_kind} | ${r.object_label} | ${r.object_id}`);
  console.log(`    ${String(r.detail).slice(0, 400)}`);
}
console.log('\n=== OPEN ALERTS ===');
for (const r of db.prepare("SELECT id,kind,severity,title,status,created_at FROM alert WHERE status='open'").all()) {
  console.log(JSON.stringify(r));
}
console.log('\n=== OPEN GAPS ===');
for (const r of db.prepare("SELECT id,gap_key,severity,status,title,description FROM data_gap WHERE status='open'").all()) {
  console.log(JSON.stringify(r));
}
console.log('\n=== ALL GAPS ===');
for (const r of db.prepare("SELECT gap_key,severity,status,title,updated_at FROM data_gap ORDER BY status, severity").all()) {
  console.log(JSON.stringify(r));
}
db.close();
