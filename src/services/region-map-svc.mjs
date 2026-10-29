/**
 * 省域地图服务（docs/59）
 * ============================================================================
 * 职责：
 *   1. 生成 `/api/v2/overview/region-map` 的只读数据：
 *      - 固定 34 个省级地区；
 *      - 公开 CCER 项目数/项目登记数/减排量登记项目数（真实、非 demo、按登记号去重）；
 *      - 区域 CO₂ / 全国碳市场纳管排放（只取有明确年度、单位、省份、原文证据的有效记录）；
 *      - 全国碳市场名录数（按名录年度、企业去重，不跨年累加）；
 *      - 未知省份单列，不猜测。
 *   2. 严格校验查询参数与导入记录；
 *   3. 生成与页面一致的 CSV 行（公式注入防护由 export-svc 统一处理）；
 *   4. 幂等导入、修订留痕、审计；
 *   5. 日更任务中的有界状态检查（不重算年度排放值）。
 *
 * 本模块不访问外网、不读取凭据、不生成任何排放数字。没有证据就是 null。
 */
import { createHash } from 'node:crypto';
import { all, get, run, tx, audit, dbPath, getMeta, getDb } from '../core/db.mjs';
import { newId, nowIso, todayCst } from '../core/util.mjs';
import {
  PROVINCES, PROVINCE_CODES, REGION_GROUPS, regionCatalog,
  normalizeProvince, provinceByCode, isRegionGroup,
} from '../data/region-catalog.mjs';
import { STAGE_COLUMNS, projectLogicalKey } from './project-aggregate.mjs';

const CURRENT_YEAR = Number(todayCst().slice(0, 4));
const MAX_IMPORT_ROWS = 1000;
const MAX_VALUE_TCO2 = 1e12; // 省级单年 CO₂ 远低于此值；仅用于拦截明显录入错误

export const PROJECT_METRICS = ['projects', 'registered_projects', 'reduction_registered_projects'];
export const EMISSION_METRICS = ['region_co2', 'national_ets'];
export const DIRECTORY_METRICS = ['ets_entities'];
export const METRICS = [...PROJECT_METRICS, ...EMISSION_METRICS, ...DIRECTORY_METRICS];

export const METRIC_META = {
  projects: {
    key: 'projects', view: 'projects', label: '公开项目数', unit: '个',
    scope: 'ccer_project', value_key: 'project_count',
  },
  registered_projects: {
    key: 'registered_projects', view: 'projects', label: '项目登记数', unit: '个',
    scope: 'ccer_project', value_key: 'registered_count',
  },
  reduction_registered_projects: {
    key: 'reduction_registered_projects', view: 'projects', label: '减排量登记项目数', unit: '个',
    scope: 'ccer_project', value_key: 'reduction_registered_count',
  },
  region_co2: {
    key: 'region_co2', view: 'region_co2', label: '区域 CO₂ 排放', unit: 'tCO2',
    scope: 'region_co2',
  },
  national_ets: {
    key: 'national_ets', view: 'national_ets', label: '全国碳市场纳管排放', unit: 'tCO2',
    scope: 'national_ets',
  },
  ets_entities: {
    key: 'ets_entities', view: 'ets_entities', label: 'CEA纳管企业名录', unit: '家',
    scope: 'cea_entity', value_key: 'directory_count',
  },
};

export const VIEWS = [
  { key: 'projects', label: '公开 CCER 项目', metrics: PROJECT_METRICS },
  { key: 'region_co2', label: '区域 CO₂ 排放', metrics: ['region_co2'] },
  { key: 'national_ets', label: '全国碳市场纳管排放', metrics: ['national_ets'] },
  { key: 'ets_entities', label: 'CEA纳管企业名录', metrics: DIRECTORY_METRICS },
];

export const SUBMETRICS = PROJECT_METRICS.map((key) => ({
  key, label: METRIC_META[key].label, unit: METRIC_META[key].unit,
}));

export const CCER_PROJECT_SOURCE_URL = 'https://ccer.cets.org.cn/projectPublicity/projectPublicityList';
export const CCER_PROJECT_SOURCE = {
  dataset_key: 'ccer-public-projects',
  source_name: '本平台公开项目库（官方公开栏目聚合）',
  source_url: CCER_PROJECT_SOURCE_URL,
  source_kind: 'platform',
  source_kind_label: '平台聚合统计',
  methodology: '按官方登记编号去重（缺失时按项目 ID）；阶段标记取并集，不按阶段相加',
  boundary: '本平台已收录的公开 CCER 项目，不代表全国项目总数',
  excerpt: '0 表示本系统在该省尚未收录公开项目，不是该省没有项目。',
  verification_status: 'source_recorded',
};

const ALLOWED_QUERY_KEYS = new Set([
  'metric', 'year', 'list_year', 'region', 'domain', 'methodology_id', 'stage', 'dataset',
]);
const EXPORT_QUERY_KEYS = new Set([...ALLOWED_QUERY_KEYS, 'format']);
const IMPORT_KEYS = new Set([
  'province', 'province_code', 'province_name', 'scope', 'year', 'value_tco2', 'unit',
  'methodology', 'boundary', 'dataset_key', 'source_name', 'source_url', 'source_kind',
  'published_at', 'excerpt', 'snapshot_hash', 'collected_at', '__row',
]);

const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

/* ==================================================================== */
/*  一、基础格式与 URL 校验                                               */
/* ==================================================================== */

function textValue(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'string') return v.trim() || null;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
}

function shortText(v, max) {
  const s = textValue(v);
  if (!s) return null;
  return s.length > max ? null : s;
}

/** 只允许 http(s)，拒绝凭据、内网/回环地址；官方来源还要求 https + 官方域名。 */
export function validateSourceUrl(raw, sourceKind = 'research') {
  const s = textValue(raw);
  if (!s) return { ok: false, error: '缺少来源链接 source_url' };
  if (s.length > 2000) return { ok: false, error: '来源链接过长' };
  if (CONTROL_RE.test(s)) return { ok: false, error: '来源链接包含控制字符' };
  let u;
  try {
    u = new URL(s);
  } catch {
    return { ok: false, error: '来源链接必须是完整的 http(s) URL' };
  }
  if (!['http:', 'https:'].includes(u.protocol)) {
    return { ok: false, error: '来源链接只允许 http 或 https' };
  }
  if (u.username || u.password) return { ok: false, error: '来源链接不得包含用户名或口令' };
  const host = normalizeHost(u.hostname);
  if (!host || host.includes('..')) return { ok: false, error: '来源链接域名无效' };
  if (isPrivateHost(host)) return { ok: false, error: '来源链接不得指向本机或内网地址' };
  if (sourceKind === 'official') {
    if (u.protocol !== 'https:') return { ok: false, error: 'official 来源必须使用 https' };
    if (!isOfficialHost(host)) {
      return {
        ok: false,
        error: 'official 来源必须使用政府（.gov.cn）或全国碳市场/CCER 官方域名（cets.org.cn）；'
          + '其他来源请如实标记为 research，不能伪造官方来源',
      };
    }
  }
  return { ok: true, url: u.toString(), host };
}

/** 去掉 IPv6 方括号和末尾的点；`localhost.` 与 `localhost` 必须同等对待。 */
function normalizeHost(host) {
  return String(host || '').toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.+$/, '');
}

function isPrivateIpv4(ip) {
  const p = String(ip).split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  if (p[0] === 10 || p[0] === 127 || p[0] === 0) return true;
  if (p[0] === 169 && p[1] === 254) return true;
  if (p[0] === 192 && p[1] === 168) return true;
  if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
  if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true;
  return false;
}

