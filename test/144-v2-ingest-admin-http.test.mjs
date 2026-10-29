/**
 * 测试 144（docs/80 A6/B5）：新增后台入口的 HTTP 权限与只读状态契约。
 * 未登录 401；普通用户 403；管理员可读队列/分类并切换开关。
 * 仅用 setupV2 临时库；不调用模型、不联网。
 */
import {
  setupV2, testAsync, assert, assertEqual, assertIncludes, finish,
} from './v2-helpers.mjs';
import { readFile } from 'node:fs/promises';

const ctx = await setupV2({ withPublicDemo: false });
const { db } = ctx;
process.env.CCER_AUTH_MODE = 'session';

const ingest = await import('../src/services/ingest-summary-svc.mjs');
const { server } = await import('../src/server.mjs');
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

async function call(path, { method = 'GET', body = null, token = null } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text.slice(0, 200) }; }
  return { status: res.status, json, text };
}

let adminToken = null;
let viewerToken = null;
try {
  await testAsync('登录管理员与普通只读用户', async () => {
    const a = await call('/api/auth/login', { method: 'POST', body: { user_id: 'user-admin', password: 'admin-demo-2026' } });
    assertEqual(a.status, 200, a.text.slice(0, 120));
    adminToken = a.json.token;
    const v = await call('/api/auth/login', { method: 'POST', body: { user_id: 'user-other', password: 'viewer-demo-2026' } });
    assertEqual(v.status, 200, v.text.slice(0, 120));
    viewerToken = v.json.token;
  });

  await testAsync('入库摘要队列 GET：匿名 401、普通用户 403、管理员 200 且不含密钥', async () => {
    const anon = await call('/api/v2/admin/summaries/queue');
    assertEqual(anon.status, 401);
    const viewer = await call('/api/v2/admin/summaries/queue', { token: viewerToken });
    assertEqual(viewer.status, 403);
    const admin = await call('/api/v2/admin/summaries/queue', { token: adminToken });
    assertEqual(admin.status, 200, admin.text.slice(0, 160));
    assert(admin.json.counts, '应返回队列状态统计');
    assert(admin.json.config && admin.json.worker, '应返回实际配置与 worker 状态');
    assertIncludes(admin.json.note, '输入签名');
    assert(!/api[_-]?key|secret|token/i.test(JSON.stringify(admin.json)), '队列状态不得含凭据字段');
  });

  await testAsync('缺口分类/CEA 排除 GET：普通用户 403、管理员 200', async () => {
    for (const p of ['/api/v2/admin/maintenance/gaps/triage', '/api/v2/admin/maintenance/cea-exclusions']) {
      const viewer = await call(p, { token: viewerToken });
      assertEqual(viewer.status, 403, `${p} 普通用户应 403`);
      const admin = await call(p, { token: adminToken });
      assertEqual(admin.status, 200, `${p} 管理员应 200：${admin.text.slice(0, 120)}`);
    }
    const admin = await call('/api/v2/admin/maintenance/gaps/triage', { token: adminToken });
    assert(Array.isArray(admin.json.categories), '应返回分类字典');
    assert(Array.isArray(admin.json.items), '应返回缺口项');
    assertIncludes(admin.json.note, '不调用模型');
  });

  await testAsync('队列开关/补入/重试 POST：普通用户 403，管理员入口可用', async () => {
    const viewerToggle = await call('/api/v2/admin/summaries/queue/toggle', {
      method: 'POST', body: { enabled: false }, token: viewerToken,
    });
    assertEqual(viewerToggle.status, 403);
    const viewerBackfill = await call('/api/v2/admin/summaries/queue/backfill', {
      method: 'POST', body: { limit: 2 }, token: viewerToken,
    });
    assertEqual(viewerBackfill.status, 403);
    const viewerRetry = await call('/api/v2/admin/summaries/queue/retry', {
      method: 'POST', body: { limit: 2 }, token: viewerToken,
    });
    assertEqual(viewerRetry.status, 403);

    const adminToggle = await call('/api/v2/admin/summaries/queue/toggle', {
      method: 'POST', body: { enabled: false }, token: adminToken,
    });
    assertEqual(adminToggle.status, 200, adminToggle.text.slice(0, 160));
    assertEqual(adminToggle.json.enabled, false);
    const adminBackfill = await call('/api/v2/admin/summaries/queue/backfill', {
      method: 'POST', body: { limit: 2 }, token: adminToken,
    });
    assertEqual(adminBackfill.status, 200, adminBackfill.text.slice(0, 160));
    assertEqual(typeof adminBackfill.json.queued, 'number');
    // 恢复默认，避免影响同进程后续；测试结束会停掉 worker。
    await call('/api/v2/admin/summaries/queue/toggle', {
      method: 'POST', body: { enabled: true }, token: adminToken,
    });
  });

  await testAsync('缺口动作 POST：普通用户 403；无匹配缺口的管理员请求返回业务 404 而非 500', async () => {
    const viewer = await call('/api/v2/admin/maintenance/gaps/NOPE/action', {
      method: 'POST', body: { action: 'requeue_summary' }, token: viewerToken,
    });
    assertEqual(viewer.status, 403);
    const admin = await call('/api/v2/admin/maintenance/gaps/NOPE/action', {
      method: 'POST', body: { action: 'requeue_summary' }, token: adminToken,
    });
    assertEqual(admin.status, 404, admin.text.slice(0, 160));
    assertIncludes(admin.json.error, '不存在');
  });

  await testAsync('GET 队列状态不产生外部调用（请求计数不变）', async () => {
    const before = db.get('SELECT COUNT(*) n FROM llm_call_log').n;
    const out = await call('/api/v2/admin/summaries/queue', { token: adminToken });
    assertEqual(out.status, 200);
    assertEqual(db.get('SELECT COUNT(*) n FROM llm_call_log').n, before, 'GET 不得写模型调用日志');
  });
  await testAsync('后台入口源码：队列开关、状态/失败原因、有界重试/补入与缺口动作均可达', async () => {
    const src = await readFile(new URL('../web/v2/modules/maintenance.js', import.meta.url), 'utf8');
    for (const token of [
      '入库摘要队列', 'data-ingest-toggle', 'data-ingest-backfill', 'data-ingest-retry',
      'last_error', 'data-gap-action', 'data-gap-triage', '自动处理', 'unsupported_reason',
    ]) assertIncludes(src, token, `后台维护页应包含 ${token}`);
    assertIncludes(src, '/api/v2/admin/summaries/queue/', '队列动作应走真实后台路由');
    assertIncludes(src, '/api/v2/admin/maintenance/gaps/', '缺口动作应走真实受控路由');
  });
} finally {
  ingest.stopIngestSummaryWorker();
  await new Promise((resolve) => server.close(resolve));
}

finish('test/144-v2-ingest-admin-http.test.mjs');
