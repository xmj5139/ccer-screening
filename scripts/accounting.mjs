/**
 * 公开碳核算资料运维 CLI（docs/39 第 1、4 条）
 * ============================================================================
 *   node scripts/accounting.mjs status                 来源 / 因子 / 规范 / 缺口 / 采集状态
 *   node scripts/accounting.mjs seed [--no-values]      幂等 seed（来源登记 + 规范元数据 + 已核实静态值）
 *   node scripts/accounting.mjs collect [--target=all] [--budget-ms=N]
 *                                                       执行一次有界采集（单批 ≤120 秒）
 *   node scripts/accounting.mjs factors [--data-year=2023] [--category=...] [--region=北京]
 *   node scripts/accounting.mjs standards [--sector=钢铁] [--type=verification]
 *   node scripts/accounting.mjs crc [--from=...] [--to=...]   中碳登清结算日报 + 同日 CEA 对照
 *   node scripts/accounting.mjs calc-electricity --energy=100 --unit=万kWh --factor=<id|national|北京>
 *   node scripts/accounting.mjs mirror --query="..." --domain=www.mee.gov.cn
 *                                                       用已配置搜索服务**只寻找官方镜像 URL**（不取摘要当事实）
 *
 * 【硬约束】
 *   · 复用 initV2Env()：默认独立库；显式指向 data/ccer.db 时直接退出，不建连接、不改文件；
 *   · 没有任何破坏性命令（reset/drop/delete）；
 *   · 不打印任何密钥、cipher 或 access_token；
 *   · 不登录任何企业账户，不绕过 HTTP 412 / 验证码；412 页面只登记为 blocked。
 */
import { initV2Env, parseArgs } from './v2-env.mjs';

const args = parseArgs();
const cmd = String(args._[0] || 'status').toLowerCase();

const HELP = `
公开碳核算资料 CLI（默认使用独立库，绝不动生产库）

  status                                  来源/因子/规范/清结算/缺口 汇总
  seed [--no-values]                      幂等 seed（--no-values 只写来源与规范元数据）
  collect [--target=all|crc_daily|standards|factor_pdf|portals] [--budget-ms=120000]
                                          执行一次有界采集（单批 ≤120000ms）
  factors [--data-year=2023] [--category=...] [--region=北京] [--q=...]
  standards [--sector=钢铁] [--type=accounting|verification|update_note] [--status=formal]
  crc [--from=YYYY-MM-DD] [--to=YYYY-MM-DD] [--limit=30]
  calc-electricity --energy=100 --unit=万kWh --factor=<因子ID|national|北京> [--target-year=2026] [--accept-ref-year]
  mirror --query="..." --domain=www.mee.gov.cn
                                          只寻找官方域名上的镜像 URL（不把搜索摘要当事实）

环境变量：
  CCER_DB_PATH      数据库路径（不得指向 data/ccer.db）
  CCER_ENABLE_V2    由本脚本强制设为 1
  CCER_DAILY_SYNC   本 CLI 不启动定时器，不受其影响

示例：
  $env:CCER_DB_PATH="$PWD\\data\\sources-dev-20261015.db"
  node scripts/accounting.mjs seed
  node scripts/accounting.mjs status
  node scripts/accounting.mjs factors --data-year=2023
`;

if (cmd === 'help' || args.help) {
  console.log(HELP);
  process.exit(0);
}

const KNOWN = ['status', 'seed', 'collect', 'factors', 'standards', 'crc', 'calc-electricity', 'mirror'];
if (!KNOWN.includes(cmd)) {
  console.error(`✗ 未知子命令：${cmd}\n${HELP}`);
  process.exit(2);
}
if (args.reset || args.drop || args.wipe) {
  console.error('✗ 本 CLI 不提供任何破坏性命令（reset/drop/wipe）。');
  process.exit(2);
}

