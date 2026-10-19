#!/usr/bin/env node
/**
 * DSH 整改：data/ccer_v2.db 的**可追溯增量修复**
 * ============================================================================
 * 只写 `data/ccer_v2.db`（或 CCER_DB_PATH 指定的独立库）；拒绝写 data/ccer.db。
 * 每一步都写 audit_log，并保留原始证据（source_snapshot / trade_revision / change_log）。
 *
 * 步骤：
 *   --step=trade    补 2025-03-20 官方行情（公告页已 404，改用官方分行业行情「小计」行），
 *                   并按**官方公告清单**重算交易日历（修正「漏采→被推断成休市」的错误）
 *   --step=policy   淤地坝碳汇（CCER-14-005-V01）两条重复政策记录做**可追溯去重**
 *                   （保留两条：历史条目标 superseded 并补齐官方 URL，现行条目反向指向）
 *   --step=catalog  8 项原「仅答记者问口径」方法学的编号/通知 URL/日期/候选标记按官方通知更正
 *   --step=archive  逐条下载缺失的政策官方原件（本地文件 + SHA-256 + 解析），并同步缺口台账
 *   --step=recheck  重新执行全部自动核对，过期告警/差异自动结清
 *
 * 用法：
 *   $env:CCER_ENABLE_V2="1"; $env:CCER_DB_PATH="data\ccer_v2.db"
 *   node scripts/dsh-fix-v2-issues.mjs                 # 全量（默认 apply）
 *   node scripts/dsh-fix-v2-issues.mjs --dry-run       # 只打印将要做的事，不写库
 *   node scripts/dsh-fix-v2-issues.mjs --step=trade
 *   node scripts/dsh-fix-v2-issues.mjs --offline       # 跳过需要联网的步骤
 */
import process from 'node:process';

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const OFFLINE = args.includes('--offline');
const stepArg = args.find((a) => a.startsWith('--step='));
const only = stepArg ? stepArg.split('=')[1].split(',') : null;
const want = (name) => !only || only.includes(name) || only.includes('all');

process.env.CCER_ENABLE_V2 = process.env.CCER_ENABLE_V2 || '1';
process.env.CCER_DB_PATH = process.env.CCER_DB_PATH || 'data/ccer_v2.db';

const { dbPath, all, get, run, audit, setMeta, getDb } = await import('../src/core/db.mjs');
const guard = await import('../src/services/v2-guard.mjs');
const { nowIso } = await import('../src/core/util.mjs');
const trade = await import('../src/services/trade-svc.mjs');
const collect = await import('../src/services/collect-svc.mjs');
const reconcile = await import('../src/services/reconcile-svc.mjs');
const policyArchive = await import('../src/services/policy-archive-svc.mjs');
const catalogData = await import('../src/data/catalog.mjs');
const methodologyArchive = await import('../src/services/methodology-archive-svc.mjs');

const ACTOR = 'system:dsh-fix-v2-issues';
const report = { db: dbPath(), dry_run: DRY, offline: OFFLINE, steps: {} };
const say = (...a) => console.log(...a);

/* ------------------------------------------------------------------ */
/*  环境守卫                                                           */
/* ------------------------------------------------------------------ */
guard.assertIsolatedEnv('DSH 整改脚本');
if (guard.isProductionDb(dbPath())) {
  console.error('✗ 拒绝运行：CCER_DB_PATH 指向在用库 data/ccer.db');
  process.exit(2);
}
say(`库：${dbPath()}${DRY ? '（dry-run，不写库）' : ''}${OFFLINE ? ' [offline]' : ''}\n`);

function guarded(fn) {
  if (DRY) return { dry_run: true };
  return fn();
}

