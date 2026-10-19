import assert from 'node:assert/strict';
import {run,closeDb} from '../src/core/db.mjs';
import {tradeRangeSummary,ceaRangeSummary} from '../src/services/market-summary-svc.mjs';
import {retrieveEvidence} from '../src/services/retrieval-svc.mjs';
const now=new Date().toISOString();
run(`INSERT INTO trade_daily(id,trade_date,volume,turnover,session_state,collected_at,created_at,updated_at)
 VALUES(?,?,?,?,?,?,?,?)`,['MISSING-AMOUNT','2026-02-02',100,null,'traded',now,now,now]);
const partial=tradeRangeSummary({from:'2026-02-02',to:'2026-02-02'});
assert.equal(partial.totals.volume,100);
assert.equal(partial.totals.turnover,null,'Unknown turnover is not zero');
assert.equal(partial.totals.avg_price,null,'Missing turnover cannot generate a zero price');
run(`INSERT INTO cea_trade_daily(id,trade_date,total_volume,total_turnover,session_state,source_url,created_at,updated_at)
 VALUES(?,?,?,?,?,?,?,?)`,['CEA-MISSING-AMOUNT','2026-02-02',100,null,'traded','https://www.cneeex.com/',now,now]);
const c=ceaRangeSummary({from:'2026-02-02',to:'2026-02-02'});
assert.equal(c.totals.total_turnover??c.totals.turnover,null);
assert.equal(c.totals.computed_avg_price,null,'Missing turnover cannot produce a CEA mean');

const mismatch=retrieveEvidence('2026年10月16日CEA成交量是多少');
assert.equal(mismatch.weak,true,'Same-year older daily data does not answer a different exact date');
const latest=retrieveEvidence('最新CEA市场成交量是多少');
assert.equal(latest.weak,true,'Old daily evidence must not answer a latest-market question');
console.log('Independent missing-value and exact-date/latest evidence checks passed');
closeDb();
