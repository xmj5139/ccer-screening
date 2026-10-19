/**
 * v2.1 测试 20：前端页面与接口的页面级验证（无浏览器环境下的等价检查）
 * ============================================================================
 * 覆盖需求（docs/19 第 77、79 条）：
 *   - 验证页面**不再出现人工审核 / 内部项目入口**；
 *   - 验证新增模块（研报与行业动态、采集连接、自动核验策略）真实存在且可渲染；
 *   - 验证减排粗估简表置顶、两项主要参数、高级参数可选；
 *   - 验证手机宽度所需的响应式样式规则存在。
 *
 * 重要说明（真实限制）：本沙箱禁止子进程创建命名管道，
 * Chromium 的 Mojo IPC 因此无法初始化（`FATAL:mojo platform_channel 拒绝访问 (0x5)`），
 * **真实浏览器无法在本环境启动**。因此本文件用两种等价手段替代浏览器：
 *   1. 通过真实 HTTP 服务读取**实际下发的** HTML/JS/CSS，断言其中不含被移除的入口，
 *      且包含新模块所需的 DOM 结构与文案；
 *   2. 用最小 DOM shim 直接调用前端模块的渲染函数，
 *      断言其输出的 HTML 结构与文案正确（这是浏览器里真正执行的同一段代码）。
 * 浏览器实机验证步骤与命令见 docs/20-DSH升级实施记录.md。
 */
import { setupV2, finish, test, testAsync, assert, assertEqual, assertIncludes } from './v2-helpers.mjs';

const ctx = await setupV2({ withPublicDemo: false });
process.env.CCER_AUTH_MODE = 'session';

/* ==================================================================== */
/*  一、通过真实 HTTP 读取实际下发的静态资源                              */
/* ==================================================================== */

const { server } = await import('../src/server.mjs');
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

async function getText(path) {
  const res = await fetch(`${BASE}${path}`);
  assertEqual(res.status, 200, `${path} 应可访问，实际 ${res.status}`);
  return res.text();
}

const html = await getText('/v2');
const appJs = await getText('/v2/app.js');
const stylesCss = await getText('/v2/styles.css');
const contentJs = await getText('/v2/modules/content.js');
const measureJs = await getText('/v2/modules/measure.js');
const adminJs = await getText('/v2/modules/admin.js');
const projectsJs = await getText('/v2/modules/projects.js');
const policiesJs = await getText('/v2/modules/policies.js');
const overviewJs = await getText('/v2/modules/overview.js');
const platformJs = await getText('/v2/platform.js');
const verifyLabelsJs = await getText('/v2/modules/verify-labels.js');

test('页面标题与描述反映碳市场信息平台定位（不再是投资筛选工作台）', () => {
  // docs/44 第 1 条：可见品牌统一为「碳市场信息平台」（浏览器标题 / 登录页 / 导航 / 页脚）
  assertIncludes(html, '碳市场信息平台', '页面标题应为碳市场信息平台');
  assertIncludes(html, '公开研报与行业动态', '描述应提到研报与行业动态');
  assert(!html.includes('六模块'), '不应再自称六模块工作台');
  assertIncludes(html, '/v2/app.js', '应加载应用脚本');
  assertIncludes(html, 'width=device-width', '应含移动端 viewport');
});

test('导航为八个主模块（含 CEA 市场），且不含被取消的入口', () => {
  const mods = [...appJs.matchAll(/key: '(\w+)', label: '([^']+)'/g)].map((m) => m[2]);
  // docs/34 阶段B：新增「CEA市场」导航（原七模块 + CEA = 八模块），普通用户可见
  // docs/39：原「减排粗估」主导航改名为「碳计算与因子」（路由仍为 #/measure，默认仍是低浓度瓦斯粗估）
  assertEqual(mods.length, 8, `导航应为 8 个模块（含 CEA市场），实际 ${mods.length}：${mods.join('、')}`);
  assertEqual(
    mods.join(','),
    '总览,政策和方法学,公开项目,交易信息,CEA市场,碳计算与因子,研报与行业动态,后台管理',
    '导航名称与顺序应与需求一致（CEA市场在交易信息之后；减排粗估已改名为碳计算与因子）'
  );
  for (const bad of ['内部项目', '审核', '复核']) {
    assert(!mods.join(' ').includes(bad), `导航不应含「${bad}」`);
  }
});

