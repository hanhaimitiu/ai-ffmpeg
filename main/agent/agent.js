'use strict';

/**
 * Agent 领域层：操作 Schema、action 校验、LLM 输出规范化、系统提示词。
 * 仅纯函数；编排由 graph.js（LangGraph）完成。
 */

/** 提供给 LLM 的操作 Schema（与 executor.js 中实现保持一致） */
const OP_SCHEMA = [
  { op: 'convert', params: { targetFormat: 'mp4|mov|avi|mkv|webm|mp3|wav|flac|aac|gif...' }, desc: '转封装/转格式' },
  { op: 'trim', params: { start: '起始秒(可省略)', end: '结束秒(可省略)', fromEnd: 'true 表示保留末尾end秒(可选)', removeFromEnd: 'true 表示删除末尾end秒(可选)' }, desc: '裁剪片段' },
  { op: 'extractAudio', params: { targetFormat: 'mp3|wav|flac|aac|m4a|ogg', track: '提取第几条音轨（可省略，默认0，见流列表audioIndex）' }, desc: '提取音频（可指定音轨）' },
  { op: 'selectAudioTrack', params: { track: '选用第几条音轨（从0开始，对应流列表中的 audioIndex）' }, desc: '选择音轨（输出保留该音轨+视频）' },
  { op: 'selectVideoTrack', params: { track: '选用第几条视频轨（从0开始，对应流列表中的 videoIndex）' }, desc: '选择视频轨' },
  { op: 'demux', params: {}, desc: '音视频分流：拆成纯视频+纯音频两个文件。必须单独使用，不能与其他操作组合' },
  { op: 'mute', params: {}, desc: '移除/静音音频轨' },
  { op: 'resolution', params: { width: '目标宽度像素，如1920' }, desc: '调整分辨率(按宽度等比缩放)' },
  { op: 'bitrate', params: { kbps: '目标视频码率kbps' }, desc: '调整视频码率' },
  { op: 'fps', params: { fps: '目标帧率' }, desc: '调整帧率' },
  { op: 'speed', params: { speed: '倍速数值，如2(快)、0.5(慢)' }, desc: '变速' },
  { op: 'reverse', params: {}, desc: '倒放' },
  { op: 'rotate', params: { degrees: '90|180|270' }, desc: '旋转' },
  { op: 'volume', params: { factor: '音量倍率，1=原声' }, desc: '调整音量' },
  { op: 'watermark', params: { text: '文字内容', position: 'top-left|top-right|bottom-left|bottom-right|center|top|bottom', image: '是否图片水印(可选)' }, desc: '添加文字水印' },
  { op: 'compress', params: { crf: '压缩强度18~32，越大体积越小画质越差' }, desc: '压缩(CRF编码)' },
  { op: 'denoise', params: {}, desc: '视频降噪(hqdn3d)' },
  { op: 'mirror', params: { direction: 'horizontal|vertical' }, desc: '镜像翻转' },
  { op: 'thumbnail', params: { at: '取帧时间点(秒)' }, desc: '生成封面/提取某一帧' },
  { op: 'gif', params: {}, desc: '转成GIF动图' },
];

const OP_NAMES = OP_SCHEMA.map((x) => x.op);

const INSPECT_DESC = '用户想了解媒体信息/时长/分辨率/大小/有哪些音轨等 → 返回 {"type":"inspect"}';
const UNKNOWN_DESC = '用户要求做的事不在以上能力范围内 → 返回 {"type":"unknown","message":"简短说明原因","suggestions":["示例指令1","示例指令2"]}';

/** 单文件流列表的可读摘要（给 LLM 看） */
function describeStreams(info) {
  if (!info || !Array.isArray(info.streams) || !info.streams.length) return '（无流信息）';
  return info.streams
    .map((s) => {
      if (s.type === 'video') {
        return `- #${s.index} 视频 ${s.codec} ${s.width}x${s.height}${s.fps ? ` ${s.fps}fps` : ''}（videoIndex=${s.videoIndex}）${s.language ? ` 语言:${s.language}` : ''}`;
      }
      if (s.type === 'audio') {
        return `- #${s.index} 音频 ${s.codec}${s.channels ? ` ${s.channels}声道` : ''}（audioIndex=${s.audioIndex}）${s.language ? ` 语言:${s.language}` : ''}${s.title ? ` 标题:${s.title}` : ''}`;
      }
      return `- #${s.index} ${s.type} ${s.codec || ''}${s.language ? ` 语言:${s.language}` : ''}`;
    })
    .join('\n');
}

/**
 * 构建系统提示词（多文件 + 流感知）。
 * @param {Array<{name:string, info:object}>} files
 */
