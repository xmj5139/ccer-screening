/**
 * 交易信息服务（六模块之「交易信息」）
 * ============================================================================
 * 数据源（官方，已实测可获取，见 scripts/v2-status.mjs 的连通性自检）：
 *   1. 每日行情公告列表（静态 JSON，含全部 381 条公告的日期/标题/URL/发布时间）
 *        https://www.ccer.com.cn/wcm/ccer/data/2502lshq.json
 *   2. 每日行情公告正文（HTML，含当日成交量/成交额/成交均价 + 截至当日累计值）
 *        https://www.ccer.com.cn/wcm/ccer/html/2502lshq/<YYYYMMDD>/<id>.shtml
 *   3. 分行业行情（静态 JSON，含 能源产业 / 林业和其他碳汇类型 与小计）
 *        https://www.ccer.com.cn/wcm/ccer/data/<YYYYMMDD>-first.json
 *
 * 【口径纪律】（需求规格 1.4）
 *   - 成交均价 = 当日成交额 ÷ 当日成交量，**不是收盘价**；官方未披露时留空，
 *     系统不自行补值（另给出显式的「计算值」字段供对照，标注为计算值）。
 *   - 区间成交均价 = Σ成交额 ÷ Σ成交量；**不取日均价的简单平均**。
 *   - 有成交 / 无成交交易日 / 休市 / 数据暂缺四种状态分别存储与展示，
 *     不用一个「0」混淆。
 *   - 历史修订保留旧值（trade_revision），不静默覆盖。
 *   - 官方未区分交易方式时，trade_method 记为「官方合计（未区分交易方式）」，
 *     不按挂牌/协议等自行拆分。
 */
import { all, get, run, tx } from '../core/db.mjs';
import { newId, nowIso, todayCst, isDate, j, uj, round } from '../core/util.mjs';

/** 官方未区分交易方式时的占位口径（不自行补值） */
export const TRADE_METHOD_TOTAL = '官方合计（未区分交易方式）';

export const SESSION_STATES = {
  traded: '有成交',
  no_trade: '无成交交易日',
  closed: '休市',
  missing: '数据暂缺',
};

export const VERIFY_STATES = {
  pending: '待核对',
  verified: '已核对',
  mismatch: '与官方公告不符（已标记待核）',
};

export const MARKET_CCER = 'CCER';

/** 官方数据源地址（采集连接器与界面「来源」按钮共用） */
export const TRADE_SOURCES = {
  list_json: 'https://www.ccer.com.cn/wcm/ccer/data/2502lshq.json',
  list_page: 'https://www.ccer.com.cn/wcm/ccer/html/2502lshq/index.html',
  bulletin_base: 'https://www.ccer.com.cn/wcm/ccer/html/',
  dimension_json: (ymd8) => `https://www.ccer.com.cn/wcm/ccer/data/${ymd8}-first.json`,
};

const CN_NUM = (s) => Number(String(s ?? '').replace(/[,，\s]/g, ''));

/* ==================================================================== */
/*  一、解析层                                                          */
/* ==================================================================== */

/**
 * 解析每日行情公告列表 JSON。
 * @returns {{total:number, items:Array<{trade_date:string,title:string,url:string,published_at:string}>}}
 */
export function parseTradeListJson(text) {
  const data = uj(text, null);
  if (!data || !Array.isArray(data.rows)) {
    return { total: 0, items: [], error: '公告列表 JSON 结构不符合预期（缺少 rows 数组）' };
  }
  const items = [];
  const skipped = [];
  for (const r of data.rows) {
    const m = String(r.title || '').match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
    if (!m) {
      skipped.push(r.title || r.url || '(无标题)');
      continue;
    }
    items.push({
      // 交易日期以标题为准：公告 URL 的路径日期可能是补发/重发日期（实测存在）
      trade_date: `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`,
      title: r.title || null,
      url: r.url ? `${TRADE_SOURCES.bulletin_base}${String(r.url).replace(/^\/+/, '')}` : null,
      published_at: r.publishedTime || null,
    });
  }
  items.sort((a, b) => a.trade_date.localeCompare(b.trade_date));
  return { total: Number(data.total || items.length), items, skipped };
}

/**
 * 解析每日行情公告正文。
 * 实测存在两种文本格式：
 *   新格式（2025 年起）：「核证自愿减排量成交量X吨，成交额Y元，成交均价Z元/吨。」
 *                        +「截至 YYYY 年 M 月 D 日…累计成交量…吨，累计成交额…元。」
 *   旧格式（2024 年）：「全国温室气体自愿减排交易市场总成交量X 吨，总成交额Y 元。」
 *                      （无成交均价、无累计值 —— 系统不推测，如实留空并登记缺口）
 *
 * @param {string} html
 * @param {{url?:string, fallback_date?:string}} [opts]
 */
