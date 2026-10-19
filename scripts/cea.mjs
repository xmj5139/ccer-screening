/**
 * CEA CLI
 * ============================================================================
 * 用法（PowerShell / bash 通用）：
 *   node scripts/cea.mjs <命令> [选项]
 *
 * 命令：
 *   status                     来源、配额、AI 服务、缺口与最近任务的真实状态
 *   sources [--dataset=daily]  列出已登记的 CEA 官方来源
 *   seed                       幂等写入来源登记与已确认的政策/日历基础元数据
 *   collect [--target=daily|documents|entities|intentions|all]
 *           [--sources=cea_daily_sample_1,cea_daily_sample_2]
 *           [--dates=2026-07-30,2026-08-11] [--limit=8] [--all-versions]
 *                             有界采集（默认 1 轮、每轮 ≤8 条、总时长 ≤120 秒）
 *   parse --file=<path> [--url=...] [--date=YYYY-MM-DD]
 *                             只解析本地原文（不发网络请求、不写库）
 *   verify [--target=documents|records] [--id=...] [--limit=8]
 *                             调用既有核验服务；未配置模型则保持 unavailable
 *   scenario --E=.. --A=.. --C=.. --U=.. --r=.. --P1=.. --P2=.. [--extra-cost=..]
 *                             履约成本情景（只计算，不写库）
 *   export --dataset=trade|entities|intentions|documents|events [--format=csv|json] [--out=path]
 *   jobs [--limit=20]          最近 CEA 任务与步骤
 *   gaps [--status=open]       CEA 数据缺口
 *
 * 环境约束（与本轮开发硬约束一致）：
 *   - CCER_DB_PATH 必须指向独立库（默认 data/cea-dev-20261014.db），指向 data/ccer.db 时直接退出；
 *   - CCER_ENABLE_V2=1 才会执行增量迁移；
 *   - 不打印任何凭据；不修改账号与密钥。
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { initV2Env, parseArgs } from './v2-env.mjs';

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0] || 'status';

const CEA_DB_DEFAULT = 'data/cea-dev-20261014.db';
if (!process.env.CCER_DB_PATH) process.env.CCER_DB_PATH = CEA_DB_DEFAULT;

await initV2Env({ quiet: false });
const db = await import('../src/core/db.mjs');
const cea = await import('../src/services/cea-svc.mjs');
const collect = await import('../src/services/cea-collect-svc.mjs');
const parse = await import('../src/services/cea-parse.mjs');

const out = (v) => console.log(JSON.stringify(v, null, 2));
const listOf = (v) => (v === undefined || v === null || v === '' ? [] : String(v).split(',').map((s) => s.trim()).filter(Boolean));

/**
 * 退出码统一在 finally 中设置，避免在 try 内直接 process.exit：
 * 进程立即退出会让 SQLite 连接来不及关闭，在 Windows 上触发 libuv 断言。
 */
let exitCode = 0;

