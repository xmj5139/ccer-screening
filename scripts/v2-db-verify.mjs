/**
 * 现有 v2 数据库接口验收（二轮整改）
 * ============================================================================
 * 目的：用**真实的 data/ccer_v2.db**（不是临时库）启动同进程 HTTP 服务，
 * 逐项验证 docs/22 第 16 条要求的口径：
 *   - 公开项目业务数排除演示条目（294 → 291）；
 *   - 来源首页归档记录不进入文章列表与统计，发布日不再等于采集日；
 *   - 总览 / 后台文案不含人工复核、签字、审批、待办口径；
 *   - 数据缺口以「自动处理方式」展示；
 *   - 根路径导向 /v2；旧私有/审批接口返回 410。
 *
 * 说明：
 *   - 随机端口 + 同进程，杜绝「打到别的进程」的假通过；
 *   - CCER_DAILY_SYNC=0：不启动每日调度，不产生采集写入；
 *   - 打开数据库会执行**幂等、非破坏性**迁移（补列 + 回填 is_demo/record_kind），
 *     不删除任何历史数据；本脚本不修改业务数据、不写配置。
 *
 * 用法：node scripts/v2-db-verify.mjs
 */
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';

const DB = resolve(process.env.CCER_DB_PATH || 'data/ccer_v2.db');
if (!existsSync(DB)) {
  console.error(`✗ 未找到数据库：${DB}`);
  process.exit(2);
}
process.env.CCER_DB_PATH = DB;
process.env.CCER_ENABLE_V2 = '1';
process.env.CCER_DAILY_SYNC = '0';
process.env.CCER_AUTH_MODE = 'dev'; // 本机回环验收：用 x-user-id 直连，不触碰真实口令
delete process.env.CCER_ALLOW_REMOTE;

const db = await import('../src/core/db.mjs');
const { startServer } = await import('../src/server.mjs');

db.getDb();
const server = await startServer({ port: 0, host: '127.0.0.1' });
const port = server.address().port;
const BASE = `http://127.0.0.1:${port}`;

let pass = 0;
let fail = 0;
const check = (ok, name, detail = '') => {
  if (ok) {
    pass += 1;
    console.log(`  OK   ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name}${detail ? ` :: ${detail}` : ''}`);
  }
};

async function api(path, { method = 'GET', user = 'user-admin', body = null, redirect = 'follow' } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    redirect,
    headers: { 'x-user-id': user, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: res.status, json, text, headers: res.headers };
}

console.log('');
console.log('  现有 v2 数据库接口验收');
console.log('  ═════════════════════════════════════════════');
console.log(`  数据库：${DB}`);
console.log(`  服务：${BASE}（同进程随机端口，CCER_DAILY_SYNC=0）`);
console.log('  ─────────────────────────────────────────────');

/* 1. 健康检查与数据库真实计数 */
const health = await api('/api/health');
check(health.status === 200 && health.json?.ok === true, '健康检查可用', `HTTP ${health.status}`);
check(health.json?.v2?.ok === true, 'v2 迁移已启用');

const projTotal = db.get('SELECT COUNT(*) c FROM public_project').c;
const projDemo = db.get('SELECT COUNT(*) c FROM public_project WHERE COALESCE(is_demo,0)=1').c;
const projBusiness = db.get('SELECT COUNT(*) c FROM public_project WHERE COALESCE(is_demo,0)=0').c;
console.log(`  项目库：总计 ${projTotal}｜演示 ${projDemo}｜业务 ${projBusiness}`);
check(projDemo >= 3, '历史演示项目已被标记 is_demo=1（只标记，不删除）');
check(projBusiness === projTotal - projDemo, '业务项目数 = 总数 − 演示数');

/* 2. 公开项目接口默认排除演示条目 */
const projects = await api('/api/v2/public-projects?limit=5');
check(projects.status === 200, '公开项目接口可用', `HTTP ${projects.status}`);
check(projects.json?.total === projBusiness, `公开项目 total 应等于业务数 ${projBusiness}`, `实际 ${projects.json?.total}`);
const demoIncluded = await api('/api/v2/public-projects?limit=5&include_demo=true');
check(demoIncluded.json?.total === projTotal, '显式 include_demo=true 时仍可查看全部（历史留痕）', `实际 ${demoIncluded.json?.total}`);

