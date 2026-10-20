/**
 * 省域排放公开源采集（docs/61）
 * ============================================================================
 * 唯一来源：Carbon Monitor-China 固定公开 CSV（无需 Key）。
 *   https://datas.carbonmonitor.org/API/downloadFullDataset.php?source=carbon_china
 *
 * 纪律：
 *   - 只采这一个 HTTPS 固定端点，不调用模型、不调用付费 API、不读凭据；
 *   - 下载有界：约 90 秒超时、最大 32 MB、并发 1、重定向不得越出固定公开源域名；
 *   - CSV 字段 state/date/sector/value，日期按 DD/MM/YYYY；31 省受控映射，山西/陕西分开；
 *   - 每年每省五个部门各完整 365/366 日才汇总；单位 MtCO2/day 先逐日求和再 ×1e6，
 *     不平均、不年化、不把缺部门记 0；
 *   - 只导入上一完整年度及更早的完整年份；源文件缺省/缺部门时逐条列出原因，不伪造完整；
 *   - 通过既有 importRegionRecords 幂等/修订；原件 hash 相同则跳过入库，只更新 last_check；
 *   - 失败绝不删除已有值，也不把检查时间写成数据更新时间；
 *   - 最新原始 CSV 与小型采集回执写入 archiveDir（默认 data/regional-collect）。
 *
 * 本模块导出纯解析函数与可注入 fetch 的下载/采集函数，测试不访问真实服务。
 */
