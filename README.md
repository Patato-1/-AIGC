# AI Canvas · 自由创作画布

纯前端、零依赖、零构建的 AI 创作画布。iOS / Apple 设计语言，纯黑白灰配色，浅色与深色双主题。

**双击 `index.html` 就能用**，不需要 Node、不需要打包、不需要联网。

> 这不是 ComfyUI 那种连线工作流。画布上只有一张张独立卡片，想放哪放哪，没有端口、没有连线、没有拓扑。

---

## 怎么用

| 操作 | 方式 |
|---|---|
| **新建模型** | **双击画布空白处** → 弹出「AI 生图模型 / AI 视频模型」 |
| **拖入图片** | 把电脑里的图片直接**拖到画布上**（可多选，支持 ⌘V 粘贴） |
| **移动卡片** | **整张卡片任意位置都能拖**（顶栏、预览区、表单空白处都行）；输入框 / 下拉 / 按钮上按住则不移动，正常操作控件 |
| **改宽度** | 悬停卡片时右侧出现把手，左右拖 |
| **写提示词** | 直接在卡片里的输入框写，点「生成图片 / 生成视频」 |
| **拉连线** | 按住卡片边缘的**小圆点**拖到另一张卡，松开即连上（图片卡右侧只有输出，模型卡左右都有） |
| **删连线** | 点一下线选中，再按 `Delete`；或点线中间的圆形 × |
| **当参考图** | 把图片直接拖到模型卡上，松开即连成输入（等价于拉一条线） |
| **框选** | **空白处按住拖拽**即可拉出选择矩形（跟随鼠标，右下角实时显示选中数量）；按住 `Shift`/`⌘` 拖拽 = 追加到已有选择 |
| **平移 / 缩放** | **空格 + 拖拽** / 中键拖拽 / 切到平移工具 · `⌘/Ctrl + 滚轮` 或触控板捏合缩放 · 双指滚动平移 |
| **复制 / 粘贴** | `⌘C` 复制 · `⌘X` 剪切 · `⌘V` 粘贴到**当前鼠标位置**（整组左上角对齐鼠标、往下 8px；卡片之间的相对位置保持不变）。鼠标不动连按 ⌘V 会依次错开 34px |
| **其它** | `⌘Z` 撤销 · `⇧⌘Z` 重做 · `⌘D` 原地复制 · `⌘A` 全选 · `Delete` 删除 · `⌘0` 适应视图 · `Esc` 取消选择 |

---

## 三种卡片

**AI 生图模型** — 提示词 + 模型 + 比例 + 风格，生成结果直接落在卡片里。

**AI 视频模型** — 多一个时长选项，结果带播放按钮和时长角标。

**图片素材** — 拖进来的本地图片，自动等比缩放到最长边 1600px 再存，卡片显示原图尺寸。

卡片宽度可调（160–720px），高度由内容自动决定，所以改比例、改宽度都不会变形。

---

## 连线是怎么工作的（轻量连接）

卡片边缘的小圆点就是端口：**模型卡左边是输入、右边是输出**，**图片素材只有右边（输出）**。从圆点拖一条线到另一张卡就建立了连接。

连线的含义很直接 —— **把上游的输出喂给下游当输入**：

- **图片 → 模型卡**：这张图作为该模型卡的参考图（图生图 / 视频首帧）
- **模型卡 → 模型卡**：上游生成的结果作为下游的输入（例如先生图、再拿这张图去生成视频）

连接后会怎样：
- 卡片里出现一行「来自 XX」的输入条，点它的 × 可以单独断开
- 重新生成时，参考图会一起提交给后端（`refImage` 字段）
- 输入变了，生成结果的 seed 也会变（同一个提示词 + 同一组输入 = 同一张图）

约束（避免连出无意义的结构）：不能自己连自己、不能重复连、图片素材不能接收输入。删除卡片时相关连线会自动一起删掉。

画布本身仍然是自由摆放的 —— 连线只是"这两张卡有关系"的记号，不强制顺序，也没有节点图那种必须先摆好再跑的结构。

## 现在的生成是「演示模式」

`api.js` 里 `USE_MOCK = true`，生成走本地：**不联网**，按提示词算出一个 seed，用 `art.js` 程序化画一张黑白抽象图。

几个刻意的设计：

- **结果是确定性的**：同一个 seed 永远画出同一张图。所以文档里只存 `seed`（几十字节），重新打开画布再画一遍即可 —— 生成 100 张图也不会撑爆 localStorage。
- **进度是假的但节奏是真的**：前 12% 很快、之后变慢，像真实的排队 + 推理。
- **结果角上有 `DEMO` 角标**，提醒这是占位内容；接上后端后角标自动消失。

---

## 接入真实 API

所有网络访问都收在 `assets/js/api.js`，**其它文件一行都不用改**。

### 第一步：切开关

```js
var CONFIG = {
  USE_MOCK: false,                              // ← 改成 false
  BASE_URL: 'https://api.your-domain.com/api',  // ← 你的后端
  TOKEN_KEY: 'aic.token.v1',
  TIMEOUT: 20000
};
```

登录后写入令牌，请求会自动带 `Authorization: Bearer <token>`：

```js
FC.api.setToken('your-jwt-token');
```

### 第二步：实现这些接口

**画布文档**

| 方法 | 端点 | 说明 |
|---|---|---|
| `listBoards()` | `GET /boards` | 画布列表 |
| `getBoard(id)` | `GET /boards/:id` | 读取画布 |
| `createBoard(doc)` | `POST /boards` | 新建 |
| `updateBoard(id, doc)` | `PUT /boards/:id` | 全量保存（自动保存走这里） |
| `deleteBoard(id)` | `DELETE /boards/:id` | 删除 |
| `ping()` | `GET /health` | 健康检查 |

