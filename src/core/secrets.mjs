/**
 * 服务端凭据库
 * ============================================================================
 * 解决的问题（docs/19 第 59 条、docs/22 第 5 条）：
 *   「输入密钥但缺加密主密钥时应在页面提供可操作提示。可以实现持久、权限受限的
 *     本机密钥文件初始化来简化本地使用，但不能硬编码密钥/明文保存 API Key。」
 *
 * 设计：
 *   1. 主密钥（master key）解析顺序：
 *        a. 环境变量 CCER_SECRET_KEY（部署推荐，容器/密钥管理注入）
 *        b. 本机密钥文件 <数据库目录>/keys/master.key —— 首次 `initMasterKeyFile()` 时生成
 *           32 字节随机密钥。
 *           · 路径跟随 **当前数据库路径**（隔离库 → 隔离密钥文件），
 *             因此自动化测试不会污染真实使用中的密钥文件；
 *             可用 CCER_KEY_DIR 显式覆盖。
 *           · POSIX：chmod 0600 并**校验**权限位；
 *           · Windows：用 icacls 关闭继承并只授予当前用户，且**回读 ACL 校验**；
 *             无法设置或无法校验时**拒绝初始化**（不留弱权限文件），
 *             并提示改用 CCER_SECRET_KEY。
 *   2. 凭据本体一律用 AES-256-GCM 加密后存入数据库列（`v1:<iv>:<tag>:<ct>`），
 *      数据库里不存在明文；任何 API 响应、日志、导出都只返回「是否已配置」。
 *   3. 本模块**不读取、不打印**任何密钥值；`keyStatus()` 只返回来源与可用性。
 *
 * 明确不做的事：不生成、不保存、不返回任何第三方服务的密钥明文。
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { PROJECT_ROOT, dbPath } from './db.mjs';

const CIPHER_PREFIX = 'v1';

/** 默认密钥目录：跟随数据库目录（隔离库 → 隔离密钥），可用 CCER_KEY_DIR 覆盖。 */
export function defaultKeyDir() {
  if (process.env.CCER_KEY_DIR) return resolve(process.env.CCER_KEY_DIR);
  try {
    return join(dirname(resolve(dbPath())), 'keys');
  } catch {
    return join(PROJECT_ROOT, 'data', 'keys');
  }
}

/**
 * 当前密钥目录与密钥文件路径。
 * 以 `let` 导出：数据库路径在运行期变化（测试切换隔离库）时，导入方仍能读到最新值。
 */
export let KEY_DIR = defaultKeyDir();
export let KEY_FILE = join(KEY_DIR, 'master.key');

/** 重新解析路径（幂等；仅在数据库/环境变化时改变）。 */
export function refreshKeyPaths() {
  const dir = defaultKeyDir();
  if (dir !== KEY_DIR) {
    KEY_DIR = dir;
    KEY_FILE = join(KEY_DIR, 'master.key');
    _cachedKey = null;
    _cachedSource = null;
  }
  return { KEY_DIR, KEY_FILE };
}
refreshKeyPaths();

let _cachedKey = null;
let _cachedSource = null;

