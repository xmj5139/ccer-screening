/**
 * 测试 168（docs/86 第二阶段）：用户关注规则、站内更新、已读游标与跨用户 IDOR。
 * 只用 setupV2 临时库；不联网、不调用模型。
 */
import {
  setupV2, test, assert, assertEqual, assertIncludes, finish,
} from './v2-helpers.mjs';

const ctx = await setupV2({ withPublicDemo: false });
const { db } = ctx;
const content = await import('../src/services/content-svc.mjs');
const follow = await import('../src/services/follow-svc.mjs');

console.log('\n[v2-168] 关注规则 / 站内更新 / 已读隔离 / IDOR');

db.run(
  `INSERT OR IGNORE INTO app_user (id,name,role,team_id,active) VALUES (?,?,?,?,1)`,
  ['U-168-A', '用户A', 'viewer', 'T-168']
);
db.run(
  `INSERT OR IGNORE INTO app_user (id,name,role,team_id,active) VALUES (?,?,?,?,1)`,
  ['U-168-B', '用户B', 'viewer', 'T-168']
);
const userA = { id: 'U-168-A', name: '用户A', role: 'viewer' };
const userB = { id: 'U-168-B', name: '用户B', role: 'viewer' };

const bodyA = '瓦斯利用项目位于内蒙古，涉及钢铁行业，方法学编号 CCER-10-001-V01。'.repeat(5);
const itemA = content.upsertContent({
  source_url: 'https://example.test/168/a',
  title: '瓦斯关注测试：内蒙古钢铁项目',
  publisher: '测试发布机构',
  content_type: 'industry_news',
  industry: '钢铁',
  published_at: '2026-09-10',
  body_snapshot: bodyA,
  methodology_ids: ['CCER-10-001-V01'],
}, { actor: 'test:168' });
const reprintA = content.upsertContent({
  source_url: 'https://example.test/168/a-reprint',
  title: '转载：瓦斯关注测试',
  publisher: '转载站',
  content_type: 'industry_news',
  published_at: '2026-09-11',
  body_snapshot: bodyA,
}, { actor: 'test:168' });
const itemB = content.upsertContent({
  source_url: 'https://example.test/168/b',
  title: '污水处理关注测试：广东项目',
  publisher: '测试发布机构',
  content_type: 'industry_news',
  industry: '污水处理',
  published_at: '2026-09-12',
  body_snapshot: '污水处理项目位于广东，涉及甲烷回收。'.repeat(6),
}, { actor: 'test:168' });
content.upsertContent({
  source_url: 'https://example.test/168/demo',
  title: '瓦斯关注测试：演示条目',
  publisher: '测试发布机构',
  content_type: 'industry_news',
  industry: '钢铁',
  published_at: '2026-09-13',
  is_demo: 1,
  body_snapshot: '演示瓦斯项目，不应进入关注信息流。'.repeat(6),
}, { actor: 'test:168' });

test('未设置规则时信息流为空；保存规则至少需要一个条件', () => {
  const empty = follow.listFollowFeed(userA, { limit: 20 });
  assertEqual(empty.ok, true);
  assertEqual(empty.items.length, 0);
  const bad = follow.saveFollowRule(userA, { name: '空规则' });
  assertEqual(bad.ok, false);
  assertEqual(bad.status, 400);
});

let ruleA;
let ruleB;
test('用户保存自己的组合关注规则，只返回自己的规则', () => {
  const saved = follow.saveFollowRule(userA, {
    name: '内蒙古瓦斯钢铁',
    keywords: ['瓦斯'],
    regions: ['内蒙古'],
    industries: ['钢铁'],
    methodologies: ['CCER-10-001-V01'],
    content_types: ['industry_news'],
  });
  assertEqual(saved.ok, true, JSON.stringify(saved));
  ruleA = saved.rule;
  assertEqual(ruleA.keywords[0], '瓦斯');
  const savedB = follow.saveFollowRule(userB, {
    name: '用户B的瓦斯关注', keywords: ['瓦斯'],
  });
  assertEqual(savedB.ok, true);
  ruleB = savedB.rule;
  const listA = follow.listFollowRules(userA);
  const listB = follow.listFollowRules(userB);
  assertEqual(listA.rules.length, 1);
  assertEqual(listB.rules.length, 1);
  assertEqual(listA.rules[0].id, ruleA.id);
  assertEqual(listB.rules[0].id, ruleB.id);
});

