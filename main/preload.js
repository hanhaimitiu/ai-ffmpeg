'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // ffmpeg
  resolveFFmpeg: () => ipcRenderer.invoke('ffmpeg:resolve'),
  probeMedia: (filePath) => ipcRenderer.invoke('ffmpeg:probe', filePath),

  // agent
  runAgent: (text, filePaths, sessionId) => ipcRenderer.invoke('agent:run', text, filePaths, sessionId),

  // tasks
  runOperation: (filePath, ops) => ipcRenderer.invoke('task:run-operation', filePath, ops),
  cancelTask: (id) => ipcRenderer.invoke('task:cancel', id),
  listTasks: () => ipcRenderer.invoke('task:list'),
  clearTaskHistory: () => ipcRenderer.invoke('task:clear-history'),
  onTaskUpdate: (cb) => {
    const handler = (_e, state) => cb(state);
    ipcRenderer.on('task:update', handler);
    return () => ipcRenderer.removeListener('task:update', handler);
  },

  // settings
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  testLLM: (cfg) => ipcRenderer.invoke('llm:test', cfg),
  listLLMModels: (baseURL) => ipcRenderer.invoke('llm:models', baseURL),

  // sessions
  listSessions: () => ipcRenderer.invoke('sessions:list'),
  getSession: (id) => ipcRenderer.invoke('sessions:get', id),
  createSession: (title) => ipcRenderer.invoke('sessions:create', title),
  renameSession: (id, title) => ipcRenderer.invoke('sessions:rename', id, title),
  deleteSession: (id) => ipcRenderer.invoke('sessions:delete', id),
  appendSessionMessage: (id, msg) => ipcRenderer.invoke('sessions:append', id, msg),

  // dialogs
  pickFiles: (multi) => ipcRenderer.invoke('dialog:pick-file', multi),
  pickFFmpeg: (kind) => ipcRenderer.invoke('dialog:pick-ffmpeg', kind),

  // utils
  platform: process.platform,

  // window controls (frameless mode)
  minimizeWindow: () => ipcRenderer.send('win:minimize'),
  maximizeWindow: () => ipcRenderer.send('win:maximize'),
  closeWindow: () => ipcRenderer.send('win:close'),
  isMaximized: () => ipcRenderer.invoke('win:is-maximized'),
  onMaximizeChanged: (cb) => {
    const handler = (_e, flag) => cb(flag);
    ipcRenderer.on('win:maximize-changed', handler);
    return () => ipcRenderer.removeListener('win:maximize-changed', handler);
  },
});
