/**
 * 省域地图卡（docs/59）
 * ============================================================================
 * 设计意图：
 *   - 暖白卡面、雾绿底图、深绿选择态；地图是主角，右侧详情与排名是工作区；
 *   - 桌面地图高度约 450px，手机单列；图例、单位、年度、覆盖范围始终可见；
 *   - 0 与缺数据分开：项目库未收录记 0，排放未取得为 null（灰色斜纹）；
 *   - 地图只负责选择，不因选中某省让其他省消失；省份下拉与排名按钮都可键盘操作；
 *   - 底图来自本地缓存的 DataV GeoJSON，缺失时降级为可用省份列表，不阻塞总览。
 *
 * 本模块不直接依赖 app.js；取数函数由 overview 注入，便于测试纯渲染函数。
 */
import { esc, loading } from '../ui.js';

export const GEO_URL = '/v2/assets/maps/china-provinces.json';
export const SOURCE_URL = '/v2/assets/maps/source.json';
export const PROJECT_METRICS = ['projects', 'registered_projects', 'reduction_registered_projects'];
export const DIRECTORY_METRIC = 'ets_entities';
export const DIRECTORY_METRICS = [DIRECTORY_METRIC];
export const VIEWS = [
  { key: 'projects', label: '公开 CCER 项目' },
  { key: 'region_co2', label: '区域 CO₂ 排放' },
  { key: 'national_ets', label: '全国碳市场纳管排放' },
  { key: 'ets_entities', label: 'CEA纳管企业名录' },
];
export const SUBMETRICS = [
  { key: 'projects', label: '公开项目数', unit: '个' },
  { key: 'registered_projects', label: '项目登记数', unit: '个' },
  { key: 'reduction_registered_projects', label: '减排量登记项目数', unit: '个' },
];
export const GROUPS = ['华北', '东北', '华东', '华中', '华南', '西南', '西北', '港澳台'];

const VIEW_LABEL = Object.fromEntries(VIEWS.map((v) => [v.key, v.label]));

/** 总览路由 → 地图查询。只有显式 map=ets_entities 才直接进入名录热力图。 */
export function mapQueryFromRoute(query = {}) {
  const params = new URLSearchParams();
  if (query.map === DIRECTORY_METRIC) {
    params.set('metric', DIRECTORY_METRIC);
    if (query.list_year) params.set('list_year', String(query.list_year));
  }
  for (const key of ['domain', 'methodology_id', 'stage']) {
    if (query[key]) params.set(key, query[key]);
  }
  return params;
}
const METRIC_LABEL = {
  projects: '公开项目数',
  registered_projects: '项目登记数',
  reduction_registered_projects: '减排量登记项目数',
  region_co2: '区域 CO₂ 排放',
  national_ets: '全国碳市场纳管排放',
  ets_entities: 'CEA纳管企业名录',
};
const PROJECT_STAGE_LABEL = {
  project_public: '项目公示',
  validated: '审定',
  project_registered: '项目登记',
  reduction_public: '减排量公示',
  verified: '核查',
  reduction_registered: '减排量登记',
};
function yearLabel(data) {
  return data?.year ? `${data.year} 年` : '年度未取得';
}
export function formatListYear(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? `${n} 年` : '名录年度未取得';
}
export function formatEntityCount(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—';
  return `${Number(value).toLocaleString('zh-CN')} 家`;
}
export function formatReadTime(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} `
    + `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function stageLabel(value) {
  return PROJECT_STAGE_LABEL[value] || value || '';
}
function directorySub(region) {
  const dir = region?.ets_directory || {};
  if (!dir.available) return '名录未取得';
  return Number(dir.count) > 0
    ? `本系统收录名录 ${dir.count} 家（${dir.year}）`
    : `名录未收录（${dir.year}）`;
}
function directoryYear(data) {
  return data?.list_year ?? data?.directory_summary?.list_year ?? data?.coverage?.directory_years?.[0] ?? null;
}
const MAIN_BOUNDS = { lonMin: 73.2, lonMax: 135.3, latMin: 17.6, latMax: 53.8, width: 820, height: 620, pad: 6 };
const INSET = {
  lonMin: 105, lonMax: 125, latMin: 2.5, latMax: 25,
  box: { x: 660, y: 382, width: 150, height: 224 },
};
const COS_MAIN = Math.cos((35 * Math.PI) / 180);
const COS_INSET = Math.cos((15 * Math.PI) / 180);

/* ==================================================================== */
/*  一、状态与纯函数                                                     */
/* ==================================================================== */

export function createRegionMapState(initial = {}) {
  return {
    view: 'projects',
    metric: 'projects',
    submetric: 'projects',
    year: null,
    listYear: null,
    dataset: null,
    regionGroup: '',
    selectedCode: null,
    hoverCode: null,
    lastSuccessAt: null,
    refreshError: null,
    ...initial,
  };
}

export function selectRegion(state, code) {
  return { ...state, selectedCode: code || null };
}

export function hoverRegion(state, code) {
  return { ...state, hoverCode: code || null };
}

export function clearHover(state) {
  return { ...state, hoverCode: null };
}

export function currentMetric(data, state) {
  if (state.view === DIRECTORY_METRIC || state.metric === DIRECTORY_METRIC || data?.metric === DIRECTORY_METRIC) {
    return DIRECTORY_METRIC;
  }
  if (state.view === 'projects' || (data?.view === 'projects' && PROJECT_METRICS.includes(state.metric))) {
    return PROJECT_METRICS.includes(state.submetric) ? state.submetric : 'projects';
  }
  return state.view === 'national_ets' ? 'national_ets' : 'region_co2';
}

export function projectMetricValue(region, metric) {
  if (metric === 'registered_projects') return Number(region?.registered_count || 0);
  if (metric === 'reduction_registered_projects') return Number(region?.reduction_registered_count || 0);
  return Number(region?.project_count || 0);
}

export function valueOf(region, metric) {
  if (PROJECT_METRICS.includes(metric)) return projectMetricValue(region, metric);
  if (DIRECTORY_METRICS.includes(metric)) {
    const n = region?.directory?.count ?? region?.ets_directory?.count;
    return n === null || n === undefined ? null : Number(n);
  }
  return region?.value === null || region?.value === undefined ? null : Number(region.value);
}

export function isMissingValue(region, metric) {
  if (PROJECT_METRICS.includes(metric)) return false;
  if (DIRECTORY_METRICS.includes(metric)) {
    return region?.directory?.count === null
      || region?.directory?.count === undefined
      || valueOf(region, metric) === null;
  }
  return region?.missing === true || valueOf(region, metric) === null;
}

export function formatCount(v) {
  if (v === null || v === undefined || !Number.isFinite(Number(v))) return '—';
  return `${Number(v).toLocaleString('zh-CN')} 个`;
}

export function formatTco2(v) {
  if (v === null || v === undefined || v === '') return '—';
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  const fmt = (x, d) => Number(x).toLocaleString('zh-CN', { minimumFractionDigits: 0, maximumFractionDigits: d });
  if (n >= 1e8) return `${fmt(n / 1e8, 2)} 亿吨`;
  if (n >= 1e4) return `${fmt(n / 1e4, 2)} 万吨`;
  return `${fmt(n, 0)} 吨`;
}

export function displayValue(region, metric) {
  if (PROJECT_METRICS.includes(metric)) return formatCount(valueOf(region, metric));
  const v = valueOf(region, metric);
  if (DIRECTORY_METRICS.includes(metric)) return v === null ? '未收录' : formatEntityCount(v);
  return v === null ? '未取得' : formatTco2(v);
}

/** 分位数分级：0 单列，缺失单列；正值按 3 个分位断点分成 4 档。 */
export function buildScale(values = []) {
  const nums = values
    .filter((v) => v !== null && v !== undefined && Number.isFinite(Number(v)))
    .map(Number);
  const positive = [...new Set(nums.filter((n) => n > 0))].sort((a, b) => a - b);
  const hasZero = nums.some((n) => n === 0);
  if (!positive.length) {
    return {
      empty: nums.length === 0,
      hasZero,
      allZero: nums.length > 0 && positive.length === 0,
      breaks: [],
      min: nums.length ? Math.min(...nums) : null,
      max: nums.length ? Math.max(...nums) : null,
      singlePositive: null,
    };
  }
  if (positive.length === 1) {
    return {
      empty: false, hasZero, allZero: false, breaks: [],
      min: Math.min(...nums), max: Math.max(...nums), singlePositive: positive[0],
    };
  }
  const breaks = [];
  for (let i = 1; i <= 3; i += 1) {
    const idx = Math.min(positive.length - 1, Math.floor((positive.length - 1) * i / 4));
    const b = positive[idx];
    if (!breaks.includes(b)) breaks.push(b);
  }
  return {
    empty: false, hasZero, allZero: false, breaks,
    min: Math.min(...nums), max: Math.max(...nums), singlePositive: null,
  };
}

