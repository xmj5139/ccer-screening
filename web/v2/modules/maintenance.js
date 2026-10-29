/**
 * 后台「运行与内容维护」（docs/44 第 4、5 条）
 * ============================================================================
 * 原「总览」页的**自动运行状态**与**数据缺口**两个版块移到这里，仅管理员可见；
 * 总览接口本身不再返回运行告警与缺口细节，普通用户直接请求相关接口也会 403。
 *
 * 本页提供**实际可用**的处理方式：
 *   1. 运行状态：数据截至、最近同步、失败任务数（只读，如实展示）；
 *   2. 缺口原因：逐条列出原因 / 影响 / 自动处理方式，并可发起有界重试；
 *   3. 内容修订：按实体类型选择记录，编辑标题/摘要/来源链接等**白名单字段**，
 *      提交前有确认与字段校验，提交后有结果提示；修订写入**覆盖层**并标记
 *      「管理员修订」，不覆盖原始快照与官方数值，历史可恢复；
 *   4. 摘要：查看覆盖状态并有界补齐（未配置模型时如实显示 0 条，不伪造）；
 *   5. 官方域名登记：官方来源判定的唯一依据（hostname 精确 / 受控子域）。
 */
import { api } from '../app.js';
import {
  card, table, loading, emptyState, errorState, noteBlock, esc, shortDate, dateTime, chip,
  kv, toast, num, truncate, drawer,
} from '../ui.js';
import {
  datalistHtml, editFieldControl, fallbackFormOptions, loadFormOptions,
} from '../form-selects.js';

let summaryPoll = null;