import { createHash } from 'node:crypto';
import {
  existsSync, mkdirSync, readFileSync, writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { all } from '../core/db.mjs';
import { nowIso } from '../core/util.mjs';
import { importRegionRecords } from './region-map-svc.mjs';

export const CARBONMONITOR_SOURCE_URL =
  'https://datas.carbonmonitor.org/API/downloadFullDataset.php?source=carbon_china';
export const CARBONMONITOR_SOURCE_HOMEPAGE = 'https://cn.carbonmonitor.org/';
export const CARBONMONITOR_SOURCE_HOST = 'datas.carbonmonitor.org';
export const CARBONMONITOR_DATASET_KEY = 'carbonmonitor-china-five-sectors';
export const CARBONMONITOR_SOURCE_NAME = 'Carbon Monitor-China（研究估算）';
export const CARBONMONITOR_METHODOLOGY =
  'Carbon Monitor-China五部门日排放逐日汇总；原始单位MtCO2/day × 1,000,000归一为tCO2/年';
export const CARBONMONITOR_BOUNDARY =
  '电力、工业、地面交通、国内航空、居民消费五部门研究估算；不等于官方省级全社会温室气体清单，'
  + '不含土地利用等其他部门；排除源文件缺部门地区。';
export const CARBONMONITOR_SECTORS = Object.freeze([
  'Power', 'Industry', 'Ground Transport', 'Aviation', 'Residential',
]);
export const MAX_DOWNLOAD_BYTES = 32 * 1024 * 1024;
export const DOWNLOAD_TIMEOUT_MS = 90000;
export const MAX_REDIRECTS = 5;
export const DEFAULT_ARCHIVE_DIR = resolve(process.cwd(), 'data', 'regional-collect');

/** 源文件英文州名到中国省级行政区代码的受控映射；山西 Shanxi ≠ 陕西 Shaanxi。 */
export const CARBONMONITOR_STATES = Object.freeze({
  Beijing: ['110000', '北京市'],
  Tianjin: ['120000', '天津市'],
  Hebei: ['130000', '河北省'],
  Shanxi: ['140000', '山西省'],
  'Inner Mongolia': ['150000', '内蒙古自治区'],
  Liaoning: ['210000', '辽宁省'],
  Jilin: ['220000', '吉林省'],
  Heilongjiang: ['230000', '黑龙江省'],
  Shanghai: ['310000', '上海市'],
  Jiangsu: ['320000', '江苏省'],
  Zhejiang: ['330000', '浙江省'],
  Anhui: ['340000', '安徽省'],
  Fujian: ['350000', '福建省'],
  Jiangxi: ['360000', '江西省'],
  Shandong: ['370000', '山东省'],
  Henan: ['410000', '河南省'],
  Hubei: ['420000', '湖北省'],
  Hunan: ['430000', '湖南省'],
  Guangdong: ['440000', '广东省'],
  Guangxi: ['450000', '广西壮族自治区'],
  Hainan: ['460000', '海南省'],
  Chongqing: ['500000', '重庆市'],
  Sichuan: ['510000', '四川省'],
  Guizhou: ['520000', '贵州省'],
  Yunnan: ['530000', '云南省'],
  Tibet: ['540000', '西藏自治区'],
  Shaanxi: ['610000', '陕西省'],
  Gansu: ['620000', '甘肃省'],
  Qinghai: ['630000', '青海省'],
  Ningxia: ['640000', '宁夏回族自治区'],
  Xinjiang: ['650000', '新疆维吾尔自治区'],
});

const SCALE = 10n ** 13n;
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function daysInYear(year) {
  return new Date(Date.UTC(year, 1, 29)).getUTCDate() === 29 ? 366 : 365;
}

function normalizeIso(value) {
  if (!value) return nowIso();
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? nowIso() : d.toISOString();
}

function formatScaled(scaled) {
  const text = scaled.toString().padStart(14, '0');
  const whole = text.slice(0, -13);
  const frac = text.slice(-13).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
}

function parseMtValue(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return { error: '数值为空' };
  if (CONTROL_RE.test(s) || !/^\d+(?:\.\d{1,13})?$/.test(s)) {
    return { error: `数值不是非负有限十进制数：${s.slice(0, 40)}` };
  }
  const [whole, frac = ''] = s.split('.');
  try {
    return { scaled: BigInt(whole) * SCALE + BigInt(frac.padEnd(13, '0')) };
  } catch {
    return { error: `数值无法解析：${s.slice(0, 40)}` };
  }
}

/** 严格 DD/MM/YYYY，并校验真实日历日（拒绝 30/02/2024）。 */
export function parseCarbonMonitorDate(raw) {
  const s = String(raw ?? '').trim();
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s);
  if (!m) return { ok: false, error: `日期必须是 DD/MM/YYYY：${s.slice(0, 20)}` };
  const day = Number(m[1]);
  const month = Number(m[2]);
  const year = Number(m[3]);
  const dt = new Date(Date.UTC(year, month - 1, day));
  if (dt.getUTCFullYear() !== year || dt.getUTCMonth() !== month - 1 || dt.getUTCDate() !== day) {
    return { ok: false, error: `日期不是真实日历日：${s.slice(0, 20)}` };
  }
  return {
    ok: true,
    year,
    month,
    day,
    iso: `${String(year).padStart(4, '0')}-${m[2]}-${m[1]}`,
  };
}

/** 支持双引号、转义双引号与字段内逗号的最小 CSV 行解析。 */
export function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else if (ch === '"') {
        quoted = false;
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (quoted) return null;
  out.push(cur);
  return out;
}

function isErrorBody(text) {
  const head = String(text || '').replace(/^\uFEFF/, '').trimStart().slice(0, 200).toLowerCase();
  return head.startsWith('<') || head.startsWith('{') || head.startsWith('[');
}

/**
 * 解析 Carbon Monitor-China CSV。
 * @param {string} text 原始 CSV 文本
 * @param {{lastCompleteYear?:number, now?:string, snapshotHash?:string}} [opts]
 * @returns {{ok:boolean,error?:string,annual:Array,excluded:Array,ignored:Array,anomalies:Array,stats:object}}
 */
