/**
 * 后台维护服务（admin-maintenance-svc）
 * ============================================================================
 * 需求（docs/44 第 5 条）：后台提供**实际可用**的处理方式
 *   - 刷新/重试采集（有界、真实调用既有采集入口）；
 *   - 查看缺口原因（缺口台账 + 实时状态，只给管理员）；
 *   - 编辑对应公开内容（标题、摘要、正文/来源链接等**合理白名单字段**，
 *     按实体类型校验）；
 *   - 管理员编辑有确认/结果提示、审计、修改前后版本或可恢复历史；
 *   - **不得悄悄覆盖原始快照和官方数值**：手工修订单独覆盖层并标记「管理员修订」；
 *   - 不能把编辑缺口说明当作修复原始数据；
 *   - 禁止动态 SQL 表名/字段名未白名单；防存储 XSS；URL 仅 http(s)；
 *   - 普通用户编辑必须 403（路由层 + 本层双重判定），不能只隐藏按钮。
 *
 * 本模块的所有表名/列名都来自下方常量白名单，**不拼接任何调用方输入**。
 */
import { all, get, run, audit } from '../core/db.mjs';
import { newId, nowIso } from '../core/util.mjs';
import { decorateGap } from './dashboard-svc.mjs';
import * as adminSvc from './admin-v2-svc.mjs';
import * as summarySvc from './summary-svc.mjs';
import * as chatSvc from './chat-svc.mjs';
import { listOfficialDomains, upsertOfficialDomain, seedOfficialDomains, sourceDisplay } from './source-display-svc.mjs';
import { syncStatus } from './collect-svc.mjs';
import * as gapTriage from './gap-triage-svc.mjs';
import * as ingestSummary from './ingest-summary-svc.mjs';

/* ==================================================================== */
/*  一、可编辑实体与字段白名单                                           */
/* ==================================================================== */

const T = (label, max = 300, extra = {}) => ({ label, type: 'text', max, ...extra });
const D = (label) => ({ label, type: 'date' });
const U = (label) => ({ label, type: 'url' });
const N = (label) => ({ label, type: 'number' });

/**
 * 白名单：实体类型 → { table, titleCol, label, fields }。
 * 只有这里登记的字段可被管理员修订；表名与列名硬编码，不接受外部输入。
 */
export const EDITABLE_ENTITIES = {
  policy_document: {
    label: '政策文件', table: 'policy_document', titleCol: 'title', order: "COALESCE(publish_date,'') DESC",
    fields: {
      title: T('标题', 300),
      summary: T('摘要 / 说明', 2000),
      issuing_authority: T('发布机关', 120),
      doc_number: T('文号', 80),
      publish_date: D('发布日期'),
      official_url: U('官方原文链接'),
      collect_note: T('采集备注', 600),
    },
  },
  methodology_version: {
    label: '方法学', table: 'methodology_version', titleCol: 'name', order: "COALESCE(release_date,'') DESC",
    fields: {
      name: T('名称', 300),
      domain: T('领域', 60),
      release_date: D('发布日期'),
      official_url: U('原文链接'),
      evidence_note: T('证据说明', 1000),
    },
  },
  public_project: {
    label: '公开项目', table: 'public_project', titleCol: 'name', order: 'updated_at DESC',
    fields: {
      name: T('项目名称', 300),
      province: T('省份', 60),
      methodology_id: T('方法学编号', 80),
      owner_name: T('业主名称', 200),
      note: T('备注', 1000),
    },
  },
  content_item: {
    label: '研报与动态', table: 'content_item', titleCol: 'title', order: 'collected_at DESC',
    fields: {
      title: T('标题', 300),
      summary: T('展示摘要（管理员修订）', 2000),
      publisher: T('发布机构', 200),
      published_at: D('发布日期'),
      source_url: U('来源链接'),
      note: T('备注', 1000),
    },
  },
  cea_document: {
    label: 'CEA 政策与研报', table: 'cea_document', titleCol: 'title', order: "COALESCE(publish_date,'') DESC",
    fields: {
      title: T('标题', 300),
      issuer: T('发布机构', 200),
      publish_date: D('发布日期'),
      official_url: U('官方链接'),
      note: T('备注', 1000),
    },
  },
  emission_factor: {
    label: '公开排放因子', table: 'emission_factor', titleCol: 'name', order: 'data_year DESC',
    fields: {
      name: T('因子名称', 300),
      original_unit: T('原文单位', 40),
      standard_unit: T('规范单位', 40),
      region: T('地区', 60),
      data_year: N('数据年度'),
      publish_date: D('发布日期'),
      applicability: T('适用说明', 600),
      original_url: U('原文链接'),
    },
  },
  accounting_standard: {
    label: '标准规范', table: 'accounting_standard', titleCol: 'title', order: "COALESCE(publish_date,'') DESC",
    fields: {
      title: T('标准名称', 300),
      code: T('标准编号', 80),
      publish_date: D('发布日期'),
      source_locator: T('原文定位说明', 300),
      original_url: U('原文 PDF 链接'),
      announcement_url: U('发布公告页链接'),
    },
  },
  accounting_public_document: {
    label: '公开资料与问答', table: 'accounting_public_document', titleCol: 'title', order: "COALESCE(published_at,'') DESC",
    fields: {
      title: T('标题', 300),
      url: U('原文链接'),
      limitation: T('已知限制说明', 600),
    },
  },
};