/** 展开 IPv6（含 :: 与内嵌 IPv4）；无法解析时返回 null。 */
function expandIpv6(ip) {
  let s = String(ip).toLowerCase().split('%')[0];
  if (!s || !s.includes(':')) return null;
  if (s.includes('.')) {
    const idx = s.lastIndexOf(':');
    if (idx < 0) return null;
    const v4 = s.slice(idx + 1).split('.').map(Number);
    if (v4.length !== 4 || v4.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    s = `${s.slice(0, idx + 1)}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  if (halves.length === 1 && left.length !== 8) return null;
  const missing = 8 - left.length - right.length;
  if (missing < 0) return null;
  const groups = [...left, ...Array(missing).fill('0'), ...right];
  if (groups.length !== 8) return null;
  const nums = groups.map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  return nums.some(Number.isNaN) ? null : nums;
}

function isPrivateIpv6(ip) {
  const g = expandIpv6(ip);
  if (!g) return true; // 无法可靠判定的地址一律拒绝
  if (g.every((n) => n === 0)) return true; // ::
  if (g.slice(0, 7).every((n) => n === 0) && g[7] === 1) return true; // ::1
  if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7
  if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10
  const v4 = `${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`;
  // IPv4 映射 ::ffff:0:0/96、IPv4 兼容 ::/96、NAT64 64:ff9b::/96
  if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0
    && ((g[4] === 0 && g[5] === 0xffff) || (g[4] === 0 && g[5] === 0))) {
    if (isPrivateIpv4(v4)) return true;
  }
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 0 && g[3] === 0
    && g[4] === 0 && g[5] === 0 && isPrivateIpv4(v4)) return true;
  return false;
}

function isPrivateHost(host) {
  const h = normalizeHost(host);
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost') || h === 'local'
    || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return isPrivateIpv4(h);
  if (h.includes(':')) return isPrivateIpv6(h);
  return false;
}

function isOfficialHost(host) {
  const h = String(host || '').toLowerCase();
  return h === 'gov.cn' || h.endsWith('.gov.cn')
    || h === 'cets.org.cn' || h.endsWith('.cets.org.cn');
}

/** API/CSV 只输出通过协议校验的链接；数据库中的脏 URL 一律降级为 null。 */
export function safeHttpUrl(raw) {
  const s = textValue(raw);
  if (!s) return null;
  try {
    const u = new URL(s);
    if (!['http:', 'https:'].includes(u.protocol)) return null;
    if (u.username || u.password) return null;
    const host = normalizeHost(u.hostname);
    if (!host || isPrivateHost(host)) return null;
    return u.toString();
  } catch {
    return null;
  }
}

/** 展示换算：底层值始终是 tCO2；万吨/亿吨只用于展示。 */
export function formatTco2(value) {
  if (value === null || value === undefined || value === '') return '—';
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  const fmt = (v, digits) => Number(v).toLocaleString('zh-CN', {
    minimumFractionDigits: 0, maximumFractionDigits: digits,
  });
  if (n >= 1e8) return `${fmt(n / 1e8, 2)} 亿吨`;
  if (n >= 1e4) return `${fmt(n / 1e4, 2)} 万吨`;
  return `${fmt(n, 0)} 吨`;
}

export function formatProjectCount(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—';
  return `${Number(value).toLocaleString('zh-CN')} 个`;
}

export function formatEntityCount(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—';
  return `${Number(value).toLocaleString('zh-CN')} 家`;
}

export function formatListYear(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? `${n} 年` : '名录年度未取得';
}

const NATIONAL_ETS_SECTORS = ['发电', '钢铁', '水泥', '铝冶炼'];
const DIRECTORY_SCOPE_NOTE =
  '本平台已收录，非全国/全省完整数量；行业覆盖以各省详情为准，未取得出处的行业不补 0，也不代表不存在。';

function splitSectors(value) {
  return String(value || '')
    .split(/[、,，;；/]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function dateOnly(s) {
  const v = textValue(s);
  if (!v) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : v.slice(0, 10);
}

/** 严格校验 YYYY-MM-DD 是真实存在的日历日（拒绝 2025-02-30）。 */
export function isValidCalendarDate(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const dt = new Date(Date.UTC(year, month - 1, day));
  return dt.getUTCFullYear() === year
    && dt.getUTCMonth() === month - 1
    && dt.getUTCDate() === day;
}

function sourceKindLabel(kind) {
  return kind === 'official' ? '官方' : kind === 'research' ? '研究核算' : '平台聚合统计';
}

/* ==================================================================== */
/*  二、查询参数校验                                                      */
/* ==================================================================== */

export function validateRegionMapQuery(query = {}, { allowFormat = false } = {}) {
  const allowed = allowFormat ? EXPORT_QUERY_KEYS : ALLOWED_QUERY_KEYS;
  for (const key of Object.keys(query || {})) {
    if (!allowed.has(key)) {
      return { ok: false, status: 400, error: '参数不在白名单内', parameter: key };
    }
  }
  const metric = textValue(query.metric) || 'projects';
  if (!METRICS.includes(metric)) {
    return {
      ok: false, status: 400, error: `不支持的指标：${metric}`,
      parameter: 'metric', allowed: METRICS,
    };
  }
  const isProject = PROJECT_METRICS.includes(metric);
  const isDirectory = DIRECTORY_METRICS.includes(metric);
  const yearText = textValue(query.year);
  let year = null;
  if (yearText !== null) {
    if (!/^\d{4}$/.test(yearText)) {
      return { ok: false, status: 400, error: 'year 必须是四位年份', parameter: 'year' };
    }
    year = Number(yearText);
    if (!Number.isInteger(year) || year < 1990 || year > CURRENT_YEAR) {
      return {
        ok: false, status: 400, error: `year 必须在 1990–${CURRENT_YEAR} 之间`,
        parameter: 'year',
      };
    }
    if (isProject) {
      return {
        ok: false, status: 400,
        error: '公开项目指标是当前收录快照，不使用 year 过滤；排放视图才按年度选择',
        parameter: 'year',
      };
    }
    if (isDirectory) {
      return {
        ok: false, status: 400,
        error: '名录视图按 list_year 选择名录年度，不借用排放年度 year',
        parameter: 'year',
      };
    }
  }

  const listYearText = textValue(query.list_year);
  let listYear = null;
  if (listYearText !== null) {
    if (!/^\d{4}$/.test(listYearText)) {
      return { ok: false, status: 400, error: 'list_year 必须是四位年份', parameter: 'list_year' };
    }
    listYear = Number(listYearText);
    if (!Number.isInteger(listYear) || listYear < 2000 || listYear > CURRENT_YEAR + 1) {
      return {
        ok: false, status: 400, error: `list_year 必须在 2000–${CURRENT_YEAR + 1} 之间`,
        parameter: 'list_year',
      };
    }
    if (!isDirectory) {
      return {
        ok: false, status: 400,
        error: 'list_year 只用于 CEA 纳管企业名录视图；排放视图请使用 year',
        parameter: 'list_year',
      };
    }
  }

  const region = textValue(query.region);
  if (region && !isRegionGroup(region)) {
    return {
      ok: false, status: 400, error: `未知区域分组：${region}`,
      parameter: 'region', allowed: REGION_GROUPS.map((g) => g.key),
    };
  }
  const domain = textValue(query.domain);
  const methodologyId = textValue(query.methodology_id);
  for (const [key, value] of [['domain', domain], ['methodology_id', methodologyId]]) {
    if (value && (value.length > 120 || CONTROL_RE.test(value))) {
      return { ok: false, status: 400, error: `${key} 格式无效`, parameter: key };
    }
  }
  const stage = textValue(query.stage);
  if (stage && !STAGE_COLUMNS[stage]) {
    return {
      ok: false, status: 400, error: `未知阶段：${stage}`,
      parameter: 'stage', allowed: Object.keys(STAGE_COLUMNS),
    };
  }
  const dataset = textValue(query.dataset);
  if (dataset) {
    if (!/^[a-z0-9][a-z0-9._-]{2,80}$/i.test(dataset)) {
      return { ok: false, status: 400, error: 'dataset 格式无效', parameter: 'dataset' };
    }
    if (isProject) {
      return {
        ok: false, status: 400,
        error: '公开项目视图不使用 dataset；排放视图才按数据集选择',
        parameter: 'dataset',
      };
    }
    if (isDirectory) {
      return {
        ok: false, status: 400,
        error: '名录视图不使用 dataset；名录年度请使用 list_year',
        parameter: 'dataset',
      };
    }
  }
  let format = null;
  if (allowFormat) {
    format = (textValue(query.format) || 'csv').toLowerCase();
    if (!['csv', 'xlsx', 'json'].includes(format)) {
      return { ok: false, status: 400, error: 'format 只支持 csv 或 xlsx', parameter: 'format' };
    }
  }
  return {
    ok: true,
    value: {
      metric, view: METRIC_META[metric].view, year, list_year: listYear, region: region || null,
      domain: domain || null, methodology_id: methodologyId || null,
      stage: stage || null, dataset: dataset || null, format,
    },
  };
}

/** 白名单之外再确认 domain/methodology 确实存在于公开项目库，避免任意字符串查询。 */
function validateFilterValues(f) {
  if (f.domain) {
    const row = get(
      'SELECT 1 AS ok FROM public_project WHERE COALESCE(is_demo,0)=0 AND domain = ? LIMIT 1',
      [f.domain]
    );
    if (!row) {
      return { error: '领域筛选值不在公开项目库中', parameter: 'domain', status: 400 };
    }
  }
  if (f.methodology_id) {
    const row = get(
      'SELECT 1 AS ok FROM public_project WHERE COALESCE(is_demo,0)=0 AND methodology_id = ? LIMIT 1',
      [f.methodology_id]
    );
    if (!row) {
      return { error: '方法学筛选值不在公开项目库中', parameter: 'methodology_id', status: 400 };
    }
  }
  return null;
}

/* ==================================================================== */
/*  三、项目聚合（34 地区 + 未知省份）                                    */
/* ==================================================================== */

function projectAggregates(f) {
  const where = ['COALESCE(p.is_demo,0)=0'];
  const params = [];
  if (f.domain) { where.push('p.domain = ?'); params.push(f.domain); }
  if (f.methodology_id) { where.push('p.methodology_id = ?'); params.push(f.methodology_id); }
  if (f.stage && STAGE_COLUMNS[f.stage]) {
    where.push(`p.${STAGE_COLUMNS[f.stage]} = 1`);
  }
  const rows = all(
    `SELECT p.id, p.registry_project_no, p.name, p.province, p.methodology_id,
            p.current_stage, p.updated_at, p.stage_project_registered,
            p.stage_reduction_registered
     FROM public_project p
     WHERE ${where.join(' AND ')}`,
    params
  );

  // 同一官方登记编号只算一个项目；阶段标记取并集，避免同项目多行重复。
  const seen = new Map();
  let provinceConflicts = 0;
  for (const row of rows) {
    const logicalKey = projectLogicalKey(row);
    const province = normalizeProvince(row.province);
    const rawProvince = textValue(row.province);
    const registered = Number(row.stage_project_registered) === 1;
    const reduction = Number(row.stage_reduction_registered) === 1;
    const prev = seen.get(logicalKey);
    if (!prev) {
      seen.set(logicalKey, {
        id: row.id,
        name: row.name,
        methodology_id: row.methodology_id,
        current_stage: row.current_stage,
        updated_at: row.updated_at,
        rawProvince,
        province,
        provinceCode: province ? province.code : null,
        registered,
        reduction,
      });
    } else {
      prev.registered = prev.registered || registered;
      prev.reduction = prev.reduction || reduction;
      if (!prev.rawProvince && rawProvince) prev.rawProvince = rawProvince;
      if (row.updated_at && String(row.updated_at) > String(prev.updated_at || '')) {
        prev.id = row.id;
        prev.name = row.name;
        prev.methodology_id = row.methodology_id;
        prev.current_stage = row.current_stage;
        prev.updated_at = row.updated_at;
      }
      if (province) {
        if (prev.provinceCode && prev.provinceCode !== province.code) provinceConflicts += 1;
        if (!prev.provinceCode) {
          prev.provinceCode = province.code;
          prev.province = province;
        }
      }
    }
  }

  const deduped = [...seen.values()].sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
  const byCode = new Map(PROVINCES.map((p) => [p.code, {
    project_count: 0,
    registered_count: 0,
    reduction_registered_count: 0,
    samples: [],
  }]));
  const labelCounts = new Map();
  const unknown = new Map();
  let asOf = null;
  for (const row of deduped) {
    const day = dateOnly(row.updated_at);
    if (day && (!asOf || day > asOf)) asOf = day;
    if (!row.provinceCode) {
      const label = row.rawProvince || '未标注省份';
      const key = row.rawProvince || '__missing__';
      const item = unknown.get(key) || {
        province: label,
        project_count: 0,
        registered_count: 0,
        reduction_registered_count: 0,
      };
      item.project_count += 1;
      if (row.registered) item.registered_count += 1;
      if (row.reduction) item.reduction_registered_count += 1;
      unknown.set(key, item);
      continue;
    }
    const agg = byCode.get(row.provinceCode);
    agg.project_count += 1;
    if (row.registered) agg.registered_count += 1;
    if (row.reduction) agg.reduction_registered_count += 1;
    if (row.rawProvince) {
      if (!labelCounts.has(row.provinceCode)) labelCounts.set(row.provinceCode, new Map());
      const counts = labelCounts.get(row.provinceCode);
      counts.set(row.rawProvince, (counts.get(row.rawProvince) || 0) + 1);
    }
    if (agg.samples.length < 6) {
      agg.samples.push({
        id: row.id,
        name: row.name,
        methodology_id: row.methodology_id,
        current_stage: row.current_stage,
        updated_at: row.updated_at,
      });
    }
  }
  return {
    byCode,
    labelCounts,
    unknown: [...unknown.values()].sort((a, b) => b.project_count - a.project_count),
    total: deduped.length,
    as_of: asOf,
    province_conflicts: provinceConflicts,
  };
}

/* ==================================================================== */
/*  四、全国碳市场名录聚合（按年度、企业去重）                            */
/* ==================================================================== */

function emptyDirectoryAggregates(error = null, extra = {}) {
  return {
    available: false,
    years: [],
    latest_year: null,
    selected_year: null,
    by_year: new Map(),
    all_years: new Map(),
    label_counts: new Map(),
    unknown: [],
    unknown_by_year: new Map(),
    source_sets: new Map(),
    source_meta: new Map(),
    source_as_of: new Map(),
    sector_sets: new Map(),
    as_of_by_year_province: new Map(),
    total_latest_year: null,
    total_selected_year: null,
    total_all_years: null,
    as_of: null,
    latest_as_of: null,
    sources: [],
    error,
    ...extra,
  };
}

/**
 * 全国碳市场名录聚合。
 * 去重键优先使用统一社会信用代码，未披露时退回 entity_key/名称；只在“信用代码+名录年度”内去重，
 * 同一主体跨行业/多出处只计 1 家。省份无记录时 count=null，不补 0。
 */
function directoryAggregates(requestedYear = null) {
  let rows = [];
  try {
    rows = all(
      `SELECT id, entity_key, credit_code, name, province, sector, list_year,
              data_as_of, source_url, source_code, updated_at
       FROM cea_entity`
    );
  } catch (e) {
    return emptyDirectoryAggregates(e.message);
  }
  if (!rows.length) return emptyDirectoryAggregates();
  const years = [...new Set(rows.map((r) => Number(r.list_year)).filter((y) => Number.isInteger(y)))]
    .sort((a, b) => b - a);
  if (!years.length) return emptyDirectoryAggregates();
  const selectedYear = requestedYear === null || requestedYear === undefined
    ? years[0] : Number(requestedYear);
  if (!years.includes(selectedYear)) {
    return emptyDirectoryAggregates(
      `未收录 ${requestedYear} 年名录；可选名录年度：${years.join('、')}。`,
      {
        status: 400, years, latest_year: years[0], selected_year: null,
        total_latest_year: null, total_selected_year: null, total_all_years: null,
      }
    );
  }

  // 成员关系表保存同一主体在各官方名单中的行业/出处；老库缺失该表时退回主体行字段。
  let memberships = [];
  try {
    memberships = all(
      `SELECT entity_id, source_code, source_url, sector
       FROM cea_entity_membership`
    );
  } catch {
    memberships = [];
  }
  const membershipsByEntity = new Map();
  for (const m of memberships) {
    if (!membershipsByEntity.has(m.entity_id)) membershipsByEntity.set(m.entity_id, []);
    membershipsByEntity.get(m.entity_id).push(m);
  }

  const byYear = new Map();
  const allYears = new Map();
  const labelCounts = new Map();
  const unknownAll = new Map();
  const unknownByYear = new Map();
  const sourceSets = new Map();
  const sourceMeta = new Map();
  const sourceAsOf = new Map();
  const sectorSets = new Map();
  const asOfByYearProvince = new Map();
  // 省详情里提供少量真实企业入口（只列已收录名录行），可进入企业档案。
  const entityRowsByYearProvince = new Map();

  const addSource = (yearKey, sourceKey, key, day, code, url) => {
    if (!sourceMeta.has(sourceKey)) sourceMeta.set(sourceKey, { source_code: code || null, source_url: url || null });
    const meta = sourceMeta.get(sourceKey);
    if (!meta.source_url && url) meta.source_url = url;
    if (!sourceSets.has(yearKey)) sourceSets.set(yearKey, new Map());
    const map = sourceSets.get(yearKey);
    if (!map.has(sourceKey)) map.set(sourceKey, new Set());
    map.get(sourceKey).add(key);
    if (day) {
      const asOfKey = `${yearKey}|${sourceKey}`;
      if (!sourceAsOf.has(asOfKey) || day > sourceAsOf.get(asOfKey)) sourceAsOf.set(asOfKey, day);
    }
  };

  for (const row of rows) {
    const year = Number(row.list_year);
    if (!Number.isInteger(year) || !years.includes(year)) continue;
    // The project map uses geographical aliases; directory jurisdiction is separate.
    const isCorps = ['新疆生产建设兵团', '新疆建设兵团', '新疆兵团'].includes(String(row.province || '').trim());
    const province = isCorps ? null : normalizeProvince(row.province);
    const creditCode = String(row.credit_code || '').trim().toUpperCase();
    const key = creditCode
      || String(row.entity_key || '').trim()
      || `name:${String(row.name || '').trim()}`;
    if (!key) continue;
    const yearKeyBase = `${year}|${province ? province.code : ''}`;
    const day = dateOnly(row.data_as_of) || dateOnly(row.updated_at);
    if (!province) {
      const label = String(row.province || '').trim() || '未标注省份';
      if (!unknownAll.has(label)) unknownAll.set(label, new Set());
      unknownAll.get(label).add(key);
      if (!unknownByYear.has(year)) unknownByYear.set(year, new Map());
      const map = unknownByYear.get(year);
      if (!map.has(label)) map.set(label, new Set());
      map.get(label).add(key);
      continue;
    }
    const code = province.code;
    if (!allYears.has(code)) allYears.set(code, new Set());
    allYears.get(code).add(key);
    if (!labelCounts.has(code)) labelCounts.set(code, new Map());
    const rawLabel = String(row.province || '').trim();
    if (rawLabel) labelCounts.get(code).set(rawLabel, (labelCounts.get(code).get(rawLabel) || 0) + 1);
    if (!byYear.has(yearKeyBase)) byYear.set(yearKeyBase, new Set());
    byYear.get(yearKeyBase).add(key);
    if (!entityRowsByYearProvince.has(yearKeyBase)) entityRowsByYearProvince.set(yearKeyBase, []);
    entityRowsByYearProvince.get(yearKeyBase).push({
      id: row.id, name: row.name, list_year: year, sector: row.sector || null,
      credit_code: row.credit_code || null,
    });
    if (!sectorSets.has(yearKeyBase)) sectorSets.set(yearKeyBase, new Set());
    const memberRows = membershipsByEntity.get(row.id) || [];
    const sectors = new Set(sectorSets.get(yearKeyBase));
    for (const m of memberRows) for (const s of splitSectors(m.sector)) sectors.add(s);
    if (!sectors.size) for (const s of splitSectors(row.sector)) sectors.add(s);
    sectorSets.set(yearKeyBase, sectors);
    if (day && (!asOfByYearProvince.has(yearKeyBase) || day > asOfByYearProvince.get(yearKeyBase))) {
      asOfByYearProvince.set(yearKeyBase, day);
    }
    const refs = memberRows.length
      ? memberRows.map((m) => ({ source_code: m.source_code, source_url: m.source_url }))
      : [{ source_code: row.source_code, source_url: row.source_url }];
    const seenRefs = new Set();
    for (const ref of refs) {
      const sourceCode = String(ref.source_code || '').trim();
      const sourceUrl = safeHttpUrl(ref.source_url);
      if (!sourceCode && !sourceUrl) continue;
      // 以实际链接作为出处标识，确保同一代码下不同官方文件不会被合并掉。
      const sourceKey = sourceUrl ? `url:${sourceUrl}` : `code:${sourceCode}`;
      if (seenRefs.has(sourceKey)) continue;
      seenRefs.add(sourceKey);
      addSource(yearKeyBase, sourceKey, key, day, sourceCode, sourceUrl);
    }
  }

  let totalSelected = 0;
  for (const p of PROVINCES) totalSelected += byYear.get(`${selectedYear}|${p.code}`)?.size || 0;
  let totalLatest = 0;
  for (const p of PROVINCES) totalLatest += byYear.get(`${years[0]}|${p.code}`)?.size || 0;
  const allYearsCount = new Map([...allYears.entries()].map(([code, set]) => [code, set.size]));
  const totalAll = [...allYears.values()].reduce((sum, set) => sum + set.size, 0);
  const unknown = [...unknownAll.entries()].map(([province, set]) => ({ province, count: set.size }));
  const selectedUnknown = [...(unknownByYear.get(selectedYear) || new Map()).entries()]
    .map(([province, set]) => ({ province, count: set.size }));

  // 全部省级出处汇总（当前名录年度）；不下沉为“最后一条全库来源”。
  const selectedSourceSets = new Map();
  for (const p of PROVINCES) {
    const map = sourceSets.get(`${selectedYear}|${p.code}`);
    if (!map) continue;
    for (const [sourceKey, keys] of map.entries()) {
      if (!selectedSourceSets.has(sourceKey)) selectedSourceSets.set(sourceKey, new Set());
      for (const key of keys) selectedSourceSets.get(sourceKey).add(`${p.code}|${key}`);
    }
  }
  const sources = [...selectedSourceSets.entries()].map(([sourceKey, keys]) => {
    const meta = sourceMeta.get(sourceKey) || {};
    const asOf = sourceAsOf.get(`${selectedYear}|${sourceKey}`) || null;
    return {
      source_code: meta.source_code || null,
      source_url: meta.source_url || null,
      count: keys.size,
      as_of: asOf,
    };
  }).sort((a, b) => b.count - a.count || String(a.source_code || a.source_url).localeCompare(String(b.source_code || b.source_url)));

  const selectedAsOf = PROVINCES.reduce((max, p) => {
    const day = asOfByYearProvince.get(`${selectedYear}|${p.code}`);
    return day && (!max || day > max) ? day : max;
  }, null);
  const latestAsOf = PROVINCES.reduce((max, p) => {
    const day = asOfByYearProvince.get(`${years[0]}|${p.code}`);
    return day && (!max || day > max) ? day : max;
  }, null);

  return {
    available: true,
    years,
    latest_year: years[0],
    selected_year: selectedYear,
    by_year: byYear,
    all_years: allYearsCount,
    label_counts: labelCounts,
    unknown,
    unknown_by_year: unknownByYear,
    selected_unknown: selectedUnknown,
    source_sets: sourceSets,
    source_meta: sourceMeta,
    source_as_of: sourceAsOf,
    sector_sets: sectorSets,
    entity_rows_by_year_province: entityRowsByYearProvince,
    as_of_by_year_province: asOfByYearProvince,
    total_latest_year: totalLatest,
    total_selected_year: totalSelected,
    total_all_years: totalAll,
    as_of: selectedAsOf,
    latest_as_of: latestAsOf,
    sources,
    error: null,
  };
}

function directoryRegionDetail(directory, province) {
  const year = directory.selected_year;
  const key = year && province ? `${year}|${province.code}` : '';
  const set = key ? directory.by_year.get(key) : null;
  const count = set ? set.size : null;
  const sourceMap = key ? directory.source_sets.get(key) : null;
  const sources = sourceMap ? [...sourceMap.entries()].map(([sourceKey, keys]) => {
    const meta = directory.source_meta.get(sourceKey) || {};
    return {
      source_code: meta.source_code || null,
      source_url: meta.source_url || null,
      count: keys.size,
      as_of: directory.source_as_of.get(`${key}|${sourceKey}`) || null,
    };
  }).sort((a, b) => b.count - a.count || String(a.source_code || a.source_url).localeCompare(String(b.source_code || b.source_url))) : [];
  const sectors = [...(key ? directory.sector_sets.get(key) || [] : [])];
  // Explicit scope confirmations are separate from missing data and entity rows.
  let confirmations = [];
  try { confirmations = JSON.parse(getMeta(getDb(), 'cea_directory_coverage_confirmations') || '[]'); } catch { /* older metadata */ }
  if (!Array.isArray(confirmations)) confirmations = [];
  const notApplicable = confirmations.filter((c) => Number(c.list_year) === year
    && normalizeProvince(c.province)?.code === province.code
    && c.status === 'not_applicable' && NATIONAL_ETS_SECTORS.includes(c.sector)
    && !sectors.includes(c.sector));
  const missingSectors = NATIONAL_ETS_SECTORS.filter((s) => !sectors.includes(s)
    && !notApplicable.some((c) => c.sector === s));
  const asOf = key ? directory.as_of_by_year_province.get(key) || null : null;
  const entities = key
    ? (directory.entity_rows_by_year_province.get(key) || [])
      .slice()
      .sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'zh-CN'))
      .slice(0, 8)
    : [];
  const note = count === null || count === 0
    ? `本平台尚未收录该省 ${year || ''} 年名录；不补 0，不代表该省没有重点排放单位。`
    : `本平台已收录该省 ${year} 年名录 ${count} 家；`
      + (missingSectors.length
        ? `仅取得${sectors.length ? sectors.join('、') : '未标注'}行业名单；${missingSectors.join('、')}行业名单尚未取得；`
        : `已取得${sectors.join('、')}行业名单；`)
      + notApplicable.map((c) => `${c.sector}无企业（${c.basis === 'user_confirmed' ? '用户确认' : '来源确认'}）；`).join('')
      + '不代表全省或全国完整数量。';
  return {
    available: Boolean(year && count !== null),
    year,
    list_year: year,
    count,
    all_years_count: directory.all_years.get(province.code) || 0,
    sources,
    source_count: sources.length,
    sectors,
    missing_sectors: missingSectors,
    not_applicable_sectors: notApplicable,
    as_of: asOf,
    entities,
    entities_note: entities.length ? '以下为已收录名录中的真实企业，可进入企业档案；不是全省完整名单。' : null,
    province_label: province.name,
    coverage_note: note,
    note,
  };
}

/* ==================================================================== */
/*  五、排放数据集选择与记录                                              */
/* ==================================================================== */

function emissionAggregates(f) {
  const scope = f.metric;
  const metadataRows = all(
    `SELECT dataset_key, scope, source_name, source_kind, methodology, boundary,
            MIN(year) AS min_year, MAX(year) AS max_year,
            COUNT(*) AS records, COUNT(DISTINCT province_code) AS provinces,
            MAX(collected_at) AS latest_collected_at,
            MAX(COALESCE(published_at,'')) AS latest_published_at
     FROM region_emission
     WHERE scope = ? AND status = 'active'
     GROUP BY dataset_key, scope, source_name, source_kind, methodology, boundary
     ORDER BY dataset_key`,
    [scope]
  );
  if (!metadataRows.length) {
    return {
      available: false,
      scope,
      year: null,
      dataset: null,
      datasets: [],
      year_options: [],
      records: new Map(),
      coverage: null,
      source: null,
      message:
        `尚未入库${scope === 'region_co2' ? '区域 CO₂ 排放' : '全国碳市场纳管排放'}记录。`
        + '只显示有明确年度、单位、省份和原文证据的数据；不补 0，不生成演示热力。',
      warnings: [],
      quarantined_datasets: [],
      error: null,
    };
  }
  // 历史脏数据防线：同一个 dataset_key 只要出现不同来源/方法/边界，就整组隔离，
  // 不把重复 key 放进下拉框，更不把不同口径混进同一张热力图。
  const variantsByKey = new Map();
  for (const row of metadataRows) {
    if (!variantsByKey.has(row.dataset_key)) variantsByKey.set(row.dataset_key, []);
    variantsByKey.get(row.dataset_key).push(row);
  }
  const validKeys = new Set();
  const quarantined = [];
  for (const [key, variants] of variantsByKey.entries()) {
    if (new Set(variants.map((v) => JSON.stringify({
      source_name: v.source_name,
      source_kind: v.source_kind,
      methodology: v.methodology,
      boundary: v.boundary,
    }))).size > 1) {
      quarantined.push(key);
    } else {
      validKeys.add(key);
    }
  }
  const warnings = quarantined.map((key) => (
    `数据集「${key}」在历史记录中存在不同的来源名称/来源类型/核算方法/核算边界，已隔离并停止展示；`
    + '请管理员核查 region_emission 后按数据集版本改用不同的 dataset_key。'
  ));
  const datasetRows = metadataRows.filter((r) => validKeys.has(r.dataset_key));
  if (!datasetRows.length) {
    return {
      available: false,
      scope,
      year: null,
      dataset: null,
      datasets: [],
      year_options: [],
      records: new Map(),
      coverage: null,
      source: null,
      message: '现有排放数据集均存在口径冲突，已隔离；请管理员核查历史记录。',
      warnings,
      quarantined_datasets: quarantined,
      error: null,
    };
  }
  const yearRows = all(
    `SELECT dataset_key, year, province_code
     FROM region_emission
     WHERE scope = ? AND status = 'active'
     GROUP BY dataset_key, year, province_code`,
    [scope]
  ).filter((r) => validKeys.has(r.dataset_key));
  const byDatasetYearSets = new Map();
  const yearProvinceSets = new Map();
  for (const r of yearRows) {
    const year = Number(r.year);
    const key = `${r.dataset_key}|${year}`;
    if (!byDatasetYearSets.has(key)) byDatasetYearSets.set(key, new Set());
    byDatasetYearSets.get(key).add(String(r.province_code));
    if (!yearProvinceSets.has(year)) yearProvinceSets.set(year, new Set());
    yearProvinceSets.get(year).add(String(r.province_code));
  }
  const byDatasetYear = new Map([...byDatasetYearSets.entries()].map(([k, set]) => [k, set.size]));
  const yearCoverage = new Map([...yearProvinceSets.entries()].map(([y, set]) => [y, set.size]));
  const allYears = [...yearProvinceSets.keys()].sort((a, b) => b - a);
  const options = datasetRows.map((r) => {
    const years = yearRows
      .filter((y) => y.dataset_key === r.dataset_key)
      .map((y) => Number(y.year))
      .sort((a, b) => b - a);
    return {
      key: r.dataset_key,
      dataset_key: r.dataset_key,
      scope: r.scope,
      source_name: r.source_name,
      source_kind: r.source_kind,
      source_kind_label: sourceKindLabel(r.source_kind),
      methodology: r.methodology,
      boundary: r.boundary,
      years,
      min_year: Number(r.min_year),
      max_year: Number(r.max_year),
      province_count: Number(r.provinces) || 0,
      records: Number(r.records) || 0,
      latest_collected_at: r.latest_collected_at || null,
      latest_published_at: r.latest_published_at || null,
      coverage_by_year: Object.fromEntries(years.map((y) => [y, byDatasetYear.get(`${r.dataset_key}|${y}`) || 0])),
    };
  });

  // 选定年度：显式 year 优先；显式 dataset 但未给 year 时取该数据集覆盖最多的年度；
  // 都没有时选“覆盖省份最多”的年度（并列取较新年度），让默认地图尽量完整。
  let year = f.year;
  if (f.dataset && quarantined.includes(f.dataset)) {
    return {
      error: `数据集「${f.dataset}」存在口径冲突，已隔离`,
      message: '该数据集中的来源/方法/边界不一致，不能展示；请管理员核查历史记录。',
      status: 400,
      year_options: allYears,
      dataset_options: options.map((o) => o.dataset_key),
      warnings,
      quarantined_datasets: quarantined,
    };
  }
  if (f.dataset && !options.some((o) => o.dataset_key === f.dataset)) {
    return {
      error: `未知数据集：${f.dataset}`,
      message: '请从实际存在的数据集中选择。',
      status: 400,
      year_options: allYears,
      dataset_options: options.map((o) => o.dataset_key),
      warnings,
      quarantined_datasets: quarantined,
    };
  }
  if (!year && f.dataset) {
    const ds = options.find((o) => o.dataset_key === f.dataset);
    year = ds?.years.slice().sort(
      (a, b) => (ds.coverage_by_year[b] || 0) - (ds.coverage_by_year[a] || 0) || b - a
    )[0] ?? null;
  }
  if (!year) {
    const ranked = [...yearCoverage.entries()].sort(
      (a, b) => b[1] - a[1] || b[0] - a[0]
    );
    year = ranked[0]?.[0] ?? null;
  }
  let candidates = options.filter((o) => o.years.includes(year));
  if (f.dataset) candidates = candidates.filter((o) => o.dataset_key === f.dataset);
  if (!candidates.length) {
    return {
      error: f.dataset ? '所选数据集在该年度没有有效记录' : '该年度没有有效排放记录',
      message: '请从实际存在的数据年度/数据集中选择。',
      status: 400,
      year_options: allYears,
      dataset_options: options.map((o) => o.dataset_key),
      warnings,
      quarantined_datasets: quarantined,
    };
  }
  candidates.sort((a, b) => (
    (b.coverage_by_year[year] || 0) - (a.coverage_by_year[year] || 0)
    || (a.source_kind === 'official' ? 0 : 1) - (b.source_kind === 'official' ? 0 : 1)
    || String(b.latest_collected_at || '').localeCompare(String(a.latest_collected_at || ''))
    || a.dataset_key.localeCompare(b.dataset_key)
  ));
  const selected = candidates[0];
  const records = all(
    `SELECT * FROM region_emission
     WHERE scope = ? AND year = ? AND dataset_key = ? AND status = 'active'
     ORDER BY province_code`,
    [scope, year, selected.dataset_key]
  );
  const byCode = new Map();
  let asOf = null;
  let publishedLatest = null;
  for (const r of records) {
    const p = provinceByCode(r.province_code) || normalizeProvince(r.province_name);
    if (!p) continue;
    const row = { ...r, unit: 'tCO2' };
    byCode.set(p.code, row);
    const day = dateOnly(r.collected_at);
    if (day && (!asOf || day > asOf)) asOf = day;
    const pub = dateOnly(r.published_at);
    if (pub && (!publishedLatest || pub > publishedLatest)) publishedLatest = pub;
  }
  const datasetOptions = options
    .filter((o) => o.years.includes(year))
    .map((o) => ({ ...o, selected: o.dataset_key === selected.dataset_key }));
  const sourceRow = records.find((r) => safeHttpUrl(r.source_url)) || null;
  return {
    available: records.length > 0,
    scope,
    year,
    dataset: selected.dataset_key,
    datasets: datasetOptions,
    all_datasets: options,
    year_options: allYears,
    records: byCode,
    coverage: {
      as_of: asOf,
      published_latest: publishedLatest,
      method: selected.methodology,
      boundary: selected.boundary,
      source_name: selected.source_name,
      source_kind: selected.source_kind,
    },
    source: {
      dataset_key: selected.dataset_key,
      source_name: selected.source_name,
      source_url: safeHttpUrl(sourceRow?.source_url),
      source_kind: selected.source_kind,
      source_kind_label: sourceKindLabel(selected.source_kind),
      methodology: selected.methodology,
      boundary: selected.boundary,
      verification_status: 'source_recorded',
    },
    message: records.length
      ? null
      : '所选年度/数据集没有通过校验的有效排放记录；不补 0。',
    warnings,
    quarantined_datasets: quarantined,
    error: null,
  };
}

/* ==================================================================== */
/*  六、组装 API 响应                                                    */
/* ==================================================================== */

function sourceForEmission(row) {
  if (!row) return null;
  return {
    dataset_key: row.dataset_key,
    source_name: row.source_name || null,
    source_url: safeHttpUrl(row.source_url),
    source_kind: row.source_kind || null,
    source_kind_label: sourceKindLabel(row.source_kind),
    methodology: row.methodology || null,
    boundary: row.boundary || null,
    published_at: dateOnly(row.published_at),
    collected_at: row.collected_at || null,
    snapshot_hash: row.snapshot_hash || null,
    excerpt: row.excerpt || null,
    verification_status: row.verification_status || 'source_recorded',
    status: row.status || 'active',
  };
}

function sourceForProject(project) {
  return {
    ...CCER_PROJECT_SOURCE,
    collected_at: project.as_of,
    published_at: project.as_of,
  };
}

function mostCommonLabel(counts) {
  if (!counts || !counts.size) return null;
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]), 'zh-CN'))[0][0];
}

function buildNotes(metric, emission, directory, directoryCoverageNote = DIRECTORY_SCOPE_NOTE) {
  const notes = [
    '项目数按本平台已收录公开项目统计，按官方登记编号去重（缺失时按项目 ID），排除 demo 条目；'
      + '0 表示本系统未收录，不代表该省没有项目。',
    '阶段标记为并列标记；项目总数不按阶段相加。已登记减排量（tCO2e）不在本卡汇总：'
      + '批次口径一致性与去重无法证明时，不用业主预计量替代。',
    '省份选择只控制右侧详情与跳转，不改变全国底图；总览省份筛选在卡片上单独标注。',
    '未知省份单列，不按项目名称或城市名猜省份。',
  ];
  if (DIRECTORY_METRICS.includes(metric)) {
    notes.push(
      'CEA 纳管企业名录来自 cea_entity，按统一社会信用代码 + 名录年度去重；'
        + '未披露信用代码的条目按名称参与去重，同一主体多行业/多出处只计 1 家。',
      '未收录省份保持 null（灰色斜纹），不补 0；0 不表示该省真实没有重点排放单位。',
      '名录只表示本平台已收录的公开名单，不是企业排放量、配额缺口、买家数量或企业盈缺。',
      `名录年度:${directory?.selected_year ?? '未取得'}；名录采集截止日单独列示，不借用排放日期。`,
      directoryCoverageNote,
      '项目阶段/领域/方法学筛选只影响项目数，不改变名录企业数。',
    );
  }
  if (EMISSION_METRICS.includes(metric)) {
    notes.push(
      '排放底层值为 tCO2；万吨/亿吨是展示换算（1 亿吨 = 100,000,000 吨），不与 tCO2e 混算。',
      '同一省/范围/年度有多个来源口径时按数据集分列，不静默相加或覆盖；当前只展示所选数据集。',
      '排放未取得的省份保持 null（灰色斜纹），不补 0，不生成演示热力；不计算“排放 − CCER”净排放。',
      '“已披露合计”只是当前数据集覆盖省份的合计，不是全国排放总量。',
    );
    if (metric === 'national_ets') {
      notes.push(
        '全国碳市场名录按名录年度展示，同一企业跨年按统一社会信用代码/名称去重；'
          + '名录数量不代表已披露排放的覆盖率，也不等于买家数量或企业盈缺；地方试点数据不混入全国 CEA。',
      );
    }
    if (emission?.available === false) notes.push(emission.message);
    for (const warning of emission?.warnings || []) notes.push(warning);
  }
  return notes;
}

export function buildRegionMap(query = {}) {
  const v = validateRegionMapQuery(query);
  if (!v.ok) return v;
  const f = v.value;
  const memberError = validateFilterValues(f);
  if (memberError) return memberError;

  const isProject = PROJECT_METRICS.includes(f.metric);
  const isDirectory = DIRECTORY_METRICS.includes(f.metric);
  const isEmission = EMISSION_METRICS.includes(f.metric);
  const projects = projectAggregates(f);
  const directory = directoryAggregates(isDirectory ? f.list_year : null);
  if (isDirectory && directory.error) {
    return {
      ...directory,
      status: directory.status || 400,
      filters: f,
      list_year_options: directory.years || [],
      data_available: false,
    };
  }
  const emission = isEmission ? emissionAggregates(f) : null;
  if (emission?.error) {
    return {
      ...emission,
      filters: f,
      year_options: emission.year_options || [],
      dataset_options: emission.dataset_options || [],
    };
  }

  const meta = METRIC_META[f.metric];
  const projectSource = sourceForProject(projects);
  const directoryYear = isDirectory ? directory.selected_year : directory.latest_year;
  const directoryAsOf = isDirectory ? directory.as_of : directory.latest_as_of;
  const regions = regionCatalog().map((p) => {
    const pAgg = projects.byCode.get(p.code);
    const projValue = isProject ? pAgg[meta.value_key] : null;
    let value = null;
    let display = '—';
    let missing = false;
    let emissionRow = null;
    let source = null;
    const dirDetail = directoryRegionDetail(directory, p);
    if (isProject) {
      value = Number(projValue);
      display = formatProjectCount(value);
      missing = false;
      source = projectSource;
    } else if (isDirectory) {
      value = dirDetail.count;
      display = value === null ? '未收录' : formatEntityCount(value);
      missing = value === null;
      source = dirDetail.sources.length ? {
        source_name: `公开名录及补充原件（${dirDetail.sources.length} 份）`,
        source_url: dirDetail.sources[0]?.source_url || null,
        source_kind: 'platform',
        source_kind_label: '公开名录（含确认转载及上传原件）',
        methodology: '按统一社会信用代码 + 名录年度去重',
        boundary: '本平台已收录，非全国/全省完整数量',
        verification_status: 'source_recorded',
        excerpt: dirDetail.coverage_note,
      } : null;
    } else {
      emissionRow = emission.records.get(p.code) || null;
      if (emissionRow && emissionRow.value_tco2 !== null && emissionRow.value_tco2 !== undefined) {
        value = Number(emissionRow.value_tco2);
        display = formatTco2(value);
        missing = false;
        source = sourceForEmission(emissionRow);
      } else {
        value = null;
        display = '未取得';
        missing = true;
        source = null;
      }
    }
    const directoryCountForView = isDirectory
      ? dirDetail.count
      : (dirDetail.available ? (dirDetail.count || 0) : null);
    const projectProvinceLabel = mostCommonLabel(projects.labelCounts.get(p.code));
    return {
      code: p.code,
      name: p.name,
      short_name: p.short_name,
      group: p.group,
      project_province_label: projectProvinceLabel,
      value,
      display,
      unit: meta.unit,
      missing,
      zero: value === 0,
      project_count: pAgg.project_count,
      registered_count: pAgg.registered_count,
      reduction_registered_count: pAgg.reduction_registered_count,
      ets_directory: {
        available: isDirectory
          ? dirDetail.available
          : Boolean(directory.available && directoryYear),
        year: directoryYear,
        count: directoryCountForView,
        all_years_count: directory.available ? (directory.all_years.get(p.code) || 0) : null,
        province_label: p.name,
        sources: dirDetail.sources,
        source_count: dirDetail.source_count,
        sectors: dirDetail.sectors,
        missing_sectors: dirDetail.missing_sectors,
        as_of: dirDetail.as_of,
        coverage_note: dirDetail.coverage_note,
      },
      directory: {
        ...dirDetail,
        list_year: directoryYear,
      },
      emission: emissionRow ? {
        value_tco2: Number(emissionRow.value_tco2),
        display: formatTco2(emissionRow.value_tco2),
        year: Number(emissionRow.year),
        unit: 'tCO2',
        scope: emissionRow.scope,
        dataset_key: emissionRow.dataset_key,
        methodology: emissionRow.methodology,
        boundary: emissionRow.boundary,
        source: sourceForEmission(emissionRow),
      } : null,
      samples: pAgg.samples,
      source,
    };
  });

  const directoryGapNotes = regions
    .filter((r) => r.directory?.sectors?.length && r.directory?.missing_sectors?.length)
    .map((r) => `${r.name}仅取得${r.directory.sectors.join('、')}行业名单`)
    .slice(0, 8);
  const directoryCoverageNote = `${DIRECTORY_SCOPE_NOTE}`
    + (directoryGapNotes.length ? `当前明确缺口：${directoryGapNotes.join('；')}。` : '');
  const covered = regions.filter((r) => !r.missing);
  const missingRegions = regions.filter((r) => r.missing).length;
  const total = covered.length ? covered.reduce((s, r) => s + Number(r.value || 0), 0) : null;
  const projectTotal = isProject
    ? regions.reduce((s, r) => s + Number(r[meta.value_key] || 0), 0)
    : null;
  const unknownProjects = projects.unknown.reduce((s, u) => s + u.project_count, 0);
  const totalValue = isProject ? projectTotal : total;
  const directoryTotal = directory.available
    ? (isDirectory ? directory.total_selected_year : directory.total_latest_year)
    : null;
  const directoryCovered = regions.filter((r) => Number(r.directory?.count) > 0).length;
  const unknownDirectory = isDirectory
    ? (directory.selected_unknown || [])
    : (directory.unknown || []);
  const directorySourceSummary = {
    source_name: '公开名录及补充原件（逐条保留原始来源）',
    source_url: directory.sources?.[0]?.source_url || null,
    source_kind: 'platform',
    source_kind_label: '公开名录（含确认转载及上传原件）',
    verification_status: 'source_recorded',
    data_as_of: directoryAsOf,
    source_count: directory.sources?.length || 0,
    sources: directory.sources || [],
    excerpt: directoryCoverageNote,
  };
  const filtersNote = isDirectory
    ? '项目阶段/领域/方法学筛选只影响项目统计，不改变名录企业数。'
    : isEmission
      ? '项目筛选（阶段/领域/方法学）只作用于项目数与名录联动，不改变已入库的排放记录口径。'
      : '筛选条件已传递到公开项目统计。';

  return {
    metric: f.metric,
    metric_label: meta.label,
    view: meta.view,
    scope: meta.scope,
    unit: meta.unit,
    year: isEmission ? emission.year : null,
    year_options: isEmission ? (emission.year_options || []) : [],
    list_year: directoryYear,
    list_year_options: directory.years || [],
    dataset: isEmission ? emission.dataset : null,
    dataset_options: isEmission ? (emission.datasets || []) : [],
    region: f.region,
    filters: {
      domain: f.domain,
      methodology_id: f.methodology_id,
      stage: f.stage,
      note: filtersNote,
    },
    views: VIEWS,
    submetrics: SUBMETRICS,
    data_available: isProject ? true : (isDirectory ? Boolean(directory.available) : Boolean(emission.available)),
    message: isProject
      ? null
      : isDirectory
        ? (directory.available ? null : '尚未收录 CEA 纳管企业名录；不补 0，不生成演示热力。')
        : emission.message,
    regions,
    unknown: {
      projects: {
        count: unknownProjects,
        items: projects.unknown,
        note: unknownProjects
          ? '这些项目的省份文本无法归并为省级行政区（或未标注），未计入 34 地区，也不按项目名称猜测。'
          : null,
      },
      directory: {
        count: unknownDirectory.reduce((s, u) => s + u.count, 0),
        items: unknownDirectory,
        note: unknownDirectory.length
          ? '这些名录按原辖区单列，未计入34省级地区底图；新疆生产建设兵团不强行合并到新疆自治区。'
          : null,
      },
    },
    totals: {
      regions: 34,
      covered_regions: covered.length,
      missing_regions: missingRegions,
      value: totalValue,
      display: isProject
        ? formatProjectCount(totalValue)
        : isDirectory
          ? formatEntityCount(totalValue)
          : (totalValue === null ? '—' : formatTco2(totalValue)),
      label: isProject
        ? `本系统已收录${meta.label}合计（34 地区）`
        : isDirectory
          ? `本平台已收录名录合计（${covered.length}/34 省，非全国/全省完整数量）`
          : `已披露合计（${covered.length}/34 省，非全国排放总量）`,
      project_count: regions.reduce((s, r) => s + r.project_count, 0),
      registered_count: regions.reduce((s, r) => s + r.registered_count, 0),
      reduction_registered_count: regions.reduce((s, r) => s + r.reduction_registered_count, 0),
      unknown_projects: unknownProjects,
      directory_total: directoryTotal,
      directory_year: directoryYear,
      directory_total_all_years: directory.available ? directory.total_all_years : null,
      directory_covered_regions: directoryCovered,
    },
    coverage: {
      // 排放截至只来自排放记录；名录采集日期单独放在 directory_as_of，不互相借用。
      as_of: isProject
        ? projects.as_of
        : isDirectory
          ? directoryAsOf
          : (emission.coverage?.as_of || null),
      project_as_of: projects.as_of,
      emission_as_of: isEmission ? (emission.coverage?.as_of || null) : null,
      emission_published_latest: isEmission ? (emission.coverage?.published_latest || null) : null,
      directory_as_of: directoryAsOf,
      project_scope: CCER_PROJECT_SOURCE.boundary,
      emission_scope: isEmission && emission.coverage
        ? `${sourceKindLabel(emission.coverage.source_kind)}｜${emission.coverage.method}｜${emission.coverage.boundary}`
        : '未取得排放记录',
      directory_scope: isDirectory
        ? `CEA 纳管企业名录（名录 ${directoryYear ?? '年度未取得'} 年）；${directoryCoverageNote}`
        : '全国碳市场重点排放单位名录（按名录年度展示）',
      directory_years: directory.years,
      directory_available: directory.available,
    },
    source: isProject ? projectSource : (isDirectory ? directorySourceSummary : emission.source),
    directory_source: directorySourceSummary,
    directory_summary: {
      available: directory.available,
      list_year: directoryYear,
      list_year_options: directory.years || [],
      total: directoryTotal,
      covered_regions: directoryCovered,
      as_of: directoryAsOf,
      source_count: directory.sources?.length || 0,
      coverage_note: directoryCoverageNote,
    },
    notes: buildNotes(f.metric, emission, directory, directoryCoverageNote),
    admin_alerts: emission?.warnings || [],
    data_quality: {
      province_conflicts: projects.province_conflicts,
      project_dedupe: '官方登记编号优先，缺失时按项目 ID；演示条目排除',
      quarantined_datasets: emission?.quarantined_datasets || [],
      registered_reduction_amount: null,
      registered_reduction_note:
        '登记减排量合计（tCO2e）未提供：现有批次字段不足以证明口径一致且无重复，不用业主预计量替代。',
      emissions_missing_policy: 'null；不补 0，不做演示热力',
      directory_policy: '按统一社会信用代码 + 名录年度去重；未收录为 null；跨年不累加',
    },
    generated_at: nowIso(),
  };
}

/* ==================================================================== */
/*  七、导出（与页面同源）                                               */
/* ==================================================================== */

export const EXPORT_COLUMNS = [
  { key: 'province', label: '省份' },
  { key: 'province_code', label: '省份代码' },
  { key: 'region_group', label: '区域分组' },
  { key: 'metric', label: '指标键' },
  { key: 'metric_label', label: '指标' },
  { key: 'value', label: '数值', align: 'right' },
  { key: 'unit', label: '单位' },
  { key: 'year', label: '年度', align: 'right' },
  { key: 'scope', label: '范围', definition: 'ccer_project=公开项目；region_co2=区域 CO₂；national_ets=全国碳市场纳管排放；cea_entity=CEA 纳管企业名录' },
  { key: 'method', label: '核算方法' },
  { key: 'boundary', label: '核算边界' },
  { key: 'source_url', label: '来源链接' },
  { key: 'source_name', label: '来源名称' },
  { key: 'source_kind', label: '来源类型', definition: 'official=官方；research=研究核算；platform=平台聚合' },
  { key: 'verification_status', label: '来源记录状态', definition: 'source_recorded=已记录来源，尚未独立核实；不代表官方确认' },
  { key: 'excerpt', label: '原文证据' },
  { key: 'published_at', label: '来源发布日' },
  { key: 'collected_at', label: '入库时间' },
  { key: 'as_of', label: '数据截至' },
  { key: 'missing', label: '缺失标记', definition: '1=未取得；0=有记录（含真实 0）' },
  { key: 'missing_reason', label: '缺失原因' },
  { key: 'dataset_key', label: '数据集' },
  { key: 'ets_directory_year', label: '名录年度', align: 'right' },
  { key: 'ets_directory_count', label: '名录数量（本系统收录）', align: 'right' },
  { key: 'ets_directory_note', label: '名录覆盖说明' },
  { key: 'ets_source_urls', label: '名录出处链接（全部）' },
  { key: 'ets_source_codes', label: '名录出处代码（全部）' },
  { key: 'ets_source_count', label: '名录出处份数', align: 'right' },
  { key: 'ets_sectors', label: '已取得行业' },
  { key: 'ets_missing_sectors', label: '尚未取得行业' },
  { key: 'ets_coverage_note', label: '名录覆盖说明（详细）' },
  { key: 'project_count', label: '公开项目数', align: 'right' },
  { key: 'registered_count', label: '项目登记数', align: 'right' },
  { key: 'reduction_registered_count', label: '减排量登记项目数', align: 'right' },
  { key: 'note', label: '备注' },
];

export function buildRegionMapExport(query = {}) {
  const v = validateRegionMapQuery(query, { allowFormat: true });
  if (!v.ok) return v;
  const viewQuery = { ...query };
  delete viewQuery.format;
  const view = buildRegionMap(viewQuery);
  if (view.error) return view;
  const f = v.value;
  const isDirectory = DIRECTORY_METRICS.includes(f.metric);
  const rows = [];
  const selectedRegions = f.region
    ? view.regions.filter((r) => r.group === f.region)
    : view.regions;
  for (const region of selectedRegions) {
    const e = region.emission;
    const dir = region.directory || region.ets_directory || {};
    const dirSources = Array.isArray(dir.sources) ? dir.sources : [];
    const dirUrls = dirSources.map((s) => s.source_url).filter(Boolean);
    const dirCodes = dirSources.map((s) => s.source_code).filter(Boolean);
    const src = isDirectory
      ? region.source
      : (e?.source || (region.missing ? null : region.source) || null);
    const dirNote = dir.coverage_note || (dir.available
      ? (Number(dir.count) > 0
        ? '本系统已收录该省名录条数，不代表该省实际重点排放单位总数'
        : '本系统未收录该省名录，不代表真实没有重点排放单位')
      : '本系统未取得该省名录');
    const dirCountForExport = isDirectory
      ? dir.count
      : (region.ets_directory?.count ?? null);
    const rowAsOf = isDirectory
      ? (dir.as_of || view.coverage.directory_as_of || '')
      : PROJECT_METRICS.includes(f.metric)
        ? (view.coverage.project_as_of || '')
        : (e ? (dateOnly(e.collected_at) || '') : '');
    const missingReason = isDirectory
      ? `本平台未收录该省 ${dir.year ?? ''} 年名录；不补 0`
      : (view.metric === 'national_ets' ? '未取得该省纳管排放记录' : '未取得该省排放记录');
    rows.push({
      province: region.name,
      province_code: region.code,
      region_group: region.group,
      metric: view.metric,
      metric_label: view.metric_label,
      value: region.value,
      unit: view.unit,
      year: isDirectory ? '' : view.year,
      scope: view.scope,
      method: isDirectory
        ? '按统一社会信用代码 + 名录年度去重'
        : (e?.methodology || src?.methodology || view.source?.methodology || ''),
      boundary: isDirectory
        ? '本平台已收录，非全国/全省完整数量'
        : (e?.boundary || src?.boundary || view.source?.boundary || ''),
      source_url: isDirectory
        ? (dirUrls[0] || '')
        : (src?.source_url || ''),
      source_name: isDirectory
        ? (dirSources.length ? `省级生态环境主管部门公开名录（${dirSources.length} 份）` : '')
        : (src?.source_name || ''),
      source_kind: isDirectory ? (dirSources.length ? 'official' : '') : (src?.source_kind || ''),
      verification_status: isDirectory
        ? (dirSources.length ? 'source_recorded' : '')
        : (src?.verification_status || ''),
      excerpt: isDirectory ? dirNote : (src?.excerpt || ''),
      published_at: isDirectory ? '' : (src?.published_at || ''),
      collected_at: isDirectory ? (dir.as_of || '') : (src?.collected_at || ''),
      as_of: rowAsOf,
      missing: region.missing ? 1 : 0,
      missing_reason: region.missing ? missingReason : '',
      dataset_key: isDirectory ? '' : (view.dataset || ''),
      ets_directory_year: dir.year ?? '',
      ets_directory_count: dirCountForExport ?? '',
      ets_directory_note: dirNote,
      ets_source_urls: dirUrls.join(' | '),
      ets_source_codes: dirCodes.join(' | '),
      ets_source_count: dirSources.length,
      ets_sectors: (dir.sectors || []).join('、'),
      ets_missing_sectors: (dir.missing_sectors || []).join('、'),
      ets_coverage_note: dir.coverage_note || '',
      project_count: region.project_count,
      registered_count: region.registered_count,
      reduction_registered_count: region.reduction_registered_count,
      note: isDirectory
        ? (region.missing
          ? `该省 ${dir.year ?? ''} 年名录未收录；0 不代表真实没有企业；名录采集截止日 ${dir.as_of || '未取得'}`
          : `本平台已收录 ${dir.count} 家；${dir.coverage_note || ''}`)
        : (region.missing
          ? '该省无排放记录；数据截至不借用名录日期；数据集级口径见 dataset_key'
          : (region.value === 0 ? '真实 0，不是缺失' : '')),
    });
  }
  // 未知省份项目单列，保留与 API 相同的口径；按区域筛选时不混入任何分组。
  if (!f.region && PROJECT_METRICS.includes(f.metric)) {
    for (const item of view.unknown.projects.items) {
      rows.push({
        province: item.province === '未标注省份' ? '未标注省份' : `未知：${item.province}`,
        province_code: 'UNKNOWN',
        region_group: '',
        metric: view.metric,
        metric_label: view.metric_label,
        value: METRIC_META[f.metric].value_key === 'registered_count'
          ? item.registered_count
          : METRIC_META[f.metric].value_key === 'reduction_registered_count'
            ? item.reduction_registered_count
            : item.project_count,
        unit: view.unit,
        year: '',
        scope: 'ccer_project',
        method: CCER_PROJECT_SOURCE.methodology,
        boundary: CCER_PROJECT_SOURCE.boundary,
        source_url: CCER_PROJECT_SOURCE.source_url,
        source_name: CCER_PROJECT_SOURCE.source_name,
        source_kind: 'platform',
        verification_status: CCER_PROJECT_SOURCE.verification_status,
        excerpt: CCER_PROJECT_SOURCE.excerpt,
        published_at: '',
        collected_at: view.coverage.project_as_of || '',
        as_of: view.coverage.project_as_of || '',
        missing: 0,
        missing_reason: '',
        dataset_key: '',
        ets_directory_year: '',
        ets_directory_count: '',
        ets_directory_note: '',
        ets_source_urls: '',
        ets_source_codes: '',
        ets_source_count: '',
        ets_sectors: '',
        ets_missing_sectors: '',
        ets_coverage_note: '',
        project_count: item.project_count,
        registered_count: item.registered_count,
        reduction_registered_count: item.reduction_registered_count,
        note: '省份未识别，未计入 34 地区',
      });
    }
  }
  const meta = {
    数据集: '省域地图',
    数据截至: isDirectory
      ? (view.coverage.directory_as_of || '名录采集日期未取得')
      : view.scope === 'ccer_project'
        ? (view.coverage.project_as_of || '（见各行字段）')
        : (view.coverage.emission_as_of || '排放未取得（不借用名录日期）'),
    项目快照截至: view.coverage.project_as_of || '未取得',
    名录采集日期: view.coverage.directory_as_of || '未取得',
    指标: view.metric_label,
    年度: isDirectory
      ? (view.list_year ?? '名录年度未取得')
      : view.scope === 'ccer_project'
        ? '当前收录快照（项目指标）'
        : (view.year ?? '年度未取得'),
    分组: f.region || '全国 34 地区',
    统计口径: isDirectory
      ? view.coverage.directory_scope
      : view.scope === 'ccer_project'
        ? view.coverage.project_scope
        : view.coverage.emission_scope,
    来源: isDirectory
      ? `公开名录及补充原件（${view.directory_summary?.source_count ?? 0} 份，含确认转载）`
      : (view.source?.source_name || '本平台公开项目库'),
    说明: [
      ...view.notes,
      isDirectory
        ? '名录按统一社会信用代码 + 名录年度去重；未收录为 null，不补 0；名录数量不是排放量，也不代表全国/全省完整数量。'
        : view.scope === 'ccer_project'
          ? '公开项目为当前收录快照，不与历史排放年度混用；项目总数按登记号去重、阶段取并集。'
          : '排放截至仅来自排放记录；名录采集日期单独列示。名录数量只表示本系统已收录，不代表该省实际重点排放单位总数。',
    ].join('；'),
  };
  return {
    ok: true,
    view,
    columns: EXPORT_COLUMNS,
    rows,
    meta,
    dataset: '省域地图',
    fileBase: isDirectory
      ? `region_map_${view.metric}_${view.list_year ?? 'unknown'}`
      : `region_map_${view.metric}`,
  };
}

/* ==================================================================== */
/*  八、导入校验与幂等写入                                                */
/* ==================================================================== */

function parseFiniteNumber(v) {
  if (v === null || v === undefined || v === '') return { error: '数值为空' };
  if (typeof v === 'number') {
    return Number.isFinite(v) ? { value: v } : { error: '数值必须是有限数' };
  }
  if (typeof v !== 'string') return { error: '数值必须是数字或数字字符串' };
  const s = v.replace(/[,，\s]/g, '');
  if (!s) return { error: '数值为空' };
  const n = Number(s);
  return Number.isFinite(n) ? { value: n } : { error: '数值必须是有限数' };
}

function validIsoDateTime(s) {
  if (!s) return null;
  const t = Date.parse(s);
  if (Number.isNaN(t)) return null;
  if (t > Date.now() + 86400000) return null;
  return new Date(t).toISOString();
}

function sourceKeyHash(v) {
  return createHash('sha256').update(JSON.stringify({
    province_code: v.province_code,
    scope: v.scope,
    year: v.year,
    value_tco2: v.value_tco2,
    unit: v.unit,
    methodology: v.methodology,
    boundary: v.boundary,
    dataset_key: v.dataset_key,
    source_name: v.source_name,
    source_url: v.source_url,
    source_kind: v.source_kind,
    published_at: v.published_at,
    excerpt: v.excerpt,
    snapshot_hash: v.snapshot_hash,
  })).digest('hex');
}

/** 导入单条记录校验；不写库，不把管理员录入自动升格为官方核实。 */
export function validateImportRecord(raw = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: '记录必须是对象' };
  }
  for (const key of Object.keys(raw)) {
    if (!IMPORT_KEYS.has(key)) return { ok: false, error: `未知字段：${key}` };
  }
  const provinceText = textValue(raw.province);
  const codeText = textValue(raw.province_code);
  const nameText = textValue(raw.province_name);
  let province = null;
  if (codeText) {
    province = provinceByCode(codeText);
    if (!province) return { ok: false, error: `未知 province_code：${codeText}` };
  }
  if (nameText) {
    const byName = normalizeProvince(nameText);
    if (!byName) return { ok: false, error: `未知 province_name：${nameText}` };
    if (province && province.code !== byName.code) {
      return { ok: false, error: 'province_code 与 province_name 不一致' };
    }
    province = byName;
  }
  if (provinceText) {
    const byText = /^\d{6}$/.test(provinceText)
      ? provinceByCode(provinceText)
      : normalizeProvince(provinceText);
    if (!byText) return { ok: false, error: `无法识别省份：${provinceText}` };
    if (province && province.code !== byText.code) {
      return { ok: false, error: 'province 与代码/全称不一致' };
    }
    province = byText;
  }
  if (!province) return { ok: false, error: '缺少可识别的 province / province_code' };

  const scope = textValue(raw.scope);
  if (!['region_co2', 'national_ets'].includes(scope)) {
    return { ok: false, error: 'scope 必须是 region_co2 或 national_ets' };
  }
  const yearParsed = parseFiniteNumber(raw.year);
  if (yearParsed.error || !Number.isInteger(yearParsed.value)
    || yearParsed.value < 1990 || yearParsed.value > CURRENT_YEAR) {
    return { ok: false, error: `year 必须是 1990–${CURRENT_YEAR} 的整数` };
  }
  const year = yearParsed.value;
  const valueParsed = parseFiniteNumber(raw.value_tco2);
  if (valueParsed.error) return { ok: false, error: `value_tco2：${valueParsed.error}` };
  if (valueParsed.value < 0) return { ok: false, error: 'value_tco2 不能为负数' };
  if (valueParsed.value > MAX_VALUE_TCO2) return { ok: false, error: 'value_tco2 超出合理范围' };
  const unit = (textValue(raw.unit) || '').replace(/\s+/g, '');
  if (!/^tco2$/i.test(unit)) {
    return { ok: false, error: 'unit 必须为 tCO2；不接受 tCO2e、万吨或亿吨等混合单位' };
  }
  const methodology = shortText(raw.methodology, 300);
  if (!methodology || methodology.length < 2 || CONTROL_RE.test(methodology)) {
    return { ok: false, error: 'methodology 必须是 2–300 字的核算方法/清单名称' };
  }
  const boundary = shortText(raw.boundary, 300);
  if (!boundary || boundary.length < 2 || CONTROL_RE.test(boundary)) {
    return { ok: false, error: 'boundary 必须是 2–300 字的核算边界' };
  }
  const datasetKey = shortText(raw.dataset_key, 80);
  if (!datasetKey || !/^[a-z0-9][a-z0-9._-]{2,80}$/i.test(datasetKey)) {
    return { ok: false, error: 'dataset_key 必须是 3–80 位字母、数字、点、下划线或连字符' };
  }
  const sourceName = shortText(raw.source_name, 200);
  if (!sourceName || sourceName.length < 2 || CONTROL_RE.test(sourceName)) {
    return { ok: false, error: 'source_name 必须是 2–200 字的来源名称' };
  }
  const sourceKind = textValue(raw.source_kind);
  if (!['official', 'research'].includes(sourceKind)) {
    return { ok: false, error: 'source_kind 必须是 official 或 research' };
  }
  const urlCheck = validateSourceUrl(raw.source_url, sourceKind);
  if (!urlCheck.ok) return { ok: false, error: urlCheck.error };
  const publishedAt = textValue(raw.published_at);
  if (publishedAt) {
    if (!isValidCalendarDate(publishedAt)) {
      return { ok: false, error: 'published_at 必须是真实的 YYYY-MM-DD 日历日期' };
    }
    if (publishedAt > todayCst()) return { ok: false, error: 'published_at 不能是未来日期' };
  }
  const excerpt = shortText(raw.excerpt, 2000);
  if (!excerpt || excerpt.length < 12) {
    return { ok: false, error: 'excerpt 必须提供至少 12 字的原文证据' };
  }
  if (!/(CO2|二氧化碳|排放|万吨|亿吨|tCO2)/i.test(excerpt)) {
    return { ok: false, error: 'excerpt 必须包含排放/CO₂/单位等可核对证据关键词' };
  }
  const snapshotHash = textValue(raw.snapshot_hash);
  if (snapshotHash && !/^[a-f0-9]{8,128}$/i.test(snapshotHash)) {
    return { ok: false, error: 'snapshot_hash 必须是 8–128 位十六进制' };
  }
  const collectedAtRaw = textValue(raw.collected_at);
  const collectedAt = collectedAtRaw ? validIsoDateTime(collectedAtRaw) : nowIso();
  if (!collectedAt) return { ok: false, error: 'collected_at 不是有效时间或超出当前时间' };

  const value = {
    province_code: province.code,
    province_name: province.name,
    scope,
    year,
    value_tco2: valueParsed.value,
    unit: 'tCO2',
    methodology,
    boundary,
    dataset_key: datasetKey,
    source_name: sourceName,
    source_url: urlCheck.url,
    source_kind: sourceKind,
    published_at: publishedAt || null,
    excerpt: excerpt.replace(/\s+/g, ' '),
    snapshot_hash: snapshotHash || null,
    collected_at: collectedAt,
  };
  value.content_hash = sourceKeyHash(value);
  return { ok: true, value };
}

/**
 * 幂等导入：内容相同跳过；内容变化时旧行标记 superseded，新行写入 revision_of。
 * @returns {{ok:boolean,total:number,inserted:number,revised:number,unchanged:number,errors:Array}}
 */
export function importRegionRecords(records, { actor = 'cli', dryRun = false } = {}) {
  if (!Array.isArray(records)) {
    return { ok: false, error: '导入内容必须是记录数组', total: 0, inserted: 0, revised: 0, unchanged: 0, errors: [] };
  }
  if (records.length === 0) {
    return { ok: false, error: '导入内容为空', total: 0, inserted: 0, revised: 0, unchanged: 0, errors: [] };
  }
  if (records.length > MAX_IMPORT_ROWS) {
    return {
      ok: false, error: `单次最多导入 ${MAX_IMPORT_ROWS} 条`,
      total: records.length, inserted: 0, revised: 0, unchanged: 0, errors: [],
    };
  }
  const valid = [];
  const errors = [];
  records.forEach((raw, i) => {
    const checked = validateImportRecord(raw);
    if (!checked.ok) {
      errors.push({ row: Number(raw?.__row) || i + 1, error: checked.error });
    } else {
      checked.value.__row = Number(raw?.__row) || i + 1;
      valid.push(checked.value);
    }
  });
  if (errors.length) {
    return {
      ok: false, error: '存在未通过校验的记录，本次未写入任何数据',
      total: records.length, inserted: 0, revised: 0, unchanged: 0, errors: errors.slice(0, 50),
    };
  }
  // 同一 dataset_key + scope 的元数据必须一致；否则同一数据集内会混入不同边界/来源类型。
  const metaErrors = [];
  const batchMeta = new Map();
  for (const v of valid) {
    const batchKey = `${v.scope}|${v.dataset_key}`;
    const inBatch = batchMeta.get(batchKey);
    const differsFromBatch = inBatch && (
      inBatch.source_name !== v.source_name
      || inBatch.source_kind !== v.source_kind
      || inBatch.methodology !== v.methodology
      || inBatch.boundary !== v.boundary
    );
    if (differsFromBatch) {
      metaErrors.push({
        row: v.__row,
        error: `同一批次内 dataset_key「${v.dataset_key}」的来源/方法/边界不一致，不能混算`,
      });
      continue;
    }
    if (!inBatch) batchMeta.set(batchKey, v);
    // 必须检查全部 active 行，而不是只取一条：历史脏数据可能已经混入同 key。
    const existingRows = all(
      `SELECT DISTINCT source_name, source_kind, methodology, boundary
       FROM region_emission
       WHERE dataset_key = ? AND scope = ? AND status = 'active'`,
      [v.dataset_key, v.scope]
    );
    if (!existingRows.length) continue;
    const differs = existingRows.some((existing) => (
      existing.source_name !== v.source_name
      || existing.source_kind !== v.source_kind
      || existing.methodology !== v.methodology
      || existing.boundary !== v.boundary
    ));
    if (differs) {
      metaErrors.push({
        row: v.__row,
        error: `dataset_key「${v.dataset_key}」已有不同的来源/方法/边界，不能在同一数据集内混算；请换 dataset_key 或先确认口径一致`,
      });
    }
  }
  if (metaErrors.length) {
    return {
      ok: false, error: '数据集口径不一致，本次未写入任何数据',
      total: records.length, inserted: 0, revised: 0, unchanged: 0, errors: metaErrors.slice(0, 50),
    };
  }
  if (dryRun) {
    return {
      ok: true, dry_run: true, total: records.length, valid: valid.length,
      inserted: 0, revised: 0, unchanged: 0, errors: [],
    };
  }

  let inserted = 0;
  let revised = 0;
  let unchanged = 0;
  const ids = [];
  try {
    tx(() => {
      for (const v of valid) {
        const last = get(
          `SELECT * FROM region_emission
           WHERE province_code = ? AND scope = ? AND year = ? AND dataset_key = ?
           ORDER BY CASE WHEN status = 'active' THEN 0 ELSE 1 END,
                    created_at DESC, id DESC
           LIMIT 1`,
          [v.province_code, v.scope, v.year, v.dataset_key]
        );
        const active = last && last.status === 'active' ? last : null;
        if (active && active.content_hash === v.content_hash) {
          unchanged += 1;
          continue;
        }
        const now = nowIso();
        const id = newId('REM');
        if (active) {
          const upd = run(
            `UPDATE region_emission
             SET status = 'superseded', superseded_by = ?, superseded_at = ?, updated_at = ?
             WHERE id = ? AND status = 'active'`,
            [id, now, now, active.id]
          );
          if (Number(upd?.changes) !== 1) {
            throw new Error(`修订旧记录失败：${active.id}`);
          }
          revised += 1;
        }
        run(
          `INSERT INTO region_emission
           (id, province_code, province_name, scope, year, value_tco2, unit, methodology,
            boundary, dataset_key, source_name, source_url, source_kind, published_at,
            excerpt, snapshot_hash, content_hash, verification_status, status, revision_of,
            revision_reason, superseded_by, superseded_at, entered_by, collected_at,
            created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            id, v.province_code, v.province_name, v.scope, v.year, v.value_tco2, v.unit,
            v.methodology, v.boundary, v.dataset_key, v.source_name, v.source_url,
            v.source_kind, v.published_at, v.excerpt, v.snapshot_hash, v.content_hash,
            'source_recorded', 'active', active?.id || last?.id || null,
            active ? 'source_or_value_changed' : (last ? 'reimport_after_superseded' : 'initial_import'),
            null, null, actor, v.collected_at, now, now,
          ]
        );
        inserted += 1;
        ids.push(id);
      }
    });
  } catch (e) {
    return {
      ok: false, error: e.message, total: records.length,
      inserted: 0, revised: 0, unchanged: 0, errors: [],
    };
  }
  try {
    audit({
      actor,
      actorRole: 'cli',
      action: 'region_emission.import',
      objectType: 'region_emission',
      objectId: valid.map((v) => v.dataset_key).filter((v, i, a) => a.indexOf(v) === i).join(','),
      detail: {
        total: records.length, inserted, revised, unchanged,
        datasets: [...new Set(valid.map((v) => v.dataset_key))],
        years: [...new Set(valid.map((v) => v.year))].sort(),
      },
    });
  } catch {
    /* 审计失败不阻断已完成的导入；CLI 会打印汇总 */
  }
  return {
    ok: true, total: records.length, inserted, revised, unchanged,
    ids, errors: [],
  };
}

