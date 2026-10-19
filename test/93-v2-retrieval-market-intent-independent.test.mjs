import assert from 'node:assert/strict';
import{run,closeDb}from'../src/core/db.mjs';
import{retrieveEvidence}from'../src/services/retrieval-svc.mjs';
const now=new Date().toISOString();
run(`INSERT INTO policy_document(id,policy_key,title,category,publish_date,summary,body_snapshot,collected_at,created_at,updated_at)
 VALUES(?,?,?,?,?,?,?,?,?,?)`,['DISTRACTOR','distractor','2023、2024年度全国碳排放权交易发电行业配额总量和分配方案','ministry_policy','2024-10-22','文件涉及全国碳市场CEA，2024年度配额分配。','本文件为2023、2024年度全国碳排放权交易发电行业配额总量和分配方案。'.repeat(20),now,now,now]);
const missing=retrieveEvidence('2024年12月31日全国碳市场CEA收盘价是多少？');
assert.equal(missing.weak,true,'A same-year allocation policy is not sufficient evidence for an exact-day closing price; web fallback is required');
run(`INSERT INTO cea_trade_daily(id,trade_date,close,computed_avg_price,total_volume,total_turnover,source_url,created_at,updated_at)
 VALUES(?,?,?,?,?,?,?,?,?)`,['MATCHING-CEA','2024-12-31',97.49,96,10,960,'https://www.cneeex.com/',now,now]);
const available=retrieveEvidence('2024年12月31日全国碳市场CEA收盘价是多少？');
assert.equal(available.weak,false,'Matching CEA official daily facts should answer without web fallback');
assert(available.evidence.some(e=>e.entity_type==='cea_trade_daily'&&e.published_at==='2024-12-31'));
closeDb();console.log('Market-intent retrieval rejects policy distractors and accepts the correct dated market record');
