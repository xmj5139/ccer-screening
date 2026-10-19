/**
 * 38-v2-cea-collect-summary.test.mjs —— 采集任务摘要「skipped」语义回归（CEA 尾项）
 * ============================================================================
 * 真实故障（本机 8912 真实任务留档）：
 *   · 修复前 data/backups/cea-20261014/live-task-research-local.log
 *     （2026-10-15T02:33:15Z，task CEATASK-0mv8xcch8-f7d9fba6）
 *     target=research、elapsed_ms=73446、final_status="skipped"、
 *     summary={ status:"skipped", note:"本次未执行" }、error="真实任务失败：本次未执行"
 *   · 修复后 data/backups/cea-20261014/live-task-research-fixed.log（独立验收方在 8912 复跑）
 *     同目标 → final_status="success"、published=1、note="取得 1 项结果"、error=null
 *   即：该轮真实搜索、取正文、入库确实执行过 73 秒，把「批次真实执行过」判成整批未执行是错的。
 *
 * 根因：summarizeCeaResult 内 `if (out.skipped)` 用真值判断。research 采集器把 skipped
 *   初始化为**逐条跳过清单数组**（cea-collect-svc.mjs 的 `skipped: []`，daily 通道同理），
 *   空数组在 JS 中也是真值 → 任何 research/daily 结果都被当成整批跳过。
 *
 * 纪律（本文件逐条验证，只调用纯函数；不建库、不发网络请求、不碰 8912 服务与密钥）：
 *   1. 只有 `skipped === true`（布尔）才表示「整批未执行」；
 *   2. `skipped: []` 不触发；`skipped: [非空条目]` 不触发（那只是逐条跳过原因清单）；
 *   3. research published>0 → success/partial；published=0 → failed 并给出真实原因；
 *      任何真实执行过的批次都不得显示「本次未执行」。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  finish, test, assert, assertEqual, assertIncludes, assertNotIncludes,
} from './v2-helpers.mjs';

const { summarizeCeaResult } = await import('../src/services/cea-collect-svc.mjs');

const SRC = readFileSync(join(process.cwd(), 'src', 'services', 'cea-collect-svc.mjs'), 'utf8');
const NOT_EXECUTED = '本次未执行';

console.log('\n[v2-38] CEA 采集任务摘要：只有 skipped===true 才是整批跳过（数组不触发）');

/** research 采集器的真实 out 形状（cea-collect-svc.mjs 的初始化字段，逐字对齐） */
function researchOut(over = {}) {
  return {
    job_id: 'JOB-test', channel: null, queries: ['全国碳排放权交易市场 配额 研究 报告'],
    candidates: 0, fetched: 0, published: 0, created: 0, updated: 0,
    skipped: [], failed: [], truncated: false, verified: null, note: null, deadline_shared: false,
    ...over,
  };
}

/* ==================================================================== */
/*  0) 前提：夹具形状与静态契约                                          */
/* ==================================================================== */

test('前提：research 的 skipped 是逐条清单数组（不是布尔标记），用例非空转', () => {
  assert(Array.isArray(researchOut().skipped), 'research skipped 必须是数组，否则本文件用例失去意义');
  assert(Array.isArray(researchOut({ skipped: [] }).skipped), '空数组同样是数组');
});

test('静态契约：summarizeCeaResult 只用 === true 判定整批跳过，且未被退回真值判断', () => {
  const body = SRC.slice(SRC.indexOf('export function summarizeCeaResult'));
  const fn = body.slice(0, body.indexOf('\nfunction errorSummaryOf'));
  assertIncludes(fn, 'out.skipped === true', '整批跳过必须要求布尔 true');
  assertNotIncludes(fn, 'if (out.skipped)', '不得用 `if (out.skipped)` 真值判断（数组恒为真）');
});

/* ==================================================================== */
/*  1) research 真实成功：published>0，skipped=[]                        */
/* ==================================================================== */

test('research published>0 且 skipped=[] → success（不是 skipped，不显示「本次未执行」）', () => {
  const s = summarizeCeaResult('research', researchOut({
    candidates: 12, fetched: 6, published: 6, created: 4, updated: 2,
    skipped: [], failed: [], truncated: false,
    note: '已取得 6 篇全文，写入/更新 6 条研报与动态（来源：SP-test）。观点类内容标记为研究观点，不作为现行规则。',
  }));
  assertEqual(s.status, 'success', '真实取得 6 条结果必须是 success');
  assertEqual(s.published, 6);
  assertEqual(s.failed, 0);
  assertIncludes(s.note, '取得 6 项结果');
  assertNotIncludes(s.note, NOT_EXECUTED, '真实执行过的批次不得显示「本次未执行」');
});

/* ==================================================================== */
/*  2) research 真实成功：skipped 为非空条目数组                          */
/* ==================================================================== */

test('research published>0 且 skipped 非空数组 → success（逐条跳过只是原因清单）', () => {
  const s = summarizeCeaResult('research', researchOut({
    candidates: 9, fetched: 4, published: 3, created: 3,
    skipped: [
      { url: 'https://agg.example/a', reason: 'repost_not_first_source', message: '本轮已取得第一来源条目；聚合/转载站不作为新增研报入库' },
      { url: 'https://x.example/b', reason: 'body_too_short', message: '正文 120 字，未达 200 字，不作为事实' },
      { url: 'https://x.example/c', reason: 'already_collected_same_hash' },
    ],
    failed: [],
  }));
  assertEqual(s.status, 'success', '有 3 条真实入库时，非空 skipped 不得把整批判为 skipped');
  assertEqual(s.published, 3);
  assertEqual(s.failed, 0);
  assertIncludes(s.note, '取得 3 项结果');
  assertNotIncludes(s.note, NOT_EXECUTED);
});

