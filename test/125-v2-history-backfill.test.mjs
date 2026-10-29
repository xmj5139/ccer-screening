/**
 * 测试 125（docs/74 B）：历史补采的日期条件、窗口/页游标、去重、未知日期、
 * 暂停/继续/取消、失败重试、重启恢复与采集租约。
 * 搜索/抓取全部使用测试替身，不联网、不调用任何模型。
 */
import {
  setupV2, test, testAsync, assert, assertEqual, assertIncludes, finish,
} from './v2-helpers.mjs';

const ctx = await setupV2({ withPublicDemo: false });
const { db } = ctx;
const backfill = await import('../src/services/history-backfill-svc.mjs');
const gov = await import('../src/services/governance-svc.mjs');

console.log('\n[v2-125] 历史补采：日期窗口、分页游标、暂停恢复与失败隔离');

const admin = { id: 'u-admin', name: 'admin-test', role: 'admin' };
const viewer = { id: 'u-viewer', name: 'viewer', role: 'viewer' };
const CAPS = {
  search_configured: true, date_filter_supported: true, pagination_supported: true,
  fetch_configured: true, provider: { id: 'fake-search', name: '测试搜索', kind: 'generic_json' },
};
const BASE = {
  dataset: 'content', date_from: '2026-09-01', date_to: '2026-09-04',
  window_days: 2, query: 'CCER', page_size: 2, max_pages: 2,
  options: { max_calls: 50 },
};

const fetchGood = async (url) => ({ ok: true, content: `${url} 公开全文正文。`.repeat(120) });

function fakeSearchFor({ failFirst = false } = {}) {
  const calls = [];
  let callNo = 0;
  const fn = async (term, opts) => {
    callNo += 1;
    calls.push({ term, ...opts });
    if (failFirst && callNo === 1) {
      return { ok: false, reason: 'rate_limited', message: '测试限流', results: [] };
    }
    // 窗口 1：第一页有窗口内/未知日期/窗口外；第二页有重复与新增
    if (opts.start_date === '2026-09-01' && opts.page === 1) {
      return {
        ok: true,
        results: [
          { url: 'https://example.test/a', title: 'A 碳市场公开研报', published_at: '2026-09-01', snippet: 'A 摘要' },
          { url: 'https://example.test/unknown', title: '未知发布日期动态', published_at: null, snippet: '未知日期摘要' },
          { url: 'https://example.test/out', title: '窗口外内容', published_at: '2026-09-09', snippet: '不应进入本窗口' },
        ],
      };
    }
    if (opts.start_date === '2026-09-01' && opts.page === 2) {
      return {
        ok: true,
        results: [
          { url: 'https://example.test/a', title: 'A 碳市场公开研报', published_at: '2026-09-01', snippet: 'A 摘要' },
          { url: 'https://example.test/b', title: 'B 碳市场动态', published_at: '2026-09-02', snippet: 'B 摘要' },
        ],
      };
    }
    if (opts.start_date === '2026-09-03' && opts.page === 1) {
      return { ok: true, results: [{ url: 'https://example.test/c', title: 'C 碳市场新闻', published_at: '2026-09-03', snippet: 'C 摘要' }] };
    }
    return { ok: true, results: [] };
  };
  fn.calls = calls;
  return fn;
}

test('预览：窗口、估算调用数、通知筛选限制；不支持的类型明确拒绝', () => {
  const p = backfill.previewBackfill(BASE, { capabilities: CAPS });
  assertEqual(p.ok, true, JSON.stringify(p));
  assertEqual(p.window_count, 2);
  assertEqual(p.estimated_search_calls, 4, '2 窗口 × 1 查询 × 2 页');
  assertIncludes(p.coverage_note, '完成');
  assertIncludes(p.coverage_note, '不代表全网资料完整');
  const bad = backfill.previewBackfill({ ...BASE, dataset: 'trade' }, { capabilities: CAPS });
  assertEqual(bad.status, 400);
  assertIncludes(bad.error, '不支持');
  const badDate = backfill.previewBackfill({ ...BASE, date_from: '2026-09-05', date_to: '2026-09-01' }, { capabilities: CAPS });
  assertEqual(badDate.status, 400);
  assertIncludes(badDate.error, '不得晚于');
  const disabled = backfill.previewBackfill({ ...BASE, source_ids: ['src-ca-cws'] }, { capabilities: CAPS });
  assert(disabled.blocking_reasons.join('｜').includes('已停用'), '停用来源应明确提示');
});

