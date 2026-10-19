/**
 * 统一异步 PDF 解析服务（docs/36 第 2、3、5 条）
 * ============================================================================
 * 【为什么需要】
 *   原有 `extractPdfText()`（cea-collect-svc.mjs）是**同步** execFileSync，且只判
 *   「整篇字数」：扫描件页、乱码页、缺页都被当成一个整体，既无法定位到页，也没有
 *   OCR 兜底。本模块提供统一的、**异步**的、**逐页**的解析路径。
 *
 * 【纪律】
 *   1. 只用 `execFile` 异步调用本机 `pdftotext` / `pdfinfo`（不阻塞事件循环，
 *      可设置真实超时并受整批 deadline 约束），绝不 `execFileSync`；
 *   2. **逐页**保留文本与页码（**1 起**），逐页判断缺文字 / 乱码，再决定该页是否走 OCR；
 *   3. 整篇是否 full 由**逐页成功情况**决定：只要有一页没有可用正文就是 `partial`，
 *      **不用整篇字数阈值**把缺页判成全文（旧实现的根因）；
 *   4. OCR 未配置时**诚实失败**（该页标 ocr_not_configured），已有的可读页不受影响；
 *   5. 缓存键 = 原件 SHA-256 + 页码 + 解析版本（换版本自动失效，不重复计费）；
 *   6. quota / timeout 中止时**不产生任何残留写**（不写页缓存、不写结果 JSON）。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { writeFile, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { dbPath, get, run, audit } from '../core/db.mjs';
import { nowIso } from '../core/util.mjs';
import { baiduOcrConfig, baiduOcrReady, recognizePage, recordParserVersion } from './baidu-ocr-svc.mjs';
import { runToolToFile } from './exec-tool.mjs';

/** 文本解析版本：分页/判废策略变更时必须递增，使旧缓存自动失效。 */
export const PDF_TEXT_PARSER_VERSION = 'pdftext-v2';
/** 整篇结果 schema 版本 */
export const PDF_RESULT_VERSION = 1;

/** OCR 结果（含页码 JSON）落盘根目录：与数据库同级的 official-originals/ocr */
export function ocrRoot() {
  return join(dirname(dbPath()), 'official-originals', 'ocr');
}

/** 单页缓存文件：<ocr>/<sha256>/page-<n>.json */
export function pageCachePath(hash, page) {
  return join(ocrRoot(), String(hash), `page-${Number(page)}.json`);
}

/** 整篇解析结果：<ocr>/<sha256>.json */
export function docResultPath(hash) {
  return join(ocrRoot(), `${hash}.json`);
}

/* ==================================================================== */
/*  一、逐页文本质量判定                                                */
/* ==================================================================== */

/** 常见「乱码」特征：替换符、CID 占位、控制字符、私用区字符。 */
const CID_RE = /\(cid:\d+\)/i;

/**
 * 逐页判定一页的 pdftotext 输出是否可用。
 * @returns {{usable:boolean, reason:string|null, chars:number, garbled:boolean, needs_ocr:boolean}}
 */
