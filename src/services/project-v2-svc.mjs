/**
 * 项目信息模块服务（六模块之「项目信息」）
 * ============================================================================
 * 需求规格 1.3：
 *   - 「公开项目库」与「机构内部项目库」两个标签页，支持组合筛选；
 *   - 公开项目逐项记录：官方唯一 ID、名称、业主、地区、行业、方法学及版本、边界与技术路线、
 *     开工/投产时间、设计文件、业主公示预计量、公示起止、审定结论、项目登记编号与日期、
 *     各期减排量公示、核查确定量、减排量登记量、注销状态、官方页面与附件、最后核对时间；
 *   - 状态按官方流程**分列存储**，不用一个「已交易项目」标签概括所有阶段；
 *   - 内部项目增设投资分析字段（资料清单、证据与页码、可信度、权属与重复申报线索、
 *     经济性假设、筛选结论、补充材料、跟进负责人、版本与审核）；
 *   - 交易关联：只有在官方披露可验证的对应关系时才展示，否则明确显示
 *     「公开交易数据无法归属至该项目」，可展示所属行业/方法学的市场汇总但不得宣称已成交。
 *
 * 【纪律】同名异项、业主变更必须人工核对（internal_project_link 只能人工建立，
 * 禁止按名称相似度自动关联）；业主公示预计量 / 核查量 / 登记量三套数字分开存储。
 */
import { all, get, run, tx, audit } from '../core/db.mjs';
import { newId, nowIso, j, uj, isDate, round } from '../core/util.mjs';
import { requireRole } from './project-svc.mjs';
import { cellBool, cellNum } from '../data/import-templates.mjs';

export const EVIDENCE_LABELS = {
  official_registry: '官方登记/发布事实',
  project_material: '业主公示或项目材料',
  third_party: '第三方信息',
  model_estimate: '模型估算',
  unverified: '待核实',
};

export const STAGE_FIELDS = [
  ['stage_project_public', 'project_public', '项目公示'],
  ['stage_validated', 'validated', '审定'],
  ['stage_project_registered', 'project_registered', '项目登记'],
  ['stage_reduction_public', 'reduction_public', '减排量公示'],
  ['stage_verified', 'verified', '核查'],
  ['stage_reduction_registered', 'reduction_registered', '减排量登记'],
];

const CONFIDENTIALITY_ORDER = { internal: 0, confidential: 1, restricted: 2 };

/* ==================================================================== */
/*  权限                                                                */
/* ==================================================================== */

export function canViewInternal(user, project) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  if (project.team_id && user.team_id && project.team_id === user.team_id) return true;
  const grant = get(
    `SELECT id FROM project_grant WHERE object_type = 'internal_project' AND object_id = ? AND team_id = ?`,
    [project.id, user.team_id || '__none__']
  );
  return !!grant;
}

export function canEditInternal(user, project) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  if (!['researcher', 'analyst'].includes(user.role)) return false;
  return canViewInternal(user, project);
}

/* ==================================================================== */
/*  一、公开项目库                                                       */
/* ==================================================================== */