try {
  if (cmd === 'status') {
    db.getDb();
    const s = collect.ceaSyncStatus();
    const st = cea.ceaStatus();
    out({
      db: db.dbPath(),
      schema_version: db.metaValue('schema_version', null),
      schema_cea_applied: db.metaValue('schema_version_cea_applied', null),
      counts: st.counts,
      quota: s.quota,
      ai: s.ai,
      search: s.search,
      fetch: s.fetch,
      sources: st.sources.map((x) => ({ code: x.code, dataset: x.dataset, enabled: x.enabled, last_status: x.last_status, last_success_at: x.last_success_at, last_error: x.last_error })),
      cursors: s.cursors,
      gaps: s.gaps,
      last_jobs: s.last_jobs,
    });
  } else if (cmd === 'sources') {
    db.getDb();
    out(cea.listCeaSources({ dataset: args.dataset || null }));
  } else if (cmd === 'seed') {
    db.getDb();
    out(cea.seedCeaBaseData({ actor: 'cli:cea-seed' }));
  } else if (cmd === 'collect') {
    db.getDb();
    cea.seedCeaBaseData({ actor: 'cli:cea-seed' });
    const target = String(args.target || 'daily');
    const sources = listOf(args.sources);
    const dates = listOf(args.dates);
    const onlyNew = args['all-versions'] ? false : args.onlyNew !== 'false';
    let res;
    if (target === 'json') {
      res = await collect.collectCeaJsonDaily({
        actor: 'cli:cea-collect', trigger: 'cli', dates: dates.length ? dates : null,
      });
    } else if (target === 'daily') {
      res = await collect.collectCeaDaily({
        actor: 'cli:cea-collect', trigger: 'cli',
        sources: sources.length ? sources : null,
        dates: dates.length ? dates : null,
        onlyNew, limit: args.limit ? Number(args.limit) : null,
      });
    } else if (target === 'documents') {
      res = await collect.collectCeaDocuments({ actor: 'cli:cea-collect', trigger: 'cli', codes: sources.length ? sources : null });
    } else if (target === 'entities') {
      res = args.discover
        ? await collect.collectCeaEntitiesFromDiscovery({
            actor: 'cli:cea-collect', trigger: 'cli', limit: args.limit ? Number(args.limit) : 3,
            listYear: args.year ? Number(args.year) : null, query: args.query || null,
          })
        : await collect.collectCeaEntities({
            actor: 'cli:cea-collect', trigger: 'cli', codes: sources.length ? sources : null,
            listYear: args.year ? Number(args.year) : null, province: args.province || null,
          });
    } else if (target === 'intentions') {
      res = await collect.collectCeaIntentions({ actor: 'cli:cea-collect', trigger: 'cli' });
    } else if (target === 'research') {
      // 研报/动态：有界定向发现 + 全文取得后核验（复用已配置搜索/抓取/模型）
      res = await collect.collectCeaResearch({
        actor: 'cli:cea-collect', trigger: 'cli',
        limit: args.limit ? Number(args.limit) : 6,
        queries: args.query ? [String(args.query)] : null,
      });
    } else if (target === 'all') {
      res = await collect.runCeaDailyStep({ actor: 'cli:cea-collect', trigger: 'cli' });
    } else {
      console.error(`未知 --target=${target}（可选 json/daily/documents/entities/intentions/research/all）`);
      exitCode = 2;
    }
    out(res);
    const failed = res?.failed?.length || res?.error_count || 0;
    exitCode = failed && !(res?.collected?.length || res?.ok?.length) ? 1 : 0;
  } else if (cmd === 'parse') {
    // 只解析本地文件：不发网络请求、不写库（可用于核对解析器与原文的对应关系）
    const file = args.file;
    if (!file) {
      console.error('需要 --file=<本地原文路径>（HTML 或纯文本）');
      exitCode = 2;
    }
    const { readFileSync } = await import('node:fs');
    const content = readFileSync(resolve(file), 'utf8');
    const parsed = parse.parseCeaDailyReport(content, { url: args.url || '', tradeDateHint: args.date || null });
    const checks = parse.runDailyChecks({ ...parsed.fields, ...parse.deriveDaily(parsed.fields) }, {});
    out({ file: resolve(file), parsed, deterministic_checks: checks });
  } else if (cmd === 'verify') {
    db.getDb();
    const target = String(args.target || 'documents');
    if (args.id) {
      const { verifyObject } = await import('../src/services/verification-svc.mjs');
      out(await verifyObject(args.object_type || 'cea_document', args.id, { actor: 'cli:cea-verify', force: args.force === true }));
    } else if (target === 'documents') {
      out(await collect.verifyCeaDocuments({ actor: 'cli:cea-verify', limit: Number(args.limit) || 8 }));
    } else {
      const rows = db.all("SELECT id FROM cea_trade_daily WHERE verification_status='unverified' ORDER BY trade_date DESC LIMIT ?", [Number(args.limit) || 8]);
      out(await collect.verifyCollectedCea(rows.map((r) => r.id), { actor: 'cli:cea-verify', limit: Number(args.limit) || 8 }));
    }
  } else if (cmd === 'scenario') {
    const numOrUndef = (v) => (v === undefined || v === '' ? undefined : Number(v));
    out(cea.runCeaScenario({
      E: numOrUndef(args.E), A: numOrUndef(args.A), C: numOrUndef(args.C), U: numOrUndef(args.U),
      r: numOrUndef(args.r), P1: numOrUndef(args.P1), P2: numOrUndef(args.P2),
      extra_cost: args['extra-cost'] !== undefined ? Number(args['extra-cost']) : undefined,
    }));
  } else if (cmd === 'export') {
    db.getDb();
    const dataset = String(args.dataset || 'trade');
    const built = cea.ceaExportRows(dataset, {
      from: args.from || null, to: args.to || null, province: args.province || null, list_year: args.year || null,
    });
    if (built.error) {
      console.error(built.error);
      exitCode = 2;
    }
    const format = String(args.format || 'csv').toLowerCase();
    if (format === 'json') {
      const body = JSON.stringify({ dataset, meta: built.meta, columns: built.columns, rows: built.rows }, null, 2);
      if (args.out) { writeFileSync(resolve(args.out), body, 'utf8'); console.log(`已写出 ${resolve(args.out)}（${built.rows.length} 行）`); }
      else console.log(body);
    } else {
      // 复用导出服务：CSV 公式注入防护 + 表头单位与口径
      const { toCsv } = await import('../src/services/export-svc.mjs');
      const body = toCsv(built.columns, built.rows, { meta: built.meta });
      if (args.out) { writeFileSync(resolve(args.out), body, 'utf8'); console.log(`已写出 ${resolve(args.out)}（${built.rows.length} 行）`); }
      else console.log(body);
    }
  } else if (cmd === 'jobs') {
    db.getDb();
    out({
      jobs: db.all("SELECT * FROM ingestion_job WHERE job_key LIKE 'cea%' ORDER BY started_at DESC LIMIT ?", [Number(args.limit) || 20]),
      cursors: db.all("SELECT * FROM dataset_cursor WHERE dataset LIKE 'cea%' ORDER BY dataset"),
    });
  } else if (cmd === 'close-stale') {
    db.getDb();
    out(collect.closeStaleCeaJobs({ actor: 'cli:cea', maxAgeMs: args['max-age-min'] ? Number(args['max-age-min']) * 60000 : undefined }));
  } else if (cmd === 'gaps') {
    db.getDb();
    out(cea.listCeaGaps({ status: args.status || 'open' }));
  } else {
    console.error(`未知命令：${cmd}`);
    console.error('可用命令：status | sources | seed | collect | parse | verify | scenario | export | jobs | gaps');
    exitCode = 2;
  }
} catch (e) {
  console.error(`✗ ${cmd} 失败：${e.message}`);
  if (process.env.CEA_CLI_DEBUG === '1') console.error(e.stack);
  exitCode = 1;
} finally {
  try {
    db.closeDb();
  } catch { /* ignore */ }
  process.exitCode = exitCode;
}
