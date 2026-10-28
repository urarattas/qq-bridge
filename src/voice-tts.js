// 语音合成（TTS）：给控制台的「语音库与语音发送（调试）」面板使用。
//
// 支持两类引擎：
//   1) MeloTTS：用户把 MeloTTS 装进 lib/MeloTTS（或 lib/、PATH）后，调用 `melo` CLI；
//   2) 系统语音：Windows 自带 SAPI（System.Speech），macOS 的 `say`，Linux 的 `espeak-ng`。
// 合成结果落到语音库，之后与手放进去的音频走完全相同的发送/校验/限流路径。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

export const MELO_VOICES = Object.freeze([
  { id: 'ZH', name: '中文（ZH）', language: 'ZH' },
  { id: 'EN-Default', name: 'English · Default', language: 'EN' },
  { id: 'EN-US', name: 'English · US', language: 'EN' },
  { id: 'EN-BR', name: 'English · British', language: 'EN' },
  { id: 'EN-AU', name: 'English · Australian', language: 'EN' },
  { id: 'EN_INDIA', name: 'English · India', language: 'EN' },
  { id: 'ES', name: 'Español', language: 'ES' },
  { id: 'FR', name: 'Français', language: 'FR' },
  { id: 'JP', name: '日本語', language: 'JP' },
  { id: 'KR', name: '한국어', language: 'KR' },
]);

function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

function pathDirs() {
  return String(process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
}

function findExecutable(names, dirs) {
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (isFile(candidate)) return candidate;
    }
  }
  return null;
}

/** 找 MeloTTS 的 `melo` 命令：显式配置 → lib/ → lib/MeloTTS/ → PATH。 */
export function findMeloPath({ root = process.cwd(), explicit = '' } = {}) {
  const explicitPath = String(explicit ?? '').trim();
  if (explicitPath && isFile(explicitPath)) return path.resolve(explicitPath);
  const names = process.platform === 'win32'
    ? ['melo.exe', 'melo.cmd', 'melo.bat', 'melo']
    : ['melo'];
  return findExecutable(names, [
    path.join(root, 'lib'),
    path.join(root, 'lib', 'MeloTTS'),
    ...pathDirs(),
  ]);
}

/** 找 Windows PowerShell（SAPI 通过它调用）。 */
export function findPowerShellPath() {
  if (process.platform !== 'win32') return null;
  const systemRoot = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  const candidates = [
    path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    findExecutable(['powershell.exe'], pathDirs()),
  ].filter(Boolean);
  return candidates.find(isFile) ?? null;
}

function spawnCapture(command, args, { timeoutMs = 120000, env = process.env, windowsVerbatimArguments = false } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env,
        ...(windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
      });
    } catch (error) {
      resolve({ code: -1, stdout: '', stderr: String(error?.message ?? error) });
      return;
    }
    let stdout = '';
    let stderr = '';
    const cap = (text) => (text.length > 8000 ? text.slice(-8000) : text);
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      resolve({ code: -2, stdout, stderr: cap(stderr) || `超时（${timeoutMs}ms）` });
    }, timeoutMs);
    child.stdout?.on('data', (chunk) => { stdout = cap(stdout + chunk.toString('utf8')); });
    child.stderr?.on('data', (chunk) => { stderr = cap(stderr + chunk.toString('utf8')); });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: String(error?.message ?? error) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

/** .bat/.cmd 需要 cmd.exe 代跑；参数逐项加引号。 */
export function spawnExecutable(file, args, options = {}) {
  if (process.platform === 'win32' && /\.(bat|cmd)$/i.test(file)) {
    const commandLine = [file, ...args].map((value) => `"${String(value).replace(/"/g, '""')}"`).join(' ');
    return spawnCapture(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${commandLine}"`], {
      ...options,
      windowsVerbatimArguments: true,
    });
  }
  return spawnCapture(file, args, options);
}

