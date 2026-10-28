// 语音合成（MeloTTS / 系统语音）离线回归：引擎探测、文件名、SAPI 真合成（有则测）、桥接端点与控制台接线。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectTtsEngines, findMeloPath, findPowerShellPath, MELO_VOICES, synthesizeSpeech, ttsFileName } from '../src/voice-tts.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
let pass = 0;
let fail = 0;
function ok(cond, name, extra = '') {
  if (cond) { pass += 1; console.log(`  ✅ ${name}${extra ? ' — ' + extra : ''}`); }
  else { fail += 1; console.error(`  ❌ ${name}${extra ? ' — ' + extra : ''}`); }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-tts-test-'));

console.log('## 引擎与音色');
{
  ok(MELO_VOICES.some((v) => v.language === 'ZH'), 'MeloTTS 音色含中文');
  ok(MELO_VOICES.some((v) => v.id === 'EN-US'), 'MeloTTS 音色含 EN-US');
  const fake = path.join(tmp, 'melo.bat');
  fs.writeFileSync(fake, '@echo off\r\n');
  ok(findMeloPath({ root: tmp, explicit: fake }) === path.resolve(fake), '显式 meloPath 生效');
  const engines = await detectTtsEngines({ root: tmp, timeoutMs: 5000 });
  ok(Array.isArray(engines), 'detectTtsEngines 返回数组');
  if (process.platform === 'win32') {
    ok(findPowerShellPath() !== null, 'Windows 能找到 PowerShell');
    ok(engines.some((e) => e.id === 'sapi'), 'Windows 暴露 SAPI 引擎');
  }
}

console.log('## 参数校验');
{
  await assert.rejects(() => synthesizeSpeech({ text: '', engine: 'sapi', outputPath: path.join(tmp, 'a.wav') }), /不能为空/);
  await assert.rejects(() => synthesizeSpeech({ text: 'x'.repeat(600), engine: 'sapi', outputPath: path.join(tmp, 'a.wav'), maxChars: 500 }), /不能超过/);
  await assert.rejects(() => synthesizeSpeech({ text: 'hi', engine: 'nope', outputPath: path.join(tmp, 'a.wav') }), /未知/);
}

console.log('## 文件名');
{
  const name = ttsFileName(new Date(2026, 9, 28, 8, 3, 4));
  ok(/^tts-20261028-080304\.wav$/.test(name), 'ttsFileName 生成时间戳文件名', name);
}

console.log('## SAPI 真合成');
if (process.platform === 'win32' && findPowerShellPath()) {
  const output = path.join(tmp, 'selftest.wav');
  try {
    const result = await synthesizeSpeech({ text: '你好，这是语音合成自检。', engine: 'sapi', outputPath: output, timeoutMs: 30000 });
    const buf = fs.readFileSync(output);
    ok(result.bytes > 1000, '生成了非空音频', `${result.bytes} 字节`);
    ok(buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WAVE', '输出是 WAV 容器');
  } catch (error) {
    ok(false, 'SAPI 合成成功', error.message);
  }
} else {
  console.log('  ⏭ 非 Windows 或缺少 PowerShell，跳过 SAPI 真合成');
}

console.log('## MeloTTS（用假 melo.cmd 验证 .bat 启动与参数）');
if (process.platform === 'win32') {
  const fixtureWav = path.join(tmp, 'fixture.wav');
  const wav = Buffer.alloc(44 + 1024);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + 1024, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(22050, 24);
  wav.writeUInt32LE(44100, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(1024, 40);
  fs.writeFileSync(fixtureWav, wav);
  const fakeMelo = path.join(tmp, 'melo.cmd');
  fs.writeFileSync(fakeMelo, `@echo off\r\ncopy /y "%~dp0fixture.wav" "%~2" >nul\r\n`);
  const output = path.join(tmp, 'melo-out.wav');
  try {
    const result = await synthesizeSpeech({ text: 'hello', engine: 'melo', meloPath: fakeMelo, voice: 'EN-US', outputPath: output, timeoutMs: 15000 });
    ok(result.bytes > 1000, '假 melo.cmd 被正确启动并产出音频', `${result.bytes} 字节`);
  } catch (error) {
    ok(false, '假 melo.cmd 合成', error.message);
  }
} else {
  console.log('  ⏭ 非 Windows，跳过 .cmd 启动测试');
}

console.log('## 桥接与控制台接线');
{
  const bridge = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');
  for (const route of ['/api/voice/tts/engines', '/api/voice/tts', '/api/voice/preview']) {
    ok(bridge.includes(`'${route}'`), `桥接注册 ${route}`);
  }
  ok(/detectTtsEngines/.test(bridge) && /synthesizeSpeech/.test(bridge), '桥接调用 TTS 模块');
  const html = fs.readFileSync(path.join(ROOT, 'public', 'console.html'), 'utf8');
  for (const id of ['voiceTtsEngine', 'voiceTtsVoice', 'voiceTtsSpeed', 'voiceTtsText', 'voiceTtsBtn', 'voiceTtsRefresh', 'voicePreview', 'voicePreviewBtn']) {
    ok(html.includes(`id="${id}"`), `控制台有 #${id}`);
  }
  ok(/api\/voice\/tts\/engines/.test(html) && /api\('\/api\/voice\/tts'/.test(html), '控制台调用 TTS 端点');
  ok(/api\/voice\/preview/.test(html), '控制台有试听端点');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
