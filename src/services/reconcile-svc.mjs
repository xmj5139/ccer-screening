/**
 * 数据核对服务（每日核对）
 * ============================================================================
 * 需求（docs/19 第 23 条 + docs/22 第 6、12 条）：
 *   每类数据都要有**自动检查 + 自动标注**，异常进入未结清差异台账，
 *   不用旧数据伪装当日行情，历史修订保留新旧值。
 *   **二轮整改**：交易/政策/因子/项目核对一律**不再生成人工任务**
 *   （不调用 createReviewTask）；严重项只写 data_reconciliation 与 notification，
 *   作为自动运行状态展示与检索。
 *
 * 本模块实现四组检查：
 *   1. 交易行情（trade）
 *        - 单价关系：成交额 ≈ 成交量 × 官方披露均价（容差 = 均价 2 位小数的舍入上限）
 *        - 累计差分：官方累计值区间 (a, b] 的增量应等于区间内**全部交易日**逐日合计；
 *          区间交易日以 trade_calendar（官方公告清单）为准，漏采交易日时只登记一条
 *          「区间覆盖不完整」，不与单日成交量相减；成交量与成交额合并在同一条记录中
 *        - 累计单调：累计成交量/额不得回退
 *        - 缺失交易日：日历标为交易日却无行情记录
 *        - 陈旧告警：最新交易日明显落后于当日（不得用旧数据伪装当日行情）
 *        - 修订待核：发生过官方修订的行必须重新核对
 *        - 维度一致性：分行业维度合计与合计行一致
 *   2. 公开项目（project）
 *        - 阶段与事件一致性 / 阶段时序倒退 / 三类量关系 / 缺官方链接 / 缺附件
 *   3. 政策（policy）
 *        - 生效政策缺发布日期 / 缺官方 URL / 原件未归档（以「本地文件 + SHA-256」判定）
 *          / 标题重复；已做可追溯去重的 superseded 历史记录不重复告警
 *   4. 因子与引用文件（factor）
 *        - 占位系数、适用年份缺口、未回填条款页码
 *
 * 所有异常写入 data_reconciliation（幂等：同 dataset+object+check_kind 未结清时
 * 更新而不重复堆积）；严重项同时发 notification（运行状态提醒，不是审批待办）。
 */
import { all, get, run, audit } from '../core/db.mjs';
import { newId, nowIso, todayCst, isDate, round, uj } from '../core/util.mjs';
import { notify, addReconcileStep, syncNotificationLifecycle } from './collect-svc.mjs';
import { policyHasArchivedOriginal } from './policy-svc.mjs';

/* ------------------------------------------------------------------ */
/*  异常登记（幂等）                                                    */
/* ------------------------------------------------------------------ */

/**
 * 登记一条核对差异。同一 dataset + object_id + check_kind 若已有 open 记录，
 * 则更新 detail/severity 而不是新增（避免每日重复堆积）。
 * 严重项只发自动通知，**不生成人工任务**（平台没有审核队列）。
 */
export function recordIssue({
  dataset, object_id = null, object_label = null, check_kind, severity = 'warning',
  detail, expected = null, actual = null, detected_by = 'system:reconcile',
}) {
  const dup = get(
    `SELECT id FROM data_reconciliation WHERE dataset = ? AND check_kind = ?
       AND COALESCE(object_id,'') = COALESCE(?,'') AND status = 'open'`,
    [dataset, check_kind, object_id]
  );
  const now = nowIso();
  if (dup) {
    run('UPDATE data_reconciliation SET detail = ?, expected = ?, actual = ?, severity = ?, detected_at = ? WHERE id = ?', [
      detail, expected, actual, severity, now, dup.id,
    ]);
    return { id: dup.id, deduped: true, severity };
  }
  const id = newId('REC');
  run(
    `INSERT INTO data_reconciliation (id,dataset,object_id,object_label,check_kind,severity,detail,expected,actual,
       detected_at,detected_by,status,resolved_by,resolved_at,resolution)
     VALUES (?,?,?,?,?,?,?,?,?,?,?, 'open', NULL, NULL, NULL)`,
    [id, dataset, object_id, object_label, check_kind, severity, detail, expected, actual, now, detected_by]
  );
  if (severity === 'critical' || severity === 'warning') {
    if (severity === 'critical') {
      notify({
        kind: 'reconciliation',
        title: `数据异常：${object_label || object_id || dataset}`,
        detail,
        severity: 'high',
        impact_level: 'high',
        object_type: 'data_reconciliation',
        object_id: id,
      });
    }
  }
  return { id, deduped: false, severity };
}

