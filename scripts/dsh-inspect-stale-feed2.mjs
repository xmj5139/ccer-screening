#!/usr/bin/env node
/** 只读排查（第二轮）：核对已结清差异是否真有依据、残留人工措辞、归档统计。 */
process.env.CCER_ENABLE_V2 = process.env.CCER_ENABLE_V2 || '1';
process.env.CCER_DB_PATH = process.env.CCER_DB_PATH || 'data/ccer_v2.db';

const { all, get, closeDb, dbPath } = await import('../src/core/db.mjs');
console.log(`库：${dbPath()}\n`);

console.log('--- 已结清的 6 条区间差异：缺失交易日现在是否已有行情 ---');
for (const rec of all("SELECT id, object_id, status, resolution, resolved_at FROM data_reconciliation WHERE check_kind='cumulative_interval_incomplete' ORDER BY detected_at DESC")) {
  const [a, b] = String(rec.object_id).split('..');
  const rows = all(
    "SELECT trade_date, session_state, volume FROM trade_daily WHERE trade_date > ? AND trade_date <= ? ORDER BY trade_date",
    [a, b]
  );
  const cal = all("SELECT trade_date, day_type FROM trade_calendar WHERE trade_date > ? AND trade_date <= ? ORDER BY trade_date", [a, b]);
  console.log(`${rec.id} ${rec.object_id} status=${rec.status}`);
  console.log(`   行情: ${rows.map((r) => `${r.trade_date}/${r.session_state}/${r.volume}`).join(' ') || '(无)'}`);
  console.log(`   日历: ${cal.map((c) => `${c.trade_date}/${c.day_type}`).join(' ') || '(无)'}`);
}

console.log('\n--- 未结清差异明细 ---');
for (const r of all("SELECT id,dataset,object_id,object_label,check_kind,severity,detected_at,detail FROM data_reconciliation WHERE status='open' ORDER BY severity, detected_at DESC")) {
  console.log(JSON.stringify(r));
}

console.log('\n--- 显示文本中仍含「人工/研究员/待办」字样的行 ---');
for (const t of [
  ['alert', "SELECT id,status,kind,title,detail FROM alert WHERE title LIKE '%人工%' OR detail LIKE '%人工%' OR detail LIKE '%研究员%' OR title LIKE '%研究员%'"],
  ['data_gap', "SELECT id,status,gap_key,title,description,impact,auto_action,manual_path FROM data_gap WHERE COALESCE(title,'')||COALESCE(description,'')||COALESCE(impact,'')||COALESCE(auto_action,'') LIKE '%人工%' OR COALESCE(description,'') LIKE '%研究员%' OR COALESCE(manual_path,'') LIKE '%人工%'"],
  ['notification', "SELECT id,read_at,title,detail FROM notification WHERE COALESCE(title,'')||COALESCE(detail,'') LIKE '%人工%'"],
  ['data_reconciliation', "SELECT id,status,dataset,check_kind,detail FROM data_reconciliation WHERE status='open' AND (detail LIKE '%人工%' OR detail LIKE '%签字%' OR detail LIKE '%专家%')"],
]) {
  const rows = all(t[1]);
  console.log(`[${t[0]}] ${rows.length} 行`);
  for (const r of rows) console.log('   ' + JSON.stringify(r).slice(0, 500));
}

console.log('\n--- 政策归档实时统计（现行政策） ---');
const policies = all("SELECT id,title,official_url,local_path,original_file_hash,doc_status FROM policy_document WHERE doc_status != 'superseded'");
let archived = 0, unarchived = 0, good = 0, partial = 0;
for (const p of policies) {
  const atts = all('SELECT id,parse_quality,local_path,file_hash,parse_note FROM policy_attachment WHERE policy_id = ?', [p.id]);
  const arch = atts.filter((a) => a.local_path && a.file_hash);
  if (arch.length || (p.local_path && p.original_file_hash)) archived += 1; else unarchived += 1;
  if (arch.some((a) => a.parse_quality === 'good')) good += 1;
  else if (arch.length) { partial += 1; console.log(`   partial: ${p.title} ← ${arch[0].parse_note}`); }
}
console.log(`  现行政策 ${policies.length}：已归档 ${archived}，未归档 ${unarchived}，正文 good ${good}，partial ${partial}`);

console.log('\n--- alert 全量（含 closed） ---');
for (const a of all('SELECT id,kind,severity,status,title,detail FROM alert ORDER BY status, created_at')) {
  console.log(`[${a.status}] ${a.kind} | ${a.title}`);
  console.log(`     ${String(a.detail).slice(0, 300)}`);
}

closeDb();
