/** Show recent ingestion failures without dumping responses or credentials. */
import { initV2Env } from './v2-env.mjs';
await initV2Env({ quiet: true });
const { getDb, closeDb } = await import('../src/core/db.mjs');
const db = getDb();
const jobs = db.prepare('SELECT id, status, started_at, error_summary, detail_json FROM ingestion_job ORDER BY started_at DESC LIMIT 3').all();
for (const job of jobs) {
  const detail = JSON.parse(job.detail_json || '{}');
  console.log(JSON.stringify({
    id: job.id, status: job.status, started_at: job.started_at, error_summary: job.error_summary,
    content: detail.content ? { ok: detail.content.ok, reason: detail.content.reason } : null,
    content_seed: detail.content_seed ? { ok: detail.content_seed.ok, reason: detail.content_seed.reason } : null,
    verify: detail.verify ? { ok: detail.verify.ok, reason: detail.verify.reason, error: detail.verify.error } : null,
    project: detail.project ? { ok: detail.project.ok, errors: detail.project.stats?.errors?.length } : null,
  }));
  const steps = db.prepare("SELECT stage, target, status, message FROM ingestion_step WHERE job_id=? AND status='failed' LIMIT 20").all(job.id);
  for (const s of steps) console.log(JSON.stringify(s));
}
closeDb();
