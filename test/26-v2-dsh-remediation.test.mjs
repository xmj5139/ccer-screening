/**
 * v2 测试 26：DSH 整改回归（交易日历／累计差分／政策原件归档／方法学目录）
 * ============================================================================
 * 本文件守护本轮四个整改项的**口径修复**，全部在独立临时库中运行、默认不联网：
 *
 *   1. 累计差分必须按「区间 (a, b] 内全部交易日逐日合计」比较，
 *      区间交易日以 trade_calendar 为准（而不是「已导入 trade_daily 的日期」）。
 *      漏采中间交易日时只登记**一条**「区间覆盖不完整」，不得把多日累计差分
 *      与单日成交量相减（2025-03-21 假告警的根因）。
 *   2. 成交量与成交额属同一根因，合并为**一条**记录（不再产生
 *      cumulative_gap + cumulative_turnover_gap 两条重复提醒）。
 *   3. 交易日历的「交易日」权威来源是官方公告清单；已入库行情但清单快照未含的日期
 *      **不得**降级为休市（否则采集失败会被伪装成法定节假日休市）。
 *   4. 「原件已归档」必须以本地文件 + SHA-256 判定；只有 parse_quality='good'
 *      的占位记录不算已归档（该缺陷曾让缺口永远无法结清）。
 *   5. 政策可追溯去重后，superseded 历史记录不再重复触发缺链接/重复标题告警。
 *   6. 方法学目录：正式版本的编号与来源通知一一对应，目录基线自洽。
 */
import {
  setupV2, test, assert, assertEqual, assertIncludes, netAllowed, finish,
} from './v2-helpers.mjs';

const ctx = await setupV2();
const { db, trade, reconcile, policy } = ctx;
const archiveSvc = await import('../src/services/policy-archive-svc.mjs');
const catalog = await import('../src/data/catalog.mjs');

console.log('\n[v2-26] DSH 整改回归');

const iso = () => new Date().toISOString();

/* ==================================================================== */
/*  一、交易日历：官方公告清单是「交易日」的权威来源                     */
/* ==================================================================== */

test('交易日历：官方公告清单中的日期一律标为 trading', () => {
  const out = trade.rebuildCalendar(['2026-03-02', '2026-03-03', '2026-03-04'], {
    windowStart: '2026-03-02', actor: 'test',
  });
  assert(out.marked >= 3, '应标记窗口内每一天');
  for (const d of ['2026-03-02', '2026-03-03', '2026-03-04']) {
    assertEqual(db.get('SELECT day_type FROM trade_calendar WHERE trade_date = ?', [d]).day_type, 'trading', `${d} 应为交易日`);
  }
});

test('交易日历：周末标 weekend、无公告工作日标 unknown', () => {
  // 2026-03-05（周四）不在官方公告清单内，缺公告不能证明休市。
  trade.rebuildCalendar(['2026-03-02', '2026-03-03', '2026-03-04', '2026-03-06', '2026-03-09'], {
    windowStart: '2026-03-02', actor: 'test',
  });
  assertEqual(db.get("SELECT day_type FROM trade_calendar WHERE trade_date = '2026-03-07'").day_type, 'weekend');
  assertEqual(db.get("SELECT day_type FROM trade_calendar WHERE trade_date = '2026-03-08'").day_type, 'weekend');
  assertEqual(db.get("SELECT day_type FROM trade_calendar WHERE trade_date = '2026-03-05'").day_type, 'unknown');
});

test('交易日历：已入库行情但公告清单快照未含的日期不得降级为休市（关键回归）', () => {
  // 场景：2026-03-10 有官方公告也有行情；下一次清单快照漏了这一天（例如公告页 404）
  trade.rebuildCalendar(['2026-03-09', '2026-03-10', '2026-03-11'], { windowStart: '2026-03-09', actor: 'test' });
  assertEqual(db.get("SELECT day_type FROM trade_calendar WHERE trade_date = '2026-03-10'").day_type, 'trading');
  trade.rebuildCalendar(['2026-03-09', '2026-03-11'], {
    windowStart: '2026-03-09', actor: 'test', importedDates: ['2026-03-10'],
  });
  assertEqual(
    db.get("SELECT day_type FROM trade_calendar WHERE trade_date = '2026-03-10'").day_type,
    'trading',
    '已入库行情记录的日期不得因清单快照缺失而被降级为 holiday（否则采集失败会被伪装成休市）'
  );
});

/* ==================================================================== */
/*  二、累计差分：区间逐日合计 + 单条记录                               */
/* ==================================================================== */

