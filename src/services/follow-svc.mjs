/**
 * 用户关注规则、站内更新与已读（docs/86 第二阶段第 2 节）
 * ============================================================================
 * 硬约束：
 *   · 规则与已读游标的所有权键是服务端会话里的 user.id；请求体里的 user_id 一律忽略。
 *   · 更新/删除规则、按规则读取前都校验归属；他人规则返回 403，不泄露内容。
 *   · 只做站内信息流，不默认发邮件/第三方消息。
 *   · 事件组（同文转载）合并展示以抑制重复，但保留每个来源与正文变化；
 *     关键词/地区/行业/方法学命中只是“正文或元数据提及”，不是官方适用范围。
 */
import { all, get, run, audit } from '../core/db.mjs';
import { newId, nowIso } from '../core/util.mjs';
import { sha256Text } from './search-index-svc.mjs';

export const FOLLOW_LIMITS = {
  max_rules: 20,
  max_keywords: 20,
  max_list_items: 20,
  max_item_chars: 60,
  feed_scan: 300,
  feed_limit: 100,
};

const CONTENT_BASE_WHERE = [
  'is_demo=0',
  'duplicate_of IS NULL',
  "record_kind='article'",
  "COALESCE(process_status,'')<>'failed_fetch'",
];

function parseList(value, limit = FOLLOW_LIMITS.max_list_items) {
  let raw;
  if (Array.isArray(value)) raw = value;
  else {
    const text = String(value || '').trim();
    if (/^\[/.test(text)) {
      try {
        const parsed = JSON.parse(text);
        raw = Array.isArray(parsed) ? parsed : [text];
      } catch {
        raw = text.split(/[,，、;；\n]+/);
      }
    } else {
      raw = text.split(/[,，、;；\n]+/);
    }
  }
  return [...new Set(raw.map((x) => String(x || '').trim()).filter(Boolean))]
    .map((x) => x.slice(0, FOLLOW_LIMITS.max_item_chars))
    .slice(0, limit);
}

function parseJsonList(value) {
  try {
    const arr = JSON.parse(value || '[]');
    return Array.isArray(arr) ? arr.map(String).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function ruleOut(row) {
  return {
    id: row.id,
    name: row.name,
    keywords: parseJsonList(row.keywords_json),
    regions: parseJsonList(row.regions_json),
    industries: parseJsonList(row.industries_json),
    methodologies: parseJsonList(row.methodologies_json),
    content_types: parseJsonList(row.content_types_json),
    include_updates: !!row.include_updates,
    enabled: !!row.enabled,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function fail(error, status = 400) {
  return { ok: false, error, status };
}

function ownRule(user, id) {
  if (!user?.id) return { error: fail('未认证', 401) };
  const row = get('SELECT * FROM user_follow_rule WHERE id=?', [String(id)]);
  if (!row) return { error: fail('关注规则不存在', 404) };
  if (String(row.user_id) !== String(user.id)) return { error: fail('无权操作他人的关注规则', 403) };
  return { row };
}

export function listFollowRules(user) {
  if (!user?.id) return fail('未认证', 401);
  return {
    ok: true,
    rules: all(
      'SELECT * FROM user_follow_rule WHERE user_id=? ORDER BY updated_at DESC, id DESC',
      [String(user.id)]
    ).map(ruleOut),
    limits: FOLLOW_LIMITS,
    note: '关注规则只属于当前用户；正文/元数据提及不等于官方适用范围。',
  };
}

export function saveFollowRule(user, payload = {}) {
  if (!user?.id) return fail('未认证', 401);
  const id = payload.id ? String(payload.id) : null;
  let existing = null;
  if (id) {
    const own = ownRule(user, id);
    if (own.error) return own.error;
    existing = own.row;
  } else {
    const count = Number(get('SELECT COUNT(*) c FROM user_follow_rule WHERE user_id=?', [String(user.id)])?.c || 0);
    if (count >= FOLLOW_LIMITS.max_rules) return fail(`关注规则最多 ${FOLLOW_LIMITS.max_rules} 条`, 400);
  }
  const keywords = parseList(payload.keywords ?? payload.keywords_json, FOLLOW_LIMITS.max_keywords);
  const regions = parseList(payload.regions ?? payload.regions_json);
  const industries = parseList(payload.industries ?? payload.industries_json);
  const methodologies = parseList(payload.methodologies ?? payload.methodologies_json);
  const contentTypes = parseList(payload.content_types ?? payload.content_types_json);
  if (!keywords.length && !regions.length && !industries.length && !methodologies.length && !contentTypes.length) {
    return fail('至少填写一个关键词、地区、行业、方法学编号或内容类型', 400);
  }
  const name = String(payload.name || '').trim().slice(0, 80) || '我的关注';
  const now = nowIso();
  const values = [
    name,
    JSON.stringify(keywords),
    JSON.stringify(regions),
    JSON.stringify(industries),
    JSON.stringify(methodologies),
    JSON.stringify(contentTypes),
    payload.include_updates === false ? 0 : 1,
    payload.enabled === false ? 0 : 1,
    now,
  ];
  if (existing) {
    run(
      `UPDATE user_follow_rule SET name=?,keywords_json=?,regions_json=?,industries_json=?,
         methodologies_json=?,content_types_json=?,include_updates=?,enabled=?,updated_at=?
       WHERE id=? AND user_id=?`,
      [...values, existing.id, String(user.id)]
    );
    audit({
      actor: user.name || user.id, action: 'follow_rule.update', objectType: 'user_follow_rule',
      objectId: existing.id, detail: { owner: user.id, keywords, regions, industries, methodologies, contentTypes },
    });
    return { ok: true, rule: ruleOut(get('SELECT * FROM user_follow_rule WHERE id=?', [existing.id])) };
  }
  const ruleId = newId('FOL');
  run(
    `INSERT INTO user_follow_rule
       (id,user_id,name,keywords_json,regions_json,industries_json,methodologies_json,
        content_types_json,include_updates,enabled,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [ruleId, String(user.id), ...values, now]
  );
  audit({
    actor: user.name || user.id, action: 'follow_rule.create', objectType: 'user_follow_rule',
    objectId: ruleId, detail: { owner: user.id, keywords, regions, industries, methodologies, contentTypes },
  });
  return { ok: true, rule: ruleOut(get('SELECT * FROM user_follow_rule WHERE id=?', [ruleId])) };
}

export function deleteFollowRule(user, id) {
  const own = ownRule(user, id);
  if (own.error) return own.error;
  run('DELETE FROM user_follow_rule WHERE id=? AND user_id=?', [own.row.id, String(user.id)]);
  // 已读游标是用户自己的独立记录；删除规则不删除已读记录，避免误清其它规则的已读状态。
  audit({
    actor: user.name || user.id, action: 'follow_rule.delete', objectType: 'user_follow_rule',
    objectId: own.row.id, detail: { owner: user.id },
  });
  return { ok: true, deleted: own.row.id };
}

export function getFollowRule(user, id) {
  const own = ownRule(user, id);
  if (own.error) return own.error;
  return { ok: true, rule: ruleOut(own.row) };
}

function contentHaystack(row) {
  return [
    row.title, row.summary, row.auto_summary, row.body_snapshot,
    row.publisher, row.industry, row.topics_json, row.methodology_ids_json,
  ].filter(Boolean).join('\n').slice(0, 60000).toLowerCase();
}

function matchedReasons(row, rule) {
  const hay = contentHaystack(row);
  const reasons = [];
  if (rule.keywords.length) {
    const hit = rule.keywords.filter((k) => hay.includes(String(k).toLowerCase()));
    if (!hit.length) return null;
    reasons.push(`关键词：${hit.join('、')}`);
  }
  if (rule.regions.length) {
    const hit = rule.regions.filter((r) => hay.includes(String(r).toLowerCase()));
    if (!hit.length) return null;
    reasons.push(`地区提及：${hit.join('、')}`);
  }
  if (rule.industries.length) {
    const hit = rule.industries.filter((r) => hay.includes(String(r).toLowerCase()));
    if (!hit.length) return null;
    reasons.push(`行业提及：${hit.join('、')}`);
  }
  if (rule.methodologies.length) {
    const hit = rule.methodologies.filter((r) => hay.includes(String(r).toLowerCase()));
    if (!hit.length) return null;
    reasons.push(`方法学编号：${hit.join('、')}`);
  }
  if (rule.content_types.length) {
    if (!rule.content_types.includes(String(row.content_type || ''))) return null;
    reasons.push(`内容类型：${row.content_type}`);
  }
  return reasons;
}

function readState(userId, contentId) {
  return get(
    'SELECT read_body_hash, read_at FROM user_follow_read WHERE user_id=? AND content_item_id=?',
    [String(userId), String(contentId)]
  );
}

function bodyHashOf(row) {
  return row.body_fingerprint || row.content_hash || sha256Text(row.body_snapshot || '');
}

function versionOf(contentId) {
  return get(
    `SELECT version_no,change_kind,change_summary,diff_chars,fetched_at
       FROM content_version WHERE content_item_id=? ORDER BY version_no DESC LIMIT 1`,
    [String(contentId)]
  );
}

const CHANGE_LABEL = {
  initial: '首次收录',
  body_change: '正文实质变化',
  attachment_change: '附件变化',
  updated: '内容更新',
  minor_edit: '非实质编辑',
};

function groupMembers(eventGroupId) {
  if (!eventGroupId) return [];
  return all(
    `SELECT ci.id,ci.title,ci.publisher,ci.source_url,ci.published_at,ci.discovered_at,
            ci.updated_at,ci.body_fingerprint,ci.content_hash
       FROM content_event_member m JOIN content_item ci ON ci.id=m.content_item_id
      WHERE m.event_group_id=? ORDER BY ci.updated_at DESC`,
    [String(eventGroupId)]
  );
}

/**
 * 当前用户的关注信息流。
 * @param {object} user
 * @param {{limit?:number, offset?:number, unread_only?:boolean, rule_id?:string}} opts
 */
export function listFollowFeed(user, { limit = 50, offset = 0, unreadOnly = false, ruleId = null } = {}) {
  if (!user?.id) return fail('未认证', 401);
  const rules = all(
    'SELECT * FROM user_follow_rule WHERE user_id=? AND enabled=1 ORDER BY updated_at DESC',
    [String(user.id)]
  ).map(ruleOut);
  if (ruleId) {
    const own = ownRule(user, ruleId);
    if (own.error) return own.error;
  }
  const selected = ruleId ? rules.filter((r) => r.id === String(ruleId)) : rules;
  if (!selected.length) {
    return {
      ok: true, items: [], total: 0, unread_count: 0, rules_count: 0,
      note: '尚未设置启用的关注规则；规则只属于当前用户，添加后在此查看站内更新。',
    };
  }
  const rows = all(
    `SELECT id,title,publisher,source_url,published_at,discovered_at,collected_at,updated_at,
            summary,auto_summary,body_snapshot,body_fingerprint,content_hash,content_type,
            industry,topics_json,methodology_ids_json,event_group_id
       FROM content_item
      WHERE ${CONTENT_BASE_WHERE.join(' AND ')}
      ORDER BY COALESCE(published_at,discovered_at,updated_at) DESC, id DESC
      LIMIT ?`,
    [FOLLOW_LIMITS.feed_scan]
  );
  const groups = new Map();
  for (const row of rows) {
    let best = null;
    for (const rule of selected) {
      const reasons = matchedReasons(row, rule);
      if (reasons) {
        if (!best) best = { rule, reasons };
        else best.reasons.push(...reasons);
      }
    }
    if (!best) continue;
    const hash = bodyHashOf(row);
    const read = readState(user.id, row.id);
    const unread = !read || read.read_body_hash !== hash;
    const version = versionOf(row.id);
    const key = row.event_group_id ? `eg:${row.event_group_id}` : `item:${row.id}`;
    const date = row.published_at || row.discovered_at || row.updated_at || null;
    let item = groups.get(key);
    if (!item) {
      item = {
        key,
        content_item_id: row.id,
        event_group_id: row.event_group_id || null,
        title: row.title,
        publisher: row.publisher,
        source_url: row.source_url,
        content_type: row.content_type,
        date,
        unread,
        read_at: read?.read_at || null,
        body_hash: hash,
        update_kind: version?.change_kind || 'initial',
        update_label: CHANGE_LABEL[version?.change_kind] || '首次收录',
        update_summary: version?.change_summary || null,
        matched_rules: [{ id: best.rule.id, name: best.rule.name, reasons: [...new Set(best.reasons)] }],
        sources: [{
          content_item_id: row.id, title: row.title, publisher: row.publisher,
          source_url: row.source_url, published_at: row.published_at,
          unread, update_kind: version?.change_kind || 'initial',
        }],
      };
      groups.set(key, item);
    } else {
      item.unread = item.unread || unread;
      if (date && (!item.date || String(date) > String(item.date))) {
        item.date = date;
        item.content_item_id = row.id;
        item.title = row.title;
        item.publisher = row.publisher;
        item.source_url = row.source_url;
      }
      if (!item.matched_rules.some((r) => r.id === best.rule.id)) {
        item.matched_rules.push({ id: best.rule.id, name: best.rule.name, reasons: [...new Set(best.reasons)] });
      }
      if (!item.sources.some((s) => s.content_item_id === row.id)) {
        item.sources.push({
          content_item_id: row.id, title: row.title, publisher: row.publisher,
          source_url: row.source_url, published_at: row.published_at,
          unread, update_kind: version?.change_kind || 'initial',
        });
      }
    }
  }

  // 事件组可能还有未进入本次扫描的成员；补足来源并同步未读。
  for (const item of groups.values()) {
    if (!item.event_group_id) continue;
    const members = groupMembers(item.event_group_id);
    for (const m of members) {
      if (item.sources.some((s) => s.content_item_id === m.id)) continue;
      const read = readState(user.id, m.id);
      const unread = !read || read.read_body_hash !== bodyHashOf(m);
      item.unread = item.unread || unread;
      item.sources.push({
        content_item_id: m.id, title: m.title, publisher: m.publisher, source_url: m.source_url,
        published_at: m.published_at, unread, update_kind: 'reprint',
      });
    }
  }

  let items = [...groups.values()];
  if (unreadOnly) items = items.filter((x) => x.unread);
  items.sort((a, b) => {
    if (a.unread !== b.unread) return a.unread ? -1 : 1;
    return String(b.date || '').localeCompare(String(a.date || ''));
  });
  const unreadCount = items.filter((x) => x.unread).length;
  const start = Math.max(0, Number(offset) || 0);
  const size = Math.max(1, Math.min(Number(limit) || 50, FOLLOW_LIMITS.feed_limit));
  const page = items.slice(start, start + size).map((x) => ({
    ...x,
    source_count: x.sources.length,
    sources: x.sources.slice(0, 10),
    matched_rules: x.matched_rules.slice(0, 5),
  }));
  return {
    ok: true,
    items: page,
    total: items.length,
    unread_count: unreadCount,
    rules_count: selected.length,
    scanned: rows.length,
    note: '关注命中只表示正文/元数据提及，不代表官方适用范围或项目合格；同文转载按事件组合并，来源仍逐条保留。',
  };
}

/**
 * 标记已读。只写当前用户的 user_follow_read；body_hash 记录读取时的正文版本，
 * 正文实质变化后会重新显示为未读（不会把旧已读状态沿用到新正文）。
 */
export function markFollowRead(user, { contentId = null, eventGroupId = null } = {}) {
  if (!user?.id) return fail('未认证', 401);
  let ids = [];
  if (contentId) {
    const row = get('SELECT id,event_group_id,body_fingerprint,content_hash FROM content_item WHERE id=?', [String(contentId)]);
    if (!row) return fail('内容条目不存在', 404);
    ids = [row.id];
    if (row.event_group_id) {
      const members = groupMembers(row.event_group_id);
      if (members.length) ids = members.map((m) => m.id);
    }
  } else if (eventGroupId) {
    const members = groupMembers(eventGroupId);
    if (!members.length) return fail('事件组不存在或没有可读成员', 404);
    ids = members.map((m) => m.id);
  } else {
    return fail('请提供 content_id 或 event_group_id', 400);
  }
  const now = nowIso();
  let marked = 0;
  for (const id of [...new Set(ids)]) {
    const row = get('SELECT id,body_fingerprint,content_hash,body_snapshot FROM content_item WHERE id=?', [String(id)]);
    if (!row) continue;
    run(
      `INSERT INTO user_follow_read(user_id,content_item_id,read_body_hash,read_at)
       VALUES (?,?,?,?)
       ON CONFLICT(user_id,content_item_id) DO UPDATE SET
         read_body_hash=excluded.read_body_hash, read_at=excluded.read_at`,
      [String(user.id), String(id), bodyHashOf(row), now]
    );
    marked += 1;
  }
  audit({
    actor: user.name || user.id, action: 'follow_read.mark', objectType: 'user_follow_read',
    objectId: String(contentId || eventGroupId), detail: { owner: user.id, marked },
  });
  return { ok: true, marked, content_ids: [...new Set(ids)] };
}

/** 标记当前信息流中已展示的条目为已读。 */
export function markFollowFeedRead(user, { ruleId = null, limit = 200 } = {}) {
  if (!user?.id) return fail('未认证', 401);
  const feed = listFollowFeed(user, { limit, offset: 0, ruleId });
  if (!feed.ok) return feed;
  let marked = 0;
  for (const item of feed.items) {
    const out = markFollowRead(user, { contentId: item.content_item_id });
    if (out.ok) marked += out.marked;
  }
  return { ok: true, marked, items: feed.items.length };
}

export { parseList, matchedReasons };
