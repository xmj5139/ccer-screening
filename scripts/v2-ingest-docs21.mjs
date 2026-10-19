/**
 * docs/21 真实公开文章的联网入库与日期来源验证（二轮整改验收）
 * ============================================================================
 * 目的：用**真实公开页面**验证「发现 → 抓取正文 → 日期抽取 → 去重 → 落库 → 自动核验」，
 * 并核对发布日期**只来自来源页面声明**（不取采集时间、不取搜索摘要、不取 URL 年份）。
 *
 * 目标文章（docs/21-公开来源与连接参考.md）：
 *   1. 北京理工大学能源与环境政策研究中心《全球和中国碳市场回顾与展望（2026）》
 *      页面记载发布日 2026-01-12；页面声明转载需事先同意，因此只归档元数据/简短摘要，
 *      不重新分发原 PDF。
 *   2. 全国温室气体自愿减排交易系统「为地球降温—全民参与碳抵销行动」正式上线
 *      网页时间 2026-09-20（活动发生于 9 月 14 日，两者必须区分）。
 *
 * 用法：
 *   node scripts/v2-ingest-docs21.mjs            # 写入真实 v2 库并核验
 *   node scripts/v2-ingest-docs21.mjs --no-write # 只抓取与解析，不写库
 *
 * 说明：模型未配置凭据时核验结果如实为 unavailable（不会伪造「已核验」）。
 */
import { initV2Env, parseArgs } from './v2-env.mjs';

const args = parseArgs();
const { dbPath } = await initV2Env({ quiet: true });
const noWrite = args['no-write'] === true;

const db = await import('../src/core/db.mjs');
const fetchSvc = await import('../src/services/web-fetch-svc.mjs');
const content = await import('../src/services/content-svc.mjs');
const verify = await import('../src/services/verification-svc.mjs');
const admin = await import('../src/services/admin-v2-svc.mjs');

db.getDb();

const TARGETS = [
  {
    id: 'bit-ceep-2026',
    url: 'https://ceep.bit.edu.cn/zxcg/ndycbg/1a2c1e2116184a51b2fa88d1ede43ddc.htm',
    expect_date: '2026-01-12',
    content_type: 'research_report',
    source_category: 'institution',
    publisher: '北京理工大学能源与环境政策研究中心',
    note: 'docs/21 收录：页面声明转载需事先同意，只展示链接、元数据与简短摘要，不重新分发原 PDF。',
  },
  {
    id: 'ccer-com-20260920',
    url: 'https://www.ccer.com.cn/wcm/ccer/html/2408scdt1/20260920/102025504.shtml',
    expect_date: '2026-09-20',
    content_type: 'industry_news',
    source_category: 'exchange',
    publisher: '全国温室气体自愿减排交易系统',
    note: 'docs/21 收录：交易平台动态（不是政策法规）；发布日 2026-09-20，活动发生于 9 月 14 日，两者区分。',
  },
];

console.log('');
console.log('  docs/21 真实公开文章入库与日期来源验证');
console.log('  ═════════════════════════════════════════════');
console.log(`  数据库：${dbPath}`);
console.log(`  写入模式：${noWrite ? '只读（抓取与解析，不写库）' : '写入真实采集结果'}`);
console.log('  ─────────────────────────────────────────────');

/* 抓取连接：直连 HTTP（无需第三方密钥）；这里只补充 docs/21 的原始发布域到白名单 */
const ALLOWED = [
  'mee.gov.cn', 'www.mee.gov.cn', 'ccer.cets.org.cn', 'www.ccer.com.cn',
  'cneeex.com', 'www.cneeex.com', 'overview.cneeex.com',
  'tanpaifang.com', 'www.tanpaifang.com', 'tanjiaoyi.com', 'www.tanjiaoyi.com',
  'ceep.bit.edu.cn', 'www.ctg.com.cn', 'ctg.com.cn',
];
let conn = db.get("SELECT * FROM web_fetch_connection WHERE id='WFC-DIRECT-REAL'");
if (!conn) {
  if (noWrite) {
    conn = {
      id: 'WFC-DIRECT-REAL-RO', name: '直连 HTTP（只读临时）', conn_kind: 'direct_http',
      base_url: 'https://www.mee.gov.cn', endpoint_path: '/', auth_kind: 'none',
      allowed_domains: JSON.stringify(ALLOWED), timeout_ms: 30000, retry_max: 1,
      daily_quota: 100, calls_today: 0, calls_today_date: null, enabled: 1,
    };
  } else {
    const created = fetchSvc.upsertFetchConnection(
      { name: 'admin', role: 'admin' },
      {
        id: 'WFC-DIRECT-REAL', name: '直连 HTTP 抓取（本服务自行请求官方与行业公开页面）',
        conn_kind: 'direct_http', base_url: 'https://www.mee.gov.cn', endpoint_path: '/',
        auth_kind: 'none', allowed_domains: ALLOWED, timeout_ms: 30000, retry_max: 1,
        daily_quota: 300, enabled: true,
        note: '由本服务直接 GET 目标页面并抽取正文文本；无需第三方密钥；不执行 JS。',
      }
    );
    if (created.error) {
      console.error(`  ✗ 创建抓取连接失败：${created.error}`);
      process.exit(1);
    }
    conn = db.get("SELECT * FROM web_fetch_connection WHERE id='WFC-DIRECT-REAL'");
  }
}
if (!noWrite && !ujAllowed(conn.allowed_domains, ALLOWED)) {
  fetchSvc.upsertFetchConnection({ name: 'admin', role: 'admin' }, { id: conn.id, allowed_domains: ALLOWED });
  conn = db.get("SELECT * FROM web_fetch_connection WHERE id=?", [conn.id]);
  console.log('  已把 docs/21 原始发布域补入抓取白名单。');
}
function ujAllowed(raw, want) {
  try {
    const have = JSON.parse(raw || '[]');
    return want.every((d) => have.includes(d));
  } catch {
    return false;
  }
}

