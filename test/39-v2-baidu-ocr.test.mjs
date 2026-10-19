/**
 * 39-v2-baidu-ocr.test.mjs —— 百度 OCR 服务（docs/36 第 1、3、4 条）真实回归
 * ============================================================================
 * 全部走**本机 HTTP 打桩服务**（127.0.0.1，由 v2-test.mjs 显式打开回环出站），
 * 不访问任何真实百度接口、不使用任何真实凭据、不产生任何真实计费：
 *   · 鉴权 / 经典高精度 / 文档解析三类请求都打到本地 stub，逐条断言真实发出的
 *     表单字段、重试次数、配额计数与错误分类；
 *   · 生产域名固定性单独验证：非官方基址在未显式允许回环时被忽略。
 *
 * 纪律（本文件逐条验证）：
 *   1. 配置接口只返回 credential_configured / 模式 / 配额限时 / 统计；
 *      **绝不返回** cipher、api_key、secret_key、access_token；
 *   2. 保存时空密钥表示保留，只有显式 clear_credentials 才删除；
 *   3. token 只在内存缓存并按 expires_in 提前刷新；110/111 只刷新重试**一次**；
 *   4. 鉴权 / 额度 / 权限 / 超时分别归类，不无限重试；
 *   5. 配额按**实际尝试**计数；缓存命中不重复计费；
 *   6. 文档解析默认 unsupported，不伪实现；结果链接必须 HTTPS 百度官方域名。
 */
import { createServer } from 'node:http';
import {
  setupV2, test, testAsync, assert, assertEqual, assertIncludes, assertNotIncludes, finish,
} from './v2-helpers.mjs';

const ctx = await setupV2();
const { db } = ctx;

console.log('\n[v2-39] 百度 OCR：真实调用（本机 stub）/ 凭据纪律 / 重试与配额');

/* ==================================================================== */
/*  0) 本机打桩服务                                                     */
/* ==================================================================== */

/** 每次请求记录：路径、表单字段、鉴权 query —— 用于断言「真的发出去了什么」 */
const calls = [];
let script = {};

const stub = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', async () => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const form = Object.fromEntries(new URLSearchParams(body));
    const rec = {
      path: url.pathname,
      token: url.searchParams.get('access_token'),
      form_keys: Object.keys(form),
      form,
      at: Date.now(),
    };
    calls.push(rec);
    const rule = script[url.pathname] || script.default || {};
    if (rule.delayMs) await new Promise((r) => setTimeout(r, rule.delayMs));
    const reply = typeof rule.reply === 'function' ? rule.reply(rec, calls) : rule.reply;
    if (reply === undefined) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error_code: 999, error_msg: 'stub 未配置该路径' }));
      return;
    }
    res.writeHead(rule.status || 200, { 'content-type': 'application/json' });
    res.end(typeof reply === 'string' ? reply : JSON.stringify(reply));
  });
});
await new Promise((r) => stub.listen(0, '127.0.0.1', r));
const STUB_PORT = stub.address().port;
const STUB_BASE = `http://127.0.0.1:${STUB_PORT}`;

// 允许回环出站（v2-test.mjs 也设置了；这里显式确保单独运行时同样成立）
process.env.CCER_ALLOW_LOOPBACK_OUTBOUND = '1';
process.env.CCER_BAIDU_OCR_BASE_URL = STUB_BASE;
// 主密钥用环境变量注入（避免在沙箱里依赖 Windows ACL 初始化）
process.env.CCER_SECRET_KEY = 'test-master-key-for-baidu-ocr-regression';

const ocr = await import('../src/services/baidu-ocr-svc.mjs');
const { audit, get: dbGet } = db;

const AUTH_PATH = '/oauth/2.0/token';
const OCR_PATH = '/rest/2.0/ocr/v1/accurate_basic';
const PARSER_SUBMIT = '/rest/2.0/brain/online/v2/parser/task';

const ADMIN = { id: 'A1', name: 'admin', role: 'admin' };
const VIEWER = { id: 'U1', name: 'viewer', role: 'viewer' };

function resetAll(extra = {}) {
  calls.length = 0;
  script = extra;
  ocr.resetTokenCache();
  ocr.resetBaiduOcrCounters();
}

const creds = (over = {}) => ({
  [AUTH_PATH]: { reply: { access_token: 'tok-1', expires_in: 2592000 } },
  [OCR_PATH]: { reply: { words_result: [{ words: '测试页正文' }], words_result_num: 1 } },
  ...over,
});

/** 确保库内已有可用凭据（多数鉴权用例的前置条件） */
function ensureCreds() {
  if (!ocr.baiduOcrCredential().ok) {
    ocr.saveBaiduOcrConfig(ADMIN, { api_key: 'AK-REGRESSION', secret_key: 'SK-REGRESSION', enabled: true });
  }
  return ocr.baiduOcrPublicConfig();
}

