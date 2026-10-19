# -*- coding: utf-8 -*-
"""
build_deploy.py — 打包部署到阿里云函数计算 FC 的 zip

为什么需要这个脚本
------------------
手动挑文件容易漏、也容易**误把密钥文件打进去**。这个脚本按白名单打包，
从根上避免后者。

用法：
    python build_deploy.py

产出：
    deploy/ai-canvas-backend.zip     上传到函数计算
    deploy/ai-canvas-frontend.zip    上传到 OSS 静态托管

两个包的分工：
    后端包 → 函数计算 FC（含 route 逻辑，密钥靠环境变量注入）
    前端包 → OSS 静态托管（不含任何密钥，含一个占位 config.local.js）
"""

import io
import os
import re
import sys
import zipfile

sys.stdout.reconfigure(encoding='utf-8', errors='replace')

BASE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(BASE, 'deploy')

# ---------------------------------------------------------------------------
# 后端：只打这些（白名单，不是黑名单 —— 漏一个不会出事，多一个会泄密）
# ---------------------------------------------------------------------------
BACKEND_FILES = [
    'fc_handler.py',          # 云函数入口
    'upload_server.py',       # route() 业务逻辑
    'grsai.py',               # Grsai 转发
    'wan3.py',                # 速创转发
    'ratelimit.py',           # 限流
    'requirements.txt',       # 依赖
]

# ---------------------------------------------------------------------------
# 前端：HTML + 静态资源
# ---------------------------------------------------------------------------
FRONTEND_FILES = [
    'index.html',
    'config.example.js',
]
FRONTEND_DIRS = [
    'assets',
]

# 这些永远不能进包
FORBIDDEN = [
    'config.local.js',
    'config.oss.local.py',
    'config.wuyinkeji.local.py',
]

# 前端包里的 config.local.js 内容（占位，让访客拿到的是「指向自己后端」的配置）
FRONTEND_CONFIG_STUB = """/* ==========================================================================
   部署时生成的配置
   --------------------------------------------------------------------------
   这个文件由 build_deploy.py 生成，里面【没有任何密钥】。
   所有需要密钥的调用都走 BACKEND_URL 指向的后端。

   部署后请把下面的 BACKEND_URL 改成你的函数计算地址。
   ========================================================================== */
window.FC = window.FC || {};

window.FC.LOCAL = {
  USE_MOCK: false,

  // ★ 改成你的函数计算 HTTP 触发器地址
  BACKEND_URL: 'https://把你的函数地址填这里',

  // 留空 = 用 BACKEND_URL + /api/upload
  UPLOAD_URL: '',
  UPLOAD_FIELD: 'file',

  MODELS: {
    image: 'gpt-image-2.5',
    video: 'minimax-h3'
  }
};
"""


def _fail(msg):
    print('  [x] ' + msg)
    return False


def build_backend():
    """打包后端（给函数计算）"""
    path = os.path.join(OUT, 'ai-canvas-backend.zip')
    missing = [f for f in BACKEND_FILES if not os.path.isfile(os.path.join(BASE, f))]
    if missing:
        _fail('缺少文件: %s' % ', '.join(missing))
        return None

    with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as z:
        for f in BACKEND_FILES:
            z.write(os.path.join(BASE, f), f)
    return path


def build_frontend():
    """打包前端（给 OSS 静态托管）"""
    path = os.path.join(OUT, 'ai-canvas-frontend.zip')
    count = 0

    with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as z:
        for f in FRONTEND_FILES:
            src = os.path.join(BASE, f)
            if os.path.isfile(src):
                z.write(src, f)
                count += 1
        for d in FRONTEND_DIRS:
            root = os.path.join(BASE, d)
            if not os.path.isdir(root):
                continue
            for cur, _dirs, files in os.walk(root):
                for fn in files:
                    full = os.path.join(cur, fn)
                    rel = os.path.relpath(full, BASE).replace('\\', '/')
                    if os.path.basename(rel) in FORBIDDEN:
                        continue
                    z.write(full, rel)
                    count += 1

        # 生成一个不带密钥的 config.local.js
        z.writestr('config.local.js', FRONTEND_CONFIG_STUB)
        count += 1

    return path, count


