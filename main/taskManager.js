'use strict';

const { randomUUID } = require('crypto');

/**
 * 简单的串行任务队列：任务排队执行，支持取消、进度回调、历史记录。
 */
class TaskManager {
  constructor(onChange) {
    this.queue = []; // 等待中的任务（不含正在执行的）
    this.running = null;
    this.history = [];
    this.onChange = onChange || (() => {});
  }

  _emit() {
    this.onChange({
      running: this.running ? serializeTask(this.running) : null,
      queue: this.queue.map(serializeTask),
      history: this.history.map(serializeTask).reverse(), // 最新的在前
    });
  }

  /**
   * @param {object} task
   * @param {string} task.title 任务标题
   * @param {string} task.type  任务类型：operation | agent
   * @param {string} task.command  用于展示的 ffmpeg 命令（去掉二进制路径）
   * @param {(ctl:{bin:string,args:string[],duration:number,onProgress:Function})=>Promise<{ok:boolean,code:number|null,error?:string}>} task.run
   */
  enqueue(task) {
    const record = {
      id: randomUUID(),
      status: 'queued',
      progress: 0,
      createdAt: Date.now(),
      ...task,
    };
    this.queue.push(record);
    this._emit();
    if (!this.running) this._next();
    return record.id;
  }

  async _next() {
    if (this.running || this.queue.length === 0) return;
    const record = this.queue.shift();
    this.running = record;
    record.status = 'running';
    record.startedAt = Date.now();
    this._emit();

    try {
      const result = await record.run({
        onProgress: (p) => {
          record.progress = p.progress == null ? record.progress : p.progress;
          this._emit();
        },
      });
      record.status = result.ok ? 'done' : 'error';
      record.error = result.error || null;
    } catch (e) {
      record.status = 'error';
      record.error = String((e && e.message) || e);
    }
    record.finishedAt = Date.now();
    record.endedAt = record.finishedAt;

    this.history.push(record);
    if (this.history.length > 50) this.history.shift();
    this.running = null;
    this._emit();
    if (this.queue.length > 0) this._next();
  }

  /** 取消正在执行的任务（若可取消） */
  cancel(id) {
    if (this.running && this.running.id === id && typeof this.running.kill === 'function') {
      this.running.kill();
      return true;
    }
    const idx = this.queue.findIndex((t) => t.id === id);
    if (idx >= 0) {
      const [removed] = this.queue.splice(idx, 1);
      removed.status = 'cancelled';
      removed.finishedAt = Date.now();
      this.history.push(removed);
      this._emit();
      return true;
    }
    return false;
  }

  getState() {
    return {
      running: this.running ? serializeTask(this.running) : null,
      queue: this.queue.map(serializeTask),
      history: this.history.map(serializeTask).reverse(),
    };
  }
}

function serializeTask(t) {
  return {
    id: t.id,
    title: t.title,
    type: t.type,
    command: t.command,
    status: t.status,
    progress: t.progress,
    error: t.error || null,
    createdAt: t.createdAt,
    startedAt: t.startedAt,
    finishedAt: t.finishedAt,
    endedAt: t.endedAt,
  };
}

module.exports = { TaskManager };
