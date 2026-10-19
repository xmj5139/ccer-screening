/**
 * 测试 1：确定性规则引擎
 * 验证三态判断、证据策略、表达式组合与必需字段语义。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setup, teardown } from './helpers.mjs';

let engineMod;
let M;

before(async () => {
  M = await setup();
  engineMod = await import('../src/rules/engine.mjs');
});

after(() => teardown());

function store(facts, evidence = new Map()) {
  return new engineMod.FactStore(
    facts.map((f) => ({
      field_key: f.key,
      value_text: f.text ?? (f.num !== undefined ? String(f.num) : null),
      value_num: f.num ?? null,
      value_type: f.type || 'text',
      source_kind: f.kind,
      evidence_id: f.evidenceId || null,
      asserted_at: '2026-01-01T00:00:00.000Z',
    })),
    evidence
  );
}

const EV = new Map([['EV1', { id: 'EV1', file_name: '开工报告.pdf', page: 1, excerpt: '2023-05-10 开工', doc_type: '开工报告' }]]);

test('缺失字段 → 待核实（不得判为通过）', () => {
  const s = store([]);
  const r = engineMod.evaluateRule(
    {
      rule_id: 'T1', title: '开工日期门槛', layer: 'common', severity: 'blocking',
      condition_text: '', expression_text: 'time.start >= 2012-11-08',
      expr: { op: 'date_on_or_after', field: 'time.start', value: '2012-11-08' },
      required_fields: ['time.start'], evidence_policy: 'strict',
    },
    s, {}
  );
  assert.equal(r.state, 'unknown');
  assert.match(r.detail, /字段缺失|待核实/);
});

test('严格证据策略：业主自述不判通过，返回待核实', () => {
  const s = store([{ key: 'time.start', text: '2023-05-10', type: 'date', kind: 'owner_claim' }]);
  const r = engineMod.evaluateRule(
    {
      rule_id: 'T2', title: '开工日期门槛', layer: 'common', severity: 'blocking',
      condition_text: '', expression_text: 'time.start >= 2012-11-08',
      expr: { op: 'date_on_or_after', field: 'time.start', value: '2012-11-08' },
      required_fields: ['time.start'], evidence_policy: 'strict',
    },
    s, {}
  );
  assert.equal(r.state, 'unknown');
  assert.match(r.detail, /业主自述/);
});

test('严格证据策略：项目资料 + 证据定位 → 通过', () => {
  const s = store([{ key: 'time.start', text: '2023-05-10', type: 'date', kind: 'project_doc', evidenceId: 'EV1' }], EV);
  const r = engineMod.evaluateRule(
    {
      rule_id: 'T3', title: '开工日期门槛', layer: 'common', severity: 'blocking',
      condition_text: '', expression_text: 'time.start >= 2012-11-08',
      expr: { op: 'date_on_or_after', field: 'time.start', value: '2012-11-08' },
      required_fields: ['time.start'], evidence_policy: 'strict',
    },
    s, {}
  );
  assert.equal(r.state, 'pass');
  assert.equal(r.evidence.file_name, '开工报告.pdf');
  assert.equal(r.evidence.page, 1);
});

test('严格证据策略：项目资料但无证据定位 → 待核实', () => {
  const s = store([{ key: 'time.start', text: '2023-05-10', type: 'date', kind: 'project_doc' }]);
  const r = engineMod.evaluateRule(
    {
      rule_id: 'T4', title: 'x', layer: 'common', severity: 'blocking', condition_text: '',
      expression_text: '', expr: { op: 'date_on_or_after', field: 'time.start', value: '2012-11-08' },
      required_fields: ['time.start'], evidence_policy: 'strict',
    },
    s, {}
  );
  assert.equal(r.state, 'unknown');
  assert.match(r.detail, /证据/);
});

test('模型假设永远不能用于条件判定', () => {
  const s = store([{ key: 'comp.a', text: 'false', type: 'bool', kind: 'assumption' }]);
  const r = engineMod.evaluateRule(
    {
      rule_id: 'T5', title: 'x', layer: 'common', severity: 'blocking', condition_text: '',
      expression_text: '', expr: { op: 'is_false', field: 'comp.a' },
      required_fields: ['comp.a'], evidence_policy: 'normal',
    },
    s, {}
  );
  assert.equal(r.state, 'unknown');
  assert.match(r.detail, /模型假设/);
});

test('日期比较：早于门槛 → 不通过', () => {
  const s = store([{ key: 'time.start', text: '2011-01-01', type: 'date', kind: 'project_doc', evidenceId: 'EV1' }], EV);
  const r = engineMod.evaluateRule(
    {
      rule_id: 'T6', title: 'x', layer: 'common', severity: 'blocking', condition_text: '',
      expression_text: '', expr: { op: 'date_on_or_after', field: 'time.start', value: '2012-11-08' },
      required_fields: ['time.start'], evidence_policy: 'strict',
    },
    s, {}
  );
  assert.equal(r.state, 'fail');
});

test('and 组合：任一不通过 → 不通过；任一待核实 → 待核实', () => {
  const rule = {
    rule_id: 'T7', title: 'x', layer: 'common', severity: 'blocking', condition_text: '',
    expression_text: '', required_fields: [], evidence_policy: 'normal',
    expr: {
      op: 'and',
      args: [
        { op: 'is_true', field: 'a' },
        { op: 'is_true', field: 'b' },
      ],
    },
  };
  assert.equal(
    engineMod.evaluateRule(rule, store([
      { key: 'a', text: 'true', type: 'bool', kind: 'analyst' },
      { key: 'b', text: 'false', type: 'bool', kind: 'analyst' },
    ]), {}).state,
    'fail'
  );
  assert.equal(
    engineMod.evaluateRule(rule, store([{ key: 'a', text: 'true', type: 'bool', kind: 'analyst' }]), {}).state,
    'unknown'
  );
  assert.equal(
    engineMod.evaluateRule(rule, store([
      { key: 'a', text: 'true', type: 'bool', kind: 'analyst' },
      { key: 'b', text: 'true', type: 'bool', kind: 'analyst' },
    ]), {}).state,
    'pass'
  );
});

test('required_fields 不可用时强制待核实', () => {
  const s = store([{ key: 'a', text: 'true', type: 'bool', kind: 'analyst' }]);
  const r = engineMod.evaluateRule(
    {
      rule_id: 'T8', title: 'x', layer: 'common', severity: 'blocking', condition_text: '',
      expression_text: '', expr: { op: 'const', value: true },
      required_fields: ['a', 'b'], evidence_policy: 'normal',
    },
    s, {}
  );
  assert.equal(r.state, 'unknown');
  assert.deepEqual(r.missing_fields, ['b']);
});

test('in / not_in / 数值比较 / contains_any', () => {
  const s = store([
    { key: 'type', text: '煤矿瓦斯回收利用', type: 'text', kind: 'analyst' },
    { key: 'scale', num: 35000, type: 'number', kind: 'analyst' },
    { key: 'routes', text: '["瓦斯发电","瓦斯氧化"]', type: 'multi', kind: 'analyst' },
  ]);
  const mk = (expr, required = []) => engineMod.evaluateRule(
    { rule_id: 'T', title: 't', layer: 'common', severity: 'blocking', condition_text: '', expression_text: '', expr, required_fields: required, evidence_policy: 'normal' },
    s, {}
  );
  assert.equal(mk({ op: 'in', field: 'type', values: ['煤矿瓦斯回收利用'] }).state, 'pass');
  assert.equal(mk({ op: 'not_in', field: 'type', values: ['造林碳汇'] }).state, 'pass');
  assert.equal(mk({ op: 'lt', field: 'scale', value: 30000 }).state, 'fail');
  assert.equal(mk({ op: 'gte', field: 'scale', value: 30000 }).state, 'pass');
  assert.equal(mk({ op: 'contains_any', field: 'routes', values: ['瓦斯氧化'] }).state, 'pass');
  assert.equal(mk({ op: 'contains_any', field: 'routes', values: ['海上油田伴生气'] }).state, 'fail');
});

test('非法操作符 → 待核实而非崩溃', () => {
  const r = engineMod.evaluateRule(
    { rule_id: 'T', title: 't', layer: 'common', severity: 'blocking', condition_text: '', expression_text: '', expr: { op: 'no_such_op', field: 'a' }, required_fields: [], evidence_policy: 'normal' },
    store([]), {}
  );
  assert.equal(r.state, 'unknown');
});

test('四态结论派生：硬障碍优先，其次关键项待核实', () => {
  const results = [
    { rule_id: 'a', title: 'A', state: 'fail', severity: 'blocking' },
    { rule_id: 'b', title: 'B', state: 'unknown', severity: 'major' },
  ];
  const s = engineMod.summarize(results);
  assert.equal(engineMod.conclude(s, { hasFormalCandidate: true }), '存在明确障碍');
  assert.equal(engineMod.conclude(engineMod.summarize([{ rule_id: 'b', title: 'B', state: 'unknown', severity: 'major' }]), { hasFormalCandidate: true }), '资料不足暂无法判断');
  assert.equal(engineMod.conclude(engineMod.summarize([{ rule_id: 'c', title: 'C', state: 'pass', severity: 'blocking' }]), { hasFormalCandidate: true }), '可继续尽调');
  assert.equal(engineMod.conclude(engineMod.summarize([]), { hasFormalCandidate: false }), '无已发布适用方法学');
  // 仅 minor 级不通过不应阻断
  assert.equal(engineMod.conclude(engineMod.summarize([{ rule_id: 'd', title: 'D', state: 'fail', severity: 'minor' }]), { hasFormalCandidate: true }), '可继续尽调');
});
