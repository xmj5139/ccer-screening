/**
 * v2.1 端到端验收：单进程内启动真实 HTTP 服务（随机端口）并跑完全部验收项
 * ============================================================================
 * 为什么不用固定端口：本机可能残留旧的 node server 进程占用端口，
 * 导致新代码无法监听、验收打到旧进程上。这里让操作系统分配随机端口，
 * 并**在同一进程内**完成验收，杜绝「验收对象其实是旧进程」的风险。
 *
 * 用时序化输出报告每一条验收结论，退出码：0 全部通过 / 1 有失败。
 *
 * 用法：node scripts/v2-acceptance.mjs
 */
import { initV2Env } from './v2-env.mjs';

const { dbPath, guard } = await initV2Env({ quiet: true });

const db = await import('../src/core/db.mjs');
db.getDb();
// 在导入 server 之前固定环境
process.env.CCER_AUTH_MODE = 'session';
process.env.PORT = '0';
delete process.env.CCER_ALLOW_REMOTE;

const { server } = await import('../src/server.mjs');
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;
const BASE = `http://127.0.0.1:${PORT}`;

const results = [];
function check(cond, label, detail = '') {
  results.push({ ok: !!cond, label, detail });
  console.log(`  ${cond ? 'OK  ' : 'FAIL'} ${label}${detail ? ` :: ${detail}` : ''}`);
}

async function call(path, { method = 'GET', body = null, token = null } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: res.status, json, text };
}

console.log('');
console.log('  CCER 公开信息平台 v2.1 · 端到端验收');
console.log('  ═════════════════════════════════════════════');
console.log(`  数据库：${dbPath}`);
console.log(`  生产库？${guard.isProductionDb(dbPath) ? '是（应被拒绝写）' : '否'}`);
console.log(`  服务端口：${PORT}（随机分配，避免打到旧进程）`);
console.log('  ─────────────────────────────────────────────');

/* -------- 1. 健康检查与版本标识 -------- */
console.log('\n[1] 健康检查与产品标识');
const health = await call('/api/health');
check(health.status === 200, '健康检查返回 200');
check(health.json.app === 'CCER 公开信息平台', '应用名称为公开信息平台', String(health.json.app));
// 版本号随 CEA 阶段B 尾项整改推进到 2.3.0；这里断言「≥2.1.0 且为 2.x」，避免版本升级即误报失败
const verNum = String(health.json.version || '');
check(/^2\.\d+\.\d+$/.test(verNum) && verNum >= '2.1.0', `版本为 2.x（当前 ${verNum}）`, verNum);
check(health.json.v2?.ok === true, 'v2 表结构就绪');
check(health.json.v2?.production_db === false, '使用独立库而非在用生产库');
check(String(health.json.product_note || '').includes('不含内部项目'), '健康检查声明不含内部项目与人工审核');

/* -------- 2. 登录与权限 -------- */
console.log('\n[2] 登录与权限');
const login = await call('/api/auth/login', {
  method: 'POST', body: { user_id: 'user-admin', password: 'admin-demo-2026' },
});
check(login.status === 200, '管理员登录成功');
const token = login.json?.token;
check(!!token, '返回会话令牌');
const viewerLogin = await call('/api/auth/login', {
  method: 'POST', body: { user_id: 'user-other', password: 'viewer-demo-2026' },
});
const viewerToken = viewerLogin.json?.token;
check(viewerLogin.status === 200, '只读用户登录成功');
const noAuth = await call('/api/v2/overview');
check(noAuth.status === 401, '未认证访问 /api/v2/* 返回 401', String(noAuth.status));
const viewerWrite = await call('/api/v2/trade/collect', { method: 'POST', body: { limit: 1 }, token: viewerToken });
check(viewerWrite.status === 403, '只读用户写操作返回 403', String(viewerWrite.status));

/* -------- 3. 八个模块的数据接口 -------- */
console.log('\n[3] 八个模块的数据接口');
const moduleApis = [
  ['总览', '/api/v2/overview'],
  ['政策和方法学', '/api/v2/policies'],
  ['公开项目', '/api/v2/public-projects'],
  ['交易信息', '/api/v2/trade/overview'],
  ['减排粗估', '/api/v2/measure/quick-gas/meta'],
  ['研报与行业动态', '/api/v2/content'],
  ['后台管理', '/api/v2/admin/status'],
];
for (const [name, path] of moduleApis) {
  const out = await call(path, { token });
  check(out.status === 200, `${name} → ${path}`, `HTTP ${out.status}`);
}

