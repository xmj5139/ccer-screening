// Constructed records only, in setupV2's disposable database. No real HTTP/API calls.
import {setupV2,test,assertEqual,assert,finish} from './v2-helpers.mjs';
const ctx=await setupV2(),{db}=ctx;
const svc=await import('../src/services/cea-svc.mjs');
svc.ensureCeaSources();
db.run('DELETE FROM cea_entity_membership');db.run('DELETE FROM cea_entity_revision');db.run('DELETE FROM cea_entity');
const power='cea_entity_public_neimenggu_a1',aluminium='cea_entity_public_neimenggu_a6';
db.tx(()=>{
 for(let i=0;i<1005;i++)svc.upsertCeaEntity({name:`导出构造样本${String(i).padStart(4,'0')}有限公司`,list_year:2026,province:'内蒙古',sector:'发电',data_as_of:'2026-10-20'});
 svc.upsertCeaEntity({name:'跨行业构造样本有限公司',list_year:2026,province:'内蒙古',sector:'发电',source_code:power,source_url:'https://sthjt.nmg.gov.cn/fixture-power',source_hash:'fixture-power',data_as_of:'2026-10-20'});
 svc.upsertCeaEntity({name:'跨行业构造样本有限公司',list_year:2026,province:'内蒙古',sector:'铝冶炼',source_code:aluminium,source_url:'https://sthjt.nmg.gov.cn/fixture-aluminium',source_hash:'fixture-aluminium',data_as_of:'2026-10-20'});
 svc.upsertCeaEntity({name:'异年构造样本有限公司',list_year:2025,province:'广东省',sector:'水泥',data_as_of:'2026-10-19'});
});
test('导出跨过1000行上限且忽略页面offset，完整保留筛选范围',()=>{
 const e=svc.ceaExportRows('entities',{province:'内蒙古自治区',list_year:2026,offset:1000});
 assertEqual(e.rows.length,1006);assertEqual(new Set(e.rows.map(r=>r.name)).size,1006);
 assertEqual(svc.listCeaEntities({province:'内蒙古',list_year:2026,limit:1000}).rows.length,1000);
 assertEqual(svc.listCeaEntities({province:'内蒙古',list_year:2026,limit:1000,offset:1000}).rows.length,6);
});
test('重启迁移不把聚合行业反推给最后一个来源',()=>{
 assertEqual(db.get('SELECT COUNT(*) n FROM cea_entity_membership').n,2);
 db.closeDb();db.getDb();
 assertEqual(db.get('SELECT COUNT(*) n FROM cea_entity_membership').n,2);
 assertEqual(db.get('SELECT COUNT(*) n FROM cea_entity_membership WHERE source_code=? AND sector=?',[aluminium,'发电']).n,0);
 const r=svc.listCeaEntities({q:'跨行业构造样本'}).rows[0];assertEqual(r.source_memberships.length,2);assert(r.sector.includes('发电')&&r.sector.includes('铝冶炼'));
});
test('导出保留多出处，截止日期来自当前筛选范围',()=>{
 const r=svc.ceaExportRows('entities',{q:'跨行业构造样本'}).rows[0];assert(r.notes.includes('fixture-power')&&r.notes.includes('fixture-aluminium'));
 assertEqual(svc.listCeaEntities({province:'广东',list_year:2025}).coverage.as_of,'2026-10-19');
 assertEqual(svc.listCeaEntities({province:'内蒙古',list_year:2026}).coverage.as_of,'2026-10-20');
});
finish('121-v2-cea-directory-export-reopen.test.mjs');