export function parseCarbonMonitorCsv(text, opts = {}) {
  const input = String(text ?? '').replace(/^\uFEFF/, '');
  if (!input.trim()) {
    return { ok: false, error: 'CSV 内容为空' };
  }
  if (isErrorBody(input)) {
    return { ok: false, error: '返回内容为 HTML/JSON 错误体，不是 CSV' };
  }
  const lines = input.split(/\r?\n/);
  let headerIndex = -1;
  let header = null;
  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i].trim()) continue;
    header = parseCsvLine(lines[i]);
    if (!header) return { ok: false, error: `CSV 表头引号不闭合（第 ${i + 1} 行）` };
    headerIndex = i;
    break;
  }
  if (!header) return { ok: false, error: 'CSV 缺少表头' };
  const headerNorm = header.map((h) => h.trim().toLowerCase());
  const idx = { state: headerNorm.indexOf('state'), date: headerNorm.indexOf('date'), sector: headerNorm.indexOf('sector'), value: headerNorm.indexOf('value') };
  if (Object.values(idx).some((n) => n < 0)) {
    return { ok: false, error: 'CSV 表头必须包含 state/date/sector/value' };
  }
  const requiredIndex = Math.max(idx.state, idx.date, idx.sector, idx.value);
  const now = normalizeIso(opts.now);
  const currentYear = Number(now.slice(0, 4));
  const lastCompleteYear = Number.isInteger(opts.lastCompleteYear)
    ? opts.lastCompleteYear : currentYear - 1;
  const snapshotHash = opts.snapshotHash || null;
  const groups = new Map();
  const anomalies = [];
  let anomalyTotal = 0;
  let dataRows = 0;
  let duplicateSame = 0;

  const addAnomaly = (line, error) => {
    anomalyTotal += 1;
    if (anomalies.length < 200) anomalies.push({ line, error });
  };

  for (let i = headerIndex + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim()) continue;
    dataRows += 1;
    const cells = parseCsvLine(line);
    if (!cells) {
      addAnomaly(i + 1, 'CSV 行引号不闭合');
      continue;
    }
    if (cells.length <= requiredIndex) {
      addAnomaly(i + 1, `字段数不足（需要至少 ${requiredIndex + 1} 列）`);
      continue;
    }
    const state = cells[idx.state].trim();
    const dateText = cells[idx.date].trim();
    const sector = cells[idx.sector].trim();
    const valueText = cells[idx.value].trim();
    const province = CARBONMONITOR_STATES[state];
    if (!province) {
      addAnomaly(i + 1, `未知州/省名称：${state || '（空）'}`);
      continue;
    }
    const date = parseCarbonMonitorDate(dateText);
    if (!date.ok) {
      addAnomaly(i + 1, date.error);
      continue;
    }
    const groupKey = `${state}|${date.year}`;
    let group = groups.get(groupKey);
    if (!group) {
      group = {
        state, year: date.year, values: new Map(), datesBySector: new Map(),
        conflict: false, conflictDetails: [], invalid: false, invalidDetails: [],
      };
      groups.set(groupKey, group);
    }
    if (!CARBONMONITOR_SECTORS.includes(sector)) {
      group.invalid = true;
      group.invalidDetails.push(`未知部门「${sector}」`);
      addAnomaly(i + 1, `未知部门：${sector || '（空）'}`);
      continue;
    }
    const parsedValue = parseMtValue(valueText);
    if (parsedValue.error) {
      group.invalid = true;
      group.invalidDetails.push(`非法数值「${valueText.slice(0, 30)}」`);
      addAnomaly(i + 1, parsedValue.error);
      continue;
    }
    const valueKey = `${date.iso}|${sector}`;
    if (group.values.has(valueKey)) {
      if (group.values.get(valueKey) === parsedValue.scaled) {
        duplicateSame += 1;
      } else {
        group.conflict = true;
        group.conflictDetails.push(`${date.iso} ${sector} 同日重复出现不同值`);
        addAnomaly(i + 1, `重复冲突：${date.iso} ${sector} 同键不同值`);
      }
      continue;
    }
    group.values.set(valueKey, parsedValue.scaled);
    if (!group.datesBySector.has(sector)) group.datesBySector.set(sector, new Set());
    group.datesBySector.get(sector).add(date.iso);
  }

  const annual = [];
  const excluded = [];
  const ignored = [];
  for (const group of groups.values()) {
    const days = daysInYear(group.year);
    const coverage = {};
    for (const sector of CARBONMONITOR_SECTORS) {
      coverage[sector] = group.datesBySector.get(sector)?.size || 0;
    }
    const reasons = [];
    if (group.conflict) reasons.push(`存在重复冲突：${group.conflictDetails.slice(0, 2).join('；')}`);
    if (group.invalid) reasons.push(`存在非法数据：${[...new Set(group.invalidDetails)].slice(0, 3).join('；')}`);
    const missingSectors = CARBONMONITOR_SECTORS.filter((s) => coverage[s] === 0);
    const shortSectors = CARBONMONITOR_SECTORS.filter((s) => coverage[s] > 0 && coverage[s] < days);
    if (missingSectors.length) reasons.push(`缺少部门：${missingSectors.join('、')}`);
    if (shortSectors.length) {
      reasons.push(`部门覆盖不足：${shortSectors.map((s) => `${s} ${coverage[s]}/${days} 日`).join('、')}`);
    }

    if (group.year > lastCompleteYear) {
      ignored.push({
        state: group.state,
        province_code: CARBONMONITOR_STATES[group.state][0],
        year: group.year,
        coverage,
        expected_days: days,
        records: group.values.size,
        reason: group.year > currentYear
          ? `${group.year} 年超出当前年度，不作为全年`
          : `${group.year} 年数据未满全年（完整年份最高为 ${lastCompleteYear}），不作为全年`,
      });
      continue;
    }
    if (reasons.length) {
      excluded.push({
        state: group.state,
        province_code: CARBONMONITOR_STATES[group.state][0],
        year: group.year,
        coverage,
        expected_days: days,
        records: group.values.size,
        reason: reasons.join('；'),
      });
      continue;
    }
    let sumScaled = 0n;
    for (const value of group.values.values()) sumScaled += value;
    const totalMt = formatScaled(sumScaled);
    const yearValue = Number(sumScaled) / 1e7; // Mt/day × 1e6，scale 1e13
    const [provinceCode, provinceName] = CARBONMONITOR_STATES[group.state];
    annual.push({
      province: provinceName,
      province_code: provinceCode,
      scope: 'region_co2',
      year: group.year,
      value_tco2: yearValue,
      unit: 'tCO2',
      methodology: CARBONMONITOR_METHODOLOGY,
      boundary: CARBONMONITOR_BOUNDARY,
      dataset_key: CARBONMONITOR_DATASET_KEY,
      source_name: CARBONMONITOR_SOURCE_NAME,
      source_url: CARBONMONITOR_SOURCE_URL,
      source_kind: 'research',
      published_at: null,
      excerpt:
        `原始CSV state=${group.state}, date=01/01/${group.year}—31/12/${group.year}，`
        + `5部门各${days}日，共${days * 5}条；value列合计${totalMt} MtCO2，`
        + `换算${yearValue} tCO2。`,
      snapshot_hash: snapshotHash,
      collected_at: now,
    });
  }
  annual.sort((a, b) => a.year - b.year || a.province_code.localeCompare(b.province_code));
  excluded.sort((a, b) => a.state.localeCompare(b.state) || a.year - b.year);
  ignored.sort((a, b) => a.state.localeCompare(b.state) || a.year - b.year);
  return {
    ok: true,
    annual,
    excluded,
    ignored,
    anomalies,
    stats: {
      data_rows: dataRows,
      duplicate_same: duplicateSame,
      complete_records: annual.length,
      excluded_records: excluded.length,
      ignored_records: ignored.length,
      anomaly_count: anomalyTotal,
      last_complete_year: lastCompleteYear,
    },
  };
}

