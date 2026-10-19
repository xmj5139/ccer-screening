/**
 * 公开碳核算资料 · 确定性解析器（docs/39 第 4 条）
 * ============================================================================
 * 【纪律】本模块只做**按明确结构取数**，不做任何推测：
 *   1. HTTP 412 / JS 校验页 / 登录页一律判为 blocked，**绝不当正文**，
 *      更不从这种页面里"提取"任何数值；
 *   2. 数值只来自原文结构化位置（表格单元格、正文句式、PDF 表行），
 *      不从搜索摘要、模型输出或页面导航文本生成事实；
 *   3. 表格与正文互为交叉证据：能同时取到时逐项比对，不一致就如实报冲突，
 *      两方原值都保留（不取平均、不择一覆盖）；
 *   4. 单位/日期/适用性由确定性规则判定；解析不出就返回明确的 reason，
 *      不返回"看起来像"的默认值。
 */

/* ==================================================================== */
/*  一、通用 HTML 工具                                                  */
/* ==================================================================== */

const NAMED_ENTITIES = {
  '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'",
  '&ldquo;': '“', '&rdquo;': '”', '&mdash;': '—', '&ndash;': '–', '&hellip;': '…',
};

export function decodeEntities(s) {
  return String(s ?? '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&[a-z]+;|&#39;/gi, (m) => NAMED_ENTITIES[m.toLowerCase()] ?? NAMED_ENTITIES[m] ?? m);
}

/** 去标签取纯文本（保留单元格内的换行语义为空格）。 */
export function stripTags(html) {
  return decodeEntities(
    String(html ?? '')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/[\s\u00a0]+/g, ' ')
    .trim();
}

/**
 * 把一张 `<table>` 还原成矩阵（处理 colspan/rowspan 占位）。
 * 这是「Excel 粘贴到网页」这类表格取数的关键：不展开 rowspan 会串行。
 * @returns {Array<Array<string>>}
 */
export function tableToMatrix(tableHtml) {
  const raw = [];
  for (const trm of String(tableHtml).matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [];
    for (const tdm of trm[1].matchAll(/<(t[dh])([^>]*)>([\s\S]*?)<\/\1>/gi)) {
      const attrs = tdm[2] || '';
      cells.push({
        text: stripTags(tdm[3]),
        colspan: Math.max(1, Number((attrs.match(/colspan\s*=\s*"?(\d+)/i) || [])[1] || 1)),
        rowspan: Math.max(1, Number((attrs.match(/rowspan\s*=\s*"?(\d+)/i) || [])[1] || 1)),
      });
    }
    if (cells.length) raw.push(cells);
  }
  // 展开：先按 rowspan 预占位，再按 colspan 铺开
  const grid = [];
  const pending = new Map(); // colIndex -> { text, left }
  raw.forEach((cells, r) => {
    const row = [];
    let c = 0;
    const put = (v) => { row[c] = v; c += 1; };
    for (const cell of cells) {
      while (pending.has(c) && pending.get(c).left > 0) {
        const p = pending.get(c);
        put(p.text);
        p.left -= 1;
        if (p.left <= 0) pending.delete(c);
      }
      put(cell.text);
      for (let k = 1; k < cell.colspan; k += 1) put(cell.text);
      if (cell.rowspan > 1) {
        for (let k = 0; k < cell.colspan; k += 1) {
          pending.set(c - cell.colspan + k, { text: cell.text, left: cell.rowspan - 1 });
        }
      }
    }
    while (pending.has(c) && pending.get(c).left > 0) {
      const p = pending.get(c);
      put(p.text);
      p.left -= 1;
      if (p.left <= 0) pending.delete(c);
    }
    // 补齐空洞
    for (let i = 0; i < row.length; i += 1) if (row[i] === undefined) row[i] = '';
    grid[r] = row;
  });
  return grid;
}

export function allTables(html) {
  return [...String(html ?? '').matchAll(/<table[\s\S]*?<\/table>/gi)].map((m) => m[0]);
}

/** 解析千分位数字；'-'、'—'、'' 一律返回 null（不是 0）。 */
export function parseNumberCell(text) {
  const s = String(text ?? '').replace(/[\s\u00a0,，]/g, '');
  if (!s || s === '-' || s === '—' || s === '–') return null;
  if (!/^[-+]?\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/* ==================================================================== */
/*  二、反爬 / 校验页识别（绝不当正文）                                 */
/* ==================================================================== */

/** 正文为空 + JS 挑战脚本特征 */
export function looksLikeJsChallenge(html) {
  const src = String(html ?? '');
  if (src.length > 20000) return false;
  const bodyEmpty = /<body[^>]*>\s*<\/body>/i.test(src) || !/<body[\s\S]*?\S[\s\S]*?<\/body>/i.test(src);
  const challenge = /\$_ts\s*=|_ts\.cd\s*=|\/2dFsELm1TcWE\/|document\.cookie|location\.reload/i.test(src);
  const meta = /<meta\s+id=["'][A-Za-z0-9]{8,}["']\s+content=/i.test(src);
  return challenge && (bodyEmpty || meta);
}

/** 登录页特征（不登录、不绕过） */
export function looksLikeLoginPage(html, url = '') {
  const src = String(html ?? '');
  if (/\/(login|signin|cas\/login)/i.test(String(url))) return true;
  const hasPwd = /type\s*=\s*["']password["']/i.test(src);
  const hasLoginWord = /(用户登录|登录系统|账号登录|统一身份认证|请先登录)/.test(src);
  return hasPwd && hasLoginWord;
}

/**
 * NCSC 门户的「加载壳」：访客路径与官方门户链接都返回这 14 个字。
 * HTTP 200 / 抓取 ok **不等于**资料成功：识别出来就不入因子、不计解析成功。
 * 只有当整页正文除掉这一句后没有其他实义内容时才判定为加载壳，
 * 避免把正文里恰好引用这句话的页面误判。
 */
export const NCSC_LOADING_SHELL_TEXT = '正在加载系统资源，请耐心等待';

export function looksLikeLoadingShell(text) {
  const s = String(text ?? '').replace(/\s+/g, '');
  if (!s.includes(NCSC_LOADING_SHELL_TEXT)) return false;
  const rest = s.split(NCSC_LOADING_SHELL_TEXT).join('').trim();
  return rest.length <= 24;
}

/**
 * 判定一次抓取结果能否作为正文使用。
 * @returns {{ok:boolean, reason?:string, message?:string}}
 */
export function assessFetchedDocument({ httpStatus = null, html = '', url = '', contentType = '' } = {}) {
  if (/application\/pdf/i.test(String(contentType))) {
    return { ok: false, reason: 'pdf_not_supported', message: '目标为 PDF：需走 PDF 解析器，不能当 HTML 正文' };
  }
  if (Number(httpStatus) === 412) {
    return {
      ok: false, reason: 'http_412_challenge',
      message: 'HTTP 412：来源返回 JS 校验页（正文为空）。不得当作正文，也不得破解校验或猜测 API。',
    };
  }
  if (Number(httpStatus) === 401 || Number(httpStatus) === 403) {
    return { ok: false, reason: `http_${httpStatus}`, message: `HTTP ${httpStatus}：来源拒绝匿名访问，不做绕过。` };
  }
  if (!html) return { ok: false, reason: 'empty_response', message: '响应为空' };
  if (looksLikeJsChallenge(html)) {
    return {
      ok: false, reason: 'http_412_challenge',
      message: '响应体为 JS 反爬/校验页（<body> 为空 + 挑战脚本）。不得当作正文，也不得破解校验。',
    };
  }
  // 抓取服务已渲染的 markdown/纯文本可能不含标签：两种形态都要判定加载壳。
  const plain = /<[a-z!/][^>]*>/i.test(String(html)) ? stripTags(html) : String(html).trim();
  if (looksLikeLoadingShell(plain)) {
    return {
      ok: false, reason: 'loading_shell',
      message:
        `响应体为前端「加载壳」（源码即 “${NCSC_LOADING_SHELL_TEXT}”）：` +
        'HTTP 200 与抓取成功都**不等于**取得资料，本页不作为正文、不入因子、不计解析成功。',
    };
  }
  if (looksLikeLoginPage(html, url)) {
    return { ok: false, reason: 'login_required', message: '响应体为登录页：本库不登录企业/管理平台账户。' };
  }
  return { ok: true };
}

/* ==================================================================== */
/*  三、中碳登：列表发现 + 日报详情解析                                 */
/* ==================================================================== */

/**
 * 从列表页按**真实 a.href** 发现详情链接（不拼猜 URL）。
 * @returns {Array<{url:string, href:string, title:string|null, date_label:string|null}>}
 */
export function discoverCrcDetailLinks(html, { baseUrl = 'https://www.chinacrc.net.cn/' } = {}) {
  const out = [];
  const seen = new Set();
  for (const m of String(html ?? '').matchAll(
    /<dl\b[^>]*>([\s\S]*?)<\/dl>/gi
  )) {
    const block = m[1];
    const titles = [...block.matchAll(/<span[^>]*class\s*=\s*["'][^"']*\btitle\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/gi)]
      .map((x) => stripTags(x[1])).filter(Boolean);
    const dm = block.match(/<span[^>]*class\s*=\s*["'][^"']*\bdata\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/i);
    const ym = block.match(/<span[^>]*class\s*=\s*["'][^"']*\byear\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/i);
    for (const am of block.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["']/gi)) {
      const href = am[1];
      let url;
      try {
        url = new URL(href, baseUrl).href;
      } catch {
        continue;
      }
      if (!/\/view\/\d+\.html/i.test(new URL(url).pathname)) continue;
      if (seen.has(url)) continue;
      seen.add(url);
      out.push({
        url,
        href,
        title: titles[0] || null,
        date_label: dm ? `${(ym ? stripTags(ym[1]) : '').trim()}-${stripTags(dm[1]).trim()}` : null,
      });
    }
  }
  return out;
}

const CRC_NUM = '(\\d[\\d,]*(?:\\.\\d+)?)';

/** 从正文段落取数（关键第二证据）。 */
export function parseCrcDailyProse(text) {
  const s = String(text ?? '').replace(/\s+/g, '');
  const grab = (re) => {
    const m = s.match(re);
    return m ? parseNumberCell(m[1]) : null;
  };
  return {
    daily_volume_t: grab(new RegExp(`成交总量${CRC_NUM}吨`)),
    daily_amount_yuan: grab(new RegExp(`成交总额${CRC_NUM}元`)),
    daily_avg_price_published: grab(new RegExp(`成交均价${CRC_NUM}元/吨`)),
    cumulative_volume_t: grab(new RegExp(`累计成交总量${CRC_NUM}吨`)),
    cumulative_amount_yuan: grab(new RegExp(`累计成交总额${CRC_NUM}元`)),
  };
}

/**
 * 解析中碳登清结算信息日报详情页。
 * @returns {{ok:boolean, reason?:string, message?:string, data?:object}}
 */
export function parseCrcDailyDetail(html, { url = '', httpStatus = 200 } = {}) {
  const blocked = assessFetchedDocument({ httpStatus, html, url });
  if (!blocked.ok) return { ok: false, reason: blocked.reason, message: blocked.message };

  const src = String(html);
  // 文章标题：必须取**正文容器**里的 div.title。
  // 页面上导航/页脚也有 .title 类，直接全局取第一个会拿到栏目名（实测会取到「关于公司」）。
  const leftIdx = src.search(/<div[^>]*class\s*=\s*["'][^"']*\bcont_left\b[^"']*["']/i);
  const wrapIdx = src.search(/<div[^>]*class\s*=\s*["'][^"']*\bwrapIntel\b[^"']*["']/i);
  const scope = leftIdx >= 0 ? src.slice(leftIdx, wrapIdx > leftIdx ? wrapIdx : undefined) : src;
  const titleM = scope.match(/<div[^>]*class\s*=\s*["'][^"']*\btitle\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);
  const title = titleM ? stripTags(titleM[1]) : null;
  const pubM = src.match(/发布时间\s*[：:]\s*(\d{4}-\d{2}-\d{2})/);
  const publishedAt = pubM ? pubM[1] : null;
  const dateM = String(title || '').match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
  const tradeDate = dateM
    ? `${dateM[1]}-${String(dateM[2]).padStart(2, '0')}-${String(dateM[3]).padStart(2, '0')}`
    : publishedAt;

  // ---- 表格：交易合计行 + 分层明细 ----
  let total = null;
  let components = [];
  for (const t of allTables(src)) {
    const grid = tableToMatrix(t);
    if (!grid.length) continue;
    const flat = grid.map((r) => r.join('|'));
    if (!flat.some((r) => /交易合计/.test(r))) continue;
    for (const row of grid) {
      const cells = row.map((c) => String(c || '').trim());
      if (cells[0] === '交易合计') {
        const nums = cells.map(parseNumberCell).filter((v) => v !== null);
        if (nums.length >= 4) {
          total = {
            daily_volume_t: nums[nums.length - 4],
            daily_amount_yuan: nums[nums.length - 3],
            cumulative_volume_t: nums[nums.length - 2],
            cumulative_amount_yuan: nums[nums.length - 1],
          };
        }
      }
    }
    if (!total) continue;
    let currentYear = null;
    for (const row of grid) {
      const cells = row.map((c) => String(c || '').trim());
      if (/^碳排放配额/.test(cells[0])) currentYear = cells[0];
      const method = cells[1];
      if (!currentYear || !/^(挂牌协议交易|大宗协议交易|单向竞价|小计)$/.test(method)) continue;
      components.push({
        year_label: currentYear,
        trade_method: method,
        is_subtotal: method === '小计' ? 1 : 0,
        counts_to_total: method === '小计' ? 1 : 0,
        daily_volume_t: parseNumberCell(cells[2]),
        daily_amount_yuan: parseNumberCell(cells[3]),
        cumulative_volume_t: parseNumberCell(cells[4]),
        cumulative_amount_yuan: parseNumberCell(cells[5]),
      });
    }
    break;
  }
  if (!total) {
    return {
      ok: false, reason: 'table_not_found',
      message: '详情页未找到「交易合计」行：结构可能已变更，本次不写入任何数值（不用导航/摘要文本凑数）。',
    };
  }

  // ---- 正文：第二证据 ----
  const wrapM = src.match(/<div[^>]*class\s*=\s*["'][^"']*\bwrapIntel\b[^"']*["'][^>]*>([\s\S]*?)<\/div>\s*<\/div>/i);
  const proseText = stripTags(wrapM ? wrapM[1] : src);
  const prose = parseCrcDailyProse(proseText);

  // ---- 交叉核对：表格 vs 正文 ----
  const fields = ['daily_volume_t', 'daily_amount_yuan', 'cumulative_volume_t', 'cumulative_amount_yuan'];
  const cross = {};
  const conflicts = [];
  for (const f of fields) {
    const a = total[f];
    const b = prose[f];
    cross[f] = { table: a, prose: b, agree: a !== null && b !== null && Math.abs(a - b) < 1e-6 };
    if (a !== null && b !== null && !cross[f].agree) conflicts.push(f);
  }

  // ---- 公布均价：原文值与复算值分开保存 ----
  const published = prose.daily_avg_price_published;
  const derived = total.daily_volume_t && total.daily_amount_yuan
    ? total.daily_amount_yuan / total.daily_volume_t
    : null;

  // ---- 明细 → 小计 → 合计 的加总关系（用于「不重复加总」） ----
  const subtotals = components.filter((c) => c.counts_to_total === 1);
  const sumOfSubtotals = subtotals.reduce((acc, c) => ({
    daily_volume_t: (acc.daily_volume_t ?? 0) + (c.daily_volume_t ?? 0),
    daily_amount_yuan: (acc.daily_amount_yuan ?? 0) + (c.daily_amount_yuan ?? 0),
    cumulative_volume_t: (acc.cumulative_volume_t ?? 0) + (c.cumulative_volume_t ?? 0),
    cumulative_amount_yuan: (acc.cumulative_amount_yuan ?? 0) + (c.cumulative_amount_yuan ?? 0),
  }), { daily_volume_t: 0, daily_amount_yuan: 0, cumulative_volume_t: 0, cumulative_amount_yuan: 0 });
  const subtotalAgrees = subtotals.length > 0 && Object.keys(sumOfSubtotals).every((k) =>
    total[k] !== null && Math.abs(sumOfSubtotals[k] - total[k]) < 0.005);

  return {
    ok: true,
    data: {
      url,
      title,
      trade_date: tradeDate,
      published_at: publishedAt,
      ...total,
      daily_avg_price_published: published,
      daily_avg_price_derived: derived,
      avg_price_origin: published !== null ? 'published' : derived !== null ? 'derived' : 'none',
      caliber: '全国碳排放权交易市场（中碳登清结算信息日报口径：交易合计行）',
      scope: 'market_total',
      table_prose_cross_check: { fields: cross, conflicts, agree: conflicts.length === 0 },
      subtotal_check: { subtotal_rows: subtotals.length, sum_of_subtotals: sumOfSubtotals, agree: subtotalAgrees },
      components,
      raw_prose: proseText.slice(0, 2000),
    },
  };
}

/* ==================================================================== */
/*  四、生态环境部公告页：真实附件发现                                  */
/* ==================================================================== */

/**
 * 提取公告页中的**真实**附件链接（沿原文 href 解析为绝对 URL，绝不拼猜）。
 * 注意：`baseUrl` 必须是**该公告页自身**的 URL——相对 href（如 `./W0202….pdf`）
 * 只有相对公告页所在目录解析才得到正确 PDF 地址。
 * @returns {{title:string|null, files:Array<{url:string,href:string,anchor:string,kind:string,code:string|null}>}}
 */
export function parseAnnouncementAttachments(html, { baseUrl = '' } = {}) {
  const title = stripTags((String(html).match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1]) || null;
  const files = [];
  const seen = new Set();
  for (const m of String(html ?? '').matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const href = (m[1].match(/href\s*=\s*["']([^"']+)["']/i) || [])[1];
    if (!href) continue;
    if (!/\.(pdf|docx?|xlsx?)(\?|$)/i.test(href)) continue;
    let url;
    try {
      url = new URL(href, baseUrl || 'https://www.mee.gov.cn/').href;
    } catch {
      continue;
    }
    if (seen.has(url)) continue;
    seen.add(url);
    const anchor = stripTags(m[2]);
    const codeM = anchor.match(/CETS[—\-–]?(A?V?G?)[—\-–]?(\d{2}\.\d{2})[—\-–]?(V\d{2})[—\-–]?(\d{4})/i)
      || anchor.match(/(CETS-[A-Z]{2}-\d{2}\.\d{2}-V\d{2}-\d{4})/i);
    let code = null;
    if (codeM) {
      if (codeM[1] && codeM[2]) code = `CETS-${String(codeM[1]).toUpperCase()}-${codeM[2]}-${String(codeM[3]).toUpperCase()}-${codeM[4]}`;
      else code = String(codeM[1]).toUpperCase();
    }
    files.push({
      url,
      href,
      anchor,
      kind: /更新内容/.test(anchor) ? 'update_note' : /核查/.test(anchor) ? 'verification' : /核算与报告/.test(anchor) ? 'accounting' : 'attachment',
      code,
    });
  }
  return { title, files };
}

/* ==================================================================== */
/*  五、2023 年电力 CO2 因子 PDF：逐页 → 40 行                          */
/* ==================================================================== */

export const ELECTRICITY_FACTOR_PDF_URL =
  'https://www.mee.gov.cn/xxgk2018/xxgk/xxgk01/202512/W020251231726284332528.pdf';

const TABLE_SECTIONS = [
  { re: /表\s*1\b/, category: 'national_average', level: 'national', table: '表1' },
  { re: /表\s*2\b/, category: 'regional_average', level: 'region', table: '表2' },
  { re: /表\s*3\b/, category: 'provincial_average', level: 'province', table: '表3' },
  { re: /表\s*4\b/, category: 'national_excl_market_nonfossil', level: 'national', table: '表4' },
  { re: /表\s*5\b/, category: 'national_fossil', level: 'national', table: '表5' },
];

/** 表号 → 原文表标题（locator 用，逐字取自 PDF 正文）。 */
const TABLE_TITLES = {
  表1: '表1 2023 年全国电力平均二氧化碳排放因子',
  表2: '表2 2023 年区域电力平均二氧化碳排放因子',
  表3: '表3 2023 年省级电力平均二氧化碳排放因子',
  表4: '表4 2023 年全国电力平均二氧化碳排放因子（不包括市场化交易的非化石能源电量）',
  表5: '表5 2023 年全国化石能源电力二氧化碳排放因子',
};

/**
 * 表号 → 口径说明。三种全国口径**不可互换**，口径随行保存，
 * 下游（存储/界面/计算）都据此显示，不允许只留一个 0.5306。
 */
const TABLE_CALIBERS = {
  表1: '全国电力平均二氧化碳排放因子（表1）；2023 数据年度',
  表2: '区域电力平均二氧化碳排放因子（表2）；2023 数据年度',
  表3: '省级电力平均二氧化碳排放因子（表3）；2023 数据年度；不含西藏（原文未列）',
  表4: '全国电力平均二氧化碳排放因子（不包括市场化交易的非化石能源电量）（表4）；与表1 口径不同，不得互换',
  表5: '全国化石能源电力二氧化碳排放因子（表5）；仅化石能源电力，与表1 口径不同，不得互换',
};

/** 找出该页的打印页码（形如 `— 3 —` / `- 4 -`）。 */
export function printedPageOf(pageText) {
  const m = String(pageText ?? '').match(/[—–-]\s*(\d{1,4})\s*[—–-]/);
  return m ? m[1] : null;
}

/**
 * 把 pdftotext 逐页文本解析为因子行。
 * @param {string[]} pages 物理页文本（索引 0 = 物理页 1）
 * @returns {{ok:boolean, reason?:string, message?:string, rows?:Array, stats?:object}}
 */
export function parseElectricityFactorPages(pages, { url = ELECTRICITY_FACTOR_PDF_URL, sha256 = null } = {}) {
  const list = Array.isArray(pages) ? pages : [];
  if (!list.length || !list.some((p) => String(p || '').trim())) {
    return { ok: false, reason: 'no_text', message: 'PDF 无可提取文本（扫描件或解析失败），不产生任何因子行' };
  }
  const rows = [];
  let current = null;
  const seenTables = new Set();
  list.forEach((pageText, idx) => {
    const pagePhysical = idx + 1;
    const pagePrinted = printedPageOf(pageText);
    for (const line of String(pageText).split(/\r?\n/)) {
      const heading = TABLE_SECTIONS.find((s) => s.re.test(line) && /电力|排放因子/.test(line));
      if (heading) {
        current = heading;
        seenTables.add(heading.table);
        continue;
      }
      if (!current) continue;
      // 数值行：`<地区>  <0.0000>`（表1/4/5 地区为「全国」）
      const m = line.match(/^\s*([\u4e00-\u9fa5A-Za-z]{2,10})\s+(\d+\.\d{4})\s*$/);
      if (!m) continue;
      const region = m[1];
      const value = Number(m[2]);
      if (!Number.isFinite(value) || value <= 0 || value > 10) continue;
      rows.push({
        category: current.category,
        region_level: current.level,
        region: current.level === 'national' ? null : region,
        region_label: current.level === 'national' ? '全国' : region,
        value,
        original_unit: 'kgCO2/kWh',
        gas: 'CO2',
        data_year: 2023,
        page_physical: pagePhysical,
        page_printed: pagePrinted,
        locator: `${TABLE_TITLES[current.table]}｜${current.level === 'national' ? '全国' : region}`,
        caliber: TABLE_CALIBERS[current.table],
        source: { url, sha256 },
      });
    }
  });

  if (!rows.length) {
    return { ok: false, reason: 'no_rows', message: '未从 PDF 文本中识别到任何因子行（不写入任何推测值）' };
  }

  const byCategory = {};
  for (const r of rows) byCategory[r.category] = (byCategory[r.category] || 0) + 1;

  // 结构校验：本附件固定 1/7/30/1/1 = 40 行；结构不符则如实报告，不自动"补齐"
  const expected = {
    national_average: 1, regional_average: 7, provincial_average: 30,
    national_excl_market_nonfossil: 1, national_fossil: 1,
  };
  const mismatch = Object.entries(expected)
    .filter(([k, n]) => (byCategory[k] || 0) !== n)
    .map(([k, n]) => `${k}: 期望 ${n}，实得 ${byCategory[k] || 0}`);

  const stats = {
    rows: rows.length,
    by_category: byCategory,
    tables: [...seenTables].sort(),
    printed_pages: [...new Set(rows.map((r) => r.page_printed).filter(Boolean))],
    national_average: rows.find((r) => r.category === 'national_average')?.value ?? null,
    national_excl_market_nonfossil: rows.find((r) => r.category === 'national_excl_market_nonfossil')?.value ?? null,
    national_fossil: rows.find((r) => r.category === 'national_fossil')?.value ?? null,
    // 原文未列西藏：不得自动补
    has_tibet: rows.some((r) => r.region === '西藏'),
    structurally_expected: mismatch.length === 0,
    mismatch,
  };
  return { ok: true, rows, stats };
}

/* ==================================================================== */
/*  六、CETS 公开门户（全国碳市场信息网）解析                            */
/* ==================================================================== */
/**
 * 公开门户名称为**全国碳市场信息网**；后台企业管理系统链接与公开信息网站分开，
 * 因此解析时：
 *   · 站点导航（栏目树/办事服务/页脚）**不是正文**，必须去掉；
 *   · 列表页只计**本页实际出现**的条目数；分页 `#` 占位链接不猜 API、不拼页码；
 *   · 页面「共 N 条」只是**栏目宣称总量**，必须与「本页实际获得」分列；
 *   · 问答页按 `问 … 答 …` 结构拆分，一条问答一条记录。
 * 输入既支持真实 HTML，也支持已渲染抓取返回的 markdown/纯文本。
 */

/** 首页页脚确认的权威主体（原文表述）。 */
export const CETS_PORTAL_NAME = '全国碳市场信息网';
export const CETS_AUTHORITY_NOTE =
  '指导单位：生态环境部应对气候变化司；业务审核单位：国家应对气候变化战略研究和国际合作中心；技术支持：生态环境部信息中心（门户页脚原文）。';

/** 该抓取结果是否为已渲染文本（markdown/纯文本）而不是 HTML。 */
function isPlainRendered(text) {
  const s = String(text ?? '');
  return !/<(html|body|div|table|ul|dl|a)\b/i.test(s);
}

/**
 * 去掉站点导航/页脚，只留列表或文章正文区。
 * HTML：优先取 `当前位置：` 之后的区域；纯文本：同样按 `当前位置：` 切分。
 */
export function stripCetsChrome(source) {
  const raw = String(source ?? '');
  const plain = isPlainRendered(raw);
  const text = plain ? raw : stripTags(raw);
  const lines = text.split(/\r?\n/);

  // 1. 去掉「当前位置：…」之前的一切（首页横幅 + 一二级栏目树 + 办事服务入口）
  let start = lines.findIndex((l) => /当前位置\s*[：:]/.test(l));
  if (start < 0) start = 0;

  // 2. 去掉页脚之后的一切
  let end = lines.length;
  for (let i = start; i < lines.length; i += 1) {
    if (/(网站地图|指导单位\s*[：:]|业务审核单位\s*[：:]|ICP备案编号)/.test(lines[i])) { end = i; break; }
  }
  return lines.slice(start, end).join('\n').trim();
}

/** 面包屑（当前位置）→ 栏目路径数组。 */
export function breadcrumbOf(source) {
  const text = isPlainRendered(source) ? String(source) : stripTags(source);
  const m = text.match(/当前位置\s*[：:]\s*([^\n]+)/);
  if (!m) return [];
  return m[1]
    .split(/>/)
    .map((x) => stripTags(x).replace(/\[[^\]]*\]/g, '').replace(/\\/g, '').trim())
    .filter((x) => x && x !== '首页');
}

/** 列表条目标题清理：去掉换行标记 `\` 与首尾空白（真实抓取件里换行会渲染成 `\\`）。 */
function cleanEntryTitle(t) {
  return String(t || '')
    .replace(/(\\\s*)+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 是否「栏目导航/控件」行（去导航用）。
 * 真实抓取渲染件里：栏目树是 `- [名称](…index.jhtml)`，页面图标是
 * `- ![](…/zu43965.png)`，两者都**不是**正文或问答。
 */
function isNavLine(line) {
  const s = String(line || '').trim();
  if (!s) return true;
  if (/^#{1,6}\s/.test(s)) return true;                                  // 标题
  if (/^当前位置|^(字号|\[打印\]|分享到|责任编辑|扫一扫)/.test(s)) return true;
  if (/^(网站地图|指导单位|业务审核单位|ICP备案编号|\.\.\.)$/.test(s)) return true;
  if (/^(共\s*[\d,]+\s*条|第\s*\d*\s*页|\d+|\d{4,})$/u.test(s)) return true; // 分页/页码串
  // 整行只由链接与分隔符组成（面包屑续行）
  if (/\[[^\]]*\\?\]\([^)]*\)/.test(s)
    && s.replace(/\[[^\]]*\\?\]\([^)]*\)/g, '').replace(/[\\>\s]/g, '').length < 8) return true;
  return false;
}

function isMenuItemLine(line) { return /^[-*]\s+\[/.test(String(line).trim()); }

/** 列表页宣称总量：`共40条`。只作为 announced_count，绝不当作实际入库数。 */
export function parseAnnouncedCount(source) {
  const text = isPlainRendered(source) ? String(source) : stripTags(source);
  const m = text.match(/共\s*([\d,]+)\s*条/);
  return m ? Number(String(m[1]).replace(/,/g, '')) : null;
}

/** 栏目是否为空：`共0条`（如企业端办事指南当前 0 条）。 */
export function cetsSectionIsEmpty(source) {
  const n = parseAnnouncedCount(source);
  return n === 0;
}

/**
 * 解析 CETS 列表页（标准规范 / 政策文件 / 通知公告 / 办事指南 / 公开入口）。
 * 只取「当前位置」之后的真实条目；条目标题 + 日期 + 详情 URL。
 * @returns {{title:string|null, entries:Array<{url,title,published_at}>, announced_count:number|null,
 *            observed_count:number, is_empty:boolean, pagination:{placeholder:boolean,page_numbers:number[]}}}
 */
export function parseCetsListPage(source, { baseUrl = 'https://www.cets.org.cn/' } = {}) {
  const raw = String(source ?? '');
  const plain = isPlainRendered(raw);
  const body = stripCetsChrome(raw);
  const heading = (body.split(/\r?\n/).find((l) => /^#{3,4}\s*\S/.test(l)) || '').replace(/^#+\s*/, '').trim() || null;
  const entries = [];
  const seen = new Set();

  // 条目形态（已渲染 markdown 与真实 HTML 去标签后一致）：
  //   - [标题 2026-10-10](https://www.cets.org.cn/bzgf/7487.jhtml)
  //   - [标题](url)            日期
  const push = (title, url, date) => {
    const t = String(title || '').replace(/\s+/g, ' ').trim();
    if (!t || !url) return;
    let u;
    try { u = new URL(url, baseUrl).href; } catch { return; }
    // 栏目自身与分页 `#` 占位链接不是条目：详情条目形如 /bzgf/7487.jhtml
    if (!/\/\d+\.jhtml$/i.test(new URL(u).pathname)) return;
    if (seen.has(u)) return;
    try {
      const h = new URL(u).hostname;
      if (!/(^|\.)cets\.org\.cn$/i.test(h)) return;
    } catch { return; }
    seen.add(u);
    entries.push({ url: u, title: t, published_at: date || null });
  };

  for (const m of body.matchAll(/\[([^\]]+)\]\((https?:\/\/[^)\s]+|\/[^)\s]+)\)/g)) {
    const label = cleanEntryTitle(m[1]);
    const dm = label.match(/(20\d{2}-\d{2}-\d{2})\s*$/);
    push(dm ? label.slice(0, dm.index).trim() : label, m[2], dm ? dm[1] : null);
  }
  if (!plain) {
    for (const m of raw.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
      const href = m[1];
      if (!/\.jhtml/i.test(href)) continue;
      const label = cleanEntryTitle(stripTags(m[2]));
      const dm = label.match(/(20\d{2}-\d{2}-\d{2})/);
      push(dm ? label.replace(dm[1], '').trim() : label, href, dm ? dm[1] : null);
    }
  }

  // 分页：`[1](…#)` 这类 `#` 占位说明分页由前端脚本完成 → 不猜 API
  const paginationRaw = [...body.matchAll(/\[(\d{1,3})\]\(([^)]*)\)/g)];
  const placeholder = paginationRaw.length > 0 && paginationRaw.every((m) => /#\s*$/.test(m[2]));
  return {
    title: heading,
    entries,
    announced_count: parseAnnouncedCount(raw),
    observed_count: entries.length,
    is_empty: cetsSectionIsEmpty(raw) || (!entries.length && parseAnnouncedCount(raw) === 0),
    pagination: {
      placeholder,
      page_numbers: paginationRaw.map((m) => Number(m[1])).filter((n) => Number.isFinite(n)),
    },
  };
}

/**
 * 拆分百问百答页面：按「问 … 答 …」结构提取。
 * 结构特征（真实抓取文本，见 cets-general-faq.md / cets-power-faq.md）：
 *   问题段 → `答:` → 回答段（可能跨多行），重复出现。
 * 只做**结构切分**：不改写、不摘要、不生成问题；栏目导航与菜单**不是问答**。
 */
export function parseCetsFaqPage(source, { baseUrl = 'https://www.cets.org.cn/' } = {}) {
  const body = stripCetsChrome(source);
  // The publisher uses one observed question icon per accordion entry. Split actual blocks,
  // rather than guessing question boundaries from arbitrary sentence length or navigation.
  const blocks = body.split(/[-*]\s*!\[[^\]]*\]\([^)]*\/zu43965\.png\)/i).slice(1);
  const qa=[];
  for (let block of blocks) {
    block=block.replace(/!\[[^\]]*\]\([^)]*\)/g,'').split(/\n\s*\[1\]\(/)[0];
    const m=/^\s*答\s*[：:]\s*$/m.exec(block);
    if(!m) continue;
    const question=block.slice(0,m.index).replace(/\s+/g,' ').trim();
    const answer=block.slice(m.index+m[0].length).replace(/^\s*答\s*[：:]\s*/,'').replace(/\s+/g,' ').trim();
    if(question.length>=6 && answer) qa.push({question,answer});
  }
  return {title:'百问百答',qa,observed_count:qa.length,announced_count:parseAnnouncedCount(source),breadcrumb:breadcrumbOf(source),note:'仅本页实际问答；原站未标发布日期。历史指南答复请结合现行规范使用。'};
}

/**
 * 解析 CETS 详情/文章页正文（如 bzgf/7487.jhtml 的 CCER 造林碳汇 V02 公告）。
 * 去导航后返回正文段落、发布日期与来源；附件以**真实 href** 登记（不拼猜 URL）。
 */
export function parseCetsArticlePage(source, { baseUrl = 'https://www.cets.org.cn/' } = {}) {
  const raw = String(source ?? '');
  const body = stripCetsChrome(raw);
  const all = body.split(/\r?\n/).map((l) => l.replace(/!\[\]\([^)]*\)/g, ' ').trim());
  // 详情页正文以**文章标题**（`# 标题`，与 `####` 栏目标题区分）为界
  let h1 = all.findIndex(l=>/^#\s+\S/.test(l));
  const hasBodyHeading=h1>=0;
  if(h1<0)h1=all.findIndex(l=>/^####\s+\S/.test(l));
  const title = h1 >= 0 ? all[h1].replace(/^#+\s*/, '').trim() : null;
  const printIndex=all.findIndex((l,i)=>i>h1&&l.includes('打印'));
  const split=hasBodyHeading?h1:(printIndex>=0?printIndex:h1);
  const head = (split >= 0 ? all.slice(0, split) : all).filter(Boolean);
  const contentArea = split >= 0 ? all.slice(split + 1) : [];
  const dateM = head.join(' ').match(/20\d{2}-\d{2}-\d{2}/);
  const srcM = head.find(l=>/^来源\s*[：:]/.test(l))?.match(/^来源\s*[：:]\s*(.+)$/);
  const content = contentArea
    .filter((l) => l && !/^(字号|\[打印\]|分享到|责任编辑|扫一扫)/.test(l))
    .filter((l) => !/^\[[^\]]*\\?\]\([^)]*\)\s*[\\>\s]*$/.test(l))
    .filter((l) => !isNavLine(l))
    .filter((l) => !isMenuItemLine(l))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const attachments = [];
  const seen = new Set();
  for (const m of raw.matchAll(/\[([^\]]+)\]\((https?:\/\/[^)\s]+\.(?:pdf|docx?|xlsx?))\)/gi)) {
    let u;
    try { u = new URL(m[2], baseUrl).href; } catch { continue; }
    if (seen.has(u)) continue;
    seen.add(u);
    attachments.push({ url: u, anchor: cleanEntryTitle(stripTags(m[1])).replace(/^附件\s*[：:]\s*/, '').trim() });
  }
  return {
    title,
    published_at: dateM ? dateM[0] : null,
    issuer: srcM ? srcM[1].trim() : null,
    body_text: content || null,
    attachments,
    breadcrumb: breadcrumbOf(raw),
    body_chars: content.length,
  };
}