export async function renderMaintenance(body, q = {}) {
  stopSummaryPoll();
  body.innerHTML = loading('正在加载运行与内容维护…');
  let d;
  let adminOptions;
  try {
    const [overview, formOptions] = await Promise.all([
      api('/api/v2/admin/maintenance/overview'),
      loadFormOptions(api).catch(() => fallbackFormOptions()),
    ]);
    d = overview;
    adminOptions = formOptions.admin;
  } catch (e) {
    body.innerHTML = errorState(e);
    return;
  }
  const run = d.run || {};
  const gaps = d.gaps || { items: [] };
  const sum = d.summaries || {};
  const ingest = d.ingest_summary || {};
  const chat = d.chat || {};

  body.innerHTML = `
  <div class="banner banner-info">本页内容仅管理员可见：总览页不返回运行告警、缺口细节与核验统计；普通用户直接请求相关接口会返回 403。</div>

  <div class="grid-2">
    ${card({
      title: '运行状态',
      subtitle: `数据截至 ${esc(shortDate(run.data_as_of))}｜最近成功同步 ${esc(dateTime(run.last_success_sync))}`,
      actions: '<button class="btn btn-sm" data-maint-refresh>刷新</button>',
      body: `
        <div class="metrics metrics-sm">
          ${mini('公开内容条目', run.counts?.content_items ?? 0, '条', '不含演示与转载副本')}
          ${mini('未结清差异', run.counts?.open_issues ?? 0, '条', '自动运行状态，不产生人工待办')}
          ${mini('近 2 日失败任务', run.failed_jobs_2d ?? 0, '次', '可在此发起有界重试')}
          ${mini('未结清缺口', gaps.open ?? 0, '项', '见下方缺口原因')}
        </div>
        ${run.alert ? `<div class="callout callout-warn"><b>告警</b><p>${esc(run.alert)}</p></div>` : '<p class="hint">当前没有新的运行告警。</p>'}
        <p class="hint">运行状态只作提示与检索，不会自动覆盖官方数值，也不进入公开总览。</p>`,
    })}
    ${card({
      title: '有界重试',
      subtitle: '调用既有采集/摘要入口；未配置凭据时如实返回失败原因，不伪造成功',
      body: `
        <ul class="list">${(RETRY_TARGETS).map((t) => `<li>
          <div class="list-head"><b>${esc(t.label)}</b>
            <span class="right"><button class="btn btn-sm" data-retry="${esc(t.key)}">重试</button></span></div>
          <p class="hint">${esc(t.hint)}</p>
        </li>`).join('')}</ul>
        <div id="retry-result"></div>`,
    })}
  </div>

  ${card({
    title: '数据缺口与原因',
    subtitle: `共 ${gaps.total ?? 0} 项，未结清 ${gaps.open ?? 0} 项｜按下载、解析、摘要、核验、冲突、非目标页等确定性分类`,
    actions: '<button class="btn btn-sm" data-gap-triage>重新分类</button>',
    body: (gaps.items || []).length
      ? `${(gaps.optional_field_anomalies || []).length ? `<div class="callout callout-info"><b>可选字段异常不阻塞整条记录</b>
          <p>${num(gaps.optional_field_anomalies.length)} 条企业名录的原始信用代码未通过 18 位/校验位规则：标准代码留空、原始值保留，企业名称仍计入名录；未关闭任何真实缺口。</p></div>` : ''}
        <ul class="list">${gaps.items.map((g) => {
          const t = g.triage || {};
          const tone = t.tone || (g.severity === 'critical' ? 'danger' : 'warn');
          const isClosed = g.status === 'closed' || g.status === 'resolved';
          const isActive = g.status === 'open';
          const isNonTarget = t.category === 'non_target' || g.classification === 'non_target';
          const statusText = isClosed ? '历史已结清'
            : g.status === 'mitigated' ? (isNonTarget ? '非目标页已排除' : '已缓解/继续跟踪')
              : '未结清';
          const statusTone = isClosed ? 'ok' : g.status === 'mitigated' ? 'muted' : 'warn';
          const actions = isActive ? (t.supported_actions || []).map((a) =>
            `<button class="btn btn-xs" data-gap-action="${esc(a.key)}" data-gap-id="${esc(g.id)}" title="${esc(a.description || '')}">${esc(a.label)}</button>`).join(' ') : '';
          return `<li>
          <div class="list-head"><b>${esc(g.title)}</b>
            ${chip(t.label || '未分类', tone)}
            ${isActive ? chip(t.blocking ? '阻塞核心数据' : '非阻塞', t.blocking ? 'warn' : 'muted') : ''}
            ${chip(statusText, statusTone)}
          </div>
          <p class="muted">原因：${esc(g.reason || '—')}</p>
          <p class="muted">影响：${esc(g.impact || '—')}</p>
          <p class="hint">${isClosed ? '历史依据' : '依据'}：${esc((t.basis || []).join('；') || '—')}</p>
          ${isActive ? `<p class="hint">自动处理：${esc(t.auto_action || g.auto_action || '由每日自动任务重试与补全')}</p>` : ''}
          ${isActive && t.unsupported_reason ? `<p class="hint">没有可执行动作：${esc(t.unsupported_reason)}</p>` : ''}
          ${actions ? `<div class="row-actions">${actions}</div>` : ''}
          ${g.last_action ? `<p class="hint">${isClosed ? '结清记录' : '上次动作'}：${esc(g.last_action)}｜${esc(dateTime(g.last_action_at))}｜${esc(truncate(g.last_action_result || '—', 180))}</p>` : ''}
        </li>`;
        }).join('')}</ul>
        ${(gaps.non_target_exclusions || []).length ? `<details class="tech-details"><summary>CEA 非目标页排除记录（${gaps.non_target_exclusions.length}）</summary>
          <div class="tech-details-body"><ul class="bullets">${gaps.non_target_exclusions.slice(0, 12).map((x) => `<li><a class="link" href="${esc(x.url)}" target="_blank" rel="noreferrer noopener">${esc(truncate(x.url, 72))}</a>｜规则 <code>${esc(x.rule)}</code>｜快照 ${esc(x.snapshot_id || '—')}</li>`).join('')}</ul></div></details>` : ''}
        <div id="gap-action-result"></div>`
      : emptyState('没有缺口记录'),
    note: gaps.note,
  })}

  ${card({
    title: '入库摘要队列',
    subtitle: ingest.enabled ? `已启用｜${Math.round((ingest.config?.interval_ms || 0) / 1000)} 秒周期｜单批 ≤${ingest.config?.batch_size || 3} 条 / ${Math.round((ingest.config?.budget_ms || 0) / 1000)} 秒｜与每日 06:30 调度独立` : `未启用｜${ingest.worker?.env_disabled ? '环境变量已停用（后台不可覆盖）' : '后台开关已暂停'}`,
    actions: `<button class="btn btn-sm ${ingest.enabled ? '' : 'btn-primary'}" data-ingest-toggle="${ingest.enabled ? 'off' : 'on'}" ${ingest.worker?.env_disabled && !ingest.enabled ? 'disabled' : ''}>${ingest.enabled ? '暂停队列' : '启用队列'}</button>
      <button class="btn btn-sm" data-ingest-backfill>补入漏队项</button>
      <button class="btn btn-sm" data-ingest-retry>重试失败/阻塞</button>`,
    body: `
      <div class="metrics metrics-sm">
        ${mini('待处理', (ingest.counts?.queued || 0) + (ingest.counts?.failed || 0) + (ingest.counts?.blocked || 0), '条', `当前可领取 ${ingest.due ?? 0} 条`)}
        ${mini('运行中', ingest.counts?.running ?? 0, '条', ingest.worker?.running ? 'worker 正在处理' : '当前无运行任务')}
        ${mini('已生成', ingest.counts?.succeeded ?? 0, '条', '摘要阶段完成，不代表核验通过')}
        ${mini('失败/阻塞', (ingest.counts?.failed || 0) + (ingest.counts?.blocked || 0) + (ingest.counts?.dead || 0), '条', `尝试上限 ${ingest.config?.max_attempts || 5} 次`)}
        ${mini('已失效/替换', ingest.counts?.superseded ?? 0, '条', '输入签名或模型键变化，旧任务不调用')}
      </div>
      <p class="hint">队列按“实际输入哈希 + 提示词版本 + 模型键”去重；摘要队列不读取页面、不在 GET 调模型。租约忙或进程重启只延后，不消耗真实失败次数。${ingest.worker?.last_error ? `最近错误：${esc(ingest.worker.last_error)}` : ''}</p>
      ${(ingest.recent || []).length ? table({
        rows: ingest.recent,
        pageSize: 8,
        columns: [
          { key: 'entity_id', label: '条目', render: (r) => `<code>${esc(truncate(r.entity_id, 24))}</code>` },
          { key: 'status', label: '状态', render: (r) => chip({ queued: '排队', running: '运行中', succeeded: '已生成', failed: '失败待重试', blocked: '阻塞', dead: '达到上限', superseded: '已失效' }[r.status] || r.status, r.status === 'succeeded' ? 'ok' : r.status === 'running' ? 'accent' : r.status === 'dead' ? 'danger' : 'warn') },
          { key: 'attempts', label: '尝试', align: 'right', render: (r) => `${r.attempts}/${r.max_attempts}` },
          { key: 'last_error', label: '失败原因', render: (r) => esc(truncate(r.last_error || '—', 46)) },
          { key: 'next_attempt_at', label: '下次重试', render: (r) => esc(r.next_attempt_at ? dateTime(r.next_attempt_at) : '—') },
          { key: 'updated_at', label: '更新时间', render: (r) => esc(dateTime(r.updated_at)) },
        ],
        emptyText: '尚未有入库摘要任务；新内容入库后自动出现',
      }) : emptyState('尚未有入库摘要任务', '新内容入库后自动入队；只有标题、演示、转载副本与失败抓取不会入队。')}
      <div id="ingest-result"></div>`,
    note: '摘要成功只表示摘要阶段完成。正文范围与来源继续在详情中如实展示；不能把仅有来源摘要写成阅读全文。',
  })}

  ${card({
    title: '核心摘要覆盖',
    subtitle: `提示词版本 ${esc(sum.prompt_version || '—')}｜模型 ${sum.model_configured ? esc(sum.provider?.model || sum.provider?.id || '已配置') : '未配置'}${sum.running_task ? `｜有任务在执行：${esc(sum.running_task.status)}` : ''}`,
    actions: '<button class="btn btn-sm btn-primary" data-summary-run>补齐一批（后台任务）</button>',
    body: `
      <div class="metrics metrics-sm">
        ${mini('有效条目', sum.totals?.entities ?? 0, '条', '已排除演示/失败抓取/转载副本')}
        ${mini('已生成摘要', sum.totals?.covered ?? 0, '条', `覆盖率 ${sum.coverage_ratio === null || sum.coverage_ratio === undefined ? '—' : `${(sum.coverage_ratio * 100).toFixed(1)}%`}`)}
        ${mini('未生成', sum.totals?.missing ?? 0, '条', '按持久游标轮转补齐')}
        ${mini('抽样失效', sum.totals?.stale ?? 0, '条', `抽样 ${sum.totals?.stale_sampled ?? 0} 条`)}
        ${mini('无模型跳过', sum.totals?.skipped ?? 0, '条', '如实记录，不伪造模型摘要')}
      </div>
      ${table({
        rows: Object.entries(sum.per_entity || {}).map(([k, v]) => ({ entity_type: k, ...v })),
        pageSize: 12,
        columns: [
          { key: 'label', label: '实体类型' },
          { key: 'entity_total', label: '有效条目', align: 'right' },
          { key: 'covered', label: '已生成', align: 'right' },
          { key: 'missing', label: '未生成', align: 'right' },
          { key: 'stale_sampled', label: '抽样失效', align: 'right' },
          { key: 'skipped', label: '无模型跳过', align: 'right' },
          { key: 'cursor', label: '游标', align: 'right' },
          { key: 'actions', label: '操作', render: (r) => `<button class="btn btn-xs" data-summary-run="${esc(r.entity_type)}">补齐该类型</button>` },
        ],
        emptyText: '尚无可统计实体',
      })}
      <div id="summary-result">${sum.running_task ? `<div class="callout callout-warn"><b>已有任务在执行</b><p>任务 ${esc(sum.running_task.id)}（${esc(sum.running_task.status)}）。全局单并发：完成前不会重复发起。</p></div>` : ''}</div>
      ${(sum.recent_tasks || []).length ? `<h5>最近任务</h5>${table({
        rows: sum.recent_tasks,
        pageSize: 5,
        columns: [
          { key: 'id', label: '任务', render: (r) => `<code>${esc(truncate(r.id, 20))}</code>` },
          { key: 'status', label: '状态', render: (r) => chip(r.status, r.status === 'success' ? 'ok' : r.status === 'failed' ? 'danger' : 'warn') },
          { key: 'scope', label: '范围', render: (r) => esc(r.entity_type || '全部类型') },
          { key: 'generated', label: '生成', align: 'right' },
          { key: 'failed', label: '失败', align: 'right' },
          { key: 'skipped', label: '跳过', align: 'right' },
          { key: 'created_at', label: '发起', render: (r) => esc(dateTime(r.created_at)) },
        ],
      })}` : ''}
      ${noteBlock(sum.note)}`,
  })}

  ${card({
    title: '公开内容修订（覆盖层）',
    subtitle: '只写管理员修订覆盖层并标记「管理员修订」；原始快照与官方数值不被改写，历史可恢复',
    body: `
      <div class="filters">
        <label class="fld"><span>实体类型</span><select id="edit-type">${(d.edit_types || []).map((t) => `<option value="${esc(t.key)}">${esc(t.label)}</option>`).join('')}</select></label>
        <label class="fld"><span>关键词</span><input type="search" id="edit-q" placeholder="按标题筛选"></label>
        <span class="fld-actions"><button class="btn btn-sm" id="edit-search">查询</button></span>
      </div>
      <div id="edit-list">${emptyState('选择实体类型后点击查询')}</div>
      <div id="edit-form"></div>
      <div id="edit-result"></div>`,
  })}

  ${card({
    title: '修订历史与恢复',
    subtitle: '每条修订记录修改前后值与操作者；superseded 为历史版本，可恢复到任意历史值',
    body: `<div id="revision-list">${emptyState('在下方查询修订历史', '可按实体 ID 过滤')}</div>
      <div class="filters">
        <label class="fld"><span>实体 ID</span><input type="search" id="rev-id" placeholder="留空显示全部"></label>
        <span class="fld-actions"><button class="btn btn-sm" id="rev-search">查询历史</button></span>
      </div>`,
  })}

  ${card({
    title: '官方域名登记（官方来源判定依据）',
    subtitle: '只按 hostname 精确 / 受控子域匹配；不使用 contains、不使用 .gov.cn 字符串包含、不由模型判断',
    body: `
      ${table({
        rows: d.official_domains || [],
        pageSize: 20,
        columns: [
          { key: 'domain', label: '域名' },
          { key: 'label', label: '机构' },
          { key: 'kind', label: '类型' },
          { key: 'match_mode', label: '匹配方式', render: (r) => (r.match_mode === 'exact' ? '仅精确 hostname' : '精确 + 受控子域') },
          { key: 'enabled', label: '启用', render: (r) => (r.enabled ? chip('启用', 'ok') : chip('停用', 'warn')) },
        ],
        emptyText: '尚无登记',
      })}
      <div class="filters">
        <label class="fld"><span>域名</span><input type="search" id="dom-domain" placeholder="例如 mee.gov.cn"></label>
        <label class="fld"><span>机构</span><input type="search" id="dom-label" placeholder="例如 生态环境部" list="dom-label-options">${datalistHtml('dom-label-options', adminOptions.sources, '')}</label>
        <label class="fld"><span>类型</span><select id="dom-kind"><option value="official">政府/主管机构</option><option value="registry">登记系统</option><option value="exchange">交易机构</option></select></label>
        <label class="fld"><span>匹配</span><select id="dom-mode"><option value="subdomain">精确 + 受控子域</option><option value="exact">仅精确 hostname</option></select></label>
        <span class="fld-actions"><button class="btn btn-sm btn-primary" id="dom-save">保存</button><button class="btn btn-sm" id="dom-seed">补种内置登记</button></span>
      </div>
      <p class="hint">第三方转载官方内容不会命中本表，因此不会显示为「官方信息」。来源统计抽样：官方 ${d.source_stats?.counts?.official ?? 0}｜第三方 ${d.source_stats?.counts?.third_party ?? 0}｜未标注 ${d.source_stats?.counts?.unknown ?? 0}。</p>`,
  })}

  ${card({
    title: '平台问答运行情况',
    subtitle: `问答 ${chat.totals?.total ?? 0} 次｜拒答 ${chat.totals?.refused ?? 0} 次｜联网 ${chat.totals?.web_used ?? 0} 次｜模型调用 ${chat.totals?.model_used ?? 0} 次｜当前并发 ${chat.in_flight_total ?? 0}/${chat.limits?.total_concurrent ?? '—'}`,
    body: table({
      rows: chat.recent || [],
      pageSize: 10,
      columns: [
        { key: 'created_at', label: '时间', render: (r) => esc(dateTime(r.created_at)) },
        { key: 'user_name', label: '提问人' },
        { key: 'question', label: '问题', render: (r) => esc(truncate(r.question, 40)) },
        { key: 'mode', label: '模式' },
        { key: 'evidence_count', label: '证据', align: 'right' },
        { key: 'web_used', label: '联网', render: (r) => (r.web_used ? '是' : '否') },
        { key: 'refused', label: '结果', render: (r) => (r.refused ? chip(`拒答：${r.refuse_reason || ''}`, 'warn') : chip('已答复', 'ok')) },
        { key: 'latency_ms', label: '耗时(ms)', align: 'right' },
      ],
      emptyText: '尚无问答记录',
    }),
    note: chat.note,
  })}`;

  await bindMaintenance(body, d, q, adminOptions);
}