function assertAllowedSourceUrl(text) {
  const u = new URL(text);
  if (u.protocol !== 'https:') throw new Error('只允许 https 固定公开源');
  if (u.username || u.password) throw new Error('来源地址不得包含凭据');
  if (u.hostname.toLowerCase() !== CARBONMONITOR_SOURCE_HOST) {
    throw new Error(`重定向越出固定公开源域名：${u.hostname}`);
  }
  if (u.port && u.port !== '443') throw new Error('固定公开源不允许非标准端口');
  return u;
}

async function readBodyLimited(res, maxBytes) {
  const declared = Number(res.headers?.get?.('content-length') || 0);
  if (Number.isFinite(declared) && declared > maxBytes) {
    try { await res.body?.cancel?.(); } catch { /* ignore */ }
    throw new Error(`响应体超过上限（${declared} > ${maxBytes} 字节）`);
  }
  if (res.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value);
        total += chunk.length;
        if (total > maxBytes) {
          try { await reader.cancel(); } catch { /* ignore */ }
          throw new Error(`响应体超过上限（>${maxBytes} 字节）`);
        }
        chunks.push(chunk);
      }
    } finally {
      try { reader.releaseLock?.(); } catch { /* ignore */ }
    }
    return Buffer.concat(chunks);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length > maxBytes) throw new Error(`响应体超过上限（>${maxBytes} 字节）`);
  return buffer;
}

