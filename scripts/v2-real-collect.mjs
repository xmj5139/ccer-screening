/**
 * 真实联网采集验证脚本（非测试套件；会访问真实互联网）
 * ============================================================================
 * 用途：在**真实网络**条件下验证「来源发现 → 抓取正文 → 去重 → 抽取 → 模型核验 →
 * 自动发布」链路，并把真实结果写入 v2 数据库。
 *
 * 明确区分「真实联网数据」与「模拟测试」：
 *   - 本脚本抓的是真实公网页面，结果是真实公开数据；
 *   - 模型核验只有在真实配置了模型凭据时才会真正调用外部模型；
 *     未配置时如实记为 unavailable，不伪造「已核验」。
 *
 * 用法：
 *   node scripts/v2-real-collect.mjs                 # 抓种子来源 + 报告统计
 *   node scripts/v2-real-collect.mjs --seeds=4       # 限制抓取来源数量
 *   node scripts/v2-real-collect.mjs --no-write      # 只读探测：不写业务数据、不建连接、不写游标
 *
 * 【--no-write 的真实语义】（docs/22 第 15 条）：
 *   只做**读取型**探测（连接是否已存在、模型/搜索是否配置），不 upsert 任何连接配置，
 *   不落库快照、不写 dataset_cursor、不执行内容核验；仅打印当前库的真实统计。
 */
import { initV2Env, parseArgs } from './v2-env.mjs';

const args = parseArgs();
const { dbPath } = await initV2Env({ quiet: true });

const db = await import('../src/core/db.mjs');
const fetchSvc = await import('../src/services/web-fetch-svc.mjs');
const content = await import('../src/services/content-svc.mjs');
const verify = await import('../src/services/verification-svc.mjs');
const admin = await import('../src/services/admin-v2-svc.mjs');
const search = await import('../src/services/search-svc.mjs');

db.getDb();
const noWrite = args['no-write'] === true;
const seedLimit = Number(args.seeds) || content.SEED_SOURCES.filter((s) => s.enabled).length;

console.log('');
console.log('  CCER 公开信息平台 · 真实联网采集验证');
console.log('  ═════════════════════════════════════════════');
console.log(`  数据库：${dbPath}`);
console.log(`  写入模式：${noWrite ? '只读探测（不写业务数据 / 不建连接 / 不写游标）' : '写入真实采集结果'}`);
console.log('  ─────────────────────────────────────────────');

/* ---------------------- 1. 直连 HTTP 抓取连接（只读检查；仅写入模式才创建） ---------------------- */

const CONN_ID = 'WFC-DIRECT-REAL';
let conn = db.get('SELECT * FROM web_fetch_connection WHERE id=?', [CONN_ID]);
if (!conn && noWrite) {
  // 只读模式：不创建任何连接配置，也不写 probe 游标
  console.log('  （--no-write：未找到抓取连接，跳过真实抓取；不会创建连接或写任何配置）');
  const st0 = content.contentStats();
  console.log(`  当前内容库（正文条目，不含来源归档/演示/转载）：${st0.total}`);
  console.log(`  最近发布：${st0.latest_published_at || '—'}｜最近采集：${st0.last_collected_at || '—'}`);
  console.log(`  搜索服务：${JSON.stringify(search.searchStatus().detail)}`);
  console.log(`  抓取连接：${JSON.stringify(fetchSvc.fetchStatus().detail)}`);
  const cfg0 = verify.verifyConfig();
  console.log(`  模型：${verify.pickVerifyProvider(cfg0)?.name || '未配置'}（只读探测，不执行核验）`);
  console.log('');
  console.log('  只读探测结束：未写入任何业务数据或配置。');
  db.closeDb();
  process.exit(0);
}
if (!conn) {
  const created = fetchSvc.upsertFetchConnection(
    { name: 'system:real-collect', role: 'admin' },
    {
      id: CONN_ID,
      name: '直连 HTTP 抓取（本服务自行请求官方与行业公开页面）',
      conn_kind: 'direct_http',
      base_url: 'https://www.mee.gov.cn',
      endpoint_path: '/',
      auth_kind: 'none',
      allowed_domains: [
        'mee.gov.cn', 'www.mee.gov.cn', 'ccer.cets.org.cn', 'www.ccer.com.cn',
        'cneeex.com', 'www.cneeex.com', 'overview.cneeex.com',
        'tanpaifang.com', 'www.tanpaifang.com',
        'tanjiaoyi.com', 'www.tanjiaoyi.com', 'chinacoal.gov.cn', 'www.chinacoal.gov.cn',
        'cresa.org.cn', 'www.cresa.org.cn',
        // docs/21 的真实公开文章页（用于可验证的联网验收）
        'ceep.bit.edu.cn', 'www.ctg.com.cn', 'ctg.com.cn',
      ],
      timeout_ms: 25000,
      retry_max: 1,
      daily_quota: 300,
      enabled: true,
      note: '由本服务直接 GET 目标页面并抽取正文文本；无需第三方密钥；不执行 JS。',
    }
  );
  if (created.error) {
    console.error(`  ✗ 创建抓取连接失败：${created.error}`);
    process.exit(1);
  }
  conn = db.get('SELECT * FROM web_fetch_connection WHERE id=?', [created.id]);
}
console.log(`  抓取连接：${conn.name}`);
console.log(`  连接状态：${conn.enabled ? '已启用' : '未启用'}｜类别 ${conn.conn_kind}`);

/* ---------------------- 2. 种子来源可用性真实实测 ---------------------- */