export function parseTradeBulletin(html, opts = {}) {
  const text = String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
  const out = {
    trade_date: opts.fallback_date && isDate(opts.fallback_date) ? opts.fallback_date : null,
    volume: null,
    turnover: null,
    avg_price: null,
    session_state: null,
    cumulative: null,
    text_format: null,
    published_at: null,
    title: null,
    source_url: opts.url || null,
    warnings: [],
  };
  const title = String(html || '').match(/<title>([\s\S]*?)<\/title>/i);
  if (title) out.title = title[1].replace(/\s+/g, ' ').trim();
  const t = text.match(/时间：\s*(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/);
  if (t) out.published_at = t[1];

  // 日期：优先正文首句的「YYYY年M月D日，」
  const dm = text.match(/(\d{4})年(\d{1,2})月(\d{1,2})日\s*[，,]/);
  if (dm) out.trade_date = `${dm[1]}-${String(dm[2]).padStart(2, '0')}-${String(dm[3]).padStart(2, '0')}`;

  // 新格式
  const n1 = text.match(/成交量\s*([\d,\.]+)\s*吨[，,]\s*成交额\s*([\d,\.]+)\s*元[，,]\s*成交均价\s*([\d,\.]+)\s*元\/吨/);
  // 旧格式（2024）
  const n0 = text.match(/总成交量\s*([\d,\.]+)\s*吨[，,]\s*总成交额\s*([\d,\.]+)\s*元/);
  if (n1) {
    out.text_format = 'volume-turnover-avgprice';
    out.volume = CN_NUM(n1[1]);
    out.turnover = CN_NUM(n1[2]);
    out.avg_price = CN_NUM(n1[3]);
    out.session_state = out.volume > 0 ? 'traded' : 'no_trade';
    out.warnings.push('成交均价为官方披露值（不是收盘价）');
  } else if (n0) {
    out.text_format = 'volume-turnover-only';
    out.volume = CN_NUM(n0[1]);
    out.turnover = CN_NUM(n0[2]);
    out.avg_price = null;
    out.session_state = out.volume > 0 ? 'traded' : 'no_trade';
    out.warnings.push('该日公告未披露成交均价（旧格式），系统留空不自行补值；可查看「计算值」对照');
  } else {
    // 无成交日：官方文案形如「成交量0吨」或「无成交」
    const zero = text.match(/成交量\s*0\s*吨/);
    const none = /无成交|没有成交/.test(text);
    if (zero || none) {
      out.text_format = 'no-trade';
      out.volume = 0;
      out.turnover = 0;
      out.avg_price = null;
      out.session_state = 'no_trade';
    } else {
      out.warnings.push('未能从公告正文识别成交量/成交额，需人工核对');
    }
  }

  // 累计值
  const cum = text.match(
    /截至\s*(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日[，,]?\s*全国温室气体自愿减排交易市场累计成交量\s*([\d,\.]+)\s*吨[，,]?\s*累计成交额\s*([\d,\.]+)\s*元/
  );
  if (cum) {
    out.cumulative = {
      as_of_date: `${cum[1]}-${String(cum[2]).padStart(2, '0')}-${String(cum[3]).padStart(2, '0')}`,
      volume_total: CN_NUM(cum[4]),
      turnover_total: CN_NUM(cum[5]),
      text: cum[0],
    };
  } else if (out.volume !== null) {
    out.warnings.push('公告未披露累计成交量/额（旧格式），累计核对仅能覆盖新格式区间');
  }
  if (out.volume !== null && out.turnover !== null && out.volume > 0 && out.avg_price !== null) {
    const derived = out.turnover / out.volume;
    if (Math.abs(derived - out.avg_price) > 0.02) {
      out.warnings.push(
        `官方披露均价 ${out.avg_price} 与「成交额÷成交量」${round(derived, 4)} 存在舍入差异（属官方四舍五入，不修订）`
      );
    }
  }
  return out;
}

/**
 * 解析分行业行情 JSON（能源产业 / 林业和其他碳汇类型 / 小计）。
 * @returns {{trade_date:string|null, rows:object[], subtotal:object|null, warnings:string[]}}
 */
export function parseTradeFirstJson(text) {
  const data = uj(text, null);
  const warnings = [];
  if (!Array.isArray(data)) {
    return { trade_date: null, rows: [], subtotal: null, warnings: ['分行业行情 JSON 结构不符合预期'] };
  }
  const num = (v) => {
    const s = String(v ?? '').trim();
    if (s === '' || s === '-' || s === '—') return null;
    const n = CN_NUM(s);
    return Number.isFinite(n) ? n : null;
  };
  let trade_date = null;
  let subtotal = null;
  const rows = [];
  for (const r of data) {
    const d8 = String(r.business_date || '');
    if (/^\d{8}$/.test(d8)) trade_date = `${d8.slice(0, 4)}-${d8.slice(4, 6)}-${d8.slice(6, 8)}`;
    const rec = {
      dimension_value: String(r.profession_name || '').trim(),
      volume: num(r.business_amount),
      turnover: num(r.business_price),
      avg_price: num(r.business_ave_price),
      raw: r,
    };
    if (!rec.dimension_value) continue;
    if (/^小计$/.test(rec.dimension_value)) subtotal = rec;
    else rows.push(rec);
  }
  if (subtotal && rows.length) {
    const sumV = rows.reduce((s, r) => s + (r.volume || 0), 0);
    const sumT = rows.reduce((s, r) => s + (r.turnover || 0), 0);
    if (subtotal.volume !== null && Math.abs(sumV - subtotal.volume) > 1e-6) {
      warnings.push(`分行业成交量合计 ${sumV} 与小计 ${subtotal.volume} 不一致（官方数据自身差异，按来源原样保存）`);
    }
    if (subtotal.turnover !== null && Math.abs(sumT - subtotal.turnover) > 0.01) {
      warnings.push(`分行业成交额合计 ${sumT} 与小计 ${subtotal.turnover} 不一致（官方数据自身差异，按来源原样保存）`);
    }
  }
  return { trade_date, rows, subtotal, warnings };
}

/* ==================================================================== */
/*  二、写入层（含修订留痕）                                             */
/* ==================================================================== */

function sameNum(a, b) {
  if (a === null || a === undefined) return b === null || b === undefined;
  if (b === null || b === undefined) return false;
  return Math.abs(Number(a) - Number(b)) < 1e-9;
}

/**
 * 写入 / 更新一条日行情。
 * - 已存在且数值一致：不写库（幂等，重复采集不产生噪音）
 * - 已存在但数值变化：写 trade_revision 保留旧值，并置 verify_status='pending'
 * - 官方口径变化（例如旧格式补披露均价）：同样留痕
 *
 * @returns {{action:'inserted'|'unchanged'|'revised', id:string, changes:object[]}}
 */
export function upsertTradeDaily(input, { actor = 'system:collect', reason = '官方公告采集' } = {}) {
  const {
    trade_date, volume = null, turnover = null, avg_price = null,
    session_state = null, source_url = null, source_snapshot_id = null,
    published_at = null, trade_method = TRADE_METHOD_TOTAL, market = MARKET_CCER,
    note = null, verify_status = 'pending',
  } = input;
  if (!isDate(trade_date)) throw new Error(`非法交易日期：${trade_date}`);
  const state =
    session_state || (volume === null ? 'missing' : Number(volume) > 0 ? 'traded' : 'no_trade');
  const existing = get(
    'SELECT * FROM trade_daily WHERE trade_date = ? AND trade_method = ? AND market = ?',
    [trade_date, trade_method, market]
  );
  const now = nowIso();
  if (!existing) {
    const id = newId('TD');
    run(
      `INSERT INTO trade_daily
       (id,trade_date,trade_method,volume,turnover,avg_price,market,session_state,source_id,source_url,
        source_snapshot_id,published_at,collected_at,verify_status,verify_note,verified_by,verified_at,
        revision,note,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        id, trade_date, trade_method, volume, turnover, avg_price, market, state, null, source_url,
        source_snapshot_id, published_at, now, verify_status, null, null, null, 1, note, now, now,
      ]
    );
    return { action: 'inserted', id, changes: [] };
  }
  const fields = [
    ['volume', existing.volume, volume],
    ['turnover', existing.turnover, turnover],
    ['avg_price', existing.avg_price, avg_price],
    ['session_state', existing.session_state, state],
    ['source_url', existing.source_url, source_url],
    ['published_at', existing.published_at, published_at],
  ];
  const changes = fields
    .filter(([, oldV, newV]) => {
      if (newV === null || newV === undefined) return false; // 不用空值覆盖已有值
      return typeof oldV === 'number' || typeof newV === 'number'
        ? !sameNum(oldV, newV)
        : String(oldV ?? '') !== String(newV ?? '');
    })
    .map(([field, oldV, newV]) => ({ field, old: oldV, new: newV }));
  if (!changes.length) {
    // 仅补充快照/来源等非数值信息
    run(
      `UPDATE trade_daily SET source_snapshot_id = COALESCE(?, source_snapshot_id),
         source_url = COALESCE(?, source_url), updated_at = ? WHERE id = ?`,
      [source_snapshot_id, source_url, now, existing.id]
    );
    return { action: 'unchanged', id: existing.id, changes: [] };
  }
  tx(() => {
    for (const c of changes) {
      run(
        `INSERT INTO trade_revision (id,trade_daily_id,revised_at,revised_by,field,old_value,new_value,reason,official_ref)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [
          newId('TRV'), existing.id, now, actor, c.field,
          c.old === null || c.old === undefined ? null : String(c.old),
          c.new === null || c.new === undefined ? null : String(c.new),
          reason, source_url,
        ]
      );
    }
    run(
      `UPDATE trade_daily SET volume = COALESCE(?, volume), turnover = COALESCE(?, turnover),
         avg_price = COALESCE(?, avg_price), session_state = ?, source_url = COALESCE(?, source_url),
         source_snapshot_id = COALESCE(?, source_snapshot_id), published_at = COALESCE(?, published_at),
         collected_at = ?, verify_status = 'pending',
         verify_note = ?, revision = revision + 1, updated_at = ?
       WHERE id = ?`,
      [
        volume, turnover, avg_price, state, source_url, source_snapshot_id, published_at,
        now, `第 ${Number(existing.revision || 1) + 1} 版：官方公告数值发生变化，旧值已保留在修订记录中`,
        now, existing.id,
      ]
    );
  });
  return { action: 'revised', id: existing.id, changes };
}

