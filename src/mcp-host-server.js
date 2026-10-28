// SnowLuma 网关状态查询 MCP server（stdio）。
// 由 DSH 的 MCP 客户端 spawn（cordis.patch.yml 里 mcp-snowluma-host 行）。
//
// 工具：
//   snowluma_status   —— 检查网关是否在线（只读：HTTP get_login_info）与账号信息
//
// ── 为什么这里**没有**启停 SnowLuma 的 MCP 工具（2026-09-20 移除，不要加回来）─────
//
// 曾经有 `start_snowluma` / `stop_snowluma`（`spawn launcher.bat` / `taskkill`），默认关闭、
// 需要 `snowluma.allowProcessControl: true` 才注册。它们被移除，理由不是"危险"，而是**许可**
// 与边界：SnowLuma EULA §5.4 规定「并入第三方安装包或 Docker 镜像、通过自动化脚本部署」
// 须事先取得书面授权；把进程控制交给**群里的模型**也远超这个工具需要的权限。
//
// 注意区分：**桥接启动时**会扫描用户在 `lib/<名称>/launcher.*` 放好的启动器并尝试拉起
// （见 src/lib-autolaunch.js，可用 `config.lib.autoLaunch: false` 关闭）。那只是运行用户
// 已安装的本机程序，不安装、不复制、不打包、不下载，也不暴露给 agent；用户需自行确保
// 对该程序拥有相应授权。MCP 侧依然只有只读探活，不会替模型启停任何进程。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function loadConfig() {
  try {
    let text = fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function getConfig() {
  return loadConfig();
}

function getHostConfig() {
  const c = getConfig();
  const httpUrl = (c.snowluma?.httpUrl ?? 'http://127.0.0.1:3000').replace(/\/+$/, '');
  const homeDir = c.snowluma?.homeDir ?? (c.snowluma?.launcherPath ? path.dirname(c.snowluma.launcherPath) : '');
  return { httpUrl, homeDir, token: c.snowluma?.accessToken ?? '' };
}

async function gatewayInfo() {
  const { httpUrl, token } = getHostConfig();
  try {
    const res = await fetch(`${httpUrl}/get_login_info`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(5000)
    });
    if (!res.ok) {
      const hint = res.status === 426 ? '（HTTP 426：snowluma.httpUrl 可能指向了 WebSocket 端口，请改为 OneBot HTTP API 地址）' : '';
      return { reachable: false, httpStatus: res.status, ...(hint ? { hint } : {}) };
    }
    const body = await res.json();
    if (body?.status === 'ok' && body?.retcode === 0) {
      return { reachable: true, online: true, user_id: body.data?.user_id, nickname: body.data?.nickname };
    }
    return { reachable: true, online: false, retcode: body?.retcode, wording: body?.wording };
  } catch (error) {
    return { reachable: false, error: String(error?.message ?? error) };
  }
}

const server = new McpServer({ name: 'snowluma-host', version: '0.2.1-r1' });

// 控制台「二代仿真 → 工具开关」的 hostStatus；只在 reserved2 下按开关隐藏。
const hostToolEnabled = (() => {
  let mode = '';
  let tools = {};
  try { mode = String(JSON.parse(fs.readFileSync(path.join(ROOT, 'state', 'mode.json'), 'utf8'))?.mode ?? ''); } catch {}
  try { tools = getConfig()?.socialV2?.tools ?? {}; } catch {}
  return !(mode === 'reserved2' && tools?.hostStatus === false);
})();

if (hostToolEnabled) server.tool(
  'snowluma_status',
  '检查 SnowLuma OneBot 网关是否在线（只读探活 get_login_info）。返回网关可达性、QQ 在线状态与账号信息。网关不可达时返回可操作的提示（桥接启动时会尝试拉起 lib/SnowLuma/launcher.bat，可用 config.lib.autoLaunch 关闭）。',
  {},
  async () => {
    const hc = getHostConfig();
    const info = await gatewayInfo();
    // 只读工具：不再暴露本机路径/PID（那需要进程控制能力，而该能力已被移除）。
    const payload = { ...info };
    if (info.reachable === false) {
      payload.hint = 'SnowLuma 网关不可达。请检查 lib/SnowLuma/launcher.bat 是否存在并成功启动（config.lib.autoLaunch 关闭时需手动启动）。'
        + (hc.homeDir ? '' : ' 若 config.json 的 snowluma.httpUrl 与实际端口不一致，也请一并检查。');
    }
    return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
  }
);

await server.connect(new StdioServerTransport());
