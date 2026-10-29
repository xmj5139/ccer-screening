/**
 * 独立 PDF 表格 worker（docs/86 第二阶段第 3 节）
 * ============================================================================
 * 真实执行本机 python + pdfplumber（不是空远程接口）：
 *   · 输入只接受受限原件根内路径（official-originals、管理员上传、经授权的
 *     验收样本根），realpath 后再做前缀校验，阻止 ../ 与符号链接越界；
 *   · 严格文件大小、页数、执行超时、单进程并发与输出上限；
 *   · 输出保留物理页码、表序号、行列、单元格文本、成功/失败页与真实 coverage；
 *   · 扫描/空白页只标 no_text_layer/empty，绝不推断“零家企业”；
 *   · 失败/超时保留原件与既有正文，不把结果覆盖成全空。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import { dbPath, get, all, run, audit, PROJECT_ROOT } from '../core/db.mjs';
import { newId, nowIso } from '../core/util.mjs';
import { runToolToFile } from './exec-tool.mjs';

export const PDF_TABLE_LIMITS = {
  max_bytes: 20 * 1024 * 1024,
  max_pages: 500,
  default_max_pages: 200,
  max_output_bytes: 16 * 1024 * 1024,
  timeout_ms: 120000,
  min_timeout_ms: 5000,
  max_timeout_ms: 180000,
  concurrency: 1,
};

const WORKER_SCRIPT = join(PROJECT_ROOT, 'scripts', 'pdf-table-worker.py');

let activeJobId = null;

function fail(error, status = 400) {
  return { ok: false, error, status };
}

export function pdfTableRoots() {
  const roots = [resolve(dirname(dbPath()), 'official-originals')];
  if (process.env.CCER_PDF_TABLE_ALLOW_SAMPLES === '1') {
    roots.push(resolve(PROJECT_ROOT, 'data', 'backups', 'intelligence-20261029', 'samples'));
  }
  return [...new Set(roots)];
}

function isWithin(root, target) {
  const norm = (p) => (process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p));
  const r = norm(root);
  const t = norm(target);
  return t === r || t.startsWith(`${r}${sep}`);
}

/**
 * 校验并解析一个受限 PDF 路径。不存在/目录/非 PDF/超大小/越界都返回明确错误。
 * @returns {{ok:true,path:string,name:string,size:number}|{ok:false,error:string,status:number}}
 */
export function resolveRestrictedPdf(filePath) {
  if (!filePath || typeof filePath !== 'string') return fail('缺少 PDF 文件路径', 400);
  const abs = resolve(filePath);
  if (!existsSync(abs)) return fail('PDF 原件不存在', 404);
  let real;
  try {
    real = realpathSync(abs);
  } catch (e) {
    return fail(`无法解析 PDF 真实路径：${e.message}`, 400);
  }
  const roots = pdfTableRoots().map((r) => {
    try { return existsSync(r) ? realpathSync(r) : resolve(r); } catch { return resolve(r); }
  });
  if (!roots.some((root) => isWithin(root, real))) {
    return fail('PDF 路径不在受限原件根内（拒绝 ../、符号链接越界与任意路径）', 403);
  }
  let st;
  try { st = statSync(real); } catch (e) { return fail(`无法读取 PDF 文件信息：${e.message}`, 400); }
  if (!st.isFile()) return fail('目标不是普通文件', 400);
  if (String(extname(real)).toLowerCase() !== '.pdf') return fail('只接受 .pdf 文件', 400);
  if (st.size <= 0) return fail('PDF 文件为空', 400);
  if (st.size > PDF_TABLE_LIMITS.max_bytes) {
    return fail(`PDF 超过 ${Math.round(PDF_TABLE_LIMITS.max_bytes / 1024 / 1024)} MB 上限`, 413);
  }
  return { ok: true, path: real, name: basename(real), size: st.size };
}

