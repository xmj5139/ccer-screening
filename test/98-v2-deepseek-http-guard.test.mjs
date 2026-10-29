/**
 * 测试 98（docs/54 A/C）：DeepSeek / 视觉新增接口的权限与返回纪律
 * ============================================================================
 * 真实 HTTP 层：匿名 401、普通用户 403、管理员 200；
 * 响应不得包含凭据明文、密文、请求头或服务器路径。
 */
import {
  setupV2, testAsync, assert, assertEqual, assertNotIncludes, finish,
} from './v2-helpers.mjs';

const ctx = await setupV2({ withPublicDemo: false });
process.env.CCER_AUTH_MODE = 'session';
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

async function login(user_id, password) {
  const out = await call('/api/auth/login', { method: 'POST', body: { user_id, password } });
  assertEqual(out.status, 200, `登录失败：${out.text.slice(0, 120)}`);
  return out.json.token;
}

console.log('\n[v2-98] DeepSeek / 视觉后台接口权限与返回纪律');
const adminToken = await login('user-admin', 'admin-demo-2026');
const viewerToken = await login('user-other', 'viewer-demo-2026');

await testAsync('匿名访问新增后台接口：401', async () => {
  for (const path of ['/api/v2/admin/deepseek', '/api/v2/admin/vision/status', '/api/v2/admin/vision/tooling']) {
    const out = await call(path);
    assertEqual(out.status, 401, `${path} 匿名应 401，实际 ${out.status}`);
  }
});

await testAsync('普通用户访问新增后台接口：403（不是隐藏按钮）', async () => {
  for (const path of ['/api/v2/admin/deepseek', '/api/v2/admin/vision/status', '/api/v2/admin/vision/tooling']) {
    const out = await call(path, { token: viewerToken });
    assertEqual(out.status, 403, `${path} 普通用户应 403，实际 ${out.status}`);
  }
  const write = await call('/api/v2/admin/deepseek/capabilities/vision', {
    method: 'POST', token: viewerToken, body: { enabled: true },
  });
  assertEqual(write.status, 403, '普通用户不得修改 DeepSeek 能力');
  const vision = await call('/api/v2/admin/vision/supplement', {
    method: 'POST', token: viewerToken, body: { kind: 'policy_document', id: 'x', page: 1 },
  });
  assertEqual(vision.status, 403, '普通用户不得触发视觉补充');
});

await testAsync('管理员可读取概览；响应只含配置状态，不含凭据/密文/请求头', async () => {
  const out = await call('/api/v2/admin/deepseek', { token: adminToken });
  assertEqual(out.status, 200, out.text.slice(0, 200));
  const s = JSON.stringify(out.json);
  for (const bad of ['credential_cipher', 'authorization', 'Bearer ', 'sk-', 'DEEPSEEK_API_KEY']) {
    assertNotIncludes(s, bad, `后台概览不得包含「${bad}」`);
  }
  const caps = out.json.capabilities || [];
  assertEqual(caps.length, 5, '应返回五类能力（search/fetch/vision/chat_tools/json）');
  assertEqual(out.json.boundary_note.includes('视觉'), true);
});

await testAsync('普通用户问答接口可读能力状态，但不含后台细节与凭据', async () => {
  const out = await call('/api/v2/chat/limits', { token: viewerToken });
  assertEqual(out.status, 200, out.text.slice(0, 200));
  const s = JSON.stringify(out.json);
  assertNotIncludes(s, 'credential_cipher');
  assertNotIncludes(s, 'DEEPSEEK_API_KEY');
  assert(out.json.capabilities, '应返回可用能力状态（不是服务端秘密）');
  const adminOnly = await call('/api/v2/admin/vision/status', { token: viewerToken });
  assertEqual(adminOnly.status, 403);
});

await testAsync('视觉触发参数校验：非法 kind / 缺 id 返回 400，不触碰文件或模型', async () => {
  const badKind = await call('/api/v2/admin/vision/supplement', {
    method: 'POST', token: adminToken, body: { kind: 'file_path', id: 'x', page: 1 },
  });
  assertEqual(badKind.status, 400);
  const noId = await call('/api/v2/admin/vision/supplement', {
    method: 'POST', token: adminToken, body: { kind: 'policy_document', page: 1 },
  });
  assertEqual(noId.status, 400);
  assertEqual(String(noId.json.error).includes('id'), true);
});

await testAsync('管理员视觉状态 / 能力配置可读写，但不会自动发起模型调用', async () => {
  const status = await call('/api/v2/admin/vision/status', { token: adminToken });
  assertEqual(status.status, 200, status.text.slice(0, 200));
  assert(status.json.capability, '应返回能力状态');
  const save = await call('/api/v2/admin/deepseek/capabilities/json', {
    method: 'POST', token: adminToken,
    body: { enabled: true, daily_quota: 50, max_per_turn: 2, timeout_ms: 30000, config: { max_retry: 1 } },
  });
  assertEqual(save.status, 200, save.text.slice(0, 240));
  assertEqual(save.json.capability.kind, 'json');
  const read = await call('/api/v2/chat/limits', { token: viewerToken });
  assert(read.json.capabilities.tool_chat, '普通用户看到的工具能力状态应是只读的公开字段');
});

server.closeAllConnections?.();
await new Promise((resolve) => server.close(resolve));
finish('98-v2-deepseek-http-guard.test.mjs');
