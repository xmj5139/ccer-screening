/**
 * 34-v2-cea-phaseB.test.mjs —— CEA 阶段B 后端尾项回归
 * ============================================================================
 * 覆盖 docs/34-CEA阶段B交付任务.md「必须处理的后端尾项」1—8 与参数校验：
 *   1. dir=2 卖出（用**真实 69 条样本**复验，不用改写夹具）
 *   2. callVerifyModel 真正取 min(provider, caller, 60000)（慢响应桩验证）
 *   3. 正式休市公告优先于机器辅助列表（异常独立告警、保留原文、不生成人工复核、不判数值不真实）
 *   4. API 参数统一校验（真实日期 / 倒置范围 / limit / offset / year / dataset / format）
 *   5. CEA 管理员 PDF 上传（cea_document 目标、普通用户 403、扫描件不伪造正文）
 *   6. 真实历史价格层（≥120 点、快照来源、参考数量不当成交量、无成交额/均价）
 *   7. 研报/动态第一来源分级与元数据纪律（未标注保持 null，转载站显式标注）
 *   8. 附件目录统一到 data/official-originals/cea
 * 另含：共享总 deadline（子步骤不再各给 120 秒）。
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  setupV2, finish, test, testAsync, assert, assertEqual, assertIncludes,
} from './v2-helpers.mjs';

const ctx = await setupV2();
const { db } = ctx;
const cea = await import('../src/services/cea-svc.mjs');
const collect = await import('../src/services/cea-collect-svc.mjs');
const parse = await import('../src/services/cea-parse.mjs');
const jsonSvc = await import('../src/services/cea-json.mjs');
const params = await import('../src/services/cea-api-params.mjs');
const upload = await import('../src/services/document-upload-svc.mjs');
const verify = await import('../src/services/verification-svc.mjs');

const ROOT = process.cwd();
// 公开无凭据夹具随代码包提供（root 已准备 test/fixtures/cea），完整回归不依赖 data/backups 运行期目录
const SAMPLE_DIR = join(ROOT, 'test', 'fixtures', 'cea');

console.log('\n[v2-34] CEA 阶段B 后端尾项（方向 / 时限 / 日历 / 参数 / 上传 / 价格层 / 研报）');

// 核验模型相关用例自行控制 provider，先禁用所有模型，避免任何外发请求
const savedProviders = db.all('SELECT id, enabled, use_content_verify FROM llm_provider');
db.run('UPDATE llm_provider SET enabled=0, use_content_verify=0');

/* ==================================================================== */
/*  尾项1：真实意向方向（dir=2 卖出）                                    */
/* ==================================================================== */

test('尾项1 tradeIntent：真实 69 条样本 dir 仅 1/2，映射为 47 买入 / 22 卖出 / 0 unknown', () => {
  const file = join(SAMPLE_DIR, 'tradeIntent.json');
  assert(existsSync(file), `缺少真实样本 ${file}`);
  const raw = readFileSync(file, 'utf8');
  const payload = JSON.parse(raw);
  assertEqual(payload.length, 69, '真实样本应为 69 条');
  const dirs = [...new Set(payload.map((r) => r.dir))].sort();
  assertEqual(JSON.stringify(dirs), JSON.stringify([1, 2]), '真实样本 dir 唯一取值应为 1/2');
  const out = jsonSvc.parseTradeIntents(raw, { sourceUrl: 'https://shyx.cneeex.com/assets/json/tradeIntent.json' });
  assertEqual(out.ok, true);
  assertEqual(out.rows.length, 69);
  const buy = out.rows.filter((r) => r.direction === 'buy').length;
  const sell = out.rows.filter((r) => r.direction === 'sell').length;
  const unknown = out.rows.filter((r) => r.direction === 'unknown').length;
  assertEqual(buy, 47, 'dir==1 应为 47 条买入');
  assertEqual(sell, 22, 'dir==2 应为 22 条卖出');
  assertEqual(unknown, 0, '不得再有 unknown（旧实现把 dir=2 判为 unknown）');
  assertEqual(out.unknown_direction.length, 0);
  assertEqual(out.rows.every((r) => r.price === null), true, '未公开价格必须为 null');
  assertEqual(out.rows.every((r) => r.participant === null), true, '未公开主体必须为 null');
  assertIncludes(out.note, '1=买入、2=卖出');
});

