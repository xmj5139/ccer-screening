/**
 * 表单选择项（form-options-svc）
 * ============================================================================
 * 只读聚合公开页面已经存在的有限枚举与真实历史值，供前端下拉 / datalist 使用：
 *   - 省份：34 个省级行政区（含全称与短名）、全国、六个电网区域、新疆生产建设兵团；
 *   - 项目：公开项目实际出现过的省份、方法学编号、领域（历史值不丢）；
 *   - CEA：政策文件行业/年度、名录省份/行业/年度、交易意向配额年度、研报机构；
 *   - 核算：排放因子库真实地区、口径、数据年度；
 *   - 来源/机构：公开政策、研报、CEA 文件与项目业主的实际发布方（仅作建议，不限制输入）。
 *
 * 纪律：
 *   - 不写入任何表，不改变筛选语义；空值「全部」由前端生成；
 *   - 选项值来自库内真实字段或固定行政区/行业目录，找不到的旧值由前端保留为「历史值」；
 *   - 任何单表缺失或字段异常只让对应选项为空，不影响其它筛选。
 */
import { all } from '../core/db.mjs';
import { uj } from '../core/util.mjs';
import { METHODOLOGY_CATALOG } from '../data/catalog.mjs';
import { PROVINCES, REGION_GROUPS } from '../data/region-catalog.mjs';
import { factorFacets } from './accounting-svc.mjs';
import { filterOptions } from './dashboard-svc.mjs';

const NATIONAL = { value: '全国', label: '全国' };
const XPCC = { value: '新疆生产建设兵团', label: '新疆生产建设兵团' };
const GRID_REGIONS = ['华北', '东北', '华东', '华中', '西北', '南方'];
const NATIONAL_ETS_SECTORS = ['发电', '钢铁', '水泥', '铝冶炼'];

function opt(value, label = value) {
  const v = value === null || value === undefined ? '' : String(value).trim();
  if (!v) return null;
  return { value: v, label: String(label ?? v).trim() || v };
}

function uniqOptions(list = []) {
  const out = [];
  const seen = new Set();
  for (const item of list) {
    const o = typeof item === 'string' ? opt(item) : opt(item?.value, item?.label);
    if (!o || seen.has(o.value)) continue;
    seen.add(o.value);
    out.push(o);
  }
  return out;
}

function safeAll(sql, params = []) {
  try {
    return all(sql, params);
  } catch {
    return [];
  }
}

function stringValues(sql, params = []) {
  return safeAll(sql, params)
    .map((r) => r?.v)
    .filter((v) => v !== null && v !== undefined && String(v).trim() !== '')
    .map((v) => String(v).trim());
}

function jsonArray(value) {
  const out = uj(value, []);
  return Array.isArray(out) ? out : [];
}

