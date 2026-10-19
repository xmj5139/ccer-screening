import { setupV2, test, testAsync, assert, assertEqual, finish } from './v2-helpers.mjs';

const { db, trade, reconcile } = await setupV2();
const upload = await import('../src/services/document-upload-svc.mjs');

console.log('\n[v2-29] 云端差异与管理员补充原件');

const { parseOfficialClosures } = await import('../src/services/trade-calendar-svc.mjs');
test('全年休市公告只解析明确的休市区间，不把恢复开市日期算作假期', () => {
  const days = parseOfficialClosures('<h1>2026年全年休市安排</h1><p>一、元旦：1月1日（星期四）至1月3日（星期六）休市。1月5日（星期一）起照常开市。</p><p>七、国庆节：10月1日（星期四）至10月7日（星期三）休市，10月8日起照常开市。</p>', 2026);
  assertEqual(days.length, 10);
  assert(days.includes('2026-10-07'));
  assert(!days.includes('2026-10-08'));
  assertEqual(parseOfficialClosures('1月1日休市，没有标题年份',2026).length,0);
});

test('缺公告的工作日不再被推断成法定节假日或累计数值冲突', () => {
  const actor = 'test:calendar';
  trade.upsertTradeDaily({ trade_date: '2025-03-19', volume: 600, turnover: 55200, avg_price: 92,
    session_state: 'traded', source_url: 'https://www.ccer.com.cn/20250319' }, { actor });
  trade.upsertTradeDaily({ trade_date: '2025-03-21', volume: 500, turnover: 42749, avg_price: 85.5,
    session_state: 'traded', source_url: 'https://www.ccer.com.cn/20250321' }, { actor });
  trade.upsertCumulativeReference({ as_of_date: '2025-03-19', volume_total: 1330039, turnover_total: 105412285.42 });
  trade.upsertCumulativeReference({ as_of_date: '2025-03-21', volume_total: 1332669, turnover_total: 105673442.82 });
  trade.rebuildCalendar(['2025-03-19', '2025-03-21'], { importedDates: ['2025-03-19', '2025-03-21'], actor });
  assertEqual(db.get("SELECT day_type FROM trade_calendar WHERE trade_date='2025-03-20'").day_type, 'unknown');
  reconcile.runTradeChecks({ actor });
  assert(db.get("SELECT id FROM data_reconciliation WHERE check_kind='cumulative_interval_incomplete' AND object_id='2025-03-19..2025-03-21' AND status='open'"));
  assertEqual(db.get("SELECT COUNT(*) n FROM data_reconciliation WHERE check_kind='cumulative_gap' AND object_id='2025-03-19..2025-03-21' AND status='open'").n, 0);
});

test('同文号同标题的缺链接旧政策关联官方原件记录，保留法律效力状态', () => {
  const now = new Date().toISOString();
  const title = '关于发布《CCER 测试方法学》的通知';
  const rows = [
    ['POL-test-official', 'test-official', title, '环办气候函〔2025〕999号', 'notice', 'https://www.mee.gov.cn/test.pdf', 'abc123'],
    ['POL-test-stub', 'test-stub', title, '环办气候函〔2025〕999号', 'effective', null, null],
  ];
  for (const r of rows) db.run(`INSERT INTO policy_document
    (id,policy_key,title,doc_number,category,doc_status,official_url,original_file_hash,collected_at,created_at,updated_at)
    VALUES (?,?,?,?,'methodology',?,?,?,?,?,?)`, [r[0],r[1],r[2],r[3],r[4],r[5],r[6],now,now,now]);
  reconcile.runPolicyChecks({ actor: 'test:dedupe' });
  const stub = db.get("SELECT duplicate_of,doc_status FROM policy_document WHERE id='POL-test-stub'");
  assertEqual(stub.duplicate_of, 'POL-test-official');
  assertEqual(stub.doc_status, 'effective', '不得把重复收录误标为政策已废止');
});

await testAsync('管理员 PDF 补充保留来源待核实标记；普通用户与伪 PDF 被拒绝', async () => {
  const now = new Date().toISOString();
  db.run(`INSERT INTO policy_document
    (id,policy_key,title,category,doc_status,collected_at,created_at,updated_at)
    VALUES ('POL-test-upload','test-upload','待补充的公开政策','other','notice',?,?,?)`, [now,now,now]);
  const pdf = Buffer.from('%PDF-1.4\n1 0 obj <<>> endobj\n%%EOF\n').toString('base64');
  const input = { kind: 'policy', id: 'POL-test-upload', file_name: 'notice.pdf', pdf_base64: pdf,
    ocr_text: '待补充的公开政策。该扫描件由管理员提供 OCR 文字，平台不得把这段文字冒充官方原文。'.repeat(5) };
  assertEqual((await upload.uploadDocument({ id: 'viewer', role: 'viewer' }, input)).status, 403);
  assertEqual((await upload.uploadDocument({ id: 'admin', role: 'admin' }, { ...input, pdf_base64: 'not-pdf' })).status, 400);
  const out = await upload.uploadDocument({ id: 'admin', name: '管理员', role: 'admin' }, input);
  assert(out.ok, '合法上传应保存');
  assertEqual(out.source_status, 'admin_supplied_unverified');
  const row = db.get('SELECT * FROM document_upload WHERE id=?', [out.id]);
  assertEqual(row.text_source, 'admin_transcript');
  assertEqual(db.get("SELECT original_file_hash FROM policy_document WHERE id='POL-test-upload'").original_file_hash, null,
    '管理员上传不得冒充已独立核实的官方文件');
});

await testAsync('真实 HTTP 上传入口：管理员可保存文件，普通用户被拒绝', async () => {
  const { server } = await import('../src/server.mjs');
  const auth = await import('../src/services/auth-svc.mjs');
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const adminSession = auth.createSession('user-admin');
  const viewerSession = auth.createSession('user-analyst');
  try {
    const payload = { kind:'policy',id:'POL-test-upload',file_name:'supplement.pdf',
      pdf_base64:Buffer.from('%PDF-1.4\n1 0 obj <<>> endobj\n%%EOF\n').toString('base64'),ocr_text:'待补充的公开政策。管理员补充扫描文字，来源另行记录。'.repeat(8) };
    const send = (token) => fetch(`${base}/api/v2/admin/document-upload`, { method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${token}`},body:JSON.stringify(payload) });
    const denied = await send(viewerSession.token);
    assertEqual(denied.status,403);
    await denied.text();
    const response = await send(adminSession.token);
    assertEqual(response.status,200);
    assert((await response.json()).ok);
  } finally {
    auth.destroySession(adminSession.token);auth.destroySession(viewerSession.token);
    await new Promise((resolve)=>server.close(resolve));
  }
});
// Windows 上等待 HTTP/子进程句柄关闭后，再由测试辅助器退出进程。
await new Promise((resolve) => setTimeout(resolve, 200));
finish('test/29-v2-cloud-evidence-and-upload.test.mjs');
