import assert from 'node:assert/strict';
import { quoteInEvidence, validateAnswer } from '../src/services/chat-svc.mjs';

// Codex independent review: docs/46-摘要问答独立复核整改.md lists the observed
// schema, cache pagination, timestamp and quote defects. Resolve it before delivery.

const a={source_id:'factor:a',title:'2023年全国电力因子',kind:'metadata',origin:'db',year_match:true,text:'2023年全国电力平均二氧化碳排放因子为0.5306 kgCO2/kWh。',url:'https://www.mee.gov.cn/'};
const b={...a,source_id:'factor:b',text:'2023年全国电力平均二氧化碳排放因子为0.6096 kgCO2/kWh。'};
assert.equal(quoteInEvidence('全国电力平均二氧化碳排放因子为05306 kgCO2/kWh',a.text),false,'Decimal points are part of numeric evidence');
assert.equal(quoteInEvidence('2023年全国电力平均二氧化碳排放因子为9.9999 kgCO2/kWh。',a.text),false,'Partially matching long quotes cannot change the source value');
const paragraph=(text,ids,quotes)=>({answerable:true,paragraphs:[{text,source_ids:ids,quotes}]});
assert.equal(validateAnswer(paragraph('2023年全国电力因子为0.5306 kgCO2/kWh。',['factor:a'],[{source_id:'factor:a',quote:a.text}]),[a,b],{question:'2023年全国电力因子'}).ok,true);
assert.equal(validateAnswer(paragraph('全国电力因子为0.6096。',['factor:a'],[{source_id:'factor:b',quote:b.text}]),[a,b]).ok,false,'A paragraph cannot cite A and use a quote from B');
assert.equal(validateAnswer(paragraph('2023年全国电力因子为9.9999 kgCO2/kWh。',['factor:a'],[{source_id:'factor:a',quote:a.text}]),[a]).ok,false,'An actual source quote does not justify an unsupported number');
assert.equal(validateAnswer(paragraph('数值为0.5306。',['factor:a','invented:source'],[{source_id:'factor:a',quote:a.text}]),[a]).ok,false,'Mixed valid and forged IDs must fail rather than silently discard forged citations');
console.log('Independent decimal fidelity, source/quote pairing and unsupported-number rejection passed');
