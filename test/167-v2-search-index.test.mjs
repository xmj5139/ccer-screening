/**
 * 测试 167（docs/86 第二阶段）：中文 FTS5 索引、600 条旧命中、两字词、
 * 英文编号、真实总数分页、筛选/排除口径、增量 hash 与可用性回退。
 * 只用 setupV2 临时库；不联网、不调用模型。
 */
import {
  setupV2, test, assert, assertEqual, assertIncludes, finish,
} from './v2-helpers.mjs';

const ctx = await setupV2({ withPublicDemo: false });
const { db } = ctx;
const search = await import('../src/services/unified-search-svc.mjs');
const index = await import('../src/services/search-index-svc.mjs');
const content = await import('../src/services/content-svc.mjs');

console.log('\n[v2-167] 中文 FTS5：旧记录、两字词、编号、真实分页与增量');

const now = new Date().toISOString();
const OLD_ID = 'CI-167-OLD';
const COMMON = '检索覆盖测试';

function insertContent(id, {
  title = `${COMMON} 批量记录 ${id}`, publisher = '测试机构A', published = '2026-09-01',
  body = `${COMMON} 的正文，包含煤炭消费与甲烷治理内容。`, demo = 0, duplicateOf = null,
  recordKind = 'article', processStatus = 'fetched', source = null,
} = {}) {
  db.run(
    `INSERT INTO content_item
       (id,content_type,record_kind,title,publisher,published_at,discovered_at,source_url,url_hash,
        content_hash,source_category,authority_tier,body_availability,language,summary,body_snapshot,
        body_chars,process_status,is_demo,duplicate_of,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      id, 'industry_news', recordKind, title, publisher, published, now,
      `https://example.test/167/${encodeURIComponent(id)}`, `hash-${id}`, `chash-${id}`,
      'media', 'media_report', 'full_text', 'zh', `${COMMON} 摘要`, body, body.length,
      processStatus, demo, duplicateOf, now, now,
    ]
  );
}

