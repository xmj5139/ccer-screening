/**
 * 120-v2-cea-entity-attachments-memberships.test.mjs —— docs/66 附件与多来源入库
 * ============================================================================
 * 覆盖：
 *   1. 有界 DOCX 解包 + 分页续表（不重复表头）与异常 ZIP/超限/宏拒绝；
 *   2. 山西 multipart PDF 外壳：只解一个完整 PDF，原始 HTTP 哈希与载荷哈希分列；
 *   3. 同一主体多来源/多行业成员关系：保留全部出处，主体仍按信用代码+年度去重；
 *   4. 行业筛选命中成员关系、省名等价、CSV notes 含全部出处；
 *   5. 同源重采幂等、缓存按本来源成员关系去重企业；
 *   6. 旧库成员关系回填（含合并行业拆分）与既有企业字段不改写；
 *   7. 吉林「自备电厂」备注、广东跨行公司名不再丢失/拼入名称。
 *
 * 隔离：setupV2 临时库；回环 stub；DOCX 夹具在系统临时目录生成；不访问生产库。
 */
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  setupV2, finish, test, testAsync, assert, assertEqual, assertIncludes, PROJECT_ROOT,
} from './v2-helpers.mjs';

const ctx = await setupV2();
const { db } = ctx;
const parse = await import('../src/services/cea-parse.mjs');
const collect = await import('../src/services/cea-collect-svc.mjs');
const svc = await import('../src/services/cea-svc.mjs');

process.env.CCER_ALLOW_LOOPBACK_OUTBOUND = '1';
process.env.CCER_CEA_ATTACHMENT_DIR = join(ctx.dir, 'attachments');

console.log('\n[v2-120] 企业名录 DOCX / 包装 PDF / 多来源成员关系');

const PYTHON = process.env.CCER_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const FIXTURE_DIR = mkdtempSync(join(tmpdir(), 'cea-test120-'));
const sha256 = (b) => createHash('sha256').update(b).digest('hex');

function runPython(script, args) {
  const r = spawnSync(PYTHON, ['-c', script, ...args], {
    encoding: 'utf8', timeout: 30000, windowsHide: true, stdio: 'ignore',
  });
  if (r.error) throw new Error(`Python 不可用：${r.error.message}`);
  if (r.status !== 0) throw new Error(`Python 夹具生成失败（退出码 ${r.status}）`);
}

const ZIP_SCRIPT = String.raw`
import sys, zipfile
out_path, xml_path = sys.argv[1:3]
entries = [('[Content_Types].xml', b'<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>'), ('word/document.xml', open(xml_path, 'rb').read())]
mode = sys.argv[3] if len(sys.argv) > 3 else 'normal'
if mode == 'missing-part':
    entries = [e for e in entries if e[0] != 'word/document.xml']
elif mode == 'macro':
    entries.append(('word/vbaProject.bin', b'not a real macro'))
with zipfile.ZipFile(out_path, 'w', zipfile.ZIP_DEFLATED) as z:
    for name, data in entries:
        z.writestr(name, data)
`;

function makeDocx(name, xml, { mode = 'normal', bytesOnly = false } = {}) {
  const xmlPath = join(FIXTURE_DIR, `${name}.document.xml`);
  const outPath = join(FIXTURE_DIR, `${name}.docx`);
  writeFileSync(xmlPath, xml, 'utf8');
  runPython(ZIP_SCRIPT, [outPath, xmlPath, mode]);
  return bytesOnly ? readFileSync(outPath) : outPath;
}

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const xmlEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const wP = (text) => `<w:p><w:r><w:t xml:space="preserve">${xmlEsc(text)}</w:t></w:r></w:p>`;
const wTbl = (rows) => `<w:tbl>${rows.map((cells) => `<w:tr>${cells.map((cell) => `<w:tc>${wP(cell)}</w:tc>`).join('')}</w:tr>`).join('')}</w:tbl>`;
const wDoc = (blocks) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="${W_NS}"><w:body>${blocks.join('')}<w:sectPr/></w:body></w:document>`;

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const routes = new Map();
const hits = [];
const stub = createServer((req, res) => {
  const path = new URL(req.url, 'http://127.0.0.1').pathname;
  hits.push(path);
  const found = routes.get(path);
  if (!found) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
    return;
  }
  res.writeHead(200, { 'content-type': found.type || 'text/html; charset=utf-8' });
  res.end(found.body);
});
await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve));
const STUB = `http://127.0.0.1:${stub.address().port}`;

