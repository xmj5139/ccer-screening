/**
 * 公开正文清洗（docs/86 第一阶段第 1 节）
 * ============================================================================
 * 设计口径：
 *   1. 确定性规则清洗永远可用：优先 <article> / <main>，移除 script/style/nav/
 *      footer/aside/form 等；保留标题、段落、列表与表格单元格。
 *   2. Trafilatura 是**可选 Python worker**：只有显式设置 CCER_TRAFILATURA=1
 *      才尝试；未安装、超时、输出非法时回退到规则清洗，并如实记录真实 parser，
 *      绝不把回退结果标成 Trafilatura。
 *   3. 清洗器只负责「原文 → 文本」，不决定 body_availability。
 *      正文变长不等于全文：可用性由抓取连接/正文结构判定。
 *   4. 日期页脚、版权行、责任编辑等易变内容从「实质指纹」中剔除，
 *      避免页脚日期变化就重生成摘要；原始清洗文本仍完整保存。
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CLEANER_VERSION = '1.0.0';
export const TRAFILATURA_REQUIRED_VERSION = '1.12.2';
export const MAX_CLEAN_CHARS = 200_000;
export const MAX_RAW_HTML_CHARS = 1_000_000;
const WORKER = fileURLToPath(new URL('../../scripts/trafilatura-worker.py', import.meta.url));
const PROJECT_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const RUNTIME_PY_PACKAGES = resolve(PROJECT_ROOT, 'data', 'runtime', 'python-packages');

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', mdash: '—', ndash: '–',
  hellip: '…', middot: '·', copy: '©', reg: '®', trade: '™', times: '×',
  divide: '÷', laquo: '«', raquo: '»', emsp: '　', ensp: ' ', thinsp: ' ',
};

/** 解码 XML/HTML 标准实体；未知实体保持原样，不解析外部实体。 */
export function decodeEntities(value) {
  return String(value || '').replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]+);/gi, (all, body) => {
    const key = String(body).toLowerCase();
    if (key.startsWith('#x')) {
      const code = Number.parseInt(key.slice(2), 16);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : all;
    }
    if (key.startsWith('#')) {
      const code = Number.parseInt(key.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : all;
    }
    return Object.prototype.hasOwnProperty.call(ENTITIES, key) ? ENTITIES[key] : all;
  });
}

export function stripTags(html) {
  return decodeEntities(String(html || '').replace(/<[^>]*>/g, ' '));
}

function removeUnsafeBlocks(html) {
  const src = String(html || '');
  return src
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template|svg|math|iframe|object|embed|canvas|nav|footer|aside|form|button|select|textarea)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<(script|style|noscript|template|svg|math|iframe|object|embed|canvas|nav|footer|aside|form|button|select|textarea)\b[^>]*\/?>/gi, ' ');
}