console.log('');
console.log('  [1/4] 种子来源官网可用性实测（真实 HTTP 请求）');
console.log('  ─────────────────────────────────────────────');
let probe = { available: 0, total: 0, results: [] };
if (noWrite) {
  // 只读探测：verifySeedSources 会写 seed_source_probe 游标，故只读模式跳过，
  // 改为如实打印当前库中已有的实测结论（不产生新的写入）。
  const cur = db.get("SELECT * FROM dataset_cursor WHERE dataset='seed_source_probe'");
  console.log(`  （--no-write：不发起会写游标的实测；库中最近实测：${cur ? `${cur.last_status} @ ${cur.last_attempt_at}` : '从未'}）`);
  console.log(`  ${cur?.note || ''}`);
} else {
  probe = await content.verifySeedSources({ actor: 'system:real-collect' });
  for (const r of probe.results) {
    const mark = r.ok ? '✓' : '✗';
    console.log(`  ${mark} ${r.name}`);
    console.log(`      ${r.url}`);
    console.log(`      ${r.ok ? `HTTP 可达，${r.chars} 字符，${r.latency_ms} ms` : `不可用：${r.status} ${r.message || ''}`}`);
  }
  console.log(`  ── 实测可用：${probe.available}/${probe.total} ──`);
}

/* ---------------------- 3. 抓取种子来源公开正文页 ---------------------- */

console.log('');
console.log('  [2/4] 发现并抓取来源正文页（真实联网；首页只作来源归档）');
console.log('  ─────────────────────────────────────────────');

let tally = { attempted: 0, fetched: 0, failed: 0, inserted: 0, updated: 0, unchanged: 0,
  archive_records: 0, articles_discovered: 0, articles_fetched: 0, published_dated: 0, published_undated: 0, failures: [] };
if (!noWrite) {
  tally = await content.collectFromSeedSources({
    actor: 'system:real-collect',
    fetchLimit: seedLimit,
    maxArticlesPerSource: 3,
    verify: false,
    log: (m) => console.log(`  ${m}`),
  });
  console.log(
    `  ── 来源页 ${tally.attempted} 个：抓取成功 ${tally.fetched}，失败 ${tally.failed}；` +
    `发现正文 ${tally.articles_discovered} 篇、成功 ${tally.articles_fetched} 篇` +
    `（有发布日期 ${tally.published_dated} / 未披露 ${tally.published_undated}）；来源归档 ${tally.archive_records} 条（不计入文章）──`
  );
  for (const f of tally.failures || []) {
    console.log(`  ✗ ${f.source}（${f.reason}）：${String(f.message || '').slice(0, 120)}`);
  }
} else {
  console.log('  （--no-write：跳过写入与抓取）');
}

/* ---------------------- 4. 自动核验（真实模型状态） ---------------------- */

console.log('');
console.log('  [3/4] 自动核验（模型可用性如实记录）');
console.log('  ─────────────────────────────────────────────');
const cfg = verify.verifyConfig();
const provider = verify.pickVerifyProvider(cfg);
if (!provider) {
  console.log('  ✗ 未配置可用模型：内容将标记为「暂未自动核验」（unavailable）');
} else {
  const cred = admin.resolveCredential(provider);
  console.log(`  模型：${provider.name} · ${provider.model}`);
  console.log(`  凭据：${cred.ok ? `已配置（来源：${cred.source}）` : `未配置 — ${cred.reason}`}`);
  console.log(`  可调用性：${cred.ok ? '具备调用条件（是否真正可达取决于网络与配额）' : '不可调用'}`);
}
const llmStatus = admin.llmStatus();
console.log(`  模型配置数：${llmStatus.providers}｜已启用：${llmStatus.enabled_providers}｜任一能力可用：${llmStatus.any_ai_available}`);
console.log(`  搜索服务：${JSON.stringify(search.searchStatus().detail)}`);

if (!noWrite) {
  const vr = await verify.verifyContentBatch({ actor: 'system:real-collect', limit: 30, onlyUnverified: true });
  console.log(`  核验结果：共 ${vr.total} 条 → 通过 ${vr.verified}｜证据不足 ${vr.insufficient}｜来源冲突 ${vr.conflict}｜暂未自动核验 ${vr.unavailable}｜命中缓存 ${vr.cached}`);
}

/* ---------------------- 5. 最终统计 ---------------------- */

console.log('');
console.log('  [4/4] 采集后统计（真实库）');
console.log('  ─────────────────────────────────────────────');
const st = content.contentStats();
console.log(`  公开内容条目（不含演示与转载副本）：${st.total}`);
console.log(`  按类型：${JSON.stringify(st.by_type_label)}`);
console.log(`  按来源类别：${JSON.stringify(st.by_source_category)}`);
console.log(`  按核验状态：${JSON.stringify(st.by_verification)}`);
console.log(`  按正文可获得性：${JSON.stringify(st.by_availability)}`);
console.log(`  最近发布：${st.latest_published_at || '—'}｜最近采集：${st.last_collected_at || '—'}`);
console.log(`  已排除演示条目：${st.demo_excluded}｜已关联转载副本：${st.reprints_linked}`);
const cursors = (await import('../src/services/collect-svc.mjs')).listDatasetCursors()
  .filter((c) => ['content_discovery', 'seed_source_probe', 'verify_content'].includes(c.dataset));
for (const c of cursors) {
  console.log(`  游标 ${c.dataset}：状态 ${c.last_status}｜最近成功 ${c.last_success_at || '从未'}｜${c.note || ''}`);
}
const dup = content.dedupeAudit();
console.log(`  去重自检：${dup.ok ? '通过（无重复 URL / 内容哈希）' : `发现重复：${JSON.stringify(dup)}`}`);
console.log('');
console.log('  ═════════════════════════════════════════════');
console.log('  说明：以上数量为**真实联网采集**结果；未配置模型时核验状态为');
console.log('        「暂未自动核验」，平台不会伪造核验通过。');
console.log('');

db.closeDb();
