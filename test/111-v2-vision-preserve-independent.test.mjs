/** Codex独立验收：视觉补充不能覆盖已识别的原文；无外部调用。 */
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {dirname} from 'node:path';
import {setupV2,testAsync,assertEqual,finish} from './v2-helpers.mjs';
const ctx=await setupV2({withPublicDemo:false});
const vision=await import('../src/services/vision-svc.mjs');
const pdf=await import('../src/services/pdf-parse-svc.mjs');
try{
 for(const source of ['text','ocr'])await testAsync('有效'+source+'页不能被视觉推断覆盖',async()=>{
  const hash=('b'+source).padEnd(64,'1'),original='已经有效解析的原文，包含必须保留的参数123.45。';
  const result={ok:true,hash,status:'ok',pages_total:1,pages_scanned:1,pages:[{page:1,source,text:original,chars:original.length}],text:original,raw_text:original};
  const path=pdf.docResultPath(hash);mkdirSync(dirname(path),{recursive:true});writeFileSync(path,JSON.stringify(result));
  const out=await vision.applyVisionPageToDocument({kind:'policy_document',id:'not-needed',docHash:hash,page:1,text:'模型误读后的文字',imageHash:'synthetic',pagesTotal:1});
  assertEqual(out.ok,false);assertEqual(out.reason,'existing_page_usable');
  assertEqual(JSON.parse(readFileSync(path,'utf8')).pages[0].text,original);
 });
 finish('111-v2-vision-preserve-independent');
}finally{await ctx.cleanup();}
