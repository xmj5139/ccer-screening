/**
 * RSS / Atom 资料发现（docs/86 第一阶段第 4 节）
 * ============================================================================
 * 约束：
 *   · 只用原生 RSS/Atom，不部署 RSSHub；
 *   · 解析器禁止 DOCTYPE/ENTITY，不做外部实体解析（防 XXE）；
 *   · 抓取前校验 http(s)、拒绝内网/本机/字面 IP/带凭据 URL；复用 fetchText 的
 *     白名单、超时、重定向二次校验、低频与大小上限；
 *   · 订阅摘要只作为候选摘要，绝不当全文；正文仍进入既有抓取/清洗/摘要流程；
 *   · 按 URL 幂等发现；每天只处理有限来源、有限条目、有限正文抓取与总时间预算。
 */
import { all, get, run, audit } from '../core/db.mjs';
import { newId, nowIso, j } from '../core/util.mjs';
import { fetchText, sha256 } from './collect-svc.mjs';
import { cleanText, stripTags, decodeEntities } from './content-clean-svc.mjs';
import { classifySource, guessContentType, upsertContent, repairIncompleteContent } from './content-svc.mjs';

export const RSS_LIMITS = {
  max_sources_per_run: 5,
  max_items_per_source: 20,
  max_fetch_bodies: 3,
  max_feed_bytes: 2 * 1024 * 1024,
  max_xml_chars: 2_000_000,
  budget_ms: 60_000,
};

const PRIVATE_HOST = [
  /^localhost$/i, /^127\./, /^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./, /^0\.0\.0\.0$/, /^\[?::1\]?$/i, /^\[?fc00:/i, /^\[?fe80:/i,
  /\.local$/i, /\.internal$/i, /\.localhost$/i,
];

/** 公开 RSS 地址校验：比通用出站检查更严格，始终拒绝内网/本机/字面 IP。 */
export function validateRssUrl(rawUrl) {
  let u;
  try {
    u = new URL(String(rawUrl || ''));
  } catch {
    return { ok: false, reason: 'URL 不合法' };
  }
  if (!['http:', 'https:'].includes(u.protocol)) return { ok: false, reason: `不支持的协议：${u.protocol}` };
  if (u.username || u.password) return { ok: false, reason: 'URL 不得包含用户名/密码' };
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (PRIVATE_HOST.some((re) => re.test(host))) return { ok: false, reason: `拒绝内网/本机地址：${host}` };
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return { ok: false, reason: '拒绝直接使用 IP 地址' };
  if (!host.includes('.') && host !== 'localhost') return { ok: false, reason: `拒绝无域名后缀的主机：${host}` };
  return { ok: true, host, url: u.toString() };
}

function unwrapCdata(value) {
  return String(value || '')
    .replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/i, '$1')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, '$1');
}