export const EDITABLE_KEYS = Object.keys(EDITABLE_ENTITIES);

/** 实际的表列名缓存（表名来自上方硬编码白名单，不接受外部输入）。 */
const columnCache = new Map();
export function tableColumns(table) {
  if (columnCache.has(table)) return columnCache.get(table);
  let cols = [];
  try {
    cols = all(`PRAGMA table_info(${table})`).map((c) => c.name);
  } catch {
    cols = [];
  }
  columnCache.set(table, cols);
  return cols;
}

/**
 * 实体白名单与实际库结构的一致性检查。
 * 白名单字段写错（例如引用了不存在的列）时**明确报错**，而不是把 SQL 错误当成空结果。
 */
export function editableFieldIssues() {
  const issues = [];
  for (const [type, cfg] of Object.entries(EDITABLE_ENTITIES)) {
    const cols = tableColumns(cfg.table);
    if (!cols.length) { issues.push({ entity_type: type, table: cfg.table, issue: '表不存在' }); continue; }
    if (!cols.includes(cfg.titleCol)) issues.push({ entity_type: type, table: cfg.table, issue: `标题列不存在：${cfg.titleCol}` });
    for (const f of Object.keys(cfg.fields)) {
      if (!cols.includes(f)) issues.push({ entity_type: type, table: cfg.table, issue: `字段不在实际表结构中：${f}` });
    }
  }
  return issues;
}

/* ==================================================================== */
/*  二、字段校验（白名单 + 类型 + 防存储 XSS + URL 仅 http(s)）           */
/* ==================================================================== */

/** 明显的脚本注入载荷：拒绝入库（渲染层另有 esc() 转义，这里是第二道防线）。 */
const DANGEROUS_MARKUP = [
  /<\s*script\b/i, /<\s*iframe\b/i, /<\s*object\b/i, /<\s*embed\b/i, /<\s*svg\b/i,
  /\son[a-z]+\s*=/i, /javascript\s*:/i, /data\s*:\s*text\/html/i, /<\s*img[^>]*onerror/i,
];

export function assertSafeText(value, label) {
  const s = String(value ?? '');
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(s)) return { ok: false, error: `${label}包含不可见控制字符` };
  if (DANGEROUS_MARKUP.some((re) => re.test(s))) return { ok: false, error: `${label}包含可执行的脚本/事件属性，已拒绝（防存储 XSS）` };
  return { ok: true, value: s };
}

export function assertHttpUrl(value, label) {
  const s = String(value ?? '').trim();
  if (!s) return { ok: true, value: null };
  let u;
  try {
    u = new URL(s);
  } catch {
    return { ok: false, error: `${label}不是合法 URL（只允许 http(s) 链接）` };
  }
  if (!['http:', 'https:'].includes(u.protocol)) return { ok: false, error: `${label}只允许 http(s) 链接` };
  return { ok: true, value: u.toString() };
}

function assertDate(value, label) {
  const s = String(value ?? '').trim();
  if (!s) return { ok: true, value: null };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return { ok: false, error: `${label}须为 YYYY-MM-DD` };
  const t = Date.parse(`${s}T00:00:00Z`);
  if (!Number.isFinite(t)) return { ok: false, error: `${label}不是有效日期` };
  return { ok: true, value: s };
}