await testAsync('尾项1 复采：意向写入后 buy/sell 计数与真实样本一致，且不进入成交表', async () => {
  cea.seedCeaBaseData({ actor: 'test' });
  const file = join(SAMPLE_DIR, 'tradeIntent.json');
  const parsed = jsonSvc.parseTradeIntents(readFileSync(file, 'utf8'), { sourceUrl: 'https://shyx.cneeex.com/assets/json/tradeIntent.json' });
  let created = 0;
  for (const r of parsed.rows) {
    const res = cea.upsertCeaIntention({ ...r, source_code: 'cea_json_trade_intent' }, { actor: 'test' });
    if (res.created) created += 1;
  }
  assertEqual(created, 69);
  const counts = db.all("SELECT direction, COUNT(*) c FROM cea_intention GROUP BY direction ORDER BY direction");
  assertEqual(JSON.stringify(counts), JSON.stringify([{ direction: 'buy', c: 47 }, { direction: 'sell', c: 22 }]));
  assertEqual(db.get("SELECT COUNT(*) c FROM cea_intention WHERE price IS NOT NULL")?.c, 0);
  // 意向绝不计入成交
  assertEqual(db.get('SELECT COUNT(*) c FROM cea_trade_daily')?.c, 0, '临时库不应因意向写入而产生成交行');
});

/* ==================================================================== */
/*  尾项2：模型调用时限真正取最小值                                      */
/* ==================================================================== */