export function classForValue(value, scale) {
  if (value === null || value === undefined) return 'is-missing';
  const n = Number(value);
  if (!Number.isFinite(n)) return 'is-missing';
  if (n === 0) return 'is-zero';
  if (!scale || scale.empty) return 'is-missing';
  if (!scale.breaks.length) return 'heat-2';
  let idx = 0;
  for (const b of scale.breaks) if (n > b) idx += 1;
  return `heat-${Math.min(4, idx + 1)}`;
}

export function scaleBins(scale, metric) {
  if (!scale || scale.empty) return [];
  const fmt = (v) => DIRECTORY_METRICS.includes(metric) ? formatEntityCount(v)
    : PROJECT_METRICS.includes(metric) ? `${Number(v).toLocaleString('zh-CN')}` : formatTco2(v);
  if (!scale.breaks.length) {
    if (scale.singlePositive !== null && scale.singlePositive !== undefined) {
      return [{ cls: 'heat-2', label: `正值 ${fmt(scale.singlePositive)}` }];
    }
    return [];
  }
  const bins = [];
  let prev = 0;
  scale.breaks.forEach((b, i) => {
    bins.push({
      cls: `heat-${i + 1}`,
      label: i === 0 ? `≤ ${fmt(b)}` : `${fmt(prev)}–${fmt(b)}`,
    });
    prev = b;
  });
  bins.push({ cls: `heat-${Math.min(4, scale.breaks.length + 1)}`, label: `> ${fmt(prev)}` });
  return bins;
}

/** 排名：有值按降序，缺失置底；并列同名次。区域分组只影响排名，不影响地图。 */
export function rankRegions(regions, metric, group = '') {
  const list = (regions || []).filter((r) => !group || r.group === group);
  const prepared = list.map((r) => ({
    region: r,
    value: valueOf(r, metric),
    missing: isMissingValue(r, metric),
  }));
  prepared.sort((a, b) => {
    if (a.missing !== b.missing) return a.missing ? 1 : -1;
    if (a.missing) return String(a.region.code).localeCompare(String(b.region.code));
    return (b.value - a.value) || String(a.region.code).localeCompare(String(b.region.code));
  });
  let lastValue = null;
  let lastRank = 0;
  return prepared.map((item, i) => {
    let rank = null;
    if (!item.missing) {
      if (lastValue !== null && item.value === lastValue) rank = lastRank;
      else {
        rank = i + 1;
        lastRank = rank;
        lastValue = item.value;
      }
    }
    return { ...item.region, rank, value: item.value, missing: item.missing };
  });
}

export function buildExportHref(data, state, filters = {}) {
  const metric = currentMetric(data, state);
  const q = new URLSearchParams({ format: 'csv', metric });
  if (DIRECTORY_METRICS.includes(metric)) {
    if (state.listYear || state.year) q.set('list_year', String(state.listYear || state.year));
  } else if (!PROJECT_METRICS.includes(metric)) {
    if (state.year) q.set('year', String(state.year));
    if (state.dataset) q.set('dataset', state.dataset);
  }
  if (state.regionGroup) q.set('region', state.regionGroup);
  for (const key of ['domain', 'methodology_id', 'stage']) {
    if (filters[key]) q.set(key, filters[key]);
  }
  return `/api/v2/overview/region-map/export?${q.toString()}`;
}

