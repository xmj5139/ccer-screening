#!/usr/bin/env node
/**
 * 从实现数据生成「方法学清单」与「项目事实字段表」两份待确认交付物。
 * ============================================================================
 * 设计文档第 11 节明确要求：制作方应先提交**方法学清单**和**项目事实字段表**供确认。
 * 这两份清单直接从代码与数据生成，避免与实现漂移。
 *
 *   node scripts/gen-docs.mjs
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OFFICIAL_SOURCES, METHODOLOGY_CATALOG, CATALOG_BASELINE } from '../src/data/catalog.mjs';
import { FACT_FIELDS, FACT_GROUP_ORDER, SOURCE_KIND_LABELS } from '../src/data/fact-fields.mjs';
import { commonRules } from '../src/rules/common.mjs';
import { listMethodologyModules, collectSelfCheckSamples } from '../src/methodologies/index.mjs';
import { STANDARD_CODES } from '../src/data/standard-codes.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DOCS = join(__dirname, '..', 'docs');
mkdirSync(DOCS, { recursive: true });

const today = new Date().toISOString().slice(0, 10);
const mdEsc = (s) => String(s ?? '—').replace(/\|/g, '\\|').replace(/\n/g, ' ');
const code = (s) => (s ? `\`${s}\`` : '—');

/* ========================================================================== */
/*  05 方法学清单                                                             */
/* ========================================================================== */