test('跨用户规则 IDOR：更新/删除/读取他人规则一律 403，且不泄露规则内容', () => {
  const update = follow.saveFollowRule(userB, {
    id: ruleA.id, name: '劫持', keywords: ['污水'],
  });
  assertEqual(update.ok, false);
  assertEqual(update.status, 403);
  const del = follow.deleteFollowRule(userB, ruleA.id);
  assertEqual(del.ok, false);
  assertEqual(del.status, 403);
  const one = follow.getFollowRule(userB, ruleA.id);
  assertEqual(one.ok, false);
  assertEqual(one.status, 403);
  const feed = follow.listFollowFeed(userB, { ruleId: ruleA.id });
  assertEqual(feed.ok, false);
  assertEqual(feed.status, 403);
  // A 的规则未被 B 修改。
  const still = follow.getFollowRule(userA, ruleA.id);
  assertEqual(still.rule.name, '内蒙古瓦斯钢铁');
});

test('站内信息流按规则组合命中，事件组转载合并但保留来源；演示条目排除', () => {
  const feed = follow.listFollowFeed(userA, { limit: 20 });
  assertEqual(feed.ok, true);
  assertEqual(feed.items.length, 1, `应只命中 A 条，实际 ${feed.items.length}`);
  const item = feed.items[0];
  assertEqual(item.content_item_id, itemA.id);
  assertEqual(item.unread, true);
  assertEqual(item.source_count, 2, '同文转载应合并为一个事件，来源逐条保留');
  assert(item.sources.some((s) => s.content_item_id === reprintA.id), '转载来源必须保留');
  assert(!feed.items.some((x) => x.title.includes('演示')), '演示条目不得进入关注信息流');
  assert(feed.items[0].matched_rules[0].reasons.join('｜').includes('关键词：瓦斯'), '命中理由应可解释');
  assert(feed.note.includes('不代表官方适用范围'), '提示词/展示应明确非官方结论');
});

test('已读状态按用户隔离：B 标记已读不影响 A；正文实质变化后重新未读', () => {
  const bFeedBefore = follow.listFollowFeed(userB, { limit: 20 });
  assertEqual(bFeedBefore.items.length, 1);
  assertEqual(bFeedBefore.items[0].unread, true);
  const bRead = follow.markFollowRead(userB, { contentId: itemA.id });
  assertEqual(bRead.ok, true);
  const bFeedAfter = follow.listFollowFeed(userB, { limit: 20 });
  assertEqual(bFeedAfter.items[0].unread, false);
  const aFeed = follow.listFollowFeed(userA, { limit: 20 });
  assertEqual(aFeed.items[0].unread, true, 'B 的已读不能影响 A 的游标');

  const aRead = follow.markFollowRead(userA, { contentId: itemA.id });
  assertEqual(aRead.ok, true);
  assertEqual(aRead.marked, 2, '事件组已读应覆盖代表条目与转载来源');
  const aFeedRead = follow.listFollowFeed(userA, { limit: 20 });
  assertEqual(aFeedRead.items[0].unread, false);
  assertEqual(aFeedRead.unread_count, 0);

  content.upsertContent({
    source_url: 'https://example.test/168/a',
    title: '瓦斯关注测试：内蒙古钢铁项目（修订）',
    publisher: '测试发布机构',
    content_type: 'industry_news',
    industry: '钢铁',
    published_at: '2026-09-10',
    body_snapshot: `${bodyA}\n本次修订新增了实质性技术要求。`,
    methodology_ids: ['CCER-10-001-V01'],
  }, { actor: 'test:168' });
  const updated = follow.listFollowFeed(userA, { limit: 20 });
  assertEqual(updated.items[0].unread, true, '正文实质变化后应重新显示未读');
  assertEqual(updated.items[0].update_kind, 'body_change');
  assertIncludes(updated.items[0].update_label, '正文实质变化');
});

test('未读过滤、标记全部已读、删除自己的规则后信息流为空', () => {
  follow.markFollowRead(userA, { contentId: itemA.id });
  follow.markFollowRead(userB, { contentId: itemA.id });
  const unread = follow.listFollowFeed(userA, { limit: 20, unreadOnly: true });
  assertEqual(unread.total, 0);
  const readAll = follow.markFollowFeedRead(userA, { limit: 20 });
  assert(readAll.ok);
  const del = follow.deleteFollowRule(userA, ruleA.id);
  assertEqual(del.ok, true);
  const after = follow.listFollowFeed(userA, { limit: 20 });
  assertEqual(after.items.length, 0);
  const bStill = follow.listFollowFeed(userB, { limit: 20, unreadOnly: true });
  assertEqual(bStill.items.length, 0);
  // B 的规则仍在；A 的规则删除不影响 B。
  const bRules = follow.listFollowRules(userB);
  assertEqual(bRules.rules.length, 1);
});

finish('168-v2-follow.test.mjs');
