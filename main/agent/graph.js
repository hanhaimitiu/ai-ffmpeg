'use strict';

/**
 * LangGraph Agent 编排：
 *
 *   START → plan → (校验失败，未达上限) → retry → plan …
 *              → (校验通过) → execute → END
 *              → (inspect/unknown/调用失败) → END
 *              → (重试后仍失败) → fail → END
 *
 * plan    : LLM（OpenAI 兼容接口）把自然语言解析为多文件操作计划
 * execute : 计划 → ffmpeg 命令（含 demux 展开、concat 合并），供任务队列执行
 */

const path = require('path');
const { ChatOpenAI } = require('@langchain/openai');
const { StateGraph, START, END, Annotation } = require('@langchain/langgraph');

const { buildSystemPrompt, normalizeOperation } = require('./agent');
const { extractJSON } = require('./llm');
const {
  buildCommand,
  suggestOutputPath,
  uniquePath,
  buildDemuxCommands,
  suggestDemuxOutputs,
  buildConcatCommand,
} = require('./executor');

const MAX_ATTEMPTS = 2;

// ---------- 状态定义 ----------
// 注：TS 的 Annotation<T> 泛型在纯 JS 中写作裸 Annotation 引用

const AgentState = Annotation.Root({
  text: Annotation,                                              // 用户指令
  history: Annotation,                                           // 多轮上下文 [{role, content}]
  files: Annotation,                                             // 已探测文件 [{path, name, info}]
  llmConfig: Annotation,                                         // { baseURL, apiKey, model }
  onNote: Annotation({ reducer: (_o, n) => n, default: () => null }),

  attempt: Annotation({ reducer: (_o, n) => n, default: () => 0 }),
  planError: Annotation({ reducer: (_o, n) => n, default: () => null }),
  pendingPlan: Annotation({ reducer: (_o, n) => n, default: () => null }),

  kind: Annotation({ reducer: (_o, n) => n, default: () => 'pending' }), // operation|inspect|unknown|error
  message: Annotation({ reducer: (_o, n) => n, default: () => null }),
  suggestions: Annotation({ reducer: (_o, n) => n, default: () => [] }),
  tasks: Annotation({ reducer: (_o, n) => n, default: () => [] }),
  warnings: Annotation({ reducer: (_o, n) => n, default: () => [] }),
});

// ---------- 节点 ----------

function buildModel(llmConfig) {
  // @langchain/openai v1.x 无 .bind；调用参数在 invoke 的第二参传入
  return new ChatOpenAI({
    model: llmConfig.model,
    apiKey: llmConfig.apiKey || 'not-needed', // 本地 llama.cpp / Ollama 无需 Key
    temperature: 0.2,
    timeout: 120000,
    configuration: { baseURL: llmConfig.baseURL },
  });
}

function contentToText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((p) => (typeof p === 'string' ? p : (p && p.text) || '')).join('');
  }
  return '';
}

/** plan 节点：调用 LLM 产出结构化计划 */
async function planNode(state) {
  const note = state.onNote || (() => {});
  if (!state.llmConfig || !state.llmConfig.baseURL || !state.llmConfig.model) {
    return {
      kind: 'unknown',
      message: '未配置大模型，无法理解指令。请在「设置」中配置 OpenAI 兼容接口（支持本地 llama.cpp / Ollama 等）。',
      suggestions: ['打开右上角「设置」→ 服务预设 → llama.cpp(本地) → 读取模型 → 保存'],
    };
  }

  const system = buildSystemPrompt(state.files);
  let userText = state.text;
  if (state.planError) {
    userText += `\n\n（注意：上一次解析结果无效：${state.planError}。请修正后重新输出完整 JSON 计划。）`;
  }

  const messages = [['system', system]];
  for (const m of state.history || []) {
    messages.push([m.role === 'assistant' ? 'ai' : 'human', m.content]);
  }
  messages.push(['human', userText]);

  let raw;
  try {
    const res = await buildModel(state.llmConfig).invoke(messages, {
      response_format: { type: 'json_object' },
    });
    raw = contentToText(res.content);
  } catch (e) {
    note(`LLM 调用失败：${e.message}`);
    return { kind: 'error', message: `大模型调用失败：${e.message}` };
  }

  const json = extractJSON(raw);
  if (!json) {
    note('LLM 未返回合法 JSON');
    return { kind: 'error', message: '大模型未返回合法 JSON，请重试。' };
  }

  if (json.type === 'inspect') return { kind: 'inspect', planError: null };
  if (json.type === 'unknown') {
    return {
      kind: 'unknown',
      message: json.message || '该操作不在支持范围内',
      suggestions: Array.isArray(json.suggestions) ? json.suggestions : [],
      planError: null,
    };
  }
  if (json.type !== 'operation') {
    return { kind: 'error', message: '大模型返回结构无法识别，请重试。' };
  }

  const norm = normalizeOperation(json, state.files);
  if (!norm.ok) return { kind: 'invalid', message: norm.error };

  return { kind: 'ready', pendingPlan: norm, planError: null };
}

/** retry 节点：记录失败原因并累计次数，带提示回到 plan */
function retryNode(state) {
  return { attempt: (state.attempt || 0) + 1, planError: state.message };
}