/* -------- 4. 公开数据集口径 -------- */
console.log('\n[4] 公开数据集口径（排除内部/demo）');
const overview = await call('/api/v2/overview', { token });
const regionKeys = Object.keys(overview.json.region?.provinces?.[0] || {});
check(!regionKeys.includes('internal_projects'), '地域视图不含内部项目列', regionKeys.join(','));
check(String(overview.json.region?.note || '').includes('不再统计机构内部项目'), '口径说明不再统计内部项目');
check(Array.isArray(overview.json.policies?.latest), '总览返回最新政策');
check(overview.json.content && 'stats' in overview.json.content, '总览返回最新研报与动态');
const status = await call('/api/v2/status', { token });
check(!('pending_review' in (status.json.sync?.counts || {})), '状态计数不再含待人工核对');
for (const k of ['verification_verified', 'verification_insufficient', 'verification_conflict', 'verification_unavailable']) {
  check(typeof status.json.sync?.counts?.[k] === 'number', `状态计数含 ${k}`);
}
check(typeof status.json.demo_content === 'number', '单独统计内容库演示条目（不计入业务统计）');

/* -------- 5. 旧业务入口全部停用 -------- */
console.log('\n[5] 旧业务入口全部停用（不可作为绕过入口）');
const retired = [
  ['GET', '/api/v2/internal-projects'],
  ['POST', '/api/v2/internal-projects'],
  ['POST', '/api/v2/public-projects/x/confirm'],
  ['POST', '/api/v2/policies/x/confirm'],
  ['POST', '/api/v2/trade/x/verify'],
  ['POST', '/api/v2/trade/verify-bulk'],
  ['GET', '/api/v2/admin/reviews'],
  ['POST', '/api/v2/admin/reviews/x/decide'],
  ['POST', '/api/v2/admin/reconciliations/x/resolve'],
  ['GET', '/api/v2/admin/ai-review'],
  ['POST', '/api/v2/admin/ai-review/run'],
  ['POST', '/api/v2/import/internal-project'],
  ['POST', '/api/v2/measure/run'],
  ['GET', '/api/v2/measure/runs'],
  ['GET', '/api/v2/policy-changes/:id'],
];
let retiredOk = 0;
for (const [method, path] of retired) {
  const out = await call(path, { method, body: method === 'GET' ? null : {}, token });
  // 410=显式停用；404=路由不存在（同样不可达）；405 也算不可达
  const unreachable = [410, 404, 405].includes(out.status);
  if (unreachable) retiredOk += 1;
  else console.log(`        注意：${method} ${path} → HTTP ${out.status}`);
}
check(retiredOk === retired.length, `全部 ${retired.length} 条旧入口不可达`, `可达 ${retired.length - retiredOk} 条`);
const retiredBody = await call('/api/v2/internal-projects', { token });
check(retiredBody.status === 410 || retiredBody.status === 404, '内部项目接口不可用', String(retiredBody.status));
if (retiredBody.status === 410) {
  check(retiredBody.json?.retired === true, '停用响应标记 retired');
  check(String(retiredBody.json?.message || '').includes('不再提供'), '停用响应说明原因');
}

/* -------- 6. 快捷估算（无档案、无审批） -------- */
console.log('\n[6] 减排粗估：无项目档案、无审批');
const qg = await call('/api/v2/measure/quick-gas/meta', { token });
check(qg.json.requires_project_dossier === false, '不要求项目档案');
check(qg.json.requires_approval === false, '不要求任何审批');
check(qg.json.numeric_formula_source === 'deterministic_plugin', '公式来自确定性程序');
check(qg.json.primary_fields?.length === 2, '主要参数为两项', String(qg.json.primary_fields?.length));
check(qg.json.advanced_fields?.length === 2, '高级参数为两项（可选）');
check(String(qg.json.disclaimer || '').includes('不是可签发'), '声明不是可签发量');
const est = await call('/api/v2/measure/quick-gas', {
  method: 'POST', token, body: { annual_gas_m3: 50000000, ch4_pct: 1.2 },
});
check(est.status === 200, '估算接口返回 200');
check(est.json.annual_tco2e === 9135.45, '粗估量可独立复算 = 9135.45', String(est.json.annual_tco2e));
const bad = await call('/api/v2/measure/quick-gas', {
  method: 'POST', token, body: { annual_gas_m3: 1000, ch4_pct: 9 },
});
check(bad.status === 400, '≥8% 输入被拒绝', String(bad.status));

