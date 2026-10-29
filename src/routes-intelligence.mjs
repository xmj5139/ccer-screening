/**
 * 公开信息智能化第一阶段路由（docs/86）
 * ============================================================================
 * 普通登录用户：只读字段证据（与内容详情同一份公开正文）。
 * 管理员：单条重取/离线重处理/模型字段抽取/RSS 来源管理/有界发现。
 * 所有 /api/v2/admin/* 由 routes-v2 的统一后台守卫先判 admin，服务层再次校验。
 */
import { readGuard, writeGuard } from './services/http-guard.mjs';
import { requireRole } from './services/project-svc.mjs';
import { getFieldEvidence, extractDeterministicFields, extractFieldsWithModel } from './services/field-evidence-svc.mjs';
import { refetchContentItem, reprocessContentItem, listExtractions } from './services/content-intelligence-svc.mjs';
import * as rss from './services/rss-discovery-svc.mjs';
import * as follow from './services/follow-svc.mjs';
import * as searchIndex from './services/search-index-svc.mjs';
import * as pdfTable from './services/pdf-table-svc.mjs';

function deny(ctx, action) {
  return requireRole(ctx.user, ['admin'], action);
}

function fail(out) {
  return { status: out?.status || 400, body: out };
}

export const INTELLIGENCE_RAW_ROUTES = [
  /* ================= 普通用户：字段证据只读 ================= */
  ['GET', '/api/v2/content/:id/fields', async (ctx) => {
    const g = readGuard();
    if (g) return { status: g.status, body: g };
    const out = getFieldEvidence('content_item', ctx.params.id);
    return {
      content_item_id: ctx.params.id,
      ...out,
    };
  }],

  /* ================= 后台：单条重取 / 重处理 ================= */
  ['POST', '/api/v2/admin/content/:id/refetch', async (ctx) => {
    const g = writeGuard(ctx); if (g) return { status: g.status, body: g };
    const denied = deny(ctx, '重取公开正文'); if (denied) return { status: denied.status, body: denied };
    const out = await refetchContentItem(ctx.params.id, {
      actor: ctx.user.name,
      timeoutMs: Math.min(Math.max(Number(ctx.body?.timeout_ms) || 30000, 5000), 60000),
    });
    if (out.error) return fail(out);
    return out;
  }],

  ['POST', '/api/v2/admin/content/:id/reprocess', async (ctx) => {
    const g = writeGuard(ctx); if (g) return { status: g.status, body: g };
    const denied = deny(ctx, '离线重处理公开正文'); if (denied) return { status: denied.status, body: denied };
    const out = await reprocessContentItem(ctx.params.id, { actor: ctx.user.name });
    if (out.error) return fail(out);
    return out;
  }],

  ['GET', '/api/v2/admin/content/:id/extractions', async (ctx) => {
    const g = readGuard(); if (g) return { status: g.status, body: g };
    const denied = deny(ctx, '查看正文提取记录'); if (denied) return { status: denied.status, body: denied };
    return {
      extractions: listExtractions(ctx.params.id, Number(ctx.query.limit) || 20),
      note: '记录实际提取器、版本、状态、原始 HTML 哈希与清洗后字符数；不返回大段原始正文。',
    };
  }],

  /* ================= 后台：结构字段证据 ================= */
  ['POST', '/api/v2/admin/content/:id/extract-fields', async (ctx) => {
    const g = writeGuard(ctx); if (g) return { status: g.status, body: g };
    const denied = deny(ctx, '抽取结构字段'); if (denied) return { status: denied.status, body: denied };
    const mode = String(ctx.body?.mode || 'model');
    if (!['deterministic', 'model'].includes(mode)) {
      return { status: 400, body: { error: 'mode 只支持 deterministic 或 model' } };
    }
    if (mode === 'deterministic') {
      const out = extractDeterministicFields('content_item', ctx.params.id, {
        actor: ctx.user.name, markStale: ctx.body?.force !== false,
      });
      if (!out.ok) return { status: 400, body: { error: '确定性字段抽取未执行', ...out } };
      return {
        ok: true, method: 'deterministic_rule', ...out,
        note: '确定性规则抽取：字段值与引句均可定位；不冒充模型结果。',
      };
    }
    const out = await extractFieldsWithModel('content_item', ctx.params.id, {
      actor: ctx.user.name,
      providerId: ctx.body?.provider_id || null,
      force: ctx.body?.force === true,
    });
    if (!out.ok && out.status) return fail(out);
    return out;
  }],

  /* ================= 后台：RSS 来源与候选 ================= */
  ['GET', '/api/v2/admin/rss-sources', async (ctx) => {
    const g = readGuard(); if (g) return { status: g.status, body: g };
    const denied = deny(ctx, '查看 RSS 来源'); if (denied) return { status: denied.status, body: denied };
    return {
      sources: rss.listRssSources(),
      candidates: rss.listRssCandidates({ limit: Number(ctx.query.limit) || 50 }),
      limits: rss.RSS_LIMITS,
      note: 'RSS/Atom 只提供候选元数据；订阅摘要不是全文，正文仍由既有抓取/清洗/摘要流程处理。',
    };
  }],

  ['POST', '/api/v2/admin/rss-sources', async (ctx) => {
    const g = writeGuard(ctx); if (g) return { status: g.status, body: g };
    const denied = deny(ctx, '保存 RSS 来源'); if (denied) return { status: denied.status, body: denied };
    const out = rss.saveRssSource(ctx.user, ctx.body || {});
    if (out.error) return fail(out);
    return out;
  }],

  ['POST', '/api/v2/admin/rss-sources/:id/test', async (ctx) => {
    const g = writeGuard(ctx); if (g) return { status: g.status, body: g };
    const denied = deny(ctx, '测试 RSS 来源'); if (denied) return { status: denied.status, body: denied };
    const out = await rss.testRssSource(ctx.user, ctx.params.id);
    if (out.error) return fail(out);
    return out;
  }],

  ['POST', '/api/v2/admin/rss-sources/:id/discover', async (ctx) => {
    const g = writeGuard(ctx); if (g) return { status: g.status, body: g };
    const denied = deny(ctx, '发现 RSS 候选'); if (denied) return { status: denied.status, body: denied };
    const source = rss.listRssSources().find((s) => s.id === ctx.params.id);
    if (!source) return { status: 404, body: { error: 'RSS 来源不存在' } };
    const out = await rss.discoverRssSource(
      { ...source, enabled: source.enabled ? 1 : 0 },
      {
        actor: ctx.user.name,
        maxItems: Math.min(Math.max(Number(ctx.body?.max_items) || 20, 1), 50),
        fetchBodies: ctx.body?.fetch_bodies === true,
        maxFetch: Math.min(Math.max(Number(ctx.body?.max_fetch) || 3, 0), 10),
        deadlineAt: Date.now() + Math.min(Math.max(Number(ctx.body?.budget_ms) || 60000, 5000), 120000),
      }
    );
    if (out.error) return fail(out);
    return out;
  }],

  ['POST', '/api/v2/admin/rss-sources/:id/pause', async (ctx) => {
    const g = writeGuard(ctx); if (g) return { status: g.status, body: g };
    const denied = deny(ctx, '停用/启用 RSS 来源'); if (denied) return { status: denied.status, body: denied };
    const out = rss.pauseRssSource(ctx.user, ctx.params.id, { enabled: ctx.body?.enabled === true });
    if (out.error) return fail(out);
    return out;
  }],

  ['GET', '/api/v2/admin/rss-candidates', async (ctx) => {
    const g = readGuard(); if (g) return { status: g.status, body: g };
    const denied = deny(ctx, '查看 RSS 候选'); if (denied) return { status: denied.status, body: denied };
    return {
      candidates: rss.listRssCandidates({
        sourceId: ctx.query.source_id || null,
        limit: Number(ctx.query.limit) || 100,
      }),
      note: '候选只记录来源提供的标题、链接、日期和订阅摘要；未取得正文前不声称全文。',
    };
  }],

  ['POST', '/api/v2/admin/rss/run', async (ctx) => {
    const g = writeGuard(ctx); if (g) return { status: g.status, body: g };
    const denied = deny(ctx, '执行每日 RSS 有界任务'); if (denied) return { status: denied.status, body: denied };
    const out = await rss.runRssDaily({
      actor: ctx.user.name,
      maxSources: Math.min(Math.max(Number(ctx.body?.max_sources) || 5, 1), 10),
      maxItems: Math.min(Math.max(Number(ctx.body?.max_items) || 20, 1), 50),
      maxFetch: Math.min(Math.max(Number(ctx.body?.max_fetch) || 3, 0), 10),
      deadlineAt: Date.now() + Math.min(Math.max(Number(ctx.body?.budget_ms) || 60000, 5000), 120000),
    });
    return out;
  }],

  /* ================= 普通用户：我的关注 / 站内更新 / 已读 ================= */
  ['GET', '/api/v2/follow/rules', async (ctx) => {
    const g = readGuard(); if (g) return { status: g.status, body: g };
    if (!ctx.user) return { status: 401, body: { error: '未认证' } };
    return follow.listFollowRules(ctx.user);
  }],

  ['POST', '/api/v2/follow/rules', async (ctx) => {
    const g = writeGuard(ctx); if (g) return { status: g.status, body: g };
    if (!ctx.user) return { status: 401, body: { error: '未认证' } };
    const out = follow.saveFollowRule(ctx.user, ctx.body || {});
    if (!out.ok) return { status: out.status || 400, body: out };
    return out;
  }],

  ['DELETE', '/api/v2/follow/rules/:id', async (ctx) => {
    const g = writeGuard(ctx); if (g) return { status: g.status, body: g };
    if (!ctx.user) return { status: 401, body: { error: '未认证' } };
    const out = follow.deleteFollowRule(ctx.user, ctx.params.id);
    if (!out.ok) return { status: out.status || 400, body: out };
    return out;
  }],

  ['GET', '/api/v2/follow/feed', async (ctx) => {
    const g = readGuard(); if (g) return { status: g.status, body: g };
    if (!ctx.user) return { status: 401, body: { error: '未认证' } };
    return follow.listFollowFeed(ctx.user, {
      limit: ctx.query.limit,
      offset: ctx.query.offset,
      unreadOnly: ctx.query.unread_only === '1' || ctx.query.unread_only === 'true',
      ruleId: ctx.query.rule_id || null,
    });
  }],

  ['POST', '/api/v2/follow/read', async (ctx) => {
    const g = writeGuard(ctx); if (g) return { status: g.status, body: g };
    if (!ctx.user) return { status: 401, body: { error: '未认证' } };
    const out = follow.markFollowRead(ctx.user, {
      contentId: ctx.body?.content_id || null,
      eventGroupId: ctx.body?.event_group_id || null,
    });
    if (!out.ok) return { status: out.status || 400, body: out };
    return out;
  }],

  ['POST', '/api/v2/follow/read-all', async (ctx) => {
    const g = writeGuard(ctx); if (g) return { status: g.status, body: g };
    if (!ctx.user) return { status: 401, body: { error: '未认证' } };
    const out = follow.markFollowFeedRead(ctx.user, {
      ruleId: ctx.body?.rule_id || null,
      limit: Math.min(Math.max(Number(ctx.body?.limit) || 200, 1), 500),
    });
    if (!out.ok) return { status: out.status || 400, body: out };
    return out;
  }],

  /* ================= 后台：全文索引状态 / 有限批次重建 ================= */
  ['GET', '/api/v2/admin/search-index', async (ctx) => {
    const g = readGuard(); if (g) return { status: g.status, body: g };
    const denied = deny(ctx, '查看全文索引状态'); if (denied) return { status: denied.status, body: denied };
    return {
      ok: true,
      status: searchIndex.searchIndexStatus(),
      limits: {
        default_batch: searchIndex.SEARCH_INDEX_DEFAULT_BATCH,
        max_batch: searchIndex.SEARCH_INDEX_MAX_BATCH,
        version: searchIndex.SEARCH_INDEX_VERSION,
      },
      note: '查询不会触发全库重建；后台按有限批次重建/增量刷新，普通用户不能写索引。',
    };
  }],

  ['POST', '/api/v2/admin/search-index/rebuild', async (ctx) => {
    const g = writeGuard(ctx); if (g) return { status: g.status, body: g };
    const denied = deny(ctx, '重建全文索引'); if (denied) return { status: denied.status, body: denied };
    const types = Array.isArray(ctx.body?.types)
      ? ctx.body.types.map(String).filter((t) => searchIndex.SEARCH_TYPES[t])
      : null;
    const out = searchIndex.buildSearchIndex({
      types,
      maxDocs: ctx.body?.max_docs,
      offset: ctx.body?.offset,
      force: ctx.body?.force === true,
      rotate: ctx.body?.rotate === true,
      actor: ctx.user.name,
    });
    return { ok: true, ...out, status: searchIndex.searchIndexStatus() };
  }],

  /* ================= 后台：PDF 表格 worker ================= */
  ['GET', '/api/v2/admin/pdf-tables', async (ctx) => {
    const g = readGuard(); if (g) return { status: g.status, body: g };
    const denied = deny(ctx, '查看 PDF 表格任务'); if (denied) return { status: denied.status, body: denied };
    return {
      ok: true,
      worker: pdfTable.pdfTableStatus(),
      jobs: pdfTable.listPdfTableJobs({ limit: Number(ctx.query.limit) || 30 }),
      note: '只读受限原件根内 PDF；单并发、页数/大小/超时/输出上限；扫描空页不推断零家企业。',
    };
  }],

  ['GET', '/api/v2/admin/pdf-tables/candidates', async (ctx) => {
    const g = readGuard(); if (g) return { status: g.status, body: g };
    const denied = deny(ctx, '查看 PDF 表格候选'); if (denied) return { status: denied.status, body: denied };
    return { ok: true, ...pdfTable.listPdfTableCandidates({ limit: Number(ctx.query.limit) || 100 }) };
  }],

  ['POST', '/api/v2/admin/pdf-tables/run', async (ctx) => {
    const g = writeGuard(ctx); if (g) return { status: g.status, body: g };
    const denied = deny(ctx, '执行 PDF 表格解析'); if (denied) return { status: denied.status, body: denied };
    const out = await pdfTable.runPdfTableJob(ctx.user, ctx.body || {});
    if (!out.ok && out.status) return { status: out.status, body: out };
    return out;
  }],

  ['GET', '/api/v2/admin/pdf-tables/jobs/:id', async (ctx) => {
    const g = readGuard(); if (g) return { status: g.status, body: g };
    const denied = deny(ctx, '查看 PDF 表格结果'); if (denied) return { status: denied.status, body: denied };
    const out = pdfTable.getPdfTableJob(ctx.params.id, {
      includeTables: ctx.query.tables !== '0',
      page: ctx.query.page ? Number(ctx.query.page) : null,
      limit: Number(ctx.query.limit) || 100,
    });
    if (!out.ok) return { status: out.status || 404, body: out };
    return out;
  }],
];
