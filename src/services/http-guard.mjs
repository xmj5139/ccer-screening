/**
 * v2 HTTP 守卫（读写守卫的单一实现）
 * ============================================================================
 * 原实现在 src/routes-v2.mjs 内部。CEA 路由（src/routes-cea.mjs）需要完全相同的
 * 语义，因此抽到本模块共用，避免两份实现出现安全差异。
 *
 * 语义（与原实现逐字一致）：
 *   - readGuard：v2 未启用 / 表结构未就绪 → 503（只读也拒绝，因为查询会打到不存在的表）
 *   - writeGuard：v2 可用性 + 生产库拒写 + 同源校验（CSRF）
 */
import { guardV2 } from './v2-guard.mjs';

/** 写操作守卫：v2 可用性 + 生产库拒写 + 同源校验（CSRF） */
export function writeGuard(ctx) {
  const g = guardV2({ write: true });
  if (g) return g;
  const headers = ctx.req?.headers || {};
  const hasBearer = /^Bearer\s+/i.test(String(headers.authorization || ''));
  // 1) Fetch Metadata（现代浏览器自动携带；跨站写请求直接拒绝）
  const site = headers['sec-fetch-site'];
  if (!hasBearer && site && !['same-origin', 'same-site', 'none'].includes(String(site))) {
    return { error: '跨站写操作被拒绝', message: `检测到跨站请求（sec-fetch-site: ${site}）。`, status: 403 };
  }
  // 2) Origin 校验（Cookie 会话下最关键的 CSRF 防线）
  const origin = headers.origin;
  if (!hasBearer && origin && origin !== 'null') {
    let originHost = null;
    try {
      originHost = new URL(String(origin)).host;
    } catch {
      originHost = null;
    }
    const reqHost = String(headers.host || '');
    if (!originHost || (reqHost && originHost !== reqHost)) {
      return {
        error: '跨站写操作被拒绝',
        message: `请求来源（Origin: ${origin}）与本站（${reqHost || '未知'}）不一致，已拒绝写入。`,
        status: 403,
      };
    }
  }
  return null;
}

export function readGuard() {
  return guardV2({ write: false });
}
