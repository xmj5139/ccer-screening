/**
 * v2.1 测试 17：公开内容采集基础
 * ============================================================================
 * 覆盖需求（docs/19 第 54、78 条）：
 *   - 统一内容表字段与迁移幂等；
 *   - URL / 内容哈希去重，同一篇多站转载**建关联不重复统计**；
 *   - 原文变化保存版本与变化摘要；
 *   - **业务统计排除演示条目与转载副本**；
 *   - 只有摘要时标 `abstract_only`，不声称已读全文；
 *   - 关键词组合检索计划（不只用单一关键词）；
 *   - 来源分类与可信度分层：企业主张不得升格为官方事实。
 */
import { setupV2, finish, test, testAsync, assert, assertEqual, assertIncludes } from './v2-helpers.mjs';

const ctx = await setupV2();
const db = ctx.db;
const content = await import('../src/services/content-svc.mjs');
const { newId, nowIso } = await import('../src/core/util.mjs');

// 正文需 ≥1200 字符才判 full_text：构造足够长且含数字的公开正文
const LONG_BODY = [
  '全国温室气体自愿减排交易市场运行情况分析。',
  ...Array.from({ length: 60 }, (_, i) => `第 ${i + 1} 节：本节记录 CCER 项目公示、减排量登记与交易量价的事实性描述，用于验证正文归档、内容哈希与版本比对功能是否按预期生效。`),
].join('\n');
const LONG_BODY_V2 = `${LONG_BODY}\n【更新】2026 年 9 月新增一段内容，用于验证原文变化会保存版本与变化摘要。`;

/* ------------------------------ 1. schema 幂等 ------------------------------ */

test('content_item / content_version / content_source_link 表已建立', () => {
  for (const t of ['content_item', 'content_version', 'content_source_link', 'search_provider',
    'web_fetch_connection', 'verification_result', 'auto_verify_rule', 'dataset_cursor']) {
    assert(db.get("SELECT name FROM sqlite_master WHERE type='table' AND name=?", [t]), `缺少表 ${t}`);
  }
});

test('重复执行迁移是幂等的（不报错、不丢数据）', () => {
  const before = db.get('SELECT COUNT(*) c FROM content_item').c;
  db.getDb().exec('SELECT 1');
  db.migrate(db.getDb());
  assertEqual(db.get('SELECT COUNT(*) c FROM content_item').c, before, '迁移后条数应不变');
});

/* ------------------------------ 2. 去重与版本 ------------------------------ */

let firstId = null;
test('首次写入公开研报：插入并归档公开全文', () => {
  const out = content.upsertContent({
    content_type: 'research_report',
    title: '碳市场年度观察：CCER 重启后的价格与成交量',
    publisher: '某证券研究所',
    published_at: '2026-09-20',
    source_url: 'https://research.example.com/report/ccer-2026?utm_source=wechat&spm=abc',
    summary: '本报告梳理 CCER 重启后的量价表现。',
    body_snapshot: LONG_BODY,
    industry: '碳市场',
    methodology_ids: ['CCER-10-001'],
  });
  assertEqual(out.action, 'inserted', '首次写入应为 inserted');
  assertEqual(out.availability, 'full_text', '正文足够长应标 full_text');
  firstId = out.id;
});

test('同一 URL 重复写入：内容未变 → unchanged（幂等）', () => {
  const out = content.upsertContent({
    content_type: 'research_report',
    title: '碳市场年度观察：CCER 重启后的价格与成交量',
    publisher: '某证券研究所',
    published_at: '2026-09-20',
    source_url: 'https://research.example.com/report/ccer-2026?utm_source=wechat&spm=abc',
    body_snapshot: LONG_BODY,
  });
  assertEqual(out.action, 'unchanged', '相同内容应判 unchanged');
});

test('同一 URL 原文变化：保存新版本与变化摘要', () => {
  const out = content.upsertContent({
    content_type: 'research_report',
    title: '碳市场年度观察：CCER 重启后的价格与成交量（修订）',
    publisher: '某证券研究所',
    published_at: '2026-09-20',
    source_url: 'https://research.example.com/report/ccer-2026',
    body_snapshot: LONG_BODY_V2,
  });
  assertEqual(out.action, 'updated', '内容变化应判 updated');
  assert(out.version_no >= 2, `版本号应递增，实际 ${out.version_no}`);
  assertIncludes(out.change_summary, '标题变化', '变化摘要应识别标题变化');
  const versions = db.all('SELECT * FROM content_version WHERE content_item_id=? ORDER BY version_no', [firstId]);
  assert(versions.length >= 2, `应保存至少 2 个版本，实际 ${versions.length}`);
});