const RETRY_TARGETS = [
  { key: 'trade', label: 'CCER 每日行情（官方公告）', hint: '按官方公告页重新采集最近交易日行情' },
  { key: 'policy', label: '官方政策巡检', hint: '巡检已登记官方政策页面并归档原文' },
  { key: 'content', label: '研报与动态检索', hint: '用已配置搜索服务执行一次有界检索发现' },
  { key: 'summaries', label: '核心摘要补齐', hint: '对缺失/失效摘要执行一次有界批次生成' },
];

function mini(label, value, unit, sub) {
  return `<div class="mini"><span class="mini-label">${esc(label)}</span>
    <span class="mini-value">${esc(num(value))}<i>${esc(unit || '')}</i></span>
    <span class="mini-sub">${esc(sub || '')}</span></div>`;
}

function stopSummaryPoll() {
  if (summaryPoll) { clearTimeout(summaryPoll); summaryPoll = null; }
}

async function bindMaintenance(body, d, q = {}, adminOptions = fallbackFormOptions().admin) {
  body.querySelector('[data-maint-refresh]')?.addEventListener('click', () => renderMaintenance(body));

  // 有界重试
  body.querySelectorAll('[data-retry]').forEach((btn) => btn.addEventListener('click', async () => {
    const box = body.querySelector('#retry-result');
    const target = btn.dataset.retry;
    btn.disabled = true;
    const old = btn.textContent;
    btn.textContent = '执行中…';
    if (box) box.innerHTML = `<p class="hint">正在执行「${esc(target)}」有界重试…</p>`;
    try {
      const out = await api('/api/v2/admin/maintenance/retry', { method: 'POST', body: { target, limit: 5 } });
      const ok = out.ok !== false;
      if (box) {
        box.innerHTML = `<div class="callout ${ok ? 'callout-ok' : 'callout-warn'}">
          <b>${ok ? '已完成' : '未成功'}</b>
          <p>${esc(out.message || out.error || JSON.stringify(out).slice(0, 300))}</p>
          <p class="hint">结果已写入任务/审计，可在「任务与快照」「操作日志」中核对。</p></div>`;
      }
      toast(ok ? '重试已完成' : '重试未成功（原因见页面）', ok ? 'ok' : 'warn');
      renderMaintenance(body);
    } catch (e) {
      if (box) box.innerHTML = errorState(e);
      toast(e.body?.error || e.message, 'danger');
    } finally {
      btn.disabled = false;
      btn.textContent = old;
    }
  }));

  // 缺口受控动作：只提交一个明确动作；服务端返回真实执行结果，失败不伪造结清
  const gapResult = () => body.querySelector('#gap-action-result');
  body.querySelectorAll('[data-gap-action]').forEach((btn) => btn.addEventListener('click', async () => {
    const id = btn.dataset.gapId;
    const action = btn.dataset.gapAction;
    const box = gapResult();
    btn.disabled = true;
    const old = btn.textContent;
    btn.textContent = '执行中…';
    if (box) box.innerHTML = `<p class="hint">正在执行「${esc(old)}」…</p>`;
    try {
      const out = await api(`/api/v2/admin/maintenance/gaps/${encodeURIComponent(id)}/action`, {
        method: 'POST', body: { action },
      });
      const ok = out.ok !== false;
      if (box) {
        box.innerHTML = `<div class="callout ${ok ? 'callout-ok' : 'callout-warn'}">
          <b>${ok ? '动作已执行' : '动作未成功/未结清'}</b>
          <p>${esc(out.message || out.error || '—')}</p>
          <p class="hint">状态：${esc(out.status || '—')}｜${out.closed ? '已按同一对象证据结清' : '缺口保持，除非同一对象证据已真实修复'}</p>
        </div>`;
      }
      toast(ok ? '动作已执行（结果以页面为准）' : '动作未成功，缺口未结清', ok ? 'ok' : 'warn');
      if (out.closed || out.status === 'mitigated') setTimeout(() => renderMaintenance(body), 1400);
    } catch (e) {
      if (box) box.innerHTML = errorState(e);
      toast(e.body?.error || e.message, 'danger');
    } finally {
      btn.disabled = false;
      btn.textContent = old;
    }
  }));
  body.querySelector('[data-gap-triage]')?.addEventListener('click', async (ev) => {
    const btn = ev.currentTarget;
    btn.disabled = true;
    try {
      const out = await api('/api/v2/admin/maintenance/gaps/triage', {
        method: 'POST', body: { status: 'all', limit: 300 },
      });
      toast(`已重新分类 ${out.total || 0} 条缺口`, 'ok');
      renderMaintenance(body);
    } catch (e) {
      toast(e.body?.error || e.message, 'danger');
      btn.disabled = false;
    }
  });

  // 入库摘要队列：开关 / 有界补入 / 有界重试失败项
  const ingestBox = () => body.querySelector('#ingest-result');
  const runIngestAction = async (btn, path, payload, label) => {
    const box = ingestBox();
    btn.disabled = true;
    const old = btn.textContent;
    btn.textContent = '执行中…';
    if (box) box.innerHTML = `<p class="hint">正在执行「${esc(label)}」…</p>`;
    try {
      const out = await api(path, { method: 'POST', body: payload });
      const q = out.queue_status || out.status || {};
      if (box) {
        box.innerHTML = `<div class="callout callout-ok"><b>${esc(label)}已执行</b>
          <p>${esc(out.message || (out.queued !== undefined ? `补入 ${out.queued} 条，跳过 ${out.skipped || 0} 条` : out.reset !== undefined ? `重入 ${out.reset} 条` : `队列已${out.enabled ? '启用' : '暂停'}`))}</p>
          <p class="hint">队列状态：待处理 ${(q.counts?.queued || 0) + (q.counts?.failed || 0) + (q.counts?.blocked || 0)} 条｜运行中 ${q.counts?.running || 0} 条。动作结果来自服务端实际执行。</p></div>`;
      }
      toast(`${label}完成`, 'ok');
      setTimeout(() => renderMaintenance(body), 1600);
    } catch (e) {
      if (box) box.innerHTML = `<div class="callout callout-warn"><b>${esc(label)}未成功</b><p>${esc(e.body?.error || e.message)}</p></div>`;
      toast(e.body?.error || e.message, 'danger');
      btn.disabled = false;
      btn.textContent = old;
    }
  };
  body.querySelector('[data-ingest-toggle]')?.addEventListener('click', (ev) => {
    const btn = ev.currentTarget;
    runIngestAction(btn, '/api/v2/admin/summaries/queue/toggle', { enabled: btn.dataset.ingestToggle === 'on' },
      btn.dataset.ingestToggle === 'on' ? '启用队列' : '暂停队列');
  });
  body.querySelector('[data-ingest-backfill]')?.addEventListener('click', (ev) =>
    runIngestAction(ev.currentTarget, '/api/v2/admin/summaries/queue/backfill', { limit: 20 }, '补入漏队项'));
  body.querySelector('[data-ingest-retry]')?.addEventListener('click', (ev) =>
    runIngestAction(ev.currentTarget, '/api/v2/admin/summaries/queue/retry', { limit: 5 }, '重试失败/阻塞任务'));

  // 摘要批次：**异步任务 + 轮询**（202 + task_id）；全局单并发，按钮连点返回 409
  const runSummary = async (entityType) => {
    const box = body.querySelector('#summary-result');
    if (box) box.innerHTML = '<p class="hint">正在提交后台摘要任务（不同步等待批次，避免长请求超时）…</p>';
    let taskId = null;
    try {
      const out = await api('/api/v2/admin/summaries/run', {
        method: 'POST',
        body: { entity_type: entityType || null, limit: 8 },
      });
      taskId = out.task_id;
    } catch (e) {
      if (e.status === 409) {
        if (box) box.innerHTML = `<div class="callout callout-warn"><b>已有任务在执行</b><p>${esc(e.body?.message || '全局单并发：请等待当前任务完成')}</p></div>`;
        toast('已有摘要任务在执行中', 'warn');
        return;
      }
      if (box) box.innerHTML = errorState(e);
      toast(e.body?.error || e.message, 'danger');
      return;
    }
    // 轮询任务状态（有界：最多 60 次 × 2 秒）
    let tries = 0;
    const poll = async () => {
      tries += 1;
      let t = null;
      try {
        const r = await api(`/api/v2/admin/summaries/tasks/${encodeURIComponent(taskId)}`);
        t = r.task;
      } catch (e) {
        if (box) box.innerHTML = errorState(e);
        return;
      }
      if (box) {
        box.innerHTML = `<div class="callout callout-info"><b>任务 ${esc(t.status)}</b>
          <p>${esc(t.id)}｜范围 ${esc(t.entity_type || '全部类型')}｜生成 ${num(t.generated)}｜失败 ${num(t.failed)}｜跳过 ${num(t.skipped)}</p>
          <p class="hint">状态持久化；中断的任务会被标记为 interrupted，可重新发起。</p></div>`;
      }
      if (['success', 'partial', 'failed', 'interrupted'].includes(t.status) || tries >= 60) {
        if (t.status === 'success' || t.status === 'partial') toast(`摘要任务完成：生成 ${t.generated} 条`, t.generated ? 'ok' : 'warn');
        else toast(`摘要任务${t.status === 'interrupted' ? '中断' : '失败'}：${t.error || t.reason || ''}`, 'warn');
        renderMaintenance(body);
        return;
      }
      summaryPoll = setTimeout(poll, 2000);
    };
    poll();
  };
  body.querySelectorAll('button[data-summary-run]').forEach((btn) => btn.addEventListener('click', () => runSummary(btn.dataset.summaryRun || null)));

  // 内容修订
  const listBox = () => body.querySelector('#edit-list');
  const formBox = () => body.querySelector('#edit-form');
  const resultBox = () => body.querySelector('#edit-result');

  const loadEntities = async () => {
    const type = body.querySelector('#edit-type')?.value;
    const q = body.querySelector('#edit-q')?.value || '';
    if (!listBox()) return;
    listBox().innerHTML = loading('正在查询…');
    try {
      const out = await api(`/api/v2/admin/maintenance/entities?entity_type=${encodeURIComponent(type)}&q=${encodeURIComponent(q)}&limit=20`);
      const group = out.entities?.[type];
      const rows = group?.rows || [];
      listBox().innerHTML = rows.length
        ? table({
          rows,
          pageSize: 10,
          columns: [
            { key: 'title', label: '记录' },
            { key: 'id', label: 'ID', render: (r) => `<code>${esc(truncate(r.id, 28))}</code>` },
            { key: 'manual_revision', label: '管理员修订', render: (r) => (r.manual_revision ? chip(`已修订：${(r.manual_fields || []).join('、')}`, 'warn') : '—') },
            { key: 'actions', label: '操作', render: (r) => `<button class="btn btn-xs" data-edit="${esc(r.id)}">编辑</button>` },
          ],
          emptyText: '没有匹配记录',
        })
        : emptyState('没有匹配记录', '可更换关键词');
      listBox().querySelectorAll('[data-edit]').forEach((btn) => btn.addEventListener('click', () => openEditForm(type, btn.dataset.edit)));
    } catch (e) {
      listBox().innerHTML = errorState(e);
    }
  };

  const openEditForm = async (type, id) => {
    if (!formBox()) return;
    formBox().innerHTML = loading('正在读取当前值与字段白名单…');
    let p;
    try {
      p = await api('/api/v2/admin/maintenance/preview', { method: 'POST', body: { entity_type: type, entity_id: id } });
    } catch (e) {
      formBox().innerHTML = errorState(e);
      return;
    }
    const fields = p.fields || [];
    const cur = p.current || {};
    formBox().innerHTML = card({
      title: `编辑：${esc(truncate(cur[p.fields?.find((f) => f.key === 'title') ? 'title' : 'id'] || cur.id, 40))}`,
      subtitle: '只有下列白名单字段可修订；省份/地区/领域为有限选项，方法学与机构可自由输入，URL 保留原值；含脚本载荷的值会被服务端拒绝',
      body: `
        <div class="edit-grid">
          ${fields.map((f) => `<label class="fld"><span>${esc(f.label)}</span>
            ${editFieldControl(f, cur[f.key] === null || cur[f.key] === undefined ? '' : cur[f.key], adminOptions)}
            ${cur.original_values && f.key in (cur.original_values || {}) ? `<span class="hint">原始采集值：${esc(cur.original_values[f.key] ?? '（空）')}</span>` : ''}
          </label>`).join('')}
        </div>
        ${datalistHtml('edit-methodology-options', adminOptions.methodologies, cur.methodology_id || '', { currentSuffix: '（当前值）' })}
        ${datalistHtml('edit-source-options', adminOptions.sources, cur.issuing_authority || cur.publisher || cur.issuer || '', { currentSuffix: '（当前值）' })}
        ${datalistHtml('edit-year-options', adminOptions.years, cur.data_year || '', { currentSuffix: '（当前值）' })}
        <label class="fld"><span>修订说明（写入审计）</span><input data-edit-note type="text" maxlength="500" placeholder="例如：修正来源链接为官方原文"></label>
        <div class="edit-actions">
          <button class="btn btn-primary" data-edit-submit>提交修订</button>
          <button class="btn" data-edit-cancel>取消</button>
        </div>
        <p class="hint">提交后写入**覆盖层**并标记「管理员修订」；原始快照与官方数值不会被覆盖，可在「修订历史」中恢复。</p>`,
    });
    formBox().querySelector('[data-edit-cancel]')?.addEventListener('click', () => { formBox().innerHTML = ''; });
    formBox().querySelector('[data-edit-submit]')?.addEventListener('click', async (ev) => {
      const fieldsToSend = {};
      formBox().querySelectorAll('[data-edit-field]').forEach((inp) => { fieldsToSend[inp.dataset.editField] = inp.value; });
      const note = formBox().querySelector('[data-edit-note]')?.value || null;
      const btn = ev.currentTarget;
      btn.disabled = true;
      btn.textContent = '提交中…';
      try {
        const out = await api('/api/v2/admin/maintenance/edit', {
          method: 'POST',
          body: { entity_type: type, entity_id: id, fields: fieldsToSend, note },
        });
        const box = resultBox();
        if (box) {
          box.innerHTML = `<div class="callout callout-ok"><b>已保存</b>
            <p>${esc(out.message || '')}</p>
            <ul class="bullets">${(out.revisions || []).map((r) => `<li><code>${esc(r.field_key)}</code>：${esc(String(r.original_value ?? '（空）'))} → <b>${esc(String(r.value ?? '（空）'))}</b>（第 ${r.revision_no} 次修订）</li>`).join('')}</ul>
            <p class="hint">已写入审计与修订历史，可恢复。</p></div>`;
        }
        toast('修订已保存（覆盖层，已标记管理员修订）', 'ok');
        loadEntities();
        formBox().innerHTML = '';
      } catch (e) {
        const box = resultBox();
        if (box) {
          box.innerHTML = `<div class="callout callout-warn"><b>提交未通过</b>
            <p>${esc(e.body?.error || e.message)}</p>
            ${(e.body?.issues || []).length ? `<ul class="bullets">${e.body.issues.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>` : ''}</div>`;
        }
        toast(e.body?.error || e.message, 'danger');
      } finally {
        btn.disabled = false;
        btn.textContent = '提交修订';
      }
    });
  };

  body.querySelector('#edit-search')?.addEventListener('click', loadEntities);

  // 修订历史
  const loadRevisions = async () => {
    const box = body.querySelector('#revision-list');
    const id = body.querySelector('#rev-id')?.value || '';
    if (!box) return;
    box.innerHTML = loading('正在查询…');
    try {
      const out = await api(`/api/v2/admin/maintenance/revisions?entity_id=${encodeURIComponent(id)}&limit=80`);
      const rows = out.revisions || [];
      box.innerHTML = rows.length
        ? table({
          rows,
          pageSize: 12,
          columns: [
            { key: 'created_at', label: '时间', render: (r) => esc(dateTime(r.created_at)) },
            { key: 'entity_type', label: '实体' },
            { key: 'entity_id', label: 'ID', render: (r) => `<code>${esc(truncate(r.entity_id, 24))}</code>` },
            { key: 'field_key', label: '字段' },
            { key: 'original_value', label: '修改前', render: (r) => esc(truncate(String(r.original_value ?? '（空）'), 30)) },
            { key: 'value', label: '修改后', render: (r) => esc(truncate(String(r.value ?? '（空）'), 30)) },
            { key: 'status', label: '状态', render: (r) => (r.status === 'active' ? chip('生效中', 'ok') : chip(r.status === 'reverted' ? '已回退到原始值' : '历史版本', 'muted')) },
            { key: 'actor', label: '操作者' },
            { key: 'actions', label: '恢复', render: (r) => `<button class="btn btn-xs" data-restore="${esc(r.id)}">恢复此版本</button>` },
          ],
          emptyText: '没有修订记录',
        })
        : emptyState('没有修订记录');
      box.querySelectorAll('[data-restore]').forEach((btn) => btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
          const out = await api(`/api/v2/admin/maintenance/revisions/${encodeURIComponent(btn.dataset.restore)}/restore`, { method: 'POST', body: {} });
          toast(`已恢复字段 ${out.field_key}`, 'ok');
          loadRevisions();
          loadEntities();
        } catch (e) {
          toast(e.body?.error || e.message, 'danger');
          btn.disabled = false;
        }
      }));
    } catch (e) {
      box.innerHTML = errorState(e);
    }
  };
  body.querySelector('#rev-search')?.addEventListener('click', loadRevisions);

  // 官方域名登记
  body.querySelector('#dom-save')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      await api('/api/v2/admin/maintenance/official-domains', {
        method: 'POST',
        body: {
          domain: body.querySelector('#dom-domain')?.value || '',
          label: body.querySelector('#dom-label')?.value || '',
          kind: body.querySelector('#dom-kind')?.value || 'official',
          match_mode: body.querySelector('#dom-mode')?.value || 'subdomain',
        },
      });
      toast('已保存官方域名登记', 'ok');
      renderMaintenance(body);
    } catch (err) {
      toast(err.body?.error || err.message, 'danger');
      btn.disabled = false;
    }
  });
  body.querySelector('#dom-seed')?.addEventListener('click', async (e) => {
    e.currentTarget.disabled = true;
    try {
      const out = await api('/api/v2/admin/maintenance/official-domains/seed', { method: 'POST', body: {} });
      toast(`已补种 ${out.added} 条内置登记`, 'ok');
      renderMaintenance(body);
    } catch (err) {
      toast(err.body?.error || err.message, 'danger');
    }
  });

  // 从信息治理详情跳转：预选实体并直接打开覆盖层编辑表单（不修改原始业务表）。
  if (q.entity_type && q.entity_id) {
    const typeEl = body.querySelector('#edit-type');
    if (typeEl && [...typeEl.options].some((o) => o.value === q.entity_type)) {
      typeEl.value = q.entity_type;
      await loadEntities();
      await openEditForm(q.entity_type, q.entity_id);
      body.querySelector('#edit-form')?.scrollIntoView({ block: 'start' });
    } else {
      const box = body.querySelector('#edit-form');
      if (box) {
        box.innerHTML = `<div class="callout callout-warn"><b>该资料类型没有覆盖层编辑入口</b>
          <p>${esc(q.entity_type)} 不在后台可编辑白名单内；请使用对应业务页面的维护入口，或回到治理详情查看。</p></div>`;
      }
    }
  }
}
