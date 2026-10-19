/**
 * 打印某条 CEA 通道快照被送入模型的「聚焦证据」（用于核对 AI 核验到底看到了什么）。
 * 用法：node scripts/cea-evidence-preview.mjs [--url=<片段>] [--id=<快照ID>] [--snapshot-id=<快照ID>]
 */
import { initV2Env, parseArgs } from './v2-env.mjs';

const args = parseArgs(process.argv.slice(2));
if (!process.env.CCER_DB_PATH) process.env.CCER_DB_PATH = 'data/cea-dev-20261014.db';
await initV2Env({ quiet: true });

const db = await import('../src/core/db.mjs');
const { focusCeaEvidence } = await import('../src/services/verification-svc.mjs');
db.getDb();

let snap = null;
if (args['snapshot-id']) snap = db.get('SELECT id,url,body_text,fetched_at FROM source_snapshot WHERE id=?', [String(args['snapshot-id'])]);
else {
  const like = `%${args.url || 'querySubStat'}%`;
  snap = db.get('SELECT id,url,body_text,fetched_at FROM source_snapshot WHERE url LIKE ? ORDER BY fetched_at DESC LIMIT 1', [like]);
}
if (!snap) {
  console.error('未找到匹配的快照。');
  process.exit(2);
}
const focused = focusCeaEvidence(snap.body_text, snap.url);
console.log(`快照：${snap.id}`);
console.log(`URL ：${snap.url}`);
console.log(`抓取：${snap.fetched_at}`);
console.log(`原文长度：${String(snap.body_text || '').length} 字符；聚焦后：${focused.length} 字符`);
console.log('─'.repeat(78));
console.log(focused);
db.closeDb();