def audit(zip_path, allow_frontend_stub=False):
    """
    检查包里有没有不该有的东西。
    这一步是最后一道防线 —— 打包错了比不打包更糟。

    @param allow_frontend_stub  前端包会【故意】生成一个不带密钥的
                                config.local.js 占位文件（里面只有
                                BACKEND_URL）。这时文件名本身不算问题，
                                但内容仍然会被下面的密钥扫描检查。
    """
    problems = []
    names = []
    with zipfile.ZipFile(zip_path) as z:
        for info in z.infolist():
            names.append(info.filename)
            base = os.path.basename(info.filename)
            if base in FORBIDDEN:
                if not (allow_frontend_stub and base == 'config.local.js'):
                    problems.append('包含密钥配置: %s' % info.filename)
            if base.endswith('.pyc') or '__pycache__' in info.filename:
                problems.append('包含缓存文件: %s' % info.filename)

        # 扫内容里有没有真的密钥。
        # 注意别误报：代码里会出现 'sk-' 这个字符串本身（比如判断前缀
        # env_key.startswith('sk-')），那不是密钥。真正的密钥长这样：
        # sk- 后面跟 20 位以上的字母数字。
        key_re = re.compile(r'sk-[A-Za-z0-9]{20,}')
        for info in z.infolist():
            if info.file_size > 3 * 1024 * 1024:
                continue
            try:
                text = z.read(info.filename).decode('utf-8', 'ignore')
            except Exception:
                continue
            for line in text.split('\n'):
                m = key_re.search(line)
                if not m:
                    continue
                found = m.group(0)
                # 示例值放过（文档里用 xxx / 你的 之类的占位）
                if re.match(r'sk-(x{3,}|X{3,}|\.{3,}|你的|xxx|Xxx)', found):
                    continue
                problems.append('%s 里有真实密钥（%s…）'
                                % (info.filename, found[:12]))
                break
    return names, problems


def main():
    os.makedirs(OUT, exist_ok=True)

    print('=' * 66)
    print('打包部署文件')
    print('=' * 66)
    print()

    # ---- 后端 ----
    print('【后端】给阿里云函数计算')
    be = build_backend()
    if not be:
        return 1
    names, problems = audit(be)
    print('  %s  (%d 个文件, %.1f KB)' % (
        os.path.basename(be), len(names),
        os.path.getsize(be) / 1024.0))
    for n in sorted(names):
        print('     ' + n)
    if problems:
        print('  [!] 发现问题:')
        for p in problems:
            print('      ' + p)
        return 1
    print('  ✓ 没有密钥配置、没有缓存文件')
    print()

    # ---- 前端 ----
    print('【前端】给 OSS 静态托管')
    fe, cnt = build_frontend()
    names2, problems2 = audit(fe, allow_frontend_stub=True)
    print('  %s  (%d 个文件, %.1f KB)' % (
        os.path.basename(fe), cnt, os.path.getsize(fe) / 1024.0))
    # 前端文件多，只列非 assets 的
    for n in sorted(names2):
        if not n.startswith('assets/js/') and not n.startswith('assets/css/'):
            print('     ' + n)
    print('     assets/js/*.js        (%d 个)' % len([n for n in names2 if n.startswith('assets/js/')]))
    print('     assets/css/*.css      (%d 个)' % len([n for n in names2 if n.startswith('assets/css/')]))
    if problems2:
        print('  [!] 发现问题:')
        for p in problems2:
            print('      ' + p)
        return 1
    print('  ✓ 没有真实密钥')
    print('  ✓ 已生成占位 config.local.js（记得改里面的 BACKEND_URL）')
    print()

    print('=' * 66)
    print('下一步')
    print('=' * 66)
    print("""
  1. 后端 → 阿里云函数计算 FC，上传 %s
     请求处理程序填：fc_handler.handler
     然后在「配置 → 环境变量」里配好密钥（见 DEPLOY.md 第二节）

  2. 前端 → OSS 静态网站托管，解压 %s 上传
     ★ 上传前先改 config.local.js 里的 BACKEND_URL 为你的函数地址

  3. 验证：访问 https://你的函数地址/api/health
     看到 "grsai_configured": true 就说明密钥读到了
""" % (os.path.basename(be), os.path.basename(fe)))
    return 0


if __name__ == '__main__':
    sys.exit(main())