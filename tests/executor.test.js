'use strict';

const { buildCommand, suggestOutputPath } = require('../main/agent/executor');

let pass = 0;
let fail = 0;

function check(desc, cond, extra) {
  if (cond) {
    pass++;
  } else {
    fail++;
    console.log(`✗ ${desc}${extra ? '\n   ' + extra : ''}`);
  }
}

const media = { duration: 120, video: { width: 1920, height: 1080 }, audio: { hasAudio: true } };

// 转格式 + 拷贝
let r = buildCommand({ input: 'C:/v/a.mp4', output: 'C:/v/a.mkv', actions: [{ op: 'convert', targetFormat: 'mkv' }], media });
check('转mkv使用copy', r.args.includes('-c:v') && r.args.includes('copy') && !r.args.includes('-vf'), JSON.stringify(r.args));
check('输出路径正确', r.args[r.args.length - 1] === 'C:/v/a.mkv');

// 裁剪
r = buildCommand({ input: 'a.mp4', output: 'a_out.mp4', actions: [{ op: 'trim', start: 10, end: 30 }], media });
check('裁剪 -ss 在前', r.args.indexOf('-ss') < r.args.indexOf('-i'));
check('裁剪 -t', r.args.includes('-t') && r.args[r.args.indexOf('-t') + 1] === '20');

// 保留后20秒
r = buildCommand({ input: 'a.mp4', output: 'a_out.mp4', actions: [{ op: 'trim', end: 20, fromEnd: true }], media });
check('保留后20秒 -t=20', r.args.includes('-t') && r.args[r.args.indexOf('-t') + 1] === '20');

// 提取音频
r = buildCommand({ input: 'a.mp4', output: 'a.mp3', actions: [{ op: 'extractAudio', targetFormat: 'mp3' }], media });
check('提取音频 -vn', r.args.includes('-vn'));
check('提取音频 libmp3lame', r.args.includes('libmp3lame'));

// 720p
r = buildCommand({ input: 'a.mp4', output: 'a_720.mp4', actions: [{ op: 'resolution', width: 1280 }], media });
check('720p scale滤镜', r.args.includes('-vf') && r.args[r.args.indexOf('-vf') + 1].includes('scale=1280:-2'));
check('720p 重新编码', r.args.includes('libx264'));

// 变速
r = buildCommand({ input: 'a.mp4', output: 'a_speed.mp4', actions: [{ op: 'speed', speed: 2 }], media });
const vf = r.args[r.args.indexOf('-vf') + 1];
check('2倍速 setpts', vf.includes('setpts=PTS/2'));
check('2倍速 atempo', r.args.includes('-af') && r.args[r.args.indexOf('-af') + 1].includes('atempo=2.0000'));

// 加速4倍（atempo链）
r = buildCommand({ input: 'a.mp4', output: 'a_s4.mp4', actions: [{ op: 'speed', speed: 4 }], media });
const af = r.args.includes('-af') ? r.args[r.args.indexOf('-af') + 1] : '';
check('4倍速 atempo链', af.split(',').filter((x) => x.startsWith('atempo')).length === 2, af);

// 水印
r = buildCommand({ input: 'a.mp4', output: 'a_wm.mp4', actions: [{ op: 'watermark', text: '我的视频', position: 'bottom-right' }], media });
const wvf = r.args[r.args.indexOf('-vf') + 1];
check('水印 drawtext', wvf.includes('drawtext=text=' + "'我的视频'"), wvf);
check('水印转义冒号', !wvf.includes('text=我的视频:'));
check('水印位置', wvf.includes('x=w-tw-20:y=h-th-20'));

// 组合：截取+720p
r = buildCommand({ input: 'a.mp4', output: 'a_out.mp4', actions: [{ op: 'trim', start: 5, end: 65 }, { op: 'resolution', width: 1280 }], media });
check('组合 -t=60', r.args[r.args.indexOf('-t') + 1] === '60');
check('组合滤镜合并', r.args.includes('-vf') && r.args[r.args.indexOf('-vf') + 1] === 'scale=1280:-2');

// gif
r = buildCommand({ input: 'a.mp4', output: 'a.gif', actions: [{ op: 'gif' }], media });
check('gif fps=12', r.args[r.args.indexOf('-vf') + 1].includes('fps=12'));
check('gif 无音频', r.args.includes('-an'));

// 封面
r = buildCommand({ input: 'a.mp4', output: 'a_cover.png', actions: [{ op: 'thumbnail', at: 5 }], media });
check('封面 -frames:v 1', r.args.includes('-frames:v') && r.args[r.args.indexOf('-frames:v') + 1] === '1');
check('封面 -ss', r.args.includes('-ss') && r.args[r.args.indexOf('-ss') + 1] === '5');

// 静音
r = buildCommand({ input: 'a.mp4', output: 'a_mute.mp4', actions: [{ op: 'mute' }], media });
check('静音 -an', r.args.includes('-an'));

// 非法参数
let threw = false;
try {
  buildCommand({ input: 'a.mp4', output: 'a.mp4', actions: [{ op: 'speed', speed: -1 }], media });
} catch (e) { threw = true; }
check('非法倍速抛错', threw);

// suggestOutputPath
let out = suggestOutputPath('C:/v/我的 视频.mp4', [{ op: 'convert', targetFormat: 'avi' }]);
check('输出路径-转换', out.endsWith('我的 视频.avi'), out);
out = suggestOutputPath('C:/v/video.mp4', [{ op: 'extractAudio', targetFormat: 'wav' }]);
check('输出路径-音频', out.endsWith('video.wav'), out);
out = suggestOutputPath('C:/v/video.mp4', [{ op: 'compress' }]);
check('输出路径-压缩', out.endsWith('video_out.mp4'), out);

console.log(`\nexecutor 测试结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