function insertSource(code, path, { kind = 'official_html', name = null } = {}) {
  const now = new Date().toISOString();
  const sourceName = name || `${code} 2026年度全国碳市场重点排放单位名录`;
  db.run(
    `INSERT INTO cea_source
       (id,code,name,url,dataset,kind,authority,allowed_domains,enabled,priority,created_at,updated_at)
     VALUES (?,?,?,?, 'entity',?,?,?,1,10,?,?)`,
    [`SRC120-${code}`, code, sourceName, `${STUB}${path}`, kind, '测试机关', JSON.stringify(['127.0.0.1']), now, now]
  );
}

function entityHtml(title, sections) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>
${sections.map((s) => `<h2>${s.title || title}</h2><table><tr><th>序号</th><th>企业名称</th><th>统一社会信用代码</th><th>地区</th></tr>
${s.rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</table>`).join('\n')}
</body></html>`;
}

function resetEntityTestData() {
  db.run("UPDATE cea_source SET enabled=0 WHERE dataset='entity'");
  db.run('DELETE FROM cea_entity_membership');
  db.run('DELETE FROM cea_entity_revision');
  db.run('DELETE FROM cea_entity');
  db.run("DELETE FROM data_gap WHERE dataset='cea_entity'");
  db.run("DELETE FROM system_meta WHERE key LIKE 'cea_entity_parse_result:%'");
  routes.clear();
  hits.length = 0;
}

/* ------------------------------------------------------------------ */
/* 1) DOCX + 分页续表                                                   */
/* ------------------------------------------------------------------ */

await testAsync('DOCX 有界解包：分页续表复用上一个明确表头，行为完整入库且缓存按企业去重', async () => {
  resetEntityTestData();
  const rows = [
    ['1', '上海外高桥发电有限责任公司', '91310115132236621M', '4412', '浦东新区'],
    ['2', '上海外高桥第二发电有限责任公司', '91310115632080651P', '4412', '浦东新区'],
    ['3', '宝山钢铁股份有限公司', '91310000631696382C', '3120', '宝山区'],
    ['4', '上海申能临港燃机发电有限公司', '913101157718269277', '4412', '浦东新区'],
  ];
  const xml = wDoc([
    wP('上海市2026年度全国碳排放权交易市场（发电行业）重点排放单位名录'),
    wTbl([['序号', '企业名称', '统一社会信用代码', '国民经济行业分类代码', '地区'], ...rows.slice(0, 2)]),
    '<w:tbl><w:tblPr/><w:tblGrid/></w:tbl>',
    wTbl(rows.slice(2)),
  ]);
  const docxPath = makeDocx('continuation', xml);
  routes.set('/docx-ok', { body: readFileSync(docxPath), type: DOCX_MIME });
  insertSource('test120_docx', '/docx-ok', {
    kind: 'official_docx', name: '上海2026年度全国碳市场重点排放单位名录（发电）',
  });

  const out = await collect.collectCeaEntities({ actor: 'test', codes: ['test120_docx'], trigger: 'manual' });
  assertEqual(out.entities_created, 4, JSON.stringify(out.sources));
  assertEqual(out.sources[0].kind, 'docx');
  assertEqual(out.sources[0].rows, 4, '续表 3/4 行不得丢失');
  const got = db.all("SELECT name,list_year,province,sector FROM cea_entity WHERE source_code='test120_docx' ORDER BY name");
  assertEqual(got.length, 4);
  assertEqual(got[0].list_year, 2026);
  assertEqual(got[0].province, '上海');
  assert(got.every((r) => r.sector === '发电'), 'DOCX 分节行业应写入主体');
  assert(got.some((r) => r.name === '宝山钢铁股份有限公司'), '续表首行必须继续解析');

  const cache = JSON.parse(db.get("SELECT value FROM system_meta WHERE key='cea_entity_parse_result:test120_docx'").value);
  assertEqual(cache.complete, true);
  assertEqual(cache.rows, 4);
  assertEqual(cache.entities, 4);
  assertIncludes(cache.parser, 'docx');

  const membershipsBefore = db.get("SELECT COUNT(*) AS n FROM cea_entity_membership WHERE source_code='test120_docx'").n;
  assertEqual(membershipsBefore, 4);
  const again = await collect.collectCeaEntities({ actor: 'test', codes: ['test120_docx'], trigger: 'manual' });
  assertEqual(again.entities_created + again.entities_updated, 0, '同 hash 重采不得重复写入');
  assertEqual(again.unchanged, 4, '缓存应按成员关系去重企业计数');
  assertEqual(db.get("SELECT COUNT(*) AS n FROM cea_entity_membership WHERE source_code='test120_docx'").n, membershipsBefore);
});

test('DOCX 异常拒绝：无效 ZIP、缺 document.xml、宏、超限都必须失败且不进 HTML 解析', () => {
  const bad = collect.extractDocxEntityHtml(Buffer.from('not a zip'), {});
  assertEqual(bad.ok, false);
  assertEqual(bad.reason, 'invalid_docx');
  assertIncludes(bad.message, 'invalid zip');

  const minus = collect.extractDocxEntityHtml(makeDocx('missing', wDoc([wP('x')]), { mode: 'missing-part', bytesOnly: true }), {});
  assertEqual(minus.ok, false);
  assertIncludes(minus.message, 'missing docx part');

  const macro = collect.extractDocxEntityHtml(makeDocx('macro', wDoc([wP('x')]), { mode: 'macro', bytesOnly: true }), {});
  assertEqual(macro.ok, false);
  assertIncludes(macro.message, 'macro');

  const good = readFileSync(makeDocx('limit', wDoc([wP('x')])));
  const tooLarge = collect.extractDocxEntityHtml(good, { maxBytes: 16 });
  assertEqual(tooLarge.ok, false);
  assertEqual(tooLarge.reason, 'docx_too_large');
});

await testAsync('DOCX 坏件在采集路径登记 parse gap，不把二进制当 HTML 成功入库', async () => {
  resetEntityTestData();
  routes.set('/docx-bad', { body: Buffer.from('this is not a docx'), type: DOCX_MIME });
  insertSource('test120_docx_bad', '/docx-bad', {
    kind: 'official_docx', name: '上海2026年度全国碳市场重点排放单位名录（发电）',
  });
  const out = await collect.collectCeaEntities({ actor: 'test', codes: ['test120_docx_bad'], trigger: 'manual' });
  assertEqual(out.parse_gaps.length, 1);
  assertEqual(out.parse_gaps[0].kind, 'docx');
  assertEqual(out.parse_gaps[0].reason, 'invalid_docx');
  assertEqual(db.get("SELECT COUNT(*) AS n FROM cea_entity WHERE source_code='test120_docx_bad'").n, 0);
  assertEqual(db.get("SELECT COUNT(*) AS n FROM data_gap WHERE dataset='cea_entity' AND status='open'").n, 1);
});

/* ------------------------------------------------------------------ */
/* 2) 山西 multipart PDF 外壳                                           */
/* ------------------------------------------------------------------ */

test('山西真实样本：multipart 只解出单个完整 PDF，原始哈希与载荷哈希分开', () => {
  const base = join(PROJECT_ROOT, 'data', 'backups', 'cea-directory-20261020', 'raw');
  const raw = readFileSync(join(base, 'shanxi_a1.html'));
  const payload = readFileSync(join(base, 'shanxi_a1.pdf'));
  const decoded = collect.unwrapCeaMultipartPdf({
    buf: raw,
    content_type: 'multipart/form-data; boundary=xRJGZ8Yjbl9hkWPrBd-du5vL4UCBDr0c',
    hash: sha256(raw),
  });
  assertEqual(decoded.ok, true, JSON.stringify(decoded));
  assertEqual(decoded.transport, 'multipart');
  assertEqual(decoded.filename, 'h836.pdf');
  assertEqual(decoded.payload_bytes, payload.length);
  assertEqual(decoded.hash, sha256(payload), '载荷哈希必须对应解码后的 PDF（含证据文件保留的边界前 CRLF）');
  assertEqual(decoded.raw_hash, sha256(raw), '原始 HTTP 哈希不得被载荷哈希替换');
  assert(decoded.raw_hash !== decoded.hash, '外壳哈希与载荷哈希必须可区分');
});

await testAsync('山西包装 PDF 损坏时采集路径留缺口，不把外壳当 HTML 解析', async () => {
  resetEntityTestData();
  const base = join(PROJECT_ROOT, 'data', 'backups', 'cea-directory-20261020', 'raw');
  const raw = readFileSync(join(base, 'shanxi_a1.html'));
  routes.set('/pdf-bad', { body: raw.subarray(0, raw.length - 80), type: 'multipart/form-data; boundary=xRJGZ8Yjbl9hkWPrBd-du5vL4UCBDr0c' });
  insertSource('test120_pdf_bad', '/pdf-bad', {
    kind: 'official_pdf', name: '山西2026年度全国碳市场重点排放单位名录（发电、钢铁、水泥、铝冶炼）',
  });
  const out = await collect.collectCeaEntities({ actor: 'test', codes: ['test120_pdf_bad'], trigger: 'manual' });
  assertEqual(out.parse_gaps.length, 1);
  assertEqual(out.parse_gaps[0].kind, 'pdf_wrapper');
  assertEqual(out.parse_gaps[0].reason, 'multipart_incomplete');
  assertEqual(db.get("SELECT COUNT(*) AS n FROM cea_entity WHERE source_code='test120_pdf_bad'").n, 0);
  assertEqual(db.get("SELECT COUNT(*) AS n FROM data_gap WHERE dataset='cea_entity' AND status='open'").n, 1);
});

test('multipart 异常：多附件、截断、非 PDF、超限一律失败', () => {
  const boundary = 'BOUND120';
  const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n', 'latin1');
  const part = (name, type, body) => Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: ${type}\r\n\r\n`, 'latin1'),
    body,
    Buffer.from('\r\n', 'latin1'),
  ]);
  const single = Buffer.concat([part('a.pdf', 'application/pdf', pdf), Buffer.from(`--${boundary}--\r\n`)]);
  const ok = collect.unwrapCeaMultipartPdf({ buf: single, content_type: `multipart/form-data; boundary=${boundary}`, hash: 'raw' });
  assertEqual(ok.ok, true);
  assertEqual(ok.hash, sha256(Buffer.concat([pdf, Buffer.from('\r\n')])));

  const multi = Buffer.concat([part('a.pdf', 'application/pdf', pdf), part('b.pdf', 'application/pdf', pdf), Buffer.from(`--${boundary}--\r\n`)]);
  const multiple = collect.unwrapCeaMultipartPdf({ buf: multi, content_type: `multipart/form-data; boundary=${boundary}` });
  assertEqual(multiple.ok, false, `多附件必须失败：${multiple.reason}`);
  assertEqual(multiple.reason, 'multipart_multiple_parts');

  const truncated = single.subarray(0, single.length - boundary.length - 6);
  const cut = collect.unwrapCeaMultipartPdf({ buf: truncated, content_type: `multipart/form-data; boundary=${boundary}` });
  assertEqual(cut.ok, false, `截断必须失败：${cut.reason}`);
  assert(['multipart_incomplete', 'multipart_bad_headers'].includes(cut.reason), cut.reason);

  const notPdf = Buffer.concat([part('a.html', 'text/html', Buffer.from('<html></html>')), Buffer.from(`--${boundary}--\r\n`)]);
  const typeErr = collect.unwrapCeaMultipartPdf({ buf: notPdf, content_type: `multipart/form-data; boundary=${boundary}` });
  assertEqual(typeErr.ok, false, `非 PDF 必须失败：${typeErr.reason}`);
  assertEqual(typeErr.reason, 'multipart_not_pdf');

  const huge = collect.unwrapCeaMultipartPdf(
    { buf: single, content_type: `multipart/form-data; boundary=${boundary}` },
    { maxPayloadBytes: 10 }
  );
  assertEqual(huge.ok, false, `超限必须失败：${huge.reason}`);
  assertEqual(huge.reason, 'pdf_payload_too_large');
});

