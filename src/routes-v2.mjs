/**
 * v2 API 路由（七大模块 · 公开信息平台）
 * ============================================================================
 * 挂载方式：server.mjs 把本模块的 V2_ROUTES 追加到同一张路由表，
 * 所有路径以 /api/v2/ 前缀。
 *
 * 【本轮升级】（docs/19-公开信息整合平台升级任务.md）
 *   - 新增「研报与行业动态」模块接口（/api/v2/content/*）；
 *   - 新增搜索服务、网页抓取连接、自动核验策略接口（后台管理）；
 *   - **停用**内部项目（internal-projects）、项目人工确认、政策人工确认、
 *     政策变更确认、行情人工核对、审核任务等旧业务入口：这些路由直接返回 410，
 *     旧路由不能成为绕过权限或绕过自动核验的入口（源码保留在服务层作历史）。
 *
 * 统一约定：
 *   - 每个写操作前调用 guardV2({ write: true })：未开启 v2 / 表未就绪 → 503；
 *     指向在用生产库 data/ccer.db → 409（拒绝写入）。
 *   - 权限一律服务端判定（requireRole），不依赖前端隐藏入口。
 *   - 导出走 export-svc（CSV/XLSX/JSON + 导出审计），响应 { raw: ... }。
 *   - Cookie 会话下的写操作做同源校验（防止跨站请求伪造）。
 */
import { guardV2, v2Status } from './services/v2-guard.mjs';
// 读写守卫的单一实现（CEA 路由共用同一份，避免安全语义分叉）
import { writeGuard, readGuard } from './services/http-guard.mjs';
import { requireRole } from './services/project-svc.mjs';
import { buildExport } from './services/export-svc.mjs';
import { IMPORT_TEMPLATES, getTemplate, templateCsv, rowsFromCsv } from './data/import-templates.mjs';
import * as dash from './services/dashboard-svc.mjs';
import * as regionMap from './services/region-map-svc.mjs';
import * as policy from './services/policy-svc.mjs';
import * as projects from './services/project-v2-svc.mjs';
import * as trade from './services/trade-svc.mjs';
import * as measure from './services/measure-svc.mjs';
import * as admin from './services/admin-v2-svc.mjs';
import * as collect from './services/collect-svc.mjs';
import * as reconcile from './services/reconcile-svc.mjs';
import * as reconcileAi from './services/reconciliation-ai-svc.mjs';
import * as documentUpload from './services/document-upload-svc.mjs';
import * as content from './services/content-svc.mjs';
import * as search from './services/search-svc.mjs';
import * as fetchSvc from './services/web-fetch-svc.mjs';
import * as deepseek from './services/deepseek-capability-svc.mjs';
import * as deepseekFallback from './services/deepseek-fallback-svc.mjs';
import * as verify from './services/verification-svc.mjs';
import { syncStatus } from './services/collect-svc.mjs';
import { get as dbGet } from './core/db.mjs';
import * as registry from './services/registry-svc.mjs';
import { quickGasEstimate, quickGasMeta } from './services/quick-estimate-svc.mjs';
// CEA（全国碳排放配额）专题路由：独立文件，装配到同一张表（共用守卫与信封规约）
import { CEA_RAW_ROUTES } from './routes-cea.mjs';
// PDF 解析 / OCR 后台路由（docs/36）：同样装配到同一张表，共用后台角色守卫
import { OCR_RAW_ROUTES } from './routes-ocr.mjs';
// 公开碳核算资料路由（docs/39）：来源/因子/标准/中碳登清结算 + 碳排放计算 + 后台采集
import { ACCOUNTING_RAW_ROUTES } from './routes-accounting.mjs';
// 碳市场信息平台路由（docs/44）：统一摘要 / 行情区间口径 / 平台问答 / 后台运行与内容维护
import { PLATFORM_RAW_ROUTES } from './routes-platform.mjs';
// 统一摘要与来源展示口径（docs/44 第 2、3 条）：列表与详情统一挂载，读路径只读缓存
import * as summary from './services/summary-svc.mjs';
import { sourceDisplay } from './services/source-display-svc.mjs';
import * as maint from './services/admin-maintenance-svc.mjs';

/* ------------------------------ 通用辅助 ------------------------------ */

/** 已停用的旧业务入口：明确回应，避免被当作可用路径或权限绕过点 */
const RETIRED = {
  status: 410,
  error: '该功能已停用',
  retired: true,
  message:
    '本平台已升级为「公开信息平台」：不再提供内部项目档案、项目录入、尽调与投资审批，' +
    '也不再提供任何人工复核 / 人工确认 / 专家签字 / 审核待办。' +
    '采集、核验与发布全部自动化，请使用对应的公开信息接口（/api/v2/content、/api/v2/public-projects、' +
    '/api/v2/policies、/api/v2/trade）。',
};

/** 已停用路由的统一处理函数：对任何角色都只回 410，因此不做角色判定 */
const retiredHandler = async () => RETIRED;

/**
 * 后台管理命名空间（/api/v2/admin/*）的最小角色要求。
 * 仅 admin 可访问；其余角色一律 403。
 * 该判定与具体接口无关，因此在路由表装配时统一加装（见文件末尾 V2_ROUTES）。
 */
export const ADMIN_AREA_ROLES = ['admin'];

/**
 * 后台管理守卫：v2 可用性 → 身份 → 角色，逐层判定后才进入业务处理。
 * 历史上多条 /api/v2/admin/* 只读接口（如 status、jobs、snapshots、gaps、metrics）
 * 依赖各处理函数自行判定，容易漏判；这里统一兜底，普通用户访问后台设置一律 403。
 */
function withAdminAreaGuard(handler) {
  return async (ctx) => {
    const g = readGuard();
    if (g) return { status: g.status, body: g };
    if (!ctx || !ctx.user) return { status: 401, body: { error: '未认证' } };
    const denied = requireRole(ctx.user, ADMIN_AREA_ROLES, '访问后台管理');
    if (denied) return { status: denied.status, body: denied };
    return handler(ctx);
  };
}

/** 写操作守卫 / 读守卫：见 services/http-guard.mjs（CEA 路由共用同一实现） */

/** 统一包装：把服务返回的 { error, status } 转成路由信封 */
function envelope(out) {
  if (!out) return out;
  if (out.error) return { status: out.status || 400, body: out };
  return out;
}

function exportResponse(ctx, { dataset, fileBase, format, columns, rows, meta, filters }) {
  const out = buildExport({
    user: ctx.user, dataset, fileBase, format: format || 'csv', columns, rows, meta: meta || {}, filters,
    ip: ctx.ip,
  });
  return {
    raw: {
      mime: out.mime,
      body: out.body,
      headers: {
        'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(out.file_name)}`,
        'x-export-sha256': out.sha256,
        'x-export-rows': String(out.row_count),
      },
    },
  };
}

function fmt(params) {
  return String(params.format || 'csv').toLowerCase();
}

/* ------------------------------ 摘要 / 来源挂载 ------------------------------ */

/**
 * 统一挂载「核心摘要」与「来源展示口径」（docs/44 第 2、3 条）。
 * 只读摘要缓存，**不在列表 GET 里生成摘要或访问外网**。
 */
function withSummaries(entityType, rows, { overlay = false } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  let prepared = list;
  if (overlay) {
    try {
      prepared = maint.mergeOverlays(entityType, list);
    } catch {
      prepared = list;
    }
  }
  return summary.attachSummaries(entityType, prepared);
}

/** 单条：摘要 + 覆盖层 + 来源展示。 */
function withSummaryOne(entityType, row, { overlay = false } = {}) {
  if (!row) return row;
  let prepared = row;
  if (overlay) {
    try {
      prepared = maint.mergeOverlay(entityType, row);
    } catch {
      prepared = row;
    }
  }
  return summary.attachSummary(entityType, prepared);
}

