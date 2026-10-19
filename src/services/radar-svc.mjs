/**
 * 信息雷达服务：官方来源监测、变更比对、告警、订阅、审计、看板
 * ============================================================================
 * 更新机制（设计文档第 4 节）：
 *   定时抓取 → 去重与差异比对 → 研究员确认状态与影响领域 → 批准后才发布到判断引擎
 *
 * 本服务**不会**自动修改方法学状态或规则卡。抓取结果只产生 source_change 与 alert，
 * 由研究员在管理后台确认。这是设计文档明确要求的「人工确认生效状态与规则版本」。
 */
import { createHash } from 'node:crypto';
import { all, get, run, audit, metaValue } from '../core/db.mjs';
import { newId, nowIso, j, uj, todayCst } from '../core/util.mjs';

/* ------------------------------- 来源 ------------------------------- */

export function listSources(filters = {}) {
  const where = [];
  const params = [];
  if (filters.status) {
    where.push('status = ?');
    params.push(filters.status);
  }
  if (filters.tier) {
    where.push('tier = ?');
    params.push(Number(filters.tier));
  }
  const rows = all(
    `SELECT * FROM source_document ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY tier ASC, publish_date DESC`,
    params
  );
  return rows.map((s) => ({ ...s, is_official: !!s.is_official }));
}

