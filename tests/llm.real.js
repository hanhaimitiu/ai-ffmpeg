'use strict';

/**
 * 真实本地大模型（llama.cpp / Ollama）验证：
 * 流级操作（选音轨/分流）+ 多文件协同（各自操作/合并）+ 多步骤。
 * 服务未启动时自动跳过。
 */

const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const ffmpeg = require('../main/ffmpeg');
const { runAgentGraph } = require('../main/agent/graph');

const BASE_URL = process.env.LLM_BASE || 'http://localhost:8080/v1';
const WORK = path.join(__dirname, '.real');
let pass = 0;
let fail = 0;

function ok(cond, desc, extra) {
  if (cond) { pass++; console.log(`  ✓ ${desc}`); }
  else { fail++; console.log(`  ✗ ${desc}${extra ? '\n    ' + extra : ''}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function serverUp() {
  try {
    const resp = await fetch(`${BASE_URL}/models`, { signal: AbortSignal.timeout(4000) });
    if (!resp.ok) return null;
    const data = await resp.json();
    const id = data.models?.[0]?.model || data.data?.[0]?.id;
    return id || 'llama';
  } catch { return null; }
}

async function main() {
  const MODEL = await serverUp();
  if (!MODEL) { console.log('本地大模型服务不可用，跳过真实验证'); process.exit(0); }
  console.log(`本地大模型服务可用：${BASE_URL}（模型: ${MODEL}）\n`);
  const cfg = { baseURL: BASE_URL, model: MODEL, apiKey: '' };

  const binRes = await ffmpeg.resolveBinaries({});
  if (!binRes.ok) { console.log('ffmpeg 不可用，跳过'); process.exit(0); }
  fs.mkdirSync(WORK, { recursive: true });

  // 测试视频A：6s 单音轨
  const videoA = path.join(WORK, 'a.mp4');
  if (!fs.existsSync(videoA)) {
    execFileSync(binRes.ffmpeg, [
      '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24:duration=6',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
      '-shortest', '-y', videoA,
    ], { stdio: 'ignore' });
  }
  // 测试视频B：5s 双音轨（440Hz 中文轨 + 880Hz 英文轨）
  const videoB = path.join(WORK, 'dual.mp4');
  if (!fs.existsSync(videoB)) {
    execFileSync(binRes.ffmpeg, [
      '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24:duration=5',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=5',
      '-f', 'lavfi', '-i', 'sine=frequency=880:duration=5',
      '-map', '0:v', '-map', '1:a', '-map', '2:a',
      '-metadata:s:a:0', 'language=chi', '-metadata:s:a:1', 'language=eng',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
      '-shortest', '-y', videoB,
    ], { stdio: 'ignore' });
  }

  const probeA = await ffmpeg.probeMedia(binRes.ffprobe, videoA);
  const probeB = await ffmpeg.probeMedia(binRes.ffprobe, videoB);
  const files = [
    { path: videoA, name: 'a.mp4', info: ffmpeg.summarizeInfo(probeA.info) },
    { path: videoB, name: 'dual.mp4', info: ffmpeg.summarizeInfo(probeB.info) },
  ];
  ok(files[1].info.streams.filter((s) => s.type === 'audio').length === 2, '双音轨视频就绪（流列表可见）');

  // ---- 用例 ----
  const cases = [
    ['把视频转成mp4并压缩', [files[0]], (r) => r.kind === 'operation' && r.tasks[0].args.includes('-crf')],
    ['这个视频有多长', [files[0]], (r) => r.kind === 'inspect'],
    ['把视频倒放', [files[0]], (r) => r.kind === 'operation' && r.tasks[0].args.some((x) => String(x).includes('reverse'))],
    // 流级操作
    ['提取英文那条音轨保存为m4a', [files[1]], (r) => r.kind === 'operation'
      && r.tasks[0].args.some((x) => x === '0:a:1'), 'LLM 需读懂双音轨选择 track=1'],
    ['音视频分流', [files[1]], (r) => r.kind === 'operation' && r.tasks.length === 2
      && r.tasks.some((t) => t.title.includes('纯视频')) && r.tasks.some((t) => t.title.includes('纯音频'))],
    // 多文件协同
    ['把这两个视频合并成一个', files, (r) => r.kind === 'operation' && r.tasks.length === 1
      && r.tasks[0].args.includes('-filter_complex')],
    ['第一个文件提取音频，第二个转480p', files, (r) => r.kind === 'operation' && r.tasks.length === 2
      && r.tasks[0].output.endsWith('.mp3') && r.tasks[1].args.includes('scale=480:-2'), '需返回 per-file plans'],
  ];

  const checkPred = (desc, r, pred, extra) => {
    if (pred(r)) { pass++; console.log(`  ✓ ${desc}`); }
    else {
      fail++;
      console.log(`  ✗ ${desc}${extra ? '（' + extra + '）' : ''}\n    实际: kind=${r.kind} tasks=${JSON.stringify((r.tasks || []).map((t) => ({ t: t.title, a: t.args.slice(0, 8) })))}`.slice(0, 400));
    }
  };

  for (const [text, fs_, pred, extra] of cases) {
    try {
      const r = await runAgentGraph({ text, files: fs_, llmConfig: cfg });
      checkPred(`「${text}」`, r, pred, extra);
    } catch (e) {
      fail++; console.log(`  ✗ 「${text}」异常: ${e.message}`);
    }
    await sleep(300);
  }

  // ---- 真实执行：选音轨 + 分流 + 合并 ----
  const pick = async (text, fs_) => runAgentGraph({ text, files: fs_, llmConfig: cfg });

  let r = await pick('提取英文那条音轨保存为m4a', [files[1]]);
  if (r.kind === 'operation') {
    const res = await ffmpeg.runFFmpeg({ bin: binRes.ffmpeg, args: r.tasks[0].args, duration: 5 }).promise;
    ok(res.ok && fs.existsSync(r.tasks[0].output), '选音轨真实执行成功');
  }

  r = await pick('音视频分流', [files[1]]);
  if (r.kind === 'operation' && r.tasks.length === 2) {
    for (const t of r.tasks) {
      await ffmpeg.runFFmpeg({ bin: binRes.ffmpeg, args: t.args, duration: 5 }).promise;
    }
    const pv = ffmpeg.summarizeInfo((await ffmpeg.probeMedia(binRes.ffprobe, r.tasks[0].output)).info);
    const pa = ffmpeg.summarizeInfo((await ffmpeg.probeMedia(binRes.ffprobe, r.tasks[1].output)).info);
    ok(pv.video.hasVideo && !pv.audio.hasAudio, '分流产物：纯视频');
    ok(!pa.video.hasVideo && pa.audio.hasAudio, '分流产物：纯音频');
  }

  r = await pick('把这两个视频合并成一个', files);
  if (r.kind === 'operation') {
    const res = await ffmpeg.runFFmpeg({ bin: binRes.ffmpeg, args: r.tasks[0].args, duration: 11 }).promise;
    if (res.ok) {
      const s = ffmpeg.summarizeInfo((await ffmpeg.probeMedia(binRes.ffprobe, r.tasks[0].output)).info);
      ok(Math.abs(s.duration - 11) < 1.5, `合并产物时长≈11s（实际 ${s.duration.toFixed(2)}s）`);
    } else {
      ok(false, '合并真实执行成功', res.error || '');
    }
  }

  console.log(`\n真实大模型验证: ${pass} 通过, ${fail} 失败`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('异常:', e); process.exit(1); });