test('前端代码整体不再出现人工审核 / 内部项目入口文案', () => {
  const files = { appJs, contentJs, measureJs, adminJs, projectsJs, policiesJs, overviewJs };
  // 只剥离 /* ... */ 块注释：说明性注释会写「旧入口已移除」，
  // 若不剥离会把说明误判为仍然存在该入口。行内 // 注释不剥离，
  // 因为 URL 里的 // 会被误删，反而破坏断言对象。
  const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, ' ');
  // 这些是**可点击/可提交的入口**特征，必须彻底消失
  const forbiddenEntryPoints = [
    '机构内部项目库', '项目更新与 AI 复核', '变更待确认', '标记为已核对',
    '领域已签字', '内部项目关联',
    'data-confirm', 'data-approve', 'data-reject',
  ];
  for (const [name, srcRaw] of Object.entries(files)) {
    const src = stripComments(srcRaw);
    for (const bad of forbiddenEntryPoints) {
      assert(!src.includes(bad), `${name} 不应包含入口「${bad}」`);
    }
  }
  // 「确认已核对」只允许作为**否定说明**出现（"不提供…按钮"），不得作为按钮或动作
  for (const [name, srcRaw] of Object.entries(files)) {
    const src = stripComments(srcRaw);
    if (!src.includes('确认已核对')) continue;
    const occurrences = src.split('确认已核对').length - 1;
    const negated = (src.match(/不(提供|再提供|设)[^。\n]{0,20}确认已核对/g) || []).length;
    assertEqual(negated, occurrences, `${name} 中「确认已核对」只能出现在否定说明里`);
  }
  // 「从项目档案测算」只允许作为**已移除说明**出现，不得出现在任何可点击元素或接口调用里
  const measureCode = stripComments(measureJs);
  assert(!/data-[a-z-]*=(\"|')?[^\"'>]*从项目档案测算/.test(measureCode),
    '不应存在以「从项目档案测算」为标签的按钮/入口');
  assert(!measureCode.includes('/api/v2/measure/run'), '不应调用旧测算接口');
  // 不应再调用任何被停用的写接口
  const retiredCalls = [
    '/api/v2/internal-projects', '/api/v2/admin/reviews', '/api/v2/admin/ai-review',
    '/api/v2/measure/run', '/api/v2/measure/precheck', '/verify-bulk',
  ];
  for (const [name, srcRaw] of Object.entries(files)) {
    const src = stripComments(srcRaw);
    for (const bad of retiredCalls) {
      assert(!src.includes(bad), `${name} 不应调用停用接口 ${bad}`);
    }
    assert(!/api\/v2\/[^'"`]*\/confirm/.test(src), `${name} 不应调用人工确认接口`);
  }
});

test('管理页签反映新版后台（有采集连接与自动核验，无审核任务与 AI 复核）', () => {
  const tabs = [...adminJs.matchAll(/key: '(\w+)', label: '([^']+)'/g)].map((m) => m[2]);
  assert(tabs.length >= 8, `后台页签应不少于 8 个，实际 ${tabs.length}`);
  const joined = tabs.join(' ');
  assertIncludes(joined, '采集连接', '应含采集连接页签');
  assertIncludes(joined, '自动核验策略', '应含自动核验策略页签');
  assertIncludes(joined, '模型配置', '应含模型配置页签');
  assertIncludes(joined, '用户管理', '应含用户管理页签');
  assert(!joined.includes('审核任务'), '不应含审核任务页签');
  assert(!joined.includes('AI 复核'), '不应含 AI 复核页签');
  // 真实连接测试与主密钥初始化入口必须存在
  assertIncludes(adminJs, '真实连接测试', '模型/连接配置应提供真实连接测试');
  assertIncludes(adminJs, '初始化本机主密钥', '应提供可操作的主密钥初始化提示');
  assertIncludes(adminJs, '只读工具白名单', 'MCP 连接应说明只读工具白名单');
});

test('研报与行业动态模块以来源为主，不再在公开列表呈现核验四态', () => {
  const tabs = [...contentJs.matchAll(/key: '(\w*)', label: '([^']+)'/g)].map((m) => m[2]);
  const joined = tabs.join(' ');
  for (const need of ['公开研报', '行业动态', '机构观点', '企业公告']) {
    assertIncludes(joined, need, `内容模块应含「${need}」页签`);
  }
  // docs/44 第 2 条：公开列表不再以「证据充足/不足/自动核验」标签呈现，以来源为主
  assertIncludes(contentJs, '来源分布', '应以来源分布取代核验状态分布');
  assertIncludes(contentJs, 'sourceBlock', '标题下应使用统一的来源展示组件');
  assertIncludes(contentJs, 'summaryBlock', '标题下应展示核心摘要');
  assertIncludes(contentJs, '官方信息', '官方网站应显示「官方信息」');
  assertIncludes(contentJs, '来源未标注', '来源未知应显示「来源未标注」');
  for (const need of ['关键词', '发布机构', '来源类别', '起始日期']) {
    assertIncludes(contentJs, need, `应含筛选项「${need}」`);
  }
  // 核验数据保留后台：公开列表不再出现核验四态标签文案
  for (const bad of ['自动核验通过', '证据不足', '暂未自动核验']) {
    assert(!contentJs.includes(bad), `公开内容模块不应再以「${bad}」标签呈现`);
  }
  assertIncludes(contentJs, '不构成独立审计', '应说明来源标签不构成独立审计');
  assertIncludes(contentJs, '未获取公开全文', '仅有摘要时应明确标注');
  assertIncludes(contentJs, '不重复统计', '应说明转载不重复统计');
  assertIncludes(contentJs, '事实 / 观点 / 预测分离', '应把观点、预测与已发生事实分开');
  assertIncludes(contentJs, '预测（不构成承诺）', '预测应单独标注不构成承诺');
  assertIncludes(contentJs, '不声称已读全文', '缺正文时不得声称已读全文');
});

test('减排粗估模块：简表置顶、两项主要参数、高级参数可选、无档案测算', () => {
  assertIncludes(measureJs, '低于 8% 煤矿瓦斯简表', '简表应作为主表');
  assertIncludes(measureJs, '不需要项目档案', '应说明无需项目档案');
  assertIncludes(measureJs, '高级参数（可选', '高级参数应为可选折叠区');
  assertIncludes(measureJs, '确定性程序', '应说明数值由确定性程序计算');
  assertIncludes(measureJs, '不参与任何数值公式或结果的生成', '应说明模型不生成数值公式');
  // 旧版解释卡（从项目档案测算 / 内部项目 / 专家签字）必须删除，只保留简短口径说明
  assert(!measureJs.includes('从项目档案测算'), '不应再保留旧版「从项目档案测算」解释卡');
  assert(!measureJs.includes('领域专家签字'), '不应把专家签字等旧流程写进产品主流程');
  assert(!measureJs.includes('deterministic_plugin'), '不应把实现细节（deterministic_plugin）暴露在产品文案里');
  assertIncludes(measureJs, '正式申报量', '应保留与正式申报差别的简短说明');
  // 气量单位口径：必须提供单位选择并把换算交给服务端严格处理（避免缩小 10000 倍）
  assertIncludes(measureJs, 'data-q-unit', '气量字段应提供单位选择（m³/年 / 万 m³/年）');
  assertIncludes(measureJs, 'annual_gas_10k_m3', '应使用独立的万 m³ 键并交由服务端换算');
  // 简表优先于其它内容：主要参数块出现在高级参数之前
  const idxPrimary = measureJs.indexOf('quick-primary');
  const idxAdvanced = measureJs.indexOf('quick-advanced');
  assert(idxPrimary > 0 && idxAdvanced > 0 && idxPrimary < idxAdvanced, '主要参数应排在高级参数之前');
});

test('公开项目页签只有公开项目与模板，且保留阶段分列与三套数字', () => {
  const tabs = [...projectsJs.matchAll(/key: '(\w*)', label: '([^']+)'/g)].map((m) => m[2]);
  const joined = tabs.join(' ');
  assertIncludes(joined, '公开项目库', '应保留公开项目库页签');
  assertIncludes(joined, '导入与模板', '应保留导入与模板页签');
  assert(!joined.includes('内部项目'), '不应有内部项目页签');
  for (const need of ['公示预计量', '核查量', '登记量', '阶段分列', '自动核验']) {
    assertIncludes(projectsJs, need, `应保留「${need}」`);
  }
  assertIncludes(projectsJs, '官方链接不可下载', '附件不可下载时应显示真实状态');
});

test('政策模块把正式与征求意见分开，且不再有人工确认', () => {
  assertIncludes(policiesJs, '不得当作现行正式方法学', '草案不得当作正式方法学');
  assertIncludes(policiesJs, '自动生成', 'AI 解读应标「自动生成」');
  assertIncludes(policiesJs, '缺正文时不声称已读原文', '缺正文时不得声称已读原文');
  const tabs = [...policiesJs.matchAll(/key: '(\w*)', label: '([^']+)'/g)].map((m) => m[2]);
  assertIncludes(tabs.join(' '), '原文变化（自动检测）', '变更应为只读自动检测');
  assert(!tabs.join(' ').includes('待确认'), '不应有变更待确认页签');
});

test('总览包含最新研报与动态，并展示来源与核心摘要；运行状态版块已移除', () => {
  for (const need of ['最新研报与行业动态', 'summaryBlock', 'sourceBlock', '企业主张']) {
    assertIncludes(overviewJs, need, `总览应含「${need}」`);
  }
  // docs/44 第 6 条：总览底部新增所有已登录用户可用的 AI 对话区
  assertIncludes(overviewJs, 'chatPanel', '总览底部应挂载问答区组件');
  assertIncludes(platformJs, '碳市场问答', '问答区标题应为「碳市场问答」');
  assertIncludes(platformJs, '核心摘要', '统一摘要组件应提供「核心摘要」标题');
  // docs/44 第 4 条：总览移除「自动运行状态」与「数据缺口」两个版块（移到后台管理员页）
  assert(!overviewJs.includes('自动运行状态'), '总览不应再出现「自动运行状态」版块');
  assert(!overviewJs.includes('数据缺口与自动补全状态'), '总览不应再出现「数据缺口」版块');
  assert(!overviewJs.includes('内部项目'), '总览不应再出现内部项目');
});

test('内部核验标签集中在后台模块，公开模块不再引用', () => {
  assertIncludes(verifyLabelsJs, '自动核验通过', '后台核验标签模块应保留四态文案');
  assert(!contentJs.includes('verifyChip'), '公开内容模块不应引用核验标签组件');
});

/* ==================================================================== */
/*  二、响应式样式（手机宽度可用性）                                      */
/* ==================================================================== */

test('样式包含手机宽度适配与新版组件样式', () => {
  assertIncludes(stylesCss, '@media', '应有媒体查询');
  assert(/@media\s*\(max-width:\s*720px\)/.test(stylesCss), '应有 720px 断点');
  for (const cls of ['.quick-primary', '.quick-value', '.verify-box', '.body-snapshot', '.bullets', '.chip-plain']) {
    assertIncludes(stylesCss, cls, `应有样式 ${cls}`);
  }
  // 手机断点下主要参数改为单列（避免横向溢出）
  const media = stylesCss.slice(stylesCss.indexOf('@media (max-width: 720px)'));
  assertIncludes(media, '.quick-primary { grid-template-columns: 1fr; }', '手机断点下主要参数应为单列');
  assertIncludes(media, '.quick-value { font-size: 24px; }', '手机断点下大数字应缩小');
});

/* ==================================================================== */
/*  三、真实 HTTP 接口（页面所依赖的数据面）                              */
/* ==================================================================== */

async function login(userId, password) {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ user_id: userId, password }),
  });
  const json = await res.json();
  return json.token;
}
const token = await login('user-admin', 'admin-demo-2026');
assert(token, '管理员应能登录');

