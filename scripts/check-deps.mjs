#!/usr/bin/env node
// 环境检查 + 确保 CDP Proxy 就绪（跨平台，替代 check-deps.sh）

import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROXY_SCRIPT = path.join(ROOT, 'scripts', 'cdp-proxy.mjs');
const PROXY_PORT = Number(process.env.CDP_PROXY_PORT || 3456);

// --- Node.js 版本检查 ---

function checkNode() {
  const major = Number(process.versions.node.split('.')[0]);
  const version = `v${process.versions.node}`;
  if (major >= 22) {
    console.log(`node: ok (${version})`);
  } else {
    console.log(`node: warn (${version}, 建议升级到 22+)`);
  }
}

// --- TCP 端口探测 ---

function checkPort(port, host = '127.0.0.1', timeoutMs = 2000) {
  return new Promise((resolve) => {
    const socket = net.createConnection(port, host);
    const timer = setTimeout(() => { socket.destroy(); resolve(false); }, timeoutMs);
    socket.once('connect', () => { clearTimeout(timer); socket.destroy(); resolve(true); });
    socket.once('error', () => { clearTimeout(timer); resolve(false); });
  });
}

// --- Chrome 调试端口检测（DevToolsActivePort 多路径 + 常见端口回退） ---

function activePortFiles() {
  const home = os.homedir();
  const localAppData = process.env.LOCALAPPDATA || '';
  switch (os.platform()) {
    case 'darwin':
      return [
        path.join(home, 'Library/Application Support/Google/Chrome/DevToolsActivePort'),
        path.join(home, 'Library/Application Support/Google/Chrome Canary/DevToolsActivePort'),
        path.join(home, 'Library/Application Support/Chromium/DevToolsActivePort'),
      ];
    case 'linux':
      return [
        path.join(home, '.config/google-chrome/DevToolsActivePort'),
        path.join(home, '.config/chromium/DevToolsActivePort'),
      ];
    case 'win32':
      return [
        path.join(localAppData, 'Google/Chrome/User Data/DevToolsActivePort'),
        path.join(localAppData, 'Chromium/User Data/DevToolsActivePort'),
      ];
    default:
      return [];
  }
}

async function detectChromePort() {
  // 优先从 DevToolsActivePort 文件读取
  for (const filePath of activePortFiles()) {
    try {
      const lines = fs.readFileSync(filePath, 'utf8').trim().split(/\r?\n/).filter(Boolean);
      const port = parseInt(lines[0], 10);
      if (port > 0 && port < 65536 && await checkPort(port)) {
        return port;
      }
    } catch (_) {}
  }
  // 回退：探测常见端口
  for (const port of [9222, 9229, 9333]) {
    if (await checkPort(port)) {
      return port;
    }
  }
  return null;
}

// --- CDP Proxy 启动与等待 ---

function httpGetJson(url, timeoutMs = 3000) {
  return fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    .then(async (res) => {
      try { return JSON.parse(await res.text()); } catch { return null; }
    })
    .catch(() => null);
}

function startProxyDetached() {
  const logFile = path.join(os.tmpdir(), 'cdp-proxy.log');
  const logFd = fs.openSync(logFile, 'a');
  const child = spawn(process.execPath, [PROXY_SCRIPT], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    ...(os.platform() === 'win32' ? { windowsHide: true } : {}),
  });
  child.unref();
  fs.closeSync(logFd);
}

