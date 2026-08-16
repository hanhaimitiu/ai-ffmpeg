'use strict';

const path = require('path');
const fs = require('fs');

/**
 * 把解析出的操作计划翻译成 ffmpeg 命令行参数。
 * 纯函数，不直接执行；由 main.js 结合 ffmpeg 二进制与进度回调执行。
 *
 * 注意 ffmpeg 选项位置语义：-i 之前的选项是输入选项，-i 之后的是输出选项。
 * 这里统一把编码/滤镜/容器等输出选项放在 -i 之后，避免 -crf 等被误当作输入选项。
 */

// ---------- 工具 ----------

function extOf(p) {
  const e = path.extname(p || '');
  return e ? e.slice(1).toLowerCase() : '';
}

function baseName(p) {
  const base = path.basename(p, path.extname(p));
  return base.replace(/[\\/:*?"<>|]/g, '_');
}

/** 为操作组合建议输出路径（避免覆盖输入） */
function suggestOutputPath(inputPath, actions) {
  const dir = path.dirname(inputPath);
  const base = baseName(inputPath);

  const hasThumbnail = actions.some((a) => a.op === 'thumbnail');
  if (hasThumbnail) {
    const at = actions.find((a) => a.op === 'thumbnail').at;
    return path.join(dir, `${base}${at != null ? `_frame${at}s` : '_cover'}.png`);
  }

  const hasGif = actions.some((a) => a.op === 'gif');
  if (hasGif) return path.join(dir, `${base}.gif`);

  const audio = actions.find((a) => a.op === 'extractAudio');
  if (audio) return path.join(dir, `${base}.${audio.targetFormat}`);

  const conv = actions.find((a) => a.op === 'convert');
  if (conv) return path.join(dir, `${base}.${conv.targetFormat}`);

  return path.join(dir, `${base}_out.${extOf(inputPath) || 'mp4'}`);
}

// ---------- 滤镜辅助 ----------

function filterChain(filters) {
  return filters.length ? filters.join(',') : null;
}

/** drawtext 文本转义 */
function escapeDrawText(s) {
  return String(s)
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/,/g, '\\,')
    .replace(/'/g, "\\'")
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]');
}

const WM_POSITIONS = {
  'top-left': 'x=20:y=20',
  'top-right': 'x=w-tw-20:y=20',
  'bottom-left': 'x=20:y=h-th-20',
  'bottom-right': 'x=w-tw-20:y=h-th-20',
  top: 'x=(w-tw)/2:y=20',
  bottom: 'x=(w-tw)/2:y=h-th-20',
  center: 'x=(w-tw)/2:y=(h-th)/2',
};

/** 查找可用的中文字体文件（供 drawtext 使用） */
function findCJKFont() {
  const candidates = [
    'C:/Windows/Fonts/msyh.ttc',
    'C:/Windows/Fonts/msyh.ttf',
    'C:/Windows/Fonts/simhei.ttf',
    'C:/Windows/Fonts/simsun.ttc',
    '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    '/System/Library/Fonts/PingFang.ttc',
  ];
  for (const p of candidates) {
    try {
      if (fs.statSync(p).isFile()) return p.replace(/\\/g, '/');
    } catch {}
  }
  return null;
}

/** atempo 链：atempo 支持 0.5~2.0，超出范围串联 */
function atempoChain(factor) {
  const chains = [];
  let f = factor;
  while (f > 2) {
    chains.push('atempo=2.0');
    f /= 2;
  }
  while (f < 0.5) {
    chains.push('atempo=0.5');
    f /= 0.5;
  }
  chains.push(`atempo=${f.toFixed(4)}`);
  return chains.join(',');
}

// ---------- 构建命令 ----------

/**
 * @param {object} opts
 * @param {string} opts.input  输入文件路径
 * @param {string} opts.output 输出文件路径（建议由 suggestOutputPath 生成）
 * @param {object[]} opts.actions 操作列表
 * @param {object} [opts.media] 媒体信息摘要（需含 duration 秒）
 * @param {string} [opts.logoPath] 图片水印路径（可选）
 * @returns {{ args: string[], display: string, kind: 'video'|'audio'|'image'|'gif' }}
 * @throws {Error} 参数不合法时
 */
function buildCommand({ input, output, actions, media, logoPath }) {
  if (!actions || actions.length === 0) throw new Error('没有可执行的操作');
  const duration = (media && media.duration) || 0;

  const pre = []; // -i 之前的输入选项
  const post = []; // -i 之后的输出选项
  const extraInputs = []; // 附加输入文件（如图片水印）
  const videoFilters = [];
  const audioFilters = [];
  let outputFormat = null;
  let audioOnly = false;
  let imageOut = false;
  let gifOut = false;
  let forceVideoEncode = false;
  let trimStart = null;
  let trimLen = null;
  let hasThumbnail = false;
  let imageWatermark = false;

  for (const a of actions) {
    if (!a || typeof a !== 'object' || !a.op) throw new Error('操作缺少 op 字段');
    switch (a.op) {
      case 'trim': {
        if (a.start == null && a.end == null) throw new Error('trim 操作缺少 start/end 参数');
        if (a.start != null) trimStart = a.start;
        if (a.end != null) {
          if (a.fromEnd && a.start == null) {
            if (duration > 0) {
              trimStart = Math.max(0, duration - a.end);
              trimLen = a.end;
            } else {
              throw new Error('无法确定总时长，请先获取媒体信息');
            }
          } else if (a.removeFromEnd && a.start == null) {
            if (duration > 0) {
              trimStart = 0;
              trimLen = Math.max(0, duration - a.end);
            } else {
              throw new Error('无法确定总时长，请先获取媒体信息');
            }
          } else {
            trimLen = a.end - (a.start != null ? a.start : 0);
          }
        }
        break;
      }

      case 'convert': {
        outputFormat = a.targetFormat;
        if (actions.length === 1) {
          // 纯转封装：流拷贝
          forceVideoEncode = false;
        } else {
          forceVideoEncode = true;
        }
        break;
      }

      case 'extractAudio': {
        audioOnly = true;
        outputFormat = a.targetFormat || 'mp3';
        break;
      }

      case 'mute': {
        post.push('-an');
        break;
      }

      case 'resolution': {
        const w = Math.round(a.width);
        if (w < 16) throw new Error('分辨率数值异常');
        videoFilters.push(`scale=${w}:-2`);
        forceVideoEncode = true;
        break;
      }

      case 'bitrate': {
        const k = Math.round(a.kbps);
        if (k < 10) throw new Error('码率数值异常');
        post.push('-b:v', `${k}k`);
        forceVideoEncode = true;
        break;
      }

      case 'fps': {
        const f = Math.round(a.fps);
        if (f < 1 || f > 240) throw new Error('帧率数值异常');
        videoFilters.push(`fps=${f}`);
        forceVideoEncode = true;
        break;
      }

      case 'speed': {
        const sp = a.speed;
        if (sp <= 0 || sp > 16) throw new Error('倍速数值异常');
        videoFilters.push(`setpts=PTS/${sp}`);
        audioFilters.push(atempoChain(sp));
        forceVideoEncode = true;
        break;
      }

      case 'reverse': {
        videoFilters.push('reverse');
        audioFilters.push('areverse');
        forceVideoEncode = true;
        break;
      }

      case 'rotate': {
        const deg = ((a.degrees % 360) + 360) % 360;
        const t = deg === 90 ? 1 : deg === 180 ? 2 : deg === 270 ? 3 : null;
        if (t == null) throw new Error('旋转角度仅支持 90/180/270');
        videoFilters.push(`transpose=${t}`);
        forceVideoEncode = true;
        break;
      }

      case 'volume': {
        const f = a.factor;
        if (f <= 0 || f > 100) throw new Error('音量数值异常');
        audioFilters.push(`volume=${f}`);
        break;
      }

      case 'watermark': {
        if (a.image && logoPath) {
          imageWatermark = true;
          extraInputs.push(logoPath);
        } else {
          const text = a.text || 'watermark';
          if (!text.trim()) throw new Error('水印文字为空');
          const pos = WM_POSITIONS[a.position] || WM_POSITIONS['bottom-right'];
          const font = findCJKFont();
          let draw = `drawtext=text='${escapeDrawText(text)}'`;
          if (font) draw += `:fontfile='${escapeDrawText(font)}'`;
          draw += `:${pos}:fontsize=36:fontcolor=white:box=1:boxcolor=black@0.5:boxborderw=8`;
          videoFilters.push(draw);
        }
        forceVideoEncode = true;
        break;
      }

      case 'compress': {
        const crf = Math.min(51, Math.max(0, Math.round(a.crf || 28)));
        post.push('-crf', String(crf), '-preset', 'slow');
        forceVideoEncode = true;
        break;
      }

      case 'denoise': {
        videoFilters.push('hqdn3d');
        forceVideoEncode = true;
        break;
      }

      case 'mirror': {
        videoFilters.push(a.direction === 'vertical' ? 'vflip' : 'hflip');
        forceVideoEncode = true;
        break;
      }

      case 'thumbnail': {
        hasThumbnail = true;
        imageOut = true;
        if (a.at != null) pre.push('-ss', String(a.at));
        post.push('-frames:v', '1', '-q:v', '2');
        outputFormat = 'png';
        break;
      }

      case 'gif': {
        gifOut = true;
        outputFormat = 'gif';
        videoFilters.push('fps=12');
        if (!videoFilters.some((f) => f.startsWith('scale='))) videoFilters.push('scale=480:-2');
        post.push('-loop', '0');
        break;
      }

      default:
        throw new Error(`不支持的操作: ${a.op}`);
    }
  }

  // ---------- 组装 ----------

  // 输入选项（-i 之前）：快速 seek
  if (trimStart != null) pre.push('-ss', String(trimStart));

  // -i 之后先放 -t（输出时长）
  if (trimLen != null) post.unshift('-t', String(trimLen));

  // 附加输入（图片水印）
  const inputs = [input, ...extraInputs];

  if (audioOnly) {
    post.push('-vn');
    if (!post.includes('-c:a')) {
      const acodec = { mp3: 'libmp3lame', aac: 'aac', m4a: 'aac', wav: 'pcm_s16le', flac: 'flac', ogg: 'libvorbis', opus: 'libopus' }[outputFormat];
      if (acodec) post.push('-c:a', acodec);
      else post.push('-c:a', 'copy');
    }
  } else if (hasThumbnail) {
    post.push('-an');
    if (!post.includes('-c:v')) post.push('-c:v', 'png');
  } else {
    // 图片水印需要 filter_complex（多输入）
    if (imageWatermark) {
      const chain = filterChain(videoFilters);
      const inner = chain ? `${chain},` : '';
      const fc = `[0:v]${inner}overlay=W-w-20:H-h-20[v]`;
      post.push('-filter_complex', fc, '-map', '[v]');
      if (audioFilters.length) post.push('-af', filterChain(audioFilters));
      if (gifOut) post.push('-an');
    } else {
      const vf = filterChain(videoFilters);
      const af = filterChain(audioFilters);
      if (vf) post.push('-vf', vf);
      if (af) post.push('-af', af);
      if (gifOut) post.push('-an');
    }

    if (forceVideoEncode) {
      const target = { mp4: 'libx264', mov: 'libx264', mkv: 'libx264', webm: 'libvpx-vp9', avi: 'libx264', flv: 'libx264' }[outputFormat || extOf(output)];
      if (target) post.push('-c:v', target);
    } else if (outputFormat && outputFormat !== extOf(input)) {
      // 纯转封装 → 流拷贝（若未重新编码）
      post.push('-c:v', 'copy');
      post.push('-c:a', 'copy');
    }
  }

  const args = [...pre, ...inputs.flatMap((p) => ['-i', p]), ...post, '-y', output];

  const display = `ffmpeg ${args.map((a) => (/ /.test(a) ? `'${a}'` : a)).join(' ')}`;

  return {
    args,
    display,
    kind: gifOut ? 'gif' : imageOut ? 'image' : audioOnly ? 'audio' : 'video',
  };
}

module.exports = { buildCommand, suggestOutputPath };