test('research published>0 且 skipped 非空数组 + failed 非空 → partial（仍不是 skipped）', () => {
  const s = summarizeCeaResult('research', researchOut({
    published: 2,
    skipped: [{ url: 'https://x.example/d', reason: 'deadline_exceeded', message: '剩余时间不足' }],
    failed: [{ url: 'https://x.example/e', reason: 'exception', message: '抓取超时' }],
  }));
  assertEqual(s.status, 'partial');
  assertEqual(s.published, 2);
  assertEqual(s.failed, 1);
  assertIncludes(s.note, '取得 2 项结果');
  assertIncludes(s.note, '1 项失败');
  assertNotIncludes(s.note, NOT_EXECUTED);
});

/* ==================================================================== */
/*  3) research 真实执行但published=0                                    */
/* ==================================================================== */

test('research published=0（skipped=[]，failed 有真实原因）→ failed 并给出原因，不是 skipped', () => {
  const s = summarizeCeaResult('research', researchOut({
    candidates: 5, fetched: 0, published: 0,
    skipped: [], failed: [{ url: 'https://x.example/f', reason: 'deadline_exceeded', message: '剩余时间不足，未取正文' }],
  }));
  assertEqual(s.status, 'failed', '真实执行但无产出应是 failed（附原因），而不是「未执行」');
  assertEqual(s.published, 0);
  assertEqual(s.failed, 1);
  assertIncludes(s.note, '未取得任何结果');
  assertIncludes(s.note, 'deadline_exceeded');
  assertNotIncludes(s.note, NOT_EXECUTED);
});

test('research published=0 且 skipped 非空数组（搜索有候选、正文全被跳过）→ failed 并保留真实说明', () => {
  const note = '本轮未取得任何可入库的研报/动态全文（搜索无结果或正文过短）；不写入推测条目，如实登记缺口。';
  const s = summarizeCeaResult('research', researchOut({
    candidates: 7, fetched: 2, published: 0, skipped: [
      { url: 'https://x.example/g', reason: 'body_too_short' },
      { url: 'https://x.example/h', reason: 'outbound_blocked', message: '域名不在白名单' },
    ], failed: [], note,
  }));
  assertEqual(s.status, 'failed');
  assertEqual(s.published, 0);
  assertIncludes(s.note, '未取得任何结果');
  assertIncludes(s.note, '搜索无结果或正文过短');
  assertNotIncludes(s.note, NOT_EXECUTED);
});

/* ==================================================================== */
/*  4) 布尔 true 才是整批跳过（预算/停用语义必须原样保留）                */
/* ==================================================================== */

test('skipped===true 仍必须是 skipped，并保留 message/reason 文案（各目标一致）', () => {
  for (const target of ['json', 'daily', 'documents', 'entities', 'intentions', 'research', 'all']) {
    const s = summarizeCeaResult(target, {
      skipped: true, reason: 'batch_budget_exceeded', message: '批次总时间上限已到，留待下一批',
    });
    assertEqual(s.status, 'skipped', `${target}：布尔 true 必须整批 skipped`);
    assertIncludes(s.note, '批次总时间上限已到');
  }
  const disabled = summarizeCeaResult('documents', { skipped: true, reason: 'disabled', message: 'CEA 采集已停用（后台配置）' });
  assertEqual(disabled.status, 'skipped');
  assertIncludes(disabled.note, 'CEA 采集已停用');
  const noText = summarizeCeaResult('json', { skipped: true, reason: 'after_close_disabled' });
  assertEqual(noText.status, 'skipped');
  assertEqual(noText.note, 'after_close_disabled', '没有 message 时用 reason；都没有才回落「本次未执行」');
});

test('非布尔真值（1 / "true"）不触发整批跳过：严格只认布尔 true', () => {
  const s = summarizeCeaResult('research', { skipped: 1, published: 0, failed: [] });
  assertEqual(s.status, 'failed', 'skipped=1 不是布尔 true，应按真实结果汇总');
  const t = summarizeCeaResult('research', { skipped: 'true', published: 0, failed: [] });
  assertEqual(t.status, 'failed', 'skipped="true" 不是布尔 true，应按真实结果汇总');
});

/* ==================================================================== */
/*  5) 同根因通道（daily）与回归：数组 skipped 一律不触发                 */
/* ==================================================================== */

test('daily 通道 skipped=[] 同样不触发整批跳过（同根因，防止只修 research 分支）', () => {
  const s = summarizeCeaResult('daily', {
    collected: [{ date: '2026-10-14' }, { date: '2026-10-13' }],
    skipped: [{ url: 'https://x.example/i', reason: 'already_collected_same_hash' }],
    failed: [],
  });
  assertEqual(s.status, 'success', 'daily 的 skipped 也是逐条清单，不得判为整批未执行');
  assertEqual(s.published, 2);
  assertNotIncludes(s.note, NOT_EXECUTED);
});

test('回归对照：整批 skipped 与真实结果互斥，同一个 out 不会两种结论并存', () => {
  const real = researchOut({ published: 1, skipped: [] });
  assertEqual(summarizeCeaResult('research', real).status, 'success');
  assertEqual(summarizeCeaResult('research', { ...real, skipped: true, message: '批次总时间上限已到' }).status, 'skipped');
});

finish('38-v2-cea-collect-summary.test.mjs');