const { dbPath } = await initV2Env({ quiet: true });
const db = await import('../src/core/db.mjs');
db.getDb();
const acc = await import('../src/services/accounting-svc.mjs');
const calc = await import('../src/services/carbon-calc-svc.mjs');
const collect = await import('../src/services/accounting-collect-svc.mjs');
const { fetchStatus } = await import('../src/services/web-fetch-svc.mjs');
const { searchStatus } = await import('../src/services/search-svc.mjs');

const print = (o) => console.log(JSON.stringify(o, null, 2));
console.log(`[accounting] 数据库：${dbPath}`);

if (cmd === 'status') {
  const st = acc.accountingStatus();
  console.log(`[accounting] 来源 ${st.counts.sources}｜因子 ${st.counts.factors}（历史 ${st.counts.factors_total}）｜规范 ${st.counts.standards}（含正文 ${st.counts.standards_with_body}）｜清结算日报 ${st.counts.crc_daily}（最新 ${st.counts.crc_latest_date || '—'}）`);
  console.log(`[accounting] 受阻来源 ${st.counts.blocked_sources}｜原件落盘根 ${st.roots.accounting_originals}`);
  console.log(`[accounting] 采集：${JSON.stringify(collect.accountingCollectStatus().last_job ? {
    status: collect.accountingCollectStatus().last_job.status,
    started_at: collect.accountingCollectStatus().last_job.started_at,
    parsed: collect.accountingCollectStatus().last_job.items_parsed,
    errors: collect.accountingCollectStatus().last_job.error_count,
  } : { status: 'never_run' })}`);
  console.log(`[accounting] 抓取连接：${fetchStatus().connections ?? '—'}｜搜索：${JSON.stringify(searchStatus().providers ?? searchStatus())}`);
  console.log('[accounting] 缺口：');
  for (const g of st.gaps) console.log(`  · [${g.kind}] ${g.code}｜${g.note}`);
  print({ config: st.config, counts: st.counts, by_source: st.by_source, notes: st.notes });
  process.exit(0);
}

if (cmd === 'seed') {
  const out = acc.seedAccountingBase({ withStaticValues: args['no-values'] !== true });
  console.log(`[accounting] seed 完成：新增来源 ${out.sources}｜新增因子 ${out.factors}｜新增规范 ${out.standards}｜清结算样本 ${out.crc_daily}`);
  console.log('[accounting] 说明：seed 只写来源登记、规范元数据与已核实静态值；不写任何抓取成功状态与模型核验结论。');
  print(acc.accountingStatus().counts);
  process.exit(0);
}

if (cmd === 'collect') {
  const target = String(args.target || 'all');
  const budget = Math.max(5000, Math.min(Number(args['budget-ms']) || 120000, 120000));
  const out = await collect.runAccountingCollectTarget({
    target, actor: 'cli:accounting', trigger: 'cli', deadlineAt: Date.now() + budget,
  });
  console.log(`[accounting] 采集结果：${out.status}｜目标 ${out.target}｜用时 ${out.elapsed_ms}ms｜预算 ${out.budget_ms}ms`);
  print(out);
  process.exit(out.status === 'failed' ? 1 : 0);
}

if (cmd === 'factors') {
  const out = acc.listFactors({
    data_year: args['data-year'] || null,
    category: args.category || null,
    region: args.region || null,
    q: args.q || null,
    limit: Number(args.limit) || 200,
  });
  console.log(`[accounting] 因子 ${out.total} 行`);
  for (const f of out.rows) {
    console.log(`  · ${f.value} ${f.original_unit}｜${f.category_label}｜${f.region || '全国'}｜${f.data_year}｜物理页 ${f.page_physical}（打印页 ${f.page_printed}）｜${f.evidence_level}｜核验 ${f.model_verify_status}`);
  }
  process.exit(0);
}

