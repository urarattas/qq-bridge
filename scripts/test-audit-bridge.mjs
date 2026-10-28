import assert from 'node:assert/strict';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

let failures = 0;
async function test(name, run) {
  const h = await bridgeHarness();
  try { await run(h); console.log('PASS', name); }
  catch (error) { failures++; console.error('FAIL', name, error.message); }
  finally { await h.close(); }
}
await test('closed-agent session is not reused after switching to chat', async (h) => {
  h.setMode('closed-agent');
  const privileged = await h.ensureSession('private:123');
  h.setMode('chat');
  const restricted = await h.ensureSession('private:123');
  assert.notEqual(restricted, privileged);
  assert.equal(h.calls.created.at(-1).agentPreset, 'qq-chat');
  assert.ok(h.calls.cancelled.includes(privileged));
});
await test('unavailable preset catalogue fails closed for QQ and learner sessions', async (h) => {
  h.setPresets([]);
  assert.equal(h.resolvePresetName('missing', { strict: true }), '');
  await assert.rejects(h.ensureSession('group:456'));
  await assert.rejects(h.ensureSlangLearnerSession());
  assert.equal(h.calls.created.length, 0);
});
await test('session creation crossing a mode change never accepts stale permissions', async (h) => {
  h.setMode('closed-agent');
  let release;
  const original = h.api.sessions.create;
  h.api.sessions.create = async (params) => {
    const result = await original(params);
    await new Promise((resolve) => { release = resolve; });
    return result;
  };
  const pending = h.ensureSession('private:123');
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  h.setMode('chat');
  release();
  await assert.rejects(pending);
  assert.equal(h.state.sessions['private:123'], undefined);
});
await test('queued send rechecks allowlist at actual transport time', async (h) => {
  const sending = h.sendToQQ('group:456', 'fixture');
  h.cfg.allow.groups = [];
  await sending;
  assert.equal(h.calls.sent.length, 0);
});
await test('本地 /help 不投递 DSH，指令与回复都不进入二代消息流', async (h) => {
  h.setMode('reserved2');
  const event = {
    self_id: 999, user_id: 456, group_id: 456, message_id: 1001,
    sender: { user_id: 456, nickname: '群友' },
    message: [{ type: 'text', data: { text: '/help' } }]
  };
  await h.handleIncoming('group', 456, event, h.cfg);
  assert.equal(h.calls.prompts.length, 0, '/help 不得投递 DSH');
  assert.ok(h.calls.sent.some((m) => m.kind === 'group' && String(m.text).includes('/help')), '应本地回复帮助');
  const st = h.getSocialV2State('group:456');
  assert.equal(st.unread.length, 0, '指令不能进入二代未读');
  assert.equal(st.recentMessages.length, 0, '指令不能进入二代最近消息');
});
await test('允许任何人开关按类型放行，黑名单优先且不改管理员', async (h) => {
  h.setMode('reserved2');
  assert.equal(h.modeAllowed('group:999', 'group', 999, h.cfg, 'reserved2'), false, '默认仍按白名单拦截');
  h.cfg.allowAll = { groups: true, private: false };
  assert.equal(h.modeAllowed('group:999', 'group', 999, h.cfg, 'reserved2'), true, '开启后任意群放行');
  assert.equal(h.modeAllowed('private:999', 'private', 999, h.cfg, 'reserved2'), false, '未开启的类型不受影响');
  h.cfg.allowAll = { groups: true, private: true };
  assert.equal(h.modeAllowed('private:999', 'private', 999, h.cfg, 'reserved2'), true, '开启后任意私聊放行');
  h.cfg.deny.groups.push('999');
  assert.equal(h.modeAllowed('group:999', 'group', 999, h.cfg, 'reserved2'), false, '黑名单必须优先于 allowAll');
  assert.equal(h.cfg.ownerQQ, 123, 'allowAll 不得改动 ownerQQ');
  // 封闭 Agent 仍只允许管理员私聊
  assert.equal(h.modeAllowed('private:999', 'private', 999, h.cfg, 'closed-agent'), false, 'closed-agent 不受 allowAll 影响');
});
await test('好友/加群请求入库、私聊通知管理员，并可由管理员处理', async (h) => {
  h.setMode('reserved2');
  const friend = { post_type: 'request', request_type: 'friend', flag: 'flag-friend-1', user_id: 200001, comment: '你好' };
  await h.handleRequestEvent(friend);
  const entry = h.requestStore.items.find((x) => x.flag === 'flag-friend-1');
  assert.ok(entry, '好友申请必须入库');
  assert.equal(entry.status, 'pending');
  assert.ok(h.calls.sent.some((m) => m.kind === 'private' && String(m.text).includes('好友申请')), '应私聊通知管理员');
  const notified = h.calls.sent.length;
  await h.handleRequestEvent(friend);
  assert.equal(h.calls.sent.length, notified, '同一 flag 重复投递不得重复通知');
  const res = await h.decideAddRequest(entry.id, true);
  assert.equal(res.ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls.requests.at(-1))), { action: 'set_friend_add_request', params: { flag: 'flag-friend-1', approve: true } });
  assert.equal(entry.status, 'approved');
  assert.equal((await h.decideAddRequest(entry.id, false)).ok, false, '已处理的请求不能再处理');

  const group = { post_type: 'request', request_type: 'group', flag: 'flag-group-1', group_id: 456, user_id: 777, sub_type: 'invite', comment: '' };
  await h.handleRequestEvent(group);
  const ge = h.requestStore.items.find((x) => x.flag === 'flag-group-1');
  await h.decideAddRequest(ge.id, false, '不认识');
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls.requests.at(-1))), {
    action: 'set_group_add_request',
    params: { flag: 'flag-group-1', approve: false, sub_type: 'invite', reason: '不认识' }
  });
  assert.equal(ge.status, 'rejected');
});
await test('管理员可用 /requests 与 /approve 处理好友请求', async (h) => {
  h.setMode('reserved2');
  await h.handleRequestEvent({ post_type: 'request', request_type: 'friend', flag: 'flag-cmd-1', user_id: 200003, comment: '指令测试' });
  const entry = h.requestStore.items.find((x) => x.flag === 'flag-cmd-1');
  const say = (text) => h.handleIncoming('private', 123, {
    self_id: 999, user_id: 123, message_id: 3001,
    sender: { user_id: 123, nickname: '管理员' },
    message: [{ type: 'text', data: { text } }]
  }, h.cfg);
  await say('/requests');
  assert.ok(h.calls.sent.some((m) => String(m.text).includes(`#${entry.id}`) && String(m.text).includes('好友申请')), '/requests 应列出待处理请求');
  await say(`/approve ${entry.id}`);
  assert.equal(entry.status, 'approved');
  assert.ok(h.calls.sent.some((m) => String(m.text).includes('已通过')), '/approve 应回复结果');
  await say('/requests');
  assert.ok(h.calls.sent.some((m) => String(m.text).includes('没有待处理')), '处理完应显示无待处理');
});
await test('群友 /status 被本地拒绝，管理员 /status 本地回复且不投递 DSH', async (h) => {
  h.setMode('reserved2');
  const makeEvent = (userId, text) => ({
    self_id: 999, user_id: userId, group_id: 456, message_id: 1002 + userId,
    sender: { user_id: userId, nickname: String(userId) },
    message: [{ type: 'text', data: { text } }]
  });
  await h.handleIncoming('group', 456, makeEvent(456, '/status'), h.cfg);
  assert.ok(h.calls.sent.some((m) => String(m.text).includes('仅管理员')), '群友应收到仅管理员提示');
  h.calls.sent.length = 0;
  await h.handleIncoming('group', 456, makeEvent(123, '/status'), h.cfg);
  assert.equal(h.calls.prompts.length, 0, '管理员 /status 也不得投递 DSH');
  assert.ok(h.calls.sent.some((m) => String(m.text).includes('会话') && String(m.text).includes('模式')), '管理员应收到本地状态');
  const st = h.getSocialV2State('group:456');
  assert.equal(st.unread.length, 0, '指令与回复都不能进入二代未读');
  assert.equal(st.recentMessages.length, 0, '指令与回复都不能进入二代最近消息');
});
await test('控制台模型切换只接受 DSH 目录中的组合，并热更新会话模型', async (h) => {
  h.api.callUnary = async (method) => {
    if (method === 'session.modelCatalog') {
      return { result: { ok: true, value: { groups: [{ id: 'my-relay', models: [{ id: 'relay-large', reasoning: { efforts: [{ id: 'high' }], defaultEffort: 'high' } }] }] } } };
    }
    return { result: { ok: true, value: {} } };
  };
  h.cfg.dsh = { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max' };
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  const post = (body) => new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port: server.address().port, path: '/api/dsh/model?token=fixture-console-token', method: 'POST', headers: { 'content-type': 'application/json' } }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') }));
    });
    request.on('error', reject);
    request.setTimeout(3000, () => request.destroy(new Error('model request hung')));
    request.end(JSON.stringify(body));
  });
  try {
    const ok = await post({ provider: 'my-relay', model: 'relay-large' });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.model, 'relay-large');
    assert.equal(h.cfg.dsh.provider, 'my-relay');
    assert.equal(h.cfg.dsh.model, 'relay-large');
    assert.equal(h.cfg.dsh.reasoningEffort, 'high', '不兼容的思考强度应回退到该模型默认档');
    const bad = await post({ provider: 'my-relay', model: 'not-in-catalog' });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /my-relay/);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});