export function createSource(user, payload) {
  const id = newId('SRC');
  run(
    `INSERT INTO source_document (id,url,title,issuing_authority,doc_number,publish_date,effective_date,
      fetched_at,original_file_hash,file_type,is_official,tier,status,parse_quality,parse_note,
      local_path,domain,region,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      id, payload.url || null, payload.title || '未命名来源', payload.issuing_authority || null,
      payload.doc_number || null, payload.publish_date || null, payload.effective_date || null,
      nowIso(), null, payload.file_type || 'html', payload.is_official ? 1 : 0,
      payload.tier || 1, payload.status || 'notice', payload.parse_quality || 'partial',
      payload.parse_note || null, null, payload.domain || null, payload.region || null,
      nowIso(), nowIso(),
    ]
  );
  audit({ actor: user.name, actorRole: user.role, action: 'source.create', objectType: 'source_document', objectId: id, detail: payload });
  return get('SELECT * FROM source_document WHERE id = ?', [id]);
}

export function listSourceChanges(limit = 100) {
  return all(
    `SELECT c.*, s.title AS source_title, s.url AS source_url
     FROM source_change c LEFT JOIN source_document s ON s.id = c.source_id
     ORDER BY c.detected_at DESC LIMIT ?`,
    [Number(limit) || 100]
  );
}

/** 确认来源变更：由研究员确认状态、影响领域与规则变更影响 */
export function confirmSourceChange(user, changeId, payload = {}) {
  if (!['admin', 'researcher'].includes(user.role)) {
    return { error: '仅政策研究员或管理员可确认来源变更', status: 403 };
  }
  const c = get('SELECT * FROM source_change WHERE id = ?', [changeId]);
  if (!c) return { error: '变更记录不存在', status: 404 };
  run('UPDATE source_change SET review_status = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?', [
    payload.review_status || 'confirmed', user.name, nowIso(), changeId,
  ]);
  audit({
    actor: user.name, actorRole: user.role, action: 'source_change.confirm',
    objectType: 'source_change', objectId: changeId,
    detail: { review_status: payload.review_status || 'confirmed', note: payload.note || null },
  });
  return { ok: true };
}

/* --------------------------- 抓取与差异比对 --------------------------- */

const METHODOLOGY_CODE_RE = /CCER[\u2014\u2013\-]\s?(\d{2})[\u2014\u2013\-]\s?(\d{3})[\u2014\u2013\-]\s?(V\d{2})/g;

function normalizeCodes(text) {
  const out = new Set();
  if (!text) return out;
  let m;
  const re = new RegExp(METHODOLOGY_CODE_RE.source, 'g');
  while ((m = re.exec(text)) !== null) {
    out.add(`CCER-${m[1]}-${m[2]}-${m[3]}`);
  }
  return out;
}

async function fetchWithTimeout(url, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'CCER-Screening-Radar/1.0 (institution intranet; controlled egress)' },
    });
    const body = await res.text();
    return { ok: res.ok, status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 受控抓取：外部站点采集须走受控出口，由机构确认数据可否离开内网。
 * @param {{userId?:string, actor?:string, actorRole?:string, timeoutMs?:number, dryRun?:boolean}} opts
 */
export async function syncSources(user, opts = {}) {
  if (user && !['admin', 'researcher'].includes(user.role)) {
    return { error: '仅政策研究员或管理员可触发来源同步', status: 403 };
  }
  const sources = all('SELECT * FROM source_document WHERE url IS NOT NULL');
  const knownCodes = new Set(
    all('SELECT methodology_id, code_display FROM methodology_version')
      .map((r) => r.code_display || r.methodology_id)
      .filter(Boolean)
      .map((c) => String(c).replace(/（.*?）/g, '').trim())
  );

  const results = [];
  for (const s of sources) {
    const record = { source_id: s.id, title: s.title, url: s.url, outcome: 'unchanged', detail: null };
    if (opts.dryRun) {
      record.outcome = 'skipped';
      record.detail = '演练模式，未发起网络请求';
      results.push(record);
      continue;
    }
    try {
      const res = await fetchWithTimeout(s.url, opts.timeoutMs || 15000);
      const hash = createHash('sha256').update(res.body || '').digest('hex');
      const prevHash = s.original_file_hash;

      if (!res.ok) {
        insertChange(s, 'fetch_failed', prevHash, null, `HTTP ${res.status}`);
        pushAlert({
          kind: 'fetch_failed', severity: 'warning',
          title: `来源抓取失败：${s.title}`,
          detail: `HTTP ${res.status}。来源结构变化或公告撤回须人工核查。`,
          sourceId: s.id, domain: s.domain,
        });
        record.outcome = 'fetch_failed';
        record.detail = `HTTP ${res.status}`;
      } else if (!prevHash) {
        run('UPDATE source_document SET original_file_hash = ?, fetched_at = ?, updated_at = ? WHERE id = ?', [
          hash, nowIso(), nowIso(), s.id,
        ]);
        record.outcome = 'baseline_recorded';
        record.detail = `建立基线哈希 ${hash.slice(0, 12)}…`;
      } else if (prevHash !== hash) {
        insertChange(s, 'content_revised', prevHash, hash, '正文哈希变化');
        pushAlert({
          kind: 'revised', severity: 'warning',
          title: `来源内容发生变化：${s.title}`,
          detail: '哈希与上次抓取不一致。请研究员核对变更摘要、影响领域与是否触发规则版本更新。',
          sourceId: s.id, domain: s.domain,
        });
        run('UPDATE source_document SET original_file_hash = ?, fetched_at = ?, updated_at = ? WHERE id = ?', [
          hash, nowIso(), nowIso(), s.id,
        ]);
        record.outcome = 'content_revised';
        record.detail = `新哈希 ${hash.slice(0, 12)}…`;
      } else {
        run('UPDATE source_document SET fetched_at = ?, updated_at = ? WHERE id = ?', [nowIso(), nowIso(), s.id]);
      }

      // 方法学编号扫描：发现库中不存在的新编号 → 告警（不自动入库）
      const codes = normalizeCodes(res.body);
      const unknown = [...codes].filter((c) => {
        const mid = c.replace(/-V\d+$/, '');
        return !knownCodes.has(c) && !knownCodes.has(mid) &&
          !all('SELECT 1 AS x FROM methodology_version WHERE methodology_id = ? LIMIT 1', [mid]).length;
      });
      if (unknown.length) {
        pushAlert({
          kind: 'new', severity: 'warning',
          title: `发现方法学目录中尚未录入的编号 ${unknown.length} 个`,
          detail: `编号：${unknown.join('、')}。系统不自动入库，须研究员在注册登记系统核对后由管理后台人工补录。`,
          sourceId: s.id, domain: s.domain,
        });
        record.outcome = record.outcome === 'unchanged' ? 'new_codes_found' : record.outcome;
        record.detail = `${record.detail || ''} 新编号：${unknown.join('、')}`.trim();
      }
    } catch (e) {
      const msg = e?.name === 'AbortError' ? '请求超时' : e?.message || String(e);
      insertChange(s, 'fetch_failed', s.original_file_hash, null, msg);
      pushAlert({
        kind: 'fetch_failed', severity: 'warning',
        title: `来源抓取失败：${s.title}`,
        detail: `${msg}。若为内网出口受限，请确认受控出口策略。`,
        sourceId: s.id, domain: s.domain,
      });
      record.outcome = 'fetch_failed';
      record.detail = msg;
    }
    results.push(record);
  }

  audit({
    actor: user?.name || 'system:scheduler',
    actorRole: user?.role || 'system',
    action: 'source.sync',
    detail: { count: results.length, outcomes: results.map((r) => `${r.outcome}`) },
  });

  return {
    status: 200,
    synced_at: nowIso(),
    results,
    summary: {
      total: results.length,
      unchanged: results.filter((r) => r.outcome === 'unchanged').length,
      changed: results.filter((r) => r.outcome === 'content_revised').length,
      failed: results.filter((r) => r.outcome === 'fetch_failed').length,
      baseline_recorded: results.filter((r) => r.outcome === 'baseline_recorded').length,
      new_codes_found: results.filter((r) => r.outcome === 'new_codes_found').length,
    },
    note: '抓取结果不会自动修改方法学状态或规则卡；须由研究员确认后发布到判断引擎。',
  };
}

function insertChange(source, kind, oldHash, newHash, summary) {
  run(
    `INSERT INTO source_change (id,source_id,detected_at,change_kind,old_hash,new_hash,diff_summary,review_status)
     VALUES (?,?,?,?,?,?,?,?)`,
    [newId('CHG'), source.id, nowIso(), kind, oldHash || null, newHash || null, summary || null, 'pending']
  );
}

/* ------------------------------- 告警 ------------------------------- */

export function pushAlert({ kind, severity, title, detail, sourceId, methodologyId, domain, region, projectTypes }) {
  const id = newId('ALR');
  run(
    `INSERT INTO alert (id,kind,severity,title,detail,source_id,methodology_id,domain,region,project_types,created_at,status)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      id, kind, severity, title, detail || null, sourceId || null, methodologyId || null,
      domain || null, region || null, j(projectTypes || []), nowIso(), 'open',
    ]
  );
  return id;
}

