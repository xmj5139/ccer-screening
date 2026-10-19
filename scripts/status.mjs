#!/usr/bin/env node
/** 自检：输出审批状态、门禁默认值与因子确认状态（供整改验收留痕） */
import { getDb, all } from '../src/core/db.mjs';
import { listMethodologyModules } from '../src/methodologies/index.mjs';

getDb();
console.log('=== system_meta ===');
for (const r of all('SELECT key,value FROM system_meta ORDER BY key')) {
  console.log('  ', r.key.padEnd(26), '=', String(r.value).slice(0, 90));
}
console.log('\n=== 方法学版本的审批状态 ===');
for (const r of all(
  `SELECT methodology_id, code_display, document_status, rulecard_status, calculator_status
   FROM methodology_version WHERE document_status = 'formal' ORDER BY methodology_id`
)) {
  console.log(
    '  ', (r.code_display || r.methodology_id).padEnd(30),
    '规则卡=', String(r.rulecard_status).padEnd(15),
    '计算插件=', r.calculator_status
  );
}
console.log('\n=== 草案 ===');
for (const r of all(
  `SELECT code_display, document_status, rulecard_status, calculator_status
   FROM methodology_version WHERE document_status <> 'formal'`
)) {
  console.log('  ', String(r.code_display).padEnd(42), r.document_status, r.calculator_status);
}
console.log('\n=== 因子确认状态 ===');
for (const r of all('SELECT value_status, COUNT(*) c FROM factor_version GROUP BY value_status')) {
  console.log('  ', r.value_status.padEnd(14), r.c);
}
console.log('\n=== 各插件业务测算可用性 ===');
for (const m of listMethodologyModules()) {
  const ph = m.plugin.factors.filter((f) => f.value_status === 'placeholder');
  const pend = m.plugin.formula_refs.filter(
    (f) => !f.clause_ref || f.clause_ref.includes('【占位】') || f.clause_ref.includes('待对照')
  );
  const mv = all(
    'SELECT calculator_status FROM methodology_version WHERE methodology_id = ? AND version = ?',
    [m.meta.methodology_id, m.meta.version]
  )[0];
  const blocked = mv?.calculator_status !== 'approved' || ph.length || pend.length;
  console.log(
    '  ', m.meta.methodology_id.padEnd(14),
    '占位因子', String(ph.length).padStart(2),
    '| 缺条款公式', String(pend.length).padStart(2),
    '| 审批', String(mv?.calculator_status || 'none').padEnd(15),
    '=> 业务测算', blocked ? '禁止' : '允许'
  );
}
console.log('\n=== 数据统计 ===');
for (const t of ['source_document', 'methodology_version', 'rule', 'formula', 'factor_version',
  'fact_field', 'project', 'project_fact', 'project_evidence', 'alert', 'app_user', 'user_session']) {
  const c = all(`SELECT COUNT(*) c FROM ${t}`)[0].c;
  console.log('  ', t.padEnd(22), c);
}