export function assessPageText(rawText, { minChars = 12, maxGarbledRatio = 0.02 } = {}) {
  const text = String(rawText ?? '');
  const compact = text.replace(/\s+/g, '');
  const chars = compact.length;
  if (!chars) {
    return { usable: false, reason: 'page_empty', reason_text: '该页没有可提取文本（多为扫描/图片页）', chars: 0, garbled: false, needs_ocr: true };
  }
  if (CID_RE.test(text)) {
    return {
      usable: false, reason: 'page_cid_placeholder', garbled: true, needs_ocr: true, chars,
      reason_text: '该页文本为 CID 占位符（字体未嵌入，无法得到真实文字）',
    };
  }
  const replacement = (text.match(/\uFFFD/g) || []).length;
  const controls = (text.match(/[\u0000-\u0008\u000B\u000E-\u001F\u007F]/g) || []).length;
  const garbledRatio = (replacement + controls) / Math.max(1, text.length);
  if (garbledRatio > maxGarbledRatio) {
    return {
      usable: false, reason: 'page_garbled', garbled: true, needs_ocr: true, chars,
      reason_text: `该页乱码比例 ${(garbledRatio * 100).toFixed(1)}%（替换符 ${replacement} / 控制字符 ${controls}），不能作为正文`,
    };
  }
  if (chars < minChars) {
    // 有文字但过短：视为「缺文字」，需要 OCR 补足；**不**因此把整篇判成全文
    return {
      usable: false, reason: 'page_too_short', garbled: false, needs_ocr: true, chars,
      reason_text: `该页仅 ${chars} 个可见字符，低于 ${minChars} 的可用下限，按缺文字处理并转 OCR`,
    };
  }
  return { usable: true, reason: null, reason_text: null, chars, garbled: false, needs_ocr: false };
}

/* ==================================================================== */
/*  二、异步本机工具                                                   */
/* ==================================================================== */

async function runTool(cmd, args, { timeoutMs = 30000 } = {}) {
  // 无管道异步执行：受限环境禁止子进程打开管道，用 execFile 会得到 EPERM
  // （表现为「本机缺少 pdftotext」）。见 exec-tool.mjs 的说明。
  const r = await runToolToFile(cmd, args, { timeoutMs, tag: 'pdfparse' });
  if (r.ok) return { ok: true, stdout: r.stdout, stderr: r.stderr };
  return {
    ok: false,
    code: r.code,
    missing: r.missing,
    error: r.missing
      ? `未安装 ${cmd}（需要 poppler-utils）`
      : r.timedOut
        ? `${cmd} 超时或被杀（${timeoutMs}ms）`
        : (r.error || `${cmd} 执行失败`),
  };
}

/**
 * 剩余可用时间（相对 deadlineAt）。
 * 注意：`null` / `undefined` / `0` 都表示「没有整批 deadline」，必须回落到默认值——
 * `Number(null) === 0` 是有限数，用 `Number.isFinite(Number(x))` 判断会把「无 deadline」
 * 误判成「deadline 已过」。
 */
function remainingMs(deadlineAt, fallback = 30000) {
  const d = Number(deadlineAt);
  if (deadlineAt === null || deadlineAt === undefined || deadlineAt === '' || !Number.isFinite(d) || d <= 0) {
    return fallback;
  }
  return Math.max(0, d - Date.now());
}

/**
 * 用异步 pdfinfo 取真实页数。
 * @returns {Promise<{ok:boolean, pages?:number, error?:string}>}
 */
export async function pdfInfoPages(filePath, { deadlineAt = null, timeoutMs = 20000 } = {}) {
  if (!filePath || !existsSync(filePath)) return { ok: false, error: '文件不存在' };
  const budget = Math.min(timeoutMs, remainingMs(deadlineAt, timeoutMs));
  if (budget < 500) return { ok: false, error: '整批时间上限已到：未执行 pdfinfo', deadline_exceeded: true };
  const r = await runTool(process.env.CCER_PDFINFO || 'pdfinfo', [filePath], { timeoutMs: budget });
  if (!r.ok) return { ok: false, error: r.error };
  const m = String(r.stdout || '').match(/^Pages:\s+(\d+)/m);
  if (!m) return { ok: false, error: 'pdfinfo 未返回 Pages 字段' };
  const pages = Number(m[1]);
  if (!Number.isInteger(pages) || pages < 1) return { ok: false, error: `pdfinfo 返回非法页数：${m[1]}` };
  return { ok: true, pages };
}

/**
 * 用异步 pdftotext **一次性**取回全文，再按换页符 `\f` 切成逐页文本（页码 1 起）。
 * 一次调用即可拿到页码级文本，避免逐页重复启动进程。
 * @returns {Promise<{ok:boolean, pages?:string[], error?:string}>}
 */