/* ==================================================================== */
/*  1) 纯函数：错误分类与提前刷新窗口                                    */
/* ==================================================================== */

test('错误分类：鉴权/额度/权限/参数/服务端分别归类，不混为一谈', () => {
  assertEqual(ocr.classifyBaiduError({ code: 110 }), 'auth', '110 = token 无效');
  assertEqual(ocr.classifyBaiduError({ code: 111 }), 'auth', '111 = token 过期');
  assertEqual(ocr.classifyBaiduError({ code: 17 }), 'quota', '17 = 日配额超限');
  assertEqual(ocr.classifyBaiduError({ code: 18 }), 'quota', '18 = QPS 超限');
  assertEqual(ocr.classifyBaiduError({ code: 19 }), 'quota', '19 = 总量超限');
  assertEqual(ocr.classifyBaiduError({ code: 6 }), 'permission', '6 = 无权限');
  assertEqual(ocr.classifyBaiduError({ code: 100 }), 'param', '100 = 参数错误');
  assertEqual(ocr.classifyBaiduError({ code: 500 }), 'server');
  assertEqual(ocr.classifyBaiduError({ name: 'invalid_client' }), 'auth',
    '本轮真实踩坑：截图转录的 client_id 返回 invalid_client，必须归为鉴权失败');
  assertEqual(ocr.classifyBaiduError({ name: 'unknown client id' }), 'unknown');
  assertNotIncludes(JSON.stringify(Object.keys(ocr.ERROR_CATEGORY_LABEL)), 'undefined');
});

test('token 提前刷新窗口：expires_in 的 10%，夹在 30s—300s 之间', () => {
  assertEqual(ocr.tokenRefreshAheadMs(2592000), 300000, '30 天有效期 → 提前 300s 上限');
  assertEqual(ocr.tokenRefreshAheadMs(100), 30000, '100s → 下限 30s');
  assertEqual(ocr.tokenRefreshAheadMs(1000), 100000, '1000s → 100s');
});

test('接口基址固定：未显式允许回环出站时，注入的非官方基址被忽略', () => {
  const saved = process.env.CCER_ALLOW_LOOPBACK_OUTBOUND;
  const savedBase = process.env.CCER_BAIDU_OCR_BASE_URL;
  process.env.CCER_BAIDU_OCR_BASE_URL = 'http://10.0.0.9:8080';
  delete process.env.CCER_ALLOW_LOOPBACK_OUTBOUND;
  assertEqual(ocr.ocrBaseUrl(), 'https://aip.baidubce.com', '生产不允许把接口改到私网地址');
  assertEqual(ocr.ocrAllowedDomains().join(','), 'aip.baidubce.com');
  process.env.CCER_ALLOW_LOOPBACK_OUTBOUND = saved;
  process.env.CCER_BAIDU_OCR_BASE_URL = savedBase;
  assertEqual(ocr.ocrBaseUrl(), STUB_BASE, '显式允许回环时才采用本机 stub');
});

/* ==================================================================== */
/*  2) 凭据纪律：保存 / 保留 / 清除 / 绝不回显                            */
/* ==================================================================== */

await testAsync('配置接口只返回「是否已配置」，绝不返回 cipher / 密钥', async () => {
  const saved = ocr.saveBaiduOcrConfig(ADMIN, { api_key: 'AK-PLAINTEXT-测试', secret_key: 'SK-PLAINTEXT-测试', enabled: true });
  assertEqual(saved.ok, true, `保存应成功：${saved.error || ''}`);
  assertEqual(saved.credential_action, 'updated');
  const pub = ocr.baiduOcrPublicConfig();
  const text = JSON.stringify(pub);
  assertEqual(pub.credential_configured, true);
  assertIncludes(text, 'credential_configured');
  for (const forbidden of ['credential_cipher', 'AK-PLAINTEXT', 'SK-PLAINTEXT', 'access_token', 'api_key', 'secret_key']) {
    assertNotIncludes(text, forbidden, `公开配置不得出现 ${forbidden}`);
  }
  // 库里必须是密文，不能有明文
  const row = dbGet("SELECT value FROM system_meta WHERE key='baidu_ocr_config_v1'");
  assertIncludes(row.value, 'v1:', '凭据必须以 v1:<iv>:<tag>:<ct> 形式加密存储');
  assertNotIncludes(row.value, 'AK-PLAINTEXT', '数据库里不得出现明文密钥');
  // 审计同样不得含密钥
  const aud = dbGet("SELECT detail FROM audit_log WHERE action='baidu_ocr.config' ORDER BY at DESC LIMIT 1");
  assertNotIncludes(String(aud.detail), 'AK-PLAINTEXT');
  assertNotIncludes(String(aud.detail), 'credential_cipher');
});

