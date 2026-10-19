#!/usr/bin/env node
/**
 * DSH 二轮回归修复：陈旧提醒 / 动态缺口文案 —— data/ccer_v2.db 的**可追溯增量修复**
 * ============================================================================
 * 只写 `data/ccer_v2.db`（或 CCER_DB_PATH 指定的独立库）；拒绝写 data/ccer.db。
 * 幂等：所有步骤先比对现状，无变化时不写任何行；每次实际变更写 audit_log。
 *
 * 步骤：
 *   0. 备份   动库前先确保存在一份不早于数据库最后修改的一致性强照（VACUUM INTO）
 *   1. 提醒生命周期  所指核对记录/告警已结清的旧提醒 → 记 resolved_at/resolved_by/resolution，
 *                     不再作为待关注；仍未结清但正文已变 → 刷新正文（不猜测、不掩盖）
 *   2. 动态缺口文案  gap-policy-original-archive 的 title/description/impact/auto_action
 *                     按实时归档状态同源更新（原件已归档 ≠ 正文可引用）
 *   3. 静态缺口文案  与 src/data/policy-catalog.mjs 基线同步（只改文案，不改状态）
 *   4. 目录告警口径  注册登记系统目录页「自动核验受阻、未核实」，去掉人工按周期核对写法
 *   5. 复核          打印未结清告警/缺口/差异与总览更新流，确认无「已结清却仍待关注」
 *
 * 用法：
 *   $env:CCER_ENABLE_V2="1"; $env:CCER_DB_PATH="data\ccer_v2.db"
 *   node scripts/dsh-fix-feed-staleness.mjs             # 默认 apply
 *   node scripts/dsh-fix-feed-staleness.mjs --dry-run   # 只打印将要做的事，不写库
 */
import process from 'node:process';
import { readdirSync, statSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname, basename } from 'node:path';

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');

process.env.CCER_ENABLE_V2 = process.env.CCER_ENABLE_V2 || '1';
process.env.CCER_DB_PATH = process.env.CCER_DB_PATH || 'data/ccer_v2.db';

const { dbPath, all, get, run, audit, getDb, closeDb } = await import('../src/core/db.mjs');
const guard = await import('../src/services/v2-guard.mjs');
const { nowIso } = await import('../src/core/util.mjs');
const collect = await import('../src/services/collect-svc.mjs');
const archiveSvc = await import('../src/services/policy-archive-svc.mjs');
const { DATA_GAPS } = await import('../src/data/policy-catalog.mjs');

const ACTOR = 'system:dsh-fix-feed-staleness';
const report = { db: dbPath(), dry_run: DRY, backup: null, steps: {} };
const say = (...a) => console.log(...a);

/* ------------------------------------------------------------------ */
/*  环境守卫                                                           */
/* ------------------------------------------------------------------ */
guard.assertIsolatedEnv('DSH 陈旧提醒修复脚本');
if (guard.isProductionDb(dbPath())) {
  console.error('✗ 拒绝运行：CCER_DB_PATH 指向在用库 data/ccer.db');
  process.exit(2);
}
say(`库：${dbPath()}${DRY ? '（dry-run，不写库）' : ''}\n`);

/* ------------------------------------------------------------------ */
/*  步骤 0：动库前先确保有一份「不早于库最后修改」的备份                 */
/* ------------------------------------------------------------------ */
function mtimeMs(p) {
  try {
    return statSync(p).mtimeMs;
  } catch {
    return 0;
  }
}

function sha256File(p) {
  return createHash('sha256').update(readFileSync(p)).digest('hex');
}

