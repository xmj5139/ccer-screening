/**
 * 测试夹具：把库改造成「领域专家已完成确认」的状态
 * ============================================================================
 * 背景（首轮检查整改清单 P0-2）：
 *   默认库中，规则卡与计算插件的审批状态为 `pending_review`，且插件含占位系数、
 *   部分公式缺条款页码，因此**业务测算被阻止**——这是正确的默认行为。
 *
 *   为了测试业务路径（公式链、情景、报告、追溯），需要先把库改造成
 *   「专家已逐项确认并签字」的状态。本文件把这个改造集中在一处，
 *   使测试可以明确区分「未确认 → 禁止出数」与「已确认 → 可出数」两种状态。
 *
 * 注意：本夹具只用于测试。生产库中这些字段应由管理后台的审批流与
 *       docs/12 领域专家确认清单驱动，不得由脚本批量改写。
 */
import { run, all, get, audit } from '../src/core/db.mjs';
import { nowIso } from '../src/core/util.mjs';

const EXPERT = { name: '领域复核人（测试夹具）', role: 'reviewer' };

/**
 * 把某方法学版本的因子全部标记为 verified，并把计算插件审批状态改为 approved。
 * @param {string} methodologyId 例如 'CCER-10-001'
 * @returns {{factors:number, methodology_version_id:string}}
 */
export function simulateExpertApproval(methodologyId, version = 'V01') {
  const mv = get(
    'SELECT * FROM methodology_version WHERE methodology_id = ? AND version = ?',
    [methodologyId, version]
  );
  if (!mv) throw new Error(`未找到方法学版本 ${methodologyId}::${version}`);

  // 1) 因子：placeholder → verified，并记录确认人与时间
  const rows = all(
    `SELECT * FROM factor_version
     WHERE value_status = 'placeholder'
       AND (methodology_version_id = ? OR methodology_version_id = '')`,
    [`${methodologyId}::${version}`]
  );
  for (const r of rows) {
    run(
      `UPDATE factor_version
       SET value_status = 'verified', verified_by = ?, verified_at = ?,
           verification_note = COALESCE(verification_note,'') || '【测试夹具】已按领域专家确认处理'
       WHERE id = ?`,
      [EXPERT.name, nowIso(), r.id]
    );
  }

  // 2) 方法学版本：规则卡与计算插件审批通过
  run(
    `UPDATE methodology_version
     SET rulecard_status = 'approved', rulecard_approved_by = ?, rulecard_approved_at = ?,
         calculator_status = 'approved', calculator_approved_by = ?, calculator_approved_at = ?,
         updated_at = ?
     WHERE id = ?`,
    [EXPERT.name, nowIso(), EXPERT.name, nowIso(), nowIso(), mv.id]
  );

  audit({
    actor: EXPERT.name, actorRole: 'reviewer', action: 'test.simulate_expert_approval',
    objectType: 'methodology_version', objectId: mv.id,
    detail: { methodologyId, version, factors: rows.length },
  });

  return { factors: rows.length, methodology_version_id: mv.id };
}

/** 开启演示通道（需要 admin 角色对象） */
export function enableDemoChannel(user) {
  run(
    `INSERT INTO system_meta (key,value,updated_at) VALUES ('demo_channel_enabled','true',?)
     ON CONFLICT(key) DO UPDATE SET value='true', updated_at=excluded.updated_at`,
    [nowIso()]
  );
  run(
    `INSERT INTO system_meta (key,value,updated_at) VALUES ('demo_channel_enabled_by',?,?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
    [user?.name || 'test', nowIso()]
  );
}

export function disableDemoChannel() {
  run("UPDATE system_meta SET value = 'false' WHERE key = 'demo_channel_enabled'");
}

/** 把 4 个甲烷类方法学全部置为「专家已确认」 */
export function approveAllMethaneMethodologies() {
  return ['CCER-10-001', 'CCER-10-002', 'CCER-10-003', 'CCER-10-004'].map((id) =>
    simulateExpertApproval(id)
  );
}

/** 读取当前关键状态，便于断言 */
export function gateState() {
  const meta = Object.fromEntries(
    all('SELECT key, value FROM system_meta').map((r) => [r.key, r.value])
  );
  const mv = all(
    `SELECT methodology_id, calculator_status, rulecard_status
     FROM methodology_version WHERE document_status = 'formal' ORDER BY methodology_id`
  );
  const factors = all('SELECT value_status, COUNT(*) AS c FROM factor_version GROUP BY value_status');
  return { meta, methodology: mv, factors };
}
