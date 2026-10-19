/* ==========================================================================
   config.deploy.js — 部署配置（会提交到 GitHub，供 GitHub Pages 等静态托管使用）
   --------------------------------------------------------------------------
   ⚠️ 这个文件里【绝对不能有密钥】—— 它是公开的。
      所有需要密钥的调用都走 BACKEND_URL 指向的后端，密钥在那边。

   加载顺序（见 index.html）：
       config.local.js   ← 本地开发用，有密钥，在 .gitignore 里
       config.deploy.js  ← 这个文件，线上用
       api.js            ← 合并两者，本地配置优先

   所以：
       线上：没有 config.local.js，用这里的 BACKEND_URL
       本地：config.local.js 覆盖这里，指向 127.0.0.1
   ========================================================================== */
window.FC = window.FC || {};

// 用 DEPLOY 这个名字（不是 LOCAL），这样本地配置不会被它覆盖掉
window.FC.DEPLOY = {
  USE_MOCK: false,

  // 后端地址（阿里云函数计算）
  BACKEND_URL: 'https://ai-canvas-api-anclqihhzx.cn-hangzhou.fcapp.run',

  UPLOAD_URL: '',
  UPLOAD_FIELD: 'file',

  MODELS: {
    image: 'gpt-image-2.5',
    video: 'minimax-h3'
  }
};