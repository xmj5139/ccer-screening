#!/usr/bin/env node
/** 只读：本次整改的审计留痕与新增数据统计。 */
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
const db = new DatabaseSync(process.env.CCER_DB_PATH || path.resolve('data/ccer_v2.db'), { readOnly: true });
const ACTOR = 'system:dsh-fix-v2-issues';
console.log('=== audit_log by this actor ===');
for (const r of db.prepare('SELECT action, COUNT(*) c FROM audit_log WHERE actor = ? GROUP BY 1 ORDER BY 2 DESC').all(ACTOR)) {
  console.log('  ', r.action, r.c);
}
console.log('  total:', db.prepare('SELECT COUNT(*) c FROM audit_log WHERE actor = ?').get(ACTOR).c);
console.log('\n=== 新增/修订数据 ===');
console.log('  trade_daily 总数:', db.prepare('SELECT COUNT(*) c FROM trade_daily').get().c);
console.log('  trade_daily 2025-03-20:', JSON.stringify(db.prepare("SELECT id,volume,turnover,avg_price,verify_status FROM trade_daily WHERE trade_date='2025-03-20'").get()));
console.log('  trade_dimension 2025-03-20:', db.prepare("SELECT COUNT(*) c FROM trade_dimension WHERE trade_date='2025-03-20'").get().c);
console.log('  trade_revision for new row:', db.prepare("SELECT COUNT(*) c FROM trade_revision WHERE trade_daily_id='TD-0munhj5qz-630ff0e8'").get().c);
console.log('  source_snapshot 总数:', db.prepare('SELECT COUNT(*) c FROM source_snapshot').get().c);
console.log('  policy_document:', JSON.stringify(db.prepare('SELECT doc_status, COUNT(*) c FROM policy_document GROUP BY 1').all()));
console.log('  policy_attachment 有本地文件:', db.prepare('SELECT COUNT(*) c FROM policy_attachment WHERE local_path IS NOT NULL').get().c);
console.log('  methodology_version 已核实编号:', db.prepare("SELECT COUNT(*) c FROM methodology_version WHERE catalog_confidence='verified_from_official_notice'").get().c);
console.log('  data_reconciliation resolved:', db.prepare("SELECT COUNT(*) c FROM data_reconciliation WHERE status='resolved'").get().c);
console.log('  data_reconciliation open:', db.prepare("SELECT COUNT(*) c FROM data_reconciliation WHERE status='open'").get().c);
console.log('  alert closed:', db.prepare("SELECT COUNT(*) c FROM alert WHERE status='closed'").get().c);
console.log('  alert open:', db.prepare("SELECT id,kind,severity,title FROM alert WHERE status='open'").all().map((a) => `${a.kind}:${a.severity}`).join(', '));
db.close();