test('保存空密钥 = 保留原凭据；只有显式 clear_credentials 才删除', () => {
  const before = dbGet("SELECT value FROM system_meta WHERE key='baidu_ocr_config_v1'").value;
  const cipherBefore = JSON.parse(before).credential_cipher;
  assert(cipherBefore, '前置条件：已存在加密凭据');
  const kept = ocr.saveBaiduOcrConfig(ADMIN, { api_key: '', secret_key: '' });
  assertEqual(kept.credential_action, 'kept', '空密钥必须表示保留');
  assertEqual(JSON.parse(dbGet("SELECT value FROM system_meta WHERE key='baidu_ocr_config_v1'").value).credential_cipher, cipherBefore,
    '保留时 cipher 必须原样不变');
  assertEqual(ocr.baiduOcrPublicConfig().credential_configured, true);

  // 只填一个字段 → 拒绝（避免把旧 secret 冲掉）
  const half = ocr.saveBaiduOcrConfig(ADMIN, { api_key: 'ONLY-KEY' });
  assertEqual(half.status, 400);
  assertIncludes(half.error, '同时填写');

  const cleared = ocr.saveBaiduOcrConfig(ADMIN, { clear_credentials: true });
  assertEqual(cleared.credential_action, 'cleared');
  assertEqual(JSON.parse(dbGet("SELECT value FROM system_meta WHERE key='baidu_ocr_config_v1'").value).credential_cipher, undefined,
    '显式 clear_credentials 才删除凭据');
  assertEqual(ocr.baiduOcrPublicConfig().credential_configured, false);
  assertIncludes(ocr.baiduOcrPublicConfig().credential_hint, '未配置百度 OCR 凭据');
});

test('普通用户保存配置 → 403（凭据只能管理员维护）', () => {
  const out = ocr.saveBaiduOcrConfig(VIEWER, { api_key: 'x', secret_key: 'y' });
  assertEqual(out.status, 403);
});

test('配置越界值一律 400，不静默回退默认值', () => {
  const cases = [
    [{ request_timeout_ms: 10 }, 'request_timeout_ms'],
    [{ batch_budget_ms: 999999999 }, 'batch_budget_ms'],
    [{ daily_page_limit: 0 }, 'daily_page_limit'],
    [{ max_pages_per_doc: 99999 }, 'max_pages_per_doc'],
    [{ ocr_min_chars: 0 }, 'ocr_min_chars'],
    [{ mode: 'paddle_vl' }, 'mode'],
  ];
  for (const [patch, label] of cases) {
    const out = ocr.saveBaiduOcrConfig(ADMIN, patch);
    assertEqual(out.status, 400, `${label} 越界应 400`);
    assert(out.error, `${label} 应给出原因`);
  }
  // 文档解析未通过能力探测前不得被选为生效模式
  const dp = ocr.saveBaiduOcrConfig(ADMIN, { mode: 'doc_parser' });
  assertEqual(dp.status, 400, 'unsupported 状态下不能把 doc_parser 设为生效模式');
  assertIncludes(dp.error, '未通过真实能力探测');
});

await testAsync('环境变量凭据优先于库内存储，且不写库', async () => {
  ocr.saveBaiduOcrConfig(ADMIN, { clear_credentials: true });
  process.env.BAIDU_OCR_API_KEY = 'ENV-AK';
  process.env.BAIDU_OCR_SECRET_KEY = 'ENV-SK';
  try {
    const cred = ocr.baiduOcrCredential();
    assertEqual(cred.ok, true);
    assertIncludes(cred.source, '环境变量');
    const pub = ocr.baiduOcrPublicConfig();
    assertNotIncludes(JSON.stringify(pub), 'ENV-AK');
    assertNotIncludes(JSON.stringify(pub), 'ENV-SK');
    assertEqual(pub.credential_configured, true);
  } finally {
    delete process.env.BAIDU_OCR_API_KEY;
    delete process.env.BAIDU_OCR_SECRET_KEY;
  }
});

/* ==================================================================== */
/*  3) 鉴权：内存缓存 / 提前刷新 / 110-111 只重试一次                     */
/* ==================================================================== */

await testAsync('未配置凭据时诚实失败，且**不发出任何请求**', async () => {
  resetAll(creds());
  ocr.saveBaiduOcrConfig(ADMIN, { clear_credentials: true });
  const out = await ocr.getAccessToken({ force: true });
  assertEqual(out.ok, false);
  assertEqual(out.error_category, 'not_configured');
  assertIncludes(out.error, '未配置百度 OCR 凭据');
  assertEqual(calls.length, 0, '没有凭据就不该发请求（不猜测密钥）');
});

