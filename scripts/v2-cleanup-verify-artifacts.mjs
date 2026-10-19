/**
 * 清理「链路验证脚本」遗留在真实公开库中的验证痕迹（幂等、不删除历史）
 * ============================================================================
 * 背景：`scripts/v2-verify-model-path.mjs` 早期版本会写入真实库：
 *   - 一条指向本机临时端口的桩模型配置（不是真实供应商）；
 *   - 它被写进自动核验策略的 provider_id；
 *   - 若干 source_url 为 linkcheck.example.com 的验证条目。
 * 这些是**验证痕迹**，不是公开信息，也不应参与业务统计。
 *
 * 处理原则（不改写/不删除原始证据）：
 *   - 桩模型配置：**停用**（enabled=0, use_content_verify=0）并加备注，不删除该行；
 *   - 自动核验策略：把 provider_id 复位为 null（下次按「已启用且勾选用途」自动挑选）；
 *   - 验证条目：标记 is_demo=1 并注明原因，使其退出文章列表与统计（行与快照保留）。
 *
 * 用法：node scripts/v2-cleanup-verify-artifacts.mjs
 */
import { initV2Env } from './v2-env.mjs';

const { dbPath } = await initV2Env({ quiet: true });
const db = await import('../src/core/db.mjs');
const { nowIso, j, uj } = await import('../src/core/util.mjs');

db.getDb();
console.log('');
console.log('  清理验证脚本遗留痕迹');
console.log('  ═════════════════════════════════════════════');
console.log(`  数据库：${dbPath}`);

let stopped = 0;
for (const p of db.all("SELECT * FROM llm_provider WHERE name LIKE '%链路验证%' OR base_url LIKE '%127.0.0.1%'")) {
  if (Number(p.enabled) === 0 && Number(p.use_content_verify) === 0 && String(p.note || '').includes('已停用')) continue;
  db.run(
    'UPDATE llm_provider SET enabled=0, use_content_verify=0, note=?, updated_at=? WHERE id=?',
    [
      `${p.note ? `${p.note}｜` : ''}验证脚本遗留的桩配置（指向本机临时端口，非真实供应商），已停用；如需真实核验请在后台配置厂商模型。`,
      nowIso(), p.id,
    ]
  );
  stopped += 1;
  console.log(`  已停用桩模型配置：${p.name}（${p.id}）`);
}

const cfgKey = 'auto_verify_config_v1';
const raw = db.get('SELECT value FROM system_meta WHERE key=?', [cfgKey])?.value;
let cfgReset = false;
if (raw) {
  const cfg = uj(raw, {}) || {};
  const target = cfg.provider_id ? db.get('SELECT * FROM llm_provider WHERE id=?', [cfg.provider_id]) : null;
  const isStub = target && (String(target.name).includes('链路验证') || String(target.base_url).includes('127.0.0.1'));
  if (isStub) {
    cfg.provider_id = null;
    db.run(
      `INSERT INTO system_meta (key,value,updated_at) VALUES (?,?,?)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
      [cfgKey, j(cfg), nowIso()]
    );
    cfgReset = true;
    console.log('  自动核验策略的 provider_id 已复位为 null（不再指向桩模型）。');
  }
}

let demoMarked = 0;
for (const c of db.all("SELECT * FROM content_item WHERE source_url LIKE '%linkcheck.example.com%' AND is_demo=0")) {
  db.run(
    "UPDATE content_item SET is_demo=1, note=COALESCE(note,'') || '｜链路验证脚本产生的验证条目，已标记为演示/验证数据，不计入业务统计（二轮整改留痕）', updated_at=? WHERE id=?",
    [nowIso(), c.id]
  );
  demoMarked += 1;
  console.log(`  已标记验证条目为演示数据：${c.id}（保留行与快照，不删除）`);
}

console.log('  ─────────────────────────────────────────────');
console.log(`  停用桩配置 ${stopped} 条；策略复位 ${cfgReset ? '是' : '否'}；标记验证条目 ${demoMarked} 条。`);
console.log('  ═════════════════════════════════════════════');
db.closeDb();
