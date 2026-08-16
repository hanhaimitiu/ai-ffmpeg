'use strict';

/**
 * 主题预启动：在页面渲染前把上次使用的皮肤写到 <html data-theme>，
 * 避免深色用户每次打开都先闪一下浅色（CSP 禁止内联脚本，故用外部文件）。
 */
(function () {
  try {
    var t = localStorage.getItem('theme');
    if (t === 'dark' || t === 'stone' || t === 'light') {
      document.documentElement.setAttribute('data-theme', t);
    }
  } catch (e) { /* localStorage 不可用时用默认浅色 */ }
})();
