/**
 * v2.6 测试 69（docs/44 第 1、3、8 条）：前端命名、摘要/对话入口与显示清理
 * ============================================================================
 * 覆盖（无浏览器环境下的等价检查：读取真实下发的静态资源）：
 *   · 可见品牌统一「碳市场信息平台」（标题 / 登录注册 / 导航 / 页脚 / 顶栏）；
 *   · 采集信息在标题下展示核心摘要；行情表只做确定性区间汇总（不逐行调用模型）；
 *   · 后台有「运行与内容维护」页签（摘要批次、缺口、修订、官方域名）；
 *   · 空值不是 0、单位一致、长标题/长 URL 不竖排、390px 无整体横向溢出。
 */
import {
  setupV2, test, testAsync, assert, assertIncludes, finish,
} from './v2-helpers.mjs';

const ctx = await setupV2({ withPublicDemo: false });
void ctx;

console.log('\n[v2-69] 前端命名、摘要与对话入口、显示清理');

process.env.CCER_AUTH_MODE = 'session';
const { server } = await import('../src/server.mjs');
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;
async function getText(path) {
  const res = await fetch(`${BASE}${path}`);
  assert(res.status === 200, `${path} 应可访问，实际 ${res.status}`);
  return res.text();
}

const html = await getText('/v2');
const appJs = await getText('/v2/app.js');
const platformJs = await getText('/v2/platform.js');
const overviewJs = await getText('/v2/modules/overview.js');
const adminJs = await getText('/v2/modules/admin.js');
const maintenanceJs = await getText('/v2/modules/maintenance.js');
const contentJs = await getText('/v2/modules/content.js');
const stylesCss = await getText('/v2/styles.css');
const summarySvc = await (await import('node:fs/promises')).readFile(
  new URL('../src/services/summary-svc.mjs', import.meta.url), 'utf8'
);
const marketSvc = await (await import('node:fs/promises')).readFile(
  new URL('../src/services/market-summary-svc.mjs', import.meta.url), 'utf8'
);

/* ==================================================================== */
/*  一、命名统一                                                         */
/* ==================================================================== */

test('浏览器标题 / 描述为「碳市场信息平台」', () => {
  assertIncludes(html, '碳市场信息平台', '浏览器标题应为碳市场信息平台');
  assert(!html.includes('CCER 公开信息平台'), '不应再出现旧品牌名');
  assertIncludes(html, 'width=device-width', '应含移动端 viewport');
});

test('登录/注册页、顶栏、页脚均使用新品牌名', () => {
  assertIncludes(appJs, '碳市场信息平台', '顶栏标题应为碳市场信息平台');
  assertIncludes(appJs, 'auth-wordmark', '应保留登录页结构');
  assertIncludes(appJs, '碳市场', '登录页品牌字标应更新');
  assertIncludes(appJs, 'CARBON MARKET WORKSPACE', '登录页英文标识应同步更新');
  assertIncludes(appJs, '<footer class="footer">', '应保留页脚');
  assertIncludes(appJs, '碳市场信息平台：', '页脚应以新品牌名开头');
  assert(!appJs.includes('CCER 公开信息平台'), '前端不得再出现旧品牌名');
});

test('导航仍为八个主模块，未因本轮改动增减', () => {
  const mods = [...appJs.matchAll(/key: '(\w+)', label: '([^']+)'/g)].map((m) => m[2]);
  assert(mods.length === 8, `导航应为 8 个模块，实际 ${mods.length}：${mods.join('、')}`);
  assertIncludes(mods.join(' '), '总览');
  assertIncludes(mods.join(' '), '后台管理');
});

/* ==================================================================== */
/*  二、摘要与对话入口                                                   */
/* ==================================================================== */

test('统一摘要组件：标题下展示核心摘要，未生成/失效时如实空态', () => {
  assertIncludes(platformJs, '核心摘要', '应提供「核心摘要」标签');
  assertIncludes(platformJs, '模型生成', '已生成时应标注模型生成');
  assertIncludes(platformJs, '未生成', '未生成时应如实空态');
  assertIncludes(platformJs, '原摘要已失效', '失效摘要不得当作当前摘要显示');
  assertIncludes(platformJs, '输入范围', '应说明摘要依据的输入范围');
});

test('列表页展示核心摘要，且缺失时不向普通用户提示无权限的后台入口', () => {
  for (const [name, src] of [['overview', overviewJs], ['content', contentJs]]) {
    assertIncludes(src, 'summaryBlock', `${name} 列表应在标题下展示核心摘要`);
  }
  // 后台提示只对管理员显示（普通用户看不到无权限入口）
  assertIncludes(platformJs, "state.user?.role === 'admin'", '后台补齐提示应只对管理员出现');
});