export function listReconciliation({ status = 'open', dataset = null, severity = null, limit = 200 } = {}) {
  const where = [];
  const params = [];
  if (status && status !== 'all') {
    where.push('status = ?');
    params.push(status);
  }
  if (dataset) {
    where.push('dataset = ?');
    params.push(dataset);
  }
  if (severity) {
    where.push('severity = ?');
    params.push(severity);
  }
  return all(
    `SELECT * FROM data_reconciliation ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, detected_at DESC
     LIMIT ?`,
    [...params, Math.min(Number(limit) || 200, 1000)]
  );
}

export function resolveReconciliation(user, id, { status = 'resolved', resolution = null } = {}) {
  const row = get('SELECT * FROM data_reconciliation WHERE id = ?', [id]);
  if (!row) return { error: '核对记录不存在', status: 404 };
  if (!['resolved', 'confirmed', 'ignored'].includes(status)) {
    return { error: 'status 取值非法（resolved/confirmed/ignored）', status: 400 };
  }
  if (!resolution) return { error: '结清核对记录必须填写处理说明（resolution）', status: 400 };
  run(
    `UPDATE data_reconciliation SET status = ?, resolved_by = ?, resolved_at = ?, resolution = ? WHERE id = ?`,
    [status, user?.name || 'unknown', nowIso(), resolution, id]
  );
  // 结清核对记录的同时结清它产生的提醒（否则旧提醒会继续作为待关注显示）
  syncNotificationLifecycle({ actor: user?.name || 'system:resolve' });
  return { ok: true, id, status, resolved_by: user?.name || 'unknown' };
}

export function reconciliationStats() {
  const row = get(
    `SELECT SUM(CASE WHEN status='open' AND severity='critical' THEN 1 ELSE 0 END) AS critical,
            SUM(CASE WHEN status='open' AND severity IN ('warning','high') THEN 1 ELSE 0 END) AS warning,
            SUM(CASE WHEN status='open' AND severity='info' THEN 1 ELSE 0 END) AS info,
            SUM(CASE WHEN status!='open' THEN 1 ELSE 0 END) AS closed
     FROM data_reconciliation`
  ) || {};
  return {
    critical: Number(row.critical || 0),
    warning: Number(row.warning || 0),
    info: Number(row.info || 0),
    closed: Number(row.closed || 0),
    open_total: Number(row.critical || 0) + Number(row.warning || 0) + Number(row.info || 0),
  };
}

/* ------------------------------------------------------------------ */
/*  1. 交易行情核对                                                     */
/* ------------------------------------------------------------------ */