function assertNumber(value, label) {
  if (value === null || value === undefined || value === '') return { ok: true, value: null };
  const n = Number(value);
  if (!Number.isFinite(n)) return { ok: false, error: `${label}须为数字` };
  return { ok: true, value: n };
}

/** 按字段规格校验单个字段值。 */
export function validateField(entityType, fieldKey, rawValue) {
  const spec = EDITABLE_ENTITIES[entityType]?.fields?.[fieldKey];
  if (!spec) return { ok: false, error: `字段 ${fieldKey} 不在 ${entityType} 的可编辑白名单内` };
  if (spec.type === 'url') return assertHttpUrl(rawValue, spec.label);
  if (spec.type === 'date') return assertDate(rawValue, spec.label);
  if (spec.type === 'number') return assertNumber(rawValue, spec.label);
  const t = assertSafeText(rawValue, spec.label);
  if (!t.ok) return t;
  const s = t.value.trim();
  if (s.length > spec.max) return { ok: false, error: `${spec.label}超过 ${spec.max} 字上限` };
  return { ok: true, value: s || null };
}

/* ==================================================================== */
/*  三、覆盖层读写                                                        */
/* ==================================================================== */

/** 某实体的生效覆盖层（{field: value}）。 */
export function overlayFor(entityType, entityId) {
  if (!EDITABLE_ENTITIES[entityType]) return {};
  const rows = all(
    "SELECT field_key, value FROM admin_revision WHERE entity_type=? AND entity_id=? AND status='active'",
    [entityType, String(entityId)]
  );
  return Object.fromEntries(rows.map((r) => [r.field_key, r.value]));
}

/** 批量覆盖层（列表页用，一次查询）。 */
export function overlaysFor(entityType, ids = []) {
  const out = new Map();
  if (!EDITABLE_ENTITIES[entityType] || !ids.length) return out;
  const list = [...new Set(ids.map(String))].slice(0, 500);
  const rows = all(
    `SELECT entity_id, field_key, value FROM admin_revision
     WHERE entity_type=? AND status='active' AND entity_id IN (${list.map(() => '?').join(',')})`,
    [entityType, ...list]
  );
  for (const r of rows) {
    if (!out.has(r.entity_id)) out.set(r.entity_id, {});
    out.get(r.entity_id)[r.field_key] = r.value;
  }
  return out;
}

/**
 * 把覆盖层合并到一行上（**只读合并，绝不 UPDATE 业务表**）。
 * 返回 `manual_revision` / `manual_fields` / `original_values` 供界面标记「管理员修订」。
 */
export function mergeOverlay(entityType, row, overlay = null) {
  if (!row) return row;
  const ov = overlay || overlayFor(entityType, row.id);
  const keys = Object.keys(ov);
  if (!keys.length) return { ...row, manual_revision: false, manual_fields: [], original_values: {} };
  const merged = { ...row };
  const original = {};
  for (const k of keys) {
    original[k] = row[k] === undefined ? null : row[k];
    merged[k] = ov[k];
  }
  return {
    ...merged,
    manual_revision: true,
    manual_fields: keys,
    original_values: original,
    revision_note: '该行含管理员修订：原采集字段与官方数值保存在覆盖层，可在后台查看历史并恢复。',
  };
}

/** 给列表批量合并覆盖层。 */
export function mergeOverlays(entityType, rows = []) {
  const map = overlaysFor(entityType, rows.map((r) => r.id));
  return rows.map((r) => mergeOverlay(entityType, r, map.get(String(r.id)) || {}));
}

/* ==================================================================== */
/*  四、可编辑实体列表 / 预览 / 提交 / 历史 / 恢复                        */
/* ==================================================================== */

function requireAdmin(user) {
  if (user?.role !== 'admin') return { error: '仅管理员可维护公开内容', status: 403 };
  return null;
}

