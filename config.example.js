/* ==========================================================================
   config.example.js — 本地配置模板
   --------------------------------------------------------------------------
   用法：
     1. 把这个文件复制成  config.local.js
     2. 在 config.local.js 里填你自己的密钥和地址
     3. config.local.js 已经在 .gitignore 里，永远不会被提交

   ⚠️ 千万不要把密钥填进这个文件（config.example.js 是会提交到 GitHub 的）。
   ========================================================================== */
window.FC = window.FC || {};

window.FC.LOCAL = {
  /* ---- 接中转站 / 后端 ---- */
  USE_MOCK: false,                       // false = 走真实接口
  BASE_URL: 'https://你的中转站地址',      // 例如 https://api.example.com
  API_KEY: '',                           // ← 你的密钥填这里（只在 config.local.js 里填）

  /* ---- 图片怎么发给对方 ---- */
  // 'base64' 直接内联（简单，但请求体大，有些中转站不收）
  // 'url'    先上传拿链接再发（请求体小，兼容性最好）
  // 'auto'   先试 base64，失败（413/400）自动改用上传  ← 推荐
  IMAGE_MODE: 'auto',

  // 只有 IMAGE_MODE = 'url' 或 'auto' 降级时才用得到
  UPLOAD_URL: '',                        // 例如 https://api.example.com/upload
  UPLOAD_FIELD: 'file',                  // 上传时的表单字段名

  /* ---- 模型名（要跟中转站文档里完全一致）---- */
  MODELS: {
    image: '',                           // 例如 'chatgptimage2.5'
    video: ''
  }
};