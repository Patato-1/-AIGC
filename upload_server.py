#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
upload_server.py — 把图片传到阿里云 OSS，换回一个公网 URL

为什么需要它
------------
有些 AI 接口（比如速创的 Wan3.0 视频）只收图片的**公网 URL**，不收 base64。
而你自己电脑里的图、画布里存的图，都没有公网地址。这个后端就是干这个的：

    浏览器  ──POST /api/upload──▶  本服务  ──▶  阿里云 OSS
                                      │
                                ◀── 返回公网 URL
                                      │
                            浏览器拿这个 URL 去调 AI 接口

跑起来
------
    python upload_server.py

它默认监听 8778。start.bat 会连静态服务一起拉起来。

配置
----
复制 config.oss.example.py 成 config.oss.local.py，填上 AccessKey / Bucket。
也可以改用环境变量：OSS_ACCESS_KEY_ID / OSS_ACCESS_KEY_SECRET / OSS_ENDPOINT / OSS_BUCKET

接口
----
    GET  /api/health          看看配置对不对、OSS 通不通
    POST /api/upload          传图，拿 URL

POST /api/upload 的三种用法（JSON body）：

    {"data": "data:image/png;base64,iVBOR...", "name": "我的图"}
        传 base64 / dataURL（画布里的图就是这么传的）

    {"data": "<base64 纯字符串>", "name": "x"}
        不带 dataURL 前缀的纯 base64 也行

    {"url": "https://file5.aitohumanize.com/file/xxx.png", "name": "x"}
        给一个远程地址，本服务替你抓下来再转存到 OSS
        —— 用途：中转站图床会挂、会过期，转存一份到自己这里更稳

返回：
    {"ok": true, "url": "https://bucket.oss-cn-....aliyuncs.com/ai-canvas/xxx.png",
     "key": "ai-canvas/xxx.png", "size": 123456, "type": "image/png"}