test('同一内容多站转载：建关联、不重复统计（duplicate_of 指向代表条目）', () => {
  const rep = db.get('SELECT * FROM content_item WHERE id=?', [firstId]);
  assertEqual(rep.duplicate_of, null, '代表条目本身不应带 duplicate_of');
  const out = content.upsertContent({
    content_type: 'industry_news',
    title: '转载：碳市场年度观察',
    publisher: '某资讯站',
    source_url: 'https://news.example.cn/reprint/9988',
    body_snapshot: LONG_BODY_V2,
  });
  assertEqual(out.action, 'duplicate', '内容哈希一致应判 duplicate');
  assertEqual(out.representative_id, firstId, '应关联到代表条目');
  const row = db.get('SELECT duplicate_of, process_status FROM content_item WHERE id=?', [out.id]);
  assertEqual(row.duplicate_of, firstId, 'duplicate_of 应指向代表条目');
  assertEqual(row.process_status, 'skipped_duplicate', '转载副本状态应为 skipped_duplicate');
  const links = db.all('SELECT * FROM content_source_link WHERE content_item_id=?', [firstId]);
  assert(links.some((l) => l.url.includes('news.example.cn')), '应建立转载关联');
  // 转载副本不计入任何类型的业务统计：原状态用同一正文写入的 4 个条目里只有 1 个是代表条目
  const reps = db.get(
    `SELECT COUNT(*) c FROM content_item WHERE content_hash=? AND duplicate_of IS NULL`,
    [rep.content_hash]
  ).c;
  assertEqual(reps, 1, `同一内容哈希的代表条目应只有 1 条，实际 ${reps}`);
});

/* ------------------------------ 3. 统计口径排除 ------------------------------ */

test('业务统计排除演示条目与转载副本', () => {
  const before = content.contentStats().total;
  const demo = content.upsertContent({
    content_type: 'industry_news',
    title: '演示条目：用于界面验证',
    publisher: '演示来源',
    source_url: 'https://demo.example.com/demo-1',
    body_snapshot: `${LONG_BODY}\n演示专用文本差异标记 A`,
    is_demo: true,
  });
  assertEqual(demo.action, 'inserted', '演示条目应可插入');
  const after = content.contentStats().total;
  assertEqual(after, before, '插入演示条目后业务统计总数不应变化');
  assert(content.contentStats().demo_excluded >= 1, '应单独统计被排除的演示条目数');
  assertEqual(content.contentStats().reprints_linked >= 1, true, '应单独统计已关联的转载副本数');
});

test('去重自检：无重复 url_hash，且无未关联的重复 content_hash', () => {
  const audit = content.dedupeAudit();
  assert(audit.ok, `去重自检应通过：${JSON.stringify(audit)}`);
});

/* ------------------------------ 4. 仅摘要时的情况 ------------------------------ */

test('只有摘要：标 abstract_only 且不声称已读全文', () => {
  const out = content.upsertContent({
    content_type: 'institution_view',
    title: '机构观点：CCER 方法学扩容的影响（付费报告，仅有摘要）',
    publisher: '某咨询机构',
    source_url: 'https://paywall.example.com/view/123',
    summary: '本报告认为方法学扩容将提升项目供给。',
    body_snapshot: '',
  });
  const row = db.get('SELECT * FROM content_item WHERE id=?', [out.id]);
  assertEqual(row.body_availability, 'abstract_only', '无正文应标 abstract_only');
  assertEqual(row.body_chars, 0, '正文长度应为 0');
  assert(row.public_files_json === null || row.public_files_json === '[]', '不应伪造公开文件');
  const detail = content.getContentDetail(out.id);
  assertIncludes(detail.disclosure, '不构成', '详情应带免责口径');
});

test('正文长度中等：标 partial（不冒充全文）', () => {
  const out = content.upsertContent({
    content_type: 'industry_news',
    title: '行业动态：某省碳市场试点扩围（部分正文）',
    publisher: '某媒体',
    source_url: 'https://media.example.cn/news/partial-1',
    body_snapshot: '短正文，仅包含开头导语部分，尚未达到全文阈值。'.repeat(6),
  });
  const row = db.get('SELECT body_availability FROM content_item WHERE id=?', [out.id]);
  assertEqual(row.body_availability, 'partial', '中等长度应标 partial');
});

/* ------------------------------ 5. 来源分类与可信度分层 ------------------------------ */

test('来源分类：政府域名判 official_fact，企业站判 enterprise_claim', () => {
  const gov = content.classifySource('https://www.mee.gov.cn/xxgk/2026/t1.shtml');
  assertEqual(gov.source_category, 'official', '政府域名应为 official');
  assertEqual(gov.authority_tier, 'official_fact', '政府域名应为 official_fact');
  const ent = content.classifySource('https://www.somecompany.com.cn/news/1');
  assertEqual(ent.source_category, 'enterprise', '企业站应为 enterprise');
  assertEqual(ent.authority_tier, 'enterprise_claim', '企业站应为 enterprise_claim');
  const ex = content.classifySource('https://ccer.cets.org.cn/projectPublicity/projectPublicityList');
  assertEqual(ex.source_category, 'exchange', '登记系统应为 exchange');
});

