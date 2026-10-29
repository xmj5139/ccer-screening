// Codex independent acceptance: batching must retain previous pages, never return stale public text.
import {setupV2,test,assert,assertEqual,finish} from './v2-helpers.mjs';
const {db}=await setupV2();
const {upsertContent}=await import('../src/services/content-svc.mjs');
const index=await import('../src/services/search-index-svc.mjs');
const {searchUnified}=await import('../src/services/unified-search-svc.mjs');
const {applyEdit}=await import('../src/services/admin-maintenance-svc.mjs');
db.run('UPDATE content_item SET is_demo=1');
const ids=[];
for(let i=0;i<6;i++)ids.push(upsertContent({title:`公开分批样本${i}`,source_url:`https://example.gov.cn/batch197/${i}`,content_type:'industry_news',body_snapshot:'批次测试公开资料，保留不同企业和来源的原始正文。'.repeat(5)+'独立公告编号'+i,body_availability:'full_text'}).id);
test('末页刷新不能删除前页；完整刷新仍须移除已排除的来源',()=>{
  for(const offset of [0,2,4])index.buildSearchIndex({types:['content'],maxDocs:2,offset,actor:'test:197'});
  assertEqual(db.get("SELECT COUNT(*) n FROM search_index_doc WHERE type='content'").n,6);
  db.run('UPDATE content_item SET is_demo=1 WHERE id=?',[ids[0]]);
  index.buildSearchIndex({types:['content'],maxDocs:20000,actor:'test:197'});
  assertEqual(db.get("SELECT COUNT(*) n FROM search_index_doc WHERE type='content'").n,5);
  assertEqual(db.get("SELECT COUNT(*) n FROM search_index_doc WHERE entity_id=?",[ids[0]]).n,0);
});
const now=new Date().toISOString();
const policy='POL-INDEPENDENT-197';
db.run(`INSERT INTO policy_document (id,policy_key,title,category,doc_status,publish_date,official_url,collected_at,created_at,updated_at,body_snapshot) VALUES (?,?,?,'management','effective','2020-01-01','https://example.gov.cn/policy197',?,?,?,?)`,[policy,policy,'qaoriginal197',now,now,now,'公开政策正文，不包含任何测试标题词。']);
index.buildSearchIndex({maxDocs:20000,actor:'test:197'});
test('非content实体更新后不能继续返回旧payload，也能检索新增词',()=>{
  db.run('UPDATE policy_document SET title=?,updated_at=? WHERE id=?',['qafresh197',now,policy]);
  const fresh=searchUnified({q:'qafresh197',types:'policy'});
  assert(fresh.results.some(r=>r.entity_id===policy&&r.title==='qafresh197'),'更新后的政策标题须在索引或如实回退结果中可见');
  const old=searchUnified({q:'qaoriginal197',types:'policy'});
  assert(!old.results.some(r=>r.entity_id===policy),'缓存中的过期标题不能当作当前正文');
});
test('管理员公开字段覆盖层立即参与检索与展示',()=>{
  const out=applyEdit({id:'user-admin',name:'独立验收',role:'admin'},{entity_type:'policy_document',entity_id:policy,fields:{title:'qaoverlay197'}});
  assert(out.ok,JSON.stringify(out));
  const found=searchUnified({q:'qaoverlay197',types:'policy'});
  assert(found.results.some(r=>r.entity_id===policy&&r.title==='qaoverlay197'),'不能继续搜索和展示覆盖前的原始标题');
});
test('删除公开来源后，不允许从旧索引返回已删除实体',()=>{
  db.run('DELETE FROM policy_document WHERE id=?',[policy]);
  const found=searchUnified({q:'qaoverlay197',types:'policy'});
  assert(!found.results.some(r=>r.entity_id===policy));
});
finish('197-v2-index-freshness-independent.test.mjs');
