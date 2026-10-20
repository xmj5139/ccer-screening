-- ---------------------------------------------------------------------------
-- 省域地图 · 省级排放资料（docs/59）
-- ---------------------------------------------------------------------------
-- 只保存有明确省份、范围、年度、单位与原文证据的排放记录。
-- 同一省/范围/年度可以有多个 dataset_key（不同核算边界或来源），
-- API 按 dataset 选择，绝不静默相加或覆盖。
--
-- 修订留痕：新值不 UPDATE 旧行，而是把旧行 status 置为 superseded，
-- 新行用 revision_of 指向旧行；同一 dataset 同时只允许一条 active 记录。
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS region_emission (
  id                  TEXT PRIMARY KEY,
  province_code       TEXT NOT NULL,              -- 六位省级代码，与本地底图 adcode 一致
  province_name       TEXT NOT NULL,              -- 规范全称（如 内蒙古自治区）
  scope               TEXT NOT NULL CHECK(scope IN ('region_co2','national_ets')),
  year                INTEGER NOT NULL,
  value_tco2          REAL NOT NULL CHECK(value_tco2 >= 0),
  unit                TEXT NOT NULL CHECK(unit = 'tCO2'), -- 只接收基准单位；万吨/亿吨仅展示换算
  methodology         TEXT NOT NULL,              -- 核算方法/清单名称
  boundary            TEXT NOT NULL,              -- 核算边界（部门/气体/地域/是否全国 CEA）
  dataset_key         TEXT NOT NULL,              -- 来源/口径数据集键
  source_name         TEXT NOT NULL,
  source_url          TEXT NOT NULL,
  source_kind         TEXT NOT NULL CHECK(source_kind IN ('official','research')),
  published_at        TEXT,
  excerpt             TEXT NOT NULL,              -- 原文证据片段，不做模型推断
  snapshot_hash       TEXT,                       -- 来源快照哈希（有则记录）
  content_hash        TEXT NOT NULL,              -- 归一化内容哈希，用于幂等导入
  verification_status TEXT NOT NULL DEFAULT 'source_recorded',
  status              TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','superseded')),
  revision_of         TEXT REFERENCES region_emission(id),
  revision_reason     TEXT,
  superseded_by       TEXT,
  superseded_at       TEXT,
  entered_by          TEXT,
  collected_at        TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

-- 同一省/范围/年度/数据集只能有一条当前有效记录；历史修订行保留。
CREATE UNIQUE INDEX IF NOT EXISTS idx_region_emission_active
  ON region_emission(province_code, scope, year, dataset_key)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_region_emission_scope_year
  ON region_emission(scope, year, dataset_key, status);

CREATE INDEX IF NOT EXISTS idx_region_emission_province
  ON region_emission(province_code, scope, year, status);

CREATE INDEX IF NOT EXISTS idx_region_emission_dataset
  ON region_emission(dataset_key, status, collected_at);
