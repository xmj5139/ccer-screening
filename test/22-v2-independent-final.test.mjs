/** 独立验收发现的真实回归：公告入库、日期语义、栏目排除与 Windows 密钥权限。 */
import { setupV2, finish, test, testAsync, assert, assertEqual } from './v2-helpers.mjs';
import { join } from 'node:path';
const ctx = await setupV2({ withPublicDemo: true });
const { db, collect, policy } = ctx;
const content = await import('../src/services/content-svc.mjs');

test('事件日期及 URL 候选不得冒充发布日期', () => {
  const d = content.extractPublishedDate('<p>活动于2026年9月14日举行。</p>', {url:'https://www.mee.gov.cn/20260920/news.shtml'});
  assertEqual(d.published_at, null);
  assertEqual(d.date_candidate, '2026-09-20');
  assertEqual(content.extractPublishedDate('<meta content="2026-09-20" property="article:published_time">').published_at, '2026-09-20');
  assertEqual(content.extractPublishedDate('<p>发布时间：2026年9月20日</p>').published_at, '2026-09-20');
});
test('深层栏目和 APP 产品页不作为文章，正文仍可发现', () => {
  const html = '<a href="/zxcg/ndycbg/index.htm">年度预测报告栏目</a><a href="/app">碳市场平台客户端</a><a href="/20260920/report.shtml">CCER市场研究报告</a>';
  const links = content.discoverArticleLinks(html,'https://example.com/');
  assertEqual(links.length,1);
  assert(links[0].url.endsWith('report.shtml'));
});
await testAsync('新公告实际进入可浏览政策库，复采幂等且不生成人工任务', async () => {
  const originalFetch = globalThis.fetch;
  const list = 'https://www.mee.gov.cn/xxgk2018/xxgk/xxgk06/';
  const url = list + '202609/t20260929_999999.shtml';
  const title = '关于CCER温室气体自愿减排新公告';
  globalThis.fetch = async (requested) => {
    const body = String(requested) === list
      ? `<a href="${url}">${title}</a>`
      : `<meta name="publishdate" content="2026-09-29"><h1>${title}</h1><p>这是公开通知原文，仅用于隔离测试，不推断效力状态。公开资料由自动采集任务归档并记录来源。</p>`;
    return {ok:true,status:200,url:String(requested),headers:new Headers({'content-type':'text/html'}),arrayBuffer:async()=>Buffer.from(body)};
  };
  const before = db.get('SELECT COUNT(*) c FROM review_task').c;
  try {
    const first = await collect.discoverPolicyNotices({listUrls:[list]});
    assertEqual(first.stats.published,1);
    const rows = policy.listPolicies({keyword:title});
    assertEqual(rows.length,1);
    assertEqual(rows[0].publish_date,'2026-09-29');
    assertEqual(rows[0].doc_status,'notice');
    assert(rows[0].body_snapshot.includes('公开通知原文'));
    assert(rows[0].auto_verify_status, '必须触发自动核验并如实标注结果');
    const second = await collect.discoverPolicyNotices({listUrls:[list]});
    assertEqual(second.stats.published,0);
    assertEqual(policy.listPolicies({keyword:title}).length,1);
    assertEqual(db.get('SELECT COUNT(*) c FROM review_task').c,before);
  } finally {globalThis.fetch = originalFetch;}
});
if(process.platform === 'win32') {
  test('Windows 实际生成并校验 ACL；复用不覆盖主密钥', () => {
    process.env.CCER_KEY_DIR = join(ctx.dir,'isolated-keys');
  });
  const secrets = await import('../src/core/secrets.mjs');
  test('Windows ACL 实际初始化及加密往返', () => {
    const first=secrets.initMasterKeyFile();
    assert(first.ok,first.message);
    assertEqual(first.acl_verified,true);
    const second=secrets.initMasterKeyFile();
    assertEqual(second.ok,true);
    assertEqual(second.created,false);
    const encrypted=secrets.encryptSecret('temporary-test-value');
    assert(encrypted !== 'temporary-test-value');
    assertEqual(secrets.decryptSecret(encrypted),'temporary-test-value');
  });
}
finish();
