/**
 * 政策原件归档服务
 * ============================================================================
 * 需求（docs/19 + docs/22 第 16 条 / data_gap: gap-policy-original-archive）：
 *   政策条目必须能回溯到**可核验的官方原件**：本地落盘文件 + SHA-256 + 解析状态。
 *   未归档时条款只能引用到文件与章节层级，**不得声称已读原文**。
 *
 * 【口径纪律】
 *   1. 「已归档」= 有本地落盘文件（local_path）且记录了 SHA-256（file_hash），
 *      解析质量为 good / partial。仅把 `parse_quality` 写成 `good` 而**没有**
 *      本地文件与哈希的旧记录，只能算「官方页面已核对」，**不算原件已归档**。
 *   2. 只抓取白名单内的官方域名（生态环境部 / 全国温室气体自愿减排注册登记系统）。
 *   3. 抓取失败、页面过短（疑似跳转/错误页）、非 PDF 却声明为 PDF 等情形，
 *      一律如实记录失败原因，不用摘要或第三方转载冒充官方原件。
 *   4. PDF 文本提取依赖本机 pdftotext；不可用时保留原件并如实标记
 *      `parse_quality='partial'`，不伪造页码级文本。
 */
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { all, get, run, audit, dbPath } from '../core/db.mjs';
import { nowIso } from '../core/util.mjs';
import { fetchText, recordSnapshot, DEFAULT_ALLOWED_DOMAINS } from './collect-svc.mjs';
import { extractHtmlText } from './web-fetch-svc.mjs';
import { registerAttachment, isAttachmentArchived } from './policy-svc.mjs';
// 统一异步逐页解析（docs/36 第 2、5 条）：PDF 正文优先走统一服务，缺文字页再走 OCR
import { parsePdfDocument } from './pdf-parse-svc.mjs';

const execFileAsync = promisify(execFile);

/** 归档根目录：与数据库同级的 data/official-originals（与既有 PDF 归档保持一致） */
export function archiveRoot() {
  return join(dirname(dbPath()), 'official-originals');
}

/**
 * 政策**两种证据需求**的实时状态（docs/36 第 7 条）。
 *
 *   证据 A：可核对的**网页正文**（HTML full_text，政策正文快照）→ 满足「条款可按章节引用」；
 *   证据 B：可核验的**官方 PDF 附件原件**（本地文件 + SHA-256）→ 满足「条款可按页引用」。
 *
 * 关键修正：网页已有可核对正文时，**不因缺少 PDF 附件**就把它算成「PDF 未解析」缺口；
 * 反之亦然——有 PDF 但正文提取失败时，也不能因为页面存在就声称已读原文。
 *
 * 【旧证据保留】同一政策下已被更新归档替代的历史附件（如 `not_attempted`）
 * 在展示层标为 `superseded_by_newer_archive` 并保留原行，**不删除**。
 */
