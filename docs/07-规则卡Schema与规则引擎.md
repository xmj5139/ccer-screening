# 规则卡 Schema 与规则引擎

> 设计文档第 5 节要求：**规则卡不是对 PDF 的普通摘要，而是可复核的结构化配置。**
> 本文档给出规则卡的完整结构定义、规则引擎的执行语义，以及「结构化规则卡 → 三态判断 → 四态结论」的完整链路。

---

## 一、规则卡结构

规则卡由设计文档第 5 节列出的最少字段构成。下表给出每个字段的落库位置与当前实现状态：

| 设计文档字段 | 落库位置 | 本原型状态 |
|---|---|---|
| `methodology_id` | `methodology_version.methodology_id` | ✅ |
| `name` | `methodology_version.name` | ✅ |
| `version` | `methodology_version.version` | ✅ |
| `document_status` | `methodology_version.document_status` | ✅ 四态：formal / draft / revised_draft / repealed |
| `effective_date` | `methodology_version.effective_date` | ✅ 草案为空 |
| `official_url` | `methodology_version.official_url` | ✅ 全部指向官方发布通知 |
| `original_file_hash` | `methodology_version.original_file_hash` | ⚠️ 列已就绪，PDF 未归档故为空 |
| `approved_by` / `approved_at` | `methodology_version.approved_by` / `approved_at` | ✅ 目录层批准 |
| `scope` | `methodology_version.project_types` / `tech_routes` / `scale_note` / `crediting_note` | ✅ |
| `exclusions` | 规则卡的 `blocking` 规则 + `methodology_version.exclusion_note` | ✅ |
| `eligibility_rules[]` | `rule` 表（见下节） | ✅ |
| `additionality` | 规则 `M10-*-0x`「额外性采用免予论证」+ 通用规则 `C-08` | ✅ |
| `baseline` | 规则「基准线情景已按方法学确定」+ 插件 `formula_refs` 的基准线公式 | ✅ |
| `parameters[]` | 插件 `parameters` 声明 + `project_fact` 字段字典 | ✅ |
| `formulas[]` | `formula` 表（由插件 `formula_refs` 写入） | ✅ 条款页码待回填 |
| `monitoring` | 规则「监测数据联网」「计量仪表检定/校准」+ 字段 `mon.*` | ✅ |
| `crediting` | 字段 `time.crediting_*` + 规则 `C-09` | ✅ |
| `change_log` | `methodology_version.change_log` | ⚠️ 列已就绪，内容待专家填写 |

### 1.1 `rule` 表字段定义

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | TEXT PK | 规则记录 ID |
| `methodology_version_id` | TEXT FK → `methodology_version.id` | **NULL 表示通用门槛规则**（所有方法学共用） |
| `layer` | TEXT | `common` 通用门槛 / `specific` 方法学专属 / `conflict` 冲突与重复 |
| `rule_id` | TEXT | 规则编号：`C-xx` 通用、`X-xx` 冲突、`M10-0xx-xx` 方法学专属 |
| `title` | TEXT | 规则标题（界面主标题） |
| `condition_text` | TEXT | **条件文本**：方法学原文或管理办法的条款表述 |
| `expression_text` | TEXT | **逻辑表达式（人读）**：界面展示与报告引用 |
| `expr` | TEXT(JSON) | **逻辑表达式（机器可执行）**：JSON 表达式树 |
| `required_fields` | TEXT(JSON) | 必需事实字段数组；任一不可用即强制「待核实」 |
| `evidence_policy` | TEXT | `strict` / `normal` |
| `evidence_requirement` | TEXT | 期望的证据形式（界面提示用） |
| `clause_ref` | TEXT | 条款与页码 |
| `severity` | TEXT | `blocking` 硬障碍 / `major` 重大 / `minor` 提示 |
| `fail_conclusion` | TEXT | 不通过时的业务含义 |
| `unknown_action` | TEXT | 待核实时的处置提示 |
| `sort_order` | INTEGER | 执行与展示顺序 |

**为什么同时保留 `expression_text` 与 `expr`？**
`expression_text` 给人看、给报告引用；`expr` 给引擎执行。二者由同一份规则卡声明保证语义一致，
但**执行只依赖 `expr`**，因此不存在「自然语言被曲解」的风险。

---

## 二、表达式树算子全集

规则引擎执行 JSON 表达式树，**不使用 `eval`**。算子按求值语义分三类。

### 2.1 逻辑组合

