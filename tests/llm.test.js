'use strict';

/**
 * Agent LangGraph 链路测试：本地 mock OpenAI 兼容服务，验证
 * 多文件规划 → 校验 → 重试 → 命令构建（分流/合并/选轨）全流程。
 */

const http = require('http');
const { runAgentGraph } = require('../main/agent/graph');
const { normalizeOperation, matchFile, validateAction } = require('../main/agent/agent');

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
        const msgs = parsed.messages || [];
        const userMsg = msgs.length ? msgs[msgs.length - 1].content : '';
        const isRetry = /上一次解析结果无效/.test(userMsg);
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Connection', 'close');
        res.end(JSON.stringify({
          choices: [{ message: { content: replyFn(userMsg, isRetry, msgs) } }],
          echo_messages: msgs,
        }));
      });
    });
    s.listen(port, () => resolve(s));
  });
}

const FILES = [
  { path: 'C:/v/a.mp4', name: 'a.mp4', info: { duration: 120, formatName: 'mov', streams: [
    { index: 0, type: 'video', codec: 'h264', width: 1920, height: 1080, videoIndex: 0 },
    { index: 1, type: 'audio', codec: 'aac', audioIndex: 0, language: 'zh' },
    { index: 2, type: 'audio', codec: 'aac', audioIndex: 1, language: 'en' },
  ] } },
  { path: 'C:/v/b.mp4', name: 'b.mp4', info: { duration: 80, formatName: 'mp4', streams: [
    { index: 0, type: 'video', codec: 'h264', width: 1280, height: 720, videoIndex: 0 },
    { index: 1, type: 'audio', codec: 'aac', audioIndex: 0 },
  ] } },
];

