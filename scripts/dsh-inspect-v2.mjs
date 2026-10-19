#!/usr/bin/env node
/**
 * 只读盘点工具：总览告警 / 数据缺口 / 交易累计差异 / 政策原件归档状态。
 *
 * 用途：DSH 整改前的现状盘点与整改后的复查对照。
 * 严格只读：以 readOnly 打开数据库，不写业务数据、不建表、不迁移。
 *
 * 用法：
 *   node scripts/dsh-inspect-v2.mjs                # 全量盘点
 *   node scripts/dsh-inspect-v2.mjs --section=alerts
 *   node scripts/dsh-inspect-v2.mjs --section=gaps
 *   node scripts/dsh-inspect-v2.mjs --section=recon
 *   node scripts/dsh-inspect-v2.mjs --section=policy
 *   node scripts/dsh-inspect-v2.mjs --section=method
 *   node scripts/dsh-inspect-v2.mjs --section=trade
 *   node scripts/dsh-inspect-v2.mjs --json         # 输出 JSON
 */

import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import process from 'node:process';

const DB_PATH = process.env.CCER_DB_PATH || path.resolve('data/ccer_v2.db');
const args = process.argv.slice(2);
const sectionArg = args.find((a) => a.startsWith('--section='));
const section = sectionArg ? sectionArg.split('=')[1] : 'all';
const asJson = args.includes('--json');

const db = new DatabaseSync(DB_PATH, { readOnly: true });

function all(sql, params = []) {
  try {
    return db.prepare(sql).all(...params);
  } catch (err) {
    return [{ __error: String(err.message) }];
  }
}
function one(sql, params = []) {
  const rows = all(sql, params);
  return rows[0] ?? null;
}
function hasTable(name) {
  return Boolean(one("SELECT name FROM sqlite_master WHERE type='table' AND name = ?", [name]));
}

const out = { db: DB_PATH, generated_at: new Date().toISOString() };

function sectionAlerts() {
  out.alert_counts = all(`SELECT status, severity, COUNT(*) AS c FROM alert GROUP BY 1, 2`);
  out.alert_open = all(
    `SELECT id, kind, severity, status, title, detail, source_id, methodology_id, domain, created_at
     FROM alert WHERE status = 'open' ORDER BY severity, created_at DESC`,
  );
  out.alert_recent_closed = all(
    `SELECT id, kind, severity, status, title, source_id, created_at
     FROM alert WHERE status != 'open' ORDER BY created_at DESC LIMIT 30`,
  );
}

function sectionGaps() {
  out.data_gap_open = all(
    `SELECT id, dataset, gap_key, severity, status, title, description, impact, manual_path, detected_at, updated_at
     FROM data_gap WHERE status = 'open' ORDER BY severity, detected_at DESC`,
  );
  out.data_gap_closed_recent = all(
    `SELECT id, gap_key, severity, status, title, updated_at
     FROM data_gap WHERE status != 'open' ORDER BY updated_at DESC LIMIT 30`,
  );
}

function sectionRecon() {
  out.data_reconciliation_counts = all(
    `SELECT status, severity, check_kind, COUNT(*) AS c FROM data_reconciliation GROUP BY 1, 2, 3`,
  );
  out.data_reconciliation_open = all(
    `SELECT * FROM data_reconciliation WHERE status = 'open' ORDER BY detected_at DESC`,
  );
  out.data_reconciliation_recent = all(
    `SELECT id, dataset, object_id, object_label, check_kind, severity, status, detail,
            expected, actual, detected_at, resolved_at, resolution
     FROM data_reconciliation ORDER BY COALESCE(resolved_at, detected_at) DESC LIMIT 40`,
  );
}

function sectionPolicy() {
  out.policy_recent = all(
    `SELECT id, policy_key, title, doc_number, issuing_authority, category, doc_status,
            publish_date, effective_date, official_url, source_id, local_path,
            original_file_hash, confirmed_by, collected_at, updated_at
     FROM policy_document ORDER BY COALESCE(publish_date, created_at) DESC LIMIT 40`,
  );
  out.policy_attachments = all(
    `SELECT id, policy_id, file_name, file_type, url, file_hash, local_path,
            parse_quality, parse_note, fetched_at
     FROM policy_attachment ORDER BY COALESCE(fetched_at, created_at) DESC LIMIT 40`,
  );
  out.policy_count = one(`SELECT COUNT(*) AS c FROM policy_document`);
}

function sectionMethod() {
  out.methodology_counts = all(
    `SELECT document_status, catalog_confidence, code_display IS NULL AS code_null, COUNT(*) AS c
     FROM methodology_version GROUP BY 1, 2, 3 ORDER BY 4 DESC`,
  );
  out.methodology_list = all(
    `SELECT id, methodology_id, code_display, name, version, document_status, catalog_confidence,
            is_candidate_eligible, official_url, original_file_hash IS NOT NULL AS has_hash,
            original_file_path IS NOT NULL AS has_path, release_date, effective_date
     FROM methodology_version ORDER BY document_status, code_display IS NULL, code_display`,
  );
}

function sectionTrade() {
  out.trade_daily_recent = all(
    `SELECT * FROM trade_daily ORDER BY trade_date DESC LIMIT 25`,
  );
  out.trade_cumulative_reference = all(
    `SELECT * FROM trade_cumulative_reference ORDER BY as_of_date DESC LIMIT 25`,
  );
  out.trade_daily_count = one(`SELECT COUNT(*) AS c, MIN(trade_date) AS min_d, MAX(trade_date) AS max_d FROM trade_daily`);
}

function sectionSchema() {
  out.tables = all(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`).map((r) => r.name);
  out.trade_calendar_rows = hasTable('trade_calendar')
    ? all(`SELECT * FROM trade_calendar ORDER BY trade_date LIMIT 20`)
    : 'table missing';
  out.trade_calendar_count = hasTable('trade_calendar')
    ? one(`SELECT COUNT(*) AS c, MIN(trade_date) AS min_d, MAX(trade_date) AS max_d FROM trade_calendar`)
    : null;
}

const runners = {
  schema: sectionSchema,
  alerts: sectionAlerts,
  gaps: sectionGaps,
  recon: sectionRecon,
  policy: sectionPolicy,
  method: sectionMethod,
  trade: sectionTrade,
};

for (const [key, fn] of Object.entries(runners)) {
  if (section === 'all' || section === key) fn();
}

db.close();

if (asJson) {
  console.log(JSON.stringify(out, null, 2));
} else {
  for (const [key, value] of Object.entries(out)) {
    if (key === 'db' || key === 'generated_at') continue;
    console.log(`\n=== ${key} (${Array.isArray(value) ? value.length : 1}) ===`);
    if (Array.isArray(value)) {
      for (const row of value) console.log(JSON.stringify(row));
    } else {
      console.log(JSON.stringify(value));
    }
  }
}
