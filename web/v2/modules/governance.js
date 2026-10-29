/**
 * 后台「信息治理与历史补采」（docs/74 A/B/C）
 * ============================================================================
 * 复用既有维护/编辑/摘要/核验接口：本页只增加阶段漏斗、有界补处理、历史补采
 * 任务和版本关系候选入口；不新增人工审核流程。
 */
import { api, setQuery } from '../app.js';
import {
  card, esc, shortDate, dateTime, chip, toast, drawer, kv, loading, errorState, num, truncate,
} from '../ui.js';

const STAGE_LABEL = {
  discovered: '发现', fetched: '正文/附件', parsed: '解析/OCR', summarized: '摘要', verified: '核验',
};
const STATUS_LABEL = {
  done: '已完成', pending: '待处理', running: '处理中', failed: '失败',
  blocked: '阻塞/不可用', stale: '已失效', skipped: '不适用',
};
const TASK_LABEL = {
  queued: '排队中', running: '运行中', paused: '已暂停', cancelled: '已取消',
  completed: '已完成', partial: '部分完成', failed: '失败', interrupted: '已中断',
};
const TASK_TONE = {
  queued: 'chip-muted', running: 'chip-accent', paused: 'chip-warn', cancelled: 'chip-muted',
  completed: 'chip-ok', partial: 'chip-warn', failed: 'chip-danger', interrupted: 'chip-warn',
};
const REL_LABEL = {
  supersedes: '替代', revises: '修订', replaces: '取代', repeals: '废止', consults: '征求意见', supplements: '补充',
};
const TYPE_LABEL = {
  content_item: '研报动态', policy_document: '政策文件', methodology_version: '方法学版本',
  cea_document: 'CEA 文件', accounting_standard: '标准规范',
  accounting_public_document: '公开资料/问答', public_project: '公开项目',
};
const UPLOAD_KIND = {
  policy_document: 'policy', methodology_version: 'methodology', cea_document: 'cea_document',
};

function typeChip(item) {
  return `<span class="chip chip-muted">${esc(item.type_label || TYPE_LABEL[item.object_type] || item.object_type)}</span>`;
}

let activeGovernanceCleanup = null;

function statusChip(status, map = STATUS_LABEL) {
  const tone = {
    done: 'ok', running: 'accent', pending: 'muted', failed: 'danger',
    blocked: 'warn', stale: 'warn', skipped: 'muted', queued: 'muted',
    paused: 'warn', cancelled: 'muted', completed: 'ok', partial: 'warn', interrupted: 'warn',
  }[status] || 'muted';
  return `<span class="chip chip-${tone}">${esc(map[status] || status)}</span>`;
}

function funnelBar(s) {
  const pct = s.total ? Math.round((s.done / s.total) * 100) : 0;
  const bits = ['pending', 'blocked', 'stale', 'failed', 'running']
    .filter((k) => (s[k] || 0) > 0)
    .map((k) => `<span class="chip chip-${k === 'failed' ? 'danger' : k === 'blocked' || k === 'stale' ? 'warn' : 'muted'}">${esc(STATUS_LABEL[k])} ${s[k]}</span>`)
    .join('');
  return `<article class="funnel-step">
    <div class="funnel-head"><b>${esc(s.label)}</b><span>${s.done}/${s.total}</span></div>
    <div class="funnel-track"><i style="width:${pct}%"></i></div>
    <div class="funnel-foot">${bits || '<span class="muted">无待处理</span>'}</div>
  </article>`;
}