/* ================================================================== */
/*  步骤 1：交易日历 + 2025-03-20 官方行情                              */
/* ================================================================== */
async function stepTrade() {
  say('=== [1] 交易日历与 2025-03-20 行情 ===');
  const out = { calendar: null, backfill: null, before: {}, after: {} };
  const DATE = '2025-03-20';

  const beforeRow = get('SELECT * FROM trade_daily WHERE trade_date = ?', [DATE]);
  const beforeCal = get('SELECT * FROM trade_calendar WHERE trade_date = ?', [DATE]);
  out.before = {
    trade_daily: beforeRow ? { id: beforeRow.id, volume: beforeRow.volume, turnover: beforeRow.turnover } : null,
    calendar_day_type: beforeCal?.day_type ?? null,
    diff_volume: Number(get('SELECT volume_total FROM trade_cumulative_reference WHERE as_of_date = ?', ['2025-03-21'])?.volume_total || 0) -
      Number(get('SELECT volume_total FROM trade_cumulative_reference WHERE as_of_date = ?', ['2025-03-19'])?.volume_total || 0),
  };
  say(`  修改前：trade_daily=${beforeRow ? '存在' : '缺失'}，日历 day_type=${beforeCal?.day_type ?? '无'}`);

  if (OFFLINE) {
    say('  [offline] 跳过需要联网的公告清单/分行业行情抓取');
    out.skipped = 'offline';
    return out;
  }

  /* 1.1 官方公告清单 → 交易日历（权威来源） */
  const listRes = await collect.fetchText(trade.TRADE_SOURCES.list_json, {
    headers: { referer: trade.TRADE_SOURCES.list_page, accept: 'application/json,*/*' },
    rateLimitPerMin: 20,
  });
  if (!listRes.ok) throw new Error(`官方公告清单抓取失败：${listRes.error}`);
  const list = trade.parseTradeListJson(listRes.body);
  if (!list.items.length) throw new Error('官方公告清单解析为 0 条');
  const listSnap = guarded(() =>
    collect.recordSnapshot({
      url: trade.TRADE_SOURCES.list_json, res: listRes, sourceId: null,
      parser: 'ccer_trade_list_json', parseQuality: 'good',
      parseNote: 'DSH 整改：按官方公告清单重算交易日历',
    })
  );
  const officialDates = list.items.map((i) => i.trade_date);
  const importedDates = all('SELECT DISTINCT trade_date FROM trade_daily').map((r) => r.trade_date);
  const want320 = list.items.find((i) => i.trade_date === DATE);
  say(`  官方公告清单：${list.items.length} 条，${DATE} ${want320 ? '在列' : '不在列'}（URL 路径日期 ${want320 ? new URL(want320.url).pathname.split('/').slice(-2)[0] : '—'}）`);
  out.calendar = guarded(() => trade.rebuildCalendar(officialDates, { actor: ACTOR, importedDates, windowStart: importedDates.length ? importedDates.sort()[0] : null }));
  out.list_snapshot = listSnap?.id || null;
  say(`  交易日历重算：${out.calendar?.marked ?? '(dry-run)'} 天`);

  /* 1.2 补 2025-03-20：走采集器的官方分行业小计兜底路径 */
  if (beforeRow && beforeRow.volume !== null) {
    say(`  ${DATE} 已有行情记录（volume=${beforeRow.volume}），不重复写入`);
    out.backfill = { action: 'already_present', id: beforeRow.id };
  } else if (!want320) {
    say(`  官方公告清单不含 ${DATE}，无法按官方口径补录（保持缺失）`);
    out.backfill = { action: 'not_in_official_list' };
  } else {
    const steps = [];
    const fb = await guarded(() =>
      collect.collectTradeDayFromOfficialDimension(want320, {
        sourceId: null, actor: ACTOR, speed: 'fast',
        step: (s) => steps.push(s),
        reason: '官方每日行情公告正文页返回 404（历史链接失效）',
      })
    );
    if (!fb) throw new Error(`${DATE} 兜底采集失败：官方分行业行情不可用`);
    out.backfill = { action: fb.action, id: fb.id, volume: fb.volume, turnover: fb.turnover, avg_price: fb.avg_price, source_url: fb.source_url };
    say(`  已补 ${DATE}：成交量 ${fb.volume} 吨，成交额 ${fb.turnover} 元，均价 ${fb.avg_price ?? '官方未披露（留空）'}，action=${fb.action}`);
    if (!DRY) {
      audit({
        actor: ACTOR, action: 'trade.backfill_official_dimension', objectType: 'trade_daily', objectId: fb.id,
        detail: {
          trade_date: DATE, official_list_url: want320.url, fallback_source: fb.source_url,
          reason: '官方每日行情公告页 404；改用同一官网栏目分行业行情 JSON 的小计行（官方披露值，非插值）',
        },
      });
    }
  }

  /* 1.3 复核：累计差分与逐日合计 */
  const afterRow = get('SELECT * FROM trade_daily WHERE trade_date = ?', [DATE]);
  const afterCal = get('SELECT * FROM trade_calendar WHERE trade_date = ?', [DATE]);
  const a = get('SELECT * FROM trade_cumulative_reference WHERE as_of_date = ?', ['2025-03-19']);
  const b = get('SELECT * FROM trade_cumulative_reference WHERE as_of_date = ?', ['2025-03-21']);
  const days = all(
    `SELECT trade_date, volume, turnover FROM trade_daily
     WHERE trade_date > '2025-03-19' AND trade_date <= '2025-03-21' AND session_state='traded' ORDER BY trade_date`
  );
  const sumV = days.reduce((s, r) => s + Number(r.volume || 0), 0);
  const sumT = days.reduce((s, r) => s + Number(r.turnover || 0), 0);
  out.after = {
    trade_daily: afterRow ? { id: afterRow.id, volume: afterRow.volume, turnover: afterRow.turnover, avg_price: afterRow.avg_price, verify_status: afterRow.verify_status } : null,
    calendar_day_type: afterCal?.day_type ?? null,
    interval_days: days.map((d) => d.trade_date),
    sum_volume: sumV,
    sum_turnover: Math.round(sumT * 100) / 100,
    diff_volume: Number(b?.volume_total || 0) - Number(a?.volume_total || 0),
    diff_turnover: Math.round((Number(b?.turnover_total || 0) - Number(a?.turnover_total || 0)) * 100) / 100,
  };
  const okV = Math.abs(out.after.sum_volume - out.after.diff_volume) <= 0.5;
  const okT = Math.abs(out.after.sum_turnover - out.after.diff_turnover) <= 0.05;
  say(`  复核：(2025-03-19 → 2025-03-21] 逐日合计 成交量 ${out.after.sum_volume} / 成交额 ${out.after.sum_turnover}；官方累计差分 成交量 ${out.after.diff_volume} / 成交额 ${out.after.diff_turnover} → ${okV && okT ? '一致 ✓' : '不一致 ✗'}`);
  out.recheck_ok = okV && okT;
  return out;
}