| op | 参数 | 语义 |
|---|---|---|
| `const` | `value: boolean` | 常量 |
| `and` | `args: [...]` | 任一 FAIL → FAIL；否则任一 UNKNOWN → UNKNOWN；否则 PASS |
| `or` | `args: [...]` | 任一 PASS → PASS；否则任一 UNKNOWN → UNKNOWN；否则 FAIL |
| `not` | `arg: {...}` | 取反；UNKNOWN 保持不变（待核实不会被取反成确定结论） |

### 2.2 存在性与取值

| op | 参数 | 语义 |
|---|---|---|
| `exists` | `field` | 字段存在、非空且证据策略满足 |
| `missing` | `field` | 与 `exists` 相反 |
| `eq` / `ne` | `field`, `value` | 字符串化后比较 |
| `in` / `not_in` | `field`, `values[]` | 集合归属 |
| `contains_any` | `field`, `values[]` | 文本或多值字段包含任一（子串匹配） |
| `any_of` / `all_of` | `field`, `values[]` | 多值字段的命中断言 |

### 2.3 数值与日期

| op | 参数 | 语义 |
|---|---|---|
| `gt` / `gte` / `lt` / `lte` | `field`, `value` | 数值比较；任一侧不可解析为数值 → UNKNOWN |
| `date_after` | `field`, `value` | 严格晚于（`>`） |
| `date_on_or_after` | `field`, `value` | 不早于（`>=`，含当日） |
| `date_before` / `date_on_or_before` | `field`, `value` | 早于 / 不晚于 |
| `is_true` / `is_false` | `field` | 布尔断言；无法解析为布尔 → UNKNOWN |
| `within_years` | `field`, `years`, `ref_field?`, `mode?` | 相对分析基准日（或 `ref_field`）的年限窗 |

### 2.4 求值失败的保护

未知算子、非法表达式节点、求值过程抛异常，一律返回 **UNKNOWN**（待核实）而**不是** FAIL 或崩溃。
设计理由：系统的失败模式必须是「不敢下结论」，而不是「错误地下结论」。

---

## 三、三态判断与事实访问

### 3.1 三态语义

| 状态 | 常量 | 含义 |
|---|---|---|
| 通过 | `pass` | 条件已满足，且有合格证据支持 |
| 不通过 | `fail` | 条件明确不满足 |
| 待核实 | `unknown` | 字段缺失、证据不合规、或来源不可用于判定 |

### 3.2 `FactStore.usable(field, evidencePolicy)`

这是「证据不足时输出待核实」的唯一实现点。判定顺序：

```text
1. 事实不存在                                    → { usable: false, reason: '字段缺失' }
2. 值为空 / 非有限数                             → { usable: false, reason: '字段为空' }
3. source_kind === 'assumption'                  → { usable: false,
     reason: '来源为「模型假设」，只能用于情景估算，不能用于条件判定' }
4. evidencePolicy === 'strict' 时：
   4a. source_kind ∉ { official, project_doc }   → { usable: false,
        reason: '该规则要求官方文件或项目资料证据，当前来源为「业主自述」' }
   4b. evidence_id 为空                          → { usable: false,
        reason: '该规则要求附带证据定位（文件+页码），当前事实无证据' }
   4c. 所引用的证据记录不存在                     → { usable: false,
        reason: '所引用的证据记录不存在（可能已删除）' }
5. 否则                                          → { usable: true, kind, evidenceId }
```

### 3.3 `required_fields` 的强制语义

规则声明的 `required_fields` 中只要有一个字段 `usable === false`，
即便表达式树本身能得出 PASS，最终结果也**强制降级为 UNKNOWN**。

设计理由：防止「用部分信息凑出一个通过」。例如「具备计算所需的年度活动数据」这条规则，
表达式是 `and(exists(A), exists(B))`，同时把 A、B 都列入 `required_fields`——
即使因为某种表达式写法漏判了一个，`required_fields` 仍会兜住。

### 3.4 规则结果结构

每条规则的执行结果包含以下字段，全部进入报告，实现「每项判断可追到原文条款和项目证据」：

| 字段 | 说明 |
|---|---|
| `rule_id` / `title` / `layer` / `severity` | 规则标识 |
| `state` | pass / fail / unknown |
| `detail` | 判断详情（人读，如「实际 35000，要求 < 30000」） |
| `condition_text` / `expression_text` | 条件文本与逻辑表达式 |
| `clause_ref` | 条款与页码 |
| `evidence_policy` / `evidence_requirement` | 证据策略与期望证据形式 |
| `fail_conclusion` | 不通过的业务含义 |
| `missing_fields[]` | 不可用字段清单 |
| `unknown_reasons[]` | 每个待核实原因（字段 + 原因 + 来源类型） |
| `fact_field` / `fact_value` / `fact_source_kind` | 主判断字段的事实值与来源 |
| `evidence` | 证据定位：文件名 + 页码 + 原文片段 |
| `judged_at` | 判断时间 |
| `rule_version` | 规则版本（方法学版本 ID，通用规则为 `common`） |