await testAsync('尾项2 callVerifyModel：provider 时限不得覆盖调用方的更短 deadline（慢响应桩实测中止）', async () => {
  const realFetch = globalThis.fetch;
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO llm_provider (id,name,provider_kind,base_url,model,timeout_ms,max_calls_per_day,enabled,
       use_content_verify,allowed_domains,created_at,updated_at)
     VALUES ('LLM-TEST-TIMEOUT','慢响应桩','ollama','http://localhost:11434/v1','stub',45000,50,1,1,'[]',?,?)
     ON CONFLICT(id) DO UPDATE SET timeout_ms=45000, enabled=1, use_content_verify=1`,
    [now, now]
  );
  const provider = db.get("SELECT * FROM llm_provider WHERE id='LLM-TEST-TIMEOUT'");
  let aborted = false;
  let sawSignal = false;
  globalThis.fetch = async (url, opts = {}) => {
    sawSignal = !!opts.signal;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => resolve(new Response(JSON.stringify({ message: { content: '{}' } }), { status: 200, headers: { 'content-type': 'application/json' } })), 3000);
      if (opts.signal) {
        opts.signal.addEventListener('abort', () => {
          aborted = true;
          clearTimeout(t);
          const e = new Error('The operation was aborted due to timeout');
          e.name = 'TimeoutError';
          reject(e);
        });
      }
    });
  };
  try {
    // provider.timeout_ms = 45000，调用方只给 1200ms → 生效时限必须是 1200ms
    const t0 = Date.now();
    const out = await verify.callVerifyModel({ provider, prompt: '慢响应桩测试', timeoutMs: 1200, purpose: 'test_timeout', actor: 'test' });
    const elapsed = Date.now() - t0;
    assertEqual(sawSignal, true, '必须带 AbortSignal');
    assertEqual(out.ok, false);
    assertEqual(out.reason, 'timeout', `应因调用方时限中止，实际 ${JSON.stringify(out.reason)} ${out.detail || ''}`);
    assert(aborted, '桩应观察到 abort');
    assert(elapsed < 4000, `应在调用方时限附近中止（实测 ${elapsed}ms），不得等到 provider 的 45 秒`);
    assertEqual(out.effective_timeout_ms, 1200, '生效时限应为调用方的 1200ms');
    assertEqual(out.provider_timeout_ms, 45000);
    assertEqual(out.caller_timeout_ms, 1200);

    // 调用方给得更宽时，仍受 provider 配置限制
    const out2 = await verify.callVerifyModel({ provider, prompt: 'x', timeoutMs: 60000, purpose: 'test_timeout', actor: 'test' });
    assertEqual(out2.effective_timeout_ms, 45000, 'provider 时限更短时取 provider');

    // 两者都超过硬上限时取 60000
    const out3 = await verify.callVerifyModel({ provider: { ...provider, timeout_ms: 900000 }, prompt: 'x', timeoutMs: 900000, purpose: 'test_timeout', actor: 'test' });
    assertEqual(out3.effective_timeout_ms, 60000, '硬上限 60000');
  } finally {
    globalThis.fetch = realFetch;
    // llm_call_log.provider_id 有外键：先删调用日志再删桩 provider
    db.run("DELETE FROM llm_call_log WHERE provider_id='LLM-TEST-TIMEOUT'");
    db.run("DELETE FROM llm_provider WHERE id='LLM-TEST-TIMEOUT'");
  }
});

await testAsync('尾项2 共享总预算：子步骤不再各自重置 120 秒（deadline 已过即刻收尾）', async () => {
  const admin = { role: 'admin', name: 'test-admin' };
  collect.saveCeaCollectConfig(admin, { enabled: true, batch_budget_ms: 120000 });
  const daily = await collect.collectCeaDaily({ actor: 'test', onlyNew: true, deadlineAt: Date.now() - 1 });
  assertEqual(daily.skipped, true, '批次预算已耗尽时应直接跳过，而不是重新开始 120 秒');
  assertEqual(daily.reason, 'batch_budget_exceeded');
  assertIncludes(daily.message, '留待下一批');
  const docs = await collect.collectCeaDocuments({ actor: 'test', deadlineAt: Date.now() - 1 });
  assertEqual(docs.skipped, true, '文件通道同样共享该 deadline');
  assertEqual(docs.deadline_shared, true);
});

/* ==================================================================== */
/*  尾项3：正式休市公告优先 + 机器列表异常分层                            */
/* ==================================================================== */

test('尾项3 正式休市公告解析：只按原文写明的范围，记录开市日，周末休市单列', () => {
  const file = join(SAMPLE_DIR, 'annual-closures-2026.html');
  assert(existsSync(file), `缺少正式公告样本 ${file}`);
  const parsed = parse.parseAnnualClosureNotice(readFileSync(file, 'utf8'), { url: 'https://overview.cneeex.com/c/2025-12-24/496961.shtml' });
  assertEqual(parsed.ok, true, `公告应能解析：${parsed.reason || ''}`);
  assertEqual(parsed.year, 2026);
  assertEqual(parsed.doc_number, '沪环境交〔2025〕44号');
  assertEqual(parsed.ranges.length, 7, '元旦/春节/清明/劳动/端午/中秋/国庆 共 7 段');
  assertEqual(parsed.closed_dates.includes('2026-10-01'), true);
  assertEqual(parsed.closed_dates.includes('2026-10-07'), true);
  assertEqual(parsed.closed_dates.includes('2026-10-14'), false, '公告未把 10-14 列为休市');
  assertEqual(parsed.reopen_dates.includes('2026-10-08'), true, '公告写明 10-08 起照常开市');
  assertEqual(parsed.weekend_closures.includes('2026-10-10'), true, '「另外…为周末休市」单列');
  assertIncludes(parsed.note, '不按节假日名称推测');
});

test('尾项3 日历核对：机器列表把实际成交日标成休市 → 独立告警、保留原文、不生成人工复核', () => {
  const now = new Date().toISOString();
  db.run("DELETE FROM cea_trade_daily WHERE trade_date IN ('2026-10-13','2026-10-14')");
  for (const d of ['2026-10-13', '2026-10-14']) {
    db.run(
      `INSERT INTO cea_trade_daily (id,trade_date,instrument,market_scope,price_regime,close,total_volume,total_turnover,
         source_url,parse_status,check_status,verification_status,session_state,revision,created_at,updated_at)
       VALUES (?,?, 'CEA','national','CEA_COMPOSITE_2026',98.2,2861440,258301176.6,
         'https://shyx.cneeex.com/gateway/common/querySubStat','ok','pass','unverified','traded',1,?,?)`,
      [`CEATD-${d}`, d, now, now]
    );
  }
  // 机器辅助列表（holidays.json）把 2026-10-14 标为休市
  cea.upsertCeaCalendarDates(['2026-10-01', '2026-10-14'], {
    evidenceKind: 'holidays_json', sourceCode: 'cea_json_holidays',
    evidenceUrl: 'https://shyx.cneeex.com/assets/json/holidays.json', note: '机器辅助列表（原文保留）',
  });
  const parsed = parse.parseAnnualClosureNotice(readFileSync(join(SAMPLE_DIR, 'annual-closures-2026.html'), 'utf8'), {});
  const applied = cea.applyCeaAnnualClosureNotice(parsed, {
    sourceCode: 'cea_annual_closures_2026', evidenceUrl: 'https://overview.cneeex.com/c/2025-12-24/496961.shtml',
  });
  assertEqual(applied.ok, true);
  assertEqual(applied.reconcile.manual_review_created, 0, '不得生成人工复核任务');
  assertEqual(applied.reconcile.anomalies, 1, '应只有 2026-10-14 一条机器列表异常');

  const checks = cea.listCeaCalendarChecks({});
  const anomaly = checks.rows.find((r) => r.trade_date === '2026-10-14');
  assert(anomaly, '应存在 2026-10-14 异常记录');
  assertEqual(anomaly.check_key, 'machine_list_vs_actual');
  assertEqual(anomaly.effective_state, 'trading');
  assertEqual(anomaly.manual_review, 0);
  assertIncludes(anomaly.detail, '机器辅助休市列表');
  assertIncludes(anomaly.detail, '不因此被判为不真实');

  // 机器列表原文必须保留（两侧证据都留）
  const machine = db.get("SELECT * FROM cea_calendar WHERE trade_date='2026-10-14' AND evidence_kind='holidays_json'");
  assert(machine && machine.day_type === 'holiday', '机器列表原文必须保留，不得被删除或改写');
  const notice = db.get("SELECT * FROM cea_calendar WHERE trade_date='2026-10-14' AND evidence_kind='official_notice'");
  assert(!notice, '正式公告并未把 10-14 列为休市');

  const layered = cea.ceaCalendarLayered({ limit: 400 });
  const d14 = layered.rows.find((r) => r.trade_date === '2026-10-14');
  assertEqual(d14.effective_state, 'trading', '有实际成交 → 按交易日对待');
  assertEqual(d14.actual_trades, true);
  assert(d14.anomaly, '分层视图中异常单独挂出');
  const d08 = layered.rows.find((r) => r.trade_date === '2026-10-08');
  assertEqual(d08.effective_state, 'trading', '正式公告写明开市 → trading');
  const d01 = layered.rows.find((r) => r.trade_date === '2026-10-01');
  assertEqual(d01.effective_state, 'closed', '正式公告休市且无成交 → closed');
  assertIncludes(layered.layers_note, '正式公告 > 实际成交 > 机器辅助列表');

  // 行情数值不因机器列表异常被标为不真实
  const row = db.get("SELECT verification_status, check_status FROM cea_trade_daily WHERE trade_date='2026-10-14'");
  assertEqual(row.verification_status, 'unverified');
  assertEqual(row.check_status, 'pass');
});

/* ==================================================================== */
/*  尾项4：API 参数统一校验                                              */
/* ==================================================================== */

test('尾项4 参数校验：真实日期、倒置范围、limit/offset/year、枚举一律拒绝而非静默兜底', () => {
  assertEqual(params.isRealIsoDate('2026-10-13'), true);
  assertEqual(params.isRealIsoDate('2026-02-30'), false, '不存在的日期应拒绝');
  assertEqual(params.isRealIsoDate('2026-13-01'), false);
  assertEqual(params.isRealIsoDate('20261013'), false);
  assertEqual(params.isRealIsoDate(''), false);

  const bad = [
    [{ from: '2026-13-45' }, { dates: ['from'] }, 'from'],
    [{ to: '2026/10/13' }, { dates: ['to'] }, 'to'],
    [{ limit: 'abc' }, { ints: [{ name: 'limit', min: 1, max: 2000 }] }, 'limit'],
    [{ limit: '0' }, { ints: [{ name: 'limit', min: 1, max: 2000 }] }, 'limit'],
    [{ limit: '9999' }, { ints: [{ name: 'limit', min: 1, max: 2000 }] }, 'limit'],
    [{ limit: '1.5' }, { ints: [{ name: 'limit', min: 1, max: 2000 }] }, 'limit'],
    [{ offset: '-1' }, { ints: [{ name: 'offset', min: 0, max: 10 }] }, 'offset'],
    [{ year: '20x6' }, { ints: [{ name: 'year', min: 2000, max: 2100 }] }, 'year'],
    [{ year: '1999' }, { ints: [{ name: 'year', min: 2000, max: 2100 }] }, 'year'],
    [{ granularity: 'hour' }, { enums: { granularity: params.CEA_GRANULARITY } }, 'granularity'],
    [{ direction: 'hold' }, { enums: { direction: ['buy', 'sell', 'unknown'] } }, 'direction'],
    [{ format: 'exe' }, { enums: { format: params.CEA_FORMATS } }, 'format'],
    [{ from: '2026-10-13', to: '2026-01-01' }, { dates: ['from', 'to'], range: ['from', 'to'] }, 'from/to'],
  ];
  for (const [query, spec, parameter] of bad) {
    const out = params.validateCeaParams(query, spec);
    assertEqual(out.ok, false, `${JSON.stringify(query)} 应被拒绝`);
    assertEqual(out.error.status, 400);
    assertEqual(out.error.parameter, parameter);
    assertIncludes(out.error.error, '不合法');
  }
  // 合法输入通过，默认值生效，空值视为未筛选
  const ok = params.validateCeaParams({ from: '2026-01-01', to: '2026-12-31', limit: '50', sector: '钢铁' }, {
    dates: ['from', 'to'], range: ['from', 'to'], ints: [{ name: 'limit', min: 1, max: 2000, def: 200 }, { name: 'offset', min: 0, max: 100, def: 0 }], passthrough: ['sector'],
  });
  assertEqual(ok.ok, true);
  assertEqual(ok.values.limit, 50);
  assertEqual(ok.values.offset, 0);
  assertEqual(ok.values.sector, '钢铁');
  assertEqual(params.validateCeaParams({}, { ints: [{ name: 'limit', min: 1, max: 2000, def: 200 }] }).values.limit, 200);
  // dataset 枚举来自统一常量
  assert(params.CEA_DATASETS.includes('price_history') && params.CEA_DATASETS.includes('research'));
});

/* ==================================================================== */
/*  尾项5：CEA 管理员 PDF 上传                                           */
/* ==================================================================== */

await testAsync('尾项5 CEA 原件补充：上传目标/扫描件/来源分层/普通用户 403', async () => {
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO cea_document (id,doc_key,doc_type,category,title,doc_number,issuer,publish_date,doc_status,
       official_url,evidence_level,ai_status,count_in_stats,created_at,updated_at)
     VALUES ('CEADOC-TEST-UPLOAD','cea_test_upload','policy','allocation','测试用 CEA 扫描件政策','测字〔2026〕9号','测试机关',
       '2026-01-01','formal',NULL,'metadata_only','unverified',1,?,?)`,
    [now, now]
  );
  // 目标列表应包含该条（缺正文/缺原件）
  const gaps = upload.listCeaDocumentGaps();
  assert(gaps.cea.some((r) => r.id === 'CEADOC-TEST-UPLOAD'), '缺正文的 CEA 文件应出现在补充入口');
  assertIncludes(gaps.note, '不得凭元数据伪造正文');

  // 普通用户 403
  const denied = await upload.uploadDocument({ id: 'U1', name: 'viewer', role: 'viewer' }, { kind: 'cea_document', id: 'CEADOC-TEST-UPLOAD' });
  assertEqual(denied.ok, false);
  assertEqual(denied.status, 403);

  // 构造一个最小合法 PDF（无文本层 → 模拟扫描件）
  const scan = Buffer.concat([
    Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n', 'latin1'),
    Buffer.from('stream\n\x00\x01\x02binary-scan-bytes\nendstream\n', 'latin1'),
    Buffer.from('trailer<</Root 1 0 R>>\n%%EOF\n', 'latin1'),
  ]);
  const out = await upload.uploadDocument(
    { id: 'A1', name: 'admin', role: 'admin' },
    { kind: 'cea_document', id: 'CEADOC-TEST-UPLOAD', file_name: 'scan.pdf', pdf_base64: scan.toString('base64') }
  );
  assertEqual(out.ok, true, `上传应成功：${out.error || ''}`);
  assertEqual(out.source_status, 'admin_supplied_unverified', '未与官方 URL 字节一致时只能标为管理员副本');
  assertEqual(out.parse_quality, 'failed', '扫描件无正文时应为 failed');
  assertIncludes(out.note, '不能据此声称官方原件已核实');
  const row = db.get("SELECT * FROM cea_document WHERE id='CEADOC-TEST-UPLOAD'");
  assertEqual(row.body_snapshot, null, '扫描件不得凭元数据伪造正文');
  assertEqual(row.evidence_level, 'metadata_only');
  const uploadRow = db.get("SELECT * FROM document_upload WHERE target_kind='cea_document' AND target_id='CEADOC-TEST-UPLOAD'");
  assert(uploadRow, '应写入 document_upload（cea_document 目标已放宽 CHECK 约束）');
  assertEqual(uploadRow.text_content, null);

  // OCR 文本作为管理员转写：保留但标记为 partial，不冒充 PDF 提取
  const out2 = await upload.uploadDocument(
    { id: 'A1', name: 'admin', role: 'admin' },
    { kind: 'cea_document', id: 'CEADOC-TEST-UPLOAD', file_name: 'scan2.pdf', pdf_base64: scan.toString('base64'), ocr_text: '这是管理员补充的 OCR 文本'.repeat(12) }
  );
  assertEqual(out2.ok, true);
  assertEqual(out2.text_source, 'admin_transcript', 'OCR 文本必须标记来源');
  assertEqual(out2.parse_quality, 'partial');
});

