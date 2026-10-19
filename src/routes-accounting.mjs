/**
 * 公开碳核算资料路由（docs/39 第 5 条）
 * ============================================================================
 * 路径规约（全部挂在既有 v2 路由表内，共用 HTTP 守卫与权限模型）：
 *   普通用户（登录即可）：
 *     GET  /api/v2/accounting/sources
 *     GET  /api/v2/accounting/factors            （list，支持筛选与分页）
 *     GET  /api/v2/accounting/factors/facets
 *     GET  /api/v2/accounting/factors/:id        （detail：来源与版本）
 *     GET  /api/v2/accounting/standards
 *     GET  /api/v2/accounting/standards/facets
 *     GET  /api/v2/accounting/standards/:id      （detail：原文/PDF/正文/来源/版本）
 *     GET  /api/v2/accounting/crc-daily          （含同日 CEA 对照）
 *     GET  /api/v2/accounting/crc-daily/:id
 *     GET  /api/v2/accounting/status
 *     POST /api/v2/accounting/calculate/electricity
 *     POST /api/v2/accounting/calculate/fuel
 *     POST /api/v2/accounting/calculate/summary
 *     POST /api/v2/accounting/calculate/result.json （下载本次结果 JSON，不保存）
 *     GET  /api/v2/accounting/export/{factors|standards|crc-daily}
 *   管理员：
 *     GET/POST /api/v2/accounting/admin/config
 *     POST     /api/v2/accounting/admin/collect       （202 + task_id）
 *     GET      /api/v2/accounting/admin/jobs          （进度轮询）
 *     POST     /api/v2/accounting/admin/verify        （对已有正文重跑模型核验）
 *     POST     /api/v2/accounting/admin/upload-body   （管理员上传缺失标准 PDF → 解析 → 模型核对）
 *
 * 安全：
 *   · 读接口 readGuard（v2 未启用/表未就绪 → 503）；写接口 writeGuard（+ 生产库拒写 + 同源校验）；
 *   · 管理员路由统一由 routes-v2 的 withAdminAreaGuard 兜底 403；
 *   · 禁止任意服务器路径与任意 URL 外发：上传只接受受限根内的路径或已上传文档 ID；
 *   · SQL 全部参数化；CSV 导出走 export-svc（含公式注入防护）；
 *   · 前端来源链接必须是 http/https（见 validHttpUrl）。
 */
import { readGuard, writeGuard } from './services/http-guard.mjs';
import { requireRole } from './services/project-svc.mjs';
import { buildExport } from './services/export-svc.mjs';
import * as acc from './services/accounting-svc.mjs';
import * as calc from './services/carbon-calc-svc.mjs';
import * as collect from './services/accounting-collect-svc.mjs';
import { get as dbGet } from './core/db.mjs';
import {listPublicDocuments,getPublicDocument} from './services/accounting-public-svc.mjs';
import {run as dbRun} from './core/db.mjs';
import {newId,nowIso} from './core/util.mjs';
import {createHash} from 'node:crypto';
// docs/44：统一「核心摘要」（只读缓存，不在 GET 里生成摘要或访问外网）
import * as summary from './services/summary-svc.mjs';

/** 给碳核算资料列表/详情挂载核心摘要（读缓存；未生成时如实空态）。 */
function withSummaries(entityType, rows) {
  return summary.attachSummaries(entityType, Array.isArray(rows) ? rows : []);
}

const admin = (ctx, what) => requireRole(ctx.user, ['admin'], what);

/** 仅允许 http/https 的来源链接（前端渲染前再白名单一次）。 */
export function validHttpUrl(value) {
  try {
    const u = new URL(String(value));
    return ['http:', 'https:'].includes(u.protocol) ? u.href : null;
  } catch {
    return null;
  }
}

function exportResponse(ctx, { dataset, fileBase, format, columns, rows, meta }) {
  const out = buildExport({
    user: ctx.user, dataset, fileBase, format: format || 'csv', columns, rows,
    meta: meta || {}, filters: ctx.query || {}, ip: ctx.ip,
  });
  return {
    raw: {
      mime: out.mime,
      body: out.body,
      headers: {
        'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(out.file_name)}`,
        'x-export-sha256': out.sha256,
        'x-export-rows': String(out.row_count),
      },
    },
  };
}