await test('二代工具开关覆盖全部 MCP 工具，并能在控制台保存', async (h) => {
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;
  const request = (path, method = 'GET', body = null) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: path + (path.includes('?') ? '&' : '?') + 'token=fixture-console-token', method, headers: body ? { 'content-type': 'application/json' } : {} }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
  try {
    const first = JSON.parse((await request('/api/socialV2/config')).text);
    for (const flag of ['status', 'rawApi', 'listGroups', 'groupHistory', 'getGroupMembers', 'webSearch', 'webFetch', 'hostStatus']) {
      assert.equal(first.config.tools[flag], true, `${flag} 默认应为 true`);
    }
    const saved = JSON.parse((await request('/api/socialV2/config', 'POST', { tools: { rawApi: false, webSearch: false } })).text);
    assert.equal(saved.ok, true);
    const after = JSON.parse((await request('/api/socialV2/config')).text);
    assert.equal(after.config.tools.rawApi, false);
    assert.equal(after.config.tools.webSearch, false);
    assert.equal(after.config.tools.status, true, '未提交的开关应保留默认值');
  } finally { await new Promise((resolve) => server.close(resolve)); }
});
await test('控制台语音合成写入语音库，试听端点可直接读取', async (h) => {
  if (process.platform !== 'win32') { console.log('SKIP 非 Windows，无 SAPI'); return; }
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;
  const request = (path, method = 'GET', body = null) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: path + (path.includes('?') ? '&' : '?') + 'token=fixture-console-token', method, headers: body ? { 'content-type': 'application/json' } : {} }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, buffer: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.setTimeout(60000, () => req.destroy(new Error('tts request timed out')));
    req.end(body ? JSON.stringify(body) : undefined);
  });
  try {
    const engines = JSON.parse((await request('/api/voice/tts/engines')).buffer.toString('utf8'));
    assert.equal(engines.ok, true);
    assert.ok(engines.engines.some((engine) => engine.id === 'sapi'), '应检测到 Windows SAPI');
    const synth = await request('/api/voice/tts', 'POST', { text: '语音合成回归测试。', engine: 'sapi' });
    const body = JSON.parse(synth.buffer.toString('utf8'));
    assert.equal(synth.status, 200, JSON.stringify(body));
    assert.match(body.file, /\.wav$/);
    const preview = await request('/api/voice/preview?file=' + encodeURIComponent(body.file));
    assert.equal(preview.status, 200);
    assert.match(String(preview.headers['content-type']), /^audio\//);
    assert.ok(preview.buffer.length > 1000, '试听应返回真实音频');
  } finally { await new Promise((resolve) => server.close(resolve)); }
});
await test('old prompt completion cannot delete replacement queue after reset', async (h) => {
  const release = [];
  h.api.sessions.prompt = async () => {
    await new Promise((resolve) => release.push(resolve));
    return { result: { ok: true, value: {} } };
  };
  const first = h.deliverPrompt('group:456', 'first');
  while (release.length < 1) await new Promise((resolve) => setImmediate(resolve));
  h.drainPromptQueue('group:456', 'reset');
  const second = h.deliverPrompt('group:456', 'second');
  while (release.length < 2) await new Promise((resolve) => setImmediate(resolve));
  const replacement = h.promptQueues.get('group:456');
  release[0](); await first;
  assert.equal(h.promptQueues.get('group:456'), replacement);
  release[1](); await second;
});
await test('same-policy sessions are reused but legacy unlabelled sessions are replaced', async (h) => {
  const first = await h.ensureSession('private:123');
  assert.equal(await h.ensureSession('private:123'), first);
  delete h.state.sessionPolicies['private:123'];
  assert.notEqual(await h.ensureSession('private:123'), first);
});
await test('reset during model selection cannot return a detached session', async (h) => {
  h.api.sessions.selectModel = async () => {
    h.resetEpoch();
    return { result: { ok: true, value: { selected: {} } } };
  };
  await assert.rejects(h.ensureSession('private:123'));
  assert.equal(h.state.sessions['private:123'], undefined);
});
await test('malformed HTTP request targets return 400 without hanging', async (h) => {
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  try {
    const status = await new Promise((resolve, reject) => {
      const request = http.request({ host: '127.0.0.1', port: server.address().port, path: 'http://[', method: 'GET' }, (response) => {
        response.resume(); response.on('end', () => resolve(response.statusCode));
      });
      request.on('error', reject);
      request.setTimeout(1500, () => request.destroy(new Error('request hung')));
      request.end();
    });
    assert.equal(status, 400);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});
{ // 控制台重置路径必须与 retireSession 一样：清掉权限元数据并终止 DSH 侧排队的工作。
  const h = await bridgeHarness();
  const server = h.startConsoleServer();
  try {
    if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
    const sessionId = await h.ensureSession('private:123');
    assert.ok(h.state.sessionPolicies['private:123'], 'policy should exist before reset');
    h.calls.cancelled.length = 0;
    const status = await new Promise((resolve, reject) => {
      const request = http.request({ host: '127.0.0.1', port: server.address().port, path: '/api/session/reset?token=fixture-console-token', method: 'POST',
        headers: { 'content-type': 'application/json' } }, (response) => {
        response.resume();
        response.on('end', () => resolve(response.statusCode));
      });
      request.on('error', reject);
      request.setTimeout(3000, () => request.destroy(new Error('reset request hung')));
      request.end(JSON.stringify({ key: 'private:123' }));
    });
    assert.equal(status, 200);
    assert.equal(h.state.sessions['private:123'], undefined);
    assert.equal(h.state.sessionPolicies['private:123'], undefined, 'policy must not be orphaned by reset');
    assert.ok(h.calls.cancelled.includes(sessionId), 'reset must stop the retired DSH session');
    console.log('PASS console reset drops the session policy and stops the retired DSH session');
  } catch (error) { failures++; console.error('FAIL console reset cleanup:', error.message); }
  finally { await new Promise((resolve) => server.close(resolve)); await h.close(); }
}
{
  const image = Buffer.from('89504e470d0a1a0a00000000', 'hex');
  let body;
  const h = await bridgeHarness({ globals: {
    safeFetchBuffer: async () => ({ buffer: image }),
    validateFetchUrl: async () => { throw new Error('must fetch validated bytes instead of passing a URL'); },
    fetch: async (_url, init) => {
      body = JSON.parse(init.body);
      return { ok: true, json: async () => ({ status: 'ok', retcode: 0, data: { message_id: 1 } }) };
    },
  } });
  try {
    await h.sendStickerV2('group:456', 'fixture-sticker');
    assert.equal(body.message.find((part) => part.type === 'image').data.file, 'base64://' + image.toString('base64'));
    console.log('PASS sticker sending gives OneBot validated bytes, never a URL to refetch');
  } catch (error) { failures++; console.error('FAIL safe sticker sending:', error.message); }
  finally { await h.close(); }
}
// ── 语音发送（AI 通道）的安全边界 ────────────────────────────────────────────
// 语音比文本更"重"（真的会说话、不可撤回），所以这里逐条钉住它的闸门：
// 来源只能是语音库、白名单必须命中、限流要生效、文件名审计要拦住本机路径。
{
  const fs = await import('node:fs');
  const path = await import('node:path');
  // 默认出厂配置是 voice.enabled=false（AI 不能发语音）；这里显式打开，
  // 才能测"打开之后"的各项闸门。关闭时的行为单独在下面钉一条。
  const voiceOn = { socialV2: { voice: { enabled: true } } };
  const h = await bridgeHarness({ config: voiceOn });
  try {
    // 语音库 fixture：临时 config 的 ROOT 之下，voice.dir 默认 'audio'
    const audioDir = path.join(h.temp, 'audio');
    fs.mkdirSync(audioDir, { recursive: true });
    fs.writeFileSync(path.join(audioDir, 'hello.mp3'), Buffer.alloc(1024, 1));
    // 库外的文件（模拟"随便一个本地文件"）
    const outside = path.join(h.temp, 'outside-secret.mp3');
    fs.writeFileSync(outside, Buffer.alloc(1024, 1));

    const names = h.voiceLibrary().map((v) => v.name);
    assert.ok(names.includes('hello.mp3'), '语音库列出库内音频');
    assert.ok(!names.some((n) => n.includes(h.temp)), '语音库不返回绝对路径');

    // 1) AI 只能按语音库名字取文件
    const okPath = h.resolveVoicePathForV2('hello');
    assert.equal(okPath.path, path.join(audioDir, 'hello.mp3'), 'AI 省略扩展名也能命中语音库文件');

    // 2) 绝对路径默认被拒（防 prompt injection 拿任意本地文件外发）
    assert.throws(() => h.resolveVoicePathForV2(outside), /语音库|绝对路径/, 'AI 传库外绝对路径被拒');
    assert.throws(() => h.resolveVoicePathForV2('C:\\Windows\\Media\\Alarm01.wav'), /语音库|绝对路径/, 'AI 传系统绝对路径被拒');

    // 3) 远程/内联来源被拒（体积与来源都不可控）
    for (const bad of ['https://example.com/a.mp3', 'base64://AAAA', 'data:audio/mp3;base64,AAAA']) {
      assert.throws(() => h.resolveVoicePathForV2(bad), /不接受|只能/, `AI 传 ${bad.split(':')[0]} 来源被拒`);
    }

    // 4) 真发一条（虚拟网关）：必须是 record 段、且 file 指向库内文件
    const sent = await h.sendVoiceForV2('group:456', 'hello.mp3', { readback: false });
    const call = h.calls.http.find((c) => c.url.endsWith('/send_group_msg'));
    assert.ok(call, '语音走 send_group_msg');
    assert.equal(call.body.group_id, 456, '语音发给正确群');
    assert.equal(call.body.message.length, 1, '语音只发一个段');
    assert.equal(call.body.message[0].type, 'record', '段类型是 record');
    assert.equal(call.body.message[0].data.file, path.join(audioDir, 'hello.mp3'), 'record 段指向库内绝对路径');
    assert.equal(sent.messageId, 9001, '返回网关 message_id');
    assert.equal(sent.readback, null, '显式关掉回读时不调 fetch_ptt_text');

    // 5) 落地校验：默认用 get_msg 回读确认这条消息真的带 record 段
    const h2 = await bridgeHarness({ config: voiceOn });
    try {
      const dir2 = path.join(h2.temp, 'audio');
      fs.mkdirSync(dir2, { recursive: true });
      fs.writeFileSync(path.join(dir2, 'hi.mp3'), Buffer.alloc(512, 1));
      const sent2 = await h2.sendVoiceForV2('group:456', 'hi.mp3');
      // 注意：这些对象来自 vm realm，deepEqual 会因原型不同而失败 → 逐字段断言
      assert.equal(sent2.verification?.confirmed, true, '默认回读 get_msg 确认 record 段');
      assert.equal(sent2.verification?.duration, 3, '回读到语音时长');
      // 校验结果**不能**把源文件路径回传给 AI（私聊 get_msg 会把本机路径塞进 record.url）
      assert.equal(sent2.verification?.file, undefined, '校验结果不回传文件路径（防路径泄露进模型上下文）');
      assert.ok(h2.calls.http.some((c) => c.url.endsWith('/get_msg')), '校验走 get_msg');
      assert.equal(sent2.readback, null, '默认不索取转写（自己发的语音没有转写）');
      // 关掉校验时不发 get_msg
      const h2b = await bridgeHarness({ config: voiceOn });
      try {
        const dir2b = path.join(h2b.temp, 'audio');
        fs.mkdirSync(dir2b, { recursive: true });
        fs.writeFileSync(path.join(dir2b, 'hi.mp3'), Buffer.alloc(512, 1));
        const sent2b = await h2b.sendVoiceForV2('group:456', 'hi.mp3', { verify: false });
        assert.equal(sent2b.verification, null, 'verify=false 时不做回读校验');
        assert.ok(!h2b.calls.http.some((c) => c.url.endsWith('/get_msg')), 'verify=false 时不发 get_msg');
      } finally { await h2b.close(); }
    } finally { await h2.close(); }

    // 6) 文件名审计：含本机路径特征的名字不许外发。
    //    resolveVoicePathForV2 允许绝对路径的"文件名形态"由 allowAbsolutePath 管；
    //    这里直接喂一个**看起来就像本机路径**的名字，验证审计层会拦下来。
    await assert.rejects(
      () => h.sendVoiceForV2('group:456', 'C:\\Users\\somebody\\secret-voice.mp3', { readback: false }),
      /敏感信息|语音库|绝对路径/,
      '文件名含本机路径特征被审计/来源校验拦截'
    );

    // 7) 限流：语音额度独立计数，超限拒绝
    const h3 = await bridgeHarness({ config: { socialV2: { voice: { enabled: true, maxPerMinute: 1, maxPerHour: 2 } } } });
    try {
      const dir3 = path.join(h3.temp, 'audio');
      fs.mkdirSync(dir3, { recursive: true });
      fs.writeFileSync(path.join(dir3, 'a.mp3'), Buffer.alloc(512, 1));
      await h3.sendVoiceForV2('group:456', 'a.mp3', { readback: false });
      await assert.rejects(
        () => h3.sendVoiceForV2('group:456', 'a.mp3', { readback: false }),
        /频率超限|每分钟/,
        '同一分钟内第二条语音被限流（每分钟 1 条）'
      );
      // 额度只在发出后才记账：参数错误不应吃掉配额
      const h4 = await bridgeHarness({ config: { socialV2: { voice: { enabled: true, maxPerMinute: 1, maxPerHour: 2 } } } });
      try {
        const dir4 = path.join(h4.temp, 'audio');
        fs.mkdirSync(dir4, { recursive: true });
        fs.writeFileSync(path.join(dir4, 'a.mp3'), Buffer.alloc(512, 1));
        await assert.rejects(() => h4.sendVoiceForV2('group:456', 'nope.mp3'), /找不到/, '不存在的音频被拒');
        // 失败没有消耗额度 → 紧接着真发一条应当成功
        const ok2 = await h4.sendVoiceForV2('group:456', 'a.mp3', { readback: false });
        assert.equal(ok2.messageId, 9001, '失败不吃额度：随后发送成功');
      } finally { await h4.close(); }
    } finally { await h3.close(); }

    // 8) 语音功能总开关关闭时，**AI 通道**彻底拒绝
    const h5 = await bridgeHarness({ config: { socialV2: { voice: { enabled: false } } } });
    try {
      await assert.rejects(() => h5.sendVoiceForV2('group:456', 'a.mp3'), /已关闭/, 'voice.enabled=false 时 AI 通道拒绝发送');
    } finally { await h5.close(); }

    // 9) 但**操作者通道**不受这个开关影响：否则"默认不启用"会变成"连手动试发都做不了"
    const h6 = await bridgeHarness({ config: { socialV2: { voice: { enabled: false } } } });
    try {
      const dir6 = path.join(h6.temp, 'audio');
      fs.mkdirSync(dir6, { recursive: true });
      fs.writeFileSync(path.join(dir6, 'a.mp3'), Buffer.alloc(512, 1));
      const sent6 = await h6.sendVoiceV2('group:456', path.join(dir6, 'a.mp3'), { guard: false, audit: true });
      assert.equal(sent6.messageId, 9001, 'voice.enabled=false 时操作者仍能发（AI 开关不该封死手动路径）');
    } finally { await h6.close(); }

    // 10) 音量：倍数会传给音频处理，并原样回报给调用方
    const h7 = await bridgeHarness({ config: voiceOn });
    try {
      const dir7 = path.join(h7.temp, 'audio');
      fs.mkdirSync(dir7, { recursive: true });
      fs.writeFileSync(path.join(dir7, 'a.mp3'), Buffer.alloc(512, 1));
      const loud = await h7.sendVoiceV2('group:456', path.join(dir7, 'a.mp3'), { guard: false, audit: true, audio: { volume: 2.5 } });
      assert.equal(loud.volume, 2.5, '音量倍数透传到音频处理');
      assert.equal(loud.audioMode, 'volume', 'mode 标为 volume');
      assert.match(loud.audioProcessing, /250%/, '处理说明含百分比');
      const normal = await h7.sendVoiceV2('group:456', path.join(dir7, 'a.mp3'), { guard: false, audit: true });
      assert.equal(normal.audioMode, 'original', '不传音量时保持原样（不转码）');
      assert.equal(normal.audioProcessing, '原始音量', '原样时说明为"原始音量"');
      const smart = await h7.sendVoiceV2('group:456', path.join(dir7, 'a.mp3'), { guard: false, audit: true, audio: { normalize: true, loudness: 'loud' } });
      assert.equal(smart.audioMode, 'loudnorm', '智能音量 mode=loudnorm');
      assert.match(smart.audioProcessing, /-13/, '智能音量按档位给出目标 LUFS');
      // 非法音量必须被拦下（而不是把奇怪的值丢给 ffmpeg）
      await assert.rejects(
        () => h7.sendVoiceForV2('group:456', 'a.mp3', { verify: false, audio: { volume: 99 } }),
        /0\.1~4/,
        '越界音量被拒'
      );
      await assert.rejects(
        () => h7.sendVoiceForV2('group:456', 'a.mp3', { verify: false, audio: { normalize: true, loudness: 'nope' } }),
        /未知的响度档位/,
        '未知响度档位被拒'
      );
    } finally { await h7.close(); }

    console.log('PASS voice sending enforces library-only source, whitelist, budget, name audit and volume');
  } catch (error) { failures++; console.error('FAIL voice sending guards:', error.message); }
  finally { await h.close(); }
}

// ── 语音路径：allowAbsolutePath 不再放宽 AI 通道（任意本机音频外发）────────────
// 审计发现：开关打开时 resolveVoicePathForV2 会把 AI 给的绝对路径直接交给
// resolveAudioSource 解析，于是群友用提示注入就能让 AI 把本机任意音频（< 20MB）
// 发到群里；而 inspectAudio 在 ffprobe 不可用时对任何文件都放行。
// 现在即使开了开关，绝对路径也必须落在语音库目录之内。
{
  const fs = await import('node:fs');
  const path = await import('node:path');
  const h = await bridgeHarness({ config: { socialV2: { voice: { enabled: true, allowAbsolutePath: true, maxPerMinute: 50, maxPerHour: 50 } } } });
  try {
    const libraryDir = path.join(h.temp, 'audio');
    const outsideDir = path.join(h.temp, 'outside');
    fs.mkdirSync(libraryDir, { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.writeFileSync(path.join(libraryDir, 'inside.mp3'), Buffer.alloc(512, 1));
    const outsideFile = path.join(outsideDir, 'secret.mp3');
    fs.writeFileSync(outsideFile, Buffer.alloc(512, 2));

    // 库外的绝对路径必须被拒绝（即使 allowAbsolutePath=true）
    await assert.rejects(
      () => h.sendVoiceForV2('group:456', outsideFile, { readback: false }),
      /语音库/,
      'allowAbsolutePath=true 时库外绝对路径仍必须被拒绝'
    );
    // 相对穿越同样必须被拒绝
    await assert.rejects(
      () => h.sendVoiceForV2('group:456', path.join('..', 'outside', 'secret.mp3'), { readback: false }),
      /语音库|\.\./,
      '相对路径穿越必须被拒绝'
    );
    // 库内的绝对路径应当仍然可用（开关的合理用途）
    const inside = await h.sendVoiceForV2('group:456', path.join(libraryDir, 'inside.mp3'), { readback: false });
    assert.equal(inside.messageId, 9001, '库内绝对路径仍可发送');
    console.log('PASS voice absolute paths stay confined to the library even when allowAbsolutePath is on');
  } catch (error) { failures++; console.error('FAIL voice library confinement:', error.message); }
  finally { await h.close(); }
}

// agent token 默认拒绝：MCP 的 v2 工具同时携带 x-console-token 与 x-agent-token，
// 因此仅靠控制台令牌挡不住 QQ 群里的 AI。人格/提示词/思考强度/白名单/重启等管理端点
// 必须对 agent token 一律 403，否则 AI 能改写自己的系统提示词或给自己提权。
{
  const h = await bridgeHarness();
  const server = h.startConsoleServer();
  try {
    if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
    const port = server.address().port;
    const call = (path, method = 'GET', headers = {}, body) => new Promise((resolve, reject) => {
      const request = http.request(
        { host: '127.0.0.1', port, path, method, headers: { 'content-type': 'application/json', ...headers } },
        (response) => {
          let data = '';
          response.on('data', (chunk) => { data += chunk; });
          response.on('end', () => resolve({ status: response.statusCode, body: data }));
        },
      );
      request.on('error', reject);
      request.setTimeout(3000, () => request.destroy(new Error('request hung')));
      request.end(body === undefined ? undefined : JSON.stringify(body));
    });
    const adminOnly = { 'x-console-token': 'fixture-console-token' };
    const asAgent = { ...adminOnly, 'x-agent-token': 'fixture-agent-token' };
    const mustDeny = [
      ['GET', '/api/roles'], ['GET', '/api/roles/content?name=x'], ['GET', '/api/roles?x=1'],
      ['POST', '/api/roles/create'], ['POST', '/api/roles/update'],
      ['POST', '/api/roles/rename'], ['POST', '/api/roles/delete'],
      ['GET', '/api/preset/sim-prompt'], ['POST', '/api/preset/sim-prompt'],
      ['GET', '/api/preset/sim-prompt/backups'], ['POST', '/api/preset/sim-prompt/restore'],
      ['GET', '/api/dsh/model'], ['POST', '/api/dsh/effort'],
      ['GET', '/api/whitelist'], ['POST', '/api/whitelist'], ['POST', '/api/restart'],
      ['GET', '/api/requests'], ['POST', '/api/requests/decide'],
      ['POST', '/api/console/token'], ['GET', '/api/role'], ['POST', '/api/role'],
      ['GET', '/api/connection'], ['GET', '/api/connection/secret?name=dsh'], ['POST', '/api/connection'],
    ];
    for (const [method, path] of mustDeny) {
      const res = await call(path, method, asAgent, method === 'POST' ? {} : undefined);
      assert.equal(res.status, 403, `${method} ${path} 必须对 agent token 拒绝，实际 HTTP ${res.status}`);
    }
    // 绕过尝试：路径穿越与重复斜杠在 URL 解析后仍需被拒
    for (const path of ['/api/roles/../roles', '/api//roles', '/api/./roles', '/api/roles/']) {
      const res = await call(path, 'GET', asAgent);
      assert.notEqual(res.status, 200, `${path} 不得绕过 agent token 限制（实际 HTTP ${res.status}）`);
    }
    // 允许面：AI 真正需要的只读接口不应被误伤
    const allowed = await call('/api/status', 'GET', asAgent);
    assert.equal(allowed.status, 200, '/api/status 应对 agent token 放行');
    // 同一批管理端点，管理员（仅控制台令牌）应可正常访问
    const adminOk = await call('/api/dsh/model', 'GET', adminOnly);
    assert.equal(adminOk.status, 200, '管理员应能访问 /api/dsh/model');
    console.log('PASS agent token cannot reach persona/prompt/effort/whitelist admin endpoints');
  } catch (error) { failures++; console.error('FAIL agent token admin isolation:', error.message); }
  finally { await new Promise((resolve) => server.close(resolve)); await h.close(); }
}
// ── 白名单 allowAll 开关与好友/加群请求控制台端点 ──────────────────────────
{
  const h = await bridgeHarness();
  const server = h.startConsoleServer();
  try {
    if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
    const port = server.address().port;
    const call = (path, method = 'GET', body) => new Promise((resolve, reject) => {
      const request = http.request(
        { host: '127.0.0.1', port, path, method, headers: { 'content-type': 'application/json', 'x-console-token': 'fixture-console-token' } },
        (response) => {
          let data = '';
          response.on('data', (chunk) => { data += chunk; });
          response.on('end', () => resolve({ status: response.statusCode, body: data ? JSON.parse(data) : null }));
        },
      );
      request.on('error', reject);
      request.setTimeout(3000, () => request.destroy(new Error('request hung')));
      request.end(body === undefined ? undefined : JSON.stringify(body));
    });

    const before = await call('/api/whitelist');
    assert.equal(before.status, 200);
    assert.deepEqual(before.body.allowAll, { groups: false, private: false });
    const saved = await call('/api/whitelist', 'POST', {
      allow: { private: [123], groups: [456] },
      deny: { private: [], groups: [] },
      allowAll: { groups: true, private: false }
    });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.body.allowAll, { groups: true, private: false });
    assert.equal(saved.body.ownerQQ, 123, '未提交 ownerQQ 时管理员必须保持不变');
    assert.equal(h.cfg.ownerQQ, 123, 'allowAll 不得改动管理员');
    assert.deepEqual(JSON.parse(JSON.stringify(h.cfg.allowAll)), { groups: true, private: false });
    const onDisk = JSON.parse(fs.readFileSync(path.join(h.temp, 'config.json'), 'utf8'));
    assert.deepEqual(onDisk.allowAll, { groups: true, private: false }, 'allowAll 必须写入 config.json');

    const empty = await call('/api/requests');
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.body.requests, []);
    await h.handleRequestEvent({ post_type: 'request', request_type: 'friend', flag: 'flag-http-1', user_id: 200009, comment: 'HTTP 测试' });
    const listed = await call('/api/requests');
    assert.equal(listed.body.requests.length, 1);
    assert.equal(listed.body.requests[0].status, 'pending');
    assert.equal(Object.hasOwn(listed.body.requests[0], 'flag'), false, '请求列表不得下处理凭证 flag');
    const decided = await call('/api/requests/decide', 'POST', { id: listed.body.requests[0].id, action: 'approve' });
    assert.equal(decided.status, 200);
    assert.equal(decided.body.request.status, 'approved');
    const invalid = await call('/api/requests/decide', 'POST', { id: 1, action: 'maybe' });
    assert.equal(invalid.status, 400);
    console.log('PASS allowAll whitelist switches and request console endpoints');
  } catch (error) { failures++; console.error('FAIL whitelist allowAll / request endpoints:', error.message); }
  finally { await new Promise((resolve) => server.close(resolve)); await h.close(); }
}
// ── 控制台入口的传输层防护：Host 头 + 令牌定长比较 + /api/authorize/read 鉴权 ──
// 这三条都是「审计发现 → 加固」的结果，钉住它们以防以后被无意改回去。
{
  const h = await bridgeHarness();
  const server = h.startConsoleServer();
  try {
    if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
    const port = server.address().port;
    const call = (path, method = 'GET', headers = {}, body) => new Promise((resolve, reject) => {
      const request = http.request(
        { host: '127.0.0.1', port, path, method, headers: { 'content-type': 'application/json', ...headers } },
        (response) => {
          let data = '';
          response.on('data', (chunk) => { data += chunk; });
          response.on('end', () => resolve({ status: response.statusCode, body: data }));
        },
      );
      request.on('error', reject);
      request.setTimeout(3000, () => request.destroy(new Error('request hung')));
      request.end(body === undefined ? undefined : JSON.stringify(body));
    });
    const admin = { 'x-console-token': 'fixture-console-token' };

    // ① DNS rebinding 硬化：非本机 Host 一律拒绝（即使带着正确的控制台令牌）。
    // 注意 Host 必须走 headers（Node 会用 options.host 覆盖它，那样测不到伪造 Host）。
    for (const host of ['evil.example.com:' + port, '127.0.0.1:1', 'localhost']) {
      const res = await call('/api/status', 'GET', { ...admin, host });
      assert.equal(res.status, 403, `Host=${host} 必须被拒绝，实际 HTTP ${res.status}`);
    }
    // 合法的三个 Host 都要放行（127.0.0.1 / localhost / [::1] 加实际端口）
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]) {
      const res = await call('/api/status', 'GET', { ...admin, host });
      assert.equal(res.status, 200, `Host=${host} 应被接受，实际 HTTP ${res.status}`);
    }

    // ② 令牌比较必须是定长：错长度/错内容的令牌都不得通过（不能因为"前缀对"就放行）。
    // 注意 Node 的 HTTP 客户端会自动裁掉自定义头的首尾空白，所以"带尾空格"这一类
    // 必须用 ?token= 传（控制台本来就接受这种入口，它才是真实的攻击面）。
    for (const token of ['fixture-console-token-x', 'fixture-console-toke', 'FIXTURE-CONSOLE-TOKEN', 'fixture-console-token ']) {
      const res = await call(`/api/status?token=${encodeURIComponent(token)}`, 'GET');
      assert.equal(res.status, 401, `令牌「${token}」不得通过鉴权，实际 HTTP ${res.status}`);
    }
    const noHeader = await call('/api/status', 'GET');
    assert.equal(noHeader.status, 401, '不带令牌必须被拒绝');

    // ③ /api/authorize/read 不再接受空令牌（它曾对 agent 流量开放 ⇒ 成为免鉴权入口）。
    const noToken = await call('/api/authorize/read', 'POST', { ...admin, 'x-agent-token': 'x' }, { key: 'group:456' });
    assert.equal(noToken.status, 403, '空会话令牌必须被拒绝');
    console.log('PASS console rejects foreign Host headers, non-exact tokens and token-less authorize/read');
  } catch (error) { failures++; console.error('FAIL console transport guards:', error.message); }
  finally { await new Promise((resolve) => server.close(resolve)); await h.close(); }
}