/* ================================================================== */
/*  官方发布通知的核验结果（2026-09-30 逐页抓取核验，scripts/dsh-verify-notice-*.mjs） */
/* ================================================================== */
/**
 * 每条都已在通知页面上核实：
 *   - 「发布机关」元数据字段；
 *   - 正文「四、本通知自印发之日起施行」；
 *   - 落款（印发）日期 = 正文中唯一出现的「YYYY年M月D日」。
 * publish_date 为官网「生成日期」（网页发布日），effective_date 为落款（印发）日。
 */
const VERIFIED_NOTICES = [
  { doc_number: '环办气候函〔2024〕486号', print_date: '2024-12-30', publish_date: '2025-01-03', authority: '生态环境部办公厅、交通运输部办公厅' },
  { doc_number: '环办气候函〔2025〕428号', print_date: '2025-11-18', publish_date: '2025-11-21', authority: '生态环境部办公厅、国家能源局综合司' },
  { doc_number: '环办气候函〔2025〕438号', print_date: '2025-11-25', publish_date: '2025-12-02', authority: '生态环境部办公厅、水利部办公厅' },
  { doc_number: '环办气候函〔2025〕451号', print_date: '2025-11-28', publish_date: '2025-12-03', authority: '生态环境部办公厅、自然资源部办公厅' },
  { doc_number: '环办气候函〔2025〕473号', print_date: '2025-12-12', publish_date: '2025-12-17', authority: '生态环境部办公厅、农业农村部办公厅' },
  { doc_number: '环办气候函〔2025〕485号', print_date: '2025-12-19', publish_date: '2025-12-23', authority: '生态环境部办公厅、住房城乡建设部办公厅' },
  { doc_number: '环办气候函〔2025〕491号', print_date: '2025-12-23', publish_date: '2025-12-26', authority: '生态环境部办公厅、国家能源局综合司' },
  { doc_number: '环办气候函〔2025〕493号', print_date: '2025-12-25', publish_date: '2025-12-26', authority: '生态环境部办公厅、住房城乡建设部办公厅、国家能源局综合司' },
];

