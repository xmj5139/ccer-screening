/**
 * 来源显示服务（source-display-svc）
 * ============================================================================
 * 需求（docs/44 第 2 条）：
 *   - 最新研报与行业动态（总览、内容模块、CEA 研报）**不再以「证据充足/不足/
 *     自动核验」等标签呈现，以来源为主**；
 *   - 官方网站显示「官方信息」，第三方显示**实际发布机构 / 网站名**；
 *   - 官方域名必须按 **hostname 精确或受控子域**匹配，不可 contains、不可
 *     「.gov.cn 字符串包含」、不可由模型自己判断，也不可把「转载官方」的第三方
 *     认定为官网；
 *   - 来源未知时显示网站域名或「来源未标注」，**不得杜撰**；
 *   - 内部核验数据保留后台，不在公开列表以核验标签呈现。
 *
 * 匹配规则（唯一）：
 *   host === domain            （match_mode='exact'）
 *   host.endsWith('.' + domain)（match_mode='subdomain'）
 * 例如 mee.gov.cn 命中 www.mee.gov.cn，但**不**命中：
 *   - notmee.gov.cn / mee.gov.cn.evil.com / evil.com/mee.gov.cn（路径不参与判定）
 *   - 任何摘要里自称「转自生态环境部」的第三方站点
 *
 * 本模块不读模型输出、不读页面自述，只用 URL 的 hostname 与来源登记表。
 */
import { all, get, run, audit } from '../core/db.mjs';
import { nowIso } from '../core/util.mjs';

/* ==================================================================== */
/*  一、内置官方域名登记（首次打开自动补种，管理员可增补）                 */
/* ==================================================================== */

/**
 * 内置官方域名。kind：
 *   official —— 政府 / 主管部门
 *   registry —— 国家登记系统
 *   exchange —— 官方交易机构
 * 只登记**域名本身**，匹配时按精确 / 受控子域判定，不做任何后缀字符串包含。
 */
export const BUILTIN_OFFICIAL_DOMAINS = [
  { domain: 'mee.gov.cn', label: '生态环境部', kind: 'official', match_mode: 'subdomain' },
  { domain: 'ndrc.gov.cn', label: '国家发展和改革委员会', kind: 'official', match_mode: 'subdomain' },
  { domain: 'nea.gov.cn', label: '国家能源局', kind: 'official', match_mode: 'subdomain' },
  { domain: 'most.gov.cn', label: '科学技术部', kind: 'official', match_mode: 'subdomain' },
  { domain: 'miit.gov.cn', label: '工业和信息化部', kind: 'official', match_mode: 'subdomain' },
  { domain: 'moa.gov.cn', label: '农业农村部', kind: 'official', match_mode: 'subdomain' },
  { domain: 'mof.gov.cn', label: '财政部', kind: 'official', match_mode: 'subdomain' },
  { domain: 'samr.gov.cn', label: '国家市场监督管理总局', kind: 'official', match_mode: 'subdomain' },
  // 中国政府网：**只登记 www.gov.cn**（受控子域），不登记 gov.cn——
  // 否则 notmee.gov.cn 之类会被后缀匹配误判为官方（见 test/64 的伪装域名用例）。
  { domain: 'www.gov.cn', label: '中国政府网', kind: 'official', match_mode: 'subdomain' },
  { domain: 'cets.org.cn', label: '全国温室气体自愿减排注册登记系统', kind: 'registry', match_mode: 'subdomain' },
  { domain: 'ccer.com.cn', label: '全国温室气体自愿减排交易系统', kind: 'exchange', match_mode: 'subdomain' },
  { domain: 'cneeex.com', label: '上海环境能源交易所（全国碳市场）', kind: 'exchange', match_mode: 'subdomain' },
  { domain: 'shcneeex.com', label: '上海环境能源交易所（行情网关）', kind: 'exchange', match_mode: 'subdomain' },
  { domain: 'chinacrc.net.cn', label: '全国碳排放权注册登记机构（中碳登）', kind: 'registry', match_mode: 'subdomain' },
  { domain: 'ncsc.org.cn', label: '国家应对气候变化战略研究和国际合作中心（国家温室气体排放因子数据库）', kind: 'official', match_mode: 'subdomain' },
];

