/** 仅从 CCER 官方全年休市公告确认假期，不以缺行情推断休市。 */
import { fetchText, recordSnapshot } from './collect-svc.mjs';
import { get } from '../core/db.mjs';
import { markCalendar } from './trade-svc.mjs';

const SOURCES = [
  [2025, 'https://www.ccer.com.cn/wcm/ccer/html/2311ptggc1/20241230/151429585.shtml'],
  [2026, 'https://www.ccer.com.cn/wcm/ccer/html/2307ptggc1/20251230/113437624.shtml'],
];

export function parseOfficialClosures(html, year) {
  const text = String(html).replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, '\n').replace(/&nbsp;|&#160;/g, ' ');
  if (!text.includes(`${year}年全年休市安排`)) return [];
  const days = new Set();
  const pattern = /[一二三四五六七八九十]+、[^：\n]{1,20}：\s*(?:\d{4}年)?(\d{1,2})月(\d{1,2})日[^。；]{0,120}?休市/g;
  for (const match of text.matchAll(pattern)) {
    const startMonth = Number(match[1]), startDay = Number(match[2]);
    const end = match[0].match(/至\s*(?:(\d{1,2})月)?(\d{1,2})日/);
    const start = Date.UTC(year, startMonth - 1, startDay);
    const finish = end ? Date.UTC(year, Number(end[1] || startMonth) - 1, Number(end[2])) : start;
    if (finish < start || finish - start > 14 * 86400000) continue;
    for (let at = start; at <= finish; at += 86400000) days.add(new Date(at).toISOString().slice(0, 10));
  }
  return [...days].sort();
}

export async function syncOfficialClosures({ actor = 'system:daily-calendar' } = {}) {
  const stats = { marked: 0, sources: [], errors: [] };
  for (const [year, url] of SOURCES) {
    const res = await fetchText(url, { retryMax: 0 });
    if (!res.ok) { stats.errors.push({ year, error: res.error }); continue; }
    const days = parseOfficialClosures(res.body, year);
    const snapshot = recordSnapshot({ url, res, parser: 'official_annual_closures', parseQuality: days.length ? 'good' : 'failed' });
    stats.sources.push({ year, url, days: days.length, snapshot_id: snapshot.id });
    for (const day of days) {
      if (get('SELECT id FROM trade_daily WHERE trade_date=?', [day])) continue;
      markCalendar(day, 'holiday', { note: `官方全年休市公告：${url}；来源快照 ${snapshot.id}`, actor });
      stats.marked++;
    }
  }
  return stats;
}
