// lib/ 自动拉起与 PATH 的离线回归：只做纯函数 + 注入 spawn，不真的启动第三方程序。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { buildHiddenRunnerScript, buildLaunchSpec, findLibLaunchers, launchLibPrograms, prependLibToPath } from '../src/lib-autolaunch.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-lib-test-'));
let pass = 0;
let fail = 0;
function ok(cond, name, extra = '') {
  if (cond) { pass += 1; console.log(`  ✅ ${name}${extra ? ' — ' + extra : ''}`); }
  else { fail += 1; console.error(`  ❌ ${name}${extra ? ' — ' + extra : ''}`); }
}

console.log('## PATH');
{
  const env = { PATH: ['C:\\one', 'C:\\two'].join(path.delimiter) };
  ok(prependLibToPath(env, path.join(tmp, 'lib')) === true, '首次调用会把 lib 前置');
  ok(env.PATH.split(path.delimiter)[0] === path.join(tmp, 'lib'), 'lib 位于 PATH 第一位');
  ok(prependLibToPath(env, path.join(tmp, 'lib')) === false, '重复调用不会重复插入');
}

console.log('## 扫描 launcher');
{
  const lib = path.join(tmp, 'lib');
  fs.mkdirSync(path.join(lib, 'Demo'), { recursive: true });
  fs.mkdirSync(path.join(lib, 'NoLauncher'), { recursive: true });
  fs.mkdirSync(path.join(lib, 'Other'), { recursive: true });
  fs.mkdirSync(path.join(lib, 'SelfNamed'), { recursive: true });
  fs.writeFileSync(path.join(lib, 'Demo', 'launcher.cmd'), '@echo off\r\n');
  fs.writeFileSync(path.join(lib, 'NoLauncher', 'readme.txt'), 'x');
  fs.writeFileSync(path.join(lib, 'Other', 'maintenance.cmd'), '@echo off\r\n');
  fs.writeFileSync(path.join(lib, 'Other', 'start.bat'), '@echo off\r\n');
  fs.writeFileSync(path.join(lib, 'SelfNamed', 'SelfNamed.cmd'), '@echo off\r\n');
  const found = findLibLaunchers(lib);
  ok(found.length === 3, '只扫描第一层子目录中的启动器', `找到 ${found.map((f) => f.name).join(',')}`);
  ok(found.some((f) => f.name === 'Demo' && f.file.endsWith('launcher.cmd')), 'launcher.cmd 命中');
  ok(found.some((f) => f.name === 'Other' && f.file.endsWith('start.bat')), 'start.bat 也算启动器');
  ok(found.some((f) => f.name === 'SelfNamed' && f.file.endsWith('SelfNamed.cmd')), '目录同名 .cmd 兜底命中');
  ok(!found.some((f) => f.name === 'NoLauncher'), '没有启动器的目录忽略');
  ok(findLibLaunchers(path.join(tmp, 'missing')).length === 0, 'lib 不存在时返回空数组');
}

console.log('## 启动命令');
{
  const bat = { file: 'C:\\repo\\lib\\SnowLuma\\launcher.bat' };
  const spec = buildLaunchSpec(bat, { platform: 'win32', comspec: 'C:\\Windows\\System32\\cmd.exe' });
  ok(spec.command.endsWith('cmd.exe'), '.bat 交给 cmd.exe');
  ok(spec.args.join(' ').includes('launcher.bat'), '参数里包含 launcher 路径');
  const exe = buildLaunchSpec({ file: 'C:\\repo\\lib\\tool.exe' }, { platform: 'win32' });
  ok(exe.command === 'C:\\repo\\lib\\tool.exe' && exe.args.length === 0, '.exe 直接执行');
  const script = buildHiddenRunnerScript({
    nodePath: 'C:\\Program Files\\nodejs\\node.exe',
    runnerPath: 'C:\\repo\\src\\lib-launcher-runner.js',
    bridgePid: 4321,
    file: 'C:\\repo\\lib\\My App\\launcher.cmd',
    logFile: 'C:\\repo\\state\\logs\\lib-My_App.log',
  });
  ok(script.includes('Chr(34)') && script.includes('sh.Run cmd, 0, False'), 'VBS 用隐藏样式异步启动 runner');
  ok(script.includes('C:\\Program Files\\nodejs\\node.exe') && script.includes('lib-launcher-runner.js'), 'runner 由 node 启动');
  ok(script.includes(' 4321 ') && script.includes('C:\\repo\\lib\\My App\\launcher.cmd'), 'VBS 传入桥接 PID 与 launcher 路径');
  ok(script.includes('C:\\repo\\state\\logs\\lib-My_App.log'), '输出重定向到日志文件');

  const runnerSrc = fs.readFileSync(new URL('../src/lib-launcher-runner.js', import.meta.url), 'utf8');
  ok(runnerSrc.includes('process.kill(bridgePid, 0)'), 'runner 监测桥接进程存活');
  ok(runnerSrc.includes("'taskkill'") && runnerSrc.includes("'/T'"), '桥接退出后 taskkill 整棵进程树');
  ok(runnerSrc.includes("stdio: ['ignore', out, out]"), 'launcher 的 stdin 接 NUL，pause/set /p 不会挂住');
}

