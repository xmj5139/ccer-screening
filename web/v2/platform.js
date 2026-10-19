/**
 * 平台共享前端组件（docs/44 第 2、3 条）
 * ============================================================================
 *   1. `sourceBlock`  —— 来源展示为主：官方网站显示「官方信息」，第三方显示实际
 *      发布机构 / 网站名，来源未知显示域名或「来源未标注」；公开列表**不再**以
 *      「证据充足/不足/自动核验」标签呈现（核验数据保留在后台）。
 *   2. `summaryBlock` —— 标题下的「核心摘要」：模型生成时标注模型与输入范围；
 *      未生成时**如实空态**，不显示空字符串、不假装已生成。
 *   3. `rangeSummaryBar` —— 行情数字表的区间口径汇总（确定性程序生成，
 *      不逐行调用模型）。
 *   4. `chatPanel` —— 总览底部所有已登录用户可用的 AI 对话区。
 *
 * 所有文本一律经 `esc()` 转义；模型输出与来源文本都按不可信数据显示。
 */
import { api, state } from './app.js';
import { esc, truncate, shortDate, dateTime, toast, loading, emptyState, chip, num } from './ui.js';

/* ==================================================================== */
/*  一、来源展示                                                        */
/* ==================================================================== */

const KIND_LABEL = {
  official: '官方信息',
  third_party: '第三方来源',
  unknown: '来源未标注',
};

/**
 * 来源标签（以来源为主，替代核验四态标签）。
 * @param {{source_display?:object, publisher?:string, source_url?:string, official_url?:string, url?:string}} row
 */
export function sourceBlock(row = {}) {
  const sd = row.source_display || null;
  if (!sd) {
    const pub = row.publisher || row.issuer || row.issuing_authority;
    return pub
      ? `<span class="chip chip-muted" title="发布机构">${esc(truncate(pub, 24))}</span>`
      : '<span class="chip chip-muted">来源未标注</span>';
  }
  if (sd.kind === 'official') {
    return `<span class="chip chip-ok" title="官方域名按 hostname 精确 / 受控子域匹配">官方信息</span>
      <span class="muted src-org">${esc(truncate(sd.official_label || sd.detail || '', 28))}</span>`;
  }
  if (sd.kind === 'third_party') {
    return `<span class="chip chip-plain" title="第三方发布机构 / 网站（不是官方网站）">${esc(truncate(sd.label, 28))}</span>
      ${sd.detail ? `<span class="muted src-org">${esc(truncate(sd.detail, 24))}</span>` : ''}`;
  }
  return `<span class="chip chip-muted" title="${esc(sd.note || '来源未标注')}">${esc(truncate(sd.label || '来源未标注', 28))}</span>`;
}

/** 原文链接（仅 http(s)；无链接时显示来源未标注，不杜撰）。 */
export function sourceLinkBlock(row = {}, { label = '原文' } = {}) {
  const url = row.source_url || row.official_url || row.url || row.original_url || null;
  if (!url || !/^https?:\/\//i.test(String(url))) {
    return '<span class="muted">来源未标注</span>';
  }
  return `<a class="link src-link" href="${esc(url)}" target="_blank" rel="noopener noreferrer" title="${esc(url)}">${esc(label)}</a>`;
}

/* ==================================================================== */
/*  二、核心摘要                                                        */
/* ==================================================================== */

/**
 * 输入范围的**短标签**（列表 compact 模式用）：只说范围，不解释实现细节。
 */
const INPUT_KIND_SHORT = {
  full_text: '已取得正文',
  partial_text: '部分正文',
  summary_only: '仅来源摘要',
  metadata_only: '仅公开字段',
  data_range: '区间汇总',
};

