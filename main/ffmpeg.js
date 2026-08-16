'use strict';

const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

/**
 * ffmpeg / ffprobe 二进制定位与调用。
 * 解析顺序：用户手动指定路径 > PATH 环境变量 > 项目内 ffmpeg-static > 常见安装目录。
 */

const COMMON_DIRS = [
  process.env.FFMPEG_PATH && path.dirname(process.env.FFMPEG_PATH),
  'C:\\ffmpeg\\bin',
  'C:\\Program Files\\ffmpeg\\bin',
  'C:\\Program Files (x86)\\ffmpeg\\bin',
  'C:\\tools\\ffmpeg\\bin',
  '/usr/bin',
  '/usr/local/bin',
  '/opt/homebrew/bin',
].filter(Boolean);

const EXE = process.platform === 'win32' ? '.exe' : '';

function isFile(p) {
  try {
    return !!p && fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** 在 PATH 中查找可执行文件（跨平台） */
function findOnPath(name) {
  return new Promise((resolve) => {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    execFile(cmd, [name], (err, stdout) => {
      if (err) return resolve(null);
      const first = String(stdout).split(/\r?\n/).map((s) => s.trim()).find(Boolean);
      resolve(first || null);
    });
  });
}

/** 尝试项目内 ffmpeg-static（可选依赖，可能未安装） */
function bundledFFmpeg() {
  try {
    const p = require('ffmpeg-static');
    return isFile(p) ? p : null;
  } catch {
    return null;
  }
}

/** 返回 { ffmpeg, ffprobe } 或 null */
async function findBinaries(override = {}) {
  if (override.ffmpeg && override.ffprobe && isFile(override.ffmpeg) && isFile(override.ffprobe)) {
    return { ffmpeg: override.ffmpeg, ffprobe: override.ffprobe };
  }

  const names = (p) => (p ? path.join(p, 'ffmpeg' + EXE) : null);
  const dirs = COMMON_DIRS.map((d) => d.replace(/\\$/, ''));

  let ffmpeg = null;
  let ffprobe = null;

  // 1. PATH
  const pathFfmpeg = await findOnPath('ffmpeg');
  const pathFfprobe = await findOnPath('ffprobe');
  if (pathFfmpeg && pathFfprobe) {
    ffmpeg = pathFfmpeg;
    ffprobe = pathFfprobe;
  }

  // 2. ffmpeg-static 自带二进制（只带 ffmpeg，ffprobe 则继续找）
  const bundled = bundledFFmpeg();
  if (!ffmpeg && bundled) ffmpeg = bundled;

  // 3. 常见安装目录
  if (!ffmpeg) {
    for (const d of dirs) {
      const f = names(d);
      if (isFile(f)) {
        ffmpeg = f;
        ffprobe = ffprobe || (isFile(names(d)) && names(d));
        if (ffmpeg) break;
      }
    }
  }
  if (ffmpeg && !ffprobe) {
    for (const d of dirs) {
      if (isFile(path.join(d, 'ffprobe' + EXE))) {
        ffprobe = path.join(d, 'ffprobe' + EXE);
        break;
      }
    }
  }

  return ffmpeg ? { ffmpeg, ffprobe } : null;
}

/** 探测二进制是否可用并返回版本号 */
async function resolveBinaries(override = {}) {
  const found = await findBinaries(override);
  if (!found) {
    return { ok: false, error: '未找到 ffmpeg，请在设置中手动指定路径，或先安装 ffmpeg 并加入 PATH。' };
  }
  const version = await getVersion(found.ffmpeg).catch(() => null);
  return { ok: true, ...found, version };
}

function getVersion(binPath) {
  return new Promise((resolve, reject) => {
    execFile(binPath, ['-version'], { timeout: 15000 }, (err, stdout) => {
      if (err) return reject(err);
      const first = String(stdout).split(/\r?\n/)[0];
      resolve(first || 'ffmpeg');
    });
  });
}

/**
 * 用 ffprobe 读取媒体信息。
 * @returns {Promise<{ok:true, info:object}|{ok:false, error:string}>}
 */
function probeMedia(ffprobePath, filePath) {
  return new Promise((resolve) => {
    if (!isFile(filePath)) return resolve({ ok: false, error: '文件不存在: ' + filePath });
    execFile(
      ffprobePath,
      ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', filePath],
      { timeout: 30000, maxBuffer: 1024 * 1024 * 16 },
      (err, stdout) => {
        if (err) return resolve({ ok: false, error: String(err.stderr || err.message) });
        try {
          resolve({ ok: true, info: JSON.parse(stdout) });
        } catch (e) {
          resolve({ ok: false, error: '解析 ffprobe 输出失败: ' + e.message });
        }
      }
    );
  });
}

/** 从 ffprobe 结果提取友好信息（含全部流列表，供流级操作与 LLM 决策） */
function summarizeInfo(info) {
  if (!info) return null;
  const fmt = info.format || {};
  const streams = info.streams || [];
  const video = streams.find((s) => s.codec_type === 'video');
  const audio = streams.find((s) => s.codec_type === 'audio');

  // 类型内序号（ffmpeg -map 0:a:N 中的 N 即此序号，0 起）
  let vIdx = -1;
  let aIdx = -1;
  const streamList = streams.map((s) => {
    const type = s.codec_type;
    if (type === 'video') vIdx += 1;
    if (type === 'audio') aIdx += 1;
    const item = {
      index: s.index,             // 全局流序号
      type,                       // video | audio | subtitle | data...
      codec: s.codec_name,
      language: (s.tags && (s.tags.language || s.tags.LANGUAGE)) || null,
      title: (s.tags && (s.tags.title || s.tags.TITLE)) || null,
      default: !!(s.disposition && s.disposition.default === 1),
    };
    if (type === 'video') {
      item.videoIndex = vIdx;
      item.width = s.width;
      item.height = s.height;
      item.fps = evalFps(s);
    }
    if (type === 'audio') {
      item.audioIndex = aIdx;
      item.channels = s.channels;
      item.sampleRate = s.sample_rate;
    }
    return item;
  });

  return {
    duration: parseFloat(fmt.duration) || parseFloat(video && video.duration) || 0,
    size: parseInt(fmt.size || 0, 10),
    bitRate: parseInt(fmt.bit_rate || 0, 10),
    formatName: (fmt.format_name || '').split(',')[0],
    streams: streamList,
    video: video
      ? {
          codec: video.codec_name,
          width: video.width,
          height: video.height,
          fps: evalFps(video),
          hasVideo: true,
        }
      : { hasVideo: false },
    audio: audio ? { codec: audio.codec_name, channels: audio.channels, hasAudio: true } : { hasAudio: false },
  };
}

function evalFps(video) {
  const r = video.r_frame_rate || video.avg_frame_rate;
  if (!r) return null;
  const [a, b] = r.split('/').map(Number);
  if (!b) return null;
  return Math.round((a / b) * 100) / 100;
}

/**
 * 以流式方式执行 ffmpeg，并解析 -progress 输出。
 * @param {object} opts
 * @param {string} opts.bin  ffmpeg 可执行文件路径
 * @param {string[]} opts.args  ffmpeg 参数（不含二进制）
 * @param {number} [opts.duration]  总时长（秒），用于计算进度百分比
 * @param {(p:{progress:number,outTime:number,phase:string})=>void} [opts.onProgress]
 * @param {(code:number|null, signal:string|null)=>void} [opts.onExit]
 * @returns {{promise: Promise<{ok:boolean, code:number|null, error?:string}>, kill: ()=>void}}
 */
function runFFmpeg({ bin, args, duration, onProgress, onExit }) {
  // 自动附加进度输出（全局选项，位置无关）
  const child = spawn(bin, [...args, '-progress', 'pipe:1', '-nostats'], { windowsHide: true });
  let killed = false;
  const kill = () => {
    killed = true;
    try {
      child.kill('SIGKILL');
    } catch {}
  };

  // -progress 输出在 stdout
  let buf = '';
  child.stdout.on('data', (chunk) => {
    buf += chunk.toString();
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line || !line.includes('=')) continue;
      const [key, ...rest] = line.split('=');
      const value = rest.join('=');
      if (key === 'out_time_us' || key === 'out_time_ms') {
        const us = key === 'out_time_us' ? parseInt(value, 10) : parseInt(value, 10) * 1000;
        const outTime = (us || 0) / 1e6;
        const progress = duration > 0 ? Math.min(1, outTime / duration) : null;
        if (onProgress) onProgress({ progress, outTime, phase: 'processing' });
      } else if (key === 'progress' && value === 'end') {
        if (onProgress) onProgress({ progress: 1, outTime: duration || 0, phase: 'done' });
      }
    }
  });

  // 收集 stderr（限制大小），供错误诊断使用
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    if (stderr.length < 8192) stderr += chunk.toString();
  });

  const promise = new Promise((resolve) => {
    child.on('error', (err) => {
      resolve({ ok: false, code: null, error: err.message });
    });
    child.on('close', (code, signal) => {
      if (onExit) onExit(code, signal);
      const error =
        killed ? '任务已取消'
        : code === 0 ? null
        : `ffmpeg 退出码 ${code}：${tailLines(stderr, 3)}`;
      resolve({ ok: code === 0, code, error });
    });
  });

  return { promise, kill };
}

function tailLines(s, n) {
  return String(s || '').split(/\r?\n/).filter(Boolean).slice(-n).join(' | ');
}

module.exports = {
  resolveBinaries,
  findBinaries,
  getVersion,
  probeMedia,
  summarizeInfo,
  runFFmpeg,
  isFile,
};
