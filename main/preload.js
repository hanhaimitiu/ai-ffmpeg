'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // ffmpeg
  resolveFFmpeg: () => ipcRenderer.invoke('ffmpeg:resolve'),
  probeMedia: (filePath) => ipcRenderer.invoke('ffmpeg:probe', filePath),

  // agent
  runAgent: (text, filePaths) => ipcRenderer.invoke('agent:run', text, filePaths),
  previewAgent: (text, filePath) => ipcRenderer.invoke('agent:preview', text, filePath),

  // tasks
  runOperation: (filePath, ops) => ipcRenderer.invoke('task:run-operation', filePath, ops),
  cancelTask: (id) => ipcRenderer.invoke('task:cancel', id),
  listTasks: () => ipcRenderer.invoke('task:list'),
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

  // dialogs
  pickFiles: (multi) => ipcRenderer.invoke('dialog:pick-file', multi),
  pickFFmpeg: (kind) => ipcRenderer.invoke('dialog:pick-ffmpeg', kind),

  // utils
  platform: process.platform,
});