/* 3. 内容库：归档不计入文章、发布日不冒充 */
const contentStats = await api('/api/v2/content/stats');
const cs = contentStats.json?.stats || {};
console.log(`  内容库：正文条目 ${cs.total}｜来源归档 ${cs.archive_records}｜发布日期未披露 ${cs.published_date_missing}`);
check(contentStats.status === 200, '内容统计接口可用');
check(Number(cs.archive_records || 0) >= 5, '旧的来源首页记录已改记为 source_homepage（保留快照，不删除）');
const archiveWrongDate = db.get(
  "SELECT COUNT(*) c FROM content_item WHERE record_kind<>'article' AND published_at IS NOT NULL"
).c;
check(archiveWrongDate === 0, '归档记录不再带「采集日冒充的发布日期」');
const contentList = await api('/api/v2/content?limit=100');
check((contentList.json?.items || []).every((i) => i.record_kind === 'article'), '文章列表不含来源归档记录');
check((contentList.json?.items || []).every((i) => i.published_at === null || i.published_at < '2026-09-29'), '文章列表不使用采集日作为发布日');

/* 4. 总览口径：排除 demo、无人工措辞 */
const overview = await api('/api/v2/overview');
check(overview.status === 200, '总览接口可用', `HTTP ${overview.status}`);
const projMetric = (overview.json?.metrics || []).find((m) => m.key === 'dash.project_public');
check(Number(projMetric?.value) === db.get('SELECT COUNT(*) c FROM public_project WHERE COALESCE(is_demo,0)=0 AND stage_project_public=1').c,
  '总览「公示项目数」为业务口径（排除演示条目）', `实际 ${projMetric?.value}`);
check(String(projMetric?.sub || '').includes(`已排除演示条目 ${projDemo} 条`), '总览明示排除的演示条数');
check(Number(overview.json?.progress?.project_total) === projBusiness, '项目进度总数为业务口径');
const overviewText = JSON.stringify(overview.json);
const forbidden = ['待人工复核', '人工核对', '人工补录', '须人工', '签字', '审批', '人工路径', '待领域'];
const leaks = forbidden.filter((w) => overviewText.includes(w));
check(leaks.length === 0, '总览接口文案不含人工工作流措辞', leaks.join('、'));
const gapViews = (overview.json?.region?.data_gaps || []);
check(gapViews.length > 0 && gapViews.every((g) => g.manual_path === null && !!g.auto_action), '数据缺口只展示自动处理方式');

/* 5. 交易/政策/核验接口 */
const trade = await api('/api/v2/trade/overview?range_days=365');
check(trade.status === 200, '交易总览接口可用', `HTTP ${trade.status}`);
const tradeDaily = await api('/api/v2/trade/daily?limit=5');
check(tradeDaily.status === 200 && (tradeDaily.json?.rows || []).length > 0, '交易明细接口可用');
const policy = await api('/api/v2/policies');
check(policy.status === 200 && (policy.json?.policies || []).length > 0, '政策接口可用');
const verifyCfg = await api('/api/v2/admin/verify-config');
check(verifyCfg.status === 200 && Array.isArray(verifyCfg.json?.rules), '自动核验策略接口可用');
const rules = verifyCfg.json?.rules || [];
check(rules.some((r) => r.scope === 'policy') && rules.some((r) => r.scope === 'project'), '核验规则已覆盖政策与公开项目（不只研报）');
const gaps = await api('/api/v2/admin/gaps?status=all');
check((gaps.json?.gaps || []).every((g) => g.manual_path === null), '后台缺口接口不再返回人工路径');
check((gaps.json?.gaps || []).some((g) => g.legacy_manual_path), '旧人工路径保留为历史留痕字段');

/* 6. 连接配置现状（只读展示，不修改） */
const searchProviders = await api('/api/v2/admin/search-providers');
const presets = searchProviders.json?.presets || {};
check(!!presets.bocha, '后台已提供博查预设（provider_kind=bocha）');
check(presets.bocha?.credential_ref === 'BOCHA_API_KEY', '博查预设凭据引用为 BOCHA_API_KEY');
const fetchConns = await api('/api/v2/admin/fetch-connections');
const fetchPresets = fetchConns.json?.presets || {};
check(!!fetchPresets.mcp_http, '后台已提供 Firecrawl v2 MCP 预设（conn_kind=mcp_http）');
check(fetchPresets.mcp_http?.mcp_tool_name === 'firecrawl_scrape', 'Firecrawl MCP 预设工具为 firecrawl_scrape');
console.log(`  现有搜索服务：${(searchProviders.json?.providers || []).map((p) => `${p.name}(${p.provider_kind}, 凭据${p.credential_configured ? '已配置' : '未配置'})`).join('、') || '无'}`);
console.log(`  现有抓取连接：${(fetchConns.json?.connections || []).map((c) => `${c.name}(${c.conn_kind}, 凭据${c.credential_configured ? '已配置' : '未配置'})`).join('、') || '无'}`);