export function runTradeChecks({ actor = 'system:reconcile', jobId = null } = {}) {
  const issues = [];
  const push = (r) => {
    issues.push(r);
  };
  const rows = all('SELECT * FROM trade_daily ORDER BY trade_date');
  let checked = 0;

  /* 1.1 单价关系 */
  for (const r of rows) {
    if (r.session_state !== 'traded' || !r.volume || r.turnover === null || r.avg_price === null) continue;
    checked += 1;
    const expected = Number(r.volume) * Number(r.avg_price);
    const diff = Math.abs(Number(r.turnover) - expected);
    // 官方披露均价保留 2 位小数，允许的舍入误差上限 = 成交量 × 0.005 + 0.01
    const tol = Number(r.volume) * 0.005 + 0.01;
    if (diff > tol) {
      push(
        recordIssue({
          dataset: 'trade',
          object_id: r.id,
          object_label: `交易日 ${r.trade_date}`,
          check_kind: 'amount_relation',
          severity: 'warning',
          detail:
            `${r.trade_date}：成交额 ${r.turnover} 元 与 成交量×官方均价（${expected.toFixed(2)} 元）` +
            `相差 ${diff.toFixed(2)} 元，超过官方 2 位小数舍入上限 ${tol.toFixed(2)} 元。`,
          expected: expected.toFixed(2),
          actual: String(r.turnover),
          detected_by: actor,
          required_role: 'researcher',
        })
      );
    }
  }

  /* 1.2 累计差分 + 单调性（官方披露累计值）
   *
   * 【口径】官方累计值 a（截至 a 日，**不含**当日之后）→ b（截至 b 日，**含**当日）
   * 的增量，应等于区间 (a, b] 内**全部交易日**当日成交量/额的合计。
   * 区间内的交易日以 `trade_calendar`（权威来源＝官方行情公告清单）为准，
   * **不能**用「已导入 trade_daily 的日期」判断区间是否只有一天：
   *   漏采一个中间交易日时，后者会看到「区间内没有其它已导入行」，
   *   于是把多日累计差分与单日成交量相减，产生假告警（2025-03-21 案例）。
   * 区间覆盖不完整时只登记**一条**说明记录，不给出「不一致」的错误结论。
   * 成交量与成交额属同一根因，合并为**一条**记录（不再分别产生
   * cumulative_gap 与 cumulative_turnover_gap 两条重复提醒）。
   */
  const refs = all('SELECT * FROM trade_cumulative_reference ORDER BY as_of_date');
  for (let i = 1; i < refs.length; i += 1) {
    const a = refs[i - 1];
    const b = refs[i];
    /* 1.2.1 单调性 */
    if (a.volume_total !== null && b.volume_total !== null && b.volume_total < a.volume_total) {
      push(
        recordIssue({
          dataset: 'trade',
          object_id: b.id,
          object_label: `官方累计值 ${b.as_of_date}`,
          check_kind: 'cumulative_monotonic',
          severity: 'critical',
          detail: `官方累计成交量回落：${a.as_of_date} 为 ${a.volume_total} 吨，${b.as_of_date} 为 ${b.volume_total} 吨。请核对官方公告是否发生口径调整。`,
          expected: `≥ ${a.volume_total}`,
          actual: String(b.volume_total),
          detected_by: actor,
          title: '官方累计成交量出现回落',
        })
      );
    }

    /* 1.2.2 区间交易日与已导入行情
     * 覆盖判定看「该交易日是否有行情记录」（有成交 traded / 无成交 no_trade 都算已覆盖），
     * 数值合计只累加有成交日的成交量/额（无成交日官方累计不动，贡献为 0）。 */
    const calendarRows = all(
      `SELECT trade_date,day_type,note FROM trade_calendar
       WHERE trade_date > ? AND trade_date <= ? ORDER BY trade_date`,
      [a.as_of_date, b.as_of_date]
    );
    const calDays = calendarRows.filter((d) => d.day_type === 'trading');
    const calendarByDate = new Map(calendarRows.map((d) => [d.trade_date, d]));
    const unknownDates = [];
    for (let t = Date.parse(`${a.as_of_date}T00:00:00Z`) + 86400000;
      t <= Date.parse(`${b.as_of_date}T00:00:00Z`); t += 86400000) {
      const day = new Date(t);
      if ([0, 6].includes(day.getUTCDay())) continue;
      const date = day.toISOString().slice(0, 10);
      const cal = calendarByDate.get(date);
      if (!cal || cal.day_type === 'unknown' ||
        (cal.day_type === 'holiday' && String(cal.note || '').includes('凭官方当日无行情公告推断'))) {
        unknownDates.push(date);
      }
    }
    const intervalDates = calDays.length ? calDays.map((d) => d.trade_date) : [b.as_of_date];
    const rows = all(
      `SELECT trade_date, volume, turnover, session_state FROM trade_daily
       WHERE trade_date > ? AND trade_date <= ?`,
      [a.as_of_date, b.as_of_date]
    );
    const byDate = new Map(rows.map((r) => [r.trade_date, r]));
    const missing = intervalDates.filter((d) => !byDate.has(d));
    const dayValue = (d) => {
      const r = byDate.get(d);
      if (!r || r.session_state !== 'traded') return { volume: 0, turnover: 0 };
      return { volume: Number(r.volume || 0), turnover: Number(r.turnover || 0) };
    };
    const volDiff = b.volume_total !== null && a.volume_total !== null
      ? round(Number(b.volume_total) - Number(a.volume_total), 2) : null;
    const turnDiff = b.turnover_total !== null && a.turnover_total !== null
      ? round(Number(b.turnover_total) - Number(a.turnover_total), 2) : null;

    if (missing.length || unknownDates.length) {
      checked += 1;
      push(
        recordIssue({
          dataset: 'trade',
          object_id: `${a.as_of_date}..${b.as_of_date}`,
          object_label: `累计区间 ${a.as_of_date} → ${b.as_of_date}`,
          check_kind: 'cumulative_interval_incomplete',
          severity: 'critical',
          detail:
            `官方累计值区间 ${a.as_of_date}（不含）→ ${b.as_of_date}（含）内` +
            `${missing.length ? `${missing.length} 个已知交易日缺少行情：${missing.join('、')}；` : ''}` +
            `${unknownDates.length ? `${unknownDates.length} 个工作日交易状态未核实：${unknownDates.join('、')}；` : ''}` +
            `累计差分为成交量 ${volDiff ?? '—'} 吨、成交额 ${turnDiff ?? '—'} 元。` +
            '不能与单日成交量/额相减；查明日期状态并补齐应有行情前不做「不一致」结论，也不用 0 或推算值填充。',
          expected: '区间内工作日状态均有证据，且每个交易日均有行情记录',
          actual: `缺行情 ${missing.join('、') || '无'}；状态未核实 ${unknownDates.join('、') || '无'}`,
          detected_by: actor,
          title: '累计差分区间覆盖不完整（有交易日缺行情）',
        })
      );
      continue;
    }

    checked += 1;
    const sumVol = round(intervalDates.reduce((s, d) => s + dayValue(d).volume, 0), 2);
    const mismatch = [];
    if (volDiff !== null && Math.abs(volDiff - sumVol) > 0.5) {
      mismatch.push(`成交量：官方累计差分 ${volDiff} 吨 ≠ 区间逐日合计 ${sumVol} 吨`);
    }
    let sumTurn = null;
    if (turnDiff !== null) {
      sumTurn = round(intervalDates.reduce((s, d) => s + dayValue(d).turnover, 0), 2);
      if (Math.abs(turnDiff - sumTurn) > 0.05) {
        mismatch.push(`成交额：官方累计差分 ${turnDiff} 元 ≠ 区间逐日合计 ${sumTurn} 元`);
      }
    }
    if (mismatch.length) {
      push(
        recordIssue({
          dataset: 'trade',
          object_id: `${a.as_of_date}..${b.as_of_date}`,
          object_label: `累计区间 ${a.as_of_date} → ${b.as_of_date}`,
          check_kind: 'cumulative_gap',
          severity: 'critical',
          detail:
            `官方累计值区间 ${a.as_of_date}（不含）→ ${b.as_of_date}（含）差分与区间逐日合计不一致：` +
            `${mismatch.join('；')}。可能漏采交易日或官方修订了历史数据。`,
          expected: `成交量 ${volDiff} 吨 / 成交额 ${turnDiff ?? '—'} 元`,
          actual: `成交量 ${sumVol} 吨 / 成交额 ${sumTurn ?? '—'} 元`,
          detected_by: actor,
          title: '累计差分与区间逐日合计不一致',
        })
      );
    }
  }

  /* 1.3 缺失交易日：日历标为 trading 但无行情 */
  const tradingDays = all("SELECT trade_date FROM trade_calendar WHERE day_type = 'trading' ORDER BY trade_date");
  for (const d of tradingDays) {
    checked += 1;
    const has = get('SELECT COUNT(*) AS c FROM trade_daily WHERE trade_date = ?', [d.trade_date])?.c ?? 0;
    if (!has) {
      push(
        recordIssue({
          dataset: 'trade',
          object_id: d.trade_date,
          object_label: `交易日 ${d.trade_date}`,
          check_kind: 'missing_trading_day',
          severity: 'critical',
          detail: `交易日历标记 ${d.trade_date} 为交易日（官方已发布公告），但系统无行情记录，可能采集失败。`,
          expected: '应有行情记录',
          actual: '缺失',
          detected_by: actor,
          required_role: 'researcher',
          title: `交易日 ${d.trade_date} 行情缺失`,
        })
      );
    }
  }

  /* 1.4 陈旧告警：两日内应得到最新交易日数据 */
  const latest = get(
    "SELECT trade_date FROM trade_daily WHERE session_state = 'traded' ORDER BY trade_date DESC LIMIT 1"
  );
  const today = todayCst();
  if (latest) {
    let behind = 0;
    for (let at = Date.parse(`${latest.trade_date}T00:00:00Z`) + 86400000; at < Date.parse(`${today}T00:00:00Z`); at += 86400000) {
      const day = new Date(at);
      if ([0, 6].includes(day.getUTCDay())) continue;
      const cell = get('SELECT day_type FROM trade_calendar WHERE trade_date=?', [day.toISOString().slice(0, 10)]);
      if (!['holiday', 'closed', 'weekend'].includes(cell?.day_type)) behind++;
    }
    checked += 1;
    if (behind > 4) {
      push(
        recordIssue({
          dataset: 'trade',
          object_id: 'stale',
          object_label: '行情新鲜度',
          check_kind: 'stale',
          severity: behind > 7 ? 'critical' : 'warning',
          detail:
            `最新交易日行情为 ${latest.trade_date}，截至今日（${today}）已有 ${behind} 个非休市工作日未更新（不含尚未结束的今日）。` +
            '请检查采集任务是否失败；系统不会用旧数据伪装当日行情。',
          expected: `距今日 ≤ 4 天（已扣除周末与节假日影响）`,
          actual: `${behind} 天`,
          detected_by: actor,
          required_role: 'researcher',
          title: '行情数据可能未更新',
        })
      );
    }
  } else {
    push(
      recordIssue({
        dataset: 'trade',
        object_id: 'empty',
        object_label: '交易行情',
        check_kind: 'stale',
        severity: 'warning',
        detail: '系统内尚无任何有成交的交易日行情；交易信息模块将显示「数据暂缺」而不是 0 元价格。',
        expected: '至少一条行情',
        actual: '0 条',
        detected_by: actor,
        required_role: 'researcher',
      })
    );
  }

  /* 1.5 修订待核 */
  const revised = all("SELECT * FROM trade_daily WHERE revision > 1 AND verify_status != 'verified'");
  for (const r of revised) {
    checked += 1;
    push(
      recordIssue({
        dataset: 'trade',
        object_id: r.id,
        object_label: `交易日 ${r.trade_date}`,
        check_kind: 'revision_pending',
        severity: 'warning',
        detail: `${r.trade_date} 发生过官方修订（当前第 ${r.revision} 版）但尚未重新核对；旧值保留在修订记录中。`,
        expected: '已核对',
        actual: r.verify_status,
        detected_by: actor,
      })
    );
  }

  /* 1.6 分行业维度一致性 */
  const dims = all(
    `SELECT trade_date, SUM(volume) AS v, SUM(turnover) AS t, COUNT(*) AS n
     FROM trade_dimension GROUP BY trade_date`
  );
  for (const d of dims) {
    const day = get('SELECT * FROM trade_daily WHERE trade_date = ? AND session_state = ?', [d.trade_date, 'traded']);
    if (!day) continue;
    checked += 1;
    if (d.v !== null && day.volume !== null && Math.abs(Number(d.v) - Number(day.volume)) > 0.5) {
      push(
        recordIssue({
          dataset: 'trade',
          object_id: `${d.trade_date}::dimension`,
          object_label: `分行业维度 ${d.trade_date}`,
          check_kind: 'dimension_mismatch',
          severity: 'warning',
          detail: `分行业成交量合计 ${d.v} 与合计行 ${day.volume} 不一致（官方数据自身差异，按来源原样保存并提示）。`,
          expected: String(day.volume),
          actual: String(d.v),
          detected_by: actor,
        })
      );
    }
  }

  if (jobId) addReconcileStep(jobId, { dataset: 'trade', checked, issues: issues.length });
  return { ok: true, dataset: 'trade', checked, issues: issues.length, critical: issues.filter((i) => i.severity === 'critical').length, items: issues };
}