if (cmd === 'standards') {
  const out = acc.listStandards({
    sector: args.sector || null,
    status: args.status || null,
    standard_type: args.type || null,
    q: args.q || null,
  });
  console.log(`[accounting] 规范 ${out.total} 项`);
  for (const s of out.rows) {
    console.log(`  · ${s.code || '（无编号）'}｜${s.title}｜${s.sector}｜${s.standard_type_label}｜${s.status_label}｜正文 ${s.body_status_label}｜核验 ${s.model_verify_status}`);
    console.log(`      原件：${s.original_url}`);
  }
  process.exit(0);
}

if (cmd === 'crc') {
  const out = acc.crcDailyWithCeaCompare({
    from: args.from || null, to: args.to || null, limit: Number(args.limit) || 30,
  });
  console.log(`[accounting] 清结算日报 ${out.total} 条｜CEA 行情表就绪：${out.cea_table_ready}`);
  for (const r of out.rows) {
    console.log(
      `  · ${r.trade_date}｜本日 ${r.daily_volume_t ?? '—'} 吨 / ${r.daily_amount_yuan ?? '—'} 元｜公布均价 ${r.daily_avg_price_published ?? '—'}｜复算 ${r.daily_avg_price_derived?.toFixed?.(4) ?? '—'}｜累计 ${r.cumulative_volume_t ?? '—'} 吨 / ${r.cumulative_amount_yuan ?? '—'} 元｜修订 ${r.revision_no}`
    );
    const c = r.cea_compare;
    if (c.cea) {
      console.log(`      CEA 同日：${c.cea.total_volume ?? '—'} 吨 / ${c.cea.total_turnover ?? '—'} 元｜收盘 ${c.cea.close ?? '—'}｜一致：${c.match === null ? '无法判定（缺一侧）' : c.match ? '是' : `否（${c.differences.length} 项差异，两方原值均已保留）`}`);
    } else {
      console.log('      CEA 同日：无该日行情（不回落、不推算）');
    }
  }
  console.log(`[accounting] ${out.note}`);
  process.exit(0);
}

if (cmd === 'calc-electricity') {
  const energy = args.energy;
  const unit = String(args.unit || '');
  const sel = String(args.factor || '');
  let factorId = sel;
  if (!/^EF/.test(sel)) {
    const category = sel === 'national' || sel === '' ? 'national_average' : 'provincial_average';
    const region = sel === 'national' || sel === '' ? null : sel;
    const list = acc.selectableFactors({ data_year: Number(args['data-year']) || 2023, category, region });
    if (!list.length) {
      console.error(`✗ 未找到匹配因子（口径 ${category}｜地区 ${region || '全国'}）：系统不会自动改用其他地区或全国平均值。`);
      process.exit(1);
    }
    factorId = list[0].id;
  }
  const out = calc.calculateElectricity({
    energy, energy_unit: unit, factor_id: factorId,
    target_year: args['target-year'] ? Number(args['target-year']) : null,
    accept_reference_year: args['accept-ref-year'] === true,
  });
  console.log(`[accounting] ${out.formula}`);
  for (const s of out.steps) console.log(`  ${s.step}：${s.expression}`);
  console.log(`[accounting] 结果：${out.total_tco2} ${out.result_unit}（${out.gas}）｜因子 ${out.factor.value} ${out.factor.unit}｜${out.factor.category_label}｜数据年 ${out.factor.data_year}｜来源 ${out.factor.original_url}`);
  for (const w of out.warnings) console.log(`  ⚠ ${w}`);
  console.log(`[accounting] ${out.limitation}`);
  process.exit(0);
}

if (cmd === 'mirror') {
  if (!args.query) {
    console.error('✗ 缺少 --query');
    process.exit(2);
  }
  const domains = String(args.domain || '').split(',').map((s) => s.trim()).filter(Boolean);
  const out = await collect.findOfficialMirror(String(args.query), { allowedDomains: domains, deadlineAt: Date.now() + 20000 });
  print(out);
  console.log('[accounting] 说明：搜索结果只用于定位官方域名上的 URL；事实仍由确定性解析器从原文取数。');
  process.exit(out.ok ? 0 : 1);
}