function targetPath(kind, id) {
  if (!kind || !id) return null;
  if (kind === 'policy') {
    const row = get('SELECT id,title,local_path FROM policy_document WHERE id=?', [String(id)]);
    if (!row) return null;
    const attachment = get(
      'SELECT id,local_path,file_name FROM policy_attachment WHERE policy_id=? AND local_path IS NOT NULL ORDER BY created_at DESC LIMIT 1',
      [String(id)]
    );
    return { path: row.local_path || attachment?.local_path || null, title: row.title };
  }
  if (kind === 'policy_attachment') {
    const row = get(
      `SELECT a.id,a.local_path,a.file_name,p.title FROM policy_attachment a
         JOIN policy_document p ON p.id=a.policy_id WHERE a.id=?`,
      [String(id)]
    );
    return row ? { path: row.local_path, title: row.title || row.file_name } : null;
  }
  if (kind === 'methodology') {
    const row = get('SELECT id,name,original_file_path FROM methodology_version WHERE id=?', [String(id)]);
    return row ? { path: row.original_file_path, title: row.name } : null;
  }
  if (kind === 'cea_document') {
    const row = get('SELECT id,title,attachment_path FROM cea_document WHERE id=?', [String(id)]);
    return row ? { path: row.attachment_path, title: row.title } : null;
  }
  if (kind === 'document_upload') {
    const row = get('SELECT id,file_name,local_path FROM document_upload WHERE id=?', [String(id)]);
    return row ? { path: row.local_path, title: row.file_name } : null;
  }
  return null;
}

/** 后台候选：只列真实存在、且在受限根内的原件。 */
export function listPdfTableCandidates({ limit = 100 } = {}) {
  const max = Math.max(1, Math.min(Number(limit) || 100, 200));
  const candidates = [];
  const seen = new Set();
  const push = (kind, row, path, title) => {
    if (!path || seen.has(String(path))) return;
    const checked = resolveRestrictedPdf(path);
    if (!checked.ok) return;
    seen.add(String(path));
    candidates.push({
      kind, id: String(row.id), title: title || row.title || row.name || row.file_name || checked.name,
      file_name: checked.name, size: checked.size, path: checked.path,
      size_label: `${(checked.size / 1024).toFixed(1)} KB`,
    });
  };
  for (const row of all('SELECT id,title,local_path FROM policy_document WHERE local_path IS NOT NULL ORDER BY updated_at DESC LIMIT ?', [max])) {
    push('policy', row, row.local_path, row.title);
  }
  for (const row of all(
    `SELECT a.id,a.file_name,a.local_path,p.title FROM policy_attachment a
       JOIN policy_document p ON p.id=a.policy_id
      WHERE a.local_path IS NOT NULL ORDER BY a.created_at DESC LIMIT ?`, [max]
  )) push('policy_attachment', { id: row.id, title: row.title }, row.local_path, row.title || row.file_name);
  for (const row of all('SELECT id,name,original_file_path FROM methodology_version WHERE original_file_path IS NOT NULL ORDER BY updated_at DESC LIMIT ?', [max])) {
    push('methodology', row, row.original_file_path, row.name);
  }
  for (const row of all('SELECT id,title,attachment_path FROM cea_document WHERE attachment_path IS NOT NULL ORDER BY updated_at DESC LIMIT ?', [max])) {
    push('cea_document', row, row.attachment_path, row.title);
  }
  for (const row of all('SELECT id,file_name,local_path FROM document_upload ORDER BY created_at DESC LIMIT ?', [max])) {
    push('document_upload', row, row.local_path, row.file_name);
  }
  return {
    candidates: candidates.slice(0, max),
    roots: pdfTableRoots(),
    limits: PDF_TABLE_LIMITS,
    note: '只列受限原件根内真实存在的 PDF；上传文件先在「PDF 解析/OCR」或原件补充入口归档。',
  };
}

