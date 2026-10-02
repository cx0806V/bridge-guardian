/* ============================================================================
   mobile-redirect.js —— 手机端取消 3D 界面（客户端兜底跳转）
   ----------------------------------------------------------------------------
   背景：3D 监测页 /dashboard 只在桌面端展示。手机端访问 /dashboard 时转到 /trend
   （实时趋势），桌面端不做任何修改。

   这是【第二层】实现。第一层在服务端（app.py 的 dashboard 视图）：真实手机/平板的
   User-Agent 命中 MOBILE_UA_RE 时直接 302 → /trend，连 3D 页面都不下发，
   手机端不会白跑 three.js（省流量、省电、无闪烁）。

   客户端这一层专门兜住 UA 判断漏掉的情况：
     · 手机横屏时部分浏览器会报桌面风格 UA；
     · 平板/折叠屏的 UA 与视口宽度可能不一致；
     · 桌面把窗口拖窄（或开发者工具切设备）时，布局本来就已经切到 ≤768px 手机档，
       此时这一页的手机档是「画布 46vh + 工具条 172px 预留」的布局，体验并不好。
   所以客户端按【视口宽度】判断，与服务端 UA 判断互补。

   为什么必须是纯同步脚本、不能加 defer / type="module"：
     它在 <head> 里同步执行 → 下面的 CSS、3D 引导（three-boot.js）与 mount.js
     都还没开始解析/加载，手机端最多闪现一次空白帧，不会闪出 3D 画布。

   为什么用 location.replace() 而不是 href：
     replace 不留历史条目 → 详情页按返回不会又弹回 /dashboard，形成来回弹跳的循环。

   断点 768px 与共享骨架的既有口径一致：_shell.html 的 MOBILE_W、
   dashboard.html 的 window.innerWidth <= 768、app.py 的 MOBILE_BREAKPOINT_PX。
   （static/app.css 里的 `@media (max-width: 760px)` 是旧大屏版式遗留档位，
    与 .sh-* 骨架无关，不参与这里的判断。）
   ============================================================================ */
(function () {
  'use strict';
  var MOBILE_BREAKPOINT_PX = 768;   /* 手机档断点：与 app.py / _shell.html / app.css 同值 */
  var TREND_PATH = '/trend';        /* 手机端的 3D 替代页：实时趋势 */

  /* 防环：仅当当前确实在 /dashboard 上才跳（本文件只被该页引用，这里是双保险） */
  if (window.location.pathname !== '/dashboard') return;
  if (window.innerWidth > MOBILE_BREAKPOINT_PX) return;   /* 桌面端：原样渲染 3D，什么都不做 */

  window.location.replace(TREND_PATH);
})();
