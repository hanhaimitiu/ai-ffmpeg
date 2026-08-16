'use strict';

/**
 * 端到端冒烟测试：生成测试视频 → 探测 → 自然语言解析（mock LLM）→ 命令构建 → 真实 ffmpeg 执行。
 * 直接复用主进程模块（不依赖 Electron 窗口）。
 */

const path = require('path');
const fs = require('fs');
const http = require('http');
const { execFileSync } = require('child_process');

const ffmpeg = require('../main/ffmpeg');
const { buildCommand, suggestOutputPath } = require('../main/agent/executor');
const { planFromText } = require('../main/agent/agent');

const WORK = path.join(__dirname, '.e2e');
let pass = 0;
let fail = 0;

function ok(cond, desc, extra) {
  if (cond) { pass++; console.log(`  ✓ ${desc}`); }
  else { fail++; console.log(`  ✗ ${desc}${extra ? '\n    ' + extra : ''}`); }
}

/** mock OpenAI 兼容服务：按指令返回操作 */
function startMockLLM(port) {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        let msg = '';
        try { msg = JSON.parse(body).messages[1].content; } catch {}
        let reply;
        if (/压缩/.test(msg)) reply = { type: 'operation', actions: [{ op: 'convert', targetFormat: 'mp4' }, { op: 'compress', crf: 28 }] };
        else if (/720p/.test(msg)) reply = { type: 'operation', actions: [{ op: 'trim', start: 1, end: 3 }, { op: 'resolution', width: 1280 }] };
        else if (/wav|音频/.test(msg)) reply = { type: 'operation', actions: [{ op: 'extractAudio', targetFormat: 'wav' }] };
        else if (/封面/.test(msg)) reply = { type: 'operation', actions: [{ op: 'thumbnail' }] };
        else reply = { type: 'unknown', message: '无法理解', suggestions: [] };
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Connection', 'close');
        res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(reply) } }] }));
      });
    });
    s.listen(port, () => resolve(s));
  });
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

  // 2. 生成测试视频（5 秒，带音频）
  const testVideo = path.join(WORK, 'test.mp4');
  execFileSync(binRes.ffmpeg, [
    '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24:duration=5',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=5',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
    '-shortest', '-y', testVideo,
  ], { stdio: 'ignore' });
  ok(fs.existsSync(testVideo), '生成测试视频');

  // 3. ffprobe 探测
  const probe = await ffmpeg.probeMedia(binRes.ffprobe, testVideo);
  ok(probe.ok, 'ffprobe 读取媒体信息');
  const summary = ffmpeg.summarizeInfo(probe.info);
  ok(summary.duration > 4.5, `时长约 5s（实际 ${summary.duration.toFixed(2)}s）`);

  // 4. 多步骤：压缩（convert + compress）
  const { plan } = await planFromText('把视频转成mp4并压缩', summary, cfg);
  ok(plan.type === 'operation' && plan.actions.length === 2, '解析"转mp4并压缩"两步骤', JSON.stringify(plan));

  // 5. 构建命令
  const out1 = path.join(WORK, 'test_compressed.mp4');
  const built1 = buildCommand({ input: testVideo, output: out1, actions: plan.actions, media: summary });
  ok(built1.args.includes('-crf'), '压缩参数包含 crf', built1.display);

  // 6. 真实执行 + 进度
  const progressEvents = [];
  let exitCode = null;
  const runner = ffmpeg.runFFmpeg({
    bin: binRes.ffmpeg,
    args: built1.args,
    duration: summary.duration,
    onProgress: (p) => progressEvents.push(p),
    onExit: (c) => { exitCode = c; },
  });
  const res = await runner.promise;
  ok(res.ok && exitCode === 0, `执行成功（exit ${exitCode}）`, res.error || '');
  ok(fs.existsSync(out1), '输出文件已生成');
  ok(progressEvents.length > 0 && progressEvents[progressEvents.length - 1].progress === 1, `进度上报到 100%（共 ${progressEvents.length} 次）`);

  // 7. 截取 + 720p 组合
  const p2 = await planFromText('截取从1秒到3秒，转成720p', summary, cfg);
  ok(p2.plan.actions.length === 2, '解析组合操作', JSON.stringify(p2.plan.actions));
  const out2 = path.join(WORK, 'test_trim720.mp4');
  const built2 = buildCommand({ input: testVideo, output: out2, actions: p2.plan.actions, media: summary });
  const r2 = await ffmpeg.runFFmpeg({ bin: binRes.ffmpeg, args: built2.args, duration: 2 }).promise;
  ok(r2.ok, '组合操作执行成功');
  const probe2 = await ffmpeg.probeMedia(binRes.ffprobe, out2);
  const s2 = ffmpeg.summarizeInfo(probe2.info);
  ok(Math.abs(s2.duration - 2) < 0.6, `时长约 2s（实际 ${s2.duration.toFixed(2)}s）`);
  ok(s2.video.width === 1280, `分辨率 1280 宽（实际 ${s2.video.width}）`);

  // 8. 提取音频
  const p3 = await planFromText('提取音频为wav', summary, cfg);
  const out3 = suggestOutputPath(testVideo, p3.plan.actions);
  const built3 = buildCommand({ input: testVideo, output: out3, actions: p3.plan.actions, media: summary });
  const r3 = await ffmpeg.runFFmpeg({ bin: binRes.ffmpeg, args: built3.args, duration: 5 }).promise;
  ok(r3.ok && fs.existsSync(out3), '提取音频成功（' + path.basename(out3) + '）');

  // 9. 封面
  const p4 = await planFromText('生成封面图', summary, cfg);
  const out4 = suggestOutputPath(testVideo, p4.plan.actions);
  const built4 = buildCommand({ input: testVideo, output: out4, actions: p4.plan.actions, media: summary });
  const r4 = await ffmpeg.runFFmpeg({ bin: binRes.ffmpeg, args: built4.args }).promise;
  ok(r4.ok && fs.existsSync(out4), '封面生成成功（' + path.basename(out4) + '）');

  server.closeAllConnections && server.closeAllConnections();
  server.close();
  console.log(`\nE2E 冒烟测试: ${pass} 通过, ${fail} 失败`);
  setTimeout(() => process.exit(fail ? 1 : 0), 150);
}

main().catch((e) => {
  console.error('E2E 异常:', e);
  process.exit(1);
});