await testAsync('创建任务与执行：日期条件真实传入、按真实发布日期落窗、未知日期隔离', async () => {
  const created = backfill.createBackfillTask(admin, BASE, { capabilities: CAPS });
  assertEqual(created.ok, true, JSON.stringify(created));
  const taskId = created.task.id;
  assertEqual(created.task.planned_windows, 2);
  const searchFn = fakeSearchFor();
  const r1 = await backfill.runBackfillStep(taskId, {
    searchFn, fetchFn: fetchGood, capabilities: CAPS, maxWindows: 1, maxMs: 20000, owner: 'test-bf-1',
  });
  assertEqual(r1.ok, true, JSON.stringify(r1));
  assertEqual(searchFn.calls.length, 2, '第一窗口处理 2 页');
  for (const c of searchFn.calls) {
    assertEqual(c.start_date, '2026-09-01', '起止日期条件必须实际传给搜索函数');
    assertEqual(c.end_date, '2026-09-02');
  }
  assertEqual(searchFn.calls[0].page, 1);
  assertEqual(searchFn.calls[1].page, 2);
  const task1 = r1.task;
  assertEqual(task1.processed_windows, 1);
  assertEqual(task1.inserted, 3, 'A/B/未知日期各入库一次');
  assertEqual(task1.duplicates, 1, '重复 URL 不应重复入库');
  assertEqual(task1.unknown_dates, 1);
  assertEqual(task1.outside_window, 1);
  assertEqual(task1.search_calls, 2);
  const w1 = db.get('SELECT * FROM backfill_window WHERE task_id=? AND seq=1', [taskId]);
  assertEqual(w1.status, 'done');
  assertEqual(w1.cursor_page, 3, '完成窗口的页码游标应保留在末尾');
  assertEqual(db.get('SELECT COUNT(*) c FROM content_item WHERE source_url=?', ['https://example.test/a']).c, 1, 'URL 去重');
  assertEqual(db.get('SELECT COUNT(*) c FROM content_item WHERE source_url=?', ['https://example.test/out']).c, 0, '窗口外日期不得入库');
  const undated = db.get('SELECT published_at,publisher FROM content_item WHERE source_url=?', ['https://example.test/unknown']);
  assert(undated, '未知日期应入库');
  assertEqual(undated.published_at, null, '未知发布日期必须保持 NULL，不得默认成窗口日期');

  const r2 = await backfill.runBackfillStep(taskId, {
    searchFn, fetchFn: fetchGood, capabilities: CAPS, maxWindows: 3, maxMs: 20000, owner: 'test-bf-2',
  });
  const task2 = r2.task;
  assertEqual(task2.status, 'completed', JSON.stringify({ status: task2.status, failed: task2.failed, blocked: task2.blocked }));
  assertEqual(task2.processed_windows, 2);
  assertEqual(task2.inserted, 4);
  assertEqual(searchFn.calls.length, 3, '已完成窗口/页不应重复调用');});

await testAsync('暂停、继续、取消：状态持久化且继续后不重复已完成窗口', async () => {
  const created = backfill.createBackfillTask(admin, {
    ...BASE, date_to: '2026-09-06', window_days: 2, options: { max_calls: 50 },
  }, { capabilities: CAPS });
  const taskId = created.task.id;
  assertEqual(created.task.planned_windows, 3);
  const searchFn = fakeSearchFor();
  await backfill.runBackfillStep(taskId, { searchFn, fetchFn: fetchGood, capabilities: CAPS, maxWindows: 1, maxMs: 20000, owner: 'pause-1' });
  const paused = backfill.pauseBackfillTask(admin, taskId);
  assertEqual(paused.task.status, 'paused');
  const blocked = await backfill.runBackfillStep(taskId, { searchFn, fetchFn: fetchGood, capabilities: CAPS, owner: 'pause-2' });
  assertEqual(blocked.reason, 'paused');
  const resumed = backfill.resumeBackfillTask(admin, taskId);
  assertEqual(resumed.task.status, 'running');
  const callsBefore = searchFn.calls.length;
  const done = await backfill.runBackfillStep(taskId, { searchFn, fetchFn: fetchGood, capabilities: CAPS, maxWindows: 5, maxMs: 20000, owner: 'pause-3' });
  assertEqual(done.task.status, 'completed');
  assert(done.task.processed_windows === 3, `应完成 3 个窗口，实际 ${done.task.processed_windows}`);
  assert(searchFn.calls.length > callsBefore);

  const c2 = backfill.createBackfillTask(admin, BASE, { capabilities: CAPS });
  const cancelled = backfill.cancelBackfillTask(admin, c2.task.id);
  assertEqual(cancelled.task.status, 'cancelled');
  const skipped = db.all("SELECT status FROM backfill_window WHERE task_id=?", [c2.task.id]);
  assert(skipped.every((w) => w.status === 'skipped'), '取消后未完成窗口应标记 skipped');
  const afterCancel = await backfill.runBackfillStep(c2.task.id, { searchFn, fetchFn: fetchGood, capabilities: CAPS });
  assertEqual(afterCancel.ok, true, '已取消任务不再执行');
});

