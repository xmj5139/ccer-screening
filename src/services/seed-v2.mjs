/**
 * v2 种子数据：政策库、公开项目库、交易行情、数据源与模型配置、团队授权、
 *              原文对照台账、数据缺口台账、指标口径说明。
 * ============================================================================
 * 与 v1 的关系：本模块**不修改** seed.mjs 的行为，只在它之后追加写入 v2 新增表。
 * 调用顺序：seedAll()（v1） → seedV2()（本模块）。
 *
 * 【来源纪律】所有金额/数量均为官方公开口径的**示例或已核实值**；
 * 未能自动获取的数据一律不写入，改为在 data_gap 台账中登记真实缺口。
 */
import { run, get, all, tx, getDb } from '../core/db.mjs';
import { newId, nowIso, todayCst, j } from '../core/util.mjs';
import { POLICY_DOCUMENTS, DATA_GAPS } from '../data/policy-catalog.mjs';
import { DOC_VERIFICATIONS, METHODOLOGY_DOC_SOURCES } from '../data/methodology-evidence.mjs';

/** v2 新增表（按「父表在前」排列；wipeV2 倒序删除并临时关闭外键） */
export const V2_TABLES = [
  'methodology_doc_verification',
  'policy_document', 'policy_attachment', 'policy_change',
  'public_project', 'registry_observation', 'ai_review_result', 'project_event', 'reduction_batch',
  'internal_project', 'internal_project_link', 'evidence',
  'trade_daily', 'trade_revision', 'trade_dimension', 'trade_calendar', 'trade_cumulative_reference',
  'source_snapshot', 'ingestion_job', 'ingestion_step', 'data_reconciliation', 'reconciliation_ai_review',
  'review_task', 'app_team', 'project_grant', 'user_login_log', 'export_log',
  'llm_provider', 'llm_call_log', 'api_credential', 'datasource_config', 'datasource_rollback',
  'notification', 'metric_definition', 'methodology_project_stat', 'methodology_interpretation', 'data_gap',
];

/**
 * 清空 v2 表。
 * 说明：
 *   1. 顺序按「子表 → 父表」排列（下面 V2_TABLES 是父表在前，删除时倒序）；
 *   2. 同时临时关闭外键约束，避免因顺序或遗漏导致删除被静默跳过
 *      （此前 policy_document 因 policy_attachment 的引用而删不掉，
 *       再次 seed 时触发 policy_key 唯一约束失败 —— 已修正）。
 */
export function wipeV2() {
  const db = getDb();
  db.exec('PRAGMA foreign_keys = OFF;');
  try {
    for (const t of [...V2_TABLES].reverse()) {
      try {
        run(`DELETE FROM ${t}`);
      } catch {
        /* 表可能尚未创建 */
      }
    }
  } finally {
    db.exec('PRAGMA foreign_keys = ON;');
  }
}

/* ------------------------------------------------------------------ */
/*  1. 政策库                                                          */
/* ------------------------------------------------------------------ */

function sourceIdByKey() {
  const rows = all('SELECT id, url, title FROM source_document');
  const map = new Map();
  for (const r of rows) map.set(r.url, r.id);
  return map;
}

