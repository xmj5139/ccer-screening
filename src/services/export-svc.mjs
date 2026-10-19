/**
 * 导出工具：CSV / XLSX / JSON 生成（零第三方依赖）
 * ============================================================================
 * 需求规格 1.3 / 1.4 / 3：
 *   - 列表可导出结构化 Excel/CSV，包含数据截点、来源 URL、状态与字段口径
 *   - 图表数据、筛选后的明细和月/年汇总均可下载 XLSX/CSV
 *   - 文件包含字段定义、单位、来源、抓取/核对时间、是否修订
 *
 * XLSX 生成方式：直接构造符合 ECMA-376 的最小 OOXML 包（ZIP，store 无压缩），
 * 因此不需要任何 npm 依赖。数值单元格写成 number 类型，Excel 中可直接参与计算。
 */
import { createHash } from 'node:crypto';
import { exportLogAudit } from './audit-svc.mjs';

/* ------------------------------ CSV ------------------------------ */

function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  // 防止 CSV 公式注入（=、+、-、@ 开头会被 Excel 当公式执行）
  const guarded = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

/**
 * 生成 CSV。
 * @param {Array<{key:string,label:string,unit?:string,definition?:string}>} columns
 * @param {Array<object>} rows
 * @param {{meta?:object, includeHeaderNotes?:boolean}} [opts]
 */
export function toCsv(columns, rows, opts = {}) {
  const lines = [];
  // 文件头的元信息：数据截点、来源、口径、生成时间、是否修订
  for (const [k, v] of Object.entries(opts.meta || {})) {
    lines.push(`# ${k}: ${String(v ?? '').replace(/\r?\n/g, ' ')}`);
  }
  lines.push(columns.map((c) => csvCell(c.unit ? `${c.label}(${c.unit})` : c.label)).join(','));
  for (const r of rows) lines.push(columns.map((c) => csvCell(r[c.key])).join(','));
  // 字段定义附在文件末尾，便于离线复算时对照口径
  if (opts.includeHeaderNotes !== false) {
    const notes = columns.filter((c) => c.definition);
    if (notes.length) {
      lines.push('');
      lines.push('# 字段定义');
      for (const c of notes) lines.push(`# ${c.label}: ${String(c.definition).replace(/\r?\n/g, ' ')}`);
    }
  }
  // BOM 让 Excel 正确识别 UTF-8
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

/* ------------------------------ XLSX ------------------------------ */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** 极简 ZIP（store 模式，不压缩）：OOXML 允许不压缩条目。 */
function zipStore(files) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf8');
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);       // version needed
    local.writeUInt16LE(0x0800, 6);   // flag: UTF-8 名称
    local.writeUInt16LE(0, 8);        // store
    local.writeUInt16LE(0, 10);       // time
    local.writeUInt16LE(0x21, 12);    // date (1980-01-01)
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, data);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0x21, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...chunks, centralBuf, end]);
}

function xmlEsc(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
    // 去掉 XML 1.0 不允许的控制字符
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
}

