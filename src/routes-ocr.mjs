/**
 * PDF 解析 / OCR 后台路由（docs/36 第 1、3、4、6 条）
 * ============================================================================
 * 全部位于 `/api/v2/admin/ocr/*`：
 *   · 未登录 → 由 server.mjs 统一 401；
 *   · 非 admin → 由 routes-v2.mjs 的 withAdminAreaGuard 统一 403（普通用户看不到本页签）。
 *
 * 返回纪律：
 *   · 配置接口只返回 `credential_configured` / 接口模式 / 配额限时 / 统计，
 *     **绝不返回 credential_cipher、api_key、secret_key、access_token**；
 *   · 文档解析返回的签名 URL 一律脱敏，不原样输出。
 */
import { writeGuard, readGuard } from './services/http-guard.mjs';
import { requireRole } from './services/project-svc.mjs';
import * as ocr from './services/baidu-ocr-svc.mjs';
import * as backfill from './services/ocr-backfill-svc.mjs';
import * as vision from './services/vision-svc.mjs';
import { PDF_TEXT_PARSER_VERSION, ocrRoot } from './services/pdf-parse-svc.mjs';

const admin = (ctx, what) => requireRole(ctx.user, ['admin'], what);

/** 统一剔除可能夹带的敏感键（防止上层对象展开时漏字段） */
const SENSITIVE_KEYS = new Set([
  'credential_cipher', 'api_key', 'secret_key', 'apikey', 'secretkey', 'secret',
  'access_token', 'accessToken', 'token', 'parse_result_url', 'authorization',
]);
function scrub(value, depth = 0) {
  if (depth > 6 || value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1));
  if (typeof value !== 'object') return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (SENSITIVE_KEYS.has(k) && typeof v === 'string' && v) { out[`${k}_redacted`] = true; continue; }
    out[k] = scrub(v, depth + 1);
  }
  return out;
}

