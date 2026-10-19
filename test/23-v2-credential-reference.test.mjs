import {setupV2,test,testAsync,assert,assertEqual,finish} from './v2-helpers.mjs';
const {db,admin}=await setupV2();
const secrets=await import('../src/core/secrets.mjs');
const search=await import('../src/services/search-svc.mjs');
const fetchSvc=await import('../src/services/web-fetch-svc.mjs');
const user={id:'user-admin',name:'test-admin',role:'admin'};
const fakeKey='sk-test-only-not-a-real-credential';

test('模型、搜索与抓取都拒绝将 API 密钥保存为环境变量名',()=>{
  const before=db.get('SELECT COUNT(*) c FROM llm_provider').c;
  const outputs=[
    admin.upsertLlmProvider(user,{name:'bad-reference',base_url:'https://api.deepseek.com',model:'test-model',credential_ref:fakeKey,allowed_domains:['api.deepseek.com']}),
    search.upsertSearchProvider(user,{name:'bad-reference',provider_kind:'bocha',credential_ref:fakeKey}),
    fetchSvc.upsertFetchConnection(user,{name:'bad-reference',conn_kind:'mcp_http',credential_ref:fakeKey}),
  ];
  for(const r of outputs){assertEqual(r.status,400);assert(!JSON.stringify(r).includes(fakeKey));}
  assertEqual(db.get('SELECT COUNT(*) c FROM llm_provider').c,before);
  assert(secrets.validCredentialRef('DEEPSEEK_API_KEY'));
  assert(secrets.validCredentialRef(null));
  assert(!secrets.validCredentialRef(fakeKey));
});

await testAsync('旧配置误填密钥时，列表和连接错误不回显密钥且不发起请求',async()=>{
  const row=db.get('SELECT id FROM llm_provider LIMIT 1');
  assert(row);
  db.run('UPDATE llm_provider SET credential_ref=?,last_test_message=? WHERE id=?',[fakeKey,'旧提示 CCER_LLM_KEY_'+fakeKey,row.id]);
  const listed=admin.listLlmProviders().find(p=>p.id===row.id);
  assertEqual(listed.credential_ref,null);
  assert(!JSON.stringify(listed).includes(fakeKey));
  assert(!JSON.stringify(secrets.resolveStoredCredential({credential_ref:fakeKey})).includes(fakeKey));
  const result=await admin.testLlmProvider(user,row.id);
  assertEqual(result.real_call_performed,false);
  assert(!JSON.stringify(result).includes(fakeKey));
});
finish('test/23-v2-credential-reference.test.mjs');