/** 按已核验的发布通知补齐政策记录的印发机关与生效（施行）日期；不覆盖已正确的值。 */
function normalizeNoticeMeta() {
  const out = [];
  for (const n of VERIFIED_NOTICES) {
    const rows = all('SELECT * FROM policy_document WHERE doc_number = ?', [n.doc_number]);
    for (const r of rows) {
      const patch = {};
      if (r.effective_date !== n.print_date) patch.effective_date = n.print_date;
      if (!r.issuing_authority) patch.issuing_authority = n.authority;
      if (!r.publish_date) patch.publish_date = n.publish_date;
      if (!Object.keys(patch).length) continue;
      out.push({ id: r.id, doc_number: n.doc_number, patch });
      say(`  发布通知口径更正 ${r.id}（${n.doc_number}）：${Object.entries(patch).map(([k, v]) => `${k}=${v}`).join('、')}`);
      if (!DRY) {
        const sets = Object.keys(patch).map((k) => `${k} = ?`).join(', ');
        run(`UPDATE policy_document SET ${sets}, updated_at = ? WHERE id = ?`, [...Object.values(patch), nowIso(), r.id]);
        audit({
          actor: ACTOR, action: 'policy.notice_meta_normalize', objectType: 'policy_document', objectId: r.id,
          detail: { ...patch, evidence: `通知页面「发布机关/生成日期/文号」元数据 + 正文「自印发之日起施行」+ 落款日期（${n.doc_number}）` },
        });
      }
    }
  }
  return out;
}