function colName(n) {
  let s = '';
  let x = n;
  while (x > 0) {
    const r = (x - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    x = Math.floor((x - 1) / 26);
  }
  return s;
}

function sheetXml(columns, rows, title, meta) {
  const out = [];
  out.push('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>');
  out.push('<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">');
  out.push('<sheetData>');
  let r = 0;

  const pushRow = (cells) => {
    r += 1;
    out.push(`<row r="${r}">`);
    cells.forEach((c, i) => {
      const ref = `${colName(i + 1)}${r}`;
      if (c === null || c === undefined || c === '') return;
      if (typeof c === 'number' && Number.isFinite(c)) out.push(`<c r="${ref}"><v>${c}</v></c>`);
      else out.push(`<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEsc(c)}</t></is></c>`);
    });
    out.push('</row>');
  };

  // 表头元信息（数据截点 / 来源 / 口径）——满足「文件包含字段定义、来源、抓取时间」
  for (const [k, v] of Object.entries(meta || {})) pushRow([`${k}`, v]);
  if (Object.keys(meta || {}).length) pushRow([]);
  if (title) pushRow([title]);
  pushRow(columns.map((c) => (c.unit ? `${c.label}(${c.unit})` : c.label)));
  for (const row of rows) pushRow(columns.map((c) => row[c.key]));
  const defs = columns.filter((c) => c.definition);
  if (defs.length) {
    pushRow([]);
    pushRow(['字段定义']);
    for (const c of defs) pushRow([c.label, c.definition]);
  }
  out.push('</sheetData></worksheet>');
  return out.join('');
}

/**
 * 生成 XLSX（单工作表）。
 * @param {string} sheetName 工作表名（≤31 字符，自动清理非法字符）
 * @param {Array<{key,label,unit?,definition?}>} columns
 * @param {Array<object>} rows
 * @param {object} meta 表头元信息
 */
export function toXlsx(sheetName, columns, rows, meta = {}) {
  const safeName = String(sheetName || 'Sheet1').replace(/[\\/*?:[\]]/g, '_').slice(0, 31) || 'Sheet1';
  const files = [
    {
      name: '[Content_Types].xml',
      data:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
        '</Types>',
    },
    {
      name: '_rels/.rels',
      data:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
        '</Relationships>',
    },
    {
      name: 'xl/workbook.xml',
      data:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
        `<sheets><sheet name="${xmlEsc(safeName)}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
        '</Relationships>',
    },
    { name: 'xl/worksheets/sheet1.xml', data: sheetXml(columns, rows, null, meta) },
  ];
  return zipStore(files);
}

/* ------------------------------ 统一出口 ------------------------------ */

export const EXPORT_MIME = {
  csv: 'text/csv; charset=utf-8',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  json: 'application/json; charset=utf-8',
};

/**
 * 生成导出文件（并写导出审计）。
 * @param {object} p
 * @param {object} p.user 当前用户
 * @param {string} p.dataset 数据集标识
 * @param {string} p.fileBase 文件名（不含扩展名）
 * @param {'csv'|'xlsx'|'json'} p.format
 * @param {Array} p.columns 列定义
 * @param {Array} p.rows 数据行
 * @param {object} [p.meta] 表头元信息
 * @param {object} [p.filters] 筛选条件（写入导出审计）
 * @param {string} [p.ip]
 */
export function buildExport({ user, dataset, fileBase, format = 'csv', columns, rows, meta = {}, filters = null, ip = null }) {
  const fmt = ['csv', 'xlsx', 'json'].includes(format) ? format : 'csv';
  const dataAsOf = meta['数据截至'] || null;
  const fullMeta = {
    数据集: dataset,
    数据截至: dataAsOf || '（见各行字段）',
    生成时间: new Date().toISOString(),
    生成人: user?.name || '未知',
    ...meta,
  };
  let body;
  if (fmt === 'xlsx') body = toXlsx(dataset, columns, rows, fullMeta);
  else if (fmt === 'json') {
    body = Buffer.from(
      JSON.stringify({ dataset, meta: fullMeta, columns, rows }, null, 2),
      'utf8'
    );
  } else body = Buffer.from(toCsv(columns, rows, { meta: fullMeta }), 'utf8');

  const stamp = new Date().toISOString().slice(0, 10);
  const file_name = `${fileBase}_${stamp}.${fmt}`;
  const sha = createHash('sha256').update(body).digest('hex');
  try {
    exportLogAudit({
      user, dataset, format: fmt, rowCount: rows.length, filters, ip,
      objectType: 'dataset', objectId: dataset, note: `sha256=${sha.slice(0, 16)}`,
    });
  } catch {
    /* 审计失败不阻断下载 */
  }
  return { body, mime: EXPORT_MIME[fmt], file_name, sha256: sha, row_count: rows.length };
}

export { crc32, zipStore };
