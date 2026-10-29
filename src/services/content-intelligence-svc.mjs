/**
 * 单条内容的重取 / 重处理（docs/86 第一阶段第 1、2 节）
 * ============================================================================
 * · 重取：复用 web-fetch-svc 的受控抓取（出站校验、超时、限额、备用通道）；
 * · 重处理：只读已保存的原始 HTML/文本，不访问外网；
 * · 两者都复用 collection 租约，避免与每日采集/历史补采并发写库；
 * · 列表页 / 导航页 / 空正文不覆盖已有文章；失败如实返回原因；
 * · 清洗后仍走 content-svc.upsertContent 的指纹、版本、附件、字段证据链路。
 */
import { all, get, audit } from '../core/db.mjs';
import { nowIso } from '../core/util.mjs';
import { fetchUrlContent, pickFetchConnection } from './web-fetch-svc.mjs';
import { recordSnapshot, sha256 } from './collect-svc.mjs';
import { cleanContent, cleanText, extractAttachmentLinks, reCleanExtraction } from './content-clean-svc.mjs';
import * as governance from './governance-svc.mjs';
import { upsertContent, getContentDetail } from './content-svc.mjs';

async function withCollectionLease(purpose, fn) {
  governance.reapExpiredLease('collection');
  const owner = `content:${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
  const lease = governance.acquireLease({ key: 'collection', owner, purpose });
  if (!lease.ok) {
    return {
      error: '已有采集/补采任务持有 collection 租约，本条重取/重处理未启动；租约到期后可重试。',
      status: 409, reason: 'lease_busy', lease: lease.lease || null,
    };
  }
  try {
    return await fn();
  } finally {
    governance.releaseLease({ key: 'collection', owner });
  }
}

function qualityAllowsWrite(extraction, existingBodyChars = 0) {
  if (!extraction?.ok || !String(extraction.text || '').trim()) return false;
  if (extraction.quality === 'article') return true;
  // 原条目本来没有正文时，允许保存非空但结构不完整的公开文本；绝不覆盖已有正文。
  return Number(existingBodyChars || 0) <= 0 && String(extraction.text).trim().length >= 80;
}

/**
 * 重新抓取单条公开内容。
 * @param {string} id
 * @param {{actor?:string, fetcher?:Function, connection?:object|null, timeoutMs?:number}} opts
 */
export async function refetchContentItem(id, {
  actor = 'system:content', fetcher = fetchUrlContent, connection = null, timeoutMs = 30000,
} = {}) {
  const item = get('SELECT * FROM content_item WHERE id=?', [id]);
  if (!item) return { error: '内容条目不存在', status: 404 };
  if (!/^https?:\/\//i.test(String(item.source_url || ''))) {
    return { error: '该条目没有可重取的 http(s) 原文链接', status: 400 };
  }
  const conn = connection || pickFetchConnection();
  if (!conn) {
    return {
      error: '未配置可用的网页抓取连接：重取未执行，未伪造新正文。',
      status: 400, reason: 'no_fetch_connection',
    };
  }
  return withCollectionLease('content_refetch', async () => {
    let fr;
    try {
      fr = await fetcher(conn, item.source_url, { timeoutMs });
    } catch (e) {
      fr = { ok: false, reason: 'exception', message: e.message };
    }
    if (!fr?.ok) {
      audit({ actor, action: 'content.refetch_failed', objectType: 'content_item', objectId: id,
        detail: { url: item.source_url, reason: fr?.reason || 'fetch_failed', message: fr?.message || null }, result: 'failed' });
      return {
        error: `重取失败（${fr?.reason || 'fetch_failed'}）：${fr?.message || '未取得正文'}；已保留原条目与旧版本。`,
        status: 502, reason: fr?.reason || 'fetch_failed', attempts: fr?.attempts || null,
      };
    }
    const rawHtml = fr.raw_html || fr.html || null;
    const extraction = await cleanContent({
      rawHtml,
      markdown: rawHtml ? null : fr.content,
      rawText: rawHtml ? null : fr.content,
      url: item.source_url,
    });
    if (!qualityAllowsWrite(extraction, item.body_chars)) {
      audit({ actor, action: 'content.refetch_rejected', objectType: 'content_item', objectId: id,
        detail: { url: item.source_url, extractor: extraction.extractor, quality: extraction.quality, chars: extraction.chars }, result: 'rejected' });
      return {
        error: '抓取成功但清洗结果不是可核验文章正文（疑似栏目/导航/空页）；未覆盖原条目。',
        status: 422, reason: 'not_article', extractor: extraction.extractor,
        quality: extraction.quality, chars: extraction.chars, note: extraction.note,
      };
    }
    const body = cleanText(extraction.text);
    const attachments = rawHtml ? extractAttachmentLinks(rawHtml, item.source_url) : null;
    const snap = recordSnapshot({
      url: item.source_url, sourceId: null,
      parser: `content_refetch:${extraction.extractor}`,
      parseQuality: extraction.quality === 'article' ? 'good' : 'partial',
      parseNote: `后台单条重取；清洗器 ${extraction.extractor} ${extraction.extractor_version}（${extraction.status}）`,
      res: {
        status: 200, content_type: 'text/plain; charset=utf-8',
        hash: sha256(Buffer.from(body, 'utf8')), bytes: Buffer.byteLength(body, 'utf8'), body,
      },
    });
    const saved = upsertContent({
      title: item.title,
      source_url: item.source_url,
      content_type: item.content_type,
      record_kind: item.record_kind,
      publisher: item.publisher,
      author: item.author,
      published_at: item.published_at,
      summary: item.summary,
      body_snapshot: body,
      body_availability: extraction.quality === 'article'
        ? (fr.availability || 'full_text')
        : 'partial',
      raw_html: rawHtml,
      extraction,
      attachments,
      snapshot_id: snap?.id || null,
      source_category: item.source_category,
      note: [item.note, `后台重取：${nowIso()}；清洗器 ${extraction.extractor} ${extraction.extractor_version}。`]
        .filter(Boolean).join('；').slice(0, 2000),
    }, { actor });
    audit({
      actor, action: 'content.refetch', objectType: 'content_item', objectId: id,
      detail: {
        url: item.source_url, action: saved.action, change_kind: saved.change_kind || saved.change_kind_detail || null,
        extractor: extraction.extractor, extractor_version: extraction.extractor_version,
        snapshot_id: snap?.id || null,
      },
    });
    const detail = getContentDetail(id);
    return {
      ok: true, id, action: saved.action, change_kind: saved.change_kind || null,
      version_no: saved.version_no || null, change_summary: saved.change_summary || null,
      extractor: extraction.extractor, extractor_version: extraction.extractor_version,
      extraction_status: extraction.status, quality: extraction.quality,
      body_chars: body.length, snapshot_id: snap?.id || null,
      fields: detail?.fields || [],
      attachment_fingerprint: saved.attachment_fingerprint || null,
      message: saved.action === 'unchanged'
        ? '重取成功，但正文与附件均无实质变化；未新建版本、未重生成摘要。'
        : '重取完成，已按实质变化保存版本并失效旧结论。',
    };
  });
}

/**
 * 重处理单条已保存的原始正文（可切换到 Trafilatura；不联网）。
 */
export async function reprocessContentItem(id, { actor = 'system:content', trafilaturaRunner = null } = {}) {
  const item = get('SELECT * FROM content_item WHERE id=?', [id]);
  if (!item) return { error: '内容条目不存在', status: 404 };
  const source = get(
    'SELECT * FROM content_extraction WHERE content_item_id=? AND (raw_html IS NOT NULL OR raw_text IS NOT NULL) ORDER BY fetched_at DESC LIMIT 1',
    [id]
  );
  if (!source) {
    return {
      error: '该条目没有保存原始 HTML/文本，无法离线重处理；请先执行「重取」。',
      status: 400, reason: 'no_stored_source',
    };
  }
  return withCollectionLease('content_reprocess', async () => {
    const extraction = await reCleanExtraction(source, {
      preferTrafilatura: true, trafilaturaRunner,
    });
    if (!qualityAllowsWrite(extraction, item.body_chars)) {
      return {
        error: '离线重处理未取得可核验文章正文；未覆盖原条目。',
        status: 422, reason: extraction.reason || 'not_article',
        extractor: extraction.extractor, quality: extraction.quality || null,
        note: extraction.message || extraction.note || null,
      };
    }
    const body = cleanText(extraction.text);
    const saved = upsertContent({
      title: item.title, source_url: item.source_url, content_type: item.content_type,
      record_kind: item.record_kind, publisher: item.publisher, author: item.author,
      published_at: item.published_at, summary: item.summary, body_snapshot: body,
      body_availability: extraction.quality === 'article' ? (item.body_availability || 'full_text') : 'partial',
      raw_html: extraction.raw_html || source.raw_html,
      extraction,
      snapshot_id: source.id,
      source_category: item.source_category,
      note: [item.note, `离线重处理：${nowIso()}；清洗器 ${extraction.extractor} ${extraction.extractor_version}。`]
        .filter(Boolean).join('；').slice(0, 2000),
    }, { actor });
    audit({
      actor, action: 'content.reprocess', objectType: 'content_item', objectId: id,
      detail: { extractor: extraction.extractor, version: extraction.extractor_version, action: saved.action, change_kind: saved.change_kind || null },
    });
    return {
      ok: true, id, action: saved.action, change_kind: saved.change_kind || null,
      version_no: saved.version_no || null,
      extractor: extraction.extractor, extractor_version: extraction.extractor_version,
      extraction_status: extraction.status, quality: extraction.quality,
      body_chars: body.length,
      fields: getContentDetail(id)?.fields || [],
      message: extraction.extractor === 'trafilatura'
        ? '已使用 Trafilatura 重处理并通过版本比对。'
        : `本次实际使用 ${extraction.extractor}（Trafilatura 未启用或不可用）；已如实记录，未冒充成功。`,
    };
  });
}

/** 后台展示：最近提取记录（不含大段原始 HTML）。 */
export function listExtractions(contentItemId, limit = 20) {
  return all(
    `SELECT id,content_version_id,source_url,raw_hash,extractor,extractor_version,status,quality,chars,note,fetched_at
       FROM content_extraction WHERE content_item_id=? ORDER BY fetched_at DESC LIMIT ?`,
    [contentItemId, Math.min(Math.max(Number(limit) || 20, 1), 100)]
  );
}
