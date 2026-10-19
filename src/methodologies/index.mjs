/**
 * 方法学插件注册表
 * ============================================================================
 * 每个已实现的方法学导出一个模块：{ meta, rulecard, plugin }
 *   - rulecard：结构化规则卡（设计文档第 5 节）
 *   - plugin  ：按方法学编号与版本注册的计算插件（设计文档第 7 节）
 *
 * 多版本支持：同一方法学不同版本可并存注册，计算运行必须显式绑定版本。
 */
import m10001 from './ccer-10-001.mjs';
import m10002 from './ccer-10-002.mjs';
import m10003 from './ccer-10-003.mjs';
import m10004 from './ccer-10-004.mjs';

const MODULES = [m10001, m10002, m10003, m10004];

/** key = `${methodology_id}::${version}` → { meta, rulecard, plugin } */
const registry = new Map();
for (const mod of MODULES) {
  const key = `${mod.meta.methodology_id}::${mod.meta.version}`;
  registry.set(key, mod);
}

export function listMethodologyModules() {
  return [...registry.values()];
}

export function getMethodologyModule(methodologyId, version) {
  return registry.get(`${methodologyId}::${version}`) || null;
}

export function hasRulecard(methodologyId, version) {
  return !!registry.get(`${methodologyId}::${version}`)?.rulecard?.length;
}

export function hasPlugin(methodologyId, version) {
  return !!registry.get(`${methodologyId}::${version}`)?.plugin;
}

/** 插件内声明的所有因子（含全局因子），用于写入 factor_version 表 */
export function collectFactors() {
  const out = [];
  for (const mod of registry.values()) {
    const seen = new Set();
    for (const f of mod.plugin?.factors || []) {
      const key = `${f.factor_key}::${f.methodology_version_id || ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(f);
    }
  }
  // 去重：全局因子（methodology_version_id 为空）只写一次
  const dedup = new Map();
  for (const f of out) dedup.set(`${f.factor_key}::${f.methodology_version_id || ''}`, f);
  return [...dedup.values()];
}

/** 收集所有公式声明 */
export function collectFormulas() {
  const out = [];
  for (const mod of registry.values()) {
    for (const fr of mod.plugin?.formula_refs || []) {
      out.push({ methodology_id: mod.meta.methodology_id, version: mod.meta.version, ...fr });
    }
  }
  return out;
}

/** 插件自检样例（供测试与领域专家独立复算） */
export function collectSelfCheckSamples() {
  const out = [];
  for (const mod of registry.values()) {
    for (const s of mod.plugin?.selfCheckSamples || []) {
      out.push({ methodology_id: mod.meta.methodology_id, version: mod.meta.version, ...s });
    }
  }
  return out;
}
