'use strict';

/**
 * 真实 llama.cpp 多轮对话验证：
 * 1) 第一轮「压缩」→ 记录 crf
 * 2) 第二轮带历史「再压缩一点」→ crf 应变化（理解指代）
 * 3) 新指令不被历史带偏
 */

const { runAgentGraph } = require('../main/agent/graph');

const CFG = { baseURL: process.env.LLM_BASE || 'http://localhost:8080/v1', model: process.env.LLM_MODEL || 'Qwen3.5-4B-Q4_K_M.gguf', apiKey: '' };
const media = { duration: 120, size: 52428800, bitRate: 3500000, formatName: 'mov', streams: [
  { index: 0, type: 'video', codec: 'h264', width: 1920, height: 1080, videoIndex: 0 },
  { index: 1, type: 'audio', codec: 'aac', audioIndex: 0, language: 'zh' },
], video: { hasVideo: true }, audio: { hasAudio: true } };
const FILES = [{ path: 'C:/v/demo.mov', name: 'demo.mov', info: media }];

let pass = 0, fail = 0;
function check(desc, cond, extra) {
  if (cond) { pass++; console.log(`  ✓ ${desc}`); }
  else { fail++; console.log(`  ✗ ${desc}${extra ? '\n    ' + extra : ''}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log(`模型: ${CFG.model} @ ${CFG.baseURL}\n`);

  // ---- 第一轮：压缩 ----
  console.log('— 第 1 轮：把视频压缩一下 —');
  const r1 = await runAgentGraph({ text: '把视频压缩一下', files: FILES, llmConfig: CFG });
  const crf1 = r1.kind === 'operation' && r1.tasks[0]
    ? (r1.tasks[0].args[r1.tasks[0].args.indexOf('-crf') + 1] || r1.tasks[0].args.find((x, i) => r1.tasks[0].args[i - 1] === '-crf'))
    : null;
  check('第一轮解析为 compress', r1.kind === 'operation' && crf1 != null, JSON.stringify(r1.tasks && r1.tasks.map((t) => t.title)));
  console.log(`  → crf = ${crf1}`);
  await sleep(500);

  // ---- 第二轮：带历史「再压缩一点」 ----
  const hist = [
    { role: 'user', content: '把视频压缩一下' },
    { role: 'assistant', content: `✅ demo.mov：compress（crf=${crf1}），输出 demo_out.mov` },
  ];
  console.log('— 第 2 轮（带历史）：再压缩一点 —');
  const r2 = await runAgentGraph({ text: '再压缩一点', files: FILES, llmConfig: CFG, history: hist });
  const crf2 = r2.kind === 'operation' && r2.tasks[0]
    ? r2.tasks[0].args[r2.tasks[0].args.indexOf('-crf') + 1]
    : null;
  check('第二轮仍解析为 compress', r2.kind === 'operation' && crf2 != null, JSON.stringify(r2.tasks && r2.tasks.map((t) => t.title)));
  console.log(`  → crf = ${crf2}（第一轮 ${crf1}）`);
  check('crf 相比第一轮变化（理解"再…一点"）', crf2 != null && crf1 != null && Number(crf2) !== Number(crf1), `crf1=${crf1} crf2=${crf2}`);
  await sleep(500);

  // ---- 第三轮：历史里是压缩，本轮换成新任务 ----
  console.log('— 第 3 轮（带历史）：提取音频为 mp3 —');
  const r3 = await runAgentGraph({ text: '提取音频为mp3', files: FILES, llmConfig: CFG, history: hist });
  check('新任务不被历史带偏', r3.kind === 'operation' && r3.tasks[0].output.endsWith('.mp3'), JSON.stringify(r3.tasks && r3.tasks.map((t) => t.output)));

  console.log(`\n真实多轮对话测试: ${pass} 通过, ${fail} 失败`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('异常:', e.message); process.exit(1); });