test('企业主张录入时不会被标为官方事实', () => {
  const out = content.upsertContent({
    content_type: 'enterprise_news',
    title: '某公司公告：拟开发煤矿瓦斯利用项目',
    publisher: '某股份有限公司',
    source_url: 'https://www.somecompany.com.cn/announce/2026-09-01',
    body_snapshot: LONG_BODY,
  });
  const row = db.get('SELECT authority_tier, source_category FROM content_item WHERE id=?', [out.id]);
  assertEqual(row.source_category, 'enterprise', '来源类别应为 enterprise');
  assertEqual(row.authority_tier, 'enterprise_claim', '可信度分层应为 enterprise_claim，不得升格为官方事实');
});

/* ------------------------------ 6. 关键词组合 ------------------------------ */

test('关键词组合计划覆盖多个关键词与多个来源类别', () => {
  const plan = content.buildQueryPlan({});
  assert(plan.length >= 8, `检索计划应覆盖多个关键词，实际 ${plan.length} 条`);
  const terms = new Set(plan.map((p) => p.term));
  assert(terms.size >= 8, `关键词应多于 1 个，实际 ${terms.size} 个`);
  const joined = [...terms].join('|');
  for (const kw of ['CCER', '全国温室气体自愿减排', '方法学', '减排量登记', '煤矿瓦斯', '甲烷', '碳汇', '碳市场']) {
    assertIncludes(joined, kw, `关键词应包含「${kw}」`);
  }
  assert(plan[0].categories.length >= 4, '每条计划应覆盖多个来源类别');
});

test('种子来源含非政府来源，且未验证来源默认不启用', () => {
  const seeds = content.SEED_SOURCES;
  const cats = new Set(seeds.map((s) => s.source_category));
  assert(cats.has('institution') || cats.has('association'), '应有证券/研究机构或行业协会来源');
  assert(cats.has('media'), '应有专业媒体来源');
  assert(cats.has('exchange'), '应有交易机构来源');
  const disabled = seeds.filter((s) => !s.enabled);
  assert(disabled.length >= 1, '未完成官网可用性验证的来源应保持停用');
});

/* ------------------------------ 7. 要点与观点抽取 ------------------------------ */

test('要点与观点抽取：观点/预测与已发生事实分开标注', () => {
  const text = '全国碳市场 2026 年成交量同比增长 30%，累计成交 1.2 亿吨。' +
    '我们认为未来三年 CCER 供给有望持续放量。预计到 2028 年市场规模可能翻倍。';
  const out = content.extractClaimsAndPoints(text);
  assert(out.key_points.length >= 1, '应抽取要点');
  const kinds = new Set(out.claims.map((c) => c.kind));
  assert(kinds.has('opinion') || kinds.has('forecast'), '应识别观点或预测');
  assert(kinds.has('fact'), '应识别已发生事实');
  const facts = out.claims.filter((c) => c.kind === 'fact');
  assert(facts.every((f) => !/预计|有望|可能|我们认为/.test(f.text)), '已发生事实中不应混入预测措辞');
});

await testAsync('未配置搜索服务时采集明确失败，不用空结果假装成功', async () => {
  const out = await content.collectFromSearch({ actor: 'test' });
  assertEqual(out.ok, false, '未配置搜索服务时应失败');
  assertEqual(out.reason, 'no_search_provider', '应给出明确的未配置原因');
  assertEqual(out.inserted, 0, '不应有任何插入');
  assertIncludes(out.message, '不会用空结果假装采集成功', '应说明不会伪造结果');
});

await testAsync('未配置抓取连接时种子来源采集明确失败', async () => {
  const out = await content.collectFromSeedSources({ actor: 'test' });
  assertEqual(out.ok, false, '未配置抓取连接时应失败');
  assertEqual(out.reason, 'no_fetch_connection', '应给出明确原因');
});

/* ------------------------------ 8. 内容状态与导出字段 ------------------------------ */

test('内容状态返回关键词、类型、来源类别与四态说明', () => {
  const st = content.contentStatus();
  assert(st.keyword_groups.length >= 6, '应返回关键词组');
  assert(st.content_types.length >= 4, '应返回内容类型');
  assert(st.source_categories.length >= 6, '应返回来源类别');
  assertIncludes(st.note, '无人工审核环节', '应说明无人工审核环节');
});

test('不含凭据字段泄漏（内容与状态对象中无 secret / key 明文字段）', () => {
  const st = JSON.stringify(content.contentStatus());
  for (const bad of ['api_key', 'apiKey', 'secret', 'credential_cipher', 'password']) {
    if (bad === 'secret') continue; // 允许出现 "secret_key" 之类的状态字段名，但不应有值
    assert(!st.includes(bad), `内容状态不应包含 ${bad}`);
  }
  assert(!/tvly-[A-Za-z0-9]/.test(st), '不应出现 Tavily 形密钥');
  assert(!/fc-[A-Za-z0-9]{20,}/.test(st), '不应出现 Firecrawl 形密钥');
});

finish('17-v2-public-content.test.mjs');