function tempDir() {
  const dir = path.join(os.tmpdir(), 'qq-bridge-tts');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeTemp(prefix, content, ext = '.txt') {
  const file = path.join(tempDir(), `${prefix}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}${ext}`);
  fs.writeFileSync(file, content, 'utf8');
  return file;
}

function cleanup(files) {
  for (const file of files) { try { fs.unlinkSync(file); } catch {} }
}

const SAPI_LIST_SCRIPT = [
  'Add-Type -AssemblyName System.Speech',
  '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
  'try { $s.GetInstalledVoices() | ForEach-Object { if ($_.Enabled) { $_.VoiceInfo.Name } } } finally { $s.Dispose() }',
].join('\n');

const SAPI_SPEAK_SCRIPT = [
  'param([string]$TextFile,[string]$OutFile,[string]$VoiceName,[int]$Rate)',
  'Add-Type -AssemblyName System.Speech',
  '$text = [System.IO.File]::ReadAllText($TextFile, [System.Text.Encoding]::UTF8)',
  '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
  'try {',
  '  if ($VoiceName) { $s.SelectVoice($VoiceName) }',
  '  $s.Rate = $Rate',
  '  $s.SetOutputToWaveFile($OutFile)',
  '  $s.Speak($text)',
  '} finally { $s.Dispose() }',
].join('\n');

export async function listSapiVoices({ timeoutMs = 8000 } = {}) {
  const powershell = findPowerShellPath();
  if (!powershell) return [];
  const script = writeTemp('tts-list', SAPI_LIST_SCRIPT, '.ps1');
  try {
    const result = await spawnCapture(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], { timeoutMs });
    if (result.code !== 0) return [];
    return result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  } finally {
    cleanup([script]);
  }
}

/** 返回可用引擎与音色；控制台据此渲染下拉框。 */
export async function detectTtsEngines({ root = process.cwd(), meloPath = '', timeoutMs = 8000 } = {}) {
  const engines = [];
  const melo = findMeloPath({ root, explicit: meloPath });
  if (melo) {
    engines.push({
      id: 'melo',
      name: 'MeloTTS',
      description: '本地 MeloTTS（lib/MeloTTS 或 PATH 中的 melo）',
      path: melo,
      voices: MELO_VOICES.map((voice) => ({ ...voice })),
    });
  }
  if (process.platform === 'win32') {
    const powershell = findPowerShellPath();
    if (powershell) {
      const names = await listSapiVoices({ timeoutMs });
      engines.push({
        id: 'sapi',
        name: '系统语音（Windows SAPI）',
        description: 'Windows 自带 System.Speech 合成',
        path: powershell,
        voices: names.map((name) => ({ id: name, name, language: '' })),
        warning: names.length ? undefined : '没有枚举到系统语音；仍可尝试合成（PowerShell 可能未安装 System.Speech）',
      });
    }
  } else if (process.platform === 'darwin') {
    const say = findExecutable(['say'], pathDirs());
    if (say) {
      engines.push({
        id: 'say',
        name: '系统语音（macOS say）',
        description: 'macOS 自带 say 命令',
        path: say,
        voices: [{ id: '', name: '系统默认', language: '' }],
      });
    }
  } else {
    const espeak = findExecutable(['espeak-ng', 'espeak'], pathDirs());
    if (espeak) {
      engines.push({
        id: 'espeak',
        name: '系统语音（eSpeak）',
        description: 'espeak-ng 合成',
        path: espeak,
        voices: [{ id: '', name: '系统默认', language: '' }],
      });
    }
  }
  return engines;
}

function inferLanguage(text, voice) {
  const explicit = String(voice?.language ?? '').trim().toUpperCase();
  if (explicit) return explicit;
  return /[\u3400-\u9fff]/.test(String(text)) ? 'ZH' : 'EN';
}

function normalizeSpeed(value, { min, max }) {
  const speed = Number(value);
  if (!Number.isFinite(speed)) return 1;
  return Math.min(max, Math.max(min, speed));
}

/**
 * 合成一段语音到 outputPath（扩展名决定容器，默认 .wav）。
 * 失败抛错；内容与命令都通过临时文件传递，避免命令行转义/注入问题。
 */
