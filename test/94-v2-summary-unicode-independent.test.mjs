import assert from'node:assert/strict';
import{run,closeDb}from'../src/core/db.mjs';
import{loadSummaryInput,MAX_INPUT_CHARS,summaryInputHash}from'../src/services/summary-svc.mjs';
const now=new Date().toISOString();
run(`INSERT INTO policy_document(id,policy_key,title,category,body_snapshot,collected_at,created_at,updated_at)
 VALUES(?,?,?,?,?,?,?,?)`,['UNICODE-CUTOFF','unicode-cutoff','数学字符边界核验','management','a'.repeat(8000),now,now,now]);
const initial=loadSummaryInput('policy_document','UNICODE-CUTOFF');
const prefix=initial.text.indexOf('a'.repeat(100));assert(prefix>=0);
const body='a'.repeat(MAX_INPUT_CHARS-prefix-1)+'\u{1D465}'+'source-tail';
run('UPDATE policy_document SET body_snapshot=? WHERE id=?',[body,'UNICODE-CUTOFF']);
const input=loadSummaryInput('policy_document','UNICODE-CUTOFF');
assert(input.truncated);assert(input.text.length<=MAX_INPUT_CHARS);
assert.equal(input.text.isWellFormed(),true,'A mathematical surrogate pair at the input boundary must not become an invalid JSON string');
assert(!/[\uD800-\uDBFF]$/.test(input.text),'Do not send half a mathematical character to the model');
const h=summaryInputHash(input);
run('UPDATE policy_document SET body_snapshot=? WHERE id=?',[body+'different-original-tail','UNICODE-CUTOFF']);
assert.notEqual(h,summaryInputHash(loadSummaryInput('policy_document','UNICODE-CUTOFF')),'Safe truncation still hashes the entire original source');
closeDb();console.log('Mathematical-character cutoff is well formed and full-source invalidation remains exact');