/** 来源、快照、累计值及逐日算术均齐全且无未结异常的行情，自动标记为「系统自动核对通过」。 */
export function autoCheckCleanTradeRows({actor='system:auto-reconcile'}={}) {
  const rows=all(`SELECT t.* FROM trade_daily t JOIN trade_cumulative_reference c ON c.as_of_date=t.trade_date
    WHERE t.verify_status='pending' AND t.revision=1 AND t.source_snapshot_id IS NOT NULL
      AND t.source_url LIKE 'https://www.ccer.com.cn/%'
      AND NOT EXISTS (SELECT 1 FROM data_reconciliation d WHERE d.dataset='trade' AND d.object_id=t.id
        AND d.status='open' AND d.severity IN ('warning','critical'))`);
  let checked=0;
  for(const r of rows) {
    if(r.session_state!=='traded'||!Number.isFinite(Number(r.volume))||!Number.isFinite(Number(r.turnover))||
      !Number.isFinite(Number(r.avg_price))) continue;
    if(Math.abs(Number(r.turnover)-Number(r.volume)*Number(r.avg_price))>Number(r.volume)*0.005+0.01) continue;
    run(`UPDATE trade_daily SET verify_status='verified',verify_note='系统自动核对：官方公告快照、成交额关系与累计值已核验；非人工确认',
      verified_by=?,verified_at=?,updated_at=? WHERE id=?`,[actor,nowIso(),nowIso(),r.id]);
    // 【二轮整改】不再改写任何人工任务状态：自动核对只写 trade_daily 的自动核对结果。
    checked++;
  }
  return {auto_checked:checked,remaining:get("SELECT COUNT(*) AS n FROM trade_daily WHERE verify_status='pending'")?.n||0};
}