function ensureBackup() {
  const src = dbPath();
  if (!existsSync(src)) return { created: false, reason: '数据库文件尚不存在（首次运行）' };
  const backupDir = join(dirname(src), 'backups');
  const lastWrite = Math.max(mtimeMs(src), mtimeMs(`${src}-wal`), mtimeMs(`${src}-shm`));
  mkdirSync(backupDir, { recursive: true });
  const candidates = readdirSync(backupDir)
    .filter((f) => f.toLowerCase().endsWith('.db'))
    .map((f) => ({ file: join(backupDir, f), m: mtimeMs(join(backupDir, f)) }))
    .filter((b) => b.m >= lastWrite)
    .sort((a, b) => b.m - a.m);
  if (candidates.length) {
    const hit = candidates[0];
    return { created: false, reused: hit.file, sha256: sha256File(hit.file), covers_last_write: true };
  }
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const out = join(backupDir, `ccer_v2.pre-feed-fix-${ts}.db`);
  if (DRY) return { created: false, would_create: out, dry_run: true };
  getDb().exec(`VACUUM INTO '${out.replace(/\\/g, '/').replace(/'/g, "''")}'`);
  const rec = { created: true, file: out, sha256: sha256File(out), bytes: statSync(out).size };
  // 记录到备份清单，便于回溯
  const manifestPath = join(backupDir, 'manifest.json');
  try {
    const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : { backups: [] };
    manifest.backups = [
      { created_at: new Date().toISOString(), file: basename(out), sha256: rec.sha256, bytes: rec.bytes, note: 'DSH 陈旧提醒/动态缺口修复前自动快照（脚本内生成）' },
      ...(manifest.backups || []),
    ];
    manifest.updated_at = new Date().toISOString();
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  } catch {
    /* 清单写入失败不影响备份本身 */
  }
  return rec;
}

say('=== [0] 动库前备份 ===');
report.backup = ensureBackup();
say(JSON.stringify(report.backup, null, 1));
if (!DRY && !report.backup.created && !report.backup.reused) {
  console.error('✗ 无法确认存在有效备份，已中止（不写库）');
  process.exit(3);
}

/* ------------------------------------------------------------------ */
/*  步骤 1：提醒生命周期                                                */
/* ------------------------------------------------------------------ */
function stepNotifications() {
  say('\n=== [1] 提醒生命周期：已结清的旧提醒不再作为待关注 ===');
  const before = all('SELECT id,title,object_type,object_id,resolved_at FROM notification ORDER BY created_at DESC');
  const pendingBefore = before.filter((n) => !n.resolved_at && collect.notificationSettled(n));
  say(`  提醒总数 ${before.length}；其中「所指问题已结清但仍未记录结清」${pendingBefore.length} 条`);
  for (const n of pendingBefore) say(`   - ${n.id} ${n.title}（指向 ${n.object_type} ${n.object_id}）`);
  if (DRY) return { checked: before.length, would_resolve: pendingBefore.length, would_refresh: null };
  const out = collect.syncNotificationLifecycle({ actor: ACTOR });
  say(`  实际结清 ${out.resolved.length} 条、刷新正文 ${out.refreshed.length} 条`);
  for (const r of out.resolved) say(`   ✓ 结清 ${r.id}（${r.subject}，对象状态 ${r.subject_status}）`);
  for (const r of out.refreshed) say(`   ↻ 刷新 ${r.id}（${r.subject}）`);
  return out;
}

/* ------------------------------------------------------------------ */
/*  步骤 2：动态缺口文案                                                */
/* ------------------------------------------------------------------ */
function stepDynamicGap() {
  say('\n=== [2] 动态缺口 gap-policy-original-archive 文案同步 ===');
  const before = get("SELECT * FROM data_gap WHERE gap_key='gap-policy-original-archive'");
  if (!before) return { skipped: '缺口不存在' };
  const state = archiveSvc.policyArchiveGapState();
  say(`  实时状态：现行政策 ${state.total} 条，未归档 ${state.pending.length} 条，正文不可提取 ${state.unparsed.length} 条 → status=${state.status}`);
  say(`  标题：${before.title}\n     → ${state.title}`);
  if (DRY) return { before: before.title, after: state.title, dry_run: true };
  const out = archiveSvc.syncPolicyArchiveGap({ actor: ACTOR });
  say(`  字段更新：${out.changed_fields.length ? out.changed_fields.join('、') : '（无变化）'}`);
  return out;
}

