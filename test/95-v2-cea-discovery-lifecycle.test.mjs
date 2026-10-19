/**
 * 95-v2-cea-discovery-lifecycle.test.mjs —— CEA 日报「目录发现成功」与任务收尾回归
 * ============================================================================
 * 真实故障（docs/53）：
 *   · 2026-10-17 06:30 全量任务的 detail.cea.daily.error =
 *     `discovered.failed is not iterable (cannot read property undefined)`；
 *     CEA 日报任务从 06:46 起一直 running、无步骤记录，应用重启后成为中断遗留任务。
 *   · 根因：discoverLatest 在「目录成功解析出 links」分支只返回 {items,note}，
 *     collectCeaDaily 却无条件 result.failed.push(...discovered.failed)。目录越正常越报错；
 *     发现阶段抛错又绕过任务 close，留下 running。
 *
 * 本文件只做本地行为回归（独立临时库 + fetch 夹具，无外网、无模型、无凭据）：
 *   1. 官方目录正常返回真实格式的日报链接时，采集不再出现 failed 不可迭代；
 *   2. 发现后注入未预期异常，本次新建任务必须被 closeCeaJob 如实收尾，异常仍交还调用者；
 *   3. 复用运行中的任务时，本次请求不得关闭原任务。
 *
 * 日报原文夹具与 test/31 使用的官方 2026-07-30 日报一致；仅包上最小 HTML 外壳，
 * 以便走真实的「目录 HTML → 详情 HTML → 解析 → 入库」链路。
 */
import {
  setupV2, finish, test, testAsync, assert, assertEqual, assertIncludes,
} from './v2-helpers.mjs';

const ctx = await setupV2();
const { db } = ctx;
const cea = await import('../src/services/cea-svc.mjs');
const collect = await import('../src/services/cea-collect-svc.mjs');
const { parseCeaDailyReport } = await import('../src/services/cea-parse.mjs');

const CATALOG_URL = 'https://overview.cneeex.com/qgtpfqjy/mrgk/2026n/';
const REPORT_URL = 'https://overview.cneeex.com/c/2026-07-30/498086.shtml';

// 与 test/31-v2-cea-service.test.mjs 的官方原文夹具一致（2026-07-30 真实日报文字）
const OFFICIAL_0730 = `【CEA】全国碳市场每日综合价格行情及成交信息20260730-上海环境能源交易所
今日全国碳市场综合价格行情为: 开盘价96.00元/吨，最高价97.00元/吨，最低价95.90元/吨，收盘价96.61元/吨，收盘价较前一日上涨1.00%。
今日挂牌协议交易成交量544,313吨，成交额52,585,579.00元；大宗协议交易成交量500,000吨，成交额47,575,000.00元；今日无单向竞价。
今日全国碳排放配额总成交量1,044,313吨，总成交额100,160,579.00元。
2026年1月1日至7月30日，全国碳市场碳排放配额成交量68,966,986吨，成交额5,499,968,391.61元。
截至2026年7月30日，全国碳排放配额累计成交量933,833,506吨，累计成交额63,162,586,623.18元。`;

const CATALOG_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>2026年全国碳市场每日行情</title></head>
<body>
  <div class="list">
    <a href="${REPORT_URL}">全国碳市场每日综合价格行情及成交信息20260730</a>
  </div>
</body></html>`;

const REPORT_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>全国碳市场每日综合价格行情及成交信息20260730</title></head>
<body><div class="article">${OFFICIAL_0730.replace(/\n/g, '<br>')}</div></body></html>`;

const REAL_FETCH = globalThis.fetch;
let fetchCalls = [];

