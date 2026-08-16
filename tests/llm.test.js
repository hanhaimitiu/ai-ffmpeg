'use strict';

/**
 * Agent 链路测试（纯 LLM 模式）：本地 mock OpenAI 兼容服务，验证
 * 配置 → 调用 → JSON 校验 → 空操作重试 → 命令构建 全流程。
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
        const attempt = /上一次解析结果无效/.test(userMsg) ? 2 : 1;
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Connection', 'close');
        res.end(JSON.stringify({
          choices: [{ message: { content: replyFn(userMsg, attempt, parsed.messages) } }],
          echo_messages: parsed.messages,
        }));
      });
    });
    s.listen(port, () => resolve(s));
  });
}

async function main() {
  const media = { duration: 120, video: { width: 1920, height: 1080 }, audio: { hasAudio: true } };
  const cfg = (port) => ({ baseURL: `http://127.0.0.1:${port}/v1`, model: 'mock', apiKey: 'k' });

  // ---- 服务1：正常 + 多步骤 ----
  const s1 = await mockServer((msg, attempt) => {
    if (/连通性|测试/.test(msg)) return 'OK';
    if (/多长/.test(msg)) return JSON.stringify({ type: 'inspect' });
    if (/写诗|写首诗|作诗/.test(msg)) return JSON.stringify({ type: 'unknown', message: '超出能力范围', suggestions: ['转成 mp4', '压缩视频'] });
    if (/三步/.test(msg)) return JSON.stringify({ type: 'operation', actions: [{ op: 'trim', start: 0, end: 30 }, { op: 'resolution', width: 1280 }, { op: 'compress', crf: 26 }] });
    return '```json\n{"type":"operation","actions":[{"op":"trim","start":10,"end":30},{"op":"extractAudio","targetFormat":"mp3"}]}\n```';
  }, 18123);

  let r = await planFromText('截取10到30秒，提取音频', media, cfg(18123));
  check('多步骤解析（trim+extractAudio）', r.source === 'llm' && r.plan.actions.length === 2 && r.plan.actions[0].start === 10 && r.plan.actions[1].targetFormat === 'mp3', JSON.stringify(r.plan));
  let built = buildCommand({ input: 'C:/v/a.mp4', output: 'C:/v/a_out.mp4', actions: r.plan.actions, media });
  check('命令可构建且含 -t', built.args.includes('-t') && built.args.includes('20'));

  r = await planFromText('这个视频有多长', media, cfg(18123));
  check('inspect 指令', r.plan.type === 'inspect' && r.source === 'llm');

  r = await planFromText('帮我写首诗', media, cfg(18123));
  check('unknown 指令带建议', r.plan.type === 'unknown' && r.plan.suggestions.length === 2, JSON.stringify(r.plan));

  r = await planFromText('三步：裁剪30秒、720p、压缩', media, cfg(18123));
  check('三步全部解析', r.source === 'llm' && r.plan.actions.length === 3 && r.plan.actions.map(a => a.op).join(',') === 'trim,resolution,compress', JSON.stringify(r.plan.actions));

  const ok = await callLLM({ config: cfg(18123), system: '你只回复OK', user: '测试' });
  check('callLLM 连通', ok === 'OK', ok);

  // ---- 服务2：首次返回空操作/缺参 → 应重试 ----
  let callCount = 0;
  const s2 = await mockServer((msg) => {
    callCount++;
    if (callCount === 1) return JSON.stringify({ type: 'operation', actions: [{ op: 'trim' }] }); // 无参数
    return JSON.stringify({ type: 'operation', actions: [{ op: 'trim', start: 0, end: 30 }, { op: 'gif' }] });
  }, 18124);
  r = await planFromText('截取30秒转gif', media, cfg(18124));
  check('空操作触发重试', r.source === 'llm' && r.plan.actions.length === 2 && callCount === 2, `调用次数=${callCount} ${JSON.stringify(r.plan.actions)}`);

  // ---- 服务3：非法 op 被过滤 ----
  const s3 = await mockServer(() => JSON.stringify({ type: 'operation', actions: [{ op: 'explode', x: 1 }, { op: 'fps', fps: 30 }] }), 18125);
  r = await planFromText('whatever', media, cfg(18125));
  check('非法 op 过滤', r.plan.actions.length === 1 && r.plan.actions[0].op === 'fps', JSON.stringify(r.plan.actions));

  // ---- 服务4：乱码 → 报错而非静默 ----
  const s4 = await mockServer(() => 'not json at all', 18126);
  r = await planFromText('把这个视频转成mp4', media, cfg(18126));
  check('乱码返回明确报错', r.source === 'error' && r.plan.type === 'error', JSON.stringify(r.plan));

  // ---- 服务5：服务挂掉 → 明确报错 ----
  r = await planFromText('把视频静音', media, { baseURL: 'http://127.0.0.1:18999/v1', model: 'x', apiKey: 'x' });
  check('LLM不可用明确报错', r.source === 'error' && r.plan.type === 'error', JSON.stringify(r.plan));

  // ---- 未配置 LLM → 明确提示配置 ----
  r = await planFromText('把视频静音', media, null);
  check('未配置LLM提示设置', r.source === 'error' && r.plan.type === 'unknown' && /设置/.test(r.plan.message), JSON.stringify(r.plan).slice(0, 120));

  // ---- 多轮对话：历史作为上下文发送 ----
  let seenMsgs = null;
  const s5 = await mockServer((msg, attempt, messages) => {
    seenMsgs = messages;
    return JSON.stringify({ type: 'operation', actions: [{ op: 'compress', crf: 32 }] });
  }, 18127);
  const hist = [
    { role: 'user', content: '帮我压缩这个视频' },
    { role: 'assistant', content: '✅ a.mp4：compress（crf=28）' },
  ];
  r = await planFromText('再压缩一点', media, cfg(18127), undefined, hist);
  check('多轮：历史随请求发送', Array.isArray(seenMsgs) && seenMsgs.length === 4
    && seenMsgs[1].content === '帮我压缩这个视频' && seenMsgs[2].role === 'assistant'
    && seenMsgs[3].content === '再压缩一点', JSON.stringify(seenMsgs && seenMsgs.map((m) => m.role)));
  check('多轮：结合上下文解析成功', r.source === 'llm' && r.plan.actions[0].crf === 32);

  // 无历史时消息结构不变
  seenMsgs = null;
  await planFromText('直接压缩', media, cfg(18127));
  check('无历史时仅 system+user', seenMsgs && seenMsgs.length === 2, JSON.stringify(seenMsgs && seenMsgs.map((m) => m.role)));

  // 历史上限 6 条
  const longHist = Array.from({ length: 12 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `msg${i}` }));
  seenMsgs = null;
  await planFromText('hi', media, cfg(18127), undefined, longHist);
  check('历史截断为最近6条', seenMsgs && seenMsgs.length === 8, `实际 ${seenMsgs && seenMsgs.length}`);

  for (const s of [s1, s2, s3, s4, s5]) if (s.closeAllConnections) s.closeAllConnections();
  s1.close(); s2.close(); s3.close(); s4.close(); s5.close();
  console.log(`\nAgent 链路测试: ${pass} 通过, ${fail} 失败`);
  setTimeout(() => process.exit(fail ? 1 : 0), 150);
}

main().catch((e) => { console.error('测试异常:', e); process.exit(1); });