insertContent(OLD_ID, {
  title: '较早的瓦斯治理记录 CCER-10-001-V01',
  published: '2019-01-01',
  body: `这是一条较早的瓦斯利用记录，含特殊旧记录标记 OLDUNIQUE，方法学编号 CCER-10-001-V01。${COMMON}`,
  source: 'https://example.test/167/old',
});
for (let i = 0; i < 599; i += 1) {
  insertContent(`CI-167-${String(i).padStart(3, '0')}`, {
    published: `2026-09-${String((i % 27) + 1).padStart(2, '0')}`,
    body: `${COMMON} 的第 ${i} 条正文，涉及煤炭消费与甲烷治理。`,
  });
}
// 排除口径：演示、转载副本、栏目归档、抓取失败都不能进入索引结果。
insertContent('CI-167-DEMO', { demo: 1 });
insertContent('CI-167-DUP', { duplicateOf: OLD_ID });
insertContent('CI-167-ARCHIVE', { recordKind: 'source_index' });
insertContent('CI-167-FAILED', { processStatus: 'failed_fetch' });
// 地区筛选需要项目/企业名录类型；写入一条真实公开项目。
db.run(
  `INSERT INTO public_project
     (id,registry_project_no,name,owner_name,province,city,domain,methodology_id,current_stage,
      official_url,last_checked_at,note,created_at,updated_at,is_demo)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ['PP-167', 'R-167', `${COMMON} 内蒙古项目`, '测试业主', '内蒙古', '鄂尔多斯', '煤矿瓦斯',
    'CCER-10-001-V01', 'project_registered', 'https://example.test/167/project',
    '2026-09-01', `${COMMON} 项目说明`, now, now, 0]
);

test('索引未构建时如实回退既有检索，不把失败当无结果', () => {
  const st = index.searchIndexStatus();
  assertEqual(st.ready, false);
  const out = search.searchUnified({ q: '瓦斯', types: 'content', page_size: 10 });
  assertEqual(out.mode, 'legacy_fallback');
  assertEqual(out.fallback_reason, 'index_not_ready');
  assert(out.filter_notes.join('｜').includes('回退'), '应说明已回退');
});

test('600 条记录完整构建 FTS5；两字词与英文编号精确命中', () => {
  const built = index.buildSearchIndex({ maxDocs: 20000, actor: 'test:167' });
  assertEqual(built.ok, true);
  const st = index.searchIndexStatus();
  assertEqual(st.ready, true, JSON.stringify(st));
  assert(st.doc_count >= 600, `索引文档数应覆盖 600 条，实际 ${st.doc_count}`);

  const twoChar = search.searchUnified({ q: '瓦斯', types: 'content', page_size: 20 });
  assertEqual(twoChar.mode, 'fts5');
  assertEqual(twoChar.total, 1, `“瓦斯”应只命中较早记录，实际 ${twoChar.total}`);
  assertEqual(twoChar.results[0].entity_id, OLD_ID);
  assertIncludes(twoChar.results[0].title, '瓦斯');

  const code = search.searchUnified({ q: 'CCER-10-001-V01', types: 'content', page_size: 20 });
  assertEqual(code.mode, 'fts5');
  assertEqual(code.total, 1);
  assertEqual(code.results[0].entity_id, OLD_ID);
  const codePrefix = search.searchUnified({ q: 'CCER-10-001', types: 'content', page_size: 20 });
  assertEqual(codePrefix.total, 1, '编号前缀也应命中带 V01 的完整编号');
  assertEqual(codePrefix.results[0].entity_id, OLD_ID);

  const common = search.searchUnified({ q: '检索覆盖', types: 'content', page_size: 50 });
  assertEqual(common.total, 600, `600 条普通命中之外不得混入演示/转载/归档/失败条目，实际 ${common.total}`);
  const ids = common.results.map((r) => r.entity_id);
  assert(!ids.includes('CI-167-DEMO') && !ids.includes('CI-167-DUP')
    && !ids.includes('CI-167-ARCHIVE') && !ids.includes('CI-167-FAILED'), '排除口径必须保留');
  const browse = search.searchUnified({ types: 'content', page_size: 50 });
  assertEqual(browse.mode, 'fts5');
  assertEqual(browse.empty_query, true);
  assertEqual(browse.total, 600, '空查询浏览也应使用索引真实总数');
  assertEqual(browse.results.length, 50);
});

test('真实总数与分页可达：600 条可翻到第 12 页，不是 400 条截断', () => {
  const p1 = search.searchUnified({ q: '检索覆盖', types: 'content', page_size: 50, page: 1 });
  const p12 = search.searchUnified({ q: '检索覆盖', types: 'content', page_size: 50, page: 12 });
  assertEqual(p1.total, 600);
  assertEqual(p12.total, 600);
  assertEqual(p1.total_pages, 12);
  assertEqual(p1.results.length, 50);
  assertEqual(p12.results.length, 50, '第 12 页必须真实可达');
  const all = new Set([...p1.results, ...p12.results].map((r) => r.entity_id));
  assertEqual(all.size, 100, '两页不得重复');
  assert(!p1.pagination_truncated && !p12.pagination_truncated, '600 条不应报分页截断');
});

test('来源/日期/类型/地区筛选与排除口径在索引模式一致', () => {
  const bySource = search.searchUnified({ q: '检索覆盖', types: 'content', source: '测试机构A', page_size: 50 });
  assertEqual(bySource.total, 600);
  const noSource = search.searchUnified({ q: '检索覆盖', types: 'content', source: '不存在机构', page_size: 50 });
  assertEqual(noSource.total, 0);
  const byDate = search.searchUnified({
    q: '检索覆盖', types: 'content', from: '2019-01-01', to: '2019-12-31', page_size: 50,
  });
  assertEqual(byDate.total, 1, '旧记录必须能通过日期窗口命中');
  assertEqual(byDate.results[0].entity_id, OLD_ID);
  const future = search.searchUnified({
    q: '检索覆盖', types: 'content', from: '2026-01-01', to: '2026-12-31', page_size: 50,
  });
  assertEqual(future.total, 599, '2019 旧记录不应进入 2026 窗口');
  const region = search.searchUnified({ q: '检索覆盖', types: 'project', region: '内蒙古', page_size: 50 });
  assertEqual(region.total, 1);
  assertEqual(region.results[0].type, 'project');
  assertEqual(region.results[0].date_label, '最近核对日期');
});

test('增量构建按来源 hash 跳过未变化记录；正文变化后更新并可检索新词', () => {
  const again = index.buildSearchIndex({ maxDocs: 20000, actor: 'test:167' });
  assert(again.skipped >= 600, `未变化记录应命中 hash 跳过，实际 skipped=${again.skipped}`);
  assertEqual(again.inserted, 0);
  assertEqual(again.updated, 0);

  const id = 'CI-167-000';
  db.run(
    `UPDATE content_item SET title=?,body_snapshot=?,content_hash=?,updated_at=? WHERE id=?`,
    ['增量更新后的独有关键词XXX', '正文新增独有关键词XXX。', 'chash-updated-167', new Date().toISOString(), id]
  );
  const changed = index.buildSearchIndex({ maxDocs: 20000, actor: 'test:167' });
  assert(changed.updated >= 1, `正文变化应更新索引，实际 updated=${changed.updated}`);
  const hit = search.searchUnified({ q: '独有关键词XXX', types: 'content', page_size: 10 });
  assertEqual(hit.total, 1);
  assertEqual(hit.results[0].entity_id, id);
  const old = search.searchUnified({ q: '检索覆盖', types: 'content', page_size: 50 });
  assert(!old.results.some((r) => r.entity_id === id && r.title.includes('批量记录')), '旧文本不应作为最新文本');
});

test('索引完整后 content 写入走单条增量刷新，无需全库重建即可检索', () => {
  const item = content.upsertContent({
    source_url: 'https://example.test/167/incremental-live',
    title: '增量刷新即时命中关键词LIVE',
    publisher: '测试机构A',
    content_type: 'industry_news',
    published_at: '2026-09-20',
    body_snapshot: '增量刷新即时命中关键词LIVE的正文。'.repeat(8),
  }, { actor: 'test:167' });
  const hit = search.searchUnified({ q: '关键词LIVE', types: 'content', page_size: 10 });
  assertEqual(hit.mode, 'fts5');
  assertEqual(hit.total, 1, JSON.stringify({
    status: index.searchIndexStatus(), mode: hit.mode,
    raw: db.get('SELECT entity_id,title,title_tokens,body_tokens FROM search_index_doc WHERE entity_id=?', [item.id]),
    base: db.get('SELECT id,record_kind,process_status,is_demo,duplicate_of FROM content_item WHERE id=?', [item.id]),
    notes: hit.filter_notes,
  }));
  assertEqual(hit.results[0].entity_id, item.id);
});

test('管理覆盖层：管理员修订合并进索引，不更新业务表；检索值与 manual 标记可见', () => {
  db.run(
    `INSERT INTO admin_revision
       (id,entity_type,entity_id,field_key,value,original_value,revision_no,status,note,actor,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    ['REV-167', 'content_item', OLD_ID, 'title', '管理员修订后的瓦斯标题', '较早的瓦斯治理记录 CCER-10-001-V01', 1,
      'active', '测试覆盖层', 'test:167', now]
  );
  const built = index.buildSearchIndex({ maxDocs: 20000, actor: 'test:167' });
  assert(built.updated >= 1, '覆盖层变化应更新索引记录');
  const out = search.searchUnified({ q: '管理员修订后的瓦斯', types: 'content', page_size: 10 });
  assertEqual(out.total, 1);
  assertEqual(out.results[0].title, '管理员修订后的瓦斯标题');
  assertEqual(out.results[0].manual_revision, true);
  assert(out.results[0].manual_fields.includes('title'));
  const base = db.get('SELECT title FROM content_item WHERE id=?', [OLD_ID]);
  assertIncludes(base.title, '较早的瓦斯治理记录', '业务表原始标题不得被覆盖层 UPDATE');
});

test('索引损坏/不可用时回退既有检索并显示 mode，不静默空结果', () => {
  db.run('DROP TABLE search_index_fts');
  const out = search.searchUnified({ q: '检索覆盖', types: 'content', page_size: 10 });
  assertEqual(out.mode, 'legacy_fallback');
  assertEqual(out.fallback_reason, 'index_unavailable');
  assert(out.filter_notes.join('｜').includes('回退'), '应提示索引不可用并回退');
});

finish('167-v2-search-index.test.mjs');
