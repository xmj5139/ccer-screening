#!/usr/bin/env node
/**
 * 只读终检：复核 DSH 四个整改项的最终状态，并校验归档文件确实存在于磁盘且 SHA-256 一致。
 */
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const DB = process.env.CCER_DB_PATH || path.resolve('data/ccer_v2.db');
const db = new DatabaseSync(DB, { readOnly: true });
const line = (t) => console.log(`\n===== ${t} =====`);

line('1. 2025-03-19 → 2025-03-21 累计口径');
const refs = db.prepare(
  "SELECT as_of_date, volume_total, turnover_total FROM trade_cumulative_reference WHERE as_of_date IN ('2025-03-19','2025-03-20','2025-03-21') ORDER BY as_of_date"
).all();
for (const r of refs) console.log('  官方累计', JSON.stringify(r));
for (const r of db.prepare(
  "SELECT trade_date,volume,turnover,avg_price,session_state,verify_status,source_url,note FROM trade_daily WHERE trade_date BETWEEN '2025-03-19' AND '2025-03-21' ORDER BY trade_date"
).all()) console.log('  行情', JSON.stringify(r));
const cal = db.prepare("SELECT trade_date,day_type,note FROM trade_calendar WHERE trade_date BETWEEN '2025-03-19' AND '2025-03-21' ORDER BY trade_date").all();
for (const c of cal) console.log('  日历', JSON.stringify(c));
const days = db.prepare(
  "SELECT volume, turnover FROM trade_daily WHERE trade_date > '2025-03-19' AND trade_date <= '2025-03-21' AND session_state='traded'"
).all();
const a = refs.find((r) => r.as_of_date === '2025-03-19');
const b = refs.find((r) => r.as_of_date === '2025-03-21');
const sumV = days.reduce((s, d) => s + Number(d.volume || 0), 0);
const sumT = Math.round(days.reduce((s, d) => s + Number(d.turnover || 0), 0) * 100) / 100;
console.log(`  逐日合计 成交量 ${sumV} / 成交额 ${sumT}`);
console.log(`  官方差分 成交量 ${b.volume_total - a.volume_total} / 成交额 ${Math.round((b.turnover_total - a.turnover_total) * 100) / 100}`);
console.log(`  结论：${sumV === b.volume_total - a.volume_total && Math.abs(sumT - (b.turnover_total - a.turnover_total)) < 0.01 ? '一致 ✓' : '不一致 ✗'}`);
for (const r of db.prepare(
  "SELECT id,check_kind,severity,status,object_label,resolution FROM data_reconciliation WHERE dataset='trade' AND object_id LIKE '%2025-03-2%' OR (dataset='trade' AND check_kind LIKE 'cumulative%') ORDER BY detected_at"
).all()) console.log('  历史差异', JSON.stringify(r));

line('2. 淤地坝碳汇 CCER-14-005-V01 政策与原件');
for (const r of db.prepare(
  "SELECT id,policy_key,doc_status,official_url,local_path,original_file_hash,supersedes_id,confirmed_by FROM policy_document WHERE doc_number='环办气候函〔2025〕438号' ORDER BY created_at"
).all()) console.log('  政策', JSON.stringify(r));
for (const r of db.prepare(
  `SELECT a.id,a.policy_id,a.file_name,a.file_type,a.url,a.file_hash,a.local_path,a.parse_quality,a.parse_note
   FROM policy_attachment a JOIN policy_document p ON p.id=a.policy_id WHERE p.doc_number='环办气候函〔2025〕438号'`
).all()) console.log('  附件', JSON.stringify(r));
for (const r of db.prepare(
  "SELECT id,code_display,name,release_date,effective_date,official_url,catalog_confidence,is_candidate_eligible,original_file_hash,original_file_path FROM methodology_version WHERE methodology_id='CCER-14-005'"
).all()) console.log('  方法学', JSON.stringify(r));

line('3. 方法学目录 18 项');
const counts = db.prepare(
  "SELECT document_status, COUNT(*) c, SUM(CASE WHEN code_display IS NULL THEN 1 ELSE 0 END) code_null, SUM(CASE WHEN catalog_confidence='verified_from_official_notice' THEN 1 ELSE 0 END) verified FROM methodology_version GROUP BY 1"
).all();
for (const c of counts) console.log('  ', JSON.stringify(c));
console.log('  system_meta.catalog_baseline =', db.prepare("SELECT value FROM system_meta WHERE key='catalog_baseline'").get()?.value);
for (const r of db.prepare(
  "SELECT code_display,name,release_date,effective_date,is_candidate_eligible,official_url FROM methodology_version WHERE document_status='formal' ORDER BY code_display"
).all()) console.log('  ', JSON.stringify(r));

line('4. 政策原件归档');
let ok = 0;
let bad = 0;
let missing = 0;
for (const r of db.prepare(
  "SELECT a.id,a.file_hash,a.local_path,a.file_type,a.parse_quality,p.title FROM policy_attachment a JOIN policy_document p ON p.id=a.policy_id WHERE a.local_path IS NOT NULL ORDER BY a.created_at"
).all()) {
  const exists = existsSync(r.local_path);
  let hashOk = false;
  if (exists) {
    try { hashOk = createHash('sha256').update(readFileSync(r.local_path)).digest('hex') === r.file_hash; } catch { hashOk = false; }
  }
  if (!exists) missing += 1; else if (hashOk) ok += 1; else bad += 1;
  console.log(`  ${exists ? (hashOk ? '✓' : '✗哈希不符') : '✗文件缺失'} ${r.file_type} ${r.parse_quality} ${r.file_hash?.slice(0, 16)}… ${r.local_path}`);
}
console.log(`  归档文件：哈希校验通过 ${ok}，哈希不符 ${bad}，文件缺失 ${missing}`);

line('5. 未结清告警 / 缺口 / 差异');
for (const r of db.prepare("SELECT id,kind,severity,title,detail FROM alert WHERE status='open' ORDER BY severity").all()) {
  console.log('  告警', JSON.stringify({ id: r.id, kind: r.kind, severity: r.severity, title: r.title }));
}
console.log('  已结清告警（kind=catalog_gap）:', JSON.stringify(db.prepare("SELECT id,status,substr(detail,1,80) d FROM alert WHERE kind='catalog_gap'").all()));
for (const r of db.prepare("SELECT gap_key,severity,status,title,description FROM data_gap WHERE status!='closed' ORDER BY severity").all()) {
  console.log('  缺口', JSON.stringify(r));
}
const stats = db.prepare(
  `SELECT dataset, check_kind, severity, COUNT(*) c FROM data_reconciliation WHERE status='open' GROUP BY 1,2,3 ORDER BY 1,2`
).all();
for (const s of stats) console.log('  未结清差异', JSON.stringify(s));
db.close();