**生成**

```jsonc
// 提交任务
POST /generate
{ "kind": "image" | "video", "prompt": "...", "model": "...", "ratio": "16:9",
  "style": "...", "duration": "5 秒", "width": 960, "height": 540,
  "refImage": "data:image/... 或素材 id" }
→ { "taskId": "..." }

// 轮询
GET /generate/:taskId
→ { "status": "pending|running|done|error", "progress": 0-100,
    "url": "https://...", "seed": 123, "width": 960, "height": 540,
    "error": "模型超时" }

// 取消
POST /generate/:taskId/cancel
```

前端按 800ms 轮询，骨架已经写在 `generate.js` 的 `runRemote()` 里 —— 把 `USE_MOCK` 改成 `false` 就会走它，**取消、进度、错误处理全都不用重写**。

如果想要实时进度，`GenAPI.stream()` 里也写好了 SSE 版本（`GET /generate/:taskId/stream`）。

### 结果怎么存

后端返回 `url` 时，前端存进 `result.src`，直接显示远程资源：

```js
{ kind: 'video', src: 'https://cdn.../out.mp4', w: 960, h: 540, demo: false }
```

`demo: false` 后 `DEMO` 角标不再出现，视频也会用真正的 `<video>` 播放。

---

## 数据结构

```jsonc
{
  "id": "doc_xxx",
  "name": "我的创作画布",
  "links": [                     // 轻量连线：from 的输出喂给 to
    { "id": "lnk_xxx", "from": "gen_xxx", "to": "gen_yyy" }
  ],
  "items": [
    {
      "id": "gen_xxx",
      "kind": "image-gen",        // image-gen | video-gen | asset
      "x": -430, "y": -190,       // 世界坐标
      "w": 300,                   // 宽度（高度自适应）
      "z": 1,                     // 层叠顺序
      "prompt": "晨雾中的松林",
      "model": "deepseek-image",
      "ratio": "4:3",
      "style": "摄影",
      "duration": "5 秒",          // 仅视频卡
      "refId": null,              // 参考图（指向某张 asset 卡）
      "result": {                 // 生成结果
        "kind": "image",
        "seed": 20240517,         // 演示模式：只存 seed
        "w": 896, "h": 672,
        "createdAt": 1735689600000,
        "demo": true
      }
    },
    {
      "id": "img_xxx",
      "kind": "asset",
      "x": 120, "y": 320, "w": 260, "z": 4,
      "src": "data:image/webp;base64,...",
      "name": "moodboard-01",
      "naturalW": 1600, "naturalH": 1067
    }
  ]
}
```

localStorage 键名：`aic.doc.v1`（当前画布）、`aic.boards.v1`（Mock 画布库）、`aic.theme.v1`、`aic.hint.v1`。

---

## 目录结构

```
ai-canvas/
├── index.html              页面骨架 + SVG 图标精灵
├── assets/
│   ├── css/app.css         设计令牌 · 双主题 · 全部组件样式
│   └── js/
│       ├── store.js        数据模型、撤销重做、持久化、z 序
│       ├── geometry.js     坐标变换（屏幕 ↔ 世界）与矩形工具
│       ├── (连线渲染在 render.js 的 drawLinks，端口拖拽在 interactions.js 的 startLinkDrag)
│       ├── art.js          ★ 程序化占位图（确定性，seed → 图）
│       ├── generate.js     ★ 生成流程：Mock 进度 / 真实轮询
│       ├── api.js          ★ 数据接入层（改这里就能接后端）
│       ├── render.js       卡片渲染、测量、网格、适配视图
│       ├── interactions.js 指针交互：平移缩放 / 拖拽 / 缩放宽度 / 拖入图片 / 快捷键
│       ├── ui.js           双击创建菜单、卡片事件委托、图片导入、对话框、Toast
│       └── main.js         启动引导
├── preview-light.png       浅色预览
├── preview-dark.png        深色预览
└── preview-create.png      双击创建菜单
```

**渲染策略**：卡片用 DOM，世界层用 CSS `transform` 承载缩放（文字清晰、事件简单）；卡片高度由内容自动撑开，渲染后测量真实尺寸缓存起来，供框选命中和「适应视图」使用。

---

## 几个实现细节

**图片拖入**：读进来后等比缩到最长边 1600px，再用 canvas 编码成 WebP（不支持则回退 JPEG），避免 localStorage 5MB 爆掉。存不下时会提示「保存失败（图片可能过多）」，画布本身不会丢。

**参考图**：把图片拖到模型卡上即设为参考图，显示为卡片内的缩略图条；重新生成时会把参考图一起交给后端（`refImage` 字段）。

**后台标签页**：Mock 生成按「步数」推进而不是靠时钟，所以切到别的标签页再回来，进度不会卡住。

---

## 浏览器支持

Chrome / Edge / Safari / Firefox 近两年版本。用到 `backdrop-filter`、CSS 自定义属性、`aspect-ratio`、Pointer Events、`async/await`。

已在 Edge（Chromium）1440×900 下实测：浅色 / 深色 / 双击创建菜单 / 拖入图片 / 生成进度 / 生成完成落地结果，全流程零 JS 报错。

响应式：`≤1180px` 隐藏状态条 · `≤900px` 按钮收缩 · `≤720px` 工具栏收窄 · `≤460px` 工具栏转为底部横排。