function buildSystemPrompt(files) {
  const fileList = (files || [])
    .map((f, i) => {
      const d = f.info ? `${Math.round((f.info.duration || 0))}s ${f.info.formatName || ''}` : '未探测';
      return `[${i}] ${f.name}：${d}\n${describeStreams(f.info)}`;
    })
    .join('\n\n');

  return [
    '你是嵌入在本地 ffmpeg 工具中的智能助手，负责把用户的自然语言指令解析成可执行的 ffmpeg 操作计划。',
    '',
    `当前会话中的媒体文件（含完整流列表，音轨/视频轨序号以 audioIndex/videoIndex 为准）：\n${fileList}`,
    '',
    '可用操作（actions 中每个元素一个步骤，按顺序执行，可组合）：',
    OP_SCHEMA.map((x) => `- ${JSON.stringify({ op: x.op, ...x.params })} ${x.desc}`).join('\n'),
    '',
    '输出规则（必须严格遵守）：',
    '1. 只输出一个 JSON 对象，不要输出任何解释文字或 markdown 代码块标记。',
    '2. **不同文件做不同操作**：用 plans 数组，每个文件一项，file 填文件名或 [序号]：{"type":"operation","plans":[{"file":"a.mp4","actions":[...]},{"file":"b.mp4","actions":[...]}]}',
    '3. 所有文件做相同操作：直接 {"type":"operation","actions":[...]}（应用到全部文件）。',
    '4. **合并多个文件**：{"type":"operation","concat":{"files":["a.mp4","b.mp4"],"crf":28,"width":1280},"plans":[]}（crf/width 可省略；files 必须是上面列表中的文件）。',
    `5. ${INSPECT_DESC}`,
    `6. ${UNKNOWN_DESC}`,
    '7. 参数必须是数字/字符串/布尔等合法 JSON 值。',
    '8. **用户一句话可能包含多个步骤，每个步骤一个 action，一个都不能少。**',
    '9. trim 必须给出 start 或 end（数字秒）。',
    '10. 用户提到「第N条音轨」「国语/英语音轨」「主音轨」等时，参照流列表选 track：提取用 extractAudio 的 track 参数，换轨保留视频用 selectAudioTrack。',
    '11. demux（音视频分流）必须单独一个 action，不能和其他操作组合。',
    '12. 这是多轮对话：结合历史理解「再压缩一点」等指代，但本次输出必须是完整计划（不是增量）。',
    '',
    '示例：',
    '用户："把国语配音提取出来" → {"type":"operation","actions":[{"op":"extractAudio","targetFormat":"m4a","track":0}]}',
    '用户："换成英语音轨，转成720p" → {"type":"operation","actions":[{"op":"selectAudioTrack","track":1},{"op":"resolution","width":1280}]}',
    '用户："把video.mp4音视频分流，clip.mp4转720p" → {"type":"operation","plans":[{"file":"video.mp4","actions":[{"op":"demux"}]},{"file":"clip.mp4","actions":[{"op":"resolution","width":1280}]}]}',
    '用户："前两个视频合并成一个" → {"type":"operation","concat":{"files":["a.mp4","b.mp4"]},"plans":[]}',
    '用户："这个视频有哪些音轨？" → {"type":"inspect"}',
  ].join('\n');
}

/** 校验并规范化单个 action，非法返回 null */
function validateAction(a) {
  if (!a || typeof a !== 'object') return null;
  const op = a.op;
  if (!OP_NAMES.includes(op)) return null;
  const clean = { op };
  const numParams = ['start', 'end', 'width', 'kbps', 'fps', 'speed', 'degrees', 'factor', 'crf', 'at', 'track'];
  const strParams = ['targetFormat', 'text', 'position', 'direction'];
  for (const k of numParams) {
    if (a[k] !== undefined && a[k] !== null && isFinite(Number(a[k]))) {
      clean[k] = Number(a[k]);
      if (k === 'degrees') clean[k] = ((clean[k] % 360) + 360) % 360;
      if (k === 'track' && (!Number.isInteger(clean[k]) || clean[k] < 0)) return null;
    }
  }
  for (const k of strParams) {
    if (a[k] !== undefined && a[k] !== null && String(a[k]).trim()) clean[k] = String(a[k]).trim();
  }
  for (const k of ['fromEnd', 'removeFromEnd', 'image']) {
    if (a[k] !== undefined) clean[k] = Boolean(a[k]);
  }
  const required = {
    convert: ['targetFormat'],
    extractAudio: ['targetFormat'],
    resolution: ['width'],
    bitrate: ['kbps'],
    fps: ['fps'],
    speed: ['speed'],
    rotate: ['degrees'],
    volume: ['factor'],
    compress: ['crf'],
    mirror: ['direction'],
    selectAudioTrack: ['track'],
    selectVideoTrack: ['track'],
  };
  if (op === 'trim' && clean.start === undefined && clean.end === undefined) return null;
  if (required[op] && required[op].some((k) => clean[k] === undefined)) return null;
  return clean;
}

