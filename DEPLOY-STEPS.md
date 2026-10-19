# 部署手把手（照着做就行）

> 目标：让面试官点开一个链接就能看到画布，且**前端不含任何密钥**。
>
> 预计 **30~40 分钟**。全程不用备案，花费几乎为零。
>
> 每一步后面都有一个 **✅ 检查点** —— 过了再往下走，不然后面会白折腾。

---

## 准备：确认你手上有这些

在开始之前，先把这几样东西找齐（待会儿要粘贴）：

| 要用的东西 | 从哪拿 |
|---|---|
| **Grsai 密钥** | 打开项目里的 `config.local.js`，找 `API_KEY:` 后面那一串（`sk-` 开头） |
| **Grsai 节点地址** | 同一个文件里的 `BASE_URL`（应该是 `https://grsai.dakka.com.cn`） |
| **OSS AccessKeyId** | 打开 `config.oss.local.py`，找 `OSS_ACCESS_KEY_ID` |
| **OSS AccessKeySecret** | 同文件，`OSS_ACCESS_KEY_SECRET` |
| **OSS Endpoint** | 同文件，应该是 `oss-cn-beijing.aliyuncs.com` |
| **OSS Bucket 名** | 同文件，应该是 `potatoooo` |

**⚠️ 别把这些发给我或发到群里。** 上面那张表只是告诉你"去哪找"，不是让你贴出来。

---

## 第 0 步：打包（2 分钟）

打开 PowerShell，进到项目目录：

```powershell
cd D:\deepseek\ai-canvas
python build_deploy.py
```

会看到类似输出：

```
【后端】给阿里云函数计算
  ai-canvas-backend.zip  (6 个文件, 20.1 KB)
  ✓ 没有密钥配置、没有缓存文件

【前端】给 OSS 静态托管
  ai-canvas-frontend.zip  (16 个文件, 109.5 KB)
  ✓ 没有真实密钥
```

**✅ 检查点**：`deploy\` 目录下出现两个 zip 文件。

```
D:\deepseek\ai-canvas\deploy\ai-canvas-backend.zip
D:\deepseek\ai-canvas\deploy\ai-canvas-frontend.zip
```

**如果脚本报错说"发现密钥"** → 停下来告诉我，别继续。

---

## 第 1 步：开通函数计算（5 分钟）

1. 浏览器打开 **https://fc.console.aliyun.com/**
2. 用你的阿里云账号登录
3. 如果提示**开通服务** → 点开通（免费，按量付费）
4. 首次开通可能会让你**授权一个服务角色** → 点同意

**✅ 检查点**：能看到函数计算的**函数列表**页面（可能现在是空的）。

> **如果找不到函数计算**：在阿里云控制台顶部搜索框里搜「函数计算」。
> 或者告诉我，我换个方案（用轻量应用服务器）。

---

## 第 2 步：创建函数（10 分钟）

在函数计算控制台：

### 2.1 点「创建函数」

选择 **「使用示例代码创建」** 或者 **「创建函数」**（不同版本措辞略有不同）。

### 2.2 填写基本信息

| 配置项 | 填什么 |
|---|---|
| 函数名称 | `ai-canvas-api` |
| 运行环境 / 运行时 | **Python 3.10**（或更高的 3.x） |
| 请求处理程序 | `fc_handler.handler` |
| 函数代码 | 选 **「通过 ZIP 包上传」**，传 `ai-canvas-backend.zip` |

**⚠️ 请求处理程序一定要填 `fc_handler.handler`** —— 填错了函数跑不起来。

### 2.3 关于依赖（重要）

后端只依赖一个包：`oss2`。

**两种做法，选一种：**

**做法 A（推荐，简单）**：在函数配置里找到「层」或「依赖安装」，
如果有「在线安装依赖」或 `requirements.txt` 自动安装的选项 → 用它。

**做法 B（如果 A 不行）**：临时把代码里的 OSS 上传功能关掉先跑通。
但这样「自动转存」和「上传到云端」就用不了了。

**做不了就告诉我**，我给你换成轻量应用服务器方案（不需要处理依赖，直接 `pip install`）。

**✅ 检查点**：函数创建成功，能在列表里看到 `ai-canvas-api`。

---

## 第 3 步：配环境变量（5 分钟）★ 最关键

在函数的 **「配置」→「环境变量」** 里，添加下面这些。

**一条一条加，名字要完全一致（区分大小写）：**

| 变量名 | 值 |
|---|---|
| `GRSAI_BASE_URL` | `https://grsai.dakka.com.cn` |
| `GRSAI_API_KEY` | 你的 Grsai 密钥（`sk-` 开头那串） |
| `OSS_ACCESS_KEY_ID` | 你的 OSS AccessKeyId |
| `OSS_ACCESS_KEY_SECRET` | 你的 OSS AccessKeySecret |
| `OSS_ENDPOINT` | `oss-cn-beijing.aliyuncs.com` |
| `OSS_BUCKET` | `potatoooo` |
| `OSS_PREFIX` | `ai-canvas/` |

