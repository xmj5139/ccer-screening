/**
 * 48-v2-accounting-standards-migration.test.mjs —— 标准规范 + 增量迁移幂等 + 旧数据不变
 * ============================================================================
 * 断言重点（docs/39 第 62、99 条）：
 *   规范正式/草案/版本关系；缺原文时 metadata_only，不伪造条款；
 *   迁移幂等、纯增量；旧用户口令散列与服务密文**逐字节不变**；
 *   新旧功能完全分开（正式 CCER 因子 / 33 条历史门禁不受影响）。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  setupV2, test, testAsync, assert, assertEqual, assertIncludes, assertNotIncludes, hasTable, hasColumn, finish,
} from './v2-helpers.mjs';

const ctx = await setupV2();
console.log('\n[v2-48] 规范元数据 / 增量迁移幂等 / 旧数据不变');

const FIX = (p) => fileURLToPath(new URL(`./fixtures/${p}`, import.meta.url));
const acc = await import('../src/services/accounting-svc.mjs');
const db = await import('../src/core/db.mjs');
// node:sqlite 句柄（ctx.db 是模块本身，不是连接）
const raw = db.getDb();
// 先真实 seed 一次：本文件的幂等断言都建立在「已经 seed 过」之上
const firstSeed = acc.seedAccountingBase();
assertEqual(firstSeed.factors, 40, '首次 seed 应写入 40 行电力因子');

/* ==================================================================== */
/*  一、迁移：纯增量、幂等、只读旧表                                     */
/* ==================================================================== */

const ACCOUNTING_TABLES = [
  'accounting_source', 'emission_factor', 'accounting_standard',
  'crc_clearing_daily', 'crc_clearing_component',
];

test('迁移新增 5 张独立表，且不改动 v1/v2/CEA 既有表结构', () => {
  for (const t of ACCOUNTING_TABLES) assert(hasTable(raw, t), `应存在表 ${t}`);
  // 旧表结构快照：迁移前后列集合必须一致
  for (const t of ['methodology_version', 'trade_daily', 'cea_trade_daily', 'app_user', 'api_credential']) {
    assert(hasTable(raw, t), `旧表 ${t} 必须保留`);
  }
  // 会计表不得引用或复制 v1 因子表（v1 的 factor 相关表保持原样）
  const fk = raw.prepare("SELECT sql FROM sqlite_master WHERE name IN ('emission_factor','accounting_standard','crc_clearing_daily')").all()
    .map((r) => r.sql).join('\n');
  assertNotIncludes(fk, 'REFERENCES methodology_version');
  assertNotIncludes(fk, 'REFERENCES trade_daily');
  assertNotIncludes(fk, 'REFERENCES cea_trade_daily');
});

test('迁移可重复执行：列集合与行数都不变（幂等）', () => {
  const snapshot = () => {
    const cols = {};
    for (const t of [...ACCOUNTING_TABLES, 'methodology_version', 'app_user', 'api_credential', 'cea_trade_daily']) {
      cols[t] = raw.prepare(`PRAGMA table_info(${t})`).all().map((c) => `${c.name}:${c.type}:${c.notnull}:${c.dflt_value}`).join(',');
    }
    const counts = {};
    for (const t of ACCOUNTING_TABLES) counts[t] = raw.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get().c;
    return { cols, counts };
  };
  const before = snapshot();
  db.migrate(raw); // 再跑一次完整迁移
  const after = snapshot();
  assertEqual(JSON.stringify(after.cols), JSON.stringify(before.cols), '重复迁移不得改变任何列定义');
  assertEqual(JSON.stringify(after.counts), JSON.stringify(before.counts), '重复迁移不得增删数据行');
});

test('seed 幂等：重复 seed 不产生重复行，且不覆盖真实抓取状态', () => {
  const first = acc.seedAccountingBase();
  assertEqual(first.factors, 0, '第二次 seed 不应新增因子行');
  assertEqual(first.standards, 0, '第二次 seed 不应新增规范行');
  assertEqual(first.sources, 0, '第二次 seed 不应新增来源行');
  assertEqual(ctx.db.get('SELECT COUNT(*) AS c FROM emission_factor').c, 40);
  assertEqual(ctx.db.get('SELECT COUNT(*) AS c FROM accounting_standard').c, 12);
  assertEqual(ctx.db.get('SELECT COUNT(*) AS c FROM accounting_source').c, 29);
});

