/**
 * 第三方行情候选导入与差异报告（docs/86 第三阶段第 3 节）
 * ============================================================================
 * 硬约束：
 *   · 候选只写独立表 market_candidate_import / market_candidate_row；
 *     绝不写 cea_trade_daily（官方行情零改写），也不以均价补收盘价；
 *   · 严格来源、日期、单位、数量/金额/均价/累计口径、finite/positive、大小/行数上限；
 *   · missing / conflict / match / unsupported 逐行保留，stale 标志保留；
 *   · CSV 导出复用 export-svc 的公式注入前缀防护；
 *   · 管理员专属诊断；普通用户/viewer 不可见。
 */
import { createHash } from 'node:crypto';
import { all, get, run, audit } from '../core/db.mjs';
import { newId, nowIso, todayCst } from '../core/util.mjs';
import { parseCsv } from '../data/import-templates.mjs';

export const MARKET_CANDIDATE_LIMITS = {
  max_bytes: 2 * 1024 * 1024,
  max_rows: 5000,
  max_line_chars: 4000,
  max_volume: 1e9,
  max_turnover: 1e13,
  max_price: 100000,
  stale_days: 30,
};

const HEADER_ALIASES = {
  trade_date: ['trade_date', 'date', '交易日期', '日期', '数据日期'],
  instrument: ['instrument', '标的', '品种'],
  unit: ['unit', '单位'],
  volume: ['volume', '成交量', '日成交量'],
  turnover: ['turnover', 'amount', '成交额', '成交金额'],
  avg_price: ['avg_price', 'average_price', '均价', '成交均价'],
  cumulative_volume: ['cumulative_volume', 'year_volume', '累计成交量'],
  cumulative_turnover: ['cumulative_turnover', 'year_turnover', '累计成交额'],
  source_url: ['source_url', 'url', '来源链接'],
  data_as_of: ['data_as_of', 'as_of', '截至日期', '数据截至'],
  stale: ['stale', '过期', '陈旧'],
};

function normHeader(h) {
  return String(h || '').trim().toLowerCase().replace(/[\s_\-（）()：:]/g, '');
}

function buildHeaderMap(header = []) {
  const out = new Map();
  const normalized = header.map((h) => normHeader(h));
  for (const [key, aliases] of Object.entries(HEADER_ALIASES)) {
    for (const alias of aliases) {
      const idx = normalized.indexOf(normHeader(alias));
      if (idx >= 0) { out.set(key, idx); break; }
    }
  }
  return out;
}

function cell(row, index, key) {
  if (index === undefined) return undefined;
  return row[index];
}

