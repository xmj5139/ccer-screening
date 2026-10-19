/**
 * 服务存活时按北京时间每日执行：
 *   1) 06:30 全平台更新（既有行为，不改动）；
 *   2) CEA 收盘后**轻量增量**（默认 16:30，后台可配置；只跑行情 + 意向，与 06:30 分开）。
 *
 * 关键约束（docs/35 第 7 条）：
 *   - 两个定时器都只在 CCER_ENABLE_V2=1 且 CCER_DAILY_SYNC=1 时启动；
 *     CCER_DAILY_SYNC=0 会一并停用 CEA 收盘后增量（本地开发不误触发）；
 *     额外提供 CCER_CEA_AFTER_CLOSE=0 单独停用收盘后增量的开关；
 *   - 下一次运行时间按**北京时间**计算，与服务器本地时区无关（跨天安全）；
 *   - 后台改开关/时间后调用 rescheduleCeaAfterClose() 立即生效，并可通过
 *     ceaAfterCloseStatus() 读到真实的 next_run_at（不是配置回显）；
 *   - stopDailyScheduler() 停止**所有**定时器（含 CEA）；
 *   - 重入保护：某个定时任务运行期间不并发启动另一个。
 */
let timer = null;          // 06:30 全平台更新
let ceaTimer = null;       // CEA 收盘后增量
let running = false;       // 全平台更新运行中
let ceaRunning = false;    // CEA 收盘后增量运行中
let ceaLastRun = null;     // { at, trigger, summary|error }
const DAY = 86400000;
const OFFSET = 8 * 3600000; // 北京时间 = UTC+8

/** 北京时间下一次 hour:minute 的时间戳（与服务器本地时区无关） */
function nextRun(now = Date.now(), hour = 6, minute = 30) {
  const local = new Date(now + OFFSET);
  local.setUTCHours(hour, minute, 0, 0);
  let target = local.getTime() - OFFSET;
  if (target <= now) target += DAY;
  return target;
}

/** 调度是否被环境变量允许（CCER_DAILY_SYNC=0 时两者都停） */
function schedulerAllowed() {
  return process.env.CCER_ENABLE_V2 === '1' && process.env.CCER_DAILY_SYNC === '1';
}

/** CEA 收盘后增量是否启用：环境开关 + 后台配置 after_close_enabled */
function ceaAfterCloseEnabled(cfg) {
  if (!schedulerAllowed()) return false;
  if (process.env.CCER_CEA_AFTER_CLOSE === '0') return false;
  return !!cfg?.after_close_enabled;
}

function parseCloseTime(v, fallback = { hour: 16, minute: 30 }) {
  const m = String(v || '').match(/^([01]\d|2[0-3]):([0-5]\d)$/);
  if (!m) return fallback;
  return { hour: Number(m[1]), minute: Number(m[2]) };
}

async function loadCeaConfig() {
  const mod = await import('./cea-collect-svc.mjs');
  return { mod, cfg: mod.ceaCollectConfig() };
}

export function startDailyScheduler() {
  if (!schedulerAllowed() || timer) return null;
  const hour = Math.max(0, Math.min(23, Number(process.env.CCER_DAILY_SYNC_HOUR ?? 6)));
  const minute = Math.max(0, Math.min(59, Number(process.env.CCER_DAILY_SYNC_MINUTE ?? 30)));
  const schedule = () => {
    const at = nextRun(Date.now(), hour, minute);
    timer = setTimeout(async () => {
      timer = null;
      if (!running && !ceaRunning) {
        running = true;
        try {
          if (process.env.CCER_DAILY_CALIBRATE_ONLY === '1') {
            const reconcile = await import('./reconcile-svc.mjs');
            const ai = await import('./reconciliation-ai-svc.mjs');
            const checks = reconcile.runAllChecks({ actor: 'system:daily-scheduler' });
            const result = await ai.calibrateOpenIssues({ actor: 'system:daily-scheduler', limit: 60 });
            console.log(`[v2:daily] 校准完成｜${JSON.stringify({ checks: checks.stats, ai: result })}`);
          } else {
            const { runDailyJob } = await import('./collect-svc.mjs');
            const r = await runDailyJob({ actor: 'system:daily-scheduler', trigger: 'schedule' });
            console.log(`[v2:daily] ${r.status}｜${JSON.stringify(r.stats)}`);
          }
        } catch (e) { console.error(`[v2:daily] 自动更新失败：${e.message}`); }
        finally { running = false; }
      }
      schedule();
    }, Math.max(1000, at - Date.now()));
    console.log(`[v2:daily] 下次自动更新：${new Date(at).toISOString()}（北京时间 ${hour}:${String(minute).padStart(2, '0')}）`);
  };
  schedule();
  startCeaAfterCloseScheduler();
  return true;
}

/**
 * 启动/重启 CEA 收盘后增量定时器。
 * 后台改开关或时间后调用本函数即可立即生效（不会叠加旧定时器）。
 */