/** 记录官方披露的累计值（用于累计口径核对） */
export function upsertCumulativeReference(ref, { sourceUrl = null } = {}) {
  if (!ref || !isDate(ref.as_of_date)) return { action: 'skipped' };
  const existing = get('SELECT * FROM trade_cumulative_reference WHERE as_of_date = ?', [ref.as_of_date]);
  const now = nowIso();
  if (existing) {
    if (sameNum(existing.volume_total, ref.volume_total) && sameNum(existing.turnover_total, ref.turnover_total)) {
      return { action: 'unchanged', id: existing.id };
    }
    run(
      `UPDATE trade_cumulative_reference SET volume_total = ?, turnover_total = ?, source_url = COALESCE(?, source_url),
         collected_at = ?, note = ? WHERE id = ?`,
      [
        ref.volume_total, ref.turnover_total, sourceUrl, now,
        `官方披露值发生修订（原：${existing.volume_total} / ${existing.turnover_total}），旧值见审计日志`,
        existing.id,
      ]
    );
    return { action: 'revised', id: existing.id };
  }
  const id = newId('TCR');
  run(
    `INSERT INTO trade_cumulative_reference (id,as_of_date,volume_total,turnover_total,source_id,source_url,note,collected_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    [id, ref.as_of_date, ref.volume_total, ref.turnover_total, null, sourceUrl, ref.text || null, now]
  );
  return { action: 'inserted', id };
}

/** 写入分行业行情（同一交易日同维度覆盖式更新，保留 raw 供核对） */
export function upsertTradeDimension(tradeDate, dimension, rows, { sourceUrl = null } = {}) {
  let written = 0;
  const now = nowIso();
  for (const r of rows) {
    if (!r.dimension_value) continue;
    run(
      `INSERT INTO trade_dimension (id,trade_date,dimension,dimension_value,volume,turnover,avg_price,source_id,source_url,collected_at,note)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(trade_date,dimension,dimension_value) DO UPDATE SET
         volume=excluded.volume, turnover=excluded.turnover, avg_price=excluded.avg_price,
         source_url=excluded.source_url, collected_at=excluded.collected_at, note=excluded.note`,
      [
        newId('TDIM'), tradeDate, dimension, r.dimension_value, r.volume, r.turnover, r.avg_price,
        null, sourceUrl, now, r.note || null,
      ]
    );
    written += 1;
  }
  return written;
}

/* ------------------------------ 交易日历 ------------------------------ */

/** 标记日历（幂等）。day_type: trading|closed|weekend|holiday|unknown */
export function markCalendar(tradeDate, dayType, { note = null, actor = 'system:collect' } = {}) {
  if (!isDate(tradeDate)) return false;
  run(
    `INSERT INTO trade_calendar (trade_date,day_type,note,confirmed_by,confirmed_at)
     VALUES (?,?,?,?,?)
     ON CONFLICT(trade_date) DO UPDATE SET day_type=excluded.day_type,
       note=COALESCE(excluded.note, trade_calendar.note)`,
    [tradeDate, dayType, note, actor, nowIso()]
  );
  return true;
}

/**
 * 依据官方公告日期集合重算交易日历：
 *   - 周末 → weekend
 *   - 官方公告清单中出现的日期 → trading
 *   - 已有行情记录但当前公告清单快照未包含的日期 → 仍记 trading
 *     （保守处理：公告清单是「当日有行情」的直接证据；已入库的行情记录同样是证据。
 *      绝不因为「本次没抓到」就把已知交易日降级为休市 —— 那会把采集失败伪装成休市，
 *      并让累计差分核对把多日区间误当成单日。）
 *   - 窗口内既无公告也无行情记录的工作日 → unknown（不能从缺公告推断法定休市）
 *   - 窗口起点之前的工作日 → 不推断（保持原状态或留 missing）
 *
 * 【重要】调用方必须传入**官方公告清单中的日期**（trade_calendar 的「交易日」权威来源），
 * 而不是「已成功导入 trade_daily 的日期」。后者会把抓取失败（例如公告页 404）静默变成休市，
 * 与「官方无公告即休市」的真实含义混淆。
 *
 * @param {string[]} bulletinDates 官方公告日期（升序）
 * @param {{windowStart?:string, actor?:string, importedDates?:string[]}} [opts]
 */
export function rebuildCalendar(bulletinDates, { windowStart = null, actor = 'system:collect', importedDates = [] } = {}) {
  const dates = [...new Set(bulletinDates.filter(isDate))].sort();
  if (!dates.length) return { marked: 0, from: null, to: null };
  const imported = new Set((Array.isArray(importedDates) ? importedDates : []).filter(isDate));
  const from = windowStart && isDate(windowStart) && windowStart < dates[0] ? windowStart : dates[0];
  const to = dates[dates.length - 1];
  const set = new Set(dates);
  let marked = 0;
  let keptTrading = 0;
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86400000) {
    const d = new Date(t).toISOString().slice(0, 10);
    const dow = new Date(t).getUTCDay();
    if (dow === 0 || dow === 6) {
      markCalendar(d, 'weekend', { note: '周末（非交易日）', actor });
    } else if (set.has(d)) {
      markCalendar(d, 'trading', { note: '官方已发布当日交易行情公告', actor });
    } else if (imported.has(d)) {
      // 已入库行情记录但当前公告清单快照未含该日：保持交易日，不降级
      markCalendar(d, 'trading', { note: '本系统已有该日行情记录但本次公告清单快照未包含，保持交易日（不降级为休市）', actor });
      keptTrading += 1;
    } else {
      const existing = get('SELECT day_type,note FROM trade_calendar WHERE trade_date=?', [d]);
      const independentlyClosed = ['closed', 'holiday'].includes(existing?.day_type) &&
        !String(existing?.note || '').includes('凭官方当日无行情公告推断');
      if (!independentlyClosed) {
        markCalendar(d, 'unknown', { note: '公告清单未覆盖该工作日；交易或休市状态未核实，待搜索/抓取补证', actor });
      }
    }
    marked += 1;
  }
  return { marked, from, to, kept_trading: keptTrading };
}

/** 人工确认某日为休市 / 交易日（覆盖自动推断） */
export function confirmCalendarDay(user, tradeDate, dayType, note = null) {
  if (!isDate(tradeDate)) return { error: '非法日期', status: 400 };
  if (!['trading', 'closed', 'weekend', 'holiday'].includes(dayType)) {
    return { error: 'day_type 取值非法', status: 400 };
  }
  markCalendar(tradeDate, dayType, { note: note || `人工确认为 ${dayType}`, actor: user?.name || 'unknown' });
  return { ok: true, trade_date: tradeDate, day_type: dayType };
}

/* ==================================================================== */
/*  三、查询与统计层                                                     */
/* ==================================================================== */

function rangeWhere(filters, alias = 't') {
  const where = [];
  const params = [];
  if (filters.from && isDate(filters.from)) {
    where.push(`${alias}.trade_date >= ?`);
    params.push(filters.from);
  }
  if (filters.to && isDate(filters.to)) {
    where.push(`${alias}.trade_date <= ?`);
    params.push(filters.to);
  }
  if (filters.verify_status) {
    where.push(`${alias}.verify_status = ?`);
    params.push(filters.verify_status);
  }
  if (filters.session_state) {
    where.push(`${alias}.session_state = ?`);
    params.push(filters.session_state);
  }
  if (filters.trade_method) {
    where.push(`${alias}.trade_method = ?`);
    params.push(filters.trade_method);
  }
  return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

/** 逐日行情明细（含来源与核对状态） */
export function listTradeDaily(filters = {}) {
  const w = rangeWhere(filters);
  const limit = Math.min(Number(filters.limit) || 400, 5000);
  const offset = Math.max(Number(filters.offset) || 0, 0);
  const rows = all(
    `SELECT t.*, (SELECT COUNT(*) FROM trade_revision v WHERE v.trade_daily_id = t.id) AS revision_count
     FROM trade_daily t ${w.sql} ORDER BY t.trade_date DESC LIMIT ? OFFSET ?`,
    [...w.params, limit, offset]
  );
  const total = get(`SELECT COUNT(*) AS c FROM trade_daily t ${w.sql}`, w.params)?.c ?? 0;
  return {
    rows: rows.map((r) => ({
      ...r,
      weekday: weekdayCn(r.trade_date),
      session_label: SESSION_STATES[r.session_state] || r.session_state,
      verify_label: r.verify_status === 'verified' && String(r.verified_by || '').startsWith('system:')
        ? '系统自动核对' : VERIFY_STATES[r.verify_status] || r.verify_status,
      // 官方未披露均价时的「计算值」：显式标注为计算值，不冒充官方披露值
      avg_price_derived:
        r.avg_price === null && r.volume && r.turnover !== null ? round(r.turnover / r.volume, 4) : null,
      avg_price_is_official: r.avg_price !== null,
    })),
    total,
    limit,
    offset,
    filters,
  };
}

/** 交易日历：四种状态分别标注 */
export function tradeCalendar(filters = {}) {
  const from = filters.from && isDate(filters.from) ? filters.from : null;
  const to = filters.to && isDate(filters.to) ? filters.to : todayCst();
  const cal = all(
    `SELECT * FROM trade_calendar WHERE trade_date <= ? ${from ? 'AND trade_date >= ?' : ''} ORDER BY trade_date`,
    from ? [to, from] : [to]
  );
  const daily = all(
    `SELECT trade_date, session_state, volume, verify_status FROM trade_daily
     WHERE trade_date <= ? ${from ? 'AND trade_date >= ?' : ''} ORDER BY trade_date`,
    from ? [to, from] : [to]
  );
  const byDate = new Map();
  for (const d of daily) {
    // 同一日期多交易方式时以「有成交」优先呈现
    const prev = byDate.get(d.trade_date);
    if (!prev || (prev.session_state !== 'traded' && d.session_state === 'traded')) byDate.set(d.trade_date, d);
  }
  const calMap = new Map(cal.map((c) => [c.trade_date, c]));
  const out = [];
  if (from) {
    for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86400000) {
      const d = new Date(t).toISOString().slice(0, 10);
      out.push(calendarCell(d, calMap.get(d), byDate.get(d)));
    }
  } else {
    const dates = [...new Set([...calMap.keys(), ...byDate.keys()])].sort().reverse().slice(0, Math.min(Number(filters.limit) || 400, 2000));
    for (const d of dates) out.push(calendarCell(d, calMap.get(d), byDate.get(d)));
  }
  const counts = {};
  for (const c of out) counts[c.state] = (counts[c.state] || 0) + 1;
  return {
    from: from || (out.length ? out[out.length - 1].trade_date : null),
    to,
    days: out,
    counts,
    note:
      '有成交、无成交交易日、休市（含周末/法定节假日）、数据暂缺分别显示；' +
      '工作日无官方公告一律标为「休市（待复核）」而**不是**无成交。',
  };
}

function calendarCell(date, cal, daily) {
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
  if (daily) {
    return {
      trade_date: date,
      state: daily.session_state,
      state_label: SESSION_STATES[daily.session_state] || daily.session_state,
      volume: daily.volume,
      verify_status: daily.verify_status,
      source: 'official_bulletin',
    };
  }
  if (cal && (cal.day_type === 'weekend' || dow === 0 || dow === 6)) {
    return { trade_date: date, state: 'closed', state_label: '周末休市', source: 'calendar' };
  }
  if (cal && cal.day_type === 'holiday') {
    return { trade_date: date, state: 'closed', state_label: '休市（已有独立依据）', source: 'calendar_confirmed' };
  }
  if (cal && cal.day_type === 'closed') {
    return { trade_date: date, state: 'closed', state_label: '休市（人工确认）', source: 'calendar_confirmed' };
  }
  if (cal && cal.day_type === 'trading') {
    return { trade_date: date, state: 'missing', state_label: '数据暂缺（日历标为交易日但无行情记录）', source: 'calendar' };
  }
  return { trade_date: date, state: 'missing', state_label: '数据暂缺（未采集/未导入）', source: 'none' };
}

/**
 * 区间汇总（日/月/季/年）。区间成交均价 = Σ成交额 ÷ Σ成交量。
 * 仅当上一可比区间在本系统内有完整交易日覆盖时才给出同比/环比。
 */
export function tradeSummary({ from, to, granularity = 'day', include_pending = true } = {}) {
  const g = ['day', 'month', 'quarter', 'year'].includes(granularity) ? granularity : 'day';
  const where = [];
  const params = [];
  if (from && isDate(from)) {
    where.push('trade_date >= ?');
    params.push(from);
  }
  if (to && isDate(to)) {
    where.push('trade_date <= ?');
    params.push(to);
  }
  if (!include_pending) where.push("verify_status = 'verified'");
  const rows = all(
    `SELECT * FROM trade_daily ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY trade_date`,
    params
  );
  const buckets = new Map();
  for (const r of rows) {
    const key = bucketKey(r.trade_date, g);
    if (!buckets.has(key)) {
      buckets.set(key, { key, volume: 0, turnover: 0, traded_days: 0, no_trade_days: 0, pending: 0, verified: 0, dates: [] });
    }
    const b = buckets.get(key);
    b.dates.push(r.trade_date);
    if (r.session_state === 'traded' && r.volume > 0) {
      b.volume += Number(r.volume) || 0;
      b.turnover += Number(r.turnover) || 0;
      b.traded_days += 1;
    } else if (r.session_state === 'no_trade') {
      b.no_trade_days += 1;
    }
    if (r.verify_status === 'verified') b.verified += 1;
    else b.pending += 1;
  }
  const list = [...buckets.values()]
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((b) => {
      const avg = b.volume > 0 ? round(b.turnover / b.volume, 4) : null;
      const prevYearKey = shiftBucketKey(b.key, g, -1, 'year');
      const prevKey = shiftBucketKey(b.key, g, -1, g);
      const prevYear = buckets.get(prevYearKey);
      const prev = buckets.get(prevKey);
      return {
        bucket: b.key,
        label: bucketLabel(b.key, g),
        volume: b.volume || null,
        turnover: b.turnover || null,
        avg_price: avg,
        avg_price_note: '区间成交均价 = Σ成交额 ÷ Σ成交量；成交量为 0 时为空，不取日均价的简单平均',
        traded_days: b.traded_days,
        no_trade_days: b.no_trade_days,
        date_from: b.dates[0],
        date_to: b.dates[b.dates.length - 1],
        pending_verify: b.pending,
        verified: b.verified,
        yoy_pct:
          prevYear && prevYear.volume > 0 && b.volume > 0
            ? round((b.volume / prevYear.volume - 1) * 100, 2)
            : null,
        yoy_available: !!(prevYear && prevYear.volume > 0 && b.volume > 0),
        prev_period_pct:
          prev && prev.volume > 0 && b.volume > 0 ? round((b.volume / prev.volume - 1) * 100, 2) : null,
        prev_period_available: !!(prev && prev.volume > 0 && b.volume > 0),
      };
    });
  const totalVolume = list.reduce((s, b) => s + (b.volume || 0), 0);
  const totalTurnover = list.reduce((s, b) => s + (b.turnover || 0), 0);
  return {
    granularity: g,
    from: from || (rows.length ? rows[0].trade_date : null),
    to: to || (rows.length ? rows[rows.length - 1].trade_date : null),
    buckets: list,
    total: {
      volume: totalVolume || null,
      turnover: totalTurnover || null,
      avg_price: totalVolume > 0 ? round(totalTurnover / totalVolume, 4) : null,
    },
    rows_considered: rows.length,
    note:
      '同比/环比仅在上期区间有完整交易覆盖时给出，否则显示为空（不推测）。' +
      '汇总口径与「交易信息 → 来源与口径」一致。',
  };
}

function bucketKey(date, g) {
  const [y, m] = date.split('-');
  if (g === 'day') return date;
  if (g === 'month') return `${y}-${m}`;
  if (g === 'quarter') return `${y}-Q${Math.floor((Number(m) - 1) / 3) + 1}`;
  return y;
}

function shiftBucketKey(key, g, delta, unit) {
  if (g === 'day') {
    const t = Date.parse(`${key}T00:00:00Z`);
    return new Date(t + delta * (unit === 'year' ? 365 : 1) * 86400000).toISOString().slice(0, 10);
  }
  const y = Number(key.slice(0, 4)) + (unit === 'year' ? delta : 0);
  if (g === 'year') return String(y);
  if (g === 'quarter') {
    const q = Number(key.slice(-1)) + (unit === 'quarter' ? delta : 0);
    if (q < 1) return `${y - 1}-Q4`;
    if (q > 4) return `${y + 1}-Q1`;
    return `${y}-Q${q}`;
  }
  const m = Number(key.slice(5, 7)) + (unit === 'month' ? delta : 0);
  if (m < 1) return `${y - 1}-12`;
  if (m > 12) return `${y + 1}-01`;
  return `${y}-${String(m).padStart(2, '0')}`;
}

function bucketLabel(key, g) {
  if (g === 'day') return key;
  if (g === 'month') return `${key.slice(0, 4)} 年 ${Number(key.slice(5, 7))} 月`;
  if (g === 'quarter') return `${key.slice(0, 4)} 年 ${key.slice(-1)} 季度`;
  return `${key} 年`;
}

function weekdayCn(date) {
  const names = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  const t = Date.parse(`${date}T00:00:00Z`);
  return Number.isNaN(t) ? null : names[new Date(t).getUTCDay()];
}

/** 行业 / 项目类型维度拆分（仅展示官方公开的维度，不自行补值） */
export function tradeDimensions({ from, to } = {}) {
  const where = [];
  const params = [];
  if (from && isDate(from)) {
    where.push('trade_date >= ?');
    params.push(from);
  }
  if (to && isDate(to)) {
    where.push('trade_date <= ?');
    params.push(to);
  }
  const rows = all(
    `SELECT * FROM trade_dimension ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY trade_date DESC`,
    params
  );
  const byValue = new Map();
  for (const r of rows) {
    const k = r.dimension_value;
    if (!byValue.has(k)) byValue.set(k, { dimension_value: k, volume: 0, turnover: 0, days: 0 });
    const b = byValue.get(k);
    b.volume += Number(r.volume) || 0;
    b.turnover += Number(r.turnover) || 0;
    if (r.volume) b.days += 1;
  }
  return {
    available: rows.length > 0,
    rows,
    by_value: [...byValue.values()].map((b) => ({
      ...b,
      volume: b.volume || null,
      turnover: b.turnover || null,
      avg_price: b.volume > 0 ? round(b.turnover / b.volume, 4) : null,
    })),
    note:
      rows.length > 0
        ? '维度拆分来自官方「每日行情」分行业数据；官方未披露的维度不显示，也不自行补值。'
        : '官方分行业数据尚未采集（可运行 npm run v2:daily 或后台采集）。',
  };
}

/** 累计口径：系统累计 vs 官方披露累计 */
export function tradeCumulative() {
  const sys = get(
    `SELECT SUM(CASE WHEN session_state='traded' THEN volume ELSE 0 END) AS volume,
            SUM(CASE WHEN session_state='traded' THEN turnover ELSE 0 END) AS turnover,
            MIN(trade_date) AS from_date, MAX(trade_date) AS to_date,
            COUNT(*) AS days
     FROM trade_daily`
  ) || {};
  const ref = get('SELECT * FROM trade_cumulative_reference ORDER BY as_of_date DESC LIMIT 1');
  const firstRef = get('SELECT * FROM trade_cumulative_reference ORDER BY as_of_date ASC LIMIT 1');
  let check = null;
  if (ref && sys.to_date) {
    const baseline = firstRef && firstRef.as_of_date <= sys.from_date ? firstRef : null;
    const expectedVolume = baseline ? ref.volume_total - baseline.volume_total + (baseline.volume_total !== null ? 0 : 0) : null;
    check = {
      as_of_date: ref.as_of_date,
      official_volume_total: ref.volume_total,
      official_turnover_total: ref.turnover_total,
      official_as_of: ref.as_of_date,
      system_from: sys.from_date,
      system_to: sys.to_date,
      system_volume: sys.volume,
      system_turnover: sys.turnover,
      baseline_as_of: baseline ? baseline.as_of_date : null,
      // 只有当系统覆盖了「首个官方累计基准日 → 最新累计日」的完整区间时，才可做差分校对
      delta_check_available: !!(baseline && ref.as_of_date === sys.to_date),
      delta_expected_volume: baseline && ref.as_of_date === sys.to_date ? round(ref.volume_total - baseline.volume_total, 2) : null,
      note:
        '累计核对需要「完整覆盖官方累计基准日至最新交易日」；' +
        '覆盖不完整时只展示官方披露值与系统累计值，不宣称一致。',
    };
  }
  return { system: sys, official_latest: ref || null, official_first: firstRef || null, check };
}

/** 交易模块概览（页面顶部指标 + 状态说明） */
export function tradeOverview({ range_days = 365 } = {}) {
  const to = todayCst();
  const from = new Date(Date.parse(`${to}T00:00:00Z`) - range_days * 86400000).toISOString().slice(0, 10);
  const latest = get(
    `SELECT * FROM trade_daily WHERE session_state = 'traded' ORDER BY trade_date DESC LIMIT 1`
  );
  const latestAny = get('SELECT * FROM trade_daily ORDER BY trade_date DESC LIMIT 1');
  const lastBulletin = get(
    `SELECT trade_date, published_at, source_url FROM trade_daily WHERE published_at IS NOT NULL ORDER BY trade_date DESC LIMIT 1`
  );
  const counts = get(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN verify_status='pending' THEN 1 ELSE 0 END) AS pending,
            SUM(CASE WHEN verify_status='verified' THEN 1 ELSE 0 END) AS verified,
            SUM(CASE WHEN verify_status='mismatch' THEN 1 ELSE 0 END) AS mismatch,
            SUM(CASE WHEN session_state='no_trade' THEN 1 ELSE 0 END) AS no_trade
     FROM trade_daily`
  ) || {};
  const anomaly = get(
    `SELECT COUNT(*) AS c FROM data_reconciliation WHERE dataset='trade' AND status='open'`
  )?.c ?? 0;
  return {
    as_of: to,
    latest_traded: latest || null,
    latest_any: latestAny || null,
    last_published_at: lastBulletin ? lastBulletin.published_at : null,
    counts: {
      total_days: Number(counts.total || 0),
      pending: Number(counts.pending || 0),
      verified: Number(counts.verified || 0),
      mismatch: Number(counts.mismatch || 0),
      no_trade_days: Number(counts.no_trade || 0),
      open_anomalies: anomaly,
    },
    range: { from, to, days: range_days },
    cumulative: tradeCumulative(),
    calendar: tradeCalendar({ from, to }),
    note:
      '没有官方数据的日期显示「数据暂缺」，不会用 0 元价格填充；' +
      '成交均价不是收盘价；累计值与官方披露值分开显示并核对。',
  };
}