/* ------------------------------------------------------------------ */
/* 3) 多来源成员关系、筛选、CSV、省名等价、缓存                          */
/* ------------------------------------------------------------------ */

await testAsync('同一主体两个来源：成员关系/出处全保留，行业筛选与省名等价命中，CSV notes 含全部链接', async () => {
  resetEntityTestData();
  const code = '91140000701011888X';
  routes.set('/multi/power', {
    body: Buffer.from(entityHtml('山西省2026年度全国碳排放权交易市场（发电行业）重点排放单位名录', [{
      rows: [['1', '山西多源测试有限公司', code, '太原市']],
    }])),
  });
  routes.set('/multi/steel', {
    body: Buffer.from(entityHtml('山西省2026年度全国碳排放权交易市场（钢铁行业）重点排放单位名录', [{
      rows: [['1', '山西多源测试有限公司', code, '太原市']],
    }])),
  });
  insertSource('test120_multi_a', '/multi/power', { name: '山西2026年度全国碳市场重点排放单位名录（发电）' });
  insertSource('test120_multi_b', '/multi/steel', { name: '山西2026年度全国碳市场重点排放单位名录（钢铁）' });

  const out = await collect.collectCeaEntities({
    actor: 'test', codes: ['test120_multi_a', 'test120_multi_b'], trigger: 'manual',
  });
  assertEqual(out.entities_created, 1);
  assertEqual(out.entities_updated, 1);
  assertEqual(db.get('SELECT COUNT(*) AS n FROM cea_entity').n, 1);
  const entity = db.get('SELECT * FROM cea_entity');
  assertEqual(entity.sector, '发电、钢铁');
  const mem = db.all("SELECT source_code,sector,source_url FROM cea_entity_membership ORDER BY source_code");
  assertEqual(mem.length, 2);
  assertEqual(mem.map((m) => m.sector).join(','), '发电,钢铁');
  assert(mem.every((m) => m.source_url.startsWith(STUB)), '每条成员关系保留各自来源 URL');

  const power = svc.listCeaEntities({ sector: '发电' });
  assertEqual(power.total, 1, '行业筛选必须命中成员关系，不能只比主体最后 source_code/sector');
  assertEqual(power.rows[0].source_memberships.length, 2);
  assertEqual(power.rows[0].source_memberships.map((m) => m.sector).join(','), '发电,钢铁');
  assertEqual(svc.listCeaEntities({ sector: '钢铁' }).total, 1);
  assertEqual(svc.listCeaEntities({ sector: '水泥' }).total, 0);
  assertEqual(power.rows[0].source_url, `${STUB}/multi/steel`, '原 source_url 保持兼容（最后一次来源）');

  db.run("UPDATE cea_entity SET province='山西省'");
  assertEqual(svc.listCeaEntities({ province: '山西' }).total, 1, '短省名应命中全称');
  assertEqual(svc.listCeaEntities({ province: '山西省' }).total, 1, '全称应命中');
  assertEqual(svc.listCeaEntities({ province: '山' }).total, 0, '不得退化为任意 LIKE 模糊匹配');
  db.run("UPDATE cea_entity SET province='山西'");
  assertEqual(svc.listCeaEntities({ province: '山西省' }).total, 1, '全称查询应命中短省名');

  const exported = svc.ceaExportRows('entities', { sector: '发电' });
  assert(exported.columns.some((c) => c.key === 'notes'), 'CSV 必须有 notes 列');
  assertEqual(exported.rows.length, 1, '企业数按主体计，不按成员关系行数计');
  assertIncludes(exported.rows[0].notes, `${STUB}/multi/power`);
  assertIncludes(exported.rows[0].notes, `${STUB}/multi/steel`);

  // 第二个来源已覆盖主体行的 source_code/source_hash；第一个来源的缓存命中必须按成员关系判断。
  const again = await collect.collectCeaEntities({ actor: 'test', codes: ['test120_multi_a'], trigger: 'manual' });
  assertEqual(again.unchanged, 1, '同主体多来源时，本来源 hash 未变仍应命中缓存');
  assertEqual(again.entities_created + again.entities_updated, 0);
  assertEqual(db.get("SELECT COUNT(*) AS n FROM cea_entity_membership WHERE source_code='test120_multi_a'").n, 1);
  assertEqual(db.get('SELECT COUNT(*) AS n FROM cea_entity').n, 1);
});