function splitSectors(value) {
  return String(value || '')
    .split(/[、,，/;；]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function documentSectors() {
  const values = [];
  for (const row of safeAll('SELECT covered_sectors, coverage_json FROM cea_document')) {
    values.push(...jsonArray(row.covered_sectors).map(String));
    for (const c of jsonArray(row.coverage_json)) values.push(String(c?.sector || ''));
  }
  return values;
}

function documentYears() {
  const values = [];
  for (const row of safeAll('SELECT applicable_years, coverage_json FROM cea_document')) {
    values.push(...jsonArray(row.applicable_years).map(Number));
    for (const c of jsonArray(row.coverage_json)) {
      for (const y of (Array.isArray(c?.years) ? c.years : [])) values.push(Number(y));
    }
  }
  return values.filter(Number.isInteger);
}

function numbers(values = []) {
  return [...new Set(values.map(Number).filter(Number.isInteger))].sort((a, b) => b - a);
}

function provinceOptions(actualValues = []) {
  return uniqOptions([
    NATIONAL,
    XPCC,
    ...PROVINCES.map((p) => opt(p.name, p.name)),
    ...actualValues,
  ]);
}

export function formOptions() {
  let dashboard = { domains: [], provinces: [], methodologies: [] };
  try {
    dashboard = filterOptions();
  } catch {
    /* 单模块失败不阻塞其它选项 */
  }

  const projectProvinces = stringValues(
    "SELECT DISTINCT province AS v FROM public_project WHERE COALESCE(is_demo,0)=0 AND province IS NOT NULL"
  );
  const entityProvinces = stringValues(
    'SELECT DISTINCT province AS v FROM cea_entity WHERE province IS NOT NULL'
  );
  const projectCities = stringValues(
    "SELECT DISTINCT city AS v FROM public_project WHERE COALESCE(is_demo,0)=0 AND city IS NOT NULL"
  );
  const entityCities = stringValues(
    'SELECT DISTINCT city AS v FROM cea_entity WHERE city IS NOT NULL'
  );
  const projectDomains = stringValues(
    "SELECT DISTINCT domain AS v FROM public_project WHERE COALESCE(is_demo,0)=0 AND domain IS NOT NULL"
  );
  const methodologyDomains = stringValues(
    'SELECT DISTINCT domain AS v FROM methodology_version WHERE domain IS NOT NULL'
  );

  const projectMethodologies = stringValues(
    "SELECT DISTINCT methodology_id AS v FROM public_project WHERE COALESCE(is_demo,0)=0 AND methodology_id IS NOT NULL"
  );
  const versionMethodologies = safeAll(
    'SELECT DISTINCT methodology_id, code_display, name FROM methodology_version WHERE methodology_id IS NOT NULL'
  ).map((r) => ({ id: r.code_display?.match(/^CCER-\d{2}-\d{3}(?:-V\d+)?$/)
    ? r.code_display.replace(/-V\d+$/, '') : String(r.methodology_id), name: r.name }));
  const catalogMethodologies = METHODOLOGY_CATALOG.map((m) => ({
    id: m.code_display?.match(/^CCER-\d{2}-\d{3}(?:-V\d+)?$/)
      ? m.code_display.replace(/-V\d+$/, '') : m.methodology_id, name: m.name,
  }));
  const methodologyLabel = new Map();
  for (const m of [...catalogMethodologies, ...versionMethodologies]) {
    if (m?.id && m?.name && !m.id.startsWith('CCER-PENDING-') && !methodologyLabel.has(m.id)) {
      methodologyLabel.set(m.id, m.name);
    }
  }
  const methodologies = uniqOptions([
    ...projectMethodologies.map((id) => opt(id, methodologyLabel.get(id) ? `${id}｜${methodologyLabel.get(id)}` : id)),
    ...[...methodologyLabel.keys()].map((id) => opt(id, `${id}｜${methodologyLabel.get(id)}`)),
  ]);

  const projectDomainsKnown = [
    ...projectDomains,
    ...(Array.isArray(dashboard.domains) ? dashboard.domains : []),
    ...methodologyDomains,
    ...METHODOLOGY_CATALOG.map((m) => m.domain),
  ];
  const domains = uniqOptions(projectDomainsKnown);

  const sources = uniqOptions([
    ...stringValues('SELECT DISTINCT issuing_authority AS v FROM policy_document WHERE issuing_authority IS NOT NULL'),
    ...stringValues('SELECT DISTINCT publisher AS v FROM content_item WHERE publisher IS NOT NULL'),
    ...stringValues('SELECT DISTINCT issuer AS v FROM cea_document WHERE issuer IS NOT NULL'),
    ...stringValues('SELECT DISTINCT owner_name AS v FROM public_project WHERE COALESCE(is_demo,0)=0 AND owner_name IS NOT NULL'),
  ]).slice(0, 400);

  const ceaSectors = uniqOptions([
    ...NATIONAL_ETS_SECTORS,
    ...safeAll('SELECT DISTINCT sector AS v FROM cea_entity WHERE sector IS NOT NULL').map((r) => r.v).flatMap(splitSectors),
    ...documentSectors(),
  ]);
  const entityYears = safeAll('SELECT DISTINCT list_year AS v FROM cea_entity WHERE list_year IS NOT NULL').map((r) => r.v);
  const intentionYears = safeAll('SELECT DISTINCT quota_year AS v FROM cea_intention WHERE quota_year IS NOT NULL').map((r) => r.v);
  const docYears = documentYears();
  const factorYears = safeAll('SELECT DISTINCT data_year AS v FROM emission_factor WHERE is_current=1 AND data_year IS NOT NULL').map((r) => r.v);
  const allYears = numbers([...docYears, ...entityYears, ...intentionYears, ...factorYears]);

  let facets = { data_years: [], categories: [], regions: [] };
  try {
    facets = factorFacets();
  } catch {
    /* 因子库空时返回空选项；页面保留当前值 */
  }
  const factorRegions = uniqOptions([
    NATIONAL,
    ...GRID_REGIONS.map((r) => opt(r, r)),
    ...(facets.regions || []).map((r) => opt(r.region, r.region_level ? `${r.region}（${r.region_level}）` : r.region)),
  ]);
  const accountingCategories = (facets.categories || []).map((c) => opt(c.key, c.label));

  return {
    provinces: {
      national: NATIONAL,
      xpcc: XPCC,
      grid_regions: GRID_REGIONS.map((r) => opt(r, r)),
      full: PROVINCES.map((p) => ({ value: p.name, label: p.name, short_name: p.short_name, group: p.group })),
      short: PROVINCES.map((p) => ({ value: p.short_name, label: p.short_name, full_name: p.name, group: p.group })),
      groups: REGION_GROUPS,
    },
    projects: {
      provinces: provinceOptions(projectProvinces),
      methodologies,
      domains,
    },
    search: {
      regions: uniqOptions([
        NATIONAL,
        ...REGION_GROUPS.map((g) => opt(g.key, g.label)),
        ...PROVINCES.map((p) => opt(p.short_name, p.short_name)),
        XPCC,
        ...projectProvinces,
        ...entityProvinces,
        ...projectCities,
        ...entityCities,
        ...factorRegions,
      ]),
      sources,
    },
    cea: {
      provinces: provinceOptions([...entityProvinces]),
      sectors: ceaSectors,
      years: {
        documents: numbers(docYears),
        entities: numbers(entityYears),
        intentions: numbers(intentionYears),
        all: allYears,
      },
      issuers: sources,
    },
    accounting: {
      data_years: numbers([...(facets.data_years || []), ...factorYears]),
      categories: accountingCategories,
      regions: factorRegions,
    },
    admin: {
      provinces: provinceOptions([...projectProvinces, ...entityProvinces]),
      methodologies,
      domains: uniqOptions([...domains, ...projectDomains, ...methodologyDomains]),
      regions: factorRegions,
      years: allYears,
      sources,
    },
    sources,
    note:
      '选项只读聚合自公开数据与固定行政区/行业目录；来源与机构仅作输入建议，不限制自由填写。' +
      '「全国」、电网区域、兵团与无法识别的历史值均保留，筛选语义不变。',
  };
}
