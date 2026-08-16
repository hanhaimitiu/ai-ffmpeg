'use strict';

/**
 * 自然语言 → 结构化 ffmpeg 操作 的解析器。
 * 同时支持中文与英文，纯规则实现，无需联网 / API Key。
 *
 * 返回结构：
 *  { type: 'operation', actions: [{op, ...params}], sourceHint?, title }
 *  { type: 'inspect' }
 *  { type: 'unknown', message, suggestions }
 */

const ZH_JOIN = /[，,。.！!？?；;\s]+/;

// ---------- 基础工具 ----------

function lower(s) {
  return (s || '').toLowerCase();
}

/** 提取文本中的数字（整数/小数），返回第一个匹配，无则 null */
function firstNumber(s) {
  const m = String(s).match(/(\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : null;
}

/** 解析时长："90" → 90；"1:30" → 90；"1:30:00" → 5400；"1.5" → 1.5 */
function parseTime(s) {
  const m = String(s).match(/(\d+):(\d{1,2})(?::(\d{1,2}))?/);
  if (m) {
    const h = parseInt(m[1], 10);
    const min = parseInt(m[2], 10);
    const sec = m[3] ? parseInt(m[3], 10) : 0;
    return h * 3600 + min * 60 + sec;
  }
  const n = firstNumber(s);
  return n != null ? n : null;
}

const FORMATS = {
  mp4: 'mp4', mov: 'mov', avi: 'avi', mkv: 'mkv', webm: 'webm', flv: 'flv',
  m4v: 'm4v', ts: 'ts', mpeg: 'mpeg', mpg: 'mpg', wmv: 'wmv', m4a: 'm4a',
  mp3: 'mp3', aac: 'aac', wav: 'wav', flac: 'flac', ogg: 'ogg', opus: 'opus',
  wma: 'wma', gif: 'gif', jpg: 'jpg', jpeg: 'jpeg', png: 'png', webp: 'webp',
};

const RESOLUTIONS = {
  '4k': 3840, '2160': 2160, '2k': 2560, '1440p': 2560, '1440': 2560,
  '1080p': 1920, '1080': 1920, 'fhd': 1920, '720p': 1280, '720': 1280,
  'hd': 1280, '480p': 854, '480': 854, '360p': 640, '360': 640,
  '240p': 426, '240': 426,
};

const POSITIONS = {
  '左上': 'top-left', '右上': 'top-right', '左下': 'bottom-left', '右下': 'bottom-right',
  '顶部': 'top', '底部': 'bottom', '居中': 'center', '中间': 'center',
  'top-left': 'top-left', 'top-right': 'top-right', 'bottom-left': 'bottom-left',
  'bottom-right': 'bottom-right', 'center': 'center', 'top': 'top', 'bottom': 'bottom',
};

const SUGGESTIONS = [
  '把视频转成 mp4 格式',
  '压缩视频，降低到 720p',
  '截取从 10 秒到 30 秒的片段',
  '提取音频为 mp3',
  '加速 2 倍速',
  '在右下角添加文字水印 "我的视频"',
  '生成封面图',
  '倒放视频',
];

// ---------- 各操作匹配器 ----------

/** 时间裁剪（最复杂的模式，先匹配） */
function matchTrim(s, text) {
  const t = lower(s);
  // 从 X 到 Y / X到Y秒 / 截取X到Y
  let m = t.match(/(?:从|截取|裁剪|保留|from)?\s*([0-9]+(?::[0-9]{1,2})?(?::[0-9]{1,2})?)\s*(?:秒|s|sec)?\s*(?:到|至|至到|to|-|~|～)\s*([0-9]+(?::[0-9]{1,2})?(?::[0-9]{1,2})?)\s*(?:秒|s|sec)?/);
  if (m && /(截|裁|从|到|至|取|trim|cut|from|to)/.test(t)) {
    const start = parseTime(m[1]);
    const end = parseTime(m[2]);
    if (start != null && end != null && end > start) {
      return { op: 'trim', start, end, title: `截取 ${fmtTime(start)} - ${fmtTime(end)} 片段` };
    }
  }
  // 保留前 N 秒 / 前 N 秒（须无"去掉/删除"等否定意图）
  const negate = /(去掉|删除|删掉|移除|去除|跳过|不要|remove|delete|drop|skip)/.test(t);
  m = t.match(/(?:保留|只要|只留)?\s*前\s*([0-9]+(?::[0-9]{1,2})?)\s*(?:秒|s|sec|分钟)/);
  if (m && /(截|裁|取|trim|cut|前|first)/.test(t) && !negate) {
    return { op: 'trim', start: 0, end: parseTime(m[1]), title: `保留前 ${m[1]} 秒` };
  }
  // 保留后 N 秒
  m = t.match(/(?:保留|只要|只留)?\s*后\s*([0-9]+(?::[0-9]{1,2})?)\s*(?:秒|s|sec|分钟)/);
  if (m && /(截|裁|取|trim|cut|后|last)/.test(t) && !negate) {
    return { op: 'trim', start: null, end: parseTime(m[1]), fromEnd: true, title: `保留后 ${m[1]} 秒` };
  }
  // 去掉/删除 前 N 秒
  m = t.match(/(?:去掉|删除|删掉|移除|跳过)\s*前\s*([0-9]+(?::[0-9]{1,2})?)\s*(?:秒|s|sec)/);
  if (m) {
    return { op: 'trim', start: parseTime(m[1]), title: `删除前 ${m[1]} 秒` };
  }
  // 去掉/删除 后 N 秒
  m = t.match(/(?:去掉|删除|删掉|移除|跳过)\s*后\s*([0-9]+(?::[0-9]{1,2})?)\s*(?:秒|s|sec)/);
  if (m) {
    return { op: 'trim', start: null, end: parseTime(m[1]), fromEnd: true, removeFromEnd: true, title: `删除后 ${m[1]} 秒` };
  }
  // 英文：from X to Y / trim X to Y / first N seconds / last N seconds
  m = t.match(/(?:trim|cut|from|to)\s+([0-9]+(?::[0-9]{1,2})?)\s*(?:s|sec|seconds)?\s*(?:to|until)\s*([0-9]+(?::[0-9]{1,2})?)/);
  if (m && /(trim|cut|from|to)/.test(t)) {
    const start = parseTime(m[1]);
    const end = parseTime(m[2]);
    if (start != null && end != null && end > start) {
      return { op: 'trim', start, end, title: `Cut from ${fmtTime(start)} to ${fmtTime(end)}` };
    }
  }
  m = t.match(/(?:keep|save)\s*(?:only\s*)?(?:the\s*)?first\s*(\d+(?::\d{1,2})?)?\s*(?:s|sec|seconds|minute|minutes)?/);
  if (m && /(first|keep|save)/.test(t)) {
    const v = m[1] ? parseTime(m[1]) : /minute/.test(t) ? 60 : 1;
    return { op: 'trim', start: 0, end: v, title: `Keep first ${m[1] || '1'}s` };
  }
  m = t.match(/(?:keep|save)\s*(?:only\s*)?(?:the\s*)?last\s*(\d+(?::\d{1,2})?)?\s*(?:s|sec|seconds|minute|minutes)?/);
  if (m && /(last|keep|save)/.test(t)) {
    const v = m[1] ? parseTime(m[1]) : /minute/.test(t) ? 60 : 1;
    return { op: 'trim', start: null, end: v, fromEnd: true, title: `Keep last ${m[1] || '1'}s` };
  }
  m = t.match(/(?:remove|cut|delete|skip)\s*(?:the\s*)?first\s*([0-9]+(?::[0-9]{1,2})?)\s*(?:s|sec|seconds|minutes)?/);
  if (m) return { op: 'trim', start: parseTime(m[1]), title: `Remove first ${m[1]}s` };
  m = t.match(/(?:remove|cut|delete|skip)\s*(?:the\s*)?last\s*([0-9]+(?::[0-9]{1,2})?)\s*(?:s|sec|seconds|minutes)?/);
  if (m) return { op: 'trim', start: null, end: parseTime(m[1]), fromEnd: true, removeFromEnd: true, title: `Remove last ${m[1]}s` };

  // 需同时出现裁剪意图词，避免误判
  if (/(截取|裁剪|掐头|去尾|trim|cut)/.test(t)) {
    // "截取10秒" → 前 10 秒
    m = t.match(/(?:截取|裁剪|cut|trim)\s*([0-9]+(?::[0-9]{1,2})?)\s*(?:秒|s|sec|seconds)/);
    if (m) return { op: 'trim', start: 0, end: parseTime(m[1]), title: `截取前 ${m[1]} 秒` };
  }
  return null;
}

/** 格式转换 */
function matchConvert(s, t) {
  const hasIntent = /(转换|转成|转为|转码|改成|变为|变成|保存为|导出为|convert|change|turn|export|save|transcode|to\s+[a-z]+\s+format)/.test(t);
  if (!hasIntent) return null;
  if (/(下载|删除|播放|upload|delete|play)/.test(t)) return null;

  // 中文/英文直接转换词 + 格式
  let m = t.match(/(?:转成|转为|转换成|转换为|转码为|改成|变为|变成|保存为|导出为|convert\s+to|change\s+to|turn\s+into|export\s+as|save\s+as|transcode\s+to)\s*(?:\.)?([a-z0-9]{2,5})\b/);
  let target = m ? m[1] : null;
  // "xxx格式" 模式（需有转换意图）
  if (!target) {
    m = t.match(/([a-z0-9]{2,5})\s*格式/);
    if (m) target = m[1];
  }
  // 英文 "to xxx"
  if (!target) {
    m = t.match(/\bto\s+([a-z0-9]{2,5})\b/);
    if (m) target = m[1];
  }
  if (!target) return null;
  target = lower(target);
  if (!FORMATS[target] || target === 'gif') return null; // gif 由专用匹配器处理
  return {
    op: 'convert',
    targetFormat: FORMATS[target],
    title: `转换为 ${target.toUpperCase()} 格式`,
  };
}

/** 音频提取 */
function matchExtractAudio(s, t) {
  if (/(提取音频|导出音频|抽出音频|抽音频|只要声音|只留声音|去掉画面|无声画|转音频|提取音轨|extract audio|get audio|audio only|export audio)/.test(t)) {
    let targetFormat = 'mp3';
    const fm = t.match(/(?:为|成|to)?\s*(mp3|wav|flac|aac|m4a|ogg|opus)\b/);
    if (fm) targetFormat = fm[1];
    return { op: 'extractAudio', targetFormat, title: `提取音频为 ${targetFormat.toUpperCase()}` };
  }
  return null;
}

/** 静音 / 去声 */
function matchMute(s, t) {
  if (/(静音|去掉声音|去掉音频|删除音轨|删除音频|无声|mute|remove audio|no sound|no audio|silence)/.test(t)) {
    return { op: 'mute', title: '移除音频（静音）' };
  }
  return null;
}

/** 分辨率 */
function matchResolution(s, t) {
  const m = t.match(/(?:分辨率|清晰度|画质|resolution|quality|resize|scale|size).{0,6}([0-9]{3,4}p?|4k|2k|1080p|720p|480p|360p|240p|fhd|hd|1440p|2160p)/);
  if (m) {
    const key = lower(m[1]);
    const w = RESOLUTIONS[key];
    if (w) return { op: 'resolution', width: w, title: `分辨率调整为 ${key.toUpperCase()}` };
  }
  // "改成 720p" / "转成720p" 等
  const m2 = t.match(/(?:改成|改为|变为|变成|转为|转成|转换成|调整为|设为|to)\s*(4k|2k|1080p|720p|480p|360p|240p|fhd|hd)\b/);
  if (m2) {
    const w = RESOLUTIONS[m2[1]];
    return { op: 'resolution', width: w, title: `分辨率调整为 ${m2[1].toUpperCase()}` };
  }
  return null;
}

/** 码率 */
function matchBitrate(s, t) {
  const m = t.match(/(?:码率|比特率|bitrate)\s*(?:改成|调到|设为|设为|为|是)?\s*(\d+(?:\.\d+)?)\s*(m|mbps|mb|k|kbps|kb)?/);
  if (m) {
    const val = parseFloat(m[1]);
    const unit = (m[2] || '').toLowerCase();
    let kbps;
    if (unit.startsWith('m')) kbps = val * 1000;
    else if (unit === 'kbps' || unit === 'kb' || unit === 'k') kbps = val;
    else kbps = val * 1000; // 默认按 Mbps
    return { op: 'bitrate', kbps, title: `码率设为 ${kbps} kbps` };
  }
  return null;
}

/** 帧率 */
function matchFps(s, t) {
  const m = t.match(/(?:帧率|fps|frame rate|frame)\s*(?:改成|调到|调到|设为|为|到|to)?\s*(\d{1,3})\s*(?:fps|帧)?/);
  if (m) {
    const fps = parseInt(m[1], 10);
    if (fps >= 1 && fps <= 240) return { op: 'fps', fps, title: `帧率调整为 ${fps} fps` };
  }
  return null;
}

/** 倍速 */
function matchSpeed(s, t) {
  const m = t.match(/(\d+(?:\.\d+)?)\s*(?:倍速|倍速度|x|×|x speed|times)/);
  if (m && /(加速|减速|倍速|慢放|速度|speed|slow|fast|倍)/.test(t)) {
    return { op: 'speed', speed: parseFloat(m[1]), title: `设为 ${m[1]} 倍速` };
  }
  const m2 = t.match(/(?:加速|加快|快进|speed up)\s*(?:播放)?\s*(?:(\d+(?:\.\d+)?)\s*倍)?/);
  if (m2 && /(加速|加快|快进|speed up)/.test(t)) {
    const n = m2[1] ? parseFloat(m2[1]) : 1;
    return { op: 'speed', speed: n + 1, title: `加速 ${m2[1] || '2'} 倍速` };
  }
  const m3 = t.match(/(?:减速|放慢|慢放|slow down|slow)\s*(?:播放)?\s*(?:(\d+(?:\.\d+)?)\s*倍)?/);
  if (m3 && /(减速|放慢|慢放|slow)/.test(t)) {
    const n = m3[1] ? parseFloat(m3[1]) : 2;
    return { op: 'speed', speed: 1 / n, title: `减速至 ${(1 / n).toFixed(2)} 倍速` };
  }
  return null;
}

/** 倒放 */
function matchReverse(s, t) {
  if (/(倒放|倒着放|倒播|反向|reverse|play backwards)/.test(t)) {
    return { op: 'reverse', title: '视频倒放' };
  }
  return null;
}

/** 旋转 */
function matchRotate(s, t) {
  const m = t.match(/(?:旋转|rotate|翻转方向|倒过来)\s*(?:顺时针|逆时针)?\s*(\d{1,3})\s*(?:度|°|度角|degrees)?/);
  if (m) {
    let deg = parseInt(m[1], 10) % 360;
    const ccw = /逆时针|ccw|counter/.test(t);
    if (ccw) deg = (360 - deg) % 360;
    return { op: 'rotate', degrees: deg, title: `旋转 ${deg}°` };
  }
  if (/(旋转90度|顺时针90|rotate 90|rotate90)/.test(t)) {
    return { op: 'rotate', degrees: 90, title: '旋转 90°' };
  }
  if (/(旋转180|rotate 180|rotate180)/.test(t)) {
    return { op: 'rotate', degrees: 180, title: '旋转 180°' };
  }
  if (/(逆时针90|ccw90|rotate -90)/.test(t)) {
    return { op: 'rotate', degrees: 270, title: '旋转 270°（逆时针 90°）' };
  }
  return null;
}

/** 音量 */
function matchVolume(s, t) {
  const pct = t.match(/(?:音量|volume)\s*(?:调到|设为|为|是)?\s*(\d+(?:\.\d+)?)\s*(%|percent|百分之)/);
  if (pct) {
    const v = parseFloat(pct[1]) / 100;
    return { op: 'volume', factor: v, title: `音量设为 ${pct[1]}%` };
  }
  const mult = t.match(/(?:音量|volume)\s*(?:调到|设为|为|是)?\s*(\d+(?:\.\d+)?)\s*(x|倍|times)/);
  if (mult) return { op: 'volume', factor: parseFloat(mult[1]), title: `音量设为 ${mult[1]} 倍` };
  if (/(音量调大|调大音量|增大音量|更大声|声音调大|volume up|louder|increase volume)/.test(t)) {
    return { op: 'volume', factor: 2, title: '音量调大（2 倍）' };
  }
  if (/(音量调小|调小音量|减小音量|更小声|声音调小|降低音量|volume down|quieter|decrease volume)/.test(t)) {
    return { op: 'volume', factor: 0.5, title: '音量调小（0.5 倍）' };
  }
  return null;
}

/** 水印（文字为主） */
function matchWatermark(s, t) {
  const isWm = /(加水印|添加水印|加文字|添加文字|文字水印|文字标签|写上|写上文字|打上|字幕?水印|watermark|add text|overlay text|add logo)/.test(t);
  if (!isWm) return null;

  // 提取文本：引号 / 书名号 / "写上XXX" / "写XXX" / text "xxx"
  let text = null;
  let m = t.match(/["“「『《]([^"”」』》]{1,40})["”」』》]/);
  if (m) text = m[1];
  if (!text) {
    m = t.match(/(?:写上|写|打上|add text|text)\s*[:：]?\s*["“「『《]?([\u4e00-\u9fa5a-zA-Z0-9 ]{1,40})["”」』》]?/);
    if (m) text = m[1];
  }
  // 位置
  let position = 'bottom-right';
  for (const [k, v] of Object.entries(POSITIONS)) {
    if (t.includes(k)) {
      position = v;
      break;
    }
  }
  const imageWm = /(图片水印|logo|图标水印)/.test(t);
  return { op: 'watermark', text, position, image: imageWm, title: '添加' + (imageWm ? '图片水印' : '文字水印') };
}

/** 压缩 */
function matchCompress(s, t) {
  if (/(压缩|压小|缩小体积|减小体积|变小|文件更小|compress|reduce size|smaller file|shrink|make smaller)/.test(t)) {
    let crf = 28;
    if (/(高压缩|强力压缩|尽量小|最?小体积|heavily|aggressively)/.test(t)) crf = 32;
    else if (/(低压缩|轻微压缩|尽量保画质|light)/.test(t)) crf = 23;
    return { op: 'compress', crf, title: '压缩视频（减小体积）' };
  }
  return null;
}

/** 降噪 */
function matchDenoise(s, t) {
  if (/(降噪|去噪|去除噪点|去噪点|消除噪点|denoise|reduce noise|remove noise)/.test(t)) {
    return { op: 'denoise', title: '视频/音频降噪' };
  }
  return null;
}

/** 镜像 */
function matchMirror(s, t) {
  if (/(水平翻转|左右翻转|镜像翻转|mirror|flip horizontal|flip horizontally|hflip)/.test(t)) {
    return { op: 'mirror', direction: 'horizontal', title: '水平镜像翻转' };
  }
  if (/(垂直翻转|上下翻转|flip vertical|flip vertically|vflip)/.test(t)) {
    return { op: 'mirror', direction: 'vertical', title: '垂直翻转' };
  }
  return null;
}

/** 封面 / 帧截图 */
function matchThumbnail(s, t) {
  if (/(生成封面|生成缩略图|制作封面|取封面|提取封面|提取一帧|提取帧|提取.{0,8}帧|抓帧|截帧|thumbnail|cover|extract frame|extract image|截个图)/.test(t)) {
    let at = null;
    const m = t.match(/(?:第)?\s*(\d+(?:\.\d+)?)\s*(?:秒|s|s处)?\s*(?:处|位置的?)?(?:的?帧|帧)?/);
    if (m && /帧|秒|截|取/.test(t)) at = parseFloat(m[1]);
    return { op: 'thumbnail', at, title: at != null ? `提取第 ${at} 秒的帧` : '生成封面图' };
  }
  return null;
}

/** GIF */
function matchGif(s, t) {
  if (/(转成gif|转gif|生成gif|做成gif|做gif|convert to gif|make gif|to gif)/.test(t)) {
    return { op: 'gif', title: '转换为 GIF' };
  }
  return null;
}

/** 信息查询 */
function matchInspect(s, t) {
  if (/(这个文件|这个视频|这个音频|它|this file|this video|this audio|media)/.test(t) && /(信息|详情|情况|时长|多长|多久|分辨率|大小|格式|码率|info|duration|how long|details|what format|resolution|size)/.test(t)) {
    return { type: 'inspect', title: '查看媒体信息' };
  }
  if (/^(媒体信息|视频信息|音频信息|文件信息|show info|media info|file info)$/.test(t.trim())) {
    return { type: 'inspect', title: '查看媒体信息' };
  }
  return null;
}

// ---------- 主入口 ----------

const MATCHERS = [
  matchTrim,
  matchGif,          // 先于 convert，避免被 "转gif" 的 convert 吃掉
  matchExtractAudio, // 先于 convert（"转mp3" 可能被 convert 命中，提取音频更具体）
  matchThumbnail,
  matchWatermark,
  matchResolution,
  matchBitrate,
  matchFps,
  matchSpeed,
  matchReverse,
  matchRotate,
  matchVolume,
  matchCompress,
  matchDenoise,
  matchMirror,
  matchMute,
  matchConvert,
];

/**
 * @param {string} input 用户自然语言
 * @returns {object} 解析结果
 */
function parseIntent(input) {
  const s = String(input || '').trim();
  const t = lower(s);
  if (!s) return { type: 'unknown', message: '指令为空', suggestions: SUGGESTIONS };

  const actions = [];
  for (const matcher of MATCHERS) {
    const r = matcher(s, t);
    if (r) actions.push(r);
  }

  // 没有任何具体操作被匹配时，才尝试识别"查询媒体信息"意图
  if (actions.length === 0) {
    const insp = matchInspect(s, t);
    if (insp) return insp;
    return {
      type: 'unknown',
      message: '无法理解这条指令，试试下面这些说法：',
      suggestions: SUGGESTIONS,
    };
  }

  return { type: 'operation', actions, title: actions.map((a) => a.title).join(' + ') };
}

/** 秒 → "mm:ss" / "h:mm:ss" 显示 */
function fmtTime(sec) {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const secs = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  return `${m}:${String(secs).padStart(2, '0')}`;
}

module.exports = { parseIntent, parseTime, firstNumber, fmtTime, FORMATS, RESOLUTIONS, SUGGESTIONS };