await testAsync('失败不被标为完成；重试从失败页继续并最终完成', async () => {
  const created = backfill.createBackfillTask(admin, {
    ...BASE, date_to: '2026-09-02', window_days: 2, options: { max_calls: 50 },
  }, { capabilities: CAPS });
  const taskId = created.task.id;
  const failing = fakeSearchFor({ failFirst: true });
  const r = await backfill.runBackfillStep(taskId, {
    searchFn: failing, fetchFn: fetchGood, capabilities: CAPS, maxWindows: 1, maxMs: 20000, owner: 'fail-1',
  });
  assertEqual(r.task.status, 'partial', JSON.stringify({ status: r.task.status, failed: r.task.failed }));
  const w = db.get('SELECT * FROM backfill_window WHERE task_id=?', [taskId]);
  assertEqual(w.status, 'failed');
  assertEqual(w.cursor_page, 1, '失败页的游标不得前进');
  assertIncludes(w.error || '', '测试限流');
  const retried = backfill.retryBackfillTask(admin, taskId);
  assertEqual(retried.task.status, 'queued');
  const ok = fakeSearchFor();
  const done = await backfill.runBackfillStep(taskId, {
    searchFn: ok, fetchFn: fetchGood, capabilities: CAPS, maxWindows: 2, maxMs: 20000, owner: 'fail-2',
  });
  assertEqual(done.task.status, 'completed');
  assertEqual(done.task.processed_windows, 1);
  assertEqual(ok.calls[0].page, 1, '重试应从失败页继续');
});

await testAsync('每日/补采共享租约：活任务未到期时拒绝并发；释放后可运行', async () => {
  const created = backfill.createBackfillTask(admin, {
    ...BASE, date_to: '2026-09-02', window_days: 2,
  }, { capabilities: CAPS });
  const holder = gov.acquireLease({ key: 'collection', owner: 'other-task', purpose: 'test', ttlMs: 60000 });
  assertEqual(holder.ok, true);
  const busy = await backfill.runBackfillStep(created.task.id, {
    searchFn: fakeSearchFor(), fetchFn: fetchGood, capabilities: CAPS, owner: 'blocked',
  });
  assertEqual(busy.reason, 'lease_busy');
  assertEqual(db.get('SELECT status FROM backfill_task WHERE id=?', [created.task.id]).status, 'queued');
  gov.releaseLease({ key: 'collection', owner: 'other-task' });
  const ok = await backfill.runBackfillStep(created.task.id, {
    searchFn: fakeSearchFor(), fetchFn: fetchGood, capabilities: CAPS, maxWindows: 2, owner: 'now-ok',
  });
  assertEqual(ok.task.status, 'completed');
});

await testAsync('每日任务也遵守同一租约，不与时序补采并行抢占', async () => {
  const holder = gov.acquireLease({ key: 'collection', owner: 'backfill-holder', purpose: 'test', ttlMs: 60000 });
  assertEqual(holder.ok, true);
  const collect = await import('../src/services/collect-svc.mjs');
  const out = await collect.runDailyJob({ actor: 'test:lease', datasets: [] });
  assertEqual(out.status, 'skipped');
  assertEqual(out.reason, 'lease_busy');
  gov.releaseLease({ key: 'collection', owner: 'backfill-holder' });
});

test('重启恢复：超时 running 任务转为 interrupted，窗口回到 pending；角色权限', () => {
  const created = backfill.createBackfillTask(admin, BASE, { capabilities: CAPS });
  db.run("UPDATE backfill_task SET status='running', updated_at='2000-01-01T00:00:00.000Z' WHERE id=?", [created.task.id]);
  db.run("UPDATE backfill_window SET status='running' WHERE task_id=? AND seq=1", [created.task.id]);
  const rec = backfill.recoverInterruptedBackfill();
  assert(rec.interrupted >= 1);
  const t = db.get('SELECT status FROM backfill_task WHERE id=?', [created.task.id]);
  assertEqual(t.status, 'interrupted');
  assertEqual(db.get("SELECT status FROM backfill_window WHERE task_id=? AND seq=1", [created.task.id]).status, 'pending');
  assertEqual(backfill.createBackfillTask(viewer, BASE).status, 403);
  assertEqual(backfill.pauseBackfillTask(viewer, created.task.id).status, 403);
  assertEqual(backfill.retryBackfillTask(viewer, created.task.id).status, 403);
});

test('日期能力未声明时拒绝创建，不把最近结果伪装成日期范围结果', () => {
  const out = backfill.createBackfillTask(admin, BASE, {
    capabilities: { ...CAPS, date_filter_supported: false },
  });
  assertEqual(out.status, 409);
  assertIncludes(out.error, '日期条件');
});

finish('test/125-v2-history-backfill.test.mjs');