test('累计差分：区间内全部交易日逐日合计一致时不得告警（跨多日区间）', () => {
  trade.upsertTradeDaily({ trade_date: '2026-04-01', volume: 600, turnover: 55200, avg_price: 92, session_state: 'traded' }, { actor: 'test' });
  trade.upsertTradeDaily({ trade_date: '2026-04-02', volume: 2130, turnover: 218408.4, avg_price: null, session_state: 'traded' }, { actor: 'test' });
  trade.upsertTradeDaily({ trade_date: '2026-04-03', volume: 500, turnover: 42749, avg_price: 85.5, session_state: 'traded' }, { actor: 'test' });
  trade.rebuildCalendar(['2026-04-01', '2026-04-02', '2026-04-03'], { windowStart: '2026-04-01', actor: 'test' });
  // 官方累计：04-01 基准 → 04-03 = 600 + 2130 + 500
  trade.upsertCumulativeReference({ as_of_date: '2026-04-01', volume_total: 1000000, turnover_total: 90000000 });
  trade.upsertCumulativeReference({ as_of_date: '2026-04-02', volume_total: 1002130, turnover_total: 90218408.4 });
  trade.upsertCumulativeReference({ as_of_date: '2026-04-03', volume_total: 1002630, turnover_total: 90261157.4 });
  reconcile.runTradeChecks({ actor: 'test' });
  const wrong = db.get(
    `SELECT COUNT(*) c FROM data_reconciliation
     WHERE dataset='trade' AND status='open'
       AND check_kind IN ('cumulative_gap','cumulative_turnover_gap','cumulative_interval_incomplete')
       AND object_id IN ('2026-04-01..2026-04-02','2026-04-02..2026-04-03','2026-04-01..2026-04-03')`
  ).c;
  assertEqual(wrong, 0, '区间逐日合计与官方累计差分一致时不得产生累计类告警');
});

test('累计差分：漏采中间交易日 → 只登记一条「区间覆盖不完整」，不与单日相减', () => {
  // 2026-05-06 / 05-07 / 05-08 均为工作日；官方累计在 05-06 → 05-08 之间增加了 2630，
  // 但 05-07（交易日）没有行情记录
  trade.rebuildCalendar(['2026-05-06', '2026-05-07', '2026-05-08'], { windowStart: '2026-05-06', actor: 'test' });
  trade.upsertTradeDaily({ trade_date: '2026-05-06', volume: 600, turnover: 55200, avg_price: 92, session_state: 'traded' }, { actor: 'test' });
  trade.upsertTradeDaily({ trade_date: '2026-05-08', volume: 500, turnover: 42749, avg_price: 85.5, session_state: 'traded' }, { actor: 'test' });
  trade.upsertCumulativeReference({ as_of_date: '2026-05-06', volume_total: 2000000, turnover_total: 180000000 });
  trade.upsertCumulativeReference({ as_of_date: '2026-05-08', volume_total: 2002630, turnover_total: 180261157.4 });
  reconcile.runTradeChecks({ actor: 'test' });

  const incomplete = db.get(
    "SELECT * FROM data_reconciliation WHERE check_kind='cumulative_interval_incomplete' AND object_id='2026-05-06..2026-05-08' AND status='open'"
  );
  assert(incomplete, '应登记一条区间覆盖不完整记录');
  assertIncludes(incomplete.detail, '2026-05-07', '必须点名缺失的交易日');
  assertIncludes(incomplete.detail, '不能与单日成交量/额相减', '必须说明为何不做差分结论');
  const dup = db.get(
    "SELECT COUNT(*) c FROM data_reconciliation WHERE check_kind='cumulative_turnover_gap' AND status='open'"
  ).c;
  assertEqual(dup, 0, '同一根因不得再额外产生成交额重复提醒');
});

test('累计差分：无成交交易日（no_trade）算已覆盖，不算漏采', () => {
  trade.rebuildCalendar(['2026-06-01', '2026-06-02'], { windowStart: '2026-06-01', actor: 'test' });
  trade.upsertTradeDaily({ trade_date: '2026-06-01', volume: 1000, turnover: 95000, avg_price: 95, session_state: 'traded' }, { actor: 'test' });
  trade.upsertTradeDaily({ trade_date: '2026-06-02', volume: 0, turnover: 0, avg_price: null, session_state: 'no_trade' }, { actor: 'test' });
  trade.upsertCumulativeReference({ as_of_date: '2026-06-01', volume_total: 3000000, turnover_total: 270000000 });
  trade.upsertCumulativeReference({ as_of_date: '2026-06-02', volume_total: 3000000, turnover_total: 270000000 });
  reconcile.runTradeChecks({ actor: 'test' });
  const bad = db.get(
    "SELECT COUNT(*) c FROM data_reconciliation WHERE check_kind='cumulative_interval_incomplete' AND object_id='2026-06-01..2026-06-02' AND status='open'"
  ).c;
  assertEqual(bad, 0, '官方已发布公告的无成交日属于已覆盖，不得判为漏采');
});

