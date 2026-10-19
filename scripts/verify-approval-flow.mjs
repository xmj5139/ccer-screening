#!/usr/bin/env node
/**
 * 验证「审批 → 可出数」链路现在可达（整改缺陷 #1 的回归验证）
 * ============================================================================
 * 修复前：门禁读插件模块的静态声明，approveMethodology 永远返回 409，
 *         「管理后台审批 → 业务测算放行」在实现上不可达。
 * 修复后：门禁读 factor_version / formula 表，审批链路必须完全可达。
 *
 *   node scripts/verify-approval-flow.mjs
 */
import { getDb, all, run, get } from '../src/core/db.mjs';
import * as calc from '../src/services/calc-svc.mjs';
import * as F from '../test/fixtures.mjs';

getDb();
const ADMIN = { id: 'user-admin', name: '系统管理员', role: 'admin', team_id: 'team-carbon' };
const mvId = (mid) =>
  all("SELECT id FROM methodology_version WHERE methodology_id = ? AND version = 'V01'", [mid])[0].id;

const status = (mid) => calc.methodologyPluginStatus().find((p) => p.methodology_id === mid);
let failures = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? '✅' : '❌'} ${label}${detail ? '  — ' + detail : ''}`);
};

console.log('=== 修复前的初始状态（未确认） ===');
// 重置为初始状态：把 CCER-10-001 的因子退回 placeholder、审批退回 pending_review
run(
  `UPDATE factor_version SET value_status='placeholder', verified_by=NULL,
     verification_note='【验证脚本重置】' WHERE factor_key LIKE 'c10-001.%' AND factor_key NOT LIKE '%t.npt%' AND factor_key NOT LIKE '%p.npt%' AND factor_key NOT LIKE '%water%' AND factor_key NOT LIKE '%mwh%' AND factor_key NOT LIKE '%energy.value%'`
);
run("UPDATE methodology_version SET calculator_status='pending_review', calculator_approved_by=NULL WHERE id = ?", [mvId('CCER-10-001')]);

let s = status('CCER-10-001');
console.log(`  审批状态=${s.calculator_status}　占位系数=${s.placeholder_factors.length}　业务测算=${s.business_calculation}`);
check('初始状态业务测算被阻止', s.business_calculation.includes('禁止'), s.business_calculation);

const r1 = calc.approveMethodology(ADMIN, mvId('CCER-10-001'), { target: 'calculator', decision: 'approved' });
check('仍有占位系数时，审批被拒（防呆）', !!r1.error, r1.error ? String(r1.error).slice(0, 60) + '…' : '竟然批准了');
if (r1.detail) {
  console.log(`     阻塞明细：占位=${(r1.detail.placeholder_factors || []).join('、') || '无'}`);
  console.log(`               缺条款=${(r1.detail.formulas_without_clause || []).join('、') || '无'}`);
}

console.log('\n=== 领域专家确认后 ===');
const applied = F.simulateExpertApproval('CCER-10-001');
console.log(`  已确认因子 ${applied.factors} 项（写入 factor_version 表）`);
s = status('CCER-10-001');
console.log(`  审批状态=${s.calculator_status}　占位系数=${s.placeholder_factors.length}　业务测算=${s.business_calculation}`);

const r2 = calc.approveMethodology(ADMIN, mvId('CCER-10-001'), {
  target: 'calculator', decision: 'approved', comment: '验证脚本：确认后审批',
});
check('占位系数清零后，审批成功', !r2.error, r2.error || JSON.stringify(r2));

const row = get('SELECT calculator_status, calculator_approved_by, calculator_approved_at FROM methodology_version WHERE id = ?', [mvId('CCER-10-001')]);
check('审批人与时间已落库', row.calculator_status === 'approved' && !!row.calculator_approved_by && !!row.calculator_approved_at,
  `${row.calculator_status} / ${row.calculator_approved_by}`);

s = status('CCER-10-001');
check('审批后业务测算变为可出数', s.business_calculation.includes('可出数'), s.business_calculation);

console.log('\n=== 结果 ===');
console.log(failures === 0
  ? '结论：审批链路完全可达，门禁已改为读数据库。'
  : `结论：仍有 ${failures} 项不符合预期。`);
process.exit(failures === 0 ? 0 : 1);