let ok = 0;
let bad = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 抓取一次；网络类失败最多再重试 2 次（带退避），不做无限重试。 */
async function fetchOnce(url, attempt = 1) {
  const fr = await fetchSvc.fetchUrlContent({ ...conn, enabled: 1, retry_max: 0 }, url, {});
  if (!fr.ok && ['network', 'timeout'].includes(fr.reason) && attempt < 3) {
    console.log(`  … 第 ${attempt} 次失败（${fr.reason}），${attempt * 2}s 后重试`);
    await sleep(attempt * 2000);
    return fetchOnce(url, attempt + 1);
  }
  return fr;
}

for (const t of TARGETS) {
  console.log('');
  console.log(`  ── ${t.id} ──`);
  console.log(`  URL：${t.url}`);
  const fr = await fetchOnce(t.url);
  if (!fr.ok) {
    bad += 1;
    console.log(`  ✗ 抓取失败（${fr.reason}）：${fr.message || ''}`);
    console.log('     环境/站点限制如实记录，不伪造成功；可稍后重试或改用已配置凭据的抓取连接。');
    continue;
  }
  const date = content.extractPublishedDate(fr.raw_html || '', { url: t.url, text: fr.content });
  const sourceSummary = content.extractMetaDescription(fr.raw_html || '');
  console.log(`  ✓ 抓取成功：${fr.chars} 字符｜连接：${fr.conn_kind}`);
  console.log(`  标题：${fr.title || '(无 <title>)'}`);
  console.log(`  发布日期：${date.published_at || '未披露'}｜依据：${date.date_source || '—'}`);
  console.log(`  日期说明：${date.note || '—'}`);
  console.log(`  来源摘要（页面自带）：${sourceSummary ? sourceSummary.slice(0, 120) : '（无 meta description）'}`);
  const expectedOk = !t.expect_date || date.published_at === t.expect_date;
  console.log(`  与 docs/21 记载日期一致：${expectedOk ? '是' : `否（docs/21 为 ${t.expect_date}，本次解析 ${date.published_at}）`}`);
  if (!expectedOk) bad += 1; else ok += 1;

  if (noWrite) continue;
  const { key_points, claims } = content.extractClaimsAndPoints(fr.content || '');
  const up = content.upsertContent(
    {
      content_type: t.content_type,
      record_kind: 'article',
      title: fr.title || t.id,
      publisher: t.publisher || null,
      published_at: date.published_at,
      source_url: t.url,
      source_category: t.source_category,
      body_availability: content.availabilityFromFetch(fr, fr.content),
      summary: sourceSummary,
      auto_summary: sourceSummary ? null : String(fr.content || '').slice(0, 300),
      auto_summary_kind: sourceSummary ? null : 'extractive',
      key_points,
      claims,
      topics: ['docs/21 验收', t.id],
      body_snapshot: fr.content,
      note: [t.note, date.note, `正文由直连 HTTP 确定性抽取（${fr.chars} 字符），未执行 JS。`].filter(Boolean).join('；'),
    },
    { actor: 'system:docs21-verify' }
  );
  console.log(`  入库：${up.action}｜id=${up.id}${up.availability ? `｜正文可获得性=${up.availability}` : ''}`);
  // 幂等补齐发布者：首次采集未标注原始发布者时按 docs/21 的来源归属补写（不改写正文）
  if (t.publisher) {
    const cur = db.get('SELECT publisher FROM content_item WHERE id=?', [up.id]);
    if (cur && !cur.publisher) {
      db.run('UPDATE content_item SET publisher=?, updated_at=? WHERE id=?', [t.publisher, new Date().toISOString(), up.id]);
      console.log(`  已补写原始发布者：${t.publisher}（核验将在下一轮自动重算）`);
    }
  }
  const v = await verify.verifyContentItem(up.id, { actor: 'system:docs21-verify', force: true });
  console.log(`  自动核验：${v.label || v.result}（${v.result}）｜${v.summary || ''}`);
  if (v.capability_note) console.log(`  核验能力说明：${v.capability_note}`);
  const row = db.get('SELECT id,title,published_at,body_availability,verification_status,record_kind FROM content_item WHERE id=?', [up.id]);
  console.log(`  库内回读：${JSON.stringify(row)}`);
}

console.log('');
console.log('  ─────────────────────────────────────────────');
const cfg = verify.verifyConfig();
const provider = verify.pickVerifyProvider(cfg);
const cred = provider ? admin.resolveCredential(provider) : { ok: false, reason: '未配置模型' };
console.log(`  模型状态：${provider ? `${provider.name}/${provider.model}｜凭据${cred.ok ? '已配置' : '未配置'}` : '未配置'}`);
console.log(`  日期一致性：${ok} 项通过，${bad} 项异常`);
console.log('  说明：日期只取来源页面声明；模型不可用时核验如实为「暂未自动核验」，不伪造通过。');
console.log('  ═════════════════════════════════════════════');
db.closeDb();
// 不调用 process.exit：undici keep-alive 连接会在退出时触发 libuv 断言；
// 改用退出码让进程自然结束。
process.exitCode = bad ? 1 : 0;