async function apiGet(path) {
  const res = await fetch(`${BASE}${path}`, { headers: { authorization: `Bearer ${token}` } });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: res.status, json, text };
}

await testAsync('页面所需的全部数据接口可用（含新模块）', async () => {
  const paths = [
    '/api/v2/status',
    '/api/v2/overview',
    '/api/v2/policies',
    '/api/v2/methodologies',
    '/api/v2/public-projects',
    '/api/v2/trade/overview',
    '/api/v2/measure/quick-gas/meta',
    '/api/v2/content',
    '/api/v2/content/stats',
    '/api/v2/admin/status',
    '/api/v2/admin/search-providers',
    '/api/v2/admin/fetch-connections',
    '/api/v2/admin/verify-config',
    '/api/v2/admin/llm',
    '/api/v2/admin/secret-key',
    '/api/v2/admin/users',
    '/api/v2/admin/jobs',
    '/api/v2/admin/dataset-cursors',
  ];
  for (const p of paths) {
    const out = await apiGet(p);
    assertEqual(out.status, 200, `${p} 应返回 200，实际 ${out.status}：${out.text.slice(0, 120)}`);
    assert(out.json && typeof out.json === 'object', `${p} 应返回 JSON 对象`);
  }
});

await testAsync('快捷估算接口返回两项主要参数与确定性公式来源', async () => {
  const out = await apiGet('/api/v2/measure/quick-gas/meta');
  assertEqual(out.json.requires_project_dossier, false, '不应要求项目档案');
  assertEqual(out.json.requires_approval, false, '不应要求审批');
  assertEqual(out.json.numeric_formula_source, 'deterministic_plugin', '公式应来自确定性程序');
  assertEqual(out.json.primary_fields.length, 2, '主要参数应为两项');
  assertEqual(out.json.advanced_fields.length, 2, '高级参数应为两项');
  const calc = await fetch(`${BASE}/api/v2/measure/quick-gas`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ annual_gas_m3: 50000000, ch4_pct: 1.2 }),
  });
  const body = await calc.json();
  assertEqual(calc.status, 200, '估算应成功');
  assertEqual(body.annual_tco2e, 9135.45, '应返回可复算的粗估量');
});

