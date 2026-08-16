'use strict';

/**
 * LLM 调用封装：兼容 OpenAI Chat Completions 接口。
 * 支持 DeepSeek / OpenAI / 通义千问 / Moonshot / Ollama(localhost) 等任意 OpenAI 兼容服务。
 */

/** 常用 OpenAI 兼容服务默认配置（baseURL 到 /v1 为止） */
const LLM_PRESETS = {
  deepseek: { name: 'DeepSeek', baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-chat', keyHint: 'sk-...' },
  openai: { name: 'OpenAI', baseURL: 'https://api.openai.com/v1', model: 'gpt-4o-mini', keyHint: 'sk-...' },
  moonshot: { name: 'Moonshot(月之暗面)', baseURL: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k', keyHint: 'sk-...' },
  qwen: { name: '通义千问', baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus', keyHint: 'sk-...' },
  zhipu: { name: '智谱GLM', baseURL: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash', keyHint: 'id.secret' },
  ollama: { name: 'Ollama(本地)', baseURL: 'http://localhost:11434/v1', model: 'qwen2.5:7b', keyHint: '无需 Key' },
  llamacpp: { name: 'llama.cpp(本地)', baseURL: 'http://localhost:8080/v1', model: 'llama', keyHint: '无需 Key', local: true },
};

/**
 * 查询 OpenAI 兼容服务的模型列表（/v1/models）。
 * @param {string} baseURL
 * @returns {Promise<string[]>} 模型 id 列表；失败返回 []
 */
async function listModels(baseURL) {
  const base = String(baseURL || '').replace(/\/+$/, '');
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const resp = await fetch(`${base}/models`, { signal: controller.signal });
      if (!resp.ok) return [];
      const data = await resp.json();
      const arr = (data.data || data.models || []);
      const ids = arr.map((m) => m.id || m.model || m.name).filter(Boolean);
      return [...new Set(ids)];
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return [];
  }
}

/**
 * 调用 LLM，返回助手文本内容。
 * @param {object} opts
 * @param {object} opts.config { baseURL, apiKey, model }
 * @param {string} opts.system  系统提示词
 * @param {string} opts.user    用户内容
 * @param {{role:'user'|'assistant', content:string}[]} [opts.history] 多轮对话上下文（时间顺序）
 * @param {boolean} [opts.json] 期望 JSON 输出（附带 response_format）
 * @returns {Promise<string>}
 */
async function callLLM({ config, system, user, history, json = false }) {
  const base = String(config.baseURL || '').replace(/\/+$/, '');
  const url = `${base}/chat/completions`;
  const messages = [
    { role: 'system', content: system },
  ];
  if (Array.isArray(history)) {
    for (const m of history) {
      if (m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim()) {
        messages.push({ role: m.role, content: m.content });
      }
    }
  }
  messages.push({ role: 'user', content: user });
  const body = {
    model: config.model,
    messages,
    temperature: 0.2,
  };
  if (json) {
    body.response_format = { type: 'json_object' };
  }
  if (config.apiKey) {
    body.api_key = config.apiKey; // 智谱等通过此字段鉴权
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120000);
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey || ''}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`LLM 请求失败 (HTTP ${resp.status}): ${text.slice(0, 300)}`);
    }
    const data = await resp.json();
    const content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (typeof content !== 'string' || !content.trim()) {
      throw new Error('LLM 返回内容为空');
    }
    return content.trim();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 调用 LLM 并把输出解析为 JSON。
 * @returns {Promise<object|null>} 解析失败返回 null
 */
async function callLLMJSON(opts) {
  const raw = await callLLM({ ...opts, json: true });
  return extractJSON(raw);
}

/** 从模型文本中提取 JSON（容忍 ```json 代码块、前后说明文字） */
function extractJSON(text) {
  let m = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = m ? m[1] : text;
  // 直接试 parse；失败则截取第一个 { 到最后一个 }
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(candidate.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

module.exports = { callLLM, callLLMJSON, extractJSON, listModels, LLM_PRESETS };