await testAsync('token 只在内存缓存：第二次调用不再请求鉴权接口（按 expires_in 提前刷新）', async () => {
  resetAll(creds({ [AUTH_PATH]: { reply: { access_token: 'tok-cache', expires_in: 3600 } } }));
  ensureCreds();
  const a = await ocr.getAccessToken({ force: true });
  assertEqual(a.ok, true, `鉴权应成功：${a.error || ''}`);
  assertEqual(a.cached, false);
  const b = await ocr.getAccessToken();
  assertEqual(b.ok, true);
  assertEqual(b.cached, true, '第二次必须命中内存缓存');
  assertEqual(b.token, 'tok-cache');
  const authCalls = calls.filter((c) => c.path === AUTH_PATH).length;
  assertEqual(authCalls, 1, '命中缓存时不得重复请求鉴权接口');
  // 缓存过期时间 = now + (expires_in*1000 - 提前窗口)
  const left = Date.parse(b.expires_at) - Date.now();
  assert(left <= 3600 * 1000 - 30000 + 2000 && left > 3000 * 1000, `缓存有效期应扣除提前刷新窗口，实际剩余 ${left}ms`);
  const st = ocr.tokenCacheState();
  assertEqual(st.cached, true);
  assert(typeof st.expires_at === 'string', '只返回到期时间，不返回 token 本身');
  assertEqual(Object.keys(st).includes('token'), false, 'tokenCacheState 不得返回 token');
});

await testAsync('鉴权失败（invalid_client）：如实回报，不猜测密钥、不声称可用', async () => {
  resetAll(creds({
    [AUTH_PATH]: { reply: { error: 'invalid_client', error_description: 'unknown client id' } },
  }));
  ocr.saveBaiduOcrConfig(ADMIN, { api_key: 'bad-ak', secret_key: 'bad-sk', enabled: true });
  const out = await ocr.getAccessToken({ force: true });
  assertEqual(out.ok, false, `鉴权应失败：${JSON.stringify(out)}`);
  assertEqual(out.error_category, 'auth', `应归为鉴权失败，实际 ${out.error_category}`);
  assertIncludes(out.error, 'invalid_client');
  assertIncludes(out.error, 'unknown client id');
  assertEqual(out.retryable, false, '鉴权失败不重试（凭据错了重试没有意义）');
  assertEqual(calls.filter((c) => c.path === OCR_PATH).length, 0, '鉴权未过不得发起 OCR 调用');
  assertEqual(ocr.baiduOcrReady().ready, false, '鉴权不可用时不得声称可自动补跑');
});

await testAsync('110（token 失效）：**只刷新并重试一次**，第二次成功', async () => {
  let ocrHits = 0;
  resetAll(creds({
    [AUTH_PATH]: { reply: (rec, all) => ({ access_token: `tok-${all.filter((c) => c.path === AUTH_PATH).length}`, expires_in: 3600 }) },
    [OCR_PATH]: {
      reply: () => {
        ocrHits += 1;
        return ocrHits === 1
          ? { error_code: 110, error_msg: 'Access token invalid or no longer valid' }
          : { words_result: [{ words: '刷新后的正文' }] };
      },
    },
  }));
  ocr.resetBaiduOcrCounters();
  const out = await ocr.recognizePage({ pdfBuffer: ocr.buildProbePdf(), pageNum: 1 });
  assertEqual(out.ok, true, `110 后应刷新 token 重试成功：${out.error || ''}`);
  assertIncludes(out.text, '刷新后的正文');
  assertEqual(out.token_refreshed, true);
  assertEqual(ocrHits, 2, 'OCR 调用应恰好 2 次（1 次失败 + 1 次重试）');
  assertEqual(calls.filter((c) => c.path === AUTH_PATH).length, 2, '鉴权应为 2 次（首次 + 刷新）');
  assertEqual(ocr.baiduOcrStats().auth_retry_once, 1);
  assertEqual(ocr.baiduOcrQuotaState().pages_attempted, 2, '配额按实际尝试计数：失败那次也要计');
});

await testAsync('110 持续失败：最多 2 次尝试，绝不无限重试', async () => {
  resetAll(creds({
    [OCR_PATH]: { reply: { error_code: 110, error_msg: 'Access token invalid' } },
  }));
  ensureCreds();
  const out = await ocr.recognizePage({ pdfBuffer: ocr.buildProbePdf(), pageNum: 1 });
  assertEqual(out.ok, false);
  assertEqual(out.error_category, 'auth');
  assertEqual(out.attempts, 2, '只允许「刷新一次 + 重试一次」，共 2 次尝试');
  assertEqual(calls.filter((c) => c.path === OCR_PATH).length, 2);
  assertIncludes(out.error, '已刷新并重试一次，停止重试（不无限重试）');
});

