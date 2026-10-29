/**
 * 测试 124（docs/74 A）：处理阶段、摘要/核验分离、正文变更失效、有界重试、租约。
 * 只使用临时库；不联网（种子采集使用注入的 fetch/verify 替身）。
 */
import {
  setupV2, test, testAsync, assert, assertEqual, assertIncludes, finish,
} from './v2-helpers.mjs';

const ctx = await setupV2({ withPublicDemo: false });
const { db } = ctx;
const content = await import('../src/services/content-svc.mjs');
const gov = await import('../src/services/governance-svc.mjs');
const stage = await import('../src/services/processing-stage-svc.mjs');
const summarySvc = await import('../src/services/summary-svc.mjs');
const verificationSvc = await import('../src/services/verification-svc.mjs');

console.log('\n[v2-124] 信息治理：五阶段、摘要/核验分离、失效与租约');

const admin = { id: 'u-admin', name: 'admin-test', role: 'admin' };
const viewer = { id: 'u-viewer', name: 'viewer', role: 'viewer' };

const body = '这是一篇用于处理阶段测试的公开研报正文，包含碳市场公开信息与方法学讨论。'.repeat(20);
const created = content.upsertContent({
  source_url: 'https://www.example.gov.cn/report/2026/001.html',
  title: '公开研报：全国碳市场年度观察（测试）',
  publisher: '示例研究机构', content_type: 'research_report',
  published_at: '2026-09-10', body_snapshot: body,
}, { actor: 'test:124' });
const ID = created.id;

test('新条目写入五阶段：发现/获取/解析完成，摘要/核验待处理', () => {
  const rows = db.all('SELECT stage,status,attempts,completed_at,source_locator FROM processing_stage WHERE object_id=? ORDER BY stage', [ID]);
  assertEqual(rows.length, 5, `应有 5 个阶段，实际 ${rows.length}`);
  const by = Object.fromEntries(rows.map((r) => [r.stage, r]));
  for (const s of ['discovered', 'fetched', 'parsed']) {
    assertEqual(by[s]?.status, 'done', `${s} 应为 done`);
    assert(!!by[s].completed_at, `${s} 应保留完成时间`);
  }
  assertEqual(by.summarized.status, 'pending');
  assertEqual(by.verified.status, 'pending');
  assert(by.discovered.source_locator.includes('example.gov.cn'), '发现阶段应保留来源定位');
});

test('无模型时摘要记为 blocked，不会写成已完成/已核验', async () => {
  const out = await gov.processPending({ actor: 'test', limit: 1, only: ['summarized'], budgetMs: 5000 });
  assertEqual(out.scanned, 1, JSON.stringify(out));
  assertEqual(out.blocked, 1, '无模型应阻塞而不是成功');
  const s = db.get("SELECT * FROM processing_stage WHERE object_id=? AND stage='summarized'", [ID]);
  assertEqual(s.status, 'blocked');
  assert(s.attempts >= 1, '应记录尝试次数');
  assert(!!s.next_retry_at, '应写入退避后的下次重试时间');
  assertIncludes(s.failure_reason || '', '模型', '阻塞原因应明确是模型未配置');
  assertEqual(db.get("SELECT status FROM processing_stage WHERE object_id=? AND stage='verified'", [ID]).status, 'pending',
    '摘要阻塞不得改变核验阶段的独立状态');
  // 退避未到，不重复处理
  const again = await gov.processPending({ actor: 'test', limit: 1, only: ['summarized'], budgetMs: 5000 });
  assertEqual(again.scanned, 0, '同一失败未到重试时间不应重复调用');
});

