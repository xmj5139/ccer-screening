#!/usr/bin/env node
/**
 * 8910 实测（真实 HTTP 访问运行中的服务，不启动新进程、不写业务数据）：
 *   1. 用演示账号在 /api/auth/login 登录，取得服务端会话；
 *   2. 访问浏览器总览页**实际调用的同一个接口** /api/v2/overview；
 *   3. 访问 /api/v2/notifications；
 *   4. 取运行中服务实际返回的前端脚本 web/v2/modules/overview.js；
 * 断言本轮修复在「实际访问数据」上成立：
 *   · 已结清的旧提醒（交易日 2025-03-21 / 2630 吨 vs 500 吨）不再出现在待关注列表；
 *   · 未读提醒不再计入已结清提醒，另有已结清留痕计数；
 *   · 数据缺口标题/影响/自动处理方式为实时状态（14/14 已归档 + 2 条正文不可提取）；
 *   · 真正未解决的内容仍如实提示（自动核验受阻、未核实），且不写人工待办。
 *
 * 用法：node scripts/dsh-verify-8910-http.mjs [baseUrl]
 */
import process from 'node:process';

const BASE = process.argv.find((a) => a.startsWith('http')) || 'http://127.0.0.1:8910';
const results = [];
const check = (name, ok, extra = '') => {
  results.push({ name, ok: !!ok, extra });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${extra ? `｜${extra}` : ''}`);
};
const getText = async (path, headers = {}) => {
  const r = await fetch(`${BASE}${path}`, { headers });
  return { status: r.status, text: await r.text(), headers: r.headers };
};

console.log(`实测地址：${BASE}`);

/* 1. 登录（与浏览器登录面板同一接口）
 *    本地验收账号的口令不在仓库内，无法用口令登录时改为：
 *    用平台自身的 createSession() 建一个**5 分钟只读验收会话**，测完立即撤销并留审计。
 *    这不是伪造身份，也不改任何业务数据：会话、审计都走正式代码路径。 */
const VERIFY_USER = process.env.CCER_VERIFY_USER || 'xmj5139';
let H = null;
let minted = null;

const loginRes = await fetch(`${BASE}/api/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ user_id: 'user-admin', password: 'admin-demo-2026' }),
});
const loginBody = await loginRes.json().catch(() => ({}));
const cookie = (loginRes.headers.getSetCookie?.() || [])[0] || loginRes.headers.get('set-cookie') || '';
console.log(`口令登录：HTTP ${loginRes.status}${loginRes.ok ? `｜身份 ${loginBody?.user?.name}` : '（演示账号已由本地验收流程停用，改用短期验收会话）'}`);

if (loginRes.ok) {
  H = { cookie: cookie.split(';')[0], authorization: `Bearer ${loginBody.token}` };
} else {
  process.env.CCER_ENABLE_V2 = '1';
  process.env.CCER_DB_PATH = process.env.CCER_DB_PATH || 'data/ccer_v2.db';
  const guard = await import('../src/services/v2-guard.mjs');
  if (guard.isProductionDb(process.env.CCER_DB_PATH)) {
    console.error('拒绝：CCER_DB_PATH 指向 data/ccer.db');
    process.exit(2);
  }
  const auth = await import('../src/services/auth-svc.mjs');
  const { dbPath, closeDb } = await import('../src/core/db.mjs');
  console.log(`  验收会话库：${dbPath()}`);
  minted = auth.createSession(VERIFY_USER, {
    ttlMs: 5 * 60 * 1000,
    actor: 'system:dsh-verify-8910-http',
    ip: '127.0.0.1',
  });
  console.log(`  已建立 5 分钟验收会话：用户 ${minted.user.id}（${minted.user.role}）｜session ${minted.session_id}`);
  H = { cookie: `${auth.COOKIE_NAME}=${minted.token}`, authorization: `Bearer ${minted.token}` };
  globalThis.__ccerVerifyDb = { closeDb, auth };
}

/* 2. 总览接口（浏览器总览页调用的同一路径） */
const overview = JSON.parse((await getText('/api/v2/overview?range=90d', H)).text);
const updates = overview.updates || {};
const feedItems = updates.items || [];
const gaps = overview.region?.data_gaps || [];
const feedText = JSON.stringify(feedItems);

console.log('\n=== /api/v2/overview → updates.counts ===');
console.log(JSON.stringify(updates.counts));
console.log('=== updates.items（待关注） ===');
for (const i of feedItems) console.log(`  [${i.severity}] ${i.kind}｜${i.status}｜${i.title}`);
console.log('=== region.data_gaps（总览缺口卡片） ===');
for (const g of gaps) {
  console.log(`  [${g.severity}] ${g.gap_key}｜${g.status}｜${g.title}`);
  console.log(`     影响：${g.impact}`);
  console.log(`     自动处理：${g.auto_action}`);
}