/* ==================================================================== */
/*  尾项6：真实历史价格层                                                */
/* ==================================================================== */

await testAsync('尾项6 历史价格层：≥120 真实点、快照来源、参考数量不当成交量、无成交额/均价', async () => {
  const points = [];
  for (let i = 0; i < 130; i += 1) {
    const d = new Date(Date.UTC(2026, 0, 1) + i * 86400000).toISOString().slice(0, 10);
    points.push({ trade_date: d, open: 90 + i * 0.01, high: 91 + i * 0.01, low: 89 + i * 0.01, close: 90.5 + i * 0.01, volume_reference: 1000 + i });
  }
  const saved = cea.upsertCeaPriceHistory(points, {
    sourceCode: 'cea_json_hiskline', sourceUrl: 'https://shyx.cneeex.com/assets/json/hiskline.json',
    snapshotId: 'SS-TEST-PH', contentHash: 'hash-test', fetchedAt: new Date().toISOString(),
  });
  assertEqual(saved.created, 130);
  const layered = cea.ceaPriceHistoryLayered({ limit: 200 });
  assertEqual(layered.source_history_count, 130, '应返回全部 130 个真实价格点（≥120）');
  assertIncludes(layered.min_points_note, '≥120');
  const p = layered.source_history[0];
  assertEqual(p.quote_caliber, 'source_history');
  assertEqual(p.is_precise, 0);
  assertEqual(p.snapshot_id, 'SS-TEST-PH', '历史价格点必须能回溯到来源快照');
  assertEqual(Object.keys(p).some((k) => /turnover|vwap|avg_price/i.test(k)), false, '历史价格层不得含成交额/均价字段');
  const cols = cea.CEA_EXPORT_COLUMNS.price_history.map((c) => c.key);
  assertEqual(cols.includes('total_turnover'), false);
  assertEqual(cols.includes('computed_avg_price'), false);
  assert(cols.includes('volume_reference'), '参考数量必须单列并注明不是成交量');
  assertIncludes(cea.CEA_EXPORT_COLUMNS.price_history.find((c) => c.key === 'volume_reference').definition, '不是');
  // 幂等：同日期同来源重复写入不新增行
  const again = cea.upsertCeaPriceHistory(points, { sourceCode: 'cea_json_hiskline', sourceUrl: 'x' });
  assertEqual(again.created, 0);
  assertEqual(again.updated, 130);
  assertEqual(db.get('SELECT COUNT(*) c FROM cea_price_history')?.c, 130);
  // 精确日统计与历史价格分开
  assertEqual(layered.precise_daily.every((r) => r.quote_caliber === 'precise_daily' && r.is_precise === 1), true);
  assertIncludes(layered.caliber_note, '参考数量');
  // 导出数据集可生成行（不含成交额/均价）
  const exp = cea.ceaExportRows('price_history', {});
  assertEqual(exp.rows.length, 130);
  assertEqual(Object.keys(exp.rows[0]).includes('total_turnover'), false);
});

