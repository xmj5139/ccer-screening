/**
 * 初始化与种子数据服务
 * ============================================================================
 * 职责：
 *   1. 建表（schema.sql）
 *   2. 写入官方来源库（SourceDocument）
 *   3. 写入方法学目录与方法学版本（正式 / 修订征求意见稿分列）
 *   4. 写入项目事实字段字典（Fact Field Dictionary）
 *   5. 写入通用门槛规则与各方法学规则卡（Rule）
 *   6. 写入公式（Formula）与因子版本（FactorVersion）
 *   7. 写入示例项目、证据、事实（用于 7 项关键验收用例）
 *   8. 生成目录核对与草案跟踪告警（Alert）
 *   9. 写入用户、订阅与系统元数据
 *
 * 纪律：本文件不做任何推测性补录。凡未从官方来源核实的编号一律留空并产生告警。
 */
import { getDb, run, all, get, setMeta, audit, tx } from '../core/db.mjs';
import { newId, nowIso, todayCst, j } from '../core/util.mjs';
import { OFFICIAL_SOURCES, METHODOLOGY_CATALOG, CATALOG_BASELINE } from '../data/catalog.mjs';
import { FACT_FIELDS } from '../data/fact-fields.mjs';
import { commonRules } from '../rules/common.mjs';
import {
  listMethodologyModules, collectFactors, collectFormulas, hasRulecard, hasPlugin,
} from '../methodologies/index.mjs';

const TABLES = [
  'audit_log', 'alert', 'subscription', 'review_decision', 'report', 'calculation_run',
  'eligibility_run', 'match_run', 'project_fact', 'project_evidence', 'project',
  'fact_field', 'factor_version', 'formula', 'rule', 'methodology_version',
  'source_change', 'source_document', 'user_session', 'app_user',
];

export function wipe() {
  const db = getDb();
  db.exec('PRAGMA foreign_keys = OFF;');
  for (const t of TABLES) {
    try {
      db.exec(`DELETE FROM ${t};`);
    } catch {
      /* 表可能尚未创建 */
    }
  }
  db.exec('PRAGMA foreign_keys = ON;');
}

/** 正式有效且可作候选的项目类型集合（供通用规则 C-03 动态生成） */
export function formalProjectTypes() {
  return [
    ...new Set(
      METHODOLOGY_CATALOG.filter(
        (m) => m.document_status === 'formal' && m.is_candidate_eligible === 1
      ).flatMap((m) => m.project_types || [])
    ),
  ];
}