test('同一区间只保留一条累计差分记录（成交量与成交额合并）', () => {
  trade.rebuildCalendar(['2026-07-01', '2026-07-02'], { windowStart: '2026-07-01', actor: 'test' });
  trade.upsertTradeDaily({ trade_date: '2026-07-01', volume: 1000, turnover: 95000, avg_price: 95, session_state: 'traded' }, { actor: 'test' });
  trade.upsertTradeDaily({ trade_date: '2026-07-02', volume: 1000, turnover: 95000, avg_price: 95, session_state: 'traded' }, { actor: 'test' });
  trade.upsertCumulativeReference({ as_of_date: '2026-07-01', volume_total: 4000000, turnover_total: 360000000 });
  // 成交量与成交额都与区间逐日合计不一致
  trade.upsertCumulativeReference({ as_of_date: '2026-07-02', volume_total: 4000500, turnover_total: 360040000 });
  reconcile.runTradeChecks({ actor: 'test' });
  const rows = db.all(
    `SELECT check_kind, detail FROM data_reconciliation
     WHERE object_id='2026-07-01..2026-07-02' AND status='open' ORDER BY check_kind`
  );
  assertEqual(rows.length, 1, `同一区间只应有一条记录，实际 ${rows.length} 条：${rows.map((r) => r.check_kind).join('、')}`);
  assertEqual(rows[0].check_kind, 'cumulative_gap');
  assertIncludes(rows[0].detail, '成交量：', '同一条记录里应给出成交量差异');
  assertIncludes(rows[0].detail, '成交额：', '同一条记录里应给出成交额差异');
});

/* ==================================================================== */
/*  三、政策原件归档判定                                                */
/* ==================================================================== */

test('原件归档判定：只有 parse_quality=good 的占位记录不算已归档（关键回归）', () => {
  db.run(
    `INSERT INTO policy_document (id,policy_key,title,category,doc_status,official_url,collected_at,created_at,updated_at)
     VALUES ('POL-ARCH-1','pol-arch-1','归档判定测试政策','management','effective','https://www.mee.gov.cn/x.html',?,?,?)`,
    [iso(), iso(), iso()]
  );
  db.run(
    `INSERT INTO policy_attachment (id,policy_id,file_name,file_type,url,file_hash,local_path,parse_quality,parse_note,created_at)
     VALUES ('PAT-ARCH-1','POL-ARCH-1','页面.html','html','https://www.mee.gov.cn/x.html',NULL,NULL,'good','官方页面已核对',?)`,
    [iso()]
  );
  assertEqual(policy.isAttachmentArchived(db.get("SELECT * FROM policy_attachment WHERE id='PAT-ARCH-1'")), false,
    '没有本地文件与哈希的占位记录不得算作已归档');
  assertEqual(policy.policyHasArchivedOriginal('POL-ARCH-1'), false, '该政策应判为未归档');

  reconcile.runPolicyChecks({ actor: 'test' });
  const rec = db.get("SELECT * FROM data_reconciliation WHERE check_kind='missing_attachment' AND object_id='POL-ARCH-1' AND status='open'");
  assert(rec, '未归档必须如实登记 missing_attachment（不得被 parse_quality=good 掩盖）');
});

test('原件归档判定：本地文件 + SHA-256 才算已归档，且历史核对记录自动结清', () => {
  db.run(
    `INSERT INTO policy_attachment (id,policy_id,file_name,file_type,url,file_hash,local_path,parse_quality,parse_note,created_at)
     VALUES ('PAT-ARCH-2','POL-ARCH-1','x.html','html','https://www.mee.gov.cn/x.html','deadbeef','data/x.html','good','官方页面原件已落盘',?)`,
    [iso()]
  );
  assertEqual(policy.policyHasArchivedOriginal('POL-ARCH-1'), true);
  reconcile.runAllChecks({ actor: 'test' });
  const rec = db.get("SELECT * FROM data_reconciliation WHERE check_kind='missing_attachment' AND object_id='POL-ARCH-1'");
  assertEqual(rec.status, 'resolved', '归档补齐后历史核对记录应自动结清（不删除历史）');
});