/* ==================================================================== */
/*  4) 额度 / 权限 / 超时 / 参数：分别归类，不互相冒充                    */
/* ==================================================================== */

await testAsync('额度不足（17）：归为 quota，不重试，配额仍按真实尝试计数', async () => {
  resetAll(creds({ [OCR_PATH]: { reply: { error_code: 17, error_msg: 'Open api daily request limit reached' } } }));
  const out = await ocr.recognizePage({ pdfBuffer: ocr.buildProbePdf(), pageNum: 1 });
  assertEqual(out.ok, false);
  assertEqual(out.error_category, 'quota');
  assertEqual(out.attempts, 1, '额度类不做重试');
  assertEqual(ocr.baiduOcrStats().last_category, 'quota');
  assertIncludes(out.error, '17');
});

await testAsync('无权限（6）：归为 permission，不与额度混为一谈', async () => {
  resetAll(creds({ [OCR_PATH]: { reply: { error_code: 6, error_msg: 'No permission to access data' } } }));
  const out = await ocr.recognizePage({ pdfBuffer: ocr.buildProbePdf(), pageNum: 1 });
  assertEqual(out.ok, false);
  assertEqual(out.error_category, 'permission');
  assertEqual(out.attempts, 1);
});

await testAsync('整批 deadline 到点：归为 timeout，未发出的请求不再发送', async () => {
  resetAll(creds({ [OCR_PATH]: { reply: { words_result: [{ words: 'x' }] }, delayMs: 1500 } }));
  const out = await ocr.recognizePage({ pdfBuffer: ocr.buildProbePdf(), pageNum: 1, deadlineAt: Date.now() + 600 });
  assertEqual(out.ok, false);
  assertEqual(out.error_category, 'timeout', `超时应归为 timeout，实际 ${out.error_category}：${out.error}`);
  assertIncludes(out.error, '整批时间上限');
  // 已经过了 deadline → 再调用应当直接不发请求
  const before = calls.length;
  const out2 = await ocr.recognizePage({ pdfBuffer: ocr.buildProbePdf(), pageNum: 1, deadlineAt: Date.now() - 1 });
  assertEqual(out2.error_category, 'timeout');
  assertEqual(calls.length, before, 'deadline 已过时不得再发出请求');
});

await testAsync('单页读取：pdf_file 为 base64、pdf_file_num 从 1 起（不是 0）', async () => {
  resetAll(creds());
  ensureCreds();
  const out = await ocr.recognizePage({ pdfBuffer: ocr.buildProbePdf(), pageNum: 3 });
  assertEqual(out.ok, true, out.error || '');
  const call = calls.find((c) => c.path === OCR_PATH);
  assert(call, '应真的发出 OCR 请求');
  assertEqual(call.form.pdf_file_num, '3', '经典接口页码从 1 起');
  assert(call.form.pdf_file.length > 20, 'pdf_file 应为 base64 内容');
  assertEqual(call.form.pdf_file.slice(0, 5), Buffer.from('%PDF-').toString('base64').slice(0, 5), 'pdf_file 必须是 base64 的 PDF');
  assertEqual(call.token, 'tok-1', 'access_token 走 query 参数');
  assertEqual(call.form_keys.sort().join(','), 'pdf_file,pdf_file_num', '只提交这两个表单字段');
});

await testAsync('参数校验：页码非法直接拒绝，不消耗配额', async () => {
  resetAll(creds());
  const a = await ocr.recognizePage({ pdfBuffer: ocr.buildProbePdf(), pageNum: 0 });
  assertEqual(a.error_category, 'param');
  const b = await ocr.recognizePage({ pdfBuffer: null, pageNum: 1 });
  assertEqual(b.error_category, 'param');
  assertEqual(calls.length, 0);
  assertEqual(ocr.baiduOcrQuotaState().pages_attempted, 0);
});

/* ==================================================================== */
/*  5) 连接测试与文档解析能力探测                                        */
/* ==================================================================== */

await testAsync('真实连接测试：鉴权 + 1 页 OCR 都真实调用，成功才判可用', async () => {
  resetAll(creds());
  ocr.saveBaiduOcrConfig(ADMIN, { api_key: 'AK', secret_key: 'SK', enabled: true, mode: 'accurate_basic' });
  const out = await ocr.testBaiduOcrConnection({ actor: 'test' });
  assertEqual(out.ok, true, `连接测试应通过：${JSON.stringify(out)}`);
  assertEqual(out.status, 'ok');
  assertEqual(out.token.ok, true);
  assertEqual(out.ocr.ok, true);
  assertEqual(calls.filter((c) => c.path === AUTH_PATH).length, 1);
  assertEqual(calls.filter((c) => c.path === OCR_PATH).length, 1, '连接测试恰好 1 页真实调用');
  assertIncludes(JSON.stringify(out), 'credential_configured');
  assertNotIncludes(JSON.stringify(out), 'AK', '不得回显凭据');
});

