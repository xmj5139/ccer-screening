import {setupV2,test,assert,assertEqual,finish} from './v2-helpers.mjs';
const {db}=await setupV2();
const {applyEdit}=await import('../src/services/admin-maintenance-svc.mjs');
const {searchUnified}=await import('../src/services/unified-search-svc.mjs');
const {buildSearchIndex}=await import('../src/services/search-index-svc.mjs');
const now=new Date().toISOString(), id='POL-FALLBACK-200';
db.run(`INSERT INTO policy_document (id,policy_key,title,category,collected_at,created_at,updated_at) VALUES (?,?,?,'management',?,?,?)`,[id,id,'qaoriginalfallback200',now,now,now]);
const changed=applyEdit({id:'user-admin',role:'admin',name:'独立验收'},{entity_type:'policy_document',entity_id:id,fields:{title:'qaeditedfallback200'}});
assert(changed.ok);
test('索引尚未构建时回退检索仍使用管理员公开覆盖层，并标注修订',()=>{
  const out=searchUnified({q:'qaeditedfallback200',types:'policy'});
  assertEqual(out.mode,'legacy_fallback');
  const row=out.results.find(x=>x.entity_id===id);
  assert(row,'索引未准备好也不能漏掉当前公开标题');
  assertEqual(row.title,'qaeditedfallback200'); assert(row.manual_revision);
  assert(!searchUnified({q:'qaoriginalfallback200',types:'policy'}).results.some(x=>x.entity_id===id));
});
test('FTS故障后回退同样使用公开覆盖层',()=>{
  buildSearchIndex({maxDocs:20000}); db.run('DROP TABLE search_index_fts');
  const out=searchUnified({q:'qaeditedfallback200',types:'policy'});
  assertEqual(out.mode,'legacy_fallback');
  assert(out.results.some(x=>x.entity_id===id&&x.manual_revision));
});
finish('200-v2-search-fallback-overlay-independent.test.mjs');
