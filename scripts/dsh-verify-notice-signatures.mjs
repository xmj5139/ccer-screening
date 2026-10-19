#!/usr/bin/env node
/** 只读核验：从生态环境部通知正文中提取落款（印发）日期候选（排除页脚版权区）。 */
const H = {
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
};
const NOTICES = [
  ['2024-486', 'https://www.mee.gov.cn/xxgk2018/xxgk/xxgk06/202501/t20250103_1099966.html'],
  ['2025-428', 'https://www.mee.gov.cn/xxgk2018/xxgk/xxgk06/202511/t20251121_1134574.html'],
  ['2025-438', 'https://www.mee.gov.cn/xxgk2018/xxgk/xxgk06/202512/t20251202_1136958.html'],
  ['2025-451', 'https://www.mee.gov.cn/xxgk2018/xxgk/xxgk06/202512/t20251203_1137023.html'],
  ['2025-473', 'https://www.mee.gov.cn/xxgk2018/xxgk/xxgk06/202512/t20251217_1138026.html'],
  ['2025-485', 'https://www.mee.gov.cn/xxgk2018/xxgk/xxgk06/202512/t20251223_1138457.html'],
  ['2025-491', 'https://www.mee.gov.cn/xxgk2018/xxgk/xxgk06/202512/t20251226_1139056.html'],
  ['2025-493', 'https://www.mee.gov.cn/xxgk2018/xxgk/xxgk06/202512/t20251226_1139063.html'],
];
for (const [no, url] of NOTICES) {
  const html = await (await fetch(url, { headers: H })).text();
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
  const cut = text.indexOf('版权所有：中华人民共和国生态环境部');
  if (cut > 0) text = text.slice(0, cut);
  const hits = [...text.matchAll(/(.{24})(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/g)]
    .map((m) => ({ ctx: m[1], date: `${m[2]}-${String(m[3]).padStart(2, '0')}-${String(m[4]).padStart(2, '0')}` }));
  console.log(`=== ${no}  候选日期 ${hits.length} 个`);
  for (const h of hits.slice(-4)) console.log(`   ${h.date}  ← …${h.ctx.trim()}`);
  if (!hits.length) console.log('   (正文内未出现「YYYY年M月D日」)');
}