function innerCandidates(html, tag) {
  const out = [];
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}\\s*>`, 'gi');
  for (const m of String(html || '').matchAll(re)) out.push(m[1]);
  return out;
}

/**
 * 按同名标签配对提取块（支持嵌套 div）。用于政府 CMS 常见的
 * TRS_Editor / #zoom / .article-content 等正文容器。
 */
function tagBlocks(html, tag) {
  const src = String(html || '');
  const re = new RegExp(`<${tag}\\b[^>]*>|<\\/${tag}\\s*>`, 'gi');
  const stack = [];
  const blocks = [];
  for (const m of src.matchAll(re)) {
    if (/^<\//.test(m[0])) {
      const open = stack.pop();
      if (open) blocks.push({ attrs: open.attrs, inner: src.slice(open.end, m.index) });
    } else if (!/\/>\s*$/.test(m[0])) {
      stack.push({ attrs: m[0], end: (m.index ?? 0) + m[0].length });
    }
  }
  return blocks;
}

function textLength(html) {
  return stripTags(removeUnsafeBlocks(html)).replace(/\s+/g, ' ').trim().length;
}

/** 选择正文容器：最大的 article；没有 article 则最大的 main；再尝试政府 CMS 正文 div；否则 body。 */
export function selectContentHtml(html) {
  const src = String(html || '');
  for (const tag of ['article', 'main']) {
    const parts = innerCandidates(src, tag).filter((x) => textLength(x) >= 20);
    if (parts.length) return parts.sort((a, b) => textLength(b) - textLength(a))[0];
  }
  const GOV_CONTENT = /(?:id|class)\s*=\s*["'][^"']*(?:TRS_Editor|article[-_]?content|news[-_]?content|pages_content|detail[-_]?content|content_main|main[-_]?content|xxgk[-_]?content|\bzoom\b)[^"']*["']/i;
  const divs = tagBlocks(src, 'div')
    .filter((b) => GOV_CONTENT.test(b.attrs) && textLength(b.inner) >= 80)
    .map((b) => b.inner);
  if (divs.length) return divs.sort((a, b) => textLength(b) - textLength(a))[0];
  const body = innerCandidates(src, 'body');
  if (body.length) return body.sort((a, b) => textLength(b) - textLength(a))[0];
  return src;
}

/** HTML → 可读正文（保留段落、标题、列表和表格的制表符/换行）。 */
export function htmlToText(html) {
  let src = selectContentHtml(removeUnsafeBlocks(html));
  src = src
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|main|h[1-6]|li|ul|ol|blockquote|pre)>/gi, '\n')
    .replace(/<\/(td|th)>/gi, '\t')
    .replace(/<\/(tr|table|thead|tbody)>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '• ')
    .replace(/<[^>]*>/g, '');
  src = decodeEntities(src)
    .replace(/\u00a0/g, ' ')
    .replace(/[\u200b-\u200d\ufeff]/g, '')
    .replace(/\r\n?/g, '\n');
  const lines = src.split('\n').map((line) => {
    const cells = line.split('\t');
    return cells.map((c) => c.replace(/[ \t\f\v]+/g, ' ').trim()).filter((c, i, a) => c || i < a.length - 1).join('\t');
  });
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Markdown → 文本；链接保留文字，表格保留管道分隔，避免丢结构。 */
export function markdownToText(markdown) {
  return decodeEntities(String(markdown || '')
    .replace(/^---\n[\s\S]*?\n---\n/, '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s*/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '• ')
    .replace(/\r\n?/g, '\n'))
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 纯文本归一化（保留段落与表格制表符）。 */
export function cleanText(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/[\u200b-\u200d\ufeff]/g, '')
    .split('\n')
    .map((line) => line.split('\t').map((c) => c.replace(/[ \t\f\v]+/g, ' ').trim()).join('\t'))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const NAV_LINE = /^(首页|网站首页|导航|登录|注册|关于我们|联系我们|广告服务|招聘|版权声明|网站地图|订阅|投稿|免责声明|分享|打印|字号|上一篇|下一篇|返回顶部)\s*$/;

/**
 * 页面类型判定：只用于说明/质量提示，不代替正文。
 * - navigation：短页且导航行占比高；
 * - list：大量短行、缺少句末标点；
 * - article：其余非空正文。
 */
export function classifyPage(text, { title = null } = {}) {
  const body = cleanText(text);
  if (!body) return { kind: 'empty', reason: '清洗后正文为空' };
  const lines = body.split('\n').filter(Boolean);
  const navLines = lines.filter((l) => NAV_LINE.test(l)).length;
  if (body.length < 120 && navLines >= Math.max(2, Math.ceil(lines.length / 3))) {
    return { kind: 'navigation', reason: '短页且导航行占比高' };
  }
  const short = lines.filter((l) => l.length <= 28).length;
  const punct = (body.match(/[。！？；]/g) || []).length;
  const longParagraphs = lines.filter((l) => l.length >= 80 && /[。；]/.test(l)).length;
  if (longParagraphs >= 2 && punct >= 4) return { kind: 'article', reason: '包含多个完整段落，判定为文章正文' };
  if (lines.length >= 12 && short / lines.length >= 0.8 && punct <= Math.ceil(lines.length / 8)) {
    return { kind: 'list', reason: '大量短行且缺少句末标点，疑似栏目/列表页' };
  }
  if (body.length < 60) return { kind: 'empty', reason: `正文过短（${body.length} 字符）` };
  return { kind: 'article', reason: title ? `正文结构可用（${title.slice(0, 40)}）` : '正文结构可用' };
}

/** 从 HTML / Markdown 中提取附件链接（仅公开文件类型；拒绝 data/javascript）。 */
export function extractAttachmentLinks(raw, baseUrl = null, { max = 50 } = {}) {
  const refs = [];
  const src = String(raw || '');
  for (const m of src.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    refs.push({ href: m[1], name: stripTags(m[2]).replace(/\s+/g, ' ').trim() });
  }
  for (const m of src.matchAll(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+|\/[^\s)]+)\)/g)) {
    refs.push({ href: m[2], name: m[1] });
  }
  const out = [];
  const seen = new Set();
  for (const ref of refs) {
    const href = String(ref.href || '').trim();
    if (!href || /^(#|javascript:|data:|file:|vbscript:|mailto:|tel:)/i.test(href)) continue;
    let u;
    try {
      u = new URL(href, baseUrl || undefined);
    } catch {
      continue;
    }
    if (!['http:', 'https:'].includes(u.protocol)) continue;
    const path = u.pathname.toLowerCase();
    const ext = (path.match(/\.([a-z0-9]{2,6})$/i) || [])[1] || '';
    if (!['pdf', 'doc', 'docx', 'xls', 'xlsx', 'csv', 'zip', 'ofd'].includes(ext)) continue;
    const key = u.toString();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      url: key,
      file_name: String(ref.name || '').slice(0, 200) || key.split('/').pop().split('?')[0].slice(0, 120),
      file_type: ext,
    });
    if (out.length >= Math.max(1, Math.min(Number(max) || 50, 200))) break;
  }
  return out;
}

/** 附件清单指纹：只依赖 URL 与已知文件哈希，按稳定顺序排序。 */
export function attachmentFingerprint(list = []) {
  const rows = (Array.isArray(list) ? list : [])
    .filter((a) => a && a.url && /^https?:\/\//i.test(String(a.url)))
    .map((a) => `${String(a.url).trim()}|${String(a.file_hash || '')}`)
    .sort();
  return createHash('sha256').update(rows.join('\n'), 'utf8').digest('hex');
}

const VOLATILE_LINE = /^(发布(?:时间|日期)|最后更新|更新时间|更新日期|责任编辑|编辑|来源\s*[:：]|版权|copyright|©|ICP|网站地图|打印|分享|字号|上一篇|下一篇|相关阅读|返回顶部|扫一扫|阅读原文|点击量|浏览量)/i;

/**
 * 实质正文：剔除日期页脚、版权、责任编辑、分享等易变行。
 * 用于判断「是否值得重新生成摘要」，不用于展示或证据定位。
 */
export function substantiveBody(text) {
  const lines = cleanText(text).split('\n');
  const kept = lines.filter((line) => {
    const t = line.trim();
    if (!t) return true;
    if (VOLATILE_LINE.test(t)) return false;
    if (/^(©|copyright)\s*\d{4}/i.test(t)) return false;
    if (/^[\d\s年月日\-/.:]+$/.test(t) && t.length <= 24) return false;
    return true;
  });
  return cleanedWhitespace(kept.join('\n')).trim();
}

function cleanedWhitespace(text) {
  return String(text || '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n');
}

export function sha256Text(text) {
  return createHash('sha256').update(String(text || ''), 'utf8').digest('hex');
}

/** 正文指纹：清洗后完整文本；实质指纹：去页脚后文本。 */
export function bodyFingerprints(text) {
  const body = cleanText(text);
  const substantive = substantiveBody(body);
  return {
    body,
    body_hash: sha256Text(body),
    substantive_hash: sha256Text(substantive),
    chars: body.length,
  };
}

/** 可解释差异摘要（公共前后缀，不伪造编辑语义）。 */
export function diffSummary(prev, next) {
  const a = cleanText(prev);
  const b = cleanText(next);
  if (a === b) return { change_kind: 'none', diff_chars: 0, summary: '正文无变化' };
  let start = 0;
  const max = Math.min(a.length, b.length);
  while (start < max && a[start] === b[start]) start += 1;
  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) {
    endA -= 1;
    endB -= 1;
  }
  const removed = a.slice(start, endA + 1);
  const added = b.slice(start, endB + 1);
  const diffChars = Math.max(removed.length, added.length);
  return {
    change_kind: 'body_change',
    diff_chars: diffChars,
    changed_at: start,
    removed_chars: removed.length,
    added_chars: added.length,
    summary:
      `正文长度 ${a.length} → ${b.length}（${b.length >= a.length ? '+' : ''}${b.length - a.length} 字符）；` +
      `变更片段起于第 ${start + 1} 个字符，删除 ${removed.length} / 新增 ${added.length} 字符` +
      (diffChars ? `；片段：${(removed || added).replace(/\s+/g, ' ').slice(0, 80)}` : ''),
  };
}

/** 是否启用 Trafilatura（默认关闭；未安装时不会假装可用）。 */
export function trafilaturaEnabled() {
  return process.env.CCER_TRAFILATURA === '1';
}

/** 进程内单并发：Trafilatura worker 一次只跑一个，避免小服务器并发起多个 Python。 */
let trafilaturaQueue = Promise.resolve();

/**
 * 执行 Python Trafilatura worker。
 * 单进程、单并发、有限输入/输出、超时即杀；失败返回明确 reason，由调用方回退。
 */
export async function runTrafilaturaWorker(html, { url = null, timeoutMs = 15000, maxChars = MAX_CLEAN_CHARS, runner = null } = {}) {
  const src = String(html || '');
  if (!src.trim()) return { ok: false, reason: 'empty_input', message: '没有可清洗的 HTML' };
  if (src.length > MAX_RAW_HTML_CHARS) return { ok: false, reason: 'input_too_large', message: `HTML 超过 ${MAX_RAW_HTML_CHARS} 字符上限` };
  if (typeof runner === 'function') {
    return runner({ html: src, url, maxChars, timeoutMs });
  }
  if (!trafilaturaEnabled()) {
    return { ok: false, reason: 'not_enabled', message: '未设置 CCER_TRAFILATURA=1，使用规则清洗' };
  }
  const task = () => runTrafilaturaWorkerUnlocked(src, { url, timeoutMs, maxChars });
  const scheduled = trafilaturaQueue.then(task, task);
  trafilaturaQueue = scheduled.then(() => undefined, () => undefined);
  return scheduled;
}

function runTrafilaturaWorkerUnlocked(src, { url = null, timeoutMs = 15000, maxChars = MAX_CLEAN_CHARS } = {}) {
  const python = process.env.CCER_TRAFILATURA_PYTHON || 'python';
  return new Promise((resolve) => {
    let settled = false;
    let stdout = '';
    let stderr = '';
    let killedForSize = false;
    let timer = null;
    const finish = (out) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(out);
    };
    let child;
    try {
      const pyPath = [process.env.PYTHONPATH, existsSync(RUNTIME_PY_PACKAGES) ? RUNTIME_PY_PACKAGES : null]
        .filter(Boolean).join(process.platform === 'win32' ? ';' : ':');
      child = spawn(python, [WORKER], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1',
          ...(pyPath ? { PYTHONPATH: pyPath } : {}),
        },
      });
    } catch (e) {
      finish({ ok: false, reason: 'worker_spawn_failed', message: e.message });
      return;
    }
    timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      finish({ ok: false, reason: 'timeout', message: `Trafilatura worker 超过 ${timeoutMs}ms，已终止并回退` });
    }, Math.max(1000, Math.min(Number(timeoutMs) || 15000, 60000)));
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (stdout.length > Math.max(maxChars * 6, 1_000_000)) {
        killedForSize = true;
        try { child.kill(); } catch { /* ignore */ }
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-4000);
    });
    child.on('error', (e) => finish({ ok: false, reason: 'worker_spawn_failed', message: e.message }));
    child.on('close', (code) => {
      if (killedForSize) {
        finish({ ok: false, reason: 'output_too_large', message: 'Trafilatura 输出超过上限，已终止并回退' });
        return;
      }
      if (code !== 0) {
        finish({ ok: false, reason: 'worker_failed', message: `worker 退出码 ${code}：${stderr.slice(0, 300)}` });
        return;
      }
      const lastLine = stdout.trim().split('\n').filter(Boolean).pop() || '';
      let parsed;
      try {
        parsed = JSON.parse(lastLine);
      } catch {
        finish({ ok: false, reason: 'bad_worker_output', message: 'worker 输出不是 JSON' });
        return;
      }
      if (!parsed?.ok) {
        finish({ ok: false, reason: parsed?.reason || 'worker_error', message: parsed?.message || 'worker 未返回可用正文' });
        return;
      }
      const text = cleanText(parsed.text).slice(0, maxChars);
      if (!text) {
        finish({ ok: false, reason: 'empty_output', message: 'worker 未提取到正文' });
        return;
      }
      finish({
        ok: true,
        text,
        title: parsed.title || null,
        version: String(parsed.version || 'unknown'),
        chars: text.length,
        latency_ms: parsed.latency_ms ?? null,
      });
    });
    try {
      child.stdin.end(JSON.stringify({ html: src, url, max_chars: maxChars }));
    } catch (e) {
      finish({ ok: false, reason: 'worker_input_failed', message: e.message });
    }
  });
}

/**
 * 统一清洗入口。
 * @returns {Promise<{ok:boolean,text:string,title:string|null,extractor:string,extractor_version:string,
 *   status:'ok'|'fallback'|'failed',quality:string,chars:number,note:string,raw_html?:string,raw_text?:string}>}
 */
export async function cleanContent({
  rawHtml = null, markdown = null, rawText = null, url = null,
  preferTrafilatura = null, timeoutMs = 15000, trafilaturaRunner = null,
  maxChars = MAX_CLEAN_CHARS,
} = {}) {
  const useTrafilatura = preferTrafilatura === true || (preferTrafilatura !== false && trafilaturaEnabled());
  const html = rawHtml ? String(rawHtml) : '';
  const md = markdown ? String(markdown) : '';
  const plain = rawText ? String(rawText) : '';
  let fallbackReason = null;
  let trafVersion = null;

  if (html && useTrafilatura) {
    const w = await runTrafilaturaWorker(html, { url, timeoutMs, maxChars, runner: trafilaturaRunner });
    if (w.ok) {
      const text = cleanText(w.text).slice(0, maxChars);
      const cls = classifyPage(text);
      return {
        ok: true, text, title: w.title || null,
        extractor: 'trafilatura', extractor_version: w.version || 'unknown',
        status: 'ok', quality: cls.kind, chars: text.length,
        note: `Trafilatura 提取成功（版本 ${w.version || 'unknown'}）；${cls.reason}`,
        raw_html: html.slice(0, MAX_RAW_HTML_CHARS),
        raw_text: null,
      };
    }
    fallbackReason = `${w.reason}：${w.message}`;
    trafVersion = null;
  }

  if (html) {
    const text = htmlToText(html).slice(0, maxChars);
    const cls = classifyPage(text);
    if (!text) {
      return {
        ok: false, text: '', title: null, extractor: 'deterministic_html',
        extractor_version: CLEANER_VERSION, status: 'failed', quality: 'empty', chars: 0,
        note: ['规则清洗未取得正文', fallbackReason].filter(Boolean).join('；'),
        raw_html: html.slice(0, MAX_RAW_HTML_CHARS), raw_text: null,
      };
    }
    return {
      ok: true, text, title: null,
      extractor: 'deterministic_html', extractor_version: CLEANER_VERSION,
      status: fallbackReason ? 'fallback' : 'ok', quality: cls.kind, chars: text.length,
      note: [cls.reason, fallbackReason ? `Trafilatura 未使用/失败（${fallbackReason}）` : null].filter(Boolean).join('；'),
      raw_html: html.slice(0, MAX_RAW_HTML_CHARS), raw_text: null,
    };
  }

  if (md) {
    const text = markdownToText(md).slice(0, maxChars);
    const cls = classifyPage(text);
    return {
      ok: !!text, text, title: null, extractor: 'markdown', extractor_version: CLEANER_VERSION,
      status: text ? 'ok' : 'failed', quality: cls.kind, chars: text.length,
      note: cls.reason, raw_html: null, raw_text: md.slice(0, MAX_RAW_HTML_CHARS),
    };
  }

  if (plain) {
    const text = cleanText(plain).slice(0, maxChars);
    const cls = classifyPage(text);
    return {
      ok: !!text, text, title: null, extractor: 'plain', extractor_version: CLEANER_VERSION,
      status: text ? 'ok' : 'failed', quality: cls.kind, chars: text.length,
      note: cls.reason, raw_html: null, raw_text: plain.slice(0, MAX_RAW_HTML_CHARS),
    };
  }

  return {
    ok: false, text: '', title: null, extractor: 'none', extractor_version: CLEANER_VERSION,
    status: 'failed', quality: 'empty', chars: 0, note: '没有可清洗的正文输入',
    raw_html: null, raw_text: null,
  };
}

/** 从已存提取记录重新清洗（后台重处理动作使用）。 */
export async function reCleanExtraction(row, opts = {}) {
  if (!row) return { ok: false, reason: 'extraction_not_found' };
  if (row.raw_html) {
    return cleanContent({ rawHtml: row.raw_html, url: row.source_url, ...opts });
  }
  if (row.raw_text) {
    return cleanContent({ rawText: row.raw_text, url: row.source_url, ...opts });
  }
  return { ok: false, reason: 'no_stored_source', message: '该条没有保存原始 HTML/文本，需先重新抓取' };
}