/** 从文件读取主密钥（仅当文件存在且长度合法） */
function readKeyFile() {
  try {
    refreshKeyPaths();
    if (!existsSync(KEY_FILE)) return null;
    const raw = readFileSync(KEY_FILE, 'utf8').trim();
    if (!raw) return null;
    const buf = Buffer.from(raw, 'base64');
    if (buf.length !== 32) return null;
    return buf;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/*  ACL / 权限：真实设置 + 真实校验                                     */
/* ------------------------------------------------------------------ */

/**
 * 无管道执行外部命令（沙箱禁止子进程打开命名管道，因此不用 stdio:'pipe'）。
 * 需要读取输出时由命令自身写入临时文件，父进程再读文件。
 * @returns {{ok:boolean, status:number|null, error:string|null}}
 */
function spawnNoPipe(cmd, args, { timeoutMs = 15000 } = {}) {
  try {
    // 从 PowerShell 7 启动时，Windows PowerShell 5 不能加载继承的 7.x 模块。
    const env = process.platform === 'win32' && cmd === 'powershell.exe'
      ? { ...process.env, PSModulePath: join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'Modules') }
      : process.env;
    const r = spawnSync(cmd, args, { stdio: 'ignore', windowsHide: true, timeout: timeoutMs, env });
    return { ok: r.status === 0, status: r.status, error: r.error ? String(r.error.code || r.error.message) : null };
  } catch (e) {
    return { ok: false, status: null, error: String(e.code || e.message) };
  }
}

function powershellExe() {
  return process.platform === 'win32' ? 'powershell.exe' : 'pwsh';
}

/** 用「命令写文件 + 父进程读文件」的方式取回命令输出（不经过管道）。 */
function captureViaFile(command, { timeoutMs = 20000 } = {}) {
  const out = join(tmpdir(), `ccer-acl-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
  const quotedOut = out.replace(/'/g, "''");
  const script = `$ErrorActionPreference='Stop'; try { & { ${command} } | Out-File -LiteralPath '${quotedOut}' -Encoding utf8 } catch { $_.Exception.Message | Out-File -LiteralPath '${quotedOut}' -Encoding utf8; exit 1 }`;
  const r = spawnNoPipe(powershellExe(), ['-NoProfile', '-NonInteractive', '-Command', script], { timeoutMs });
  let text = '';
  try {
    if (existsSync(out)) text = readFileSync(out, 'utf8');
  } catch {
    text = '';
  }
  try {
    if (existsSync(out)) rmSync(out, { force: true });
  } catch {
    /* 临时文件清理失败不影响结论 */
  }
  return { ...r, text, error: r.error || (!r.ok ? text.trim().slice(0,300) : null) };
}

/** Windows：关闭继承并只授予当前用户（读写）。返回执行结果，不做结论。 */
function applyWindowsAcl(file) {
  const f = file.replace(/'/g, "''");
  const script =
    `$p='${f}';` +
    `$acl=Get-Acl -LiteralPath $p;` +
    `$acl.SetAccessRuleProtection($true,$false);` +
    `foreach($r in @($acl.Access)){ [void]$acl.RemoveAccessRule($r) };` +
    `$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User;` +
    `$rule=New-Object System.Security.AccessControl.FileSystemAccessRule($sid,'FullControl','Allow');` +
    `$acl.SetAccessRule($rule);` +
    `Set-Acl -LiteralPath $p -AclObject $acl;` +
    `'ACL_APPLIED'`;
  const r = captureViaFile(script);
  return { ok: r.ok && /ACL_APPLIED/.test(r.text), error: r.ok ? null : (r.error || `PowerShell 退出码 ${r.status}`) };
}

/**
 * Windows：回读 ACL 校验——必须是「已关闭继承」且只包含当前用户，
 * 不得出现 Everyone / Users / Authenticated Users 等宽泛主体。
 */
function verifyWindowsAcl(file) {
  const f = file.replace(/'/g, "''");
  const script =
    `$p='${f}';` +
    `$acl=Get-Acl -LiteralPath $p;` +
    `'CURRENT=' + [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value;` +
    `'PROTECTED=' + $acl.AreAccessRulesProtected;` +
    `$acl.Access | ForEach-Object { 'RULE=' + $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value + '|' + $_.FileSystemRights + '|' + $_.AccessControlType }`;
  const r = captureViaFile(script);
  if (!r.ok || !/PROTECTED=/.test(r.text)) {
    return { verified: false, error: r.error || 'ACL 回读失败（无法执行 PowerShell/Get-Acl）', raw: '' };
  }
  const protectedRules = /PROTECTED=True/i.test(r.text);
  const rules = r.text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith('RULE='));
  const currentSid = r.text.match(/CURRENT=(S-[\d-]+)/)?.[1];
  const wide = rules.filter((l) => l.split('|')[0].replace(/^RULE=/, '').trim() !== currentSid || !l.endsWith('|Allow'));
  return {
    verified: protectedRules && !!currentSid && rules.length > 0 && wide.length === 0,
    protected: protectedRules,
    rules: rules.map((l) => l.replace(/^RULE=/, '')),
    broad_rules: wide,
    error: protectedRules ? (wide.length ? `存在宽泛访问主体：${wide.join('；')}` : null) : 'ACL 继承未关闭',
  };
}

/** POSIX：设置并校验 0600（仅属主可读写）。 */
function applyPosixMode(file) {
  try {
    chmodSync(file, 0o600);
  } catch (e) {
    return { ok: false, error: `chmod 0600 失败：${e.message}` };
  }
  try {
    const mode = statSync(file).mode & 0o777;
    if (mode & 0o077) return { ok: false, error: `权限位仍为 ${mode.toString(8)}，未收紧为 600` };
    return { ok: true, mode: mode.toString(8) };
  } catch (e) {
    return { ok: false, error: `读取权限位失败：${e.message}` };
  }
}

/**
 * 当前主密钥状态（**不返回值本身**）。
 * @returns {{available:boolean, source:'env'|'file'|null, key_file:string, key_dir:string,
 *            key_file_exists:boolean, key_file_mode:string|null, acl_verified:boolean|null,
 *            acl_note:string|null, isolated:boolean, can_init_file:boolean, hint:string}}
 */
export function keyStatus() {
  refreshKeyPaths();
  const envSet = !!process.env.CCER_SECRET_KEY;
  const fileKey = readKeyFile();
  const available = envSet || !!fileKey;
  let mode = null;
  let acl = { verified: null, note: null };
  if (existsSync(KEY_FILE) && process.platform !== 'win32') {
    try {
      mode = (statSync(KEY_FILE).mode & 0o777).toString(8);
    } catch {
      mode = null;
    }
    acl = { verified: mode === '600', note: mode === '600' ? '文件权限 0600（仅属主可读写）' : `权限位为 ${mode}` };
  } else if (existsSync(KEY_FILE) && process.platform === 'win32') {
    const v = verifyWindowsAcl(KEY_FILE);
    acl = { verified: v.verified, note: v.error || `ACL：${(v.rules || []).join('；')}` };
  }
  const isolated = resolve(KEY_DIR) !== resolve(join(PROJECT_ROOT, 'data', 'keys'));
  return {
    available,
    source: envSet ? 'env' : fileKey ? 'file' : null,
    key_dir: KEY_DIR,
    key_file: KEY_FILE,
    key_file_exists: existsSync(KEY_FILE),
    key_file_mode: mode,
    acl_verified: acl.verified,
    acl_note: acl.note,
    isolated_key_dir: isolated,
    can_init_file: !envSet && !fileKey,
    hint: available
      ? envSet
        ? '主密钥来自环境变量 CCER_SECRET_KEY。'
        : `主密钥来自本机受限密钥文件（${KEY_FILE}）。`
      : '尚未初始化主密钥：无法加密保存凭据。可在「后台管理 → 模型与连接」点击「初始化本机主密钥」，' +
        '或由运维设置环境变量 CCER_SECRET_KEY。未初始化前只能使用「环境变量凭据引用名」方式。',
  };
}

/**
 * 初始化本机主密钥文件（幂等：已存在则原样保留，不轮换、不覆盖）。
 * 只有**真实设置并校验通过**受限权限后才保留文件；否则删除并拒绝初始化。
 * @returns {{ok:boolean, refused?:boolean, created:boolean, path:string, mode?:string|null,
 *            acl_verified?:boolean|null, message:string, hint?:string}}
 */
export function initMasterKeyFile() {
  refreshKeyPaths();
  if (process.env.CCER_SECRET_KEY) {
    return {
      ok: true, created: false, path: KEY_FILE, mode: null,
      message: '已使用环境变量 CCER_SECRET_KEY，无需生成本机密钥文件。',
    };
  }
  if (existsSync(KEY_FILE)) {
    const st = statSync(KEY_FILE);
    const mode = process.platform === 'win32' ? null : (st.mode & 0o777).toString(8);
    const acl = process.platform === 'win32' ? verifyWindowsAcl(KEY_FILE) : { verified: mode === '600', error: null };
    if (acl.verified) {
      return {
        ok: true, created: false, path: KEY_FILE, mode, acl_verified: true,
        message: '本机主密钥文件已存在且权限受限，保持不变（不会覆盖，避免既有密文失效）。',
      };
    }
    return {
      ok: false, refused: true, created: false, path: KEY_FILE, mode, acl_verified: false,
      message: `已存在的密钥文件权限未通过校验（${acl.error || '权限过宽'}），拒绝继续使用。`,
      hint: '请修复该文件权限（仅当前用户可读写）后重试，或改用环境变量 CCER_SECRET_KEY（凭据不入库）。',
    };
  }
  mkdirSync(KEY_DIR, { recursive: true });
  const key = randomBytes(32);
  writeFileSync(KEY_FILE, `${key.toString('base64')}\n`, { encoding: 'utf8', mode: 0o600 });

  const acl = process.platform === 'win32' ? applyWindowsAcl(KEY_FILE) : applyPosixMode(KEY_FILE);
  let verified = null;
  let verifyError = acl.ok ? null : acl.error;
  if (acl.ok) {
    if (process.platform === 'win32') {
      const v = verifyWindowsAcl(KEY_FILE);
      verified = v.verified;
      verifyError = v.error;
    } else {
      verified = true;
    }
  }
  if (!verified) {
    // 无法真实设置/校验受限权限 → 删除刚生成的文件并拒绝初始化（不留弱权限私钥）
    try {
      rmSync(KEY_FILE, { force: true });
    } catch {
      /* ignore */
    }
    return {
      ok: false, refused: true, created: false, path: KEY_FILE, acl_verified: false,
      message:
        `拒绝初始化本机密钥文件：${process.platform === 'win32' ? 'Windows ACL' : '文件权限'}` +
        `无法设置或校验（${verifyError || '未知原因'}）；已删除刚生成的文件，避免留下权限过宽的私钥。`,
      hint:
        '可操作替代方案：由运维设置环境变量 CCER_SECRET_KEY（推荐，凭据完全不落库），' +
        '或修复本机权限后重试：Windows 可用 icacls 仅授予当前用户并关闭继承。',
    };
  }
  _cachedKey = null;
  _cachedSource = null;
  let mode = null;
  try {
    mode = process.platform === 'win32' ? null : (statSync(KEY_FILE).mode & 0o777).toString(8);
  } catch {
    mode = null;
  }
  return {
    ok: true, created: true, path: KEY_FILE, mode, acl_verified: true,
    message:
      '已生成本机主密钥文件（32 字节随机）；' +
      (process.platform === 'win32' ? '已用 ACL 关闭继承并只授予当前用户。' : '权限已设为 0600。') +
      '请勿提交到版本库或复制到其它机器。',
  };
}

/**
 * 取主密钥。**仅在本模块内部使用**；返回值绝不可写日志或返回给前端。
 * @returns {{key:Buffer|null, source:'env'|'file'|null}}
 */
export function masterKey() {
  if (_cachedKey) return { key: _cachedKey, source: _cachedSource };
  if (process.env.CCER_SECRET_KEY) {
    _cachedKey = createHash('sha256').update(String(process.env.CCER_SECRET_KEY)).digest();
    _cachedSource = 'env';
    return { key: _cachedKey, source: 'env' };
  }
  const fileKey = readKeyFile();
  if (fileKey) {
    // 文件里已是 32 字节随机密钥，直接作为 AES-256 密钥
    _cachedKey = fileKey;
    _cachedSource = 'file';
    return { key: _cachedKey, source: 'file' };
  }
  return { key: null, source: null };
}

export function secretsConfigured() {
  return !!masterKey().key;
}

/**
 * 加密凭据。未配置主密钥时返回 null（调用方必须据此拒绝保存明文）。
 * @param {string} plain
 * @returns {string|null}
 */
export function encryptSecret(plain) {
  const { key } = masterKey();
  if (!key) return null;
  if (plain === null || plain === undefined || plain === '') return null;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${CIPHER_PREFIX}:${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
}

/**
 * 解密凭据。失败（未配置主密钥 / 数据损坏 / 主密钥已更换）返回 null。
 * @param {string} payload
 * @returns {string|null}
 */
export function decryptSecret(payload) {
  const { key } = masterKey();
  if (!key || !payload) return null;
  const parts = String(payload).split(':');
  if (parts.length !== 4 || parts[0] !== CIPHER_PREFIX) return null;
  try {
    const iv = Buffer.from(parts[1], 'base64');
    const tag = Buffer.from(parts[2], 'base64');
    const data = Buffer.from(parts[3], 'base64');
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/**
 * 统一凭据解析：环境变量引用名 → 本机加密存储。
 * @param {{credential_ref?:string, credential_cipher?:string, label?:string}} conf
 * @returns {{ok:boolean, source?:string, secret?:string|null, reason?:string}}
 */
export function validCredentialRef(ref) {
  return ref === null || ref === undefined || String(ref).trim() === '' ||
    /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(String(ref).trim());
}

export const CREDENTIAL_REF_HINT = '环境变量名应填写 DEEPSEEK_API_KEY、BOCHA_API_KEY 等名称，不能填写实际 API 密钥。请把实际密钥填入下方“API 密钥”栏。';

export function redactCredentialText(text) {
  return text == null ? text : String(text).replace(/(?:sk|fc)-[A-Za-z0-9_-]{8,}/g, '[密钥已隐藏]');
}

export function resolveStoredCredential(conf = {}) {
  if (!validCredentialRef(conf.credential_ref)) return { ok: false, reason: CREDENTIAL_REF_HINT };
  const ref = conf.credential_ref ? String(conf.credential_ref).trim() : null;
  if (ref && process.env[ref]) {
    return { ok: true, source: `环境变量 ${ref}`, secret: process.env[ref] };
  }
  if (ref && process.env[`CCER_CONN_KEY_${ref}`]) {
    return { ok: true, source: `环境变量 CCER_CONN_KEY_${ref}`, secret: process.env[`CCER_CONN_KEY_${ref}`] };
  }
  const dec = decryptSecret(conf.credential_cipher);
  if (dec) return { ok: true, source: '服务端加密存储（AES-256-GCM）', secret: dec };
  if (conf.credential_cipher && !secretsConfigured()) {
    return {
      ok: false,
      reason: '数据库中有加密凭据，但当前服务端没有主密钥（CCER_SECRET_KEY 或本机密钥文件），无法解密。',
    };
  }
  if (conf.credential_cipher) {
    return { ok: false, reason: '加密凭据无法解密（主密钥可能已被更换）。请重新录入凭据。' };
  }
  return {
    ok: false,
    reason: ref
      ? `未找到凭据：请设置环境变量 ${ref}（或 CCER_CONN_KEY_${ref}），或在后台用主密钥加密保存。`
      : '未配置凭据（若该服务无需密钥可忽略）。',
  };
}