async function ensureProxy() {
  const targetsUrl = `http://127.0.0.1:${PROXY_PORT}/targets`;

  // /targets 返回 JSON 数组即 ready
  const targets = await httpGetJson(targetsUrl);
  if (Array.isArray(targets)) {
    console.log('proxy: ready');
    return true;
  }

  // 未运行或未连接，启动并等待
  console.log('proxy: connecting...');
  startProxyDetached();

  // 等 proxy 进程就绪
  await new Promise((r) => setTimeout(r, 2000));

  for (let i = 1; i <= 15; i++) {
    const result = await httpGetJson(targetsUrl, 8000);
    if (Array.isArray(result)) {
      console.log('proxy: ready');
      return true;
    }
    if (i === 1) {
      console.log('⚠️  Chrome 可能有授权弹窗，请点击「允许」后等待连接...');
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  console.log('❌ 连接超时，请检查 Chrome 调试设置');
  console.log(`  日志：${path.join(os.tmpdir(), 'cdp-proxy.log')}`);
  return false;
}

// --- Chrome 路径（跨平台） ---

function chromeExePaths() {
  const home = os.homedir();
  switch (os.platform()) {
    case 'darwin':
      return [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
      ];
    case 'linux':
      return ['google-chrome', 'chromium', 'chromium-browser'];
    case 'win32': {
      const progFiles = process.env['ProgramFiles'] || 'C:\\Program Files';
      const progFiles86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
      const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
      return [
        path.join(progFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(progFiles86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      ];
    }
    default:
      return [];
  }
}

// --- Chrome 是否已在运行（进程检测） ---

function isChromeProcessRunning() {
  try {
    switch (os.platform()) {
      case 'darwin':
        return execSync('pgrep -x "Google Chrome" 2>/dev/null || pgrep -x Chromium 2>/dev/null', { encoding: 'utf8' }).trim().length > 0;
      case 'linux':
        return execSync('pgrep -x "chrome" 2>/dev/null || pgrep -x "chromium" 2>/dev/null', { encoding: 'utf8' }).trim().length > 0;
      case 'win32': {
        const out = execSync('tasklist /FI "IMAGENAME eq chrome.exe" 2>NUL', { encoding: 'utf8', windowsHide: true });
        return out.includes('chrome.exe');
      }
      default:
        return false;
    }
  } catch {
    return false;
  }
}

// --- 自动启动 Chrome ---

function launchChrome(port = 9222) {
  for (const exe of chromeExePaths()) {
    if (fs.existsSync(exe)) {
      console.log(`chrome: launching... (${exe})`);
      const child = spawn(exe, [
        `--remote-debugging-port=${port}`,
        '--no-first-run',
        '--no-default-browser-check',
      ], {
        detached: true,
        stdio: 'ignore',
        ...(os.platform() === 'win32' ? { windowsHide: true } : {}),
      });
      child.unref();
      return true;
    }
  }
  return false;
}

// --- main ---

async function main() {
  checkNode();

  let chromePort = await detectChromePort();
  if (!chromePort) {
    const running = isChromeProcessRunning();
    if (running) {
      // Chrome 已运行但无调试端口 — 无法注入，需手动重启
      console.log('chrome: 已运行但未开启远程调试 — 请完全关闭 Chrome 后重试（我将自动拉起带调试端口的 Chrome）');
      process.exit(1);
    }

    // Chrome 未运行，尝试自动启动
    const launched = launchChrome();
    if (!launched) {
      console.log('chrome: not connected — 未找到 Chrome 安装路径，请手动打开 Chrome 后访问 chrome://inspect/#remote-debugging 并勾选 Allow remote debugging');
      process.exit(1);
    }

    // 等待 Chrome 启动并就绪
    for (let i = 1; i <= 20; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      chromePort = await detectChromePort();
      if (chromePort) break;
      if (i === 3) console.log('  等待 Chrome 启动...');
    }

    if (!chromePort) {
      console.log('chrome: 启动超时 — 请手动打开 Chrome 后重试');
      process.exit(1);
    }
  }
  console.log(`chrome: ok (port ${chromePort})`);

  const proxyOk = await ensureProxy();
  if (!proxyOk) {
    process.exit(1);
  }

  // 列出已有站点经验
  const patternsDir = path.join(ROOT, 'references', 'site-patterns');
  try {
    const sites = fs.readdirSync(patternsDir)
      .filter(f => f.endsWith('.md'))
      .map(f => f.replace(/\.md$/, ''));
    if (sites.length) {
      console.log(`\nsite-patterns: ${sites.join(', ')}`);
    }
  } catch {}

}

await main();