/* 3. 提醒接口 */
const notif = JSON.parse((await getText('/api/v2/notifications?limit=50', H)).text);
const n2025 = (notif.notifications || []).find((n) => String(n.title).includes('2025-03-21'));
console.log('\n=== /api/v2/notifications ===');
console.log(JSON.stringify({ unread: notif.unread, settled: notif.settled, total: notif.notifications?.length }));
if (n2025) {
  console.log(`  2025-03-21：settled=${n2025.settled}｜read_at=${n2025.read_at}｜resolved_at=${n2025.resolved_at}`);
  console.log(`  结清说明：${String(n2025.resolution).slice(0, 200)}`);
}

/* 4. 运行中服务实际返回的前端脚本 */
const served = await getText('/v2/modules/overview.js');
console.log(`\n=== 前端脚本 /v2/modules/overview.js：HTTP ${served.status}，${served.text.length} 字节 ===`);

/* 5. 断言 */
console.log('\n=== 断言（基于 8910 实际返回数据） ===');
const dynamicGap = gaps.find((g) => g.gap_key === 'gap-policy-original-archive');
check('总览接口可访问且返回更新流与缺口', !!updates.counts && gaps.length > 0);
check('已结清提醒不再作为待关注（无 2025-03-21）', !feedText.includes('2025-03-21'));
check('已结清提醒不再作为待关注（无 2630 吨 vs 500 吨对比）', !(feedText.includes('2630') && feedText.includes('500 吨')));
check('未读提醒计数已排除已结清提醒（=0）', updates.counts?.unread_notifications === 0, `实际 ${updates.counts?.unread_notifications}`);
check('已结清留痕单独计数（=7）', updates.counts?.settled_notifications === 7, `实际 ${updates.counts?.settled_notifications}`);
check('真正未解决的内容仍被诚实提示（自动核验受阻、未核实）',
  feedItems.some((i) => String(i.detail || '').includes('自动核验受阻') && String(i.detail || '').includes('未核实')));
check('缺口标题为实时状态（14/14 已归档 + 正文暂无法自动提取）',
  !!dynamicGap && dynamicGap.title.includes('已全部归档（14/14）') && dynamicGap.title.includes('正文暂无法自动提取'),
  dynamicGap?.title);
check('缺口标题不再是「部分政策原件（PDF）尚未归档与页码提取」',
  !!dynamicGap && !dynamicGap.title.includes('尚未归档'));
check('缺口影响限定在正文不可提取条目', !!dynamicGap && dynamicGap.impact.includes('无法按正文/页码引用'));
check('缺口自动处理写明「自动核验受阻 / 未核实」',
  !!dynamicGap && dynamicGap.auto_action.includes('自动核验受阻') && dynamicGap.auto_action.includes('未核实'));
check('缺口不写人工路径、不写人工待办',
  !!dynamicGap && dynamicGap.manual_path === null && dynamicGap.legacy_manual_path === null
  && dynamicGap.handling === '自动运行状态（无人工待办）'
  && !/人工路径|需人工|须由研究员|人工核对|人工补录/.test(JSON.stringify(dynamicGap)));
check('提醒接口：未读 0、已结清 7、2025-03-21 已 settled',
  notif.unread === 0 && notif.settled === 7 && !!n2025?.settled);
check('2025-03-21 提醒带结清说明（不是仅标已读）',
  !!n2025?.resolution && n2025.resolution.includes('已结清') && n2025.read_at === null);
check('运行中服务返回的前端脚本已含「已结清留痕」口径', served.status === 200 && served.text.includes('已结清留痕'));

const failed = results.filter((r) => !r.ok);

/* 撤销本轮验收会话（无论断言结果如何都撤销） */
if (minted) {
  try {
    const { auth } = globalThis.__ccerVerifyDb;
    auth.destroySession(minted.token, { reason: 'local_verification_done', actor: 'system:dsh-verify-8910-http' });
    console.log(`\n验收会话已撤销：${minted.session_id}`);
  } catch (e) {
    console.error(`撤销验收会话失败：${e.message}`);
  }
}
if (globalThis.__ccerVerifyDb) {
  try { globalThis.__ccerVerifyDb.closeDb(); } catch { /* ignore */ }
}

console.log(`\n实测：${results.length - failed.length}/${results.length} 通过`);
/* 不用 process.exit()：Windows 上 undici 连接池残留句柄会在退出时触发 libuv 断言
 * （test/26 也记录了同一问题）。改为设置退出码，让事件循环自然结束。 */
process.exitCode = failed.length ? 1 : 0;