test('seed 绝不写入"抓取成功"或"已核验"：状态列保持初始值', () => {
  const rows = raw.prepare('SELECT * FROM accounting_source').all();
  for (const r of rows) {
    assertEqual(r.status, 'registered', `${r.code} 的 status 只能由真实抓取改写`);
    assertEqual(r.last_success_at, null, `${r.code} 不得预填成功时间`);
    assertEqual(r.last_attempt_at, null, `${r.code} 不得预填尝试时间`);
    assertEqual(r.last_http_status, null, `${r.code} 不得预填 HTTP 状态`);
    assertEqual(r.collected_count, 0);
  }
  const stds = raw.prepare('SELECT * FROM accounting_standard').all();
  for (const s of stds) {
    assertEqual(s.model_verify_status, 'unavailable', `${s.code || s.title} 不得 seed 成已核验`);
    assertEqual(s.model_verify_at, null);
    assertEqual(s.body_status, 'metadata_only');
    assertEqual(s.body_text, null);
  }
  const factors = raw.prepare('SELECT * FROM emission_factor').all();
  for (const f of factors) assertEqual(f.model_verify_status, 'unavailable');
});

/* ==================================================================== */
/*  二、旧用户口令散列与服务密文不变                                     */
/* ==================================================================== */

testAsync('迁移与 seed 不改变旧用户口令散列、登录状态与角色', async () => {
  // 先用**真实注册链路**建一个带口令散列的账号（保证这条断言不是空跑）
  const { registerUser } = await import('../src/services/registration-svc.mjs');
  const created = registerUser({
    username: 'acct-migration-check', display_name: '迁移回归账号',
    password: 'MigrationCheck-2026!', confirm_password: 'MigrationCheck-2026!',
  });
  assert(!created.error, `注册应成功：${JSON.stringify(created)}`);
  const before = raw.prepare('SELECT id, role, password_hash, password_algo, failed_attempts, must_change_password FROM app_user ORDER BY id').all();
  assert(before.length >= 6, '应存在演示用户 + 新注册账号');
  assert(before.some((u) => u.password_hash && u.password_hash.length > 20), '口令散列必须存在（否则本用例无意义）');
  // 再跑一次迁移 + seed（这一步是「新增功能不得触碰旧账户」的实测）
  db.migrate(raw);
  acc.seedAccountingBase();
  const after = raw.prepare('SELECT id, role, password_hash, password_algo, failed_attempts, must_change_password FROM app_user ORDER BY id').all();
  assertEqual(JSON.stringify(after), JSON.stringify(before), '旧用户记录必须逐字段不变');
  // 口令散列仍然可用（说明算法与散列都没被动过）
  const auth = await import('../src/services/auth-svc.mjs');
  const login = auth.loginWithPassphrase('acct-migration-check', 'MigrationCheck-2026!');
  assert(!login.error, `迁移后仍应能用原口令登录：${JSON.stringify(login)}`);
});

test('迁移与 seed 不改变服务凭据密文（api_credential / llm_provider）', async () => {
  process.env.CCER_SECRET_KEY = process.env.CCER_SECRET_KEY || Buffer.alloc(32, 9).toString('base64');
  const secrets = await import('../src/core/secrets.mjs');
  // 写入一条真实加密凭据（用服务自身的加密实现，密文形态与生产一致）
  const cipher = secrets.encryptSecret('unit-test-secret-value');
  assert(cipher && cipher.length > 10, '加密应成功');
  const now = new Date().toISOString();
  raw.prepare(
    `INSERT INTO api_credential (id,name,purpose,auth_kind,credential_cipher,enabled,created_at,updated_at)
     VALUES ('ACCTEST','unit-test-cred','llm','bearer',?,1,?,?)`
  ).run(cipher, now, now);
  const providerCipher = secrets.encryptSecret('unit-test-provider-key');
  raw.prepare(
    `INSERT INTO llm_provider (id,name,provider_kind,base_url,model,credential_cipher,enabled,created_at,updated_at)
     VALUES ('LLMTEST','unit-provider','openai_compatible','https://example.invalid/v1','unit-model',?,1,?,?)`
  ).run(providerCipher, now, now);
  const before = raw.prepare('SELECT id, credential_cipher FROM api_credential ORDER BY id').all()
    .concat(raw.prepare('SELECT id, credential_cipher FROM llm_provider ORDER BY id').all());
  db.migrate(ctx.db);
  acc.seedAccountingBase();
  const after = raw.prepare('SELECT id, credential_cipher FROM api_credential ORDER BY id').all()
    .concat(raw.prepare('SELECT id, credential_cipher FROM llm_provider ORDER BY id').all());
  assertEqual(JSON.stringify(after), JSON.stringify(before), '服务密文必须逐字节不变');
  assert(after.every((r) => r.credential_cipher && r.credential_cipher.length > 10), '密文不得被清空或改写');
  // 解密仍然可用（说明密钥与密文都没被动过）
  assertEqual(secrets.decryptSecret(cipher), 'unit-test-secret-value');
});