export function listAlerts({ status, severity, kind } = {}) {
  const where = [];
  const params = [];
  if (status) {
    where.push('a.status = ?');
    params.push(status);
  }
  if (severity) {
    where.push('a.severity = ?');
    params.push(severity);
  }
  if (kind) {
    where.push('a.kind = ?');
    params.push(kind);
  }
  return all(
    `SELECT a.*, s.title AS source_title, s.url AS source_url, s.publish_date AS source_publish_date
     FROM alert a LEFT JOIN source_document s ON s.id = a.source_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY CASE a.severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, a.created_at DESC
     LIMIT 200`,
    params
  ).map((a) => ({ ...a, project_types: uj(a.project_types, []) }));
}

export function updateAlert(user, alertId, status) {
  if (!['open', 'ack', 'closed'].includes(status)) return { error: '状态取值应为 open / ack / closed', status: 400 };
  run('UPDATE alert SET status = ? WHERE id = ?', [status, alertId]);
  audit({ actor: user.name, actorRole: user.role, action: 'alert.update', objectType: 'alert', objectId: alertId, detail: { status } });
  return { ok: true };
}

/* ------------------------------- 订阅 ------------------------------- */

export function listSubscriptions() {
  return all('SELECT * FROM subscription ORDER BY created_at DESC').map((s) => ({
    ...s,
    domains: uj(s.domains, []),
    regions: uj(s.regions, []),
    project_types: uj(s.project_types, []),
    active: !!s.active,
  }));
}