/** 幂等补种内置官方域名（不覆盖管理员修改过的行）。 */
export function seedOfficialDomains() {
  let added = 0;
  for (const d of BUILTIN_OFFICIAL_DOMAINS) {
    const exists = get('SELECT domain FROM official_domain WHERE domain=?', [d.domain]);
    if (exists) continue;
    run(
      `INSERT INTO official_domain (domain,label,kind,match_mode,enabled,note,created_at,updated_at)
       VALUES (?,?,?,?,1,?,?,?)`,
      [d.domain, d.label, d.kind, d.match_mode, '内置登记（docs/44 第 2 条：精确 hostname 或受控子域匹配）', nowIso(), nowIso()]
    );
    added += 1;
  }
  return added;
}

/** 全部启用的官方域名（表不可用时退回内置列表，绝不「无匹配即视为官方」）。 */
export function listOfficialDomains({ includeDisabled = false } = {}) {
  try {
    // 空表自动补种内置登记（幂等）：保证任何库都有可用的官方判定依据。
    if (!get('SELECT COUNT(*) AS c FROM official_domain')?.c) seedOfficialDomains();
    const rows = includeDisabled
      ? all('SELECT * FROM official_domain ORDER BY domain')
      : all('SELECT * FROM official_domain WHERE enabled=1 ORDER BY domain');
    if (rows.length) return rows;
  } catch {
    /* 表尚未迁移：使用内置列表 */
  }
  return BUILTIN_OFFICIAL_DOMAINS.map((d) => ({ ...d, enabled: 1 }));
}

/* ==================================================================== */
/*  二、hostname 精确 / 受控子域匹配                                     */
/* ==================================================================== */

/** 从 URL 取规范化 hostname（小写、去端口、去尾部点）。取不到返回 ''。 */
export function hostnameOf(url) {
  try {
    const raw = String(url || '').trim();
    if (!raw) return '';
    const u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    return String(u.hostname || '').toLowerCase().replace(/\.+$/, '');
  } catch {
    return '';
  }
}

/**
 * 单个 host 是否命中某条登记。
 * 绝不使用 includes / 后缀字符串包含：只接受完全相等或「点号分隔的受控子域」。
 */
export function hostMatchesDomain(host, domain, matchMode = 'subdomain') {
  const h = String(host || '').toLowerCase().replace(/\.+$/, '');
  const d = String(domain || '').toLowerCase().replace(/\.+$/, '');
  if (!h || !d) return false;
  if (h === d) return true;
  if (matchMode === 'exact') return false;
  // 受控子域：必须是 d 之前紧跟一个点号，且左边还有内容
  return h.endsWith(`.${d}`) && h.length > d.length + 1;
}

/** 返回命中的官方域名登记（未命中返回 null）。 */
export function matchOfficialDomain(host, domains = null) {
  const list = domains || listOfficialDomains();
  for (const d of list) {
    if (!d || d.enabled === 0) continue;
    if (hostMatchesDomain(host, d.domain, d.match_mode || 'subdomain')) {
      return { domain: d.domain, label: d.label, kind: d.kind || 'official', match_mode: d.match_mode || 'subdomain' };
    }
  }
  return null;
}

/* ==================================================================== */
/*  三、对外展示口径                                                     */
/* ==================================================================== */

/** 去掉常见 www 前缀，只用于展示域名。 */
export function displayHost(host) {
  const h = String(host || '').toLowerCase();
  return h.startsWith('www.') && h.length > 4 ? h.slice(4) : h;
}

/**
 * 计算一条记录的来源展示口径。
 * @param {{url?:string, publisher?:string, site_name?:string, issuer?:string,
 *          source_category?:string, official_url?:string}} input
 * @returns {{kind:'official'|'third_party'|'unknown', label:string, detail:string,
 *            host:string, official_domain:string|null, official_label:string|null,
 *            publisher:string|null, note:string|null}}
 */
