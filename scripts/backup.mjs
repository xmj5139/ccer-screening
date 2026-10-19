#!/usr/bin/env node
/**
 * 数据库备份与完整性校验
 * ============================================================================
 * 用法：
 *   node scripts/backup.mjs                      # 备份到 data/backups/
 *   node scripts/backup.mjs --out D:\backup      # 指定输出目录
 *   node scripts/backup.mjs --keep 30            # 只保留最近 30 份
 *   node scripts/backup.mjs --verify <文件>      # 只校验已有备份
 *
 * 实现说明：
 *   - 使用 SQLite 的 VACUUM INTO 生成一致性快照（比直接复制文件安全，避免 WAL 未合并）
 *   - 同时导出 JSON 快照（来源库 / 方法学目录 / 规则 / 因子 / 项目），便于人工核对与异地保管
 *   - 输出 SHA-256 校验值，写入 manifest.json
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, dirname, basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDb, dbPath, closeDb, all, get } from '../src/core/db.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const args = process.argv.slice(2);

const argVal = (name, fallback = null) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

/* ------------------------------- 校验模式 ------------------------------- */
const verifyTarget = argVal('--verify');
if (verifyTarget) {
  const p = resolve(verifyTarget);
  if (!existsSync(p)) {
    console.error(`文件不存在：${p}`);
    process.exit(1);
  }
  const buf = readFileSync(p);
  const hash = createHash('sha256').update(buf).digest('hex');
  console.log(`文件：${p}`);
  console.log(`大小：${buf.length} 字节`);
  console.log(`SHA-256：${hash}`);

  const manifestPath = join(dirname(p), 'manifest.json');
  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const rec = (manifest.backups || []).find((b) => basename(p) === b.file);
    if (rec) {
      const ok = rec.sha256 === hash;
      console.log(`清单记录：${rec.sha256}`);
      console.log(ok ? '✅ 校验通过：与清单记录一致' : '❌ 校验失败：与清单记录不一致');
      process.exit(ok ? 0 : 2);
    }
    console.log('清单中未找到该文件的记录。');
  } else {
    console.log('未找到 manifest.json，仅输出了当前哈希。');
  }
  process.exit(0);
}

/* ------------------------------- 备份模式 ------------------------------- */
const outDir = resolve(argVal('--out', join(ROOT, 'data', 'backups')));
const keep = Number(argVal('--keep', '30'));
mkdirSync(outDir, { recursive: true });

const db = getDb();
const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const baseName = `ccer-${ts}`;
const snapshotPath = join(outDir, `${baseName}.db`);
const jsonPath = join(outDir, `${baseName}.catalog.json`);

// 1) SQLite 一致性快照
db.exec(`VACUUM INTO '${snapshotPath.replace(/\\/g, '/').replace(/'/g, "''")}'`);

// 2) 参考数据 JSON 快照（便于人工核对与异地保管）
const referenceSnapshot = {
  exported_at: new Date().toISOString(),
  source_db: dbPath(),
  counts: {},
  sources: all('SELECT * FROM source_document ORDER BY tier, publish_date'),
  methodology_versions: all('SELECT * FROM methodology_version ORDER BY methodology_id, version'),
  rules: all('SELECT * FROM rule ORDER BY methodology_version_id, sort_order'),
  formulas: all('SELECT * FROM formula'),
  factors: all('SELECT * FROM factor_version ORDER BY factor_key'),
  fact_fields: all('SELECT * FROM fact_field ORDER BY sort_order'),
  projects: all(
    'SELECT id, code, name, project_type, confidentiality, team_id, analyst, created_at FROM project ORDER BY code'
  ),
  alerts_open: all("SELECT * FROM alert WHERE status = 'open'"),
  system_meta: all('SELECT * FROM system_meta'),
};
for (const t of ['source_document', 'methodology_version', 'rule', 'formula', 'factor_version',
  'fact_field', 'project', 'project_fact', 'project_evidence', 'eligibility_run',
  'calculation_run', 'report', 'review_decision', 'audit_log', 'alert', 'subscription']) {
  const row = get(`SELECT COUNT(*) AS c FROM ${t}`);
  referenceSnapshot.counts[t] = row ? row.c : 0;
}
writeFileSync(jsonPath, JSON.stringify(referenceSnapshot, null, 2), 'utf8');

// 3) 哈希与清单
const hashOf = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const entry = {
  created_at: new Date().toISOString(),
  file: basename(snapshotPath),
  catalog_file: basename(jsonPath),
  bytes: statSync(snapshotPath).size,
  sha256: hashOf(snapshotPath),
  catalog_sha256: hashOf(jsonPath),
  counts: referenceSnapshot.counts,
  calculator_gate_mode: get("SELECT value FROM system_meta WHERE key = 'calculator_gate_mode'")?.value || 'demo',
};

const manifestPath = join(outDir, 'manifest.json');
const manifest = existsSync(manifestPath)
  ? JSON.parse(readFileSync(manifestPath, 'utf8'))
  : { note: 'CCER 投资筛选 AI 应用 —— 数据库备份清单', backups: [] };
manifest.backups = [entry, ...(manifest.backups || [])];
manifest.updated_at = new Date().toISOString();

// 4) 轮转
const removed = [];
if (keep > 0 && manifest.backups.length > keep) {
  const drop = manifest.backups.slice(keep);
  for (const d of drop) {
    for (const f of [d.file, d.catalog_file]) {
      const p = join(outDir, f);
      if (f && existsSync(p)) {
        unlinkSync(p);
        removed.push(f);
      }
    }
  }
  manifest.backups = manifest.backups.slice(0, keep);
}
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

console.log('备份完成');
console.log(`  目录：${outDir}`);
console.log(`  数据库快照：${entry.file}（${entry.bytes} 字节）`);
console.log(`  参考数据快照：${entry.catalog_file}`);
console.log(`  SHA-256：${entry.sha256}`);
console.log(`  门禁模式：${entry.calculator_gate_mode}`);
console.log('  关键表记录数：');
for (const [k, v] of Object.entries(entry.counts)) {
  if (v > 0) console.log(`    ${k.padEnd(22)} ${v}`);
}
if (removed.length) console.log(`  已按 --keep ${keep} 轮转删除：${removed.join('、')}`);
console.log(`  当前保留备份 ${manifest.backups.length} 份`);

const existing = readdirSync(outDir).filter((f) => f.endsWith('.db')).length;
console.log(`  目录内 .db 快照文件数：${existing}`);

closeDb();