function genMethodologyList() {
  const modules = new Map(
    listMethodologyModules().map((m) => [`${m.meta.methodology_id}::${m.meta.version}`, m])
  );
  const L = [];
  L.push('# 方法学清单（待确认交付物 1／2）');
  L.push('');
  L.push(`> 生成日期：${today}　｜　自动生成自 \`src/data/catalog.mjs\` 与 \`src/methodologies/\`，请勿手工编辑。`);
  L.push('> 重新生成：`node scripts/gen-docs.mjs`');
  L.push('');
  L.push('## 本清单的性质与确认要求');
  L.push('');
  L.push('本清单是**方法学目录基线**，须由领域专家逐条确认后方可用于正式项目筛选。确认要点：');
  L.push('');
  L.push('1. **编号与名称**：以生态环境部发布通知为唯一权威来源；第 9–17 项仅有主管部门答记者问口径，');
  L.push('   编号尚未从发布通知核实，须由研究员在[全国温室气体自愿减排注册登记系统](https://ccer.cets.org.cn/)逐条核对后补录。');
  L.push('   系统**不推测**编号；未核实编号的条目仅供检索与观察，不列为可申报候选。');
  L.push('2. **发布/生效日期**：须与发布通知一致。修订征求意见稿的生效日期必须为空。');
  L.push('3. **规则卡状态**：标「已建」的方法学已有结构化规则卡，可执行条件检查；标「未建」的仅供参考。');
  L.push('4. **计算插件状态**：标「已注册」的方法学可执行情景初算，但其中的方法学专属系数仍为占位值，');
  L.push('   须由领域专家逐项确认（见[领域专家确认清单](./12-领域专家确认清单.md)）。');
  L.push('');
  L.push('## 一、目录核对结果');
  L.push('');
  L.push(`- 设计文档记载的官方目录条目数：**${CATALOG_BASELINE.design_doc_count}** 项`);
  L.push(`- 本库已录入方法学条目数：**${CATALOG_BASELINE.seeded_methodology_ids}** 项`);
  L.push(`  - 其中编号已从发布通知核实：**${METHODOLOGY_CATALOG.filter((m) => m.catalog_confidence === 'verified_from_official_notice' && m.document_status === 'formal').length}** 项`);
  L.push(`  - 仅获得主管部门口径、编号待核实：**${METHODOLOGY_CATALOG.filter((m) => m.catalog_confidence === 'name_only_pending_code').length}** 项`);
  L.push(`- 差额：**${CATALOG_BASELINE.design_doc_count - CATALOG_BASELINE.seeded_methodology_ids}** 项，须人工核对后补录`);
  L.push('');
  L.push(`> ${CATALOG_BASELINE.note}`);
  L.push('');
  L.push('系统已就上述差额生成 `catalog_gap` 告警，在「信息雷达」页面持续提示。');
  L.push('');
  L.push('## 二、正式发布的方法学');
  L.push('');
  L.push('| # | 编号 | 名称 | 领域 | 支持项目类型 | 发布日 | 生效日 | 规则卡 | 计算插件 | 编号核实 |');
  L.push('|---:|---|---|---|---|---|---|---|---|---|');
  let i = 0;
  for (const m of METHODOLOGY_CATALOG.filter((x) => x.document_status === 'formal')) {
    i += 1;
    const mod = modules.get(`${m.methodology_id}::${m.version}`);
    L.push(
      `| ${i} | ${code(m.code_display)} | ${mdEsc(m.name)} | ${mdEsc(m.domain)} | ${mdEsc((m.project_types || []).join('、'))} ` +
      `| ${mdEsc(m.release_date)} | ${mdEsc(m.effective_date)} ` +
      `| ${mod?.rulecard?.length ? '已建' : '未建'} | ${mod?.plugin ? '已注册' : '未注册'} ` +
      `| ${m.catalog_confidence === 'verified_from_official_notice' ? '✅ 已核实' : '⚠️ 待核实'} |`
    );
  }
  L.push('');
  L.push('## 三、草案与征求意见稿（仅观察，不得列为候选、不得用于计算）');
  L.push('');
  L.push('| 编号 | 名称 | 状态 | 发布日 | 生效日 | 被修订的正式版本 | 处理规则 |');
  L.push('|---|---|---|---|---|---|---|');
  for (const m of METHODOLOGY_CATALOG.filter((x) => x.document_status !== 'formal')) {
    L.push(
      `| ${code(m.code_display)} | ${mdEsc(m.name)} | ${mdEsc(m.document_status)} | ${mdEsc(m.release_date)} | ${mdEsc(m.effective_date)} ` +
      `| ${code(m.supersedes_code)} | ${mdEsc(m.exclusion_note)} |`
    );
  }
  L.push('');
  L.push('## 四、适用条件摘要（方法学原文口径）');
  L.push('');
  L.push('| 编号 | 名称 | 规模／边界／适用对象 |');
  L.push('|---|---|---|');
  for (const m of METHODOLOGY_CATALOG) {
    L.push(`| ${code(m.code_display || m.methodology_id)} | ${mdEsc(m.name)} | ${mdEsc(m.scale_note)} |`);
  }
  L.push('');
  L.push('## 五、规则卡与计算插件实现状态');
  L.push('');
  L.push('| 方法学 | 专属规则条数 | 公式条数 | 参数项 | 已核实因子 | 占位因子 | 自检样例 | 测算状态 |');
  L.push('|---|---:|---:|---:|---:|---:|---:|---|');
  for (const mod of listMethodologyModules()) {
    const placeholders = (mod.plugin.factors || []).filter((f) => f.value_status === 'placeholder');
    const verified = (mod.plugin.factors || []).filter((f) => f.value_status === 'verified');
    L.push(
      `| ${code(mod.meta.display_name.split(' ')[0])} | ${mod.rulecard.length} | ${mod.plugin.formula_refs.length} ` +
      `| ${mod.plugin.parameters.length} | ${verified.length} | ${placeholders.length} ` +
      `| ${mod.plugin.selfCheckSamples.length} | ${placeholders.length ? '可出数（须标注占位系数）' : '可出数'} |`
    );
  }
  L.push('');
  L.push('## 六、通用门槛规则（所有方法学共用，来源：设计文档第 6 节第一层）');
  L.push('');
  L.push('| 规则 | 标题 | 逻辑表达式 | 证据策略 | 严重程度 |');
  L.push('|---|---|---|---|---|');
  for (const r of commonRules([]).filter((x) => x.layer === 'common')) {
    L.push(
      `| ${code(r.rule_id)} | ${mdEsc(r.title)} | ${code(r.expression_text)} ` +
      `| ${r.evidence_policy === 'strict' ? '**严格证据**' : '普通'} ` +
      `| ${({ blocking: '硬障碍', major: '重大', minor: '提示' })[r.severity]} |`
    );
  }
  L.push('');
  L.push('## 七、冲突与重复标记规则（只标记，不自动判不合格）');
  L.push('');
  L.push('| 规则 | 标题 | 逻辑表达式 | 说明 |');
  L.push('|---|---|---|---|');
  for (const r of commonRules([]).filter((x) => x.layer === 'conflict')) {
    L.push(`| ${code(r.rule_id)} | ${mdEsc(r.title)} | ${code(r.expression_text)} | ${mdEsc(r.fail_conclusion)} |`);
  }
  L.push('');
  L.push('## 八、官方来源依据（用于核对本清单）');
  L.push('');
  L.push('| # | 标题 | 发布机关 | 文号 | 发布日期 | 状态 | 链接 |');
  L.push('|---:|---|---|---|---|---|---|');
  OFFICIAL_SOURCES.forEach((s, idx) => {
    L.push(`| ${idx + 1} | ${mdEsc(s.title)} | ${mdEsc(s.issuing_authority)} | ${mdEsc(s.doc_number)} | ${mdEsc(s.publish_date)} | ${mdEsc(s.status)} | <${s.url}> |`);
  });
  L.push('');
  L.push('## 九、标准与引用文件编码表');
  L.push('');
  L.push('| 编码 | 名称 | 类型 | 发布机关 | 核实状态 | 说明 |');
  L.push('|---|---|---|---|---|---|');
  for (const s of STANDARD_CODES) {
    L.push(`| ${code(s.code)} | ${mdEsc(s.title)} | ${mdEsc(s.kind)} | ${mdEsc(s.issuing_authority)} | ${s.verified ? '✅ 已核实' : '⚠️ 待核实'} | ${mdEsc(s.note)} |`);
  }
  L.push('');
  L.push('---');
  L.push('');
  L.push('## 附：确认签署栏');
  L.push('');
  L.push('| 确认项 | 确认人 | 角色 | 日期 | 结论 |');
  L.push('|---|---|---|---|---|');
  L.push('| 方法学编号与名称 | | | | |');
  L.push('| 发布／生效日期 | | | | |');
  L.push('| 草案状态处理规则 | | | | |');
  L.push('| 适用条件摘要 | | | | |');
  L.push('| 通用门槛规则 | | | | |');
  L.push('');
  return L.join('\n');
}