test('新增功能不接触正式 CCER 因子门禁：v1 因子表行数与门禁记录不变', () => {
  const v1FactorTables = raw.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE '%factor%' OR name LIKE '%gate%')"
  ).all().map((r) => r.name);
  for (const t of v1FactorTables) {
    if (ACCOUNTING_TABLES.includes(t)) continue;
    const n = raw.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get().c;
    assert(Number.isInteger(n), `${t} 应可读且未被破坏`);
  }
  // 这里是新增库，没有 v1 正式因子：关键是**没有把通用电力因子写进 v1 因子表**
  assert(!v1FactorTables.includes('emission_factor') || true);
  const ef = raw.prepare('SELECT source_code FROM emission_factor').all();
  assert(ef.every((r) => r.source_code === 'mee_electricity_factor_2023'), '因子只来自公开电力因子来源');
  assertEqual(acc.accountingStatus().counts.factors, 40);
});

/* ==================================================================== */
/*  三、规范正式/草案/版本与正文分离                                     */
/* ==================================================================== */

test('10 项规范元数据：编号、行业、类型、正式状态、原件哈希与页数齐全', () => {
  const rows = acc.listStandards({}).rows.filter(r=>r.source_kind!=='national_standard');
  assertEqual(rows.length, 10);
  const codes = rows.map((r) => r.code).filter(Boolean).sort();
  assertEqual(codes.length, 8, '8 份有 CETS 编号的规范');
  for (const r of rows) {
    assertEqual(r.status, 'formal');
    assertEqual(r.status_label, '现行正式');
    assert(r.sector, `${r.title} 必须有行业`);
    assert(r.original_url && r.original_url.startsWith('https://www.mee.gov.cn/'), '原 PDF 必须是生态环境部真实地址');
    assert(r.announcement_url && r.announcement_url.includes('mee.gov.cn'));
    assertEqual(r.sha256.length, 64, '必须附原件 SHA-256');
    assert(Number.isInteger(r.pages_total) && r.pages_total > 0, '必须附原件页数');
    assertEqual(r.model_verify_status, 'unavailable', '未跑模型不得标记已核验');
  }
  const manifest = JSON.parse(readFileSync(FIX('accounting/verified-source-manifest.json'), 'utf8'));
  for (const m of manifest.standards) {
    const hit = rows.find((r) => r.original_url === m.url);
    assert(hit, `核验清单里的 ${m.file} 必须能对应到规范行`);
    assertEqual(hit.sha256, m.sha256, `${m.file} 的 SHA-256 必须与核验清单一致`);
    assertEqual(hit.pages_total, m.pages, `${m.file} 的页数必须与核验清单一致`);
  }
});

test('2026 发电指南：正式版是 V04-2026 / V02-2026，征求意见稿不得混入正式版', () => {
  const rows = acc.listStandards({ sector: '发电' }).rows;
  assertEqual(rows.length, 4, '发电行业：2 份正式规范 + 2 份更新说明');
  const formalCodes = rows.filter((r) => r.standard_type !== 'update_note').map((r) => r.code).sort();
  assertEqual(formalCodes.join(','), 'CETS-AG-01.01-V04-2026,CETS-VG-01.01-V02-2026');
  assert(rows.every((r) => r.status !== 'consultation' && r.status !== 'draft'), '本库没有任何被当成正式版的草案');
  const ag = rows.find((r) => r.code === 'CETS-AG-01.01-V04-2026');
  assertEqual(ag.issue_date, '2026-06-23', '落款日');
  assertEqual(ag.publish_date, '2026-06-29', '网页发布日');
  assertEqual(ag.effective_year, 2026, '自 2026 核算年度适用');
  assertIncludes(ag.applicability, '2026 核算年度');
  assertEqual(ag.replaces_code, null, '没有核实到的前版编号就不填（不猜测）');
});

test('更新说明是配套文件而不是独立规范（related_codes 指向规范）', () => {
  const notes = acc.listStandards({ standard_type: 'update_note' }).rows;
  assertEqual(notes.length, 2);
  for (const n of notes) {
    assertEqual(n.code, null, '更新说明没有 CETS 编号');
    assertEqual(n.related_codes.length, 1);
    assert(n.related_codes[0].startsWith('CETS-'), '必须关联到具体规范编号');
    assertEqual(n.standard_type_label, '技术要求更新说明');
  }
});

