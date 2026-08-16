'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

/**
 * 会话存储：多会话聊天记录持久化到 userData/sessions.json。
 * 会话结构：
 * {
 *   id, title, createdAt, updatedAt,
 *   messages: [{ role:'user'|'assistant', text, ts, results?:object[] }]
 * }
 */

const MAX_SESSIONS = 50;
const MAX_MESSAGES_PER_SESSION = 200;

class SessionStore {
  constructor(file) {
    this.file = file;
    this.sessions = [];
    this.load();
  }

  load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const data = JSON.parse(raw);
      this.sessions = Array.isArray(data.sessions) ? data.sessions : [];
    } catch {
      this.sessions = [];
    }
  }

  save() {
    try {
      fs.writeFileSync(this.file, JSON.stringify({ sessions: this.sessions }, null, 2), 'utf8');
    } catch (e) {
      console.error('保存会话失败:', e.message);
    }
  }

  /** 列表元信息（不含 messages，避免传输过大） */
  list() {
    return this.sessions
      .map(({ id, title, createdAt, updatedAt, messages }) => ({
        id,
        title,
        createdAt,
        updatedAt,
        messageCount: messages ? messages.length : 0,
      }));
  }

  get(id) {
    const s = this.sessions.find((x) => x.id === id);
    return s ? { ...s } : null;
  }

  create(title) {
    const now = Date.now();
    const session = {
      id: randomUUID(),
      title: title || '新会话',
      createdAt: now,
      updatedAt: now,
      messages: [],
    };
    this.sessions.unshift(session);
    if (this.sessions.length > MAX_SESSIONS) this.sessions.pop();
    this.save();
    return { ...session };
  }

  rename(id, title) {
    const s = this.sessions.find((x) => x.id === id);
    if (!s) return null;
    s.title = String(title || '').trim().slice(0, 60) || s.title;
    s.updatedAt = Date.now();
    this.save();
    return { ...s };
  }

  delete(id) {
    const idx = this.sessions.findIndex((x) => x.id === id);
    if (idx < 0) return false;
    this.sessions.splice(idx, 1);
    this.save();
    return true;
  }

  /** 追加消息；首条用户消息自动成为会话标题 */
  appendMessage(id, msg) {
    const s = this.sessions.find((x) => x.id === id);
    if (!s) return null;
    const record = {
      role: msg.role === 'assistant' ? 'assistant' : 'user',
      text: String(msg.text || ''),
      ts: Date.now(),
    };
    if (Array.isArray(msg.results)) record.results = msg.results;
    s.messages.push(record);
    if (s.messages.length > MAX_MESSAGES_PER_SESSION) s.messages.splice(0, s.messages.length - MAX_MESSAGES_PER_SESSION);
    if (s.messages.length === 1 && record.role === 'user') {
      s.title = record.text.replace(/\s+/g, ' ').slice(0, 24) || s.title;
    }
    s.updatedAt = Date.now();
    // 保持最近活跃的在前
    const idx = this.sessions.indexOf(s);
    if (idx > 0) {
      this.sessions.splice(idx, 1);
      this.sessions.unshift(s);
    }
    this.save();
    return { ...s };
  }

  /**
   * 取最近 N 轮对话作为 LLM 上下文（user/assistant 文本对）。
   * @returns {{role:'user'|'assistant', content:string}[]}
   */
  historyForLLM(id, limit = 6) {
    const s = this.sessions.find((x) => x.id === id);
    if (!s) return [];
    return s.messages
      .filter((m) => m.text && m.text.trim())
      .slice(-limit)
      .map((m) => ({ role: m.role, content: m.text.slice(0, 2000) }));
  }
}

module.exports = { SessionStore };