await testAsync('真实连接测试：鉴权失败时**不伪造可用**，也不发起 OCR 调用', async () => {
  resetAll(creds({ [AUTH_PATH]: { reply: { error: 'invalid_client', error_description: 'unknown client id' } } }));
  ocr.saveBaiduOcrConfig(ADMIN, { api_key: 'AK', secret_key: 'SK', enabled: true });
  const out = await ocr.testBaiduOcrConnection({ actor: 'test' });
  assertEqual(out.ok, false);
  assertEqual(out.status, 'auth_failed');
  assertEqual(out.ocr.skipped, true, '鉴权未过不得继续 OCR');
  assertEqual(calls.filter((c) => c.path === OCR_PATH).length, 0);
  assertIncludes(out.message, '鉴权阶段');
});

await testAsync('文档解析默认 unsupported：不发起调用、不伪实现', async () => {
  resetAll(creds());
  const cfg = ocr.baiduOcrConfig();
  assertEqual(cfg.doc_parser_state, 'unsupported', '本轮默认必须如实标为 unsupported');
  const sub = await ocr.submitDocParserTask({ fileBuffer: ocr.buildProbePdf(), fileName: 'probe.pdf' });
  assertEqual(sub.ok, false);
  assertEqual(sub.error_category, 'unsupported');
  assertIncludes(sub.error, '不伪实现');
  assertEqual(calls.length, 0, 'unsupported 时不得发出请求');
  // 经典高精度仍可用（不受文档解析未支持影响）
  const okPage = await ocr.recognizePage({ pdfBuffer: ocr.buildProbePdf(), pageNum: 1 });
  assertEqual(okPage.ok, true);
});

test('文档解析结果链接保护：必须 HTTPS 百度官方域名，拒绝私网与 IP', () => {
  assertEqual(ocr.validateParserResultUrl('https://bj.bcebos.com/v1/xxx?sig=abc').ok, true);
  assertEqual(ocr.validateParserResultUrl('https://doc-parse.bj.baidubce.com/out/1').ok, true);
  assertEqual(ocr.validateParserResultUrl('http://bj.bcebos.com/x').ok, false, 'HTTP 必须拒绝');
  assertEqual(ocr.validateParserResultUrl('https://evil.example.com/x').ok, false, '非官方域名必须拒绝');
  assertEqual(ocr.validateParserResultUrl('https://127.0.0.1/x').ok, false, 'IP 直连必须拒绝');
  assertEqual(ocr.validateParserResultUrl('https://10.0.0.5/x').ok, false, '私网必须拒绝');
  assertEqual(ocr.validateParserResultUrl('not-a-url').ok, false);
  const red = ocr.redactParserResultUrl('https://bj.bcebos.com/v1/a/b.pdf?signature=SECRET');
  assertNotIncludes(red, 'SECRET', '签名必须脱敏，不得原样输出');
  assertIncludes(red, 'bj.bcebos.com');
  assertIncludes(red, '已隐藏');
});

test('文档解析表单：page_filter 从 0 起，且与经典接口的 1 起不混用', () => {
  const form = new URLSearchParams(ocr.buildDocParserForm({ fileBuffer: Buffer.from('%PDF-'), fileName: 'a.pdf', pages: [0, 2] }));
  assertEqual(form.get('file_name'), 'a.pdf');
  assertEqual(form.get('page_filter'), '0,2');
  assert(form.get('file_data').length > 0);
  assertEqual(ocr.DOC_PARSER_SUBMIT_PATH, '/rest/2.0/brain/online/v2/parser/task');
  assertEqual(ocr.OCR_ACCURATE_PATH, '/rest/2.0/ocr/v1/accurate_basic');
  assertEqual(ocr.OCR_AUTH_PATH, '/oauth/2.0/token');
});

await testAsync('能力探测：无权限时如实标 unsupported，不自动切换付费服务', async () => {
  resetAll(creds({ [PARSER_SUBMIT]: { reply: { error_code: 6, error_msg: 'No permission' } } }));
  ocr.saveBaiduOcrConfig(ADMIN, { api_key: 'AK', secret_key: 'SK', enabled: true, mode: 'accurate_basic' });
  const out = await ocr.probeDocParserCapability({ actor: 'test' });
  assertEqual(out.ok, false);
  assertEqual(out.state, 'unsupported');
  assertEqual(out.error_category, 'permission');
  assertIncludes(out.message, '不自动切换付费服务');
  assertEqual(ocr.baiduOcrConfig().doc_parser_state, 'unsupported');
  assertEqual(ocr.baiduOcrPublicConfig().mode, 'accurate_basic', '探测失败不得把生效模式改成 doc_parser');
});

