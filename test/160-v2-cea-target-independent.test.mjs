// Synthetic page fixtures; these do not represent actual trading data.
import {test,assertEqual,finish} from './v2-helpers.mjs';
import {detectCeaNonTargetPage} from '../src/services/cea-parse.mjs';
test('Explicit company profile with substantive main text is excluded',()=>{
 const r=detectCeaNonTargetPage('<title>基本信息-上海环境能源交易所</title><main><h1>基本信息</h1><p>企业名称：上海环境能源交易所股份有限公司。企业类型：股份有限公司。成立时间：2008年8月5日。</p></main>');
 assertEqual(r.non_target,true);
});
test('A real daily body with basic-information navigation remains a target',()=>{
 const r=detectCeaNonTargetPage('<title>全国碳市场每日综合价格行情及成交信息20261020</title><nav>基本信息 联系我们</nav><main><h1>每日行情</h1><p>今日全国碳市场开盘价96元/吨，收盘价97元/吨，成交量100吨，成交额9700元。</p></main><footer>企业基本信息 网站地图</footer>');
 assertEqual(r.non_target,false);
});
test('An access-error page retaining its original company-profile title is not proven non-target',()=>{
 const r=detectCeaNonTargetPage('<html><head><title>基本信息-上海环境能源交易所</title></head><body><main>访问过于频繁，请稍后重试。Access Denied</main></body></html>');
 assertEqual(r.non_target,false,'access failure must preserve uncertainty, not settle a historic parse gap');
});
test('A title-only empty page is not enough evidence to settle a historical failure',()=>{
 assertEqual(detectCeaNonTargetPage('<title>基本信息</title><main></main>').non_target,false);
});
finish('160-v2-cea-target-independent.test.mjs');