/* ------------------------------ 核对工作流 ------------------------------ */

/** 人工核对：verified / mismatch（发现与官方不符时标记待核，不更新正式口径） */
export function verifyTradeDaily(user, id, { decision = 'verified', note = null } = {}) {
  const row = get('SELECT * FROM trade_daily WHERE id = ?', [id]);
  if (!row) return { error: '行情记录不存在', status: 404 };
  if (!['verified', 'mismatch', 'pending'].includes(decision)) {
    return { error: 'decision 取值非法（verified/mismatch/pending）', status: 400 };
  }
  run(
    `UPDATE trade_daily SET verify_status = ?, verify_note = ?, verified_by = ?, verified_at = ?, updated_at = ?
     WHERE id = ?`,
    [decision, note, user?.name || 'unknown', nowIso(), nowIso(), id]
  );
  return { ok: true, id, trade_date: row.trade_date, verify_status: decision, verified_by: user?.name || 'unknown' };
}

export function bulkVerifyTrade(user, { ids = [], from = null, to = null, decision = 'verified', note = null } = {}) {
  let targets = [];
  if (ids.length) {
    targets = ids;
  } else {
    const w = rangeWhere({ from, to, verify_status: 'pending' });
    targets = all(`SELECT id FROM trade_daily t ${w.sql}`, w.params).map((r) => r.id);
  }
  let done = 0;
  for (const id of targets) {
    const out = verifyTradeDaily(user, id, { decision, note });
    if (!out.error) done += 1;
  }
  return { ok: true, verified: done, requested: targets.length, decision };
}

