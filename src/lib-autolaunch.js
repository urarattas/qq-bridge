// lib/ 目录：把第三方程序放到 lib/<名称>/launcher.*，桥接启动时自动拉起；
// lib 本身还会被加到 PATH，所以 lib/ffmpeg.exe 这类单文件工具无需 launcher 也能被调用。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const RUNNER_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'lib-launcher-runner.js');

// 常见启动脚本命名。只认这些名字，避免把 lib/<程序>/ 里的普通 .bat/.cmd 工具脚本
// （例如只有几个命令的维护脚本）一起拉起来；目录同名脚本放在最后作为兜底，
// 这样 `lib/Foo/Foo.cmd` 这种自带启动器的程序也能直接丢进来。
const LAUNCHER_BASENAMES = Object.freeze(['launcher', 'launch', 'start', 'run']);
const LAUNCHER_EXTENSIONS = Object.freeze(['.bat', '.cmd', '.exe']);

/** 把 lib 目录前置到 PATH；重复调用不会产生重复项。 */
export function prependLibToPath(env = process.env, libDir) {
  const dir = path.resolve(libDir);
  // Windows 环境变量名大小写不敏感，Node 在部分启动方式下只暴露 Path。
  const current = String(env.PATH ?? env.Path ?? '');
  const parts = current.split(path.delimiter).filter(Boolean);
  if (parts.some((part) => path.resolve(part) === dir)) return false;
  env.PATH = [dir, ...parts].join(path.delimiter);
  return true;
}

/**
 * 扫描 lib 第一层子目录里的启动器（不递归，避免误拉起深层文件）。
 * 依次尝试 launcher / launch / start / run，最后是「与目录同名」的脚本，命中即停。
 */
