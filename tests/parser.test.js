'use strict';

const { parseIntent } = require('../main/agent/parser');

let pass = 0;
let fail = 0;

function check(desc, input, expectOp, expectParams) {
  const r = parseIntent(input);
  const op = r.type === 'operation' ? r.actions.map((a) => a.op) : r.type;
  if (r.type === 'operation') {
    const allOk = expectOp.every((e) => op.includes(e)) && op.length === expectOp.length;
    if (!allOk) {
      fail++;
      console.log(`✗ ${desc}\n   输入: "${input}"\n   期望操作: ${expectOp}\n   实际: ${op}`);
      return;
    }
    if (expectParams) {
      const a = r.actions.find((x) => x.op === expectParams.op);
      for (const [k, v] of Object.entries(expectParams)) {
        if (k === 'op') continue;
        if (a[k] !== v) {
          fail++;
          console.log(`✗ ${desc} [${k}]\n   输入: "${input}"\n   期望: ${k}=${v}\n   实际: ${k}=${a[k]}`);
          return;
        }
      }
    }
    pass++;
  } else if (r.type === expectOp[0]) {
    pass++;
  } else {
    fail++;
    console.log(`✗ ${desc}\n   输入: "${input}"\n   期望: ${expectOp}\n   实际: ${r.type}`);
  }
}

// ---------- 格式转换 ----------
check('转mp4', '把这个视频转成mp4格式', ['convert'], { op: 'convert', targetFormat: 'mp4' });
check('转换avi', '转换成avi', ['convert'], { op: 'convert', targetFormat: 'avi' });
check('转mkv', '转为mkv文件', ['convert'], { op: 'convert', targetFormat: 'mkv' });
check('convert to webm', 'convert this video to webm', ['convert'], { op: 'convert', targetFormat: 'webm' });

// ---------- 裁剪 ----------
check('截取10-30', '截取从10秒到30秒的片段', ['trim'], { op: 'trim', start: 10, end: 30 });
check('保留前30秒', '只保留前30秒', ['trim'], { op: 'trim', start: 0, end: 30 });
check('保留后20秒', '保留最后20秒', ['trim'], { op: 'trim', fromEnd: true, end: 20 });
check('去掉前10秒', '去掉前10秒', ['trim'], { op: 'trim', start: 10 });
check('trim 5 to 15', 'trim from 5 seconds to 15 seconds', ['trim'], { op: 'trim', start: 5, end: 15 });
check('keep first minute', 'keep only the first minute', ['trim'], { op: 'trim', start: 0, end: 60 });

// ---------- 音频 ----------
check('提取mp3', '提取音频为mp3', ['extractAudio'], { op: 'extractAudio', targetFormat: 'mp3' });
check('extract audio wav', 'extract audio as wav', ['extractAudio'], { op: 'extractAudio', targetFormat: 'wav' });
check('静音', '把视频静音', ['mute']);

// ---------- 分辨率 / 码率 / 帧率 ----------
check('720p', '把分辨率调到720p', ['resolution'], { op: 'resolution', width: 1280 });
check('1080p', '转成1080p分辨率', ['resolution'], { op: 'resolution', width: 1920 });
check('码率', '设置码率为2000k', ['bitrate'], { op: 'bitrate', kbps: 2000 });
check('fps', '调整帧率到30fps', ['fps'], { op: 'fps', fps: 30 });

// ---------- 速度 / 旋转 / 倒放 ----------
check('加速2倍', '加速2倍速播放', ['speed'], { op: 'speed', speed: 2 });
check('减速0.5', '减速到0.5倍速', ['speed'], { op: 'speed', speed: 0.5 });
check('倒放', '把视频倒放', ['reverse']);
check('旋转90', '顺时针旋转90度', ['rotate'], { op: 'rotate', degrees: 90 });

// ---------- 音量 / 水印 ----------
check('音量50%', '音量调到50%', ['volume'], { op: 'volume', factor: 0.5 });
check('文字水印', '在右下角添加文字水印"我的视频"', ['watermark'], { op: 'watermark', text: '我的视频', position: 'bottom-right' });

// ---------- 压缩 / 降噪 / 镜像 / 封面 / gif ----------
check('压缩', '压缩一下这个视频', ['compress']);
check('降噪', '给视频降噪', ['denoise']);
check('水平翻转', '水平翻转视频', ['mirror'], { op: 'mirror', direction: 'horizontal' });
check('生成封面', '生成封面图', ['thumbnail']);
check('提取第5秒帧', '提取第5秒的帧', ['thumbnail'], { op: 'thumbnail', at: 5 });
check('转gif', '转成gif动图', ['gif']);

// ---------- 多操作组合 ----------
const multi = parseIntent('截取从10秒到30秒，然后转成720p');
if (multi.type === 'operation' && multi.actions.length === 2 &&
    multi.actions[0].op === 'trim' && multi.actions[1].op === 'resolution') {
  pass++;
} else {
  fail++;
  console.log(`✗ 多操作组合\n   实际: ${JSON.stringify(multi)}`);
}

// ---------- 查询 / 未知 ----------
check('查询时长', '这个视频有多长？', ['inspect']);
check('查询信息', '看一下这个文件的信息', ['inspect']);

const unknown = parseIntent('帮我煎个鸡蛋');
if (unknown.type === 'unknown' && Array.isArray(unknown.suggestions)) {
  pass++;
} else {
  fail++;
  console.log(`✗ 未知指令应返回 unknown: ${JSON.stringify(unknown)}`);
}

console.log(`\nparser 测试结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