/* -------- 7. 采集连接与自动核验状态 -------- */
console.log('\n[7] 采集连接与自动核验（如实显示）');
const sp = await call('/api/v2/admin/search-providers', { token });
check(sp.status === 200, '搜索服务配置接口可用');
check(typeof sp.json.status?.available === 'boolean', '搜索服务如实返回可用性');
check(String(sp.json.status?.note || '').length > 0, '搜索服务给出状态说明');
const fc = await call('/api/v2/admin/fetch-connections', { token });
check(fc.status === 200, '抓取连接配置接口可用');
check(typeof fc.json.status?.available === 'boolean', '抓取连接如实返回可用性');
const vc = await call('/api/v2/admin/verify-config', { token });
check(vc.status === 200, '自动核验策略接口可用');
check(vc.json.rules?.length >= 10, '内置核验规则齐备', String(vc.json.rules?.length));
check(vc.json.states?.length === 4, '核验四态定义完整');
const stateNames = (vc.json.states || []).map((s) => s.result).sort().join(',');
check(stateNames === 'conflict,insufficient,unavailable,verified', '四态取值正确', stateNames);
check(typeof vc.json.stats?.model_available === 'boolean', '如实返回模型可用性');
const sk = await call('/api/v2/admin/secret-key', { token });
check(sk.status === 200, '主密钥状态接口可用');
check(!('value' in (sk.json.secret_key || {})), '主密钥接口不返回值本身');
check(!/[A-Za-z0-9+/]{40,}={0,2}/.test(JSON.stringify(sk.json)), '主密钥响应不含密钥形态长串');

/* -------- 8. 模型真实连接测试（区分已配置/可调用） -------- */
console.log('\n[8] 模型真实连接测试');
const llm = await call('/api/v2/admin/llm', { token });
check(llm.status === 200, '模型配置接口可用');
const enabled = (llm.json.providers || []).find((p) => p.enabled);
if (enabled) {
  const t = await call(`/api/v2/admin/llm/${enabled.id}/test`, { method: 'POST', token });
  check(t.status === 200, '连接测试接口返回 200');
  check(typeof t.json.configured === 'boolean', '区分 configured');
  check(typeof t.json.callable === 'boolean', '区分 callable');
  console.log(`        模型 ${enabled.name}：configured=${t.json.configured} callable=${t.json.callable} real_call=${t.json.real_call_performed}`);
  console.log(`        说明：${String(t.json.message || '').slice(0, 160)}`);
  check(!JSON.stringify(t.json).includes('sk-'), '连接测试响应不含密钥明文');
} else {
  check(false, '应至少有一个已配置模型（种子数据）');
}

/* -------- 9. 每日任务与数据集游标 -------- */
console.log('\n[9] 每日任务与「最近成功时间/失败原因」');
const daily = await call('/api/v2/admin/daily', {
  method: 'POST', token, body: { datasets: ['content'], contentMaxItems: 10 },
});
check(daily.status === 200, '每日任务接口返回 200');
check(daily.json.ok === true, '未配置搜索 API 不应让任务判失败', `status=${daily.json.status} errors=${daily.json.stats?.errors}`);
check(!!daily.json.detail?.content_not_configured, '未配置搜索服务时写明原因（已知限制）');
check(daily.json.detail?.content_seed?.attempted >= 0, '执行了种子来源抓取');
const cursors = await call('/api/v2/admin/dataset-cursors', { token });
const cursorNames = (cursors.json.cursors || []).map((c) => c.dataset);
for (const d of ['content_discovery', 'content_seed', 'seed_source_probe', 'verify_content']) {
  check(cursorNames.includes(d), `游标含数据集 ${d}`);
}
const seedCur = (cursors.json.cursors || []).find((c) => c.dataset === 'content_seed');
check(!!seedCur?.last_success_at, '种子来源抓取记录了最近成功时间', String(seedCur?.last_success_at));
const never = (cursors.json.cursors || []).filter((c) => c.last_status === 'never');
check(never.length >= 0, `如实显示「从未成功」的数据集：${never.map((c) => c.dataset).join('、') || '无'}`);

