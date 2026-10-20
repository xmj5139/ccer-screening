/**
 * 公开项目去重口径（总览与省域地图共用）
 * ============================================================================
 * 规则（docs/59、docs/61）：
 *   - 同一官方登记编号只算一个逻辑项目；缺失登记号时按项目 ID；
 *   - 同一逻辑项目的历史多行阶段标记取并集，不按阶段相加；
 *   - 各阶段计数基于去重后的逻辑项目计算，避免同名/同号多行重复计数。
 *
 * 本模块不访问数据库、不访问网络，只做纯函数聚合。
 */

export const STAGE_COLUMNS = {
  project_public: 'stage_project_public',
  validated: 'stage_validated',
  project_registered: 'stage_project_registered',
  reduction_public: 'stage_reduction_public',
  verified: 'stage_verified',
  reduction_registered: 'stage_reduction_registered',
};

export const STAGE_LABELS = {
  project_public: '项目公示',
  validated: '审定',
  project_registered: '项目登记',
  reduction_public: '减排量公示',
  verified: '核查',
  reduction_registered: '减排量登记',
};

export const STAGE_KEYS = Object.keys(STAGE_COLUMNS);

/** 官方登记编号优先；没有编号时按项目 ID，绝不用名称代替。 */
export function projectLogicalKey(row = {}) {
  const no = String(row.registry_project_no ?? '').trim();
  return no ? `no:${no}` : `id:${String(row.id ?? '')}`;
}

/**
 * 聚合项目行。
 * @param {Array<object>} rows 已按业务筛选条件取出的 public_project 行
 * @returns {{projects:Array<object>,total:number,stage_counts:Record<string,number>}}
 */
export function aggregateProjectRows(rows = []) {
  const byKey = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row) continue;
    const key = projectLogicalKey(row);
    const existing = byKey.get(key);
    if (!existing) {
      const item = { ...row };
      for (const col of Object.values(STAGE_COLUMNS)) item[col] = Number(row[col]) === 1 ? 1 : 0;
      byKey.set(key, item);
      continue;
    }
    // 阶段标记取并集；其余展示字段保留更新时间较新的那一行。
    for (const col of Object.values(STAGE_COLUMNS)) {
      existing[col] = existing[col] === 1 || Number(row[col]) === 1 ? 1 : 0;
    }
    if (String(row.updated_at || '') > String(existing.updated_at || '')) {
      const stage = Object.fromEntries(Object.values(STAGE_COLUMNS).map((col) => [col, existing[col]]));
      Object.assign(existing, row, stage);
    }
  }
  const projects = [...byKey.values()];
  const stage_counts = {};
  for (const key of STAGE_KEYS) {
    const col = STAGE_COLUMNS[key];
    stage_counts[key] = projects.filter((p) => Number(p[col]) === 1).length;
  }
  return { projects, total: projects.length, stage_counts };
}
