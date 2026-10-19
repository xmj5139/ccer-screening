/**
 * PDF 解析 / OCR 运维 CLI（docs/36 第 6 条）
 * ============================================================================
 * 供 Codex 在**本地独立库**上部署与排障，支持三个子命令：
 *
 *   node scripts/ocr.mjs status                     真实缺口 / 受限根 / 配额 / 任务游标
 *   node scripts/ocr.mjs config [--enable] [--set k=v ...] [--clear-credentials]
 *                                                   查看或修改 OCR 与补跑配置
 *   node scripts/ocr.mjs reparse --kind=... --id=... [--force] [--dry-run]
 *                                                   按对象 ID 重解析（默认不覆盖已有正文）
 *
 * 【硬约束】
 *   · 复用 `initV2Env()`：默认指向独立库 data/ccer_v2.db，**绝不默认生产库**；
 *     显式把 CCER_DB_PATH 指向 data/ccer.db 时直接退出（不建连接、不改文件）；
 *   · **没有 reset / drop / delete 之类的破坏性命令**；
 *   · 只读取当前数据库目录下 official-originals / registry-files 两个受限根内的 PDF；
 *   · 不打印任何密钥、cipher 或 access_token。
 */
import { initV2Env, parseArgs } from './v2-env.mjs';

const args = parseArgs();
const cmd = String(args._[0] || 'status').toLowerCase();

const HELP = `
PDF 解析 / OCR 运维 CLI（默认使用独立库 data/ccer_v2.db，绝不动生产库）

  status
      真实缺口统计、受限根、OCR 配置与配额、补跑游标与最近任务。

  config [--enable|--disable] [--mode=accurate_basic|unsupported]
         [--max-docs=N] [--max-pages-per-doc=N] [--batch-budget-ms=N]
         [--daily-page-limit=N] [--daily-doc-limit=N] [--daily-docs=N]
         [--clear-credentials] [--probe-parser]
      查看（无参数）或修改配置。修改配置需要 --db 指向独立库（本脚本已强制）。
      --clear-credentials 才会删除已存凭据；不带该参数时凭据保持不变。
      --probe-parser 真实探测文档解析接口权限（失败即如实标 unsupported）。

  reparse --kind=<policy_attachment|policy_document|methodology_version|cea_document>
          --id=<对象ID> [--force] [--dry-run]
      按对象 ID 重解析。默认跳过已有正文的对象；--force 才重解析。
      --dry-run 只做路径校验与缺口判定，不解析、不写库。

  backfill [--limit=N] [--kind=...] [--id=...] [--daily]
      执行一批有界补跑（单并发、受配额与整批限时约束）。

示例：
  node scripts/ocr.mjs status
  node scripts/ocr.mjs config --enable --max-docs=5
  node scripts/ocr.mjs reparse --kind=cea_document --id=CEADOC-xxx --force
  node scripts/ocr.mjs backfill --limit=3
`;

if (cmd === 'help' || args.help) {
  console.log(HELP);
  process.exit(0);
}

const KNOWN = ['status', 'config', 'reparse', 'backfill'];
if (!KNOWN.includes(cmd)) {
  console.error(`✗ 未知子命令：${cmd}\n${HELP}`);
  process.exit(2);
}
if (args.reset || args.drop || args.wipe) {
  console.error('✗ 本 CLI 不提供任何破坏性命令（reset/drop/wipe）。');
  process.exit(2);
}

const { dbPath, guard } = await initV2Env({ temp: !!args.temp });
const db = await import('../src/core/db.mjs');
db.getDb();
const ocr = await import('../src/services/baidu-ocr-svc.mjs');
const backfill = await import('../src/services/ocr-backfill-svc.mjs');
const pdfParse = await import('../src/services/pdf-parse-svc.mjs');

const print = (o) => console.log(JSON.stringify(o, null, 2));

