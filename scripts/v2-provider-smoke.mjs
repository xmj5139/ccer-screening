/** Minimal real provider probes for server migration, without logging credentials. */
import { initV2Env } from './v2-env.mjs';
await initV2Env({ quiet: true });
const { getDb, closeDb } = await import('../src/core/db.mjs');
const { keyStatus } = await import('../src/core/secrets.mjs');
const { testLlmProvider } = await import('../src/services/admin-v2-svc.mjs');
const { testSearchProvider } = await import('../src/services/search-svc.mjs');
const { testFetchConnection } = await import('../src/services/web-fetch-svc.mjs');
const db = getDb();
const admin = { id: 'user-admin', name: '部署验收', role: 'admin' };
const key = keyStatus();
console.log(JSON.stringify({ key_available: key.available, key_acl_verified: key.acl_verified }));
const kinds = [
  ['llm', 'llm_provider', testLlmProvider],
  ['search', 'search_provider', testSearchProvider],
  ['fetch', 'web_fetch_connection', testFetchConnection],
];
for (const [kind, table, fn] of kinds) {
  const rows = db.prepare(`SELECT id, name, enabled FROM ${table} ORDER BY created_at`).all();
  for (const row of rows) {
    if (!row.enabled) {
      console.log(JSON.stringify({ kind, name: row.name, enabled: false, tested: false }));
      continue;
    }
    try {
      const out = await fn(admin, row.id);
      console.log(JSON.stringify({
        kind, name: row.name, enabled: true,
        configured: !!out.configured, callable: !!out.callable,
        real_call_performed: !!out.real_call_performed,
        scrape_call_performed: !!out.scrape_call_performed,
        http_status: out.http_status ?? null,
        reason: out.reason ?? null,
        latency_ms: out.latency_ms ?? null,
      }));
    } catch (error) {
      console.log(JSON.stringify({ kind, name: row.name, enabled: true, error_type: error?.name || 'Error' }));
    }
  }
}
closeDb();
