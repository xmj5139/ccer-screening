#!/usr/bin/env node
/**
 * 只读排查：官方公告清单中的日期若在 trade_daily 缺失，探测其公告页与官方分行业 JSON 是否可取。
 * 用于确认「交易日缺行情」是采集失败还是官方确实未发布。
 */
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

const H = {
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
};
const db = new DatabaseSync(process.env.CCER_DB_PATH || path.resolve('data/ccer_v2.db'), { readOnly: true });
const imported = new Set(db.prepare('SELECT DISTINCT trade_date FROM trade_daily').all().map((r) => r.trade_date));
const list = JSON.parse(await (await fetch('https://www.ccer.com.cn/wcm/ccer/data/2502lshq.json', { headers: H })).text());
const missing = [];
for (const r of list.rows || []) {
  const m = String(r.title || '').match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
  if (!m) continue;
  const d = `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
  if (!imported.has(d)) missing.push({ date: d, title: r.title, url: `https://www.ccer.com.cn/wcm/ccer/html/${String(r.url).replace(/^\/+/, '')}`, published: r.publishedTime });
}
console.log(`官方公告清单共 ${(list.rows || []).length} 条；trade_daily 缺 ${missing.length} 个日期\n`);
for (const it of missing) {
  const ymd8 = it.date.replace(/-/g, '');
  const dimUrl = `https://www.ccer.com.cn/wcm/ccer/data/${ymd8}-first.json`;
  let page = 'ERR';
  let dim = 'ERR';
  try {
    const r = await fetch(it.url, { headers: H });
    const t = await r.text();
    page = `${r.status} ${t.length}B${r.status === 200 ? (/成交/.test(t) ? ' 含成交描述' : ' 无成交描述') : ''}`;
  } catch (e) { page = `ERR ${e.message}`; }
  try {
    const r = await fetch(dimUrl, { headers: H });
    const body = await r.text();
    dim = `${r.status} ${body.length}B ${body.slice(0, 150)}`;
  } catch (e) { dim = `ERR ${e.message}`; }
  console.log(`- ${it.date} | 公告 ${it.url}`);
  console.log(`    公告页: ${page}`);
  console.log(`    分行业: ${dim}`);
}
db.close();