export function seedAll({ withDemo = true, actor = 'system:seed' } = {}) {
  const db = getDb();
  wipe();

  tx(() => {
    /* ---------------------- 1. 官方来源库 ---------------------- */
    const sourceIdByKey = new Map();
    for (const s of OFFICIAL_SOURCES) {
      const id = newId('SRC');
      sourceIdByKey.set(s.key, id);
      run(
        `INSERT INTO source_document
         (id,url,title,issuing_authority,doc_number,publish_date,effective_date,fetched_at,
          original_file_hash,file_type,is_official,tier,status,parse_quality,parse_note,
          local_path,domain,region,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          id, s.url, s.title, s.issuing_authority || null, s.doc_number || null,
          s.publish_date || null, s.effective_date || null, nowIso(),
          null, 'html', s.is_official ? 1 : 0, s.tier || 1, s.status,
          s.parse_quality || null, s.parse_note || null, null, s.domain || null, null,
          nowIso(), nowIso(),
        ]
      );
    }

    /* ---------------------- 2. 方法学版本 ---------------------- */
    const mvIdByCode = new Map();
    for (const m of METHODOLOGY_CATALOG) {
      const id = newId('MV');
      const key = m.code_display || `${m.methodology_id}::${m.version}`;
      mvIdByCode.set(key, id);
      const approvedRulecard = hasRulecard(m.methodology_id, m.version);
      const approvedPlugin = hasPlugin(m.methodology_id, m.version);
      // ------------------------------------------------------------------
      // 【审批状态纪律】代码里存在规则卡/插件模块，**不等于**已通过领域专家审核。
      // 因此这里一律写入 'pending_review'：结构已就位，等待复核签字。
      // 只有在 docs/12 的 EXP 条目确认完毕、且经管理后台记录审批人与时间后，
      // 才可由 'pending_review' 流转为 'approved'。绝不自动写 approved。
      // ------------------------------------------------------------------
      const rulecardStatus = approvedRulecard ? 'pending_review' : 'none';
      const calculatorStatus = approvedPlugin ? 'pending_review' : 'none';
      run(
        `INSERT INTO methodology_version
         (id,methodology_id,code_display,name,version,document_status,domain,project_types,tech_routes,
          scale_note,crediting_note,release_date,effective_date,repeal_date,official_url,source_id,
          original_file_hash,approved_by,approved_at,rulecard_status,rulecard_approved_by,
          rulecard_approved_at,calculator_status,calculator_approved_by,calculator_approved_at,
          supersedes_id,catalog_confidence,is_candidate_eligible,exclusion_note,change_log,
          created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          id, m.methodology_id, m.code_display || null, m.name, m.version, m.document_status,
          m.domain || null, j(m.project_types || []), j(m.tech_routes || []),
          m.scale_note || null, m.crediting_note || null, m.release_date || null,
          m.effective_date || null, null, m.official_url || null, sourceIdByKey.get(m.source_key) || null,
          null,
          m.document_status === 'formal' ? '生态环境部（依发布通知）' : '征求意见稿发布机关',
          m.release_date || null,
          approvedRulecard ? rulecardStatus : 'none',
          approvedRulecard ? null : null,
          null,
          approvedPlugin ? calculatorStatus : 'none',
          approvedPlugin ? null : null,
          null,
          null,
          m.catalog_confidence, m.is_candidate_eligible,
          m.exclusion_note || null, null, nowIso(), nowIso(),
        ]
      );
    }
    // 回填 supersedes（修订稿指向现行正式版）
    for (const m of METHODOLOGY_CATALOG) {
      if (!m.supersedes_code) continue;
      const id = mvIdByCode.get(m.code_display || `${m.methodology_id}::${m.version}`);
      const target = mvIdByCode.get(m.supersedes_code);
      if (id && target) run('UPDATE methodology_version SET supersedes_id = ? WHERE id = ?', [target, id]);
    }

    /* ---------------------- 3. 项目事实字段字典 ---------------------- */
    let order = 0;
    for (const f of FACT_FIELDS) {
      order += 10;
      run(
        `INSERT INTO fact_field
         (key,label,group_name,value_type,unit,enum_values,applies_to,required_for,evidence_policy,description,sort_order)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [
          f.key, f.label, f.group_name || '通用', f.value_type, f.unit || null,
          j(f.enum_values || []), j(f.applies_to || []), j(f.required_for || []),
          f.evidence_policy || 'normal', f.description || null, order,
        ]
      );
    }

    /* ---------------------- 4. 通用门槛规则 ---------------------- */
    const types = formalProjectTypes();
    for (const r of commonRules(types)) {
      insertRule(r);
    }

    /* ---------------------- 5. 方法学规则卡 + 公式 + 因子 ---------------------- */
    for (const mod of listMethodologyModules()) {
      const mvId = mvIdByCode.get(`${mod.meta.methodology_id}::${mod.meta.version}`) ||
        mvIdByCode.get(
          METHODOLOGY_CATALOG.find(
            (m) => m.methodology_id === mod.meta.methodology_id && m.version === mod.meta.version
          )?.code_display || ''
        );
      if (!mvId) continue;
      for (const r of mod.rulecard || []) {
        insertRule({ ...r, methodology_version_id: mvId });
      }
      for (const fr of mod.plugin?.formula_refs || []) {
        run(
          `INSERT INTO formula (id,methodology_version_id,formula_id,title,expression,unit,rounding,applicable_period,clause_ref,created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
          [
            newId('FRM'), mvId, fr.formula_id, fr.title || null, fr.expression || null,
            fr.unit || null, fr.rounding || null, fr.applicable_period || null,
            fr.clause_ref || null, nowIso(),
          ]
        );
      }
    }

    for (const f of collectFactors()) {
      run(
        `INSERT INTO factor_version
         (id,factor_key,name,value,unit,methodology_version_id,scope,source_ref,source_year,
          gwp_assessment_report,value_status,verification_note,verified_by,verified_at,
          reasonable_min,reasonable_max,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          newId('FAC'), f.factor_key, f.name, f.value ?? null, f.unit || null,
          f.methodology_version_id || '', f.scope || 'global', f.source_ref || null,
          f.source_year ?? null, f.gwp_assessment_report || null, f.value_status,
          f.verification_note || null,
          f.value_status === 'verified' ? '系统核对（公开权威文献）' : null,
          f.value_status === 'verified' ? nowIso() : null,
          f.reasonable_min ?? null, f.reasonable_max ?? null, nowIso(),
        ]
      );
    }

    /* ---------------------- 6. 告警：目录核对与草案跟踪 ---------------------- */
    /* 目录核对告警只在**确有缺口**时创建：
     *   - 条目数少于设计基线，或
     *   - 仍有编号未从发布通知核实。
     * 两者都不成立时不再生成「条目数一致但编号待核实」这类过期告警
     * （过期告警由每日复查自动结清，见 scripts/dsh-fix-v2-issues.mjs 的复查）。 */
    const seededIds = new Set(METHODOLOGY_CATALOG.map((m) => m.methodology_id));
    const baseline = CATALOG_BASELINE;
    const catalogGapOpen =
      seededIds.size < Number(baseline.design_doc_count || 0) ||
      Number(baseline.pending_code_count || 0) > 0;
    if (catalogGapOpen) {
      run(
        `INSERT INTO alert (id,kind,severity,title,detail,source_id,methodology_id,domain,region,project_types,created_at,status)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          newId('ALR'), 'catalog_gap', 'warning',
          `方法学目录核对：设计基线记载 ${baseline.design_doc_count} 项，本库已录入 ${seededIds.size} 项` +
            (Number(baseline.pending_code_count || 0) > 0 ? `（编号待核实 ${baseline.pending_code_count} 项）` : ''),
          baseline.note,
          sourceIdByKey.get('src-registry') || null, null, null, null, j([]), nowIso(), 'open',
        ]
      );
    }
    run(
      `INSERT INTO alert (id,kind,severity,title,detail,source_id,methodology_id,domain,region,project_types,created_at,status)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        newId('ALR'), 'draft_consultation', 'info',
        '造林碳汇、红树林营造修订征求意见稿在跟踪中',
        '两份修订稿为草案状态，仅作观察与变更跟踪；项目初筛与测算仍绑定现行正式版本 CCER-14-001-V01 / CCER-14-002-V01，不得自动替换。',
        sourceIdByKey.get('src-draft-2026') || null, 'CCER-14-002', '林业和其他碳汇', null,
        j(['造林碳汇', '红树林营造']), nowIso(), 'open',
      ]
    );
    run(
      `INSERT INTO alert (id,kind,severity,title,detail,source_id,methodology_id,domain,region,project_types,created_at,status)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        newId('ALR'), 'structure_changed', 'warning',
        '注册登记系统方法学目录页为前端渲染，自动核验受阻：目录条目数未核实',
        '注册登记系统方法学目录页为前端渲染、站内列表接口返回 401，系统无法自动读取官方目录条目数与编号 → ' +
        '自动核验受阻、条目数**未核实**。系统不推测缺失编号，也不用推测值充当官方目录；' +
        '该事项为自动运行状态（无人工待办），每日任务自动重试，取得官方 PDF / 可渲染通道后自动补核。',
        sourceIdByKey.get('src-registry') || null, null, '注册登记', null, j([]), nowIso(), 'open',
      ]
    );

    /* ---------------------- 7. 用户与订阅 ---------------------- */
    const users = [
      { id: 'user-admin', name: '系统管理员', role: 'admin', team_id: 'team-carbon' },
      { id: 'user-researcher', name: '政策研究员', role: 'researcher', team_id: 'team-carbon' },
      { id: 'user-analyst', name: '投资分析师', role: 'analyst', team_id: 'team-invest' },
      { id: 'user-reviewer', name: '领域复核人', role: 'reviewer', team_id: 'team-carbon' },
      { id: 'user-other', name: '其他团队成员', role: 'viewer', team_id: 'team-other' },
    ];
    for (const u of users) {
      run('INSERT INTO app_user (id,name,role,team_id,active) VALUES (?,?,?,?,1)', [u.id, u.name, u.role, u.team_id]);
    }

    run(
      `INSERT INTO subscription (id,name,owner,domains,regions,project_types,channel,active,created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [
        newId('SUB'), '油气甲烷与煤矿瓦斯方法学变更', 'user-researcher',
        j(['燃料逸散性排放']), j([]),
        j(['煤矿瓦斯回收利用', '海上油田伴生气回收利用', '陆上气田试气放喷气回收利用', '陆上油田低气量伴生气回收利用']),
        'in_app', 1, nowIso(),
      ]
    );

    setMeta(db, 'catalog_baseline', j(CATALOG_BASELINE));
    // 身份认证模式：默认 session（身份只来自服务端会话，x-user-id / ?user= 一律忽略）。
    // 仅本地演示时可显式设置 CCER_AUTH_MODE=dev；见 src/services/auth-svc.mjs。
    setMeta(db, 'auth_mode', 'session');
    // 默认严格模式：未通过领域专家审核的规则卡与插件一律不得出数。
    setMeta(db, 'calculator_gate_mode', 'strict');
    // 演示通道默认关闭；仅在明确开启时，才允许在隔离通道内做情景推演。
    setMeta(db, 'demo_channel_enabled', 'false');
    setMeta(db, 'demo_channel_enabled_by', '');
    setMeta(db, 'demo_channel_enabled_at', '');
    setMeta(db, 'demo_channel_note',
      '演示通道用于流程演示与内部讨论。开启后仍不产生可用于投资筛选的数字：' +
      '运行记录标记为 demo，不进入报告，不可导出。');
    setMeta(db, 'seeded_at', nowIso());
  });

  if (withDemo) seedDemoProjects();

  audit({
    actor,
    action: 'seed.rebuild',
    objectType: 'system',
    detail: {
      sources: OFFICIAL_SOURCES.length,
      methodology_versions: METHODOLOGY_CATALOG.length,
      fact_fields: FACT_FIELDS.length,
      withDemo,
    },
  });

  return {
    sources: OFFICIAL_SOURCES.length,
    methodology_versions: METHODOLOGY_CATALOG.length,
    fact_fields: FACT_FIELDS.length,
  };
}

function insertRule(r) {
  run(
    `INSERT INTO rule
     (id,methodology_version_id,layer,rule_id,title,condition_text,expression_text,expr,
      required_fields,evidence_policy,evidence_requirement,clause_ref,severity,fail_conclusion,
      unknown_action,sort_order,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      newId('RUL'), r.methodology_version_id ?? null, r.layer, r.rule_id, r.title,
      r.condition_text, r.expression_text, j(r.expr), j(r.required_fields || []),
      r.evidence_policy || 'normal', r.evidence_requirement || null, r.clause_ref || null,
      r.severity, r.fail_conclusion || null, r.unknown_action || null,
      r.sort_order ?? 100, nowIso(),
    ]
  );
}

