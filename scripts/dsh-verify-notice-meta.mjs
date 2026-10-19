#!/usr/bin/env node
/** 只读核验：提取生态环境部通知页面的「发布机关 / 生成日期 / 文号」元数据块。 */
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
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
  const idx = text.indexOf('发布机关');
  const meta = idx >= 0 ? text.slice(idx, idx + 200) : '(无「发布机关」字段)';
  // 文末附件前的落款（正文尾部「附件：」之前 300 字）
  const attIdx = text.indexOf('附件：');
  const beforeAtt = attIdx > 0 ? text.slice(Math.max(0, attIdx - 320), attIdx) : '';
  const sig = beforeAtt.match(/([\u4e00-\u9fa5、]{4,80}?(?:办公厅|综合司|部|局))\s*(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  console.log(`=== ${no}`);
  console.log(`  元数据: ${meta}`);
  console.log(`  落款  : ${sig ? `${sig[1]} ${sig[2]}-${String(sig[3]).padStart(2, '0')}-${String(sig[4]).padStart(2, '0')}` : `(未匹配) …${beforeAtt.slice(-140)}`}`);
}