---

## 四、严重程度与结论派生

### 4.1 严重程度

| severity | 含义 | 对结论的影响 |
|---|---|---|
| `blocking` | 硬障碍（违反适用条件或通用门槛） | 不通过 → 结论直接为「存在明确障碍」 |
| `major` | 重大项（影响可申报性或计算可行性） | 不通过 → 报告列为重大不符合；待核实 → 阻断「可继续尽调」 |
| `minor` | 提示项（冲突与重复标记） | 不通过不阻断结论，仅提示人工核对 |

### 4.2 四态结论派生规则

```js
conclude(summary, { hasFormalCandidate }) {
  if (!hasFormalCandidate)               return '无已发布适用方法学';
  if (summary.blocking_failures > 0)     return '存在明确障碍';
  if (summary.unknown_blocking > 0)      return '资料不足暂无法判断';  // blocking 或 major 项待核实
  return '可继续尽调';
}
```

结论只输出这四个枚举值，系统任何位置都不输出「符合申报」之类的笼统结论。
该约束由 `test/02-acceptance.test.mjs` 断言保护。

---

## 五、规则清单

### 5.1 通用门槛（`layer = 'common'`，9 条）

依据《温室气体自愿减排交易管理办法（试行）》，对所有方法学生效。

| 规则 | 标题 | 逻辑表达式 | 证据策略 | 严重程度 |
|---|---|---|---|---|
| C-01 | 项目真实性与业主承诺 | `comp.owner_commitment == true` | normal | major |
| C-02 | 项目唯一性 | `comp.uniqueness_declared == true` | **strict** | blocking |
| C-03 | 属于生态环境部正式发布的方法学支持领域 | `proj.project_type ∈ {现行正式目录的项目类型}` | normal | blocking |
| C-04 | 开工日期不早于 2012-11-08 | `time.start_construction_date >= 2012-11-08` | **strict** | blocking |
| C-05 | 不承担法定温室气体减排义务 | `comp.legal_ghg_obligation == false` | **strict** | blocking |
| C-06 | 未纳入全国或地方碳排放权交易市场配额管理 | `comp.in_ets_quota == false` | **strict** | blocking |
| C-07 | 减排量产生时间不早于 2020-09-22 | `time.reduction_generation_start >= 2020-09-22` | **strict** | blocking |
| C-08 | 额外性论证路径已明确 | `comp.additionality_route ∈ {免予论证, 简化论证, 需完整论证}` | normal | major |
| C-09 | 计入期长度已确定 | `time.crediting_period_years 存在` | normal | major |

> **C-03 的动态取值**：`commonRules()` 在种子写入时读取「正式发布 + 编号已核实」的方法学项目类型集合，
> `test/04` 断言其与 `formalProjectTypes()` 完全一致。因此目录更新后重跑 `npm run seed` 即会同步。
> 注意：编号待核实的条目**不参与** C-03 的支持领域集合，避免用未核实的方法学支撑申报资格。

### 5.2 冲突与重复（`layer = 'conflict'`，4 条）

| 规则 | 标题 | 严重程度 | 处理原则 |
|---|---|---|---|
| X-01 | 是否已在其他自愿减排机制申报或声明 | minor | 标记，交人工核对法律与方法学影响 |
| X-02 | 是否存在绿证 / 绿电环境权益声明 | minor | 标记，核对重复计算风险 |
| X-03 | 是否存在补贴或合同已处分环境权益 | minor | 标记，核对权属影响 |
| X-04 | 减排量权属清晰 | major | 权属不清晰时投资标的可处分性存疑 |

**X-01~X-03 一律为 `minor` 且 `severity !== 'blocking'`**（由测试断言），
落实设计文档「不能仅凭发现同名机制就自动判不合格」的要求。

### 5.3 方法学专属条件（`layer = 'specific'`，33 条）

| 方法学 | 条数 | 规则编号区间 | 硬障碍条数 |
|---|---:|---|---:|
| CCER-10-001 煤矿低浓度瓦斯和风排瓦斯利用 | 9 | M10-001-01 ~ -09 | 3 |
| CCER-10-002 海上油田伴生气回收利用 | 8 | M10-002-01 ~ -08 | 3 |
| CCER-10-003 陆上气田试气放喷气回收利用 | 8 | M10-003-01 ~ -08 | 3 |
| CCER-10-004 陆上油田低气量伴生气回收利用 | 8 | M10-004-01 ~ -08 | 4 |

