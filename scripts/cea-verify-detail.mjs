/**
 * 查看 CEA 条目的 AI 证据一致性核验详情（核查是否真实调用模型、引文是否可定位）。
 * 用法：node scripts/cea-verify-detail.mjs [--limit=5]
 */
import { initV2Env, parseArgs } from './v2-env.mjs';

const args = parseArgs(process.argv.slice(2));
if (!process.env.CCER_DB_PATH) process.env.CCER_DB_PATH = 'data/cea-dev-20261014.db';
await initV2Env({ quiet: true });

const db = await import('../src/core/db.mjs');
const { uj } = await import('../src/core/util.mjs');
db.getDb();
const rows = db.all(
  `SELECT * FROM verification_result WHERE object_type IN ('cea_trade_daily','cea_document')
   ORDER BY created_at DESC LIMIT ?`,
  [Number(args.limit) || 5]
);
for (const r of rows) {
  const citations = uj(r.citations_json, []);
  const rules = uj(r.rules_json, []);
  const llm = db.get(
    'SELECT at,purpose,model,request_chars,response_chars,latency_ms,status,error FROM llm_call_log WHERE object_id=? ORDER BY at DESC LIMIT 1',
    [r.object_id]
  );
  console.log('─'.repeat(78));
  console.log(`对象：${r.object_type} / ${r.object_id}`);
  console.log(`结论：${r.result}（${r.ui_state}）｜模型调用：${r.model_used ? '是' : '否'}｜证据等级：${r.evidence_level}`);
  console.log(`provider=${r.provider_id} model=${r.model}｜引文 通过 ${r.citations_validated} / 驳回 ${r.citations_rejected}｜confidence=${r.confidence}`);
  console.log(`input_hash=${String(r.input_hash).slice(0, 16)}… policy_hash=${String(r.policy_hash).slice(0, 12)}… model_key=${r.model_key}`);
  console.log(`说明：${r.capability_note || '（无）'}`);
  console.log(`摘要：${r.summary || '（无）'}`);
  if (r.error) console.log(`错误：${r.error}`);
  console.log(`规则：${rules.map((c) => `${c.rule_key}=${c.ok ? 'ok' : 'FAIL'}`).join(', ') || '（无）'}`);
  console.log(`真实调用日志：${llm ? `${llm.at} ${llm.purpose} ${llm.model} ${llm.status} ${llm.latency_ms}ms 请求${llm.request_chars}字 响应${llm.response_chars}字 ${llm.error || ''}` : '（无）'}`);
  for (const c of citations) {
    console.log(`  引文[${c.kind}] locator=${c.locator || '-'} validated=${c.validated} match=${c.match || '-'}`);
    console.log(`    quote: ${String(c.quote).slice(0, 180)}`);
  }
}
db.closeDb();
