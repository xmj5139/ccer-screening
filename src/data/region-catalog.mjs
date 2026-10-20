/**
 * 中国省级行政区目录与规范化
 * ============================================================================
 * 用途（docs/59）：
 *   - 省域地图固定返回 34 个省级地区，不因项目库缺数而减少；
 *   - 项目/名录里的省份文本可能写作简称、全称或自治区全称，统一归并；
 *   - 只接受省级行政区名称，不从项目名称、城市名或地址推测省份；
 *   - 无法识别的省份单独列为 unknown，不塞进任一省份。
 *
 * 编码采用与本地 DataV 底图 properties.adcode 一致的六位行政区划代码，
 * 前端直接用 adcode 关联底图，不再维护第二套编码。
 */

/** 七个必需导航分组 + 港澳台单独分组（底图含港澳台，避免强行归入地理大区）。 */
export const REGION_GROUPS = [
  { key: '华北', label: '华北' },
  { key: '东北', label: '东北' },
  { key: '华东', label: '华东' },
  { key: '华中', label: '华中' },
  { key: '华南', label: '华南' },
  { key: '西南', label: '西南' },
  { key: '西北', label: '西北' },
  { key: '港澳台', label: '港澳台' },
];

export const REGION_GROUP_KEYS = REGION_GROUPS.map((g) => g.key);

/**
 * 34 个省级地区。
 * aliases 只放省级简称/历史常用全称，不放城市、区县、地理方位。
 */
export const PROVINCES = [
  { code: '110000', name: '北京市', short_name: '北京', group: '华北', aliases: [] },
  { code: '120000', name: '天津市', short_name: '天津', group: '华北', aliases: [] },
  { code: '130000', name: '河北省', short_name: '河北', group: '华北', aliases: [] },
  { code: '140000', name: '山西省', short_name: '山西', group: '华北', aliases: [] },
  { code: '150000', name: '内蒙古自治区', short_name: '内蒙古', group: '华北', aliases: ['内蒙'] },
  { code: '210000', name: '辽宁省', short_name: '辽宁', group: '东北', aliases: [] },
  { code: '220000', name: '吉林省', short_name: '吉林', group: '东北', aliases: [] },
  { code: '230000', name: '黑龙江省', short_name: '黑龙江', group: '东北', aliases: [] },
  { code: '310000', name: '上海市', short_name: '上海', group: '华东', aliases: [] },
  { code: '320000', name: '江苏省', short_name: '江苏', group: '华东', aliases: [] },
  { code: '330000', name: '浙江省', short_name: '浙江', group: '华东', aliases: [] },
  { code: '340000', name: '安徽省', short_name: '安徽', group: '华东', aliases: [] },
  { code: '350000', name: '福建省', short_name: '福建', group: '华东', aliases: [] },
  { code: '360000', name: '江西省', short_name: '江西', group: '华东', aliases: [] },
  { code: '370000', name: '山东省', short_name: '山东', group: '华东', aliases: [] },
  { code: '410000', name: '河南省', short_name: '河南', group: '华中', aliases: [] },
  { code: '420000', name: '湖北省', short_name: '湖北', group: '华中', aliases: [] },
  { code: '430000', name: '湖南省', short_name: '湖南', group: '华中', aliases: [] },
  { code: '440000', name: '广东省', short_name: '广东', group: '华南', aliases: [] },
  { code: '450000', name: '广西壮族自治区', short_name: '广西', group: '华南', aliases: [] },
  { code: '460000', name: '海南省', short_name: '海南', group: '华南', aliases: [] },
  { code: '500000', name: '重庆市', short_name: '重庆', group: '西南', aliases: [] },
  { code: '510000', name: '四川省', short_name: '四川', group: '西南', aliases: [] },
  { code: '520000', name: '贵州省', short_name: '贵州', group: '西南', aliases: [] },
  { code: '530000', name: '云南省', short_name: '云南', group: '西南', aliases: [] },
  { code: '540000', name: '西藏自治区', short_name: '西藏', group: '西南', aliases: [] },
  { code: '610000', name: '陕西省', short_name: '陕西', group: '西北', aliases: [] },
  { code: '620000', name: '甘肃省', short_name: '甘肃', group: '西北', aliases: [] },
  { code: '630000', name: '青海省', short_name: '青海', group: '西北', aliases: [] },
  { code: '640000', name: '宁夏回族自治区', short_name: '宁夏', group: '西北', aliases: [] },
  {
    code: '650000', name: '新疆维吾尔自治区', short_name: '新疆', group: '西北',
    // 公开项目库中的「新疆建设兵团」等写法受控归并到新疆，不据此猜测其他层级。
    aliases: ['新疆建设兵团', '新疆生产建设兵团', '新疆兵团'],
  },
  { code: '710000', name: '台湾省', short_name: '台湾', group: '港澳台', aliases: [] },
  { code: '810000', name: '香港特别行政区', short_name: '香港', group: '港澳台', aliases: [] },
  { code: '820000', name: '澳门特别行政区', short_name: '澳门', group: '港澳台', aliases: [] },
];