test('总览底部对所有已登录用户提供问答区（输入 / 发送 / 加载 / 错误 / 清空 / 历史）', () => {
  for (const need of ['碳市场问答', 'chat-send', 'chat-clear', 'chat-input', '发送', '清空对话']) {
    assertIncludes(platformJs, need, `问答区应包含「${need}」`);
  }
  for (const need of ['检索中', '请求失败', '已拒答']) {
    assertIncludes(platformJs, need, `问答区应处理「${need}」状态`);
  }
  assertIncludes(platformJs, '来源', '答复应展示来源');
  assertIncludes(platformJs, '搜索摘要', '只获得摘要时应标记「搜索摘要」');
  // 历史消息只保存在内存（不做任何浏览器本地持久化）
  assert(!platformJs.includes('localStorage.getItem'), '对话历史不得写入 localStorage');
  assert(!platformJs.includes('localStorage.setItem'), '对话历史不得写入 localStorage');
  assert(!platformJs.includes('sessionStorage'), '对话历史不得写入 sessionStorage');
  assertIncludes(overviewJs, 'chatPanel', '总览应挂载问答区');
});

test('行情表只在页面标题下汇总筛选区间，逐行不调用模型', () => {
  assertIncludes(marketSvc, 'model_calls: 0', '区间汇总必须标注零模型调用');
  assertIncludes(marketSvc, '不逐行调用模型', '应说明不逐行调用模型');
  assertIncludes(platformJs, 'market-summary', '前端应调用确定性区间汇总接口');
  assertIncludes(overviewJs, 'rangeSummaryBar', '总览行情卡应展示区间口径条');
  // summary-svc 的**缓存读写段**不调用模型（只有「三、摘要生成」写路径才调用）
  const readStart = summarySvc.indexOf('二、缓存读写');
  const writeStart = summarySvc.indexOf('三、摘要生成');
  assert(readStart > 0 && writeStart > readStart, '摘要服务应区分读缓存段与生成段');
  const readPart = summarySvc.slice(readStart, writeStart);
  assert(!readPart.includes('callVerifyModel'), '摘要读路径不得包含模型调用');
  assert(!readPart.includes('fetch('), '摘要读路径不得发起网络请求');
});

/* ==================================================================== */
/*  三、后台维护入口                                                     */
/* ==================================================================== */

test('后台新增「运行与内容维护」页签，含缺口 / 摘要 / 修订 / 官方域名', () => {
  const tabs = [...adminJs.matchAll(/key: '(\w+)', label: '([^']+)'/g)].map((m) => m[2]);
  assertIncludes(tabs.join(' '), '运行与内容维护', '后台应有「运行与内容维护」页签');
  for (const need of ['数据缺口与原因', '核心摘要覆盖', '公开内容修订（覆盖层）', '修订历史与恢复', '官方域名登记', '平台问答运行情况']) {
    assertIncludes(maintenanceJs, need, `维护页应含「${need}」`);
  }
  for (const ep of ['/api/v2/admin/maintenance/retry', '/api/v2/admin/summaries/run', '/api/v2/admin/maintenance/edit', '/api/v2/admin/maintenance/revisions/']) {
    assertIncludes(maintenanceJs, ep, `维护页应调用 ${ep}`);
  }
  assertIncludes(maintenanceJs, '轮询', '摘要批次应通过任务轮询而非同步等待');
  assertIncludes(maintenanceJs, '管理员修订', '修订应标记「管理员修订」');
});

/* ==================================================================== */
/*  四、显示清理：空值 / 单位 / 长文本 / 390px                           */
/* ==================================================================== */

test('样式：摘要行高清晰、长标题与长 URL 不竖排、390px 无整体横向溢出', () => {
  for (const cls of ['.summary-block', '.summary-text', '.summary-label', '.chat-log', '.chat-bubble', '.range-summary']) {
    assertIncludes(stylesCss, cls, `应有样式 ${cls}`);
  }
  assertIncludes(stylesCss, 'overflow-wrap: anywhere', '长文本应可断行，不挤成竖字');
  // 短操作按钮不得竖排
  assertIncludes(stylesCss, 'white-space: nowrap', '短操作按钮不得换行');
  // 390px 窄屏：页面整体不横向溢出
  const narrow = stylesCss.slice(stylesCss.indexOf('@media (max-width: 420px)'));
  assert(narrow.length > 0, '应有 420px 断点覆盖 390px 设备');
  assertIncludes(narrow, 'overflow-x: hidden', '窄屏下页面整体不得横向溢出');
  assertIncludes(narrow, '.chat-bubble', '窄屏下对话气泡应适配');
});

await testAsync('数值与日期格式：空值显示「—」而不是 0', async () => {
  const uiJs = await getText('/v2/ui.js');
  assertIncludes(uiJs, "Number.isNaN(Number(v))) return '—';", '空值必须显示「—」而不是 0');
  assertIncludes(uiJs, "return '—';", '日期/数值格式化应统一空态');
});

// 让句柄先落定，避免 Windows 上 libuv 在 exit 时断言失败
server.unref();
await new Promise((r) => setTimeout(r, 50));

finish('69-v2-platform-frontend.test.mjs');