/** 列出可编辑实体（管理员）。 */
export function listEditableEntities(user, { entity_type: entityType = null, q = null, limit = 30 } = {}) {
  const denied = requireAdmin(user);
  if (denied) return denied;
  const types = entityType ? [entityType] : EDITABLE_KEYS;
  for (const t of types) if (!EDITABLE_ENTITIES[t]) return { error: `不支持的实体类型：${t}`, status: 400 };
  const out = {};
  const n = Math.max(1, Math.min(Number(limit) || 30, 100));
  for (const t of types) {
    const cfg = EDITABLE_ENTITIES[t];
    const where = [];
    const params = [];
    if (q) {
      where.push(`${cfg.titleCol} LIKE ?`);
      params.push(`%${String(q).slice(0, 80)}%`);
    }
    let rows = [];
    try {
      rows = all(
        `SELECT id, ${cfg.titleCol} AS title FROM ${cfg.table} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY ${cfg.order} LIMIT ?`,
        [...params, n]
      );
    } catch {
      rows = [];
    }
    out[t] = {
      label: cfg.label,
      fields: Object.entries(cfg.fields).map(([key, spec]) => ({ key, label: spec.label, type: spec.type, max: spec.max || null })),
      rows: rows.map((r) => mergeOverlay(t, r)),
    };
  }
  return {
    entities: out,
    types: EDITABLE_KEYS.map((k) => ({ key: k, label: EDITABLE_ENTITIES[k].label })),
    note:
      '修订写入**独立覆盖层**并标记「管理员修订」，原始快照与官方数值不被改写；' +
      'URL 仅接受 http(s)，字段按白名单与长度校验，含脚本载荷的值会被拒绝。',
  };
}

/** 取一条实体的完整当前值 + 覆盖层（编辑确认用）。 */
export function previewEdit(user, { entity_type: entityType, entity_id: entityId } = {}) {
  const denied = requireAdmin(user);
  if (denied) return denied;
  const cfg = EDITABLE_ENTITIES[entityType];
  if (!cfg) return { error: `不支持的实体类型：${entityType}`, status: 400 };
  const cols = tableColumns(cfg.table);
  const wanted = ['id', cfg.titleCol, ...Object.keys(cfg.fields)].filter((c, i, arr) => arr.indexOf(c) === i);
  const missing = wanted.filter((c) => !cols.includes(c));
  if (missing.length) {
    // 白名单与真实表结构不一致：明确报错，绝不静默返回空行
    return { error: `字段白名单与实际表结构不一致：${missing.join('、')}`, status: 500, entity_type: entityType, table: cfg.table };
  }
  const row = get(`SELECT ${wanted.join(',')} FROM ${cfg.table} WHERE id=?`, [String(entityId)]);
  if (!row) return { error: '目标记录不存在', status: 404 };
  const merged = mergeOverlay(entityType, row);
  return {
    entity_type: entityType,
    label: cfg.label,
    current: merged,
    overlay: overlayFor(entityType, entityId),
    fields: Object.entries(cfg.fields).map(([key, spec]) => ({ key, label: spec.label, type: spec.type, max: spec.max || null })),
    note: '提交后写入覆盖层并记录修订前后版本；原始采集值不会被 UPDATE。',
  };
}

/**
 * 提交管理员修订（写入覆盖层 + 审计 + 可恢复历史）。
 * @returns {{ok:boolean, revisions?:Array, entity?:object, error?:string, status?:number}}
 */