**为什么用环境变量而不是配置文件**：

```
配置文件  →  容易不小心传给别人 / 传到网上
环境变量  →  只存在云平台里，代码和 ZIP 包里一个字都没有
```

**✅ 检查点**：7 个变量都加好了，保存成功。

---

## 第 4 步：配置 HTTP 触发器（5 分钟）

函数需要能从浏览器访问，所以要加 **HTTP 触发器**。

1. 在函数页面找 **「触发器」** 标签
2. 点 **「创建触发器」**
3. 类型选 **HTTP 触发器**
4. 认证方式选 **「无需认证」**（因为我们要让访客直接访问）
5. 请求方法：勾选 **GET / POST**（或选"所有方法"）
6. 保存

保存后会得到一个**公网访问地址**，长这样：

```
https://ai-canvas-api-xxxxxxxx.cn-beijing.fcapp.run
```

**★ 把这个地址记下来**（复制到记事本），第 6 步要用。

**✅ 检查点**：能看到触发器的公网地址。

---

## 第 5 步：验证后端活了（2 分钟）★ 重要

在浏览器里访问（把地址换成你刚才拿到的）：

```
https://你的函数地址/api/health
```

**应该看到这样的 JSON：**

```json
{
  "ok": true,
  "oss_reachable": true,
  "grsai_configured": true,
  "bucket": "potatoooo",
  "limits": { ... }
}
```

**逐项对照：**

| 字段 | 应该是 | 如果不是 |
|---|---|---|
| `grsai_configured` | `true` | 密钥没配对，回第 3 步检查变量名 |
| `oss_reachable` | `true` | OSS 配置有问题，检查 AK/SK/Endpoint/Bucket |
| `ok` | `true` | 看 `error` 字段说什么 |

**如果报错，把整段 JSON 发我**（把密钥相关的字段遮掉），我告诉你怎么改。

**❌ 如果返回 `Internal Server Error` 或 502**：
八成是 `oss2` 没装上（第 2.3 步）。告诉我。

---

## 第 6 步：部署前端到 OSS（10 分钟）

### 6.1 先改配置（★ 别忘）

1. 把 `deploy\ai-canvas-frontend.zip` 解压到一个文件夹
2. 打开里面的 **`config.local.js`**
3. 把 `BACKEND_URL` 改成第 4 步拿到的函数地址：

```js
window.FC.LOCAL = {
  USE_MOCK: false,

  // ★ 改成你的函数地址（不要带结尾的斜杠）
  BACKEND_URL: 'https://ai-canvas-api-xxxxxxxx.cn-beijing.fcapp.run',

  UPLOAD_URL: '',
  MODELS: { image: 'gpt-image-2.5', video: 'minimax-h3' }
};
```

4. 保存

> **忘了改会怎样？** 不会白屏 —— 页面会弹提示告诉你「BACKEND_URL 还是占位地址」。