function publicWhere(filters = {}) {
  const where = [];
  const params = [];
  if (filters.keyword) {
    const k = `%${String(filters.keyword).trim()}%`;
    where.push('(p.name LIKE ? OR COALESCE(p.owner_name,\'\') LIKE ? OR COALESCE(p.registry_project_no,\'\') LIKE ? OR COALESCE(p.owner_credit_code,\'\') LIKE ?)');
    params.push(k, k, k, k);
  }
  if (filters.province) {
    where.push('p.province = ?');
    params.push(filters.province);
  }
  if (filters.domain) {
    where.push('p.domain = ?');
    params.push(filters.domain);
  }
  if (filters.methodology_id) {
    where.push('p.methodology_id = ?');
    params.push(filters.methodology_id);
  }
  if (filters.review_status) {
    where.push('p.review_status = ?');
    params.push(filters.review_status);
  }
  // 自动核验四态筛选（取代人工核对状态筛选）
  if (filters.auto_verify_status) {
    if (filters.auto_verify_status === 'none') where.push('p.auto_verify_status IS NULL');
    else {
      where.push('p.auto_verify_status = ?');
      params.push(filters.auto_verify_status);
    }
  }
  // 演示条目（is_demo=1 或历史注释以「演示条目」开头）默认排除：不进入列表、统计与导出。
  // 只有显式 include_demo=true（历史留痕查看）才会包含，且界面会标注「演示条目」。
  const includeDemo = filters.include_demo === true || filters.include_demo === 'true';
  if (!includeDemo) {
    where.push("COALESCE(p.is_demo,0)=0 AND (p.note IS NULL OR p.note NOT LIKE '演示条目%')");
  }
  if (filters.evidence_level) {
    where.push('p.evidence_level = ?');
    params.push(filters.evidence_level);
  }
  if (filters.stage) {
    const f = STAGE_FIELDS.find(([field, key]) => key === filters.stage || field === filters.stage);
    if (f) where.push(`p.${f[0]} = 1`);
  }
  if (filters.checked_from && isDate(filters.checked_from)) {
    where.push('p.last_checked_at >= ?');
    params.push(filters.checked_from);
  }
  if (filters.date_field === 'start_operation' && filters.date_from) {
    where.push('p.start_operation_date >= ?');
    params.push(filters.date_from);
  }
  return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

export function listPublicProjects(filters = {}) {
  const w = publicWhere(filters);
  const limit = Math.min(Number(filters.limit) || 100, 1000);
  const offset = Math.max(Number(filters.offset) || 0, 0);
  const rows = all(
    `SELECT p.*,
        (SELECT COUNT(*) FROM project_event e WHERE e.public_project_id = p.id) AS event_count,
        (SELECT COUNT(*) FROM reduction_batch b WHERE b.public_project_id = p.id) AS batch_count,
        (SELECT COUNT(*) FROM internal_project_link l WHERE l.public_project_id = p.id) AS internal_links
     FROM public_project p ${w.sql}
     ORDER BY p.updated_at DESC LIMIT ? OFFSET ?`,
    [...w.params, limit, offset]
  );
  const total = get(`SELECT COUNT(*) AS c FROM public_project p ${w.sql}`, w.params)?.c ?? 0;
  return {
    rows: rows.map((p) => ({
      ...p,
      evidence_label: EVIDENCE_LABELS[p.evidence_level] || p.evidence_level,
      stage_flags: STAGE_FIELDS.map(([field, key, label]) => ({ key, label, done: !!p[field] })),
      // 交易归因：默认不可归属；只有人工建立的关联且官方有对应披露时才可展示
      trade_attribution: 'not_attributable',
    })),
    total,
    limit,
    offset,
    filters,
    note:
      '公开项目库以注册登记系统公开页面为主，按日同步其站内列表与详情接口。' +
      '接口并非面向第三方承诺的稳定 API；系统已收录数不等于官方全国总数。',
  };
}

export function getPublicProjectDetail(id) {
  const p = get('SELECT * FROM public_project WHERE id = ?', [id]);
  if (!p) return null;
  const events = all('SELECT * FROM project_event WHERE public_project_id = ? ORDER BY COALESCE(event_date, period_end, period_start)', [id]);
  const batches = all('SELECT * FROM reduction_batch WHERE public_project_id = ? ORDER BY COALESCE(period_start, registration_date)', [id]);
  const evidenceRows = all(
    `SELECT * FROM evidence WHERE object_type IN ('public_project','reduction_batch','project_event') AND
      (object_id = ? OR object_id IN (SELECT id FROM reduction_batch WHERE public_project_id = ?)
                     OR object_id IN (SELECT id FROM project_event WHERE public_project_id = ?))
     ORDER BY uploaded_at DESC`,
    [id, id, id]
  );
  const links = all(
    `SELECT l.*, i.code AS internal_code, i.name AS internal_name, i.team_id
     FROM internal_project_link l JOIN internal_project i ON i.id = l.internal_project_id
     WHERE l.public_project_id = ?`,
    [id]
  );
  const attribution = tradeAttribution(p);
  return {
    project: {
      ...p,
      evidence_label: EVIDENCE_LABELS[p.evidence_level] || p.evidence_level,
      stage_flags: STAGE_FIELDS.map(([field, key, label]) => ({ key, label, done: !!p[field] })),
    },
    events: events.map((e) => ({
      ...e,
      evidence_label: EVIDENCE_LABELS[e.evidence_level] || e.evidence_level,
      amount_label:
        e.amount_kind === 'owner_announced_estimate'
          ? '业主公示预计量'
          : e.amount_kind === 'verified_amount'
            ? '核查确定量'
            : e.amount_kind === 'registered_amount'
              ? '登记量'
              : '未标注量',
    })),
    batches: batches.map((b) => ({
      ...b,
      // 三套数字分列，禁止互相替代
      amounts: {
        owner_announced_estimate: b.owner_announced_estimate,
        verified_amount: b.verified_amount,
        registered_amount: b.registered_amount,
        cancelled_amount: b.cancelled_amount,
      },
      evidence_label: EVIDENCE_LABELS[b.evidence_level] || b.evidence_level,
    })),
    evidence: evidenceRows,
    internal_links: links,
    trade_attribution: attribution,
    amounts_summary: {
      owner_announced_estimate: sumField(batches, 'owner_announced_estimate'),
      verified_amount: sumField(batches, 'verified_amount'),
      registered_amount: sumField(batches, 'registered_amount'),
      note: '业主公示预计量 ≠ 核查确定量 ≠ 减排量登记量，界面与导出均分列显示。',
    },
    note:
      '项目各阶段分列存储；「最后核对时间」为系统人工核对记录时间，未核对时显示 null。',
  };
}

function sumField(rows, key) {
  const vals = rows.map((r) => r[key]).filter((v) => v !== null && v !== undefined);
  if (!vals.length) return null;
  return round(vals.reduce((s, v) => s + Number(v), 0), 4);
}

/**
 * 交易关联分析。需求规格 1.3：
 *   只有官方披露可验证的项目/批次/序列号与交易的对应关系时才能展示；
 *   否则显示「公开交易数据无法归属至该项目」，可展示同方法学/行业的市场汇总。
 */
export function tradeAttribution(project) {
  const officialLink = all(
    `SELECT * FROM evidence WHERE object_type = 'public_project' AND object_id = ?
       AND doc_type IN ('trade_link','registry_trade_link')`,
    [project.id]
  );
  const marketSummary = marketSummaryForProject(project);
  if (officialLink.length) {
    return {
      attributable: true,
      basis: officialLink.map((e) => ({
        evidence_id: e.id,
        file_name: e.file_name,
        source_url: e.source_url,
        excerpt: e.excerpt,
      })),
      message: '存在官方披露的对应关系证据，可展示该项目关联的交易信息（须逐条核对证据）。',
      market_summary: marketSummary,
    };
  }
  return {
    attributable: false,
    message:
      '公开交易数据无法归属至该项目：交易系统按日公布市场成交汇总，未披露与具体项目/批次的对应关系，' +
      '因此系统**不宣称**该项目已成交，也不把市场成交量推算为该项目的成交量。',
    market_summary: marketSummary,
    how_to_enable:
      '如官方后续披露项目/批次/序列号与成交的对应关系，可由研究员在「证据」中登记 doc_type=trade_link 的证据，' +
      '系统随即在项目页展示关联来源、时间与数量。',
  };
}

/** 同方法学 / 同行业的市场汇总（明确标注不能归因到具体项目） */
export function marketSummaryForProject(project) {
  const dims = all('SELECT * FROM trade_dimension ORDER BY trade_date DESC LIMIT 2000');
  const byValue = new Map();
  for (const d of dims) {
    const b = byValue.get(d.dimension_value) || { dimension_value: d.dimension_value, volume: 0, turnover: 0, days: 0 };
    b.volume += Number(d.volume) || 0;
    b.turnover += Number(d.turnover) || 0;
    if (d.volume) b.days += 1;
    byValue.set(d.dimension_value, b);
  }
  const overall = get(
    `SELECT SUM(volume) AS v, SUM(turnover) AS t, MIN(trade_date) AS f, MAX(trade_date) AS l,
            COUNT(DISTINCT trade_date) AS days
     FROM trade_daily WHERE session_state = 'traded'`
  ) || {};
  const methodologyProjects = get(
    'SELECT COUNT(*) AS c FROM public_project WHERE methodology_id = ?',
    [project.methodology_id || '__none__']
  )?.c ?? 0;
  return {
    scope: 'market_only',
    cannot_attribute: true,
    market_total: {
      volume: overall.v,
      turnover: overall.t,
      from: overall.f,
      to: overall.l,
      days: overall.days,
      avg_price: overall.v > 0 ? round(overall.t / overall.v, 4) : null,
    },
    official_dimensions: [...byValue.values()],
    methodology_projects_in_system: methodologyProjects,
    note:
      '以上为市场公开汇总（含官方分行业维度），**不能归因**到本项目；' +
      '本项目所属方法学的市场成交请以「交易信息」模块为准。',
  };
}

/* ------------------------------ 写入 ------------------------------ */

export function upsertPublicProject(user, payload = {}, { actor = null, reason = '人工录入' } = {}) {
  const who = actor || user?.name || 'unknown';
  const key = payload.registry_project_no || payload.id || null;
  const existing = payload.id
    ? get('SELECT * FROM public_project WHERE id = ?', [payload.id])
    : key
      ? get('SELECT * FROM public_project WHERE registry_project_no = ?', [key])
      : null;
  const now = nowIso();
  const fields = {
    registry_project_no: payload.registry_project_no ?? null,
    name: payload.name ?? null,
    owner_name: payload.owner_name ?? null,
    owner_credit_code: payload.owner_credit_code ?? null,
    province: payload.province ?? null,
    city: payload.city ?? null,
    domain: payload.domain ?? null,
    industry: payload.industry ?? null,
    methodology_id: payload.methodology_id ?? null,
    methodology_version: payload.methodology_version ?? null,
    technology_route: payload.technology_route ?? null,
    boundary_desc: payload.boundary_desc ?? null,
    start_operation_date: payload.start_operation_date ?? null,
    design_doc_url: payload.design_doc_url ?? null,
    stage_project_public: cellBool(payload.stage_project_public, 0),
    stage_validated: cellBool(payload.stage_validated, 0),
    stage_project_registered: cellBool(payload.stage_project_registered, 0),
    stage_reduction_public: cellBool(payload.stage_reduction_public, 0),
    stage_verified: cellBool(payload.stage_verified, 0),
    stage_reduction_registered: cellBool(payload.stage_reduction_registered, 0),
    stage_cancelled: cellBool(payload.stage_cancelled, 0),
    owner_announced_estimate: cellNum(payload.owner_announced_estimate),
    verified_amount: cellNum(payload.verified_amount),
    registered_amount: cellNum(payload.registered_amount),
    evidence_level: payload.evidence_level || 'unverified',
    official_url: payload.official_url ?? null,
    note: payload.note ?? null,
  };
  if (!fields.name) return { error: '缺少项目名称 name', status: 400 };
  const currentStage = deriveStage(fields);
  if (!existing) {
    const id = newId('PPJ');
    run(
      `INSERT INTO public_project
       (id,registry_project_no,name,owner_name,owner_credit_code,province,city,domain,industry,
        methodology_id,methodology_version,technology_route,boundary_desc,start_operation_date,design_doc_url,
        stage_project_public,stage_validated,stage_project_registered,stage_reduction_public,stage_verified,
        stage_reduction_registered,stage_cancelled,current_stage,owner_announced_estimate,verified_amount,
        registered_amount,evidence_level,official_url,source_id,source_snapshot_id,last_checked_at,
        last_checked_result,review_status,reviewed_by,reviewed_at,note,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        id, fields.registry_project_no, fields.name, fields.owner_name, fields.owner_credit_code,
        fields.province, fields.city, fields.domain, fields.industry, fields.methodology_id,
        fields.methodology_version, fields.technology_route, fields.boundary_desc, fields.start_operation_date,
        fields.design_doc_url, fields.stage_project_public, fields.stage_validated, fields.stage_project_registered,
        fields.stage_reduction_public, fields.stage_verified, fields.stage_reduction_registered,
        fields.stage_cancelled, currentStage, fields.owner_announced_estimate, fields.verified_amount,
        fields.registered_amount, fields.evidence_level, fields.official_url, null, null, null, 'never',
        'pending', null, null, fields.note, now, now,
      ]
    );
    audit({ actor: who, actorRole: user?.role, action: 'public_project.create', objectType: 'public_project', objectId: id, detail: { reason, name: fields.name } });
    return { ok: true, action: 'inserted', id };
  }
  const before = {};
  const after = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v === null || v === undefined) continue;
    if (String(existing[k] ?? '') !== String(v)) {
      before[k] = existing[k];
      after[k] = v;
    }
  }
  run(
    `UPDATE public_project SET
       registry_project_no=?, name=?, owner_name=?, owner_credit_code=?, province=?, city=?, domain=?, industry=?,
       methodology_id=?, methodology_version=?, technology_route=?, boundary_desc=?, start_operation_date=?,
       design_doc_url=?, stage_project_public=?, stage_validated=?, stage_project_registered=?,
       stage_reduction_public=?, stage_verified=?, stage_reduction_registered=?, stage_cancelled=?,
       current_stage=?, owner_announced_estimate=?, verified_amount=?, registered_amount=?,
       official_url=COALESCE(?, official_url), note=COALESCE(?, note), updated_at=?
     WHERE id = ?`,
    [
      fields.registry_project_no ?? existing.registry_project_no, fields.name, fields.owner_name,
      fields.owner_credit_code, fields.province, fields.city, fields.domain, fields.industry,
      fields.methodology_id, fields.methodology_version, fields.technology_route, fields.boundary_desc,
      fields.start_operation_date, fields.design_doc_url, fields.stage_project_public, fields.stage_validated,
      fields.stage_project_registered, fields.stage_reduction_public, fields.stage_verified,
      fields.stage_reduction_registered, fields.stage_cancelled, currentStage,
      fields.owner_announced_estimate ?? existing.owner_announced_estimate,
      fields.verified_amount ?? existing.verified_amount,
      fields.registered_amount ?? existing.registered_amount,
      fields.official_url, fields.note, now, existing.id,
    ]
  );
  audit({
    actor: who, actorRole: user?.role, action: 'public_project.update', objectType: 'public_project',
    objectId: existing.id, detail: { reason, before, after },
  });
  return { ok: true, action: Object.keys(after).length ? 'updated' : 'unchanged', id: existing.id, changes: after };
}

function deriveStage(f) {
  const order = [
    ['stage_reduction_registered', '减排量登记'],
    ['stage_verified', '核查'],
    ['stage_reduction_public', '减排量公示'],
    ['stage_project_registered', '项目登记'],
    ['stage_validated', '审定'],
    ['stage_project_public', '项目公示'],
  ];
  for (const [flag, label] of order) if (f[flag]) return label;
  return '未公示';
}

/** CSV / 接口导入公开项目（逐行校验 + 事件与批次最小写入） */
export function importPublicProjects(user, rows, { actor = null } = {}) {
  const accepted = [];
  const rejected = [];
  for (const r of rows) {
    const errors = [];
    if (!r.registry_project_no) errors.push('缺少官方项目 ID / 登记编号');
    if (!r.name) errors.push('缺少项目名称');
    if (r.start_operation_date && !isDate(r.start_operation_date)) errors.push('开工/投产时间格式应为 YYYY-MM-DD');
    if (r.event_date && !isDate(r.event_date)) errors.push('事件日期格式应为 YYYY-MM-DD');
    if (r.methodology_id && !/^CCER-\d{2}-\d{3}$/.test(String(r.methodology_id))) {
      errors.push('方法学编号格式应为 CCER-XX-XXX（未核实编号请留空，系统不推测）');
    }
    const a = cellNum(r.owner_announced_estimate);
    const v = cellNum(r.verified_amount);
    const g = cellNum(r.registered_amount);
    for (const [label, val] of [['业主公示预计量', a], ['核查确定量', v], ['减排量登记量', g]]) {
      if (val !== null && val < 0) errors.push(`${label}不能为负`);
    }
    if (errors.length) {
      rejected.push({ row: r.__row, registry_project_no: r.registry_project_no || null, errors });
      continue;
    }
    const out = upsertPublicProject(
      user,
      { ...r, owner_announced_estimate: a, verified_amount: v, registered_amount: g },
      { actor, reason: 'CSV 导入（注册登记系统人工摘录）' }
    );
    if (out.error) {
      rejected.push({ row: r.__row, registry_project_no: r.registry_project_no, errors: [out.error] });
      continue;
    }
    // 事件与批次：仅在导入行提供了对应字段时写入
    const stageEvent = STAGE_FIELDS.find(([f]) => cellBool(r[f], 0) === 1);
    if (stageEvent && r.event_date) {
      upsertProjectEvent(user, out.id, {
        event_type: stageEvent[1],
        event_date: r.event_date,
        amount:
          stageEvent[1] === 'reduction_registration'
            ? g
            : stageEvent[1] === 'verification'
              ? v
              : stageEvent[1] === 'reduction_public'
                ? a
                : null,
        amount_kind:
          stageEvent[1] === 'reduction_registration'
            ? 'registered_amount'
            : stageEvent[1] === 'verification'
              ? 'verified_amount'
              : stageEvent[1] === 'reduction_public'
                ? 'owner_announced_estimate'
                : 'none',
        official_url: r.official_url || null,
        evidence_level: r.evidence_level || 'unverified',
        note: 'CSV 导入自动登记的事件，待人工核对',
      });
    }
    if (v !== null || g !== null || a !== null) {
      upsertReductionBatch(user, out.id, {
        batch_no: `导入批次（${r.__row}）`,
        owner_announced_estimate: a,
        verified_amount: v,
        registered_amount: g,
        evidence_level: r.evidence_level || 'unverified',
        note: 'CSV 导入；三套数字分列存储',
      });
    }
    accepted.push({ registry_project_no: r.registry_project_no, action: out.action, id: out.id });
  }
  return {
    ok: rejected.length === 0,
    accepted_count: accepted.length,
    rejected_count: rejected.length,
    accepted,
    rejected,
    note:
      '导入条目的证据等级默认「待核实」，须人工打开官方页面核对后才能改为「官方登记/发布事实」。' +
      '系统不会按名称相似度自动关联内部项目。',
  };
}

export function upsertProjectEvent(user, publicProjectId, payload = {}) {
  const project = get('SELECT * FROM public_project WHERE id = ?', [publicProjectId]);
  if (!project) return { error: '公开项目不存在', status: 404 };
  const valid = ['project_public', 'validation', 'project_registration', 'reduction_public', 'verification', 'reduction_registration', 'cancellation'];
  if (!valid.includes(payload.event_type)) return { error: `event_type 取值非法（${valid.join('/')}）`, status: 400 };
  const id = newId('PEV');
  const now = nowIso();
  run(
    `INSERT INTO project_event
     (id,public_project_id,event_type,event_date,period_start,period_end,amount,amount_kind,registry_ref,
      official_url,source_snapshot_id,evidence_level,review_status,reviewed_by,reviewed_at,note,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      id, publicProjectId, payload.event_type, payload.event_date || null, payload.period_start || null,
      payload.period_end || null, cellNum(payload.amount), payload.amount_kind || 'none',
      payload.registry_ref || null, payload.official_url || null, payload.source_snapshot_id || null,
      payload.evidence_level || 'unverified', 'pending', null, null, payload.note || null, now, now,
    ]
  );
  audit({ actor: user?.name, actorRole: user?.role, action: 'public_project.event.add', objectType: 'public_project', objectId: publicProjectId, detail: payload });
  return { ok: true, id };
}

export function upsertReductionBatch(user, publicProjectId, payload = {}) {
  const project = get('SELECT * FROM public_project WHERE id = ?', [publicProjectId]);
  if (!project) return { error: '公开项目不存在', status: 404 };
  const id = newId('RBT');
  const now = nowIso();
  run(
    `INSERT INTO reduction_batch
     (id,public_project_id,batch_no,period_start,period_end,owner_announced_estimate,verified_amount,
      registered_amount,registration_date,cancellation_status,cancelled_amount,registry_ref,official_url,
      evidence_level,review_status,reviewed_by,reviewed_at,note,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      id, publicProjectId, payload.batch_no || null, payload.period_start || null, payload.period_end || null,
      cellNum(payload.owner_announced_estimate), cellNum(payload.verified_amount), cellNum(payload.registered_amount),
      payload.registration_date || null, payload.cancellation_status || 'none', cellNum(payload.cancelled_amount),
      payload.registry_ref || null, payload.official_url || null, payload.evidence_level || 'unverified',
      'pending', null, null, payload.note || null, now, now,
    ]
  );
  audit({ actor: user?.name, actorRole: user?.role, action: 'public_project.batch.add', objectType: 'public_project', objectId: publicProjectId, detail: payload });
  return { ok: true, id };
}

/** 人工核对公开项目（唯一能把证据等级改为「官方登记/发布事实」的路径） */
export function confirmPublicProject(user, id, { evidence_level = 'official_registry', note = null, official_url = null } = {}) {
  const denied = requireRole(user, ['admin', 'researcher', 'reviewer'], '核对公开项目');
  if (denied) return denied;
  const p = get('SELECT * FROM public_project WHERE id = ?', [id]);
  if (!p) return { error: '公开项目不存在', status: 404 };
  if (!Object.keys(EVIDENCE_LABELS).includes(evidence_level)) {
    return { error: `evidence_level 取值非法（${Object.keys(EVIDENCE_LABELS).join('/')}）`, status: 400 };
  }
  if (evidence_level === 'official_registry' && !(official_url || p.official_url)) {
    return {
      error: '缺少官方页面链接',
      message: '把证据等级提升为「官方登记/发布事实」必须提供可回溯的官方页面 URL。',
      status: 400,
    };
  }
  run(
    `UPDATE public_project SET evidence_level = ?, official_url = COALESCE(?, official_url),
       review_status = 'confirmed', reviewed_by = ?, reviewed_at = ?, last_checked_at = ?,
       last_checked_result = 'ok', note = COALESCE(?, note), updated_at = ? WHERE id = ?`,
    [evidence_level, official_url, user?.name || 'unknown', nowIso(), nowIso(), note, nowIso(), id]
  );
  audit({
    actor: user?.name, actorRole: user?.role, action: 'public_project.confirm',
    objectType: 'public_project', objectId: id, detail: { evidence_level, note },
  });
  return { ok: true, id, evidence_level, reviewed_by: user?.name || 'unknown' };
}

/** 人工建立「内部项目 ↔ 公开项目」关联（禁止自动按名称相似度关联） */
export function linkInternalToPublic(user, { internal_project_id, public_project_id, link_kind = 'manual_confirmed', match_basis, name_mismatch_note = null }) {
  const denied = requireRole(user, ['admin', 'researcher', 'analyst'], '建立项目关联');
  if (denied) return denied;
  const ip = get('SELECT * FROM internal_project WHERE id = ?', [internal_project_id]);
  if (!ip) return { error: '内部项目不存在', status: 404 };
  if (!canViewInternal(user, ip)) return { error: '无权访问该项目（团队隔离）', status: 403 };
  const pp = get('SELECT * FROM public_project WHERE id = ?', [public_project_id]);
  if (!pp) return { error: '公开项目不存在', status: 404 };
  if (!match_basis) return { error: '必须填写关联依据（登记编号一致 / 业主与地址一致 等）', status: 400 };
  if (!['manual_confirmed', 'manual_suspected', 'rejected'].includes(link_kind)) {
    return { error: 'link_kind 取值非法', status: 400 };
  }
  const dup = get(
    'SELECT * FROM internal_project_link WHERE internal_project_id = ? AND public_project_id = ?',
    [internal_project_id, public_project_id]
  );
  if (dup) {
    run('UPDATE internal_project_link SET link_kind = ?, match_basis = ?, name_mismatch_note = ? WHERE id = ?', [
      link_kind, match_basis, name_mismatch_note, dup.id,
    ]);
    return { ok: true, id: dup.id, action: 'updated' };
  }
  const id = newId('IPL');
  run(
    `INSERT INTO internal_project_link (id,internal_project_id,public_project_id,link_kind,match_basis,name_mismatch_note,linked_by,linked_at,note)
     VALUES (?,?,?,?,?,?,?,?,NULL)`,
    [id, internal_project_id, public_project_id, link_kind, match_basis, name_mismatch_note, user?.name || 'unknown', nowIso()]
  );
  audit({
    actor: user?.name, actorRole: user?.role, action: 'internal_project.link',
    objectType: 'internal_project', objectId: internal_project_id,
    detail: { public_project_id, link_kind, match_basis, name_mismatch_note },
  });
  return { ok: true, id, action: 'inserted' };
}

/* ==================================================================== */
/*  二、机构内部项目库                                                   */
/* ==================================================================== */

function internalWhere(user, filters = {}) {
  const where = [];
  const params = [];
  if (user?.role !== 'admin') {
    // 团队隔离：本团队 + 显式授权
    where.push(`(i.team_id = ? OR i.id IN (SELECT object_id FROM project_grant WHERE object_type = 'internal_project' AND team_id = ?))`);
    params.push(user?.team_id || '__none__', user?.team_id || '__none__');
  }
  if (filters.keyword) {
    const k = `%${String(filters.keyword).trim()}%`;
    where.push('(i.name LIKE ? OR COALESCE(i.code,\'\') LIKE ? OR COALESCE(i.owner_name,\'\') LIKE ?)');
    params.push(k, k, k);
  }
  if (filters.team_id) {
    where.push('i.team_id = ?');
    params.push(filters.team_id);
  }
  if (filters.review_status) {
    where.push('i.review_status = ?');
    params.push(filters.review_status);
  }
  if (filters.methodology_id) {
    where.push('i.methodology_id = ?');
    params.push(filters.methodology_id);
  }
  if (filters.confidentiality) {
    where.push('i.confidentiality = ?');
    params.push(filters.confidentiality);
  }
  return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

export function listInternalProjects(user, filters = {}) {
  const w = internalWhere(user, filters);
  const rows = all(
    `SELECT i.*, (SELECT COUNT(*) FROM internal_project_link l WHERE l.internal_project_id = i.id) AS public_links
     FROM internal_project i ${w.sql} ORDER BY i.updated_at DESC LIMIT ?`,
    [...w.params, Math.min(Number(filters.limit) || 200, 1000)]
  );
  return {
    rows: rows.map((r) => ({
      ...r,
      checklist: uj(r.checklist_json, []),
      economics: uj(r.economics_json, null),
      dossier_available: !!r.dossier_project_id,
    })),
    total: rows.length,
    scope: user?.role === 'admin' ? '全部团队（管理员）' : `本团队：${user?.team_id || '未分配'}（含显式授权项目）`,
    note:
      '机构内部项目按团队隔离；管理员可见全部。内部项目与公开项目只能**人工建立**关联，' +
      '同名异项与业主变更须在关联说明中记录。',
  };
}

export function getInternalProjectDetail(user, id) {
  const p = get('SELECT * FROM internal_project WHERE id = ?', [id]);
  if (!p) return null;
  if (!canViewInternal(user, p)) return { error: '无权访问该项目（团队隔离）', status: 403 };
  const links = all(
    `SELECT l.*, pp.name AS public_name, pp.registry_project_no, pp.evidence_level, pp.current_stage
     FROM internal_project_link l JOIN public_project pp ON pp.id = l.public_project_id
     WHERE l.internal_project_id = ?`,
    [id]
  );
  const grants = all("SELECT * FROM project_grant WHERE object_type = 'internal_project' AND object_id = ?", [id]);
  const dossier = p.dossier_project_id
    ? get(
        `SELECT id, code, name, stage, project_type, industry, registry_public_url,
                registry_project_public, registry_validated, registry_project_registered,
                registry_reduction_public, registry_verified, registry_reduction_registered
         FROM project WHERE id = ?`,
        [p.dossier_project_id]
      )
    : null;
  const runs = p.dossier_project_id
    ? all(
        `SELECT id, run_at, methodology_version_id, conclusion, status FROM calculation_run
         WHERE project_id = ? ORDER BY run_at DESC LIMIT 20`,
        [p.dossier_project_id]
      )
    : [];
  return {
    project: {
      ...p,
      checklist: uj(p.checklist_json, []),
      evidence_index: uj(p.evidence_index_json, []),
      economics: uj(p.economics_json, null),
    },
    public_links: links,
    grants,
    dossier,
    calculation_runs: runs,
    note:
      '投资分析字段（资料清单、证据与页码、可信度、权属线索、经济性假设、筛选结论）' +
      '仅机构内部可见；测算须通过「碳减排测算」模块的门禁（原文对照 + 领域签字 + 参数确认）。',
  };
}

export function createInternalProject(user, payload = {}) {
  const denied = requireRole(user, ['admin', 'researcher', 'analyst'], '创建内部项目');
  if (denied) return denied;
  if (!payload.name) return { error: '缺少项目名称', status: 400 };
  if (payload.code) {
    const dup = get('SELECT id FROM internal_project WHERE code = ?', [payload.code]);
    if (dup) return { error: `内部编号已存在：${payload.code}`, status: 409 };
  }
  const id = newId('IPJ');
  const now = nowIso();
  run(
    `INSERT INTO internal_project
     (id,code,name,owner_name,owner_credit_code,province,domain,methodology_id,stage,owner_announced_estimate,
      checklist_json,evidence_index_json,credibility,ownership_risk_note,economics_json,screening_conclusion,
      follow_up_owner,supplementary_note,version,review_status,reviewed_by,reviewed_at,confidentiality,team_id,
      analyst,dossier_project_id,industry,note,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,'draft',NULL,NULL,?,?,?,?,?,?,?,?)`,
    [
      id, payload.code || null, payload.name, payload.owner_name || null, payload.owner_credit_code || null,
      payload.province || null, payload.domain || null, payload.methodology_id || null, payload.stage || null,
      cellNum(payload.owner_announced_estimate), j(payload.checklist || []), j(payload.evidence_index || []),
      payload.credibility || 'unknown', payload.ownership_risk_note || null,
      payload.economics ? j(payload.economics) : null, payload.screening_conclusion || null,
      payload.follow_up_owner || user?.name || null, payload.supplementary_note || null,
      payload.confidentiality || 'internal',
      user?.role === 'admin' && payload.team_id ? payload.team_id : user?.team_id || 'team-default',
      payload.analyst || user?.name || '未指派', payload.dossier_project_id || null,
      payload.industry || null, payload.note || null, now, now,
    ]
  );
  audit({ actor: user?.name, actorRole: user?.role, action: 'internal_project.create', objectType: 'internal_project', objectId: id, detail: { name: payload.name } });
  return { ok: true, id };
}

export function updateInternalProject(user, id, patch = {}) {
  const p = get('SELECT * FROM internal_project WHERE id = ?', [id]);
  if (!p) return { error: '内部项目不存在', status: 404 };
  if (!canEditInternal(user, p)) return { error: '无权修改该项目', status: 403 };
  const allowed = [
    'name', 'owner_name', 'owner_credit_code', 'province', 'domain', 'methodology_id', 'stage',
    'credibility', 'ownership_risk_note', 'screening_conclusion', 'follow_up_owner', 'supplementary_note',
    'confidentiality', 'analyst', 'industry', 'note', 'dossier_project_id',
  ];
  const jsonFields = ['checklist', 'evidence_index', 'economics'];
  const sets = [];
  const params = [];
  const before = {};
  const after = {};
  for (const k of allowed) {
    if (patch[k] === undefined) continue;
    sets.push(`${k} = ?`);
    params.push(patch[k] === '' ? null : patch[k]);
    before[k] = p[k];
    after[k] = patch[k];
  }
  for (const k of jsonFields) {
    if (patch[k] === undefined) continue;
    const col = `${k}_json`;
    sets.push(`${col} = ?`);
    params.push(j(patch[k]));
    before[col] = p[col];
    after[col] = patch[k];
  }
  if (patch.owner_announced_estimate !== undefined) {
    sets.push('owner_announced_estimate = ?');
    params.push(cellNum(patch.owner_announced_estimate));
    after.owner_announced_estimate = patch.owner_announced_estimate;
  }
  if (!sets.length) return { error: '没有可更新的字段', status: 400 };
  sets.push('version = version + 1', 'updated_at = ?');
  params.push(nowIso(), id);
  run(`UPDATE internal_project SET ${sets.join(', ')} WHERE id = ?`, params);
  audit({
    actor: user?.name, actorRole: user?.role, action: 'internal_project.update',
    objectType: 'internal_project', objectId: id, detail: { before, after, reason: patch.reason || null },
  });
  return { ok: true, id, updated: Object.keys(after) };
}

export function decideInternalProject(user, id, { decision = 'approved', note = null } = {}) {
  const p = get('SELECT * FROM internal_project WHERE id = ?', [id]);
  if (!p) return { error: '内部项目不存在', status: 404 };
  if (!['approved', 'rejected', 'pending_review', 'draft'].includes(decision)) {
    return { error: 'decision 取值非法', status: 400 };
  }
  if (decision === 'approved' && !['admin', 'reviewer'].includes(user?.role)) {
    return { error: '内部项目审核通过需要「领域复核人」或「系统管理员」角色', status: 403 };
  }
  if (['pending_review', 'draft'].includes(decision) && !canEditInternal(user, p)) {
    return { error: '无权提交该项目', status: 403 };
  }
  if (decision === 'approved' && p.analyst === (user?.name || '') && user?.role !== 'admin') {
    return { error: '职责分离：本人维护的项目不能由本人批准', status: 403 };
  }
  run('UPDATE internal_project SET review_status = ?, reviewed_by = ?, reviewed_at = ?, updated_at = ? WHERE id = ?', [
    decision, user?.name || 'unknown', nowIso(), nowIso(), id,
  ]);
  audit({ actor: user?.name, actorRole: user?.role, action: 'internal_project.review', objectType: 'internal_project', objectId: id, detail: { decision, note } });
  return { ok: true, id, review_status: decision, reviewed_by: user?.name || 'unknown' };
}

/** 把 v1 项目档案（project 表）镜像为内部项目库条目，便于在 v2 界面统一管理与关联 */
export function syncInternalFromDossiers(user) {
  const denied = requireRole(user, ['admin', 'researcher'], '同步内部项目库');
  if (denied) return denied;
  const projects = all('SELECT * FROM project');
  let inserted = 0;
  let updated = 0;
  tx(() => {
    for (const p of projects) {
      const existing = get('SELECT * FROM internal_project WHERE dossier_project_id = ?', [p.id]);
      const now = nowIso();
      if (!existing) {
        run(
          `INSERT INTO internal_project
           (id,code,name,owner_name,owner_credit_code,province,domain,methodology_id,stage,owner_announced_estimate,
            checklist_json,evidence_index_json,credibility,ownership_risk_note,economics_json,screening_conclusion,
            follow_up_owner,supplementary_note,version,review_status,reviewed_by,reviewed_at,confidentiality,team_id,
            analyst,dossier_project_id,industry,note,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            newId('IPJ'), p.code, p.name, p.owner_name || null, null,
            p.province || null, p.project_type || null, null, p.stage || null, null,
            j([]), j([]), 'unknown', null, null, null, p.analyst || null, null,
            'draft', null, null, p.confidentiality || 'internal', p.team_id || 'team-default',
            p.analyst || '未指派', p.id, p.industry || null,
            '由既有项目档案自动镜像（v1 project → v2 internal_project），投资分析字段待补充', now, now,
          ]
        );
        inserted += 1;
      } else {
        run(
          `UPDATE internal_project SET name = ?, owner_name = ?, province = ?, team_id = ?, methodology_id = ?, updated_at = ?
           WHERE id = ?`,
          [p.name, p.owner_name || null, p.province || null, p.team_id || 'team-default', p.methodology_id || null, now, existing.id]
        );
        updated += 1;
      }
    }
  });
  return { ok: true, inserted, updated, total: projects.length };
}