/**
 * 有界下载固定公开 CSV。测试可注入 fetchImpl；不会调用其他域名。
 */
export async function downloadCarbonMonitorCsv(opts = {}) {
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('当前运行环境没有 fetch，无法采集');
  const timeoutMs = Number(opts.timeoutMs) || DOWNLOAD_TIMEOUT_MS;
  const maxBytes = Number(opts.maxBytes) || MAX_DOWNLOAD_BYTES;
  let url = CARBONMONITOR_SOURCE_URL;
  assertAllowedSourceUrl(url);
  let redirects = 0;
  // 总期限覆盖所有重定向与正文读取；每跳只使用剩余时间，不能逐跳重置。
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`下载超时（>${timeoutMs} ms）`);
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { controller.abort(); } catch { /* ignore */ }
    }, remaining);
    try {
      const res = await fetchImpl(url, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: { accept: 'text/csv,text/plain;q=0.9,*/*;q=0.1' },
      });
      if ([301, 302, 303, 307, 308].includes(Number(res.status))) {
        const location = res.headers?.get?.('location');
        try { await res.body?.cancel?.(); } catch { /* ignore */ }
        if (!location) throw new Error('重定向缺少 Location');
        redirects += 1;
        if (redirects > MAX_REDIRECTS) throw new Error(`重定向超过 ${MAX_REDIRECTS} 次`);
        const next = new URL(location, url);
        assertAllowedSourceUrl(next.toString());
        url = next.toString();
        continue;
      }
      const contentType = String(res.headers?.get?.('content-type') || '').toLowerCase();
      if (contentType.includes('text/html') || contentType.includes('application/json')) {
        try { await res.body?.cancel?.(); } catch { /* ignore */ }
        throw new Error(`响应类型不是 CSV（${contentType || '未声明'}）`);
      }
      let buffer;
      try {
        // 计时器覆盖响应体读取；超时会 abort，读取循环收到 AbortError。
        buffer = await readBodyLimited(res, maxBytes);
      } catch (e) {
        if (timedOut || e?.name === 'AbortError') throw new Error(`下载超时（>${timeoutMs} ms）`);
        throw new Error(`读取响应失败：${e.message}`);
      }
      if (!res.ok) {
        const snippet = buffer.toString('utf8', 0, Math.min(buffer.length, 300)).replace(/\s+/g, ' ').trim();
        throw new Error(`HTTP ${res.status} ${res.statusText || ''}：${snippet || '响应体为空'}`);
      }
      const text = buffer.toString('utf8').replace(/^\uFEFF/, '');
      if (isErrorBody(text)) throw new Error('响应体是 HTML/JSON 错误页，不是 CSV');
      return {
        ok: true,
        url: CARBONMONITOR_SOURCE_URL,
        final_url: url,
        bytes: buffer.length,
        sha256: sha256(buffer),
        csv: text,
        buffer,
      };
    } catch (e) {
      if (timedOut || e?.name === 'AbortError') throw new Error(`下载超时（>${timeoutMs} ms）`);
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }
}

function archivePaths(archiveDir) {
  return {
    raw: join(archiveDir, 'carbonmonitor-china-dataset.csv'),
    receipt: join(archiveDir, 'last-receipt.json'),
  };
}

function previousReceipt(archiveDir) {
  try {
    return JSON.parse(readFileSync(archivePaths(archiveDir).receipt, 'utf8'));
  } catch {
    return null;
  }
}

