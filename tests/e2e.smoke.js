'use strict';

/**
 * 端到端冒烟测试：生成测试视频（含双音轨）→ 探测 → LangGraph Agent（mock LLM）
 * → 命令构建 → 真实 ffmpeg 执行（含音视频分流 / 选音轨 / 合并 / 多文件）。
 * 直接复用主进程模块（不依赖 Electron 窗口）。
 */

const path = require('path');
const fs = require('fs');
const http = require('http');
const { execFileSync } = require('child_process');

const ffmpeg = require('../main/ffmpeg');
const { runAgentGraph } = require('../main/agent/graph');

const WORK = path.join(__dirname, '.e2e');
let pass = 0;
let fail = 0;

function ok(cond, desc, extra) {
  if (cond) { pass++; console.log(`  ✓ ${desc}`); }
  else { fail++; console.log(`  ✗ ${desc}${extra ? '\n    ' + extra : ''}`); }
}

/** mock OpenAI 兼容服务：按指令返回计划 */
function startMockLLM(port) {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        let msg = '';
        try { const m = JSON.parse(body).messages; msg = m[m.length - 1].content; } catch {}
        let reply;
        if (/压缩/.test(msg)) reply = { type: 'operation', actions: [{ op: 'convert', targetFormat: 'mp4' }, { op: 'compress', crf: 28 }] };
        else if (/720p/.test(msg)) reply = { type: 'operation', actions: [{ op: 'trim', start: 1, end: 3 }, { op: 'resolution', width: 1280 }] };
        else if (/wav|音频/.test(msg)) reply = { type: 'operation', actions: [{ op: 'extractAudio', targetFormat: 'wav' }] };
        else if (/封面/.test(msg)) reply = { type: 'operation', actions: [{ op: 'thumbnail' }] };
        else if (/分流/.test(msg)) reply = { type: 'operation', plans: [{ file: 'dual.mp4', actions: [{ op: 'demux', track: 1 }] }] };
        else if (/音轨/.test(msg)) reply = { type: 'operation', actions: [{ op: 'selectAudioTrack', track: 1 }] };
        else if (/合并/.test(msg)) reply = { type: 'operation', concat: { files: ['test.mp4', 'dual.mp4'] }, plans: [] };
        else if (/各自/.test(msg)) reply = { type: 'operation', plans: [
          { file: 'test.mp4', actions: [{ op: 'extractAudio', targetFormat: 'mp3' }] },
          { file: 'dual.mp4', actions: [{ op: 'resolution', width: 640 }] },
        ] };
        else reply = { type: 'unknown', message: '无法理解', suggestions: [] };
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Connection', 'close');
        res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(reply) } }] }));
      });
    });
    s.listen(port, () => resolve(s));
  });
}

async function runTask(binRes, task, desc) {
  const r = await ffmpeg.runFFmpeg({ bin: binRes.ffmpeg, args: task.args, duration: task.duration }).promise;
  ok(r.ok, `${desc}（exit 0）`, r.error || '');
  return r;
}

