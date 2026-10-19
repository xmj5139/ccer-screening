#!/usr/bin/env node
/**
 * 初始化 / 重建数据库。
 *   node scripts/seed.mjs            —— 重建参考数据与示例项目（保留数据库文件）
 *   node scripts/seed.mjs --reset    —— 删除数据库文件后完全重建
 *   node scripts/seed.mjs --no-demo  —— 只建参考数据，不写入示例项目
 */
import { rmSync, existsSync } from 'node:fs';
import { dbPath, getDb, closeDb, tableCount } from '../src/core/db.mjs';
import { seedAll } from '../src/services/seed.mjs';
import { OFFICIAL_SOURCES, METHODOLOGY_CATALOG } from '../src/data/catalog.mjs';
import { listMethodologyModules, collectSelfCheckSamples } from '../src/methodologies/index.mjs';

const args = process.argv.slice(2);

if (args.includes('--reset')) {
  const p = dbPath();
  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(p + suffix)) rmSync(p + suffix, { force: true });
  }
  console.log(`已删除数据库文件：${p}`);
}

getDb();
const res = seedAll({ withDemo: !args.includes('--no-demo') });

console.log('数据库：', dbPath());
console.log('官方来源：', res.sources, '条');
console.log('方法学版本：', res.methodology_versions, '条');
console.log('项目事实字段：', res.fact_fields, '个');
console.log('已注册方法学插件：', listMethodologyModules().map((m) => m.meta.methodology_id).join('、'));
console.log('插件自检样例：', collectSelfCheckSamples().length, '个');
console.log('');
console.log('表记录数：');
for (const t of [
  'source_document', 'methodology_version', 'rule', 'formula', 'factor_version',
  'fact_field', 'project', 'project_fact', 'project_evidence', 'alert', 'app_user',
]) {
  console.log(`  ${t.padEnd(22)} ${tableCount(t)}`);
}
console.log('');
console.log('方法学目录：');
for (const m of METHODOLOGY_CATALOG) {
  const flag = m.document_status === 'formal' ? (m.is_candidate_eligible ? '正式·可候选' : '正式·不可候选') : '草案（仅观察）';
  console.log(`  ${(m.code_display || `（编号待核实）${m.methodology_id}`).padEnd(34)} ${m.name.slice(0, 30).padEnd(32)} ${flag}`);
}
console.log('');
console.log(`一级来源 ${OFFICIAL_SOURCES.filter((s) => s.tier === 1).length} 条，全部标注官方出处。`);
closeDb();