export function applyEdit(user, { entity_type: entityType, entity_id: entityId, fields = {}, note = null } = {}) {
  const denied = requireAdmin(user);
  if (denied) return denied;
  const cfg = EDITABLE_ENTITIES[entityType];
  if (!cfg) return { error: `不支持的实体类型：${entityType}`, status: 400 };
  if (!entityId) return { error: '缺少实体 ID', status: 400 };
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return { error: 'fields 须为对象', status: 400 };
  const keys = Object.keys(fields);
  if (!keys.length) return { error: '没有需要修订的字段', status: 400 };
  if (keys.length > 12) return { error: '单次修订字段过多（上限 12）', status: 400 };
  const row = get(`SELECT * FROM ${cfg.table} WHERE id=?`, [String(entityId)]);
  if (!row) return { error: '目标记录不存在', status: 404 };

  // 逐字段校验（白名单 + 类型 + 长度 + 防 XSS + URL 协议）
  const validated = {};
  const errors = [];
  for (const k of keys) {
    const r = validateField(entityType, k, fields[k]);
    if (!r.ok) errors.push(r.error);
    else validated[k] = r.value;
  }
  if (errors.length) return { error: '字段校验未通过', issues: errors, status: 400 };

  const now = nowIso();
  const revisions = [];
  for (const [fieldKey, value] of Object.entries(validated)) {
    const prev = get(
      "SELECT * FROM admin_revision WHERE entity_type=? AND entity_id=? AND field_key=? AND status='active'",
      [entityType, String(entityId), fieldKey]
    );
    const revisionNo = (prev?.revision_no || 0) + 1;
    // 原始公开显示值：优先覆盖层之前的原始值（保证链路可回溯到采集值）
    const originalValue = prev ? prev.original_value : (row[fieldKey] === undefined ? null : row[fieldKey]);
    const id = newId('REV');
    if (prev) {
      run("UPDATE admin_revision SET status='superseded', superseded_at=?, superseded_by=? WHERE id=?", [now, id, prev.id]);
    }
    run(
      `INSERT INTO admin_revision (id,entity_type,entity_id,field_key,value,original_value,revision_no,status,note,
         actor,actor_role,created_at,restored_from)
       VALUES (?,?,?,?,?,?,?,'active',?,?,?,?,?)`,
      [id, entityType, String(entityId), fieldKey, value === null ? null : String(value),
        originalValue === null || originalValue === undefined ? null : String(originalValue),
        revisionNo, note ? String(note).slice(0, 500) : null, user.name || 'unknown', user.role || null, now,
        prev ? prev.id : null]
    );
    audit({
      actor: user.name, actorRole: user.role, action: 'maintenance.edit',
      objectType: entityType, objectId: String(entityId),
      detail: {
        field: fieldKey, before: originalValue ?? null, after: value ?? null,
        revision_no: revisionNo, overlay: true, note: note ? String(note).slice(0, 500) : null,
      },
    });
    revisions.push({ id, field_key: fieldKey, value, original_value: originalValue, revision_no: revisionNo });
  }

  const after = mergeOverlay(entityType, get(`SELECT * FROM ${cfg.table} WHERE id=?`, [String(entityId)]));
  return {
    ok: true,
    entity_type: entityType,
    entity_id: String(entityId),
    revisions,
    entity: after,
    message:
      `已保存 ${revisions.length} 个字段的管理员修订（覆盖层，标记「管理员修订」）。` +
      '原始快照与官方数值未被修改；缺口说明不会被当作原始数据的修复。',
  };
}

/** 修订历史（管理员）。 */
export function listRevisions(user, { entity_type: entityType = null, entity_id: entityId = null, limit = 100 } = {}) {
  const denied = requireAdmin(user);
  if (denied) return denied;
  const where = [];
  const params = [];
  if (entityType) { where.push('entity_type = ?'); params.push(entityType); }
  if (entityId) { where.push('entity_id = ?'); params.push(String(entityId)); }
  const rows = all(
    `SELECT * FROM admin_revision ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT ?`,
    [...params, Math.max(1, Math.min(Number(limit) || 100, 500))]
  );
  return {
    revisions: rows,
    note: '每条修订都记录修改前后值与操作者；status=superseded 为历史版本，可恢复到任意历史值。',
  };
}

/** 恢复某个字段到指定历史修订（或回退到原始采集值）。 */
export function restoreRevision(user, revisionId) {
  const denied = requireAdmin(user);
  if (denied) return denied;
  const rev = get('SELECT * FROM admin_revision WHERE id=?', [String(revisionId)]);
  if (!rev) return { error: '修订记录不存在', status: 404 };
  const cfg = EDITABLE_ENTITIES[rev.entity_type];
  if (!cfg) return { error: `不支持的实体类型：${rev.entity_type}`, status: 400 };
  const row = get(`SELECT * FROM ${cfg.table} WHERE id=?`, [rev.entity_id]);
  if (!row) return { error: '目标记录不存在', status: 404 };
  const now = nowIso();
  const active = get(
    "SELECT * FROM admin_revision WHERE entity_type=? AND entity_id=? AND field_key=? AND status='active'",
    [rev.entity_type, rev.entity_id, rev.field_key]
  );
  const id = newId('REV');
  if (active) run("UPDATE admin_revision SET status='superseded', superseded_at=?, superseded_by=? WHERE id=?", [now, id, active.id]);
  if (rev.original_value === null || rev.original_value === '') {
    // 恢复为原始采集值 = 停用覆盖层
    run(
      `INSERT INTO admin_revision (id,entity_type,entity_id,field_key,value,original_value,revision_no,status,note,
         actor,actor_role,created_at,restored_from)
       VALUES (?,?,?,?,NULL,?,?,'reverted',?,?,?,?,?)`,
      [id, rev.entity_type, rev.entity_id, rev.field_key, rev.original_value, (active?.revision_no || 0) + 1,
        `恢复到原始采集值（撤销第 ${rev.revision_no} 次修订）`, user.name || 'unknown', user.role || null, now, rev.id]
    );
  } else {
    run(
      `INSERT INTO admin_revision (id,entity_type,entity_id,field_key,value,original_value,revision_no,status,note,
         actor,actor_role,created_at,restored_from)
       VALUES (?,?,?,?,?,?,?,'active',?,?,?,?,?)`,
      [id, rev.entity_type, rev.entity_id, rev.field_key, rev.value, rev.original_value, (active?.revision_no || 0) + 1,
        `恢复到第 ${rev.revision_no} 次修订值`, user.name || 'unknown', user.role || null, now, rev.id]
    );
  }
  audit({
    actor: user.name, actorRole: user.role, action: 'maintenance.restore',
    objectType: rev.entity_type, objectId: rev.entity_id,
    detail: { field: rev.field_key, restored_from: rev.id, to_value: rev.value },
  });
  return { ok: true, restored_from: rev.id, field_key: rev.field_key, entity: mergeOverlay(rev.entity_type, get(`SELECT * FROM ${cfg.table} WHERE id=?`, [rev.entity_id])) };
}