/**
 * 标题下的「核心摘要」块。
 * docs/47：列表 compact 模式只给「核心摘要」+ 简洁正文（约 100—160 字）与一句短提示；
 * 输入范围 / 生成时间放进 title（悬停可见）或详情模式，**不再每条重复免责声明**，
 * 也不在页面上解释 GET、批次等实现细节。
 * @param {object} row 需要带 `summary_block`（后端 summaryPayload 输出）
 * @param {{compact?:boolean}} opts compact=true 用于列表行
 */
export function summaryBlock(row = {}, { compact = false } = {}) {
  const s = row.summary_block || null;
  if (!s) return '';
  // 失效摘要不能当成当前摘要显示（docs/46 第 3 条）：显示简短空态
  if (s.status !== 'ok' || !s.text || s.stale) {
    const adminHint = state.user?.role === 'admin'
      ? '管理员可在后台「运行与内容维护」中补齐。'
      : '';
    const short = s.stale ? '原摘要已失效，等待重新生成'
      : s.status === 'failed' ? '摘要暂不可用' : '摘要正在整理';
    return `<div class="summary-block summary-empty" title="${esc(
      s.stale
        ? `原摘要已失效（${s.stale_reason || '输入已变化'}），等待重新生成`
        : `摘要未生成：${s.empty_reason || '暂不可用'}`
    )}">
      <span class="summary-label">核心摘要</span>
      <span class="muted">${esc(short)}</span>
      ${adminHint ? `<span class="hint">${esc(adminHint)}</span>` : ''}
    </div>`;
  }
  const kindShort = INPUT_KIND_SHORT[s.input_kind] || '输入范围未标注';
  if (compact) {
    return `<div class="summary-block summary-compact">
      <span class="summary-label">核心摘要</span>
      <p class="summary-text">${esc(truncate(s.text, 160))}</p>
      <div class="summary-meta">
        <span class="muted" title="${esc(`输入范围：${s.scope_note || kindShort}${s.generated_at ? `；生成于 ${dateTime(s.generated_at)}` : ''}`)}">AI 生成｜${esc(kindShort)}</span>
      </div>
    </div>`;
  }
  return `<div class="summary-block">
    <span class="summary-label">核心摘要</span>
    <p class="summary-text">${esc(truncate(s.text, 600))}</p>
    <div class="summary-meta">
      <span class="chip chip-muted" title="摘要由已配置模型生成，仅供检索参考">模型生成</span>
      <span class="muted">输入范围：${esc(kindShort)}</span>
      ${s.scope_note ? `<span class="muted" title="${esc(s.scope_note)}">｜${esc(truncate(s.scope_note, 70))}</span>` : ''}
      ${s.generated_at ? `<span class="muted">｜生成于 ${esc(dateTime(s.generated_at))}</span>` : ''}
    </div>
    <p class="hint">摘要由模型依据上述输入范围生成，未经来源确认；请以原文链接为准。</p>
  </div>`;
}

/**
 * 摘要整理提示：只在整页确实有缺失时给一句，不解释 GET / 批次等实现细节，
 * 也不向普通用户指向其无权限的后台（docs/46 第 10 条、docs/47）。
 */
export function summaryCoverageHint(rows = []) {
  const list = Array.isArray(rows) ? rows : [];
  const missing = list.filter((r) => {
    const s = r.summary_block;
    return !s || s.status !== 'ok' || s.stale;
  }).length;
  if (!list.length || !missing) return '';
  const adminHint = state.user?.role === 'admin' ? '管理员可在后台「运行与内容维护」中补齐。' : '';
  return `<p class="hint">本页 ${list.length} 条中 ${missing} 条摘要正在整理。${adminHint}</p>`;
}

/* ==================================================================== */
/*  三、行情区间口径条（确定性，不调用模型）                              */
/* ==================================================================== */

