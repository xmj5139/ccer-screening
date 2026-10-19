import assert from 'node:assert/strict';
import { quickGasEstimate } from '../src/services/quick-estimate-svc.mjs';
import { parseFiles, detailUrl } from '../src/services/registry-svc.mjs';

const out=quickGasEstimate({annual_gas_m3:100_000_000,ch4_pct:1.2});
assert.equal(out.annual_tco2e,18270.9);
assert.equal(out.inputs.treated_share_pct,100);
assert.equal(out.kind,'rough_methane_component');
assert.match(out.caveat,/不是预计可签发 CCER/);
// 一万倍回归：10000 万 m³/年 + 1.2% 必须与 1e8 m³/年 同结果（不是 1.82709）
const out10k=quickGasEstimate({annual_gas_10k_m3:10000,ch4_pct:1.2});
assert.equal(out10k.annual_tco2e,18270.9);
assert.equal(out10k.inputs.annual_gas_m3,100_000_000);
assert.equal(quickGasEstimate({annual_gas_m3:100,annual_gas_10k_m3:1,ch4_pct:1}).status,400);
assert.equal(quickGasEstimate({annual_gas_m3:100,ch4_pct:8}).status,400);
assert.equal(quickGasEstimate({annual_gas_m3:100,ch4_pct:1,treated_share_pct:101}).status,400);
const half=quickGasEstimate({annual_gas_m3:100_000_000,ch4_pct:1.2,treated_share_pct:50});
assert.equal(half.annual_tco2e,9135.45);
const files=parseFiles({applyFile1:JSON.stringify([{name:'PDD.pdf',url:'/api/file/download/single?filePath=x.pdf'},
  {name:'外部',url:'http://127.0.0.1/private'}])});
assert.equal(files.length,1);
assert.equal(files[0].name,'PDD.pdf');
assert.match(detailUrl({applyId:'123',dataType:'1'}),/applyId=123/);
console.log('✓ 快速估算公式、适用边界与官方附件 URL 白名单');