/** 给任意行补来源展示口径（官方信息 / 实际发布机构 / 来源未标注）。 */
export function withSourceDisplay(row, urlKeys = ['source_url', 'official_url', 'url']) {
  if (!row) return row;
  const url = urlKeys.map((k) => row[k]).find(Boolean) || null;
  return {
    ...row,
    source_display: sourceDisplay({
      url,
      publisher: row.publisher || row.issuer || row.issuing_authority,
      source_category: row.source_category,
    }),
  };
}

/* ------------------------------ 路由表 ------------------------------ */

const RAW_ROUTES = [
  ['GET', '/api/v2/registry/status', async () => registry.registryStatus()],
  ['POST', '/api/v2/registry/sync', async (ctx) => {
    const g=writeGuard(ctx); if(g)return {status:g.status,body:g};
    const denied=requireRole(ctx.user,['admin','researcher'],'同步官方项目库');
    if(denied)return {status:denied.status,body:denied};
    const b=ctx.body||{};
    return registry.syncRegistry({actor:ctx.user.name,maxDetails:Math.min(Number(b.max_details)||500,500),
      archiveFiles:b.archive_files===true || (!!process.env.CCER_REGISTRY_COOKIE && b.archive_files!==false)});
  }],

  /* ================= 减排粗估（无项目档案、无审批） ================= */
  ['GET', '/api/v2/measure/quick-gas/meta', async () => {
    const g = readGuard();
    if (g) return { status: g.status, body: g };
    return quickGasMeta();
  }],
  ['POST', '/api/v2/measure/quick-gas', async (ctx) => {
    const g = writeGuard(ctx); if(g)return {status:g.status,body:g};
    return envelope(quickGasEstimate(ctx.body||{}));
  }],

  /* ================= 系统状态 / 元数据 ================= */
  // docs/44 第 4 条 + docs/46 第 8 条 + docs/47：
  // 运行细节（采集失败告警、未结清差异、核验四态、搜索/抓取/模型连接状态）只在
  // 后台「运行与内容维护」展示；`/api/v2/status` 对**非管理员**同样不返回它们。
  // 公开保留：数据自身日期（data_as_of / last_success_sync）、公开内容条目数、
  // 演示条目计数与导入模板 —— 这些是阅读信息，不是运行告警。
  ['GET', '/api/v2/status', async (ctx) => {
    const st = v2Status();
    if (!st.ok) return { status: 200, body: { v2: st, degraded: true } };
    const demoProjects = dbGet("SELECT COUNT(*) AS n FROM public_project WHERE note LIKE '演示条目%'")?.n ?? 0;
    const demoContent = dbGet('SELECT COUNT(*) AS n FROM content_item WHERE is_demo=1')?.n ?? 0;
    const contentStats = content.contentStatus().stats;
    const templates = Object.values(IMPORT_TEMPLATES).map((t) => ({ key: t.key, name: t.name }));
    const isAdmin = ctx?.user?.role === 'admin';
    if (!isAdmin) {
      const sync = syncStatus();
      // 核验四态统计属于运行信息，只随后台维护页给管理员
      const { by_verification: _omitVerification, ...publicContentStats } = contentStats;
      return {
        v2: st,
        sync: {
          // 只保留数据自身的日期与公开条目数
          data_as_of: sync.data_as_of,
          last_success_sync: sync.last_success_sync,
          counts: { content_items: sync.counts?.content_items ?? 0 },
        },
        content: publicContentStats,
        demo_projects: demoProjects,
        demo_content: demoContent,
        templates,
        run_info_scope: '运行告警、缺口与核验统计只在后台「运行与内容维护」对管理员展示。',
      };
    }
    return {
      v2: st,
      sync: syncStatus(),
      demo_projects: demoProjects,
      demo_content: demoContent,
      content: contentStats,
      search: search.searchStatus(),
      fetch: fetchSvc.fetchStatus(),
      verification: verify.verificationStats(),
      templates,
    };
  }],

  ['GET', '/api/v2/meta/templates', async () => ({
    templates: Object.values(IMPORT_TEMPLATES).map((t) => ({
      key: t.key, name: t.name, purpose: t.purpose, source_note: t.source_note,
      columns: t.columns, example: t.example,
    })),
  })],

  ['GET', '/api/v2/meta/templates/:key/file', async (ctx) => {
    const csv = templateCsv(ctx.params.key);
    if (!csv) return { status: 404, body: { error: `未找到模板：${ctx.params.key}` } };
    const t = getTemplate(ctx.params.key);
    return {
      raw: {
        mime: 'text/csv; charset=utf-8',
        body: Buffer.from(csv, 'utf8'),
        headers: {
          'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(`${t.name}_模板.csv`)}`,
        },
      },
    };
  }],

  /* ================= 核验状态口径（前端展示用） ================= */
  ['GET', '/api/v2/meta/verification-states', async () => ({
    states: Object.values(verify.VERIFY_RESULTS),
    note: '四个状态互斥；「自动核验通过」只表示证据一致性，不表示独立审计或主管部门确认。',
  })],

  /* ================= 总览 ================= */
  ['GET', '/api/v2/overview', async (ctx) => {
    const g = readGuard();
    if (g) return { status: g.status, body: g };
    const out = dash.overview(ctx.query);
    // 最新政策与最新研报动态：标题下带核心摘要 + 来源展示口径
    out.policies = {
      ...(out.policies || {}),
      latest: withSummaries('policy_document', out.policies?.latest || []).map((p) => withSourceDisplay(p, ['official_url', 'source_url'])),
    };
    out.content = {
      ...(out.content || {}),
      latest: withSummaries('content_item', out.content?.latest || []).map((c) => withSourceDisplay(c, ['source_url'])),
    };
    return out;
  }],

  ['GET', '/api/v2/overview/market', async (ctx) => {
    const g = readGuard();
    if (g) return { status: g.status, body: g };
    return { market: dash.marketSeries({ range: ctx.query.range || '90d', as_of: ctx.query.as_of }) };
  }],

  /* ---- 省域地图（docs/59）：普通用户只读，匿名由服务端统一 401 ---- */
  ['GET', '/api/v2/overview/region-map', async (ctx) => {
    const g = readGuard();
    if (g) return { status: g.status, body: g };
    const out = regionMap.buildRegionMap(ctx.query || {});
    if (out.error) return { status: out.status || 400, body: out };
    return out;
  }],

  ['GET', '/api/v2/overview/region-map/export', async (ctx) => {
    const g = readGuard();
    if (g) return { status: g.status, body: g };
    if (!ctx.user) return { status: 401, body: { error: '未认证' } };
    const out = regionMap.buildRegionMapExport(ctx.query || {});
    if (out.error) return { status: out.status || 400, body: out };
    return exportResponse(ctx, {
      dataset: out.dataset,
      fileBase: out.fileBase,
      format: fmt(ctx.query),
      columns: out.columns,
      rows: out.rows,
      meta: out.meta,
      filters: ctx.query,
    });
  }],

  ['GET', '/api/v2/meta/metrics', async (ctx) => {
    const g = readGuard();
    if (g) return { status: g.status, body: g };
    return { metrics: dash.metricDefinitions(ctx.query.module || null) };
  }],

  ['GET', '/api/v2/notifications', async (ctx) => {
    const g = readGuard();
    if (g) return { status: g.status, body: g };
    // docs/44 第 4 条：运行告警/未结清差异属后台运行信息，仅管理员可访问；
    // 普通用户不能通过直接请求该接口绕过总览的版块移除。
    const denied = requireRole(ctx.user, ['admin'], '查看运行提醒明细');
    if (denied) return { status: denied.status, body: denied };
    const notifications = collect
      .listNotifications({ limit: Number(ctx.query.limit) || 100 })
      .map((n) => ({ ...n, settled: collect.notificationSettled(n) }));
    return {
      notifications,
      // 未读数只统计**所指问题仍未结清**的提醒；已结清的历史提醒单独计数。
      unread: notifications.filter((n) => !n.settled && !n.read_at).length,
      settled: notifications.filter((n) => n.settled).length,
      note:
        'settled=true 表示该提醒所指向的核对记录 / 告警已结清，属历史留痕（附结清说明），' +
        '不再作为待关注；本接口属后台运行信息，仅管理员可见。',
    };
  }],

  ['POST', '/api/v2/notifications/:id/read', async (ctx) => {
    const g = writeGuard(ctx);
    if (g) return { status: g.status, body: g };
    return collect.markNotificationRead(ctx.user, ctx.params.id);
  }],

  /* ================= 政策和方法学 ================= */
  ['GET', '/api/v2/policies/stats', async () => {
    const g = readGuard();
    if (g) return { status: g.status, body: g };
    return policy.policyStats();
  }],

  ['GET', '/api/v2/policies', async (ctx) => {
    const g = readGuard();
    if (g) return { status: g.status, body: g };
    const rows = withSummaries('policy_document', policy.listPolicies(ctx.query), { overlay: true })
      .map((p) => withSourceDisplay(p, ['official_url', 'source_url']));
    return { policies: rows, stats: policy.policyStats() };
  }],

  ['GET', '/api/v2/policies/export', async (ctx) => {
    const g = readGuard();
    if (g) return { status: g.status, body: g };
    const rows = policy.listPolicies(ctx.query);
    return exportResponse(ctx, {
      dataset: '政策库',
      fileBase: 'policy_library',
      format: fmt(ctx.query),
      filters: ctx.query,
      columns: [
        { key: 'title', label: '标题' },
        { key: 'doc_number', label: '文号' },
        { key: 'issuing_authority', label: '发布机关' },
        { key: 'category_label', label: '分类' },
        { key: 'status_label', label: '状态', definition: '现行有效/已被替代/已废止/征求意见中/公告' },
        { key: 'auto_verify_label', label: '自动核验', definition: '自动核验通过/证据不足/来源冲突/暂未自动核验' },
        { key: 'publish_date', label: '发布日期' },
        { key: 'effective_date', label: '生效日期' },
        { key: 'version_label', label: '版本' },
        { key: 'official_url', label: '官方链接' },
        { key: 'attachment_count', label: '附件数' },
        { key: 'archived_count', label: '已归档原件数' },
        { key: 'collected_at', label: '采集时间' },
        { key: 'summary', label: '摘要' },
      ],
      rows,
      meta: {
        数据截至: policy.policyStats().latest_publish_date || '—',
        来源: '生态环境部及相关部委官方发布',
        口径: '全部为官方原文自动采集；「自动核验」为规则与模型的一致性检查结论，无人工确认环节。',
      },
    });
  }],

  ['GET', '/api/v2/policies/:id', async (ctx) => {
    const g = readGuard();
    if (g) return { status: g.status, body: g };
    const out = policy.getPolicyDetail(ctx.params.id);
    if (!out) return { status: 404, body: { error: '政策条目不存在' } };
    return {
      ...out,
      policy: withSourceDisplay(withSummaryOne('policy_document', out.policy, { overlay: true }), ['official_url']),
    };
  }],

  ['PATCH', '/api/v2/policies/:id', async (ctx) => {
    const g = writeGuard(ctx);
    if (g) return { status: g.status, body: g };
    const denied = requireRole(ctx.user, ['admin', 'researcher'], '编辑政策');
    if (denied) return { status: denied.status, body: denied };
    return envelope(policy.updatePolicy(ctx.user, ctx.params.id, ctx.body || {}));
  }],

  ['POST', '/api/v2/policies/:id/attachments', async (ctx) => {
    const g = writeGuard(ctx);
    if (g) return { status: g.status, body: g };
    const denied = requireRole(ctx.user, ['admin', 'researcher'], '登记政策原件');
    if (denied) return { status: denied.status, body: denied };
    return envelope(policy.registerAttachment(ctx.user, ctx.params.id, ctx.body || {}));
  }],

  ['GET', '/api/v2/methodologies', async (ctx) => {
    const g = readGuard();
    if (g) return { status: g.status, body: g };
    const out = policy.listMethodologiesV2(ctx.query);
    // 正式与草案两份列表都要带核心摘要与来源展示（标题下展示）
    const attach = (rows) => withSummaries('methodology_version', rows || []).map((m) => withSourceDisplay(m, ['official_url']));
    return { ...out, formal: attach(out.formal), draft: attach(out.draft) };
  }],

  ['GET', '/api/v2/methodologies/:id', async (ctx) => {
    const g = readGuard();
    if (g) return { status: g.status, body: g };
    const out = policy.getMethodologyDetail(ctx.params.id);
    if (!out) return { status: 404, body: { error: '方法学版本不存在' } };
    const key = out.version?.id || out.id || ctx.params.id;
    return { ...out, summary_block: summary.summaryPayload('methodology_version', { id: key, ...(out.version || {}) }, summary.getSummary('methodology_version', key)) };
  }],

  ['POST', '/api/v2/methodologies/interpretations', async (ctx) => {
    const g = writeGuard(ctx);
    if (g) return { status: g.status, body: g };
    const denied = requireRole(ctx.user, ['admin', 'researcher'], '维护方法学解读');
    if (denied) return { status: denied.status, body: denied };
    return envelope(policy.upsertInterpretation(ctx.user, ctx.body || {}));
  }],

  ['GET', '/api/v2/catalog/completeness', async () => {
    const g = readGuard();
    if (g) return { status: g.status, body: g };
    return policy.catalogCompleteness();
  }],

  // 官方原文变化：**只读**展示（自动检测结果，不是审批待办）
  ['GET', '/api/v2/policy-changes', async (ctx) => {
    const g = readGuard();
    if (g) return { status: g.status, body: g };
    return {
      changes: policy.listPolicyChanges({ status: ctx.query.status || 'all', limit: Number(ctx.query.limit) || 200 }),
      note:
        '官方原文变化的只读记录：每日巡检自动比对并写差异摘要与影响面。' +
        '这是自动运行状态，不是审批待办；平台已取消「确认/忽略」人工处理入口。',
    };
  }],

  /* ================= 公开项目（不含内部项目） ================= */
  ['GET', '/api/v2/public-projects/export', async (ctx) => {
    const g = readGuard();
    if (g) return { status: g.status, body: g };
    const { columns, rows, meta } = projects.publicProjectExport(ctx.query);
    return exportResponse(ctx, { dataset: '公开项目库', fileBase: 'public_projects', format: fmt(ctx.query), columns, rows, meta, filters: ctx.query });
  }],

  ['GET', '/api/v2/public-projects', async (ctx) => {
    const g = readGuard();
    if (g) return { status: g.status, body: g };
    const out = projects.listPublicProjects(ctx.query);
    return { ...out, rows: withSummaries('public_project', out.rows || [], { overlay: true }).map((p) => withSourceDisplay(p, ['official_url', 'design_doc_url'])) };
  }],

  ['GET', '/api/v2/public-projects/:id', async (ctx) => {
    const g = readGuard();
    if (g) return { status: g.status, body: g };
    const out = projects.getPublicProjectDetail(ctx.params.id);
    if (!out) return { status: 404, body: { error: '公开项目不存在' } };
    const key = out.project?.id || ctx.params.id;
    const row = maint.mergeOverlay('public_project', { id: key, ...(out.project || {}) });
    return {
      ...out,
      project: withSourceDisplay(summary.attachSummary('public_project', row), ['official_url', 'design_doc_url']),
    };
  }],

  ['GET', '/api/v2/public-projects/:id/verify', async (ctx) => {
    const g = readGuard();
    if (g) return { status: g.status, body: g };
    return {
      latest: verify.listVerifications({ object_type: 'public_project', object_id: ctx.params.id, limit: 5 }),
      states: Object.values(verify.VERIFY_RESULTS),
    };
  }],

  /* ================= 研报与行业动态（新增模块） ================= */
  ['GET', '/api/v2/content', async (ctx) => {
    const g = readGuard();
    if (g) return { status: g.status, body: g };
    const types = ctx.query.content_type ? String(ctx.query.content_type).split(',').filter(Boolean) : null;
    const categories = ctx.query.source_category ? String(ctx.query.source_category).split(',').filter(Boolean) : null;
    const vs = ctx.query.verification_status ? String(ctx.query.verification_status).split(',').filter(Boolean) : null;
    const out = content.listContentItems({
      content_type: types, source_category: categories, verification_status: vs,
      publisher: ctx.query.publisher || null, industry: ctx.query.industry || null,
      methodology_id: ctx.query.methodology_id || null,
      from: ctx.query.from || null, to: ctx.query.to || null, q: ctx.query.q || null,
      order: ctx.query.order || null,
      limit: Number(ctx.query.limit) || 60, offset: Number(ctx.query.offset) || 0,
    });
    // 公开列表以**来源**为主展示：官方信息 / 实际发布机构 / 来源未标注（核验数据保留后台）
    return {
      ...out,
      items: withSummaries('content_item', out.items || [], { overlay: true }).map((c) => withSourceDisplay(c, ['source_url'])),
    };
  }],

  ['GET', '/api/v2/content/stats', async () => {
    const g = readGuard();
    if (g) return { status: g.status, body: g };
    return content.contentStatus();
  }],

  ['GET', '/api/v2/content/export', async (ctx) => {
    const g = readGuard();
    if (g) return { status: g.status, body: g };
    const { items } = content.listContentItems({ ...ctx.query, limit: 500 });
    return exportResponse(ctx, {
      dataset: '研报与行业动态',
      fileBase: 'content_library',
      format: fmt(ctx.query),
      filters: ctx.query,
      columns: [
        { key: 'published_at', label: '发布日期' },
        { key: 'content_type_label', label: '类型' },
        { key: 'title', label: '标题' },
        { key: 'publisher', label: '发布机构' },
        { key: 'author', label: '作者' },
        { key: 'source_category_label', label: '来源类别' },
        { key: 'authority_tier_label', label: '可信度分层', definition: '官方事实/机构分析/媒体报道/企业主张/未判定' },
        { key: 'verification_status', label: '核验状态', definition: 'verified/insufficient/conflict/unavailable' },
        { key: 'body_availability', label: '正文可获得性', definition: 'full_text/partial/abstract_only/metadata_only' },
        { key: 'source_url', label: '来源 URL' },
        { key: 'summary', label: '摘要' },
      ],
      rows: items,
      meta: {
        数据截至: content.contentStats().latest_published_at || '—',
        来源: '公开搜索 API + 网页抓取连接自动采集',
        口径:
          '不含演示条目与转载副本；「核验状态」为模型与规则的一致性检查结论，不代表独立审计。' +
          '「仅有摘要」条目未获取公开全文。',
      },
    });
  }],

  ['GET', '/api/v2/content/:id', async (ctx) => {
    const g = readGuard();
    if (g) return { status: g.status, body: g };
    const out = content.getContentDetail(ctx.params.id);
    if (!out) return { status: 404, body: { error: '内容条目不存在' } };
    // 公开详情以来源为主；核验明细仍在后台「自动核验策略 / 核验记录」中可查
    return {
      ...out,
      item: withSourceDisplay(summary.attachSummary('content_item', maint.mergeOverlay('content_item', out.item)), ['source_url']),
    };
  }],

  ['POST', '/api/v2/content/:id/verify', async (ctx) => {
    const g = writeGuard(ctx);
    if (g) return { status: g.status, body: g };
    const denied = requireRole(ctx.user, ['admin', 'researcher'], '触发自动核验');
    if (denied) return { status: denied.status, body: denied };
    const out = await verify.verifyContentItem(ctx.params.id, {
      actor: ctx.user?.name || 'unknown',
      force: (ctx.body || {}).force === true,
    });
    return envelope(out);
  }],

  ['DELETE', '/api/v2/content/:id', async (ctx) => {
    const g = writeGuard(ctx);
    if (g) return { status: g.status, body: g };
    return envelope(content.deleteContent(ctx.user, ctx.params.id));
  }],

  ['POST', '/api/v2/content/collect', async (ctx) => {
    const g = writeGuard(ctx);
    if (g) return { status: g.status, body: g };
    const denied = requireRole(ctx.user, ['admin', 'researcher'], '执行公开内容采集');
    if (denied) return { status: denied.status, body: denied };
    const b = ctx.body || {};
    const out = await content.collectFromSearch({
      actor: ctx.user?.name || 'unknown',
      searchProviderId: b.search_provider_id || null,
      groups: Array.isArray(b.groups) ? b.groups : null,
      categories: Array.isArray(b.categories) ? b.categories : null,
      windowDays: Number(b.window_days) || 7,
      countPerQuery: Number(b.count_per_query) || 8,
      maxQueries: Number(b.max_queries) || 12,
      maxItems: Number(b.max_items) || 40,
      fetchBody: b.fetch_body !== false,
      verify: b.verify !== false,
    });
    return out;
  }],

  ['POST', '/api/v2/content/collect-seeds', async (ctx) => {
    const g = writeGuard(ctx);
    if (g) return { status: g.status, body: g };
    const denied = requireRole(ctx.user, ['admin', 'researcher'], '采集种子来源');
    if (denied) return { status: denied.status, body: denied };
    const b = ctx.body || {};
    return content.collectFromSeedSources({
      actor: ctx.user?.name || 'unknown',
      seedIds: Array.isArray(b.seed_ids) ? b.seed_ids : null,
      fetchLimit: Number(b.fetch_limit) || 6,
      verify: b.verify === true,
    });
  }],

  ['POST', '/api/v2/content/probe-sources', async (ctx) => {
    const g = writeGuard(ctx);
    if (g) return { status: g.status, body: g };
    const denied = requireRole(ctx.user, ['admin', 'researcher'], '验证种子来源可用性');
    if (denied) return { status: denied.status, body: denied };
    return content.verifySeedSources({ actor: ctx.user?.name || 'unknown' });
  }],

  /* ================= 交易信息 ================= */
  ['GET', '/api/v2/trade/overview', async (ctx) => {
    const g = readGuard();
    if (g) return { status: g.status, body: g };
    return trade.tradeOverview({ range_days: Number(ctx.query.range_days) || 365 });
  }],

  ['GET', '/api/v2/trade/daily', async (ctx) => {
    const g = readGuard();
    if (g) return { status: g.status, body: g };
    return trade.listTradeDaily(ctx.query);
  }],

  ['GET', '/api/v2/trade/summary', async (ctx) => {
    const g = readGuard();
    if (g) return { status: g.status, body: g };
    return trade.tradeSummary({
      from: ctx.query.from || null,
      to: ctx.query.to || null,
      granularity: ctx.query.granularity || 'month',
      include_pending: ctx.query.include_pending !== 'false',
    });
  }],

  ['GET', '/api/v2/trade/calendar', async (ctx) => {
    const g = readGuard();
    if (g) return { status: g.status, body: g };
    return trade.tradeCalendar(ctx.query);
  }],

  ['GET', '/api/v2/trade/dimensions', async (ctx) => {
    const g = readGuard();
    if (g) return { status: g.status, body: g };
    return trade.tradeDimensions({ from: ctx.query.from, to: ctx.query.to });
  }],

  ['GET', '/api/v2/trade/cumulative', async () => {
    const g = readGuard();
    if (g) return { status: g.status, body: g };
    return trade.tradeCumulative();
  }],

  ['GET', '/api/v2/trade/revisions', async (ctx) => {
    const g = readGuard();
    if (g) return { status: g.status, body: g };
    return { revisions: trade.listTradeRevisions({ trade_daily_id: ctx.query.trade_daily_id || null, limit: Number(ctx.query.limit) || 200 }) };
  }],

  ['GET', '/api/v2/trade/checks', async (ctx) => {
    const g = readGuard();
    if (g) return { status: g.status, body: g };
    return {
      cumulative: trade.tradeCumulative(),
      revisions: trade.listTradeRevisions({ limit: Number(ctx.query.limit) || 50 }),
      note: '确定性量价/累计差分检查结果：只做自动标注，不产生人工核对任务。',
    };
  }],

  ['GET', '/api/v2/trade/export', async (ctx) => {
    const g = readGuard();
    if (g) return { status: g.status, body: g };
    const which = ctx.query.dataset === 'summary' ? 'summary' : 'daily';
    if (which === 'summary') {
      const { columns, rows, meta } = trade.tradeSummaryExport({
        from: ctx.query.from, to: ctx.query.to, granularity: ctx.query.granularity || 'month',
      });
      return exportResponse(ctx, { dataset: '交易行情汇总', fileBase: 'trade_summary', format: fmt(ctx.query), columns, rows, meta, filters: ctx.query });
    }
    const { columns, rows, meta } = trade.tradeDailyExport(ctx.query);
    return exportResponse(ctx, { dataset: '交易行情明细', fileBase: 'trade_daily', format: fmt(ctx.query), columns, rows, meta, filters: ctx.query });
  }],

  ['POST', '/api/v2/trade/collect', async (ctx) => {
    const g = writeGuard(ctx);
    if (g) return { status: g.status, body: g };
    const denied = requireRole(ctx.user, ['admin', 'researcher'], '采集官方行情');
    if (denied) return { status: denied.status, body: denied };
    const body = ctx.body || {};
    const out = await collect.collectTradeQuotes({
      actor: ctx.user?.name || 'unknown',
      onlyNew: body.onlyNew !== false,
      limit: Number(body.limit) || 40,
      withDimension: body.withDimension !== false,
      dates: Array.isArray(body.dates) ? body.dates : null,
    });
    return out;
  }],

  ['POST', '/api/v2/trade/checks/run', async (ctx) => {
    const g = writeGuard(ctx);
    if (g) return { status: g.status, body: g };
    const denied = requireRole(ctx.user, ['admin', 'researcher'], '执行交易数据核对');
    if (denied) return { status: denied.status, body: denied };
    return reconcile.runTradeChecks({ actor: ctx.user?.name || 'unknown' });
  }],

  /* ================= 减排粗估（简表为主要入口） ================= */
  // 旧「从项目档案测算」链路的放行总览与可测算项目清单依赖内部项目档案与领域签字，
  // 属已取消业务：新版明确返回 410，而不是保留一个会 500/403 的半成品入口（docs/22 第 6 条）。
  ['GET', '/api/v2/measure/readiness', retiredHandler],
  ['GET', '/api/v2/measure/targets', retiredHandler],

  // 因子登记表：公开技术参考（不依赖任何人工放行），保留只读
  ['GET', '/api/v2/measure/factors', async (ctx) => {
    const g = readGuard();
    if (g) return { status: g.status, body: g };
    return measure.factorRegistry(ctx.query.methodology_id || null);
  }],

  /* ================= 公开数据导入（仅公开模板） ================= */
  ['POST', '/api/v2/import/:template', async (ctx) => {
    const g = writeGuard(ctx);
    if (g) return { status: g.status, body: g };
    const denied = requireRole(ctx.user, ['admin', 'researcher'], '导入公开数据');
    if (denied) return { status: denied.status, body: denied };
    const key = ctx.params.template;
    if (key === 'internal-project') return RETIRED; // 内部项目模板已随内部项目模块下线
    const t = getTemplate(key);
    if (!t) return { status: 404, body: { error: `未找到导入模板：${key}` } };
    const body = ctx.body || {};
    let rows = Array.isArray(body.rows) ? body.rows : null;
    let parse = null;
    if (!rows) {
      if (!body.csv) return { status: 400, body: { error: '请求体需包含 csv（文本）或 rows（数组）' } };
      parse = rowsFromCsv(key, body.csv);
      if (parse.errors.length) {
        return { status: 400, body: { error: 'CSV 解析失败', errors: parse.errors, unknown_headers: parse.unknown_headers } };
      }
      rows = parse.rows;
    }
    if (!rows.length) return { status: 400, body: { error: '没有可导入的数据行' } };
    if (key === 'trade-daily') {
      const out = trade.importTradeRows(ctx.user, rows, { sourceKind: body.source_kind || 'manual_csv' });
      return {
        status: 201,
        body: { ...out, parsed: parse ? { matched_columns: parse.matched_columns, unknown_headers: parse.unknown_headers } : null },
      };
    }
    if (key === 'public-project') {
      return { status: 201, body: projects.importPublicProjects(ctx.user, rows) };
    }
    return { status: 400, body: { error: `模板 ${key} 不支持通过该接口导入` } };
  }],

  /* ================= 后台管理 ================= */
  ['GET', '/api/v2/admin/status', async () => {
    const g = readGuard();
    if (g) return { status: g.status, body: g };
    return admin.systemStatus();
  }],

  ['GET', '/api/v2/admin/secret-key', async (ctx) => {
    const g = readGuard();
    if (g) return { status: g.status, body: g };
    const denied = requireRole(ctx.user, ['admin'], '查看主密钥状态');
    if (denied) return { status: denied.status, body: denied };
    return { secret_key: admin.secretKeyStatus() };
  }],

  ['POST', '/api/v2/admin/secret-key/init', async (ctx) => {
    const g = writeGuard(ctx);
    if (g) return { status: g.status, body: g };
    return envelope(admin.initSecretKey(ctx.user));
  }],

  ['GET', '/api/v2/admin/datasources', async (ctx) => {
    const g = readGuard();
    if (g) return { status: g.status, body: g };
    const denied = requireRole(ctx.user, ['admin', 'researcher'], '查看数据源');
    if (denied) return { status: denied.status, body: denied };
    return { datasources: admin.listDatasources(), source_kinds: admin.SOURCE_KINDS, parsers: admin.PARSERS };
  }],

  ['POST', '/api/v2/admin/datasources', async (ctx) => {
    const g = writeGuard(ctx);
    if (g) return { status: g.status, body: g };
    return envelope(admin.upsertDatasource(ctx.user, ctx.body || {}));
  }],

  ['POST', '/api/v2/admin/datasources/:id/test', async (ctx) => {
    const g = writeGuard(ctx);
    if (g) return { status: g.status, body: g };
    return admin.testDatasource(ctx.user, ctx.params.id);
  }],

  ['POST', '/api/v2/admin/datasources/:id/pause', async (ctx) => {
    const g = writeGuard(ctx);
    if (g) return { status: g.status, body: g };
    return envelope(admin.pauseDatasource(ctx.user, ctx.params.id, ctx.body || {}));
  }],

  ['GET', '/api/v2/admin/datasources/:id/rollbacks', async (ctx) => {
    const g = readGuard();
    if (g) return { status: g.status, body: g };
    const denied = requireRole(ctx.user, ['admin'], '查看回滚点');
    if (denied) return { status: denied.status, body: denied };
    return { rollbacks: admin.listDatasourceRollbacks(ctx.params.id) };
  }],

  ['POST', '/api/v2/admin/rollbacks/:id/restore', async (ctx) => {
    const g = writeGuard(ctx);
    if (g) return { status: g.status, body: g };
    return envelope(admin.rollbackDatasource(ctx.user, ctx.params.id));
  }],

  /* ---- 搜索服务配置（Tavily / Firecrawl Search / 自建网关） ---- */
  ['GET', '/api/v2/admin/search-providers', async (ctx) => {
    const g = readGuard();
    if (g) return { status: g.status, body: g };
    const denied = requireRole(ctx.user, ['admin', 'researcher'], '查看搜索服务配置');
    if (denied) return { status: denied.status, body: denied };
    return { providers: search.listSearchProviders(), presets: search.SEARCH_KINDS, status: search.searchStatus() };
  }],

  ['POST', '/api/v2/admin/search-providers', async (ctx) => {
    const g = writeGuard(ctx);
    if (g) return { status: g.status, body: g };
    return envelope(search.upsertSearchProvider(ctx.user, ctx.body || {}));
  }],

  ['POST', '/api/v2/admin/search-providers/:id/test', async (ctx) => {
    const g = writeGuard(ctx);
    if (g) return { status: g.status, body: g };
    return envelope(await search.testSearchProvider(ctx.user, ctx.params.id));
  }],

  ['POST', '/api/v2/admin/search-providers/:id/pause', async (ctx) => {
    const g = writeGuard(ctx);
    if (g) return { status: g.status, body: g };
    return envelope(search.pauseSearchProvider(ctx.user, ctx.params.id, ctx.body || {}));
  }],

  /* ---- 网页抓取连接（Firecrawl Scrape / 远端 MCP） ---- */
  ['GET', '/api/v2/admin/fetch-connections', async (ctx) => {
    const g = readGuard();
    if (g) return { status: g.status, body: g };
    const denied = requireRole(ctx.user, ['admin', 'researcher'], '查看抓取连接配置');
    if (denied) return { status: denied.status, body: denied };
    return { connections: fetchSvc.listFetchConnections(), presets: fetchSvc.FETCH_KINDS, status: fetchSvc.fetchStatus() };
  }],

  ['POST', '/api/v2/admin/fetch-connections', async (ctx) => {
    const g = writeGuard(ctx);
    if (g) return { status: g.status, body: g };
    return envelope(fetchSvc.upsertFetchConnection(ctx.user, ctx.body || {}));
  }],

  ['POST', '/api/v2/admin/fetch-connections/:id/test', async (ctx) => {
    const g = writeGuard(ctx);
    if (g) return { status: g.status, body: g };
    // probe_scrape=true 时，未配置凭据的连接会对官方 keyless 端点主动尝试**一次**抓取；
    // 默认只做 initialize + tools/list（不反复无密钥请求，也不伪造抓取成功）。
    return envelope(await fetchSvc.testFetchConnection(ctx.user, ctx.params.id, {
      probe_scrape: (ctx.body || {}).probe_scrape === true,
    }));
  }],

  ['POST', '/api/v2/admin/fetch-connections/:id/pause', async (ctx) => {
    const g = writeGuard(ctx);
    if (g) return { status: g.status, body: g };
    return envelope(fetchSvc.pauseFetchConnection(ctx.user, ctx.params.id, ctx.body || {}));
  }],

  /* ---- 自动核验策略（非人工审批） ---- */
  ['GET', '/api/v2/admin/verify-config', async (ctx) => {
    const g = readGuard();
    if (g) return { status: g.status, body: g };
    const denied = requireRole(ctx.user, ['admin'], '查看自动核验策略');
    if (denied) return { status: denied.status, body: denied };
    return {
      config: verify.verifyConfig(),
      stats: verify.verificationStats(),
      // 全部内置规则（内容 / 政策 / 方法学 / 公开项目）：统一模型核验的规则面必须可见
      rules: verify.listRules({}),
      states: Object.values(verify.VERIFY_RESULTS),
      defaults: verify.DEFAULT_CONFIG,
    };
  }],

  ['POST', '/api/v2/admin/verify-config', async (ctx) => {
    const g = writeGuard(ctx);
    if (g) return { status: g.status, body: g };
    return envelope(verify.saveVerifyConfig(ctx.user, ctx.body || {}));
  }],

  ['POST', '/api/v2/admin/verify-rules/:id', async (ctx) => {
    const g = writeGuard(ctx);
    if (g) return { status: g.status, body: g };
    return envelope(verify.updateRule(ctx.user, ctx.params.id, ctx.body || {}));
  }],

  ['POST', '/api/v2/admin/verify/run', async (ctx) => {
    const g = writeGuard(ctx);
    if (g) return { status: g.status, body: g };
    const denied = requireRole(ctx.user, ['admin', 'researcher'], '执行自动核验');
    if (denied) return { status: denied.status, body: denied };
    // 统一核验：按策略 scopes 覆盖 研报与动态 / 政策 / 方法学 / 公开项目，
    // 全部使用同一四态与同一缓存键（策略+模型+证据）；unavailable 不缓存，可自动重试。
    return verify.verifyAllBatch({
      actor: ctx.user?.name || 'unknown',
      limitPerScope: Number(ctx.body?.limit) || null,
    });
  }],

  ['GET', '/api/v2/admin/verifications', async (ctx) => {
    const g = readGuard();
    if (g) return { status: g.status, body: g };
    const denied = requireRole(ctx.user, ['admin', 'researcher'], '查看核验记录');
    if (denied) return { status: denied.status, body: denied };
    return {
      verifications: verify.listVerifications({
        object_type: ctx.query.object_type || null,
        object_id: ctx.query.object_id || null,
        result: ctx.query.result || null,
        limit: Number(ctx.query.limit) || 200,
      }),
      stats: verify.verificationStats(),
    };
  }],

  /* ---- 模型配置 ---- */
  ['GET', '/api/v2/admin/llm', async (ctx) => {
    const g = readGuard();
    if (g) return { status: g.status, body: g };
    const denied = requireRole(ctx.user, ['admin'], '查看模型配置');
    if (denied) return { status: denied.status, body: denied };
    return { providers: admin.listLlmProviders(), purposes: admin.LLM_PURPOSES, status: admin.llmStatus() };
  }],

  ['POST', '/api/v2/admin/llm', async (ctx) => {
    const g = writeGuard(ctx);
    if (g) return { status: g.status, body: g };
    return envelope(admin.upsertLlmProvider(ctx.user, ctx.body || {}));
  }],

  ['POST', '/api/v2/admin/llm/:id/test', async (ctx) => {
    const g = writeGuard(ctx);
    if (g) return { status: g.status, body: g };
    return envelope(await admin.testLlmProvider(ctx.user, ctx.params.id));
  }],

  /* ---- DeepSeek 能力（docs/54）：引用、预算、测试与观测 ---- */
  ['GET', '/api/v2/admin/deepseek', async (ctx) => {
    const g = readGuard();
    if (g) return { status: g.status, body: g };
    const denied = requireRole(ctx.user, ['admin'], '查看 DeepSeek 能力');
    if (denied) return { status: denied.status, body: denied };
    return {
      ...deepseek.deepseekOverview(),
      fallback: deepseekFallback.fallbackStatus(),
      search: search.searchStatus(),
      fetch: fetchSvc.fetchStatus(),
    };
  }],

  ['POST', '/api/v2/admin/deepseek/capabilities/:kind', async (ctx) => {
    const g = writeGuard(ctx);
    if (g) return { status: g.status, body: g };
    const denied = requireRole(ctx.user, ['admin'], '配置 DeepSeek 能力');
    if (denied) return { status: denied.status, body: denied };
    return envelope(deepseek.saveDeepSeekCapability(ctx.user, ctx.params.kind, ctx.body || {}));
  }],

  ['POST', '/api/v2/admin/deepseek/test', async (ctx) => {
    const g = writeGuard(ctx);
    if (g) return { status: g.status, body: g };
    const denied = requireRole(ctx.user, ['admin'], '测试 DeepSeek 能力');
    if (denied) return { status: denied.status, body: denied };
    const kind = String(ctx.body?.kind || 'chat_tools');
    if (kind === 'search' || kind === 'fetch') {
      const row = kind === 'search'
        ? dbGet("SELECT id FROM search_provider WHERE provider_kind='deepseek_search' AND archived=0 ORDER BY is_fallback, created_at LIMIT 1")
        : dbGet("SELECT id FROM web_fetch_connection WHERE conn_kind='deepseek_fetch' AND archived=0 ORDER BY is_fallback, created_at LIMIT 1");
      if (!row) return { status: 404, body: { error: `尚无 DeepSeek ${kind === 'search' ? 'Search' : 'Fetch'} 连接，请先在「采集连接」页创建并引用官方模型` } };
      const tested = kind === 'search'
        ? await search.testSearchProvider(ctx.user, row.id)
        : await fetchSvc.testFetchConnection(ctx.user, row.id);
      // Search/Fetch 本身是真实能力测试：真实请求对应官方接口并验证返回结构。
      return envelope({
        ...tested,
        test_scope: 'capability',
        capability_verified: tested?.ok === true,
        test_label: '真实能力测试',
        note: kind === 'search'
          ? '真实调用 DeepSeek Search 并适配返回结构；空结果不算能力失败，但不会伪造正文。'
          : '真实调用 DeepSeek Fetch 并验证 title/content；空正文不按成功有结果计费。',
      });
    }
    const out = await deepseek.testDeepSeekBinding(ctx.user, kind, { deadlineAt: Date.now() + 45000 });
    return envelope(out);
  }],

  ['POST', '/api/v2/admin/deepseek/files/cleanup', async (ctx) => {
    const g = writeGuard(ctx);
    if (g) return { status: g.status, body: g };
    const denied = requireRole(ctx.user, ['admin'], '清理过期的 DeepSeek 图片缓存');
    if (denied) return { status: denied.status, body: denied };
    const out = await deepseek.cleanupExpiredFiles({ limit: Number(ctx.body?.limit) || 10 });
    return { ...out, cache: deepseek.fileCachePublic(20) };
  }],

  /* ---- 用户管理（保留） ---- */
  ['GET', '/api/v2/admin/users', async (ctx) => {
    const g = readGuard();
    if (g) return { status: g.status, body: g };
    const denied = requireRole(ctx.user, ['admin'], '查看用户');
    if (denied) return { status: denied.status, body: denied };
    return { users: admin.listUsers(), roles: admin.ROLES, teams: admin.listTeams() };
  }],

  ['POST', '/api/v2/admin/users', async (ctx) => {
    const g = writeGuard(ctx);
    if (g) return { status: g.status, body: g };
    return envelope(admin.upsertUser(ctx.user, ctx.body || {}));
  }],

  ['POST', '/api/v2/admin/users/:id/password', async (ctx) => {
    const g = writeGuard(ctx);
    if (g) return { status: g.status, body: g };
    return envelope(admin.resetUserPassword(ctx.user, ctx.params.id, ctx.body || {}));
  }],

  ['GET', '/api/v2/admin/logins', async (ctx) => {
    const g = readGuard();
    if (g) return { status: g.status, body: g };
    const denied = requireRole(ctx.user, ['admin'], '查看登录记录');
    if (denied) return { status: denied.status, body: denied };
    return { logins: admin.listLoginLogs({ limit: Number(ctx.query.limit) || 200, result: ctx.query.result || null }) };
  }],

  ['GET', '/api/v2/admin/audit', async (ctx) => {
    const g = readGuard();
    if (g) return { status: g.status, body: g };
    const denied = requireRole(ctx.user, ['admin'], '查看操作审计');
    if (denied) return { status: denied.status, body: denied };
    return {
      audit: admin.listAuditLogs({
        limit: Number(ctx.query.limit) || 200,
        action: ctx.query.action || null,
        object_type: ctx.query.object_type || null,
        actor: ctx.query.actor || null,
      }),
    };
  }],

  ['GET', '/api/v2/admin/exports', async (ctx) => {
    const g = readGuard();
    if (g) return { status: g.status, body: g };
    const denied = requireRole(ctx.user, ['admin'], '查看导出审计');
    if (denied) return { status: denied.status, body: denied };
    return { exports: admin.listExportLogs({ limit: Number(ctx.query.limit) || 200 }) };
  }],

  ['GET', '/api/v2/admin/reconciliations', async (ctx) => {
    const g = readGuard();
    if (g) return { status: g.status, body: g };
    const items = reconcile.listReconciliation({
        status: ctx.query.status || 'open',
        dataset: ctx.query.dataset || null,
        severity: ctx.query.severity || null,
        limit: Number(ctx.query.limit) || 200,
      });
    const aiReviews = reconcileAi.listReconciliationAiReviews(items.map((item) => item.id));
    return {
      items: items.map((item) => ({ ...item, ai_review: aiReviews[item.id] || null })),
      stats: reconcile.reconciliationStats(),
      note: '差异只作为自动运行状态展示与检索，不产生人工核对任务，也不会自动覆盖官方数值。',
    };
  }],

  ['POST', '/api/v2/admin/checks/run', async (ctx) => {
    const g = writeGuard(ctx);
    if (g) return { status: g.status, body: g };
    const denied = requireRole(ctx.user, ['admin', 'researcher'], '执行数据核对');
    if (denied) return { status: denied.status, body: denied };
    const body = ctx.body || {};
    const actor = ctx.user?.name || 'unknown';
    const checks = body.dataset === 'trade' ? reconcile.runTradeChecks({ actor })
      : body.dataset === 'project' ? reconcile.runProjectChecks({ actor })
      : body.dataset === 'policy' ? reconcile.runPolicyChecks({ actor })
      : body.dataset === 'factor' ? reconcile.runFactorChecks({ actor })
      : reconcile.runAllChecks({ actor });
    if (body.ai === false) return checks;
    const ai = await reconcileAi.calibrateOpenIssues({ actor, limit: Number(body.limit) || 60, force: !!body.force });
    return { ...checks, ai };
  }],

  ['GET', '/api/v2/admin/gaps', async (ctx) => {
    const g = readGuard();
    if (g) return { status: g.status, body: g };
    return { gaps: admin.listGaps({ status: ctx.query.status || 'open' }) };
  }],

  ['GET', '/api/v2/admin/document-gaps', async (ctx) => {
    const g = readGuard();
    if (g) return { status: g.status, body: g };
    const denied = requireRole(ctx.user, ['admin'], '查看原件补充入口');
    if (denied) return { status: denied.status, body: denied };
    return documentUpload.listDocumentGaps();
  }],

  ['POST', '/api/v2/admin/document-upload', async (ctx) => {
    const g = writeGuard(ctx);
    if (g) return { status: g.status, body: g };
    const denied = requireRole(ctx.user, ['admin'], '上传公开原件');
    if (denied) return { status: denied.status, body: denied };
    return envelope(await documentUpload.uploadDocument(ctx.user, ctx.body || {}));
  }],

  ['POST', '/api/v2/admin/gaps/:id', async (ctx) => {
    const g = writeGuard(ctx);
    if (g) return { status: g.status, body: g };
    return envelope(admin.updateGap(ctx.user, ctx.params.id, ctx.body || {}));
  }],

  ['GET', '/api/v2/admin/metrics', async (ctx) => {
    const g = readGuard();
    if (g) return { status: g.status, body: g };
    return { metrics: admin.listMetricDefinitions(ctx.query.module || null) };
  }],

  ['POST', '/api/v2/admin/metrics/:key', async (ctx) => {
    const g = writeGuard(ctx);
    if (g) return { status: g.status, body: g };
    return envelope(admin.updateMetricDefinition(ctx.user, ctx.params.key, ctx.body || {}));
  }],

  ['GET', '/api/v2/admin/jobs', async (ctx) => {
    const g = readGuard();
    if (g) return { status: g.status, body: g };
    return {
      jobs: collect.listJobs({ limit: Number(ctx.query.limit) || 50, job_key: ctx.query.job_key || null }),
      cursors: collect.listDatasetCursors(),
    };
  }],

  ['GET', '/api/v2/admin/jobs/:id', async (ctx) => {
    const g = readGuard();
    if (g) return { status: g.status, body: g };
    const job = collect.getJob(ctx.params.id);
    return job ? job : { status: 404, body: { error: '任务不存在' } };
  }],

  ['GET', '/api/v2/admin/dataset-cursors', async () => {
    const g = readGuard();
    if (g) return { status: g.status, body: g };
    return {
      cursors: collect.listDatasetCursors(),
      note: '每个数据集记录最近成功时间与失败原因；增量更新按窗口幂等。',
    };
  }],

  ['POST', '/api/v2/admin/daily', async (ctx) => {
    const g = writeGuard(ctx);
    if (g) return { status: g.status, body: g };
    const denied = requireRole(ctx.user, ['admin', 'researcher'], '执行每日更新');
    if (denied) return { status: denied.status, body: denied };
    const body = ctx.body || {};
    const out = await collect.runDailyJob({
      actor: ctx.user?.name || 'unknown',
      trigger: 'manual',
      datasets: Array.isArray(body.datasets) && body.datasets.length ? body.datasets : collect.DAILY_DATASETS,
      tradeLimit: Number(body.tradeLimit) || 40,
      onlyNew: body.onlyNew !== false,
      withDimension: body.withDimension !== false,
      jobKey: body.jobKey || 'daily_all',
      contentMaxItems: Number(body.contentMaxItems) || 30,
    });
    return { status: 200, body: out };
  }],

  ['GET', '/api/v2/admin/snapshots', async (ctx) => {
    const g = readGuard();
    if (g) return { status: g.status, body: g };
    const { all: allRows } = await import('./core/db.mjs');
    return {
      snapshots: allRows(
        `SELECT id, source_id, url, fetched_at, http_status, content_type, content_hash, content_bytes,
                parser_version, parse_quality, parse_note, error
         FROM source_snapshot ORDER BY fetched_at DESC LIMIT ?`,
        [Math.min(Number(ctx.query.limit) || 100, 500)]
      ),
      note: '原始网页/接口响应按 sha256 留痕；同 URL 同哈希不重复堆积，正文可在快照详情中查看。',
    };
  }],

  ['GET', '/api/v2/admin/snapshots/:id', async (ctx) => {
    const g = readGuard();
    if (g) return { status: g.status, body: g };
    const { get: getRow } = await import('./core/db.mjs');
    const snap = getRow('SELECT * FROM source_snapshot WHERE id = ?', [ctx.params.id]);
    if (!snap) return { status: 404, body: { error: '快照不存在' } };
    const denied = requireRole(ctx.user, ['admin', 'researcher'], '查看原始快照');
    if (denied) return { status: denied.status, body: denied };
    return { snapshot: snap };
  }],

  /* ================= 采集任务（手工触发单个连接器） ================= */
  ['POST', '/api/v2/collect/policy-patrol', async (ctx) => {
    const g = writeGuard(ctx);
    if (g) return { status: g.status, body: g };
    const denied = requireRole(ctx.user, ['admin', 'researcher'], '巡检官方政策页面');
    if (denied) return { status: denied.status, body: denied };
    const out = await collect.patrolPolicyDocuments({ actor: ctx.user?.name || 'unknown' });
    return out;
  }],

  ['POST', '/api/v2/collect/policy-discover', async (ctx) => {
    const g = writeGuard(ctx);
    if (g) return { status: g.status, body: g };
    const denied = requireRole(ctx.user, ['admin', 'researcher'], '巡检官方公告栏目');
    if (denied) return { status: denied.status, body: denied };
    const out = await collect.discoverPolicyNotices({ actor: ctx.user?.name || 'unknown' });
    return out;
  }],

  /* ================= 已停用的旧业务入口（明确 410） ================= */
  // 内部项目库 / 项目创建 / 项目人工核对 / 内部与公开项目关联
  ['GET', '/api/v2/internal-projects', retiredHandler],
  ['GET', '/api/v2/internal-projects/export', retiredHandler],
  ['GET', '/api/v2/internal-projects/:id', retiredHandler],
  ['POST', '/api/v2/internal-projects', retiredHandler],
  ['PATCH', '/api/v2/internal-projects/:id', retiredHandler],
  ['POST', '/api/v2/internal-projects/sync', retiredHandler],
  ['POST', '/api/v2/internal-projects/:id/review', retiredHandler],
  ['POST', '/api/v2/project-links', retiredHandler],
  ['POST', '/api/v2/public-projects/:id/confirm', retiredHandler],
  ['POST', '/api/v2/policies/:id/confirm', retiredHandler],
  ['POST', '/api/v2/policy-changes/:id/confirm', retiredHandler],
  // 行情人工核对
  ['POST', '/api/v2/trade/:id/verify', retiredHandler],
  ['POST', '/api/v2/trade/verify-bulk', retiredHandler],
  ['POST', '/api/v2/trade/amend/:id', retiredHandler],
  ['POST', '/api/v2/trade/calendar/:date', retiredHandler],
  // 审核任务 / 差异人工处理
  ['GET', '/api/v2/admin/reviews', retiredHandler],
  ['POST', '/api/v2/admin/reviews/:id/decide', retiredHandler],
  ['POST', '/api/v2/admin/reconciliations/:id/resolve', retiredHandler],
  // 内部项目导入模板与旧测算链路
  ['POST', '/api/v2/import/internal-project', retiredHandler],
  ['POST', '/api/v2/measure/run', retiredHandler],
  ['GET', '/api/v2/measure/runs', retiredHandler],
  ['GET', '/api/v2/measure/runs/:id', retiredHandler],
  ['GET', '/api/v2/measure/runs/:id/export', retiredHandler],
  ['POST', '/api/v2/measure/precheck', retiredHandler],
  ['GET', '/api/v2/measure/precheck/:id', retiredHandler],
  ['GET', '/api/v2/measure/form-fields', retiredHandler],
  ['GET', '/api/v2/measure/prefill/:publicProjectId', retiredHandler],
  // 团队项目授权（只服务内部项目）
  ['POST', '/api/v2/admin/teams', retiredHandler],
  ['POST', '/api/v2/admin/grants', retiredHandler],
  ['DELETE', '/api/v2/admin/grants/:id', retiredHandler],
  // 旧 AI 复核（已由自动核验取代）
  ['GET', '/api/v2/admin/ai-review', retiredHandler],
  ['POST', '/api/v2/admin/ai-review', retiredHandler],
  ['POST', '/api/v2/admin/ai-review/run', retiredHandler],
];

/**
 * 对外路由表。
 * 装配规则：`/api/v2/admin/*` 下的**在役**路由统一套上后台管理角色守卫
 * （普通用户 403）；已停用路由保持「对任何角色都 410」，不参与角色判定。
 * CEA 路由（src/routes-cea.mjs）在同一张表内装配，共用同一套守卫与信封规约。
 */
export const V2_ROUTES = [...RAW_ROUTES, ...CEA_RAW_ROUTES, ...OCR_RAW_ROUTES, ...ACCOUNTING_RAW_ROUTES, ...PLATFORM_RAW_ROUTES].map(([method, pattern, handler]) =>
  (pattern.startsWith('/api/v2/admin/') || pattern.startsWith('/api/v2/accounting/admin/')) && handler !== retiredHandler
    ? [method, pattern, withAdminAreaGuard(handler)]
    : [method, pattern, handler]
);

/** 占位（仅静态检查用；所有路由都使用真实 ctx.user 做权限判定） */
export default V2_ROUTES;