"""

import base64
import json
import os
import re
import sys
import time
import uuid
import mimetypes
import urllib.request
import urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# Windows 控制台默认是 GBK，直接 print 中文/符号会 UnicodeEncodeError 崩掉。
# 强制把 stdout/stderr 切到 UTF-8（Python 3.7+ 才支持 reconfigure）。
for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass

# ---------------------------------------------------------------------------
# 配置：先看环境变量，再看 config.oss.local.py
# ---------------------------------------------------------------------------

CFG = {
    'OSS_ACCESS_KEY_ID': os.environ.get('OSS_ACCESS_KEY_ID', ''),
    'OSS_ACCESS_KEY_SECRET': os.environ.get('OSS_ACCESS_KEY_SECRET', ''),
    'OSS_ENDPOINT': os.environ.get('OSS_ENDPOINT', ''),
    'OSS_BUCKET': os.environ.get('OSS_BUCKET', ''),
    'OSS_PREFIX': os.environ.get('OSS_PREFIX', 'ai-canvas/'),
    'PORT': int(os.environ.get('UPLOAD_PORT', '8778')),
    # 视频比图大得多（1080p 10 秒可能几十 MB），所以给宽一点。
    # 走 {url:...} 模式时文件不经过浏览器，只是本机内存里过一下，100MB 没问题。
    'MAX_UPLOAD_BYTES': 100 * 1024 * 1024,
    'USE_HTTPS': True,
    'CUSTOM_DOMAIN': '',
}


# 本文件所在目录。
# 两个用途：读 config.*.local.py，以及让 `import wan3` 能找到同目录的 wan3.py。
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
if BASE_DIR not in sys.path:
    sys.path.insert(0, BASE_DIR)


def load_config():
    """读 config.oss.local.py（不存在也不报错，环境变量就够了）"""
    here = BASE_DIR
    path = os.path.join(here, 'config.oss.local.py')
    if not os.path.isfile(path):
        return False
    ns = {}
    try:
        with open(path, 'r', encoding='utf-8') as f:
            code = f.read()
        exec(compile(code, path, 'exec'), ns)
    except Exception as e:
        print('[upload] 读 config.oss.local.py 失败: %s' % e)
        return False

    for k in list(CFG.keys()):
        v = ns.get(k)
        # 只接受非空值，免得模板里的空串把环境变量覆盖掉
        if v not in (None, '', 0):
            CFG[k] = v
    return True


def config_ready():
    missing = [k for k in ('OSS_ACCESS_KEY_ID', 'OSS_ACCESS_KEY_SECRET',
                           'OSS_ENDPOINT', 'OSS_BUCKET') if not CFG.get(k)]
    return (not missing), missing


# ---------------------------------------------------------------------------
# OSS
# ---------------------------------------------------------------------------

_bucket = None


def get_bucket():
    global _bucket
    if _bucket is not None:
        return _bucket
    try:
        import oss2
    except ImportError:
        raise RuntimeError('没装 oss2。执行：python -m pip install oss2')

    auth = oss2.Auth(CFG['OSS_ACCESS_KEY_ID'], CFG['OSS_ACCESS_KEY_SECRET'])
    _bucket = oss2.Bucket(auth, CFG['OSS_ENDPOINT'], CFG['OSS_BUCKET'])
    return _bucket


def public_url(key):
    if CFG.get('CUSTOM_DOMAIN'):
        return CFG['CUSTOM_DOMAIN'].rstrip('/') + '/' + key
    scheme = 'https' if CFG.get('USE_HTTPS') else 'http'
    return '%s://%s.%s/%s' % (scheme, CFG['OSS_BUCKET'], CFG['OSS_ENDPOINT'], key)


def guess_ext(mime, fallback='.png'):
    m = {
        'image/png': '.png', 'image/jpeg': '.jpg', 'image/jpg': '.jpg',
        'image/webp': '.webp', 'image/gif': '.gif', 'image/bmp': '.bmp',
        'video/mp4': '.mp4', 'video/quicktime': '.mov',
        'audio/mpeg': '.mp3', 'audio/wav': '.wav',
    }
    if mime in m:
        return m[mime]
    ext = mimetypes.guess_extension(mime or '') if mime else None
    return ext or fallback


def safe_name(name):
    """
    把用户给的名字洗成一个安全的文件名片段。

    只保留 ASCII 字母数字和 - _：返回的 URL 要交给第三方接口（如速创 Wan3.0）
    去抓取，中文等非 ASCII 字符在部分 HTTP 客户端上会出问题。
    名字只是为了好认，唯一性靠时间戳 + 随机串保证。
    """
    name = re.sub(r'\.[A-Za-z0-9]{1,5}$', '', str(name or ''))   # 去掉扩展名
    name = name.encode('ascii', 'ignore').decode('ascii')        # 丢掉非 ASCII（中文等）
    name = re.sub(r'[\\/:*?"<>|\s]+', '_', name)              # 去掉非法字符
    name = re.sub(r'_+', '_', name).strip('_')
    return name[:40] or 'upload'


def decode_payload(body):
    """
    从请求体里拿出二进制内容 + mime + 名字。
    支持 {data: dataURL} / {data: base64} / {url: 远程地址}
    返回 (raw_bytes, mime, name, source)
    """
    data = body.get('data')
    remote = body.get('url')
    name = body.get('name') or ''

    if remote:
        if not re.match(r'^https?://', str(remote)):
            raise ValueError('url 必须是 http/https 开头')
        req = urllib.request.Request(str(remote), headers={'User-Agent': 'ai-canvas-upload/1.0'})
        with urllib.request.urlopen(req, timeout=60) as resp:
            raw = resp.read()
            mime = (resp.headers.get('Content-Type') or '').split(';')[0].strip()
        if not mime:
            mime = mimetypes.guess_type(str(remote))[0] or 'image/png'
        if not name:
            name = os.path.basename(str(remote).split('?')[0])
        return raw, mime, name, 'remote'

    if not data:
        raise ValueError('请求体里要有 data 或 url')

    text = str(data).strip()
    mime = ''
    # dataURL: data:image/png;base64,xxxx
    m = re.match(r'^data:([^;,]+)?(;base64)?,(.*)$', text, re.S)
    if m:
        mime = m.group(1) or ''
        b64 = m.group(3)
        if not m.group(2):
            # 不是 base64 而是 URL-encoded 的 dataURL，少见但兼容一下
            return urllib.parse.unquote_to_bytes(b64), mime or 'image/png', name, 'dataurl'
    else:
        b64 = text

    b64 = re.sub(r'\s+', '', b64)
    try:
        raw = base64.b64decode(b64, validate=False)
    except Exception:
        raise ValueError('data 既不是合法 base64，也不是 dataURL')

    if not mime:
        # 从魔数猜
        if raw[:8] == b'\x89PNG\r\n\x1a\n':
            mime = 'image/png'
        elif raw[:3] == b'\xff\xd8\xff':
            mime = 'image/jpeg'
        elif raw[:4] == b'RIFF' and raw[8:12] == b'WEBP':
            mime = 'image/webp'
        elif raw[:6] in (b'GIF87a', b'GIF89a'):
            mime = 'image/gif'
        else:
            mime = 'application/octet-stream'
    return raw, mime, name, 'base64'


def do_upload(body):
    ready, missing = config_ready()
    if not ready:
        raise RuntimeError('OSS 还没配置好，缺：%s。请复制 config.oss.example.py 成 '
                           'config.oss.local.py 并填写。' % '、'.join(missing))

    raw, mime, name, source = decode_payload(body)

    if not raw:
        raise ValueError('内容是空的')
    if len(raw) > CFG['MAX_UPLOAD_BYTES']:
        raise ValueError('文件太大（%.1f MB），上限 %.0f MB'
                         % (len(raw) / 1048576.0, CFG['MAX_UPLOAD_BYTES'] / 1048576.0))

    ext = guess_ext(mime)
    stamp = time.strftime('%Y%m%d-%H%M%S')
    key = '%s%s_%s_%s%s' % (CFG['OSS_PREFIX'], stamp, safe_name(name),
                            uuid.uuid4().hex[:8], ext)

    bucket = get_bucket()
    bucket.put_object(key, raw, headers={'Content-Type': mime or 'application/octet-stream'})

    return {
        'ok': True,
        'url': public_url(key),
        'key': key,
        'size': len(raw),
        'type': mime,
        'source': source,
    }


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------

def route(method, path, query, body, client_ip):
    """
    路由分发 —— 与传输层无关。

    这一层是「业务逻辑」，不关心请求是从哪来的。上面那个 http.server 的
    Handler 只是它在本机的一个适配器；部署到阿里云函数计算时，
    fc_handler.py 是另一个适配器，两边共用同一份路由和校验逻辑。

    @param method     'GET' / 'POST'
    @param path       不带查询串的路径，如 '/api/health'
    @param query      dict（已经 parse_qs 过），如 {'id': ['xxx']}
    @param body       POST 的 JSON dict（GET 传 None）
    @param client_ip  客户端真实 IP，用于限流
    @returns (status:int, payload:dict)
    """
    qs = query or {}

    # ============================ GET ============================
    if method == 'GET':

        if path == '/api/health':
            ready, missing = config_ready()
            info = {
                'ok': ready,
                'oss_configured': ready,
                'missing': missing,
                'bucket': CFG['OSS_BUCKET'] or None,
                'endpoint': CFG['OSS_ENDPOINT'] or None,
                'prefix': CFG['OSS_PREFIX'],
            }
            if ready:
                try:
                    get_bucket().get_bucket_info()
                    info['oss_reachable'] = True
                except Exception as e:
                    info['ok'] = False
                    info['oss_reachable'] = False
                    info['error'] = str(e)
            # 两边模型通道配好没有
            try:
                import wan3
                cfg, err = wan3.get_config(BASE_DIR)
                info['wan3_configured'] = bool(cfg)
                if err:
                    info['wan3_error'] = err
            except Exception as e:
                info['wan3_configured'] = False
                info['wan3_error'] = str(e)
            try:
                import grsai
                cfg2, err2 = grsai._load_cfg(BASE_DIR)
                info['grsai_configured'] = bool(cfg2)
                if err2:
                    info['grsai_error'] = err2
            except Exception as e:
                info['grsai_configured'] = False
                info['grsai_error'] = str(e)
            try:
                import ratelimit
                info['limits'] = ratelimit.snapshot()
            except Exception as e:
                info['limits_error'] = str(e)
            return (200 if info['ok'] else 503), info

        # ---- Grsai 结果查询（转发）----
        if path == '/api/gr/result':
            try:
                import grsai
                cfg, err = grsai._load_cfg(BASE_DIR)
                if not cfg:
                    return 400, {'ok': False, 'error': err}
                tid = (qs.get('id') or [''])[0]
                return 200, grsai.result(cfg, tid)
            except Exception as e:
                return 500, {'ok': False, 'error': '%s: %s' % (type(e).__name__, e)}

        # ---- 速创 Wan3.0 结果查询（转发）----
        if path == '/api/wy/detail':
            try:
                import wan3
                cfg, err = wan3.get_config(BASE_DIR)
                if not cfg:
                    return 400, {'ok': False, 'error': err}
                tid = (qs.get('id') or [''])[0]
                return 200, wan3.detail(cfg, tid)
            except Exception as e:
                return 500, {'ok': False, 'error': '%s: %s' % (type(e).__name__, e)}

        if path in ('/', '/index.html'):
            return 200, {
                'service': 'ai-canvas backend',
                'endpoints': [
                    'GET  /api/health',
                    'POST /api/upload       图片转存到 OSS',
                    'POST /api/gr/submit    Grsai 生图/视频提交（密钥在后端）',
                    'GET  /api/gr/result?id= Grsai 查结果',
                    'POST /api/wy/submit    速创 Wan3.0 提交',
                    'GET  /api/wy/detail?id= 速创 Wan3.0 查结果',
                ],
            }
        return 404, {'ok': False, 'error': 'not found'}

    # ============================ POST ============================
    if method == 'POST':
        try:
            if path == '/api/upload':
                return 200, do_upload(body or {})

            # ---- Grsai 提交（转发 + 限流）----
            if path == '/api/gr/submit':
                import grsai
                import ratelimit
                body = body or {}
                is_video = str(body.get('kind')) == 'video'
                # 限流：前端能被绕过，后端不能
                allowed, why, retry = ratelimit.check(client_ip, is_video)
                if not allowed:
                    return 429, {'ok': False, 'error': why, 'retryAfter': retry}
                cfg, err = grsai._load_cfg(BASE_DIR)
                if not cfg:
                    return 400, {'ok': False, 'error': err}
                return 200, grsai.submit(cfg, body)

            # ---- 速创 Wan3.0 提交（转发 + 限流）----
            if path == '/api/wy/submit':
                import ratelimit
                import wan3
                allowed, why, retry = ratelimit.check(client_ip, True)
                if not allowed:
                    return 429, {'ok': False, 'error': why, 'retryAfter': retry}
                cfg, err = wan3.get_config(BASE_DIR)
                if not cfg:
                    return 400, {'ok': False, 'error': err}
                return 200, wan3.submit(cfg, body or {})

            return 404, {'ok': False, 'error': 'not found'}
        except ValueError as e:
            return 400, {'ok': False, 'error': str(e)}
        except urllib.error.HTTPError as e:
            return 400, {'ok': False, 'error': '抓取远程文件失败：HTTP %s' % e.code}
        except Exception as e:
            return 500, {'ok': False, 'error': '%s: %s' % (type(e).__name__, e)}

    return 405, {'ok': False, 'error': 'method not allowed'}


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    server_version = 'ai-canvas-upload/1.0'

    def log_message(self, fmt, *args):
        sys.stderr.write('  [upload] %s - %s\n' % (self.address_string(), fmt % args))

    def _client_ip(self):
        """
        取客户端 IP。部署在反向代理 / 函数计算后面时，真实 IP 在
        X-Forwarded-For 的第一段（最左边那个是原始客户端）。
        """
        xff = self.headers.get('X-Forwarded-For') or ''
        if xff:
            first = xff.split(',')[0].strip()
            if first:
                return first
        real = self.headers.get('X-Real-IP')
        if real:
            return real.strip()
        return self.client_address[0] if self.client_address else 'unknown'

    # ---- 工具 ----
    def _send(self, code, payload, ctype='application/json; charset=utf-8'):
        if isinstance(payload, (dict, list)):
            payload = json.dumps(payload, ensure_ascii=False).encode('utf-8')
        elif isinstance(payload, str):
            payload = payload.encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(payload)))
        self.send_header('Cache-Control', 'no-store')
        # 前端在另一个端口（8777），必须放开跨域
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Headers', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.end_headers()
        try:
            self.wfile.write(payload)
        except Exception:
            pass

    def _read_json(self):
        n = int(self.headers.get('Content-Length') or 0)
        if n <= 0:
            return {}
        if n > CFG['MAX_UPLOAD_BYTES'] * 2:
            raise ValueError('请求体太大')
        raw = self.rfile.read(n)
        try:
            return json.loads(raw.decode('utf-8'))
        except Exception:
            raise ValueError('请求体不是合法 JSON')

    # ---- 路由 ----
    def do_OPTIONS(self):
        self._send(204, b'', 'text/plain')

    def do_GET(self):
        self._dispatch('GET')

    def do_POST(self):
        self._dispatch('POST')

    def _dispatch(self, method):
        """
        本机 HTTP 适配器：把请求交给 route()，再把结果写回响应。
        业务逻辑全在 route() 里，部署到函数计算时换成另一个适配器即可。
        """
        path = self.path.split('?')[0]
        qs = urllib.parse.parse_qs(self.path.split('?', 1)[1]) if '?' in self.path else {}
        try:
            body = self._read_json() if method == 'POST' else None
        except ValueError as e:
            return self._send(400, {'ok': False, 'error': str(e)})
        code, payload = route(method, path, qs, body, self._client_ip())
        return self._send(code, payload)



def main():
    port = CFG['PORT']
    if len(sys.argv) > 1:
        try:
            port = int(sys.argv[1])
        except ValueError:
            pass

    load_config()
    ready, missing = config_ready()

    print('')
    print('  图片上传服务')
    print('  ----------------------------------------')
    if ready:
        print('  OSS bucket : %s' % CFG['OSS_BUCKET'])
        print('  OSS 节点   : %s' % CFG['OSS_ENDPOINT'])
        print('  目录前缀   : %s' % CFG['OSS_PREFIX'])
    else:
        print('  [!] OSS 还没配置，缺：%s' % '、'.join(missing))
        print('     复制 config.oss.example.py 成 config.oss.local.py 并填写')
    print('  监听       : http://127.0.0.1:%d' % port)
    print('  健康检查   : http://127.0.0.1:%d/api/health' % port)
    print('')

    server = ThreadingHTTPServer(('127.0.0.1', port), Handler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\n  已停止')
    finally:
        server.server_close()


if __name__ == '__main__':
    main()