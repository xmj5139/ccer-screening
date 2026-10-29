/**
 * 共享表单选择工具（零依赖，可被 Node 测试直接导入）
 * ============================================================================
 * 目标：
 *   - 有限选项统一输出为 <select>；来源/机构等不完整清单使用 <datalist>，仍可自由输入；
 *   - 当前 query / 编辑旧值即使不在选项表里也保留为「历史值」选中项，不静默丢失；
 *   - 所有选项 value/label 都做 HTML 转义，避免选项内容成为注入点；
 *   - 空选项固定为「全部」（筛选）或「（空）」（编辑），不改变后端筛选语义。
 */

const FULL_PROVINCES = [
  '北京市', '天津市', '河北省', '山西省', '内蒙古自治区', '辽宁省', '吉林省', '黑龙江省',
  '上海市', '江苏省', '浙江省', '安徽省', '福建省', '江西省', '山东省', '河南省',
  '湖北省', '湖南省', '广东省', '广西壮族自治区', '海南省', '重庆市', '四川省', '贵州省',
  '云南省', '西藏自治区', '陕西省', '甘肃省', '青海省', '宁夏回族自治区', '新疆维吾尔自治区',
  '台湾省', '香港特别行政区', '澳门特别行政区',
];
const SHORT_PROVINCES = [
  '北京', '天津', '河北', '山西', '内蒙古', '辽宁', '吉林', '黑龙江',
  '上海', '江苏', '浙江', '安徽', '福建', '江西', '山东', '河南',
  '湖北', '湖南', '广东', '广西', '海南', '重庆', '四川', '贵州',
  '云南', '西藏', '陕西', '甘肃', '青海', '宁夏', '新疆',
  '台湾', '香港', '澳门',
];
export const GRID_REGIONS = ['华北', '东北', '华东', '华中', '西北', '南方'];
export const NATIONAL_ETS_SECTORS = ['发电', '钢铁', '水泥', '铝冶炼'];
const SPECIAL_REGIONS = ['全国', '新疆生产建设兵团'];

export function escForm(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** 接受字符串或 { value,label }，按 value 去重；空值丢弃。 */
export function normalizeOptions(input) {
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(input) ? input : []) {
    let value;
    let label;
    if (item !== null && typeof item === 'object') {
      value = item.value ?? item.key ?? item.name ?? item.methodology_id;
      label = item.label ?? item.name ?? value;
    } else {
      value = item;
      label = item;
    }
    if (value === null || value === undefined) continue;
    const v = String(value).trim();
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push({ value: v, label: String(label ?? v).trim() || v });
  }
  return out;
}

function withCurrent(options, current, suffix = '（历史值）') {
  const list = normalizeOptions(options);
  const value = current === null || current === undefined ? '' : String(current);
  if (!value || list.some((o) => o.value === value)) return list;
  return [...list, { value, label: `${value}${suffix}` }];
}

/**
 * 筛选下拉的 <option> 列表。空值代表「全部」，并保留未知的历史 query 值。
 * 返回内容不含外层 <select>，便于各页面沿用既有 data-* 属性。
 */
export function selectOptionsHtml(options, current = '', {
  allLabel = '全部', allValue = '', currentSuffix = '（历史值）',
} = {}) {
  const av = String(allValue ?? '');
  const cv = current === null || current === undefined ? '' : String(current);
  const allSelected = cv === av ? ' selected' : '';
  const list = withCurrent(options, cv, currentSuffix).filter((o) => o.value !== av);
  return `<option value="${escForm(av)}"${allSelected}>${escForm(allLabel)}</option>`
    + list.map((o) => `<option value="${escForm(o.value)}"${cv === o.value ? ' selected' : ''}>${escForm(o.label)}</option>`).join('');
}

/** datalist 只给建议，不限制输入；当前旧值也会进入建议列表。 */
export function datalistHtml(id, options, current = '', { currentSuffix = '（当前值）' } = {}) {
  const safeId = String(id || 'options').replace(/[^A-Za-z0-9_-]/g, '-');
  const list = withCurrent(options, current, currentSuffix);
  return `<datalist id="${escForm(safeId)}">${list
    .map((o) => `<option value="${escForm(o.value)}">${escForm(o.label)}</option>`).join('')}</datalist>`;
}

function selectForField(fieldKey, current, options, { allLabel = '（空）' } = {}) {
  return `<select data-edit-field="${escForm(fieldKey)}">${selectOptionsHtml(options, current, {
    allLabel, allValue: '', currentSuffix: '（当前值）',
  })}</select>`;
}

/**
 * 后台编辑字段控件。有限枚举用下拉，来源/方法学建议用 datalist，URL 保留原值。
 * 纯字符串输出，便于维护页直接拼接，也便于测试旧值与转义。
 */
