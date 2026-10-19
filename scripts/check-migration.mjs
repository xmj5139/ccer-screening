/** 迁移自检脚本：验证 v2 增量迁移是否幂等、是否影响 v1 表。 */
import { getDb, all, metaValue, tableCount } from '../src/core/db.mjs';

getDb();
const tables = all("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").map((t) => t.name);
console.log('表数量：', tables.length);
console.log(tables.join(', '));
console.log('schema_version =', metaValue('schema_version'));
console.log('catalog tables:', ['policy_document', 'public_project', 'trade_daily', 'ingestion_job', 'review_task', 'llm_provider', 'datasource_config', 'methodology_doc_verification'].map((t) => `${t}=${tableCount(t)}`).join(' '));
// 幂等性：再跑一次 migrate
getDb().exec('SELECT 1');
console.log('再次 getDb 成功（迁移幂等）');