function escapeAttr(v) {
  return esc(v).replace(/`/g, '&#96;');
}

function safeHttpHref(url) {
  if (!url) return null;
  try {
    const u = new URL(String(url));
    if (!['http:', 'https:'].includes(u.protocol)) return null;
    if (u.username || u.password) return null;
    return u.toString();
  } catch {
    return null;
  }
}

function projectListHref(region) {
  return `#/projects?province=${encodeURIComponent(region.project_province_label || region.name)}`;
}

export function entityListHref(region) {
  const year = region?.directory?.year ?? region?.ets_directory?.year;
  // 名录页按省份别名组过滤，统一传规范全称，避免简称/全称各写一套。
  const q = new URLSearchParams({ tab: 'entities', province: region?.name || '' });
  if (year) q.set('list_year', String(year));
  return `#/cea?${q.toString()}`;
}

/* ==================================================================== */
/*  二、底图加载与几何预处理                                             */
/* ==================================================================== */

let mapPromise = null;
let geometryCache = { geo: null, value: null };

export function loadChinaMap({ force = false } = {}) {
  if (force) mapPromise = null;
  if (mapPromise) return mapPromise;
  mapPromise = Promise.all([
    fetch(GEO_URL, { credentials: 'same-origin' }).then((res) => {
      if (!res.ok) throw new Error(`底图加载失败（HTTP ${res.status}）`);
      return res.json();
    }),
    fetch(SOURCE_URL, { credentials: 'same-origin' }).then((res) => (res.ok ? res.json() : null)).catch(() => null),
  ]).then(([geo, source]) => {
    if (!geo || geo.type !== 'FeatureCollection' || !Array.isArray(geo.features)) {
      throw new Error('底图格式不完整');
    }
    const provinceFeatures = geo.features.filter((f) => f?.properties?.level === 'province'
      || (f?.properties?.adcode && String(f.properties.adcode).length === 6));
    if (provinceFeatures.length < 34) throw new Error('底图缺少省级边界');
    return { geo, source };
  }).catch((e) => {
    mapPromise = null;
    throw e;
  });
  return mapPromise;
}

function makeProjector({ lonMin, lonMax, latMin, latMax, width, height, pad, cos }) {
  const lonSpan = (lonMax - lonMin) * cos;
  const latSpan = latMax - latMin;
  return (lon, lat) => [
    pad + ((lon - lonMin) * cos / lonSpan) * (width - pad * 2),
    pad + ((latMax - lat) / latSpan) * (height - pad * 2),
  ];
}

function insetProjector() {
  const { x, y, width, height } = INSET.box;
  const lonSpan = (INSET.lonMax - INSET.lonMin) * COS_INSET;
  const latSpan = INSET.latMax - INSET.latMin;
  const pad = 5;
  return (lon, lat) => [
    x + pad + ((lon - INSET.lonMin) * COS_INSET / lonSpan) * (width - pad * 2),
    y + pad + ((INSET.latMax - lat) / latSpan) * (height - pad * 2),
  ];
}

function polygonsOf(geometry) {
  if (!geometry) return [];
  if (geometry.type === 'MultiPolygon') return Array.isArray(geometry.coordinates) ? geometry.coordinates : [];
  if (geometry.type === 'Polygon') return [geometry.coordinates];
  return [];
}

function maxLatOfPolygon(poly) {
  let max = -90;
  for (const ring of poly || []) {
    for (const pt of ring || []) {
      if (Array.isArray(pt) && Number.isFinite(pt[1])) max = Math.max(max, pt[1]);
    }
  }
  return max;
}

function bboxCenter(polys) {
  let minLon = 180; let minLat = 90; let maxLon = -180; let maxLat = -90;
  for (const poly of polys || []) {
    for (const ring of poly || []) {
      for (const pt of ring || []) {
        if (!Array.isArray(pt) || !Number.isFinite(pt[0]) || !Number.isFinite(pt[1])) continue;
        minLon = Math.min(minLon, pt[0]); maxLon = Math.max(maxLon, pt[0]);
        minLat = Math.min(minLat, pt[1]); maxLat = Math.max(maxLat, pt[1]);
      }
    }
  }
  if (minLon > maxLon) return null;
  return [(minLon + maxLon) / 2, (minLat + maxLat) / 2];
}

function ringToPath(ring, project) {
  let out = '';
  for (let i = 0; i < ring.length; i += 1) {
    const pt = ring[i];
    if (!Array.isArray(pt) || !Number.isFinite(pt[0]) || !Number.isFinite(pt[1])) continue;
    const [x, y] = project(pt[0], pt[1]);
    out += `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`;
  }
  return out ? `${out}Z` : '';
}

function polygonsToPath(polys, project) {
  return (polys || []).map((poly) => (poly || []).map((ring) => ringToPath(ring, project)).join('')).join('');
}

export function prepareGeometry(geo) {
  if (geometryCache.geo === geo) return geometryCache.value;
  const mainProject = makeProjector({ ...MAIN_BOUNDS, cos: COS_MAIN });
  const insetProject = insetProjector();
  const main = [];
  const inset = [];
  const insetHainan = [];
  const sea = [];
  const byCode = new Map();
  for (const feature of geo.features || []) {
    const props = feature.properties || {};
    const adcode = String(props.adcode || '');
    const polys = polygonsOf(feature.geometry);
    if (!polys.length) continue;
    if (adcode === '100000_JD' || (!props.name && adcode === '100000_JD')) {
      sea.push({ code: 'sea', d: polygonsToPath(polys, insetProject) });
      continue;
    }
    if (!adcode || adcode.length !== 6) continue;
    let mainPolys = polys;
    let hainanPolys = [];
    if (adcode === '460000') {
      mainPolys = polys.filter((poly) => maxLatOfPolygon(poly) >= 18.0);
      hainanPolys = polys.filter((poly) => maxLatOfPolygon(poly) < 18.0);
    }
    const d = polygonsToPath(mainPolys, mainProject);
    if (!d) continue;
    const centroidLonLat = Array.isArray(props.centroid) ? props.centroid
      : Array.isArray(props.center) ? props.center
        : bboxCenter(mainPolys);
    const centroid = centroidLonLat ? mainProject(centroidLonLat[0], centroidLonLat[1]) : null;
    const item = { code: adcode, name: props.name || adcode, d, centroid };
    main.push(item);
    byCode.set(adcode, item);
    if (hainanPolys.length) {
      insetHainan.push({ code: adcode, d: polygonsToPath(hainanPolys, insetProject) });
    }
  }
  for (const s of sea) inset.push(s);
  const value = { main, inset, insetHainan, sea, byCode };
  geometryCache = { geo, value };
  return value;
}

/* ==================================================================== */
/*  三、SVG 渲染                                                         */
/* ==================================================================== */

function ariaForRegion(region, metric, data) {
  const display = displayValue(region, metric);
  if (PROJECT_METRICS.includes(metric)) {
    if (valueOf(region, metric) === 0) {
      return `${region.name}，${METRIC_LABEL[metric]} 0 个（本系统未收录）`;
    }
    return `${region.name}，${METRIC_LABEL[metric]} ${display}`;
  }
  if (DIRECTORY_METRICS.includes(metric)) {
    if (isMissingValue(region, metric)) {
      return `${region.name}，本平台未收录该省 ${formatListYear(directoryYear(data))}名录`;
    }
    return `${region.name}，${METRIC_LABEL[metric]} ${display}，${formatListYear(directoryYear(data))}`;
  }
  if (isMissingValue(region, metric)) return `${region.name}，排放数据未取得`;
  return `${region.name}，${data?.metric_label || METRIC_LABEL[metric]} ${display}${data?.year ? `，${data.year} 年` : ''}`;
}

export function buildRegionSvg(geo, data, state) {
  const prepared = prepareGeometry(geo);
  const metric = currentMetric(data, state);
  const values = (data?.regions || []).map((r) => valueOf(r, metric));
  const scale = buildScale(values);
  const regionByCode = new Map((data?.regions || []).map((r) => [String(r.code), r]));
  const selected = state.selectedCode ? prepared.byCode.get(String(state.selectedCode)) : null;
  const paths = prepared.main.map((g) => {
    const region = regionByCode.get(g.code);
    if (!region) return '';
    const cls = classForValue(valueOf(region, metric), scale);
    const isSelected = String(state.selectedCode || '') === g.code;
    const aria = ariaForRegion(region, metric, data);
    return `<path d="${g.d}" class="region-shape ${cls}${isSelected ? ' is-selected' : ''}" `
      + `data-region-code="${escapeAttr(g.code)}" tabindex="0" role="button" `
      + `aria-pressed="${isSelected ? 'true' : 'false'}" aria-label="${escapeAttr(aria)}">`
      + `<title>${esc(aria)}</title></path>`;
  }).join('');
  const hainanRegion = regionByCode.get('460000');
  const hainanCls = hainanRegion ? classForValue(valueOf(hainanRegion, metric), scale) : 'is-missing';
  const insetHainanPaths = prepared.insetHainan.map((g) => (
    `<path d="${g.d}" class="region-inset-hainan ${hainanCls}" aria-hidden="true" focusable="false"></path>`
  )).join('');
  const seaPaths = prepared.sea.map((g) => (
    `<path d="${g.d}" class="region-sea-shape" aria-hidden="true" focusable="false"></path>`
  )).join('');
  const marker = selected?.centroid
    ? `<g id="region-selected-marker" class="region-selected-marker" aria-hidden="true" pointer-events="none">`
      + `<circle cx="${selected.centroid[0].toFixed(1)}" cy="${selected.centroid[1].toFixed(1)}" r="7" class="region-selected-ring"></circle>`
      + `<circle cx="${selected.centroid[0].toFixed(1)}" cy="${selected.centroid[1].toFixed(1)}" r="2.8" class="region-selected-dot"></circle>`
      + '</g>'
    : '';
  return `<svg class="region-map-svg" data-map-svg viewBox="0 0 ${MAIN_BOUNDS.width} ${MAIN_BOUNDS.height}" `
    + `preserveAspectRatio="xMidYMid meet" role="group" aria-labelledby="region-map-svg-title region-map-svg-desc">`
    + '<title id="region-map-svg-title">中国省级地图</title>'
    + '<desc id="region-map-svg-desc">深色表示较高数值，浅色表示较低数值，灰色斜纹表示未取得。使用 Tab 聚焦省份，按 Enter 或空格查看右侧详情。</desc>'
    + '<defs><pattern id="region-missing-hatch" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">'
    + '<rect width="7" height="7" fill="#eef1ec"></rect><line x1="0" y1="0" x2="0" y2="7" stroke="#c8d0c8" stroke-width="1.2"></line>'
    + '</pattern></defs>'
    + `<g class="region-map-main">${paths}</g>`
    + marker
    + `<g class="region-map-inset" aria-hidden="true" focusable="false">`
    + `<rect x="${INSET.box.x}" y="${INSET.box.y}" width="${INSET.box.width}" height="${INSET.box.height}" rx="7" class="region-inset-frame"></rect>`
    + insetHainanPaths
    + seaPaths
    + `<text x="${INSET.box.x + INSET.box.width / 2}" y="${INSET.box.y + INSET.box.height - 9}" text-anchor="middle" class="region-inset-label">南海诸岛</text>`
    + '</g>'
    + '</svg>';
}

/* ==================================================================== */
/*  四、卡片 HTML                                                        */
/* ==================================================================== */

function dataErrorCard(error) {
  const msg = error?.body?.error || error?.message || String(error || '数据不可用');
  return `<section class="card region-map-card" aria-labelledby="region-map-heading">
    <header class="card-head">
      <div><h3 id="region-map-heading">省域地图与排放</h3>
      <p class="muted">公开 CCER 项目与省级排放</p></div>
    </header>
    <div class="card-body">
      <div class="region-map-error" role="alert">
        <b>省域地图暂不可用</b>
        <p>${esc(msg)}。总览其他卡片不受影响。</p>
        <button type="button" class="btn btn-sm" data-map-retry>重试</button>
      </div>
    </div>
  </section>`;
}

function subtitleFor(data) {
  if (!data) return '正在加载省域数据…';
  if (PROJECT_METRICS.includes(data.metric)) {
    return `公开 CCER 项目｜当前收录快照｜统计截至 ${data.coverage?.project_as_of || '—'}｜本平台已收录，不代表全国总数`;
  }
  if (DIRECTORY_METRICS.includes(data.metric)) {
    const total = data.totals?.directory_total;
    const covered = data.totals?.directory_covered_regions ?? data.totals?.covered_regions ?? 0;
    const asOf = data.coverage?.directory_as_of || '未取得';
    return `${data.metric_label}｜${formatListYear(directoryYear(data))}｜本平台已收录 ${formatEntityCount(total)}`
      + `，覆盖 ${covered}/34 省｜名录采集截至 ${asOf}｜非全国/全省完整数量`;
  }
  if (!data.data_available) {
    return `${data.metric_label || '排放'}｜年度未取得｜排放未取得｜不显示演示热力`;
  }
  const kind = data.dataset_options?.find?.((d) => d.dataset_key === data.dataset)?.source_kind_label
    || (data.metric === 'national_ets' ? '全国碳市场' : '区域排放');
  const dir = data.metric === 'national_ets' && data.coverage?.directory_available
    ? (Number(data.totals?.directory_total) > 0
      ? `｜本系统收录名录 ${data.totals.directory_total} 家（${data.coverage.directory_years?.[0] ?? '年度未取得'}）`
      : `｜名录未收录（${data.coverage.directory_years?.[0] ?? '年度未取得'}）`)
    : '';
  const asOf = data.coverage?.as_of ? `｜排放截至 ${data.coverage.as_of}` : '｜排放截至未取得';
  return `${data.metric_label}｜${yearLabel(data)}｜${kind}｜覆盖 ${data.totals?.covered_regions ?? 0}/34 省${asOf}${dir}`;
}

function viewSwitchHtml(data, state) {
  const current = state.view;
  return `<div class="region-map-views" role="group" aria-label="地图指标视图">
    ${VIEWS.map((v) => `<button type="button" class="region-map-view${current === v.key ? ' is-active' : ''}" `
      + `data-map-view="${v.key}" aria-pressed="${current === v.key ? 'true' : 'false'}">${esc(v.label)}</button>`).join('')}
  </div>`;
}

function submetricHtml(data, state) {
  if (state.view !== 'projects') return '';
  const items = data?.submetrics?.length ? data.submetrics : SUBMETRICS;
  return `<div class="region-map-submetrics" role="group" aria-label="公开项目子指标">
    ${items.map((s) => `<button type="button" class="region-map-submetric${state.submetric === s.key ? ' is-active' : ''}" `
      + `data-map-submetric="${s.key}" aria-pressed="${state.submetric === s.key ? 'true' : 'false'}">${esc(s.label)}</button>`).join('')}
  </div>`;
}

function selectedDataset(data) {
  return (data?.dataset_options || []).find((d) => d.dataset_key === data.dataset) || null;
}

function directoryControlsHtml(data, state) {
  const years = data?.list_year_options || data?.directory_summary?.list_year_options || [];
  if (!years.length) return '<span class="region-map-control-note">尚未收录可选名录年度</span>';
  const selected = state.listYear ?? directoryYear(data);
  return `<div class="region-map-emission-controls">
    <label class="region-map-control"><span>名录年度</span>
      <select data-map-list-year aria-label="名录年度">
        ${years.map((y) => `<option value="${y}" ${Number(selected) === Number(y) ? 'selected' : ''}>${y} 年</option>`).join('')}
      </select>
    </label>
    <span class="region-map-dataset-note">按信用代码+名录年度去重；未收录省份不补 0</span>
  </div>`;
}

function emissionControlsHtml(data, state) {
  if (DIRECTORY_METRICS.includes(currentMetric(data, state))) return directoryControlsHtml(data, state);
  if (state.view === 'projects') return '';
  const years = data?.year_options || [];
  const ds = selectedDataset(data);
  const options = data?.dataset_options || [];
  if (!years.length) {
    return '<span class="region-map-control-note">尚未入库可选年度</span>';
  }
  return `<div class="region-map-emission-controls">
    <label class="region-map-control"><span>年度</span>
      <select data-map-year aria-label="排放年度">
        ${years.map((y) => `<option value="${y}" ${Number(state.year) === Number(y) ? 'selected' : ''}>${y} 年</option>`).join('')}
      </select>
    </label>
    ${options.length > 1 ? `<label class="region-map-control"><span>数据口径</span>
      <select data-map-dataset aria-label="排放数据口径">
        ${options.map((o) => `<option value="${esc(o.dataset_key)}" ${o.dataset_key === state.dataset ? 'selected' : ''}>`
          + `${esc(o.source_name)}｜${esc(o.source_kind_label)}｜${o.province_count} 省</option>`).join('')}
      </select></label>`
      : `<span class="region-map-dataset-note">${ds ? `${esc(ds.source_name)}｜${esc(ds.source_kind_label)}｜${ds.province_count} 省` : '单一数据口径'}</span>`}
  </div>`;
}

function filterContextHtml(data, filters, contextProvince, state) {
  const chips = [];
  if (contextProvince) {
    chips.push(`<span class="chip chip-muted">总览省份筛选：${esc(contextProvince)}（地图仍为全国底图）</span>`);
  }
  const bits = [];
  if (filters?.domain) bits.push(`领域 ${esc(filters.domain)}`);
  if (filters?.methodology_id) bits.push(`方法学 ${esc(filters.methodology_id)}`);
  if (filters?.stage) bits.push(`阶段 ${esc(filters.stage_label || filters.stage)}`);
  if (bits.length) {
    const scope = DIRECTORY_METRICS.includes(currentMetric(data, state))
      ? '只作用于项目统计，不改变名录企业数'
      : '只作用于项目数';
    chips.push(`<span class="chip chip-muted">项目筛选：${bits.join('｜')}（${scope}）</span>`);
  }
  if (data?.unknown?.projects?.count) {
    chips.push(`<span class="chip chip-warn">未知省份项目 ${data.unknown.projects.count} 个，未计入 34 地区</span>`);
  }
  return chips.length ? `<div class="region-map-context">${chips.join('')}</div>` : '';
}

function legendHtml(data, state) {
  const metric = currentMetric(data, state);
  const values = (data?.regions || []).map((r) => valueOf(r, metric));
  const scale = buildScale(values);
  const bins = scaleBins(scale, metric);
  const isProject = PROJECT_METRICS.includes(metric);
  const isDirectory = DIRECTORY_METRICS.includes(metric);
  const swatches = [];
  if (!isDirectory) {
    swatches.push('<span class="region-legend-item"><i class="region-legend-swatch is-zero" aria-hidden="true"></i>0'
      + `${isProject ? '（本系统未收录）' : '（真实 0）'}</span>`);
  }
  for (const b of bins) {
    swatches.push(`<span class="region-legend-item"><i class="region-legend-swatch ${b.cls}" aria-hidden="true"></i>${esc(b.label)}</span>`);
  }
  if (!isProject) {
    swatches.push(`<span class="region-legend-item"><i class="region-legend-swatch is-missing" aria-hidden="true"></i>${isDirectory ? '未收录（不补 0）' : '未取得'}</span>`);
  }
  const note = isProject
    ? '项目视图没有缺数据：本系统未收录记 0。'
    : isDirectory
      ? '灰色斜纹为本平台未收录该省名录，不是 0 家；代表已收录范围，不是全省完整数量。'
      : '灰色斜纹为未取得，不是 0。';
  return `<div class="region-map-legend" aria-label="地图图例">`
    + `<span class="region-legend-unit">${isProject ? '单位：个' : isDirectory ? '单位：家' : '单位：tCO2（展示换算为万吨/亿吨）'}</span>`
    + `${swatches.join('')}`
    + `<span class="region-map-legend-note">${esc(note)}</span></div>`;
}

function attributionHtml(state) {
  const s = state.source;
  const url = safeHttpHref(s?.source_url);
  const name = s?.source_name || '阿里云 DataV.GeoAtlas';
  const collected = s?.collected_at ? String(s.collected_at).slice(0, 10) : '—';
  return `<div class="region-map-attribution">
    <span>底图：${url ? `<a class="link" href="${esc(url)}" target="_blank" rel="noreferrer noopener">${esc(name)}</a>` : esc(name)}</span>
    <span>来源记录 <a class="link" href="/v2/assets/maps/source.json" target="_blank" rel="noreferrer noopener">source.json</a></span>
    <span>采集 ${esc(collected)}</span>
    ${s?.sha256 ? `<span class="region-map-hash" title="底图文件 SHA-256">sha256 ${esc(String(s.sha256).slice(0, 12))}…</span>` : ''}
    <span>底图出处不代表本平台另行取得审图号</span>
  </div>`;
}

function fallbackHtml(data, state, error) {
  const metric = currentMetric(data, state);
  return `<div class="region-map-fallback">
    <p class="region-map-fallback-note"><b>底图未加载，已降级为省份列表。</b>统计值仍可用；${esc(error?.message || '底图文件不可用')}。</p>
    <div class="region-map-fallback-grid" role="group" aria-label="省份列表">
      ${(data?.regions || []).map((r) => `<button type="button" class="region-map-fallback-row${String(state.selectedCode) === String(r.code) ? ' is-selected' : ''}" `
        + `data-map-select="${r.code}" aria-pressed="${String(state.selectedCode) === String(r.code) ? 'true' : 'false'}">`
        + `<span>${esc(r.short_name)}</span><b>${esc(displayValue(r, metric))}</b></button>`).join('')}
    </div>
  </div>`;
}

function mapSlotHtml(data, state) {
  if (state.mapError) return fallbackHtml(data, state, state.mapError);
  if (state.geo) return buildRegionSvg(state.geo, data, state);
  if (state.loading) return '<div class="region-map-loading" role="status">正在加载省域数据…</div>';
  return '<div class="region-map-loading" role="status">正在加载本地底图…</div>';
}

function detailRows(data, region, metric) {
  if (!region) return '';
  const isProject = PROJECT_METRICS.includes(metric);
  const isDirectory = DIRECTORY_METRICS.includes(metric);
  const e = region.emission;
  const source = e?.source || region.source || null;
  const metaLabel = isProject ? METRIC_LABEL[metric] : (data?.metric_label || METRIC_LABEL[metric]);
  const dir = region.directory || region.ets_directory || {};
  const rows = [];
  if (isDirectory) {
    rows.push(['指标', metaLabel]);
    rows.push(['单位', '家（本平台已收录数）']);
    rows.push(['名录年度', formatListYear(dir.year || data?.list_year)]);
    rows.push(['本平台收录', Number(dir.count) > 0 ? `${dir.count} 家` : '未收录（不补 0）']);
    rows.push(['覆盖行业', (dir.sectors || []).length ? dir.sectors.join('、') : '行业未标注']);
    if ((dir.missing_sectors || []).length) rows.push(['尚未取得行业', dir.missing_sectors.join('、')]);
    rows.push(['名录采集截止日', dir.as_of || data?.coverage?.directory_as_of || '未取得']);
    rows.push(['覆盖说明', dir.coverage_note || data?.directory_summary?.coverage_note || '未取得']);
    rows.push(['公开项目（当前快照）',
      `${region.project_count} 个（登记 ${region.registered_count}｜减排量登记 ${region.reduction_registered_count}）`]);
    return rows.map(([k, v]) => `<div class="region-kv"><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('');
  }
  rows.push(['指标', isProject ? `${metaLabel}（当前收录快照）` : `${metaLabel}｜${yearLabel(data)}`]);
  rows.push(['单位', isProject ? '个' : isDirectory ? '家' : 'tCO2（页面按万吨/亿吨换算）']);
  rows.push([isProject ? '公开项目（当前快照）' : '公开项目（当前快照，不随排放年度变化）',
    `${region.project_count} 个（登记 ${region.registered_count}｜减排量登记 ${region.reduction_registered_count}）`]);
  if (!isProject) {
    if (dir.available) {
      rows.push(['全国碳市场名录', Number(dir.count) > 0
        ? `本系统收录 ${dir.count} 家（${dir.year} 年；跨年去重 ${dir.all_years_count} 家）`
        : `名录未收录（${dir.year}）`]);
    } else {
      rows.push(['全国碳市场名录', '本系统未收录名录']);
    }
    rows.push(['排放来源类型', source?.source_kind_label || '未取得']);
    rows.push(['记录状态', source?.verification_status === 'source_recorded'
      ? '来源已记录（未独立核实）'
      : (source?.verification_status || '未取得')]);
    if (source?.methodology) rows.push(['核算方法', source.methodology]);
    if (source?.boundary) rows.push(['核算边界', source.boundary]);
    // 排放值和排放截至只来自排放记录；没有排放值时不借用名录采集日期。
    rows.push(['数据截至', e ? (data?.coverage?.emission_as_of || e.collected_at?.slice(0, 10) || '—') : '排放未取得']);
    rows.push(['名录采集日期', data?.coverage?.directory_as_of || '未取得']);
  } else {
    rows.push(['数据截至', data?.coverage?.project_as_of || '—']);
  }
  return rows.map(([k, v]) => `<div class="region-kv"><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('');
}

function directorySourcesHtml(dir) {
  const sources = dir?.sources || [];
  if (!sources.length) return '';
  return `<div class="region-directory-sources">
    <b>名录出处（全部 ${sources.length} 份）</b>
    <ul>${sources.map((s) => {
      const href = safeHttpHref(s.source_url);
      const label = s.source_code || href || '出处代码未标注';
      return `<li>${href
        ? `<a class="link" href="${esc(href)}" target="_blank" rel="noreferrer noopener">${esc(label)}</a>`
        : `<span>${esc(label)}</span>`}
        <span class="muted">${esc(formatEntityCount(s.count))}${s.as_of ? `｜采集 ${esc(s.as_of)}` : ''}</span>
      </li>`;
    }).join('')}</ul>
  </div>`;
}

function detailHtml(data, state) {
  const metric = currentMetric(data, state);
  const region = (data?.regions || []).find((r) => String(r.code) === String(state.selectedCode));
  if (!region) {
    const total = data?.totals || {};
    const missing = data?.data_available === false;
    return `<div class="region-detail region-detail-empty">
      <div class="region-detail-title"><h4>全国概览</h4><span class="muted">34 个省级地区</span></div>
      <div class="region-detail-value">${esc(total.display || '—')}</div>
      <p class="region-detail-meta">${esc(total.label || '')}</p>
      <p class="region-detail-hint">${missing
        ? esc(data?.message || '尚未取得排放记录；不补 0，不显示演示热力。')
        : '点击地图省份、右侧排名或省份下拉，查看该省指标、来源与公开项目。'}</p>
      ${data?.unknown?.projects?.count ? `<p class="region-detail-hint">未知省份项目 ${data.unknown.projects.count} 个，未计入 34 地区。</p>` : ''}
    </div>`;
  }
  const isProject = PROJECT_METRICS.includes(metric);
  const isDirectory = DIRECTORY_METRICS.includes(metric);
  const display = displayValue(region, metric);
  const e = region.emission;
  const source = e?.source || region.source || null;
  const samples = region.samples || [];
  const dir = region.directory || region.ets_directory || {};
  const dirSourceUrl = safeHttpHref(data.directory_source?.source_url);
  if (isDirectory) {
    const meta = `${formatListYear(dir.year || data.list_year)}｜${esc(region.group)}｜本平台已收录，非全省完整数量`;
    return `<div class="region-detail">
      <div class="region-detail-title"><h4>${esc(region.name)}</h4><span class="muted">${esc(region.group)}</span></div>
      <div class="region-detail-value${region.missing ? ' is-missing' : ''}">${esc(display)}</div>
      <p class="region-detail-meta">${meta}</p>
      ${region.missing
        ? `<p class="region-detail-hint">本平台尚未收录该省该名录年度的企业；灰色斜纹表示未收录，不补 0，也不代表该省没有重点排放单位。</p>`
        : ''}
      <dl class="region-kv-list">${detailRows(data, region, metric)}</dl>
      ${directorySourcesHtml(dir)}
      <div class="region-detail-links">
        <a class="link" href="${esc(entityListHref(region))}">在 CEA 企业名录中查看该省</a>
        <a class="link" href="${esc(projectListHref(region))}">该省公开项目</a>
      </div>
      ${samples.length ? `<div class="region-samples"><b>该省公开项目（当前快照）</b>
        <ul>${samples.slice(0, 4).map((p) => `<li><a href="#/projects?province=${encodeURIComponent(region.project_province_label || region.name)}">${esc(p.name)}</a>
          <span class="muted">${esc(stageLabel(p.current_stage))}</span></li>`).join('')}</ul></div>` : ''}
    </div>`;
  }
  const excerpt = source?.excerpt
    ? (source.excerpt.length > 280 ? `${source.excerpt.slice(0, 280)}…` : source.excerpt)
    : null;
  const sourceUrl = safeHttpHref(source?.source_url);
  const meta = isProject
    ? `当前收录快照｜${esc(region.group)}`
    : `${yearLabel(data)}｜${esc(region.group)}｜${esc(source?.source_kind_label || (region.missing ? '排放未取得' : '—'))}｜公开项目为当前快照`;
  return `<div class="region-detail">
    <div class="region-detail-title"><h4>${esc(region.name)}</h4><span class="muted">${esc(region.group)}</span></div>
    <div class="region-detail-value${region.missing ? ' is-missing' : ''}">${esc(display)}</div>
    <p class="region-detail-meta">${meta}</p>
    ${region.missing ? `<p class="region-detail-hint">未取得该省排放记录；不补 0。可切换年度/数据口径或查看数据集来源。</p>` : ''}
    <dl class="region-kv-list">${detailRows(data, region, metric)}</dl>
    ${excerpt ? `<blockquote class="region-evidence"><b>原文证据</b><span>${esc(excerpt)}</span></blockquote>` : ''}
    <div class="region-detail-links">
      ${sourceUrl ? `<a class="link" href="${esc(sourceUrl)}" target="_blank" rel="noreferrer noopener">查看来源原文</a>` : ''}
      <a class="link" href="${projectListHref(region)}">该省公开项目</a>
      ${data.metric === 'national_ets' ? `<a class="link" href="${entityListHref(region)}">全国碳市场名录入口</a>` : ''}
      ${data.metric === 'national_ets' && dirSourceUrl ? `<a class="link" href="${esc(dirSourceUrl)}" target="_blank" rel="noreferrer noopener">名录来源</a>` : ''}
    </div>
    ${samples.length ? `<div class="region-samples"><b>该省公开项目（当前快照）</b>
      <ul>${samples.slice(0, 4).map((p) => `<li><a href="#/projects?province=${encodeURIComponent(region.project_province_label || region.name)}">${esc(p.name)}</a>
        <span class="muted">${esc(stageLabel(p.current_stage))}</span></li>`).join('')}</ul></div>` : ''}
  </div>`;
}

function rankingHtml(data, state) {
  const metric = currentMetric(data, state);
  const ranked = rankRegions(data?.regions || [], metric, state.regionGroup);
  const selected = String(state.selectedCode || '');
  return `<div class="region-ranking">
    <div class="region-ranking-head">
      <div><h4>省份排名</h4><p class="muted">${state.regionGroup ? esc(state.regionGroup) : '全国'}｜按${esc(METRIC_LABEL[metric] || data.metric_label)}降序</p></div>
      <label class="region-province-select"><span class="sr-only">选择省份</span>
        <select data-map-province aria-label="选择省份">
          <option value="">选择省份</option>
          ${(data?.regions || []).map((r) => `<option value="${r.code}" ${selected === String(r.code) ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}
        </select>
      </label>
    </div>
    <div class="region-group-filter" role="group" aria-label="按区域分组排名">
      <button type="button" class="region-group-chip${!state.regionGroup ? ' is-active' : ''}" data-map-group="" aria-pressed="${!state.regionGroup ? 'true' : 'false'}">全国</button>
      ${GROUPS.map((g) => `<button type="button" class="region-group-chip${state.regionGroup === g ? ' is-active' : ''}" data-map-group="${g}" aria-pressed="${state.regionGroup === g ? 'true' : 'false'}">${g}</button>`).join('')}
    </div>
    <ol class="region-rank-list" aria-label="省份排名">
      ${ranked.map((r) => {
        const miss = r.missing;
        const isSel = selected === String(r.code);
        const value = displayValue(r, metric);
        const sub = PROJECT_METRICS.includes(metric)
          ? `登记 ${r.registered_count}｜减排量登记 ${r.reduction_registered_count}`
          : DIRECTORY_METRICS.includes(metric) && (r.directory?.count === null || r.directory?.count === undefined)
            ? `未收录（${r.directory?.year ?? data.list_year ?? '年度未取得'}）`
            : directorySub(r);
        return `<li><button type="button" class="region-rank-row${isSel ? ' is-selected' : ''}${miss ? ' is-missing' : ''}" data-map-select="${r.code}" aria-pressed="${isSel ? 'true' : 'false'}" aria-label="${escapeAttr(`${r.name}，${METRIC_LABEL[metric]} ${value}${miss ? '，未取得' : ''}`)}">
          <span class="region-rank-no">${r.rank ?? '—'}</span>
          <span class="region-rank-name">${esc(r.short_name)}</span>
          <span class="region-rank-value">${esc(value)}</span>
          <span class="region-rank-sub">${esc(sub)}</span>
        </button></li>`;
      }).join('')}
    </ol>
  </div>`;
}

function notesHtml(data) {
  const notes = data?.notes || [];
  const unknown = data?.unknown?.projects;
  const unknownDir = data?.unknown?.directory;
  const isDirectory = data?.metric === DIRECTORY_METRIC;
  const sourceUrl = isDirectory ? null : safeHttpHref(data?.source?.source_url);
  const alerts = Array.isArray(data?.admin_alerts) ? data.admin_alerts : [];
  return `<details class="region-map-notes">
    <summary>统计口径、来源与限制</summary>
    ${alerts.length ? `<div class="region-map-alert" role="alert"><b>管理员提示</b>
      <ul>${alerts.map((n) => `<li>${esc(n)}</li>`).join('')}</ul></div>` : ''}
    <ul>${notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>
    ${unknown?.count ? `<p>未知省份项目：${unknown.count} 个。${esc(unknown.note || '')}</p>
      <p>${(unknown.items || []).map((x) => `${esc(x.province)} ${x.project_count} 个`).join('；')}</p>` : ''}
    ${unknownDir?.count ? `<p>省份无法归并的名录：${unknownDir.count} 家（未计入 34 地区）。</p>` : ''}
    <p>${esc(data?.data_quality?.registered_reduction_note || '')}</p>
    ${isDirectory
      ? `<p>名录出处：共 ${esc(String(data?.directory_summary?.source_count ?? 0))} 份，按省份在右侧详情列示；不把某一省出处当作其他省的来源。</p>`
      : `<p>数据集来源：${esc(data?.source?.source_name || '—')}${sourceUrl ? `｜<a class="link" href="${esc(sourceUrl)}" target="_blank" rel="noreferrer noopener">来源链接</a>` : ''}</p>`}
  </details>`;
}

function directoryHighlightHtml(data, state) {
  const summary = data?.directory_summary;
  if (!summary || !summary.available) return '';
  const current = currentMetric(data, state) === DIRECTORY_METRIC;
  const year = summary.list_year ?? data?.list_year;
  const total = summary.total === null || summary.total === undefined ? '—' : String(summary.total);
  const href = `#/overview?map=${DIRECTORY_METRIC}${year ? `&list_year=${year}` : ''}`;
  return `<div class="region-directory-callout" data-directory-callout>
    <div class="region-directory-copy">
      <p class="region-directory-line"><b>${current ? '当前名录视图' : '最新已收录纳管企业'}</b>
        <strong>${esc(total)}</strong> 家</p>
      <p class="region-directory-sub">覆盖 ${esc(String(summary.covered_regions ?? 0))} 个省级地区 · 名录 ${esc(formatListYear(year))} · ${esc(summary.coverage_note || '本平台已收录，非全国/全省完整数量')}</p>
    </div>
    ${current
      ? '<span class="chip chip-muted" aria-current="true">当前为名录热力图</span>'
      : `<a class="btn btn-sm" href="${esc(href)}" data-directory-link>查看名录热力图</a>`}
  </div>`;
}

function refreshMetaHtml(state) {
  return `<span class="region-map-refresh-meta" data-map-last-refresh role="status">最近成功读取 ${esc(formatReadTime(state.lastSuccessAt))}</span>`;
}

function refreshErrorInnerHtml(state) {
  const err = state.refreshError;
  if (!err) return '';
  return `<div><b>${esc(err.title || '刷新失败，仍显示上次成功数据')}</b>
    <p>${esc(err.message || '数据读取失败，请重试。')}</p></div>
    <button class="btn btn-sm" type="button" data-map-refresh-retry>重试</button>`;
}

function refreshErrorHtml(state) {
  return `<div class="region-map-refresh-error" data-map-refresh-error role="alert" ${state.refreshError ? '' : 'hidden'}>${refreshErrorInnerHtml(state)}</div>`;
}

export function regionMapCardHtml(data, state, { filters = {}, contextProvince = null } = {}) {
  if (!data) return loading('正在加载省域地图…');
  const metric = currentMetric(data, state);
  const exportHref = buildExportHref(data, state, filters);
  return `<section class="card region-map-card" aria-labelledby="region-map-heading">
    <header class="card-head region-map-head">
      <div>
        <h3 id="region-map-heading">省域地图与排放</h3>
        <p class="muted">${esc(subtitleFor(data))}</p>
      </div>
      <div class="card-actions">
        <span class="chip chip-muted" data-map-updating role="status" ${state.loading ? '' : 'hidden'}>更新中…</span>
        ${refreshMetaHtml(state)}
        <button class="btn btn-sm" type="button" data-map-refresh>刷新数据</button>
        <a class="btn btn-sm" data-map-export href="${esc(exportHref)}" download>下载当前 CSV</a>
      </div>
    </header>
    <div class="card-body region-map-body" ${state.loading ? 'aria-busy="true"' : ''}>
      ${directoryHighlightHtml(data, state)}
      <div class="region-map-toolbar">
        ${viewSwitchHtml(data, state)}
        <div class="region-map-toolbar-right">${submetricHtml(data, state)}${emissionControlsHtml(data, state)}</div>
      </div>
      ${filterContextHtml(data, filters, contextProvince, state)}
      ${refreshErrorHtml(state)}
      <div class="region-map-layout">
        <div class="region-map-mapcol">
          <div class="region-map-canvas">
            <div class="region-map-slot" data-map-slot>${mapSlotHtml(data, state)}</div>
            <div class="region-map-tooltip" role="tooltip" aria-hidden="true" hidden></div>
          </div>
          ${legendHtml(data, state)}
          <div class="region-map-attribution-wrap" data-map-attribution>${attributionHtml(state)}</div>
        </div>
        <aside class="region-map-side">
          <div class="region-detail-live" aria-live="polite">${detailHtml(data, state)}</div>
          ${rankingHtml(data, state)}
        </aside>
      </div>
      ${notesHtml(data)}
    </div>
  </section>`;
}

/* ==================================================================== */
/*  五、挂载与交互                                                       */
/* ==================================================================== */

function tooltipLine(el, text, className = '') {
  const div = document.createElement('div');
  if (className) div.className = className;
  div.textContent = text;
  el.appendChild(div);
  return div;
}

function fillTooltip(el, region, metric, data) {
  el.replaceChildren();
  tooltipLine(el, region.name, 'region-tooltip-name');
  tooltipLine(el, `${METRIC_LABEL[metric] || data?.metric_label || '指标'}：${displayValue(region, metric)}`, 'region-tooltip-value');
  if (PROJECT_METRICS.includes(metric)) {
    tooltipLine(el, `登记 ${region.registered_count}｜减排量登记 ${region.reduction_registered_count}`, 'region-tooltip-sub');
  } else if (DIRECTORY_METRICS.includes(metric)) {
    const dir = region.directory || region.ets_directory || {};
    tooltipLine(el, region.missing
      ? '本平台未收录该省该名录年度企业，不补 0'
      : `${formatListYear(dir.year ?? data?.list_year)}｜本平台已收录，非全省完整数量`,
    'region-tooltip-sub');
  } else if (region.missing) {
    tooltipLine(el, '未取得该省排放记录，不补 0', 'region-tooltip-sub');
  } else {
    tooltipLine(el, `${yearLabel(data)}｜${region.source?.source_kind_label || '来源已记录'}`, 'region-tooltip-sub');
  }
  tooltipLine(el, '点击查看右侧详情', 'region-tooltip-hint');
}

function positionTooltip(el, canvas, target, event) {
  if (!el || !canvas || !target) return;
  const cRect = canvas.getBoundingClientRect();
  let x;
  let y;
  if (event && Number.isFinite(event.clientX)) {
    x = event.clientX - cRect.left + 14;
    y = event.clientY - cRect.top + 12;
  } else {
    const r = target.getBoundingClientRect();
    x = r.left - cRect.left + r.width / 2 + 10;
    y = r.top - cRect.top + 8;
  }
  const maxX = Math.max(8, cRect.width - el.offsetWidth - 8);
  const maxY = Math.max(8, cRect.height - el.offsetHeight - 8);
  el.style.left = `${Math.max(8, Math.min(maxX, x))}px`;
  el.style.top = `${Math.max(8, Math.min(maxY, y))}px`;
}

function errorMessage(error) {
  return error?.body?.error || error?.message || String(error || '数据读取失败');
}

export function mountRegionMap({
  root, initialData, filters = {}, contextProvince = null, fetchApi,
}) {
  if (!root) return null;
  let state = createRegionMapState();
  const initialOk = Boolean(initialData && !initialData.__error);
  state.data = initialOk ? initialData : null;
  state.error = initialData?.__error || null;
  state.loading = false;
  state.geo = null;
  state.source = null;
  state.mapError = null;
  state.lastSuccessAt = initialOk ? (initialData.generated_at || new Date().toISOString()) : null;
  if (initialOk) {
    state.view = initialData.view === 'projects' || PROJECT_METRICS.includes(initialData.metric)
      ? 'projects' : initialData.view;
    state.metric = initialData.metric || 'projects';
    state.submetric = PROJECT_METRICS.includes(initialData.metric) ? initialData.metric : 'projects';
    state.year = initialData.year ?? null;
    state.listYear = initialData.list_year ?? null;
    state.dataset = initialData.dataset ?? null;
  }
  const context = String(contextProvince || '').trim();
  if (context && initialData?.regions) {
    const hit = initialData.regions.find((r) => r.name === context || r.short_name === context);
    if (hit) state.selectedCode = hit.code;
  }
  const getPrepared = () => (state.geo ? prepareGeometry(state.geo) : null);
  let loadSeq = 0;
  let disposed = false;
  let refreshInFlight = false;
  let refreshTimer = null;
  let lastFailed = null;
  const REFRESH_INTERVAL = 60000;
  const listeners = {};

  function dataSignature(data) {
    if (!data) return '';
    return JSON.stringify({
      metric: data.metric,
      view: data.view,
      list_year: data.list_year,
      year: data.year,
      dataset: data.dataset,
      totals: data.totals,
      directory_summary: data.directory_summary,
      regions: (data.regions || []).map((r) => [
        r.code, r.value, r.missing, r.directory?.count, r.ets_directory?.count,
        (r.directory?.sources || []).map((s) => [s.source_code, s.count, s.as_of]),
      ]),
    });
  }

  function updateMapSlot() {
    const slot = root.querySelector('[data-map-slot]');
    if (!slot) return;
    slot.innerHTML = mapSlotHtml(state.data, state);
    syncSelectedMarker();
  }

  // 底图与 source 元数据异步取得；只刷新归属行，不重渲染卡片，保留选择/焦点/事件委托。
  function updateAttribution() {
    const wrap = root.querySelector('[data-map-attribution]');
    if (!wrap) return;
    wrap.innerHTML = attributionHtml(state);
  }

  function updateRefreshMeta() {
    const node = root.querySelector('[data-map-last-refresh]');
    if (!node) return;
    node.textContent = `最近成功读取 ${formatReadTime(state.lastSuccessAt)}`;
  }

  function updateFailure() {
    const node = root.querySelector('[data-map-refresh-error]');
    if (!node) return;
    node.innerHTML = refreshErrorInnerHtml(state);
    node.hidden = !state.refreshError;
  }

  function syncSelectedMarker() {
    const svg = root.querySelector('[data-map-svg]');
    if (!svg) return;
    svg.querySelector('#region-selected-marker')?.remove();
    const prepared = getPrepared();
    const g = prepared?.byCode.get(String(state.selectedCode || ''));
    if (!g?.centroid) return;
    const ns = 'http://www.w3.org/2000/svg';
    const group = document.createElementNS(ns, 'g');
    group.setAttribute('id', 'region-selected-marker');
    group.setAttribute('class', 'region-selected-marker');
    group.setAttribute('aria-hidden', 'true');
    group.setAttribute('pointer-events', 'none');
    for (const [r, cls] of [[7, 'region-selected-ring'], [2.8, 'region-selected-dot']]) {
      const c = document.createElementNS(ns, 'circle');
      c.setAttribute('cx', g.centroid[0].toFixed(1));
      c.setAttribute('cy', g.centroid[1].toFixed(1));
      c.setAttribute('r', String(r));
      c.setAttribute('class', cls);
      group.appendChild(c);
    }
    svg.appendChild(group);
  }

  function updateSelectionDom() {
    const code = String(state.selectedCode || '');
    root.querySelectorAll('[data-region-code]').forEach((path) => {
      const on = String(path.dataset.regionCode || '') === code;
      path.classList.toggle('is-selected', on);
      path.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    root.querySelectorAll('[data-map-select]').forEach((el) => {
      const on = String(el.dataset.mapSelect || '') === code;
      el.classList.toggle('is-selected', on);
      el.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    const select = root.querySelector('[data-map-province]');
    if (select) select.value = code;
    const detail = root.querySelector('.region-detail-live');
    if (detail) detail.innerHTML = detailHtml(state.data, state);
    const exportLink = root.querySelector('[data-map-export]');
    if (exportLink) exportLink.href = buildExportHref(state.data, state, filters);
    syncSelectedMarker();
    if (code && typeof window !== 'undefined' && window.matchMedia?.('(max-width: 900px)').matches) {
      const nextDetail = root.querySelector('.region-detail-live');
      nextDetail?.scrollIntoView({ block: 'nearest' });
    }
  }

  function hideTooltip() {
    const tip = root.querySelector('.region-map-tooltip');
    if (!tip) return;
    tip.hidden = true;
    tip.setAttribute('aria-hidden', 'true');
    state = clearHover(state);
  }

  function showTooltip(target, event) {
    const tip = root.querySelector('.region-map-tooltip');
    const canvas = root.querySelector('.region-map-canvas');
    const region = (state.data?.regions || []).find((r) => String(r.code) === String(target.dataset.regionCode));
    if (!tip || !canvas || !region) return;
    state = hoverRegion(state, region.code);
    fillTooltip(tip, region, currentMetric(state.data, state), state.data);
    tip.hidden = false;
    tip.setAttribute('aria-hidden', 'false');
    positionTooltip(tip, canvas, target, event);
  }

  function render({ focus = null } = {}) {
    if (!state.data || state.data.__error) {
      root.innerHTML = dataErrorCard(state.data?.__error || state.error);
      return;
    }
    root.innerHTML = regionMapCardHtml(state.data, state, { filters, contextProvince });
    if (focus) {
      const el = root.querySelector(focus);
      el?.focus({ preventScroll: true });
    }
    if (state.geo) syncSelectedMarker();
    updateRefreshMeta();
    updateFailure();
    setUpdating(Boolean(state.loading));
  }

  function setUpdating(on) {
    const card = root.querySelector('.region-map-card');
    if (card) {
      const body = card.querySelector('.region-map-body');
      if (body) body.setAttribute('aria-busy', on ? 'true' : 'false');
    }
    const chip = root.querySelector('[data-map-updating]');
    if (chip) chip.hidden = !on;
    const exportLink = root.querySelector('[data-map-export]');
    if (exportLink) {
      if (on) exportLink.setAttribute('aria-disabled', 'true');
      else exportLink.removeAttribute('aria-disabled');
    }
    const refreshBtn = root.querySelector('[data-map-refresh]');
    if (refreshBtn) {
      if (on) refreshBtn.setAttribute('aria-disabled', 'true');
      else refreshBtn.removeAttribute('aria-disabled');
    }
  }

  function applyData(data) {
    state.data = data;
    state.view = data.view;
    state.metric = data.metric;
    if (PROJECT_METRICS.includes(data.metric)) state.submetric = data.metric;
    state.year = data.year ?? null;
    if (DIRECTORY_METRICS.includes(data.metric) || state.listYear === null || state.listYear === undefined) {
      state.listYear = data.list_year ?? null;
    }
    state.dataset = data.dataset ?? null;
    state.loading = false;
    state.error = null;
    state.refreshError = null;
    state.lastSuccessAt = data.generated_at || new Date().toISOString();
    lastFailed = null;
    if (state.selectedCode && !(data.regions || []).some((r) => String(r.code) === String(state.selectedCode))) {
      state.selectedCode = null;
    }
  }

  function requestOptions() {
    if (state.view === DIRECTORY_METRIC) return { listYear: state.listYear };
    if (PROJECT_METRICS.includes(state.metric)) return {};
    return { year: state.year, dataset: state.dataset };
  }

  function queryFor(metric, options = {}) {
    const q = new URLSearchParams({ metric });
    for (const key of ['domain', 'methodology_id', 'stage']) {
      if (filters[key]) q.set(key, filters[key]);
    }
    if (metric === DIRECTORY_METRIC) {
      const listYear = options.listYear ?? state.listYear;
      if (listYear) q.set('list_year', String(listYear));
    } else if (!PROJECT_METRICS.includes(metric)) {
      if (options.year ?? state.year) q.set('year', String(options.year ?? state.year));
      if (options.dataset ?? state.dataset) q.set('dataset', options.dataset ?? state.dataset);
    }
    return q.toString();
  }

  async function loadView(metric, options = {}) {
    if (typeof fetchApi !== 'function' || disposed) return;
    const seq = ++loadSeq;
    lastFailed = null;
    state.loading = true;
    state.error = null;
    state.refreshError = null;
    updateFailure();
    setUpdating(true);
    try {
      const data = await fetchApi(`/api/v2/overview/region-map?${queryFor(metric, options)}`);
      if (disposed || seq !== loadSeq) return;
      if (data?.error) throw Object.assign(new Error(data.error), { body: data });
      applyData(data);
      render({ focus: options.focus || null });
    } catch (e) {
      if (disposed || seq !== loadSeq) return;
      state.loading = false;
      if (!state.data) {
        state.error = e;
        render();
      } else {
        state.refreshError = {
          title: `${METRIC_LABEL[metric] || metric}加载失败，仍显示上次成功数据`,
          message: `${errorMessage(e)}。最近成功读取 ${formatReadTime(state.lastSuccessAt)}。`,
        };
        lastFailed = { kind: 'view', metric, options };
        updateFailure();
        setUpdating(false);
      }
    } finally {
      if (!disposed && seq === loadSeq) setUpdating(false);
    }
  }

  async function refresh({ source = 'manual' } = {}) {
    if (typeof fetchApi !== 'function' || disposed || refreshInFlight || state.loading) return false;
    if (!state.data || state.data.__error) {
      void loadView(state.metric || 'projects', requestOptions());
      return false;
    }
    refreshInFlight = true;
    const seq = ++loadSeq;
    const before = dataSignature(state.data);
    state.loading = true;
    state.refreshError = null;
    lastFailed = null;
    updateFailure();
    setUpdating(true);
    try {
      const data = await fetchApi(`/api/v2/overview/region-map?${queryFor(currentMetric(state.data, state), requestOptions())}`);
      if (disposed || seq !== loadSeq) return false;
      if (data?.error) throw Object.assign(new Error(data.error), { body: data });
      const changed = before !== dataSignature(data);
      applyData(data);
      if (changed) {
        render({ focus: source === 'manual' || source === 'retry' ? '[data-map-refresh]' : null });
      } else {
        updateRefreshMeta();
        updateFailure();
      }
      return true;
    } catch (e) {
      if (disposed || seq !== loadSeq) return false;
      state.loading = false;
      state.refreshError = {
        title: '刷新失败，仍显示上次成功数据',
        message: `${errorMessage(e)}。最近成功读取 ${formatReadTime(state.lastSuccessAt)}。`,
      };
      lastFailed = { kind: 'refresh' };
      updateFailure();
      setUpdating(false);
      return false;
    } finally {
      refreshInFlight = false;
      if (!disposed && seq === loadSeq) setUpdating(false);
    }
  }

  function retry() {
    if (lastFailed?.kind === 'view') {
      void loadView(lastFailed.metric, { ...lastFailed.options, focus: lastFailed.options?.focus || null });
    } else {
      void refresh({ source: 'retry' });
    }
  }

  function select(code) {
    state = selectRegion(state, code);
    updateSelectionDom();
  }

  function pageVisible() {
    return typeof document === 'undefined'
      || !document.visibilityState
      || document.visibilityState === 'visible';
  }

  async function onVisibilityChange() {
    if (disposed || !pageVisible()) return;
    await refresh({ source: 'visibility' });
  }

  const onClick = (e) => {
    const target = e.target;
    const closest = (sel) => target?.closest?.(sel) || null;
    const exportLink = closest('[data-map-export]');
    if (exportLink && (state.loading || exportLink.getAttribute('aria-disabled') === 'true')) {
      e.preventDefault();
      return;
    }
    const refreshBtn = closest('[data-map-refresh]');
    if (refreshBtn) {
      e.preventDefault();
      if (state.loading || refreshInFlight) return;
      void refresh({ source: 'manual' });
      return;
    }
    if (closest('[data-map-refresh-retry]')) {
      e.preventDefault();
      retry();
      return;
    }
    const view = closest('[data-map-view]');
    if (view) {
      const next = view.dataset.mapView;
      if (next === state.view) return;
      if (next === 'projects') void loadView('projects', { focus: '[data-map-view="projects"]' });
      else void loadView(next, { focus: `[data-map-view="${next}"]` });
      return;
    }
    const sub = closest('[data-map-submetric]');
    if (sub) {
      state.submetric = sub.dataset.mapSubmetric;
      state.metric = state.submetric;
      render({ focus: `[data-map-submetric="${state.submetric}"]` });
      return;
    }
    const group = closest('[data-map-group]');
    if (group) {
      state.regionGroup = group.dataset.mapGroup || '';
      render({ focus: `[data-map-group="${state.regionGroup}"]` });
      return;
    }
    const pick = closest('[data-map-select]');
    if (pick) {
      select(pick.dataset.mapSelect);
      return;
    }
    if (closest('[data-map-retry]')) {
      if (!state.data || state.data.__error) {
        void loadView(state.metric || 'projects', requestOptions());
      } else {
        state.mapError = null;
        loadChinaMap({ force: true }).then(({ geo, source }) => {
          if (disposed) return;
          state.geo = geo;
          state.source = source;
          updateMapSlot();
          updateAttribution();
        }).catch((err) => {
          if (disposed) return;
          state.mapError = err;
          updateMapSlot();
          updateAttribution();
        });
      }
    }
  };

  const onChange = (e) => {
    const target = e.target;
    const closest = (sel) => target?.closest?.(sel) || null;
    const listYear = closest('[data-map-list-year]');
    if (listYear) {
      void loadView(DIRECTORY_METRIC, {
        listYear: Number(listYear.value),
        focus: '[data-map-list-year]',
      });
      return;
    }
    const year = closest('[data-map-year]');
    if (year) {
      void loadView(state.view, { year: Number(year.value), focus: '[data-map-year]' });
      return;
    }
    const dataset = closest('[data-map-dataset]');
    if (dataset) {
      void loadView(state.view, { year: state.year, dataset: dataset.value, focus: '[data-map-dataset]' });
      return;
    }
    const province = closest('[data-map-province]');
    if (province && province.value) select(province.value);
  };

  const onPointerOver = (e) => {
    const path = e.target?.closest?.('[data-region-code]');
    if (!path) return;
    showTooltip(path, e);
  };
  const onPointerMove = (e) => {
    const path = e.target?.closest?.('[data-region-code]');
    if (!path) return;
    const tip = root.querySelector('.region-map-tooltip');
    const canvas = root.querySelector('.region-map-canvas');
    if (tip && !tip.hidden) positionTooltip(tip, canvas, path, e);
  };
  const onPointerOut = (e) => {
    const path = e.target?.closest?.('[data-region-code]');
    if (!path) return;
    const to = e.relatedTarget;
    if (to && to.closest && to.closest('[data-region-code]')) return;
    hideTooltip();
  };
  const onPointerLeave = () => hideTooltip();
  const onFocusIn = (e) => {
    const path = e.target?.closest?.('[data-region-code]');
    if (!path) return;
    showTooltip(path, null);
  };
  const onFocusOut = (e) => {
    const path = e.target?.closest?.('[data-region-code]');
    if (!path) return;
    const to = e.relatedTarget;
    if (to && to.closest && to.closest('[data-region-code]')) return;
    hideTooltip();
  };
  const onKeyDown = (e) => {
    const path = e.target?.closest?.('[data-region-code]');
    if (!path) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      select(path.dataset.regionCode);
    } else if (e.key === 'Escape') {
      hideTooltip();
    }
  };

  listeners.click = onClick;
  listeners.change = onChange;
  listeners.pointerover = onPointerOver;
  listeners.pointermove = onPointerMove;
  listeners.pointerout = onPointerOut;
  listeners.pointerleave = onPointerLeave;
  listeners.focusin = onFocusIn;
  listeners.focusout = onFocusOut;
  listeners.keydown = onKeyDown;
  for (const [type, fn] of Object.entries(listeners)) root.addEventListener(type, fn);

  render();
  loadChinaMap().then(({ geo, source }) => {
    if (disposed) return;
    state.geo = geo;
    state.source = source;
    updateMapSlot();
    updateAttribution();
  }).catch((err) => {
    if (disposed) return;
    state.mapError = err;
    updateMapSlot();
    updateAttribution();
  });

  // 只读轻量刷新：60 秒一次，标签页重新可见时立即一次；失败保留上次成功数据。
  if (typeof fetchApi === 'function') {
    refreshTimer = setInterval(() => {
      if (!disposed && pageVisible()) void refresh({ source: 'auto' });
    }, REFRESH_INTERVAL);
    refreshTimer?.unref?.();
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      document.addEventListener('visibilitychange', onVisibilityChange);
    }
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    loadSeq += 1;
    if (refreshTimer !== null) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
    if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
      document.removeEventListener('visibilitychange', onVisibilityChange);
    }
    for (const [type, fn] of Object.entries(listeners)) {
      try { root.removeEventListener?.(type, fn); } catch { /* 旧 DOM 桩可能没有 removeEventListener */ }
    }
    state.refreshError = null;
  }

  // 地图加载完成后若用户已经选择，标记点由 updateMapSlot 内的 syncSelectedMarker 补齐。
  return {
    getState: () => state,
    select,
    loadView,
    refresh,
    retry,
    dispose,
    isDestroyed: () => disposed,
  };
}