/* ------------------------------------------------------------------ */
/*  步骤 3：静态缺口文案（只改文案，不改状态）                          */
/* ------------------------------------------------------------------ */
function stepStaticGaps() {
  say('\n=== [3] 静态缺口文案与基线同步（状态保持） ===');
  const out = { updated: [] };
  for (const g of DATA_GAPS) {
    if (g.gap_key === 'gap-policy-original-archive') continue; // 动态缺口由步骤 2 维护
    const row = get('SELECT * FROM data_gap WHERE gap_key = ?', [g.gap_key]);
    if (!row) continue;
    const changed = ['title', 'description', 'impact', 'auto_action'].filter(
      (k) => String(row[k] ?? '') !== String(g[k] ?? '')
    );
    if (!changed.length) continue;
    out.updated.push({ gap_key: g.gap_key, fields: changed, status_kept: row.status });
    say(`  更新 ${g.gap_key}（${changed.join('、')}）；状态保持 ${row.status}`);
    if (DRY) continue;
    run('UPDATE data_gap SET title=?, description=?, impact=?, auto_action=?, updated_at=? WHERE gap_key=?', [
      g.title, g.description, g.impact || null, g.auto_action || null, nowIso(), g.gap_key,
    ]);
    audit({
      actor: ACTOR, action: 'data_gap.sync_text', objectType: 'data_gap', objectId: row.id,
      detail: {
        fields: changed, status_kept: row.status,
        before: Object.fromEntries(changed.map((k) => [k, row[k]])),
        after: Object.fromEntries(changed.map((k) => [k, g[k]])),
      },
    });
  }
  if (!out.updated.length) say('  无需要更新的静态缺口文案');
  return out;
}

/* ------------------------------------------------------------------ */
/*  步骤 4：目录告警口径（自动核验受阻、未核实；不是人工待办）           */
/* ------------------------------------------------------------------ */
const ALERT_TARGETS = [
  {
    id: 'ALR-0muf764dy-b78e7896',
    match: "kind='structure_changed' AND status='open'",
    title: '注册登记系统方法学目录页为前端渲染，自动核验受阻：目录条目数未核实',
    detail:
      '注册登记系统方法学目录页为前端渲染、站内列表接口返回 401，系统无法自动读取官方目录条目数与编号 → ' +
      '自动核验受阻、条目数**未核实**。系统不推测缺失编号，也不用推测值充当官方目录；' +
      '该事项为自动运行状态（无人工待办），每日任务自动重试，取得官方 PDF / 可渲染通道后自动补核。',
  },
  {
    id: 'ALR-0muf764dy-b3c7e992',
    match: "kind='catalog_gap'",
    title: '方法学目录核对：设计基线记载 18 项，本库已录入 18 项',
    detailReplace: {
      from: '未核实项：注册登记系统目录页为前端渲染、列表接口返回 401，官方目录当前条目数仍需人工按周期核对（该事项保留在 structure_changed 告警中，未强行关闭）。',
      to: '未核实项：注册登记系统目录页为前端渲染、列表接口返回 401，官方目录当前条目数**自动核验受阻、未核实**（系统不推测条目数，也不设人工待办；该事项保留在 structure_changed 告警中，由每日任务自动重试）。',
    },
  },
];

