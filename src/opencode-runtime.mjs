// 隔离的 OpenCode 运行时：发现 / 下载 / 校验 / 启动 / 停止。
//
// 与"用户自己装的 OpenCode"完全隔离：独立 XDG 目录、随机 Basic 口令、环境变量白名单。
// 这样插件的会话不会读到用户日常的 OpenCode 配置、登录态或项目规则。

import fs from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomBytes } from 'node:crypto';
import { extractMember } from './tar-mini.mjs';

const exec = promisify(execFile);
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const REGISTRIES = ['https://registry.npmjs.org', 'https://registry.npmmirror.com'];

export function runtimePackage(platform = process.platform, arch = process.arch) {
  if (!['darwin', 'win32', 'linux'].includes(platform) || !['x64', 'arm64'].includes(arch)) {
    throw new Error(`不支持的平台/架构：${platform}/${arch}`);
  }
  return {
    name: `opencode-${platform === 'win32' ? 'windows' : platform}-${arch}`,
    binary: platform === 'win32' ? 'opencode.exe' : 'opencode',
  };
}

function compareVersions(a, b) {
  const left = String(a).split(/[+-]/, 1)[0].split('.').map(Number);
  const right = String(b).split(/[+-]/, 1)[0].split('.').map(Number);
  for (let i = 0; i < 3; i += 1) if (left[i] !== right[i]) return (left[i] ?? 0) - (right[i] ?? 0);
  return 0;
}

/** 本机已装的 OpenCode 候选位置（只读探测，不修改它们）。 */
export function localCandidates(pkg = runtimePackage(), platform = process.platform, env = process.env, home = os.homedir()) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const configured = env.OPENCODE_PATH || env.DSH_OPENCODE_PATH;
  const installed = platform === 'win32'
    ? [p.join(home, '.opencode', 'bin', pkg.binary),
       p.join(env.APPDATA || p.join(home, 'AppData', 'Roaming'), 'npm', 'node_modules', 'opencode-ai', 'bin', pkg.binary)]
    : [p.join(home, '.opencode', 'bin', pkg.binary), '/opt/homebrew/bin/opencode', '/usr/local/bin/opencode'];
  return [configured, ...installed].filter(Boolean);
}

async function probeVersion(file, timeout = 15000) {
  const { stdout } = await exec(file, ['--version'], { timeout, windowsHide: true });
  return stdout.trim();
}

/** 从 npm tarball 里取出那一个二进制（自带最小 tar 读取器，零外部依赖）。 */
async function extractBinary(archive, staging, member) {
  await fs.mkdir(staging, { recursive: true });
  const destination = path.join(staging, path.basename(member));
  const ok = await extractMember(archive, member, destination);
  if (!ok) throw new Error(`压缩包里没有 ${member}`);
}

async function sha512Of(file) {
  const hash = createHash('sha512');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return `sha512-${hash.digest('base64')}`;
}

/**
 * 确保有一份可用的隔离 OpenCode：
 *  1) 本机已有（含用户显式配置的路径）→ 复制进托管目录
 *  2) 托管目录里已有同版本 → 直接用
 *  3) 都没有 → 从 npm 官方源（回退国内镜像）下载，SHA-512 校验后解压
 * 返回可执行文件的绝对路径与版本。
 */