function firstTag(block, names) {
  for (const name of names) {
    const re = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}\\s*>`, 'i');
    const m = String(block || '').match(re);
    if (m) return m[1];
  }
  return null;
}

function linkFromBlock(block) {
  const links = [...String(block || '').matchAll(/<link\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*\/?>/gi)]
    .map((m) => ({ href: decodeEntities(m[1]).trim(), rel: (m[0].match(/\brel\s*=\s*["']([^"']+)["']/i) || [])[1] || null }));
  if (links.length) {
    const alternate = links.find((l) => !l.rel || l.rel === 'alternate');
    return (alternate || links[0]).href;
  }
  const rss = firstTag(block, ['link']);
  if (rss) return decodeEntities(unwrapCdata(rss)).trim();
  const guid = String(block || '').match(/<guid\b[^>]*>([\s\S]*?)<\/guid>/i);
  if (guid) {
    const v = decodeEntities(unwrapCdata(guid[1])).trim();
    if (/^https?:\/\//i.test(v)) return v;
  }
  return null;
}

function summaryFromBlock(block) {
  const raw = firstTag(block, ['description', 'summary', 'content:encoded', 'content']);
  if (!raw) return null;
  const plain = cleanText(stripTags(
    unwrapCdata(raw)
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
  ));
  return plain ? plain.slice(0, 800) : null;
}

function parseDate(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

/**
 * 安全解析 RSS/Atom。
 * @returns {{ok:boolean,format?:string,title?:string,items?:Array,reason?:string,message?:string}}
 */
export function parseFeed(xml, { feedUrl = null } = {}) {
  const src = String(xml || '').replace(/^\uFEFF/, '');
  if (!src.trim()) return { ok: false, reason: 'empty_feed', message: '订阅内容为空' };
  if (src.length > RSS_LIMITS.max_xml_chars) {
    return { ok: false, reason: 'feed_too_large', message: `订阅内容超过 ${RSS_LIMITS.max_xml_chars} 字符上限` };
  }
  if (/<!DOCTYPE/i.test(src) || /<!ENTITY/i.test(src)) {
    return { ok: false, reason: 'xxe_blocked', message: '订阅包含 DOCTYPE/ENTITY 声明，已拒绝解析（禁止外部实体）' };
  }
  const cleaned = src.replace(/<!--[\s\S]*?-->/g, ' ');
  const isAtom = /<feed\b/i.test(cleaned) && /<entry\b/i.test(cleaned);
  const blockRe = isAtom ? /<entry\b[^>]*>([\s\S]*?)<\/entry\s*>/gi : /<item\b[^>]*>([\s\S]*?)<\/item\s*>/gi;
  const blocks = [...cleaned.matchAll(blockRe)].map((m) => m[1]);
  if (!blocks.length) return { ok: false, reason: 'no_items', message: '未找到 RSS <item> 或 Atom <entry>' };
  const feedTitle = cleanText(stripTags(unwrapCdata(firstTag(cleaned, ['title']) || ''))).slice(0, 200) || null;
  const items = [];
  const seen = new Set();
  for (const block of blocks.slice(0, 100)) {
    const title = cleanText(stripTags(unwrapCdata(firstTag(block, ['title']) || ''))).slice(0, 400) || null;
    const link = linkFromBlock(block);
    if (!link) continue;
    let absolute;
    try {
      absolute = new URL(link, feedUrl || undefined).toString();
    } catch {
      continue;
    }
    const safe = validateRssUrl(absolute);
    if (!safe.ok) continue;
    const key = safe.url;
    if (seen.has(key)) continue;
    seen.add(key);
    const published = parseDate(firstTag(block, ['pubDate', 'published', 'updated', 'dc:date']));
    const summary = summaryFromBlock(block);
    items.push({ url: key, title, published_at: published, summary });
  }
  if (!items.length) return { ok: false, reason: 'no_valid_items', message: '订阅中没有可用的 http(s) 条目链接' };
  return { ok: true, format: isAtom ? 'atom' : 'rss', feed_title: feedTitle, items };
}

/** 抓取订阅 XML；fetcher 可注入（测试/离线），默认复用 fetchText 的出站安全链路。 */
export async function fetchFeedXml(url, { fetcher = null, timeoutMs = 15000 } = {}) {
  const safe = validateRssUrl(url);
  if (!safe.ok) return { ok: false, reason: 'blocked_url', message: safe.reason };
  if (typeof fetcher === 'function') {
    const out = await fetcher(safe.url);
    if (typeof out === 'string') return { ok: true, url: safe.url, body: out, bytes: Buffer.byteLength(out) };
    if (Buffer.isBuffer(out)) return { ok: true, url: safe.url, body: out.toString('utf8'), bytes: out.length };
    if (out?.ok === false) return out;
    const body = String(out?.body ?? out?.content ?? '');
    return { ok: !!body, url: safe.url, body, bytes: Buffer.byteLength(body), reason: body ? null : 'empty_feed' };
  }
  const r = await fetchText(safe.url, {
    allowedDomains: [safe.host], timeoutMs,
    retryMax: 1, rateLimitPerMin: 6, maxBytes: RSS_LIMITS.max_feed_bytes,
  });
  if (!r.ok) return { ok: false, reason: r.reason || r.error || 'fetch_failed', message: r.error || null, status: r.status || null };
  return { ok: true, url: r.final_url || safe.url, body: r.body, bytes: r.bytes, hash: r.hash };
}

export function listRssSources() {
  return all('SELECT * FROM rss_source ORDER BY enabled DESC, created_at').map((r) => ({
    id: r.id, name: r.name, url: r.url, enabled: !!r.enabled, status: r.status,
    last_attempt_at: r.last_attempt_at, last_success_at: r.last_success_at,
    last_error: r.last_error, last_item_at: r.last_item_at,
    items_seen: r.items_seen, items_new: r.items_new,
    created_by: r.created_by, created_at: r.created_at, updated_at: r.updated_at,
  }));
}

export function saveRssSource(user, payload = {}) {
  if (!['admin'].includes(user?.role)) return { error: '仅管理员可管理 RSS 来源', status: 403 };
  const url = String(payload.url || '').trim();
  const safe = validateRssUrl(url);
  if (!safe.ok) return { error: `RSS 地址不可用：${safe.reason}`, status: 400 };
  const name = String(payload.name || '').trim();
  if (!name) return { error: '请填写 RSS 来源名称', status: 400 };
  const urlHash = sha256(Buffer.from(safe.url, 'utf8'));
  const now = nowIso();
  const id = payload.id ? String(payload.id) : null;
  const existing = id ? get('SELECT * FROM rss_source WHERE id=?', [id]) : null;
  if (id && !existing) return { error: 'RSS 来源不存在', status: 404 };
  const clash = get('SELECT id,name FROM rss_source WHERE url_hash=? AND id<>?', [urlHash, id || '']);
  if (clash) return { error: `同一 RSS 地址已存在：${clash.name}`, status: 409 };
  const enabled = payload.enabled === undefined ? (existing?.enabled ?? 1) : (payload.enabled ? 1 : 0);
  if (existing) {
    run(
      `UPDATE rss_source SET name=?,url=?,url_hash=?,enabled=?,updated_at=? WHERE id=?`,
      [name.slice(0, 200), safe.url, urlHash, enabled, now, id]
    );
    audit({ actor: user.name, actorRole: user.role, action: 'rss.source_update', objectType: 'rss_source', objectId: id, detail: { name, url: safe.url, enabled } });
    return { ok: true, source: listRssSources().find((s) => s.id === id) };
  }
  const nid = newId('RSS');
  run(
    `INSERT INTO rss_source (id,name,url,url_hash,enabled,status,items_seen,items_new,created_by,created_at,updated_at)
     VALUES (?,?,?,?,?, 'never',0,0,?,?,?)`,
    [nid, name.slice(0, 200), safe.url, urlHash, enabled, user.name, now, now]
  );
  audit({ actor: user.name, actorRole: user.role, action: 'rss.source_create', objectType: 'rss_source', objectId: nid, detail: { name, url: safe.url, enabled } });
  return { ok: true, source: listRssSources().find((s) => s.id === nid) };
}

export function pauseRssSource(user, id, { enabled = false } = {}) {
  if (!['admin'].includes(user?.role)) return { error: '仅管理员可管理 RSS 来源', status: 403 };
  const row = get('SELECT * FROM rss_source WHERE id=?', [id]);
  if (!row) return { error: 'RSS 来源不存在', status: 404 };
  run('UPDATE rss_source SET enabled=?, updated_at=? WHERE id=?', [enabled ? 1 : 0, nowIso(), id]);
  audit({ actor: user.name, actorRole: user.role, action: 'rss.source_pause', objectType: 'rss_source', objectId: id, detail: { enabled: !!enabled } });
  return { ok: true, id, enabled: !!enabled };
}

async function updateSourceResult(sourceId, { status, error = null, seen = 0, inserted = 0, lastItemAt = null, success = false }) {
  const now = nowIso();
  run(
    `UPDATE rss_source SET status=?, last_attempt_at=?, last_success_at=CASE WHEN ? THEN ? ELSE last_success_at END,
       last_error=?, last_item_at=COALESCE(?,last_item_at), items_seen=items_seen+?, items_new=items_new+?, updated_at=?
     WHERE id=?`,
    [status, now, success ? 1 : 0, now, error ? String(error).slice(0, 900) : null, lastItemAt, seen, inserted, now, sourceId]
  );
}

/**
 * 有界发现一个 RSS 来源。
 * @param {object} source rss_source 行
 * @param {{actor?:string, maxItems?:number, fetchBodies?:boolean, maxFetch?:number,
 *          fetcher?:Function, connection?:object|null, deadlineAt?:number}} opts
 */
export async function discoverRssSource(source, {
  actor = 'system:rss', maxItems = RSS_LIMITS.max_items_per_source,
  fetchBodies = false, maxFetch = RSS_LIMITS.max_fetch_bodies,
  fetcher = null, connection = null, deadlineAt = null,
} = {}) {
  if (!source) return { ok: false, reason: 'source_not_found' };
  if (!source.enabled) return { ok: false, reason: 'disabled', source_id: source.id };
  if (deadlineAt && Date.now() >= deadlineAt - 200) return { ok: false, reason: 'deadline_exceeded', source_id: source.id };
  const fetched = await fetchFeedXml(source.url, { fetcher });
  if (!fetched.ok) {
    await updateSourceResult(source.id, { status: 'failed', error: `${fetched.reason}: ${fetched.message || ''}` });
    return { ok: false, source_id: source.id, source_name: source.name, reason: fetched.reason, message: fetched.message || null, items: 0, inserted: 0 };
  }
  const parsed = parseFeed(fetched.body, { feedUrl: fetched.url });
  if (!parsed.ok) {
    await updateSourceResult(source.id, { status: 'failed', error: `${parsed.reason}: ${parsed.message || ''}` });
    return { ok: false, source_id: source.id, source_name: source.name, reason: parsed.reason, message: parsed.message || null, items: 0, inserted: 0 };
  }
  const cap = Math.min(Math.max(Number(maxItems) || RSS_LIMITS.max_items_per_source, 1), 50);
  const items = parsed.items.slice(0, cap);
  const insertedIds = [];
  let inserted = 0;
  let existing = 0;
  let lastItemAt = null;
  for (const item of items) {
    if (deadlineAt && Date.now() >= deadlineAt - 200) break;
    const urlHash = sha256(Buffer.from(item.url, 'utf8'));
    const prior = get('SELECT id FROM content_item WHERE url_hash=?', [urlHash]);
    let contentId = prior?.id || null;
    let status = prior ? 'existing' : 'inserted';
    if (!contentId) {
      const cls = classifySource(item.url);
      const contentType = guessContentType({ title: item.title, snippet: item.summary, url: item.url });
      try {
        const up = upsertContent({
          content_type: contentType,
          record_kind: 'article',
          title: item.title || '(RSS 候选，无标题)',
          publisher: null,
          published_at: item.published_at,
          source_url: item.url,
          source_category: cls.source_category,
          authority_tier: cls.unknown === 'unknown' ? 'unknown' : cls.authority_tier,
          body_availability: 'metadata_only',
          summary: item.summary,
          body_snapshot: '',
          topics: ['RSS 候选', source.name],
          note: `RSS/Atom 候选：订阅源「${source.name}」只提供标题、链接与摘要；订阅摘要不是全文，` +
            '正文仍进入既有抓取/清洗/摘要流程，未凭域名判定官方。',
        }, { actor });
        contentId = up.id;
        if (up.action === 'inserted') {
          inserted += 1;
          insertedIds.push(up.id);
          status = 'inserted';
        } else {
          existing += 1;
          status = up.action === 'duplicate' ? 'existing' : up.action;
        }
      } catch (e) {
        status = 'failed';
      }
    } else {
      existing += 1;
    }
    const now = nowIso();
    run(
      `INSERT INTO rss_candidate
         (id,rss_source_id,url,url_hash,title,published_at,summary,content_item_id,status,note,discovered_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(rss_source_id,url_hash) DO UPDATE SET
         title=excluded.title, published_at=excluded.published_at, summary=excluded.summary,
         content_item_id=COALESCE(excluded.content_item_id,rss_candidate.content_item_id),
         status=excluded.status, note=excluded.note, updated_at=excluded.updated_at`,
      [
        newId('RSC'), source.id, item.url, urlHash, item.title || null, item.published_at || null,
        item.summary || null, contentId, status,
        status === 'inserted' ? 'RSS 候选已入库，待既有抓取/摘要流程处理。' : 'URL 已存在，未重复入库。',
        now, now,
      ]
    );
    if (item.published_at && (!lastItemAt || item.published_at > lastItemAt)) lastItemAt = item.published_at;
  }
  let bodyFetch = null;
  if (fetchBodies && insertedIds.length) {
    try {
      bodyFetch = await repairIncompleteContent({
        actor, ids: insertedIds.slice(0, Math.max(1, Math.min(Number(maxFetch) || RSS_LIMITS.max_fetch_bodies, 10))),
        limit: Math.min(Number(maxFetch) || RSS_LIMITS.max_fetch_bodies, 10), verify: false,
        connection, deadlineAt,
      });
    } catch (e) {
      bodyFetch = { ok: false, reason: 'body_fetch_failed', message: e.message };
    }
  }
  await updateSourceResult(source.id, {
    status: bodyFetch && (bodyFetch.unavailable || bodyFetch.failed) ? 'partial' : 'ok',
    seen: items.length, inserted, lastItemAt,
    error: bodyFetch?.unavailable ? `正文抓取未配置：${bodyFetch.reason || ''}` : null,
    success: true,
  });
  return {
    ok: true, source_id: source.id, source_name: source.name, format: parsed.format,
    feed_title: parsed.feed_title, items: items.length, inserted, existing,
    inserted_ids: insertedIds, body_fetch: bodyFetch,
    bounded: { max_items: cap, max_fetch: Number(maxFetch) || RSS_LIMITS.max_fetch_bodies },
  };
}

/** 后台真实测试：抓取并解析，不把空的/非 RSS 页面标成功。 */
export async function testRssSource(user, id, { fetcher = null } = {}) {
  if (!['admin'].includes(user?.role)) return { error: '仅管理员可测试 RSS 来源', status: 403 };
  const source = get('SELECT * FROM rss_source WHERE id=?', [id]);
  if (!source) return { error: 'RSS 来源不存在', status: 404 };
  const fetched = await fetchFeedXml(source.url, { fetcher });
  if (!fetched.ok) {
    await updateSourceResult(source.id, { status: 'failed', error: `${fetched.reason}: ${fetched.message || ''}` });
    return { ok: false, id, status: 'failed', reason: fetched.reason, message: fetched.message || '抓取失败', http_status: fetched.status || null };
  }
  const parsed = parseFeed(fetched.body, { feedUrl: fetched.url });
  if (!parsed.ok) {
    await updateSourceResult(source.id, { status: 'failed', error: `${parsed.reason}: ${parsed.message || ''}` });
    return { ok: false, id, status: 'failed', reason: parsed.reason, message: parsed.message || '解析失败' };
  }
  await updateSourceResult(source.id, { status: 'ok', seen: parsed.items.length, success: true });
  audit({ actor: user.name, actorRole: user.role, action: 'rss.source_test', objectType: 'rss_source', objectId: id, detail: { items: parsed.items.length, format: parsed.format } });
  return {
    ok: true, id, status: 'ok', format: parsed.format, feed_title: parsed.feed_title,
    items: parsed.items.length, sample: parsed.items.slice(0, 5),
    note: '真实抓取并解析成功；订阅摘要仍不是全文，候选正文需另行抓取。',
  };
}

export function listRssCandidates({ sourceId = null, limit = 100 } = {}) {
  const rows = sourceId
    ? all('SELECT * FROM rss_candidate WHERE rss_source_id=? ORDER BY discovered_at DESC LIMIT ?', [sourceId, Math.min(Number(limit) || 100, 500)])
    : all('SELECT * FROM rss_candidate ORDER BY discovered_at DESC LIMIT ?', [Math.min(Number(limit) || 100, 500)]);
  return rows.map((r) => ({
    id: r.id, source_id: r.rss_source_id, url: r.url, title: r.title,
    published_at: r.published_at, summary: r.summary, content_item_id: r.content_item_id,
    status: r.status, note: r.note, discovered_at: r.discovered_at, updated_at: r.updated_at,
  }));
}

/**
 * 每日有界 RSS 任务（不启动常驻 worker）。
 * 先发现候选并按 URL 幂等入库，再对有限的新候选走既有正文抓取。
 */
export async function runRssDaily({
  actor = 'system:rss', maxSources = RSS_LIMITS.max_sources_per_run,
  maxItems = RSS_LIMITS.max_items_per_source, maxFetch = RSS_LIMITS.max_fetch_bodies,
  deadlineAt = null, fetcher = null, connection = null,
} = {}) {
  const started = Date.now();
  const deadline = deadlineAt || started + RSS_LIMITS.budget_ms;
  const sources = all(
    `SELECT * FROM rss_source WHERE enabled=1 ORDER BY COALESCE(last_success_at,'') ASC, created_at LIMIT ?`,
    [Math.min(Math.max(Number(maxSources) || RSS_LIMITS.max_sources_per_run, 1), 20)]
  );
  const out = {
    ok: true, sources: sources.length, discovered: 0, inserted: 0, existing: 0,
    body_fetched: 0, failures: [], items: [], deadline_exceeded: false,
  };
  if (!sources.length) {
    run(
      `INSERT INTO dataset_cursor (dataset,last_attempt_at,last_status,last_error,items_seen,items_new,note)
       VALUES ('rss_discovery',?,?,?,?,?,?)
       ON CONFLICT(dataset) DO UPDATE SET last_attempt_at=excluded.last_attempt_at,last_status=excluded.last_status,
         last_error=excluded.last_error,items_seen=excluded.items_seen,items_new=excluded.items_new,note=excluded.note`,
      [nowIso(), 'never', null, 0, 0, '未配置启用的 RSS 来源；未发起任何请求。']
    );
    return out;
  }
  for (const source of sources) {
    if (Date.now() >= deadline - 500) {
      out.deadline_exceeded = true;
      out.failures.push({ source_id: source.id, reason: 'deadline_exceeded', message: '每日 RSS 时间预算已到，剩余来源留待下次' });
      break;
    }
    const r = await discoverRssSource(source, {
      actor, maxItems, fetchBodies: false, fetcher, deadlineAt: deadline,
    });
    out.discovered += r.items || 0;
    out.inserted += r.inserted || 0;
    out.existing += r.existing || 0;
    out.items.push(r);
    if (!r.ok) out.failures.push({ source_id: source.id, source_name: source.name, reason: r.reason, message: r.message });
  }
  // 只对本次新候选做有限正文抓取；重取路径复用同一清洗与指纹逻辑。
  const newIds = out.items.flatMap((r) => r.inserted_ids || []).slice(0, Math.max(0, Math.min(Number(maxFetch) || 0, 10)));
  if (newIds.length && Date.now() < deadline - 500) {
    try {
      const fetch = await repairIncompleteContent({
        actor, ids: newIds, limit: newIds.length, verify: false,
        connection, deadlineAt: deadline,
      });
      out.body_fetch = fetch;
      out.body_fetched = Number(fetch?.improved || 0);
    } catch (e) {
      out.body_fetch = { ok: false, reason: 'body_fetch_failed', message: e.message };
    }
  }
  const status = out.failures.length === 0 ? 'ok' : out.inserted > 0 || out.discovered > 0 ? 'partial' : 'failed';
  run(
    `INSERT INTO dataset_cursor (dataset,last_attempt_at,last_success_at,last_status,last_error,items_seen,items_new,note)
     VALUES ('rss_discovery',?,?,?,?,?,?,?)
     ON CONFLICT(dataset) DO UPDATE SET last_attempt_at=excluded.last_attempt_at,
       last_success_at=CASE WHEN excluded.last_status IN ('ok','partial') THEN excluded.last_success_at ELSE last_success_at END,
       last_status=excluded.last_status,last_error=excluded.last_error,items_seen=excluded.items_seen,
       items_new=excluded.items_new,note=excluded.note`,
    [
      nowIso(), status === 'failed' ? null : nowIso(), status,
      out.failures.length ? out.failures.map((f) => `${f.source_name || f.source_id}: ${f.reason} ${f.message || ''}`).join(' | ').slice(0, 900) : null,
      out.discovered, out.inserted,
      `RSS 有界任务：来源 ${sources.length} 个，候选 ${out.discovered}，新增 ${out.inserted}，正文抓取 ${out.body_fetched}；` +
      `时间预算 ${Math.round(RSS_LIMITS.budget_ms / 1000)} 秒。`,
    ]
  );
  out.ok = status !== 'failed';
  out.status = status;
  out.elapsed_ms = Date.now() - started;
  return out;
}