/* ================================================================== */
/*  步骤 2：淤地坝碳汇两条政策记录的可追溯去重                          */
/* ================================================================== */
function stepPolicy() {
  say('\n=== [2] 淤地坝碳汇（CCER-14-005-V01）政策记录去重 ===');
  const out = { merged: [], current: null };
  // 规范化标题（全角破折号与半角连字符视为同一标题）
  const norm = (s) => String(s || '').replace(/[—–－]/g, '-').replace(/[\s《》()（）\-_]/g, '');
  const candidates = all(
    `SELECT * FROM policy_document WHERE doc_number = ? ORDER BY created_at`,
    ['环办气候函〔2025〕438号']
  );
  const rows = candidates.filter((r) => norm(r.title).includes('淤地坝碳汇'));
  say(`  命中 ${rows.length} 条同文号记录：`);
  for (const r of rows) say(`   - ${r.id} status=${r.doc_status} url=${r.official_url || '(无)'} local_path=${r.local_path || '(无)'}`);

  /* 现行记录的选择必须是**确定性**的，且与 doc_status 无关，否则重复执行会
   * 把两边互相标成 superseded（第一次执行的教训）。选择顺序：
   *   1) policy_key 以 'pol-' 开头的种子记录 —— 该键是稳定业务键，全新库重新 seed 时
   *      生成的正是这条记录（保证「库内状态」与「种子源」一致）；
   *   2) 已有官方 URL 的记录；
   *   3) 最后收录的一条。 */
  const authoritative =
    rows.find((r) => String(r.policy_key || '').startsWith('pol-')) ||
    rows.find((r) => r.official_url) ||
    rows[rows.length - 1];
  const historical = rows.filter((r) => r.id !== authoritative.id);
  out.current = authoritative.id;
  say(`  选定现行记录：${authoritative.id}（policy_key=${authoritative.policy_key}）`);

  const att = get(
    `SELECT * FROM policy_attachment WHERE policy_id = ? AND local_path IS NOT NULL ORDER BY created_at DESC LIMIT 1`,
    [authoritative.id]
  ) || get(
    `SELECT * FROM policy_attachment WHERE policy_id IN (${rows.map(() => '?').join(',')})
       AND local_path IS NOT NULL ORDER BY created_at DESC LIMIT 1`,
    rows.map((r) => r.id)
  );

  // 归一化现行记录：不得是 superseded；指向被它取代的重复记录；补齐官方 URL 与归档路径
  if (!DRY) {
    run(
      `UPDATE policy_document
         SET doc_status = CASE WHEN doc_status = 'superseded' THEN 'effective' ELSE doc_status END,
             official_url = COALESCE(official_url, ?),
             local_path = COALESCE(local_path, ?),
             original_file_hash = COALESCE(original_file_hash, ?),
             supersedes_id = ?,
             confirmed_by = COALESCE(confirmed_by, '系统核对（官方发布通知原文）'),
             confirmed_at = COALESCE(confirmed_at, ?),
             updated_at = ?
       WHERE id = ?`,
      [
        authoritative.official_url, att?.local_path || null, att?.file_hash || null,
        historical[0]?.id || null, nowIso(), nowIso(), authoritative.id,
      ]
    );
  }

  for (const h of historical) {
    const change = JSON.stringify({
      at: nowIso(), by: ACTOR, kind: 'merged_duplicate',
      merged_into: authoritative.id,
      rationale:
        '与现行记录为同一份官方发布通知（同一文号 环办气候函〔2025〕438号、同一发布日期 2025-12-02、' +
        '规范化标题一致）。保留本行作为历史来源留痕，标记 superseded 并把官方 URL/归档信息补齐，' +
        '不删除任何历史字段。',
    });
    // 追加一条归一化说明，避免早期误把方向写反的 change_log 造成误读（历史条目保留不改写）
    const fixNote = JSON.stringify({
      at: nowIso(), by: ACTOR, kind: 'merge_normalized',
      current: authoritative.id, superseded: h.id,
      rationale:
        '合并方向以「稳定业务键（policy_key 以 pol- 开头的种子记录）为现行」归一化；' +
        '若本行历史 change_log 中出现 merged_into 指向被合并行，以本条为准。历史条目保留不改写。',
    });
    say(`  合并：${h.id} → ${authoritative.id}（保留历史行，标记 superseded）`);
    if (!DRY) {
      run(
        `UPDATE policy_document
           SET doc_status='superseded',
               supersedes_id=NULL,
               official_url=COALESCE(official_url, ?),
               source_id=COALESCE(source_id, ?),
               original_file_hash=COALESCE(original_file_hash, ?),
               local_path=COALESCE(local_path, ?),
               confirmed_by=COALESCE(confirmed_by, '系统核对（官方发布通知原文）'),
               confirmed_at=COALESCE(confirmed_at, ?),
               change_log=COALESCE(change_log || ' | ', '') || ?,
               updated_at=?
         WHERE id=?`,
        [
          authoritative.official_url, authoritative.source_id, authoritative.original_file_hash,
          att?.local_path || null, nowIso(), change, nowIso(), h.id,
        ]
      );
      // 现行记录：追加归一化留痕（仅在确有历史误记时写一次）
      const cur = get('SELECT change_log FROM policy_document WHERE id = ?', [authoritative.id]);
      if (!String(cur?.change_log || '').includes('"kind":"merge_normalized"')) {
        run("UPDATE policy_document SET change_log = COALESCE(change_log || ' | ', '') || ?, updated_at = ? WHERE id = ?", [
          fixNote, nowIso(), authoritative.id,
        ]);
      }
      audit({
        actor: ACTOR, action: 'policy.merge_duplicate', objectType: 'policy_document', objectId: h.id,
        detail: { merged_into: authoritative.id, doc_number: '环办气候函〔2025〕438号', reason: '同一官方发布通知的重复收录' },
      });
    }
    out.merged.push({ from: h.id, into: authoritative.id });
  }
  if (!DRY && att) {
    // 为历史行登记一条指向同一归档原件的附件记录（可回溯，不复制文件）
    for (const h of historical) {
      const dup = get('SELECT id FROM policy_attachment WHERE policy_id = ? AND file_hash = ?', [h.id, att.file_hash]);
      if (dup) continue;
      run(
        `INSERT INTO policy_attachment (id,policy_id,file_name,file_type,url,file_hash,local_path,parse_quality,parse_note,fetched_at,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [
          `PAT-merge-${h.id.slice(-8)}`, h.id, att.file_name, att.file_type, att.url, att.file_hash, att.local_path,
          att.parse_quality,
          `历史重复条目：原件归档与现行条目 ${authoritative.id} 共用同一份官方 PDF（同一 SHA-256，不重复下载）`,
          att.fetched_at, nowIso(),
        ]
      );
    }
  }
  say(`  现行（authoritative）记录：${authoritative.id}`);
  out.notice_meta = normalizeNoticeMeta();
  return out;
}

/* ================================================================== */
/*  步骤 3：方法学目录 8 项编号/状态按官方通知更正                      */
/* ================================================================== */
function stepCatalog() {
  say('\n=== [3] 方法学目录：编号与状态按官方发布通知更正 ===');
  const out = { updated: [], baseline: null };
  const baseline = catalogData.CATALOG_BASELINE;
  const byCode = new Map(catalogData.METHODOLOGY_CATALOG.map((m) => [`${m.methodology_id}::${m.version}`, m]));
  const rows = all("SELECT * FROM methodology_version WHERE document_status='formal' ORDER BY code_display");
  for (const r of rows) {
    const src = byCode.get(`${r.methodology_id}::${r.version}`);
    if (!src) continue;
    const patch = {};
    if (src.code_display && r.code_display !== src.code_display) patch.code_display = src.code_display;
    if (src.official_url && r.official_url !== src.official_url) patch.official_url = src.official_url;
    if (src.release_date && r.release_date !== src.release_date) patch.release_date = src.release_date;
    if (src.effective_date && r.effective_date !== src.effective_date) patch.effective_date = src.effective_date;
    if (r.catalog_confidence !== src.catalog_confidence) patch.catalog_confidence = src.catalog_confidence;
    if (Number(r.is_candidate_eligible) !== Number(src.is_candidate_eligible)) patch.is_candidate_eligible = src.is_candidate_eligible;
    if (!Object.keys(patch).length) continue;
    out.updated.push({ id: r.id, methodology_id: r.methodology_id, before: { code_display: r.code_display, official_url: r.official_url, catalog_confidence: r.catalog_confidence, is_candidate_eligible: r.is_candidate_eligible }, after: patch });
    say(`  更正 ${r.id}（${r.methodology_id}）：${Object.keys(patch).join('、')}`);
    if (!DRY) {
      const sets = Object.keys(patch).map((k) => `${k} = ?`).join(', ');
      run(`UPDATE methodology_version SET ${sets}, exclusion_note = ?, updated_at = ? WHERE id = ?`, [
        ...Object.values(patch),
        patch.is_candidate_eligible === 1 ? null : r.exclusion_note,
        nowIso(), r.id,
      ]);
    }
  }
  if (!DRY) {
    setMeta(getDb(), 'catalog_baseline', JSON.stringify(baseline));
    audit({ actor: ACTOR, action: 'catalog.baseline_update', objectType: 'system_meta', objectId: 'catalog_baseline', detail: baseline });
  }
  out.baseline = { design_doc_count: baseline.design_doc_count, verified_code_count: baseline.verified_code_count, pending_code_count: baseline.pending_code_count };
  say(`  目录基线：设计 ${baseline.design_doc_count} 项 / 已核实编号 ${baseline.verified_code_count} 项 / 待核实 ${baseline.pending_code_count} 项；共更正 ${out.updated.length} 行`);
  return out;
}

/* ================================================================== */
/*  步骤 4：政策原件归档 + 缺口台账同步                                 */
/* ================================================================== */
async function stepArchive() {
  say('\n=== [4] 政策原件归档与缺口台账 ===');
  const out = { archived: null, gap: null, still_missing: [] };

  // 4.1 环境已有归档但**历史核对记录未关闭**的：仅靠规则修复自动结清（在 recheck 中发生）
  const staleAtts = all(
    `SELECT a.*, p.title FROM policy_attachment a JOIN policy_document p ON p.id = a.policy_id
     WHERE a.parse_quality = 'not_attempted' AND a.local_path IS NULL
       AND EXISTS (SELECT 1 FROM policy_attachment b WHERE b.policy_id = a.policy_id AND b.local_path IS NOT NULL AND b.file_hash IS NOT NULL)`
  );
  out.stale_attachment_records = staleAtts.map((a) => ({ id: a.id, policy_id: a.policy_id, file_name: a.file_name }));
  if (staleAtts.length) {
    say(`  发现 ${staleAtts.length} 条「占位附件记录」，但同一政策已有可核验原件 → 规则修正后自动结清`);
    // 占位记录保留（不删除历史），但在 parse_note 上**追加**取代说明，
    // 避免界面仍显示「原件待归档」而与实际归档状态矛盾。原始文字不删除。
    for (const a of staleAtts) {
      if (String(a.parse_note || '').includes('该占位状态已由归档记录')) continue;
      const real = get(
        `SELECT id FROM policy_attachment WHERE policy_id=? AND local_path IS NOT NULL AND file_hash IS NOT NULL ORDER BY created_at DESC LIMIT 1`,
        [a.policy_id]
      );
      say(`   追加取代说明：${a.id} → ${real?.id || '(无)'}`);
      if (!DRY) {
        run('UPDATE policy_attachment SET parse_note = COALESCE(parse_note || \' \', \'\') || ? WHERE id = ?', [
          `【该占位状态已由归档记录 ${real?.id || ''} 取代：官方原件已下载落盘并记录 SHA-256，本条仅作历史留痕】`,
          a.id,
        ]);
        audit({
          actor: ACTOR, action: 'policy.attachment.mark_superseded', objectType: 'policy_attachment', objectId: a.id,
          detail: { policy_id: a.policy_id, superseded_by: real?.id || null, reason: '同一政策已有可核验原件归档' },
        });
      }
    }
  }

  // 4.2 逐条归档缺失原件
  if (OFFLINE) {
    say('  [offline] 跳过联网归档');
    out.skipped = 'offline';
  } else {
    const res = await guarded(() => policyArchive.archiveMissingPolicyOriginals({ actor: ACTOR, limit: 50 }));
    out.archived = res;
    if (res) {
      say(`  归档：检查 ${res.checked} 条，成功 ${res.archived} 条，跳过（已有归档）${res.skipped} 条，失败 ${res.failed.length} 条`);
      for (const f of res.failed) say(`   ✗ ${f.title}：${f.reason}`);
    }
  }

  // 4.3 方法学正式版原文（PDF）缺失的也一并归档
  if (!OFFLINE) {
    const mvMissing = all(
      `SELECT id, methodology_id, code_display, name FROM methodology_version
       WHERE document_status='formal' AND (original_file_hash IS NULL OR original_file_path IS NULL)`
    );
    out.methodology_missing = mvMissing.map((m) => `${m.code_display || m.methodology_id} ${m.name}`);
    if (mvMissing.length) {
      say(`  方法学正式版缺原文归档 ${mvMissing.length} 项，尝试自动归档…`);
      const r = await guarded(() => methodologyArchive.backfillMethodologyOriginals({ actor: ACTOR, limit: 24 }));
      out.methodology_archive = r;
      if (r) say(`  方法学归档：检查 ${r.checked}，归档 ${r.archived}，解析 ${r.parsed}，失败 ${r.failures.length}`);
      if (r) for (const f of r.failures) say(`   ✗ ${f.name}：${f.error}`);
    } else {
      say('  方法学正式版原文归档齐全');
    }
  }

  // 4.4 同步缺口台账
  const gap = guarded(() => policyArchive.syncPolicyArchiveGap({ actor: ACTOR }));
  out.gap = gap;
  if (gap) say(`  缺口 gap-policy-original-archive：${gap.closed ? '已结清' : `仍 open（${gap.pending}/${gap.total} 条缺原件）`}`);
  if (gap?.items) out.still_missing = gap.items;
  return out;
}

/* ================================================================== */
/*  步骤 5：重新核对 + 结清过期告警                                     */
/* ================================================================== */
function stepRecheck() {
  say('\n=== [5] 重新执行自动核对并结清过期告警 ===');
  const out = {};
  if (DRY) {
    say('  [dry-run] 跳过');
    return out;
  }
  const results = reconcile.runAllChecks({ actor: 'system:reconcile' });
  out.checks = {
    trade: { checked: results.trade.checked, issues: results.trade.issues },
    project: { checked: results.project.checked, issues: results.project.issues },
    policy: { checked: results.policy.checked, issues: results.policy.issues, superseded_skipped: results.policy.superseded_skipped },
    factor: { checked: results.factor.checked, issues: results.factor.issues },
    stats: results.stats,
  };
  say(`  核对结果：trade ${results.trade.issues} / project ${results.project.issues} / policy ${results.policy.issues} / factor ${results.factor.issues} 条未结清`);
  say(`  未结清合计：critical ${results.stats.critical}、warning ${results.stats.warning}、info ${results.stats.info}`);

  const auto = reconcile.autoCheckCleanTradeRows({ actor: 'system:auto-reconcile' });
  out.auto_checked_trade = auto;
  say(`  行情自动核对通过：${auto.auto_checked} 条，剩余待核 ${auto.remaining} 条`);

  /* 结清已无依据的告警（alert 表）：
   *   1) catalog_gap：设计条目数一致且编号全部核实 → 关闭，并把复核依据写入 detail；
   *   2) structure_changed（注册登记系统目录页动态渲染）：保留 open —— 这是真实未核实事项。
   */
  const base = catalogData.CATALOG_BASELINE;
  const formalCount = get("SELECT COUNT(*) AS c FROM methodology_version WHERE document_status='formal'")?.c ?? 0;
  const pendingCodes = get(
    "SELECT COUNT(*) AS c FROM methodology_version WHERE document_status='formal' AND (code_display IS NULL OR catalog_confidence != 'verified_from_official_notice')"
  )?.c ?? 0;
  const catalogAlerts = all("SELECT * FROM alert WHERE kind='catalog_gap' AND status='open'");
  out.alerts_closed = [];
  if (formalCount >= Number(base.design_doc_count) && pendingCodes === 0) {
    for (const a of catalogAlerts) {
      run('UPDATE alert SET status=?, detail=? WHERE id=?', [
        'closed',
        `【2026-09-30 复核结清】设计基线 ${base.design_doc_count} 项，本库正式方法学 ${formalCount} 项，` +
        `编号与名称已全部从发布通知正文核实（${base.verified_against.join('、')}）；` +
        '原「8 项仅答记者问口径」已按其发布通知补全编号。' +
        '未核实项：注册登记系统目录页为前端渲染、列表接口返回 401，官方目录当前条目数仍需人工按周期核对' +
        '（该事项保留在 structure_changed 告警中，未强行关闭）。',
        a.id,
      ]);
      audit({ actor: ACTOR, action: 'alert.close', objectType: 'alert', objectId: a.id, detail: { reason: '目录编号已全部核实' } });
      out.alerts_closed.push(a.id);
      say(`  已结清告警 ${a.id}（catalog_gap）`);
    }
  } else {
    say(`  目录告警保留：正式方法学 ${formalCount} 项，编号未核实 ${pendingCodes} 项`);
  }
  out.open_alerts = all("SELECT id,kind,severity,title FROM alert WHERE status='open' ORDER BY severity, created_at DESC");
  out.open_gaps = all("SELECT id,gap_key,severity,title,description FROM data_gap WHERE status='open' ORDER BY severity");
  say(`  剩余未结清告警 ${out.open_alerts.length} 条、缺口 ${out.open_gaps.length} 项`);
  return out;
}

/* ================================================================== */
/*  步骤 6：缺口台账文案同步（只更新描述，不改状态）                    */
/* ================================================================== */
/**
 * 把 `src/data/policy-catalog.mjs` 的 DATA_GAPS 文案同步进库（不覆盖 status）：
 * 缺口状态由实际核对结果决定（见 syncPolicyArchiveGap 与每日复查），
 * 但标题/描述/影响/自动处理方式必须与当前口径一致，否则界面会展示过期结论。
 */
async function stepGaps() {
  say('\n=== [6] 缺口台账文案同步（不改状态） ===');
  const { DATA_GAPS } = await import('../src/data/policy-catalog.mjs');
  /* 描述由实时核对结果维护的缺口：文案由专用同步函数写入，这里不覆盖，
   * 否则会把「已归档但正文不可提取」这类精确结论冲回基线文案。 */
  const DYNAMIC_DESCRIPTION = new Set(['gap-policy-original-archive']);
  const out = { updated: [] };
  for (const g of DATA_GAPS) {
    if (DYNAMIC_DESCRIPTION.has(g.gap_key)) {
      say(`  跳过 ${g.gap_key}（描述由 syncPolicyArchiveGap 按实时归档状态维护）`);
      continue;
    }
    const row = get('SELECT * FROM data_gap WHERE gap_key = ?', [g.gap_key]);
    if (!row) continue;
    const changed = ['title', 'description', 'impact', 'auto_action', 'severity'].filter((k) => {
      const next = k === 'severity' ? (g.severity || 'normal') : (g[k] || null);
      return String(row[k] ?? '') !== String(next ?? '');
    });
    if (!changed.length) continue;
    out.updated.push({ gap_key: g.gap_key, fields: changed, status_kept: row.status });
    say(`  更新 ${g.gap_key}（${changed.join('、')}）；状态保持 ${row.status}`);
    if (!DRY) {
      run(
        `UPDATE data_gap SET title=?, description=?, impact=?, auto_action=?, severity=?, updated_at=? WHERE gap_key=?`,
        [g.title, g.description, g.impact || null, g.auto_action || null, g.severity || 'normal', nowIso(), g.gap_key]
      );
      audit({
        actor: ACTOR, action: 'data_gap.sync_text', objectType: 'data_gap', objectId: row.id,
        detail: { fields: changed, status_kept: row.status },
      });
    }
  }
  if (!out.updated.length) say('  无需要更新的缺口文案');
  return out;
}

/* ================================================================== */
/*  主流程                                                             */
/* ================================================================== */
try {
  if (want('trade')) report.steps.trade = await stepTrade();
  if (want('policy')) report.steps.policy = stepPolicy();
  if (want('catalog')) report.steps.catalog = stepCatalog();
  if (want('archive')) report.steps.archive = await stepArchive();
  if (want('gaps')) report.steps.gaps = await stepGaps();
  if (want('recheck')) report.steps.recheck = stepRecheck();
} catch (e) {
  console.error('\n✗ 执行失败：', e?.stack || e?.message || e);
  process.exitCode = 1;
}

say('\n=== 汇总（JSON） ===');
say(JSON.stringify(report, null, 2));