export function listTradeRevisions({ trade_daily_id = null, limit = 200 } = {}) {
  return all(
    `SELECT r.*, t.trade_date FROM trade_revision r JOIN trade_daily t ON t.id = r.trade_daily_id
     ${trade_daily_id ? 'WHERE r.trade_daily_id = ?' : ''} ORDER BY r.revised_at DESC LIMIT ?`,
    trade_daily_id ? [trade_daily_id, limit] : [limit]
  );
}

/** 人工补录 / 更正单条行情（必须给出原因，旧值留痕） */
export function amendTradeDaily(user, id, patch = {}) {
  const row = get('SELECT * FROM trade_daily WHERE id = ?', [id]);
  if (!row) return { error: '行情记录不存在', status: 404 };
  if (!patch.reason) return { error: '人工更正必须填写原因（reason）', status: 400 };
  const res = upsertTradeDaily(
    {
      trade_date: row.trade_date,
      trade_method: row.trade_method,
      volume: patch.volume === undefined ? row.volume : Number(patch.volume),
      turnover: patch.turnover === undefined ? row.turnover : Number(patch.turnover),
      avg_price: patch.avg_price === undefined ? row.avg_price : Number(patch.avg_price),
      session_state: patch.session_state || row.session_state,
      source_url: patch.source_url || row.source_url,
      published_at: patch.published_at || row.published_at,
      note: patch.note || row.note,
    },
    { actor: user?.name || 'unknown', reason: `${patch.reason}｜人工更正` }
  );
  return { ok: true, ...res, trade_date: row.trade_date };
}