if (cmd === 'status') {
  const st = backfill.ocrBackfillStatus();
  console.log(`[ocr] 数据库：${dbPath}`);
  console.log(`[ocr] 受限根：${st.roots.join(' | ')}`);
  console.log(`[ocr] OCR 结果目录：${st.ocr_root}`);
  print({
    ocr_config: st.ocr_config,
    backfill_config: st.config,
    candidates: st.candidates,
    rejected_by_path: st.rejected_by_path,
    quota: st.quota,
    cursor: st.cursor,
    tasks: st.tasks.map((t) => ({ task_id: t.task_id, status: t.status, mode: t.mode, queued_at: t.queued_at, error: t.error })),
    candidate_sample: st.candidate_sample.slice(0, 10),
    rejected_sample: st.rejected_sample.slice(0, 10),
    note: st.note,
  });
} else if (cmd === 'config') {
  const patch = {};
  if (args.enable) patch.enabled = true;
  if (args.disable) patch.enabled = false;
  if (args.mode) patch.mode = String(args.mode);
  if (args['clear-credentials']) patch.clear_credentials = true;
  if (args['api-key']) patch.api_key = String(args['api-key']);
  if (args['secret-key']) patch.secret_key = String(args['secret-key']);
  const intKeys = ['daily_page_limit', 'daily_doc_limit', 'max_pages_per_doc', 'batch_budget_ms', 'request_timeout_ms'];
  for (const k of intKeys) {
    const v = args[k.replaceAll('_', '-')] ?? args[k];
    if (v !== undefined) patch[k] = Number(v);
  }
  const bfPatch = {};
  if (args['max-docs'] !== undefined) bfPatch.max_docs_per_run = Number(args['max-docs']);
  if (args['daily-docs'] !== undefined) bfPatch.daily_docs = Number(args['daily-docs']);
  if (args['batch-budget-ms'] !== undefined && patch.batch_budget_ms === undefined) {
    bfPatch.batch_budget_ms = Number(args['batch-budget-ms']);
  }

  const isWrite = Object.keys(patch).length > 0 || Object.keys(bfPatch).length > 0;
  if (!isWrite) {
    print({ db: dbPath, ocr_config: ocr.baiduOcrPublicConfig(), backfill_config: backfill.ocrBackfillConfig() });
  } else {
    // CLI 侧再确认一次：绝不作用于生产库（initV2Env 已强制，这里做双保险）
    if (guard.isProductionDb(dbPath)) {
      console.error('✗ 拒绝在疑似生产库上写配置。');
      process.exit(2);
    }
    const admin = { name: 'cli:ocr', role: 'admin' };
    const out = patch.clear_credentials || Object.keys(patch).length
      ? ocr.saveBaiduOcrConfig(admin, patch)
      : { ok: true };
    if (out.error) { console.error(`✗ ${out.error}`); process.exit(2); }
    let bf = null;
    if (Object.keys(bfPatch).length) {
      bf = backfill.saveOcrBackfillConfig(admin, bfPatch);
      if (bf.error) { console.error(`✗ ${bf.error}`); process.exit(2); }
    }
    print({
      ok: true,
      credential_action: out.credential_action || 'kept',
      ocr_config: out.config || ocr.baiduOcrPublicConfig(),
      backfill_config: bf?.config || backfill.ocrBackfillConfig(),
    });
  }
  if (args['probe-parser']) {
    const probe = await ocr.probeDocParserCapability({ actor: 'cli:ocr' });
    print({ probe: { ok: probe.ok, state: probe.state, error_category: probe.error_category || null, message: probe.message } });
  }
} else if (cmd === 'reparse') {
  const kind = String(args.kind || '');
  const id = String(args.id || '');
  if (!kind || !id) {
    console.error('✗ 需要 --kind=<类型> 与 --id=<对象ID>');
    process.exit(2);
  }
  const allowed = ['policy_attachment', 'policy_document', 'methodology_version', 'cea_document'];
  if (!allowed.includes(kind)) {
    console.error(`✗ --kind 须为 ${allowed.join(' | ')}`);
    process.exit(2);
  }
  if (args['dry-run']) {
    const scan = backfill.scanOcrCandidates({ limit: 2000, objectId: id });
    const hit = scan.candidates.find((c) => c.kind === kind && c.id === id);
    const rejected = scan.rejected.find((c) => c.kind === kind && c.id === id);
    print({
      dry_run: true, kind, id,
      candidate: hit || null,
      rejected: rejected ? { reason: rejected.reject_reason } : null,
      roots: scan.roots,
      note: '仅做受限根校验与缺口判定，未解析、未写库。',
    });
    process.exit(hit ? 0 : 3);
  }
  const out = await backfill.reparseObject({ kind, id, actor: 'cli:ocr', force: args.force === true });
  if (out.error) { console.error(`✗ ${out.error}`); print(out); process.exit(2); }
  print(out);
  process.exit(out.ok ? 0 : 3);
} else if (cmd === 'backfill') {
  if (args.daily) {
    const out = await backfill.runDailyOcrBackfill({ actor: 'cli:ocr' });
    print({ ...out, docs: out.docs?.map((d) => ({ ...d, text: undefined })) });
    process.exit(out.ok_count > 0 || (!out.error && !out.candidates && !out.rejected_by_path) ? 0 : 3);
  }
  const out = await backfill.runBackfillBatch({
    actor: 'cli:ocr',
    limit: Number(args.limit) || backfill.ocrBackfillConfig().max_docs_per_run,
    objectKind: args.kind ? String(args.kind) : null,
    objectId: args.id ? String(args.id) : null,
    trigger: 'cli',
  });
  print({ ...out, docs: out.docs.map((d) => ({ ...d, text: undefined })) });
  process.exit(out.ok_count > 0 || (!out.error && !out.candidates && !out.rejected_by_path) ? 0 : 3);
}

console.log(`[ocr] 解析器版本：${pdfParse.PDF_TEXT_PARSER_VERSION}`);
db.closeDb();
