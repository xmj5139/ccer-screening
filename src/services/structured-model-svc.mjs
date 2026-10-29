/**
 * 结构化模型输出的可靠性加固（docs/54 第 E 节）
 * ============================================================================
 * 统一处理：空 content、finish_reason=length/截断、非 JSON 包装、必填字段缺失、
 * 类型/长度不合格，以及最多一次的可恢复重试。401/402/403、网络、超时不会盲目重试；
 * 不采用无界续写。所有失败都返回明确原因，由调用方落库为 failed/skipped，绝不伪装成功。
 */
import { callVerifyModel, isDeepSeekEndpoint } from './verification-svc.mjs';
import { capabilityConfig, capabilityPublic } from './deepseek-capability-svc.mjs';

const RECOVERABLE = new Set(['empty_content', 'truncated', 'json_invalid', 'missing_fields', 'invalid_fields']);

/** 按简单规格校验 JSON 对象：支持 string/number/boolean/array/object 与 min/max/enum。 */
export function validateStructured(parsed, spec = {}) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'json_invalid', detail: '模型输出不是 JSON 对象' };
  }
  const errors = [];
  for (const [key, rule] of Object.entries(spec || {})) {
    if (!rule) continue;
    const required = rule.required !== false;
    const value = parsed[key];
    if (value === undefined || value === null) {
      if (required) errors.push({ field: key, reason: 'missing' });
      continue;
    }
    const type = rule.type || 'string';
    if (type === 'string') {
      if (typeof value !== 'string') {
        errors.push({ field: key, reason: 'type', expected: 'string', actual: typeof value });
        continue;
      }
      const s = value.trim();
      if (rule.min !== undefined && s.length < rule.min) errors.push({ field: key, reason: 'too_short', min: rule.min, actual: s.length });
      if (rule.max !== undefined && s.length > rule.max) errors.push({ field: key, reason: 'too_long', max: rule.max, actual: s.length });
    } else if (type === 'array') {
      if (!Array.isArray(value)) errors.push({ field: key, reason: 'type', expected: 'array', actual: typeof value });
      else {
        if (rule.min_items !== undefined && value.length < rule.min_items) errors.push({ field: key, reason: 'too_few_items', min: rule.min_items, actual: value.length });
        if (rule.max_items !== undefined && value.length > rule.max_items) errors.push({ field: key, reason: 'too_many_items', max: rule.max_items, actual: value.length });
        if (rule.item_type === 'string' && value.some((v) => typeof v !== 'string')) {
          errors.push({ field: key, reason: 'item_type', expected: 'string' });
        }
      }
    } else if (type === 'number') {
      if (typeof value !== 'number' || !Number.isFinite(value)) errors.push({ field: key, reason: 'type', expected: 'number', actual: typeof value });
      else {
        if (rule.min !== undefined && value < rule.min) errors.push({ field: key, reason: 'below_min', min: rule.min, actual: value });
        if (rule.max !== undefined && value > rule.max) errors.push({ field: key, reason: 'above_max', max: rule.max, actual: value });
      }
    } else if (type === 'boolean') {
      if (typeof value !== 'boolean') errors.push({ field: key, reason: 'type', expected: 'boolean', actual: typeof value });
    } else if (type === 'object') {
      if (!value || typeof value !== 'object' || Array.isArray(value)) errors.push({ field: key, reason: 'type', expected: 'object', actual: typeof value });
    }
    if (Array.isArray(rule.enum) && !rule.enum.includes(value)) {
      errors.push({ field: key, reason: 'enum', allowed: rule.enum, actual: value });
    }
  }
  if (errors.length) {
    const missing = errors.filter((e) => e.reason === 'missing');
    return {
      ok: false,
      reason: missing.length ? 'missing_fields' : 'invalid_fields',
      detail: missing.length
        ? `缺少必填字段：${missing.map((e) => e.field).join('、')}`
        : `字段不合格：${errors.map((e) => `${e.field}(${e.reason})`).join('、')}`,
      errors,
    };
  }
  return { ok: true, errors: [] };
}

function isTruncated(out) {
  if (!out?.ok) return false;
  if (String(out.finish_reason || '').toLowerCase() === 'length') return true;
  const raw = String(out.raw || '').trim();
  if (!raw) return false;
  // finish_reason 缺失时按 JSON 括号/引号是否闭合做保守判断
  if (!raw.startsWith('{')) return false;
  try {
    JSON.parse(raw);
    return false;
  } catch {
    return true;
  }
}

function shortReason(r) {
  const map = {
    no_provider: '未配置可用模型',
    no_credential: '模型凭据未配置或不可解密',
    quota_exceeded: '模型今日调用额度已用尽',
    http_error: '模型接口返回错误',
    timeout: '模型响应超时',
    network: '模型网络不可达',
    empty_content: '模型返回空内容',
    truncated: '模型输出达到长度上限被截断',
    json_invalid: '模型输出不是合法 JSON',
    missing_fields: '模型输出缺少必填字段',
    invalid_fields: '模型输出字段类型/长度不合格',
  };
  return map[r] || `模型输出不可用（${r}）`;
}

/**
 * 调用结构化模型并校验；仅对可恢复的“输出形态”问题最多重试一次。
 * @param {object} opts
 * @param {object} opts.provider
 * @param {string} opts.prompt
 * @param {string} opts.systemPrompt
 * @param {object} opts.requiredFields  validateStructured 规格
 * @param {string} opts.purpose
 * @param {number} opts.maxTokens
 * @param {number} opts.timeoutMs
 * @param {string} opts.thinking 'disabled'|'enabled'
 * @param {string} opts.reasoningEffort
 */