/** execute 节点：规范化计划 → ffmpeg 命令任务列表 */
function executeNode(state) {
  const norm = state.pendingPlan;
  if (!norm) return { kind: 'error', message: '内部状态丢失（pendingPlan）' };

  const tasks = [];
  const warnings = [...(norm.warnings || [])];

  for (const fp of norm.filePlans) {
    const file = state.files[fp.fileIndex];
    const title = fp.actions.map((a) => a.op).join(' + ');
    try {
      if (fp.actions.length === 1 && fp.actions[0].op === 'demux') {
        // 音视频分流：展开为纯视频 + 纯音频两个流拷贝任务
        const track = fp.actions[0].track || 0;
        const audioCodec = ((file.info && file.info.streams) || []).filter((s) => s.type === 'audio')
          .map((s) => s.codec)[track] || 'aac';
        const outs = suggestDemuxOutputs(file.path, audioCodec);
        const cmds = buildDemuxCommands({
          input: file.path,
          videoOutput: outs.videoOutput,
          audioOutput: outs.audioOutput,
          audioTrack: track,
        });
        const dur = (file.info && file.info.duration) || 0;
        tasks.push({ fileIndex: fp.fileIndex, kind: 'demux-video', output: outs.videoOutput, args: cmds.video.args, display: cmds.video.display, title: '分流-纯视频', duration: dur });
        tasks.push({ fileIndex: fp.fileIndex, kind: 'demux-audio', output: outs.audioOutput, args: cmds.audio.args, display: cmds.audio.display, title: '分流-纯音频', duration: dur });
        continue;
      }
      const output = suggestOutputPath(file.path, fp.actions);
      const built = buildCommand({ input: file.path, output, actions: fp.actions, media: file.info });
      tasks.push({ fileIndex: fp.fileIndex, kind: 'operation', output, args: built.args, display: built.display, title, duration: (file.info && file.info.duration) || 0 });
    } catch (e) {
      warnings.push(`${file.name}：${e.message}`);
    }
  }

  if (norm.concat) {
    const idxs = norm.concat.fileIndexes;
    const inputs = idxs.map((i) => state.files[i].path);
    const streams = idxs.map((i) => {
      const info = state.files[i].info;
      const v = info && info.streams && info.streams.find((s) => s.type === 'video');
      const a = info && info.streams && info.streams.find((s) => s.type === 'audio');
      return { hasAudio: !!a, width: v ? v.width : 0 };
    });
    const duration = idxs.reduce((s, i) => s + ((state.files[i].info && state.files[i].info.duration) || 0), 0);
    try {
      const first = state.files[idxs[0]].path;
      const output = uniquePath(path.join(path.dirname(first), `${path.basename(first, path.extname(first))}_merged.mp4`));
      const built = buildConcatCommand({ inputs, output, streams, crf: norm.concat.crf, width: norm.concat.width });
      tasks.push({ fileIndex: idxs[0], kind: 'concat', output, args: built.args, display: built.display, title: `合并 ${idxs.length} 个文件`, duration });
    } catch (e) {
      warnings.push(`合并失败：${e.message}`);
    }
  }

  if (!tasks.length) {
    return { kind: 'error', message: warnings.join('；') || '没有生成任何可执行任务' };
  }

  return { kind: 'operation', tasks, warnings };
}

/** fail 节点：重试耗尽后的最终错误 */
function failNode(state) {
  return {
    kind: 'error',
    message: `大模型返回的计划无法执行：${state.message || ''}。请换个说法重试。`,
  };
}

// ---------- 图 ----------

function routeAfterPlan(state) {
  if (state.kind === 'invalid') {
    return (state.attempt || 0) + 1 < MAX_ATTEMPTS ? 'retry' : 'fail';
  }
  if (state.kind === 'ready') return 'execute';
  return '__end__'; // inspect / unknown / error 直接结束
}

function buildGraph() {
  const graph = new StateGraph(AgentState)
    .addNode('plan', planNode)
    .addNode('retry', retryNode)
    .addNode('execute', executeNode)
    .addNode('fail', failNode);

  graph.addEdge(START, 'plan');
  graph.addConditionalEdges('plan', routeAfterPlan, {
    retry: 'retry',
    execute: 'execute',
    fail: 'fail',
    __end__: END,
  });
  graph.addEdge('retry', 'plan');
  graph.addEdge('execute', END);
  graph.addEdge('fail', END);

  return graph.compile();
}

let compiled = null;

/**
 * 运行 Agent 状态图。
 * @param {object} opts
 * @param {string} opts.text 用户指令
 * @param {Array<{path,name,info}>} opts.files 已探测文件
 * @param {object|null} opts.llmConfig
 * @param {Array<{role,content}>} [opts.history]
 * @param {(msg:string)=>void} [opts.onNote]
 * @returns {Promise<{kind:string, message?:string|null, suggestions?:string[], tasks?:object[], warnings?:string[]}>}
 */
async function runAgentGraph(opts) {
  if (!compiled) compiled = buildGraph();
  const state = {
    text: opts.text,
    files: opts.files,
    llmConfig: opts.llmConfig || null,
    history: opts.history || [],
    onNote: opts.onNote || null,
  };
  const out = await compiled.invoke(state, { recursionLimit: 12 });
  return {
    kind: out.kind,
    message: out.message || null,
    suggestions: out.suggestions || [],
    tasks: out.tasks || [],
    warnings: out.warnings || [],
  };
}

module.exports = { runAgentGraph, buildGraph };
