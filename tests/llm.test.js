'use strict';

/**
 * LLM Agent 链路测试：本地 mock OpenAI 兼容服务，验证
 * 配置 → 调用 → JSON 校验 → 命令构建 全流程（无需真实 API Key）。
 */

const http = require('http');
const { planFromText } = require('../main/agent/agent');
const { buildCommand } = require('../main/agent/executor');
const { callLLM } = require('../main/agent/llm');

let pass = 0;
let fail = 0;
function check(desc, cond, extra) {
  if (cond) { pass++; console.log(`  ✓ ${desc}`); }
  else { fail++; console.log(`  ✗ ${desc}${extra ? '\n    ' + extra : ''}`); }
}

function mockServer(replyFn, port) {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        let parsed = {};
        try { parsed = JSON.parse(body); } catch {}
        const userMsg = parsed.messages && parsed.messages[1] && parsed.messages[1].content;
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Connection', 'close'); // 避免 undici 连接池在退出时残留
        res.end(JSON.stringify({ choices: [{ message: { content: replyFn(userMsg, parsed) } }] }));
      });
    });
    s.listen(port, () => resolve(s));
  });
}

async function main() {
  const media = { duration: 120, video: { width: 1920, height: 1080 }, audio: { hasAudio: true } };
  const cfg = (port) => ({ baseURL: `http://127.0.0.1:${port}/v1`, model: 'mock', apiKey: 'k' });

  // ---- 服务1：正常响应 ----
  const s1 = await mockServer((msg) => {
    if (/连通性|测试/.test(msg)) return 'OK';
    if (/压缩/.test(msg)) return JSON.stringify({ type: 'operation', actions: [{ op: 'convert', targetFormat: 'mp4' }, { op: 'compress', crf: 30 }] });
    if (/多长/.test(msg)) return JSON.stringify({ type: 'inspect' });
    if (/写诗|写首诗|作诗/.test(msg)) return JSON.stringify({ type: 'unknown', message: '超出能力范围', suggestions: ['转成 mp4', '压缩视频'] });
    return '```json\n{"type":"operation","actions":[{"op":"trim","start":10,"end":30},{"op":"extractAudio","targetFormat":"mp3"}]}\n```';
  }, 18123);

  let r = await planFromText('把视频压缩一下', media, cfg(18123));
  check('LLM解析操作', r.source === 'llm' && r.plan.actions.length === 2 && r.plan.actions[1].crf === 30, JSON.stringify(r.plan));
  let built = buildCommand({ input: 'C:/v/a.mp4', output: 'C:/v/a_out.mp4', actions: r.plan.actions, media });
  check('LLM结果可构建命令', built.args.includes('-crf') && built.args.includes('30'));

  r = await planFromText('这个视频有多长', media, cfg(18123));
  check('LLM解析inspect', r.plan.type === 'inspect' && r.source === 'llm');

  r = await planFromText('帮我写首诗', media, cfg(18123));
  check('LLM解析unknown', r.plan.type === 'unknown' && r.plan.suggestions.length === 2, JSON.stringify(r.plan));

  r = await planFromText('截取10到30秒，提取音频', media, cfg(18123));
  check('代码块JSON可解析', r.source === 'llm' && r.plan.actions[0].start === 10 && r.plan.actions[1].targetFormat === 'mp3', JSON.stringify(r.plan));

  // 连通测试
  const ok = await callLLM({ config: cfg(18123), system: '你只回复OK', user: '测试' });
  check('callLLM 返回内容', ok === 'OK', ok);

  // ---- 服务2：返回非法操作 / 乱码 ----
  const s2 = await mockServer(() => JSON.stringify({ type: 'operation', actions: [{ op: 'explode', x: 1 }, { op: 'fps', fps: 30 }] }), 18124);
  r = await planFromText('whatever', media, cfg(18124));
  check('非法action被过滤', r.plan.actions.length === 1 && r.plan.actions[0].op === 'fps', JSON.stringify(r.plan.actions));

  // ---- 服务3：返回乱码 → 回退本地解析 ----
  const s3 = await mockServer(() => 'not json at all', 18125);
  r = await planFromText('把这个视频转成mp4', media, cfg(18125));
  check('LLM乱码回退本地解析', r.source === 'rules' && r.plan.type === 'operation' && r.plan.actions[0].op === 'convert');

  // ---- 服务4：服务挂了 → 回退本地解析 ----
  r = await planFromText('把视频静音', media, { baseURL: 'http://127.0.0.1:18999/v1', model: 'x', apiKey: 'x' });
  check('LLM不可用回退本地解析', r.source === 'rules' && r.plan.actions[0].op === 'mute');

  // 先断开 keep-alive 连接再关闭服务，避免 Windows 下 libuv 退出断言噪音
  for (const s of [s1, s2, s3]) if (s.closeAllConnections) s.closeAllConnections();
  s1.close(); s2.close(); s3.close();
  console.log(`\nLLM Agent 链路测试: ${pass} 通过, ${fail} 失败`);
  setTimeout(() => process.exit(fail ? 1 : 0), 150);
}

main().catch((e) => { console.error('测试异常:', e); process.exit(1); });