export async function callStructuredModel({
  provider, prompt, systemPrompt, requiredFields = {}, purpose = 'structured',
  maxTokens = 1200, timeoutMs = 45000, thinking = 'disabled', reasoningEffort = null,
  actor = 'system:structured', objectType = 'model', objectId = null, repairHint = null,
  messages = null, maxRetries = null,
} = {}) {
  const cfg = capabilityConfig('json');
  const maxRetry = Math.max(0, Math.min(Number(maxRetries ?? cfg.max_retry ?? 1), 1)); // 硬上限 1 次
  const budgetCap = Math.max(Number(maxTokens) || 1200, Number(cfg.max_output_tokens) || 2200);
  const jsonMode = isDeepSeekEndpoint(provider);
  let attempts = 0;
  let last = null;
  let lastVerdict = null;
  let currentMax = Math.min(budgetCap, Math.max(200, Number(maxTokens) || 1200));
  let currentPrompt = String(prompt || '');
  let currentSystem = String(systemPrompt || '');
  let currentMessages = Array.isArray(messages) ? messages.map((m) => ({ ...m })) : null;
  // DeepSeek JSON Output 要求提示词含 json 字样与格式示例。
  const textForJsonHint = `${currentSystem}\n${currentPrompt}\n${currentMessages ? JSON.stringify(currentMessages.filter((m) => typeof m.content === 'string')) : ''}`;
  if (!/json/i.test(textForJsonHint)) {
    currentSystem += '\n\n只输出 JSON 对象；json 示例：{"result":"..."}。';
  }

  while (attempts <= maxRetry) {
    attempts += 1;
    const out = await callVerifyModel({
      provider,
      prompt: currentPrompt,
      systemPrompt: currentSystem,
      purpose,
      actor,
      objectType,
      objectId,
      maxTokens: currentMax,
      timeoutMs,
      thinking,
      reasoningEffort,
      jsonMode,
      retryCount: attempts - 1,
      messages: currentMessages,
    });
    last = out;

    if (!out.ok) {
      // 非输出形态失败（401/402/403/配额/网络/超时）不重试。
      // JSON 语法失败/空内容属于可恢复的输出形态问题，交给下面的单次修复。
      if (out.reason !== 'json_invalid') {
        return {
          ok: false, reason: out.reason, detail: out.detail || shortReason(out.reason),
          attempts, retry_count: attempts - 1, provider, raw: out.raw || null,
          usage: out.usage || null, finish_reason: out.finish_reason || null,
          diagnostics: { retryable: false, category: out.reason },
        };
      }
      lastVerdict = String(out.finish_reason || '').toLowerCase() === 'length'
        ? { ok: false, reason: 'truncated', detail: shortReason('truncated') }
        : { ok: false, reason: out.raw ? 'json_invalid' : 'empty_content', detail: out.detail || shortReason('json_invalid') };
    } else if (!String(out.raw || '').trim()) {
      lastVerdict = { ok: false, reason: 'empty_content', detail: shortReason('empty_content') };
    } else if (isTruncated(out)) {
      lastVerdict = { ok: false, reason: 'truncated', detail: shortReason('truncated') };
    } else if (!out.parsed) {
      lastVerdict = { ok: false, reason: 'json_invalid', detail: shortReason('json_invalid') };
    } else {
      lastVerdict = validateStructured(out.parsed, requiredFields);
      if (!lastVerdict.ok) lastVerdict.detail = lastVerdict.detail || shortReason(lastVerdict.reason);
    }
    if (lastVerdict.ok) {
      return {
        ok: true, parsed: out.parsed, raw: out.raw, provider, attempts, retry_count: attempts - 1,
        usage: out.usage || null, finish_reason: out.finish_reason || null,
        thinking: out.thinking || null, latency_ms: out.latency_ms,
      };
    }
    if (!RECOVERABLE.has(lastVerdict.reason) || attempts > maxRetry) break;

    // 单次修复：增大输出预算并把提示收敛到“只输出合法 JSON”，不无界续写。
    currentMax = Math.min(budgetCap, Math.max(currentMax * 2, currentMax + 400));
    const repair = repairHint
      || `上一次输出不可用（${lastVerdict.reason}）。请重新输出**一个完整、合法、未被截断的 JSON 对象**，` +
        '不要代码块、不要解释；只保留要求的字段。';
    if (!currentSystem.includes('上一次输出不可用')) currentSystem += `\n\n${repair}`;
    currentPrompt = String(prompt || '');
    if (currentMessages) {
      currentMessages = [
        ...currentMessages,
        { role: 'user', content: repair },
      ];
    }
  }

  return {
    ok: false,
    reason: lastVerdict?.reason || 'json_invalid',
    detail: lastVerdict?.detail || shortReason(lastVerdict?.reason || 'json_invalid'),
    errors: lastVerdict?.errors || [],
    attempts, retry_count: attempts - 1, provider,
    raw: last?.raw || null, usage: last?.usage || null, finish_reason: last?.finish_reason || null,
    diagnostics: {
      retryable: true,
      recovered: false,
      category: lastVerdict?.reason || 'json_invalid',
      capability: capabilityPublic('json')?.budget || null,
    },
  };
}