/* ==================================================================== */
/*  6) 超大 PDF：拆单页或明确失败，绝不静默只处理第一页                    */
/* ==================================================================== */

await testAsync('超过 4MB base64 上限：pdfseparate 不可用时如实失败并说明限制', async () => {
  resetAll(creds());
  ocr.saveBaiduOcrConfig(ADMIN, { api_key: 'AK-REGRESSION', secret_key: 'SK-REGRESSION', enabled: true });
  const big = Buffer.concat([ocr.buildProbePdf(), Buffer.alloc(ocr.OCR_MAX_RAW_PDF_BYTES + 1024, 0x20)]);
  assert(big.length > ocr.OCR_MAX_RAW_PDF_BYTES, '前置条件：确实超过内联上限');
  const saved = process.env.CCER_PDFSEPARATE;
  process.env.CCER_PDFSEPARATE = 'definitely-not-a-real-binary-xyz';
  try {
    const out = await ocr.recognizePage({ pdfBuffer: big, pageNum: 1 });
    assertEqual(out.ok, false);
    assertEqual(out.error_category, 'limit', `应为 limit，实际 ${out.error_category}：${out.error}`);
    assertEqual(out.oversized, true);
    assertIncludes(out.error, '拒绝静默只处理第一页');
    assertEqual(calls.filter((c) => c.path === OCR_PATH).length, 0, '拆不出单页就不该提交整份 PDF');
  } finally {
    if (saved === undefined) delete process.env.CCER_PDFSEPARATE;
    else process.env.CCER_PDFSEPARATE = saved;
  }
});

/* ==================================================================== */
/*  7) 配额耗尽：不发出请求、不写任何结果                                */
/* ==================================================================== */

await testAsync('当日页数配额耗尽：直接拒绝，不发请求（不留残留写）', async () => {
  resetAll(creds());
  ocr.saveBaiduOcrConfig(ADMIN, { api_key: 'AK-REGRESSION', secret_key: 'SK-REGRESSION', enabled: true, daily_page_limit: 2 });
  const a = await ocr.recognizePage({ pdfBuffer: ocr.buildProbePdf(), pageNum: 1 });
  const b = await ocr.recognizePage({ pdfBuffer: ocr.buildProbePdf(), pageNum: 2 });
  assertEqual(a.ok, true, a.error || '');
  assertEqual(b.ok, true, b.error || '');
  assertEqual(ocr.baiduOcrQuotaState().pages_attempted, 2);
  const before = calls.filter((c) => c.path === OCR_PATH).length;
  const c = await ocr.recognizePage({ pdfBuffer: ocr.buildProbePdf(), pageNum: 3 });
  assertEqual(c.ok, false);
  assertEqual(c.error_category, 'quota');
  assertEqual(c.attempts, 0, '配额耗尽时不得发出请求');
  assertIncludes(c.error, '留待次日');
  assertEqual(calls.filter((x) => x.path === OCR_PATH).length, before, '配额耗尽后请求数不得增加');
  const ready = ocr.baiduOcrReady();
  assertEqual(ready.ready, false);
  assertIncludes(ready.reason, '配额');
  // 恢复配额，避免影响后续用例
  ocr.saveBaiduOcrConfig(ADMIN, { daily_page_limit: 500 });
});

/* ==================================================================== */
/*  8) HTTP 路由：未登录 401 / 普通用户 403                              */
/* ==================================================================== */

process.env.CCER_AUTH_MODE = 'session';
const { server } = await import('../src/server.mjs');
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;

async function call(path, { method = 'GET', body = null, token = null } = {}) {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text.slice(0, 200) }; }
  return { status: res.status, json };
}

let adminToken = null;
let viewerToken = null;
await testAsync('准备：管理员与普通用户登录', async () => {
  const a = await call('/api/auth/login', { method: 'POST', body: { user_id: 'user-admin', password: 'admin-demo-2026' } });
  assertEqual(a.status, 200, `管理员登录失败：${JSON.stringify(a.json)}`);
  adminToken = a.json.token;
  const v = await call('/api/auth/login', { method: 'POST', body: { user_id: 'user-researcher', password: 'researcher-demo-2026' } });
  if (v.status === 200) viewerToken = v.json.token;
  else {
    const any = db.all("SELECT id FROM app_user WHERE role!='admin' AND status='active' LIMIT 1")[0];
    const setPw = await import('../src/services/auth-svc.mjs');
    setPw.setPassword(any.id, 'viewer-demo-2026', { actor: 'test' });
    const w = await call('/api/auth/login', { method: 'POST', body: { user_id: any.id, password: 'viewer-demo-2026' } });
    assertEqual(w.status, 200, `普通用户登录失败：${JSON.stringify(w.json)}`);
    viewerToken = w.json.token;
  }
});