/* ==================================================================== */
/*  四、CSV / Excel 导入与导出                                           */
/* ==================================================================== */

/**
 * 导入行情行（CSV 或接口）。逐行校验并返回错误清单；合法的写入并置待核对。
 * @param {object} user
 * @param {Array<object>} rows 由 rowsFromCsv('trade-daily') 解析出的行
 */
export function importTradeRows(user, rows, { sourceKind = 'manual_csv' } = {}) {
  const accepted = [];
  const rejected = [];
  const seen = new Set();
  for (const r of rows) {
    const errors = [];
    const date = r.trade_date && String(r.trade_date).trim();
    if (!isDate(date)) errors.push('交易日期格式应为 YYYY-MM-DD');
    if (date && seen.has(date)) errors.push('文件内同一交易日期重复');
    const volume = r.volume === null || r.volume === undefined || r.volume === '' ? null : Number(String(r.volume).replace(/[,，\s]/g, ''));
    if (r.volume !== null && r.volume !== '' && !Number.isFinite(volume)) errors.push('成交量不是数值');
    const turnover = r.turnover === null || r.turnover === undefined || r.turnover === '' ? null : Number(String(r.turnover).replace(/[,，\s]/g, ''));
    if (r.turnover !== null && r.turnover !== '' && !Number.isFinite(turnover)) errors.push('成交额不是数值');
    const avg = r.avg_price === null || r.avg_price === undefined || r.avg_price === '' ? null : Number(String(r.avg_price).replace(/[,，\s]/g, ''));
    if (r.avg_price !== null && r.avg_price !== '' && !Number.isFinite(avg)) errors.push('成交均价不是数值');
    if (volume !== null && (volume < 0 || volume > 1e9)) errors.push('成交量超出合理范围（0 ~ 1e9 tCO₂e）');
    if (turnover !== null && (turnover < 0 || turnover > 1e13)) errors.push('成交额超出合理范围');
    if (avg !== null && (avg <= 0 || avg > 10000)) errors.push('成交均价超出合理范围（0 ~ 10000 元/tCO₂e）');
    if (volume !== null && volume > 0 && turnover !== null && avg !== null) {
      const diff = Math.abs(turnover - volume * avg);
      if (diff > Math.max(1, volume * 0.02)) {
        errors.push(`成交量×均价 与 成交额 不一致（差 ${round(diff, 2)} 元，超过 2% 容差）`);
      }
    }
    if (errors.length) {
      rejected.push({ row: r.__row, trade_date: date || null, errors });
      continue;
    }
    if (date) seen.add(date);
    const out = upsertTradeDaily(
      {
        trade_date: date,
        volume,
        turnover,
        avg_price: avg,
        session_state: r.session_state || null,
        source_url: r.source_url || null,
        published_at: r.published_at || null,
        note: [r.note, `导入方式：${sourceKind}`, `导入人：${user?.name || 'unknown'}`].filter(Boolean).join('｜'),
      },
      { actor: user?.name || 'unknown', reason: `CSV 导入（${sourceKind}）` }
    );
    accepted.push({ trade_date: date, action: out.action, id: out.id, changes: out.changes });
  }
  return {
    ok: rejected.length === 0,
    accepted_count: accepted.length,
    rejected_count: rejected.length,
    inserted: accepted.filter((a) => a.action === 'inserted').length,
    unchanged: accepted.filter((a) => a.action === 'unchanged').length,
    revised: accepted.filter((a) => a.action === 'revised').length,
    accepted,
    rejected,
    note: '导入的行一律为「待核对」；核对通过后才计入正式口径。发现与官方公告不符时应标记待核而不是直接改数。',
  };
}