function pythonEnv() {
  const pkg = join(PROJECT_ROOT, 'data', 'runtime', 'python-packages');
  const env = {
    PATH: process.env.PATH || '',
    SystemRoot: process.env.SystemRoot || process.env.SYSTEMROOT || '',
    WINDIR: process.env.WINDIR || process.env.SystemRoot || '',
    TEMP: process.env.TEMP || tmpdir(),
    TMP: process.env.TMP || tmpdir(),
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1',
  };
  if (existsSync(pkg)) env.PYTHONPATH = pkg;
  return env;
}

function hashFile(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function jobOut(row) {
  if (!row) return null;
  return {
    id: row.id, target_kind: row.target_kind, target_id: row.target_id,
    file_name: row.file_name, file_hash: row.file_hash, file_size: row.file_size,
    status: row.status, parser: row.parser, parser_version: row.parser_version,
    pages_total: row.pages_total, pages_processed: row.pages_processed,
    pages_with_tables: row.pages_with_tables, pages_failed: row.pages_failed,
    table_count: row.table_count, row_count: row.row_count, cell_count: row.cell_count,
    coverage_ratio: row.coverage_ratio, partial_reason: row.partial_reason,
    error: row.error, requested_by: row.requested_by,
    started_at: row.started_at, finished_at: row.finished_at,
    created_at: row.created_at, updated_at: row.updated_at,
    coverage_label: `${Math.round(Number(row.coverage_ratio || 0) * 1000) / 10}%`,
    coverage_note: '页处理率（pages_processed/pages_total），不是正文完整率；扫描件也可能 100% 但无文本层。',
    // 扫描空页不是“零家企业”：把结论边界单独返回，前端不得自行补结论。
    enterprise_conclusion: row.status === 'done' && row.table_count > 0
      ? 'tables_extracted' : (row.partial_reason === 'no_text_layer_or_tables' ? 'unknown_no_text_layer' : 'unknown'),
    zero_enterprises_claim_allowed: row.status === 'done' && row.table_count > 0,
  };
}

async function runWorker({ path, maxPages, timeoutMs }) {
  const outFile = join(tmpdir(), `ccer-pdftable-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`);
  try {
    const args = [
      '-X', 'utf8', WORKER_SCRIPT,
      '--file', path,
      '--out', outFile,
      '--max-pages', String(maxPages),
      '--max-tables', '2000',
      '--max-cells', '200000',
      '--timeout-sec', String(Math.max(1, Math.floor(timeoutMs / 1000) - 1)),
    ];
    const r = await runToolToFile(process.env.CCER_PYTHON || 'python', args, {
      timeoutMs, tag: 'pdftable', env: pythonEnv(),
    });
    if (!r.ok) {
      return {
        ok: false,
        error: r.timedOut
          ? `PDF 表格 worker 超时（${timeoutMs}ms），未写入任何表格结果`
          : r.missing
            ? '未找到 Python 可执行文件（可设置 CCER_PYTHON；未安装/未运行不伪装成功）'
            : (r.error || 'PDF 表格 worker 执行失败'),
        timed_out: !!r.timedOut,
        aborted: r.timedOut ? 'timeout' : null,
      };
    }
    if (!existsSync(outFile)) return { ok: false, error: 'worker 未生成输出文件' };
    const st = statSync(outFile);
    if (st.size > PDF_TABLE_LIMITS.max_output_bytes) {
      return { ok: false, error: `worker 输出超过 ${PDF_TABLE_LIMITS.max_output_bytes} 字节上限`, aborted: 'output_too_large' };
    }
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(outFile, 'utf8'));
    } catch (e) {
      return { ok: false, error: `worker 输出不是合法 JSON：${e.message}` };
    }
    return { ok: true, parsed };
  } finally {
    try { rmSync(outFile, { force: true }); } catch { /* ignore */ }
  }
}