export const ACCOUNTING_RAW_ROUTES = [
  ['GET','/api/v2/accounting/public-documents',async(ctx)=>{acc.ensureAccountingSeeded();const out=await listPublicDocuments(ctx.query);return {...out,rows:withSummaries('accounting_public_document',out.rows)};} ],
  ['GET','/api/v2/accounting/public-documents/:id',async(ctx)=>{const d=getPublicDocument(ctx.params.id);if(!d)return{status:404,body:{error:'未找到公开资料'}};const [row]=withSummaries('accounting_public_document',[{id:d.document?.id,...(d.document||{})}]);return {...d,document:row?{...(d.document||{}),...row}:d.document,summary_block:row?.summary_block||null};}],
  /* ------------------------------ 来源与状态 ------------------------------ */
  ['GET', '/api/v2/accounting/sources', async (ctx) => ({    sources: acc.listSources({
      category: ctx.query.category || null,
      status: ctx.query.status || null,
      q: ctx.query.q || null,
      limit: Number(ctx.query.limit) || 200,
    }),
    note:
      '来源登记只描述公开入口与允许抓取的域名；状态/最近成功时间/HTTP 状态只有在**真实抓取过**之后才有值，' +
      '未经采集的来源保持 registered。',
  })],

  ['GET', '/api/v2/accounting/status', async () => {
    acc.ensureAccountingSeeded();
    return acc.accountingStatus();
  }],

  /* ------------------------------ 因子库 ------------------------------ */
  ['GET', '/api/v2/accounting/factors', async (ctx) => {
    acc.ensureAccountingSeeded();
    const q = ctx.query;
    const out = acc.listFactors({
      data_year: q.data_year || null,
      category: q.category || null,
      region: q.region || null,
      region_level: q.region_level || null,
      gas: q.gas || null,
      q: q.q || null,
      limit: Number(q.limit) || 200,
      offset: Number(q.offset) || 0,
    });
    return {
      ...out,
      rows: withSummaries('emission_factor', out.rows),
      page: Math.floor((out.offset || 0) / (out.limit || 200)) + 1,
      facets: acc.factorFacets(),
      category_labels: acc.FACTOR_CATEGORY_LABELS,
      notes: [
        '本库电力 CO2 因子（kgCO2/kWh）用于外购电力排放参考计算；不是产品全生命周期碳足迹因子，也不是 CCER 区域电网基准线因子。',
        '0.5306 / 0.6096 / 0.8273 是三种**不可互换**的口径，分别标注在「口径」列。',
        '「可计算性」表示该行具备规范单位与有限正值，可被碳排放计算选用。',
      ],
    };
  }],

  ['GET', '/api/v2/accounting/factors/facets', async () => {
    acc.ensureAccountingSeeded();
    return { ...acc.factorFacets(), category_labels: acc.FACTOR_CATEGORY_LABELS };
  }],

  ['GET', '/api/v2/accounting/factors/:id', async (ctx) => {
    acc.ensureAccountingSeeded();
    const f = acc.getFactor(ctx.params.id);
    if (!f) return { status: 404, body: { error: '未找到该因子' } };
    const [row] = withSummaries('emission_factor', [f]);
    return {
      factor: row ? { ...f, ...row } : f,
      notes: [
        '原文定位：物理页与打印页均已记录；哈希为该原件 SHA-256，可核对是否被替换。',
        '模型核验状态只表示「正文与著录是否一致」，不替代主管部门对因子的发布效力。',
      ],
    };
  }],

  /* ------------------------------ 标准规范 ------------------------------ */
  ['GET', '/api/v2/accounting/standards', async (ctx) => {
    acc.ensureAccountingSeeded();
    const q = ctx.query;
    const out = acc.listStandards({
      sector: q.sector || null,
      status: q.status || null,
      standard_type: q.standard_type || null,
      q: q.q || null,
      limit: Number(q.limit) || 200,
    });
    return {
      ...out,
      rows: withSummaries('accounting_standard', out.rows),
      facets: acc.standardFacets(),
      notes: [
        '「现行正式」只用于生态环境部正式印发/发布的规范；征求意见稿一律单独标注，绝不当作正式版。',
        '「仅元数据（未取得正文）」表示本库尚未取得该规范正文，不提供条款解读。',
      ],
    };
  }],

  ['GET', '/api/v2/accounting/standards/facets', async () => {
    acc.ensureAccountingSeeded();
    return acc.standardFacets();
  }],

  ['GET', '/api/v2/accounting/standards/:id', async (ctx) => {
    acc.ensureAccountingSeeded();
    const s = acc.getStandard(ctx.params.id);
    if (!s) return { status: 404, body: { error: '未找到该标准' } };
    const [row] = withSummaries('accounting_standard', [s]);
    return { standard: row ? { ...s, ...row } : s };
  }],

  /* ------------------------------ 中碳登清结算日报 ------------------------------ */
  ['GET', '/api/v2/accounting/crc-daily', async (ctx) => {
    acc.ensureAccountingSeeded();
    const q = ctx.query;
    return acc.crcDailyWithCeaCompare({
      from: q.from || null, to: q.to || null, limit: Number(q.limit) || 30,
    });
  }],

  ['GET', '/api/v2/accounting/crc-daily/:id', async (ctx) => {
    acc.ensureAccountingSeeded();
    const r = acc.getCrcDaily(ctx.params.id);
    if (!r) return { status: 404, body: { error: '未找到该清结算日报' } };
    const cea = (() => {
      try {
        return dbGet(
          `SELECT * FROM cea_trade_daily WHERE trade_date=? AND market_scope='national' ORDER BY price_regime DESC LIMIT 1`,
          [r.trade_date]
        );
      } catch {
        return null;
      }
    })();
    return {
      daily: r,
      cea_compare: acc.compareCrcWithCea(r, cea),
      cea_available: !!cea,
      notes: [
        '本日/累计量额与公布均价直接取自中碳登日报原文；复算均价按「成交总额 ÷ 成交总量」另列，两个值不互相覆盖。',
        '分层明细只把小计行计入合计，避免与明细重复相加。',
      ],
    };
  }],

  /* ------------------------------ 碳排放计算（纯函数，无副作用） ------------------------------ */
  ['POST', '/api/v2/accounting/calculate/electricity', async (ctx) => {
    const g = writeGuard(ctx);
    if (g) return { status: g.status, body: g };
    try {
      return calc.calculateElectricity(ctx.body || {});
    } catch (e) {
      if (e.name === 'CalcInputError') return { status: 400, body: { error: e.message, detail: e.detail || null } };
      throw e;
    }
  }],

  ['POST', '/api/v2/accounting/calculate/fuel', async (ctx) => {
    const g = writeGuard(ctx);
    if (g) return { status: g.status, body: g };
    try {
      return calc.calculateFuelCombustion(ctx.body || {});
    } catch (e) {
      if (e.name === 'CalcInputError') return { status: 400, body: { error: e.message, detail: e.detail || null } };
      throw e;
    }
  }],

  ['POST', '/api/v2/accounting/calculate/summary', async (ctx) => {
    const g = writeGuard(ctx);
    if (g) return { status: g.status, body: g };
    try {
      return calc.summarizeEmissions((ctx.body || {}).items || []);
    } catch (e) {
      if (e.name === 'CalcInputError') return { status: 400, body: { error: e.message, detail: e.detail || null } };
      throw e;
    }
  }],

  /**
   * 计算结果的 JSON 下载：**只在响应中生成，不落库、不保存用户输入**。
   * 前端把上一次计算结果原样回传，服务端用同一套纯函数复算后返回，
   * 保证下载内容与页面显示一致（且不信任前端自报数值）。
   */
  ['POST', '/api/v2/accounting/calculate/result.json', async (ctx) => {
    const g = writeGuard(ctx);
    if (g) return { status: g.status, body: g };
    const body = ctx.body || {};
    let result;
    try {
      if (Array.isArray(body.items)) result = { kind: 'summary', ...calc.summarizeEmissions(body.items) };
      else if (body.kind === 'fuel_combustion') result = calc.calculateFuelCombustion(body.input || {});
      else if (body.kind === 'electricity') result = calc.calculateElectricity(body.input || {});
      else return { status: 400, body: { error: 'kind 必须是 electricity、fuel_combustion 或多分项 items' } };
    } catch (e) {
      if (e.name === 'CalcInputError') return { status: 400, body: { error: e.message, detail: e.detail || null } };
      throw e;
    }
    const payload = calc.buildResultJson(result.kind || body.kind, result, {
      meta: { accepted_reference_year: body.accept_reference_year === true, note: body.note || null },
    });
    return {
      raw: {
        mime: 'application/json; charset=utf-8',
        body: Buffer.from(JSON.stringify(payload, null, 2), 'utf8'),
        headers: { 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent('carbon-calc-result.json')}` },
      },
    };
  }],

  /* ------------------------------ 导出 ------------------------------ */
  ['GET', '/api/v2/accounting/export/factors', async (ctx) => exportResponse(ctx, {
    dataset: 'accounting_factors',
    fileBase: 'accounting-factors',
    format: String(ctx.query.format || 'csv').toLowerCase(),
    columns: [
      { key: 'name', label: '因子名称' }, { key: 'value', label: '数值' }, { key: 'unit', label: '单位' },
      { key: 'gas', label: '气体' }, { key: 'category', label: '口径类别' }, { key: 'region', label: '地区' },
      { key: 'data_year', label: '数据年度' }, { key: 'version', label: '版本' },
      { key: 'publish_date', label: '发布日期' }, { key: 'page_physical', label: '物理页' },
      { key: 'page_printed', label: '打印页' }, { key: 'locator', label: '原文定位' },
      { key: 'evidence_level', label: '证据完整程度' }, { key: 'model_verify_status', label: '模型核验' },
      { key: 'original_url', label: '原 URL' }, { key: 'original_sha256', label: '原件 SHA-256' },
    ],
    rows: acc.factorExportRows({
      data_year: ctx.query.data_year || null, category: ctx.query.category || null,
      region: ctx.query.region || null, q: ctx.query.q || null,
    }),
    meta: { 口径: '公开排放因子库（电力 CO2 因子，kgCO2/kWh）', 注意: '三种口径不可互换；不是 CCER 区域电网基准线因子' },
  })],

  ['GET', '/api/v2/accounting/export/standards', async (ctx) => exportResponse(ctx, {
    dataset: 'accounting_standards',
    fileBase: 'accounting-standards',
    format: String(ctx.query.format || 'csv').toLowerCase(),
    columns: [
      { key: 'code', label: '规范编号' }, { key: 'title', label: '标题' }, { key: 'issuer', label: '发布机构' },
      { key: 'sector', label: '行业' }, { key: 'type', label: '类型' }, { key: 'status', label: '状态' },
      { key: 'version', label: '版本' }, { key: 'publish_date', label: '发布日期' },
      { key: 'issue_date', label: '落款日期' }, { key: 'effective_year', label: '适用年度' },
      { key: 'body_status', label: '正文状态' }, { key: 'pages_total', label: '页数' },
      { key: 'original_url', label: '原 PDF' }, { key: 'announcement_url', label: '公告页' },
      { key: 'sha256', label: '原件 SHA-256' }, { key: 'model_verify_status', label: '模型核验' },
    ],
    rows: acc.standardExportRows({
      sector: ctx.query.sector || null, status: ctx.query.status || null,
      standard_type: ctx.query.standard_type || null, q: ctx.query.q || null,
    }),
    meta: { 说明: '正式/征求意见稿分列；仅元数据表示尚未取得正文' },
  })],

  ['GET', '/api/v2/accounting/export/crc-daily', async (ctx) => exportResponse(ctx, {
    dataset: 'accounting_crc_daily',
    fileBase: 'crc-clearing-daily',
    format: String(ctx.query.format || 'csv').toLowerCase(),
    columns: [
      { key: 'trade_date', label: '数据日期' }, { key: 'daily_volume_t', label: '本日成交量', unit: '吨' },
      { key: 'daily_amount_yuan', label: '本日成交额', unit: '元' },
      { key: 'avg_price_published', label: '公布均价', unit: '元/吨' },
      { key: 'avg_price_derived', label: '复算均价', unit: '元/吨' },
      { key: 'cumulative_volume_t', label: '累计成交量', unit: '吨' },
      { key: 'cumulative_amount_yuan', label: '累计成交额', unit: '元' },
      { key: 'caliber', label: '口径' }, { key: 'revision_no', label: '修订号' },
      { key: 'published_at', label: '发布时间' }, { key: 'detail_url', label: '详情页' },
      { key: 'content_hash', label: '原件 SHA-256' },
    ],
    rows: acc.crcExportRows({ from: ctx.query.from || null, to: ctx.query.to || null, limit: 400 }),
    meta: { 口径: '全国碳排放权交易市场（中碳登清结算日报）', 注意: '与 CEA 同日量额不做相加' },
  })],

  /* ------------------------------ 管理员：配置 / 采集 / 任务 ------------------------------ */
  ['GET', '/api/v2/accounting/admin/config', async () => {
    acc.ensureAccountingSeeded();
    return {
      config: acc.accountingConfig(),
      defaults: acc.ACCOUNTING_DEFAULT_CONFIG,
      status: acc.accountingStatus(),
      collect: collect.accountingCollectStatus(),
      limits_note:
        '服务端硬约束：单批预算 5000—120000ms（需求：单批 ≤120 秒）｜单并发｜重入合并｜' +
        '单次最多文件数与单文档页数有上限｜来源未变命中缓存。',
    };
  }],

  ['POST', '/api/v2/accounting/admin/config', async (ctx) => {
    const g = writeGuard(ctx);
    if (g) return { status: g.status, body: g };
    const denied = admin(ctx, '配置碳核算资料采集');
    if (denied) return { status: denied.status, body: denied };
    const out = acc.saveAccountingConfig(ctx.user, ctx.body || {});
    if (out.error) return { status: out.status || 400, body: out };
    return out;
  }],

  ['POST', '/api/v2/accounting/admin/collect', async (ctx) => {
    const g = writeGuard(ctx);
    if (g) return { status: g.status, body: g };
    const denied = admin(ctx, '触发碳核算资料采集');
    if (denied) return { status: denied.status, body: denied };
    const body = ctx.body || {};
    const target = String(body.target || 'all');
    if (body.pages_for_source && !['chinacrc_daily_list'].includes(String(body.pages_for_source))) {
      return { status: 400, body: { error: 'pages_for_source 只允许登记过的公开列表来源代码' } };
    }
    const accepted = collect.startAccountingCollectTask({
      target, actor: ctx.user?.name || 'admin', body, cfg: acc.accountingConfig(),
    });
    if (accepted.error) return { status: accepted.status || 400, body: accepted };
    // 202：已受理，**不代表已采集成功**；进度与结果通过 /admin/jobs 轮询
    return { status: 202, body: accepted };
  }],

  ['GET', '/api/v2/accounting/admin/jobs', async (ctx) => {
    const taskId = ctx.query.task_id ? String(ctx.query.task_id) : null;
    return {
      status: collect.accountingCollectStatus(),
      task: taskId ? collect.getAccountingCollectTask(taskId) : null,
      task_id: taskId,
      note:
        'POST /admin/collect 返回 202 只表示已受理；本接口给出真实进度与结果。' +
        '「无待处理对象」是空扫描（success/empty），抓到了却解析 0 行按失败处理。',
    };
  }],

  ['POST', '/api/v2/accounting/admin/verify', async (ctx) => {
    const g = writeGuard(ctx);
    if (g) return { status: g.status, body: g };
    const denied = admin(ctx, '重跑标准正文模型核验');
    if (denied) return { status: denied.status, body: denied };
    const body = ctx.body || {};
    const id = String(body.standard_id || body.id || '');
    if (!id) return { status: 400, body: { error: '缺少 standard_id' } };
    const out = await collect.verifyStandardWithModel(id, {
      actor: ctx.user?.name || 'admin', deadlineAt: Date.now() + 60000,force:true,
    });
    return out;
  }],

  ['POST', '/api/v2/accounting/admin/upload-body', async (ctx) => {
    const g = writeGuard(ctx);
    if (g) return { status: g.status, body: g };
    const denied = admin(ctx, '上传标准原文 PDF');
    if (denied) return { status: denied.status, body: denied };
    const body = ctx.body || {};
    const id = String(body.standard_id || '');
    let filePath = body.file_path ? String(body.file_path) : null;
    if (!id) return { status: 400, body: { error: '缺少 standard_id' } };
    let upload=null;
    if(body.file_base64!==undefined){
      const standard=dbGet('SELECT * FROM accounting_standard WHERE id=? OR code=?',[id,id]);
      if(!standard)return{status:404,body:{error:'未找到标准'}};
      const encoded=body.file_base64;
      if(typeof encoded!=='string'||encoded.length>Math.ceil(20*1024*1024/3)*4||!encoded.length||!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded))return{status:400,body:{error:'PDF须为有效base64，最大20MiB'}};
      const bytes=Buffer.from(encoded,'base64');
      if(bytes.length>20*1024*1024||bytes.subarray(0,5).toString()!=='%PDF-')return{status:400,body:{error:'文件不是有效PDF或超过20MiB'}};
      const hash=createHash('sha256').update(bytes).digest('hex');filePath=acc.writeAccountingOriginal(hash,bytes,'pdf');
      const matches=(standard.official_sha256||(standard.body_origin!=='admin_upload'?standard.sha256:null))===hash;const uploadId=newId('ASUP');
      upload={upload_id:uploadId,source_status:matches?'official_hash_match':'admin_supplied_unverified',matches_original:matches};
      dbRun('INSERT INTO accounting_standard_upload(id,standard_id,file_name,file_hash,file_size,local_path,source_status,source_claim_url,matches_original,diff_note,uploaded_by,created_at)VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',[uploadId,standard.id,String(body.file_name||'补充文件.pdf').replace(/[\\/]/g,'_').slice(0,200),hash,bytes.length,filePath,upload.source_status,standard.original_url,matches?1:0,matches?null:'管理员补充文件；尚未确认与公告官方原件相同，不改官方URL。',ctx.user.name,nowIso()]);
    }
    if (!filePath) {
      return {
        status: 400,
        body: {
          error: '缺少 file_path：本接口只接受**受限根内**的服务器文件路径（official-originals / registry-files），不接受任意路径或任意 URL 外发。',
        },
      };
    }
    // 复用既有的受限路径校验（与 OCR 补跑同一实现），拒绝任意服务器路径。
    // 注意：assertRestrictedPath 是**返回** {ok, reason} 而不是抛异常，必须显式判返回值。
    let pathCheck = null;
    try {
      const backfill = await import('./services/ocr-backfill-svc.mjs');
      pathCheck = backfill.assertRestrictedPath(filePath);
    } catch (e) {
      return { status: 400, body: { error: `文件路径校验失败：${e.message}` } };
    }
    if (!pathCheck || pathCheck.ok !== true) {
      return {
        status: 400,
        body: {
          error: `文件路径不在受限根内，已拒绝：${pathCheck?.reason || '未知原因'}`,
          roots_note: '只允许当前数据库目录下的 official-originals / registry-files 内的 PDF 原件。',
        },
      };
    }
    const out = await collect.ingestStandardPdf({
      standardId: id, filePath, actor: ctx.user?.name || 'admin', deadlineAt: Date.now() + 120000,
    });
    if (out.error) return { status: out.status || 400, body: {...out,...upload} };
    return {...out,...upload};
  }],
];

/**
 * 读守卫：v2 未启用 / 表结构未就绪 → 503（查询会打到不存在的表，所以只读也拒绝）。
 * 所有 GET 路由在装配时统一套上；写路由各自先调用 writeGuard。
 */
function withReadGuard(handler) {
  return async (ctx) => {
    const g = readGuard();
    if (g) return { status: g.status, body: g };
    return handler(ctx);
  };
}

export default ACCOUNTING_RAW_ROUTES.map(([method, pattern, handler]) =>
  method === 'GET' ? [method, pattern, withReadGuard(handler)] : [method, pattern, handler]
);