export async function rangeSummaryBar(dataset, query = {}) {
  const qs = new URLSearchParams({ dataset, ...query }).toString();
  let out = null;
  try {
    out = await api(`/api/v2/market-summary?${qs}`);
  } catch (e) {
    return `<div class="range-summary range-summary-error">区间汇总暂不可用：${esc(e.body?.error || e.message)}</div>`;
  }
  const s = out.summary;
  if (!s) return '';
  return `<div class="range-summary">
    <div class="range-head"><b>${esc(s.label)}</b>
      <span class="muted">实际区间 ${esc(s.actual_range?.from || '—')} ~ ${esc(s.actual_range?.to || '—')}（${esc(String(s.actual_range?.days ?? 0))} 个交易日有记录）</span>
    </div>
    <p class="range-text">${esc(s.text)}</p>
    <p class="hint">口径：${esc(s.caliber)}${esc(s.note || '')}</p>
  </div>`;
}

/* ==================================================================== */
/*  四、总览底部 AI 对话区（所有已登录用户）                              */
/* ==================================================================== */

/** 对话历史只保存在**内存**（页面刷新即清空），不写入浏览器本地存储。 */
const chatState = { messages: [], pending: false, limits: null, cleared: 0, sessionId: null };

function newChatSessionId() {
  try {
    if (globalThis.crypto?.randomUUID) return `chat-${crypto.randomUUID().slice(0, 24)}`;
  } catch { /* 回退到时间随机串 */ }
  return `chat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function chatSession() {
  if (!chatState.sessionId) chatState.sessionId = newChatSessionId();
  return chatState.sessionId;
}

function newProgressId() {
  try {
    if (globalThis.crypto?.randomUUID) return `pg-${crypto.randomUUID()}`;
  } catch { /* ignore */ }
  return `pg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function chatStateSnapshot() {
  return { count: chatState.messages.length, pending: chatState.pending, limits: chatState.limits, session_id: chatState.sessionId };
}

export function resetChatMemory() {
  chatState.messages = [];
  chatState.pending = false;
  chatState.sessionId = null;
}

/** 对话区外壳（渲染一次，后续局部更新消息列表）。 */
export function chatPanel() {
  const u = state.user;
  if (!u) return '';
  return `
  <section class="card chat-card" id="chat-card" aria-labelledby="chat-title">
    <header class="card-head">
      <div class="chat-heading">
        <span class="chat-icon" aria-hidden="true"><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" focusable="false"><path d="M4.5 5.5h15v10.5h-8.1L7 20v-4H4.5z"/><path d="M8.5 9.2h7M8.5 12.2h4.5"/></svg></span>
        <div>
          <h3 id="chat-title">碳市场问答</h3>
          <p>先查库内证据，必要时调用只读工具联网、查行情或计算；复杂问题可继续追问</p>
        </div>
      </div>
      <div class="card-actions">
        <button class="btn btn-sm" id="chat-clear" type="button">清空对话</button>
      </div>
    </header>
    <div class="card-body">
      <div class="chat-scope">回答范围：碳市场政策、方法学、公开项目、CCER/CEA 行情、研报动态、排放因子与核算规范。范围外问题会被拒绝。来源标注：「库内证据」来自平台已入库的公开记录，「搜索摘要」表示只获得检索片段而不是完整正文。</div>
      <div class="chat-log" id="chat-log" role="log" aria-live="polite" aria-label="对话记录">${chatEmptyHtml()}</div>
      <form class="chat-form" id="chat-form">
        <label class="chat-input-wrap">
          <span class="sr-only">问题</span>
          <textarea id="chat-input" rows="2" maxlength="800" placeholder="例如：2023 年全国电力平均二氧化碳排放因子是多少？"></textarea>
        </label>
        <div class="chat-actions">
          <span class="muted chat-counter" id="chat-counter">0 / 800</span>
          <button class="btn btn-primary" id="chat-send" type="submit">发送</button>
        </div>
      </form>
      <p class="hint chat-status" id="chat-status" role="status" aria-live="polite">答复由模型依据所给证据生成，并逐条校验来源与引句；程序无法完全杜绝模型错误，请以来源原文为准。本页面显示当前对话，服务端按用户与会话保存问答记录并隔离使用。</p>
    </div>
  </section>`;
}

function chatEmptyHtml() {
  return `<div class="chat-empty">
    <p><b>先查库内证据。</b>未找到或证据不足时，才会联网核实；联网失败也会如实说明。</p>
    <div class="chat-suggestions" role="group" aria-label="可试用的问题">
      <button class="chat-suggestion" type="button" data-chat-suggest="2023 年全国电力平均二氧化碳排放因子是多少？">2023 年全国电力平均排放因子</button>
      <button class="chat-suggestion" type="button" data-chat-suggest="CCER 项目登记与减排量登记有什么区别？">CCER 项目登记与减排量登记的区别</button>
      <button class="chat-suggestion" type="button" data-chat-suggest="CEA 官方综合收盘价与全方式计算均价有什么不同？">CEA 两种价格口径的区别</button>
    </div>
  </div>`;
}

/** 绑定对话区事件（总览渲染后调用一次）。 */
export function bindChatPanel(root) {
  const form = root.querySelector('#chat-form');
  if (!form) return;
  const input = root.querySelector('#chat-input');
  const counter = root.querySelector('#chat-counter');
  const status = root.querySelector('#chat-status');
  input?.addEventListener('input', () => {
    if (counter) counter.textContent = `${input.value.length} / 800`;
  });
  root.querySelector('#chat-clear')?.addEventListener('click', () => {
    chatState.messages = [];
    chatState.sessionId = null;
    chatState.cleared += 1;
    renderChatLog(root);
    if (status) status.textContent = '当前页面对话已清空，下次提问将使用新会话；服务端已有问答日志仍保留。';
  });
  // 空态示例只填入问题，不自动发送，也不会生成假对话。
  root.querySelector('#chat-log')?.addEventListener('click', (e) => {
    const suggestion = e.target.closest('[data-chat-suggest]');
    if (!suggestion || !input) return;
    input.value = suggestion.dataset.chatSuggest || '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.focus();
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const question = String(input?.value || '').trim();
    if (!question) { if (status) status.textContent = '请输入问题后再发送。'; return; }
    if (chatState.pending) return;
    chatState.pending = true;
    chatState.messages.push({ role: 'user', content: question });
    if (input) input.value = '';
    if (counter) counter.textContent = '0 / 800';
    renderChatLog(root);
    const sendBtn = root.querySelector('#chat-send');
    if (sendBtn) { sendBtn.disabled = true; sendBtn.textContent = '检索中…'; }
    if (status) status.textContent = '正在检索平台公开数据库…';
    const progressId = newProgressId();
    let pollTimer = null;
    let lastPhases = [];
    const stopPolling = () => {
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = null;
    };
    const pollProgress = async () => {
      try {
        const p = await api(`/api/v2/chat/progress/${encodeURIComponent(progressId)}`);
        if (!p || p.error) return;
        lastPhases = p.phases || [];
        const last = lastPhases[lastPhases.length - 1];
        if (status && last) status.textContent = `${last.label || last.phase}…`;
        if (p.done) stopPolling();
      } catch { /* 进度轮询失败不阻断正式请求 */ }
    };
    pollTimer = setInterval(pollProgress, 700);
    pollProgress();
    try {
      // 只提交 user 角色的历史；服务端会丢弃任何 assistant/system 内容。
      // session_id 用于服务端保存**当前用户当前会话**的上下文；不写入 localStorage。
      const history = chatState.messages
        .filter((m) => m.role === 'user')
        .slice(-8)
        .map((m) => ({ role: 'user', content: m.content }));
      const out = await api('/api/v2/chat/ask', {
        method: 'POST',
        body: { question, history, session_id: chatSession(), progress_id: progressId },
      });
      chatState.limits = out.limits || null;
      out.progress_phases = lastPhases;
      chatState.messages.push({ role: 'assistant', content: out.message || '', payload: out });
      const modeLabel = { db: '库内证据', web: '联网核实', 'db+web': '库内 + 联网' }[out.mode] || out.mode || '—';
      if (status) {
        status.textContent = out.refused
          ? `已拒答（${modeLabel}）：${out.reason || ''}`
          : `回答完成（${modeLabel}，引用 ${out.sources?.length || 0} 条来源，数据截至 ${out.as_of || '—'}，${out.latency_ms || 0} ms）。答复基于所给证据，程序无法完全杜绝模型错误。`;
      }
    } catch (err) {
      const msg = err.body?.error || err.message;
      chatState.messages.push({ role: 'error', content: msg, payload: err.body || null });
      if (status) status.textContent = `请求失败：${msg}`;
    } finally {
      stopPolling();
      chatState.pending = false;
      if (sendBtn) { sendBtn.disabled = false; sendBtn.textContent = '发送'; }
      renderChatLog(root);
    }
  });
}

function renderChatLog(root) {
  const log = root.querySelector('#chat-log');
  if (!log) return;
  if (!chatState.messages.length) { log.innerHTML = chatEmptyHtml(); return; }
  log.innerHTML = chatState.messages.map((m) => {
    if (m.role === 'user') {
      return `<div class="chat-msg chat-msg-user"><div class="chat-bubble">${esc(m.content)}</div></div>`;
    }
    if (m.role === 'error') {
      return `<div class="chat-msg chat-msg-error"><div class="chat-bubble">请求失败：${esc(m.content)}</div></div>`;
    }
    const p = m.payload || {};
    if (p.refused) {
      return `<div class="chat-msg chat-msg-assistant">
        <div class="chat-bubble chat-refused">
          <p><b>无法核实</b>：${esc(p.message || p.reason || '没有可用证据')}</p>
          ${renderSources(p.sources || [], { title: '检索到的来源（未用于生成结论）' })}
          ${renderToolRuns(p.tool_runs || [])}
          ${chatTechDetails(p)}
        </div>
      </div>`;
    }
    return `<div class="chat-msg chat-msg-assistant">
      <div class="chat-bubble">
        ${(p.answer || []).map((a) => `
          <div class="chat-para">
            <p>${esc(a.text)}</p>
            <div class="chat-para-src">${(a.sources || []).map((s) => `<span class="chip chip-muted" title="${esc(s.title)}">${esc(truncate(s.title || s.source_id, 26))}</span>`).join('')}</div>
            ${(a.quotes || []).length ? `<details class="chat-quotes"><summary>原文引句（${a.quotes.length}）</summary>
              <ul class="bullets">${a.quotes.map((q) => `<li>〔${esc(q.source_id)}〕${esc(truncate(q.quote, 180))}</li>`).join('')}</ul></details>` : ''}
          </div>`).join('')}
        ${renderSources(p.sources || [], { title: '来源' })}
        ${renderToolRuns(p.tool_runs || [])}
        ${p.as_of ? `<p class="chat-asof">数据截至 ${esc(shortDate(p.as_of))}${p.mode === 'db+web' ? '｜库内 + 联网证据' : ''}</p>` : ''}
        ${chatTechDetails(p)}
      </div>
    </div>`;
  }).join('');
  log.scrollTop = log.scrollHeight;
}

/** 只展示实际执行的只读阶段（查库/联网/行情/计算），不展示思维链或内部提示。 */
function renderToolRuns(runs) {
  if (!Array.isArray(runs) || !runs.length) return '';
  const label = {
    search_library: '查库', get_library_record: '读库内详情', market_prices: '查行情',
    market_statistics: '程序统计', web_search: '联网检索', web_fetch: '抓取正文',
    estimate_emissions: '程序估算',
  };
  return `<details class="chat-tools"><summary>本轮工具（${runs.length}）</summary>
    <ul class="bullets">${runs.map((r) => `<li>${r.ok ? chip('完成', 'ok') : chip('未完成', 'warn')} <b>${esc(label[r.tool] || r.tool)}</b>
      ${r.summary ? `｜${esc(truncate(r.summary, 140))}` : ''}${r.latency_ms ? ` <span class="muted">${num(r.latency_ms)} ms</span>` : ''}</li>`).join('')}</ul>
  </details>`;
}

/**
 * 检索/技术注记收进折叠「检索详情」（docs/47）：
 * 检索条数、是否联网、短追问合并等属于技术说明，默认收起，不占正文空间。
 * 免责声明在问答面板只保留一次（见 chatPanel 的 #chat-status），不在每条答复里重复。
 */
function chatTechDetails(p) {
  const notes = Array.isArray(p.notes) ? p.notes.filter(Boolean) : [];
  const r = p.retrieval || {};
  const rows = [];
  if (r.evidence_count !== undefined) rows.push(`证据条数 ${r.evidence_count}`);
  if (r.web_used !== undefined) rows.push(`联网检索 ${r.web_used ? '已使用' : '未使用'}`);
  if (r.tool_call_count !== undefined) rows.push(`工具调用 ${r.tool_call_count} 次`);
  if (p.as_of) rows.push(`数据截至 ${p.as_of}`);
  if (p.mode) rows.push(`检索方式 ${({ db: '库内证据', web: '联网核实', 'db+web': '库内 + 联网' })[p.mode] || p.mode}`);
  if (p.latency_ms) rows.push(`本机耗时 ${p.latency_ms} ms`);
  if (!notes.length && !rows.length) return '';
  return `<details class="chat-tech"><summary>检索详情</summary>
    ${rows.length ? `<p class="muted">${esc(rows.join('｜'))}</p>` : ''}
    ${notes.length ? `<ul class="bullets">${notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
  </details>`;
}

function marketRangeHref(source) {
  const d = source.drill;
  if (source.entity_type !== 'program_summary' || d?.kind !== 'market_range'
    || !['cea', 'ccer'].includes(d.market)
    || !/^\d{4}-\d{2}-\d{2}$/.test(d.from || '') || !/^\d{4}-\d{2}-\d{2}$/.test(d.to || '')) return null;
  return '#/trades?' + new URLSearchParams({ variety: d.market, from: d.from, to: d.to, granularity: 'year' });
}

function renderSources(sources, { title = '来源' } = {}) {
  if (!sources.length) return '';
  return `<div class="chat-sources">
    <div class="chat-sources-title">${esc(title)}（${sources.length}）</div>
    <ul class="bullets">
      ${sources.map((s) => `<li>
        <span class="chip ${s.origin === 'db' || s.origin === 'calc' ? 'chip-plain' : 'chip-warn'}" title="${esc(s.kind_label || '')}">${esc(s.origin_label || (s.origin === 'db' ? '库内证据' : s.origin === 'calc' ? '程序计算' : '联网检索'))}</span>
        ${s.url ? `<a class="link" href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">${esc(truncate(s.title || s.url, 60))}</a>` : `<span>${esc(truncate(s.title || s.source_id, 60))}</span>`}
        ${marketRangeHref(s) ? `<a class="link" href="${esc(marketRangeHref(s))}">查看区间行情</a>` : ''}
        <span class="muted">${s.published_at ? `发布 ${esc(shortDate(s.published_at))}` : '发布日期未标注'}${s.collected_at ? `｜采集 ${esc(shortDate(s.collected_at))}` : ''}</span>
        <span class="muted">｜${esc(s.kind_label || (s.kind === 'full_text' ? '已获取正文' : s.kind === 'search_snippet' ? '搜索摘要（非全文）' : '来源摘要（非全文）'))}</span>
        ${s.source_display ? `｜<span class="muted">${esc(s.source_display.kind === 'official' ? `官方信息（${s.source_display.official_label || ''}）` : s.source_display.label || '')}</span>` : ''}
      </li>`).join('')}
    </ul>
  </div>`;
}

export { chip, loading, emptyState, toast };