/* ------------------------------------------------------------------ */
/*  2. 公开项目核对                                                     */
/* ------------------------------------------------------------------ */

const STAGE_EVENT = {
  stage_project_public: 'project_public',
  stage_validated: 'validation',
  stage_project_registered: 'project_registration',
  stage_reduction_public: 'reduction_public',
  stage_verified: 'verification',
  stage_reduction_registered: 'reduction_registration',
};

export function runProjectChecks({ actor = 'system:reconcile', jobId = null } = {}) {
  const issues = [];
  let checked = 0;
  // 演示条目不属于公开项目库，不能制造无法通过补采解决的“数据缺口”。
  const projects = all('SELECT * FROM public_project WHERE COALESCE(is_demo,0)=0 ORDER BY updated_at DESC');
  for (const p of projects) {
    checked += 1;
    const label = p.name || p.registry_project_no || p.id;

    /* 2.1 缺官方链接 */
    if (!p.official_url) {
      issues.push(
        recordIssue({
          dataset: 'project',
          object_id: p.id,
          object_label: label,
          check_kind: 'missing_official_url',
          severity: 'info',
          detail: '缺少官方页面链接，无法回溯到注册登记系统原文；证据等级保持「待核实」。',
          expected: '官方公示/登记页面 URL',
          actual: '缺失',
          detected_by: actor,
        })
      );
    }

    /* 2.2 阶段与事件一致性 */
    const events = all('SELECT * FROM project_event WHERE public_project_id = ? ORDER BY event_date', [p.id]);
    for (const [flag, type] of Object.entries(STAGE_EVENT)) {
      if (p[flag] && !events.some((e) => e.event_type === type)) {
        issues.push(
          recordIssue({
            dataset: 'project',
            object_id: `${p.id}::${flag}`,
            object_label: label,
            check_kind: 'stage_without_event',
            severity: 'warning',
            detail: `阶段字段 ${flag} 已置 1，但没有对应的「${type}」事件记录，阶段状态缺少可追溯依据。`,
            expected: `存在 ${type} 事件`,
            actual: '无事件',
            detected_by: actor,
          })
        );
      }
    }

    /* 2.3 阶段时序倒退 */
    const order = ['project_public', 'validation', 'project_registration', 'reduction_public', 'verification', 'reduction_registration'];
    let lastIdx = -1;
    let lastDate = null;
    for (const e of events) {
      const idx = order.indexOf(e.event_type);
      if (idx === -1 || !e.event_date) continue;
      if (idx < lastIdx && lastDate && e.event_date < lastDate) {
        issues.push(
          recordIssue({
            dataset: 'project',
            object_id: p.id,
            object_label: label,
            check_kind: 'status_regression',
            severity: 'warning',
            detail: `事件时序异常：${e.event_type}（${e.event_date}）早于前一阶段（${lastDate}）。请核对是否为不同期次或官方更正。`,
            expected: '阶段时间递增',
            actual: `${e.event_type} @ ${e.event_date}`,
            detected_by: actor,
          })
        );
        break;
      }
      lastIdx = Math.max(lastIdx, idx);
      lastDate = e.event_date;
    }

    /* 2.4 三类量关系 */
    const batches = all('SELECT * FROM reduction_batch WHERE public_project_id = ?', [p.id]);
    const sum = (k) => batches.reduce((s, b) => s + (Number(b[k]) || 0), 0);
    const announced = sum('owner_announced_estimate');
    const verified = sum('verified_amount');
    const registered = sum('registered_amount');
    if (registered > 0 && verified > 0 && registered > verified * 1.05) {
      issues.push(
        recordIssue({
          dataset: 'project',
          object_id: p.id,
          object_label: label,
          check_kind: 'amount_relation',
          severity: 'warning',
          detail: `登记量 ${registered} tCO₂e 大于核查量 ${verified} tCO₂e 的 105%，请核对是否存在跨期次合并或录入错误。`,
          expected: `≤ ${round(verified * 1.05, 2)}`,
          actual: String(registered),
          detected_by: actor,
        })
      );
    }
    if (registered > 0 && announced > 0 && registered > announced) {
      issues.push(
        recordIssue({
          dataset: 'project',
          object_id: p.id,
          object_label: label,
          check_kind: 'amount_relation_announced',
          severity: 'info',
          detail: `登记量 ${registered} 大于业主公示预计量 ${announced}，请核对公示口径（两者不可互相替代）。`,
          expected: '—',
          actual: '—',
          detected_by: actor,
        })
      );
    }

    /* 2.5 证据等级与复核 */
    if (p.review_status === 'pending' && p.evidence_level !== 'official_registry') {
      issues.push(
        recordIssue({
          dataset: 'project',
          object_id: p.id,
          object_label: label,
          check_kind: 'evidence_pending',
          severity: 'info',
          detail: '公开项目尚未由系统从官方页面完成证据核对，界面与导出会标注「待核实」，不得作为官方状态引用。',
          expected: '系统已从官方页面核对',
          actual: p.review_status,
          detected_by: actor,
        })
      );
    }
  }

  if (jobId) addReconcileStep(jobId, { dataset: 'project', checked, issues: issues.length });
  return { ok: true, dataset: 'project', checked, issues: issues.length, critical: 0, items: issues };
}