await testAsync('未登录访问 /api/v2/admin/ocr/* → 401', async () => {
  for (const p of ['/api/v2/admin/ocr/config', '/api/v2/admin/ocr/gaps', '/api/v2/admin/ocr/status', '/api/v2/admin/ocr/jobs']) {
    const out = await call(p);
    assertEqual(out.status, 401, `${p} 未登录应 401，实际 ${out.status}`);
  }
  const post = await call('/api/v2/admin/ocr/backfill', { method: 'POST', body: {} });
  assertEqual(post.status, 401);
});

await testAsync('普通用户访问 /api/v2/admin/ocr/* → 403（读与写都拒绝）', async () => {
  for (const p of ['/api/v2/admin/ocr/config', '/api/v2/admin/ocr/gaps', '/api/v2/admin/ocr/status']) {
    const out = await call(p, { token: viewerToken });
    assertEqual(out.status, 403, `${p} 普通用户应 403，实际 ${out.status}`);
  }
  for (const p of ['/api/v2/admin/ocr/config', '/api/v2/admin/ocr/test', '/api/v2/admin/ocr/backfill', '/api/v2/admin/ocr/reparse', '/api/v2/admin/ocr/probe-parser']) {
    const out = await call(p, { method: 'POST', body: {}, token: viewerToken });
    assertEqual(out.status, 403, `${p} 普通用户写操作应 403，实际 ${out.status}`);
  }
});

await testAsync('管理员读取配置：接口返回里没有任何密钥/密文字段', async () => {
  resetAll(creds());
  ocr.saveBaiduOcrConfig(ADMIN, { api_key: 'AK-HTTP', secret_key: 'SK-HTTP', enabled: true });
  const out = await call('/api/v2/admin/ocr/config', { token: adminToken });
  assertEqual(out.status, 200, JSON.stringify(out.json).slice(0, 200));
  const text = JSON.stringify(out.json);
  assertIncludes(text, 'credential_configured');
  for (const forbidden of ['credential_cipher', 'AK-HTTP', 'SK-HTTP', 'access_token']) {
    assertNotIncludes(text, forbidden, `HTTP 响应不得出现 ${forbidden}`);
  }
  assertEqual(out.json.config?.no_such, undefined, '不应回显未知字段');
  assert(Array.isArray(out.json.modes) && out.json.modes.length >= 3, '应返回三种模式说明');
});

await testAsync('管理员触发补跑 → HTTP 202 + task_id（异步受理，不阻塞）', async () => {
  const out = await call('/api/v2/admin/ocr/backfill', { method: 'POST', body: {}, token: adminToken });
  assertEqual(out.status, 202, `应返回 202，实际 ${out.status}：${JSON.stringify(out.json).slice(0, 200)}`);
  assert(out.json.task_id, '应返回 task_id');
  assertEqual(out.json.accepted, true);
  assert(['queued', 'running'].includes(out.json.status), `受理时状态应为 queued/running，实际 ${out.json.status}`);
  // 轮询接口可查到该 task_id
  const poll = await call(`/api/v2/admin/ocr/jobs?task_id=${encodeURIComponent(out.json.task_id)}`, { token: adminToken });
  assertEqual(poll.status, 200);
  assert(poll.json.task, '应能按 task_id 查到任务');
  assertEqual(poll.json.task.task_id, out.json.task_id);
});

await testAsync('跨站写请求被拒绝（CSRF，Cookie 会话下）', async () => {
  const login = await fetch(`http://127.0.0.1:${PORT}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ user_id: 'user-admin', password: 'admin-demo-2026' }),
  });
  const cookie = login.headers.get('set-cookie');
  assert(cookie, '登录应下发 Cookie 会话');
  const crossSite = await fetch(`http://127.0.0.1:${PORT}/api/v2/admin/ocr/backfill`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: String(cookie).split(';')[0], origin: 'https://evil.example.com' },
    body: '{}',
  });
  assertEqual(crossSite.status, 403, 'Cookie 会话下跨站写请求必须 403');
  const sameSite = await fetch(`http://127.0.0.1:${PORT}/api/v2/admin/ocr/status`, {
    headers: { cookie: String(cookie).split(';')[0], origin: `http://127.0.0.1:${PORT}` },
  });
  assertEqual(sameSite.status, 200, '同源 Cookie 请求应放行');
});

/* ==================================================================== */

stub.close();
server.close();
finish('39-v2-baidu-ocr.test.mjs');