export async function synthesizeSpeech({
  text,
  engine,
  voice = '',
  language = '',
  speed = 1,
  outputPath,
  root = process.cwd(),
  meloPath = '',
  maxChars = 500,
  timeoutMs = 120000,
} = {}) {
  const clean = String(text ?? '').replace(/\r\n/g, '\n').trim();
  if (!clean) throw new Error('合成文本不能为空');
  if (clean.length > maxChars) throw new Error(`合成文本不能超过 ${maxChars} 字（当前 ${clean.length} 字）`);
  if (!outputPath) throw new Error('缺少输出路径');
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  if (engine === 'melo') {
    const melo = findMeloPath({ root, explicit: meloPath });
    if (!melo) throw new Error('找不到 MeloTTS 的 melo 命令：请安装 MeloTTS，或把它放到 lib/MeloTTS/ 下');
    const textFile = writeTemp('tts-text', clean);
    try {
      const lang = inferLanguage(clean, { language });
      const speaker = String(voice || (lang === 'ZH' ? 'ZH' : 'EN-Default'));
      const rate = normalizeSpeed(speed, { min: 0.5, max: 2 });
      const result = await spawnExecutable(melo, [textFile, outputPath, '--file', '--language', lang, '--speaker', speaker, '--speed', String(rate)], { timeoutMs });
      if (result.code !== 0) throw new Error(`MeloTTS 合成失败（退出码 ${result.code}）：${(result.stderr || result.stdout || '').trim().slice(0, 500) || '无输出'}`);
    } finally {
      cleanup([textFile]);
    }
  } else if (engine === 'sapi') {
    const powershell = findPowerShellPath();
    if (!powershell) throw new Error('找不到 Windows PowerShell，无法使用系统语音合成');
    const textFile = writeTemp('tts-text', clean);
    const script = writeTemp('tts-sapi', SAPI_SPEAK_SCRIPT, '.ps1');
    const rate = Math.max(-10, Math.min(10, Math.round((normalizeSpeed(speed, { min: 0.5, max: 2 }) - 1) * 10)));
    try {
      const result = await spawnCapture(powershell, [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
        '-TextFile', textFile, '-OutFile', outputPath, '-VoiceName', String(voice || ''), '-Rate', String(rate)
      ], { timeoutMs });
      if (result.code !== 0) throw new Error(`系统语音合成失败（退出码 ${result.code}）：${(result.stderr || result.stdout || '').trim().slice(0, 500) || '无输出'}`);
    } finally {
      cleanup([textFile, script]);
    }
  } else if (engine === 'say') {
    const say = findExecutable(['say'], pathDirs());
    if (!say) throw new Error('找不到 macOS 的 say 命令');
    const textFile = writeTemp('tts-text', clean);
    try {
      const args = ['-f', textFile, '-o', outputPath];
      if (voice) args.unshift('-v', String(voice));
      const result = await spawnCapture(say, args, { timeoutMs });
      if (result.code !== 0) throw new Error(`say 合成失败（退出码 ${result.code}）：${result.stderr || ''}`);
    } finally {
      cleanup([textFile]);
    }
  } else if (engine === 'espeak') {
    const espeak = findExecutable(['espeak-ng', 'espeak'], pathDirs());
    if (!espeak) throw new Error('找不到 espeak-ng / espeak');
    const textFile = writeTemp('tts-text', clean);
    try {
      const args = ['-f', textFile, '-w', outputPath];
      if (voice) args.push('-v', String(voice));
      const result = await spawnCapture(espeak, args, { timeoutMs });
      if (result.code !== 0) throw new Error(`eSpeak 合成失败（退出码 ${result.code}）：${result.stderr || ''}`);
    } finally {
      cleanup([textFile]);
    }
  } else {
    throw new Error(`未知的合成引擎：${engine}`);
  }

  let stat;
  try { stat = fs.statSync(outputPath); } catch {}
  if (!stat?.isFile() || stat.size === 0) throw new Error('合成命令结束了，但没有生成音频文件');
  return { bytes: stat.size, engine };
}

/** 生成一个不冲突的语音库文件名。 */
export function ttsFileName(date = new Date(), ext = '.wav') {
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return `tts-${stamp}${ext}`;
}