export function seedPolicies() {
  const byUrl = sourceIdByKey();
  const idByKey = new Map();
  for (const p of POLICY_DOCUMENTS) {
    const id = newId('POL');
    idByKey.set(p.policy_key, id);
    run(
      `INSERT INTO policy_document
       (id,policy_key,title,doc_number,issuing_authority,category,doc_status,publish_date,effective_date,
        repeal_date,summary,official_url,source_id,source_tier,original_file_hash,local_path,version_label,
        supersedes_id,confirmed_by,confirmed_at,collected_at,collect_note,change_log,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        id, p.policy_key, p.title, p.doc_number || null, p.issuing_authority || null, p.category,
        p.doc_status, p.publish_date || null, p.effective_date || null, null,
        p.summary || null, p.official_url || null,
        p.official_url ? byUrl.get(p.official_url) || null : null,
        1, null, null, null, null,
        p.confirmed ? '系统基线（依据官方发布通知/原文）' : null,
        p.confirmed ? nowIso() : null,
        nowIso(), p.collect_note || null, null, nowIso(), nowIso(),
      ]
    );
    // 附件登记：【口径纪律】这里只登记「官方页面链接已登记」这一事实。
    // 真正的「原件已归档」必须由归档服务下载落盘后写入 local_path + file_hash。
    // 因此种子阶段一律写 parse_quality='not_attempted'：
    // 早期版本直接沿用目录里的 parse_quality='good' 并配 parse_note='官方页面已核对'，
    // 却没有本地文件与哈希，会让「原件未归档」的核对记录永远无法结清、
    // 并把真实缺口掩盖成已归档。数据源目录里的 parse_quality 只描述官方页面质量，
    // 不再直接写进附件记录。
    run(
      `INSERT INTO policy_attachment
       (id,policy_id,file_name,file_type,url,file_hash,local_path,parse_quality,parse_note,fetched_at,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [
        newId('PAT'), id,
        p.official_url ? `${p.title}.html` : `${p.title}（原件待归档）`,
        p.official_url ? 'html' : 'other',
        p.official_url || null, null, null,
        'not_attempted',
        p.official_url
          ? '官方页面链接已登记；原件尚未下载归档（无本地文件与 SHA-256），条款只能引用到文件与章节层级'
          : '原件尚未下载归档，条款只能引用到文件与章节层级',
        p.confirmed ? nowIso() : null, nowIso(),
      ]
    );
  }
  return idByKey;
}

/* ------------------------------------------------------------------ */
/*  2. 公开项目库（示例：全部标注证据等级，未与注册登记系统自动核对）    */
/* ------------------------------------------------------------------ */

/**
 * 公开项目示例数据。
 * ⚠️ 这些条目的用途是**演示界面结构与核对流程**，不是官方全量项目库。
 *    证据等级一律为 project_material / unverified，界面与导出都会如实标注，
 *    绝不标注为「官方登记/发布事实」。
 */
const PUBLIC_PROJECTS = [
  {
    registry_project_no: 'DEMO-PUB-0001',
    name: '山西晋城某煤业低浓度瓦斯发电项目',
    owner_name: '晋城某煤业有限公司',
    province: '山西省',
    city: '晋城市',
    domain: '燃料逸散性排放',
    industry: '煤炭开采和洗选业',
    methodology_id: 'CCER-10-001',
    methodology_version: 'V01',
    technology_route: '无焰氧化 + 发电',
    boundary_desc: '矿井风井场地及瓦斯抽采泵站至瓦斯发电站围墙内',
    start_operation_date: '2023-05-10',
    stage_project_public: 1, stage_validated: 1, stage_project_registered: 0,
    stage_reduction_public: 0, stage_verified: 0, stage_reduction_registered: 0,
    owner_announced_estimate: 16262,
    evidence_level: 'project_material',
    official_url: null,
    note: '演示条目：依据机构内部项目资料构造，用于演示「项目信息」阶段分列与核对流程。',
    events: [
      { event_type: 'project_public', event_date: '2025-02-18', registry_ref: 'DEMO-PUB-0001', amount: null },
      { event_type: 'validation', event_date: '2025-04-09', registry_ref: 'DEMO-VAL-0001', amount: null },
    ],
    batches: [
      {
        batch_no: '第 1 期（演示）',
        period_start: '2025-01-01', period_end: '2025-12-31',
        owner_announced_estimate: 16262, verified_amount: null, registered_amount: null,
      },
    ],
  },
  {
    registry_project_no: 'DEMO-PUB-0002',
    name: '内蒙古某煤矿瓦斯氧化供热项目',
    owner_name: '鄂尔多斯某煤业有限公司',
    province: '内蒙古自治区',
    city: '鄂尔多斯市',
    domain: '燃料逸散性排放',
    industry: '煤炭开采和洗选业',
    methodology_id: 'CCER-10-001',
    methodology_version: 'V01',
    technology_route: '无焰氧化 + 供热',
    start_operation_date: '2025-03-01',
    stage_project_public: 1, stage_validated: 0, stage_project_registered: 0,
    stage_reduction_public: 0, stage_verified: 0, stage_reduction_registered: 0,
    owner_announced_estimate: 48000,
    evidence_level: 'unverified',
    note: '演示条目：仅处于项目公示阶段，公示预计量不得显示为已登记量。',
    events: [
      { event_type: 'project_public', event_date: '2026-01-12', registry_ref: 'DEMO-PUB-0002', amount: 48000, amount_kind: 'owner_announced_estimate' },
    ],
    batches: [],
  },
  {
    registry_project_no: 'DEMO-PUB-0003',
    name: '渤海某海上油田伴生气回收生产 LNG 项目',
    owner_name: '天津某海洋石油工程有限公司',
    province: '天津市',
    city: '天津市',
    domain: '燃料逸散性排放',
    industry: '石油和天然气开采业',
    methodology_id: 'CCER-10-002',
    methodology_version: 'V01',
    technology_route: '液化天然气（LNG）',
    start_operation_date: '2023-08-15',
    stage_project_public: 1, stage_validated: 1, stage_project_registered: 1,
    stage_reduction_public: 1, stage_verified: 1, stage_reduction_registered: 1,
    owner_announced_estimate: 320000, verified_amount: 301500, registered_amount: 301500,
    evidence_level: 'unverified',
    note:
      '演示条目：阶段字段完整，用于演示「业主预计量 / 核查量 / 登记量」三套数字分开存储；' +
      '本条目未与注册登记系统自动核对，不得标注为官方已确认。',
    events: [
      { event_type: 'project_public', event_date: '2025-03-05', registry_ref: 'DEMO-PUB-0003' },
      { event_type: 'validation', event_date: '2025-05-20', registry_ref: 'DEMO-VAL-0003' },
      { event_type: 'project_registration', event_date: '2025-06-30', registry_ref: 'DEMO-REG-0003' },
      { event_type: 'reduction_public', event_date: '2025-09-10', period_start: '2024-07-01', period_end: '2025-06-30', amount: 320000, amount_kind: 'owner_announced_estimate' },
      { event_type: 'verification', event_date: '2025-11-18', period_start: '2024-07-01', period_end: '2025-06-30', amount: 301500, amount_kind: 'verified_amount' },
      { event_type: 'reduction_registration', event_date: '2025-12-05', period_start: '2024-07-01', period_end: '2025-06-30', amount: 301500, amount_kind: 'registered_amount' },
    ],
    batches: [
      {
        batch_no: '第 1 期（演示）',
        period_start: '2024-07-01', period_end: '2025-06-30',
        owner_announced_estimate: 320000, verified_amount: 301500, registered_amount: 301500,
        registration_date: '2025-12-05', cancellation_status: 'none',
      },
    ],
  },
];

export function seedPublicProjects() {
  for (const p of PUBLIC_PROJECTS) {
    const id = newId('PPJ');
    // 演示条目必须显式标记 is_demo=1：它们只用于历史留痕与界面自检，
    // **不得进入任何业务统计**（docs/22 第 16 条）；正式采集的项目 is_demo 保持 0。
    const isDemo = String(p.note || '').startsWith('演示条目') ? 1 : 0;
    run(
      `INSERT INTO public_project
       (id,registry_project_no,name,owner_name,owner_credit_code,province,city,domain,industry,
        methodology_id,methodology_version,technology_route,boundary_desc,start_operation_date,design_doc_url,
        stage_project_public,stage_validated,stage_project_registered,stage_reduction_public,stage_verified,
        stage_reduction_registered,stage_cancelled,current_stage,owner_announced_estimate,verified_amount,
        registered_amount,evidence_level,official_url,source_id,source_snapshot_id,last_checked_at,
        last_checked_result,review_status,reviewed_by,reviewed_at,note,is_demo,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        id, p.registry_project_no, p.name, p.owner_name || null, null, p.province || null, p.city || null,
        p.domain || null, p.industry || null, p.methodology_id || null, p.methodology_version || null,
        p.technology_route || null, p.boundary_desc || null, p.start_operation_date || null, null,
        p.stage_project_public || 0, p.stage_validated || 0, p.stage_project_registered || 0,
        p.stage_reduction_public || 0, p.stage_verified || 0, p.stage_reduction_registered || 0,
        0, currentStageOf(p), p.owner_announced_estimate ?? null, p.verified_amount ?? null,
        p.registered_amount ?? null, p.evidence_level || 'unverified', p.official_url || null, null, null,
        null, 'never', 'pending', null, null, p.note || null, isDemo, nowIso(), nowIso(),
      ]
    );
    for (const ev of p.events || []) {
      run(
        `INSERT INTO project_event
         (id,public_project_id,event_type,event_date,period_start,period_end,amount,amount_kind,registry_ref,
          official_url,source_snapshot_id,evidence_level,review_status,reviewed_by,reviewed_at,note,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          newId('PEV'), id, ev.event_type, ev.event_date || null, ev.period_start || null, ev.period_end || null,
          ev.amount ?? null, ev.amount_kind || (ev.amount ? 'owner_announced_estimate' : 'none'),
          ev.registry_ref || null, null, null, p.evidence_level || 'unverified', 'pending', null, null,
          ev.note || null, nowIso(), nowIso(),
        ]
      );
    }
    for (const b of p.batches || []) {
      run(
        `INSERT INTO reduction_batch
         (id,public_project_id,batch_no,period_start,period_end,owner_announced_estimate,verified_amount,
          registered_amount,registration_date,cancellation_status,cancelled_amount,registry_ref,official_url,
          evidence_level,review_status,reviewed_by,reviewed_at,note,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          newId('RBT'), id, b.batch_no || null, b.period_start || null, b.period_end || null,
          b.owner_announced_estimate ?? null, b.verified_amount ?? null, b.registered_amount ?? null,
          b.registration_date || null, b.cancellation_status || 'none', b.cancelled_amount ?? null,
          b.registry_ref || null, null, p.evidence_level || 'unverified', 'pending', null, null,
          b.note || null, nowIso(), nowIso(),
        ]
      );
    }
  }
}

/** 阶段派生：取最靠后的已完成阶段（仅供展示与筛选，不替代分列字段） */
export function currentStageOf(p) {
  const order = [
    ['stage_reduction_registered', '减排量登记'],
    ['stage_verified', '核查'],
    ['stage_reduction_public', '减排量公示'],
    ['stage_project_registered', '项目登记'],
    ['stage_validated', '审定'],
    ['stage_project_public', '项目公示'],
  ];
  for (const [flag, label] of order) if (p[flag]) return label;
  return '未公示';
}

/* ------------------------------------------------------------------ */
/*  3. 交易行情（示例条目：全部标 verify_status='pending'，不冒充官方数据） */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ 重要：这里**没有**写入任何真实行情数字。
 *
 * 交易系统未提供可稳定自动获取的公开数据接口（见 data_gap: gap-trade-daily）。
 * 需求规格明确要求「不得用旧数据伪装当日行情」「无交易日不显示 0 元价格」，
 * 因此种子数据只建立**交易日历**（用于区分休市 / 无成交 / 数据暂缺），
 * 行情数字一律由 CSV 导入或后台补录产生，并带来源与核对状态。
 */
/**
 * 交易日历初始化。
 *
 * 【口径纪律】这里**只写周末**（可以确定非交易日）；工作日的状态必须由官方公告
 * 决定，因此留给采集流程写入：
 *   - 官方当日发布了行情公告 → trading
 *   - 采集窗口内工作日无公告 → unknown（缺公告不能证明休市）
 *   - 采集窗口之外、尚未采集的工作日 → 不写日历，界面显示「数据暂缺（未采集/未导入）」
 *
 * 早期版本把「所有工作日」都预写成 trading，导致核对流程把尚未采集的交易日
 * 全部报成「交易日行情缺失」（噪声）。这里修正为只写周末。
 */
export function seedTradeCalendar(days = 60, today = todayCst()) {
  const end = new Date(`${today}T00:00:00Z`);
  let weekends = 0;
  for (let i = days - 1; i >= 0; i -= 1) {
    const d = new Date(end.getTime() - i * 86400000);
    const iso = d.toISOString().slice(0, 10);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) continue;
    run(
      `INSERT INTO trade_calendar (trade_date, day_type, note, confirmed_by, confirmed_at)
       VALUES (?,?,?,?,?)
       ON CONFLICT(trade_date) DO NOTHING`,
      [iso, 'weekend', '周末（非交易日）', null, null]
    );
    weekends += 1;
  }
  return weekends;
}

/* ------------------------------------------------------------------ */
/*  4. 原文对照台账 + 方法学解读层                                      */
/* ------------------------------------------------------------------ */

export function seedDocVerifications() {
  const mvs = all('SELECT id, methodology_id, version FROM methodology_version');
  const byKey = new Map(mvs.map((m) => [`${m.methodology_id}::${m.version}`, m]));
  let written = 0;
  for (const [key, v] of Object.entries(DOC_VERIFICATIONS)) {
    const mv = byKey.get(key);
    if (!mv) continue;
    run(
      `INSERT INTO methodology_doc_verification
       (id,methodology_version_id,evidence_level,official_url,doc_number,publish_date,artifact_hash,
        sections_verified,traceability_doc,independent_impl,independent_runner,independent_result,
        coverage_json,remaining_blockers,note,verified_by,verified_at,recorded_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        newId('MDV'), mv.id, v.evidenceLevel,
        v.officialSource?.official_url || null, v.officialSource?.doc_number || null,
        v.officialSource?.publish_date || null, null,
        j(v.officialSource?.sections_verified || []),
        v.officialSource?.traceability_doc || null,
        v.independentRecheck?.implementation || null,
        v.independentRecheck?.runner || null,
        v.independentRecheck?.last_result || null,
        j(v.coverage || {}), j(v.remaining_blockers || []), v.note || null,
        // 领域复核人签字：本轮为「待签字」，因此即便对照完成也不能放行业务测算
        v.evidenceLevel === 'official_original_verified' ? null : null,
        null, nowIso(), nowIso(),
      ]
    );
    run('UPDATE methodology_version SET evidence_level = ?, evidence_note = ?, updated_at = ? WHERE id = ?', [
      v.evidenceLevel, v.note || null, nowIso(), mv.id,
    ]);
    written += 1;
  }
  // 未登记台账的方法学一律 unverified（显式写入，不依赖列默认值）
  run(
    `UPDATE methodology_version SET evidence_level = 'unverified',
       evidence_note = '尚未建立官方原文对照台账，业务测算被阻止。', updated_at = ?
     WHERE id NOT IN (SELECT methodology_version_id FROM methodology_doc_verification)`,
    [nowIso()]
  );
  return written;
}

/** 方法学解读层：面向投资团队的四类解读（默认人工撰写；AI 只产草稿） */
const INTERPRETATIONS = [
  {
    methodology_id: 'CCER-10-001',
    version: 'V01',
    section: 'applicability',
    content:
      '判断顺序：先看矿井类型（必须是井工煤矿，且不能是废弃或关闭矿井），再看销毁技术（暂仅限于无焰氧化），' +
      '再看热能利用方式（发电、供热或热电联产三选一），最后看浓度与来源（甲烷体积浓度低于 8%，' +
      '且不得是人为把浓度≥8% 的瓦斯稀释得到的低浓度瓦斯）。',
  },
  {
    methodology_id: 'CCER-10-001',
    version: 'V01',
    section: 'exclusions',
    content:
      '常见不适用原因：① 露天煤矿；② 采用瓦斯提纯、民用/工业燃气等非「发电/供热/热电联产」利用方式；' +
      '③ 把浓度≥8% 的瓦斯人为稀释后利用；④ 减排量产生于监测数据完成联网试运行之前；' +
      '⑤ 混配管道入口流量大于抽采泵出口流量之和（公式19 情形，属不符合适用条件）。',
  },
  {
    methodology_id: 'CCER-10-001',
    version: 'V01',
    section: 'required_data',
    content:
      '需向业主索取：矿井类型与是否废弃/关闭的证明、无焰氧化装置的设备清单与验收文件、' +
      '逐小时瓦斯流量与甲烷浓度监测数据（含温度、压力）、外供电量/外供热量的计量与结算凭证、' +
      '区域电网电量边际与容量边际排放因子（按项目所在区域公布值）、项目所在省输配电损失率、' +
      '监测数据联网试运行完成时间的证明、抽采泵出口与混配入口的流量记录。',
  },
  {
    methodology_id: 'CCER-10-001',
    version: 'V01',
    section: 'carbon_impact',
    content:
      '对碳收益的影响：减排量由「瓦斯排空基准线」减去「项目自身排放（运维电力、氧化后 CO₂、未氧化逃逸）」得到，' +
      '因此外供电量与供热量的计量口径直接决定基准线规模；同时入炉甲烷量取「实测值」与「按能量反推值」的较小值，' +
      '所以实测数据的完整性与仪表检定记录会直接压低或抬高可计减排量。',
  },
];

export function seedInterpretations() {
  for (const it of INTERPRETATIONS) {
    run(
      `INSERT INTO methodology_interpretation
       (id,methodology_id,version,section,content,origin,status,citations_json,reviewed_by,reviewed_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(methodology_id,version,section) DO UPDATE SET
         content=excluded.content, updated_at=excluded.updated_at`,
      [
        newId('MIT'), it.methodology_id, it.version, it.section, it.content, 'manual', 'reviewed',
        j([]), '系统基线（依据官方 PDF 条款整理）', nowIso(), nowIso(),
      ]
    );
  }
}

/* ------------------------------------------------------------------ */
/*  5. 数据缺口台账（真实缺口，不掩饰）                                  */
/* ------------------------------------------------------------------ */

export function seedDataGaps() {
  for (const g of DATA_GAPS) {
    run(
      `INSERT INTO data_gap
       (id,dataset,gap_key,title,description,impact,manual_path,auto_action,import_template,severity,status,detected_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(gap_key) DO UPDATE SET
         title=excluded.title, description=excluded.description, impact=excluded.impact,
         auto_action=excluded.auto_action, manual_path=NULL, severity=excluded.severity,
         status=CASE WHEN data_gap.status = 'open' AND excluded.status = 'closed' THEN 'closed' ELSE data_gap.status END,
         updated_at=excluded.updated_at`,
      [
        newId('GAP'), g.dataset, g.gap_key, g.title, g.description, g.impact || null,
        // 【二轮整改】不再写入人工补录路径：原始人工文案仅由界面按历史留痕折叠展示
        null, g.auto_action || null, g.import_template || null, g.severity || 'normal',
        // 目录里已结清的缺口（例如编号已全部核实、PDF 已归档）直接以 closed 登记，
        // 不再在全新库里重新制造过期缺口；已打开的缺口不会被种子重新打开。
        g.status || 'open',
        nowIso(), nowIso(),
      ]
    );
  }
}

/* ------------------------------------------------------------------ */
/*  6. 团队、数据源配置、模型配置、指标口径说明                          */
/* ------------------------------------------------------------------ */

export function seedTeamsAndGrants() {
  const teams = [
    { id: 'team-carbon', name: '碳资产研究组', description: '政策与方法学跟踪、规则复核' },
    { id: 'team-invest', name: '投资分析组', description: '项目筛选、内部项目库维护' },
    { id: 'team-other', name: '综合管理组', description: '只读查看' },
    { id: 'team-default', name: '默认团队', description: '未分配项目的归属团队' },
  ];
  for (const t of teams) {
    run(
      `INSERT INTO app_team (id,name,description,active,created_at) VALUES (?,?,?,1,?)
       ON CONFLICT(id) DO UPDATE SET name=excluded.name, description=excluded.description`,
      [t.id, t.name, t.description || null, nowIso()]
    );
  }
}

export function seedDatasources() {
  const byUrl = sourceIdByKey();
  const rows = [
    {
      name: '生态环境部 · 气候司方法学与政策发布页',
      source_kind: 'official_page',
      url: 'https://www.mee.gov.cn/xxgk2018/xxgk/xxgk06/',
      parser: 'html_list',
      frequency: 'daily',
      license_note: '政府网站公开发布信息，按站点规则低频访问；只作为发现线索，须人工确认后入库。',
      data_owner: '政策研究员',
      enabled: 1,
      allowed_domains: ['www.mee.gov.cn'],
      status_note: '官方公告巡检（发现线索 → 待审核 → 人工确认发布）',
    },
    {
      name: '全国 CCER 注册登记系统及信息平台',
      source_kind: 'official_page',
      url: 'https://ccer.cets.org.cn/projectPublicity/projectPublicityList',
      parser: 'registry_public_list_v1',
      frequency: 'daily',
      license_note: '读取公开页面实际调用的站内列表、详情和附件；低频访问并监控页面/接口变更。',
      data_owner: '政策研究员',
      enabled: 1,
      paused: 0,
      allowed_domains: ['ccer.cets.org.cn'],
      status_note: '每日自动同步公开项目；异常项目进入复核，接口改版时保留模板导入路径。',
    },
    {
      name: '全国温室气体自愿减排交易系统 · 每日行情',
      source_kind: 'official_page',
      url: 'https://www.ccer.com.cn/wcm/ccer/html/2502lshq/index.html',
      parser: 'manual',
      frequency: 'manual',
      license_note: '前端渲染页面，未提供公开数据接口；行情须按官方页面人工摘录后导入并核对。',
      data_owner: '投资分析师',
      enabled: 0,
      paused: 1,
      allowed_domains: ['www.ccer.com.cn'],
      status_note: '真实缺口：每日行情须用「每日行情导入模板」CSV 导入，次日复核',
    },
  ];
  for (const r of rows) {
    run(
      `INSERT INTO datasource_config
       (id,source_id,name,source_kind,url,method,headers_json,field_mapping,parser,frequency,
        rate_limit_per_min,timeout_ms,retry_max,license_note,data_owner,enabled,paused,
        last_run_at,last_success_at,last_status,last_error,consecutive_failures,allowed_domains,
        created_by,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        newId('DSC'), byUrl.get(r.url) || null, r.name, r.source_kind, r.url, 'GET', null, null,
        r.parser, r.frequency, 6, 15000, 2, r.license_note, r.data_owner,
        r.enabled ? 1 : 0, r.paused ? 1 : 0, null, null, 'never', null, 0,
        j(r.allowed_domains || []), 'system:seed', nowIso(), nowIso(),
      ]
    );
  }
}

export function seedLlmPlaceholder() {
  // 按需求规格：默认不配置任何外部模型，AI 能力全部关闭且不影响规则与数据
  run(
    `INSERT INTO llm_provider
     (id,name,provider_kind,base_url,model,credential_ref,credential_cipher,timeout_ms,max_calls_per_day,
      enabled,use_policy_summary,use_methodology_extract,use_project_extract,use_qa_draft,allow_sensitive,
      allowed_domains,last_test_at,last_test_result,last_test_message,calls_today,calls_today_date,note,
      created_by,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,0,0,0,0,0,0,?,NULL,NULL,NULL,0,NULL,?,?,?,?)`,
    [
      newId('LLM'), '（未配置）机构自建或已批准的大模型', 'openai_compatible',
      'https://example.invalid/v1', '（待填写）', null, null, 30000, 200,
      j([]),
      '默认占位条目：未启用。管理员填写 Base URL、模型名与凭据引用名并逐用途开启后才会生效。',
      'system:seed', nowIso(), nowIso(),
    ]
  );
}

const METRIC_DEFS = [
  ['dash.methodology_formal', '总览', '正式有效方法学数', '仅统计 document_status = formal 且已从官方发布通知核实编号的方法学；草案与编号待核实项不计入。', '项', '方法学目录（policy_document + methodology_version）'],
  ['dash.policy_recent', '总览', '近 30 天新增/修订政策数', '按 policy_document.publish_date 落在最近 30 天内统计；修订按 policy_change 的 detected_at 统计。', '条', '政策库'],
  ['dash.project_public', '总览', '公示项目数', 'stage_project_public = 1 的公开项目数。**仅为系统已收录数，不等于全国总数**（注册登记系统列表未能自动获取）。', '个', '公开项目库（人工导入/补录）'],
  ['dash.project_registered', '总览', '登记项目数', 'stage_project_registered = 1 的公开项目数。', '个', '公开项目库（人工导入/补录）'],
  ['dash.reduction_registered', '总览', '已登记减排量', 'reduction_batch.registered_amount 合计。业主公示预计量与核查量不计入本指标。', 'tCO₂e', '公开项目库 · 减排量批次'],
  ['dash.trade_latest', '总览', '最新交易日成交量/均价/金额', '取 trade_daily 中最近一个有成交的交易日（volume > 0）；无成交交易日不显示 0 元价格，休市与数据暂缺分别标注。', 'tCO₂e / 元·tCO₂e⁻¹ / 元', '交易信息 · 每日行情（人工导入并核对）'],
  ['dash.data_anomaly', '总览', '数据异常数', 'data_reconciliation 中 status = open 且 severity in (warning, critical) 的条数。**该指标已从公开总览移除（docs/44 第 4 条）**：运行状态只在后台「运行与内容维护」中展示，口径定义保留供后台与历史沿用。', '条', '每日核对（后台运行信息）'],
  ['dash.content_recent', '总览', '近 30 天新收录研报与动态', 'content_item 中 is_demo=0、duplicate_of IS NULL、record_kind=article 且 COALESCE(published_at, collected_at) 落在最近 30 天内的条数；来源首页/栏目页归档不计入。', '条', '研报与行业动态（公开搜索 API + 网页抓取）'],
  ['trade.avg_price', '交易信息', '区间成交均价', '区间成交均价 = 区间成交额之和 ÷ 区间成交量之和；成交量为 0 时结果为空，**不取日均价的简单平均**。', '元/tCO₂e', '交易信息 · 每日行情'],
  ['trade.cumulative', '交易信息', '累计成交量/额', '系统内已导入且已核对的行情累计值，并与官方披露累计值（trade_cumulative_reference）核对，差异告警。', 'tCO₂e / 元', '交易信息 · 每日行情 + 官方披露值'],
  ['project.stage', '项目信息', '项目阶段', '项目公示、审定、项目登记、减排量公示、核查、减排量登记六个阶段**分列存储**；同一项目的多个阶段不互斥，不能相加当作项目总数。', '阶段', '公开项目库 · 项目事件'],
];

export function seedMetricDefinitions() {
  for (const [key, module, label, caliber, unit, source_note] of METRIC_DEFS) {
    run(
      `INSERT INTO metric_definition (key,module,label,caliber,unit,source_note,updated_at)
       VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(key) DO UPDATE SET label=excluded.label, caliber=excluded.caliber,
         unit=excluded.unit, source_note=excluded.source_note, updated_at=excluded.updated_at`,
      [key, module, label, caliber, unit, source_note, nowIso()]
    );
  }
}

/* ------------------------------------------------------------------ */
/*  7. 对外入口                                                        */
/* ------------------------------------------------------------------ */

export function seedV2({ withPublicDemo = true, calendarDays = 60 } = {}) {
  wipeV2();
  tx(() => {
    seedPolicies();
    seedDocVerifications();
    seedInterpretations();
    seedDataGaps();
    seedTeamsAndGrants();
    seedDatasources();
    seedLlmPlaceholder();
    seedMetricDefinitions();
    seedTradeCalendar(calendarDays);
    if (withPublicDemo) seedPublicProjects();
  });
  return {
    policies: POLICY_DOCUMENTS.length,
    doc_verifications: Object.keys(DOC_VERIFICATIONS).length,
    doc_sources: Object.keys(METHODOLOGY_DOC_SOURCES).length,
    data_gaps: DATA_GAPS.length,
    public_projects: withPublicDemo ? PUBLIC_PROJECTS.length : 0,
  };
}

export function v2Seeded() {
  const r = get('SELECT COUNT(*) AS c FROM policy_document');
  return !!(r && r.c > 0);
}

export { PUBLIC_PROJECTS };
