/**
 * 测试 141（docs/80 A）：入库只入队、去重、范围、无模型 blocked、输入变化、
 * 租约忙不扣次数、重启恢复、退避/上限、GET 不调模型与管理员权限。
 * 仅用 setupV2 临时库 + 本机回环模型桩；不联网、不读取真实密钥。
 */
import http from 'node:http';
import {
  setupV2, test, testAsync, assert, assertEqual, assertIncludes, finish,
} from './v2-helpers.mjs';

const ctx = await setupV2({ withPublicDemo: false });
const { db } = ctx;
const content = await import('../src/services/content-svc.mjs');
const ingest = await import('../src/services/ingest-summary-svc.mjs');
const governance = await import('../src/services/governance-svc.mjs');
const summary = await import('../src/services/summary-svc.mjs');

const admin = { id: 'u141-admin', name: 'admin-141', role: 'admin' };
const viewer = { id: 'u141-viewer', name: 'viewer-141', role: 'viewer' };
const BODY = '全国碳市场公开信息入库摘要队列测试正文，包含来源、日期与可核对事项。'.repeat(30);
let requestCount = 0;
let responseDelayMs = 0;
let failModel = false;
const requestStarts = [];

const server = http.createServer(async (req, res) => {
  requestCount += 1;
  requestStarts.push(Date.now());
  for await (const _ of req) { /* drain body */ }
  await new Promise((r) => setTimeout(r, responseDelayMs));
  if (failModel) {
    res.writeHead(500, { 'content-type': 'application/json', connection: 'close' });
    res.end(JSON.stringify({ error: { message: 'stub model failure' } }));
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
  res.end(JSON.stringify({
    choices: [{
      finish_reason: 'stop',
      message: { role: 'assistant', content: JSON.stringify({ summary: '这是本机桩模型生成的测试摘要，仅概括已给输入。' }) },
    }],
    usage: { prompt_tokens: 30, completion_tokens: 20, total_tokens: 50 },
  }));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

function enableStubModel() {
  db.run('UPDATE llm_provider SET enabled=0');
  db.run('DELETE FROM llm_provider WHERE id=?', ['LLM-141-STUB']);
  db.run(
    `INSERT INTO llm_provider
      (id,name,provider_kind,base_url,model,credential_ref,timeout_ms,max_calls_per_day,enabled,
       use_content_verify,allowed_domains,calls_today,calls_today_date,created_by,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ['LLM-141-STUB', '本机回环桩', 'ollama', `http://127.0.0.1:${port}`, 'stub-summary',
      null, 5000, 999, 1, 1, '127.0.0.1', 0, null, 'test:141',
      new Date().toISOString(), new Date().toISOString()]
  );
}

function addContent(slug, body = null, extra = {}) {
  return content.upsertContent({
    source_url: `https://www.example.gov.cn/ingest141/${slug}.html`,
    title: `入库摘要队列测试 ${slug}`,
    publisher: '测试发布机构',
    content_type: 'industry_news',
    published_at: '2026-10-01',
    body_snapshot: body === null ? `${BODY}\n\n场景：${slug}` : body,
    ...extra,
  }, { actor: 'test:141' });
}

function queueRows(entityId = null) {
  return entityId
    ? db.all('SELECT * FROM ingest_summary_queue WHERE entity_id=? ORDER BY created_at DESC', [entityId])
    : db.all('SELECT * FROM ingest_summary_queue ORDER BY created_at DESC');
}

function parkDue() {
  db.run(
    `UPDATE ingest_summary_queue SET next_attempt_at='2099-01-01T00:00:00.000Z'
      WHERE status IN ('queued','failed','blocked')`
  );
}

async function waitFor(predicate, timeoutMs = 2000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return false;
}

try {
  db.run('DELETE FROM ingest_summary_queue');
  db.run('DELETE FROM entity_summary');
  db.run('UPDATE llm_provider SET enabled=0');

  await testAsync('无模型：同步 upsertContent 只入队不发模型请求，worker 明确 blocked 不伪造成功', async () => {
    const before = requestCount;
    const item = addContent('no-model');
    assertEqual(requestCount, before, '同步写路径不得调用模型');
    const rows = queueRows(item.id);
    assertEqual(rows.length, 1, '新内容应入队一次');
    assertEqual(rows[0].status, 'queued');
    assertEqual(rows[0].model_key, 'none');
    const out = await ingest.runIngestSummaryWorkerOnce();
    assertEqual(out.claimed, 1);
    assertEqual(out.blocked, 1, JSON.stringify(out));
    const after = queueRows(item.id)[0];
    assertEqual(after.status, 'blocked');
    assert(after.attempts >= 1);
    assert(!!after.next_attempt_at);
    assertIncludes(after.last_error, '未配置');
    assertEqual(summary.getSummary('content_item', item.id)?.status, 'skipped');
    assertEqual(requestCount, before, '无模型时不得发出任何外部请求');
    parkDue();
  });

  await testAsync('标题-only、转载副本与相同正文重抓不产生新任务', async () => {
    const before = queueRows().length;
    const titleOnly = addContent('title-only', '', { summary: null, body_availability: 'metadata_only' });
    assertEqual(queueRows(titleOnly.id).length, 0, '只有标题不得入队');
    const dup = content.upsertContent({
      source_url: 'https://www.example.org/reprint141/no-model.html',
      title: '同一正文转载副本', publisher: '转载站', content_type: 'industry_news',
      body_snapshot: `${BODY}\n\n场景：no-model`,
    }, { actor: 'test:141' });
    assertEqual(dup.action, 'duplicate');
    assertEqual(queueRows(dup.id).length, 0, '转载副本不得入队');
    const first = queueRows().find((r) => r.entity_id && r.entity_id.startsWith('CNT'));
    const again = content.upsertContent({
      source_url: 'https://www.example.gov.cn/ingest141/no-model.html',
      title: '入库摘要队列测试 no-model', publisher: '测试发布机构', content_type: 'industry_news',
      published_at: '2026-10-01', body_snapshot: `${BODY}\n\n场景：no-model`,
    }, { actor: 'test:141' });
    assertEqual(again.action, 'unchanged');
    assertEqual(queueRows().length, before, '相同正文重复抓取不得新增付费任务');
    assert(first, 'fixture 应已有队列行');
  });

  await testAsync('有模型：worker 复用 runSummaryBatchExclusive 生成，任务成功且只调用一次桩模型', async () => {
    enableStubModel();
    responseDelayMs = 0;
    failModel = false;
    const before = requestCount;
    const item = addContent('with-model');
    const queued = queueRows(item.id)[0];
    assertEqual(queued.status, 'queued');
    assertIncludes(queued.model_key, 'LLM-141-STUB');
    const out = await ingest.runIngestSummaryWorkerOnce();
    assertEqual(out.succeeded, 1, JSON.stringify(out));
    assertEqual(requestCount, before + 1, '只应调用一次模型');
    const s = summary.getSummary('content_item', item.id);
    assertEqual(s.status, 'ok');
    assertIncludes(s.summary, '测试摘要');
    assertEqual(queueRows(item.id)[0].status, 'succeeded');
  });

  await testAsync('飞行中输入变化：旧任务不标完成，按新签名重新入队', async () => {
    responseDelayMs = 250;
    const item = addContent('inflight');
    const oldTask = queueRows(item.id)[0];
    const pending = ingest.runIngestSummaryWorkerOnce();
    const hit = await waitFor(() => requestStarts.length > 0 && requestCount > 1);
    assert(hit, '桩模型请求应已开始');
    const changed = content.upsertContent({
      source_url: 'https://www.example.gov.cn/ingest141/inflight.html',
      title: '入库摘要队列测试 inflight',
      publisher: '测试发布机构', content_type: 'industry_news', published_at: '2026-10-01',
      body_snapshot: `${BODY}\n\n补充：正文在模型飞行中发生变化。`,
    }, { actor: 'test:141' });
    assertEqual(changed.action, 'updated');
    const out = await pending;
    assertEqual(out.superseded, 1, JSON.stringify(out));
    const rows = queueRows(item.id);
    const oldRow = rows.find((r) => r.id === oldTask.id);
    assertEqual(oldRow.status, 'superseded', '旧签名任务不能标 success');
    assert(rows.some((r) => r.status === 'queued' && r.input_hash !== oldTask.input_hash), '新签名必须重新入队');
    responseDelayMs = 0;
    parkDue();
  });

  await testAsync('worker 租约忙：延后且不消耗真实失败次数', async () => {
    const item = addContent('lease-busy');
    const task = queueRows(item.id)[0];
    const held = governance.acquireLease({ key: 'ingest_summary', owner: 'other-141', purpose: 'test', ttlMs: 60000 });
    assertEqual(held.ok, true);
    const out = await ingest.runIngestSummaryWorkerOnce();
    assertEqual(out.ok, false);
    assertEqual(out.reason, 'lease_busy');
    const after = queueRows(item.id)[0];
    assertEqual(after.status, 'queued');
    assertEqual(after.attempts, task.attempts, '租约忙不得增加失败次数');
    assertEqual(after.last_error_kind, null);
    governance.releaseLease({ key: 'ingest_summary', owner: 'other-141' });
    parkDue();
  });

  await testAsync('过期运行态回收：重启续跑，不增加失败次数，也不伪造成功', async () => {
    const item = addContent('recover');
    const task = queueRows(item.id)[0];
    db.run(
      `UPDATE ingest_summary_queue SET status='running', lease_owner='dead-worker', lease_until='2000-01-01T00:00:00.000Z',
         attempts=2, worker_started_at='2000-01-01T00:00:00.000Z' WHERE id=?`,
      [task.id]
    );
    const n = ingest.reapStaleIngestTasks();
    assert(n.reaped >= 1);
    const after = queueRows(item.id)[0];
    assertEqual(after.status, 'queued');
    assertEqual(after.attempts, 2);
    assertIncludes(after.last_error, '租约过期');
    assertEqual(after.last_error_kind, 'interrupted');
    parkDue();
  });

  await testAsync('失败退避与尝试上限：退避期不重复调用；达到上限写 dead', async () => {
    failModel = true;
    const item = addContent('retry');
    const task = queueRows(item.id)[0];
    const before = requestCount;
    const first = await ingest.runIngestSummaryWorkerOnce();
    assertEqual(first.failed, 1, JSON.stringify(first));
    assertEqual(requestCount, before + 1);
    let row = queueRows(item.id)[0];
    assertEqual(row.status, 'failed');
    assertEqual(row.attempts, 1);
    assert(!!row.next_attempt_at);
    const second = await ingest.runIngestSummaryWorkerOnce();
    assertEqual(second.claimed, 0, '退避未到不得重复调用');
    assertEqual(requestCount, before + 1);
    db.run(
      `UPDATE ingest_summary_queue SET attempts=4, next_attempt_at='2000-01-01T00:00:00.000Z',
         status='failed', lease_owner=NULL, lease_until=NULL WHERE id=?`,
      [task.id]
    );
    const third = await ingest.runIngestSummaryWorkerOnce();
    assertEqual(third.failed, 1, JSON.stringify(third));
    row = queueRows(item.id)[0];
    assertEqual(row.status, 'dead');
    assertEqual(row.attempts, 5);
    assertEqual(row.next_attempt_at, null);
    assertIncludes(row.last_error, 'HTTP 500');
    failModel = false;
  });

  await testAsync('GET 状态不调用外网/模型', async () => {
    const before = requestCount;
    const status = ingest.ingestQueueStatus({ limit: 5 });
    assert(status.counts, '应返回队列统计');
    summary.summaryStatus({ sample: 1 });
    assertEqual(requestCount, before, 'GET 状态路径不得调用模型或外网');
  });

  await testAsync('权限：普通用户不能切换队列或重试任务', async () => {
    const toggle = ingest.setIngestWorkerEnabled(viewer, false);
    assertEqual(toggle.status, 403);
    const retry = ingest.retryIngestTasks(viewer, { limit: 1 });
    assertEqual(retry.status, 403);
  });

  await testAsync('管理员重试失败任务：重置尝试次数并真实入队，不直接标记成功', async () => {
    const dead = queueRows().find((r) => r.status === 'dead');
    assert(dead, 'fixture 应有 dead 任务');
    const before = queueRows(dead.entity_id)[0];
    const out = ingest.retryIngestTasks(admin, { ids: [dead.id] });
    assertEqual(out.ok, true);
    assertEqual(out.reset, 1);
    const after = queueRows(dead.entity_id)[0];
    assertEqual(after.status, 'queued');
    assertEqual(after.attempts, 0);
    assert(before.status === 'dead');
    parkDue();
  });

  await testAsync('领取顺序：每批先给新内容 1 个名额，其余从最旧待办补足，不永久饥饿', async () => {
    parkDue();
    const now = Date.now();
    const add = (id, source, created, priority) => db.run(
      `INSERT INTO ingest_summary_queue
        (id,entity_type,entity_id,dedupe_key,input_hash,prompt_version,model_key,status,priority,source,
         attempts,max_attempts,next_attempt_at,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,'queued',?,?,0,5,?,?,?)`,
      [id, 'content_item', id, `delete-${id}`, `hash-${id}`, summary.PROMPT_VERSION, 'none',
        priority, source, new Date(now).toISOString(), created, created]
    );
    add('OLD-141-1', 'daily_backfill', '2026-01-01T00:00:00.000Z', 10);
    add('OLD-141-2', 'daily_backfill', '2026-01-02T00:00:00.000Z', 10);
    add('OLD-141-3', 'daily_backfill', '2026-01-03T00:00:00.000Z', 10);
    add('NEW-141', 'ingest', new Date(now).toISOString(), 100);
    const claimed = ingest.claimIngestTasks({ limit: 2, owner: 'test-141-claim', leaseTtlMs: 40000 });
    assertEqual(claimed.ok, true);
    assertEqual(claimed.tasks.length, 2);
    const ids = claimed.tasks.map((t) => t.entity_id);
    assert(ids.includes('NEW-141'), `新内容应优先占一个名额：${ids}`);
    assert(ids.includes('OLD-141-1'), `其余名额应从最旧待办补足：${ids}`);
    db.run("UPDATE ingest_summary_queue SET status='superseded' WHERE lease_owner=?", ['test-141-claim']);
    parkDue();
  });

  await testAsync('每日兜底只补当前签名无队列的漏队内容', async () => {
    parkDue();
    const item = addContent('backfill');
    db.run('DELETE FROM ingest_summary_queue WHERE entity_id=?', [item.id]);
    const out = ingest.enqueueMissedContentSummaries({ limit: 20, actor: 'test:141' });
    assert(out.queued >= 1, JSON.stringify(out));
    const rows = queueRows(item.id);
    assertEqual(rows.length, 1, '漏队内容应补入当前签名任务');
    const again = ingest.enqueueMissedContentSummaries({ limit: 20, actor: 'test:141' });
    assertEqual(queueRows(item.id).length, 1, '已入队不得重复');
    assert(again.deduped >= 1);
    parkDue();
  });
} finally {
  ingest.stopIngestSummaryWorker();
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
}

finish('test/141-v2-ingest-summary-queue.test.mjs');
