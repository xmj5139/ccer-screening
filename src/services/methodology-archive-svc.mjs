/** Public original documents only. Search discovers; official notice and PDF establish identity. */
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { all, get, run, dbPath, audit } from '../core/db.mjs';
import { newId, nowIso } from '../core/util.mjs';
import { fetchText, recordSnapshot, sha256 } from './collect-svc.mjs';
import { runSearch, pickSearchProvider } from './search-svc.mjs';
import { extractHtmlText } from './web-fetch-svc.mjs';
import { extractPublishedDate } from './content-svc.mjs';
import { registerAttachment } from './policy-svc.mjs';
// 统一异步逐页解析（docs/36）：方法学官方 PDF 也走同一解析服务（缺页 → partial，不冒充全文）
import { parsePdfDocument } from './pdf-parse-svc.mjs';

const execFileAsync = promisify(execFile);
const official = url => { try { return new URL(url).hostname === 'www.mee.gov.cn'; } catch { return false; } };
const norm = text => String(text).replace(/[—–－]/g, '-').replace(/\s+/g, '');
export function parseMethodAttachments(html, baseUrl) {
  return [...html.matchAll(/<a\b[^>]*href=["']([^"']+\.pdf)["'][^>]*>([\s\S]*?)<\/a>/gi)]
    .map(m => ({ url: new URL(m[1], baseUrl).href, title: m[2].replace(/<[^>]*>/g, '').trim() }))
    .filter(a => official(a.url));
}

export async function backfillMethodologyOriginals({ actor = 'system:methodology-archive', limit = 24 } = {}) {
  const out = { checked: 0, codes_added: 0, archived: 0, parsed: 0, policies_added: 0, failures: [] };
  const provider = pickSearchProvider();
  const pages = new Map();
  const root = join(dirname(dbPath()), 'official-originals');
  await mkdir(root, { recursive: true });
  const methods = all("SELECT * FROM methodology_version WHERE document_status='formal' AND (original_file_hash IS NULL OR code_display IS NULL OR body_snapshot IS NULL) LIMIT ?", [limit]);
  for (const m of methods) {
    out.checked++;
    try {
      let urls = m.code_display && official(m.official_url) ? [m.official_url] : [];
      if (!urls.length && provider) {
        const r = await runSearch(provider, `site:mee.gov.cn 关于发布 方法学 ${m.name}`, { count: 6 });
        if (!r.ok) throw new Error(`搜索失败：${r.reason}`);
        urls = r.results.filter(x => official(x.url) && x.title.includes('关于发布') && !/征求意见/.test(x.title)).map(x => x.url);
      }
      let selected = null;
      for (const url of urls) {
        if (!pages.has(url)) pages.set(url, await fetchText(url, { allowedDomains: ['www.mee.gov.cn'], rateLimitPerMin: 12, retryMax: 1 }));
        const page = pages.get(url);
        if (!page.ok) continue;
        const attachments = parseMethodAttachments(page.body, url);
        const att = attachments.find(a => norm(a.title).includes(norm(m.name)) && /CCER[-—–－]\d{2}[-—–－]\d{3}[-—–－]V\d+/i.test(a.title));
        if (att) { selected = { url, page, att }; break; }
      }
      if (!selected) throw new Error('未找到名称与编号对应的官方 PDF 附件，保持缺失状态');
      const { url, page, att } = selected;
      const code = norm(att.title).match(/CCER-\d{2}-\d{3}-V\d+/i)?.[0];
      if (m.code_display && m.code_display !== code) throw new Error('已存编号与附件编号冲突，未覆盖');
      const snap = recordSnapshot({ url, res: page, parser: 'official-methodology-notice', parseQuality: 'good' });
      const now = nowIso();
      const text = extractHtmlText(page.body).content;
      const date = extractPublishedDate(page.body, { url, text });
      let pol = get('SELECT id FROM policy_document WHERE official_url=?', [url]);
      if (!pol) {
        pol = { id: newId('POL') };
        run(`INSERT INTO policy_document (id,policy_key,title,category,doc_status,publish_date,official_url,source_tier,body_snapshot,summary,collected_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [pol.id, 'notice-' + sha256(url), extractHtmlText(page.body).title || att.title, 'ministry_policy', 'notice', date.published_at, url, 1, text, text.slice(0, 500), now, now, now]);
        out.policies_added++;
      }
      const pdf = await fetchText(att.url, { allowedDomains: ['www.mee.gov.cn'], rateLimitPerMin: 12, retryMax: 1 });
      if (!pdf.ok || pdf.buf?.subarray(0, 5).toString() !== '%PDF-') throw new Error('官方附件下载失败或不是 PDF');
      const path = join(root, `${pdf.hash}.pdf`);
      await writeFile(path, pdf.buf);
      let body = null;
      let parseDetail = null;
      // 统一异步逐页解析（docs/36）：文本层 + 缺文字/乱码页 OCR；解析结果 JSON 落在 official-originals/ocr
      try {
        const parsed = await parsePdfDocument({ filePath: path, sha256: pdf.hash });
        parseDetail = {
          parser_version: parsed.parser_version, status: parsed.status,
          pages_total: parsed.pages_total, pages_text: parsed.pages_text,
          pages_ocr: parsed.pages_ocr, pages_failed: parsed.pages_failed,
          failed_pages: parsed.failed_pages || [], aborted: parsed.aborted || null,
        };
        const candidate = parsed.raw_text || parsed.text || '';
        if (candidate.length > 400 && norm(candidate).includes(code)) {
          body = candidate;
          try { await writeFile(path + '.txt', candidate, 'utf8'); } catch { /* 正文已入库，旁路写盘失败仅记录 */ }
        }
      } catch { /* Archive remains valid; parser absence is recorded without fabricating text. */ }
      if (!get('SELECT id FROM policy_attachment WHERE policy_id=? AND file_hash=?', [pol.id, pdf.hash])) {
        registerAttachment({ name: actor, role: 'admin' }, pol.id, { file_name: `${code}.pdf`, url: att.url, file_hash: pdf.hash, local_path: path, parse_quality: body ? 'good' : 'not_attempted', parse_note: body ? '官方 PDF 本地文本提取，编号与原文一致' : '已归档原件，尚未获得可核验文本' });
      }
      run(`UPDATE methodology_version SET code_display=?,official_url=?,catalog_confidence='verified_from_official_notice',original_file_hash=?,original_file_path=?,body_snapshot=?,evidence_note=?,updated_at=? WHERE id=?`,
        [code, url, pdf.hash, path, body, `官方附件名称与编号确定性比对；通知快照 ${snap.id}；PDF ${att.url}。测算规则未作审批。`, now, m.id]);
      out.codes_added += m.code_display ? 0 : 1;
      out.archived++; if (body) out.parsed++;
      audit({ actor, action: 'methodology.archive_original', objectType: 'methodology_version', objectId: m.id, detail: { code, url, pdf_url: att.url, hash: pdf.hash, parsed: !!body } });
    } catch (e) { out.failures.push({ name: m.name, error: e.message }); }
  }
  return out;
}