export function policyArchiveStatus(policyId) {
  const p = get(
    'SELECT id,title,official_url,local_path,original_file_hash,body_snapshot,doc_status,duplicate_of FROM policy_document WHERE id = ?',
    [policyId]
  );
  if (!p) return { archived: false, reason: '政策条目不存在', attachments: [], evidence: null };

  const attachments = all('SELECT * FROM policy_attachment WHERE policy_id = ? ORDER BY created_at DESC', [policyId]);
  const archivedAtts = attachments.filter(isAttachmentArchived);
  const goodAtts = archivedAtts.filter((a) => a.parse_quality === 'good');
  const bestAtt = goodAtts[0] || archivedAtts[0] || null;

  // 旧证据不删除：被更新的有效归档替代的附件在展示层标注历史/已替代
  const attachmentsView = attachments.map((a) => {
    const isCurrent = bestAtt && a.id === bestAtt.id;
    const superseded = !!bestAtt && !isCurrent && isAttachmentArchived(a) === false
      ? true
      : !!bestAtt && !isCurrent && (a.parse_quality !== 'good');
    return {
      ...a,
      is_current_archive: isCurrent,
      display_status: isCurrent ? (a.parse_quality || 'archived') : superseded ? 'superseded_by_newer_archive' : (a.parse_quality || 'unknown'),
      superseded_by: superseded ? bestAtt.id : null,
      display_note: isCurrent
        ? '当前有效归档'
        : superseded
          ? `历史证据（已被更新的有效归档 ${bestAtt.id} 替代）；原始记录保留，不删除`
          : (a.parse_note || null),
    };
  });

  const policyBody = typeof p.body_snapshot === 'string' ? p.body_snapshot : '';
  const htmlBodySatisfied = policyBody.replace(/\s+/g, '').length >= 200;
  const pdfBodySatisfied = !!(bestAtt && bestAtt.parse_quality === 'good' && bestAtt.local_path);
  const bodySatisfied = htmlBodySatisfied || pdfBodySatisfied;
  const originalSatisfied = archivedAtts.length > 0 || !!(p.local_path && p.original_file_hash);

  const evidence = {
    html_body: {
      required_for: '按章节引用条款（HTML 无固定页码）',
      satisfied: htmlBodySatisfied,
      chars: policyBody.replace(/\s+/g, '').length,
      source: htmlBodySatisfied ? 'policy_document.body_snapshot（官方网页正文快照）' : null,
    },
    pdf_original: {
      required_for: '按页引用条款（页码级原文）',
      satisfied: pdfBodySatisfied,
      original_archived: originalSatisfied,
      hash: bestAtt?.file_hash || p.original_file_hash || null,
      local_path: bestAtt?.local_path || p.local_path || null,
      parse_quality: bestAtt?.parse_quality || null,
      source: pdfBodySatisfied ? 'policy_attachment（官方 PDF 原件 + SHA-256）' : null,
    },
    body_satisfied: bodySatisfied,
    original_satisfied: originalSatisfied,
  };

  const out = {
    policy_id: p.id, title: p.title, doc_status: p.doc_status,
    archived: originalSatisfied, via: archivedAtts.length ? 'attachment' : (p.local_path && p.original_file_hash ? 'policy_document' : null),
    archived_attachments: archivedAtts, attachments: attachmentsView, evidence,
    reason: null, body_reason: null,
  };
  if (!bodySatisfied) {
    out.body_reason = originalSatisfied
      ? '原件已归档，但两条证据路径都没有可核对正文（HTML 正文快照缺失 + PDF 正文未提取成功）'
      : '原件未归档，也没有可核对正文';
  }
  if (!originalSatisfied) {
    const uploaded = get(
      "SELECT source_status,parse_quality FROM document_upload WHERE target_kind='policy' AND target_id=? ORDER BY created_at DESC LIMIT 1",
      [policyId]
    );
    if (uploaded && uploaded.source_status !== 'official_hash_match') {
      out.upload = uploaded;
      out.reason = `管理员已补充 PDF（解析状态 ${uploaded.parse_quality}），官方来源尚未独立核实`;
    } else if (!p.official_url) {
      out.reason = '缺少官方原文链接，无法自动归档原件';
      out.attachments_note = attachments.length ? '存在登记记录但没有本地文件与哈希' : '无附件记录';
    } else {
      out.reason = attachments.length
        ? '已有附件登记记录，但没有本地文件与 SHA-256（仅「官方页面已核对」占位，不构成原件归档）'
        : '尚未下载归档原件';
    }
  }
  return out;
}