/* ==================================================================== */
/*  尾项7：研报/动态来源分级与元数据纪律                                  */
/* ==================================================================== */

test('尾项7 来源分级：官方/机构/媒体/聚合转载站分类，转载站显式标注为非第一来源', () => {
  assertEqual(collect.classifyResearchSource('https://shyx.cneeex.com/assets/json/x').kind, 'official_exchange');
  assertEqual(collect.classifyResearchSource('https://www.mee.gov.cn/a.htm').kind, 'official_government');
  assertEqual(collect.classifyResearchSource('https://iigf.cufe.edu.cn/info/1012/10973.htm').kind, 'institution');
  assertEqual(collect.classifyResearchSource('https://www.sohu.com/a/1').kind, 'media_repost');
  assertEqual(collect.classifyResearchSource('https://news.bjx.com.cn/special/?id=1').kind, 'media_repost');
  const repost = collect.deriveResearchMeta({ url: 'https://www.sohu.com/a/1', body: '越来越多的大学开始研究碳市场。数据截至2023年12月' });
  assertIncludes(repost.note, '不是公开第一来源');
  // 无发布语境的机构名不得被推断
  assertEqual(repost.issuer, null, '没有「来源/机构：X」标注时机构必须为 null，不得从正文里猜机构名');
  const labeled = collect.deriveResearchMeta({ url: 'https://example.com/a', body: '来源：某某研究院 发布时间：2024-07-24 数据截至2023年12月' });
  assertEqual(labeled.issuer, '某某研究院');
  assertEqual(labeled.issuer_source, 'source_page_label');
  assertEqual(labeled.publish_date, '2024-07-24');
  // docs/35 尾项5：原文只到月时**不补造具体日**，按原精度记录并标注 precision=month
  assertEqual(labeled.data_cutoff_date, '2023-12');
  assertEqual(labeled.data_cutoff_precision, 'month');
  assertIncludes(labeled.data_cutoff_raw, '截至2023年12');
  // 只到年时保持 '2023'（precision=year），不得写成 2023-12-01
  const yearOnly = collect.deriveResearchMeta({ url: 'https://example.com/b', body: '数据截至2023年' });
  assertEqual(yearOnly.data_cutoff_date, '2023');
  assertEqual(yearOnly.data_cutoff_precision, 'year');
  // 原文明确到年月日才写 YYYY-MM-DD
  const dayExact = collect.deriveResearchMeta({ url: 'https://example.com/c', body: '数据截至2023年12月31日' });
  assertEqual(dayExact.data_cutoff_date, '2023-12-31');
  assertEqual(dayExact.data_cutoff_precision, 'day');
  const domainIssuer = collect.deriveResearchMeta({ url: 'https://iigf.cufe.edu.cn/x', body: '正文内容' });
  assertEqual(domainIssuer.issuer, '中央财经大学绿色金融国际研究院');
  assertEqual(domainIssuer.viewpoint, 'market_news');
});