/** 极简 CSV 解析（支持双引号、逗号、CRLF 与 BOM）；仅用于 CLI 导入。 */
export function parseCsv(text) {
  const src = String(text || '').replace(/^\uFEFF/, '');
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { cell += '"'; i += 1; } else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === ',') { row.push(cell); cell = ''; continue; }
    if (ch === '\r') continue;
    if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; continue; }
    cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => String(c).trim() !== ''));
}

const CSV_HEADER_ALIASES = {
  province: 'province', '省份': 'province', '省': 'province', '省份名称': 'province',
  province_code: 'province_code', '省份代码': 'province_code',
  province_name: 'province_name', '省份全称': 'province_name',
  scope: 'scope', '范围': 'scope',
  year: 'year', '年度': 'year',
  value_tco2: 'value_tco2', '排放量': 'value_tco2', 'value': 'value_tco2',
  unit: 'unit', '单位': 'unit',
  methodology: 'methodology', '核算方法': 'methodology',
  boundary: 'boundary', '边界': 'boundary', '核算边界': 'boundary',
  dataset_key: 'dataset_key', '数据集': 'dataset_key',
  source_name: 'source_name', '来源名称': 'source_name',
  source_url: 'source_url', '来源链接': 'source_url',
  source_kind: 'source_kind', '来源类型': 'source_kind',
  published_at: 'published_at', '发布日期': 'published_at', '来源发布日': 'published_at',
  excerpt: 'excerpt', '原文证据': 'excerpt',
  snapshot_hash: 'snapshot_hash', '快照哈希': 'snapshot_hash',
  collected_at: 'collected_at', '入库时间': 'collected_at',
};