### 6.2 开启 OSS 静态网站托管

1. 打开 **https://oss.console.aliyun.com/**
2. 进入你的 bucket（`potatoooo`）
3. 左侧找 **「数据管理」→「静态页面」**（或「基础设置」→「静态网站托管」）
4. **开启**静态网站托管
5. 默认首页填 `index.html`
6. 保存

### 6.3 上传前端文件

1. 左侧 **「文件管理」**
2. 建议先建一个目录，比如 `canvas/`（这样不会和你已有的 `ai-canvas/` 图片混在一起）
3. 进入这个目录，点 **「上传文件」**
4. 把解压出来的**所有文件和文件夹**传上去（`index.html`、`assets/`、`config.local.js`）

**✅ 检查点**：OSS 里能看到 `index.html` 和 `assets/` 目录。

### 6.4 拿到前端地址

静态网站托管开启后，OSS 会给一个访问地址，形如：

```
http://potatoooo.oss-cn-beijing.aliyuncs.com/canvas/index.html
```

（如果你建了 `canvas/` 目录，地址末尾要带上它）

---

## 第 7 步：端到端验证（3 分钟）★ 最后一步

1. 用浏览器打开上面那个前端地址
2. **按 F12 打开开发者工具**
3. 看 **Console（控制台）** 标签

**应该看到：**

```
[main] 后端就绪 {oss: true, grsai: true, wan3: ...}
```

**然后测试真实生成：**

4. 双击画布空白处 → 选「AI 生图模型」
5. 模型选 **`gpt-image-2`**（最便宜，¥0.03）
6. 随便写个提示词，点生成
7. 等一会儿（30 秒左右）

**✅ 检查点**：图片出来了。

**再检查安全性（这条面试能讲）：**

8. 切到 **Network（网络）** 标签，重新生成一次
9. 看请求列表 —— **应该只有对你函数地址的请求**
10. 如果看到 `grsai` / `aitohumanize` / `wuyinkeji` 的域名 → 有问题，告诉我
11. 切到 **Sources**，按 `Ctrl+Shift+F` 搜 `sk-` → **应该搜不到任何东西**

---

## 常见问题

### Q：函数返回 502 / Internal Server Error

八成是缺 `oss2` 依赖。去函数的「日志」里看真实报错，把报错发我。

### Q：前端页面打开了，但生成时报跨域错误

后端已经放了 `Access-Control-Allow-Origin: *`。如果还报跨域，
检查触发器是不是允许了 **POST** 方法。

### Q：`grsai_configured` 是 `false`

环境变量名字写错了。**区分大小写**，必须是 `GRSAI_API_KEY`。
或者密钥那串复制的时候多了空格。

### Q：生成时报「额度不足」

Grsai 账户余额不够了，去 https://grsai.ai/zh/dashboard 充值。
**生图一张 ¥0.03，先充 ¥5 就够演示很久。**

### Q：想改限流额度

改后端 `ratelimit.py` 里的 `DEFAULT_LIMITS`，重新打包上传。

### Q：前端更新了怎么重新部署

```powershell
cd D:\deepseek\ai-canvas
python build_deploy.py
```
然后重新上传前端 zip（记得改 `config.local.js` 里的地址）。

---

## 卡住了怎么办

**把这三样发我，我就能定位问题：**

1. **卡在哪一步**（第几步、在做什么）
2. **屏幕上的报错**（截图，或者把文字复制出来）
3. **第 5 步的 `/api/health` 返回内容**（把密钥字段遮掉）

**⚠️ 发之前检查一遍：不要包含 `sk-` 开头的那串、也不要包含 AccessKeySecret。**

---

## 部署完可以删掉的东西

- 本地 `deploy\` 目录（随时能重新生成）
- 桌面上那个 `AI 画布.lnk` 快捷方式（如果不再需要本地开发）

**别删**：`config.local.js` / `config.oss.local.py`（本地开发还要用）。