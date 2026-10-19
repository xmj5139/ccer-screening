/**
 * 前端骨架一致性检查（纯函数，便于测试与自检）
 * ============================================================================
 * 检查目标：index.html 中带 `hidden` 属性的顶层容器，必须与 app.js 的启动逻辑一致。
 *
 * 为什么需要这个检查：
 *   `hidden` 属性会被浏览器 UA 样式表翻译成 `display: none`，而 `.view` 等类名没有
 *   显式声明 `display`，因此无法覆盖它。若 index.html 里给 #view 加了 hidden
 *   而 boot() 忘了解除，页面就会「顶栏和免责声明都在、内容区一片空白」——
 *   这正是本项目实际发生过的一次缺陷。
 *
 * 本模块不依赖 DOM，也不派生任何子进程，可在测试与自检脚本中直接调用。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** 启动时应当由 boot() 隐藏的容器 */
export const HIDDEN_BY_BOOT = ['boot'];
/** 启动时由其他函数按需显隐的容器 */
export const HIDDEN_BY_OTHER = ['toast'];
/** 必须在 boot() 中被解除 hidden 的顶层容器（顺序无关，由检查函数排序比较） */
export const MUST_UNHIDE = ['disclaimer', 'topbar', 'view'];

/**
 * 从源码文本中抽取检查所需的全部事实。
 * @param {string} html web/index.html 内容
 * @param {string} js   web/app.js 内容
 */
export function analyzeFrontend(html, js) {
  const errors = [];
  const warnings = [];

  // 1) 找出带 hidden 属性且有 id 的元素（属性顺序不固定，两个方向都扫）
  const hiddenIds = new Set();
  for (const m of html.matchAll(/<[^>]*\bid="([^"]+)"[^>]*\bhidden\b[^>]*>/g)) hiddenIds.add(m[1]);
  for (const m of html.matchAll(/<[^>]*\bhidden\b[^>]*\bid="([^"]+)"[^>]*>/g)) hiddenIds.add(m[1]);
  const unique = [...hiddenIds];

  if (!unique.includes('view')) {
    warnings.push('index.html 中未找到带 hidden 的 #view 容器；若已不再使用 hidden 属性，请同步更新本检查的期望集合。');
  }

  // 2) 取 boot() 函数体（到下一个顶层 `}` 为止）
  const bootMatch = js.match(/async function boot\(\)\s*\{([\s\S]*?)\n\}/);
  if (!bootMatch) {
    errors.push('app.js 中未找到 async function boot() 函数体，无法校验启动逻辑。');
    return { ok: false, errors, warnings, hiddenIds: unique, mustUnhide: [] };
  }
  const bootBody = bootMatch[1];

  // 3) 期望集合一致性：hidden 容器集合变化时必须显式更新本检查，避免静默漏检
  const mustUnhide = unique
    .filter((id) => !HIDDEN_BY_BOOT.includes(id) && !HIDDEN_BY_OTHER.includes(id))
    .sort();
  const expected = [...MUST_UNHIDE].sort();
  if (JSON.stringify(mustUnhide) !== JSON.stringify(expected)) {
    errors.push(
      `带 hidden 的顶层容器集合发生变化：期望 ${expected.join('、')}，实际 ${mustUnhide.join('、') || '（空）'}。` +
      '请同步更新 boot() 的解除逻辑与本检查的期望集合。'
    );
  }

  // 4) 逐个确认 boot() 真的解除了 hidden
  for (const id of mustUnhide) {
    if (!bootBody.includes(`$('#${id}').hidden = false`)) {
      errors.push(`boot() 未解除 #${id} 的 hidden 属性，该容器将保持 display:none（表现为页面空白）。`);
    }
  }

  // 5) 加载提示应被隐藏；toast 应由 toast() 管理
  if (!bootBody.includes("$('#boot').hidden = true")) {
    errors.push("boot() 未隐藏加载提示 #boot。");
  }
  if (!js.includes('t.hidden = false;') || !js.includes('t.hidden = true;')) {
    errors.push('toast() 未同时实现显示与隐藏（应设置 t.hidden = false / true）。');
  }

  // 6) app.js 里用 $('#id') 引用的静态元素必须存在于 index.html
  const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  const dynamicIds = new Set([
    'match-result', 'elig-result', 'calc-result', 'report-result', 'cmp-result',
    'cmp-a', 'cmp-b', 'rpt-basedate', 'rpt-price',
  ]);
  for (const m of js.matchAll(/\$\('#([a-z0-9_-]+)'\)/gi)) {
    const id = m[1];
    if (dynamicIds.has(id)) continue;
    if (!htmlIds.has(id)) errors.push(`app.js 引用了 index.html 中不存在的 #${id}`);
  }

  return { ok: errors.length === 0, errors, warnings, hiddenIds: unique, mustUnhide };
}

/** 读取项目根目录下的前端文件并检查 */
export function checkFrontend(projectRoot) {
  const html = readFileSync(join(projectRoot, 'web', 'index.html'), 'utf8');
  const js = readFileSync(join(projectRoot, 'web', 'app.js'), 'utf8');
  return analyzeFrontend(html, js);
}