/* ========================================================================== */
/*  06 项目事实字段表                                                         */
/* ========================================================================== */

function genFactFieldTable() {
  const L = [];
  L.push('# 项目事实字段表（待确认交付物 2／2）');
  L.push('');
  L.push(`> 生成日期：${today}　｜　自动生成自 \`src/data/fact-fields.mjs\`，请勿手工编辑。`);
  L.push('> 重新生成：`node scripts/gen-docs.mjs`');
  L.push('');
  L.push('## 本表的用途与确认要求');
  L.push('');
  L.push('本表定义项目档案中**可录入、可判断、可追溯**的全部事实字段。每个字段携带：');
  L.push('');
  L.push('- **值类型**：决定录入校验与判断语义（date / number / text / bool / enum / multi）');
  L.push('- **归属组**：决定项目档案页的分组展示');
  L.push('- **适用方法学**：`[]` 表示全部方法学通用');
  L.push('- **必需方法学**：`__COMMON__` 表示通用门槛必需，其余为对应方法学的专属必需字段');
  L.push('- **证据策略**：`strict` 表示**必须**附官方文件或项目资料证据，仅凭业主自述时规则引擎返回');
  L.push('  「待核实」而**不会**返回「通过」。这是设计文档第 6 节「日期和义务状态必须有证据」的落地机制。');
  L.push('');
  L.push('请领域专家确认：字段是否齐全、值类型是否正确、证据策略是否恰当、枚举取值是否符合方法学原文。');
  L.push('');
  L.push('## 来源类型（录入时必须选择）');
  L.push('');
  L.push('| 来源类型 | 界面标签 | 能否用于条件判定 |');
  L.push('|---|---|---|');
  L.push('| `official` | 官方文件 | ✅ 可，且可作为严格证据 |');
  L.push('| `project_doc` | 项目资料 | ✅ 可，且可作为严格证据（须附证据定位） |');
  L.push('| `analyst` | 分析师录入 | ✅ 可用于普通规则；**不能**满足严格证据要求 |');
  L.push('| `owner_claim` | 业主自述 | ✅ 仅可用于普通规则；**不能**满足严格证据要求 |');
  L.push('| `assumption` | 模型假设 | ❌ **任何条件判定都不接受**，只能进入情景计算 |');
  L.push('');

  const byGroup = new Map();
  for (const f of FACT_FIELDS) {
    const g = f.group_name || '通用';
    if (!byGroup.has(g)) byGroup.set(g, []);
    byGroup.get(g).push(f);
  }
  const order = [...FACT_GROUP_ORDER.filter((g) => byGroup.has(g)), ...[...byGroup.keys()].filter((g) => !FACT_GROUP_ORDER.includes(g))];

  let idx = 0;
  for (const g of order) {
    L.push(`## ${g}`);
    L.push('');
    L.push('| # | 字段 key | 标签 | 值类型 | 单位 | 枚举取值 | 适用方法学 | 必需于 | 证据策略 | 说明 |');
    L.push('|---:|---|---|---|---|---|---|---|---|---|');
    for (const f of byGroup.get(g)) {
      idx += 1;
      const applies = (f.applies_to || []).length ? f.applies_to.join('、') : '全部';
      const required = (f.required_for || []).length
        ? f.required_for.map((x) => (x === '__COMMON__' ? '通用门槛' : x)).join('、')
        : '—';
      L.push(
        `| ${idx} | ${code(f.key)} | ${mdEsc(f.label)} | ${f.value_type} | ${mdEsc(f.unit)} ` +
        `| ${mdEsc((f.enum_values || []).join('、'))} | ${mdEsc(applies)} | ${mdEsc(required)} ` +
        `| ${f.evidence_policy === 'strict' ? '**strict**' : 'normal'} | ${mdEsc(f.description)} |`
      );
    }
    L.push('');
  }

  L.push('## 汇总');
  L.push('');
  L.push(`- 字段总数：**${FACT_FIELDS.length}**`);
  L.push(`- 严格证据字段：**${FACT_FIELDS.filter((f) => f.evidence_policy === 'strict').length}** 个 —— ${FACT_FIELDS.filter((f) => f.evidence_policy === 'strict').map((f) => f.label).join('、')}`);
  L.push(`- 通用门槛必需字段：**${FACT_FIELDS.filter((f) => (f.required_for || []).includes('__COMMON__')).length}** 个`);
  L.push('');
  for (const mid of ['CCER-10-001', 'CCER-10-002', 'CCER-10-003', 'CCER-10-004']) {
    const req = FACT_FIELDS.filter((f) => (f.required_for || []).includes(mid));
    L.push(`- ${mid} 专属必需字段（${req.length}）：${req.map((f) => f.label).join('、') || '—'}`);
  }
  L.push('');
  L.push('## 与规则引擎的关系');
  L.push('');
  L.push('```text');
  L.push('项目事实（字段 + 值 + 来源类型 + 证据定位）');
  L.push('        │');
  L.push('        ├── strict 规则：来源必须 ∈ {official, project_doc} 且必须有证据 ID');
  L.push('        │                    否则 → 待核实（UNKNOWN）');
  L.push('        ├── assumption 来源：任何规则 → 待核实（UNKNOWN）');
  L.push('        └── 字段缺失/为空      → 待核实（UNKNOWN）');
  L.push('        │');
  L.push('        ▼');
  L.push('  三态判断：通过 / 不通过 / 待核实');
  L.push('        │');
  L.push('        ▼');
  L.push('  四态结论：可继续尽调 / 存在明确障碍 / 资料不足暂无法判断 / 无已发布适用方法学');
  L.push('```');
  L.push('');
  L.push('引擎实现见 `src/rules/engine.mjs`；字段录入校验见 `src/services/project-svc.mjs` 的 `upsertFact`。');
  L.push('');
  L.push('---');
  L.push('');
  L.push('## 附：确认签署栏');
  L.push('');
  L.push('| 确认项 | 确认人 | 角色 | 日期 | 结论 |');
  L.push('|---|---|---|---|---|');
  L.push('| 字段齐全性（是否缺失方法学必需字段） | | | | |');
  L.push('| 值类型与单位 | | | | |');
  L.push('| 证据策略设置（哪些必须为严格证据） | | | | |');
  L.push('| 枚举取值与原文一致性 | | | | |');
  L.push('');
  return L.join('\n');
}

/* ========================================================================== */

const outputs = [
  ['05-方法学清单.md', genMethodologyList()],
  ['06-项目事实字段表.md', genFactFieldTable()],
];

for (const [name, body] of outputs) {
  writeFileSync(join(DOCS, name), body, 'utf8');
  console.log(`已生成 docs/${name}（${body.length} 字符）`);
}
console.log('');
console.log(`方法学条目：${METHODOLOGY_CATALOG.length} 条版本记录 / ${new Set(METHODOLOGY_CATALOG.map((m) => m.methodology_id)).size} 个方法学`);
console.log(`事实字段：${FACT_FIELDS.length} 个（严格证据 ${FACT_FIELDS.filter((f) => f.evidence_policy === 'strict').length} 个）`);
console.log(`计算插件：${listMethodologyModules().length} 个；自检样例 ${collectSelfCheckSamples().length} 个`);