export async function ensureRuntime({ dataDir, configured, log = () => {}, fetchImpl = globalThis.fetch, signal } = {}) {
  const pkg = runtimePackage();
  const root = path.join(dataDir, 'runtime');
  await fs.mkdir(root, { recursive: true, mode: 0o700 });

  // 已托管的版本（目录名即版本号，二进制自报版本必须一致）。
  const installed = [];
  for (const entry of await fs.readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory() || !VERSION_RE.test(entry.name)) continue;
    const file = path.join(root, entry.name, pkg.binary);
    try {
      const version = await probeVersion(file);
      if (version === entry.name) installed.push({ file, version });
    } catch { /* 版本对不上就忽略这个目录 */ }
  }
  installed.sort((a, b) => compareVersions(b.version, a.version));

  // 显式配置的路径优先，且优先于托管目录（用户说了算）。
  const explicit = configured?.trim();
  if (explicit) {
    try {
      const version = await probeVersion(explicit);
      if (!VERSION_RE.test(version)) throw new Error(`无法识别的版本输出：${version}`);
      const target = path.join(root, version, pkg.binary);
      if (await probeVersion(target).then((v) => v === version, () => false)) return { file: target, version };
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.copyFile(explicit, target);
      await fs.chmod(target, 0o755).catch(() => {});
      return { file: target, version };
    } catch (error) {
      log(`配置的 OpenCode 路径不可用（${explicit}）：${error.message}`);
    }
  }

  // 本机已装的候选：复制进托管目录，之后不再依赖原位置。
  for (const candidate of localCandidates(pkg)) {
    if (/\.(?:cmd|bat|ps1)$/i.test(candidate)) continue; // 启动脚本不是可执行映像
    try {
      const version = await probeVersion(candidate);
      if (!VERSION_RE.test(version)) continue;
      const target = path.join(root, version, pkg.binary);
      if (await probeVersion(target).then((v) => v === version, () => false)) return { file: target, version };
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.copyFile(candidate, target);
      await fs.chmod(target, 0o755).catch(() => {});
      log(`已把本机的 OpenCode ${version} 复制进托管目录：${candidate}`);
      return { file: target, version };
    } catch { /* 下一个候选 */ }
  }

  if (installed.length) {
    log(`复用已托管的 OpenCode ${installed[0].version}`);
    return installed[0];
  }

  // 下载。元数据必须可信：包名、版本形状、sha512、tarball 域名与路径前缀。
  const failures = [];
  for (const registry of REGISTRIES) {
    try {
      const response = await fetchImpl(`${registry}/${pkg.name}/latest`, { signal: AbortSignal.timeout(30000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const metadata = await response.json();
      const dist = metadata?.dist;
      let tarball;
      try { tarball = new URL(dist?.tarball); } catch { throw new Error('元数据缺少 tarball'); }
      if (metadata.name !== pkg.name || !VERSION_RE.test(metadata.version ?? '')
        || !dist?.integrity?.startsWith('sha512-')
        || !REGISTRIES.some((r) => tarball.origin === r)
        || !tarball.pathname.startsWith(`/${pkg.name}/-/`)) {
        throw new Error('官方元数据不可信');
      }
      log(`正在下载 OpenCode ${metadata.version}（${tarball.hostname}）`);
      const target = path.join(root, metadata.version, pkg.binary);
      await fs.mkdir(path.dirname(target), { recursive: true });
      const archive = path.join(path.dirname(target), 'download.tgz');
      const sources = [...new Set([metadata.dist.tarball,
        ...REGISTRIES.map((r) => `${r}/${pkg.name}/-/${pkg.name}-${metadata.version}.tgz`)])];
      let done = false;
      let checksumFailed = false;
      for (const source of sources) {
        try {
          const res = await fetchImpl(source, { signal: AbortSignal.timeout(180000) });
          if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
          await pipeline(Readable.fromWeb(res.body), createWriteStream(archive));
          // 镜像的字节必须匹配官方 integrity：这是镜像被换字节时唯一能拦住的地方。
          if (await sha512Of(archive) !== metadata.dist.integrity) {
            checksumFailed = true;
            throw new Error('完整性校验失败');
          }
          done = true;
          break;
        } catch (error) { failures.push(`${new URL(source).hostname}: ${error.message}`); }
      }
      if (!done) {
        await fs.unlink(archive).catch(() => {});
        if (checksumFailed) throw new Error('OpenCode 下载校验失败');
        throw new Error(`下载失败（${failures.join('；')}）`);
      }
      const staging = await fs.mkdtemp(path.join(path.dirname(target), 'extract-'));
      try {
        await extractBinary(archive, staging, `package/bin/${pkg.binary}`);
        await fs.rename(path.join(staging, pkg.binary), target);
      } finally {
        await fs.rm(staging, { recursive: true, force: true });
        await fs.unlink(archive).catch(() => {});
      }
      await fs.chmod(target, 0o755).catch(() => {});
      if (await probeVersion(target) !== metadata.version) throw new Error('下载后的版本与元数据不符');
      return { file: target, version: metadata.version };
    } catch (error) {
      failures.push(`${new URL(registry).hostname}: ${error.message}`);
    }
  }
  throw new Error(`找不到也无法下载 OpenCode 运行时（${failures.join('；')}）`);
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

// 会话级权限表就是围栏本身：本机动作一律要审批，适配器只会拒绝它们。
// 其余原生能力（提问、联网、子任务、计划、待办）直接拒绝，模型没有别的出路。
export const nativePermissions = {
  '*': 'ask',
  question: 'deny',
  websearch: 'deny',
  codesearch: 'deny',
  webfetch: 'deny',
  task: 'deny',
  plan_enter: 'deny',
  plan_exit: 'deny',
  todowrite: 'deny',
};

const ISOLATED_AGENT = {
  mode: 'primary',
  description: 'External client inference only',
  prompt: 'You are the reasoning component of an external assistant. Never invoke native tools. Describe external actions only inside the requested JSON response. The external client owns execution.',
  permission: nativePermissions,
};

/**
 * 启动隔离的 `opencode serve`。
 * 环境变量按名白名单复制：别的 provider 的密钥、以及用户自己的 OpenCode 授权都不会带进来。
 */
export async function startOpenCode({ binary, dataDir, log = () => {}, signal } = {}) {
  const root = path.join(dataDir, 'opencode');
  for (const dir of ['config', 'data', 'cache', 'state', 'project']) {
    await fs.mkdir(path.join(root, dir), { recursive: true, mode: 0o700 });
  }

  const env = {};
  for (const key of ['PATH', 'HOME', 'USER', 'LANG', 'TMPDIR', 'SHELL', 'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS',
    'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PATHEXT', 'COMSPEC']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  for (const name of ['config', 'data', 'cache', 'state']) env[`XDG_${name.toUpperCase()}_HOME`] = path.join(root, name);

  const password = randomBytes(24).toString('hex');
  Object.assign(env, {
    OPENCODE_SERVER_PASSWORD: password,
    OPENCODE_SERVER_USERNAME: 'opencode',
    OPENCODE_DISABLE_AUTOUPDATE: 'true',
    OPENCODE_DISABLE_PROJECT_CONFIG: 'true',
    OPENCODE_DISABLE_CLAUDE_CODE: 'true',
    OPENCODE_DISABLE_EXTERNAL_SKILLS: 'true',
  });

  const port = await freePort();
  const child = spawn(binary, ['serve', '--pure', '--hostname', '127.0.0.1', '--port', String(port)], {
    cwd: path.join(root, 'project'),
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const version = await probeVersion(binary).catch(() => undefined);
  const logLine = (chunk) => {
    const text = String(chunk).trim();
    if (text) log(`[opencode] ${text.slice(0, 500)}`);
  };
  child.stdout.on('data', logLine);
  child.stderr.on('data', logLine);

  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGTERM');
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 4000)),
    ]);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  };

  const base = `http://127.0.0.1:${port}`;
  const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;

  // 就绪判据是健康检查，不是"进程还活着"。
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    if (signal?.aborted) { await stop(); throw new Error('启动被取消'); }
    if (child.exitCode !== null) { await stop(); throw new Error(`OpenCode 启动即退出（code ${child.exitCode}）`); }
    try {
      const response = await fetch(`${base}/global/health`, { headers: { Authorization: authorization }, signal: AbortSignal.timeout(2000) });
      if (response.ok) {
        const health = await response.json();
        if (health?.healthy) return { base, authorization, password, stop, child, port, version: health.version ?? version };
      }
    } catch { /* 还没起来 */ }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  await stop();
  throw new Error('OpenCode 启动超时');
}