function persistTables(jobId, parsed, now) {
  let tableCount = 0;
  for (const page of parsed.pages || []) {
    run(
      `INSERT INTO pdf_table_page
         (id,job_id,page,width,height,table_count,row_count,cell_count,text_chars,
          has_text_layer,status,error,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(job_id,page) DO UPDATE SET
         width=excluded.width,height=excluded.height,table_count=excluded.table_count,
         row_count=excluded.row_count,cell_count=excluded.cell_count,text_chars=excluded.text_chars,
         has_text_layer=excluded.has_text_layer,status=excluded.status,error=excluded.error`,
      [
        newId('PTP'), jobId, Number(page.page), page.width || null, page.height || null,
        Number(page.table_count || 0), Number(page.row_count || 0), Number(page.cell_count || 0),
        Number(page.text_chars || 0), page.has_text_layer ? 1 : 0,
        page.status || 'ok', page.error || null, now,
      ]
    );
    for (const table of page.tables || []) {
      tableCount += 1;
      run(
        `INSERT INTO pdf_table
           (id,job_id,page,table_index,row_count,col_count,cells_json,rows_json,bbox_json,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(job_id,page,table_index) DO UPDATE SET
           row_count=excluded.row_count,col_count=excluded.col_count,
           cells_json=excluded.cells_json,rows_json=excluded.rows_json,bbox_json=excluded.bbox_json`,
        [
          newId('PTB'), jobId, Number(page.page), Number(table.table_index),
          Number(table.rows || 0), Number(table.cols || 0),
          JSON.stringify(table.cells || []), JSON.stringify(table.data || []), null, now,
        ]
      );
    }
  }
  return tableCount;
}

/**
 * 管理员显式触发一次 PDF 表格解析（单进程并发）。成功/失败都写任务记录。
 * @param {{id:string,role:string,name?:string}} user
 * @param {{targetKind?:string,targetId?:string,path?:string,maxPages?:number,timeoutMs?:number}} payload
 */
