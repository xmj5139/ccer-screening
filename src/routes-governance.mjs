/**
 * 信息治理 / 历史补采 / 方法学版本 / 统一检索路由（docs/74）
 * ============================================================================
 * 普通用户：统一检索、方法学时间线与差异、关系只读；
 * 管理员：处理阶段、补采任务、关系候选提交/自动确认。
 * /api/v2/admin/* 由 routes-v2 统一套后台管理员守卫；服务层再次校验角色。
 */
import { readGuard, writeGuard } from './services/http-guard.mjs';
import { requireRole } from './services/project-svc.mjs';
import * as gov from './services/governance-svc.mjs';
import * as backfill from './services/history-backfill-svc.mjs';
import * as method from './services/methodology-version-svc.mjs';
import * as search from './services/unified-search-svc.mjs';
import * as semanticSearch from './services/semantic-search-svc.mjs';

function guardRead() {
  return readGuard();
}

function requireAdmin(ctx, action) {
  return requireRole(ctx.user, ['admin'], action);
}

export const GOVERNANCE_RAW_ROUTES = [
  /* ================= 统一检索（登录用户） ================= */
  ['GET', '/api/v2/search', async (ctx) => {
    const g = guardRead();
    if (g) return { status: g.status, body: g };
    return search.searchUnified({
      q: ctx.query.q, types: ctx.query.types, source: ctx.query.source,
      source_category: ctx.query.source_category, region: ctx.query.region,
      from: ctx.query.from, to: ctx.query.to, sort: ctx.query.sort,
      page: ctx.query.page, page_size: ctx.query.page_size, offset: ctx.query.offset,
    });
  }],
  ['GET', '/api/v2/search/meta', async () => {
    const g = guardRead();
    if (g) return { status: g.status, body: g };
    return search.searchMeta();
  }],
  // 语义扩展检索必须是显式 POST：GET 列表不会隐式调用模型。
  // 模型不可用/限流/精确编号时返回原关键词结果并标记 fallback/keyword。
  ['POST', '/api/v2/search/semantic', async (ctx) => {
    const g = guardRead();
    if (g) return { status: g.status, body: g };
    const b = ctx.body || {};
    const out = await semanticSearch.searchSemantic({
      q: b.q, types: b.types, source: b.source,
      source_category: b.source_category, region: b.region,
      from: b.from, to: b.to, sort: b.sort,
      page: b.page, page_size: b.page_size, offset: b.offset,
    }, { userId: ctx.user?.id || ctx.user?.name || null, actor: ctx.user?.name || 'user' });
    return { status: out.status || 200, body: out };
  }],

  /* ================= 方法学版本（登录用户只读） ================= */
  ['GET', '/api/v2/methodology-versions/:id/timeline', async (ctx) => {
    const g = guardRead();
    if (g) return { status: g.status, body: g };
    const out = method.methodologyTimeline(ctx.params.id);
    if (!out) return { status: 404, body: { error: '方法学版本不存在' } };
    return out;
  }],
  ['GET', '/api/v2/methodology-versions/:id/diff', async (ctx) => {
    const g = guardRead();
    if (g) return { status: g.status, body: g };
    const compareTo = ctx.query.compare_to || ctx.query.compare_version_id;
    if (!compareTo) return { status: 400, body: { error: '需要 compare_to（对比版本 ID）' } };
    if (ctx.query.saved === '1') {
      return { version_id: ctx.params.id, compare_to: compareTo, diffs: method.savedDiffs(ctx.params.id, compareTo) };
    }
    return method.compareVersions(ctx.params.id, compareTo);
  }],
  ['GET', '/api/v2/methodology-relations', async (ctx) => {
    const g = guardRead();
    if (g) return { status: g.status, body: g };
    return {
      relations: method.listRelations({
        versionId: ctx.query.version_id || null,
        methodologyId: ctx.query.methodology_id || null,
        status: ctx.query.status || null,
      }),
      relation_types: method.RELATION_TYPES,
      note: '候选关系不按编号相邻推断；confirmed 需要原文定位、逐字引文与既有核验同时满足。',
    };
  }],
  ['POST', '/api/v2/methodology-relations', async (ctx) => {
    const g = writeGuard(ctx);
    if (g) return { status: g.status, body: g };
    const denied = requireRole(ctx.user, ['admin', 'researcher'], '提交方法学版本关系');
    if (denied) return { status: denied.status, body: denied };
    return method.proposeRelation(ctx.user, ctx.body || {});
  }],
  ['POST', '/api/v2/methodology-relations/reconcile', async (ctx) => {
    const g = writeGuard(ctx);
    if (g) return { status: g.status, body: g };
    const denied = requireAdmin(ctx, '批量确认方法学关系');
    if (denied) return { status: denied.status, body: denied };
    return { ok: true, ...method.reconcileAllRelations() };
  }],

  /* ================= 后台：处理阶段 ================= */
  ['GET', '/api/v2/admin/governance/pipeline', async (ctx) => {
    const denied = requireAdmin(ctx, '查看信息治理漏斗');
    if (denied) return { status: denied.status, body: denied };
    const out = gov.listPipeline({
      objectType: ctx.query.object_type || ctx.query.objectType || null,
      stage: ctx.query.stage || null, status: ctx.query.status || null,
      publisher: ctx.query.publisher || null, source_category: ctx.query.source_category || null,
      q: ctx.query.q || null, limit: Number(ctx.query.limit) || 50,
      offset: Number(ctx.query.offset) || 0,
    });
    if (out.error) return { status: out.status || 400, body: out };
    return out;
  }],
  ['GET', '/api/v2/admin/governance/config', async (ctx) => {
    const denied = requireAdmin(ctx, '查看治理配置');
    if (denied) return { status: denied.status, body: denied };
    return { config: gov.governanceConfig(), lease: gov.getLease('collection'), note: '所有上限都有硬上限，环境变量不能突破。' };
  }],
  ['GET', '/api/v2/admin/governance/items/:objectType/:id', async (ctx) => {
    const denied = requireAdmin(ctx, '查看治理条目明细');
    if (denied) return { status: denied.status, body: denied };
    const out = gov.getGovernanceItem(ctx.params.id, { objectType: ctx.params.objectType });
    if (out.error) return { status: out.status || 400, body: out };
    return out;
  }],
  ['POST', '/api/v2/admin/governance/sync', async (ctx) => {
    const g = writeGuard(ctx);
    if (g) return { status: g.status, body: g };
    const denied = requireAdmin(ctx, '补齐处理阶段');
    if (denied) return { status: denied.status, body: denied };
    const limit = Math.min(Math.max(Number(ctx.body?.limit) || 200, 1), 500);
    return {
      ok: true,
      ...gov.syncRecentStages({
        objectTypes: Array.isArray(ctx.body?.object_types) && ctx.body.object_types.length
          ? ctx.body.object_types : undefined,
        limit,
      }),
    };
  }],
  ['POST', '/api/v2/admin/governance/process', async (ctx) => {
    const g = writeGuard(ctx);
    if (g) return { status: g.status, body: g };
    const denied = requireAdmin(ctx, '执行治理补处理');
    if (denied) return { status: denied.status, body: denied };
    const out = await gov.runGovernanceBatch(ctx.user, {
      limit: Number(ctx.body?.limit) || null,
      budgetMs: Number(ctx.body?.budget_ms) || null,
    });
    if (out?.ok === false && out.reason === 'lease_busy') {
      return { status: 409, body: { error: '已有采集/补采任务持有 collection 租约', ...out } };
    }
    return out;
  }],
  ['POST', '/api/v2/admin/governance/retry', async (ctx) => {
    const g = writeGuard(ctx);
    if (g) return { status: g.status, body: g };
    const denied = requireAdmin(ctx, '重试处理阶段');
    if (denied) return { status: denied.status, body: denied };
    return gov.retryStage(ctx.user, {
      objectId: ctx.body?.object_id,
      objectType: ctx.body?.object_type || 'content_item',
      stage: ctx.body?.stage,
    });
  }],

  /* ================= 后台：历史补采 ================= */
  ['GET', '/api/v2/admin/backfill/sources', async (ctx) => {
    const denied = requireAdmin(ctx, '查看历史补采范围');
    if (denied) return { status: denied.status, body: denied };
    return backfill.backfillSources();
  }],
  ['POST', '/api/v2/admin/backfill/preview', async (ctx) => {
    const g = writeGuard(ctx);
    if (g) return { status: g.status, body: g };
    const denied = requireAdmin(ctx, '预览历史补采计划');
    if (denied) return { status: denied.status, body: denied };
    return backfill.previewBackfill(ctx.body || {});
  }],
  ['POST', '/api/v2/admin/backfill/tasks', async (ctx) => {
    const g = writeGuard(ctx);
    if (g) return { status: g.status, body: g };
    const denied = requireAdmin(ctx, '创建历史补采任务');
    if (denied) return { status: denied.status, body: denied };
    return backfill.createBackfillTask(ctx.user, ctx.body || {});
  }],
  ['GET', '/api/v2/admin/backfill/tasks', async (ctx) => {
    const denied = requireAdmin(ctx, '查看历史补采任务');
    if (denied) return { status: denied.status, body: denied };
    return { tasks: backfill.listBackfillTasks({ limit: Number(ctx.query.limit) || 30 }) };
  }],
  ['GET', '/api/v2/admin/backfill/tasks/:id', async (ctx) => {
    const denied = requireAdmin(ctx, '查看历史补采任务');
    if (denied) return { status: denied.status, body: denied };
    const task = backfill.getBackfillTask(ctx.params.id);
    if (!task) return { status: 404, body: { error: '补采任务不存在' } };
    return { task };
  }],
  ['POST', '/api/v2/admin/backfill/tasks/:id/start', async (ctx) => {
    const g = writeGuard(ctx);
    if (g) return { status: g.status, body: g };
    const denied = requireAdmin(ctx, '启动历史补采任务');
    if (denied) return { status: denied.status, body: denied };
    const task = backfill.getBackfillTask(ctx.params.id);
    if (!task) return { status: 404, body: { error: '补采任务不存在' } };
    if (task.status === 'paused') return { status: 409, body: { error: '任务已暂停，请先继续' } };
    if (task.status === 'cancelled') return { status: 409, body: { error: '任务已取消，请新建' } };
    const out = backfill.scheduleBackfillRun(ctx.params.id, {
      actor: ctx.user.name || 'admin',
      maxWindows: Math.min(Math.max(Number(ctx.body?.max_windows) || 2, 1), 10),
      maxMs: Math.min(Math.max(Number(ctx.body?.max_ms) || 60000, 5000), 300000),
    });
    return { status: 202, body: out };
  }],
  ['POST', '/api/v2/admin/backfill/tasks/:id/pause', async (ctx) => {
    const g = writeGuard(ctx); if (g) return { status: g.status, body: g };
    const denied = requireAdmin(ctx, '暂停历史补采任务'); if (denied) return { status: denied.status, body: denied };
    return backfill.pauseBackfillTask(ctx.user, ctx.params.id);
  }],
  ['POST', '/api/v2/admin/backfill/tasks/:id/resume', async (ctx) => {
    const g = writeGuard(ctx); if (g) return { status: g.status, body: g };
    const denied = requireAdmin(ctx, '继续历史补采任务'); if (denied) return { status: denied.status, body: denied };
    const out = backfill.resumeBackfillTask(ctx.user, ctx.params.id);
    if (out.ok) backfill.scheduleBackfillRun(ctx.params.id, { actor: ctx.user.name || 'admin' });
    return out;
  }],
  ['POST', '/api/v2/admin/backfill/tasks/:id/cancel', async (ctx) => {
    const g = writeGuard(ctx); if (g) return { status: g.status, body: g };
    const denied = requireAdmin(ctx, '取消历史补采任务'); if (denied) return { status: denied.status, body: denied };
    return backfill.cancelBackfillTask(ctx.user, ctx.params.id);
  }],
  ['POST', '/api/v2/admin/backfill/tasks/:id/retry', async (ctx) => {
    const g = writeGuard(ctx); if (g) return { status: g.status, body: g };
    const denied = requireAdmin(ctx, '重试历史补采任务'); if (denied) return { status: denied.status, body: denied };
    const out = backfill.retryBackfillTask(ctx.user, ctx.params.id);
    if (out.ok) backfill.scheduleBackfillRun(ctx.params.id, { actor: ctx.user.name || 'admin' });
    return out;
  }],
];