/** 内部项目导出（含投资分析字段与团队列） */
export function internalProjectExport(user, filters = {}) {
  const { rows } = listInternalProjects(user, filters);
  return {
    columns: [
      { key: 'code', label: '内部编号' },
      { key: 'name', label: '项目名称' },
      { key: 'owner_name', label: '业主' },
      { key: 'province', label: '省份' },
      { key: 'domain', label: '领域' },
      { key: 'methodology_id', label: '拟定方法学' },
      { key: 'stage', label: '内部阶段', definition: '与官方阶段分开记录' },
      { key: 'credibility', label: '资料可信度', definition: 'high/medium/low/unknown' },
      { key: 'review_status', label: '审核状态' },
      { key: 'analyst', label: '跟进负责人' },
      { key: 'team_id', label: '归属团队' },
      { key: 'confidentiality', label: '保密级别' },
      { key: 'screening_conclusion', label: '筛选结论' },
      { key: 'ownership_risk_note', label: '权属与重复申报线索' },
      { key: 'version', label: '版本' },
      { key: 'updated_at', label: '最后更新' },
    ],
    rows,
    meta: {
      数据截至: nowIso().slice(0, 10),
      来源: '机构内部项目库（按团队隔离）',
      口径: '内部项目与公开项目分开统计；不得合并为同一个项目数',
    },
  };
}