export function rowsFromRegionCsv(text) {
  const table = parseCsv(text);
  if (!table.length) return { ok: false, error: 'CSV 文件为空' };
  const header = table[0].map((h) => String(h).trim());
  const keys = [];
  const unknownHeaders = [];
  const seen = new Set();
  for (const h of header) {
    const key = CSV_HEADER_ALIASES[h] || CSV_HEADER_ALIASES[h.replace(/\(.*?\)\s*$/, '').trim()];
    if (!key) { unknownHeaders.push(h); continue; }
    if (seen.has(key)) return { ok: false, error: `CSV 表头重复：${h}` };
    seen.add(key);
    keys.push(key);
  }
  if (unknownHeaders.length) {
    return { ok: false, error: `CSV 包含未知表头：${unknownHeaders.join('、')}` };
  }
  const required = ['scope', 'year', 'value_tco2', 'unit', 'methodology', 'boundary',
    'dataset_key', 'source_name', 'source_url', 'source_kind', 'excerpt'];
  if (!seen.has('province') && !seen.has('province_code') && !seen.has('province_name')) {
    return { ok: false, error: 'CSV 缺少省份列（province 或 province_code）' };
  }
  const missing = required.filter((k) => !seen.has(k));
  if (missing.length) return { ok: false, error: `CSV 缺少必填列：${missing.join('、')}` };
  const rows = [];
  for (let i = 1; i < table.length; i += 1) {
    const obj = { __row: i + 1 };
    let empty = true;
    keys.forEach((key, idx) => {
      const v = table[i][idx] === undefined ? '' : String(table[i][idx]).trim();
      obj[key] = v === '' ? null : v;
      if (v !== '') empty = false;
    });
    if (!empty) rows.push(obj);
  }
  return { ok: true, rows, headers: keys };
}