export const OCR_RAW_ROUTES = [
  /* ---------------- 配置 ---------------- */
  ['GET', '/api/v2/admin/ocr/config', async () => {
    const out = ocr.baiduOcrPublicConfig();
    return {
      ...scrub(out),
      backfill: backfill.ocrBackfillConfig(),
      roots: backfill.restrictedRoots(),
      ocr_root: ocrRoot(),
      parser_version: PDF_TEXT_PARSER_VERSION,
      limits_note:
        '服务端硬上限：单批 5000—600000ms｜单条请求 3000—120000ms｜当日页数 1—20000｜当日文档 1—2000｜' +
        '单文档页数 1—500。经典接口 pdf_file 为 base64，原始 PDF 上限 4MB；超过则先用 pdfseparate 拆单页，拆不动就如实失败（不静默只处理第一页）。',
      modes: [
        { key: 'accurate_basic', label: '经典高精度（accurate_basic）', available: true, note: '本轮完整实现：单页识别、token 缓存、110/111 刷新重试一次。' },
        { key: 'doc_parser', label: '异步文档解析（doc_parser）', available: ocr.baiduOcrConfig().doc_parser_state === 'supported', note: ocr.baiduOcrConfig().doc_parser_note },
        { key: 'unsupported', label: '不启用（unsupported）', available: true, note: '显式关闭：配置页如实显示未支持，不伪实现。' },
      ],
    };
  }],

  ['POST', '/api/v2/admin/ocr/config', async (ctx) => {
    const g = writeGuard(ctx);
    if (g) return { status: g.status, body: g };
    const denied = admin(ctx, '配置 PDF 解析/OCR');
    if (denied) return { status: denied.status, body: denied };
    const body = ctx.body || {};
    const out = ocr.saveBaiduOcrConfig(ctx.user, body);
    if (out.error) return { status: out.status || 400, body: out };
    // 若同时带了补跑参数，一并保存
    if (body.backfill && typeof body.backfill === 'object') {
      const bf = backfill.saveOcrBackfillConfig(ctx.user, body.backfill);
      if (bf.error) return { status: bf.status || 400, body: bf };
      return { ...scrub(out), backfill: bf.config };
    }
    return scrub(out);
  }],

  /* ---------------- 真实连接测试 ---------------- */
  ['POST', '/api/v2/admin/ocr/test', async (ctx) => {
    const g = writeGuard(ctx);
    if (g) return { status: g.status, body: g };
    const denied = admin(ctx, '测试百度 OCR 连接');
    if (denied) return { status: denied.status, body: denied };
    const out = await ocr.testBaiduOcrConnection({ user: ctx.user, deadlineAt: Date.now() + 90000 });
    return scrub(out);
  }],

  /* ---------------- 能力探测（文档解析） ---------------- */
  ['POST', '/api/v2/admin/ocr/probe-parser', async (ctx) => {
    const g = writeGuard(ctx);
    if (g) return { status: g.status, body: g };
    const denied = admin(ctx, '探测文档解析能力');
    if (denied) return { status: denied.status, body: denied };
    const out = await ocr.probeDocParserCapability({
      actor: ctx.user?.name || 'admin', deadlineAt: Date.now() + 60000,
    });
    return scrub(out);
  }],

  /* ---------------- 状态 / 统计 / 缺口 ---------------- */
  ['GET', '/api/v2/admin/ocr/status', async () => scrub(backfill.ocrBackfillStatus())],

  ['GET', '/api/v2/admin/ocr/gaps', async (ctx) => {
    const conf = backfill.ocrBackfillConfig();
    const scan = backfill.scanOcrCandidates({ limit: Number(ctx.query.limit) || 200 });
    return { status: 200, body: scrub({
      candidates: scan.candidates,
      rejected: scan.rejected,
      scanned: scan.scanned,
      roots: scan.roots,
      config: conf,
      ocr_ready: ocr.baiduOcrReady(),
      quota: ocr.baiduOcrQuotaState(),
      note:
        'candidates 只包含落在受限根内、且**确实缺正文**的 PDF 原件；' +
        'rejected 为路径越界/非 PDF 原件等被拒条目（如实列出，不静默忽略）。' +
        '网页已有可核对正文（HTML full_text）的对象不会仅因缺少 PDF 附件而出现在这里。',
    }) };
  }],

  /* ---------------- 补跑任务 ---------------- */
  ['POST', '/api/v2/admin/ocr/backfill', async (ctx) => {
    const g = writeGuard(ctx);
    if (g) return { status: g.status, body: g };
    const denied = admin(ctx, '触发 PDF/OCR 补跑');
    if (denied) return { status: denied.status, body: denied };
    const body = ctx.body || {};
    const single = body.kind && body.id;
    const accepted = backfill.startOcrBackfillTask({
      actor: ctx.user?.name || 'admin',
      body,
      mode: single ? 'single' : 'scan',
    });
    return { status: 202, body: scrub(accepted) };
  }],

  ['GET', '/api/v2/admin/ocr/jobs', async (ctx) => {
    const taskId = ctx.query.task_id ? String(ctx.query.task_id) : null;
    return scrub({
      tasks: backfill.listOcrBackfillTasks({ limit: Number(ctx.query.limit) || 20 }),
      task: taskId ? backfill.getOcrBackfillTask(taskId) : null,
      task_id: taskId,
      cursor: backfill.readBackfillCursor(),
      note: 'tasks 为本次服务进程内受理的补跑任务（POST 返回的 task_id 在此轮询）；单并发，重入合并到运行中的任务。',
    });
  }],

  ['POST', '/api/v2/admin/ocr/reparse', async (ctx) => {
    const g = writeGuard(ctx);
    if (g) return { status: g.status, body: g };
    const denied = admin(ctx, '按对象重解析 PDF');
    if (denied) return { status: denied.status, body: denied };
    const body = ctx.body || {};
    const out = await backfill.reparseObject({
      kind: String(body.kind || ''), id: String(body.id || ''),
      actor: ctx.user?.name || 'admin', force: body.force === true,
      deadlineAt: Date.now() + 120000,
    });
    if (out.error) return { status: out.status || 400, body: scrub(out) };
    return scrub(out);
  }],

  /* ---------------- DeepSeek 视觉补充（docs/54） ---------------- */
  ['GET', '/api/v2/admin/vision/status', async (ctx) => {
    const g = readGuard();
    if (g) return { status: g.status, body: g };
    const denied = admin(ctx, '查看视觉补充状态');
    if (denied) return { status: denied.status, body: denied };
    return scrub(vision.visionStatus({ limit: Number(ctx.query.limit) || 20 }));
  }],

  ['GET', '/api/v2/admin/vision/tooling', async () => {
    return scrub(await vision.visionToolingStatus());
  }],

  ['POST', '/api/v2/admin/vision/supplement', async (ctx) => {
    const g = writeGuard(ctx);
    if (g) return { status: g.status, body: g };
    const denied = admin(ctx, '触发视觉补充');
    if (denied) return { status: denied.status, body: denied };
    const body = ctx.body || {};
    const kind = String(body.kind || '');
    const id = String(body.id || '');
    const page = Number(body.page);
    const allowed = ['policy_attachment', 'policy_document', 'methodology_version', 'cea_document'];
    if (!allowed.includes(kind)) return { status: 400, body: { error: `kind 须为 ${allowed.join(' | ')}` } };
    if (!id) return { status: 400, body: { error: '缺少对象 id' } };
    if (!Number.isInteger(page) || page < 1) return { status: 400, body: { error: 'page 须为从 1 开始的物理页码' } };
    const target = backfill.locateObjectPath(kind, id);
    if (!target || !target.local_path) return { status: 404, body: { error: '未找到该对象或该对象没有本地 PDF 原件' } };
    const pathCheck = backfill.assertRestrictedPath(target.local_path);
    if (!pathCheck.ok) return { status: 400, body: { error: pathCheck.reason, path_rejected: true } };
    const extra = (() => { try { return JSON.parse(body.extra || '{}'); } catch { return {}; } })();
    const out = await vision.visionSupplementPage({
      kind, id, page,
      filePath: pathCheck.resolved,
      docHash: target.file_hash || null,
      title: target.title,
      actor: ctx.user?.name || 'admin',
      apply: body.apply !== false,
      deadlineAt: Date.now() + 120000,
      extra,
    });
    return scrub(out);
  }],

  ['POST', '/api/v2/admin/vision/files/cleanup', async (ctx) => {
    const g = writeGuard(ctx);
    if (g) return { status: g.status, body: g };
    const denied = admin(ctx, '清理过期视觉图片缓存');
    if (denied) return { status: denied.status, body: denied };
    const out = await vision.cleanupVisionFiles();
    return scrub({ ...out, cache: vision.fileCachePublic(20) });
  }],

  /* ---------------- 每日补跑（管理员手动触发一次有界批次） ---------------- */
  ['POST', '/api/v2/admin/ocr/daily', async (ctx) => {
    const g = writeGuard(ctx);
    if (g) return { status: g.status, body: g };
    const denied = admin(ctx, '执行每日 OCR 补跑');
    if (denied) return { status: denied.status, body: denied };
    const out = await backfill.runDailyOcrBackfill({
      actor: ctx.user?.name || 'admin', deadlineAt: Date.now() + 120000,
    });
    return { status: 200, body: scrub(out) };
  }],
];

export default OCR_RAW_ROUTES;
