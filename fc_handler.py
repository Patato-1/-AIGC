# -*- coding: utf-8 -*-
"""
fc_handler.py — 阿里云函数计算的入口

部署说明
--------
这个文件只在**线上**用得到。本地开发还是跑 upload_server.py。

它们的关系：

    route()                  ← 业务逻辑（upload_server.py 里）
      ├─ Handler             ← 本机适配器（http.server）
      └─ handler(event, …)   ← 云函数适配器（本文件）

所以同一套路由、同一套参数校验、同一套限流，本地和线上完全一致 ——
不会出现「本地好的线上坏」。

配环境变量（不要传密钥文件上去）
--------------------------------
在函数计算的「配置 → 环境变量」里加：

    GRSAI_BASE_URL        https://grsai.dakka.com.cn
    GRSAI_API_KEY         sk-xxxx
    OSS_ACCESS_KEY_ID     LTAIxxxx
    OSS_ACCESS_KEY_SECRET xxxx
    OSS_ENDPOINT          oss-cn-beijing.aliyuncs.com
    OSS_BUCKET            potatoooo
    OSS_PREFIX            ai-canvas/
    WUYINKEJI_KEY         xxxx          (可选，接 Wan3.0 才需要)

阿里云函数计算的 event 结构（HTTP 触发器 / 3.0）大致是：
    {
      "requestContext": {...},
      "httpMethod": "POST",          # 或 "requestContext.http.method"
      "path": "/api/gr/submit",      # 或 "rawPath"
      "queryString": {...},
      "headers": {...},
      "body": "..."                  # 字符串，可能是 base64
    }
不同版本字段略有差别，所以下面做了兼容取值。
"""

import base64
import json
import os
import sys

# 让 import upload_server 能找到同目录的模块
_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

import upload_server  # noqa: E402


def _first(d, *keys):
    """从可能的多个字段名里取第一个非空值（兼容不同 FC 版本的 event 结构）"""
    for k in keys:
        cur = d
        ok = True
        for part in k.split('.'):
            if isinstance(cur, dict) and part in cur:
                cur = cur[part]
            else:
                ok = False
                break
        if ok and cur not in (None, ''):
            return cur
    return None


def _client_ip(event, headers):
    xff = headers.get('x-forwarded-for') or headers.get('X-Forwarded-For')
    if xff:
        return str(xff).split(',')[0].strip()
    real = headers.get('x-real-ip') or headers.get('X-Real-IP')
    if real:
        return str(real).strip()
    return _first(event, 'requestContext.http.sourceIp',
                  'requestContext.sourceIp', 'sourceIp') or 'unknown'


def _lower_headers(h):
    return {str(k).lower(): v for k, v in (h or {}).items()}


def _parse_event(event):
    """
    把 event 弄成 dict。

    有的运行时会把它作为 JSON 字符串传进来，而不是已经解析好的对象 ——
    如果不处理，后面所有 event.get / in 判断都会静默失败，
    表现是「所有路径都返回同一个响应」，非常难查。
    """
    if event is None:
        return {}
    if isinstance(event, (bytes, bytearray)):
        try:
            event = event.decode('utf-8')
        except Exception:
            return {}
    if isinstance(event, str):
        try:
            event = json.loads(event)
        except Exception:
            return {}
    return event if isinstance(event, dict) else {}


def _diag(event):
    """
    收集 event 的结构信息（只有键名和类型，不含任何值）。

    函数计算的 event 结构各版本有差异，当路由解析不出来时，把这份信息
    带在响应里，一次调用就能看出真实结构，不用去翻日志。
    键名和类型不涉及密钥，可以安全返回。
    """
    if not isinstance(event, dict):
        return {'eventType': type(event).__name__}
    info = {'keys': sorted(event.keys())}
    for k in ('rawPath', 'path', 'httpMethod', 'version', 'isBase64Encoded'):
        if k in event:
            v = event[k]
            info[k] = v if isinstance(v, (str, int, bool)) else '<%s>' % type(v).__name__
    for holder in ('requestContext', 'http', 'request'):
        v = event.get(holder)
        if isinstance(v, dict):
            info[holder + '.keys'] = sorted(v.keys())
            inner = v.get('http') if holder == 'requestContext' else None
            if isinstance(inner, dict):
                info['requestContext.http.keys'] = sorted(inner.keys())
    return info


