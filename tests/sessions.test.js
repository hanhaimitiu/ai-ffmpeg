'use strict';

/** 会话存储单元测试 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { SessionStore } = require('../main/sessions');

let pass = 0;
let fail = 0;
function check(desc, cond, extra) {
  if (cond) { pass++; console.log(`  ✓ ${desc}`); }
  else { fail++; console.log(`  ✗ ${desc}${extra ? '\n    ' + extra : ''}`); }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sess-'));
const store = new SessionStore(path.join(tmp, 'sessions.json'));

// 创建
const s1 = store.create();
check('创建会话有 id', !!s1.id && s1.messages.length === 0);
check('默认标题', s1.title === '新会话');

// 首条用户消息成为标题
store.appendMessage(s1.id, { role: 'user', text: '把视频转成mp4并压缩一下体积' });
const got = store.get(s1.id);
check('首条消息自动命名（截断24字）', got.title === '把视频转成mp4并压缩一下体积', got.title);
check('消息已追加', got.messages.length === 1 && got.messages[0].role === 'user');

// 助手消息带 results
store.appendMessage(s1.id, { role: 'assistant', text: '✅ done', results: [{ filePath: 'a.mp4', ok: true }] });
const got2 = store.get(s1.id);
check('assistant 消息保存 results', Array.isArray(got2.messages[1].results) && got2.messages[1].results.length === 1);

// LLM 上下文
const h = store.historyForLLM(s1.id);
check('historyForLLM 返回对话对', h.length === 2 && h[0].role === 'user' && h[1].role === 'assistant' && h[1].content === '✅ done', JSON.stringify(h));
check('historyForLLM 上限', store.historyForLLM(s1.id, 1).length === 1);

// 多会话排序：新建的在前
const s2 = store.create('第二个');
check('列表按最近活跃排序', store.list()[0].id === s2.id && store.list()[1].id === s1.id);

// 最近活跃提升
store.appendMessage(s1.id, { role: 'user', text: 'hi' });
check('追加消息后会话提升到最前', store.list()[0].id === s1.id);

// 重命名 / 删除
const rn = store.rename(s2.id, '  手动改名  ');
check('重命名去空白', rn.title === '手动改名');
check('删除会话', store.delete(s2.id) === true && store.get(s2.id) === null);
check('删除不存在的返回 false', store.delete('nope') === false);

// 持久化：重新加载
const store2 = new SessionStore(path.join(tmp, 'sessions.json'));
check('持久化到磁盘可恢复', store2.get(s1.id) && store2.get(s1.id).messages.length === 3);

// 容量上限
const s3 = store2.create('上限测试');
for (let i = 0; i < 250; i++) store2.appendMessage(s3.id, { role: 'user', text: `m${i}` });
check('单会话消息上限 200', store2.get(s3.id).messages.length === 200);

console.log(`\n会话存储测试: ${pass} 通过, ${fail} 失败`);
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