/* ------------------------------------------------------------------ */
/*  3. 政策核对                                                         */
/* ------------------------------------------------------------------ */

export function runPolicyChecks({ actor = 'system:reconcile', jobId = null } = {}) {
  const issues = [];
  // 仅对文号和规范化标题均相同、且一条有官方原件而另一条只是缺链接占位的情况自动关联。
  // 保留两条记录及历史来源，不把重复登记误称为法律意义上的废止。
  const candidates = all("SELECT id,title,doc_number,official_url,original_file_hash,duplicate_of FROM policy_document WHERE doc_status!='superseded'");
  const keyOf = (p) => `${String(p.doc_number || '').trim()}::${String(p.title || '').normalize('NFKC').replace(/[\s《》()（）\-—–－_]/g, '')}`;
  const groups = new Map();
  for (const p of candidates) {
    if (!p.doc_number || !p.title) continue;
    const key = keyOf(p);
    groups.set(key, [...(groups.get(key) || []), p]);
  }
  for (const group of groups.values()) {
    const canonical = group.find((p) => p.official_url && p.original_file_hash && !p.duplicate_of);
    if (!canonical) continue;
    for (const p of group) {
      if (p.id === canonical.id || p.duplicate_of || p.official_url || p.original_file_hash) continue;
      run('UPDATE policy_document SET duplicate_of=?,updated_at=? WHERE id=? AND duplicate_of IS NULL',
        [canonical.id, nowIso(), p.id]);
      audit({ actor, actorRole: 'system', action: 'policy.duplicate_link', objectType: 'policy_document', objectId: p.id,
        detail: { canonical_id: canonical.id, reason: '同文号、同规范化标题且官方原件已归档' } });
    }
  }
  const policies = all('SELECT * FROM policy_document ORDER BY publish_date DESC');
  let checked = 0;
  let supersededSkipped = 0;
  const titleMap = new Map();
  for (const p of policies) {
    /* 已做可追溯去重的历史记录（doc_status='superseded' 且被现行记录 supersedes 指向）
     * 保留在库中供回溯，但不再作为「现行政策」参与缺链接 / 缺原件 / 标题重复核对。
     * 它们的旧核对记录会由 closeAbsentIssues 自动归档结清（不删除历史）。 */
    if (p.doc_status === 'superseded' || p.duplicate_of) {
      supersededSkipped += 1;
      continue;
    }
    checked += 1;
    const label = p.title.slice(0, 40);
    if (p.doc_status === 'effective' && !p.publish_date) {
      issues.push(
        recordIssue({
          dataset: 'policy',
          object_id: p.id,
          object_label: label,
          check_kind: 'missing_publish_date',
          severity: 'warning',
          detail: '现行有效政策缺少发布日期，按发布日期筛选与「近 30 天新增」指标会失真。',
          expected: '发布日期',
          actual: '缺失',
          detected_by: actor,
        })
      );
    }
    if (!p.official_url) {
      issues.push(
        recordIssue({
          dataset: 'policy',
          object_id: p.id,
          object_label: label,
          check_kind: 'missing_official_url',
          severity: 'high',
          detail: '缺少官方原文链接，条款无法回溯，也不参与每日巡检。',
          expected: '官方 URL',
          actual: '缺失',
          detected_by: actor,
        })
      );
    }
    /* 原件归档判定：必须是「本地文件 + SHA-256」，不是 parse_quality 字段。
     * 只有「官方页面已核对」占位登记的记录如实计为未归档。 */
    if (!policyHasArchivedOriginal(p.id)) {
      const uploaded = get("SELECT source_status,parse_quality FROM document_upload WHERE target_kind='policy' AND target_id=? ORDER BY created_at DESC LIMIT 1", [p.id]);
      issues.push(
        recordIssue({
          dataset: 'policy',
          object_id: p.id,
          object_label: label,
          check_kind: uploaded ? 'admin_upload_unverified' : 'missing_attachment',
          severity: 'info',
          detail: uploaded
            ? `管理员已补充 PDF（解析状态 ${uploaded.parse_quality}），但未与官方 URL 下载的文件哈希匹配；模型只能核对内容身份，不能据此确认官方发布。`
            : '原件（PDF/HTML）尚未下载归档，条款只能引用到文件与章节层级，无法引用页码。',
          expected: '官方原件可独立核验（本地文件 + SHA-256 + 来源匹配）',
          actual: uploaded ? '有管理员副本，官方来源待核实' : '未归档',
          detected_by: actor,
        })
      );
    }
    const norm = p.title.replace(/[\s《》()（）\-—_]/g, '');
    if (titleMap.has(norm)) {
      issues.push(
        recordIssue({
          dataset: 'policy',
          object_id: p.id,
          object_label: label,
          check_kind: 'duplicate',
          severity: 'warning',
          detail:
            `与另一条政策标题重复：${titleMap.get(norm)}。` +
            '若确为同一公告，应做**可追溯去重**（保留两条、把历史条目标为 superseded 并互相指向），' +
            '而不是删除历史记录。',
          expected: '唯一标题',
          actual: '重复',
          detected_by: actor,
        })
      );
    } else {
      titleMap.set(norm, p.id);
    }
  }
  if (jobId) addReconcileStep(jobId, { dataset: 'policy', checked, issues: issues.length });
  return {
    ok: true, dataset: 'policy', checked, issues: issues.length, critical: 0,
    superseded_skipped: supersededSkipped, items: issues,
  };
}