await testAsync('尾项7 研报采集：无搜索服务时如实登记缺口，不写任何条目', async () => {
  const savedSearch = db.all('SELECT id, enabled FROM search_provider');
  db.run('UPDATE search_provider SET enabled=0');
  const before = db.get("SELECT COUNT(*) c FROM cea_document WHERE doc_key LIKE 'cea_research:%'")?.c || 0;
  const out = await collect.collectCeaResearch({ actor: 'test', limit: 3 });
  assertEqual(out.published, 0);
  assertEqual(out.failed.some((f) => f.reason === 'no_search_provider'), true);
  assertIncludes(out.note, '不伪造');
  const after = db.get("SELECT COUNT(*) c FROM cea_document WHERE doc_key LIKE 'cea_research:%'")?.c || 0;
  assertEqual(after, before, '无搜索服务时不得写入任何研报条目');
  const gap = cea.listCeaGaps({ status: 'open' }).find((g) => g.gap_key === 'cea:research:no_search');
  assert(gap, '应登记搜索服务缺口');
  for (const s of savedSearch) db.run('UPDATE search_provider SET enabled=? WHERE id=?', [s.enabled, s.id]);
});

await testAsync('尾项7 研报列表：第一来源/机构/日期/截止日/观点标记齐备，并有真实缺口说明', async () => {
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO cea_document (id,doc_key,doc_type,category,title,issuer,publish_date,data_cutoff_date,viewpoint,
       first_source_url,official_url,doc_status,evidence_level,ai_status,count_in_stats,discovery_json,created_at,updated_at)
     VALUES ('CEADOC-TEST-RS','cea_research:test','research','research','测试研报：全国碳市场展望','某研究院','2026-03-01',
       '2026-02-01','research_opinion','https://example.com/rs','https://example.com/rs','formal','full_text','verified',1,
       '{"source_kind":"institution","source_kind_label":"高校/研究机构"}',?,?)`,
    [now, now]
  );
  const out = cea.listCeaResearch({});
  const row = out.rows.find((r) => r.id === 'CEADOC-TEST-RS');
  assert(row, '研报应出现在列表');
  assertEqual(row.issuer, '某研究院');
  assertEqual(row.publish_date, '2026-03-01');
  assertEqual(row.data_cutoff_date, '2026-02-01');
  assertEqual(row.viewpoint, 'research_opinion');
  assertEqual(row.is_viewpoint, true);
  assertEqual(row.first_source, 'https://example.com/rs');
  assertIncludes(out.note, '观点类内容不作为现行规则');
  assertEqual(Array.isArray(out.open_gaps), true);
});

/* ==================================================================== */
/*  尾项8：附件目录统一                                                  */
/* ==================================================================== */

test('尾项8 CEA 官方附件目录统一到 data/official-originals/cea', () => {
  const prev = process.env.CCER_CEA_ATTACHMENT_DIR;
  delete process.env.CCER_CEA_ATTACHMENT_DIR;
  const def = collect.ceaAttachmentDir();
  assert(/official-originals[\\/]cea$/.test(def), `默认附件目录应统一到 official-originals/cea，实际 ${def}`);
  // 实际写入测试临时目录，避免污染仓库 data/
  process.env.CCER_CEA_ATTACHMENT_DIR = ctx.dir;
  try {
    const saved = collect.saveCeaAttachment('test_source', Buffer.from('%PDF-1.4\n%%EOF\n', 'latin1'), { actor: 'test' });
    assert(saved.path, `落盘应成功：${saved.reason || ''}`);
    assert(saved.path.startsWith(ctx.dir), '落盘路径应使用配置的附件目录');
    assertEqual(saved.hash.length, 64);
    assertIncludes(saved.path, 'test_source-');
  } finally {
    if (prev) process.env.CCER_CEA_ATTACHMENT_DIR = prev; else delete process.env.CCER_CEA_ATTACHMENT_DIR;
  }
});

/* ==================================================================== */
/*  回归：阶段B 新增通道不影响既有核对                                    */
/* ==================================================================== */

test('回归：新增表与列均为增量，CEA 既有表计数不受影响', () => {
  for (const t of ['cea_price_history', 'cea_calendar_check', 'cea_document', 'cea_intention', 'cea_trade_daily']) {
    assert(db.get(`SELECT name FROM sqlite_master WHERE type='table' AND name='${t}'`), `缺少表 ${t}`);
  }
  for (const c of ['first_source_url', 'data_cutoff_date', 'viewpoint', 'discovery_json']) {
    assert(db.all('PRAGMA table_info(cea_document)').some((x) => x.name === c), `cea_document 缺少列 ${c}`);
  }
  assertEqual(db.get("SELECT COUNT(*) c FROM cea_calendar_check WHERE manual_review<>0")?.c, 0, '不得存在人工复核任务');
});

/* 还原模型配置 */
for (const p of savedProviders) db.run('UPDATE llm_provider SET enabled=?, use_content_verify=? WHERE id=?', [p.enabled, p.use_content_verify, p.id]);

finish('34-v2-cea-phaseB.test.mjs');
