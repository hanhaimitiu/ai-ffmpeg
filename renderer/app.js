'use strict';

// ---------- 状态 ----------

const state = {
  files: [],            // { path, name, size, ext, info }
  selectedPath: null,
  ffmpegOk: false,
  settings: {},
  agentRunning: false,
};

const $ = (id) => document.getElementById(id);

// ---------- 工具 ----------

function fmtSize(bytes) {
  if (!bytes) return '-';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n >= 100 ? 0 : 1)} ${u[i]}`;
}

function fmtDur(sec) {
  if (sec == null || isNaN(sec)) return '-';
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
  return `${m}:${String(ss).padStart(2, '0')}`;
}

function toast(msg, kind = 'info') {
  const wrap = $('toast-wrap');
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  wrap.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transition = 'opacity .3s';
    setTimeout(() => el.remove(), 300);
  }, 3500);
}

function esc(s) {
  const d = document.createElement('div');
  d.textContent = s == null ? '' : String(s);
  return d.innerHTML;
}

// ---------- 文件列表 ----------

function addFiles(paths) {
  for (const p of paths) {
    if (state.files.some((f) => f.path === p)) continue;
    const name = p.split(/[\\/]/).pop();
    const ext = (name.includes('.') ? name.split('.').pop() : '').toLowerCase();
    state.files.push({ path: p, name, ext, info: null });
  }
  if (!state.selectedPath && state.files.length) selectFile(state.files[0].path);
  renderFiles();
}

function removeFile(p) {
  const idx = state.files.findIndex((f) => f.path === p);
  if (idx < 0) return;
  state.files.splice(idx, 1);
  if (state.selectedPath === p) {
    state.selectedPath = state.files.length ? state.files[0].path : null;
    renderMediaInfo(state.selectedPath ? null : undefined);
    if (state.selectedPath) probeSelected();
  }
  renderFiles();
}

function selectFile(p) {
  state.selectedPath = p;
  renderFiles();
  probeSelected();
}

async function probeSelected() {
  const f = state.files.find((x) => x.path === state.selectedPath);
  if (!f) return;
  renderMediaInfo(null, '读取媒体信息中…');
  try {
    const r = await window.api.probeMedia(f.path);
    if (!r.ok) {
      renderMediaInfo(null, `⚠ 无法读取：${r.error}`);
      return;
    }
    f.info = r.summary;
    renderMediaInfo(r.summary);
    renderFiles();
  } catch (e) {
    renderMediaInfo(null, `⚠ ${e.message}`);
  }
}

function renderFiles() {
  const list = $('file-list');
  if (!state.files.length) {
    list.innerHTML = '<div class="empty-hint">点击「+ 添加」选择视频或音频文件</div>';
    return;
  }
  list.innerHTML = state.files.map((f) => {
    const isV = f.info && f.info.video && f.info.video.hasVideo;
    const ico = isV ? '▣' : f.info && f.info.audio && f.info.audio.hasAudio ? '♪' : '▧';
    const sub = f.info ? `${fmtDur(f.info.duration)} · ${fmtSize(f.info.size)}` : '未探测';
    return `<div class="file-item ${f.path === state.selectedPath ? 'selected' : ''}" data-path="${esc(f.path)}">
      <span class="file-ico">${ico}</span>
      <div class="file-meta">
        <div class="file-name" title="${esc(f.name)}">${esc(f.name)}</div>
        <div class="file-sub">${sub}</div>
      </div>
      <button class="file-x" data-del="${esc(f.path)}">✕</button>
    </div>`;
  }).join('');
}

// ---------- 媒体信息 ----------

function renderMediaInfo(info, loading) {
  const el = $('media-info');
  if (loading) {
    el.innerHTML = `<div class="empty-hint">${loading}</div>`;
    return;
  }
  if (info === undefined) {
    el.innerHTML = '<div class="empty-hint">选择文件后显示时长、分辨率、码率等信息</div>';
    return;
  }
  if (!info) {
    el.innerHTML = '<div class="empty-hint">未选择文件</div>';
    return;
  }
  const cells = [
    ['时长', fmtDur(info.duration)],
    ['大小', fmtSize(info.size)],
    ['格式', (info.formatName || '-').toUpperCase()],
    ['码率', info.bitRate ? `${(info.bitRate / 1000).toFixed(0)} kbps` : '-'],
  ];
  if (info.video && info.video.hasVideo) {
    cells.push(['分辨率', `${info.video.width}×${info.video.height}`]);
    cells.push(['视频编码', info.video.codec || '-']);
    cells.push(['帧率', info.video.fps != null ? `${info.video.fps} fps` : '-']);
  }
  if (info.audio && info.audio.hasAudio) {
    cells.push(['音频编码', info.audio.codec || '-']);
    cells.push(['声道', info.audio.channels ? `${info.audio.channels} 声道` : '-']);
  }
  el.innerHTML = `<div class="info-grid">${cells.map(([k, v]) =>
    `<div class="info-cell"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div></div>`).join('')}</div>`;
}

// ---------- ffmpeg 状态 ----------

async function refreshFFmpegStatus() {
  const status = $('ffmpeg-status');
  const text = $('ffmpeg-status-text');
  const dot = status.querySelector('.dot');
  try {
    const r = await window.api.resolveFFmpeg();
    state.ffmpegOk = r.ok;
    if (r.ok) {
      dot.className = 'dot ok';
      text.textContent = `ffmpeg 已就绪 · ${r.version}`;
    } else {
      dot.className = 'dot err';
      text.textContent = '未找到 ffmpeg，请到设置中配置';
    }
  } catch (e) {
    dot.className = 'dot err';
    text.textContent = '检测失败: ' + e.message;
  }
}

// ---------- 任务 ----------

function renderTasks(tasks) {
  const list = $('task-list');
  const { running, queue, history } = tasks;
  const all = [running, ...queue, ...history].filter(Boolean);
  $('queue-info').textContent = all.length ? `${all.filter((t) => t.status === 'running' || t.status === 'queued').length} 进行中 / ${all.length} 总数` : '';

  if (!all.length) {
    list.innerHTML = '<div class="empty-hint">暂无任务</div>';
    return;
  }
  list.innerHTML = all.map((t) => {
    const pct = t.status === 'done' ? 100 : t.status === 'error' || t.status === 'cancelled' ? 0 : Math.round((t.progress || 0) * 100);
    const barCls = t.status === 'done' ? 'done-bar' : t.status === 'error' || t.status === 'cancelled' ? 'err-bar' : '';
    const cancelBtn = (t.status === 'running' || t.status === 'queued') ? `<button class="task-cancel" data-cancel="${t.id}">取消</button>` : '';
    const out = t.output ? `<div class="out">→ ${esc(t.output)}</div>` : '';
    const err = t.error ? `<div class="out" style="color:var(--red)">${esc(t.error)}</div>` : '';
    return `<div class="task-item">
      <div class="task-top">
        <div class="task-title" title="${esc(t.title)}">${esc(t.title)}</div>
        <span class="task-status status-${t.status}">${statusLabel(t.status)}</span>
      </div>
      ${t.command ? `<div class="task-cmd" title="${esc(t.command)}">${esc(t.command)}</div>` : ''}
      <div class="task-bar ${barCls}"><div style="width:${pct}%"></div></div>
      <div class="task-foot">
        <div style="flex:1;min-width:0">${out}${err}</div>
        ${cancelBtn}
      </div>
    </div>`;
  }).join('');
}

function statusLabel(s) {
  return { queued: '排队中', running: '处理中', done: '完成', error: '失败', cancelled: '已取消' }[s] || s;
}

// ---------- Agent ----------

function addChatMsg(role, html) {
  const chat = $('chat');
  const div = document.createElement('div');
  div.className = `msg ${role}`;
  div.innerHTML = `<div class="bubble">${html}</div>`;
  chat.appendChild(div);
  chat.scrollTop = chat.scrollHeight;
  return div;
}

function updateAgentMode() {
  const s = state.settings.llm;
  const el = $('agent-mode');
  if (s && s.baseURL && s.model) {
    el.textContent = `LLM: ${s.model}`;
    el.style.color = 'var(--green)';
  } else {
    el.textContent = '未配置大模型';
    el.style.color = 'var(--yellow)';
  }
}

async function sendAgent() {
  const input = $('agent-input');
  const text = input.value.trim();
  if (!text || state.agentRunning) return;
  if (!state.files.length) {
    toast('请先添加媒体文件', 'err');
    return;
  }
  if (!state.ffmpegOk) {
    toast('ffmpeg 不可用，请先在设置中配置', 'err');
    return;
  }
  const llmCfg = state.settings.llm;
  if (!llmCfg || !llmCfg.baseURL || !llmCfg.model) {
    addChatMsg('user', esc(text));
    addChatMsg('agent', '⚠ 尚未配置大模型，无法理解指令。请打开右上角「设置」→ 配置大模型（支持本地 llama.cpp / Ollama / DeepSeek 等 OpenAI 兼容接口）。');
    input.value = '';
    return;
  }

  addChatMsg('user', esc(text));
  input.value = '';
  state.agentRunning = true;
  $('btn-agent-send').disabled = true;
  const thinking = addChatMsg('agent', '<span style="opacity:.6">正在理解你的指令…</span>');

  try {
    const targets = state.files.map((f) => f.path);
    const r = await window.api.runAgent(text, targets);

    if (r.type === 'error') {
      thinking.querySelector('.bubble').innerHTML = `⚠ ${esc(r.error)}`;
      return;
    }

    const html = r.results.map((res) => renderAgentResult(res)).join('');
    thinking.querySelector('.bubble').innerHTML = html || '（无结果）';
  } catch (e) {
    thinking.querySelector('.bubble').innerHTML = `⚠ 执行出错：${esc(e.message)}`;
  } finally {
    state.agentRunning = false;
    $('btn-agent-send').disabled = false;
  }
}

function renderAgentResult(res) {
  const name = res.filePath.split(/[\\/]/).pop();
  if (res.kind === 'inspect') {
    const i = res.info;
    const lines = [
      `▧ <b>${esc(name)}</b>`,
      `格式：${(i.formatName || '-').toUpperCase()} · 时长：${fmtDur(i.duration)} · 大小：${fmtSize(i.size)}`,
    ];
    if (i.video && i.video.hasVideo) lines.push(`视频：${i.video.width}×${i.video.height} · ${i.video.codec} · ${i.video.fps} fps`);
    if (i.audio && i.audio.hasAudio) lines.push(`音频：${i.audio.codec} · ${i.audio.channels} 声道`);
    lines.push(`码率：${i.bitRate ? (i.bitRate / 1000).toFixed(0) + ' kbps' : '-'}`);
    return `<div style="margin-bottom:10px">${lines.join('<br>')}</div>`;
  }
  if (res.kind === 'unknown' || (res.kind === 'error' && res.ok === false && res.suggestions)) {
    const sugg = (res.suggestions || []).map((s) => `<span class="sugg" data-fill="${esc(s)}">${esc(s)}</span>`).join('');
    return `<div style="margin-bottom:10px">⚠ <b>${esc(name)}</b>：${esc(res.message || res.error)}<br>${sugg}</div>`;
  }
  if (res.ok === false) {
    return `<div style="margin-bottom:10px">⚠ <b>${esc(name)}</b>：${esc(res.error)}</div>`;
  }
  // operation 已入队
  const src = '大模型';
  return `<div style="margin-bottom:12px">
    <div>✅ <b>${esc(name)}</b> — 已加入任务队列（${src}解析）</div>
    <div style="font-size:12px;color:var(--muted);margin-top:2px">${esc(res.plan ? res.plan.title : '')}</div>
    <div class="cmd-box">${esc(res.command || '')}</div>
  </div>`;
}

// ---------- 操作面板 ----------

const OP_PRESETS = {
  'convert-mp4': [{ op: 'convert', targetFormat: 'mp4' }],
  'extract-audio': [{ op: 'extractAudio', targetFormat: 'mp3' }],
  compress: [{ op: 'compress', crf: 28 }],
  '720p': [{ op: 'resolution', width: 1280 }],
  '1080p': [{ op: 'resolution', width: 1920 }],
  gif: [{ op: 'gif' }],
  mute: [{ op: 'mute' }],
  reverse: [{ op: 'reverse' }],
  cover: [{ op: 'thumbnail' }],
  denoise: [{ op: 'denoise' }],
};

async function runOps(ops) {
  const f = state.files.find((x) => x.path === state.selectedPath);
  if (!f) {
    toast('请先选择文件', 'err');
    return;
  }
  try {
    const r = await window.api.runOperation(f.path, ops);
    if (!r.ok) toast(`操作失败：${r.error}`, 'err');
    else toast(`已加入任务队列 → ${r.output}`);
  } catch (e) {
    toast(`操作失败：${e.message}`, 'err');
  }
}

async function runCustom() {
  const text = $('custom-op').value.trim();
  if (!text) return;
  const f = state.files.find((x) => x.path === state.selectedPath);
  if (!f) { toast('请先选择文件', 'err'); return; }
  // 走 Agent 解析预览
  try {
    const r = await window.api.previewAgent(text, f.path);
    if (r.type === 'inspect') {
      toast('这是查询类指令，请到智能助手发送', 'err');
      return;
    }
    if (r.type === 'unknown') {
      toast('无法理解该指令：' + (r.message || ''), 'err');
      return;
    }
    if (r.type === 'error') { toast('解析失败：' + r.error, 'err'); return; }
    addChatMsg('agent', `自定义操作「${esc(text)}」解析为：<b>${esc(r.plan.title)}</b><div class="cmd-box">${esc(r.command)}</div>`);
    await runOps(r.plan.actions);
  } catch (e) {
    toast('解析失败：' + e.message, 'err');
  }
}

// ---------- 设置 ----------

function openSettings() {
  const s = state.settings;
  $('set-ffmpeg-path').value = s.ffmpegPath || '';
  $('set-ffprobe-path').value = s.ffprobePath || '';
  const llm = s.llm || {};
  $('set-llm-preset').value = '';
  $('set-llm-baseurl').value = llm.baseURL || '';
  $('set-llm-key').value = llm.apiKey || '';
  $('set-llm-model').value = llm.model || '';
  $('llm-test-result').textContent = '';
  $('llm-model-result').textContent = '';
  $('ffmpeg-detect-result').textContent = '';
  $('settings-modal').classList.remove('hidden');
}

async function saveSettings() {
  const patch = {
    ffmpegPath: $('set-ffmpeg-path').value.trim(),
    ffprobePath: $('set-ffprobe-path').value.trim(),
    llm: {
      baseURL: $('set-llm-baseurl').value.trim(),
      apiKey: $('set-llm-key').value.trim(),
      model: $('set-llm-model').value.trim(),
    },
  };
  state.settings = await window.api.setSettings(patch);
  $('settings-modal').classList.add('hidden');
  updateAgentMode();
  await refreshFFmpegStatus();
  toast('设置已保存');
}

// ---------- 事件绑定 ----------

function bindEvents() {
  $('btn-add-file').onclick = async () => {
    const paths = await window.api.pickFiles(true);
    if (paths.length) addFiles(paths);
  };
  $('file-list').addEventListener('click', (e) => {
    const del = e.target.closest('[data-del]');
    if (del) { removeFile(del.dataset.del); return; }
    const item = e.target.closest('.file-item');
    if (item) selectFile(item.dataset.path);
  });

  $('ops-grid').addEventListener('click', (e) => {
    const card = e.target.closest('.op-card');
    if (!card || card.classList.contains('disabled')) return;
    runOps(OP_PRESETS[card.dataset.op]);
  });
  $('btn-run-custom').onclick = runCustom;
  $('custom-op').addEventListener('keydown', (e) => { if (e.key === 'Enter') runCustom(); });

  $('btn-agent-send').onclick = sendAgent;
  $('agent-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendAgent(); }
  });
  $('chat').addEventListener('click', (e) => {
    const s = e.target.closest('.sugg');
    if (s) { $('agent-input').value = s.dataset.fill; $('agent-input').focus(); }
  });

  $('task-list').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-cancel]');
    if (btn) { await window.api.cancelTask(btn.dataset.cancel); }
  });

  $('btn-settings').onclick = openSettings;
  $('btn-settings-close').onclick = () => $('settings-modal').classList.add('hidden');
  $('btn-settings-cancel').onclick = () => $('settings-modal').classList.add('hidden');
  $('btn-settings-save').onclick = saveSettings;

  $('btn-pick-ffmpeg').onclick = async () => {
    const p = await window.api.pickFFmpeg('ffmpeg');
    if (p) $('set-ffmpeg-path').value = p;
  };
  $('btn-pick-ffprobe').onclick = async () => {
    const p = await window.api.pickFFmpeg('ffprobe');
    if (p) $('set-ffprobe-path').value = p;
  };
  $('btn-recheck-ffmpeg').onclick = async () => {
    const p = { ffmpegPath: $('set-ffmpeg-path').value.trim(), ffprobePath: $('set-ffprobe-path').value.trim() };
    await window.api.setSettings(p);
    const r = await window.api.resolveFFmpeg();
    $('ffmpeg-detect-result').textContent = r.ok ? `✓ ${r.version}` : `✗ ${r.error}`;
  };

  $('set-llm-preset').addEventListener('change', (e) => {
    const preset = LLM_PRESETS[e.target.value];
    if (preset) {
      $('set-llm-baseurl').value = preset.baseURL;
      $('set-llm-model').value = preset.model;
      // 本地服务自动读取真实模型名
      if (e.target.value === 'llamacpp' || e.target.value === 'ollama') {
        autoLoadModelName();
      }
    }
  });

  $('btn-load-models').onclick = autoLoadModelName;

  async function autoLoadModelName() {
    const baseURL = $('set-llm-baseurl').value.trim();
    if (!baseURL) return;
    $('llm-model-result').textContent = '读取模型列表中…';
    const models = await window.api.listLLMModels(baseURL);
    if (models.length) {
      $('set-llm-model').value = models[0];
      $('llm-model-result').textContent = `✓ 已填入 ${models[0]}${models.length > 1 ? `（共 ${models.length} 个）` : ''}`;
      $('llm-model-result').style.color = 'var(--green)';
    } else {
      $('llm-model-result').textContent = '✗ 未获取到模型列表（服务可能未启动）';
      $('llm-model-result').style.color = 'var(--red)';
    }
  }
  $('btn-test-llm').onclick = async () => {
    const cfg = {
      baseURL: $('set-llm-baseurl').value.trim(),
      apiKey: $('set-llm-key').value.trim(),
      model: $('set-llm-model').value.trim(),
    };
    $('llm-test-result').textContent = '测试中…';
    try {
      const r = await window.api.testLLM(cfg);
      $('llm-test-result').textContent = r.ok ? '✓ 连接成功' : `✗ ${r.error}`;
      $('llm-test-result').style.color = r.ok ? 'var(--green)' : 'var(--red)';
    } catch (e) {
      $('llm-test-result').textContent = '✗ ' + e.message;
      $('llm-test-result').style.color = 'var(--red)';
    }
  };

  // 拖拽文件
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    const files = [...(e.dataTransfer.files || [])].map((f) => f.path);
    if (files.length) addFiles(files);
  });

  // 无框窗口控制
  $('btn-win-min').onclick = () => window.api.minimizeWindow();
  $('btn-win-max').onclick = () => window.api.maximizeWindow();
  $('btn-win-close').onclick = () => window.api.closeWindow();
  const maxBtn = $('btn-win-max');
  const setMaxIcon = (isMax) => {
    maxBtn.innerHTML = isMax
      ? '<svg width="12" height="12" viewBox="0 0 12 12"><rect x="1" y="3.5" width="7.5" height="7.5" rx="1" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M3.5 3.5V2a1 1 0 0 1 1-1H10a1 1 0 0 1 1 1v5.5a1 1 0 0 1-1 1H8.5" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>'
      : '<svg width="12" height="12" viewBox="0 0 12 12"><rect x="1" y="1" width="10" height="10" rx="1" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>';
    maxBtn.title = isMax ? '还原' : '最大化';
  };
  window.api.onMaximizeChanged(setMaxIcon);
  window.api.isMaximized().then(setMaxIcon).catch(() => {});
  // 双击顶栏切换最大化
  $('titlebar').addEventListener('dblclick', (e) => {
    if (e.target.closest('button') || e.target.closest('.btn')) return;
    window.api.maximizeWindow();
  });
}

// ---------- 启动 ----------

const LLM_PRESETS = {
  deepseek: { baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  openai: { baseURL: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  moonshot: { baseURL: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
  qwen: { baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  zhipu: { baseURL: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
  ollama: { baseURL: 'http://localhost:11434/v1', model: 'qwen2.5:7b' },
  llamacpp: { baseURL: 'http://localhost:8080/v1', model: 'llama' },
};

async function init() {
  bindEvents();
  window.api.onTaskUpdate((tasks) => renderTasks(tasks));
  state.settings = await window.api.getSettings();
  updateAgentMode();
  const tasks = await window.api.listTasks();
  renderTasks(tasks);
  await refreshFFmpegStatus();
}

document.addEventListener('DOMContentLoaded', init);