export async function runPdfTableJob(user, payload = {}) {
  if (user?.role !== 'admin') return fail('仅管理员可触发 PDF 表格解析', 403);
  if (activeJobId) return fail(`已有 PDF 表格任务运行中（${activeJobId}）；单并发限制，请稍后重试`, 409);
  const targetKind = payload.targetKind || payload.target_kind || null;
  const targetId = payload.targetId || payload.target_id || null;
  let filePath = payload.path ? String(payload.path) : null;
  let titleHint = null;
  if (!filePath && targetKind && targetId) {
    const target = targetPath(targetKind, targetId);
    if (!target) return fail('目标对象不存在或没有已归档原件', 404);
    filePath = target.path;
    titleHint = target.title;
  }
  const checked = resolveRestrictedPdf(filePath);
  if (!checked.ok) return checked;
  const maxPages = Math.max(1, Math.min(Number(payload.maxPages || payload.max_pages) || PDF_TABLE_LIMITS.default_max_pages, PDF_TABLE_LIMITS.max_pages));
  const timeoutMs = Math.max(
    PDF_TABLE_LIMITS.min_timeout_ms,
    Math.min(Number(payload.timeoutMs || payload.timeout_ms) || PDF_TABLE_LIMITS.timeout_ms, PDF_TABLE_LIMITS.max_timeout_ms)
  );
  const jobId = newId('PTJ');
  const now = nowIso();
  let hash;
  try { hash = hashFile(checked.path); } catch (e) { return fail(`读取 PDF 失败：${e.message}`, 400); }
  run(
    `INSERT INTO pdf_table_job
       (id,target_kind,target_id,file_path,file_name,file_hash,file_size,status,parser,
        pages_total,pages_processed,pages_with_tables,pages_failed,table_count,row_count,
        cell_count,coverage_ratio,partial_reason,error,requested_by,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      jobId, targetKind, targetId, checked.path, checked.name, hash, checked.size, 'queued',
      'pdfplumber', 0, 0, 0, 0, 0, 0, 0, 0, null, null, user.name || user.id, now, now,
    ]
  );
  activeJobId = jobId;
  run('UPDATE pdf_table_job SET status=?,started_at=?,updated_at=? WHERE id=?', ['running', now, now, jobId]);
  try {
    const out = await runWorker({ path: checked.path, maxPages, timeoutMs });
    const finished = nowIso();
    if (!out.ok) {
      run(
        `UPDATE pdf_table_job SET status=?,error=?,partial_reason=?,finished_at=?,updated_at=? WHERE id=?`,
        ['failed', out.error, out.aborted || null, finished, finished, jobId]
      );
      audit({
        actor: user.name || user.id, action: 'pdf_table.run', objectType: 'pdf_table_job',
        objectId: jobId, result: 'warning',
        detail: { path: checked.path, hash, max_pages: maxPages, timeout_ms: timeoutMs, error: out.error, aborted: out.aborted || null },
      });
      return { ok: false, job: jobOut(get('SELECT * FROM pdf_table_job WHERE id=?', [jobId])), error: out.error, status: out.timed_out ? 504 : 502 };
    }
    const parsed = out.parsed || {};
    const pagesTotal = Number(parsed.pages_total || 0);
    const pagesProcessed = Number(parsed.pages_processed || 0);
    const pagesFailed = Number(parsed.pages_failed || 0);
    const tables = persistTables(jobId, parsed, finished);
    let status = 'done';
    let partialReason = null;
    if (!pagesProcessed) {
      status = 'failed';
      partialReason = 'no_pages_processed';
    } else if (parsed.aborted === 'timeout' || parsed.aborted === 'output_too_large' || parsed.aborted === 'max_tables' || parsed.aborted === 'max_cells') {
      status = 'partial'; partialReason = parsed.aborted;
    } else if (pagesTotal > pagesProcessed) {
      status = 'partial'; partialReason = 'page_limit';
    } else if (pagesFailed > 0) {
      status = 'partial'; partialReason = 'page_failures';
    } else if (!(parsed.pages || []).some((p) => p.has_text_layer || Number(p.table_count) > 0)) {
      status = 'partial'; partialReason = 'no_text_layer_or_tables';
    } else if (parsed.error) {
      status = 'partial'; partialReason = 'worker_error';
    }
    const coverage = pagesTotal > 0 ? Math.min(1, pagesProcessed / pagesTotal) : 0;
    const error = parsed.error || null;
    run(
      `UPDATE pdf_table_job SET status=?,parser=?,parser_version=?,pages_total=?,pages_processed=?,
         pages_with_tables=?,pages_failed=?,table_count=?,row_count=?,cell_count=?,coverage_ratio=?,
         partial_reason=?,output_json=?,error=?,finished_at=?,updated_at=? WHERE id=?`,
      [
        status, parsed.parser || 'pdfplumber', parsed.parser_version || null,
        pagesTotal, pagesProcessed, Number(parsed.pages_with_tables || 0), pagesFailed,
        tables, Number(parsed.row_count || 0), Number(parsed.cell_count || 0), coverage,
        partialReason, JSON.stringify(parsed), error, finished, finished, jobId,
      ]
    );
    audit({
      actor: user.name || user.id, action: 'pdf_table.run', objectType: 'pdf_table_job',
      objectId: jobId, result: status === 'failed' ? 'warning' : 'ok',
      detail: {
        path: checked.path, hash, max_pages: maxPages, timeout_ms: timeoutMs,
        status, pages_total: pagesTotal, pages_processed: pagesProcessed,
        pages_failed: pagesFailed, tables, coverage, partial_reason: partialReason,
      },
    });
    return {
      ok: status !== 'failed',
      job: jobOut(get('SELECT * FROM pdf_table_job WHERE id=?', [jobId])),
      status: status === 'failed' ? 422 : 200,
      note: partialReason === 'no_text_layer_or_tables'
        ? '没有取得文本层或表格；这不能解释为“零家企业”，需要 OCR/人工核对原件。'
        : partialReason === 'page_limit'
          ? '按页数上限只处理了前若干页，状态如实标为 partial。'
          : '表格结果只来自本机 pdfplumber 提取；行列与原文页码保留，仍需回原件核对。',
    };
  } finally {
    activeJobId = null;
  }
}

export function getPdfTableJob(jobId, { includeTables = true, page = null, limit = 100 } = {}) {
  const row = get('SELECT * FROM pdf_table_job WHERE id=?', [String(jobId)]);
  if (!row) return fail('PDF 表格任务不存在', 404);
  const pages = all('SELECT * FROM pdf_table_page WHERE job_id=? ORDER BY page', [row.id]);
  let tables = [];
  if (includeTables) {
    const params = [row.id];
    let where = 'job_id=?';
    if (page) { where += ' AND page=?'; params.push(Number(page)); }
    params.push(Math.max(1, Math.min(Number(limit) || 100, 500)));
    tables = all(`SELECT * FROM pdf_table WHERE ${where} ORDER BY page,table_index LIMIT ?`, params).map((t) => ({
      id: t.id, page: t.page, table_index: t.table_index,
      rows: t.row_count, cols: t.col_count,
      cells: JSON.parse(t.cells_json || '[]'), data: JSON.parse(t.rows_json || '[]'),
    }));
  }
  return {
    ok: true,
    job: jobOut(row),
    pages: pages.map((p) => ({
      page: p.page, width: p.width, height: p.height, table_count: p.table_count,
      row_count: p.row_count, cell_count: p.cell_count, text_chars: p.text_chars,
      has_text_layer: !!p.has_text_layer, status: p.status, error: p.error,
    })),
    tables,
    note: '页码为 PDF 物理页（1 起）；行/列均 0 起。扫描空页不是“零家企业”。',
  };
}

export function listPdfTableJobs({ limit = 30 } = {}) {
  return all('SELECT * FROM pdf_table_job ORDER BY created_at DESC LIMIT ?', [
    Math.max(1, Math.min(Number(limit) || 30, 100)),
  ]).map(jobOut);
}

export function pdfTableStatus() {
  const counts = get(
    `SELECT COUNT(*) total,
            SUM(CASE WHEN status='done' THEN 1 ELSE 0 END) done,
            SUM(CASE WHEN status='partial' THEN 1 ELSE 0 END) partial,
            SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) failed,
            SUM(CASE WHEN status='running' THEN 1 ELSE 0 END) running
       FROM pdf_table_job`
  ) || {};
  // 不硬编码“已安装/可用”：以最近一次真实任务回执判断；没有任务时如实标未探测。
  const last = get(
    `SELECT status,parser,pages_total,pages_processed,coverage_ratio,partial_reason,error,finished_at
       FROM pdf_table_job ORDER BY created_at DESC LIMIT 1`
  ) || null;
  let available = null;
  let availability = 'not_probed';
  if (last) {
    const err = String(last.error || '');
    if (/no module named|modulenotfound|not_installed|pdfplumber.*(missing|not installed)/i.test(err)) {
      available = false;
      availability = 'unavailable';
    } else if (last.parser || last.status === 'done' || last.status === 'partial') {
      available = true;
      availability = last.status === 'failed' ? 'available_last_failed' : 'available';
    } else if (last.status === 'failed') {
      available = false;
      availability = 'unavailable_or_failed';
    }
  }
  return {
    parser: 'pdfplumber',
    available,
    availability,
    last_job: last,
    active_job_id: activeJobId,
    limits: PDF_TABLE_LIMITS,
    roots: pdfTableRoots(),
    counts: {
      total: Number(counts.total || 0), done: Number(counts.done || 0),
      partial: Number(counts.partial || 0), failed: Number(counts.failed || 0),
      running: Number(counts.running || 0),
    },
    note: available === null
      ? '尚未执行过真实 PDF 任务，worker 是否可用未探测；不会把“未探测”显示为成功。'
      : available
        ? '最近一次真实任务显示 pdfplumber 可用；coverage 是页处理率，不是正文完整率。'
        : '最近一次真实任务显示 worker 不可用或解释器缺少 pdfplumber；失败原因已保留，不伪造成功。',
  };
}

export { jobOut };