async function main() {
  const cfg = (port) => ({ baseURL: `http://127.0.0.1:${port}/v1`, model: 'mock', apiKey: 'k' });
  const base = (p) => String(p).split(/[\\/]/).pop();

  // ---- 纯函数：matchFile ----
  check('matchFile 序号', matchFile('[1]', FILES) === 1 && matchFile('0', FILES) === 0);
  check('matchFile 文件名', matchFile('a.mp4', FILES) === 0 && matchFile('b', FILES) === 1);
  check('matchFile 无法识别返回 -1', matchFile('nope.mp4', FILES) === -1);

  // ---- 纯函数：validateAction 流操作 ----
  check('selectAudioTrack 需 track', validateAction({ op: 'selectAudioTrack' }) === null && validateAction({ op: 'selectAudioTrack', track: 1 }).track === 1);
  check('track 负数非法', validateAction({ op: 'selectAudioTrack', track: -1 }) === null);
  check('extractAudio 可带 track', validateAction({ op: 'extractAudio', targetFormat: 'mp3', track: 1 }).track === 1);

  // ---- 纯函数：normalizeOperation ----
  let n = normalizeOperation({ type: 'operation', plans: [
    { file: 'a.mp4', actions: [{ op: 'extractAudio', targetFormat: 'mp3', track: 1 }] },
    { file: '[1]', actions: [{ op: 'resolution', width: 1280 }] },
  ] }, FILES);
  check('plans 按文件匹配', n.ok && n.filePlans.length === 2 && n.filePlans[0].fileIndex === 0 && n.filePlans[1].fileIndex === 1, JSON.stringify(n));
  n = normalizeOperation({ type: 'operation', actions: [{ op: 'compress', crf: 28 }] }, FILES);
  check('flat actions 复制到全部文件', n.ok && n.filePlans.length === FILES.length);
  n = normalizeOperation({ type: 'operation', concat: { files: ['a.mp4', 'b.mp4'] } }, FILES);
  check('concat 规范化', n.ok && n.concat && n.concat.fileIndexes.join() === '0,1');
  n = normalizeOperation({ type: 'operation', concat: { files: ['a.mp4', 'a.mp4'] } }, FILES);
  check('concat 重复文件被拒', !n.ok, JSON.stringify(n));
  n = normalizeOperation({ type: 'operation', plans: [{ file: 'ghost.mp4', actions: [{ op: 'mute' }] }] }, FILES);
  check('未知文件引用被拒', !n.ok);
  n = normalizeOperation({ type: 'operation', plans: [{ file: 'a.mp4', actions: [{ op: 'demux' }, { op: 'compress', crf: 28 }] }] }, FILES);
  check('demux 与其他操作组合被拒', !n.ok);

  // ---- 服务1：常规 + 多步骤 + 多文件 ----
  const s1 = await mockServer((msg, retry) => {
    if (retry) return JSON.stringify({ type: 'operation', actions: [{ op: 'trim', start: 0, end: 30 }, { op: 'gif' }] });
    if (/多长|哪些/.test(msg)) return JSON.stringify({ type: 'inspect' });
    if (/写诗|写首诗|作诗/.test(msg)) return JSON.stringify({ type: 'unknown', message: '超出能力范围', suggestions: ['转成 mp4', '压缩视频'] });
    if (/三步/.test(msg)) return JSON.stringify({ type: 'operation', actions: [{ op: 'trim', start: 0, end: 30 }, { op: 'resolution', width: 1280 }, { op: 'compress', crf: 26 }] });
    if (/不同操作/.test(msg)) return JSON.stringify({ type: 'operation', plans: [
      { file: 'a.mp4', actions: [{ op: 'extractAudio', targetFormat: 'mp3', track: 1 }] },
      { file: '[1]', actions: [{ op: 'resolution', width: 1280 }] },
    ] });
    if (/分流/.test(msg)) return JSON.stringify({ type: 'operation', plans: [{ file: 'a.mp4', actions: [{ op: 'demux' }] }] });
    if (/合并/.test(msg)) return JSON.stringify({ type: 'operation', concat: { files: ['a.mp4', 'b.mp4'] }, plans: [] });
    if (/英语|音轨/.test(msg)) return JSON.stringify({ type: 'operation', actions: [{ op: 'selectAudioTrack', track: 1 }] });
    return '```json\n{"type":"operation","actions":[{"op":"trim","start":10,"end":30},{"op":"extractAudio","targetFormat":"mp3"}]}\n```';
  }, 18123);

  let r = await runAgentGraph({ text: '截取10到30秒，提取音频', files: FILES, llmConfig: cfg(18123) });
  check('多步骤解析（trim+extractAudio）', r.kind === 'operation' && r.tasks.length === 2
    && r.tasks[0].args.includes('-t') && r.tasks[0].args.includes('20'), JSON.stringify(r.tasks.map((t) => t.args)));

  r = await runAgentGraph({ text: '这个视频有多长', files: FILES, llmConfig: cfg(18123) });
  check('inspect 指令', r.kind === 'inspect');

  r = await runAgentGraph({ text: '帮我写首诗', files: FILES, llmConfig: cfg(18123) });
  check('unknown 指令带建议', r.kind === 'unknown' && r.suggestions.length === 2);

  r = await runAgentGraph({ text: '三步：裁剪30秒、720p、压缩', files: FILES, llmConfig: cfg(18123) });
  check('三步全部解析且应用到两文件', r.kind === 'operation' && r.tasks.length === 2
    && r.tasks[0].title.split(' + ').length === 3, JSON.stringify(r.tasks.map((t) => t.title)));

  r = await runAgentGraph({ text: 'a提取音频b不同操作', files: FILES, llmConfig: cfg(18123) });
  check('多文件各自不同操作', r.kind === 'operation' && r.tasks.length === 2
    && r.tasks[0].args.includes('-map') && r.tasks[0].args.includes('0:a:1')
    && r.tasks[1].args.includes('scale=1280:-2'), JSON.stringify(r.tasks.map((t) => t.args)));

  r = await runAgentGraph({ text: '音视频分流', files: FILES, llmConfig: cfg(18123) });
  check('分流展开为纯视频+纯音频', r.kind === 'operation' && r.tasks.length === 2
    && base(r.tasks[0].output) === 'a_video.mp4' && base(r.tasks[1].output) === 'a_audio.m4a'
    && r.tasks[0].args.includes('-map') && r.tasks[1].args.includes('0:a:0'), JSON.stringify(r.tasks.map((t) => t.output)));

  r = await runAgentGraph({ text: '合并两个视频', files: FILES, llmConfig: cfg(18123) });
  check('合并生成 filter_complex 命令', r.kind === 'operation' && r.tasks.length === 1
    && r.tasks[0].args.includes('-filter_complex') && base(r.tasks[0].output) === 'a_merged.mp4'
    && r.tasks[0].args.filter((x) => x === '-i').length === 2, JSON.stringify(r.tasks[0] && r.tasks[0].args));

  r = await runAgentGraph({ text: '换成英语音轨', files: FILES, llmConfig: cfg(18123) });
  check('选音轨命令（可选视频+选轨+copy）', r.kind === 'operation'
    && r.tasks[0].args.includes('0:v:0?') && r.tasks[0].args.includes('0:a:1') && r.tasks[0].args.includes('-c'), JSON.stringify(r.tasks[0] && r.tasks[0].args));

  // ---- 多轮：历史作为上下文发送 ----
  let seenMsgs = null;
  const s5 = await mockServer((msg, retry, msgs) => {
    seenMsgs = msgs;
    return JSON.stringify({ type: 'operation', actions: [{ op: 'compress', crf: 32 }] });
  }, 18127);
  const hist = [
    { role: 'user', content: '帮我压缩这个视频' },
    { role: 'assistant', content: '✅ a.mp4：compress（crf=28）' },
  ];
  r = await runAgentGraph({ text: '再压缩一点', files: FILES, llmConfig: cfg(18127), history: hist });
  check('多轮：历史随请求发送', Array.isArray(seenMsgs) && seenMsgs.length === 4
    && seenMsgs[1].content === '帮我压缩这个视频' && seenMsgs[2].role === 'assistant'
    && seenMsgs[3].content === '再压缩一点', JSON.stringify(seenMsgs && seenMsgs.map((m) => m.role)));
  check('多轮：结合上下文解析成功', r.kind === 'operation' && r.tasks[0].args.includes('32'));

  seenMsgs = null;
  await runAgentGraph({ text: '直接压缩', files: FILES, llmConfig: cfg(18127) });
  check('无历史时仅 system+user', seenMsgs && seenMsgs.length === 2);

  // ---- 服务2：首次无效 → 重试 ----
  let callCount = 0;
  const s2 = await mockServer((msg, isRetry) => {
    callCount++;
    if (!isRetry) return JSON.stringify({ type: 'operation', actions: [{ op: 'trim' }] }); // 缺参数
    return JSON.stringify({ type: 'operation', actions: [{ op: 'trim', start: 0, end: 30 }, { op: 'gif' }] });
  }, 18124);
  r = await runAgentGraph({ text: '截取30秒转gif', files: FILES, llmConfig: cfg(18124) });
  check('无效计划自动带提示重试', r.kind === 'operation' && callCount === 2, `调用次数=${callCount}`);

  // ---- 服务3：两次都无效 → 明确报错 ----
  const s3 = await mockServer(() => JSON.stringify({ type: 'operation', actions: [{ op: 'explode', x: 1 }] }), 18125);
  r = await runAgentGraph({ text: 'whatever', files: FILES, llmConfig: cfg(18125) });
  check('重试耗尽明确报错', r.kind === 'error' && /无法执行/.test(r.message || ''), JSON.stringify(r));

  // ---- 服务4：乱码 → 报错 ----
  const s4 = await mockServer(() => 'not json at all', 18126);
  r = await runAgentGraph({ text: '把这个视频转成mp4', files: FILES, llmConfig: cfg(18126) });
  check('乱码返回明确报错', r.kind === 'error');

  // ---- 服务挂掉 ----
  r = await runAgentGraph({ text: '把视频静音', files: FILES, llmConfig: { baseURL: 'http://127.0.0.1:18999/v1', model: 'x', apiKey: 'x' } });
  check('LLM不可用明确报错', r.kind === 'error' && /调用失败/.test(r.message || ''), JSON.stringify(r));

  // ---- 未配置 ----
  r = await runAgentGraph({ text: '把视频静音', files: FILES, llmConfig: null });
  check('未配置LLM提示设置', r.kind === 'unknown' && /设置/.test(r.message || ''), JSON.stringify(r));

  for (const s of [s1, s2, s3, s4, s5]) if (s.closeAllConnections) s.closeAllConnections();
  s1.close(); s2.close(); s3.close(); s4.close(); s5.close();
  console.log(`\nAgent LangGraph 链路测试: ${pass} 通过, ${fail} 失败`);
  setTimeout(() => process.exit(fail ? 1 : 0), 150);
}

main().catch((e) => { console.error('测试异常:', e); process.exit(1); });