/** 操作列表是否"有实际内容"（避免空操作命令） */
function hasEffectiveActions(actions) {
  return actions.some((a) => {
    if (['mute', 'reverse', 'gif', 'denoise', 'thumbnail', 'demux'].includes(a.op)) return true;
    return Object.keys(a).length > 1; // 除 op 外还有参数
  });
}

/** 文件引用匹配：支持 [序号]、序号、完整文件名、去扩展名、包含匹配 */
function matchFile(ref, files) {
  if (ref == null) return -1;
  let s = String(ref).trim();
  // "[1]" / "1" 都按序号处理
  const br = s.match(/^\[(\d+)\]$/);
  if (br) s = br[1];
  if (/^\d+$/.test(s)) {
    const i = parseInt(s, 10);
    if (i >= 0 && i < files.length) return i;
  }
  const lower = s.toLowerCase();
  let idx = files.findIndex((f) => f.name.toLowerCase() === lower);
  if (idx >= 0) return idx;
  idx = files.findIndex((f) => f.name.toLowerCase().replace(/\.[^.]+$/, '') === lower.replace(/\.[^.]+$/, ''));
  if (idx >= 0) return idx;
  return files.findIndex((f) => f.name.toLowerCase().includes(lower) && lower.length >= 2);
}

/**
 * 规范化 LLM 的 operation 输出：plans/flat-actions/concat 三种形态 → 统一结构。
 * @returns {{ok:true, filePlans:Array<{fileIndex:number,actions:object[]}>, concat?:object, warnings:string[]}
 *          |{ok:false, error:string}}
 */
function normalizeOperation(json, files) {
  const warnings = [];

  // concat 部分
  let concat = null;
  if (json.concat && Array.isArray(json.concat.files)) {
    const idxs = json.concat.files.map((f) => matchFile(f, files));
    const bad = idxs.filter((i) => i < 0).length;
    if (bad) return { ok: false, error: `concat 中有 ${bad} 个文件无法识别，请使用文件名或 [序号] 引用当前文件列表` };
    const uniq = [...new Set(idxs)];
    if (uniq.length < 2) return { ok: false, error: '合并（concat）至少需要引用两个不同的文件' };
    concat = {
      fileIndexes: idxs,
      crf: isFinite(Number(json.concat.crf)) ? Number(json.concat.crf) : undefined,
      width: isFinite(Number(json.concat.width)) ? Number(json.concat.width) : undefined,
    };
  }

  // plans / flat actions
  let filePlans = [];
  if (Array.isArray(json.plans) && json.plans.length) {
    for (const p of json.plans) {
      const idx = matchFile(p.file, files);
      if (idx < 0) return { ok: false, error: `计划中的文件「${p.file}」无法识别，请引用当前文件列表中的文件名或 [序号]` };
      const actions = Array.isArray(p.actions) ? p.actions.map(validateAction).filter(Boolean) : [];
      if (!actions.length) return { ok: false, error: `文件「${files[idx].name}」的操作无效（缺少必要参数）` };
      if (actions.some((a) => a.op === 'demux') && actions.length > 1) {
        return { ok: false, error: 'demux（音视频分流）不能与其他操作组合，请单独成一条' };
      }
      if (!hasEffectiveActions(actions)) return { ok: false, error: '操作缺少必要参数' };
      filePlans.push({ fileIndex: idx, actions });
    }
  } else if (Array.isArray(json.actions) && json.actions.length) {
    const actions = json.actions.map(validateAction).filter(Boolean);
    if (!actions.length) return { ok: false, error: '解析出的操作无法执行（缺少必要参数或操作名不识别）' };
    if (actions.some((a) => a.op === 'demux') && actions.length > 1) {
      return { ok: false, error: 'demux（音视频分流）不能与其他操作组合，请单独成一条' };
    }
    if (!hasEffectiveActions(actions)) return { ok: false, error: '操作缺少必要参数' };
    // flat：应用到全部文件
    filePlans = files.map((_f, i) => ({ fileIndex: i, actions: [...actions] }));
    if (files.length > 1) warnings.push('操作将应用到全部文件');
  } else if (!concat) {
    return { ok: false, error: '返回的计划为空（没有 actions 也没有 plans/concat）' };
  }

  return { ok: true, filePlans, concat: concat || null, warnings };
}

module.exports = { OP_SCHEMA, OP_NAMES, buildSystemPrompt, validateAction, hasEffectiveActions, normalizeOperation, matchFile };