/** 导出用列定义（明细） */
export function tradeDailyExport(filters = {}) {
  const { rows } = listTradeDaily({ ...filters, limit: filters.limit || 5000 });
  const columns = [
    { key: 'trade_date', label: '交易日期', definition: '官方公告披露的交易日期（非抓取日期）' },
    { key: 'weekday', label: '星期' },
    { key: 'trade_method', label: '交易方式', definition: '官方未区分时记为「官方合计（未区分交易方式）」，不自行拆分' },
    { key: 'session_state', label: '交易状态', definition: 'traded 有成交 / no_trade 无成交交易日 / closed 休市 / missing 数据暂缺' },
    { key: 'volume', label: '成交量', unit: 'tCO₂e', definition: '官方披露当日成交量' },
    { key: 'turnover', label: '成交额', unit: '元', definition: '官方披露当日成交额' },
    { key: 'avg_price', label: '成交均价（官方披露）', unit: '元/tCO₂e', definition: '官方披露值；不是收盘价。未披露时为空' },
    { key: 'avg_price_derived', label: '均价计算值', unit: '元/tCO₂e', definition: '成交额÷成交量；仅在官方未披露均价时给出，属计算值' },
    { key: 'verify_status', label: '核对状态', definition: 'pending 待核对 / verified 已核对 / mismatch 与官方不符' },
    { key: 'published_at', label: '官方发布时间' },
    { key: 'source_url', label: '官方公告链接' },
    { key: 'revision', label: '版本', definition: '大于 1 表示发生过官方修订，旧值见修订记录' },
    { key: 'note', label: '备注' },
  ];
  return {
    columns,
    rows: rows.map((r) => ({ ...r, session_state: `${r.session_state}（${r.session_label}）` })),
    meta: {
      数据截至: filters.to || (rows.length ? rows[0].trade_date : '—'),
      来源: '全国温室气体自愿减排交易系统 · 每日行情（官方公告）',
      口径: '成交均价=当日成交额÷当日成交量（不是收盘价）；区间均价=Σ成交额÷Σ成交量',
      待核对条数: rows.filter((r) => r.verify_status === 'pending').length,
    },
  };
}