export function editFieldControl(field = {}, currentValue = '', adminOptions = {}) {
  const key = String(field.key || '');
  const type = String(field.type || 'text');
  const current = currentValue === null || currentValue === undefined ? '' : String(currentValue);
  const maxlength = field.max ? ` maxlength="${Number(field.max) || 2000}"` : '';
  const common = `data-edit-field="${escForm(key)}"`;
  const valueAttr = `value="${escForm(current)}"`;

  if (type === 'url') {
    // URL 原值保留；下拉不应吞掉旧链接，也不把链接当枚举值。
    return `<input ${common} type="url" ${valueAttr}${maxlength}>`;
  }
  if (type === 'date') return `<input ${common} type="date" ${valueAttr}>`;
  if (key === 'data_year') {
    return `<input ${common} type="number" step="1" ${valueAttr} list="edit-year-options">`;
  }
  if (type === 'number') {
    return `<input ${common} type="number" step="1" ${valueAttr}>`;
  }
  if (key === 'province') return selectForField(key, current, adminOptions.provinces);
  if (key === 'region') return selectForField(key, current, adminOptions.regions);
  if (key === 'domain') return selectForField(key, current, adminOptions.domains);
  if (key === 'methodology_id') {
    return `<input ${common} type="text" ${valueAttr}${maxlength} list="edit-methodology-options" placeholder="可输入目录外编号，保留历史值">`;
  }
  if (['issuing_authority', 'publisher', 'issuer'].includes(key)) {
    return `<input ${common} type="text" ${valueAttr}${maxlength} list="edit-source-options" placeholder="机构名称可自由填写">`;
  }
  return `<input ${common} type="text" ${valueAttr}${maxlength}>`;
}

function fallbackOptionList(values = []) {
  return normalizeOptions(values);
}

export function fallbackFormOptions() {
  const fullProvinces = fallbackOptionList([...SPECIAL_REGIONS, ...FULL_PROVINCES]);
  const shortRegions = fallbackOptionList([
    ...SPECIAL_REGIONS, ...GRID_REGIONS, ...SHORT_PROVINCES,
  ]);
  const sectors = fallbackOptionList(NATIONAL_ETS_SECTORS);
  const regions = fallbackOptionList([...SPECIAL_REGIONS, ...GRID_REGIONS]);
  return {
    projects: {
      provinces: fullProvinces,
      methodologies: [],
      domains: [],
    },
    search: { regions: shortRegions, sources: [] },
    cea: {
      provinces: fullProvinces,
      sectors,
      years: { documents: [], entities: [], intentions: [], all: [] },
      issuers: [],
    },
    accounting: { data_years: [], categories: [], regions },
    admin: {
      provinces: fullProvinces,
      methodologies: [],
      domains: [],
      regions,
      years: [],
      sources: [],
    },
    sources: [],
  };
}

function mergeList(primary, fallback) {
  const a = normalizeOptions(primary);
  return a.length ? a : normalizeOptions(fallback);
}

function normalizePayload(payload = {}) {
  const base = fallbackFormOptions();
  const p = payload || {};
  return {
    projects: {
      provinces: mergeList(p.projects?.provinces, base.projects.provinces),
      methodologies: normalizeOptions(p.projects?.methodologies),
      domains: normalizeOptions(p.projects?.domains),
    },
    search: {
      regions: mergeList(p.search?.regions, base.search.regions),
      sources: normalizeOptions(p.search?.sources),
    },
    cea: {
      provinces: mergeList(p.cea?.provinces, base.cea.provinces),
      sectors: mergeList(p.cea?.sectors, base.cea.sectors),
      years: {
        documents: normalizeOptions((p.cea?.years?.documents || []).map((y) => ({ value: String(y), label: `${y} 年` }))),
        entities: normalizeOptions((p.cea?.years?.entities || []).map((y) => ({ value: String(y), label: `${y} 年` }))),
        intentions: normalizeOptions((p.cea?.years?.intentions || []).map((y) => ({ value: String(y), label: `${y} 年` }))),
        all: normalizeOptions((p.cea?.years?.all || []).map((y) => ({ value: String(y), label: `${y} 年` }))),
      },
      issuers: normalizeOptions(p.cea?.issuers),
    },
    accounting: {
      data_years: normalizeOptions((p.accounting?.data_years || []).map((y) => ({ value: String(y), label: `${y} 年` }))),
      categories: normalizeOptions(p.accounting?.categories),
      regions: mergeList(p.accounting?.regions, base.accounting.regions),
    },
    admin: {
      provinces: mergeList(p.admin?.provinces, base.admin.provinces),
      methodologies: normalizeOptions(p.admin?.methodologies),
      domains: normalizeOptions(p.admin?.domains),
      regions: mergeList(p.admin?.regions, base.admin.regions),
      years: normalizeOptions((p.admin?.years || []).map((y) => ({ value: String(y), label: `${y} 年` }))),
      sources: normalizeOptions(p.admin?.sources),
    },
    sources: normalizeOptions(p.sources),
  };
}

let optionsPromise = null;
let optionsLoadedAt = 0;
const OPTIONS_TTL_MS = 60_000;

/** 读取真实选项；页面可在失败时回退到本地行政区目录。 */
export async function loadFormOptions(api, { force = false } = {}) {
  if (force || (optionsLoadedAt && Date.now() - optionsLoadedAt >= OPTIONS_TTL_MS)) {
    optionsPromise = null;
    optionsLoadedAt = 0;
  }
  if (!optionsPromise) {
    optionsPromise = Promise.resolve()
      .then(() => api('/api/v2/meta/form-options'))
      .then((payload) => {
        optionsLoadedAt = Date.now();
        return normalizePayload(payload);
      })
      .catch((err) => {
        optionsPromise = null;
        optionsLoadedAt = 0;
        throw err;
      });
  }
  return optionsPromise;
}