/* 7. 主入口与旧入口 */
const root = await api('/', { redirect: 'manual' });
check([301, 302, 307, 308].includes(root.status) && root.headers.get('location') === '/v2', '根路径 302 导向 /v2', `HTTP ${root.status} → ${root.headers.get('location')}`);
for (const p of ['/api/projects', '/api/reviews', '/api/calculations', '/api/reports/pending']) {
  const r = await api(p);
  check(r.status === 410 && r.json?.retired === true, `旧私有/审批接口 ${p} 返回 410`, `HTTP ${r.status}`);
}

/* 7b. 真实 HTTP 下的前端资源与粗估单位（浏览器实际会拿到的内容） */
const v2page = await api('/v2');
check(v2page.status === 200 && v2page.text.includes('公开信息平台'), '新版工作台页面可访问', `HTTP ${v2page.status}`);
const FORBIDDEN_UI = ['机构内部项目库', '项目更新与 AI 复核', '变更待确认', '标记为已核对', '领域已签字', '内部项目关联', 'data-confirm', 'data-approve'];
for (const file of ['modules/measure.js', 'modules/content.js', 'modules/trades.js', 'modules/overview.js', 'modules/admin.js', 'app.js']) {
  const r = await api(`/v2/${file}`);
  const leaks = FORBIDDEN_UI.filter((w) => r.text.includes(w));
  check(r.status === 200 && leaks.length === 0, `前端资源 ${file} 无人工审核/内部项目入口`, leaks.join('、') || `HTTP ${r.status}`);
}
const legacyStatic = await api('/app.js');
check(legacyStatic.status === 410, '旧版静态工作台资源返回 410', `HTTP ${legacyStatic.status}`);

const gasMeta = await api('/api/v2/measure/quick-gas/meta');
const gasField = (gasMeta.json?.primary_fields || []).find((f) => f.key === 'annual_gas_m3');
check(gasField?.unit === 'm³/年', '粗估元数据主输入单位为 m³/年', `实际 ${gasField?.unit}`);
check((gasField?.unit_options || []).some((u) => u.key === 'annual_gas_10k_m3' && u.factor === 10000), '提供万 m³/年 单位并声明 ×10000 换算');
const gasCalc = await api('/api/v2/measure/quick-gas', {
  method: 'POST', body: { annual_gas_10k_m3: 10000, ch4_pct: 1.2 },
});
check(gasCalc.status === 200 && gasCalc.json?.annual_tco2e === 18270.9,
  '真实 HTTP 粗估：10000 万 m³/年 + 1.2% → 18270.9 tCO₂e/年（非 1.82709）', `实际 ${gasCalc.json?.annual_tco2e}`);
const gasConflict = await api('/api/v2/measure/quick-gas', {
  method: 'POST', body: { annual_gas_m3: 10000, annual_gas_10k_m3: 10000, ch4_pct: 1.2 },
});
check(gasConflict.status >= 400 && !!gasConflict.json?.error, '同时提交两种单位被拒绝（无单位歧义）', `HTTP ${gasConflict.status}`);

/* 8. 统一模型核验链路（可选：--run-verify 时才真正执行并写核验记录） */
if (process.argv.includes('--run-verify')) {
  const verify = await import('../src/services/verification-svc.mjs');
  console.log('  执行统一自动核验（内容 / 政策 / 方法学 / 公开项目；未配置模型时如实记录 unavailable）…');
  const out = await verify.verifyAllBatch({ actor: 'system:db-verify', limitPerScope: 10 });
  console.log(`  内容核验：${JSON.stringify(out.content)}`);
  for (const [scope, t] of Object.entries(out.scopes || {})) console.log(`  ${scope} 核验：${JSON.stringify(t)}`);
  check(!!out.content, '统一核验覆盖研报与行业动态');
  check(Object.keys(out.scopes || {}).length >= 3, '统一核验覆盖政策 / 方法学 / 公开项目（不只研报）');
  const byScope = db.all('SELECT object_type, result, COUNT(*) c FROM verification_result GROUP BY object_type, result');
  console.log(`  核验记录分布：${JSON.stringify(byScope)}`);
}

console.log('  ─────────────────────────────────────────────');
console.log(`  验收项：${pass + fail} 项，通过 ${pass}，失败 ${fail}`);
console.log('  ═════════════════════════════════════════════');
server.close();
db.closeDb();
process.exit(fail ? 1 : 0);