/** 官方 URL 是否指向 PDF 文件本身 */
function looksLikePdfUrl(url) {
  try {
    return /\.pdf(\?|#|$)/i.test(new URL(url).pathname + (new URL(url).search || ''));
  } catch {
    return false;
  }
}

/**
 * 归档单个政策的官方原件。
 * @returns {Promise<{ok:boolean, skipped?:boolean, reason?:string, attachment_id?:string, hash?:string, local_path?:string, parse_quality?:string}>}
 */
export async function archivePolicyOriginal(policyId, { actor = 'system:policy-archive', force = false } = {}) {
  const p = get('SELECT * FROM policy_document WHERE id = ?', [policyId]);
  if (!p) return { ok: false, reason: '政策条目不存在' };
  if (!p.official_url) return { ok: false, skipped: true, reason: '缺少官方原文链接，无法归档（保持真实缺口）' };
  const status = policyArchiveStatus(policyId);
  if (status.archived && !force) {
    return { ok: true, skipped: true, reason: '已有可核验的原件归档，跳过重复下载' };
  }

  const res = await fetchText(p.official_url, {
    headers: { referer: 'https://www.mee.gov.cn/' },
    allowedDomains: DEFAULT_ALLOWED_DOMAINS,
    rateLimitPerMin: 10,
    retryMax: 1,
  });
  if (!res.ok) {
    return { ok: false, reason: `官方页面抓取失败：${res.error || res.status}` };
  }
  const isPdf = res.buf?.subarray(0, 5).toString() === '%PDF-' || looksLikePdfUrl(p.official_url);
  if (looksLikePdfUrl(p.official_url) && res.buf?.subarray(0, 5).toString() !== '%PDF-') {
    return { ok: false, reason: '官方 URL 声明为 PDF，但响应不是 PDF，未归档（不保存错误页）' };
  }
  const text = res.body || '';
  if (!isPdf && text.replace(/<[^>]*>/g, '').replace(/\s+/g, '').length < 60) {
    return { ok: false, reason: '页面正文过短（疑似跳转/错误页），未归档' };
  }

  const root = archiveRoot();
  await mkdir(root, { recursive: true });
  const ext = isPdf ? 'pdf' : 'html';
  const filePath = join(root, `${res.hash}.${ext}`);
  await writeFile(filePath, res.buf);
  // 政策级正文快照：只有取得真实正文才写（HTML 走抽取，PDF 走逐页解析）
  let bodySnapshot = null;

  // 解析：PDF 走统一异步逐页解析服务（缺文字/乱码页再走 OCR）；HTML 用内置正文抽取
  let parseQuality = 'partial';
  let parseNote = null;
  let parseDetail = null;
  if (isPdf) {
    const parsed = await parsePdfDocument({ filePath, sha256: res.hash });
    parseDetail = {
      parser_version: parsed.parser_version, status: parsed.status,
      pages_total: parsed.pages_total, pages_text: parsed.pages_text,
      pages_ocr: parsed.pages_ocr, pages_failed: parsed.pages_failed,
      failed_pages: parsed.failed_pages || [], aborted: parsed.aborted || null,
    };
    if (parsed.text && parsed.chars > 0) {
      // 每一页都成功才算 good；只要缺页就是 partial（不把缺页判成全文）
      parseQuality = parsed.status === 'full' ? 'good' : 'partial';
      await writeFile(`${filePath}.txt`, parsed.text, 'utf8');
      parseNote =
        `逐页解析（${parsed.parser_version}）：共 ${parsed.pages_total} 页，文本层 ${parsed.pages_text} 页 + OCR ${parsed.pages_ocr} 页，` +
        `失败 ${parsed.pages_failed} 页 → ${parsed.status}`;
      bodySnapshot = parsed.text;
    } else {
      parseNote =
        `已归档原件，但逐页解析未取得可用正文（${parsed.error || parsed.note || '无可用页'}）：` +
        '多为扫描件，需配置 OCR 后补跑或在「PDF 解析/OCR」页签处理（不伪造页码文本）';
    }
  } else {
    const extracted = extractHtmlText(res.body);
    if (extracted.content && extracted.content.length > 200) {
      parseQuality = 'good';
      parseNote = '官方页面原件已落盘并提取正文（HTML 无固定页码，按章节引用）';
      const bodyPath = `${filePath}.txt`;
      await writeFile(bodyPath, extracted.content, 'utf8');
      bodySnapshot = extracted.content;
    } else {
      parseNote = '官方页面原件已落盘，但正文抽取结果过短（可能为脚本渲染页）';
    }
  }

  const snap = recordSnapshot({
    url: p.official_url, res, sourceId: p.source_id || null,
    parser: isPdf ? 'policy_original_pdf' : 'policy_original_html',
    parseQuality, parseNote,
  });

  const fileName = `${isPdf ? 'policy' : 'policy-page'}-${res.hash.slice(0, 12)}.${ext}`;
  const reg = registerAttachment({ name: actor, role: 'admin' }, policyId, {
    file_name: fileName,
    file_type: isPdf ? 'pdf' : 'html',
    url: p.official_url,
    file_hash: res.hash,
    local_path: filePath,
    parse_quality: parseQuality,
    parse_note: parseDetail ? `${parseNote}；${JSON.stringify(parseDetail)}` : parseNote,
  });
  // 有正文才写 body_snapshot（HTML 抽取结果 / PDF 逐页解析结果）；原件字节本身不改动
  run(
    'UPDATE policy_document SET local_path = ?, body_snapshot = COALESCE(?, body_snapshot), updated_at = ? WHERE id = ?',
    [filePath, bodySnapshot, nowIso(), policyId]
  );

  audit({
    actor, action: 'policy.archive_original', objectType: 'policy_document', objectId: policyId,
    detail: {
      url: p.official_url, file_hash: res.hash, local_path: filePath,
      file_type: isPdf ? 'pdf' : 'html', parse_quality: parseQuality, snapshot_id: snap.id,
      parse_detail: parseDetail, body_chars: bodySnapshot ? bodySnapshot.length : 0,
    },
  });
  return {
    ok: true, attachment_id: reg.id, hash: res.hash, local_path: filePath,
    file_type: isPdf ? 'pdf' : 'html', parse_quality: parseQuality, bytes: res.bytes, snapshot_id: snap.id,
    parse_detail: parseDetail, body_chars: bodySnapshot ? bodySnapshot.length : 0,
  };
}

/**
 * 归档所有缺少可核验原件的政策。
 * @returns {Promise<{checked:number, archived:number, skipped:number, failed:Array<{id,title,reason}>}>}
 */
export async function archiveMissingPolicyOriginals({ actor = 'system:policy-archive', limit = 50 } = {}) {
  const cap = Math.min(Math.max(Number(limit) || 50, 1), 500);
  const rows = all(
    `SELECT id, title, official_url FROM policy_document
     WHERE doc_status != 'superseded' AND duplicate_of IS NULL ORDER BY COALESCE(publish_date,'1900-01-01') DESC`,
  );
  const out = { checked: 0, archived: 0, skipped: 0, failed: [] };
  for (const r of rows) {
    const st = policyArchiveStatus(r.id);
    if (st.archived) { out.skipped += 1; continue; }
    if (out.checked >= cap) break;
    out.checked += 1;
    const res = await archivePolicyOriginal(r.id, { actor });
    if (res.ok && !res.skipped) out.archived += 1;
    else if (res.skipped) out.skipped += 1;
    else out.failed.push({ id: r.id, title: r.title, reason: res.reason });
  }
  return out;
}

/**
 * 按**实时**归档状态计算 `gap-policy-original-archive` 的口径文案。
 *
 * 【回归修复】旧实现只更新 description 与 status，title / impact / auto_action
 * 仍停留在「部分政策原件（PDF）尚未归档与页码提取」的基线文案；当原件已全部
 * 归档、只剩 2 条 JS 渲染页正文不可提取时，总览标题与事实相反。
 * 现在标题、影响、自动处理方式与描述**同源同算**，三种状态如实区分：
 *   1. 全部归档且正文可提取        → closed；
 *   2. 原件已全部归档但正文抽取受阻 → open，标题写明「已归档 N/N，M 条正文暂无法自动提取」；
 *   3. 仍有政策没有可核验原件       → open，标题写明待归档条数。
 * 展示层（dashboard-svc.decorateGap）也按本函数实时推导，避免台账未及时同步时
 * 界面出现与事实相反的标题。
 */
export function policyArchiveGapState() {
  const policies = all(
    `SELECT id, title, official_url, body_snapshot, local_path, original_file_hash
     FROM policy_document WHERE doc_status != 'superseded' AND duplicate_of IS NULL
     ORDER BY COALESCE(publish_date,'1900-01-01') DESC`
  );
  const pending = [];
  const unparsed = [];
  const html_body_only = [];
  const page_partial = [];
  for (const p of policies) {
    const st = policyArchiveStatus(p.id);
    const ev = st.evidence || {};
    // 缺正文 = 两种证据（网页正文 / PDF 附件正文）都不成立；
    // **网页已有可核对 full_text 时不因缺少 PDF 附件而计入正文缺口**（docs/36 第 7 条）
    if (!ev.body_satisfied) {
      if (st.archived) {
        const att = (st.archived_attachments || [])[0];
        unparsed.push({
          id: p.id, title: p.title,
          local_path: att?.local_path || p.local_path || null,
          parse_quality: att?.parse_quality || 'unknown',
          parse_note: att?.parse_note || null,
          reason: st.body_reason,
          evidence: ev,
        });
      } else {
        pending.push({ id: p.id, title: p.title, reason: st.reason, evidence: ev });
      }
      continue;
    }
    // 正文已满足但只是部分页（PDF 原件部分页成功）→ 单独列出，不冒充全文
    const att = (st.archived_attachments || [])[0] || null;
    if (att && att.local_path && att.parse_quality === 'partial') {
      page_partial.push({ id: p.id, title: p.title, local_path: att.local_path, parse_note: att.parse_note });
    }
    // 正文由网页提供、但没有可核验 PDF 附件 → 如实单列（这是「PDF 附件缺失」，不是「PDF 未解析」）
    if (ev.html_body?.satisfied && !ev.pdf_original?.satisfied) {
      html_body_only.push({
        id: p.id, title: p.title,
        html_chars: ev.html_body.chars,
        pdf_original_archived: !!ev.pdf_original?.original_archived,
        note: '网页正文（HTML full_text）已可核对并按章节引用；PDF 附件原件缺失不影响正文可用性。',
      });
    }
  }
  const total = policies.length;
  const now = nowIso();
  const unparsedDetail = unparsed
    .slice(0, 10)
    .map((x) => `${x.title}（${x.parse_quality}：${x.parse_note || '正文抽取失败'}）`)
    .join('；');

  if (!pending.length && !unparsed.length) {
    return {
      total, pending, unparsed, html_body_only, page_partial, status: 'closed', computed_at: now,
      title: '政策官方原件归档与正文提取（全部完成）',
      description:
        `截至 ${now.slice(0, 10)}：全部 ${total} 条现行政策都取得了**可核对正文**（网页正文 full_text 与/或 PDF 页码级文本），` +
        `原件（本地文件 + SHA-256）已归档；其中 ${html_body_only.length} 条以网页正文为正文证据、` +
        `${page_partial.length} 条 PDF 仅部分页成功（已按 partial 标注）。`,
      impact:
        '无缺少正文的政策条目；条款可按页（PDF）或按章节（HTML）引用。' +
        (html_body_only.length ? `其中 ${html_body_only.length} 条没有 PDF 附件正文，按章节引用。` : ''),
      auto_action:
        '随每日巡检自动检查新增政策的官方原件与正文提取，逐条保存本地文件、SHA-256 与解析质量；' +
        'HTML 正文与 PDF 附件作为**两种独立证据**分别判定，缺任一种都不影响另一种的结论；' +
        '缺失或抽取失败时自动重试并在「PDF 解析/OCR」页签按对象补跑。',
    };
  }

  if (!pending.length) {
    return {
      total, pending, unparsed, html_body_only, page_partial, status: 'open', computed_at: now,
      title: `政策官方原件已全部归档（${total}/${total}），${unparsed.length} 条正文不可提取`,
      description:
        `截至 ${now.slice(0, 10)}：原件**已归档**（本地文件 + SHA-256 可核验）但正文不可提取的有 ${unparsed.length} 条：${unparsedDetail}。` +
        `（另有 ${html_body_only.length} 条以网页正文（HTML full_text）为正文证据、${page_partial.length} 条 PDF 仅部分页成功，` +
        '均已按实际证据分别标注，**不计入**上面的正文不可提取条目。）' +
        '正文不可提取的条目在取得官方 PDF、可渲染抓取通道或完成 OCR 补跑前，条款只能引用到文件层级，**不声称已读原文**。',
      impact:
        `仅这 ${unparsed.length} 条条款无法按正文/页码引用（只能引用到文件与章节层级）；` +
        '其余条目的正文已可提取，不受影响。不以推测文本或第三方转载代替官方原文。' +
        '网页正文与 PDF 附件是**两种独立证据**：缺少 PDF 附件不使已有的网页正文失效。',
      auto_action:
        '原件已落盘并记录 SHA-256；随每日巡检自动重试正文提取，并在「PDF 解析/OCR」页签按对象补跑' +
        '（文本层 → 缺失/乱码页 OCR）。页面为前端渲染时**自动核验受阻**，正文状态如实标注「未核实」，' +
        '并在取得官方 PDF 或可渲染通道后自动补核。',
    };
  }

  const pendingDetail = pending.slice(0, 10).map((x) => `${x.title}（${x.reason}）`).join('；');
  return {
    total, pending, unparsed, html_body_only, page_partial, status: 'open', computed_at: now,
    title: `政策官方原件尚未全部归档（待归档 ${pending.length} / 共 ${total} 条）`,
    description:
      `截至 ${now.slice(0, 10)}：` +
      `尚未归档原件且无正文证据 ${pending.length} / ${total} 条：${pendingDetail}` +
      (pending.length > 10 ? ` 等 ${pending.length} 条` : '') +
      (unparsed.length
        ? `。另有 ${unparsed.length} 条原件**已归档**（本地文件 + SHA-256 可核验）但正文不可提取：${unparsedDetail}。` +
          '正文不可提取的条目在取得官方 PDF、可渲染抓取通道或完成 OCR 补跑前，条款只能引用到文件层级，**不声称已读原文**。'
        : '。') +
      `（以网页正文为正文证据的 ${html_body_only.length} 条、PDF 仅部分页成功的 ${page_partial.length} 条已分别标注，不计入上面的正文不可提取条目。）`,
    impact:
      `未归档的 ${pending.length} 条政策条款无法按页码引用，规则卡 clause_ref 只能引用到文件与章节层级；` +
      '系统不使用摘要或第三方转载冒充官方原件。' +
      '网页正文与 PDF 附件是**两种独立证据**：缺少 PDF 附件不使已有的网页正文失效，反之亦然。',
    auto_action:
      '随每日巡检自动抓取官方原件并计算 SHA-256（失败自动重试）；' +
      '抓取失败或页面不可用时如实登记原因，不用摘要或第三方转载冒充原件，归档前条款只引用到文件与章节层级；' +
      '已在库的 PDF 原件由「PDF 解析/OCR」页签按对象逐页补跑。',
  };
}

/**
 * 把实时缺口状态写入 `data_gap` 台账（title/description/impact/auto_action/status 同源更新）。
 * 幂等：字段无变化时一行不写；每次实际变更写 audit_log。
 */
export function syncPolicyArchiveGap({ actor = 'system:policy-archive' } = {}) {
  const state = policyArchiveGapState();
  const gap = get("SELECT * FROM data_gap WHERE gap_key = 'gap-policy-original-archive'");
  if (!gap) {
    return { updated: false, pending: state.pending.length, unparsed: state.unparsed.length, reason: '缺口台账无此条目' };
  }
  const patch = {
    title: state.title,
    description: state.description,
    impact: state.impact,
    auto_action: state.auto_action,
    status: state.status,
  };
  const changed = Object.keys(patch).filter((k) => String(gap[k] ?? '') !== String(patch[k] ?? ''));
  const out = {
    updated: changed.length > 0,
    closed: state.status === 'closed',
    pending: state.pending.length,
    unparsed: state.unparsed.length,
    total: state.total,
    changed_fields: changed,
    items: state.pending,
    unparsed_items: state.unparsed,
  };
  if (!changed.length) return out;
  run(
    `UPDATE data_gap SET title=?, description=?, impact=?, auto_action=?, status=?, updated_at=? WHERE gap_key='gap-policy-original-archive'`,
    [patch.title, patch.description, patch.impact, patch.auto_action, patch.status, nowIso()]
  );
  audit({
    actor, action: 'data_gap.sync', objectType: 'data_gap', objectId: gap.id,
    detail: {
      fields: changed, status: state.status,
      pending: state.pending.length, unparsed: state.unparsed.length, total: state.total,
      before: { title: gap.title, impact: gap.impact, auto_action: gap.auto_action, status: gap.status },
    },
  });
  return out;
}