export async function startCeaAfterCloseScheduler({ now = Date.now() } = {}) {
  if (ceaTimer) { clearTimeout(ceaTimer); ceaTimer = null; }
  ceaTimerAnchor = null;
  if (!schedulerAllowed()) return null;
  let mod;
  let cfg;
  try {
    ({ mod, cfg } = await loadCeaConfig());
  } catch (e) {
    console.error(`[cea:after-close] 读取 CEA 配置失败：${e.message}`);
    return null;
  }
  if (!ceaAfterCloseEnabled(cfg)) {
    console.log(
      `[cea:after-close] 未启用（${process.env.CCER_CEA_AFTER_CLOSE === '0' ? 'CCER_CEA_AFTER_CLOSE=0' : '后台配置 after_close_enabled=false'}）`
    );
    return null;
  }
  const { hour, minute } = parseCloseTime(cfg.after_close_time);
  const schedule = () => {
    const at = nextRun(Date.now(), hour, minute);
    ceaTimerAnchor = at; // 展示用的下一次运行时间与真实定时器同源
    ceaTimer = setTimeout(async () => {
      ceaTimer = null;
      ceaTimerAnchor = null;
      if (!ceaRunning && !running) {
        ceaRunning = true;
        try {
          const { mod: m, cfg: c } = await loadCeaConfig();
          const deadline = Date.now() + Math.max(5000, Number(c.batch_budget_ms) || 120000);
          const summary = await m.runCeaAfterCloseStep({ actor: 'system:cea-after-close', trigger: 'schedule', cfg: c, deadlineAt: deadline });
          ceaLastRun = { at: new Date().toISOString(), trigger: 'schedule', summary };
          console.log(`[cea:after-close] ${summary.skipped ? 'skipped' : 'done'}｜${JSON.stringify({ json: summary.json?.quote_sources?.length ?? null, intentions: summary.intentions?.rows ?? null, elapsed_ms: summary.elapsed_ms })}`);
        } catch (e) {
          ceaLastRun = { at: new Date().toISOString(), trigger: 'schedule', error: e.message };
          console.error(`[cea:after-close] 收盘后增量失败：${e.message}`);
        } finally { ceaRunning = false; }
      }
      schedule();
    }, Math.max(1000, at - Date.now()));
    console.log(`[cea:after-close] 下次 CEA 收盘后增量：${new Date(at).toISOString()}（北京时间 ${hour}:${String(minute).padStart(2, '0')}）`);
  };
  schedule();
  return true;
}

/** 后台配置变更后重新排程（立即生效） */
export async function rescheduleCeaAfterClose(opts = {}) {
  return startCeaAfterCloseScheduler(opts);
}

/**
 * 收盘后增量的真实调度状态：供后台显示「下一次运行时间」。
 * next_run_at 由实际定时器计算；定时器未运行时为 null（不会假装已排程）。
 */
export function ceaAfterCloseStatus() {
  return {
    env_allowed: schedulerAllowed(),
    env_switch_note: schedulerAllowed()
      ? null
      : `定时调度未启用：需要 CCER_ENABLE_V2=1 且 CCER_DAILY_SYNC=1（当前 CCER_DAILY_SYNC=${process.env.CCER_DAILY_SYNC ?? '未设置'}）`,
    env_kill_switch: process.env.CCER_CEA_AFTER_CLOSE === '0' ? 'CCER_CEA_AFTER_CLOSE=0（收盘后增量已停用）' : null,
    scheduled: !!ceaTimer,
    running: ceaRunning,
    next_run_at: ceaTimer ? new Date(ceaTimerNextAt()).toISOString() : null,
    next_run_beijing: ceaTimer ? beijingLabel(ceaTimerNextAt()) : null,
    last_run: ceaLastRun,
  };
}

/** setTimeout 句柄没有公开的到期时间：这里用与排程相同的算法重算，保证展示值与实际一致 */
let ceaTimerAnchor = null;
function ceaTimerNextAt() {
  return ceaTimerAnchor || null;
}
function beijingLabel(ts) {
  if (!ts) return null;
  const d = new Date(ts + OFFSET);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}（北京时间）`;
}

/** 停止所有定时器（06:30 全平台更新 + CEA 收盘后增量） */
export function stopDailyScheduler() {
  if (timer) clearTimeout(timer);
  if (ceaTimer) clearTimeout(ceaTimer);
  timer = null;
  ceaTimer = null;
  ceaTimerAnchor = null;
}

/** 测试用：直接执行一次收盘后步骤（不依赖真实时间流逝） */
export async function runCeaAfterCloseNow({ trigger = 'manual' } = {}) {
  const { mod, cfg } = await loadCeaConfig();
  if (!ceaAfterCloseEnabled(cfg)) {
    return { skipped: true, reason: 'after_close_disabled', message: '收盘后增量未启用（环境变量或后台配置）' };
  }
  ceaRunning = true;
  try {
    const deadline = Date.now() + Math.max(5000, Number(cfg.batch_budget_ms) || 120000);
    const summary = await mod.runCeaAfterCloseStep({ actor: 'system:cea-after-close', trigger, cfg, deadlineAt: deadline });
    ceaLastRun = { at: new Date().toISOString(), trigger, summary };
    return summary;
  } finally {
    ceaRunning = false;
  }
}

/** 暴露北京时间下一次运行时间算法，便于测试时区跨天（不启动定时器） */
export const __test = { nextRun, parseCloseTime, ceaAfterCloseEnabled, schedulerAllowed };
