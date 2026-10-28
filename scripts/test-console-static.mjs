// 控制台静态校验：在无法跑 Playwright 的环境里，替代性地检查 HTML/JS 结构契约。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// 独立发语音工具在仓库上一级（不在本仓库里）：位置解析与"不在时怎么跳过"走共享口径。
import { hasVoiceTool, skipVoiceTool, voiceToolPath } from './voice-tool-locator.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(ROOT, 'public', 'console.html'), 'utf8');

let bad = 0;
const ok = (cond, name, extra = '') => {
  if (cond) console.log(`  OK   ${name}${extra ? ' — ' + extra : ''}`);
  else { bad++; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); }
};

console.log('## 元素 ID');
const ids = [...html.matchAll(/\sid="([A-Za-z0-9_-]+)"/g)].map((m) => m[1]);
const dups = [...new Set(ids.filter((v, i) => ids.indexOf(v) !== i))];
ok(dups.length === 0, 'ID 唯一', dups.length ? `重复：${dups.join(', ')}` : `共 ${ids.length} 个`);
for (const id of ['voiceList', 'voiceRefreshBtn', 'voiceSendBtn', 'voiceSendTarget', 'voiceSendDryRun', 'voiceMsg',
  'voiceTtsEngine', 'voiceTtsVoice', 'voiceTtsSpeed', 'voiceTtsText', 'voiceTtsBtn', 'voiceTtsRefresh', 'voicePreview', 'voicePreviewBtn']) {
  const n = (html.match(new RegExp(`id="${id}"`, 'g')) ?? []).length;
  ok(n === 1, `语音面板元素 ${id}`, `${n} 处`);
}

console.log('## 视图 / 页面契约');
const views = [...new Set([...html.matchAll(/data-view="([a-z0-9-]+)"/g)].map((m) => m[1]))].sort();
const pages = [...new Set([...html.matchAll(/data-page="([a-z0-9-]+)"/g)].map((m) => m[1]))].sort();
ok(JSON.stringify(views) === JSON.stringify(pages), 'data-view 与 data-page 一一对应', `${views.length} 个：${views.join(', ')}`);