await test('控制台可查看并保存 DSH / SnowLuma 连接配置（密钥只回显掩码）', async (h) => {
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;
  const call = (path, method = 'GET', body) => new Promise((resolve, reject) => {
    const request = http.request(
      { host: '127.0.0.1', port, path, method, headers: { 'content-type': 'application/json', 'x-console-token': 'fixture-console-token' } },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed = {};
          try { parsed = JSON.parse(text || '{}'); } catch {}
          resolve({ status: response.statusCode, body: parsed, text });
        });
      }
    );
    request.on('error', reject);
    request.setTimeout(3000, () => request.destroy(new Error('request hung')));
    request.end(body === undefined ? undefined : JSON.stringify(body));
  });
  try {
    const got = await call('/api/connection');
    assert.equal(got.status, 200, got.text);
    assert.equal(got.body.dsh.host, '127.0.0.1');
    assert.equal(got.body.dsh.port, 3080);
    assert.equal(got.body.dsh.tokenSet, true);
    assert.ok(!got.text.includes('fixture-only'), 'GET 不得回显完整 DSH 令牌');
    assert.match(got.body.dsh.tokenPreview, /^fixt…only$/);

    const revealed = await call('/api/connection/secret?name=dsh');
    assert.equal(revealed.status, 200);
    assert.equal(revealed.body.value, 'fixture-only', '显式请求才能拿到完整令牌');

    const bad = await call('/api/connection', 'POST', { dsh: { scheme: 'http', host: 'http://evil/x', port: 3080 } });
    assert.equal(bad.status, 400, '主机里不允许带协议/路径');

    const saved = await call('/api/connection', 'POST', {
      dsh: { scheme: 'https', host: 'dsh.example', port: 443, authToken: 'new-dsh-key', allowRemote: true },
      snowluma: {
        http: { scheme: 'http', host: '10.0.0.5', port: 3100 },
        ws: { scheme: 'ws', host: '10.0.0.5', port: 3101 },
        accessToken: 'new-sl-key',
        followDiscoveredEndpoint: false,
      },
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.restartRequired, false, '热重载不应该要求重启');
    assert.equal(saved.body.applied?.dsh, true);
    assert.equal(saved.body.applied?.snowluma, true);
    assert.equal(h.cfg.dsh.baseUrl, 'https://dsh.example:443', '运行中的 DSH 地址应已热更新');
    assert.equal(h.cfg.dsh.authToken, 'new-dsh-key');
    assert.equal(h.api.baseUrl, 'https://dsh.example:443', 'api 客户端应切到新地址');
    assert.equal(h.api.launchToken, 'new-dsh-key', 'api 客户端应使用新令牌');
    assert.equal(h.cfg.snowluma.httpUrl, 'http://10.0.0.5:3100');
    assert.equal(h.cfg.snowluma.wsUrl, 'ws://10.0.0.5:3101');
    assert.equal(h.cfg.snowluma.accessToken, 'new-sl-key');
    const file = JSON.parse((await import('node:fs')).readFileSync(`${h.temp}/config.json`, 'utf8'));
    assert.equal(file.dsh.baseUrl, 'https://dsh.example:443');
    assert.equal(file.dsh.authToken, 'new-dsh-key');
    assert.equal(file.dsh.allowRemote, true);
    assert.equal(file.snowluma.httpUrl, 'http://10.0.0.5:3100');
    assert.equal(file.snowluma.wsUrl, 'ws://10.0.0.5:3101');
    assert.equal(file.snowluma.accessToken, 'new-sl-key');
    assert.equal(file.snowluma.followDiscoveredEndpoint, false);
    assert.equal(file.consoleToken, 'fixture-console-token', '其它配置必须原样保留');

    const noop = await call('/api/connection', 'POST', {
      dsh: { scheme: 'https', host: 'dsh.example', port: 443, authToken: 'new-dsh-key', allowRemote: true },
      snowluma: {
        http: { scheme: 'http', host: '10.0.0.5', port: 3100 },
        ws: { scheme: 'ws', host: '10.0.0.5', port: 3101 },
        accessToken: 'new-sl-key',
        followDiscoveredEndpoint: false,
      },
    });
    assert.deepEqual(noop.body.changed, [], '相同配置不应产生新的变更');
    assert.equal(noop.body.restartRequired, false, '热重载后再次保存不应要求重启');

    const afterSave = await call('/api/connection');
    assert.equal(afterSave.body.pendingRestart, undefined, '热重载后不应再有待重启状态');
    assert.equal(afterSave.body.dsh.host, 'dsh.example', '保存后应立即返回新地址');
    assert.equal(afterSave.body.hotReload, true);
    assert.ok(!afterSave.text.includes('new-dsh-key'), 'GET 仍不得回显完整令牌');
    const revealedNew = await call('/api/connection/secret?name=dsh');
    assert.equal(revealedNew.body.value, 'new-dsh-key', '显示当前值应返回新令牌');

    // 热重载的接线：mux 必须带可中止的 signal，保存时要主动 abort/唤醒退避。
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('../src/bridge.js', import.meta.url), 'utf8');
    assert.match(source, /api\.events\.mux\(\{\}, controller\.signal\)/, 'mux 必须接受热重载中止信号');
    assert.match(source, /muxRestart\?\.abort\(\)/, '保存后必须中止旧事件流');
    assert.match(source, /muxWakeSleep\?\.\(\)/, '保存后必须唤醒重连退避');
    assert.match(source, /bot\.close\(1000, 'config-reload'\)/, 'SnowLuma 必须主动重连');
    assert.match(source, /skipHealAfterConfigReload/, '热重载后的主动断开不得触发 token 自愈覆盖用户配置');
    console.log('PASS console can read/save DSH and SnowLuma connection config with masked secrets');
  } catch (error) { failures++; console.error('FAIL connection config:', error.message); }
  finally { await new Promise((resolve) => server.close(resolve)); await h.close(); }
});

if (failures) process.exitCode = 1;
