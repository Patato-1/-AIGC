# -*- coding: utf-8 -*-
"""
生成「已经配好后端地址」的前端部署包。

为什么要这个
------------
手动流程是：解压 zip → 改 config.local.js → 再把文件夹传上 OSS。
中间有两处容易出错：改错地址、拖拽文件夹拖不进去（很多人是在
Windows 的压缩包预览窗口里拖的，那里的文件拖不出来）。

这个脚本直接生成一个改好地址的 zip，上传后在 OSS 里「解压」即可，
既不用手动改文件，也不用拖文件夹。
"""

import os
import re
import sys
import zipfile

sys.stdout.reconfigure(encoding='utf-8', errors='replace')

BASE = r'D:\deepseek\ai-canvas'
OUT = os.path.join(BASE, 'deploy')

BACKEND = sys.argv[1] if len(sys.argv) > 1 else \
    'https://ai-canvas-api-anclqihhzx.cn-hangzhou.fcapp.run'

CONFIG = """/* ==========================================================================
   config.local.js — 部署配置（已自动填好后端地址）
   --------------------------------------------------------------------------
   这个文件里【没有任何密钥】。所有需要密钥的调用都走 BACKEND_URL 指向的后端。
   ========================================================================== */
window.FC = window.FC || {};

window.FC.LOCAL = {
  USE_MOCK: false,

  // 你的函数计算地址
  BACKEND_URL: '%s',

  // 留空 = 用 BACKEND_URL + /api/upload
  UPLOAD_URL: '',
  UPLOAD_FIELD: 'file',

  MODELS: {
    image: 'gpt-image-2.5',
    video: 'minimax-h3'
  }
};
""" % BACKEND

FILES = ['index.html', 'config.example.js']
DIRS = ['assets']

out_path = os.path.join(OUT, 'ai-canvas-frontend-ready.zip')
count = 0

with zipfile.ZipFile(out_path, 'w', zipfile.ZIP_DEFLATED) as z:
    for f in FILES:
        src = os.path.join(BASE, f)
        if os.path.isfile(src):
            z.write(src, f)
            count += 1
    for d in DIRS:
        root = os.path.join(BASE, d)
        for cur, _dirs, files in os.walk(root):
            for fn in files:
                full = os.path.join(cur, fn)
                rel = os.path.relpath(full, BASE).replace('\\', '/')
                z.write(full, rel)
                count += 1
    z.writestr('config.local.js', CONFIG)
    count += 1

print('=' * 68)
print('生成「配好地址」的前端包')
print('=' * 68)
print('  后端地址: %s' % BACKEND)
print('  文件数  : %d' % count)
print('  大小    : %.1f KB' % (os.path.getsize(out_path) / 1024.0))
print('  位置    : %s' % out_path)
print()

bad = []
with zipfile.ZipFile(out_path) as z:
    for info in z.infolist():
        try:
            t = z.read(info.filename).decode('utf-8', 'ignore')
        except Exception:
            continue
        if re.search(r'sk-[A-Za-z0-9]{20,}', t) or re.search(r'LTAI[A-Za-z0-9]{20,}', t):
            bad.append(info.filename)
    print('  密钥检查: %s' % ('[OK] 没有密钥' if not bad else ('[X] 发现: %s' % bad)))
    print()
    print('  解压后的结构:')
    for n in sorted(z.namelist()):
        print('    %s' % n)