// Actual two-page synthetic PDF, isolated database: one text page and one image-only page.
import {mkdirSync,writeFileSync,existsSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {createHash} from 'node:crypto';
import {setupV2,testAsync,assert,assertEqual,finish} from './v2-helpers.mjs';
const {db,dbPath}=await setupV2({withPublicDemo:false});
if(process.platform==='win32'){
 for(const p of String(process.env.PATH||'').split(';')){
  if(existsSync(join(p,'pdfinfo.exe'))&&existsSync(join(p,'pdftotext.exe'))){process.env.CCER_PDFINFO=join(p,'pdfinfo.exe');process.env.CCER_PDFTOTEXT=join(p,'pdftotext.exe');break;}
 }
}
const triage=await import('../src/services/gap-triage-svc.mjs');
const ocr=await import('../src/services/baidu-ocr-svc.mjs');
const admin={id:'independent-admin',name:'independent local admin',role:'admin'};
ocr.saveBaiduOcrConfig(admin,{enabled:false});
db.run('UPDATE llm_provider SET enabled=0');
function pdf(){
 const text=Array.from({length:12},(_,i)=>`(Synthetic carbon report line ${i} contains public test data.) Tj 0 -18 Td`).join(' ');
 const stream=`BT /F1 10 Tf 14 550 Td ${text} ET`;
 const image='0.3 0.3 0.3 rg 12 12 396 576 re f';
 const objects=['','<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [4 0 R 6 0 R] /Count 2 >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 420 600] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>',`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 420 600] /Resources << >> /Contents 7 0 R >>',`<< /Length ${image.length} >>\nstream\n${image}\nendstream`];
 let s='%PDF-1.4\n';const offsets=[0];for(let i=1;i<objects.length;i++){offsets[i]=s.length;s+=`${i} 0 obj\n${objects[i]}\nendobj\n`;}
 const x=s.length;s+=`xref\n0 ${objects.length}\n0000000000 65535 f \n`;
 for(let i=1;i<objects.length;i++)s+=`${String(offsets[i]).padStart(10,'0')} 00000 n \n`;
 s+=`trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`;return Buffer.from(s,'latin1');
}
await testAsync('A PDF with one unreadable page must not close the full-document parsing gap',async()=>{
 const root=join(dirname(dbPath),'official-originals');mkdirSync(root,{recursive:true});const p=join(root,'independent-partial.pdf');const bytes=pdf();writeFileSync(p,bytes);
 const hash=createHash('sha256').update(bytes).digest('hex'),now=new Date().toISOString();
 db.run(`INSERT INTO cea_document(id,doc_key,doc_type,title,source_code,attachment_path,attachment_hash,official_url,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)`,['independent-partial-doc','independent-pdf','technical','Synthetic partial report','independent-pdf',p,hash,'https://www.mee.gov.cn/synthetic-partial.pdf',now,now]);
 db.run(`INSERT INTO data_gap(id,dataset,gap_key,title,description,status,severity,detected_at,updated_at) VALUES(?,?,?,?,?,'open','warning',?,?)`,['independent-partial-gap','cea_document','cea:document:pdf_text:independent-pdf','PDF 已下载未解析','该 PDF 缺少完整正文，需解析/OCR。',now,now]);
 const out=await triage.runGapAction(admin,'independent-partial-gap','reparse_pdf');
 assert(out.result?.pages_failed>0,'fixture must actually produce an unreadable second page, not a simulated parsing failure');
 assertEqual(out.closed,false,'partial text is progress, not completion of a full-document gap');
 assertEqual(db.get('SELECT status FROM data_gap WHERE id=?',['independent-partial-gap']).status,'open');
});
finish('161-v2-partial-pdf-gap-independent.test.mjs');