await testAsync('同一来源同一主体跨行业：解析阶段合并行业/行出处，入库仍 1 主体并拆成员关系', async () => {
  resetEntityTestData();
  const code = '91140000701011888X';
  const html = entityHtml('山西省2026年度全国碳排放权交易市场重点排放单位名录', [
    { title: '山西省2026年度全国碳排放权交易市场（发电行业）重点排放单位名录', rows: [['1', '山西同源测试有限公司', code, '太原市']] },
    { title: '山西省2026年度全国碳排放权交易市场（钢铁行业）重点排放单位名录', rows: [['1', '山西同源测试有限公司', code, '太原市']] },
  ]);
  const parsed = parse.parseEntityRows(html, { listYear: 2026, province: '山西', sector: null });
  assertEqual(parsed.length, 1, '同一原件内同代码只保留 1 个主体');
  assertEqual(parsed[0].sector, '发电、钢铁');
  assertEqual(parsed[0].sectors.join(','), '发电,钢铁');
  assertEqual(parsed[0].row_sources.length, 2, '两行出处不得只留最后一行');
  assertEqual(parsed[0].row_sources.map((r) => r.sector).join(','), '发电,钢铁');

  routes.set('/same-source', { body: Buffer.from(html) });
  insertSource('test120_same', '/same-source', { name: '山西2026年度全国碳市场重点排放单位名录' });
  const out = await collect.collectCeaEntities({ actor: 'test', codes: ['test120_same'], trigger: 'manual' });
  assertEqual(out.entities_created, 1);
  assertEqual(out.sources[0].rows, 1, '解析行数按主体去重');
  const cache = JSON.parse(db.get("SELECT value FROM system_meta WHERE key='cea_entity_parse_result:test120_same'").value);
  assertEqual(cache.entities, 1);
  assertEqual(cache.rows, 1);
  assertEqual(db.get('SELECT sector FROM cea_entity').sector, '发电、钢铁');
  assertEqual(db.get("SELECT COUNT(*) AS n FROM cea_entity_membership WHERE source_code='test120_same'").n, 2);

  const again = await collect.collectCeaEntities({ actor: 'test', codes: ['test120_same'], trigger: 'manual' });
  assertEqual(again.unchanged, 1);
  assertEqual(again.entities_created + again.entities_updated, 0);
  assertEqual(db.get("SELECT COUNT(*) AS n FROM cea_entity_membership WHERE source_code='test120_same'").n, 2);
});