export function createSubscription(user, payload) {
  const id = newId('SUB');
  run(
    `INSERT INTO subscription (id,name,owner,domains,regions,project_types,channel,active,created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [
      id, payload.name || '未命名订阅', user.name,
      j(payload.domains || []), j(payload.regions || []), j(payload.project_types || []),
      payload.channel || 'in_app', payload.active === false ? 0 : 1, nowIso(),
    ]
  );
  audit({ actor: user.name, actorRole: user.role, action: 'subscription.create', objectType: 'subscription', objectId: id, detail: payload });
  return get('SELECT * FROM subscription WHERE id = ?', [id]);
}

/** 按订阅过滤告警（用于「我的提醒」） */
export function alertsForSubscriptions() {
  const subs = listSubscriptions().filter((s) => s.active);
  const alerts = listAlerts({ status: 'open' });
  return subs.map((s) => ({
    subscription: s,
    matched: alerts.filter((a) => {
      const domainHit = !s.domains.length || (a.domain && s.domains.includes(a.domain));
      const typeHit =
        !s.project_types.length ||
        (a.project_types || []).some((t) => s.project_types.includes(t));
      return domainHit && typeHit;
    }),
  }));
}

/* ------------------------------- 审计 ------------------------------- */

export function listAudit(user, { limit = 200, objectType, objectId, action } = {}) {
  if (!['admin', 'reviewer', 'researcher'].includes(user.role)) {
    return { error: '当前角色无审计日志查看权限', status: 403 };
  }
  const where = [];
  const params = [];
  if (objectType) {
    where.push('object_type = ?');
    params.push(objectType);
  }
  if (objectId) {
    where.push('object_id = ?');
    params.push(objectId);
  }
  if (action) {
    where.push('action LIKE ?');
    params.push(`%${action}%`);
  }
  return all(
    `SELECT * FROM audit_log ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY at DESC LIMIT ?`,
    [...params, Number(limit) || 200]
  );
}

/* ------------------------------- 看板 ------------------------------- */

export function dashboard(user) {
  const methodologies = all('SELECT * FROM methodology_version').map((m) => ({
    ...m,
    project_types: uj(m.project_types, []),
  }));
  const projects = all('SELECT * FROM project');

  const byDocStatus = {};
  for (const m of methodologies) byDocStatus[m.document_status] = (byDocStatus[m.document_status] || 0) + 1;

  const latestRuns = all(
    `SELECT e.project_id, e.conclusion, e.run_at
     FROM eligibility_run e
     JOIN (SELECT project_id, MAX(run_at) AS mx FROM eligibility_run GROUP BY project_id) t
       ON t.project_id = e.project_id AND t.mx = e.run_at`
  );
  const conclusionByProject = new Map(latestRuns.map((r) => [r.project_id, r.conclusion]));
  const byConclusion = {};
  let unanalyzed = 0;
  for (const p of projects) {
    const c = conclusionByProject.get(p.id);
    if (!c) unanalyzed += 1;
    else byConclusion[c] = (byConclusion[c] || 0) + 1;
  }

  const alerts = listAlerts({ status: 'open' });
  const gateMode = metaValue('calculator_gate_mode', 'demo');

  return {
    generated_at: nowIso(),
    today: todayCst(),
    methodology: {
      total_versions: methodologies.length,
      distinct_methodologies: new Set(methodologies.map((m) => m.methodology_id)).size,
      by_document_status: byDocStatus,
      formal_candidate_eligible: methodologies.filter((m) => m.document_status === 'formal' && m.is_candidate_eligible).length,
      with_approved_rulecard: methodologies.filter((m) => m.rulecard_status === 'approved').length,
      with_approved_calculator: methodologies.filter((m) => m.calculator_status === 'approved').length,
      catalog_gap: (() => {
        const raw = metaValue('catalog_baseline', null);
        if (!raw) return null;
        try {
          return JSON.parse(raw);
        } catch {
          return null;
        }
      })(),
    },
    project: {
      total: projects.length,
      visible_to_user: user.role === 'admin'
        ? projects.length
        : projects.filter((p) => p.team_id === user.team_id || p.confidentiality === 'public').length,
      by_conclusion: byConclusion,
      not_yet_analyzed: unanalyzed,
      by_registry_stage: (() => {
        const out = { 未进入注册登记流程: 0, 项目公示: 0, 审定: 0, 项目登记: 0, 减排量公示: 0, 核查: 0, 减排量登记: 0 };
        for (const p of projects) {
          if (p.registry_reduction_registered) out['减排量登记'] += 1;
          else if (p.registry_verified) out['核查'] += 1;
          else if (p.registry_reduction_public) out['减排量公示'] += 1;
          else if (p.registry_project_registered) out['项目登记'] += 1;
          else if (p.registry_validated) out['审定'] += 1;
          else if (p.registry_project_public) out['项目公示'] += 1;
          else out['未进入注册登记流程'] += 1;
        }
        return out;
      })(),
    },
    alert: {
      open_total: alerts.length,
      by_severity: {
        critical: alerts.filter((a) => a.severity === 'critical').length,
        warning: alerts.filter((a) => a.severity === 'warning').length,
        info: alerts.filter((a) => a.severity === 'info').length,
      },
      top: alerts.slice(0, 8),
    },
    calculation: {
      gate_mode: gateMode,
      gate_mode_label: gateMode === 'strict' ? '严格模式（占位系数阻止出数）' : '演示模式（可出数，须标注占位系数）',
      total_runs: all('SELECT COUNT(*) AS c FROM calculation_run')[0]?.c ?? 0,
      rejected_runs: all("SELECT COUNT(*) AS c FROM calculation_run WHERE status = 'rejected'")[0]?.c ?? 0,
      pending_review: all("SELECT COUNT(*) AS c FROM calculation_run WHERE review_status = 'pending'")[0]?.c ?? 0,
    },
    catalog_note:
      '方法学目录以官方注册登记系统为准。编号未核实的条目仅供检索与观察，不列为可申报候选。',
  };
}

export { get };