/** 导出用列定义（月/年汇总） */
export function tradeSummaryExport({ from, to, granularity = 'month' } = {}) {
  const s = tradeSummary({ from, to, granularity });
  const columns = [
    { key: 'bucket', label: granularity === 'year' ? '年度' : granularity === 'month' ? '月份' : granularity === 'quarter' ? '季度' : '日期' },
    { key: 'volume', label: '成交量', unit: 'tCO₂e', definition: '区间内有成交交易日的成交量之和' },
    { key: 'turnover', label: '成交额', unit: '元', definition: '区间内有成交交易日的成交额之和' },
    { key: 'avg_price', label: '区间成交均价', unit: '元/tCO₂e', definition: 'Σ成交额 ÷ Σ成交量；不取日均价的简单平均；成交量为 0 时为空' },
    { key: 'traded_days', label: '有成交天数' },
    { key: 'no_trade_days', label: '无成交交易日天数', definition: '有交易日但无成交；与休市、数据暂缺不同' },
    { key: 'date_from', label: '区间起' },
    { key: 'date_to', label: '区间止' },
    { key: 'yoy_pct', label: '同比(%)', definition: '仅在上年同期有完整交易覆盖时给出，否则为空' },
    { key: 'prev_period_pct', label: '环比(%)', definition: '仅在上期有完整交易覆盖时给出，否则为空' },
    { key: 'pending_verify', label: '其中待核对条数' },
  ];
  return {
    columns,
    rows: s.buckets,
    meta: {
      数据截至: s.to || '—',
      来源: '全国温室气体自愿减排交易系统 · 每日行情（官方公告）',
      口径: s.note,
      粒度: granularity,
    },
  };
}

export { round };
