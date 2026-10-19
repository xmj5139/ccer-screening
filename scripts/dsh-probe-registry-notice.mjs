#!/usr/bin/env node
/** 只读探测：注册登记系统公告详情页是否包含可直接下载的原件（PDF/附件）链接。 */
const H = {
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
};
const URLS = [
  'https://ccer.cets.org.cn/notice/noticeDetail?bulletinInfoId=1174755335156666368',
];
for (const u of URLS) {
  const html = await (await fetch(u, { headers: H })).text();
  const links = [...new Set([...html.matchAll(/(?:href|src)=["']([^"']+)["']/gi)].map((m) => m[1]))];
  console.log(`=== ${u}  (${html.length}B, ${(html.match(/<script/gi) || []).length} script tags)`);
  for (const l of links) console.log('   ', l);
  console.log('   has .pdf ?', /\.pdf/i.test(html));
  console.log('   可见中文正文长度:', html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, '').length);
}