/** 安装只认识官方目录与成交日报两个 URL 的 fetch 夹具；任何其他 URL 都立即拒绝，绝不外发。 */
function installFetchFixture() {
  fetchCalls = [];
  globalThis.fetch = async (url) => {
    const href = String(url);
    fetchCalls.push(href);
    // 测试夹具跳过生产限流等待；fetchText 的限流/超时行为由现有其它回归覆盖。
    // 删除的是临时库中的请求时间戳，不改变生产限流代码。
    db.run("DELETE FROM system_meta WHERE key='collect_last_request_at_ms'");
    if (href === CATALOG_URL) {
      return new Response(CATALOG_HTML, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
    }
    if (href === REPORT_URL) {
      return new Response(REPORT_HTML, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
    }
    throw new Error(`测试夹具拒绝未登记的外发请求：${href}`);
  };
}

function restoreFetch() {
  globalThis.fetch = REAL_FETCH;
}

/** 每个用例前清掉可能遗留的运行中日报任务，保证故障注入从独立状态开始。 */
function closeOpenDailyJobs() {
  for (const row of db.all("SELECT id FROM ingestion_job WHERE job_key='cea_daily' AND status='running'")) {
    collect.closeCeaJob(row.id, { status: 'failed', errorSummary: '测试前置清理：关闭遗留运行任务' });
  }
}

function dailyCfg() {
  return {
    ...collect.ceaCollectConfig(),
    enabled: true,
    auto_verify: false,
    max_evidence_rounds: 0,
    max_items_per_round: 8,
  };
}

console.log('\n[v2-95] CEA 日报目录发现契约与异常收尾');

cea.seedCeaBaseData({ actor: 'test' });

test('夹具基线：官方日报原文可解析出 2026-07-30 行情', () => {
  const parsed = parseCeaDailyReport(REPORT_HTML, { url: REPORT_URL });
  assertEqual(parsed.ok, true, `官方原文夹具应可解析：${parsed.parse_note || ''}`);
  assertEqual(parsed.trade_date, '2026-07-30');
  assertEqual(parsed.parse_status === 'ok' || parsed.parse_status === 'partial', true);
});

await testAsync('目录成功分支：返回契约含 failed，采集不再出现 failed 不可迭代', async () => {
  closeOpenDailyJobs();
  installFetchFixture();
  let out = null;
  try {
    out = await collect.collectCeaDaily({
      actor: 'test95', trigger: 'test', cfg: dailyCfg(), onlyNew: true,
    });
  } finally {
    restoreFetch();
  }

  assert(out, '正常目录分支必须返回采集结果');
  assert(Array.isArray(out.failed), 'result.failed 必须始终是数组');
  assertEqual(out.failed.length, 0, `成功目录分支不应有发现失败：${JSON.stringify(out.failed)}`);
  assertEqual(out.status, 'success', `任务应成功收尾：${JSON.stringify(out.failed)}`);
  assertEqual(out.collected.length, 1, '应实际读取并入库 1 条日报');
  assertEqual(out.collected[0].trade_date, '2026-07-30');
  assertEqual(out.collected[0].record_id != null, true);
  assertEqual(fetchCalls.includes(CATALOG_URL), true, '必须真的读取官方目录夹具');
  assertEqual(fetchCalls.includes(REPORT_URL), true, '必须按目录发现的真实链接读取日报原文');
  assertEqual(fetchCalls.length, 2, `不应发起目录/日报以外的请求：${JSON.stringify(fetchCalls)}`);

  const job = db.get('SELECT status,finished_at,error_summary FROM ingestion_job WHERE id=?', [out.job_id]);
  assertEqual(job.status, 'success');
  assert(job.finished_at, '成功任务必须有结束时间');
  assertEqual(job.error_summary, null);
});

await testAsync('发现后未预期异常：自己的任务被如实 close，不遗留 running，异常交还调用者', async () => {
  closeOpenDailyJobs();
  installFetchFixture();
  db.run('DROP TRIGGER IF EXISTS test95_after_discovery');
  // 故障注入发生在目录发现成功、准备写入 collect 步骤之后（不是源码字符串检查）。
  db.run(`CREATE TRIGGER test95_after_discovery BEFORE INSERT ON ingestion_step
    WHEN NEW.stage = 'collect' AND NEW.message LIKE '候选 %'
    BEGIN SELECT RAISE(ABORT, 'test95 注入：发现后意外异常'); END`);

  let caught = null;
  try {
    await collect.collectCeaDaily({
      actor: 'test95', trigger: 'test', cfg: dailyCfg(), onlyNew: false,
    });
  } catch (e) {
    caught = e;
  } finally {
    db.run('DROP TRIGGER IF EXISTS test95_after_discovery');
    restoreFetch();
  }

  assert(caught, '未预期异常必须继续交给调用者处理');
  assertIncludes(String(caught.message), 'test95 注入', '应保留原始异常信息');
  assertEqual(fetchCalls.includes(CATALOG_URL), true, '异常注入前必须已完成目录发现');
  assertEqual(fetchCalls.length, 1, '异常应在发现后、抓取日报前触发');

  const job = db.get("SELECT * FROM ingestion_job WHERE job_key='cea_daily' ORDER BY rowid DESC LIMIT 1");
  assertEqual(job.status, 'failed', '自己的任务必须被 close 为 failed');
  assert(job.finished_at, '异常任务必须有结束时间，不得遗留 running');
  assertIncludes(job.error_summary, 'test95 注入');
  const detail = JSON.parse(job.detail_json);
  assert(Array.isArray(detail.failed), 'detail.failed 必须是数组');
  assert(detail.failed.some((f) => f.reason === 'exception' && String(f.message).includes('test95 注入')), 'detail 应保留异常项');
  assertIncludes(detail.exception, 'test95 注入');
  assertEqual(detail.phase, 'exception');
  assertEqual(detail.found, 1, 'detail 应保留已发现候选数');
  assert(detail.discovery.includes('官方目录页发现 1 条日报链接'), 'detail 应保留已有发现结果');

  const steps = db.all('SELECT stage,status,message FROM ingestion_step WHERE job_id=?', [job.id]);
  assert(steps.some((s) => s.status === 'failed' && String(s.message).includes('test95 注入')), '异常收尾应留步骤审计');
});

await testAsync('复用运行中任务：本次请求不得关闭原任务', async () => {
  closeOpenDailyJobs();
  const placeholder = collect.openCeaJob({
    jobKey: 'cea_daily', title: '测试占位运行任务', trigger: 'test', actor: 'test95',
  });
  assertEqual(placeholder.reused, false, '前置任务应为新建');

  installFetchFixture();
  let out = null;
  try {
    out = await collect.collectCeaDaily({ actor: 'test95', trigger: 'test', cfg: dailyCfg(), onlyNew: true });
  } finally {
    restoreFetch();
  }

  assertEqual(out.reused, true, '应识别为运行中任务重入');
  assertEqual(out.merged, true);
  assertEqual(out.merged_into_job_id, placeholder.id);
  assertEqual(fetchCalls.length, 0, '重入不得重复抓取');
  const row = db.get('SELECT status,finished_at FROM ingestion_job WHERE id=?', [placeholder.id]);
  assertEqual(row.status, 'running', '重入不得把仍在运行的原任务标成结束');
  assertEqual(row.finished_at, null, '重入不得写结束时间');

  collect.closeCeaJob(placeholder.id, { status: 'failed', errorSummary: '测试收尾' });
});

finish('95-v2-cea-discovery-lifecycle.test.mjs');
