// 由 wscript 隐藏拉起的单次启动看门狗：
//   1) 以子进程方式运行 lib/<名称>/ 下的 launcher（.bat/.cmd 走 cmd.exe，.exe 直接执行）；
//   2) 每秒确认桥接进程还活着，一旦桥接退出（关闭 start.bat 窗口、崩溃、Ctrl+C），
//      用 taskkill /T /F 结束 launcher 及其全部子孙进程。
//
// 为什么需要独立进程：Windows 关闭控制台时 Node 收不到可用的清理回调，桥接自己没机会
// taskkill；而 detached 拉起的程序又不会跟随父进程结束。看门狗能在桥接消失后继续存活，
// 把「关闭主窗口 ⇒ 第三方程序一起退出」这件事补上。
//
// 用法：node lib-launcher-runner.js <bridgePid> <launcherFile> [logFile]
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const [bridgePidRaw, launcherFile, logFile = ''] = process.argv.slice(2);
const bridgePid = Number(bridgePidRaw);
if (!Number.isInteger(bridgePid) || bridgePid <= 0 || !launcherFile) {
  process.exit(2);
}

let outFd = null;
let out = 'ignore';
if (logFile) {
  try {
    outFd = fs.openSync(logFile, 'w');
    out = outFd;
  } catch {
    out = 'ignore';
  }
}

function finish(code = 0) {
  if (outFd !== null) {
    try { fs.closeSync(outFd); } catch {}
    outFd = null;
  }
  process.exit(code);
}

function bridgeAlive() {
  try {
    process.kill(bridgePid, 0);
    return true;
  } catch (error) {
    // EPERM：进程存在但没权限探测（桥接以更高权限运行），按活着处理。
    return error?.code === 'EPERM';
  }
}

// 启动前先确认桥接还在：桥接可能在 wscript 调度期间就已经退出，没必要再拉起程序。
if (!bridgeAlive()) finish(0);

const isBatch = /\.(bat|cmd)$/i.test(launcherFile);
const command = isBatch ? (process.env.ComSpec || 'cmd.exe') : launcherFile;
const args = isBatch ? ['/d', '/s', '/c', `""${launcherFile.replace(/"/g, '""')}""`] : [];

const child = spawn(command, args, {
  cwd: path.dirname(launcherFile),
  stdio: ['ignore', out, out],
  windowsHide: true,
  ...(isBatch ? { windowsVerbatimArguments: true } : {}),
});

child.on('error', (error) => {
  if (outFd !== null) {
    try { fs.writeSync(outFd, `launcher runner: spawn failed: ${error?.message ?? error}\n`); } catch {}
  }
  finish(1);
});

child.on('exit', () => finish(0));

const timer = setInterval(() => {
  if (bridgeAlive()) return;
  clearInterval(timer);
  const pid = child.pid;
  if (pid) {
    const result = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    if (result.error || result.status !== 0) {
      try { child.kill(); } catch {}
    }
  }
  finish(0);
}, 1000);
