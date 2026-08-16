'use strict';

/**
 * 真实本地大模型验证（llama.cpp / Ollama 等 OpenAI 兼容本地服务）。
 * 验证：自然语言 → 大模型结构化解析（含多步骤）→ 命令构建 → 真实 ffmpeg 执行。
 * 本地服务未启动时自动跳过（不失败）。
 */

const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const ffmpeg = require('../main/ffmpeg');
const { planFromText } = require('../main/agent/agent');
const { buildCommand, suggestOutputPath } = require('../main/agent/executor');

const BASE_URL = process.env.LLAMA_URL || 'http://localhost:8080/v1';
const MODEL = process.env.LLAMA_MODEL || 'llama';
const WORK = path.join(__dirname, '.real');

let pass = 0;
let fail = 0;
function check(desc, cond, extra) {
  if (cond) { pass++; console.log(`  ✓ ${desc}`); }
  else { fail++; console.log(`  ✗ ${desc}${extra ? '\n    ' + extra : ''}`); }
}

async function serviceUp() {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    const r = await fetch(`${BASE_URL}/models`, { signal: ctrl.signal });
    clearTimeout(t);
    return r.ok;
  } catch {
    return false;
  }
}

async function main() {
  if (!(await serviceUp())) {
    console.log(`⚠ 本地大模型服务不可用（${BASE_URL}），跳过真实模型验证`);
    console.log('   （此测试仅在 llama.cpp / Ollama 启动时运行）');
    process.exit(0);
  }
  console.log(`本地大模型服务可用：${BASE_URL}（模型: ${MODEL}）\n`);

  const binRes = await ffmpeg.resolveBinaries({});
  if (!binRes.ok) { console.log('ffmpeg 不可用，跳过'); process.exit(0); }

  fs.mkdirSync(WORK, { recursive: true });
  const testVideo = path.join(WORK, 'real_test.mp4');
  if (!fs.existsSync(testVideo)) {
    execFileSync(binRes.ffmpeg, [
      '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24:duration=6',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
      '-shortest', '-y', testVideo,
    ], { stdio: 'ignore' });
  }
  const probe = await ffmpeg.probeMedia(binRes.ffprobe, testVideo);
  const media = ffmpeg.summarizeInfo(probe.info);
  const cfg = { baseURL: BASE_URL, model: MODEL, apiKey: '' };

  const cases = [
    ['把视频转成mp4并压缩', (p) => p.type === 'operation' && p.actions.some((a) => a.op === 'convert') && p.actions.some((a) => a.op === 'compress')],
    ['截取从1秒到3秒，转成720p', (p) => p.type === 'operation' && p.actions.some((a) => a.op === 'trim') && p.actions.some((a) => a.op === 'resolution')],
    ['这个视频有多长', (p) => p.type === 'inspect'],
    ['提取音频', (p) => p.type === 'operation' && p.actions.some((a) => a.op === 'extractAudio')],
    ['生成封面图', (p) => p.type === 'operation' && p.actions.some((a) => a.op === 'thumbnail')],
    // 多步骤：三个动作必须全部解析
    ['转成mp4，截取前3秒，然后压缩', (p) => p.type === 'operation' && p.actions.length === 3 && ['convert', 'trim', 'compress'].every((op) => p.actions.some((a) => a.op === op)), '要求3个action完整返回'],
  ];

  for (const [text, pred, extra] of cases) {
    const r = await planFromText(text, media, cfg, () => {});
    check(`「${text}」`, pred(r.plan), `${extra || ''} 实际: ${JSON.stringify(r.plan).slice(0, 200)}`);
  }

  // 真实执行一条多步骤：截取 + 720p
  const r = await planFromText('截取从1秒到3秒，转成720p', media, cfg);
  if (r.source === 'llm' && r.plan.type === 'operation') {
    const out = path.join(WORK, 'real_trim720.mp4');
    const built = buildCommand({ input: testVideo, output: out, actions: r.plan.actions, media });
    const res = await ffmpeg.runFFmpeg({ bin: binRes.ffmpeg, args: built.args, duration: 2 }).promise;
    check('大模型计划真实执行成功', res.ok && fs.existsSync(out), res.error || '');
    if (res.ok) {
      const p2 = await ffmpeg.probeMedia(binRes.ffprobe, out);
      const s2 = ffmpeg.summarizeInfo(p2.info);
      check('产物时长约2s', Math.abs(s2.duration - 2) < 0.6, `实际 ${s2.duration.toFixed(2)}s`);
      check('产物为1280宽', s2.video.width === 1280, `实际 ${s2.video.width}`);
    }
  }

  console.log(`\n真实大模型验证: ${pass} 通过, ${fail} 失败`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('异常:', e); process.exit(1); });