/* ==================================================================== */
/*  五、运行状态与缺口（仅管理员）                                        */
/* ==================================================================== */

/**
 * 运行与内容维护总览（仅管理员）。
 * 原「总览」页的自动运行状态与数据缺口版块移到这里；普通用户既看不到入口，
 * 也拿不到这些详细接口（路由层 403）。
 */
export function maintenanceOverview(user, { gapStatus = 'all' } = {}) {
  const denied = requireAdmin(user);
  if (denied) return denied;
  const sync = syncStatus();
  const triageAll = gapTriage.triageGaps({ status: 'all', limit: 300 });
  const triageById = new Map(triageAll.items.map((g) => [g.id, g]));
  const gaps = adminSvc.listGaps({ status: gapStatus }).map((g) => {
    const decorated = decorateGap(g);
    const t = triageById.get(g.id);
    return {
      ...decorated,
      triage: t?.triage || gapTriage.classifyGap(g),
      auto_settled: t?.auto_settled || null,
      // 缺口原因与**自动处理方式**分列：编辑说明不等于修复原始数据
      reason: decorated.description || decorated.impact || null,
      raw_data_fix: '缺口只能通过重新采集/补证/受控重解析结清；后台编辑说明不会改变原始数据。',
    };
  });
  const open = gaps.filter((g) => g.status === 'open');
  return {
    run: {
      data_as_of: sync.data_as_of || null,
      last_success_sync: sync.last_success_sync || null,
      last_job: sync.last_job || null,
      counts: sync.counts || {},
      alert: sync.alert || null,
      failed_jobs_2d: sync.counts?.failed_jobs_2d ?? 0,
    },
    gaps: {
      total: gaps.length,
      open: open.length,
      items: gaps,
      by_category: triageAll.by_category,
      categories: triageAll.categories,
      stage_categories: triageAll.stage_categories,
      optional_field_anomalies: triageAll.optional_field_anomalies,
      non_target_exclusions: triageAll.non_target_exclusions,
      note: triageAll.note,
    },
    summaries: summarySvc.summaryStatus(),
    ingest_summary: ingestSummary.ingestQueueStatus({ limit: 15 }),
    chat: chatSvc.chatStatus({ limit: 20 }),
    edit_types: EDITABLE_KEYS.map((k) => ({ key: k, label: EDITABLE_ENTITIES[k].label })),
    retry_targets: RETRY_TARGETS,
    official_domains: listOfficialDomains({ includeDisabled: true }),
    source_stats: sourceSummary(),
    note:
      '本页内容仅管理员可见：总览页不返回运行告警、缺口细节与核验统计。' +
      '内容修订走独立覆盖层（标记「管理员修订」），不覆盖原始快照与官方数值。',
  };
}

function sourceSummary() {
  const rows = all(
    `SELECT source_url AS url, publisher FROM content_item
     WHERE is_demo=0 AND duplicate_of IS NULL AND record_kind='article' LIMIT 500`
  );
  const counts = { official: 0, third_party: 0, unknown: 0 };
  for (const r of rows) counts[sourceDisplay({ url: r.url, publisher: r.publisher }).kind] += 1;
  return { sampled: rows.length, counts, note: '按内容库抽样统计来源展示口径（官方 / 第三方 / 未标注）。' };
}

