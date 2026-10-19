# Codex真实接口复核追加问题（2026-10-19）
请继续通过DSH修复，保留既有功能与109全部断言，禁止真实凭据/外部服务/云端操作。

1. `live-http-acceptance.log`显示真实区间统计返回json_invalid。llm_call_log明确finish_reason=length、completion_tokens=1600。runToolChat必须启用适当JSON模式、限制引用冗长程度、给复杂统计合理输出预算，并在格式错误/截断时有界重试一次，仍受总时限；鉴权失败不重试。工具轮次/次数达到上限时，应停止工具并在剩余预算内做一次无工具的证据总结，而不是有资料仍立即tool_round_limit。最终仍走chat-svc逐字引用校验，不能绕过。
2. 查询2035-10-19空区间，market_statistics产生了一条0数据证据，publishedAt用了请求日期，回答as_of变成2035。无样本必须evidence=[]并返回缺口，不给未来数据日期；有样本也用实际MAX(trade_date)，不要用请求to。CEA与CCER都覆盖。统计注明已入库覆盖交易日数量。
3. `officialOnlyFilter`当前 `origin==='db' && kind==='official'` 把所有官方联网结果也移除了。按来源分类kind官方筛选，不能只允许db。添加回归验证官方联网可引用、第三方仍排除。
4. get_library_record对content必须沿用公开文章范围(is_demo=0、duplicate_of IS NULL、record_kind=article、process_status非failed_fetch)；policy排除duplicate_of。因子数值元数据不标full_text，历史/占位因子需与检索公开范围保持一致。不要扩大检索范围。
5. testDeepSeekBinding的vision/chat_tools/json只是8tokens文本ping。请把对应界面按钮/返回明确标为“鉴权与模型连接测试”，说明不等于视觉/工具完整验收，增加test_scope与capability_verified=false。Search/Fetch保持真实能力测试。连接测试也要配额/超时/调用记录，避免偷偷绕过限制。
6. 新独立测试请置于110或后续文件，覆盖空区间日期、官方联网过滤、结构化最终输出/工具上限收尾。109不改断言。记录真实修复及测试到docs/55。本轮仅做相关测试，不再全量反复跑。

Codex随后重新启动8921并真实服务/浏览器验收。已有官方Key Search/Fetch、普通库内工具问答、多轮追问均真实通过，不需要新Key。

7. 追加已确认缺陷：vision-svc.applyVisionPageToDocument中idx>=0直接覆盖原页，连source=text且正文有效的页也覆盖。请阻止视觉输出替换有效文本/OCR页（保留视觉结果供参考，返回existing_page_usable、不标applied），只有该页失败/空或明确质量不足才补入；必须有回归断言原页文本完全保留。不同视觉页的model/limitations要保留各自元数据，不把本次模型信息覆盖所有历史视觉页。

8. Codex浏览器390px移动端截图 output/playwright/deepseek-20261019/admin-mobile.png：能力表首列Search被挤成Sea/rch竖排，正文可读性差。请给能力表合理最小宽度并使用现有表格横向滚动容器，或移动端卡片布局；全页面不能横向溢出。其余宽表已有滚动容器，不要全局大改。版本徽标仍v2.6而package2.7，请与实际版本一致。

9. 总览聊天状态文案仍“对话历史仅保存在本页面内存中”，与新服务端按用户/会话保存多轮记录矛盾。改为准确说明会话隔离与实际保存范围，不承诺未实现的删除/保留期限。

## Codex并行复核修正（已完成，无需重复开发）
- 条目7/8/9由Codex落实：有效文本/OCR页保护与独立111、逐页元数据保留、能力表id和窄屏最小宽度、版本2.7、准确聊天历史文案。
- 真实复测发现最终总结缺会话正文导致追问拒答、统计证据date_match为空导致区间误拒；已补服务端隔离历史上下文、程序统计requested_range及chat-svc对实际日期/请求区间校验，独立113通过。工具最终prompt也提供本轮工具执行摘要和真实联网标记，避免“已经联网却说未联网”。
- 修复content-svc备用搜索来源归属与快照外键，独立112通过。
- 这些小修复已在本地，不要回退或覆盖。Codex会继续真实验收。
## Codex最终真实联调：
多轮追问已真实通过。区间统计仍出现遗漏CCER，因为最终8条证据优先选了日明细，挤掉了程序汇总；已将程序计算证据优先保留，并禁止模型自行加总。未来实际行情查询原本会落回普通联网并返回无关资料；已在问答入口按北京时间拒绝未来日期的实际市场行情，不发搜索/模型请求，as_of=null。