/* ========================================================================== */
/*  示例项目（覆盖设计文档第 10 节的 7 项关键验收用例）                        */
/* ========================================================================== */

function seedDemoProjects() {
  tx(() => {
    const P = (row) => {
      run(
        `INSERT INTO project
         (id,code,name,owner_name,province,city,project_type,technology_route,industry,stage,
          capacity_note,boundary_desc,registry_project_public,registry_validated,registry_project_registered,
          registry_reduction_public,registry_verified,registry_reduction_registered,registry_public_url,
          owner_announced_estimate,verified_amount,registered_amount,confidentiality,team_id,analyst,
          created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          row.id, row.code, row.name, row.owner_name, row.province, row.city, row.project_type,
          row.technology_route, row.industry || '能源', row.stage || '运营', row.capacity_note || null,
          row.boundary_desc || null,
          row.registry_project_public ? 1 : 0, row.registry_validated ? 1 : 0,
          row.registry_project_registered ? 1 : 0, row.registry_reduction_public ? 1 : 0,
          row.registry_verified ? 1 : 0, row.registry_reduction_registered ? 1 : 0,
          row.registry_public_url || null,
          row.owner_announced_estimate ?? null, row.verified_amount ?? null,
          row.registered_amount ?? null,
          row.confidentiality || 'internal', row.team_id, row.analyst,
          nowIso(), nowIso(),
        ]
      );
    };

    const E = (projectId, docType, fileName, page, excerpt, uploadedBy, confidentiality = 'internal') => {
      const id = newId('EVD');
      run(
        `INSERT INTO project_evidence
         (id,project_id,file_name,file_hash,doc_type,page,line_ref,excerpt,uploaded_by,uploaded_at,confidentiality,retention_note)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          id, projectId, fileName, `sha256:${'0'.repeat(8)}${id.slice(-8)}`, docType, page, null,
          excerpt, uploadedBy, nowIso(), confidentiality, null,
        ]
      );
      return id;
    };

    const F = (projectId, fieldKey, value, sourceKind, opts = {}) => {
      const key = `FACT-${projectId}-${fieldKey}`;
      const meta = FACT_FIELDS.find((f) => f.key === fieldKey);
      const type = opts.valueType || (meta ? meta.value_type : 'text');
      let text = null;
      let numv = null;
      if (type === 'number') numv = Number(value);
      else if (type === 'bool') text = value ? 'true' : 'false';
      else text = value === null || value === undefined ? null : String(value);
      run(
        `INSERT INTO project_fact
         (id,project_id,field_key,value_text,value_num,value_type,unit,source_kind,evidence_id,asserted_by,asserted_at,note)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          newId('FCT'), projectId, fieldKey, text, numv, type, meta?.unit || null,
          sourceKind, opts.evidenceId || null, opts.assertedBy || 'system:seed',
          nowIso(), opts.note || null,
        ]
      );
      void key;
    };

    const commonComplete = (projectId, ev) => {
      F(projectId, 'comp.owner_commitment', true, 'project_doc', { evidenceId: ev.commitment });
      F(projectId, 'comp.uniqueness_declared', true, 'project_doc', { evidenceId: ev.commitment });
      F(projectId, 'comp.legal_ghg_obligation', false, 'official', { evidenceId: ev.obligation });
      F(projectId, 'comp.in_ets_quota', false, 'official', { evidenceId: ev.obligation });
      F(projectId, 'comp.additionality_route', '免予论证', 'project_doc');
      F(projectId, 'own.reduction_ownership_clear', true, 'project_doc', { evidenceId: ev.ownership });
      F(projectId, 'own.other_mechanism_claim', '无', 'analyst');
      F(projectId, 'own.renewable_certificate_claim', '无', 'analyst');
      F(projectId, 'own.subsidy_or_contract_claim', '无', 'analyst');
    };

    /* ---------- P1：资料完整的煤矿瓦斯发电项目（应判「可继续尽调」） ---------- */
    const p1 = newId('PRJ');
    P({
      id: p1, code: 'CCER-DEMO-001', name: '山西晋城某煤业低浓度瓦斯发电项目',
      owner_name: '晋城某煤业有限公司', province: '山西省', city: '晋城市',
      project_type: '煤矿瓦斯回收利用', technology_route: '低浓度瓦斯发电',
      stage: '运营', capacity_note: '装机 6 MW，年利用瓦斯约 9600 万 Nm³',
      boundary_desc: '矿井风井场地及瓦斯抽采泵站至瓦斯发电站围墙内',
      registry_project_public: false, registry_validated: false, registry_project_registered: false,
      registry_reduction_public: false, registry_verified: false, registry_reduction_registered: false,
      team_id: 'team-invest', analyst: '投资分析师',
    });
    const e1 = {
      commitment: E(p1, '项目建议书', '项目建议书.pdf', 3, '业主承诺项目材料真实、完整、有效，且未在其他机制申报。', '投资分析师'),
      obligation: E(p1, '公示截图', '重点排放单位名录核对截图.pdf', 1, '该公司未列入全国碳排放权交易市场重点排放单位名录，亦无地方配额管理记录。', '政策研究员', 'restricted'),
      start: E(p1, '开工报告', '开工报告.pdf', 1, '项目于 2023 年 5 月 10 日正式开工。', '投资分析师'),
      reduction: E(p1, '监测台账', '瓦斯发电运行台账2024-2025.xlsx', 1, '2024 年 6 月起稳定运行并产生减排量。', '投资分析师'),
      concentration: E(p1, '监测台账', '瓦斯浓度检测报告.pdf', 2, '风排瓦斯甲烷体积浓度实测均值 1.2%，抽采瓦斯 4.5%。', '投资分析师'),
      online: E(p1, '监测台账', '监测数据联网方案.pdf', 1, '监测数据实时上传全国碳市场管理平台。', '投资分析师'),
      ownership: E(p1, '合同', '减排量权属确认函.pdf', 1, '本项目产生的减排量归项目业主所有，无争议。', '投资分析师'),
    };
    commonComplete(p1, e1);
    F(p1, 'proj.name', '山西晋城某煤业低浓度瓦斯发电项目', 'project_doc', { evidenceId: e1.commitment });
    F(p1, 'proj.project_type', '煤矿瓦斯回收利用', 'project_doc', { evidenceId: e1.commitment });
    F(p1, 'proj.technology_route', '低浓度瓦斯发电', 'project_doc');
    F(p1, 'proj.province', '山西省', 'project_doc');
    F(p1, 'time.start_construction_date', '2023-05-10', 'project_doc', { evidenceId: e1.start });
    F(p1, 'time.reduction_generation_start', '2024-06-01', 'project_doc', { evidenceId: e1.reduction });
    F(p1, 'time.crediting_start', '2025-01-01', 'project_doc');
    F(p1, 'time.crediting_period_years', 10, 'project_doc');
    F(p1, 'gas.mine_type', '井工煤矿', 'project_doc');
    F(p1, 'gas.gas_category', '风排瓦斯+抽采低浓度瓦斯', 'project_doc');
    F(p1, 'gas.ch4_concentration_pct', 1.2, 'project_doc', { evidenceId: e1.concentration });
    F(p1, 'gas.recovery_volume_nm3', 96000000, 'project_doc', { evidenceId: e1.reduction });
    F(p1, 'gas.hours_per_year', 8000, 'project_doc', { evidenceId: e1.reduction });
    F(p1, 'gas.utilization_route', '瓦斯发电', 'project_doc');
    F(p1, 'gas.baseline_scenario', '瓦斯排空', 'project_doc');

    // ---- CCER-10-001 v2 规则卡与插件新增的必需字段（依据官方 PDF §2、§5—§7） ----
    F(p1, 'gas.mine_abandoned_or_closed', false, 'project_doc', { evidenceId: e1.commitment });
    F(p1, 'gas.oxidation_technology', '无焰氧化', 'project_doc', { evidenceId: e1.commitment });
    F(p1, 'gas.heat_utilization_route', '发电', 'project_doc');
    F(p1, 'gas.diluted_from_high_concentration', false, 'project_doc', { note: '不存在将浓度≥8%的瓦斯人为稀释的情形。' });
    F(p1, 'gas.destruction_efficiency', 0.9, 'project_doc', { note: '方法学表 6 缺省值 90%（NB/T 51012-2014 5.5.1）。' });
    F(p1, 'gas.elec_export_mwh', 30000, 'project_doc', { evidenceId: e1.reduction, note: '公式(5)(16) 的外供电量。' });
    F(p1, 'gas.heat_export_gj', 0, 'project_doc', { note: '本项目不对外供热。' });
    F(p1, 'gas.grid_ef_om', 0.6, 'analyst', { note: '电量边际排放因子，取项目所在区域电网公布值（演示取值）。' });
    F(p1, 'gas.grid_ef_bm', 0.4, 'analyst', { note: '容量边际排放因子，取项目所在区域电网公布值（演示取值）。' });
    F(p1, 'gas.cons_elec_mwh', 380, 'project_doc', { note: '公式(12) 的项目下网电量。' });
    F(p1, 'gas.tdl', 0.05, 'analyst', { note: '输配电损失率，取《电力工业统计资料汇编》本省当年值（演示取值）。' });
    F(p1, 'gas.elec_efficiency', 0.35, 'project_doc', { note: '公式(16) 的发电效率，取可研值。' });
    F(p1, 'gas.drainage_flow_npt_m3h', 20000, 'project_doc', { note: '§6.7a) 地面抽采泵出口常温常压流量之和。' });
    F(p1, 'gas.mixing_inlet_flow_npt_m3h', 12000, 'project_doc', { note: '§6.7a) 混配管道入口常温常压流量。' });
    F(p1, 'gas.mixing_flow_check_ok', true, 'analyst', { note: '20000 ≥ 12000，未触发公式(19) 情形。' });
    F(p1, 'gas.high_conc_periods_recorded', true, 'project_doc', { note: '浓度≥8% 的时段已记录并从 time_y 中扣除。' });
    F(p1, 'mon.networking_trial_completed_date', '2023-12-01', 'project_doc', { evidenceId: e1.online });
    F(p1, 'mon.reduction_after_networking', true, 'project_doc', { evidenceId: e1.reduction, note: '减排量产生于联网试运行完成之后。' });
    F(p1, 'mon.metering_online', true, 'project_doc', { evidenceId: e1.online });
    F(p1, 'mon.meter_calibration', '每年一次第三方检定，仪表清单见附件', 'project_doc');
    F(p1, 'mon.data_archive_note', '原始记录留存 10 年', 'project_doc');
    F(p1, 'com.carbon_price_scenario', 70, 'analyst');

    /* ---------- P2：开工日期缺失 + 义务状态仅有业主自述（应判「资料不足」） ---------- */
    const p2 = newId('PRJ');
    P({
      id: p2, code: 'CCER-DEMO-002', name: '内蒙古某煤矿瓦斯氧化供热项目',
      owner_name: '鄂尔多斯某煤业有限公司', province: '内蒙古自治区', city: '鄂尔多斯市',
      project_type: '煤矿瓦斯回收利用', technology_route: '瓦斯氧化',
      stage: '建设', capacity_note: '拟建瓦斯氧化装置 2 套',
      team_id: 'team-invest', analyst: '投资分析师',
    });
    const e2 = {
      commitment: E(p2, '项目建议书', '项目建议书（初稿）.docx', 2, '业主声明项目材料真实完整。', '投资分析师'),
      ownership: E(p2, '合同', '权属说明.pdf', 1, '减排量权属归业主。', '投资分析师'),
    };
    F(p2, 'comp.owner_commitment', true, 'project_doc', { evidenceId: e2.commitment });
    F(p2, 'comp.uniqueness_declared', true, 'project_doc', { evidenceId: e2.commitment });
    // 义务状态仅业主自述 —— 严格证据策略下应返回「待核实」
    F(p2, 'comp.legal_ghg_obligation', false, 'owner_claim', { note: '业主口头说明不承担法定减排义务，未提供任何材料' });
    F(p2, 'comp.in_ets_quota', false, 'owner_claim', { note: '业主自述未纳入配额管理' });
    F(p2, 'comp.additionality_route', '免予论证', 'project_doc');
    F(p2, 'own.reduction_ownership_clear', true, 'project_doc', { evidenceId: e2.ownership });
    F(p2, 'own.other_mechanism_claim', '待核实', 'analyst');
    F(p2, 'proj.name', '内蒙古某煤矿瓦斯氧化供热项目', 'project_doc', { evidenceId: e2.commitment });
    F(p2, 'proj.project_type', '煤矿瓦斯回收利用', 'project_doc', { evidenceId: e2.commitment });
    F(p2, 'proj.technology_route', '瓦斯氧化', 'project_doc');
    // 【刻意留空】time.start_construction_date —— 验收用例 2
    F(p2, 'time.reduction_generation_start', '2025-03-01', 'owner_claim', { note: '业主估计，无监测记录' });
    F(p2, 'time.crediting_start', '2026-01-01', 'analyst');
    F(p2, 'time.crediting_period_years', 10, 'analyst');
    F(p2, 'gas.mine_type', '井工煤矿', 'project_doc');
    F(p2, 'gas.gas_category', '抽采低浓度瓦斯', 'project_doc');
    F(p2, 'gas.ch4_concentration_pct', 2.4, 'owner_claim', { note: '业主提供数值，尚未取得检测报告' });
    F(p2, 'gas.utilization_route', '瓦斯氧化', 'project_doc');
    F(p2, 'gas.baseline_scenario', '瓦斯排空', 'analyst');
    F(p2, 'mon.metering_online', false, 'analyst');

    /* ---------- P3：海上油田伴生气项目，仅处于「项目公示」状态 ---------- */
    const p3 = newId('PRJ');
    P({
      id: p3, code: 'CCER-DEMO-003', name: '渤海某海上油田伴生气回收生产 LNG 项目',
      owner_name: '天津某海洋石油工程有限公司', province: '天津市', city: '天津市',
      project_type: '海上油田伴生气回收利用', technology_route: '液化天然气（LNG）',
      stage: '运营', capacity_note: '回收伴生气约 2000 万 Nm³/年',
      registry_project_public: true, registry_validated: false, registry_project_registered: false,
      registry_reduction_public: false, registry_verified: false, registry_reduction_registered: false,
      registry_public_url: 'https://ccer.cets.org.cn/（示例公示页，仅演示状态分列）',
      owner_announced_estimate: 320000,
      team_id: 'team-invest', analyst: '投资分析师',
    });
    const e3 = {
      commitment: E(p3, '项目建议书', '海上伴生气回收项目建议书.pdf', 5, '业主承诺材料真实完整，项目唯一。', '投资分析师'),
      obligation: E(p3, '公示截图', '海上油田非控排企业说明.pdf', 1, '该海上油田未纳入全国碳排放权交易市场配额管理，不承担法定减排义务。', '政策研究员', 'restricted'),
      start: E(p3, '开工报告', '海上平台改造开工令.pdf', 1, '项目于 2023 年 8 月 15 日开工。', '投资分析师'),
      reduction: E(p3, '监测台账', '伴生气回收计量月报2024.pdf', 3, '2024 年 7 月起回收伴生气并生产 LNG，年回收量约 2000 万 Nm³。', '投资分析师'),
      gas: E(p3, '监测台账', '伴生气组分分析报告.pdf', 1, '甲烷体积分数 85.0%。', '投资分析师'),
      online: E(p3, '监测台账', '监测数据联网方案.pdf', 1, '计量数据实时上传全国碳市场管理平台。', '投资分析师'),
      ownership: E(p3, '合同', '减排量权属确认函.pdf', 1, '减排量权属归项目业主。', '投资分析师'),
    };
    commonComplete(p3, e3);
    F(p3, 'proj.name', '渤海某海上油田伴生气回收生产 LNG 项目', 'project_doc', { evidenceId: e3.commitment });
    F(p3, 'proj.project_type', '海上油田伴生气回收利用', 'project_doc', { evidenceId: e3.commitment });
    F(p3, 'proj.technology_route', '液化天然气（LNG）', 'project_doc');
    F(p3, 'time.start_construction_date', '2023-08-15', 'project_doc', { evidenceId: e3.start });
    F(p3, 'time.reduction_generation_start', '2024-07-01', 'project_doc', { evidenceId: e3.reduction });
    F(p3, 'time.crediting_start', '2025-01-01', 'project_doc');
    F(p3, 'time.crediting_period_years', 10, 'project_doc');
    F(p3, 'og.source_type', '海上油田伴生气', 'project_doc');
    F(p3, 'og.product_route', '液化天然气（LNG）', 'project_doc');
    F(p3, 'og.ch4_fraction', 0.85, 'project_doc', { evidenceId: e3.gas });
    F(p3, 'og.recovery_volume_nm3', 20000000, 'project_doc', { evidenceId: e3.reduction });
    F(p3, 'og.flare_baseline_efficiency', 0.98, 'project_doc');
    F(p3, 'mon.metering_online', true, 'project_doc', { evidenceId: e3.online });
    F(p3, 'mon.meter_calibration', '平台流量计年度检定计划已批复', 'project_doc');
    F(p3, 'com.carbon_price_scenario', 70, 'analyst');

    /* ---------- P4：陆上油田低气量伴生气项目，站场规模超限（应判「存在明确障碍」） ---------- */
    const p4 = newId('PRJ');
    P({
      id: p4, code: 'CCER-DEMO-004', name: '新疆某陆上油田伴生气回收项目（站场规模超限）',
      owner_name: '克拉玛依某油田技术服务有限公司', province: '新疆维吾尔自治区', city: '克拉玛依市',
      project_type: '陆上油田低气量伴生气回收利用', technology_route: '稳定轻烃',
      stage: '运营', capacity_note: '站场设计处理规模 3.5 万 m³/天',
      team_id: 'team-invest', analyst: '投资分析师',
    });
    const e4 = {
      commitment: E(p4, '项目建议书', '伴生气回收项目建议书.pdf', 4, '业主承诺材料真实完整，项目唯一。', '投资分析师'),
      obligation: E(p4, '公示截图', '非控排说明.pdf', 1, '该站场未纳入配额管理。', '政策研究员', 'restricted'),
      start: E(p4, '开工报告', '开工报告.pdf', 1, '项目于 2024 年 3 月 1 日开工。', '投资分析师'),
      scale: E(p4, '可研', '站场工艺设计说明书.pdf', 12, '同一站场内伴生气处理系统设计总规模为 35000 m³/天。', '投资分析师'),
      gas: E(p4, '监测台账', '伴生气组分分析报告.pdf', 1, '甲烷体积分数 72%。', '投资分析师'),
      reduction: E(p4, '监测台账', '伴生气回收计量月报.pdf', 2, '年回收伴生气约 600 万 Nm³。', '投资分析师'),
      online: E(p4, '监测台账', '监测数据联网方案.pdf', 1, '数据上传全国碳市场管理平台。', '投资分析师'),
      ownership: E(p4, '合同', '权属确认函.pdf', 1, '减排量权属归业主。', '投资分析师'),
    };
    commonComplete(p4, e4);
    F(p4, 'proj.name', '新疆某陆上油田伴生气回收项目', 'project_doc', { evidenceId: e4.commitment });
    F(p4, 'proj.project_type', '陆上油田低气量伴生气回收利用', 'project_doc', { evidenceId: e4.commitment });
    F(p4, 'proj.technology_route', '稳定轻烃', 'project_doc');
    F(p4, 'time.start_construction_date', '2024-03-01', 'project_doc', { evidenceId: e4.start });
    F(p4, 'time.reduction_generation_start', '2024-10-01', 'project_doc', { evidenceId: e4.reduction });
    F(p4, 'time.crediting_start', '2025-01-01', 'project_doc');
    F(p4, 'time.crediting_period_years', 10, 'project_doc');
    F(p4, 'og.source_type', '陆上油田伴生气', 'project_doc');
    F(p4, 'og.product_route', '稳定轻烃', 'project_doc');
    F(p4, 'og.station_design_scale_m3d', 35000, 'project_doc', { evidenceId: e4.scale });
    F(p4, 'og.ch4_fraction', 0.72, 'project_doc', { evidenceId: e4.gas });
    F(p4, 'og.recovery_volume_nm3', 6000000, 'project_doc', { evidenceId: e4.reduction });
    F(p4, 'og.flare_baseline_efficiency', 0.98, 'project_doc');
    F(p4, 'mon.metering_online', true, 'project_doc', { evidenceId: e4.online });
    F(p4, 'mon.meter_calibration', '流量计年度检定', 'project_doc');

    /* ---------- P5：陆上气田试气放喷气回收项目（可正常测算） ---------- */
    const p5 = newId('PRJ');
    P({
      id: p5, code: 'CCER-DEMO-005', name: '四川某页岩气井试气放喷气回收项目',
      owner_name: '成都某油气工程技术有限公司', province: '四川省', city: '内江市',
      project_type: '陆上气田试气放喷气回收利用', technology_route: '压缩天然气（CNG）',
      stage: '试运行', capacity_note: '单井次试气放喷日均回收 5 万 Nm³',
      team_id: 'team-invest', analyst: '投资分析师',
    });
    const e5 = {
      commitment: E(p5, '项目建议书', '试气放喷气回收方案.pdf', 2, '业主承诺材料真实完整，项目唯一。', '投资分析师'),
      obligation: E(p5, '公示截图', '非控排说明.pdf', 1, '该气田未纳入配额管理。', '政策研究员', 'restricted'),
      start: E(p5, '开工报告', '试气作业开工令.pdf', 1, '项目于 2025 年 2 月 20 日开始试气作业。', '投资分析师'),
      trial: E(p5, '监测台账', '试气放喷作业记录.pdf', 1, '本井次试气放喷 30 天，日均回收放喷气 50000 Nm³（标态）。', '投资分析师'),
      gas: E(p5, '监测台账', '放喷气组分分析报告.pdf', 1, '甲烷体积分数 92%。', '投资分析师'),
      online: E(p5, '监测台账', '数据报送安排.pdf', 1, '试气期间数据按日上传管理平台。', '投资分析师'),
      ownership: E(p5, '合同', '权属确认函.pdf', 1, '减排量权属归业主。', '投资分析师'),
    };
    commonComplete(p5, e5);
    F(p5, 'proj.name', '四川某页岩气井试气放喷气回收项目', 'project_doc', { evidenceId: e5.commitment });
    F(p5, 'proj.project_type', '陆上气田试气放喷气回收利用', 'project_doc', { evidenceId: e5.commitment });
    F(p5, 'proj.technology_route', '压缩天然气（CNG）', 'project_doc');
    F(p5, 'time.start_construction_date', '2025-02-20', 'project_doc', { evidenceId: e5.start });
    F(p5, 'time.reduction_generation_start', '2025-03-01', 'project_doc', { evidenceId: e5.trial });
    F(p5, 'time.crediting_start', '2025-03-01', 'project_doc');
    F(p5, 'time.crediting_period_years', 1, 'project_doc');
    F(p5, 'og.source_type', '陆上气田试气放喷气', 'project_doc');
    F(p5, 'og.well_type', '页岩气井', 'project_doc');
    F(p5, 'og.product_route', '压缩天然气（CNG）', 'project_doc');
    F(p5, 'og.trial_gas_days', 30, 'project_doc', { evidenceId: e5.trial });
    F(p5, 'og.daily_recovery_nm3', 50000, 'project_doc', { evidenceId: e5.trial });
    F(p5, 'og.ch4_fraction', 0.92, 'project_doc', { evidenceId: e5.gas });
    F(p5, 'og.flare_baseline_efficiency', 0.98, 'project_doc');
    F(p5, 'mon.metering_online', true, 'project_doc', { evidenceId: e5.online });
    F(p5, 'mon.meter_calibration', '试气期间临时计量装置已校准', 'project_doc');
    F(p5, 'com.carbon_price_scenario', 70, 'analyst');
  });
}

/** 判断库是否需要初始化 */
export function ensureSeeded() {
  const db = getDb();
  const r = db.prepare('SELECT COUNT(*) AS c FROM methodology_version').get();
  if (!r || r.c === 0) {
    seedAll({ withDemo: true, actor: 'system:auto-seed' });
    return true;
  }
  return false;
}

export function catalogBaseline() {
  const raw = get('SELECT value FROM system_meta WHERE key = ?', ['catalog_baseline']);
  if (!raw) return CATALOG_BASELINE;
  try {
    return JSON.parse(raw.value);
  } catch {
    return CATALOG_BASELINE;
  }
}

export const __internal = { all, todayCst };
