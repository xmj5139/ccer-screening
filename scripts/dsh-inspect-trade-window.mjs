#!/usr/bin/env node
/**
 * 只读盘点：交易日历 + 2025 年 3 月区间行情与累计基准，用于核对
 * 「2025-03-21 累计差分告警」的根因（是否漏采 2025-03-20）。
 *
 * 严格只读。用法：
 *   node scripts/dsh-inspect-trade-window.mjs --from=2025-03-10 --to=2025-03-31
 */

import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import process from 'node:process';

const DB_PATH = process.env.CCER_DB_PATH || path.resolve('data/ccer_v2.db');
const args = process.argv.slice(2);
const getArg = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : fallback;
};
const from = getArg('from', '2025-03-01');
const to = getArg('to', '2025-03-31');

const db = new DatabaseSync(DB_PATH, { readOnly: true });
const all = (sql, p = []) => db.prepare(sql).all(...p);

console.log(`db=${DB_PATH}\nwindow=${from} .. ${to}\n`);

console.log('=== trade_daily in window ===');
for (const r of all(
  `SELECT trade_date, volume, turnover, avg_price, session_state, source_url, published_at, collected_at, verify_status
   FROM trade_daily WHERE trade_date BETWEEN ? AND ? ORDER BY trade_date`,
  [from, to],
)) {
  console.log(JSON.stringify(r));
}

console.log('\n=== trade_cumulative_reference in window ===');
for (const r of all(
  `SELECT as_of_date, volume_total, turnover_total, source_url, note FROM trade_cumulative_reference
   WHERE as_of_date BETWEEN ? AND ? ORDER BY as_of_date`,
  [from, to],
)) {
  console.log(JSON.stringify(r));
}

console.log('\n=== trade_calendar in window ===');
for (const r of all(
  `SELECT * FROM trade_calendar WHERE trade_date BETWEEN ? AND ? ORDER BY trade_date`,
  [from, to],
)) {
  console.log(JSON.stringify(r));
}

console.log('\n=== nearest cumulative refs around window ===');
for (const r of all(
  `SELECT as_of_date, volume_total, turnover_total FROM trade_cumulative_reference
   WHERE as_of_date < ? ORDER BY as_of_date DESC LIMIT 3`,
  [from],
)) console.log(JSON.stringify(r));
for (const r of all(
  `SELECT as_of_date, volume_total, turnover_total FROM trade_cumulative_reference
   WHERE as_of_date > ? ORDER BY as_of_date ASC LIMIT 3`,
  [to],
)) console.log(JSON.stringify(r));

console.log('\n=== trade_revision in window ===');
for (const r of all(
  `SELECT * FROM trade_revision WHERE trade_date BETWEEN ? AND ? ORDER BY trade_date`,
  [from, to],
)) console.log(JSON.stringify(r));

db.close();
