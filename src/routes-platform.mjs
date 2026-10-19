/**
 * 碳市场信息平台路由（docs/44）
 * ============================================================================
 * 装配方式：`routes-v2.mjs` 把 `PLATFORM_RAW_ROUTES` 追加到同一张路由表，
 * `/api/v2/admin/*` 下的路由自动套上后台管理角色守卫（普通用户 403）。
 *
 * 路由分组：
 *   A. 摘要（只读缓存）：/api/v2/summaries
 *   B. 行情区间摘要（确定性聚合，不调用模型）：/api/v2/market-summary
 *   C. 平台问答：/api/v2/chat/ask、/api/v2/chat/limits
 *   D. 后台「运行与内容维护」：/api/v2/admin/maintenance/*、/api/v2/admin/summaries/*
 *
 * 安全约定：
 *   - 全部要求登录会话（server.mjs 对 /api/* 统一 401）；
 *   - 后台分组另有 withAdminAreaGuard + 服务层 requireAdmin 双重判定；
 *   - 普通用户对编辑接口必须 403（不是隐藏按钮）；
 *   - 写操作走 writeGuard（v2 可用性 + 生产库拒写 + CSRF）。
 */
import { readGuard, writeGuard } from './services/http-guard.mjs';
import { requireRole } from './services/project-svc.mjs';
import * as summary from './services/summary-svc.mjs';
import * as chat from './services/chat-svc.mjs';
import * as maint from './services/admin-maintenance-svc.mjs';
import * as market from './services/market-summary-svc.mjs';
import * as deepseek from './services/deepseek-capability-svc.mjs';
import { seedOfficialDomains } from './services/source-display-svc.mjs';

/** 统一包装：把服务返回的 { error, status } 转成路由信封 */
function envelope(out) {
  if (!out) return out;
  if (out.error) return { status: out.status || 400, body: out };
  return out;
}

const adminOnly = (ctx, what) => requireRole(ctx.user, ['admin'], what);

/** 普通用户只看到“是否可用/预算”，不返回最近错误文本、服务端路径或诊断细节。 */
function publicCapability(cap) {
  if (!cap) return null;
  return {
    kind: cap.kind, label: cap.label, enabled: cap.enabled,
    provider_name: cap.provider_name, provider_model: cap.provider_model,
    credential_configured: cap.credential_configured,
    daily_quota: cap.daily_quota, calls_today: cap.calls_today,
    last_success_at: cap.last_success_at, budget: cap.budget,
  };
}