export async function pdfTextPages(filePath, { deadlineAt = null, timeoutMs = 60000, expectPages = null } = {}) {
  if (!filePath || !existsSync(filePath)) return { ok: false, error: '文件不存在' };
  const budget = Math.min(timeoutMs, remainingMs(deadlineAt, timeoutMs));
  if (budget < 500) return { ok: false, error: '整批时间上限已到：未执行 pdftotext', deadline_exceeded: true };
  const dir = join(tmpdir(), `ccer-pdftext-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const out = join(dir, 'out.txt');
  try {
    await mkdir(dir, { recursive: true });
    const r = await runTool(
      process.env.CCER_PDFTOTEXT || 'pdftotext',
      ['-layout', '-enc', 'UTF-8', filePath, out],
      { timeoutMs: budget }
    );
    if (!r.ok) return { ok: false, error: r.error };
    if (!existsSync(out)) return { ok: false, error: 'pdftotext 未生成输出文件' };
    const text = await readFile(out, 'utf8');
    let pages = text.split('\f');
    // pdftotext 常在末尾多出一个空块：按真实页数归一
    if (Number.isInteger(expectPages) && expectPages > 0) {
      if (pages.length > expectPages) {
        const tail = pages.slice(expectPages);
        pages = pages.slice(0, expectPages);
        if (tail.join('').trim() && pages.length) pages[pages.length - 1] += tail.join('');
      } else if (pages.length < expectPages) {
        while (pages.length < expectPages) pages.push('');
      }
    } else if (pages.length > 1 && !pages[pages.length - 1].trim()) {
      pages = pages.slice(0, -1);
    }
    return { ok: true, pages };
  } catch (e) {
    return { ok: false, error: `读取 pdftotext 输出失败：${e.message}` };
  } finally {
    try {
      await rm(dir, { recursive: true, force: true });
    } catch {
      /* 临时目录清理失败不影响结论 */
    }
  }
}

/* ==================================================================== */
/*  三、缓存（按 原件 SHA-256 + 页码 + 解析版本）                        */
/* ==================================================================== */

export function readPageCache(hash, page, parserVersion = recordParserVersion()) {
  const p = pageCachePath(hash, page);
  if (!existsSync(p)) return null;
  try {
    const row = JSON.parse(readFileSync(p, 'utf8'));
    if (!row || row.sha256 !== hash || Number(row.page) !== Number(page) || row.version !== parserVersion) return null;
    if (!row.text || !String(row.text).trim()) return null;
    return row;
  } catch {
    return null;
  }
}

/**
 * 写单页 OCR 缓存。**只在 OCR 真实成功时调用**；quota/timeout 中止路径不会走到这里。
 */
async function writePageCache(hash, page, { text, parser, version, attempts, oversized }) {
  const dir = join(ocrRoot(), String(hash));
  await mkdir(dir, { recursive: true });
  const payload = {
    sha256: hash, page: Number(page), parser, version,
    chars: String(text).replace(/\s+/g, '').length,
    text, attempts: attempts ?? null, oversized: !!oversized,
    cached_at: nowIso(),
    note: '百度经典高精度接口单页识别结果；原文以本地归档原件为准。',
  };
  await writeFile(pageCachePath(hash, page), JSON.stringify(payload, null, 2), { encoding: 'utf8', mode: 0o600 });
  return payload;
}

export function readDocResult(hash) {
  const p = docResultPath(hash);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

/** 整篇结果只记录真实取得的内容；调用方必须先确认没有 quota/timeout 中止。 */
async function writeDocResult(hash, result) {
  await mkdir(ocrRoot(), { recursive: true });
  await writeFile(docResultPath(hash), JSON.stringify(result, null, 2), { encoding: 'utf8', mode: 0o600 });
  return result;
}

/** 测试/排障：删除某个原件的全部 OCR 缓存与结果（不触碰原件本身）。 */
export async function clearOcrArtifacts(hash) {
  try {
    await rm(join(ocrRoot(), String(hash)), { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  try {
    await rm(docResultPath(hash), { force: true });
  } catch {
    /* ignore */
  }
}

/* ==================================================================== */
/*  四、主解析入口                                                     */
/* ==================================================================== */

/**
 * 解析一个本地 PDF：逐页文本 → 逐页判废 → 缺文字/乱码页走 OCR → 汇总状态。
 *
 * @param {{filePath:string, sha256:string, deadlineAt?:number|null, cfg?:object,
 *          force?:boolean, maxPages?:number, recognize?:Function}} opts
 * @returns {Promise<{
 *   ok:boolean, status:'full'|'partial'|'failed', hash:string, file_path:string,
 *   parser:string, parser_version:string, pages_total:number,
 *   pages_text:number, pages_ocr:number, pages_failed:number,
 *   pages:Array<{page:number, source:'text'|'ocr'|'none', chars:number, text:string|null,
 *                reason:string|null, reason_text:string|null, cached:boolean, error_category:string|null}>,
 *   text:string|null, needs_ocr_pages:number[], failures:Array<object>,
 *   aborted:null|string, ocr_ready:boolean, ocr_note:string|null,
 *   cached_pages:number, ocr_calls:number, at:string
 * }>}
 */
export async function parsePdfDocument({
  filePath, sha256, deadlineAt = null, cfg = baiduOcrConfig(), force = false, maxPages = null,
  recognize = recognizePage, onPage = null,
} = {}) {
  const hash = String(sha256 || '');
  const at = nowIso();
  const base = {
    ok: false, status: 'failed', hash, file_path: filePath,
    parser: 'pdf-parse-svc', parser_version: PDF_TEXT_PARSER_VERSION,
    pages_total: 0, pages_text: 0, pages_ocr: 0, pages_vision: 0, pages_failed: 0,
    pages: [], text: null, needs_ocr_pages: [], failures: [],
    aborted: null, ocr_ready: false, ocr_note: null,
    cached_pages: 0, ocr_calls: 0, at, result_written: false,
  };
  if (!filePath || !existsSync(filePath)) return { ...base, error: '本地原件不存在，无法解析' };
  if (!hash) return { ...base, error: '缺少原件 SHA-256，拒绝在无哈希的情况下缓存解析结果' };

  const ocrState = baiduOcrReady(cfg);
  base.ocr_ready = ocrState.ready;
  base.ocr_note = ocrState.ready ? null : ocrState.reason;

  const budgetLeft = () => remainingMs(deadlineAt, 10 * 60 * 1000);
  if (budgetLeft() < 500) {
    return {
      ...base, aborted: 'deadline_exceeded',
      error: '整批时间上限已到：未开始解析（留待下一批，未写入任何结果）',
      note: '因 deadline_exceeded 未开始解析，未写入任何结果（无残留写）。',
    };
  }

  const info = await pdfInfoPages(filePath, { deadlineAt, timeoutMs: Math.min(20000, budgetLeft()) });
  if (!info.ok && info.deadline_exceeded) {
    return {
      ...base, aborted: 'deadline_exceeded', error: `无法读取 PDF 页数：${info.error}`,
      note: '因 deadline_exceeded 中止，未写入任何结果（无残留写）。',
    };
  }
  const textOut = await pdfTextPages(filePath, {
    deadlineAt, timeoutMs: Math.min(60000, budgetLeft()), expectPages: info.ok ? info.pages : null,
  });
  if (!textOut.ok) {
    return {
      ...base,
      aborted: textOut.deadline_exceeded ? 'deadline_exceeded' : null,
      error: `pdftotext 失败：${textOut.error}${info.ok ? '' : `（pdfinfo 亦不可用：${info.error}）`}`,
      note: textOut.deadline_exceeded ? '因 deadline_exceeded 中止，未写入任何结果（无残留写）。' : null,
    };
  }
  // 页数以 pdfinfo 为准；pdfinfo 不可用时退回到 pdftotext 的换页符分页，
  // 并如实标注来源（不把「页数未知」当成「全文完整」）。
  const totalAll = info.ok ? info.pages : textOut.pages.length;
  if (!info.ok) base.pages_source = 'pdftotext_formfeed';
  else base.pages_source = 'pdfinfo';
  const total = Number(maxPages) > 0 ? Math.min(totalAll, Number(maxPages)) : totalAll;
  base.pages_total = totalAll;
  base.pages_scanned = total;
  base.pages_note = info.ok ? null : `pdfinfo 不可用（${info.error}），页数按 pdftotext 换页符推算。`;

  const pages = [];
  for (let i = 0; i < total; i += 1) {
    const page = i + 1;
    const raw = textOut.pages[i] ?? '';
    const judge = assessPageText(raw, { minChars: Number(cfg.ocr_min_chars) || 12 });
    pages.push({
      page, source: judge.usable ? 'text' : 'none', chars: judge.chars,
      text: judge.usable ? raw : null,
      reason: judge.usable ? null : judge.reason,
      reason_text: judge.usable ? null : judge.reason_text,
      cached: false, error_category: null,
    });
  }

  const needsOcr = pages.filter((p) => !p.text).map((p) => p.page);
  base.needs_ocr_pages = needsOcr;

  // ---- 逐页 OCR ----
  for (const pageNo of needsOcr) {
    if (budgetLeft() < 500) {
      base.aborted = 'deadline_exceeded';
      base.failures.push({ page: pageNo, reason: 'deadline_exceeded', message: '整批时间上限已到，该页未送 OCR（未写入任何结果）' });
      break;
    }
    const entry = pages[pageNo - 1];

    // 1) 先查缓存：命中即不重复计费
    if (!force) {
      const cached = readPageCache(hash, pageNo, recordParserVersion(cfg.mode));
      if (cached) {
        entry.source = 'ocr';
        entry.text = cached.text;
        entry.chars = cached.chars;
        entry.cached = true;
        entry.reason = null;
        entry.reason_text = `命中 OCR 缓存（${cached.parser} / ${cached.version}），未重复调用接口`;
        base.cached_pages += 1;
        if (onPage) await onPage(entry);
        continue;
      }
    }

    // 2) OCR 不可用：**按真实原因分类**（配额耗尽 ≠ 未配置），
    //    诚实失败但不影响已有可读页；配额耗尽同时中止整批（不写任何结果）。
    if (!ocrState.ready) {
      const quotaBlocked = ocrState.category === 'quota';
      entry.error_category = quotaBlocked ? 'quota' : 'not_configured';
      base.failures.push({
        page: pageNo,
        reason: quotaBlocked ? 'quota_exceeded' : 'ocr_not_configured',
        message: ocrState.reason,
      });
      if (quotaBlocked) {
        base.aborted = 'quota_exceeded';
        if (onPage) await onPage(entry);
        break;
      }
      if (onPage) await onPage(entry);
      continue;
    }

    // 3) 真调用
    let pdfBuffer;
    try {
      pdfBuffer = readFileSync(filePath);
    } catch (e) {
      entry.error_category = 'io';
      base.failures.push({ page: pageNo, reason: 'io', message: `读取原件失败：${e.message}` });
      continue;
    }
    const out = await recognize({ pdfBuffer, pageNum: pageNo, deadlineAt, cfg, purpose: 'pdf-parse' });
    base.ocr_calls += Number(out.attempts) || 0;
    if (out.ok) {
      entry.source = 'ocr';
      entry.text = out.text;
      entry.chars = out.chars;
      entry.reason = null;
      entry.reason_text = out.parser === 'baidu-document-parser-v2' ? `由百度文档解析接口识别（原始物理第${pageNo}页）` : `由百度经典高精度接口识别（pages=${pageNo}，1 起）`;
      // 只有真实成功才落缓存
      await writePageCache(hash, pageNo, {
        text: out.text, parser: out.parser || recordParserVersion(cfg.mode), version: recordParserVersion(cfg.mode),
        attempts: out.attempts, oversized: out.oversized,
      });
      if (onPage) await onPage(entry);
      continue;
    }
    entry.error_category = out.error_category || 'unknown';
    base.failures.push({
      page: pageNo, reason: out.error_category || 'unknown',
      error_code: out.error_code ?? null, message: out.error || 'OCR 失败',
    });
    // quota / timeout 中止：整篇停止，且不写任何结果
    if (out.error_category === 'quota' || out.error_category === 'timeout' || out.deadline_exceeded) {
      base.aborted = out.error_category === 'quota' ? 'quota_exceeded' : 'deadline_exceeded';
      if (onPage) await onPage(entry);
      break;
    }
    if (onPage) await onPage(entry);
  }

  const okPages = pages.filter((p) => p.text);
  base.pages = pages;
  base.pages_text = pages.filter((p) => p.source === 'text').length;
  base.pages_ocr = pages.filter((p) => p.source === 'ocr').length;
  base.pages_vision = pages.filter((p) => p.source === 'vision').length;
  base.pages_failed = pages.filter((p) => !p.text).length;
  base.ok = base.pages_failed === 0 && base.pages_total > 0 && pages.length === base.pages_total;
  // 只有部分页成功 → partial（绝不用整篇字数阈值判成 full）
  base.status = base.pages_total > 0 && base.pages_failed === 0 && pages.length === base.pages_total
    ? 'full'
    : okPages.length > 0 ? 'partial' : 'failed';
  base.text = okPages.length
    ? okPages.map((p) => `【第 ${p.page} 页｜${p.source === 'ocr' ? 'OCR' : '文本层'}】\n${p.text}`).join('\n\n')
    : null;
  // 不带页码标记的纯正文：供需要与旧 pdftotext 输出等价的调用方使用
  base.raw_text = okPages.length ? okPages.map((p) => p.text).join('\n\f\n') : null;
  base.chars = okPages.reduce((n, p) => n + (p.chars || 0), 0);
  base.failed_pages = pages.filter((p) => !p.text).map((p) => ({ page: p.page, reason: p.reason, error_category: p.error_category }));
  base.note = base.pages_total > total
    ? `按配置仅解析前 ${total} / ${base.pages_total} 页（单文档页数上限）；其余页未处理，状态如实标为部分。`
    : null;

  // quota / timeout 中止 → 不写整篇结果（无残留写）
  if (base.aborted) {
    base.result_written = false;
    base.note = `${base.note ? `${base.note} ` : ''}因 ${base.aborted} 中止，未写入整篇结果 JSON（无残留写）。`;
    return base;
  }
  if (!okPages.length) {
    base.result_written = false;
    base.note = `${base.note ? `${base.note} ` : ''}没有任何一页取得可用正文，未写入结果 JSON。`;
    return base;
  }
  await writeDocResult(hash, {
    ...base,
    // 逐页正文另存于 pages[].text，结果 JSON 同时保留，便于按页引用
    record_parser_version: recordParserVersion(cfg.mode),
    parser_version: PDF_TEXT_PARSER_VERSION,
    result_version: PDF_RESULT_VERSION,
    note: 'OCR/文本层结果仅用于定位原文；已人工审核状态不因此改变，原件字节未被修改。',
  });
  base.result_written = true;
  return base;
}

/* ==================================================================== */
/*  五、结果落库（供各采集路径复用）                                     */
/* ==================================================================== */

/**
 * 把解析结果写回目标对象：**只有取得正文才写 body**；
 * 记录 hash、parser、版本、哪些页成功、失败原因与时间。
 * @returns {{updated:boolean, fields:string[], verify_eligible:boolean}}
 */
export async function persistParseResult(result, { kind, id, actor = 'system:pdf-parse' } = {}) {
  const fields = [];
  const body = result.text && result.chars >= 1 ? result.text : null;
  const now = nowIso();
  const summary = {
    hash: result.hash, parser: result.parser, parser_version: result.parser_version,
    pages_total: result.pages_total, pages_text: result.pages_text, pages_ocr: result.pages_ocr,
    pages_vision: result.pages_vision || 0, pages_failed: result.pages_failed, status: result.status,
    failed_pages: result.failed_pages || [], aborted: result.aborted, at: result.at,
    vision_pages: result.vision_pages || [],
  };
  if (kind === 'policy_attachment' && id) {
    const vNote = Number(result.pages_vision || 0) > 0 ? `；视觉模型补充 ${result.pages_vision} 页（模型理解，非官方事实）` : '';
    const q = result.status === 'full'
      ? { quality: 'good', note: `逐页解析完成（文本层 ${result.pages_text} 页 + OCR ${result.pages_ocr} 页，共 ${result.pages_total} 页）${vNote}` }
      : result.status === 'partial'
        ? { quality: 'partial', note: `仅部分页取得正文（成功 ${result.pages_total - result.pages_failed}/${result.pages_total}）：${JSON.stringify(summary.failed_pages).slice(0, 300)}${vNote}` }
        : { quality: 'failed', note: `逐页解析未取得任何可用正文：${JSON.stringify(summary.failed_pages).slice(0, 300)}${vNote}` };
    run('UPDATE policy_attachment SET parse_quality=?, parse_note=? WHERE id=?', [q.quality, `${q.note}；${JSON.stringify(summary)}`, id]);
    fields.push('policy_attachment.parse_quality', 'policy_attachment.parse_note');
  } else if (kind === 'policy_document' && id) {
    if (body) {
      run('UPDATE policy_document SET body_snapshot=?, updated_at=? WHERE id=?', [body, now, id]);
      fields.push('policy_document.body_snapshot');
    }
  } else if (kind === 'methodology_version' && id) {
    if (body) {
      run('UPDATE methodology_version SET body_snapshot=?, updated_at=? WHERE id=?', [body, now, id]);
      fields.push('methodology_version.body_snapshot');
    }
  } else if (kind === 'cea_document' && id) {
    if (body) {
      const level = result.status === 'full' ? 'full_text' : 'partial';
      run(
        `UPDATE cea_document SET body_snapshot=?, evidence_level=?,
           provenance_note = COALESCE(provenance_note,'') || ?, updated_at=? WHERE id=?`,
        [
          body, level,
          ` 逐页解析（${result.parser_version}）：文本层 ${result.pages_text} 页 + OCR ${result.pages_ocr} 页` +
          `${Number(result.pages_vision || 0) ? ` + 视觉模型补充 ${result.pages_vision} 页（模型理解，非官方事实）` : ''}，` +
          `失败 ${result.pages_failed} 页 → ${result.status}。正文为文本层/OCR/视觉补充的机器提取，` +
          '不构成已人工审核，也不替代既有自动核验。',
          now, id,
        ]
      );
      fields.push('cea_document.body_snapshot', 'cea_document.evidence_level', 'cea_document.provenance_note');
    }
    // CEA 使用 ai_status 保存核验状态，表中没有 review_status。
    // 正文改变后旧模型结论失效；等待 verifyObject 重新检查，不能由解析器直接判通过。
    if (body) run("UPDATE cea_document SET ai_status='unverified', updated_at=? WHERE id=?", [now, id]);
  }
  audit({
    actor, action: 'pdf_parse.persist', objectType: kind, objectId: id,
    detail: { ...summary, fields, body_chars: body ? body.length : 0, verify_eligible: !!body },
    result: result.status === 'failed' ? 'warning' : 'ok',
  });
  return { updated: fields.length > 0, fields, verify_eligible: !!body, summary };
}

export { statSync };
