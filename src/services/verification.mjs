/**
 * 领域专家确认状态（以数据库为准）
 * ============================================================================
 * 【为什么必须读数据库，而不是读插件模块里的静态声明】
 *
 * 领域专家的逐项确认结果记录在：
 *   - `factor_version.value_status`（placeholder → verified）与 `verified_by` / `verified_at`
 *   - `formula.clause_ref`（是否已回填方法学原文条款页码）
 *   - `methodology_version.rulecard_status` / `calculator_status` 与审批人字段
 *
 * 而插件模块 `src/methodologies/*.mjs` 里的 `plugin.factors[].value_status`
 * 与 `plugin.formula_refs[].clause_ref` 只是**声明**，其唯一用途是种子初始化时写入数据库。
 *
 * 如果门禁读静态声明，运行时的任何确认都不会生效，会出现这样的死锁：
 *   管理后台审批通过（数据库 calculator_status = 'approved'、placeholder 行数 = 0），
 *   但测算仍被拒绝，理由是「插件仍含 N 项占位系数」——
 *   因为静态声明永远是初始的 placeholder。
 * 该缺陷已在本项目实测发现并修复，本模块即为修复的落点。
 *
 * 本模块刻意不依赖任何其他 service，避免与 calc-svc / engine 形成循环依赖。
 */
import { all } from '../core/db.mjs';

/** 'CCER-10-001' → 'c10-001'（方法学专属因子的键前缀） */
export function methodologyFactorPrefix(methodologyId) {
  const m = String(methodologyId || '').match(/^CCER-(\d{2})-(\d{3})$/i);
  return m ? `c${m[1]}-${m[2]}` : null;
}

/**
 * 读取某方法学版本的确认状态。
 * @param {string} methodologyId 例如 'CCER-10-001'
 * @param {string} version       例如 'V01'
 * @returns {{placeholders:Array<{factor_key:string,name:string,value:number,unit:string,verification_note:string}>,
 *            pendingClauses:Array<{formula_id:string,clause_ref:string}>,
 *            verifiedCount:number, factorCount:number}}
 */
export function loadVerificationState(methodologyId, version) {
  const mvKey = `${methodologyId}::${version}`;
  const prefix = methodologyFactorPrefix(methodologyId);

  const scopeWhere = prefix
    ? "AND (methodology_version_id = ? OR factor_key LIKE ?)"
    : 'AND methodology_version_id = ?';
  const scopeParams = prefix ? [mvKey, `${prefix}.%`] : [mvKey];

  const placeholders = all(
    `SELECT factor_key, name, value, unit, verification_note
     FROM factor_version
     WHERE value_status = 'placeholder' ${scopeWhere}
     ORDER BY factor_key`,
    scopeParams
  );

  const verifiedCount =
    all(
      `SELECT COUNT(*) AS c FROM factor_version WHERE value_status = 'verified' ${scopeWhere}`,
      scopeParams
    )[0]?.c ?? 0;

  const factorCount =
    all(`SELECT COUNT(*) AS c FROM factor_version WHERE 1=1 ${scopeWhere}`, scopeParams)[0]?.c ?? 0;

  const pendingClauses = all(
    `SELECT f.formula_id, f.clause_ref
     FROM formula f
     JOIN methodology_version m ON m.id = f.methodology_version_id
     WHERE m.methodology_id = ? AND m.version = ?
       AND (f.clause_ref IS NULL OR TRIM(f.clause_ref) = ''
            OR f.clause_ref LIKE '%【占位】%' OR f.clause_ref LIKE '%待对照%')
     ORDER BY f.formula_id`,
    [methodologyId, version]
  );

  return { placeholders, pendingClauses, verifiedCount, factorCount };
}

/** 业务测算是否具备放行条件（不含条件检查快照绑定，那部分由 calc-svc 判定） */
export function businessCalculationReadiness(methodologyId, version, calculatorStatus) {
  const st = loadVerificationState(methodologyId, version);
  const blockers = [];
  if (calculatorStatus !== 'approved') blockers.push(`计算插件审批状态为「${calculatorStatus}」`);
  if (st.placeholders.length) blockers.push(`含 ${st.placeholders.length} 项未确认的占位系数`);
  if (st.pendingClauses.length) blockers.push(`有 ${st.pendingClauses.length} 条公式未回填原文条款页码`);
  return { ...st, blockers, ready: blockers.length === 0 };
}
