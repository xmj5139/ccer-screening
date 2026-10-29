/**
 * 测试 170（docs/86 第一阶段独立验收修正）：
 *   · 真实生态环境部瓦斯通知：清洗后只有 2024-12-31 落款，
 *     模型/规则都不能把落款当 publish_date（含“日期+印发”页脚）。
 *   · 阈值不能仅凭相同数字接受错误单位/方向。
 *   · 地区/行业只能是“正文提及”，字段展示与模型提示词明确非官方结论。
 * 只用 setupV2 临时库；模型调用全部注入替身，不联网、不读密钥。
 */
import {
  setupV2, test, testAsync, assert, assertEqual, assertIncludes, finish,
} from './v2-helpers.mjs';

const ctx = await setupV2({ withPublicDemo: false });
const { db } = ctx;
const content = await import('../src/services/content-svc.mjs');
const fields = await import('../src/services/field-evidence-svc.mjs');

console.log('\n[v2-170] 日期语义 / 阈值单位方向 / 提及边界独立失败用例');

const now = new Date().toISOString();
db.run(
  `INSERT OR IGNORE INTO llm_provider
     (id,name,provider_kind,base_url,model,enabled,created_at,updated_at)
   VALUES (?,?,?,?,?,1,?,?)`,
  ['LLM-170', '注入替身模型', 'openai_compatible', 'https://example.invalid/v1', 'test-model', now, now]
);

// 真实回执正文的核心结构：标题含“发布”，正文末尾只有落款，没有“发布日期”标签。
const realBody = [
  '关于发布《温室气体自愿减排项目方法学 甲烷体积浓度低于8%的煤矿低浓度瓦斯和风排瓦斯利用（CCER—10—001—V01）》的通知',
  '为实施积极应对气候变化国家战略，鼓励更广泛的行业、企业自愿参与温室气体减排行动。现予以发布，并就做好《方法学》贯彻执行通知如下。',
  '一、坚持诚信和自愿原则，引导动员社会减排。',
  '二、加强信息公开，自觉接受公众和媒体监督。',
  '三、强化事中事后监管，确保项目规范实施。',
  '四、本通知自印发之日起施行。',
  '生态环境部办公厅',
  '国家能源局综合司',
  '国家矿山安全监察局综合司',
  '2024年12月31日',
  '（此件社会公开）',
  '抄送：市场监管总局办公厅，各省（自治区、直辖市）和新疆生产建设兵团生态环境厅（局）。',
].join('\n');
const realItem = content.upsertContent({
  source_url: 'https://www.mee.gov.cn/xxgk2018/xxgk/xxgk06/202501/t20250103_1099965.html',
  title: '关于发布《温室气体自愿减排项目方法学 甲烷体积浓度低于8%的煤矿低浓度瓦斯和风排瓦斯利用（CCER—10—001—V01）》的通知',
  publisher: '生态环境部办公厅',
  content_type: 'policy_notice',
  published_at: '2025-01-03',
  body_snapshot: realBody,
}, { actor: 'test:170' });

test('规则抽取：真实回执只有落款时不得生成 publish_date/effective_date', () => {
  const out = fields.extractDeterministicFields('content_item', realItem.id, { actor: 'test:170' });
  assertEqual(out.ok, true);
  const keys = out.fields.map((f) => f.field_key);
  assert(!keys.includes('publish_date'), `落款日期不得成为发布日期，实际 ${keys.join(',')}`);
  assert(!keys.includes('effective_date'), `“自印发之日起”没有具体日期，不得生成生效日期，实际 ${keys.join(',')}`);
  const current = fields.getFieldEvidence('content_item', realItem.id);
  assertEqual(current.fields.filter((f) => f.field_key === 'publish_date').length, 0);
});

await testAsync('模型注入落款/“日期+印发”/纯落款生效日期：全部拒绝，不写有效字段', async () => {
  const out = await fields.extractFieldsWithModel('content_item', realItem.id, {
    providerId: 'LLM-170',
    actor: 'test:170',
    force: true,
    callModel: async () => ({
      ok: true,
      parsed: {
        fields: [
          { field: 'publish_date', value: '2024-12-31', quote: '2024年12月31日' },
          { field: 'publish_date', value: '2024-12-31', quote: '2024年12月31日印发' },
          { field: 'effective_date', value: '2024-12-31', quote: '2024年12月31日' },
        ],
      },
    }),
  });
  assertEqual(out.accepted, 0, JSON.stringify(out));
  assertEqual(out.rejected, 3, '三个模型候选都必须被拒绝（其中一条引句不在正文中）');
  const current = fields.getFieldEvidence('content_item', realItem.id);
  const modelFields = current.fields.filter((f) => f.method === 'model');
  assertEqual(modelFields.length, 0, '模型被拒绝的字段不得进入前台');
  assert(!current.fields.some((f) => f.field_key === 'publish_date' || f.field_key === 'effective_date'),
    '规则/模型都不得把落款写成发布日期或生效日期');
  const invalid = db.get(
    "SELECT COUNT(*) c FROM field_evidence WHERE entity_id=? AND status='invalid'",
    [realItem.id]
  );
  assertEqual(Number(invalid.c), 2, '被拒绝的引句应保留 invalid 审计记录');
});