function strictDate(value) {
  const s = String(value ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const [y, m, d] = s.split('-').map(Number);
  if (!(y >= 2000 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return s;
}

function strictNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const s = String(value).trim().replace(/[,，\s]/g, '');
  if (!/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function normalizeUnit(value) {
  const s = String(value ?? '').trim().toLowerCase().replace(/\s+/g, '')
    .replace('tco₂e', 'tco2e').replace('吨co2e', 'tco2e').replace('吨', 'tco2e');
  if (['tco2e', 't', '吨', '吨co2e', 'tco2'].includes(s)) return 'tco2e';
  if (['元', 'cny', 'rmb'].includes(s)) return 'cny';
  if (['万元', 'wan', '10kcny'].includes(s)) return 'wan';
  if (['元/吨', '元/tco2e', 'cny/tco2e', '元/吨co2e'].includes(s)) return 'cny/tco2e';
  return null;
}

function isStaleDate(asOf, staleFlag) {
  if (staleFlag === true || String(staleFlag).toLowerCase() === 'true' || String(staleFlag) === '1') return true;
  if (!asOf) return false;
  const t = Date.parse(`${asOf}T00:00:00Z`);
  if (!Number.isFinite(t)) return false;
  const today = Date.parse(`${todayCst()}T00:00:00Z`);
  return (today - t) / 86400000 > MARKET_CANDIDATE_LIMITS.stale_days;
}

function compareValue(field, candidate, official, { label, unit } = {}) {
  if (candidate === null || candidate === undefined) return null;
  if (official === null || official === undefined) {
    return { field, label, unit, candidate, official: null, match: null, reason: '官方该字段未披露，无法核对' };
  }
  const diff = candidate - official;
  // 严格核对：1 吨差异不能在 15 万吨里被 0.5% 容差隐藏；只留浮点误差余量。
  const allowed = Math.max(Math.abs(Number(official)) * 1e-9, 1e-6);
  return {
    field, label, unit, candidate, official,
    diff: Number(diff.toFixed(6)),
    match: Math.abs(diff) <= allowed,
  };
}

/**
 * 官方侧按标的分表：
 *   CEA  -> cea_trade_daily（独立配额行情）
 *   CCER -> trade_daily（按日汇总不同交易方式，不把分方式行当多天）
 * 其它标的（如地方试点 GDEA）或未来交易日 -> unsupported，不伪造 missing。
 */
function officialForCandidate({ tradeDate, instrument }) {
  if (!['CEA', 'CCER'].includes(instrument)) {
    return { unsupported: true, note: `不支持的标的 ${instrument}；只核对 CEA/CCER 官方行情。` };
  }
  if (tradeDate > todayCst()) {
    return { unsupported: true, note: '候选交易日晚于当前日期；未来日期不进入差异或缺口统计。' };
  }
  if (instrument === 'CEA') {
    const official = get(
      `SELECT * FROM cea_trade_daily
        WHERE trade_date=? AND instrument=?
        ORDER BY CASE WHEN market_scope='national' THEN 0 ELSE 1 END, price_regime DESC
        LIMIT 1`,
      [tradeDate, instrument]
    );
    if (!official) return { missing: true };
    const volume = official.total_volume ?? official.sum_volume;
    const turnover = official.total_turnover ?? official.sum_turnover;
    const avg = official.computed_avg_price
      ?? (volume !== null && volume !== undefined && turnover !== null && turnover !== undefined
        && Number(volume) > 0 ? Number(turnover) / Number(volume) : null);
    return {
      official_id: official.id, volume, turnover, avg,
      cumulative_volume: official.year_volume, cumulative_turnover: official.year_turnover,
    };
  }
  const rows = all(
    `SELECT * FROM trade_daily WHERE trade_date=? AND market='CCER' ORDER BY trade_method, id`,
    [tradeDate]
  );
  if (!rows.length) return { missing: true };
  const withVolume = rows.filter((r) => r.volume !== null && r.volume !== undefined);
  const withTurnover = rows.filter((r) => r.turnover !== null && r.turnover !== undefined);
  const volume = withVolume.length ? withVolume.reduce((s, r) => s + Number(r.volume), 0) : null;
  const turnover = withTurnover.length ? withTurnover.reduce((s, r) => s + Number(r.turnover), 0) : null;
  const avg = volume !== null && turnover !== null && volume > 0 ? turnover / volume : null;
  return {
    official_id: rows.map((r) => r.id).join(','),
    volume, turnover, avg,
    cumulative_volume: null, cumulative_turnover: null,
  };
}

function diffAgainstOfficial({ tradeDate, instrument, volume, turnover, avgPrice, cumulativeVolume, cumulativeTurnover }) {
  const official = officialForCandidate({ tradeDate, instrument });
  if (official.unsupported) {
    return { status: 'unsupported', fields: [], note: official.note };
  }
  if (official.missing) {
    return {
      status: 'missing', fields: [],
      note: '官方行情表没有该日期/标的记录；候选仅留档，不写入正式行情。',
    };
  }
  const fields = [];
  const push = (x) => { if (x) fields.push(x); };
  push(compareValue('volume', volume, official.volume, { label: '日成交量', unit: 'tCO2e' }));
  push(compareValue('turnover', turnover, official.turnover, { label: '日成交额', unit: '元' }));
  push(compareValue('avg_price', avgPrice, official.avg, { label: '成交均价（不使用收盘价）', unit: '元/tCO2e' }));
  push(compareValue('cumulative_volume', cumulativeVolume, official.cumulative_volume, { label: '当年累计成交量', unit: 'tCO2e' }));
  push(compareValue('cumulative_turnover', cumulativeTurnover, official.cumulative_turnover, { label: '当年累计成交额', unit: '元' }));
  if (!fields.length) {
    return {
      status: 'unsupported', fields: [],
      official_id: official.official_id,
      note: '候选没有可与官方日行情核对的数量/金额/均价/累计字段。',
    };
  }
  const comparable = fields.filter((f) => f.match !== null);
  if (!comparable.length) {
    return {
      status: 'unsupported', fields, official_id: official.official_id,
      note: '官方记录缺少对应字段，无法判断 match/conflict；不据此改官方值。',
    };
  }
  const conflicts = comparable.filter((f) => f.match === false);
  return {
    status: conflicts.length ? 'conflict' : 'match',
    fields, official_id: official.official_id,
    note: conflicts.length
      ? '候选与官方行情存在差异；仅报告，不修改官方行情。'
      : '候选与官方可核对字段一致；仍不写官方行情。',
  };
}

function rowFromObject(obj) {
  return {
    trade_date: obj.trade_date ?? obj.date ?? obj['交易日期'] ?? obj['日期'],
    instrument: obj.instrument ?? obj['标的'] ?? 'CEA',
    unit: obj.unit ?? obj['单位'],
    volume: obj.volume ?? obj['成交量'],
    turnover: obj.turnover ?? obj['成交额'],
    avg_price: obj.avg_price ?? obj.average_price ?? obj['均价'],
    cumulative_volume: obj.cumulative_volume ?? obj.year_volume ?? obj['累计成交量'],
    cumulative_turnover: obj.cumulative_turnover ?? obj.year_turnover ?? obj['累计成交额'],
    source_url: obj.source_url ?? obj.url ?? obj['来源链接'],
    data_as_of: obj.data_as_of ?? obj.as_of ?? obj['截至日期'],
    stale: obj.stale ?? obj['过期'],
  };
}

function parseCandidateText(text, format) {
  const src = String(text ?? '');
  if (format === 'json') {
    let parsed;
    try { parsed = JSON.parse(src); } catch (e) { return { ok: false, error: `JSON 解析失败：${e.message}` }; }
    const rows = Array.isArray(parsed) ? parsed
      : (Array.isArray(parsed?.rows) ? parsed.rows : (Array.isArray(parsed?.data) ? parsed.data : null));
    if (!rows) return { ok: false, error: 'JSON 必须是数组，或包含 rows/data 数组的对象' };
    return { ok: true, rows: rows.map(rowFromObject) };
  }
  if (format !== 'csv') return { ok: false, error: '只支持 csv 或 json' };
  const table = parseCsv(src);
  if (!table.length) return { ok: false, error: 'CSV 为空' };
  const map = buildHeaderMap(table[0]);
  if (!map.has('trade_date')) return { ok: false, error: 'CSV 缺少交易日期列' };
  const rows = table.slice(1).map((r) => ({
    trade_date: cell(r, map.get('trade_date')),
    instrument: cell(r, map.get('instrument')) || 'CEA',
    unit: cell(r, map.get('unit')),
    volume: cell(r, map.get('volume')),
    turnover: cell(r, map.get('turnover')),
    avg_price: cell(r, map.get('avg_price')),
    cumulative_volume: cell(r, map.get('cumulative_volume')),
    cumulative_turnover: cell(r, map.get('cumulative_turnover')),
    source_url: cell(r, map.get('source_url')),
    data_as_of: cell(r, map.get('data_as_of')),
    stale: cell(r, map.get('stale')),
  }));
  return { ok: true, rows, matched_headers: [...map.keys()] };
}

/**
 * 导入第三方候选。整个文件受字节/行数/行长限制；单行不合法时保留为
 * diff_status=unsupported 的候选行并写明原因，不写正式行情。
 */
export function importMarketCandidates({
  user, text, format = 'csv', sourceName = null, sourceUrl = null,
  asOf = null, fileName = null, stale = false,
} = {}) {
  if (String(user?.role || '') !== 'admin') return { error: '仅管理员可导入行情候选', status: 403 };
  const src = String(text ?? '');
  const bytes = Buffer.byteLength(src, 'utf8');
  if (!src.trim()) return { error: '文件为空', status: 400 };
  if (bytes > MARKET_CANDIDATE_LIMITS.max_bytes) {
    return { error: `文件超过 ${MARKET_CANDIDATE_LIMITS.max_bytes} 字节上限`, status: 413 };
  }
  const lineCount = src.split(/\r?\n/).length;
  if (lineCount > MARKET_CANDIDATE_LIMITS.max_rows + 1) {
    return { error: `行数超过 ${MARKET_CANDIDATE_LIMITS.max_rows} 行上限`, status: 413 };
  }
  const parsed = parseCandidateText(src, format);
  if (!parsed.ok) return { error: parsed.error, status: 400 };
  if (parsed.rows.length > MARKET_CANDIDATE_LIMITS.max_rows) {
    return { error: `记录数超过 ${MARKET_CANDIDATE_LIMITS.max_rows} 行上限`, status: 413 };
  }
  const batchSourceUrl = String(sourceUrl || '').trim() || null;
  if (batchSourceUrl && !/^https?:\/\//i.test(batchSourceUrl)) {
    return { error: '来源链接只允许 http(s)', status: 400 };
  }
  const batchSourceName = String(sourceName || '').trim()
    || (batchSourceUrl ? new URL(batchSourceUrl).hostname : '');
  if (!batchSourceName) {
    return { error: '缺少来源名称/来源链接：第三方候选必须保留可核对来源', status: 400 };
  }
  const batchAsOf = asOf ? strictDate(asOf) : null;
  if (asOf && !batchAsOf) return { error: '来源截至日期必须是日历上存在的 YYYY-MM-DD', status: 400 };
  const now = nowIso();
  const importId = newId('MKTCI');
  const counts = { missing: 0, conflict: 0, match: 0, unsupported: 0, stale: 0 };
  const prepared = [];
  for (let i = 0; i < parsed.rows.length; i += 1) {
    const raw = parsed.rows[i] || {};
    const errors = [];
    const tradeDate = strictDate(raw.trade_date);
    if (!tradeDate) errors.push('交易日期缺失或不是日历上存在的 YYYY-MM-DD');
    const unit = normalizeUnit(raw.unit);
    if (!unit) errors.push('单位缺失或不受支持（tCO2e/吨/元/万元/元每吨）');
    const instrument = String(raw.instrument || 'CEA').trim().toUpperCase().slice(0, 30) || 'CEA';
    const volume = strictNumber(raw.volume);
    const turnover = strictNumber(raw.turnover);
    const avgPrice = strictNumber(raw.avg_price);
    const cumulativeVolume = strictNumber(raw.cumulative_volume);
    const cumulativeTurnover = strictNumber(raw.cumulative_turnover);
    for (const [field, value, rawValue, max, label] of [
      ['volume', volume, raw.volume, MARKET_CANDIDATE_LIMITS.max_volume, '成交量'],
      ['turnover', turnover, raw.turnover, MARKET_CANDIDATE_LIMITS.max_turnover, '成交额'],
      ['avg_price', avgPrice, raw.avg_price, MARKET_CANDIDATE_LIMITS.max_price, '均价'],
      ['cumulative_volume', cumulativeVolume, raw.cumulative_volume, MARKET_CANDIDATE_LIMITS.max_volume * 100, '累计成交量'],
      ['cumulative_turnover', cumulativeTurnover, raw.cumulative_turnover, MARKET_CANDIDATE_LIMITS.max_turnover * 10, '累计成交额'],
    ]) {
      const present = rawValue !== undefined && rawValue !== null && rawValue !== '';
      if (!present) continue;
      if (value === null) { errors.push(`${label}不是有限数值（NaN/Infinity/非法格式）`); continue; }
      if (!(value > 0)) errors.push(`${label}必须为正数`);
      if (value > max) errors.push(`${label}超出合理范围上限 ${max}`);
    }
    const values = [volume, turnover, avgPrice, cumulativeVolume, cumulativeTurnover].filter((v) => v !== null);
    if (!values.length) errors.push('没有可核对的数量/金额/均价/累计数值');
    if ((unit === 'cny' || unit === 'wan')
      && (volume !== null || avgPrice !== null || cumulativeVolume !== null)) {
      errors.push('单位为金额时不能支持成交量/均价/累计成交量字段');
    }
    if (unit === 'cny/tco2e'
      && (volume !== null || turnover !== null || cumulativeVolume !== null || cumulativeTurnover !== null)) {
      errors.push('单位为元/吨时不能支持成交量/成交额/累计量额字段');
    }
    // 金额单位换算到“元”后再与官方表比较；原始单位和原始值仍写入 raw_json 留痕。
    const turnoverCanonical = turnover !== null && unit === 'wan' ? turnover * 10000 : turnover;
    const cumulativeTurnoverCanonical = cumulativeTurnover !== null && unit === 'wan'
      ? cumulativeTurnover * 10000 : cumulativeTurnover;
    const rowSourceUrl = String(raw.source_url || batchSourceUrl || '').trim() || null;
    if (rowSourceUrl && !/^https?:\/\//i.test(rowSourceUrl)) errors.push('行来源链接只允许 http(s)');
    const sourceAsOf = raw.data_as_of ? strictDate(raw.data_as_of) : batchAsOf;
    if (raw.data_as_of && !sourceAsOf) errors.push('行数据截至日期非法');
    if (tradeDate && sourceAsOf && tradeDate > sourceAsOf) {
      errors.push('交易日晚于来源截至日期；不能把未来/超出来源覆盖范围的数据当候选差异');
    }
    const rowStale = isStaleDate(sourceAsOf || batchAsOf, raw.stale) || Boolean(stale);
    const base = {
      trade_date: tradeDate, instrument, unit: raw.unit ? String(raw.unit).slice(0, 40) : null,
      volume, turnover: turnoverCanonical, avg_price: avgPrice,
      cumulative_volume: cumulativeVolume, cumulative_turnover: cumulativeTurnoverCanonical,
      source_name: batchSourceName, source_url: rowSourceUrl, source_as_of: sourceAsOf || batchAsOf,
      stale: rowStale,
    };
    let diff;
    if (errors.length) {
      diff = { status: 'unsupported', fields: [], note: errors.join('；') };
    } else {
      diff = diffAgainstOfficial({
        tradeDate, instrument, volume, turnover: turnoverCanonical, avgPrice,
        cumulativeVolume, cumulativeTurnover: cumulativeTurnoverCanonical,
      });
    }
    counts[diff.status] = (counts[diff.status] || 0) + 1;
    if (rowStale) counts.stale += 1;
    prepared.push({
      ...base, diff_status: diff.status, diff_json: JSON.stringify(diff.fields || []),
      notes: [diff.note, ...errors].filter(Boolean).join('；'),
      raw_json: JSON.stringify(raw).slice(0, MARKET_CANDIDATE_LIMITS.max_line_chars),
    });
  }
  const acceptedStatus = counts.match + counts.conflict + counts.missing + counts.unsupported > 0;
  run(
    `INSERT INTO market_candidate_import
       (id,source_name,source_url,as_of,format,file_name,file_hash,byte_size,row_count,status,
        stale,counts_json,created_by,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [importId, batchSourceName, batchSourceUrl, batchAsOf, format, fileName || null,
      // 仅用于批次去重/留痕，不用于把候选当官方数据。
      createHash('sha256').update(src).digest('hex'),
      bytes, prepared.length, acceptedStatus ? 'imported' : 'rejected',
      prepared.some((r) => r.stale) ? 1 : 0, JSON.stringify(counts), user?.name || 'admin', now]
  );
  const insert = `INSERT INTO market_candidate_row
    (id,import_id,row_no,trade_date,instrument,unit,volume,turnover,avg_price,
     cumulative_volume,cumulative_turnover,source_name,source_url,source_as_of,stale,
     diff_status,diff_json,raw_json,notes,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;
  for (let i = 0; i < prepared.length; i += 1) {
    const r = prepared[i];
    run(insert, [
      newId('MKTCR'), importId, i + 1, r.trade_date, r.instrument, r.unit,
      r.volume, r.turnover, r.avg_price, r.cumulative_volume, r.cumulative_turnover,
      r.source_name, r.source_url, r.source_as_of, r.stale ? 1 : 0,
      r.diff_status, r.diff_json, r.raw_json, r.notes, now,
    ]);
  }
  audit({
    actor: user?.name || 'admin', action: 'market_candidate.import',
    objectType: 'market_candidate_import', objectId: importId,
    detail: { source: batchSourceName, format, rows: prepared.length, counts, stale: counts.stale },
  });
  return {
    ok: true, import_id: importId, source_name: batchSourceName, source_url: batchSourceUrl,
    as_of: batchAsOf, format, row_count: prepared.length, counts,
    stale: prepared.some((r) => r.stale),
    note: '候选只写入独立表；未修改官方行情（cea_trade_daily）。match 也不代表官方确认。',
  };
}

export function listMarketCandidateImports({ limit = 20 } = {}) {
  return all(
    `SELECT id,source_name,source_url,as_of,format,file_name,byte_size,row_count,status,
            stale,counts_json,created_by,created_at
       FROM market_candidate_import ORDER BY created_at DESC LIMIT ?`,
    [Math.max(1, Math.min(Number(limit) || 20, 100))]
  ).map((r) => {
    let counts = {};
    try { counts = JSON.parse(r.counts_json || '{}'); } catch { counts = {}; }
    return { ...r, counts };
  });
}

export function listMarketCandidates({ importId = null, status = null, limit = 200 } = {}) {
  const where = [];
  const params = [];
  if (importId) { where.push('import_id=?'); params.push(String(importId)); }
  if (status) { where.push('diff_status=?'); params.push(String(status)); }
  const rows = all(
    `SELECT id,import_id,row_no,trade_date,instrument,unit,volume,turnover,avg_price,
            cumulative_volume,cumulative_turnover,source_name,source_url,source_as_of,
            stale,diff_status,diff_json,notes,created_at
       FROM market_candidate_row ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY trade_date DESC, row_no LIMIT ?`,
    [...params, Math.max(1, Math.min(Number(limit) || 200, 1000))]
  );
  return rows.map((r) => {
    let fields = [];
    try { fields = JSON.parse(r.diff_json || '[]'); } catch { fields = []; }
    return { ...r, stale: !!r.stale, diff_fields: fields };
  });
}

export function marketCandidateExport({ importId = null, status = null } = {}) {
  const rows = listMarketCandidates({ importId, status, limit: 1000 });
  const columns = [
    { key: 'trade_date', label: '交易日期' },
    { key: 'instrument', label: '标的' },
    { key: 'unit', label: '来源单位' },
    { key: 'volume', label: '成交量', unit: 'tCO2e' },
    { key: 'turnover', label: '成交额', unit: '元' },
    { key: 'avg_price', label: '均价（候选）', unit: '元/tCO2e' },
    { key: 'cumulative_volume', label: '累计成交量', unit: 'tCO2e' },
    { key: 'cumulative_turnover', label: '累计成交额', unit: '元' },
    { key: 'source_name', label: '来源' },
    { key: 'source_url', label: '来源链接' },
    { key: 'source_as_of', label: '来源截至日期' },
    { key: 'stale', label: 'stale 第三方标志' },
    { key: 'diff_status', label: '差异状态', definition: 'missing/conflict/match/unsupported' },
    { key: 'diff_detail', label: '差异明细' },
    { key: 'notes', label: '说明' },
  ];
  return {
    columns,
    rows: rows.map((r) => ({
      ...r,
      stale: r.stale ? 1 : 0,
      diff_detail: (r.diff_fields || [])
        .map((f) => `${f.label}:${f.match === null ? '不可比' : f.match ? '一致' : '冲突'}`)
        .join('；'),
    })),
    meta: {
      数据性质: '第三方候选，不是官方行情',
      差异状态: 'missing/conflict/match/unsupported',
      官方行情: '本导出不修改、不替代 cea_trade_daily',
    },
  };
}