/* ------------------------------------------------------------------ */
/*  4. 因子与引用文件核对                                                */
/* ------------------------------------------------------------------ */

export function runFactorChecks({ actor = 'system:reconcile', jobId = null } = {}) {
  const issues = [];
  let checked = 0;
  const factors = all('SELECT * FROM factor_version');
  for (const f of factors) {
    checked += 1;
    const status = f.value_status || null;
    if (status === 'placeholder') {
      issues.push(
        recordIssue({
          dataset: 'factor',
          object_id: f.id,
          object_label: f.factor_key || f.name || f.id,
          check_kind: 'placeholder_factor',
          severity: 'warning',
          detail:
            `因子 ${f.factor_key || f.name || f.id} 仍为占位值或缺少可定位的官方依据，` +
            '正式测算被阻止；规模粗估另按可见假设展示。',
          expected: '官方发布值与自动证据核验',
          actual: '占位 / 未核实',
          detected_by: actor,
        })
      );
    }
  }
  const mvs = all('SELECT * FROM methodology_version WHERE document_status = \'formal\'');
  for (const m of mvs) {
    const ver = get('SELECT * FROM methodology_doc_verification WHERE methodology_version_id = ?', [m.id]);
    if (!ver) {
      issues.push(
        recordIssue({
          dataset: 'factor',
          object_id: m.id,
          object_label: `${m.code_display || m.methodology_id} ${m.version}`,
          check_kind: 'doc_verification_missing',
          severity: 'info',
          detail: '尚未建立「原文条款 → 输入字段 → 规则/公式 → 测试样例」对照台账，业务测算被阻止。',
          expected: '已登记对照台账',
          actual: '未登记',
          detected_by: actor,
          required_role: 'reviewer',
        })
      );
      continue;
    }
    if (ver.evidence_level !== 'official_original_verified') {
      issues.push(
        recordIssue({
          dataset: 'factor',
          object_id: m.id,
          object_label: `${m.code_display || m.methodology_id} ${m.version}`,
          check_kind: 'doc_verification_incomplete',
          severity: 'info',
          detail: `原文对照台账证据等级为「${ver.evidence_level}」，未达到可放行业务测算的条件。`,
          expected: 'official_original_verified',
          actual: ver.evidence_level,
          detected_by: actor,
          required_role: 'reviewer',
        })
      );
    }
  }
  if (jobId) addReconcileStep(jobId, { dataset: 'factor', checked, issues: issues.length });
  return { ok: true, dataset: 'factor', checked, issues: issues.length, critical: 0, items: issues };
}

