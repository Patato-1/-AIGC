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

    // 2.5 图片真身在 IndexedDB，渲染前先读进内存（渲染是同步的，必须有缓存）
    try {
      var hy = await FC.assets.hydrate(Store.doc.items);
      if (hy.migrated) {
        console.info('[main] 已把 ' + hy.migrated + ' 张图片从文档迁进 IndexedDB');
        Store.markDirty();          // 文档瘦身后要重新存一次
      }
      if (hy.missing) {
        console.warn('[main] 有 ' + hy.missing + ' 张素材的图片数据找不到了');
      }
    } catch (e) {
      console.warn('[main] 图片载入失败', e);
    }

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
      (FC.genApi.config.USE_MOCK ? '本地演示（接后端改 config.local.js 的 USE_MOCK）'
                                 : (FC.api.backendBase() || '(同源)')));

    // 7. 配置自检
    //    部署时最容易犯的错就是忘了改 config.local.js 里的 BACKEND_URL，
    //    或者压根忘了建这个文件。不提示的话，用户只会看到"生成失败"
    //    或者一串看不懂的跨域报错。这里提前说清楚。
    checkConfig();
  }

  function checkConfig() {
    var err = (FC.api.configError && FC.api.configError()) || '';

    var hasLocal = !!(window.FC.LOCAL && typeof window.FC.LOCAL === 'object');
    if (!hasLocal) {
      console.info('[main] 没有 config.local.js，走演示模式。' +
        '接真实接口：cp config.example.js config.local.js 然后填配置');
      return;
    }

    if (err) {
      console.error('[main] 配置有问题：' + err);
      if (FC.ui && FC.ui.toast) FC.ui.toast(err, 'i-close');
      return;
    }

    if (FC.genApi.config.USE_MOCK) {
      console.info('[main] 当前是演示模式（USE_MOCK=true），不会真的调 AI 接口');
      return;
    }

    // 真实模式：ping 一下后端，早发现问题
    FC.api.backendHealth().then(function (h) {
      if (!h) {
        console.warn('[main] 后端连不上：' + (FC.api.backendBase() || '(同源)') +
          ' —— 检查地址、服务有没有启动、跨域有没有放开');
        return;
      }
      if (h.grsai_configured === false) {
        FC.ui.toast('后端没配 Grsai 密钥：' + (h.grsai_error || ''), 'i-close');
      } else if (h.ok) {
        console.info('[main] 后端就绪', {
          oss: h.oss_reachable, grsai: h.grsai_configured, wan3: h.wan3_configured
        });
      }
    })['catch'](function () { /* backendHealth 里已经吞掉异常了 */ });
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