console.log('## 拉起（注入 spawn）');
{
  const lib = path.join(tmp, 'lib');
  const vbsDir = path.join(tmp, 'vbs');
  fs.mkdirSync(vbsDir, { recursive: true });
  const calls = [];
  const results = await launchLibPrograms({
    libDir: lib,
    vbsDir,
    logDir: path.join(tmp, 'logs'),
    log: () => {},
    isGatewayReachable: async () => true,
    spawnImpl: (command, args, options) => {
      calls.push({ command, args, options });
      return { on: () => {}, unref: () => {} };
    },
  });
  ok(results.find((r) => r.name === 'Demo')?.status === 'launched', '非 SnowLuma 程序正常拉起');
  ok(calls.length === 3, '只拉起存在的启动器');
  ok(calls[0].command === 'wscript.exe' && calls[0].args[0] === '//nologo', '.bat/.cmd 通过 wscript 隐藏启动');
  ok(calls[0].options.detached === true && calls[0].options.windowsHide === true, 'wscript 独立于桥接进程');
  const vbsFiles = fs.readdirSync(vbsDir);
  ok(vbsFiles.length === 3, '每个启动器生成独立 VBS 脚本', vbsFiles.join(','));
  const scriptText = fs.readFileSync(path.join(vbsDir, vbsFiles[0]), 'utf16le');
  ok(scriptText.includes('lib-launcher-runner.js') && scriptText.includes(String(process.pid)), '注入的 VBS 带 runner 与当前桥接 PID（UTF-16LE 编码）');
  ok(results.every((r) => r.logFile?.endsWith('.log')), '每个启动器都有独立日志路径');

  const snow = path.join(tmp, 'lib', 'SnowLuma');
  fs.mkdirSync(snow, { recursive: true });
  fs.writeFileSync(path.join(snow, 'launcher.cmd'), '@echo off\r\n');
  const calls2 = [];
  const results2 = await launchLibPrograms({
    libDir: lib,
    vbsDir,
    isGatewayReachable: async () => true,
    spawnImpl: (command, args) => { calls2.push(command); return { on: () => {}, unref: () => {} }; },
  });
  ok(results2.find((r) => r.name === 'SnowLuma')?.status === 'skipped', 'SnowLuma 网关已在线时跳过它的 launcher');
  ok(calls2.length === 3, '跳过 SnowLuma 后只拉起其余启动器');
}

