'use strict';

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

const ffmpeg = require('./ffmpeg');
const { TaskManager } = require('./taskManager');
const { runAgentGraph } = require('./agent/graph');
const { buildCommand, suggestOutputPath } = require('./agent/executor');
const { callLLM, listModels } = require('./agent/llm');
const { SessionStore } = require('./sessions');

let win = null;
let binaries = null; // { ffmpeg, ffprobe, version }
let settings = {};
let sessionStore = null;
const settingsFile = () => (app ? path.join(app.getPath('userData'), 'settings.json') : '');

const taskManager = new TaskManager((state) => {
  if (win && !win.isDestroyed()) win.webContents.send('task:update', state);
});

// ---------- 设置 ----------

function loadSettings() {
  try {
    const raw = fs.readFileSync(settingsFile(), 'utf8');
    settings = { ...settings, ...JSON.parse(raw) };
  } catch {
    settings = {};
  }
}

function saveSettings() {
  try {
    fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2), 'utf8');
  } catch (e) {
    console.error('保存设置失败:', e.message);
  }
}

// ---------- 窗口 ----------

const THEME_BG = { light: '#F8FAFC', dark: '#0F172A', stone: '#FAFAF9' };

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 1000,
    minHeight: 700,
    title: 'AI FFmpeg 音视频工作台',
    backgroundColor: THEME_BG[settings.theme] || THEME_BG.light,
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // 开发辅助：ZCODE_SHOT=路径 时加载完成后截图（默认无副作用）
  if (process.env.ZCODE_SHOT) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          if (process.env.ZCODE_THEME) {
            await win.webContents.executeJavaScript(
              `localStorage.setItem('theme', ${JSON.stringify(process.env.ZCODE_THEME)});
               document.documentElement.setAttribute('data-theme', ${JSON.stringify(process.env.ZCODE_THEME)});`
            );
            await new Promise((r) => setTimeout(r, 400));
          }
          const img = await win.webContents.capturePage();
          fs.writeFileSync(process.env.ZCODE_SHOT, img.toPNG());
          console.log('[shot] saved:', process.env.ZCODE_SHOT);
        } catch (e) {
          console.error('[shot] fail:', e.message);
        }
        win.close();
      }, 2500);
    });
  }

  // 无框窗口：把最大化状态变化推送给渲染进程（用于切换按钮图标）
  const sendMaxState = () => {
    if (!win.isDestroyed()) win.webContents.send('win:maximize-changed', win.isMaximized());
  };
  win.on('maximize', sendMaxState);
  win.on('unmaximize', sendMaxState);
}

// ---------- 探测工具 ----------

async function ensureBinaries() {
  if (binaries) return binaries;
  const result = await ffmpeg.resolveBinaries({
    ffmpeg: settings.ffmpegPath,
    ffprobe: settings.ffprobePath,
  });
  if (result.ok) binaries = result;
  return result;
}

// ---------- 任务执行 ----------

function enqueueFFmpegTask({ input, output, args, duration, title, type, display }) {
  const task = {
    title,
    type,
    command: display,
    input,
    output,
    run: async () => {
      const res = await ffmpeg.resolveBinaries({ ffmpeg: settings.ffmpegPath, ffprobe: settings.ffprobePath });
      if (!res.ok) return { ok: false, error: res.error };
      const runner = ffmpeg.runFFmpeg({
        bin: res.ffmpeg,
        args,
        duration,
        onExit: (code) => {
          task.exitCode = code;
        },
      });
      task.kill = runner.kill;
      return runner.promise;
    },
  };
  const id = taskManager.enqueue(task);
  return { id, output, command: display };
}

// ---------- Agent 流程 ----------