function writeReceipt(archiveDir, receipt) {
  mkdirSync(archiveDir, { recursive: true });
  const path = archivePaths(archiveDir).receipt;
  writeFileSync(path, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  return path;
}

function writeRawIfNeeded(archiveDir, buffer, hash) {
  const path = archivePaths(archiveDir).raw;
  const previous = previousReceipt(archiveDir);
  if (!existsSync(path) || previous?.sha256 !== hash) {
    mkdirSync(archiveDir, { recursive: true });
    writeFileSync(path, buffer);
  }
  return path;
}

function baseReceipt({ now, actor, sourceUrl, finalUrl, sha, bytes }) {
  return {
    source_url: sourceUrl || CARBONMONITOR_SOURCE_URL,
    final_url: finalUrl || sourceUrl || CARBONMONITOR_SOURCE_URL,
    last_check: now,
    actor,
    sha256: sha || null,
    bytes: bytes || null,
    generated_at: nowIso(),
  };
}

function coverageSummary(parsed) {
  const years = [...new Set(parsed.annual.map((r) => r.year))].sort((a, b) => a - b);
  const daysByYear = {};
  for (const year of years) daysByYear[year] = daysInYear(year);
  return {
    years,
    provinces: new Set(parsed.annual.map((r) => r.province_code)).size,
    records: parsed.annual.length,
    days_by_year: daysByYear,
  };
}

/**
 * 传入原始 CSV 或注入 fetch，解析并按需入库；这是测试和 CLI 共用的主入口。
 * 任何下载/解析/入库失败都返回结构化结果，不抛到日任务外层。
 */
export async function collectCarbonMonitor(opts = {}) {
  const now = normalizeIso(opts.now);
  const actor = opts.actor || 'cli:regional-collect';
  const archiveDir = opts.archiveDir ? resolve(String(opts.archiveDir)) : DEFAULT_ARCHIVE_DIR;
  const dryRun = !!opts.dryRun;
  let downloaded = null;
  try {
    if (opts.csvText !== undefined) {
      const buffer = Buffer.from(String(opts.csvText), 'utf8');
      downloaded = {
        ok: true,
        url: CARBONMONITOR_SOURCE_URL,
        final_url: CARBONMONITOR_SOURCE_URL,
        bytes: buffer.length,
        sha256: sha256(buffer),
        csv: buffer.toString('utf8'),
        buffer,
      };
    } else {
      downloaded = await downloadCarbonMonitorCsv({
        fetchImpl: opts.fetchImpl,
        timeoutMs: opts.timeoutMs,
        maxBytes: opts.maxBytes,
      });
    }
    const currentYear = Number(now.slice(0, 4));
    const parsed = parseCarbonMonitorCsv(downloaded.csv, {
      lastCompleteYear: currentYear - 1,
      now,
      snapshotHash: downloaded.sha256,
    });
    const base = baseReceipt({
      now, actor, sourceUrl: downloaded.url, finalUrl: downloaded.final_url,
      sha: downloaded.sha256, bytes: downloaded.bytes,
    });
    if (!parsed.ok) {
      const receipt = {
        ...base,
        ok: false,
        status: 'failed',
        error: parsed.error,
        coverage: { years: [], provinces: 0, records: 0, days_by_year: {} },
        import: { skipped: true, reason: 'parse_failed' },
        excluded: [],
        ignored: [],
        anomalies: [],
      };
      receipt.receipt_path = writeReceipt(archiveDir, receipt);
      return receipt;
    }

    const rawPath = writeRawIfNeeded(archiveDir, downloaded.buffer, downloaded.sha256);
    const expected = {
      source_name: CARBONMONITOR_SOURCE_NAME,
      source_kind: 'research',
      methodology: CARBONMONITOR_METHODOLOGY,
      boundary: CARBONMONITOR_BOUNDARY,
    };
    const existingMeta = all(
      `SELECT DISTINCT source_name, source_kind, methodology, boundary
       FROM region_emission
       WHERE scope = 'region_co2' AND dataset_key = ? AND status = 'active'`,
      [CARBONMONITOR_DATASET_KEY]
    );
    const metaMismatch = existingMeta.some((row) => Object.entries(expected)
      .some(([key, value]) => row[key] !== value));
    // 同 hash 只能说明源文件没变，不能说明库内该 hash 的所有省/年都已导入。
    // 必须逐个核对解析出的 province_code+year；缺一省/一年就补采，不能整批跳过。
    const existingActive = all(
      `SELECT province_code, year, value_tco2, source_name, source_kind,
              methodology, boundary, snapshot_hash
       FROM region_emission
       WHERE scope = 'region_co2' AND dataset_key = ? AND status = 'active'`,
      [CARBONMONITOR_DATASET_KEY]
    );
    const existingByKey = new Map(existingActive.map((row) => [
      `${row.province_code}|${Number(row.year)}`, row,
    ]));
    const sameHash = parsed.annual.length > 0
      && existingActive.length >= parsed.annual.length
      && parsed.annual.every((record) => {
        const row = existingByKey.get(`${record.province_code}|${Number(record.year)}`);
        return Boolean(row)
          && row.snapshot_hash === downloaded.sha256
          && Number(row.value_tco2) === Number(record.value_tco2)
          && row.source_name === record.source_name
          && row.source_kind === record.source_kind
          && row.methodology === record.methodology
          && row.boundary === record.boundary;
      });

    let importResult;
    if (metaMismatch) {
      importResult = {
        ok: false, skipped: true, reason: 'dataset_metadata_mismatch',
        error: '现有数据集元数据与固定 bootstrap 不一致，已跳过入库；请管理员核查历史记录',
      };
    } else if (!parsed.annual.length) {
      importResult = {
        ok: true, skipped: true, reason: 'no_complete_year',
        message: '本次没有完整年份可入库；已有值保持原样',
      };
    } else if (sameHash) {
      importResult = {
        ok: true, skipped: true, reason: 'same_source_hash',
        message: '原件 hash 相同，跳过入库；只更新 last_check',
      };
    } else {
      importResult = importRegionRecords(parsed.annual, { actor, dryRun });
      if (dryRun && importResult.ok) importResult.dry_run = true;
    }

    const status = importResult.ok === false
      ? 'failed'
      : (importResult.skipped ? 'skipped' : 'ok');
    const receipt = {
      ...base,
      ok: importResult.ok !== false,
      status,
      error: importResult.error || null,
      raw_path: rawPath,
      coverage: coverageSummary(parsed),
      import: importResult,
      excluded: parsed.excluded.slice(0, 60),
      ignored: parsed.ignored.slice(0, 60),
      anomalies: parsed.anomalies.slice(0, 60),
      parse_stats: parsed.stats,
    };
    receipt.receipt_path = writeReceipt(archiveDir, receipt);
    return receipt;
  } catch (e) {
    const base = baseReceipt({
      now, actor,
      sourceUrl: downloaded?.url,
      finalUrl: downloaded?.final_url,
      sha: downloaded?.sha256,
      bytes: downloaded?.bytes,
    });
    const receipt = {
      ...base,
      ok: false,
      status: 'failed',
      error: e.message,
      coverage: { years: [], provinces: 0, records: 0, days_by_year: {} },
      import: { skipped: true, reason: 'collect_failed' },
      excluded: [],
      ignored: [],
      anomalies: [],
    };
    try {
      receipt.receipt_path = writeReceipt(archiveDir, receipt);
    } catch {
      receipt.receipt_path = null;
    }
    return receipt;
  }
}

let inFlight = false;

/**
 * 日更入口：并发 1，异常隔离，始终返回结果；失败不改变已有排放值。
 */
export async function runRegionalDailyCollect(opts = {}) {
  if (inFlight) {
    return {
      ok: false,
      status: 'failed',
      error: '省域采集并发限制为 1，上一次采集仍在进行',
      last_check: nowIso(),
      import: { skipped: true, reason: 'already_running' },
    };
  }
  inFlight = true;
  const now = normalizeIso(opts.now);
  try {
    const out = await collectCarbonMonitor({ ...opts, now });
    return out;
  } catch (e) {
    return {
      ok: false,
      status: 'failed',
      error: e.message,
      last_check: now,
      import: { skipped: true, reason: 'collect_failed' },
    };
  } finally {
    inFlight = false;
  }
}