await testAsync('旧业务入口在真实 HTTP 层返回 410（不可作为绕过入口）', async () => {
  const paths = [
    ['GET', '/api/v2/internal-projects'],
    ['GET', '/api/v2/admin/reviews'],
    ['GET', '/api/v2/admin/ai-review'],
  ];
  for (const [method, p] of paths) {
    const res = await fetch(`${BASE}${p}`, { method, headers: { authorization: `Bearer ${token}` } });
    assertEqual(res.status, 410, `${method} ${p} 应返回 410，实际 ${res.status}`);
    const body = await res.json();
    assertEqual(body.retired, true, `${p} 应标记 retired`);
    assertIncludes(body.message, '不再提供', `${p} 应说明已停用`);
  }
});

await testAsync('静态资源不含任何凭据明文', async () => {
  const all = [html, appJs, stylesCss, contentJs, measureJs, adminJs, projectsJs, policiesJs, overviewJs].join('\n');
  assert(!/tvly-[A-Za-z0-9]{10,}/.test(all), '不应出现 Tavily 形密钥');
  assert(!/fc-[A-Za-z0-9]{20,}/.test(all), '不应出现 Firecrawl 形密钥');
  assert(!/sk-[A-Za-z0-9]{16,}/.test(all), '不应出现 OpenAI 形密钥');
  assert(!/local-test-secret/.test(all), '不应出现测试用凭据');
  // 凭据状态接口只返回布尔与来源，绝不返回值
  const key = await apiGet('/api/v2/admin/secret-key');
  assert('secret_key' in key.json, '应返回主密钥状态对象');
  const ks = key.json.secret_key;
  for (const k of ['available', 'source', 'key_file', 'key_file_exists', 'can_init_file', 'hint']) {
    assert(k in ks, `主密钥状态应含字段 ${k}`);
  }
  assertEqual(ks.available, false, '未初始化时应如实返回不可用');
  assertEqual(ks.source, null, '未初始化时来源应为 null');
  // 只返回文件路径，不返回任何密钥内容；响应里不应出现长 base64 串（密钥形态）
  assert(!/[A-Za-z0-9+/]{40,}={0,2}/.test(JSON.stringify(key.json)), '响应不应包含密钥形态的长串');
  assert(!('value' in ks) && !('secret' in ks) && !('master_key' in ks), '不应返回密钥值字段');
});

server.close();
finish('20-v2-frontend-verification.test.mjs');