test('缺口台账：原件已归档但正文不可提取时保持 open，并写明原因', () => {
  db.run(
    `UPDATE policy_attachment SET parse_quality='partial', parse_note='官方页面原件已落盘，但正文抽取结果过短'
     WHERE id='PAT-ARCH-2'`
  );
  const gap = archiveSvc.syncPolicyArchiveGap({ actor: 'test' });
  assertEqual(gap.closed, false, '归档完成但正文不可提取时不得强行关闭缺口');
  assert(gap.unparsed >= 1, '应统计正文不可提取的条目数');
  const row = db.get("SELECT * FROM data_gap WHERE gap_key='gap-policy-original-archive'");
  assertEqual(row.status, 'open');
  assertIncludes(row.description, '正文不可提取');
  assertIncludes(row.description, '不声称已读原文');
});

test('缺口台账：全部归档且正文可提取时结清', () => {
  db.run("UPDATE policy_attachment SET parse_quality='good' WHERE id='PAT-ARCH-2'");
  // 其余政策同样视为已归档（本用例只验证判定逻辑）
  for (const p of db.all("SELECT id FROM policy_document WHERE doc_status != 'superseded'")) {
    const has = db.get("SELECT COUNT(*) c FROM policy_attachment WHERE policy_id=? AND local_path IS NOT NULL AND file_hash IS NOT NULL", [p.id]).c;
    if (!has) {
      db.run(
        `INSERT INTO policy_attachment (id,policy_id,file_name,file_type,url,file_hash,local_path,parse_quality,parse_note,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [`PAT-FILL-${p.id.slice(-8)}`, p.id, 'f.html', 'html', 'https://www.mee.gov.cn/', `h-${p.id}`, 'data/f.html', 'good', '测试填充', iso()]
      );
    }
  }
  const gap = archiveSvc.syncPolicyArchiveGap({ actor: 'test' });
  assertEqual(gap.closed, true, '全部归档且正文可提取时应结清缺口');
  assertEqual(db.get("SELECT status FROM data_gap WHERE gap_key='gap-policy-original-archive'").status, 'closed');
});

/* ==================================================================== */
/*  四、政策可追溯去重                                                  */
/* ==================================================================== */

test('已去重的 superseded 历史记录不再触发缺链接/重复标题告警', () => {
  db.run(
    `INSERT INTO policy_document (id,policy_key,title,category,doc_status,official_url,collected_at,created_at,updated_at)
     VALUES ('POL-DUP-OLD','pol-dup-old','关于发布《测试方法学（CCER—99—001—V01）》的通知','ministry_policy','superseded','https://www.mee.gov.cn/n.html',?,?,?)`,
    [iso(), iso(), iso()]
  );
  db.run(
    `INSERT INTO policy_document (id,policy_key,title,category,doc_status,official_url,supersedes_id,collected_at,created_at,updated_at)
     VALUES ('POL-DUP-NEW','pol-dup-new','关于发布《测试方法学（CCER-99-001-V01）》的通知','ministry_policy','effective','https://www.mee.gov.cn/n.html','POL-DUP-OLD',?,?,?)`,
    [iso(), iso(), iso()]
  );
  const out = reconcile.runPolicyChecks({ actor: 'test' });
  assert(out.superseded_skipped >= 1, '应跳过 superseded 历史记录');
  assertEqual(
    db.get("SELECT COUNT(*) c FROM data_reconciliation WHERE check_kind='duplicate' AND object_id IN ('POL-DUP-OLD','POL-DUP-NEW') AND status='open'").c,
    0,
    '可追溯去重后不得再报标题重复'
  );
  assertEqual(
    db.get("SELECT COUNT(*) c FROM data_reconciliation WHERE check_kind='missing_official_url' AND object_id='POL-DUP-OLD' AND status='open'").c,
    0,
    'superseded 历史记录不再重复触发缺链接告警'
  );
});

/* ==================================================================== */
/*  五、方法学目录自洽                                                  */
/* ==================================================================== */

test('目录基线自洽：设计条目数 = 已录入 = 已核实编号数，且无待核实项', () => {
  const b = catalog.CATALOG_BASELINE;
  assertEqual(b.design_doc_count, 18);
  assertEqual(b.seeded_methodology_ids, 18);
  assertEqual(b.verified_code_count, 18);
  assertEqual(b.pending_code_count, 0);
  assertEqual(b.registry_listing_count_verified, false, '注册登记系统目录条目数仍未核实，必须如实保留');
  assertIncludes(b.note, '注册登记系统');
});

test('正式方法学：编号齐备、来源通知 URL 一一对应、无「仅答记者问口径」条目', () => {
  const formal = catalog.METHODOLOGY_CATALOG.filter((m) => m.document_status === 'formal');
  assertEqual(formal.length, 18, '正式方法学应为 18 项');
  const pending = formal.filter((m) => m.catalog_confidence !== 'verified_from_official_notice');
  assertEqual(pending.length, 0, `不应再有编号待核实条目：${pending.map((m) => m.name).join('、')}`);
  for (const m of formal) {
    assert(m.code_display, `${m.name} 缺少编号`);
    assert(/^CCER-\d{2}-\d{3}-V\d+$/.test(m.code_display), `${m.code_display} 编号格式不正确`);
    assert(m.official_url && m.official_url.startsWith('https://www.mee.gov.cn/'), `${m.name} 的官方 URL 必须是生态环境部发布通知`);
    assert(!/zbft/.test(m.official_url), `${m.name} 的官方 URL 不得再用答记者问页面充当编号来源`);
  }
  // 编号唯一
  const codes = formal.map((m) => m.code_display);
  assertEqual(new Set(codes).size, codes.length, '正式方法学编号不得重复');
});

test('方法学生效口径：生效日期取通知落款（印发）日期，「自印发之日起施行」', () => {
  const byCode = Object.fromEntries(
    catalog.METHODOLOGY_CATALOG.filter((m) => m.document_status === 'formal').map((m) => [m.code_display, m])
  );
  // 官方通知正文均为「本通知自印发之日起施行」，落款日期经逐页核验
  const expected = {
    'CCER-07-001-V01': '2024-12-30',
    'CCER-10-002-V01': '2025-11-18',
    'CCER-10-003-V01': '2025-11-18',
    'CCER-10-004-V01': '2025-11-18',
    'CCER-14-005-V01': '2025-11-25',
    'CCER-14-003-V01': '2025-11-28',
    'CCER-14-004-V01': '2025-11-28',
    'CCER-15-001-V01': '2025-12-12',
    'CCER-15-002-V01': '2025-12-12',
    'CCER-06-001-V01': '2025-12-19',
    'CCER-01-004-V01': '2025-12-23',
    'CCER-11-001-V01': '2025-12-23',
    'CCER-01-003-V01': '2025-12-25',
  };
  for (const [code, date] of Object.entries(expected)) {
    assert(byCode[code], `目录缺少 ${code}`);
    assertEqual(byCode[code].effective_date, date, `${code} 的生效（施行）日期应为通知落款日 ${date}`);
    assertEqual(byCode[code].release_date, date, `${code} 的印发日期应为通知落款日 ${date}`);
  }
});

/* ==================================================================== */
/*  六、联网用例（默认跳过，--net 打开）                                */
/* ==================================================================== */

if (netAllowed()) {
  const { testAsync } = await import('./v2-helpers.mjs');
  const https = await import('node:https');
  /** 用 node:https 直连（agent:false + connection:close），避免 undici 全局连接在
   *  process.exit 时残留句柄（Windows 上会触发 libuv 断言）。 */
  const getText = (url, headers) =>
    new Promise((resolve, reject) => {
      const req = https.get(url, { headers, agent: false }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      });
      req.on('error', reject);
      req.setTimeout(20000, () => req.destroy(new Error('请求超时')));
    });

  await testAsync('官网分行业行情 2025-03-20 小计 = 2130 吨 / 218408.40 元（官方披露值）', async () => {
    // 请求头与采集器一致（官网对缺少 UA/Referer 的请求返回 403）
    const res = await getText('https://www.ccer.com.cn/wcm/ccer/data/20250320-first.json', {
      'user-agent': ctx.collect.USER_AGENT,
      referer: 'https://www.ccer.com.cn/wcm/ccer/html/2502lshq/index.html',
      accept: 'application/json,*/*',
      connection: 'close',
    });
    assertEqual(res.status, 200, '官方分行业行情应可访问');
    const parsed = trade.parseTradeFirstJson(res.body);
    assert(parsed.subtotal, '应解析出小计行');
    assertEqual(parsed.subtotal.volume, 2130);
    assertEqual(Math.round(parsed.subtotal.turnover * 100) / 100, 218408.4);
    // 与官方累计差分一致：1332669 - 1330039 = 2630 = 2130（03-20）+ 500（03-21）
    assertEqual(parsed.subtotal.volume + 500, 2630);
  });
} else {
  console.log('  · 跳过联网用例（加 --net 开启）');
}

finish('test/26-v2-dsh-remediation.test.mjs');
