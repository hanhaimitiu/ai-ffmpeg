'use strict';

/**
 * 真实 llama.cpp 多轮对话验证：
 * 1) 第一轮「压缩」→ 记录 crf
 * 2) 第二轮带历史「再压缩一点」→ crf 应变化（理解指代）
 * 3) 第二轮「转成mp3」带无关历史 → 正常解析
 */

const { planFromText } = require('../main/agent/agent');

const CFG = { baseURL: process.env.LLM_BASE || 'http://localhost:8080/v1', model: process.env.LLM_MODEL || 'Qwen3.5-4B-Q4_K_M.gguf' };
const media = { duration: 120, size: 52428800, bitRate: 3500000, formatName: 'mov', video: { codec: 'h264', width: 1920, height: 1080, fps: 30, hasVideo: true }, audio: { codec: 'aac', channels: 2, hasAudio: true } };

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
  const r1 = await planFromText('把视频压缩一下', media, CFG);
  check('第一轮解析为 compress', r1.plan.type === 'operation' && r1.plan.actions.some((a) => a.op === 'compress'), JSON.stringify(r1.plan.actions || r1.plan.message));
  const crf1 = r1.plan.actions ? (r1.plan.actions.find((a) => a.op === 'compress') || {}).crf : null;
  console.log(`  → crf = ${crf1}`);
  await sleep(500);

  // ---- 第二轮：带历史「再压缩一点」 ----
  const hist = [
    { role: 'user', content: '把视频压缩一下' },
    { role: 'assistant', content: `✅ demo.mov：compress（crf=${crf1}），输出 demo_out.mov` },
  ];
  console.log('— 第 2 轮（带历史）：再压缩一点 —');
  const r2 = await planFromText('再压缩一点', media, CFG, undefined, hist);
  check('第二轮仍解析为 compress', r2.plan.type === 'operation' && r2.plan.actions.some((a) => a.op === 'compress'), JSON.stringify(r2.plan.actions || r2.plan.message));
  const crf2 = r2.plan.actions ? (r2.plan.actions.find((a) => a.op === 'compress') || {}).crf : null;
  console.log(`  → crf = ${crf2}（第一轮 ${crf1}）`);
  check('crf 相比第一轮变化（理解"再…一点"）', crf2 != null && crf1 != null && crf2 !== crf1, `crf1=${crf1} crf2=${crf2}`);
  await sleep(500);

  // ---- 第三轮：历史里是压缩，本轮换成新任务 ----
  console.log('— 第 3 轮（带历史）：提取音频为 mp3 —');
  const r3 = await planFromText('提取音频为mp3', media, CFG, undefined, hist);
  check('新任务不被历史带偏', r3.plan.type === 'operation' && r3.plan.actions.some((a) => a.op === 'extractAudio' && a.targetFormat === 'mp3'), JSON.stringify(r3.plan.actions || r3.plan.message));
  const ea = r3.plan.actions && r3.plan.actions.find((a) => a.op === 'extractAudio');
  console.log(`  → targetFormat = ${ea && ea.targetFormat}`);

  console.log(`\n真实多轮对话测试: ${pass} 通过, ${fail} 失败`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('异常:', e.message); process.exit(1); });
