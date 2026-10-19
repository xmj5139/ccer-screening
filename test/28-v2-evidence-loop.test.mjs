import { setupV2, test, testAsync, assert, assertEqual, finish } from './v2-helpers.mjs';

const { db, collect, reconcile } = await setupV2();
const content = await import('../src/services/content-svc.mjs');
const loop = await import('../src/services/evidence-loop-svc.mjs');

console.log('\n[v2-28] 公开资料证据补全循环');

test('每日 12 次检索覆盖全部 8 个主题，剩余同义词按日期轮换', () => {
  const a = content.buildQueryPlan({ maxQueries: 12, rotationKey: '2026-09-30' });
  const b = content.buildQueryPlan({ maxQueries: 12, rotationKey: '2026-10-01' });
  const groups = new Set(a.map((q) => q.group));
  assertEqual(groups.size, content.KEYWORD_GROUPS.length, '限额内每个主题至少应被检索一次');
  assert(a.some((q) => q.group === 'sink') && a.some((q) => q.group === 'market'), '碳汇和交易市场不能长期漏检');
  assert(a.slice(8).some((q, i) => q.term !== b.slice(8)[i]?.term), '第二轮关键词应随日期轮换');
});

test('公开项目核对排除演示条目，避免无官方来源的假缺口进入循环', () => {
  const demoIds = db.all('SELECT id FROM public_project WHERE is_demo=1').map((r) => r.id);
  assert(demoIds.length > 0, '隔离库应有演示项目供回归验证');
  reconcile.runProjectChecks({ actor: 'test:evidence-loop' });
  for (const id of demoIds) {
    assertEqual(db.get("SELECT COUNT(*) n FROM data_reconciliation WHERE dataset='project' AND object_id=? AND status='open'", [id]).n,
      0, '演示项目不得产生公开库缺口');
  }
});

await testAsync('只有真正取得来源全文才升级正文状态，记录快照并保留原字段', async () => {
  const url = 'https://research.example.cn/ccer-evidence-loop';
  const inserted = content.upsertContent({
    title: 'CCER 公开资料证据循环测试', source_url: url, publisher: '研究机构',
    published_at: '2026-09-30', content_type: 'research_report',
    summary: '仅有摘要', body_snapshot: '摘要内容。'.repeat(22), body_availability: 'partial',
  }, { actor: 'test' });
  const before = db.get('SELECT COUNT(*) n FROM content_version WHERE content_item_id=?', [inserted.id]).n;
  const body = 'CCER 公开资料证据循环测试。公开报告正文提供可核对的政策来源与数据。'.repeat(35);
  const result = await content.repairIncompleteContent({
    actor: 'test', limit: 1, offset: 0, verify: false, connection: { id: 'WFC-TEST', enabled: 1 },
    fetcher: async () => ({ ok: true, content: body, availability: 'full_text', raw_html: '' }),
  });
  const row = db.get('SELECT * FROM content_item WHERE id=?', [inserted.id]);
  assertEqual(result.improved, 1);
  assertEqual(row.body_availability, 'full_text');
  assertEqual(row.published_at, '2026-09-30', '已有发布日期不可丢失');
  assert(row.snapshot_id, '补采正文必须有可追溯来源快照');
  assert(db.get('SELECT COUNT(*) n FROM content_version WHERE content_item_id=?', [inserted.id]).n > before,
    '新正文应保存版本');
});

await testAsync('只有摘要时不升级为已取得全文', async () => {
  const inserted = content.upsertContent({
    title: 'CCER 第二条摘要测试', source_url: 'https://research.example.cn/ccer-abstract-loop',
    publisher: '研究机构', published_at: '2026-10-01', content_type: 'research_report',
    summary: '仅有摘要', body_snapshot: '短摘要', body_availability: 'abstract_only',
  }, { actor: 'test' });
  const result = await content.repairIncompleteContent({
    actor: 'test', limit: 1, offset: 0, verify: false, connection: { enabled: 1 },
    fetcher: async () => ({ ok: true, content: '仍只有摘要', availability: 'abstract_only' }),
  });
  assertEqual(result.improved, 0);
  assertEqual(db.get('SELECT body_availability FROM content_item WHERE id=?', [inserted.id]).body_availability,
    'abstract_only');
});

await testAsync('没有新证据时首轮停止，不会反复调用模型或外部接口', async () => {
  let calls = 0;
  const state = { content_incomplete: 1, content_full_text: 0, snapshots: 0 };
  const out = await loop.runEvidenceLoop({ datasets: ['content'], maxRounds: 3,
    inspect: () => ({ ...state }), repair: async () => { calls += 1; return { content: { improved: 0 } }; },
  });
  assertEqual(calls, 1);
  assertEqual(out.evidence_gained, false);
  assertEqual(out.rounds.length, 1);
});

await testAsync('有新证据才复核，达到轮数上限即停止', async () => {
  let calls = 0;
  let verified = 0;
  const state = { content_incomplete: 3, content_full_text: 0, snapshots: 0 };
  const out = await loop.runEvidenceLoop({ datasets: ['content'], maxRounds: 2,
    inspect: () => ({ ...state }),
    repair: async () => { calls += 1; state.content_full_text += 1; state.snapshots += 1; return { content: { improved: 1 } }; },
    afterProgress: async () => { verified += 1; },
  });
  assertEqual(calls, 2);
  assertEqual(verified, 2);
  assertEqual(out.evidence_gained, true);
  assertEqual(out.rounds.length, 2);
});

await testAsync('每日任务已接入循环；没有服务连接时如实停止且不伪造补采', async () => {
  db.run('UPDATE web_fetch_connection SET enabled=0');
  db.run('UPDATE search_provider SET enabled=0');
  const out = await collect.runDailyJob({
    actor: 'test:evidence-loop', datasets: ['content'], contentMaxItems: 1,
    evidenceLoop: true,
  });
  assert(out.detail.evidence_loop, '每日任务应记录证据循环结果');
  assertEqual(out.detail.evidence_loop.evidence_gained, false);
  assert(out.detail.evidence_loop.stop_reason, '无新证据时要留下停止原因');
});

finish('test/28-v2-evidence-loop.test.mjs');