export function findLibLaunchers(libDir) {
  let entries = [];
  try {
    entries = fs.readdirSync(libDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const found = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const dir = path.join(libDir, entry.name);
    const basenames = [...LAUNCHER_BASENAMES, entry.name];
    const hit = basenames
      .flatMap((base) => LAUNCHER_EXTENSIONS.map((ext) => path.join(dir, `${base}${ext}`)))
      .find((file) => {
        try {
          return fs.statSync(file).isFile();
        } catch {
          return false;
        }
      });
    if (hit) found.push({ name: entry.name, dir, file: hit });
  }
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Windows 的 .bat/.cmd 不能直接 spawn 执行，必须交给 cmd.exe。
 * 参数逐项加引号，避免路径里的空格被拆成多个参数。
 */
export function buildLaunchSpec(launcher, { platform = process.platform, comspec = process.env.ComSpec } = {}) {
  if (platform === 'win32' && /\.(bat|cmd)$/i.test(launcher.file)) {
    // cmd.exe 只认双引号、不认 Node 的 `\"` 转义；这里给出完整命令行并让 spawn
    // 以 verbatim 方式传参，否则路径会被当成带字面反斜杠的程序名（实测启动失败）。
    const quotedPath = launcher.file.replace(/"/g, '""');
    return {
      command: comspec || 'cmd.exe',
      args: ['/d', '/s', '/c', `""${quotedPath}""`],
      windowsVerbatimArguments: true,
    };
  }
  return { command: launcher.file, args: [] };
}

const vbsString = (value) => `"${String(value).replace(/"/g, '""')}"`;

/**
 * 生成隐藏启动 runner 的 VBScript。
 *
 * 为什么不能只用 windowsHide：Windows 下 detached（DETACHED_PROCESS）与 CREATE_NO_WINDOW
 * 互斥，detached 时隐藏失效、子进程会重新申请一个可见控制台。交给 wscript（GUI 子系统，
 * 本身没有控制台）以窗口样式 0 启动 runner，可做到完全不弹窗。
 *
 * runner（lib-launcher-runner.js）负责真正拉起 launcher，并看守桥接进程：
 * 桥接一旦退出（关闭 start.bat 窗口、崩溃、Ctrl+C），runner 会 taskkill /T 结束
 * launcher 及其全部子孙进程 —— 所以这里不再追求「脱离桥接存活」。
 */
export function buildHiddenRunnerScript({ nodePath, runnerPath, bridgePid, file, logFile = null }) {
  return [
    'Set sh = CreateObject("WScript.Shell")',
    'q = Chr(34)',
    `cmd = q & ${vbsString(nodePath)} & q & " " & q & ${vbsString(runnerPath)} & q & " ${bridgePid} " & q & ${vbsString(file)} & q & " " & q & ${vbsString(logFile || '')} & q`,
    'sh.Run cmd, 0, False',
    ''
  ].join('\r\n');
}

let vbsSeq = 0;

function directLaunch(launcher, { spawnImpl, log }) {
  const spec = buildLaunchSpec(launcher);
  const child = spawnImpl(spec.command, spec.args, {
    cwd: launcher.dir,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    ...(spec.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {})
  });
  child?.on?.('error', (error) => log(`lib：${launcher.name} 启动失败：${error?.message ?? error}`));
  child?.unref?.();
  return child;
}

/**
 * 拉起 lib 下的 launcher。
 *
 * @param {object} opts
 * @param {string} opts.libDir
 * @param {(msg: string) => void} [opts.log]
 * @param {() => Promise<boolean>} [opts.isGatewayReachable] SnowLuma 已在线时跳过它的 launcher，避免重复开实例
 * @param {string} [opts.logDir] 批处理输出日志目录（不传则不落盘）
 * @param {number} [opts.bridgePid] 看门狗监视的桥接进程 PID（默认当前进程）
 * @param {Function} [opts.spawnImpl] 测试注入
 * @param {string} [opts.platform] 测试注入
 * @returns {Promise<Array<{name:string,file:string,status:'launched'|'skipped'|'failed',error?:string,logFile?:string}>>}
 */
export async function launchLibPrograms({
  libDir,
  log = () => {},
  isGatewayReachable = null,
  logDir = null,
  bridgePid = process.pid,
  spawnImpl = spawn,
  platform = process.platform,
  wscriptPath = 'wscript.exe',
  vbsDir = os.tmpdir(),
  nodePath = process.execPath,
  runnerPath = RUNNER_PATH,
} = {}) {
  const launchers = findLibLaunchers(libDir);
  if (!launchers.length) return [];
  const needsGatewayCheck = launchers.some((launcher) => /snowluma/i.test(launcher.name));
  const gatewayUp = needsGatewayCheck && isGatewayReachable
    ? await isGatewayReachable().catch(() => false)
    : false;
  const results = [];
  for (const launcher of launchers) {
    if (gatewayUp && /snowluma/i.test(launcher.name)) {
      results.push({ ...launcher, status: 'skipped' });
      log(`lib：${launcher.name}/launcher 已跳过（SnowLuma 网关已在线）`);
      continue;
    }
    let logFile = null;
    if (logDir) {
      const safe = launcher.name
        .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, '_')
        .replace(/\s+/g, '_')
        .trim()
        .slice(0, 40) || 'app';
      logFile = path.join(logDir, `lib-${safe}.log`);
      try {
        fs.mkdirSync(logDir, { recursive: true });
      } catch {
        logFile = null;
      }
    }
    try {
      if (platform === 'win32') {
        const vbsFile = path.join(vbsDir, `qq-bridge-lib-${process.pid}-${++vbsSeq}.vbs`);
        // WSH 默认按 ANSI 读脚本，UTF-8 无 BOM 会把中文路径读成乱码；用 UTF-16LE + BOM。
        fs.writeFileSync(
          vbsFile,
          `\ufeff${buildHiddenRunnerScript({ nodePath, runnerPath, bridgePid, file: launcher.file, logFile })}`,
          'utf16le'
        );
        const child = spawnImpl(wscriptPath, ['//nologo', vbsFile], {
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
        });
        // wscript 只负责按隐藏样式把 runner 拉起来，随即退出；退出后删掉临时脚本。
        child?.once?.('exit', () => {
          try { fs.rmSync(vbsFile, { force: true }); } catch {}
        });
        child?.once?.('error', (error) => {
          log(`lib：${launcher.name} 隐藏启动失败（${error?.message ?? error}），改用可见窗口启动 watchdog`);
          try { fs.rmSync(vbsFile, { force: true }); } catch {}
          // 退路仍保留看门狗：宁可看到窗口，也不要留下关不掉的进程。
          const fallback = spawnImpl(nodePath, [runnerPath, String(bridgePid), launcher.file, logFile || ''], {
            detached: true,
            stdio: 'ignore',
            windowsHide: true,
          });
          fallback?.on?.('error', (err) => log(`lib：${launcher.name} watchdog 启动失败：${err?.message ?? err}`));
          fallback?.unref?.();
        });
        child?.unref?.();
      } else {
        directLaunch(launcher, { spawnImpl, log });
      }
      results.push({ ...launcher, status: 'launched', ...(logFile ? { logFile } : {}) });
      log(`lib：已拉起 ${launcher.name}/launcher${logFile ? `（日志：${logFile}）` : ''}`);
    } catch (error) {
      results.push({ ...launcher, status: 'failed', error: String(error?.message ?? error) });
      log(`lib：${launcher.name} 启动失败：${error?.message ?? error}`);
    }
  }
  return results;
}