async function agentPipeline(text, filePaths, source, history) {
  const binRes = await ensureBinaries();
  if (!binRes.ok) return { type: 'error', error: binRes.error };

  const notes = [];
  const note = (m) => notes.push(m);

  // 先探测全部文件（含完整流列表），供 LLM 做多文件/流级规划
  const files = [];
  const results = [];
  for (const filePath of filePaths) {
    const probe = await ffmpeg.probeMedia(binRes.ffprobe, filePath);
    if (!probe.ok) {
      results.push({ filePath, ok: false, error: '无法读取媒体信息: ' + probe.error });
      continue;
    }
    files.push({ path: filePath, name: filePath.split(/[\\/]/).pop(), info: ffmpeg.summarizeInfo(probe.info) });
  }
  if (!files.length && !results.length) return { type: 'done', notes, results: [] };

  const out = await runAgentGraph({
    text,
    files,
    llmConfig: settings.llm || null,
    history: history || [],
    onNote: note,
  });

  if (out.kind === 'inspect') {
    // 每个文件返回媒体信息（含流列表）
    for (const f of files) {
      results.push({ filePath: f.path, ok: true, kind: 'inspect', info: { ...f.info, filePath: f.path } });
    }
    return { type: 'done', notes, results };
  }
  if (out.kind === 'unknown') {
    for (const f of files) {
      results.push({ filePath: f.path, ok: false, kind: 'unknown', message: out.message, suggestions: out.suggestions });
    }
    return { type: 'done', notes, results };
  }
  if (out.kind !== 'operation') {
    return { type: 'error', error: (out.message || '解析失败') + (out.warnings && out.warnings.length ? `（${out.warnings.join('；')}）` : '') };
  }

  // operation：把图产出的命令任务入队
  for (const task of out.tasks) {
    const file = files[task.fileIndex];
    try {
      const t = enqueueFFmpegTask({
        input: task.kind === 'concat' ? null : file.path,
        output: task.output,
        args: task.args,
        duration: task.duration || 0,
        title: task.title,
        type: source === 'agent' ? 'agent' : 'operation',
        display: task.display,
      });
      results.push({
        filePath: file.path,
        ok: true,
        kind: 'operation',
        taskId: t.id,
        output: task.output,
        command: task.display,
        plan: { title: task.title, source: 'llm' },
      });
    } catch (e) {
      results.push({ filePath: file.path, ok: false, kind: 'error', error: e.message });
    }
  }
  if (out.warnings && out.warnings.length) note(out.warnings.join('；'));

  return { type: 'done', notes, results };
}

// ---------- IPC ----------

