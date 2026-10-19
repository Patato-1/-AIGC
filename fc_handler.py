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


def handler(event, context):
    """阿里云函数计算入口"""
    if event is None:
        event = {}

    # 大部分 FC 版本限制单次请求体大小，超过会在平台层就被拦掉
    headers = _lower_headers(_first(event, 'headers') or {})

    method = (_first(event, 'httpMethod', 'requestContext.http.method',
                     'requestContext.httpMethod') or 'GET').upper()

    path = _first(event, 'rawPath', 'path', 'requestContext.http.path') or '/'
    path = str(path).split('?')[0]

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

    try:
        code, payload = upload_server.route(method, path, query, body, client_ip)
    except Exception as e:
        code = 500
        payload = {'ok': False, 'error': '%s: %s' % (type(e).__name__, e)}

    return {
        'statusCode': code,
        'headers': {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Headers': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        },
        'body': json.dumps(payload, ensure_ascii=False),
    }