/** 从官方公开项目栏目更新项目、详情和附件；始终使用独立 v2 数据库。 */
import { initV2Env, parseArgs } from './v2-env.mjs';
const args=parseArgs();
const {dbPath}=await initV2Env({temp:!!args.temp});
const db=await import('../src/core/db.mjs');
const registry=await import('../src/services/registry-svc.mjs');
db.getDb();
console.log(`[registry] 数据库 ${dbPath}`);
const result=await registry.syncRegistry({actor:'system:registry-cli',maxDetails:Number(args.limit)||500,
  archiveFiles:!!args.files || (!!process.env.CCER_REGISTRY_COOKIE && !args['no-files']),activeRefresh:!args['no-refresh']});
console.log(JSON.stringify(result,null,2));
db.closeDb();
if(!result.ok)process.exitCode=2;