export function sourceDisplay(input = {}) {
  const url = input.url || input.source_url || input.official_url || input.page_url || '';
  const host = hostnameOf(url);
  const publisher = firstText(input.publisher, input.site_name, input.issuer);
  const hit = host ? matchOfficialDomain(host) : null;

  if (hit) {
    return {
      kind: 'official',
      label: '官方信息',
      detail: hit.label,
      host: host || null,
      official_domain: hit.domain,
      official_label: hit.label,
      publisher: publisher || hit.label,
      // 来源类别字段即使写着 official，也不改变判定；判定只看 hostname。
      note: '官方域名按 hostname 精确 / 受控子域匹配，依据来源登记表。',
    };
  }

  if (publisher) {
    return {
      kind: 'third_party',
      // 第三方显示**实际发布机构 / 网站名**，不显示「官方」
      label: publisher,
      detail: host ? displayHost(host) : '',
      host: host || null,
      official_domain: null,
      official_label: null,
      publisher,
      note: input.source_category === 'official' && host
        ? '该条自称官方来源，但域名未在官方登记表中命中：按第三方发布机构展示，不认定为官网。'
        : null,
    };
  }

  return {
    kind: 'unknown',
    label: host ? displayHost(host) : '来源未标注',
    detail: '',
    host: host || null,
    official_domain: null,
    official_label: null,
    publisher: null,
    note: host ? null : '采集结果未提供可解析的来源链接，也未标注发布机构。',
  };
}

function firstText(...vals) {
  for (const v of vals) {
    const s = String(v ?? '').trim();
    if (s) return s.slice(0, 200);
  }
  return null;
}

/**
 * 判定一个 host 是否被允许作为官方来源（供采集与台账共用）。
 * 只做 hostname 判定，不看标题、摘要或 source_category。
 */
export function isOfficialUrl(url) {
  const host = hostnameOf(url);
  if (!host) return false;
  return !!matchOfficialDomain(host);
}

/* ==================================================================== */
/*  四、管理员维护接口（增删改官方域名）                                  */
/* ==================================================================== */

/** 新增 / 更新官方域名登记（仅管理员）。 */
export function upsertOfficialDomain(user, payload = {}) {
  if (user?.role !== 'admin') return { error: '仅管理员可维护官方域名登记', status: 403 };
  const domain = String(payload.domain || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/\.+$/, '');
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) return { error: '域名格式不合法（示例：mee.gov.cn）', status: 400 };
  if (domain.includes('*')) return { error: '不支持通配符：官方来源只允许精确 hostname 或受控子域', status: 400 };
  const label = String(payload.label || '').trim();
  if (!label) return { error: '必须填写该域名的机构名称', status: 400 };
  const kind = ['official', 'registry', 'exchange'].includes(payload.kind) ? payload.kind : 'official';
  const matchMode = payload.match_mode === 'exact' ? 'exact' : 'subdomain';
  const enabled = payload.enabled === false ? 0 : 1;
  const now = nowIso();
  const existing = get('SELECT * FROM official_domain WHERE domain=?', [domain]);
  if (existing) {
    run('UPDATE official_domain SET label=?,kind=?,match_mode=?,enabled=?,note=?,updated_at=? WHERE domain=?',
      [label, kind, matchMode, enabled, payload.note ?? existing.note, now, domain]);
  } else {
    run(
      `INSERT INTO official_domain (domain,label,kind,match_mode,enabled,note,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?)`,
      [domain, label, kind, matchMode, enabled, payload.note || null, now, now]
    );
  }
  audit({
    actor: user.name, actorRole: user.role, action: 'official_domain.upsert', objectType: 'official_domain',
    objectId: domain, detail: { label, kind, matchMode, enabled },
  });
  return { ok: true, domain, created: !existing };
}

/** 来源展示口径的统计（后台用）：官方 / 第三方 / 未知各多少条。 */
export function sourceDisplayStats() {
  const rows = all(
    `SELECT source_url AS url, publisher, source_category, official_url
     FROM content_item WHERE is_demo=0 AND duplicate_of IS NULL AND record_kind='article' LIMIT 1000`
  );
  const counts = { official: 0, third_party: 0, unknown: 0 };
  for (const r of rows) counts[sourceDisplay({ ...r, url: r.url || r.official_url }).kind] += 1;
  return { sampled: rows.length, counts, note: '按内容库抽样 1000 条计算；判定只依据 hostname 与来源登记表。' };
}