def _resolve_path(event):
    """
    从 event 里找出请求路径。

    不同版本 / 不同触发器的字段名不一样，所以按可能性依次尝试。
    返回 (path, source)，source 用来说明这条路径是从哪个字段拿到的 ——
    它也是「结构没猜对」的探测器：如果 source 是 'default'，
    说明所有字段都没匹配上，该看诊断信息了。
    """
    def _get(e, *path_parts):
        cur = e
        for part in path_parts:
            if not isinstance(cur, dict):
                return None
            cur = cur.get(part)
        return cur

    candidates = [
        ('rawPath', lambda e: _get(e, 'rawPath')),
        ('path', lambda e: _get(e, 'path')),
        ('requestContext.http.path', lambda e: _get(e, 'requestContext', 'http', 'path')),
        ('requestContext.path', lambda e: _get(e, 'requestContext', 'path')),
        ('http.path', lambda e: _get(e, 'http', 'path')),
        ('request.path', lambda e: _get(e, 'request', 'path')),
    ]
    for name, get in candidates:
        try:
            v = get(event)
        except Exception:
            v = None
        if v:
            return str(v).split('?')[0], name
    return '/', 'default'


def handler(event, context):
    """阿里云函数计算入口"""
    if event is None:
        event = {}

    # 有的运行时把 event 作为 JSON 字符串传进来，先统一成 dict
    event = _parse_event(event)

    if not event:
        return {
            'statusCode': 400,
            'headers': {'Content-Type': 'application/json; charset=utf-8'},
            'body': json.dumps({'ok': False,
                                'error': '收到空的 event（函数计算的输入结构可能变了）'},
                               ensure_ascii=False),
        }

    # 大部分 FC 版本限制单次请求体大小，超过会在平台层就被拦掉
    headers = _lower_headers(_first(event, 'headers') or {})

    method = (_first(event, 'httpMethod', 'requestContext.http.method',
                     'requestContext.httpMethod') or 'GET').upper()

    path, path_src = _resolve_path(event)

    # 查询串
    query = _first(event, 'queryString', 'queryParameters',
                   'requestContext.http.queryString') or {}
    if isinstance(query, str):
        import urllib.parse
        query = urllib.parse.parse_qs(query)
    elif isinstance(query, dict):
        # FC 有时给的是 {k: 'v'}，统一成 parse_qs 那种 {k: ['v']}
        query = {k: (v if isinstance(v, list) else [v]) for k, v in query.items()}

    # 请求体
    body = None
    raw = _first(event, 'body')
    if raw:
        if event.get('isBase64Encoded'):
            try:
                raw = base64.b64decode(raw).decode('utf-8')
            except Exception:
                raw = ''
        if raw:
            try:
                body = json.loads(raw)
            except Exception:
                return {
                    'statusCode': 400,
                    'headers': {'Content-Type': 'application/json; charset=utf-8'},
                    'body': json.dumps({'ok': False, 'error': '请求体不是合法 JSON'},
                                       ensure_ascii=False),
                }

    client_ip = _client_ip(event, headers)

    # 诊断：如果路径是从默认值来的（说明字段名都没匹配上），
    # 或者显式带了 ?debug=1，就把 event 的结构附在响应里。
    # 这样一次调用就能看出函数计算实际传的是什么结构，不用去翻日志。
    want_debug = (path_src == 'default') or (query.get('debug') == ['1'])

    try:
        code, payload = upload_server.route(method, path, query, body, client_ip)
    except Exception as e:
        code = 500
        payload = {'ok': False, 'error': '%s: %s' % (type(e).__name__, e)}

    if want_debug and isinstance(payload, dict) and '_raw' not in payload:
        payload['_debug'] = {
            'resolvedPath': path,
            'pathSource': path_src,
            'method': method,
            'event': _diag(event),
        }

    # 基础响应头
    # Content-Disposition: inline 是必须的 —— 函数计算的 HTTP 触发器默认
    # 会给响应加 attachment，浏览器打开网页会变成「下载文件」而不是显示。
    # 我们自己声明 inline 把它盖掉（静态文件和 API 都要，否则前端加载不了）。
    headers = {
        'Content-Disposition': 'inline',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    }

    # 静态文件：payload 是 {'_raw': bytes, '_ctype': ..., '_headers': {...}}
    if isinstance(payload, dict) and '_raw' in payload:
        headers['Content-Type'] = payload.get('_ctype') or 'application/octet-stream'
        headers.update(payload.get('_headers') or {})
        body_out = payload['_raw']
        if isinstance(body_out, (bytes, bytearray)):
            body_out = base64.b64encode(bytes(body_out)).decode('ascii')
            return {
                'statusCode': code,
                'headers': headers,
                'body': body_out,
                'isBase64Encoded': True,
            }
        return {'statusCode': code, 'headers': headers, 'body': body_out}

    headers['Content-Type'] = 'application/json; charset=utf-8'
    return {
        'statusCode': code,
        'headers': headers,
        'body': json.dumps(payload, ensure_ascii=False),
    }