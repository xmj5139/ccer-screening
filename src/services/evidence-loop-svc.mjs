/**
 * 每日公开证据补全循环。只有取得新的可追溯证据才继续下一轮；
 * 模型判断、搜索摘要或重复请求都不算进展。
 */
import { get, audit } from '../core/db.mjs';

const count = (sql) => Number(get(sql)?.n || 0);

export function evidenceState() {
  return {
    content_incomplete: count("SELECT COUNT(*) n FROM content_item WHERE is_demo=0 AND duplicate_of IS NULL AND record_kind='article' AND COALESCE(body_availability,'metadata_only')!='full_text'"),
    content_full_text: count("SELECT COUNT(*) n FROM content_item WHERE is_demo=0 AND duplicate_of IS NULL AND record_kind='article' AND body_availability='full_text'"),
    content_versions: count('SELECT COUNT(*) n FROM content_version'),
    policy_missing_original: count("SELECT COUNT(*) n FROM policy_document p WHERE p.doc_status!='superseded' AND p.duplicate_of IS NULL AND p.official_url IS NOT NULL AND NOT EXISTS (SELECT 1 FROM policy_attachment a WHERE a.policy_id=p.id AND a.local_path IS NOT NULL AND a.file_hash IS NOT NULL) AND (p.local_path IS NULL OR p.original_file_hash IS NULL)"),
    policy_archived: count('SELECT COUNT(*) n FROM policy_attachment WHERE local_path IS NOT NULL AND file_hash IS NOT NULL'),
    methodology_missing_original: count("SELECT COUNT(*) n FROM methodology_version WHERE document_status='formal' AND (original_file_hash IS NULL OR code_display IS NULL)"),
    methodology_archived: count("SELECT COUNT(*) n FROM methodology_version WHERE document_status='formal' AND original_file_hash IS NOT NULL"),
    trade_missing: count("SELECT COUNT(*) n FROM data_reconciliation WHERE status='open' AND dataset='trade' AND check_kind IN ('missing_trade_day','cumulative_interval_incomplete')"),
    trade_days: count('SELECT COUNT(*) n FROM trade_daily'),
    project_open: count("SELECT COUNT(*) n FROM data_reconciliation WHERE status='open' AND dataset='project'"),
    project_with_official_url: count("SELECT COUNT(*) n FROM public_project WHERE COALESCE(is_demo,0)=0 AND official_url IS NOT NULL"),
    snapshots: count('SELECT COUNT(*) n FROM source_snapshot'),
  };
}

const PROGRESS_KEYS = [
  'content_full_text', 'content_versions', 'policy_archived', 'methodology_archived',
  'trade_days', 'project_with_official_url', 'snapshots',
];
export function evidenceProgress(before, after) {
  return PROGRESS_KEYS.filter((key) => Number(after[key] || 0) > Number(before[key] || 0));
}

async function repairRound({ actor, datasets, limit, state, initialDetail, round }) {
  const actions = {};
  const attempt = async (name, fn) => {
    try { actions[name] = await fn(); }
    catch (e) { actions[name] = { ok: false, error: e.message }; }
  };
  if (datasets.includes('content') && state.content_incomplete > 0) {
    await attempt('content', async () => {
      const content = await import('./content-svc.mjs');
      return content.repairIncompleteContent({ actor, limit, round, verify: false });
    });
  }
  if (datasets.includes('policy') && state.policy_missing_original > 0) {
    await attempt('policy', async () => {
      const policy = await import('./policy-archive-svc.mjs');
      return policy.archiveMissingPolicyOriginals({ actor, limit });
    });
  }
  // 当初轮已取得新资料且仍有遗漏，才做同日第二次补采；单纯重试失败连接不会创造证据。
  if (datasets.includes('trade') && state.trade_missing > 0 && Number(initialDetail?.trade?.collected_count || 0) > 0) {
    await attempt('trade', async () => {
      const collect = await import('./collect-svc.mjs');
      return collect.collectTradeQuotes({ actor, limit, onlyNew: true, withDimension: true });
    });
  }
  if (datasets.includes('policy') && state.methodology_missing_original > 0 &&
      Number(initialDetail?.methodology_originals?.archived || 0) > 0) {
    await attempt('methodology', async () => {
      const methods = await import('./methodology-archive-svc.mjs');
      return methods.backfillMethodologyOriginals({ actor, limit });
    });
  }
  if (datasets.includes('project') && state.project_open > 0 && round === 1 && initialDetail?.project?.ok === false) {
    await attempt('project', async () => {
      const registry = await import('./registry-svc.mjs');
      return registry.syncRegistry({ actor, maxDetails: Math.min(limit, 20), archiveFiles: false });
    });
  }
  return actions;
}

export async function runEvidenceLoop({
  actor = 'system:evidence-loop', datasets = ['policy', 'project', 'trade', 'content', 'verify'],
  maxRounds = 2, limit = 8, initialDetail = {}, inspect = evidenceState, repair = repairRound,
  afterProgress = null,
} = {}) {
  const roundsMax = Math.min(Math.max(Number(maxRounds) || 1, 1), 3);
  const itemLimit = Math.min(Math.max(Number(limit) || 8, 1), 30);
  const out = { rounds: [], stop_reason: null, evidence_gained: false };
  for (let round = 1; round <= roundsMax; round += 1) {
    const before = inspect();
    const actionable = (datasets.includes('content') && before.content_incomplete > 0) ||
      (datasets.includes('policy') && before.policy_missing_original > 0) ||
      (datasets.includes('trade') && before.trade_missing > 0 && Number(initialDetail?.trade?.collected_count || 0) > 0) ||
      (datasets.includes('policy') && before.methodology_missing_original > 0 && Number(initialDetail?.methodology_originals?.archived || 0) > 0) ||
      (datasets.includes('project') && before.project_open > 0 && round === 1 && initialDetail?.project?.ok === false);
    if (!actionable) { out.stop_reason = '没有可由现有公开来源定向补采的缺口'; break; }
    const actions = await repair({ actor, datasets, limit: itemLimit, state: before, initialDetail, round });
    const after = inspect();
    const progress = evidenceProgress(before, after);
    out.rounds.push({ round, before, after, progress, actions });
    if (!progress.length) { out.stop_reason = '本轮没有取得新证据，停止重复调用'; break; }
    out.evidence_gained = true;
    if (afterProgress) await afterProgress({ actor, datasets, round, progress });
  }
  if (!out.stop_reason) out.stop_reason = `达到 ${roundsMax} 轮上限`;
  audit({ actor, actorRole: 'system', action: 'evidence.loop', objectType: 'ingestion_job',
    objectId: null, detail: { rounds: out.rounds.map(({ round, progress }) => ({ round, progress })), stop_reason: out.stop_reason } });
  return out;
}