四个方法学的专属条件完整清单见各自源码文件顶部的规则卡数组，
以及 `docs/05-方法学清单.md` 的第五节统计。

**各方法学的硬障碍条件（blocking）**：

| 方法学 | 硬障碍条件 |
|---|---|
| CCER-10-001 | 甲烷浓度 < 8%；瓦斯来源类别属于方法学范围；利用方式属于认可路径；监测数据与全国碳市场管理平台联网 |
| CCER-10-002 | 气源为海上油田伴生气；产品去向属于认可路径；监测联网 |
| CCER-10-003 | 气源为陆上气田试气放喷气；井型属于适用井型；产品去向属于认可路径 |
| CCER-10-004 | 气源为陆上油田伴生气；**站场设计总规模 < 3 万 m³/天（严格证据）**；产品去向属于认可路径；监测联网 |

---

## 六、规则卡编写规范

新增方法学时，规则卡必须满足以下要求（`test/03` 与 `test/04` 会自动校验）：

1. **编号规范**：`M<两位方法学域>-<三位序号>-<两位规则序号>`，例如 `M10-004-02`。
2. **`clause_ref` 必填**：允许在领域专家回填前写 `【占位】` 说明，但不得为空。
3. **`condition_text` 必须可追溯到原文**：不得使用「符合相关要求」之类的模糊表述。
4. **`expression_text` 与 `expr` 语义一致**。
5. **严重程度判定**：
   - 违反方法学适用条件或管理办法通用要求 → `blocking`
   - 影响可申报性或计算可行性 → `major`
   - 仅需人工核对 → `minor`
6. **证据策略判定**：
   - 日期、义务状态、浓度、规模等**一旦判错就会导致错误结论**的字段 → `strict`
   - 其余 → `normal`
7. **`fail_conclusion` 必填**：写清不通过的业务后果，供投资筛选环节直接引用。
8. **来源纪律**：规则的依据只能是方法学原文或管理办法原文。**不得**依据网页搜索摘要编写规则。

### 6.1 新增一条规则的完整示例

```js
{
  layer: 'specific',
  rule_id: 'M10-004-09',
  title: '低气量站场的计量精度满足方法学要求',
  condition_text: '<逐字引自方法学原文的条款表述>',
  expression_text: 'mon.metering_accuracy_ok == true',
  expr: { op: 'is_true', field: 'mon.metering_accuracy_ok' },
  required_fields: ['mon.metering_accuracy_ok'],
  evidence_policy: 'strict',
  evidence_requirement: '计量器具检定证书 / 精度等级说明',
  clause_ref: '<方法学 PDF 条款号与页码>',
  severity: 'major',
  fail_conclusion: '计量精度不满足要求，低气量工况下数据可靠性不足。',
  sort_order: 190,
}
```

同时需要在 `src/data/fact-fields.mjs` 中登记 `mon.metering_accuracy_ok` 字段，
否则规则会因字段未登记而在录入界面不可见。

---

## 七、规则引擎的测试覆盖

`test/01-rule-engine.test.mjs`（11 项）与 `test/04-catalog-and-governance.test.mjs`（部分项）覆盖：

| 覆盖点 | 测试名 |
|---|---|
| 缺失字段 → 待核实 | 缺失字段 → 待核实（不得判为通过） |
| 严格证据：业主自述不判通过 | 严格证据策略：业主自述不判通过，返回待核实 |
| 严格证据：项目资料 + 页码 → 通过 | 严格证据策略：项目资料 + 证据定位 → 通过 |
| 严格证据：项目资料但无证据 → 待核实 | 严格证据策略：项目资料但无证据定位 → 待核实 |
| 模型假设永不参与判定 | 模型假设永远不能用于条件判定 |
| 日期比较 | 日期比较：早于门槛 → 不通过 |
| and 组合三态传播 | and 组合：任一不通过 → 不通过；任一待核实 → 待核实 |
| required_fields 强制降级 | required_fields 不可用时强制待核实 |
| 集合与数值算子 | in / not_in / 数值比较 / contains_any |
| 未知算子保护 | 非法操作符 → 待核实而非崩溃 |
| 四态派生 | 四态结论派生：硬障碍优先，其次关键项待核实 |
| 通用规则完备性 | 通用门槛规则覆盖设计文档第 6 节第一层与第三层要求 |
| 冲突规则不得为 blocking | 同上 |
| C-03 动态取值一致性 | 同上 |