if (process.platform === 'win32') {
  console.log('## 真机：隐藏启动 .cmd（pause 不挂起）');
  {
    const lib = path.join(tmp, 'live-lib');
    const app = path.join(lib, 'Live App');
    const logs = path.join(tmp, 'live-logs');
    fs.mkdirSync(app, { recursive: true });
    fs.writeFileSync(
      path.join(app, 'start.cmd'),
      '@echo off\r\n' +
        'echo started> "%~dp0started.txt"\r\n' +
        'pause\r\n' +
        'echo done> "%~dp0done.txt"\r\n'
    );
    const live = await launchLibPrograms({ libDir: lib, logDir: logs, log: () => {} });
    ok(live[0]?.status === 'launched', '真机拉起 .cmd 成功');
    let done = false;
    for (let i = 0; i < 40 && !done; i += 1) {
      await new Promise((r) => setTimeout(r, 250));
      done = fs.existsSync(path.join(app, 'done.txt'));
    }
    ok(fs.existsSync(path.join(app, 'started.txt')), '批处理实际执行');
    ok(done, 'pause 收到 EOF 后继续执行（未卡住）');
    ok(fs.existsSync(path.join(logs, 'lib-Live_App.log')), '批处理输出写入日志');

    // 中文/空格路径：VBS 必须按 UTF-16LE 写入，否则 WSH 按 ANSI 读会乱码、拉不起来。
    const libCn = path.join(tmp, 'live-lib-cn');
    const appCn = path.join(libCn, '中文 程序');
    fs.mkdirSync(appCn, { recursive: true });
    fs.writeFileSync(path.join(appCn, 'launcher.cmd'), '@echo off\r\necho ok> "%~dp0ok.txt"\r\n');
    await launchLibPrograms({ libDir: libCn, logDir: logs, log: () => {} });
    let cnOk = false;
    for (let i = 0; i < 40 && !cnOk; i += 1) {
      await new Promise((r) => setTimeout(r, 250));
      cnOk = fs.existsSync(path.join(appCn, 'ok.txt'));
    }
    ok(cnOk, '中文路径的 .cmd 也能拉起');
  }

  console.log('## 真机：桥接退出后 launcher 整棵树退出');
  {
    const dummy = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    try {
      const libKill = path.join(tmp, 'kill-lib');
      const appKill = path.join(libKill, 'Kill App');
      fs.mkdirSync(appKill, { recursive: true });
      fs.writeFileSync(
        path.join(appKill, 'beat.js'),
        "const fs = require('node:fs');\n" +
          "const path = require('node:path');\n" +
          'let i = 0;\n' +
          "setInterval(() => fs.writeFileSync(path.join(__dirname, 'beat.txt'), String(++i)), 200);\n"
      );
      fs.writeFileSync(path.join(appKill, 'start.cmd'), '@echo off\r\nnode "%~dp0beat.js"\r\n');
      const live = await launchLibPrograms({
        libDir: libKill,
        logDir: path.join(tmp, 'kill-logs'),
        bridgePid: dummy.pid,
        log: () => {},
      });
      ok(live[0]?.status === 'launched', '带看门狗拉起 .cmd');
      const beat = path.join(appKill, 'beat.txt');
      let started = false;
      for (let i = 0; i < 60 && !started; i += 1) {
        await new Promise((r) => setTimeout(r, 250));
        started = fs.existsSync(beat);
      }
      ok(started, 'launcher 及其子进程已运行');
      dummy.kill();
      await new Promise((r) => setTimeout(r, 1500));
      const first = fs.existsSync(beat) ? fs.readFileSync(beat, 'utf8') : '';
      await new Promise((r) => setTimeout(r, 2500));
      const second = fs.existsSync(beat) ? fs.readFileSync(beat, 'utf8') : '';
      ok(first !== '' && first === second, '桥接退出后子进程停止写入（整棵树被结束）');
    } finally {
      try { dummy.kill(); } catch {}
    }
  }
}

fs.rmSync(tmp, { recursive: true, force: true });

console.log('## 桥接接线');
{
  const bridge = fs.readFileSync(new URL('../src/bridge.js', import.meta.url), 'utf8');
  const start = fs.readFileSync(new URL('../start.bat', import.meta.url), 'utf8');
  assert.match(bridge, /prependLibToPath\(process\.env, path\.join\(ROOT, 'lib'\)\)/, '桥接启动时把 lib 加入 PATH');
  assert.match(bridge, /launchLibPrograms\(\{[\s\S]*?libDir: path\.join\(ROOT, 'lib'\)/, '桥接启动时扫描 lib launcher');
  assert.match(bridge, /logDir: path\.join\(ROOT, 'state', 'logs'\)/, '批处理日志写入 state/logs');
  assert.match(bridge, /cfg\.lib\?\.autoLaunch !== false/, 'config.lib.autoLaunch 可关闭自动拉起');
  assert.match(start, /set "PATH=%~dp0lib;%PATH%"/, 'start.bat 同样把 lib 前置到 PATH');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
