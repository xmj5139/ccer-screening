/**
 * 无管道异步子进程执行（docs/36 第 2 条的实现基础）
 * ============================================================================
 * 【为什么不用 execFile】
 *   `execFile` / `exec` 默认用**管道**捕获子进程 stdout/stderr。在受限运行环境
 *   （本机沙箱/部分企业终端管控）里，子进程被禁止打开命名管道，会直接返回
 *   `EPERM: spawn EPERM` —— 表现为「本机缺少 pdftotext」，但其实是采集不到输出。
 *   同一个坑在 `src/core/secrets.mjs` 的 ACL 校验里已经踩过，那里用
 *   「命令写文件 + 父进程读文件」绕过。
 *
 * 【本模块的做法】
 *   用 `spawn` 把子进程的 stdout / stderr **直接重定向到普通文件描述符**（不是管道），
 *   结束后父进程读文件。这样：
 *     · 依然是**异步**的（不阻塞事件循环，可设真实超时并真正 kill）；
 *     · 依然不经过 shell（参数以数组传入，无注入面）；
 *     · 不依赖管道，在受限环境与生产环境行为一致。
 *
 * 本模块只做「跑一个本机工具并取回输出」，不含任何业务判断。
 */
import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * 异步执行本机工具，stdout/stderr 写入临时文件后读回。
 *
 * @param {string} cmd 可执行文件（不经 shell）
 * @param {string[]} args 参数数组
 * @param {{timeoutMs?:number, tag?:string, env?:object, cwd?:string}} [opts]
 * @returns {Promise<{ok:boolean, code:number|null, signal:string|null, stdout:string, stderr:string,
 *                    error?:string, timedOut?:boolean, missing?:boolean, elapsed_ms:number}>}
 */
export function runToolToFile(cmd, args, { timeoutMs = 30000, tag = 'tool', env = null, cwd = null } = {}) {
  const started = Date.now();
  const dir = join(
    tmpdir(),
    `ccer-${tag}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  );
  const outFile = join(dir, 'stdout.txt');
  const errFile = join(dir, 'stderr.txt');
  const budget = Math.max(500, Number(timeoutMs) || 30000);

  return new Promise((resolve) => {
    let outFd = null;
    let errFd = null;
    let child = null;
    let timer = null;
    let settled = false;

    const readSafe = (p) => {
      try {
        return readFileSync(p, 'utf8');
      } catch {
        return '';
      }
    };
    const cleanup = () => {
      try { if (outFd !== null) closeSync(outFd); } catch { /* 已关闭 */ }
      try { if (errFd !== null) closeSync(errFd); } catch { /* 已关闭 */ }
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* 临时目录清理失败不影响结论 */ }
    };
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      const stdout = readSafe(outFile);
      const stderr = readSafe(errFile);
      cleanup();
      resolve({ stdout, stderr, elapsed_ms: Date.now() - started, ...result });
    };

    try {
      mkdirSync(dir, { recursive: true });
      outFd = openSync(outFile, 'w');
      errFd = openSync(errFile, 'w');
    } catch (e) {
      return finish({ ok: false, code: null, signal: null, error: `无法创建临时输出文件：${e.message}` });
    }

    try {
      child = spawn(cmd, args, {
        stdio: ['ignore', outFd, errFd],
        windowsHide: true,
        ...(env ? { env } : {}),
        ...(cwd ? { cwd } : {}),
      });
    } catch (e) {
      return finish({
        ok: false, code: e?.code ?? null, signal: null,
        missing: e?.code === 'ENOENT',
        error: e?.code === 'ENOENT' ? `未安装 ${cmd}` : `${cmd} 启动失败：${e.message}`,
      });
    }

    timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* 进程可能已退出 */ }
    }, budget);

    child.on('error', (e) => {
      finish({
        ok: false, code: e?.code ?? null, signal: null,
        missing: e?.code === 'ENOENT',
        error: e?.code === 'ENOENT' ? `未安装 ${cmd}` : `${cmd} 启动失败：${e.message}`,
        timedOut: false,
      });
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      if (signal) {
        return finish({
          ok: false, code: code ?? null, signal,
          timedOut: true,
          error: `${cmd} 超时或被杀（${budget}ms）`,
        });
      }
      const stderr = readSafe(errFile);
      finish({
        ok: code === 0,
        code: code ?? null,
        signal: null,
        error: code === 0 ? undefined : `${cmd} 退出码 ${code}${stderr ? `：${stderr.slice(0, 200).trim()}` : ''}`,
      });
    });
  });
}

/**
 * 便捷封装：把一个本机工具的输出取回为字符串，失败时给出统一的中文原因。
 * 与 `execFile` 的 promisify 版本语义接近，但不使用管道。
 */
export async function execTool(cmd, args, { timeoutMs = 30000, tag = 'tool' } = {}) {
  const r = await runToolToFile(cmd, args, { timeoutMs, tag });
  if (!r.ok) {
    const err = new Error(
      r.missing ? `未安装 ${cmd}（需要 poppler-utils）` : (r.error || `${cmd} 执行失败`)
    );
    err.code = r.missing ? 'ENOENT' : r.code;
    err.timedOut = !!r.timedOut;
    err.stderr = r.stderr;
    throw err;
  }
  return { stdout: r.stdout, stderr: r.stderr };
}