/* ==================================================================== */
/*  六、有界重试采集（真实调用既有采集入口）                              */
/* ==================================================================== */

export const RETRY_TARGETS = [
  { key: 'trade', label: 'CCER 每日行情（官方公告）', hint: '按官方公告页重新采集最近交易日行情' },
  { key: 'policy', label: '官方政策巡检', hint: '巡检已登记官方政策页面并归档原文' },
  { key: 'content', label: '研报与动态检索', hint: '用已配置搜索服务执行一次有界检索发现' },
  { key: 'summaries', label: '核心摘要补齐', hint: '对缺失/失效摘要执行一次有界批次生成' },
];

/**
 * 有界重试（仅管理员）。每个目标都调用**既有**采集入口，不另写抓取实现。
 * 未配置凭据时如实返回失败原因，不伪造成功。
 */
export async function runRetry(user, { target, limit = 5, actorNote = null } = {}) {
  const denied = requireAdmin(user);
  if (denied) return denied;
  const t = RETRY_TARGETS.find((x) => x.key === target);
  if (!t) return { error: `不支持的重试目标：${target}（可选：${RETRY_TARGETS.map((x) => x.key).join('/')}）`, status: 400 };
  const n = Math.max(1, Math.min(Number(limit) || 5, 20));
  const actor = user.name || 'unknown';
  audit({ actor, actorRole: user.role, action: 'maintenance.retry', objectType: 'collect', objectId: t.key, detail: { limit: n, note: actorNote } });

  if (t.key === 'summaries') {
    const out = await summarySvc.runSummaryBatchExclusive({ limit: n, actor, budgetMs: 60_000 });
    if (out?.busy) {
      return {
        ok: false, target: t.key, label: t.label, ...out,
        message: '已有摘要批次在执行中（全局/跨进程单并发），本次未执行。',
      };
    }
    return {
      ok: out.generated > 0 || !out.model_configured ? !!out.model_configured : true,
      target: t.key, label: t.label, ...out,
      message: out.model_configured
        ? `摘要批次完成：生成 ${out.generated} 条，失败 ${out.failed} 条，跳过 ${out.skipped} 条。`
        : '未配置可用模型：本次没有生成任何摘要（不伪造「模型生成」）。',
    };
  }
  if (t.key === 'trade') {
    const collect = await import('./collect-svc.mjs');
    const out = await collect.collectTradeQuotes({ actor, onlyNew: true, limit: n, withDimension: true });
    return { target: t.key, label: t.label, ...out };
  }
  if (t.key === 'policy') {
    const collect = await import('./collect-svc.mjs');
    const out = await collect.patrolPolicyDocuments({ actor });
    return { target: t.key, label: t.label, ...out };
  }
  // content
  const content = await import('./content-svc.mjs');
  const out = await content.collectFromSearch({
    actor, windowDays: 7, countPerQuery: 5, maxQueries: Math.min(n, 6), maxItems: n, fetchBody: true, verify: false,
  });
  return { target: t.key, label: t.label, ...out };
}

/** 缺口原因（管理员，含实时推导状态）。 */
export function gapReasons(user, { status = 'all' } = {}) {
  const denied = requireAdmin(user);
  if (denied) return denied;
  const triage = gapTriage.triageGaps({ status, limit: 300, persist: false });
  return {
    gaps: triage.items.map((d) => ({
      ...d,
      gap_key: d.gap_key, dataset: d.dataset, severity: d.severity, status: d.status,
      title: d.title, reason: d.description || null, impact: d.impact || null,
      auto_action: d.triage.auto_action || d.auto_action || null, detected_at: d.detected_at, updated_at: d.updated_at,
      triage: d.triage,
      raw_data_fix: '结清缺口只能靠重新采集/补证/受控重解析；编辑缺口说明不会修复原始数据。',
    })),
    by_category: triage.by_category,
    categories: triage.categories,
    stage_categories: triage.stage_categories,
    optional_field_anomalies: triage.optional_field_anomalies,
    non_target_exclusions: triage.non_target_exclusions,
    note: triage.note,
  };
}

export { upsertOfficialDomain, seedOfficialDomains, listOfficialDomains };
