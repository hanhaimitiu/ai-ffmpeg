'use strict';

const { callLLMJSON, callLLM } = require('./llm');
const { parseIntent } = require('./parser');

/**
 * Agent 编排层：用户自然语言 → 执行计划。
 * 解析顺序：
 *   1. 已配置 LLM → 调用大模型解析（附媒体信息与操作 Schema）
 *   2. LLM 失败/未配置 → 内置规则解析器兜底
 */

/** 提供给 LLM 的操作 Schema（与 executor.js 中实现保持一致） */
const OP_SCHEMA = [
  { op: 'convert', params: { targetFormat: 'mp4|mov|avi|mkv|webm|mp3|wav|flac|aac|gif...' }, desc: '转封装/转格式' },
  { op: 'trim', params: { start: '起始秒(可选)', end: '结束秒(可选)', fromEnd: '若只给end且为true表示保留末尾end秒(可选)', removeFromEnd: '若为true表示删除末尾end秒(可选)' }, desc: '裁剪片段' },
  { op: 'extractAudio', params: { targetFormat: 'mp3|wav|flac|aac|m4a|ogg' }, desc: '提取音频' },
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

const INSPECT_DESC = '用户想了解媒体信息/时长/分辨率/大小等 → 返回 {"type":"inspect"}';
const UNKNOWN_DESC = '用户要求做的事不在以上能力范围内 → 返回 {"type":"unknown","message":"简短说明原因","suggestions":["示例指令1","示例指令2"]}';

function buildSystemPrompt(infoSummary) {
  return [
    '你是嵌入在本地 ffmpeg 工具中的智能助手，负责把用户的自然语言指令解析成可执行的 ffmpeg 操作列表。',
    '',
    `当前媒体文件信息（JSON）：\n${JSON.stringify(infoSummary || null, null, 2)}`,
    '',
    '可用操作（一次可组合多个，按顺序执行）：',
    OP_SCHEMA.map((x) => `- ${JSON.stringify(x)}`).join('\n'),
    '',
    '输出规则（必须严格遵守）：',
    '1. 只输出一个 JSON 对象，不要输出任何解释文字或 markdown 代码块标记。',
    `2. 普通操作返回 {"type":"operation","actions":[{"op":"...", ...参数}]}`,
    `3. ${INSPECT_DESC}`,
    `4. ${UNKNOWN_DESC}`,
    '5. 参数必须是数字/字符串/布尔等合法 JSON 值，不能写表达式或占位符。',
    '6. 如果用户没指定格式细节（如输出格式），选择最合理的默认值。',
    '',
    '示例：',
    '用户："把视频转成mp4并压缩" → {"type":"operation","actions":[{"op":"convert","targetFormat":"mp4"},{"op":"compress","crf":28}]}',
    '用户："截取前30秒，提取音频" → {"type":"operation","actions":[{"op":"trim","start":0,"end":30},{"op":"extractAudio","targetFormat":"mp3"}]}',
    '用户："这个视频多长？" → {"type":"inspect"}',
  ].join('\n');
}

/** 校验并规范化单个 action，非法返回 null */
function validateAction(a) {
  if (!a || typeof a !== 'object') return null;
  const op = a.op;
  if (!OP_NAMES.includes(op)) return null;
  const clean = { op };
  const numParams = ['start', 'end', 'width', 'kbps', 'fps', 'speed', 'degrees', 'factor', 'crf', 'at'];
  const strParams = ['targetFormat', 'text', 'position', 'direction'];
  for (const k of numParams) {
    if (a[k] !== undefined && a[k] !== null && isFinite(Number(a[k]))) {
      clean[k] = Number(a[k]);
      if (k === 'degrees') clean[k] = ((clean[k] % 360) + 360) % 360;
    }
  }
  for (const k of strParams) {
    if (a[k] !== undefined && a[k] !== null && String(a[k]).trim()) clean[k] = String(a[k]).trim();
  }
  for (const k of ['fromEnd', 'removeFromEnd', 'image']) {
    if (a[k] !== undefined) clean[k] = Boolean(a[k]);
  }
  // 缺关键参数的 op 视为非法
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
  };
  if (required[op] && required[op].some((k) => clean[k] === undefined)) return null;
  return clean;
}

/**
 * 把自然语言解析为执行计划。
 * @param {string} text 用户指令
 * @param {object|null} mediaInfo 媒体信息摘要（传给 LLM 用）
 * @param {object|null} llmConfig { baseURL, apiKey, model }，null 表示未配置
 * @param {(msg:string)=>void} [onNote] 日志回调
 * @returns {Promise<{plan:object, source:'llm'|'rules'|'error', error?:string}>}
 */
async function planFromText(text, mediaInfo, llmConfig, onNote) {
  const note = onNote || (() => {});
  const fallback = () => {
    const r = parseIntent(text);
    return { plan: r, source: 'rules' };
  };

  if (llmConfig && llmConfig.baseURL && llmConfig.model) {
    try {
      const system = buildSystemPrompt(mediaInfo);
      const json = await callLLMJSON({ config: llmConfig, system, user: text });
      if (!json) throw new Error('LLM 未返回合法 JSON');

      if (json.type === 'inspect') {
        return { plan: { type: 'inspect', title: '查看媒体信息' }, source: 'llm' };
      }
      if (json.type === 'unknown') {
        return {
          plan: { type: 'unknown', message: json.message || '该操作不在支持范围内', suggestions: json.suggestions || [] },
          source: 'llm',
        };
      }
      if (json.type === 'operation' && Array.isArray(json.actions)) {
        const actions = json.actions.map(validateAction).filter(Boolean);
        if (actions.length === 0) {
          note('LLM 返回的操作无法执行，回退本地解析器');
          return fallback();
        }
        return {
          plan: { type: 'operation', actions, title: actions.map((a) => a.title || a.op).join(' + ') },
          source: 'llm',
        };
      }
      note('LLM 返回结构无法识别，回退本地解析器');
      return fallback();
    } catch (e) {
      note(`LLM 解析失败（${e.message}），回退本地解析器`);
      return fallback();
    }
  }
  return fallback();
}

module.exports = { planFromText, buildSystemPrompt, validateAction, OP_SCHEMA };