function registerIpc() {
  ipcMain.handle('ffmpeg:resolve', async () => {
    binaries = null; // 重新探测
    const res = await ensureBinaries();
    return { ok: res.ok, version: res.version, ffmpeg: res.ffmpeg, ffprobe: res.ffprobe, error: res.error };
  });

  ipcMain.handle('ffmpeg:probe', async (_e, filePath) => {
    const binRes = await ensureBinaries();
    if (!binRes.ok) return { ok: false, error: binRes.error };
    const probe = await ffmpeg.probeMedia(binRes.ffprobe, filePath);
    if (!probe.ok) return { ok: false, error: probe.error };
    return { ok: true, summary: { ...ffmpeg.summarizeInfo(probe.info), filePath, full: probe.info } };
  });

  ipcMain.handle('agent:run', async (_e, text, filePaths, sessionId) => {
    let history = [];
    if (sessionId) {
      history = sessionStore.historyForLLM(sessionId);
      // 渲染层发指令前已把当前用户消息写入会话，历史末尾就是它——去掉避免重复
      if (history.length && history[history.length - 1].role === 'user') history.pop();
    }
    return agentPipeline(String(text || ''), filePaths || [], 'agent', history);
  });

  ipcMain.handle('task:run-operation', async (_e, filePath, ops) => {
    // 手动操作面板：给定 {op, ...} 列表直接执行
    const binRes = await ensureBinaries();
    if (!binRes.ok) return { ok: false, error: binRes.error };
    const probe = await ffmpeg.probeMedia(binRes.ffprobe, filePath);
    if (!probe.ok) return { ok: false, error: '无法读取媒体信息: ' + probe.error };
    const summary = ffmpeg.summarizeInfo(probe.info);
    try {
      const output = suggestOutputPath(filePath, ops);
      const built = buildCommand({ input: filePath, output, actions: ops, media: summary });
      const t = enqueueFFmpegTask({
        input: filePath,
        output,
        args: built.args,
        duration: summary.duration || 0,
        title: ops.map((o) => o.op).join(' + '),
        type: 'operation',
        display: built.display,
      });
      return { ok: true, taskId: t.id, output, command: built.display };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('task:cancel', (_e, id) => taskManager.cancel(id));
  ipcMain.handle('task:list', () => taskManager.getState());
  ipcMain.handle('task:clear-history', () => ({ ok: true, cleared: taskManager.clearHistory() }));

  ipcMain.handle('settings:get', () => settings);
  ipcMain.handle('settings:set', (_e, patch) => {
    // 安全合并
    if (patch.ffmpegPath !== undefined) settings.ffmpegPath = String(patch.ffmpegPath || '');
    if (patch.ffprobePath !== undefined) settings.ffprobePath = String(patch.ffprobePath || '');
    if (patch.llm !== undefined) settings.llm = { ...(settings.llm || {}), ...(patch.llm || {}) };
    if (patch.theme !== undefined) {
      settings.theme = ['light', 'dark', 'stone'].includes(patch.theme) ? patch.theme : 'light';
    }
    saveSettings();
    binaries = null;
    return settings;
  });

  ipcMain.handle('llm:test', async (_e, cfg) => {
    const config = { ...(settings.llm || {}), ...(cfg || {}) };
    if (!config.baseURL || !config.model) return { ok: false, error: '请先填写接口地址和模型名称' };
    try {
      await callLLM({
        config,
        system: '你是一个连通性测试助手，只回复"OK"两个字。',
        user: '连通性测试',
      });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('llm:models', async (_e, baseURL) => {
    return listModels(String(baseURL || ''));
  });

  // ---------- 会话 ----------
  ipcMain.handle('sessions:list', () => sessionStore.list());
  ipcMain.handle('sessions:get', (_e, id) => sessionStore.get(id));
  ipcMain.handle('sessions:create', (_e, title) => sessionStore.create(title));
  ipcMain.handle('sessions:rename', (_e, id, title) => {
    const s = sessionStore.rename(id, title);
    return s ? { ok: true, session: s } : { ok: false, error: '会话不存在' };
  });
  ipcMain.handle('sessions:delete', (_e, id) => ({ ok: sessionStore.delete(id) }));
  ipcMain.handle('sessions:append', (_e, id, msg) => {
    const s = sessionStore.appendMessage(id, msg);
    return s ? { ok: true, session: s } : { ok: false, error: '会话不存在' };
  });

  ipcMain.handle('dialog:pick-file', async (_e, multi) => {
    const r = await dialog.showOpenDialog(win, {
      properties: multi ? ['openFile', 'multiSelections'] : ['openFile'],
      filters: [
        { name: '媒体文件', extensions: ['mp4', 'mov', 'avi', 'mkv', 'webm', 'flv', 'ts', 'wmv', 'm4v', 'mp3', 'wav', 'flac', 'aac', 'ogg', 'opus', 'm4a', 'wma', 'gif'] },
        { name: '所有文件', extensions: ['*'] },
      ],
    });
    return r.canceled ? [] : r.filePaths;
  });

  ipcMain.handle('dialog:pick-ffmpeg', async (_e, kind) => {
    const r = await dialog.showOpenDialog(win, {
      properties: ['openFile'],
      filters: [{ name: '可执行文件', extensions: ['exe', '*'] }],
    });
    return r.canceled ? null : r.filePaths[0];
  });

  // 窗口控制（无框模式）
  ipcMain.on('win:minimize', () => { if (win) win.minimize(); });
  ipcMain.on('win:maximize', () => { if (win) (win.isMaximized() ? win.unmaximize() : win.maximize()); });
  ipcMain.on('win:close', () => { if (win) win.close(); });
  ipcMain.handle('win:is-maximized', () => (win ? win.isMaximized() : false));
}

// ---------- 应用生命周期 ----------

if (process.env.ZCODE_NO_LCD) app.commandLine.appendSwitch("disable-lcd-text");
app.whenReady().then(() => {
  loadSettings();
  sessionStore = new SessionStore(path.join(app.getPath('userData'), 'sessions.json'));
  registerIpc();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