export const PROVINCE_BY_CODE = new Map(PROVINCES.map((p) => [p.code, p]));
export const PROVINCE_BY_NAME = new Map(PROVINCES.map((p) => [p.name, p]));

const ALIAS = new Map();
for (const p of PROVINCES) {
  ALIAS.set(p.name, p);
  ALIAS.set(p.short_name, p);
  for (const a of p.aliases || []) ALIAS.set(a, p);
}

/** 只删除空白与括号补充说明，不做模糊匹配。 */
function cleanProvinceText(raw) {
  if (raw === null || raw === undefined) return '';
  return String(raw)
    .replace(/\u3000/g, ' ')
    .replace(/\s+/g, '')
    .replace(/[（(][^（）()]*[)）]/g, '')
    .trim();
}

/**
 * 省份文本归并。
 * @param {unknown} raw 原始省份文本
 * @returns {{code:string,name:string,short_name:string,group:string}|null}
 *   无法确认是省级行政区时返回 null（调用方必须计入 unknown，不能猜测）。
 */
export function normalizeProvince(raw) {
  let s = cleanProvinceText(raw);
  if (!s) return null;
  // 极少数公开表会写「中国广东省」「中华人民共和国广东省」；仅在前缀被去掉后
  // 能精确命中目录时才接受，不据此推断其他层级。
  s = s.replace(/^(中华人民共和国|中国)/, '');
  const direct = ALIAS.get(s);
  if (direct) return direct;

  // 自治区/特别行政区全称的简称归并（例如 广西壮族自治区 → 广西）。
  const suffixes = ['壮族自治区', '回族自治区', '维吾尔自治区', '特别行政区', '自治区', '省', '市'];
  for (const suffix of suffixes) {
    if (!s.endsWith(suffix)) continue;
    const base = s.slice(0, -suffix.length);
    const hit = ALIAS.get(base);
    if (hit) return hit;
  }
  return null;
}

/** 按六位代码取省份；代码不存在返回 null（不是 unknown 省份文本）。 */
export function provinceByCode(code) {
  return PROVINCE_BY_CODE.get(String(code || '').trim()) || null;
}

/** 是否为七个导航分组之一。 */
export function isRegionGroup(value) {
  return REGION_GROUP_KEYS.includes(String(value || ''));
}

/** 只暴露地图所需的稳定字段，避免把别名表整体发给前端。 */
export function regionCatalog() {
  return PROVINCES.map((p) => ({
    code: p.code,
    name: p.name,
    short_name: p.short_name,
    group: p.group,
  }));
}

/** 34 个地区的固定顺序（按代码），用于 API、导出和测试稳定排序。 */
export const PROVINCE_CODES = PROVINCES.map((p) => p.code);