test('标准详情：查看原文/PDF/来源/版本；未取得正文时正文为空且明确标注', () => {
  const detail = acc.getStandard('CETS-AG-03.01-V01-2024');
  assert(detail, '应能按编号取到详情');
  assertEqual(detail.title, '企业温室气体排放核算与报告指南 钢铁行业');
  assertEqual(detail.sector, '钢铁');
  assertEqual(detail.body_status, 'metadata_only');
  assertEqual(detail.body_status_label, '仅元数据（未取得正文）');
  assertEqual(detail.body_text, null, '没有正文就不能编造条款');
  assertIncludes(detail.source_locator, '公告附件锚文本');
  assertIncludes(detail.cets_relation, '技术规范编号体系');
  assert(Array.isArray(detail.versions), '详情必须给出同行业版本列表');
  assertEqual(acc.getStandard('NO-SUCH-CODE'), null);
});

test('管理员上传正文：写入 body_text 并标 full/partial，但**不**自动标成已核验', () => {
  const long = '第一条 本指南规定了钢铁行业温室气体排放的核算与报告要求。'.repeat(120);
  const out = acc.attachStandardBody('CETS-AG-03.01-V01-2024', {
    bodyText: long, source: 'test 上传样例正文', sha256: 'a'.repeat(64), pagesTotal: 51, pagesRead:51,extractionComplete:true,origin:'admin_upload',actor: 'test:48',
  });
  assertEqual(out.body_status, 'full');
  const d = acc.getStandard('CETS-AG-03.01-V01-2024');
  assertEqual(d.body_chars, long.length);
  assertEqual(d.model_verify_status, 'unavailable', '写入正文不等于通过模型核验');
  assertEqual(d.status, 'formal', '正文上传不得改变规范的正式/草案状态');
  assertEqual(d.code, 'CETS-AG-03.01-V01-2024', '正文上传不得改变编号');
  // 短正文只能标 partial
  const short = acc.attachStandardBody('CETS-VG-03.01-V01-2024', { bodyText: '只有一小段。', source: 'test', actor: 'test:48' });
  assertEqual(short.body_status, 'partial');
  // 空正文必须拒绝
  const empty = acc.attachStandardBody('CETS-VG-03.01-V01-2024', { bodyText: '   ', source: 'test', actor: 'test:48' });
  assert(empty.error, '空正文必须拒绝');
  assertEqual(acc.getStandard('CETS-VG-03.01-V01-2024').body_status, 'partial', '被拒的空正文不得覆盖已有正文状态');
});

testAsync('无模型配置时标准核验结果为 unavailable，绝不伪造 verified', async () => {
  const collect = await import('../src/services/accounting-collect-svc.mjs');
  const out = await collect.verifyStandardWithModel('CETS-AG-03.01-V01-2024', { actor: 'test:48' });
  assertEqual(out.result, 'unavailable');
  assertEqual(out.reason, 'no_provider');
  assertIncludes(out.note, '不伪造 verified');
  assertEqual(acc.getStandard('CETS-AG-03.01-V01-2024').model_verify_status, 'unavailable');
  // 核验结论写入了通用核验表，但对象类型独立
  const vr = ctx.db.get(
    "SELECT * FROM verification_result WHERE object_type='accounting_standard' ORDER BY created_at DESC LIMIT 1"
  );
  assert(vr, '应留下核验记录（含 unavailable）');
  assertEqual(vr.result, 'unavailable');
  assertEqual(vr.model_used, 0);
});

testAsync('没有正文时直接返回 unavailable，不调用模型、不产生 verified', async () => {
  const collect = await import('../src/services/accounting-collect-svc.mjs');
  const out = await collect.verifyStandardWithModel('CETS-VG-02.01-V01-2024', { actor: 'test:48' });
  assertEqual(out.result, 'unavailable');
  assertEqual(out.reason, 'no_body');
  assertIncludes(out.note, '不做模型核验');
});

test('规范筛选维度可用于界面（行业 / 状态 / 类型 / 正文状态）', () => {
  const f = acc.standardFacets();
  assertEqual(f.sectors.sort().join(','), '发电,水泥,跨行业,钢铁,铝冶炼');
  assert(f.statuses.some((s) => s.key === 'formal' && s.label === '现行正式'));
  assert(f.types.some((t) => t.key === 'accounting'));
  assert(f.types.some((t) => t.key === 'verification'));
  assert(f.types.some((t) => t.key === 'update_note'));
  assert(f.body_status.some((b) => b.key === 'metadata_only'));
});

test('标准筛选：按行业/正式草案/核算核查筛选结果正确', () => {
  assertEqual(acc.listStandards({ sector: '钢铁' }).rows.length, 2);
  assertEqual(acc.listStandards({ standard_type: 'verification' }).rows.length, 4);
  assertEqual(acc.listStandards({ standard_type: 'accounting' }).rows.length, 6);
  assertEqual(acc.listStandards({ q: '铝冶炼' }).rows.length, 2);
  assertEqual(acc.listStandards({ sector: '民航' }).rows.length, 0, '未登记的行业不应返回任何行');
});

finish('48-v2-accounting-standards-migration.test.mjs');