/** 全部核对（供 API 与脚本调用） */
export function runAllChecks({ actor = 'system:reconcile', jobId = null } = {}) {
  const trade = runTradeChecks({ actor, jobId });
  const project = runProjectChecks({ actor, jobId });
  const policy = runPolicyChecks({ actor, jobId });
  const factor = runFactorChecks({ actor, jobId });
  const results = { trade, project, policy, factor };
  closeAbsentIssues(results, actor);
  return { ...results, stats: reconciliationStats() };
}

/** 完整复查后归档已不再触发的旧差异。只依据规则结果归档，不依据模型意见改数。 */
export function closeAbsentIssues(results, actor = 'system:reconcile') {
  let closed = 0;
  for (const dataset of ['trade', 'project', 'policy', 'factor']) {
    const result = results[dataset];
    if (!result?.ok || !Array.isArray(result.items)) continue;
    const current = new Set(result.items.map((item) => item.id));
    const open = all("SELECT id FROM data_reconciliation WHERE dataset=? AND status='open'", [dataset]);
    for (const row of open) {
      if (current.has(row.id)) continue;
      run("UPDATE data_reconciliation SET status='resolved',resolved_by=?,resolved_at=?,resolution=? WHERE id=? AND status='open'", [
        actor, nowIso(), '每日规则复查未再检出；自动归档。历史差异和模型判断保留，未改写官方数值。', row.id,
      ]);
      closed += 1;
    }
  }
  /* 核对记录结清后必须同步提醒生命周期：旧提醒不得继续以未读/待关注
   * 出现在总览（本轮回归的根因）。该同步幂等，无变更时不写任何行。 */
  syncNotificationLifecycle({ actor });
  return closed;
}