test('摘要成功与核验 unavailable 分成两个状态展示', () => {
  const now = new Date(Date.now() + 1000).toISOString();
  const input = summarySvc.loadSummaryInput('content_item', ID);
  const inputHash = summarySvc.summaryInputHash(input);
  db.run(
    `INSERT OR REPLACE INTO entity_summary
       (id,entity_type,entity_id,input_hash,prompt_version,model_key,status,summary,input_kind,input_chars,scope_note,
        provider_id,model,attempts,generated_at,created_at,updated_at)
     VALUES (?,?,?,?,?,?, 'ok', ?, 'full_text', ?, ?, 'p1', 'test-model', 1, ?, ?, ?)`,
    [`SUM-124`, 'content_item', ID, inputHash, summarySvc.PROMPT_VERSION, summarySvc.currentModelKey(),
      '这是依据公开全文生成的测试摘要。', body.length, '公开全文', now, now, now]
  );
  const currentVerification = verificationSvc.contentVerificationInput(ID);
  db.run(
    `INSERT INTO verification_result
       (id,object_type,object_id,result,ui_state,rules_ok,rules_json,model_used,provider_id,model,
        evidence_level,capability_note,summary,input_hash,input_hash_scheme,policy_hash,model_key,evidence_hash,
        citations_validated,citations_rejected,prompt_chars,error,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ['VR-124', 'content_item', ID, 'unavailable', 'not_verified', 1, '[]', 0, null, null,
      'full_text', '未配置可用模型', '暂未自动核验：未配置模型', currentVerification.inputHash,
      verificationSvc.INPUT_HASH_SCHEME, 'p', 'none', 'e',
      0, 0, 0, 'no_provider', now]
  );
  stage.syncContentStages(ID);
  const sum = db.get("SELECT * FROM processing_stage WHERE object_id=? AND stage='summarized'", [ID]);
  const ver = db.get("SELECT * FROM processing_stage WHERE object_id=? AND stage='verified'", [ID]);
  assertEqual(sum.status, 'done', '摘要阶段应完成');
  assertEqual(ver.status, 'blocked', '核验 unavailable 应为 blocked');
  assertIncludes(ver.failure_reason || '', '未配置', '核验阻塞原因应保留且为不可用原因');
  const detail = gov.getGovernanceItem(ID);
  assertEqual(detail.summary?.status, 'ok');
  assertEqual(detail.verifications[0]?.result, 'unavailable');
  assert(detail.stages.find((s) => s.stage === 'summarized').status === 'done');
  assert(detail.stages.find((s) => s.stage === 'verified').status === 'blocked');
});

test('正文变更后摘要/核验立即 stale，旧完成状态不被沿用', () => {
  const changed = body + '\n\n修订：新增了一段需要重新核验的公开内容。'.repeat(5);
  const up = content.upsertContent({
    source_url: 'https://www.example.gov.cn/report/2026/001.html',
    title: '公开研报：全国碳市场年度观察（测试修订）',
    publisher: '示例研究机构', content_type: 'research_report',
    published_at: '2026-09-10', body_snapshot: changed,
  }, { actor: 'test:124' });
  assertEqual(up.action, 'updated');
  const rows = db.all("SELECT stage,status,attempts FROM processing_stage WHERE object_id=? AND stage IN ('summarized','verified')", [ID]);
  for (const r of rows) {
    assertEqual(r.status, 'stale', `${r.stage} 应为 stale`);
    assertEqual(r.attempts, 0, '失效后尝试次数应重置');
  }
  const item = db.get('SELECT verification_status FROM content_item WHERE id=?', [ID]);
  assert(item.verification_status === null, '业务表的旧核验状态应清空');
});

test('管理角色与普通角色：治理接口服务端 403', async () => {
  const a = await gov.runGovernanceBatch(viewer, { limit: 1 });
  assertEqual(a.status, 403);
  const b = await gov.retryStage(viewer, { objectId: ID, stage: 'summarized' });
  assertEqual(b.status, 403);
  const c = gov.listPipeline({ sync: false });
  assert(Array.isArray(c.funnel) && c.funnel.length === 5, '管理员漏斗应有五个阶段');
  assert(c.items.every((i) => i.summary_status && i.verify_status), '条目应分别携带摘要/核验状态');
});

test('租约：同 key 未到期不可抢占，释放后可取得；到期可接续', () => {
  const a = gov.acquireLease({ key: 'collection', owner: 't-a', purpose: 'test', ttlMs: 60000 });
  assertEqual(a.ok, true);
  const b = gov.acquireLease({ key: 'collection', owner: 't-b', purpose: 'test', ttlMs: 60000 });
  assertEqual(b.ok, false);
  assertEqual(b.reason, 'lease_busy');
  gov.releaseLease({ key: 'collection', owner: 't-a' });
  const c = gov.acquireLease({ key: 'collection', owner: 't-c', purpose: 'test', ttlMs: 60000 });
  assertEqual(c.ok, true);
  db.run("UPDATE governance_lease SET expires_at='2000-01-01T00:00:00.000Z' WHERE lease_key='collection'");
  const d = gov.acquireLease({ key: 'collection', owner: 't-d', purpose: 'test', ttlMs: 60000 });
  assertEqual(d.ok, true, '过期租约应可由新任务接续');
  gov.releaseLease({ key: 'collection', owner: 't-d' });
});

await testAsync('collectFromSeedSources 的 verify 参数真正执行（使用测试替身）', async () => {
  let verifyCalls = 0;
  const fakeSource = [{
    id: 'src-fake', name: '测试来源', url: 'https://example.test/', source_category: 'official',
    kinds: ['industry_news'], enabled: 1, is_index: true, article_paths: ['/news/'], max_articles: 1,
  }];
  const fetchPage = async (url) => {
    if (url.includes('/news/2026/09/10/001.html')) {
      return {
        ok: true, content: '公开新闻正文。'.repeat(50), chars: 350,
        raw_html: '<html><head><meta name="description" content="摘要"></head><body><article>公开新闻正文</article></body></html>',
        title: '测试新闻',
      };
    }
    return {
      ok: true, content: 'index',
      raw_html: '<a href="/news/2026/09/10/001.html">CCER 碳市场测试新闻</a>', title: '首页',
    };
  };
  const out = await content.collectFromSeedSources({
    actor: 'test:124', seedSources: fakeSource, fetchLimit: 1, maxArticlesPerSource: 1,
    archiveHomepages: false, verify: true, connection: { id: 'fake-fetch', name: '测试抓取' },
    fetchPage,
    verifyFn: async (id) => { verifyCalls += 1; return { id, result: 'insufficient' }; },
  });
  assertEqual(out.articles_fetched, 1, JSON.stringify(out));
  assertEqual(out.verified, 1, 'verify=true 应执行核验替身');
  assertEqual(verifyCalls, 1);
  assertEqual(out.verify_results.insufficient, 1);
});

await testAsync('达到尝试上限后停止自动重试，状态为 blocked 而不是 pending', async () => {
  const item = content.upsertContent({
    source_url: 'https://www.example.gov.cn/report/2026/max-attempt.html',
    title: '重试上限测试条目', publisher: '示例研究机构', content_type: 'industry_news',
    published_at: '2026-09-12', body_snapshot: '重试上限测试正文。'.repeat(40),
  }, { actor: 'test:124' });
  db.run(
    "UPDATE processing_stage SET status='pending', attempts=3, next_retry_at='2000-01-01T00:00:00.000Z' WHERE object_id=? AND stage='summarized'",
    [item.id]
  );
  await gov.processPending({ actor: 'test', limit: 20, only: ['summarized'], budgetMs: 5000 });
  const s = db.get("SELECT * FROM processing_stage WHERE object_id=? AND stage='summarized'", [item.id]);
  assertEqual(s.status, 'blocked', '达到上限后必须为 blocked');
  assertEqual(s.next_retry_at, null, '达到上限后不再自动排期');
  assertEqual(s.attempts, 3, '尝试次数保留供审计');
  assertIncludes(s.failure_reason || '', '上限');
});

finish('test/124-v2-information-governance.test.mjs');
