/**
 * 测试 142（docs/80 B）：缺口确定性分类、受控单条动作、摘要失败不结清、
 * 抓取成功但解析失败不结清、权限与“不支持动作”明示。
 * 仅用 setupV2 临时库与本机回环桩；不联网、不调用真实模型。
 */
import http from 'node:http';
import {
  setupV2, testAsync, assert, assertEqual, assertIncludes, finish,
} from './v2-helpers.mjs';

const ctx = await setupV2({ withPublicDemo: false });
const { db } = ctx;
const content = await import('../src/services/content-svc.mjs');
const gaps = await import('../src/services/gap-triage-svc.mjs');
const ingest = await import('../src/services/ingest-summary-svc.mjs');

const admin = { id: 'u142-admin', name: 'admin-142', role: 'admin' };
const viewer = { id: 'u142-viewer', name: 'viewer-142', role: 'viewer' };
const now = new Date().toISOString();
const BODY = '缺口分类与受控动作测试正文，包含公开来源、日期与明确事项。'.repeat(30);
process.env.CCER_ALLOW_LOOPBACK_OUTBOUND = '1';

let parsePageHits = 0;
const server = http.createServer(async (req, res) => {
  parsePageHits += 1;
  for await (const _ of req) { /* drain */ }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', connection: 'close' });
  res.end('<!doctype html><html><head><title>全国碳市场每日行情</title></head><body><main>'
    + '今日全国碳排放权交易市场每日行情发布，但本测试页没有开盘价、收盘价或成交字段。'
    + '</main></body></html>');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const LOCAL_URL = `http://127.0.0.1:${port}/cea/daily-142.html`;

function addGap({ id, dataset, key, title, description, severity = 'warning' }) {
  db.run(
    `INSERT INTO data_gap (id,dataset,gap_key,title,description,impact,severity,status,detected_at,updated_at)
     VALUES (?,?,?,?,?,?,?, 'open',?,?)`,
    [id, dataset, key, title, description, '测试影响', severity, now, now]
  );
  return db.get('SELECT * FROM data_gap WHERE id=?', [id]);
}

try {
  db.run('UPDATE llm_provider SET enabled=0');
  db.run('DELETE FROM ingest_summary_queue');
  const item = content.upsertContent({
    source_url: 'https://www.example.gov.cn/v2-gap-142.html',
    title: '缺口动作测试内容 142', publisher: '测试机构', content_type: 'industry_news',
    published_at: '2026-10-01', body_snapshot: BODY,
  }, { actor: 'test:142' });
  db.run('DELETE FROM ingest_summary_queue');

  const summaryGap = addGap({
    id: 'GAP-142-SUM', dataset: 'content', key: `summary:content:${item.id}`,
    title: '内容摘要生成失败待重试',
    description: `内容 ${item.id} 的摘要任务失败，需重新入队；未配置模型时只能 blocked。`,
  });
  const conflictGap = addGap({
    id: 'GAP-142-CONFLICT', dataset: 'content', key: `conflict:content:${item.id}`,
    title: '原始事实冲突：公开来源数值不一致',
    description: '两个公开来源对同一事实给出不一致数值，需保留原始出处，不能凭模型判断关闭。',
    severity: 'critical',
  });
  const trueGap = addGap({
    id: 'GAP-142-DATE', dataset: 'cea_trade', key: `cea:trade:nodate:${LOCAL_URL}`,
    title: '无法确定 CEA 行情日期',
    description: `正文与 URL 均未给出交易日：${LOCAL_URL}；按规范不补 0、不用采集日兜底。`,
  });
  const cumulativeGap = addGap({
    id: 'GAP-142-CUM', dataset: 'cea_trade', key: 'cea:trade:cumulative:2026',
    title: '累计成交额存在差异',
    description: '官方累计成交额与分日累加存在差异；保留差异与来源，不按单日值反推累计。',
  });
  db.run(
    `INSERT INTO cea_source (id,code,name,url,dataset,kind,allowed_domains,enabled,priority,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,1,1,?,?)`,
    ['CEASRC-142', 'cea-local-142', '本机 CEA 解析失败桩', LOCAL_URL, 'daily', 'official_html',
      JSON.stringify(['127.0.0.1']), now, now]
  );
  const parseGap = addGap({
    id: 'GAP-142-PARSE', dataset: 'cea_trade', key: `cea:trade:parse:${LOCAL_URL}`,
    title: 'CEA 日报解析失败',
    description: `真实抓取成功但正文未找到行情字段，解析失败：${LOCAL_URL}；未写入行情行。`,
    severity: 'critical',
  });

  await testAsync('分类：摘要/冲突/日期/解析失败各有依据、可重试性与阻塞性，未分类不猜关闭', async () => {
    const out = gaps.triageGaps({ status: 'all', limit: 50, includeFields: false });
    const byId = new Map(out.items.map((g) => [g.id, g]));
    assertEqual(byId.get(summaryGap.id).triage.category, 'summary_pending');
    assertEqual(byId.get(summaryGap.id).triage.blocking, false);
    assert(byId.get(summaryGap.id).triage.supported_actions.some((a) => a.key === 'requeue_summary'));
    assert(byId.get(summaryGap.id).triage.basis.some((x) => x.includes('summary:content')));
    assertEqual(byId.get(conflictGap.id).triage.category, 'raw_conflict');
    assertEqual(byId.get(conflictGap.id).triage.supported_actions.length, 0);
    assertIncludes(byId.get(conflictGap.id).triage.unsupported_reason, '不能靠现有单条动作');
    assertEqual(byId.get(trueGap.id).triage.category, 'missing_trade_date');
    assertEqual(byId.get(cumulativeGap.id).triage.category, 'cumulative_mismatch');
    assertEqual(byId.get(cumulativeGap.id).triage.supported_actions.length, 0);
    assertEqual(byId.get(parseGap.id).triage.category, 'dynamic_partial');
    assert(byId.get(parseGap.id).triage.supported_actions.some((a) => a.key === 'retry_cea_fetch'));
  });

  await testAsync('权限与不支持动作：普通用户 403；冲突缺口不提供空动作', async () => {
    const denied = await gaps.runGapAction(viewer, summaryGap.id, 'requeue_summary');
    assertEqual(denied.status, 403);
    const bad = await gaps.runGapAction(admin, conflictGap.id, 'retry_cea_fetch');
    assertEqual(bad.ok, false);
    assertEqual(bad.unsupported, true);
    assertEqual(bad.allowed_actions.length, 0);
    const row = db.get('SELECT status,last_action FROM data_gap WHERE id=?', [conflictGap.id]);
    assertEqual(row.status, 'open');
    assertEqual(row.last_action, null);
  });

  await testAsync('摘要动作只入队；无模型 worker blocked 后缺口仍未结清', async () => {
    const out = await gaps.runGapAction(admin, summaryGap.id, 'requeue_summary');
    assertEqual(out.ok, true, JSON.stringify(out));
    assertEqual(out.close, false);
    assertEqual(db.get('SELECT status FROM data_gap WHERE id=?', [summaryGap.id]).status, 'open');
    assertEqual(db.get(`SELECT status FROM ingest_summary_queue WHERE entity_id=?`, [item.id]).status, 'queued');
    const worker = await ingest.runIngestSummaryWorkerOnce();
    assertEqual(worker.blocked, 1, JSON.stringify(worker));
    assertEqual(db.get('SELECT status FROM data_gap WHERE id=?', [summaryGap.id]).status, 'open');
    assertIncludes(db.get('SELECT last_action FROM data_gap WHERE id=?', [summaryGap.id]).last_action, 'requeue_summary');
  });

  await testAsync('抓取成功但解析失败：动作如实失败，缺口 open，未新增行情行', async () => {
    const tradeBefore = db.get('SELECT COUNT(*) n FROM cea_trade_daily').n;
    const out = await gaps.runGapAction(admin, parseGap.id, 'retry_cea_fetch');
    assertEqual(out.ok, false, JSON.stringify(out));
    assertEqual(out.status, 'failed');
    assertIncludes(out.message, '抓取成功不等于解析成功');
    assert(parsePageHits >= 1, '应真实访问本机桩页');
    const row = db.get('SELECT * FROM data_gap WHERE id=?', [parseGap.id]);
    assertEqual(row.status, 'open');
    assertIncludes(row.last_action_result, 'parse');
    assertEqual(db.get('SELECT COUNT(*) n FROM cea_trade_daily').n, tradeBefore, '解析失败不得写行情行');
  });

  await testAsync('真实日期缺口保留：分类/重分类不会把缺日期标结清', async () => {
    const out = gaps.triageGaps({ status: 'all', persist: true, includeFields: false });
    assert(out.items.some((g) => g.id === trueGap.id));
    const row = db.get('SELECT * FROM data_gap WHERE id=?', [trueGap.id]);
    assertEqual(row.status, 'open');
    assertEqual(row.classification, 'missing_trade_date');
    assertEqual(row.blocking, 1);
    assertEqual(row.retryable, 1);
    const cum = db.get('SELECT * FROM data_gap WHERE id=?', [cumulativeGap.id]);
    assertEqual(cum.status, 'open', '累计差异不得被重分类关闭');
    assertEqual(cum.classification, 'cumulative_mismatch');
  });
} finally {
  ingest.stopIngestSummaryWorker();
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
}

finish('test/142-v2-gap-triage-actions.test.mjs');
