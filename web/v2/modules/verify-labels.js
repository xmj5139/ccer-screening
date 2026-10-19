/**
 * 内部核验文案（仅后台使用）
 * ============================================================================
 * 需求（docs/44 第 2 条）：公开列表**不再以「证据充足/不足/自动核验」等标签呈现**，
 * 内部核验数据保留后台。
 *
 * 因此核验四态文案集中放在本模块，只由后台页面（admin.js）与管理员可见的
 * 详情字段（policies.js / projects.js 的管理员分支）引用；
 * 公开的内容库、总览与 CEA 研报列表不再引用这些标签。
 */

export const VERIFY_LABEL_INTERNAL = {
  verified: '自动核验通过',
  insufficient: '证据不足',
  conflict: '来源冲突',
  unavailable: '暂未自动核验',
};

/** 核验标签（内部/后台口径） */
export function verifyChip(status) {
  const label = VERIFY_LABEL_INTERNAL[status] || '暂未自动核验';
  const cls = { verified: 'chip-ok', insufficient: 'chip-warn', conflict: 'chip-danger' }[status] || 'chip-muted';
  return `<span class="chip ${cls}" title="内部一致性检查结论，不代表独立审计">${esc(label)}</span>`;
}

function esc(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