/* ------------------------------------------------------------------ */
/* 4) 旧库回填                                                         */
/* ------------------------------------------------------------------ */

test('旧库回填：按原 source_code 字段建成员关系并把「发电、钢铁」拆开；重复执行幂等', () => {
  db.run('DELETE FROM cea_entity_membership');
  db.run('DELETE FROM cea_entity_revision');
  db.run('DELETE FROM cea_entity');
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO cea_entity
       (id,entity_key,name,credit_code,province,city,sector,list_year,status,source_code,source_url,
        source_hash,snapshot_id,note,created_at,updated_at)
     VALUES ('CEAENT120LEGACY','91140000701011888X','山西太钢不锈钢股份有限公司','91140000701011888X',
             '山西','太原市','发电、钢铁',2026,'existing','legacy_src','https://example.invalid/legacy',
             'legacyhash','snap-legacy','旧库原始备注',?,?)`,
    [now, now]
  );
  const first = ctx.db.backfillCeaEntityMemberships(ctx.db.getDb());
  assertEqual(first, 2, '合并行业应拆成 2 条成员关系');
  const mem = db.all("SELECT sector,source_url,source_hash,snapshot_id,note FROM cea_entity_membership WHERE source_code='legacy_src' ORDER BY sector");
  assertEqual(mem.length, 2);
  assertEqual(mem.map((m) => m.sector).sort().join(','), '发电,钢铁');
  assertEqual(mem[0].source_url, 'https://example.invalid/legacy');
  assertEqual(mem[0].source_hash, 'legacyhash');
  assertEqual(mem[0].snapshot_id, 'snap-legacy');
  assertEqual(db.get('SELECT sector,source_code FROM cea_entity').sector, '发电、钢铁', '回填不得改写既有企业行');
  assertEqual(svc.listCeaEntities({ sector: '钢铁' }).total, 1);
  assertEqual(svc.listCeaEntities({ sector: '发电' }).total, 1);
  assertEqual(ctx.db.backfillCeaEntityMemberships(ctx.db.getDb()), 0, '重复回填必须幂等');
  assertEqual(db.get("SELECT COUNT(*) AS n FROM cea_entity_membership WHERE source_code='legacy_src'").n, 2);
});

/* ------------------------------------------------------------------ */
/* 5) 真实 PDF 中的名称修整                                             */
/* ------------------------------------------------------------------ */

test('吉林「自备电厂」备注不得拼入名称；广东跨行名称+右侧备注仍合并完整', () => {
  const jilin = `吉林省 2026 年度全国碳排放权交易市场（发电行业）
重点排放单位名录
序号 企业名称 统一社会信用代码 核算行业 备注
4       长春大合生物技术开发有限公司      91220101748435207W
                                                      自备电厂`;
  const jilinRows = parse.parseEntityRows(jilin, { listYear: 2026, province: '吉林', sector: '发电' });
  assertEqual(jilinRows.length, 1);
  assertEqual(jilinRows[0].name, '长春大合生物技术开发有限公司');
  assert(!jilinRows[0].name.includes('自备电厂'));

  const guangdong = `广东省 2026 年度全国碳排放权交易市场（发电行业）
重点排放单位名录
序号 企业名称 统一社会信用代码 国民经济行业分类代码 备注
50   佛山市顺德金纺集团有限公司      914406062799889835   电力（44）
                                                      电厂
     佛山市佳利达环保科技股份有限                                   自备
51                      914406007436594208   电力（44）
            公司                                        电厂
52     佛山市福能发电有限公司      914406007536647339   电力（44）`;
  const gdRows = parse.parseEntityRows(guangdong, { listYear: 2026, province: '广东', sector: '发电' });
  assertEqual(gdRows.length, 3);
  const jialida = gdRows.find((r) => r.credit_code === '914406007436594208');
  assert(jialida, '跨行公司名不得丢失');
  assertEqual(jialida.name, '佛山市佳利达环保科技股份有限公司');
});

stub.close();
rmSync(FIXTURE_DIR, { recursive: true, force: true });
finish('120-v2-cea-entity-attachments-memberships.test.mjs');