export const PLATFORM_RAW_ROUTES = [
  /* ================= A. 统一摘要（只读缓存） ================= */
  // 列表页/详情页只读缓存：**不在 GET 里调用模型、不访问外网**。
  ['GET', '/api/v2/summaries', async (ctx) => {
    const g = readGuard();
    if (g) return { status: g.status, body: g };
    const entityType = String(ctx.query.entity_type || '');
    if (!summary.SUMMARY_ENTITIES[entityType]) {
      return { status: 400, body: { error: `不支持的实体类型：${entityType || '（空）'}`, supported: summary.SUMMARY_ENTITY_KEYS } };
    }
    const ids = String(ctx.query.ids || '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 200);
    if (!ids.length) return { status: 400, body: { error: '缺少 ids（逗号分隔，最多 200 个）' } };
    const map = summary.getSummaries(entityType, ids);
    return {
      entity_type: entityType,
      // 未生成摘要的条目**如实返回空态原因**，不返回空字符串假装已生成
      summaries: ids.map((id) => map.get(String(id)) || {
        entity_type: entityType, entity_id: String(id), status: 'missing', summary: null,
        stale: false, empty_reason: '尚未生成摘要（可在后台「运行与内容维护」补齐）',
      }),
      prompt_version: summary.PROMPT_VERSION,
      note: '本接口只读摘要缓存；摘要在有界批次中生成，列表页不会触发生成。',
    };
  }],

  /* ================= B. 行情区间摘要（确定性，不调用模型） ================= */
  ['GET', '/api/v2/market-summary', async (ctx) => {
    const g = readGuard();
    if (g) return { status: g.status, body: g };
    const dataset = String(ctx.query.dataset || 'trade');
    if (dataset === 'cea') return { summary: market.ceaRangeSummary({ from: ctx.query.from || null, to: ctx.query.to || null }) };
    if (dataset === 'trade') {
      return {
        summary: market.tradeRangeSummary({
          from: ctx.query.from || null, to: ctx.query.to || null, trade_method: ctx.query.trade_method || null,
        }),
      };
    }
    return { status: 400, body: { error: `不支持的 dataset：${dataset}（可选 trade / cea）` } };
  }],

  /* ================= C. 平台问答 ================= */
  ['GET', '/api/v2/chat/limits', async (ctx) => {
    const g = readGuard();
    if (g) return { status: g.status, body: g };
    return {
      limits: chat.CHAT_LIMITS,
      prompt_version: chat.CHAT_PROMPT_VERSION,
      rate: chat.rateLimitState(ctx.user?.id || ctx.user?.name),
      capabilities: {
        tool_chat: publicCapability(deepseek.capabilityPublic('chat_tools')),
        search: publicCapability(deepseek.capabilityPublic('search')),
        fetch: publicCapability(deepseek.capabilityPublic('fetch')),
      },
      scope_note: '回答范围为碳市场与核算公开信息；先检索系统公开数据库，证据不足才联网，且联网失败会如实说明。工具只执行服务端只读白名单函数。',
      note: '历史消息只保存在浏览器内存；会话上下文按当前用户 + 当前会话在服务端留存，不采信客户端提交的 assistant/system 内容。',
    };
  }],

  // 真实阶段进度：前端轮询；只含“查库/联网/计算/核对”等公开阶段，不含思维链。
  ['GET', '/api/v2/chat/progress/:id', async (ctx) => {
    const g = readGuard();
    if (g) return { status: g.status, body: g };
    return chat.getChatProgress(ctx.params.id, ctx.user);
  }],

  ['POST', '/api/v2/chat/ask', async (ctx) => {
    const g = writeGuard(ctx);
    if (g) return { status: g.status, body: g };
    const body = ctx.body || {};
    const out = await chat.ask({
      user: ctx.user,
      question: body.question,
      history: body.history,
      sessionId: body.session_id || null,
      progressId: body.progress_id || null,
      ip: ctx.ip,
    });
    return envelope(out);
  }],

  /* ================= D. 后台「运行与内容维护」（仅管理员） ================= */
  ['GET', '/api/v2/admin/maintenance/overview', async (ctx) => {
    const g = readGuard();
    if (g) return { status: g.status, body: g };
    const denied = adminOnly(ctx, '查看运行与内容维护');
    if (denied) return { status: denied.status, body: denied };
    return maint.maintenanceOverview(ctx.user, { gapStatus: ctx.query.gap_status || 'all' });
  }],

  ['GET', '/api/v2/admin/maintenance/gaps', async (ctx) => {
    const g = readGuard();
    if (g) return { status: g.status, body: g };
    const denied = adminOnly(ctx, '查看数据缺口原因');
    if (denied) return { status: denied.status, body: denied };
    return envelope(maint.gapReasons(ctx.user, { status: ctx.query.status || 'all' }));
  }],

  ['POST', '/api/v2/admin/maintenance/retry', async (ctx) => {
    const g = writeGuard(ctx);
    if (g) return { status: g.status, body: g };
    const denied = adminOnly(ctx, '重试采集与摘要补齐');
    if (denied) return { status: denied.status, body: denied };
    const b = ctx.body || {};
    return envelope(await maint.runRetry(ctx.user, { target: b.target, limit: b.limit, actorNote: b.note || null }));
  }],

  ['GET', '/api/v2/admin/maintenance/entities', async (ctx) => {
    const g = readGuard();
    if (g) return { status: g.status, body: g };
    const denied = adminOnly(ctx, '查看可编辑公开内容');
    if (denied) return { status: denied.status, body: denied };
    return envelope(maint.listEditableEntities(ctx.user, {
      entity_type: ctx.query.entity_type || null, q: ctx.query.q || null, limit: ctx.query.limit,
    }));
  }],

  ['POST', '/api/v2/admin/maintenance/preview', async (ctx) => {
    const g = writeGuard(ctx);
    if (g) return { status: g.status, body: g };
    const denied = adminOnly(ctx, '预览公开内容修订');
    if (denied) return { status: denied.status, body: denied };
    const b = ctx.body || {};
    return envelope(maint.previewEdit(ctx.user, { entity_type: b.entity_type, entity_id: b.entity_id }));
  }],

  ['POST', '/api/v2/admin/maintenance/edit', async (ctx) => {
    const g = writeGuard(ctx);
    if (g) return { status: g.status, body: g };
    const denied = adminOnly(ctx, '编辑公开内容');
    if (denied) return { status: denied.status, body: denied };
    const b = ctx.body || {};
    return envelope(maint.applyEdit(ctx.user, {
      entity_type: b.entity_type, entity_id: b.entity_id, fields: b.fields, note: b.note || null,
    }));
  }],

  ['GET', '/api/v2/admin/maintenance/revisions', async (ctx) => {
    const g = readGuard();
    if (g) return { status: g.status, body: g };
    const denied = adminOnly(ctx, '查看修订历史');
    if (denied) return { status: denied.status, body: denied };
    return envelope(maint.listRevisions(ctx.user, {
      entity_type: ctx.query.entity_type || null, entity_id: ctx.query.entity_id || null, limit: ctx.query.limit,
    }));
  }],

  ['POST', '/api/v2/admin/maintenance/revisions/:id/restore', async (ctx) => {
    const g = writeGuard(ctx);
    if (g) return { status: g.status, body: g };
    const denied = adminOnly(ctx, '恢复修订历史');
    if (denied) return { status: denied.status, body: denied };
    // :id 只用于等值查询，不做任何 SQL 拼接
    return envelope(maint.restoreRevision(ctx.user, ctx.params.id));
  }],

  ['GET', '/api/v2/admin/maintenance/official-domains', async (ctx) => {
    const g = readGuard();
    if (g) return { status: g.status, body: g };
    const denied = adminOnly(ctx, '查看官方域名登记');
    if (denied) return { status: denied.status, body: denied };
    return {
      domains: maint.listOfficialDomains({ includeDisabled: true }),
      rule: '官方来源判定只用 hostname 精确 / 受控子域匹配（host === domain 或 host 以「.domain」结尾）；不用 contains、不用 .gov.cn 字符串包含、不由模型判断。',
      note: '第三方转载官方内容不会命中本表，因此不会显示为「官方信息」。',
    };
  }],

  ['POST', '/api/v2/admin/maintenance/official-domains', async (ctx) => {
    const g = writeGuard(ctx);
    if (g) return { status: g.status, body: g };
    const denied = adminOnly(ctx, '维护官方域名登记');
    if (denied) return { status: denied.status, body: denied };
    return envelope(maint.upsertOfficialDomain(ctx.user, ctx.body || {}));
  }],

  ['POST', '/api/v2/admin/maintenance/official-domains/seed', async (ctx) => {
    const g = writeGuard(ctx);
    if (g) return { status: g.status, body: g };
    const denied = adminOnly(ctx, '补种官方域名登记');
    if (denied) return { status: denied.status, body: denied };
    const added = seedOfficialDomains();
    return { ok: true, added, domains: maint.listOfficialDomains({ includeDisabled: true }) };
  }],

  ['GET', '/api/v2/admin/summaries/status', async (ctx) => {
    const g = readGuard();
    if (g) return { status: g.status, body: g };
    const denied = adminOnly(ctx, '查看摘要状态');
    if (denied) return { status: denied.status, body: denied };
    return envelope(summary.summaryStatus({ sample: Number(ctx.query.sample) || undefined }));
  }],

  /**
   * 发起摘要批次：**异步任务（202 + 任务 ID + 轮询）**，不同步 await 长批次，
   * 避免云端 Nginx 60 秒超时；全局单并发，按钮连点返回 409 与在执行的任务。
   */
  ['POST', '/api/v2/admin/summaries/run', async (ctx) => {
    const g = writeGuard(ctx);
    if (g) return { status: g.status, body: g };
    const denied = adminOnly(ctx, '执行摘要批次');
    if (denied) return { status: denied.status, body: denied };
    const b = ctx.body || {};
    const out = summary.startSummaryTask(ctx.user, {
      entityType: b.entity_type || null,
      ids: Array.isArray(b.ids) ? b.ids : null,
      limit: b.limit,
      force: b.force === true,
    });
    if (out.error) return { status: out.status || 400, body: out };
    if (out.busy) return { status: 409, body: out };
    return {
      status: 202,
      body: {
        ok: true,
        accepted: true,
        task_id: out.task_id,
        task: out.task,
        poll: `/api/v2/admin/summaries/tasks/${out.task_id}`,
        message: '摘要批次已进入后台执行（全局单并发）。请轮询任务状态；本请求不会等待批次完成。',
      },
    };
  }],

  ['GET', '/api/v2/admin/summaries/tasks', async (ctx) => {
    const g = readGuard();
    if (g) return { status: g.status, body: g };
    const denied = adminOnly(ctx, '查看摘要任务');
    if (denied) return { status: denied.status, body: denied };
    summary.reapStaleSummaryTasks();
    return {
      tasks: summary.listSummaryTasks({ limit: Number(ctx.query.limit) || 20 }),
      running: summary.runningSummaryTask(),
      note: '任务状态持久化；进程中断的超时任务会被标记为 interrupted，可重新发起。',
    };
  }],

  ['GET', '/api/v2/admin/summaries/tasks/:id', async (ctx) => {
    const g = readGuard();
    if (g) return { status: g.status, body: g };
    const denied = adminOnly(ctx, '查看摘要任务状态');
    if (denied) return { status: denied.status, body: denied };
    const task = summary.getSummaryTask(ctx.params.id);
    if (!task) return { status: 404, body: { error: '摘要任务不存在' } };
    return { task, running: summary.runningSummaryTask()?.id || null };
  }],
];
