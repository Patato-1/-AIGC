/* ==========================================================================
   main.js — 启动
   ========================================================================== */
(function (FC) {
  'use strict';

  var Store = FC.Store;
  var R = FC.render;

  async function boot() {
    R.cacheDom();

    // 1. 主题
    var theme = 'light';
    try {
      theme = localStorage.getItem(FC.THEME_KEY) ||
        (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    } catch (e) { theme = 'light'; }
    Store.ui.theme = theme;
    document.documentElement.setAttribute('data-theme', theme);

    // 2. 载入文档：本地缓存 → 后端 → 示例
    var doc = Store.load();
    if (!doc) doc = await loadFromApi();
    Store.setDoc(doc || Store.demoDoc(), { save: false });

    // 3. UI + 交互
    FC.ui.init();
    FC.interactions.init();
    FC.interactions.setTool('select');

    // 4. 渲染（首次适配绑在渲染流程里，确保尺寸已测量）
    R.reset();
    R.requestFit(80, 0.5);

    // 5. 尺寸变化
    var t = 0;
    window.addEventListener('resize', function () {
      clearTimeout(t);
      t = setTimeout(function () { R.requestView(); }, 120);
    });

    // 6. 退出前保存
    window.addEventListener('beforeunload', function () { Store.save(); });
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) Store.save();
    });

    window.FC = FC;
    console.log('%cAI Canvas', 'font-weight:700', '已就绪 · 生成：' +
      (FC.genApi.config.USE_MOCK ? '本地演示（接后端改 api.js 的 USE_MOCK）' : FC.genApi.config.BASE_URL));
  }

  async function loadFromApi() {
    try {
      var list = await FC.api.listBoards();
      if (list && list.length) return await FC.api.getBoard(list[0].id);
      return null;
    } catch (err) {
      console.info('[main] 后端暂不可用，使用本地数据');
      return null;
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})(window.FC);