/** 公开项目导出（含来源 URL、数据截点、状态口径） */
export function publicProjectExport(filters = {}) {
  const { rows } = listPublicProjects({ ...filters, limit: filters.limit || 2000 });
  return {
    columns: [
      { key: 'registry_project_no', label: '官方项目 ID / 登记编号' },
      { key: 'name', label: '项目名称' },
      { key: 'owner_name', label: '业主' },
      { key: 'province', label: '省份' },
      { key: 'city', label: '城市' },
      { key: 'domain', label: '领域' },
      { key: 'industry', label: '行业' },
      { key: 'methodology_id', label: '方法学编号' },
      { key: 'methodology_version', label: '版本' },
      { key: 'current_stage', label: '当前阶段', definition: '派生展示字段；各阶段分列存储，不能相加' },
      { key: 'stage_project_public', label: '项目公示', unit: '1/0' },
      { key: 'stage_validated', label: '审定', unit: '1/0' },
      { key: 'stage_project_registered', label: '项目登记', unit: '1/0' },
      { key: 'stage_reduction_public', label: '减排量公示', unit: '1/0' },
      { key: 'stage_verified', label: '核查', unit: '1/0' },
      { key: 'stage_reduction_registered', label: '减排量登记', unit: '1/0' },
      { key: 'owner_announced_estimate', label: '业主公示预计量', unit: 'tCO₂e', definition: '公示预计量，不得视为登记量' },
      { key: 'verified_amount', label: '核查确定量', unit: 'tCO₂e' },
      { key: 'registered_amount', label: '减排量登记量', unit: 'tCO₂e' },
      { key: 'evidence_label', label: '证据等级' },
      { key: 'auto_verify_status', label: '自动核验', definition: 'verified/insufficient/conflict/unavailable（模型与规则的一致性检查，非人工核对）' },
      { key: 'auto_verify_at', label: '最近自动核验时间' },
      { key: 'last_checked_at', label: '最后采集核对时间' },
      { key: 'official_url', label: '官方页面' },
      { key: 'note', label: '备注' },
    ],
    rows,
    meta: {
      数据截至: nowIso().slice(0, 10),
      来源: '公开项目库（注册登记系统公开页面自动采集 + 公开数据导入）',
      口径:
        '已排除演示条目；三套数字分列：业主公示预计量 ≠ 核查确定量 ≠ 减排量登记量；' +
        '交易数据无法归属到具体项目，导出不含项目成交量；「自动核验」为模型与规则的一致性检查结论，非人工确认。',
      自动核验通过条数: rows.filter((r) => r.auto_verify_status === 'verified').length,
      排除演示条目数: Math.max(0, (get('SELECT COUNT(*) AS c FROM public_project WHERE COALESCE(is_demo,0)=1 OR note LIKE \'演示条目%\'')?.c ?? 0)),
    },
  };
}

export { CONFIDENTIALITY_ORDER };
