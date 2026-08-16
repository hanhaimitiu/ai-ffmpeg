'use strict';

const { callLLMJSON } = require('./llm');

/**
 * Agent 编排层：用户自然语言 → 执行计划。
 * 仅通过大模型解析（OpenAI 兼容接口）。未配置或调用失败时明确报错，
 * 不做离线规则解析兜底。
 */

/** 提供给 LLM 的操作 Schema（与 executor.js 中实现保持一致） */
const OP_SCHEMA = [
  { op: 'convert', params: { targetFormat: 'mp4|mov|avi|mkv|webm|mp3|wav|flac|aac|gif...' }, desc: '转封装/转格式' },
  { op: 'trim', params: { start: '起始秒(可省略，省略表示从0开始)', end: '结束秒(可省略，省略表示到结尾)', fromEnd: 'true 表示保留末尾end秒(可选)', removeFromEnd: 'true 表示删除末尾end秒(可选)' }, desc: '裁剪片段' },
  { op: 'extractAudio', params: { targetFormat: 'mp3|wav|flac|aac|m4a|ogg' }, desc: '提取音频（输出只有音频，会忽略视频类操作）' },
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
    '7. **用户一句话可能包含多个步骤，必须把每个步骤都解析为一个 action，全部放进 actions 数组，一个都不能少。**',
    '8. trim 必须给出 start 或 end（数字秒）。',
    '9. 这是多轮对话：对话历史里可能有之前的指令和执行结果，用户可能说「再压缩一点」「上一步改成1080p」这类指代之前内容的话，要结合历史理解其完整意图。但本次输出必须是**完整的操作列表**（从头描述这次要做什么，不是增量补丁）。',
    '',
    '示例：',
    '用户："把视频转成mp4并压缩" → {"type":"operation","actions":[{"op":"convert","targetFormat":"mp4"},{"op":"compress","crf":28}]}',
    '用户："截取前30秒，转720p，提取音频为wav" → {"type":"operation","actions":[{"op":"trim","start":0,"end":30},{"op":"resolution","width":1280},{"op":"extractAudio","targetFormat":"wav"}]}',
    '用户："从10秒到30秒，加速2倍，加水印" → {"type":"operation","actions":[{"op":"trim","start":10,"end":30},{"op":"speed","speed":2},{"op":"watermark","text":"我的视频","position":"bottom-right"}]}',
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
    trim: [] // trim 至少要有 start 或 end 之一
  };
  if (op === 'trim' && clean.start === undefined && clean.end === undefined) return null;
  if (required[op] && required[op].some((k) => clean[k] === undefined)) return null;
  return clean;
}

/** 操作列表是否"有实际内容"（避免空操作命令） */
function hasEffectiveActions(actions) {
  return actions.some((a) => {
    if (a.op === 'mute' || a.op === 'reverse' || a.op === 'gif' || a.op === 'denoise' || a.op === 'thumbnail') return true;
    return Object.keys(a).length > 1; // 除 op 外还有参数
  });
}

/**
 * 把自然语言解析为执行计划。
 * @param {string} text 用户指令
 * @param {object|null} mediaInfo 媒体信息摘要（传给 LLM 用）
 * @param {object|null} llmConfig { baseURL, apiKey, model }，null 表示未配置
 * @param {(msg:string)=>void} [onNote] 日志回调
 * @param {{role:'user'|'assistant', content:string}[]} [history] 多轮对话上下文
 * @returns {Promise<{plan:object, source:'llm'|'error', error?:string}>}
 */
async function planFromText(text, mediaInfo, llmConfig, onNote, history) {
  const note = onNote || (() => {});
  const chatHistory = Array.isArray(history) ? history.slice(-6) : [];

  if (!llmConfig || !llmConfig.baseURL || !llmConfig.model) {
    return {
      plan: {
        type: 'unknown',
        message: '未配置大模型，无法理解指令。请在「设置」中配置 OpenAI 兼容接口（支持本地 llama.cpp / Ollama 等）。',
        suggestions: ['打开右上角「设置」→ 服务预设 → llama.cpp(本地) → 读取模型 → 保存'],
      },
      source: 'error',
    };
  }

  const system = buildSystemPrompt(mediaInfo);

  // 最多尝试 2 次：首次结果若无效（空操作/结构异常），带提示重试一次
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const userText = attempt === 2
        ? `${text}\n\n（注意：上一次解析结果无效或不完整。用户指令里的每一个步骤都必须对应一个 action，必须为 trim 提供 start 或 end，再次输出完整 JSON。）`
        : text;
      const json = await callLLMJSON({ config: llmConfig, system, user: userText, history: chatHistory });
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
          note(`第 ${attempt} 次解析结果无可执行操作，${attempt === 1 ? '重试' : '放弃'}`);
          if (attempt === 1) continue;
          return { plan: { type: 'error', message: '大模型未返回可执行的操作，请换个说法重试。' }, source: 'error' };
        }
        if (!hasEffectiveActions(actions)) {
          note(`第 ${attempt} 次解析出空操作，${attempt === 1 ? '重试' : '放弃'}`);
          if (attempt === 1) continue;
          return { plan: { type: 'error', message: '大模型返回的操作缺少必要参数，请换个说法重试。' }, source: 'error' };
        }
        return {
          plan: { type: 'operation', actions, title: actions.map((a) => a.op).join(' + ') },
          source: 'llm',
        };
      }
      note(`第 ${attempt} 次返回结构无法识别，${attempt === 1 ? '重试' : '放弃'}`);
      if (attempt === 1) continue;
      return { plan: { type: 'error', message: '大模型返回结构无法识别，请重试。' }, source: 'error' };
    } catch (e) {
      note(`第 ${attempt} 次 LLM 调用失败（${e.message}），${attempt === 1 ? '重试' : '放弃'}`);
      if (attempt === 1) continue;
      return {
        plan: { type: 'error', message: `大模型调用失败：${e.message}` },
        source: 'error',
      };
    }
  }
  // 不可达
  return { plan: { type: 'error', message: '解析失败' }, source: 'error' };
}

module.exports = { planFromText, buildSystemPrompt, validateAction, OP_SCHEMA };