/* ==================================================================== */
/*  九、状态、日更检查                                                   */
/* ==================================================================== */

export function regionMapStatus() {
  try {
    const table = get("SELECT name FROM sqlite_master WHERE type='table' AND name='region_emission'");
    if (!table) {
      return {
        ok: false, table_ready: false, database: dbPath(),
        message: 'region_emission 表尚未迁移；请以 CCER_ENABLE_V2=1 打开数据库。',
      };
    }
    const counts = get(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status='active' THEN 1 ELSE 0 END) AS active,
              SUM(CASE WHEN status='superseded' THEN 1 ELSE 0 END) AS superseded
       FROM region_emission`
    ) || { total: 0, active: 0, superseded: 0 };
    const datasets = all(
      `SELECT scope, dataset_key, source_name, source_kind,
              MIN(year) AS min_year, MAX(year) AS max_year,
              COUNT(*) AS records, COUNT(DISTINCT province_code) AS provinces,
              MAX(collected_at) AS latest_collected_at
       FROM region_emission
       WHERE status='active'
       GROUP BY scope, dataset_key, source_name, source_kind
       ORDER BY scope, dataset_key`
    ).map((r) => ({
      ...r,
      years: all(
        `SELECT DISTINCT year FROM region_emission
         WHERE scope=? AND dataset_key=? AND status='active' ORDER BY year DESC`,
        [r.scope, r.dataset_key]
      ).map((x) => x.year),
    }));
    const years = all(
      "SELECT DISTINCT year FROM region_emission WHERE status='active' ORDER BY year DESC"
    ).map((r) => r.year);
    const provincesByScope = {};
    for (const scope of ['region_co2', 'national_ets']) {
      provincesByScope[scope] = get(
        "SELECT COUNT(DISTINCT province_code) AS c FROM region_emission WHERE scope=? AND status='active'",
        [scope]
      )?.c || 0;
    }
    const projects = get(
      `SELECT COUNT(DISTINCT COALESCE(NULLIF(registry_project_no,''), id)) AS c,
              COUNT(DISTINCT province) AS provinces,
              MAX(updated_at) AS latest_updated_at
       FROM public_project WHERE COALESCE(is_demo,0)=0`
    ) || { c: 0, provinces: 0, latest_updated_at: null };
    let directory = { total: 0, years: [], provinces: 0 };
    try {
      directory = {
        total: get('SELECT COUNT(*) AS c FROM cea_entity')?.c || 0,
        years: all('SELECT DISTINCT list_year FROM cea_entity ORDER BY list_year DESC').map((r) => r.list_year),
        provinces: get('SELECT COUNT(DISTINCT province) AS c FROM cea_entity WHERE province IS NOT NULL')?.c || 0,
      };
    } catch { /* 表未就绪时保留空统计 */ }
    return {
      ok: true,
      table_ready: true,
      database: dbPath(),
      counts: {
        total: Number(counts.total) || 0,
        active: Number(counts.active) || 0,
        superseded: Number(counts.superseded) || 0,
      },
      datasets,
      coverage: {
        years,
        latest_year: years[0] ?? null,
        latest_collected_at: datasets.map((d) => d.latest_collected_at).filter(Boolean).sort().pop() || null,
        provinces_by_scope: provincesByScope,
      },
      projects: {
        count: Number(projects.c) || 0,
        provinces: Number(projects.provinces) || 0,
        latest_updated_at: projects.latest_updated_at || null,
      },
      directory,
      note:
        '排放按年度源数据维护，不在日更中重新计算数值；日更只做有界状态检查，'
        + '失败保留上次值与年度。没有支持的开放数据时不虚报自动全量取得。',
    };
  } catch (e) {
    return {
      ok: false, table_ready: false, database: dbPath(), error: e.message,
      message: '省域排放状态读取失败；不修改任何数值。',
    };
  }
}

/** 日更钩子：只读状态检查，不联网、不重算、不覆盖。 */
export function runRegionalDailyCheck({ actor = 'system:daily' } = {}) {
  const st = regionMapStatus();
  return {
    ok: st.ok,
    actor,
    checked_at: nowIso(),
    table_ready: st.table_ready,
    active_records: st.counts?.active ?? 0,
    latest_year: st.coverage?.latest_year ?? null,
    latest_collected_at: st.coverage?.latest_collected_at ?? null,
    datasets: (st.datasets || []).map((d) => ({
      scope: d.scope, dataset_key: d.dataset_key, years: d.years, source_kind: d.source_kind,
    })),
    values_changed: false,
    note: st.ok
      ? '年度排放记录只读检查完成；未重新生成数值，失败会保留上次值与年度。'
      : (st.message || st.error || '省域排放状态不可用'),
  };
}
