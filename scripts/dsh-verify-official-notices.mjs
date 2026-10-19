#!/usr/bin/env node
/**
 * 官方来源核验（只读网络）：抓取生态环境部发布通知页面，提取
 *   - 页面标题、文号、生成日期
 *   - 正文中出现的 CCER 方法学编号与名称配对
 *   - 官方 PDF 附件链接
 *
 * 用于方法学目录编号核实与淤地坝碳汇通知核对；不写任何业务数据。
 * 用法：node scripts/dsh-verify-official-notices.mjs
 */

const H = {
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
};

const NOTICES = [
  ['2023-10-24 首批4项', 'https://www.mee.gov.cn/xxgk2018/xxgk/xxgk06/202310/t20231024_1043877.html'],
  ['2025-01-03 CCER-10-001', 'https://www.mee.gov.cn/xxgk2018/xxgk/xxgk06/202501/t20250103_1099965.html'],
  ['2025-01-03 CCER-07-001', 'https://www.mee.gov.cn/xxgk2018/xxgk/xxgk06/202501/t20250103_1099966.html'],
  ['2025-11-21 油气3项', 'https://www.mee.gov.cn/xxgk2018/xxgk/xxgk06/202511/t20251121_1134574.html'],
  ['2025-12-02 淤地坝', 'https://www.mee.gov.cn/xxgk2018/xxgk/xxgk06/202512/t20251202_1136958.html'],
  ['2025-12-03 滨海盐沼等2项', 'https://www.mee.gov.cn/xxgk2018/xxgk/xxgk06/202512/t20251203_1137023.html'],
  ['2025-12-17 猪场沼气等2项', 'https://www.mee.gov.cn/xxgk2018/xxgk/xxgk06/202512/t20251217_1138026.html'],
  ['2025-12-23 公共建筑能效', 'https://www.mee.gov.cn/xxgk2018/xxgk/xxgk06/202512/t20251223_1138457.html'],
  ['2025-12-26 电解水制氢等2项', 'https://www.mee.gov.cn/xxgk2018/xxgk/xxgk06/202512/t20251226_1139056.html'],
  ['2025-12-26 中深层地热', 'https://www.mee.gov.cn/xxgk2018/xxgk/xxgk06/202512/t20251226_1139063.html'],
];

const toText = (html) =>
  String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');

const NORM = (s) => String(s || '').replace(/[—–－]/g, '-');

for (const [label, url] of NOTICES) {
  try {
    const res = await fetch(url, { headers: H, redirect: 'follow' });
    const buf = Buffer.from(await res.arrayBuffer());
    const html = buf.toString('utf8');
    const text = toText(html);
    const title = (html.match(/<title>([\s\S]*?)<\/title>/i)?.[1] || '').replace(/\s+/g, ' ').trim();
    const docNo = NORM(text).match(/环办气候函\s*〔\s*\d{4}\s*〕\s*\d+\s*号/)?.[0] || null;
    const genDate = text.match(/生成日期\s*[:：]?\s*(\d{4}-\d{2}-\d{2})/)?.[1] || null;
    const codes = [...new Set((NORM(text).match(/CCER-\d{2}-\d{3}-V\d+/gi) || []).map((s) => s.toUpperCase()))];
    const pdfs = [...new Set([...html.matchAll(/href=["']([^"']+\.pdf)["']/gi)].map((m) => new URL(m[1], url).href))];
    console.log(`\n### ${label}`);
    console.log(`url        : ${url}`);
    console.log(`http       : ${res.status} ${buf.length}B`);
    console.log(`title      : ${title}`);
    console.log(`doc_number : ${docNo}`);
    console.log(`gen_date   : ${genDate}`);
    console.log(`codes      : ${codes.join(', ') || '(none)'}`);
    console.log(`pdfs       : ${pdfs.length}`);
    for (const p of pdfs) console.log(`   - ${p}`);
    // 编号与名称配对（正文/附件标题中的「名称（CCER-xx-xxx-Vxx）」）
    const pairs = [...NORM(text).matchAll(/([^\s，。；、（）()]{2,40})\s*[（(]\s*(CCER-\d{2}-\d{3}-V\d+)\s*[)）]/gi)]
      .map((m) => `${m[2]} = ${m[1].trim()}`)
      .filter((v, i, a) => a.indexOf(v) === i);
    for (const p of pairs) console.log(`pair       : ${p}`);
  } catch (e) {
    console.log(`\n### ${label}\nurl: ${url}\nERROR: ${e.message}`);
  }
}