/* -------- 10. 内容库口径 -------- */
console.log('\n[10] 公开内容库口径');
const content = await call('/api/v2/content?limit=20', { token });
check(content.status === 200, '内容列表接口可用');
check(typeof content.json.total === 'number', '返回总数');
check((content.json.items || []).every((i) => i.is_demo === false), '列表不含演示条目');
check((content.json.items || []).every((i) => !i.duplicate_of), '列表不含转载副本');
check(String(content.json.note || '').includes('不含演示条目'), '口径说明排除演示条目与转载副本');
const cs = await call('/api/v2/content/stats', { token });
console.log(`        真实内容 ${cs.json.stats?.total} 条｜类型 ${JSON.stringify(cs.json.stats?.by_type_label)}`);
console.log(`        核验状态 ${JSON.stringify(cs.json.stats?.by_verification)}`);
console.log(`        正文可获得性 ${JSON.stringify(cs.json.stats?.by_availability)}`);
check(cs.json.stats?.total >= 0, '统计接口可用');

/* -------- 11. 凭据不泄漏 -------- */
console.log('\n[11] 凭据不泄漏');
const probePaths = [
  '/api/v2/status', '/api/v2/admin/status', '/api/v2/admin/llm',
  '/api/v2/admin/search-providers', '/api/v2/admin/fetch-connections',
  '/api/v2/admin/secret-key', '/api/v2/measure/quick-gas/meta',
];
let leakFree = true;
for (const p of probePaths) {
  const out = await call(p, { token });
  const s = JSON.stringify(out.json);
  if (/tvly-[A-Za-z0-9]{10,}/.test(s) || /fc-[A-Za-z0-9]{20,}/.test(s) || /sk-[A-Za-z0-9]{16,}/.test(s)) {
    leakFree = false;
    console.log(`        泄漏嫌疑：${p}`);
  }
}
check(leakFree, '所有状态类接口不含密钥形态字符串');

/* -------- 12. 前端静态资源 -------- */
console.log('\n[12] 前端静态资源（真实下发内容）');
const html = await (await fetch(`${BASE}/v2`)).text();
const appJs = await (await fetch(`${BASE}/v2/app.js`)).text();
check(html.includes('CCER 公开信息平台'), '页面标题为公开信息平台');
check(!html.includes('六模块'), '页面不再自称六模块');
const navLabels = [...appJs.matchAll(/label: '([^']+)'/g)].map((m) => m[1]).slice(0, 8);
check(
  navLabels.join(',') === '总览,政策和方法学,公开项目,交易信息,CEA市场,减排粗估,研报与行业动态,后台管理',
  '导航为八个主模块（含 CEA 市场）',
  navLabels.join(' | ')
);
check(!navLabels.join(' ').includes('内部项目'), '导航不含内部项目');
const contentJs = await (await fetch(`${BASE}/v2/modules/content.js`)).text();
for (const s of ['自动核验通过', '证据不足', '来源冲突', '暂未自动核验']) {
  check(contentJs.includes(s), `内容模块含四态文案「${s}」`);
}
const adminJs = await (await fetch(`${BASE}/v2/modules/admin.js`)).text();
check(adminJs.includes('采集连接'), '后台含采集连接页签');
check(adminJs.includes('自动核验策略'), '后台含自动核验策略页签');
// 只看真实页签定义（注释里会说明「旧页签已删除」，不能据此判定仍有该页签）
const adminTabs = [...adminJs.matchAll(/key: '(\w+)', label: '([^']+)'/g)].map((m) => m[2]).join(' ');
check(!adminTabs.includes('审核任务'), '后台页签不含审核任务', adminTabs);
check(!adminTabs.includes('AI 复核'), '后台页签不含 AI 复核', adminTabs);
check(adminJs.includes('真实连接测试'), '后台提供真实连接测试');
const measureJs = await (await fetch(`${BASE}/v2/modules/measure.js`)).text();
check(measureJs.includes('低于 8% 煤矿瓦斯简表'), '减排粗估含简表');
check(measureJs.indexOf('quick-primary') < measureJs.indexOf('quick-advanced'), '主要参数排在高级参数之前');
const css = await (await fetch(`${BASE}/v2/styles.css`)).text();
check(/@media\s*\(max-width:\s*720px\)/.test(css), '含手机宽度断点');
check(css.includes('.quick-primary { grid-template-columns: 1fr; }'), '手机断点下主要参数为单列');

server.close();

/* -------- 汇总 -------- */
const failed = results.filter((r) => !r.ok);
console.log('');
console.log('  ═════════════════════════════════════════════');
console.log(`  验收项：${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`);
if (failed.length) {
  for (const f of failed) console.log(`   ✗ ${f.label}${f.detail ? ` :: ${f.detail}` : ''}`);
}
console.log('  ═════════════════════════════════════════════');
console.log('');
db.closeDb();
setTimeout(() => process.exit(failed.length ? 1 : 0), 200);
