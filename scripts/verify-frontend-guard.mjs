#!/usr/bin/env node
/**
 * 自检：证明「前端骨架一致」检查确实有效（不是空转）。
 * ============================================================================
 * 做法：对同一份 index.html，分别用「正常版 app.js」与「移除 #view 解除行的缺陷版」
 *       调用 analyzeFrontend()，确认前者通过、后者报错并指明 #view。
 *
 * 全程在进程内完成，不写临时文件、不派生任何子进程。
 *
 * 用法：node scripts/verify-frontend-guard.mjs
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeFrontend } from '../src/tools/frontend-skeleton.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(ROOT, 'web', 'index.html'), 'utf8');
const js = readFileSync(join(ROOT, 'web', 'app.js'), 'utf8');

const FIX_LINE = "$('#view').hidden = false;";

console.log('检查 1：当前源码应当通过');
const good = analyzeFrontend(html, js);
console.log(`  结果：${good.ok ? '✅ 通过' : '❌ 失败'}`);
if (!good.ok) good.errors.forEach((e) => console.log(`    · ${e}`));
if (good.warnings.length) good.warnings.forEach((w) => console.log(`    ⚠ ${w}`));
console.log(`  识别到的 hidden 容器：${good.hiddenIds.join('、')}`);
console.log(`  必须在 boot() 中解除：${good.mustUnhide.join('、')}`);

console.log('');
console.log('检查 2：移除修复行后应当失败，且必须指明 #view');
const brokenJs = js.split('\n').filter((l) => l.trim() !== FIX_LINE).join('\n');
if (brokenJs === js) {
  console.error(`  ❌ 未能构造缺陷版本（app.js 中找不到「${FIX_LINE}」），反向验证无效`);
  process.exit(1);
}
const bad = analyzeFrontend(html, brokenJs);
const caught = !bad.ok && bad.errors.some((e) => e.includes('#view'));
console.log(`  结果：${caught ? '✅ 正确捕获缺陷' : '❌ 未能捕获缺陷（检查是空转的）'}`);
bad.errors.forEach((e) => console.log(`    · ${e}`));

console.log('');
console.log('检查 3：把 #topbar 的解除行也移除，应当同时报出 #topbar');
const brokenJs2 = brokenJs.split('\n').filter((l) => l.trim() !== "$('#topbar').hidden = false;").join('\n');
const bad2 = analyzeFrontend(html, brokenJs2);
const caught2 = !bad2.ok && bad2.errors.some((e) => e.includes('#topbar'));
console.log(`  结果：${caught2 ? '✅ 正确捕获 #topbar' : '❌ 未捕获 #topbar'}`);

console.log('');
console.log('检查 4：改坏 index.html（新增一个带 hidden 的顶层容器），应当报出集合变化');
const brokenHtml = html.replace('<div id="toast" class="toast" hidden></div>',
  '<div id="toast" class="toast" hidden></div>\n<div id="oops" hidden></div>');
const bad3 = analyzeFrontend(brokenHtml, js);
const caught3 = !bad3.ok && bad3.errors.some((e) => e.includes('集合发生变化'));
console.log(`  结果：${caught3 ? '✅ 正确捕获集合变化' : '❌ 未捕获集合变化'}`);

const allOk = good.ok && caught && caught2 && caught3;
console.log('');
console.log(allOk ? '结论：前端骨架检查有效，且能捕获三类缺陷。' : '结论：检查存在漏洞，需要修正。');
process.exit(allOk ? 0 : 1);
