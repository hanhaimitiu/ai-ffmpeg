'use strict';

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

const ffmpeg = require('./ffmpeg');
const { TaskManager } = require('./taskManager');
const { planFromText } = require('./agent/agent');
const { buildCommand, suggestOutputPath } = require('./agent/executor');
const { callLLM, listModels } = require('./agent/llm');

let win = null;
let binaries = null; // { ffmpeg, ffprobe, version }
let settings = {};
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

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 1000,
    minHeight: 700,
    title: 'AI FFmpeg 音视频工作台',
    backgroundColor: '#0f1117',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
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

async function agentPipeline(text, filePaths, source) {
  const binRes = await ensureBinaries();
  if (!binRes.ok) return { type: 'error', error: binRes.error };

  const llmConfig = settings.llm || null;
  const notes = [];
  const note = (m) => notes.push(m);

  // 对每个文件探测 + 规划
  const results = [];
  for (const filePath of filePaths) {
    const probe = await ffmpeg.probeMedia(binRes.ffprobe, filePath);
    if (!probe.ok) {
      results.push({ filePath, ok: false, error: '无法读取媒体信息: ' + probe.error });
      continue;
    }
    const summary = ffmpeg.summarizeInfo(probe.info);
    const { plan, source: planSource } = await planFromText(text, summary, llmConfig, note);

    if (plan.type === 'inspect') {
      results.push({ filePath, ok: true, kind: 'inspect', info: { ...summary, filePath, full: probe.info } });
      continue;
    }
    if (plan.type === 'unknown') {
      results.push({ filePath, ok: false, kind: 'unknown', message: plan.message, suggestions: plan.suggestions });
      continue;
    }
    if (plan.type === 'error') {
      results.push({ filePath, ok: false, kind: 'unknown', message: plan.message || '解析失败', suggestions: plan.suggestions || [] });
      continue;
    }

    // operation：构建命令并入队
    try {
      const output = suggestOutputPath(filePath, plan.actions);
      const built = buildCommand({ input: filePath, output, actions: plan.actions, media: summary });
      const t = enqueueFFmpegTask({
        input: filePath,
        output,
        args: built.args,
        duration: summary.duration || 0,
        title: plan.title || '媒体处理',
        type: source === 'agent' ? 'agent' : 'operation',
        display: built.display,
      });
      results.push({
        filePath,
        ok: true,
        kind: 'operation',
        taskId: t.id,
        output,
        command: built.display,
        plan: { title: plan.title, actions: plan.actions, source: planSource },
      });
    } catch (e) {
      results.push({ filePath, ok: false, kind: 'error', error: e.message });
    }
  }

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

  ipcMain.handle('agent:run', async (_e, text, filePaths) => {
    return agentPipeline(String(text || ''), filePaths || [], 'agent');
  });

  ipcMain.handle('agent:preview', async (_e, text, filePath) => {
    const binRes = await ensureBinaries();
    if (!binRes.ok) return { type: 'error', error: binRes.error };
    const probe = await ffmpeg.probeMedia(binRes.ffprobe, filePath);
    if (!probe.ok) return { type: 'error', error: '无法读取媒体信息: ' + probe.error };
    const summary = ffmpeg.summarizeInfo(probe.info);
    const { plan, source } = await planFromText(text, summary, settings.llm || null);
    if (plan.type === 'operation') {
      try {
        const output = suggestOutputPath(filePath, plan.actions);
        const built = buildCommand({ input: filePath, output, actions: plan.actions, media: summary });
        return { type: 'operation', plan: { title: plan.title, actions: plan.actions, source }, output, command: built.display, info: summary };
      } catch (e) {
        return { type: 'error', error: e.message };
      }
    }
    return { ...plan, info: summary };
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

  ipcMain.handle('settings:get', () => settings);
  ipcMain.handle('settings:set', (_e, patch) => {
    // 安全合并
    if (patch.ffmpegPath !== undefined) settings.ffmpegPath = String(patch.ffmpegPath || '');
    if (patch.ffprobePath !== undefined) settings.ffprobePath = String(patch.ffprobePath || '');
    if (patch.llm !== undefined) settings.llm = { ...(settings.llm || {}), ...(patch.llm || {}) };
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
}

// ---------- 应用生命周期 ----------

app.whenReady().then(() => {
  loadSettings();
  registerIpc();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