function stepAlerts() {
  say('\n=== [4] 注册登记系统目录告警口径 ===');
  const out = [];
  for (const t of ALERT_TARGETS) {
    const row = get(`SELECT * FROM alert WHERE ${t.match} ORDER BY created_at DESC LIMIT 1`);
    if (!row) {
      say(`  未找到目标告警（${t.match}），跳过`);
      out.push({ target: t.id, found: false });
      continue;
    }
    const next = { title: t.title ?? row.title, detail: t.detail ?? row.detail };
    if (t.detailReplace) {
      if (String(row.detail || '').includes(t.detailReplace.from)) {
        next.detail = String(row.detail).replace(t.detailReplace.from, t.detailReplace.to);
      } else if (String(row.detail || '').includes(t.detailReplace.to)) {
        next.detail = row.detail; // 已修正
      } else {
        say(`  ⚠ ${row.id} 未匹配到待修正句子，保持原文并如实报告`);
        out.push({ target: t.id, found: true, matched: false });
        continue;
      }
    }
    const changed = ['title', 'detail'].filter((k) => String(row[k] ?? '') !== String(next[k] ?? ''));
    if (!changed.length) {
      say(`  告警 ${row.id} 文案已是最新（无变化）`);
      out.push({ target: t.id, found: true, changed: [] });
      continue;
    }
    say(`  更新告警 ${row.id}（${changed.join('、')}）`);
    if (!DRY) {
      run('UPDATE alert SET title=?, detail=? WHERE id=?', [next.title, next.detail, row.id]);
      audit({
        actor: ACTOR, action: 'alert.text_normalize', objectType: 'alert', objectId: row.id,
        detail: {
          fields: changed, kind: row.kind, status: row.status,
          before: Object.fromEntries(changed.map((k) => [k, row[k]])),
          after: Object.fromEntries(changed.map((k) => [k, next[k]])),
          reason: '无法自动读取官方目录时必须标明「自动核验受阻、未核实」，不得写成人工待办（平台无人工复核环节）',
        },
      });
    }
    out.push({ target: t.id, found: true, changed });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/*  步骤 5：复核                                                        */
/* ------------------------------------------------------------------ */
function stepVerify() {
  say('\n=== [5] 复核：仍未结清的内容必须诚实提示 ===');
  const feed = collect.listNotifications({ limit: 200 });
  const stalePending = feed.filter((n) => !n.resolved_at && collect.notificationSettled(n));
  const out = {
    stale_pending_notifications: stalePending.map((n) => n.id),
    open_alerts: all("SELECT id,kind,severity,title FROM alert WHERE status='open' ORDER BY created_at"),
    open_gaps: all("SELECT gap_key,severity,status,title FROM data_gap WHERE status='open' ORDER BY gap_key"),
    open_reconciliation: get("SELECT COUNT(*) c FROM data_reconciliation WHERE status='open'")?.c ?? 0,
    settled_notifications: feed.filter((n) => n.resolved_at || collect.notificationSettled(n)).length,
  };
  say(`  仍未结清却仍被当作待关注的提醒：${out.stale_pending_notifications.length} 条 ${JSON.stringify(out.stale_pending_notifications)}`);
  say(`  未结清告警 ${out.open_alerts.length} 条、未结清缺口 ${out.open_gaps.length} 项、未结清差异 ${out.open_reconciliation} 条、已结清提醒留痕 ${out.settled_notifications} 条`);
  for (const a of out.open_alerts) say(`   · 告警 [${a.severity}] ${a.title}`);
  for (const g of out.open_gaps) say(`   · 缺口 [${g.severity}] ${g.title}`);
  return out;
}

/* ------------------------------------------------------------------ */
/*  主流程                                                              */
/* ------------------------------------------------------------------ */
try {
  report.steps.notifications = stepNotifications();
  report.steps.dynamic_gap = stepDynamicGap();
  report.steps.static_gaps = stepStaticGaps();
  report.steps.alerts = stepAlerts();
  report.steps.verify = stepVerify();
  if (!DRY) {
    audit({ actor: ACTOR, action: 'system.feed_staleness_remediation', objectType: 'system', objectId: 'v2-feed-staleness', detail: report });
  }
} catch (e) {
  console.error('\n✗ 执行失败：', e?.stack || e?.message || e);
  process.exitCode = 1;
}

say('\n=== 汇总（JSON） ===');
say(JSON.stringify(report, null, 2));
closeDb();
