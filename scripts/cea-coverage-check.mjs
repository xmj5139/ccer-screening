/**
 * 展示 CEA 政策/配额文件的行业×年度配对覆盖与适用性判定结果。
 * 用于核对「钢铁 2025 不适用 2026 分配方案、发电 2025/2026 适用」这类配对规则。
 * 用法：node scripts/cea-coverage-check.mjs
 */
import { initV2Env } from './v2-env.mjs';

if (!process.env.CCER_DB_PATH) process.env.CCER_DB_PATH = 'data/cea-dev-20261014.db';
await initV2Env({ quiet: true });

const db = await import('../src/core/db.mjs');
const { documentApplicability } = await import('../src/services/cea-svc.mjs');
const { uj } = await import('../src/core/util.mjs');
db.getDb();

const docs = db.all('SELECT id,doc_key,title,doc_number,evidence_level,count_in_stats,attachment_of,coverage_json FROM cea_document ORDER BY doc_key');
console.log('文件（doc_key｜证据等级｜是否计入统计｜附件关联｜文号）');
for (const d of docs) {
  console.log(`  ${d.doc_key}｜${d.evidence_level}｜${d.count_in_stats ? '计入' : '不计入(附件)'}｜${d.attachment_of ? `附件→${d.attachment_of}` : '主行'}｜${d.doc_number || '—'}`);
}
console.log('');
const target = docs.find((d) => d.doc_key === 'cea_allocation_pdf_2026_1') || docs.find((d) => uj(d.coverage_json, []).length);
if (!target) {
  console.log('未找到带配对覆盖的文件。');
  db.closeDb();
  process.exit(0);
}
console.log(`适用性判定（文件：${target.doc_key}）`);
console.log(`  配对覆盖：${JSON.stringify(uj(target.coverage_json, []))}`);
for (const [sector, year] of [['发电', 2025], ['发电', 2026], ['钢铁', 2025], ['钢铁', 2026], ['水泥', 2025], ['水泥', 2026], ['铝冶炼', 2025], ['铝冶炼', 2026], ['石化', 2026]]) {
  const r = documentApplicability(target, { sector, year });
  console.log(`  ${String(sector).padEnd(4)} ${year} → applicable=${String(r.applicable).padEnd(5)}｜${r.reason.slice(0, 110)}`);
}
console.log('');
console.log(`政策计数（count_in_stats=1）：${docs.filter((d) => d.count_in_stats).length} 条；全部行数：${docs.length} 条（附件行不重复计入）`);
db.closeDb();