await testAsync('“日期+印发”页脚也不能由规则/模型生成发布日期；明确标签才可接受', async () => {
  const footer = content.upsertContent({
    source_url: 'https://example.test/170/footer',
    title: '关于发布某方法的通知',
    content_type: 'policy_notice',
    body_snapshot: '正文说明。\n生态环境部办公厅\n2024年12月31日印发\n（此件社会公开）',
  }, { actor: 'test:170' });
  const out = fields.extractDeterministicFields('content_item', footer.id, { actor: 'test:170' });
  assert(!out.fields.some((f) => f.field_key === 'publish_date'), '裸“印发”不是发布日期标签');
  const model = await fields.extractFieldsWithModel('content_item', footer.id, {
    providerId: 'LLM-170',
    actor: 'test:170',
    force: true,
    callModel: async () => ({
      ok: true,
      parsed: { fields: [{ field: 'publish_date', value: '2024-12-31', quote: '2024年12月31日印发' }] },
    }),
  });
  assertEqual(model.accepted, 0);
  assertEqual(model.rejected, 1);

  const valid = content.upsertContent({
    source_url: 'https://example.test/170/valid-dates',
    title: '带明确日期标签的公开通知',
    content_type: 'policy_notice',
    body_snapshot: '发布日期：2026年1月2日。\n生效日期：2026年2月1日。\n自2026年2月1日起施行。',
  }, { actor: 'test:170' });
  const got = fields.extractDeterministicFields('content_item', valid.id, { actor: 'test:170' });
  const pub = got.fields.find((f) => f.field_key === 'publish_date');
  const eff = got.fields.find((f) => f.field_key === 'effective_date');
  assert(pub, '明确“发布日期”应被抽取');
  assertEqual(pub.field_value, '2026-01-02');
  assert(eff, '明确“生效日期/自……起施行”应被抽取');
  assertEqual(eff.field_value, '2026-02-01');
});

test('阈值：相同数字不能支持错误单位或方向；正确方向+单位才通过', () => {
  const body = '本项目适用于甲烷体积浓度低于8%的煤矿低瓦斯利用项目，每年8吨。';
  const base = {
    entityType: 'content_item', entityId: 'TH-170', bodyHash: 'th-170', fieldKey: 'threshold',
    valueType: 'number', method: 'deterministic_rule', extractorVersion: 'test-170', text: body,
  };
  const wrongUnit = fields.upsertFieldEvidence({ ...base, fieldValue: '8吨', quote: '低于8%' });
  assertEqual(wrongUnit.ok, false);
  assertIncludes(wrongUnit.error, '单位');
  const wrongDir = fields.upsertFieldEvidence({ ...base, fieldValue: '高于8%', quote: '低于8%' });
  assertEqual(wrongDir.ok, false);
  assertIncludes(wrongDir.error, '方向');
  const missingDir = fields.upsertFieldEvidence({ ...base, fieldValue: '8%', quote: '低于8%' });
  assertEqual(missingDir.ok, false);
  assertIncludes(missingDir.error, '方向');
  const missingUnit = fields.upsertFieldEvidence({ ...base, fieldValue: '8', quote: '低于8%' });
  assertEqual(missingUnit.ok, false);
  const ok = fields.upsertFieldEvidence({ ...base, fieldValue: '低于8%', quote: '低于8%' });
  assertEqual(ok.ok, true, JSON.stringify(ok));
  const okUnit = fields.upsertFieldEvidence({
    ...base, entityId: 'TH-170-B', fieldValue: '8吨', quote: '每年8吨',
  });
  assertEqual(okUnit.ok, true, JSON.stringify(okUnit));
});

test('地区/行业只是“正文提及”：字段元数据、展示文案与提示词都明确非官方适用范围', async () => {
  const item = content.upsertContent({
    source_url: 'https://example.test/170/mention',
    title: '地区行业提及测试',
    content_type: 'industry_news',
    body_snapshot: '本方法学适用于广东省钢铁行业，正文只是提及该地区和行业，不构成官方适用范围。',
  }, { actor: 'test:170' });
  const out = fields.extractDeterministicFields('content_item', item.id, { actor: 'test:170' });
  const region = out.fields.find((f) => f.field_key === 'region');
  const industry = out.fields.find((f) => f.field_key === 'industry');
  assert(region, '应能定位地区提及');
  assert(industry, '应能定位行业提及');
  const current = fields.getFieldEvidence('content_item', item.id);
  const rf = current.fields.find((f) => f.field_key === 'region');
  const inf = current.fields.find((f) => f.field_key === 'industry');
  assertEqual(rf.mention_only, true);
  assertEqual(inf.mention_only, true);
  assertIncludes(rf.label, '仅正文提及');
  assertIncludes(rf.scope_warning, '不代表官方适用范围');

  let captured = null;
  await fields.extractFieldsWithModel('content_item', item.id, {
    providerId: 'LLM-170',
    actor: 'test:170',
    force: true,
    callModel: async (args) => { captured = args; return { ok: true, parsed: { fields: [] } }; },
  });
  assert(captured?.prompt, '注入替身应取得真实提示词');
  assertIncludes(captured.prompt, '只表示正文“提及”');
  assertIncludes(captured.prompt, '纯落款日期或“日期+印发/发布”不算发布日期');
  assertIncludes(captured.prompt, '不是官方确认');
});

finish('170-v2-intelligence-remediation.test.mjs');