async function main() {
  fs.mkdirSync(WORK, { recursive: true });
  const server = await startMockLLM(18190);
  const cfg = { baseURL: 'http://127.0.0.1:18190/v1', model: 'mock', apiKey: 'k' };

  // 1. 探测二进制
  const binRes = await ffmpeg.resolveBinaries({});
  ok(binRes.ok, '找到 ffmpeg 二进制', JSON.stringify(binRes).slice(0, 300));
  if (!binRes.ok) process.exit(1);
  console.log(`  → ${binRes.ffmpeg}`);

  // 2. 生成测试视频A（5 秒，1 音轨）
  const testVideo = path.join(WORK, 'test.mp4');
  execFileSync(binRes.ffmpeg, [
    '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24:duration=5',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=5',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
    '-shortest', '-y', testVideo,
  ], { stdio: 'ignore' });
  ok(fs.existsSync(testVideo), '生成测试视频A');

  // 3. 生成测试视频B（4 秒，双音轨：440Hz + 880Hz）
  const dualVideo = path.join(WORK, 'dual.mp4');
  execFileSync(binRes.ffmpeg, [
    '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24:duration=4',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4',
    '-f', 'lavfi', '-i', 'sine=frequency=880:duration=4',
    '-map', '0:v', '-map', '1:a', '-map', '2:a',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
    '-shortest', '-y', dualVideo,
  ], { stdio: 'ignore' });
  ok(fs.existsSync(dualVideo), '生成双音轨测试视频B');

  // 4. ffprobe 探测：流列表完整
  const probe = await ffmpeg.probeMedia(binRes.ffprobe, dualVideo);
  ok(probe.ok, 'ffprobe 读取媒体信息');
  const infoB = ffmpeg.summarizeInfo(probe.info);
  ok(Array.isArray(infoB.streams) && infoB.streams.length === 3, '流列表含 3 条流（1视频+2音频）', JSON.stringify(infoB.streams && infoB.streams.map((s) => s.type)));
  ok(infoB.streams.filter((s) => s.type === 'audio').every((s, i) => s.audioIndex === i), 'audioIndex 正确编号');

  const probeA = await ffmpeg.probeMedia(binRes.ffprobe, testVideo);
  const infoA = ffmpeg.summarizeInfo(probeA.info);
  const files = [
    { path: testVideo, name: 'test.mp4', info: infoA },
    { path: dualVideo, name: 'dual.mp4', info: infoB },
  ];

  // 5. 多步骤：压缩（convert + compress）
  const r1 = await runAgentGraph({ text: '把视频转成mp4并压缩', files, llmConfig: cfg });
  ok(r1.kind === 'operation' && r1.tasks.length === 2, '解析"转mp4并压缩"（应用到两文件）', JSON.stringify(r1));
  ok(r1.tasks[0].args.includes('-crf'), '压缩参数包含 crf', r1.tasks[0].display);
  const res1 = await runTask(binRes, r1.tasks[0], '压缩执行');
  ok(res1.ok && fs.existsSync(r1.tasks[0].output), '输出文件已生成');

  // 6. 分流（demux）：纯视频 + 指定第2条音轨的纯音频
  const r2 = await runAgentGraph({ text: '音视频分流', files, llmConfig: cfg });
  ok(r2.kind === 'operation' && r2.tasks.length === 2, '分流展开为两个任务', JSON.stringify(r2.tasks && r2.tasks.map((t) => t.title)));
  ok(r2.tasks[1].args.includes('0:a:1'), '分流音频选第2条音轨', r2.tasks[1].display);
  await runTask(binRes, r2.tasks[0], '分流-纯视频执行');
  await runTask(binRes, r2.tasks[1], '分流-纯音频执行');
  const pv = await ffmpeg.probeMedia(binRes.ffprobe, r2.tasks[0].output);
  const pa = await ffmpeg.probeMedia(binRes.ffprobe, r2.tasks[1].output);
  const sv = ffmpeg.summarizeInfo(pv.info);
  const sa = ffmpeg.summarizeInfo(pa.info);
  ok(sv.video.hasVideo && !sv.audio.hasAudio, '分流产物：纯视频文件无音轨', JSON.stringify({ v: sv.video.hasVideo, a: sv.audio.hasAudio }));
  ok(!sa.video.hasVideo && sa.audio.hasAudio, '分流产物：纯音频文件无视频', JSON.stringify({ v: sa.video.hasVideo, a: sa.audio.hasAudio }));

  // 7. 选音轨：输出保留视频 + 第2条音轨
  const r3 = await runAgentGraph({ text: '换成第二条音轨', files: [files[1]], llmConfig: cfg });
  ok(r3.kind === 'operation' && r3.tasks[0].args.includes('0:a:1') && r3.tasks[0].args.includes('-c'), '选轨命令（map + copy）', r3.tasks[0] && r3.tasks[0].display);
  await runTask(binRes, r3.tasks[0], '选音轨执行');
  const p3 = await ffmpeg.probeMedia(binRes.ffprobe, r3.tasks[0].output);
  const s3 = ffmpeg.summarizeInfo(p3.info);
  ok(s3.video.hasVideo && s3.audio.hasAudio, '选轨产物：视频+单音轨', JSON.stringify(s3.streams && s3.streams.map((x) => x.type)));

  // 8. 合并两个视频
  const r4 = await runAgentGraph({ text: '合并', files, llmConfig: cfg });
  ok(r4.kind === 'operation' && r4.tasks.length === 1 && r4.tasks[0].args.includes('-filter_complex'), '合并生成 filter_complex', r4.tasks[0] && r4.tasks[0].display.slice(0, 120));
  await runTask(binRes, r4.tasks[0], '合并执行');
  const p4 = await ffmpeg.probeMedia(binRes.ffprobe, r4.tasks[0].output);
  const s4 = ffmpeg.summarizeInfo(p4.info);
  ok(Math.abs(s4.duration - (infoA.duration + infoB.duration)) < 1.2, `合并产物时长≈两段之和（实际 ${s4.duration.toFixed(2)}s，期望 ~${(infoA.duration + infoB.duration).toFixed(2)}s）`);
  ok(s4.video.hasVideo && s4.audio.hasAudio, '合并产物含视频+音频');

  // 9. 多文件各自不同操作
  const r5 = await runAgentGraph({ text: '各自操作', files, llmConfig: cfg });
  ok(r5.kind === 'operation' && r5.tasks.length === 2
    && r5.tasks[0].output.endsWith('.mp3') && r5.tasks[1].args.includes('scale=640:-2'), '多文件独立计划', JSON.stringify(r5.tasks && r5.tasks.map((t) => t.output)));
  await runTask(binRes, r5.tasks[0], 'A 提取音频执行');
  await runTask(binRes, r5.tasks[1], 'B 缩放执行');

  // 10. 截取 + 720p 组合（回归）
  const r6 = await runAgentGraph({ text: '截取从1秒到3秒，转成720p', files: [files[0]], llmConfig: cfg });
  await runTask(binRes, r6.tasks[0], '组合操作执行');
  const p6 = await ffmpeg.probeMedia(binRes.ffprobe, r6.tasks[0].output);
  const s6 = ffmpeg.summarizeInfo(p6.info);
  ok(Math.abs(s6.duration - 2) < 0.6, `时长约 2s（实际 ${s6.duration.toFixed(2)}s）`);
  ok(s6.video.width === 1280, `分辨率 1280 宽（实际 ${s6.video.width}）`);

  server.closeAllConnections && server.closeAllConnections();
  server.close();
  console.log(`\nE2E 冒烟测试: ${pass} 通过, ${fail} 失败`);
  setTimeout(() => process.exit(fail ? 1 : 0), 150);
}

main().catch((e) => {
  console.error('E2E 异常:', e);
  process.exit(1);
});