console.log('## 服务连接面板');
for (const id of ['connDshScheme', 'connDshHost', 'connDshPort', 'connDshToken', 'connDshReveal', 'connDshClear', 'connDshAllowRemote',
  'connSlHttpScheme', 'connSlHttpHost', 'connSlHttpPort', 'connSlWsScheme', 'connSlWsHost', 'connSlWsPort',
  'connSlToken', 'connSlReveal', 'connSlClear', 'connSlFollow', 'connSave', 'connSaveRestart', 'connReload', 'connMsg', 'connStatus']) {
  ok(ids.includes(id), `连接面板元素 ${id}`);
}
ok(/api\('\/api\/connection'/.test(html), '面板读取 /api/connection');
ok(/api\('\/api\/connection', 'POST'/.test(html), '面板保存 /api/connection');
ok(/api\/connection\/secret/.test(html), '「显示当前值」走 /api/connection/secret');
ok(/if \(page === 'access'[\s\S]{0,80}loadConnectionConfig/.test(html), '进入「访问与安全」时加载连接配置');
ok(/getElementById\('connSaveRestart'\)|connEl\('connSaveRestart'\)/.test(html), '「保存并重启」按钮已绑定');

console.log('## 工具开关');
const tools = [...html.matchAll(/data-v2-tool="([A-Za-z]+)"/g)].map((m) => m[1]);
ok(tools.includes('sendVoice'), 'sendVoice 开关存在', `共 ${tools.length} 个开关`);
ok(new Set(tools).size === tools.length, '工具开关无重复');
{
  const bridge = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');
  const toolFlags = [...(bridge.match(/const toolFlags = \[([^\]]+)\]/)?.[1] ?? '').matchAll(/'([A-Za-z]+)'/g)].map((m) => m[1]);
  ok(toolFlags.length > 0, '桥接定义 toolFlags 白名单');
  ok(tools.every((flag) => toolFlags.includes(flag)), '控制台每个工具开关都被桥接接受', tools.filter((flag) => !toolFlags.includes(flag)).join(', ') || '无遗漏');
  const mcp = fs.readFileSync(path.join(ROOT, 'src', 'mcp-snowluma-safe.js'), 'utf8');
  const mcpTools = [...new Set([...mcp.matchAll(/server\.tool\(\s*'([^']+)'/g)].map((m) => m[1]))];
  const mapped = new Set([...mcp.matchAll(/^\s*(qq_[a-z_]+):\s*'([A-Za-z]+)'/gm)].map((m) => m[1]));
  const unmapped = mcpTools.filter((name) => name.startsWith('qq_') && !mapped.has(name));
  ok(unmapped.length === 0, '每个 qq_* MCP 工具都有工具开关映射', unmapped.join(', ') || '无遗漏');
}

console.log('## SnowLuma API 工具开关（可检索）');
for (const id of ['v2ToolsSummary', 'v2ToolsJump', 'v2ToolsGroup', 'v2ToolSearch', 'v2ToolsCount']) {
  ok(ids.includes(id), `工具开关元素 ${id}`);
}
ok(/data-v2-tool="rawApi"/.test(html), 'rawApi 开关存在');
ok(/SnowLuma API（qq_api \/ qq_api_help）/.test(html), 'rawApi 开关标题明确标注 SnowLuma API');
ok(/function filterV2Tools/.test(html) && /getElementById\('v2ToolSearch'\)\.addEventListener/.test(html), '工具筛选已接线');
ok(/function updateV2ToolsSummary/.test(html) && /getElementById\('v2ToolsSummary'\)/.test(html), '工具开关摘要已接线');

console.log('## 语音面板接线');
ok(/id="voiceRefreshBtn"/.test(html) && /getElementById\('voiceRefreshBtn'\)\.addEventListener/.test(html), '刷新按钮已绑定事件');
ok(/getElementById\('voiceSendBtn'\)\.addEventListener/.test(html), '试发按钮已绑定事件');
ok(/api\('\/api\/voice\/list/.test(html), '面板调用 /api/voice/list（操作者通道，无需 key）');
ok(/api\('\/api\/voice\/send'/.test(html), '面板调用 /api/voice/send');
ok(/api\/voice\/tts\/engines/.test(html) && /api\('\/api\/voice\/tts'/.test(html), '面板调用语音合成端点');
ok(/api\/voice\/preview/.test(html), '面板调用语音试听端点');
ok(/getElementById\('voiceTtsBtn'\)\.addEventListener/.test(html), '合成按钮已绑定事件');
ok(/getElementById\('voicePreviewBtn'\)\.addEventListener/.test(html), '试听按钮已绑定事件');
ok(/typeof loadVoiceLibrary === 'function'|async function loadVoiceLibrary/.test(html), 'loadVoiceLibrary 已定义');

console.log('## JS 语法');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
const big = scripts.sort((a, b) => b.length - a.length)[0];
try { new Function(big); ok(true, '主 script 语法可解析', `${big.length} 字符`); }
catch (e) { ok(false, '主 script 语法', e.message); }

console.log('## 语音图形界面的音量控件');
if (!hasVoiceTool()) {
  // 这一整段查的是独立工具自己的页面（voice.html），仓库里没有它。
  skipVoiceTool('voice.html 的音量控件断言（volRange/volLabel/volReset/normBox/loudnessSel/previewBtn、滑块范围、事件绑定、前端 JS 可解析）');
} else {
  const voice = fs.readFileSync(voiceToolPath('public', 'voice.html'), 'utf8');
  const ids = [...voice.matchAll(/\sid="([A-Za-z0-9_-]+)"/g)].map((m) => m[1]);
  const dups = [...new Set(ids.filter((v, i) => ids.indexOf(v) !== i))];
  ok(dups.length === 0, 'voice.html ID 唯一', dups.length ? `重复：${dups.join(', ')}` : `共 ${ids.length} 个`);
  for (const id of ['volRange', 'volLabel', 'volReset', 'normBox', 'loudnessSel', 'previewBtn']) {
    ok(ids.includes(id), `音量控件 ${id}`);
  }
  ok(/id="volRange"[^>]*min="10"[^>]*max="400"/.test(voice), '滑块范围 10%~400%');
  ok(/volRange'\)\.addEventListener\('input'/.test(voice), '滑块 input 事件已绑定');
  ok(/previewBtn'\)\.addEventListener/.test(voice), '试听按钮已绑定');
  ok(/api\/preview/.test(voice), '试听调 /api/preview（听处理后的效果）');
  ok(/body\.normalize = true/.test(voice) && /body\.volume = volValue\(\)/.test(voice), '发送时带上音量设置');
  const scripts = [...voice.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  try { new Function(scripts[0]); ok(true, 'voice.html 前端 JS 可解析'); }
  catch (e) { ok(false, 'voice.html 前端 JS 可解析', e.message); }
}

console.log('## fixture mock 覆盖');
const fixture = fs.readFileSync(path.join(ROOT, 'scripts', 'console-ui-fixture.mjs'), 'utf8');
ok(fixture.includes("case '/api/socialV2/voices'"), 'fixture mock 了 /api/socialV2/voices');
ok(fixture.includes("case '/api/voice/send'"), 'fixture mock 了 /api/voice/send');
ok(fixture.includes("case '/api/voice/tts/engines'") && fixture.includes("case '/api/voice/tts'"), 'fixture mock 了语音合成端点');
ok(fixture.includes("case '/api/connection'") && fixture.includes("case '/api/connection/secret'"), 'fixture mock 了连接配置与密钥读取端点');

console.log(bad === 0 ? '\n全部通过' : `\n${bad} 项失败`);
if (bad > 0) process.exit(1);
