// Actual SQLite phrase lookup, including repeated words in separate sentences.
import {DatabaseSync} from 'node:sqlite';
import {test,assertEqual,finish} from './v2-helpers.mjs';
import {tokenizeForIndex,buildFtsMatch} from '../src/services/search-index-svc.mjs';
test('重复中文前缀与重复双字不得改变FTS词语位置而漏检真实短语',()=>{
  const db=new DatabaseSync(':memory:');
  try {
    db.exec('CREATE VIRTUAL TABLE actual_phrase USING fts5(body)');
    db.prepare('INSERT INTO actual_phrase(body) VALUES (?)').run(tokenizeForIndex('碳市场信息平台。碳市场交易价格。哈哈哈。'));
    const lookup=db.prepare('SELECT COUNT(*) n FROM actual_phrase WHERE actual_phrase MATCH ?');
    assertEqual(lookup.get(buildFtsMatch('碳市场交易')).n,1);
    assertEqual(lookup.get(buildFtsMatch('哈哈哈')).n,1);
    assertEqual(lookup.get(buildFtsMatch('市场碳')).n,0,'不能将无序词集合当成连续短语');
  } finally {db.close();}
});
finish('196-v2-fts-positions-independent.test.mjs');