export async function renderGovernance(body, q = {}) {
  if (activeGovernanceCleanup) {
    activeGovernanceCleanup();
    activeGovernanceCleanup = null;
  }
  body.innerHTML = loading('读取治理阶段与补采任务…');
  let pipeline;
  let config;
  let sources;
  let tasks;
  let relations;
  try {
    [pipeline, config, sources, tasks, relations] = await Promise.all([
      api(`/api/v2/admin/governance/pipeline?${new URLSearchParams(Object.fromEntries(Object.entries({
        object_type: q.pipeline_object_type, stage: q.pipeline_stage, status: q.pipeline_status,
        publisher: q.pipeline_publisher, q: q.pipeline_q, limit: '50',
      }).filter(([, v]) => v))).toString()}`),
      api('/api/v2/admin/governance/config'),
      api('/api/v2/admin/backfill/sources'),
      api('/api/v2/admin/backfill/tasks'),
      api('/api/v2/methodology-relations?limit=50').catch(() => ({ relations: [] })),
    ]);
  } catch (e) {
    body.innerHTML = errorState(e);
    return null;
  }
  const caps = sources.capabilities || {};
  const cfg = config.config || {};
  const taskRows = tasks.tasks || [];
  const supported = (sources.datasets || []).filter((d) => d.supported);
  const unsupported = (sources.datasets || []).filter((d) => !d.supported);

  body.innerHTML = `
    <div class="callout ${pipeline.queue ? 'callout-warn' : 'callout-ok'}">
      <b>处理阶段是独立状态</b>
      <p>发现、正文获取、解析/OCR、摘要、核验分别记录完成时间、输入哈希、失败原因、尝试次数与下次重试时间。
      摘要成功不等于核验通过；核验 unavailable 不会被写成「已核验」。正文变更后摘要/核验自动失效。</p>
      <p class="muted">租约：${pipeline.lease ? `${esc(pipeline.lease.owner)}（到期 ${esc(dateTime(pipeline.lease.expires_at))}）` : '当前无采集/补采任务持有租约'}｜待处理队列 ${pipeline.queue} 条｜
      单批上限 ${cfg.max_batch} 条｜最多尝试 ${cfg.max_attempts} 次｜批预算 ${Math.round((cfg.budget_ms || 0) / 1000)} 秒。</p>
      <div class="row-actions">
        <button class="btn btn-sm" data-gov-sync>补齐最近条目阶段状态</button>
        <button class="btn btn-sm btn-primary" data-gov-process>执行有界补处理</button>
        <a class="btn btn-sm" href="#/admin?tab=maintenance">运行与内容维护</a>
      </div>
    </div>

    ${card({
      title: '阶段漏斗',
      subtitle: '按当前资料类型统计；不适用阶段单列，阶段完成不代表核验结论通过',
      actions: '<span class="muted">最近刷新 ' + esc(dateTime(pipeline.generated_at)) + '</span>',
      body: `<div class="funnel">${pipeline.funnel.map(funnelBar).join('')}</div>`,
      note: pipeline.funnel_note,
    })}

    <div class="callout">
      <b>覆盖范围（据实）</b>
      <p>${esc(pipeline.coverage_note || '')}</p>
      <ul>
        ${Object.entries(pipeline.coverage || {}).map(([key, c]) => `<li><b>${esc(c.label || TYPE_LABEL[key] || key)}</b>：
          ${c.mode === 'five_stage'
            ? `逐条五阶段｜本类型 ${c.total ?? 0} 条；摘要${c.capabilities?.summary_supported ? '可用' : '不支持'}，核验${c.capabilities?.verification_supported ? '有现有适配器' : '未支持（不伪造通过）'}`
            : `结构化确定性治理｜${c.total ?? 0} 条；不套用 PDF 五阶段`}。
          <span class="muted">${esc(c.note || '')}</span></li>`).join('')}
      </ul>
      <p class="hint">历史补采仍只支持公开内容（研报/动态）；本页不把它扩展到所有历史资料。</p>
    </div>

    <div class="grid-2">
      ${card({
        title: '阻塞与失效原因',
        subtitle: '按阶段/原因聚合；普通用户看不到本页',
        body: pipeline.blockers.length
          ? `<ul class="list">${pipeline.blockers.map((b) => `<li><div class="list-head"><b>${esc(b.stage_label)}</b>${statusChip(b.status)}${b.triage ? chip(b.triage.label, b.triage.tone || 'muted') : ''}<span class="muted right">${b.count} 条</span></div><p class="muted">${esc(truncate(b.reason, 160))}</p>${b.triage?.auto_action ? `<p class="hint">自动处理：${esc(b.triage.auto_action)}</p>` : ''}</li>`).join('')}</ul>`
          : '<p class="muted">当前没有阻塞/失效记录。</p>',
      })}
      ${card({
        title: '最近运行',
        subtitle: '采集任务真实状态；失败原因不回显到公开首页',
        body: pipeline.recent_runs.length
          ? `<div class="table-wrap"><table class="grid grid-sm"><thead><tr><th>任务</th><th>状态</th><th>时间</th><th>错误</th></tr></thead><tbody>
            ${pipeline.recent_runs.map((r) => `<tr><td>${esc(r.title || r.job_key)}</td><td>${statusChip(r.status, { success: '成功', partial: '部分成功', failed: '失败', running: '运行中' })}</td>
              <td class="muted">${esc(dateTime(r.started_at || r.created_at))}</td><td class="muted">${esc(truncate(r.error_summary || '—', 40))}</td></tr>`).join('')}
          </tbody></table></div>`
          : '<p class="muted">尚未运行采集任务。</p>',
      })}
    </div>

    ${card({
      title: '条目明细与重试',
      subtitle: '按阶段/状态/来源筛选；编辑纠错走覆盖层，不改写原始正文',
      body: `
        <form class="filters" id="gov-filter-form">
          <label class="fld"><span>资料类型</span><select name="pipeline_object_type"><option value="">全部</option>
            ${(pipeline.object_types || []).map((t) => `<option value="${esc(t.key)}" ${q.pipeline_object_type === t.key ? 'selected' : ''}>${esc(t.label)}${t.capabilities?.verification_supported ? '' : '（核验未支持）'}</option>`).join('')}</select></label>
          <label class="fld"><span>阶段</span><select name="pipeline_stage"><option value="">全部</option>
            ${Object.entries(STAGE_LABEL).map(([k, l]) => `<option value="${k}" ${q.pipeline_stage === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
          <label class="fld"><span>状态</span><select name="pipeline_status"><option value="">全部</option>
            ${Object.entries(STATUS_LABEL).map(([k, l]) => `<option value="${k}" ${q.pipeline_status === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
          <label class="fld"><span>来源/发布机构</span><input name="pipeline_publisher" value="${esc(q.pipeline_publisher || '')}" placeholder="发布机构"></label>
          <label class="fld"><span>标题/URL</span><input name="pipeline_q" value="${esc(q.pipeline_q || '')}" placeholder="关键词"></label>
          <span class="fld-actions"><button class="btn btn-sm btn-primary" type="submit">筛选</button>
            <a class="btn btn-sm" href="#/admin?tab=governance">重置</a></span>
        </form>
        ${pipeline.items.length ? `<div class="table-wrap"><table class="grid grid-sm">
          <thead><tr><th>资料</th><th>类型</th><th>来源</th><th>阶段状态</th><th>阻塞原因</th><th>操作</th></tr></thead>
          <tbody>${pipeline.items.map((it) => `<tr>
            <td><button class="link" data-gov-item="${esc(it.id)}" data-gov-item-type="${esc(it.object_type)}">${esc(truncate(it.title, 48))}</button><div class="muted">${esc(it.published_at || '日期未披露')}</div></td>
            <td>${typeChip(it)}</td>
            <td>${esc(truncate(it.publisher || '来源未标注', 20))}<div class="muted">${esc(it.source_category || '')}</div></td>
            <td><div class="stage-row">${it.stages.map((s) => `<span class="stage-pill stage-${esc(s.status)}" title="${esc(`${s.stage_label}：${s.status_label}｜尝试 ${s.attempts}｜下次 ${s.next_retry_at || '—'}`)}">${esc(s.stage_label)}</span>`).join('')}</div></td>
            <td class="muted">${esc(truncate(it.blocking_stage?.reason || '—', 56))}</td>
            <td class="row-actions">
              <button class="btn btn-sm" data-gov-item="${esc(it.id)}" data-gov-item-type="${esc(it.object_type)}">查看</button>
              ${it.blocking_stage ? `<button class="btn btn-sm" data-gov-retry="${esc(it.id)}" data-gov-retry-type="${esc(it.object_type)}" data-stage="${esc(it.blocking_stage.stage)}">重试</button>` : ''}
              <a class="btn btn-sm" href="#/admin?tab=maintenance&entity_type=${encodeURIComponent(it.object_type)}&entity_id=${encodeURIComponent(it.id)}&action=edit">编辑纠错</a>
            </td>
          </tr>`).join('')}</tbody></table></div>
          <div class="row-actions"><span class="muted">本页 ${pipeline.items.length} 条 / 匹配 ${pipeline.total} 条</span></div>`
          : '<p class="muted">没有符合筛选条件的处理阶段记录。可先点上方「补齐最近条目阶段状态」。</p>'}
        <p class="hint">重试会受尝试上限与退避约束；「补传原件」沿用后台既有上传/维护入口，不新增一条独立写库路径。</p>
      `,
    })}

    ${card({
      title: '补传原件（沿用既有上传接口）',
      subtitle: '政策 / 方法学 / CEA 文件的官方 PDF 原件；研报与动态是网页条目，不适用文件补传',
      body: `
        <form id="gov-upload-form" class="form-grid">
          <label class="fld"><span>目标类型</span><select name="kind">
            <option value="policy">政策文件</option>
            <option value="methodology">方法学版本</option>
            <option value="cea_document">CEA 文件</option>
          </select></label>
          <label class="fld"><span>目标 ID</span><input name="id" required placeholder="政策/方法学/CEA 文件 ID"></label>
          <label class="fld fld-wide"><span>官方 PDF 原件（≤12 MB）</span><input name="pdf" type="file" accept="application/pdf,.pdf" required></label>
          <label class="fld fld-wide"><span>补充文字（可选，仅用于 OCR 失败时的人工转录；不会冒充原文）</span><textarea name="ocr_text" rows="2" maxlength="200000"></textarea></label>
          <div class="fld-actions row-actions"><button class="btn btn-sm btn-primary" type="submit">补传并解析</button>
            <a class="btn btn-sm" href="#/admin?tab=ocr">查看 PDF/OCR 页签</a></div>
        </form>
        <div id="gov-upload-result"></div>
        <p class="hint">上传只补充公开原件与解析文本，不会改写原记录；网页正文缺失请回上方「重试」或编辑纠错。补传不会把管理员文件标记为官方已核验。</p>
      `,
      note: '沿用既有 /api/v2/admin/document-upload；不新增独立上传路径，不修改账号或服务配置。',
    })}

    ${card({
      title: '历史补采',
      subtitle: '仅对公开内容提供按来源与日期窗口补采；完成只表示计划窗口已处理',
      body: `
        <div class="callout ${caps.date_filter_supported && caps.search_configured ? 'callout-ok' : 'callout-warn'}">
          <b>连接能力（真实检测）</b>
          <p>搜索：${caps.search_configured ? esc(caps.provider?.name || '已配置') : '未配置'}｜
          日期条件：${caps.date_filter_supported ? '连接已声明起止日期字段，将实际发送' : '未声明，不能保证真正发送'}｜
          分页：${caps.pagination_supported ? '已声明分页字段' : '未声明，只按日期窗口'}｜
          抓取：${caps.fetch_configured ? esc(caps.fetch?.name || '已配置') : '未配置，正文会标记阻塞'}。</p>
          ${(caps.notes || []).length ? `<ul>${caps.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
          <p class="hint">${esc(sources.note || '')}</p>
          <details><summary>不支持统一日期补采的资料类型</summary><ul>${unsupported.map((d) => `<li><b>${esc(d.label)}</b>：${esc(d.note)}</li>`).join('')}</ul></details>
        </div>
        <form id="bf-form" class="form-grid">
          <label class="fld"><span>资料类型</span><select name="dataset">${supported.map((d) => `<option value="${d.key}">${esc(d.label)}</option>`).join('')}</select></label>
          <label class="fld"><span>起始日期</span><input type="date" name="date_from" required></label>
          <label class="fld"><span>截止日期</span><input type="date" name="date_to" required></label>
          <label class="fld"><span>窗口天数（1—31）</span><input type="number" name="window_days" min="1" max="31" value="7"></label>
          <label class="fld fld-wide"><span>检索词（多个用逗号/换行分隔；留空使用查询组）</span><input name="query" maxlength="100" placeholder="例如：CCER, 温室气体自愿减排"></label>
          <div class="fld fld-wide"><span>查询组</span><div class="checks">${(sources.query_groups || []).map((g) => `<label><input type="checkbox" name="group_keys" value="${esc(g.key)}" ${['ccer', 'voluntary'].includes(g.key) ? 'checked' : ''}> ${esc(g.label)}</label>`).join('')}</div></div>
          <div class="fld fld-wide"><span>来源（留空表示不限定；只取所选来源域名）</span><div class="checks checks-scroll">${(sources.seed_sources || []).map((s) => `<label ${s.enabled ? '' : 'class="muted"'}><input type="checkbox" name="source_ids" value="${esc(s.id)}" ${s.enabled ? '' : 'disabled'}> ${esc(s.name)}${s.enabled ? '' : '（已停用）'}</label>`).join('')}</div></div>
          <label class="fld"><span>每页条数（1—50）</span><input type="number" name="page_size" min="1" max="50" value="10"></label>
          <label class="fld"><span>每窗最多页数（1—10）</span><input type="number" name="max_pages" min="1" max="10" value="1"></label>
          <label class="fld"><span>任务搜索调用上限（≤2000）</span><input type="number" name="max_calls" min="1" max="2000" value="200"></label>
          <div class="fld-actions row-actions"><button class="btn btn-sm" type="button" id="bf-preview">预览计划</button>
            <button class="btn btn-sm btn-primary" type="button" id="bf-create" disabled>创建任务</button></div>
        </form>
        <div id="bf-preview" class="bf-preview"></div>
        <h5>任务</h5>
        <div id="bf-task-list">${taskTable(taskRows)}</div>
      `,
      note: '任务、日期窗口与页码游标持久化；暂停/继续/取消/失败重试/重启恢复。每日任务与补采共享同一 collection 租约，单任务并发 1。',
    })}

    ${card({
      title: '方法学版本关系候选',
      subtitle: '模型/研究员可提交候选；系统只对「原文定位 + 逐字引文 + 既有核验」同时满足的关系自动确认',
      body: `
        <form id="rel-form" class="form-grid">
          <label class="fld"><span>新版本 ID</span><input name="from_version_id" required placeholder="方法学版本 ID"></label>
          <label class="fld"><span>旧版本 ID</span><input name="to_version_id" required placeholder="方法学版本 ID"></label>
          <label class="fld"><span>关系类型</span><select name="relation_type">${Object.entries(REL_LABEL).map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select></label>
          <label class="fld"><span>证据 URL</span><input name="evidence_url" type="url" required placeholder="https://…"></label>
          <label class="fld"><span>段落/页码定位</span><input name="evidence_locator" required placeholder="例如：修订通知第 2 页第 3 段"></label>
          <label class="fld fld-wide"><span>逐字引文</span><textarea name="evidence_quote" rows="3" required placeholder="必须能在已归档正文中定位"></textarea></label>
          <div class="fld-actions row-actions"><button class="btn btn-sm btn-primary" type="submit">提交候选并自动判定</button>
            <button class="btn btn-sm" type="button" id="rel-reconcile">重新核对全部候选</button></div>
        </form>
        <div id="rel-result"></div>
        <h5>最近关系</h5>
        ${(relations.relations || []).length ? `<div class="table-wrap"><table class="grid grid-sm"><thead><tr><th>关系</th><th>从</th><th>到</th><th>状态</th><th>证据</th></tr></thead><tbody>
          ${(relations.relations || []).map((r) => `<tr><td>${esc(r.relation_type_label || REL_LABEL[r.relation_type] || r.relation_type)}</td>
            <td>${esc(r.from?.code_display || r.from_version_id)}</td><td>${esc(r.to?.code_display || r.to_version_id)}</td>
            <td>${r.status === 'confirmed' ? chip('已确认', 'ok') : r.status === 'candidate' ? chip('候选/待核实', 'warn') : chip(r.status, 'muted')}</td>
            <td class="muted">${esc(truncate(r.confirmation_basis || r.evidence_locator || '—', 50))}</td></tr>`).join('')}
        </tbody></table></div>` : '<p class="muted">暂无版本关系记录。</p>'}
      `,
      note: '确认关系不等于人工审批：判定是确定性规则，条件变化后会重新评估；无法定位的引文保持候选。',
    })}
  `;

  bindGovernance(body, { q, pipeline, config, sources, tasks });
  const interval = setInterval(async () => {
    if (!document.getElementById('bf-task-list')) return;
    try {
      const fresh = await api('/api/v2/admin/backfill/tasks');
      const el = document.getElementById('bf-task-list');
      if (el) el.innerHTML = taskTable(fresh.tasks || []);
      bindTaskButtons(el);
    } catch { /* 轮询失败不打断页面 */ }
  }, 5000);
  const cleanup = () => {
    clearInterval(interval);
    window.removeEventListener('hashchange', cleanup);
  };
  window.addEventListener('hashchange', cleanup);
  activeGovernanceCleanup = cleanup;
  return cleanup;
}

function taskTable(rows) {
  if (!rows.length) return '<p class="muted">暂无补采任务。先预览计划，再创建任务。</p>';
  return `<div class="table-wrap"><table class="grid grid-sm"><thead><tr>
    <th>任务</th><th>范围</th><th>状态</th><th>进度</th><th>命中/新增/重复/失败/阻塞</th><th>操作</th></tr></thead><tbody>
    ${rows.map((t) => `<tr>
      <td><button class="link" data-bf-detail="${esc(t.id)}">${esc(t.id)}</button><div class="muted">${esc(dateTime(t.created_at))}</div></td>
      <td>${esc(t.dataset)}<div class="muted">${esc(t.date_from)}～${esc(t.date_to)}｜${t.window_days} 天/窗｜${t.planned_windows} 窗</div></td>
      <td>${statusChip(t.status, TASK_LABEL)}</td>
      <td><div class="funnel-track"><i style="width:${t.progress?.percent || 0}%"></i></div><span class="muted">${t.progress?.windows_done ?? 0}/${t.progress?.windows_total ?? 0}｜${t.progress?.percent ?? 0}%</span></td>
      <td class="muted">${t.hits}/${t.inserted}/${t.duplicates}/${t.failed}/${t.blocked}<div>${esc(truncate(t.last_error || '', 50))}</div></td>
      <td class="row-actions">
        ${['queued', 'interrupted', 'partial'].includes(t.status) ? `<button class="btn btn-sm" data-bf-action="start" data-id="${esc(t.id)}">启动</button>` : ''}
        ${t.status === 'running' ? `<button class="btn btn-sm" data-bf-action="pause" data-id="${esc(t.id)}">暂停</button>` : ''}
        ${['paused', 'interrupted'].includes(t.status) ? `<button class="btn btn-sm" data-bf-action="resume" data-id="${esc(t.id)}">继续</button>` : ''}
        ${['failed', 'partial'].includes(t.status) ? `<button class="btn btn-sm" data-bf-action="retry" data-id="${esc(t.id)}">重试</button>` : ''}
        ${['running', 'paused', 'queued', 'interrupted', 'partial'].includes(t.status) ? `<button class="btn btn-sm" data-bf-action="cancel" data-id="${esc(t.id)}">取消</button>` : ''}
        <button class="btn btn-sm" data-bf-detail="${esc(t.id)}">详情</button>
      </td></tr>`).join('')}
  </tbody></table></div>`;
}

function bindGovernance(body, { q, pipeline, config, sources, tasks }) {
  document.getElementById('gov-filter-form')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setQuery({
      tab: 'governance',
      pipeline_object_type: f.get('pipeline_object_type') || null,
      pipeline_stage: f.get('pipeline_stage') || null,
      pipeline_status: f.get('pipeline_status') || null,
      pipeline_publisher: f.get('pipeline_publisher') || null,
      pipeline_q: f.get('pipeline_q') || null,
    });
  });
  body.querySelector('[data-gov-sync]')?.addEventListener('click', async (e) => {
    e.currentTarget.disabled = true;
    try {
      const out = await api('/api/v2/admin/governance/sync', { method: 'POST', body: { limit: 500 } });
      toast(`已补齐 ${out.synced}/${out.total} 条阶段状态`, 'ok');
      await renderGovernance(body, q);
    } catch (err) { toast(err.body?.error || err.message, 'error'); e.currentTarget.disabled = false; }
  });
  body.querySelector('[data-gov-process]')?.addEventListener('click', async (e) => {
    e.currentTarget.disabled = true;
    e.currentTarget.textContent = '处理中…';
    try {
      const out = await api('/api/v2/admin/governance/process', { method: 'POST', body: { limit: config.config?.max_batch || 20 } });
      toast(`补处理：摘要 ${out.summarized || 0}、核验 ${out.verified || 0}、阻塞 ${out.blocked || 0}、失败 ${out.failed || 0}`, out.failed ? 'warn' : 'ok');
      await renderGovernance(body, q);
    } catch (err) { toast(err.body?.error || err.message, 'error'); e.currentTarget.disabled = false; e.currentTarget.textContent = '执行有界补处理'; }
  });
  body.querySelectorAll('[data-gov-item]').forEach((el) => el.addEventListener('click', () => openGovernanceItem(
    el.dataset.govItemType || 'content_item', el.dataset.govItem
  )));
  body.querySelectorAll('[data-gov-retry]').forEach((el) => el.addEventListener('click', async () => {
    el.disabled = true;
    try {
      const out = await api('/api/v2/admin/governance/retry', {
        method: 'POST',
        body: {
          object_id: el.dataset.govRetry,
          stage: el.dataset.stage,
          object_type: el.dataset.govRetryType || 'content_item',
        },
      });
      toast(out.ok ? `重试完成：${out.status || out.result || '已提交'}` : `重试未成功：${out.reason || out.status || '阻塞'}`, out.ok ? 'ok' : 'warn');
      await renderGovernance(body, q);
    } catch (err) { toast(err.body?.error || err.message, 'error'); el.disabled = false; }
  }));

  /* 补采表单 */
  const readInput = () => {
    const f = new FormData(document.getElementById('bf-form'));
    return {
      dataset: f.get('dataset'), date_from: f.get('date_from'), date_to: f.get('date_to'),
      window_days: Number(f.get('window_days')), query: f.get('query') || '',
      group_keys: f.getAll('group_keys'), source_ids: f.getAll('source_ids'),
      page_size: Number(f.get('page_size')), max_pages: Number(f.get('max_pages')),
      options: { max_calls: Number(f.get('max_calls')) },
    };
  };
  let pendingInput = null;
  document.getElementById('bf-preview')?.addEventListener('click', async (e) => {
    e.currentTarget.disabled = true;
    try {
      const input = readInput();
      const p = await api('/api/v2/admin/backfill/preview', { method: 'POST', body: input });
      pendingInput = p.ok ? input : null;
      const create = document.getElementById('bf-create');
      if (create) create.disabled = !p.ok;
      document.getElementById('bf-preview').innerHTML = p.ok
        ? `<div class="callout ${p.blocking_reasons.length ? 'callout-warn' : 'callout-ok'}">
            <b>计划：${p.window_count} 个日期窗口｜${p.terms.length} 个检索词｜预计搜索调用 ${p.estimated_search_calls}</b>
            <p>${esc(p.coverage_note)}</p>
            ${p.blocking_reasons.length ? `<ul>${p.blocking_reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>` : ''}
            <p class="muted">窗口示例：${p.windows.slice(0, 6).map((w) => `${w.window_from}～${w.window_to}`).join('；')}${p.window_preview_truncated ? '…' : ''}</p>
          </div>`
        : `<div class="callout callout-warn"><b>计划不可执行</b><p>${esc(p.error || p.message || '参数不完整')}</p></div>`;
    } catch (err) {
      pendingInput = null;
      const create = document.getElementById('bf-create'); if (create) create.disabled = true;
      document.getElementById('bf-preview').innerHTML = `<div class="callout callout-warn"><b>预览失败</b><p>${esc(err.body?.error || err.message)}</p></div>`;
    } finally { e.currentTarget.disabled = false; }
  });
  document.getElementById('bf-create')?.addEventListener('click', async (e) => {
    if (!pendingInput) return;
    e.currentTarget.disabled = true;
    try {
      const out = await api('/api/v2/admin/backfill/tasks', { method: 'POST', body: pendingInput });
      toast(`任务已创建：${out.task?.id || ''}`, 'ok');
      await renderGovernance(body, q);
    } catch (err) { toast(err.body?.error || err.message, 'error'); e.currentTarget.disabled = false; }
  });
  bindTaskButtons(body);

  /* 补传原件 */
  document.getElementById('gov-upload-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const file = f.get('pdf');
    const box = document.getElementById('gov-upload-result');
    if (!(file instanceof File) || !file.size) { toast('请选择 PDF 文件', 'warn'); return; }
    if (file.size > 12 * 1024 * 1024) { toast('PDF 不得超过 12 MB', 'warn'); return; }
    const btn = e.currentTarget.querySelector('button[type="submit"]');
    btn.disabled = true;
    try {
      const base64 = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
        reader.onerror = () => reject(reader.error || new Error('读取文件失败'));
        reader.readAsDataURL(file);
      });
      const out = await api('/api/v2/admin/document-upload', {
        method: 'POST',
        body: {
          kind: f.get('kind'), id: f.get('id'), file_name: file.name,
          pdf_base64: base64, ocr_text: f.get('ocr_text') || '',
        },
      });
      box.innerHTML = `<div class="callout callout-ok"><b>原件已补传</b><p>${esc(out.message || out.note || '已保存并解析；原始记录未改写。')}</p></div>`;
      toast('原件已补传并解析', 'ok');
    } catch (err) {
      box.innerHTML = `<div class="callout callout-warn"><b>补传未完成</b><p>${esc(err.body?.error || err.message)}</p></div>`;
      toast(err.body?.error || err.message, 'error');
    } finally { btn.disabled = false; }
  });

  /* 从治理详情跳转：预选正确实体，仍走同一个 document-upload 表单 */
  const prefillKind = UPLOAD_KIND[q.upload_type];
  if (prefillKind && q.upload_id) {
    const kindEl = document.querySelector('#gov-upload-form select[name="kind"]');
    const idEl = document.querySelector('#gov-upload-form input[name="id"]');
    if (kindEl) kindEl.value = prefillKind;
    if (idEl) idEl.value = q.upload_id;
    document.getElementById('gov-upload-form')?.scrollIntoView({ block: 'start' });
  }

  document.getElementById('rel-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    try {
      const out = await api('/api/v2/methodology-relations', {
        method: 'POST', body: Object.fromEntries(f.entries()),
      });
      document.getElementById('rel-result').innerHTML = `<div class="callout ${out.confirmed ? 'callout-ok' : 'callout-warn'}">
        <b>${out.confirmed ? '关系已确认' : '关系保持候选'}</b>
        <p>${esc(out.confirmed ? out.relation?.confirmation_basis : out.reason || '证据不足，未确认')}</p></div>`;
      toast(out.confirmed ? '关系已确认' : '关系保持候选，请补充原文证据或先完成核验', out.confirmed ? 'ok' : 'warn');
    } catch (err) { toast(err.body?.error || err.message, 'error'); }
  });
  document.getElementById('rel-reconcile')?.addEventListener('click', async (e) => {
    e.currentTarget.disabled = true;
    try {
      const out = await api('/api/v2/methodology-relations/reconcile', { method: 'POST' });
      toast(`核对完成：确认 ${out.confirmed} 条，保留候选 ${out.kept} 条`, 'ok');
      await renderGovernance(body, q);
    } catch (err) { toast(err.body?.error || err.message, 'error'); e.currentTarget.disabled = false; }
  });
}

function bindTaskButtons(body) {
  body.querySelectorAll('[data-bf-action]').forEach((el) => el.addEventListener('click', async () => {
    el.disabled = true;
    const action = el.dataset.bfAction;
    const id = el.dataset.id;
    try {
      const out = await api(`/api/v2/admin/backfill/tasks/${id}/${action}`, {
        method: 'POST', body: action === 'start' ? { max_windows: 2 } : {},
      });
      toast(`任务 ${id}：${action === 'start' ? '已启动' : TASK_LABEL[out.task?.status] || action}`, 'ok');
      const fresh = await api('/api/v2/admin/backfill/tasks');
      const box = document.getElementById('bf-task-list');
      if (box) { box.innerHTML = taskTable(fresh.tasks || []); bindTaskButtons(box); }
    } catch (err) { toast(err.body?.error || err.message, 'error'); el.disabled = false; }
  }));
  body.querySelectorAll('[data-bf-detail]').forEach((el) => el.addEventListener('click', () => openTaskDrawer(el.dataset.bfDetail)));
}

async function openGovernanceItem(objectType, id) {
  try {
    const d = await api(`/api/v2/admin/governance/items/${encodeURIComponent(objectType)}/${encodeURIComponent(id)}`);
    const it = d.item || {};
    const ev = d.evidence || {};
    const ver = d.verifications?.[0];
    const up = d.links?.upload;
    const edit = d.links?.edit;
    const hashText = [ev.original_hash ? `原件/附件 hash：${truncate(String(ev.original_hash), 28)}` : null,
      ev.content_hash ? `正文 hash：${truncate(String(ev.content_hash), 28)}` : null].filter(Boolean).join('｜') || '—';
    document.body.insertAdjacentHTML('beforeend', drawer(`治理明细｜${truncate(it.title || it.name || id, 40)}`, `
      <div class="drawer-section">
        <div class="list-head"><span class="chip chip-muted">${esc(d.type_label || TYPE_LABEL[objectType] || objectType)}</span>
          <code class="muted">${esc(objectType)} / ${esc(id)}</code></div>
        ${kv([
          ['标题', esc(it.title || it.name || '—')],
          ['发布/来源机构', esc(it.publisher || it.issuer || it.owner_name || '来源未标注')],
          ['发布日期', ev.published_at ? esc(shortDate(ev.published_at)) : '未披露'],
          ['来源链接', /^https?:\/\//i.test(String(ev.source_url || '')) ? `<a class="link" href="${esc(ev.source_url)}" target="_blank" rel="noopener noreferrer">打开原文</a>` : '来源未标注'],
          ['正文可获得性', esc(ev.body_availability || '—')],
          ['正文长度', `${num(ev.body_chars || 0)} 字符`],
          ['原件/附件', hashText],
          ['原始证据说明', esc(ev.source_note || '—')],
        ])}
      </div>
      <div class="drawer-section">
        <h4>五阶段（失败原因与重试）</h4>
        <ul class="list">${d.stages.map((s) => `<li><div class="list-head"><b>${esc(s.stage_label)}</b>${statusChip(s.status)}<span class="muted right">尝试 ${s.attempts} 次</span></div>
          <p class="muted">完成：${esc(dateTime(s.completed_at))}｜输入：${esc(truncate(s.input_hash || '—', 24))}｜定位：${esc(s.source_locator || '—')}</p>
          ${s.failure_reason ? `<p class="muted">原因：${esc(s.failure_reason)}</p>` : ''}
          ${s.next_retry_at ? `<p class="muted">下次重试：${esc(dateTime(s.next_retry_at))}</p>` : ''}
          ${s.status === 'skipped' ? '' : `<button class="btn btn-sm" data-drawer-retry="${esc(s.stage)}" data-drawer-retry-type="${esc(d.object_type)}">重试此阶段</button>`}
        </li>`).join('')}</ul>
      </div>
      <div class="drawer-section">
        <h4>摘要与核验（分开显示）</h4>
        ${kv([
          ['摘要状态', d.summary ? `${esc(d.summary.status)}${d.summary.stale ? '（已失效）' : ''}（${dateTime(d.summary.generated_at)}）` : '未生成'],
          ['摘要输入范围', esc(d.summary?.scope_note || d.summary?.input_kind || '—')],
          ['核验适配器', d.capabilities?.verification_supported ? esc(d.capabilities.verification_mode) : '未支持（不伪造通过）'],
          ['最近核验', ver ? `${esc(ver.result)}（${dateTime(ver.created_at)}）` : '未核验'],
          ['核验能力说明', esc(ver?.capability_note || '—')],
          ['核验模型调用', ver?.model_used ? '是' : '否（规则/阻塞）'],
        ])}
        ${d.summary?.summary ? `<p class="prose">${esc(truncate(d.summary.summary, 800))}</p>` : (d.summary?.empty_reason ? `<p class="muted">${esc(d.summary.empty_reason)}</p>` : '')}
        ${ver?.citations?.length ? `<ul class="bullets">${ver.citations.map((c) => `<li>${esc(c.quote || '')}<span class="muted">（${esc(c.locator || '定位未标注')}）</span></li>`).join('')}</ul>` : ''}
      </div>
      <div class="drawer-section">
        <h4>原始证据与纠错入口</h4>
        ${(d.evidence?.attachments || []).length ? `<div class="table-wrap"><table class="grid grid-sm"><thead><tr><th>附件</th><th>hash</th><th>本地文件</th><th>解析</th></tr></thead><tbody>
          ${d.evidence.attachments.map((a) => `<tr><td>${esc(truncate(a.file_name || '—', 34))}</td><td class="muted">${esc(truncate(a.file_hash || '—', 20))}</td><td>${a.has_local_file ? '已归档' : '未获取'}</td><td class="muted">${esc(a.parse_quality || '—')}</td></tr>`).join('')}
        </tbody></table></div>` : '<p class="muted">该类型没有附件表记录，或尚未登记附件。</p>'}
        <ul class="bullets">${(d.versions || []).map((v) => `<li>v${v.version_no}｜${esc(dateTime(v.fetched_at))}｜${esc(v.change_summary || v.change_kind)}</li>`).join('') || '<li class="muted">无正文版本记录</li>'}</ul>
        <div class="row-actions">
          ${edit ? `<a class="btn btn-sm" href="${esc(edit.href)}">编辑纠错（预选本实体）</a>` : ''}
          ${up?.supported ? `<a class="btn btn-sm" href="${esc(up.href)}">补传原件（预选本实体）</a>` : `<span class="muted">${esc(up?.note || '该资料类型不支持原件补传')}</span>`}
        </div>
        <p class="hint">${esc(d.note || '')}</p>
      </div>
    `, { wide: true }));
    const panel = document.querySelector('.drawer');
    const backdrop = document.querySelector('.drawer-backdrop');
    const closePanel = () => { panel?.remove(); backdrop?.remove(); };
    panel?.querySelector('[data-close-drawer]')?.addEventListener('click', closePanel);
    // Maintenance destinations must be visible after leaving this detail drawer.
    panel?.querySelectorAll('a[href^="#/admin"]').forEach((link) => {
      link.addEventListener('click', (event) => {
        event.preventDefault();
        const destination = link.getAttribute('href');
        closePanel();
        if (destination) window.location.hash = destination.slice(1);
      });
    });
    document.querySelectorAll('.drawer [data-drawer-retry]').forEach((el) => el.addEventListener('click', async () => {
      el.disabled = true;
      try {
        const out = await api('/api/v2/admin/governance/retry', {
          method: 'POST',
          body: {
            object_id: id,
            stage: el.dataset.drawerRetry,
            object_type: el.dataset.drawerRetryType || d.object_type,
          },
        });
        toast(out.ok ? '重试完成' : `未成功：${out.reason || out.status || '阻塞'}`, out.ok ? 'ok' : 'warn');
        document.querySelector('.drawer-backdrop')?.remove();
        document.querySelector('.drawer')?.remove();
      } catch (e) { toast(e.body?.error || e.message, 'error'); el.disabled = false; }
    }));
  } catch (e) { toast(e.body?.error || e.message, 'error'); }
}

async function openTaskDrawer(id) {
  try {
    const d = await api(`/api/v2/admin/backfill/tasks/${id}`);
    const t = d.task;
    document.body.insertAdjacentHTML('beforeend', drawer(`历史补采｜${t.id}`, `
      <div class="drawer-section">
        ${kv([
          ['状态', TASK_LABEL[t.status] || t.status],
          ['范围', `${t.date_from}～${t.date_to}｜${t.window_days} 天/窗`],
          ['查询词', (t.terms || []).join('、')],
          ['来源', (t.source_ids || []).join('、') || '不限定'],
          ['计划/已处理窗口', `${t.planned_windows} / ${t.processed_windows}`],
          ['命中/新增/更新/重复/窗外', `${t.hits} / ${t.inserted} / ${t.updated} / ${t.duplicates} / ${t.outside_window}`],
          ['失败/阻塞/未知日期', `${t.failed} / ${t.blocked} / ${t.unknown_dates}`],
          ['搜索调用', t.search_calls],
          ['最后错误', esc(t.last_error || '—')],
        ])}
        <p class="muted">${esc(t.coverage_note || '')}</p>
      </div>
      <div class="drawer-section"><h4>窗口与页码游标</h4>
        <div class="table-wrap"><table class="grid grid-sm"><thead><tr><th>#</th><th>窗口</th><th>状态</th><th>页游标</th><th>命中/新增/重复</th><th>失败/阻塞/未知</th><th>错误</th></tr></thead><tbody>
          ${(t.windows || []).map((w) => `<tr><td>${w.seq}</td><td>${esc(w.window_from)}～${esc(w.window_to)}</td><td>${statusChip(w.status, { ...TASK_LABEL, done: '完成', pending: '待处理', blocked: '阻塞', skipped: '跳过' })}</td>
            <td>${w.cursor_page}/${t.max_pages}（已处理 ${w.pages_done} 页）</td><td>${w.hits}/${w.inserted}/${w.duplicates}</td><td>${w.failed}/${w.blocked}/${w.unknown_dates}</td>
            <td class="muted">${esc(truncate(w.error || '—', 50))}</td></tr>`).join('')}
        </tbody></table></div>
      </div>
    `, { wide: true }));
    document.querySelector('.drawer [data-close-drawer]')?.addEventListener('click', () => {
      document.querySelector('.drawer-backdrop')?.remove();
      document.querySelector('.drawer')?.remove();
    });
  } catch (e) { toast(e.body?.error || e.message, 'error'); }
}
