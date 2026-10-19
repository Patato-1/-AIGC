# -*- coding: utf-8 -*-
"""
grsai.py — Grsai 中转站的后端转发（生图 + 视频）

为什么必须走后端
----------------
密钥是能花钱的东西。前端直连 = 密钥写在 JS 里 = 任何人 F12 就能拿走刷余额。
放后端，浏览器永远看不到密钥。

这一层除了转发，还顺带做**参数校验和夹紧**：
公开站点上，客户端是可以被伪造的 —— 有人能直接 POST 一个「1080p 15 秒」
的请求把你的余额刷光。所以这里不信客户端，按白名单重建请求体。

接口
----
    POST /api/gr/submit    提交（校验 + 转发）
    GET  /api/gr/result    查询（转发）
"""

import json
import re
import urllib.error
import urllib.parse
import urllib.request

# ---------------------------------------------------------------------------
# 白名单 / 上限：客户端说什么不算数，以这里为准
# ---------------------------------------------------------------------------

# 允许的生图模型
IMAGE_MODELS = [
    'gpt-image-2.5', 'gpt-image-2', 'gpt-image-2-vip',
    'nano-banana-2', 'nano-banana-pro',
]

# 允许的视频模型
VIDEO_MODELS = ['minimax-h3']

# 生图比例（gpt-image 系列支持这些写法）
IMAGE_RATIOS = ['auto', '1:1', '4:3', '3:4', '16:9', '9:16', '3:2', '2:3']

# 视频比例：minimax-h3 只认这两个
VIDEO_RATIOS = ['landscape', 'portrait']

# 视频分辨率，以及各自允许的最大时长（秒）
# 官方文档：duration 支持 1~15 秒，1080p 最多 10 秒
VIDEO_RES_CAPS = {'480p': 15, '768p': 15, '1080p': 10}

MAX_REF_IMAGES = 9        # minimax-h3 最多 9 张参考图
MAX_PROMPT_LEN = 4000
MAX_REF_BYTES = 12 * 1024 * 1024   # 单张参考图上限（base64 解码后）


def _load_cfg(base_dir):
    """
    取 Grsai 配置，优先级：
        1. 环境变量（部署时用这个 —— 阿里云函数计算 FC 就是配环境变量）
        2. config.local.js（本地开发方便，那个文件在 .gitignore 里）

    环境变量名：
        GRSAI_BASE_URL   节点地址
        GRSAI_API_KEY    密钥
    """
    import io
    import os

    env_base = (os.environ.get('GRSAI_BASE_URL') or '').strip()
    env_key = (os.environ.get('GRSAI_API_KEY') or '').strip()
    if env_base and env_key:
        return {
            'base': env_base.rstrip('/'),
            'key': env_key,
            'header': (os.environ.get('GRSAI_KEY_HEADER') or 'Authorization'),
            'prefix': ('Bearer ' if env_key.startswith('sk-') else ''),
            'source': 'env',
        }, None

    path = os.path.join(base_dir, 'config.local.js')
    if not os.path.isfile(path):
        return None, ('没配 Grsai：可以设环境变量 GRSAI_BASE_URL / GRSAI_API_KEY，'
                      '或者建一个 config.local.js')
    try:
        txt = io.open(path, encoding='utf-8').read()
    except Exception as e:
        return None, '读 config.local.js 失败: %s' % e

    def grab(name):
        m = re.search(name + r"\s*:\s*'([^']*)'", txt)
        return m.group(1) if m else ''

    base = grab('BASE_URL')
    key = grab('API_KEY')
    if not base:
        return None, 'config.local.js 里没配 BASE_URL'
    if not key or '在这里' in key:
        return None, ('没配 Grsai 密钥。去 https://grsai.ai/zh/dashboard/api-keys 拿，'
                      '填到 config.local.js 的 API_KEY，或设环境变量 GRSAI_API_KEY')
    return {
        'base': base.rstrip('/'),
        'key': key,
        'header': grab('API_KEY_HEADER') or 'Authorization',
        'prefix': 'Bearer ',
        'source': 'file',
    }, None


def _request(url, data=None, headers=None, timeout=120):
    req = urllib.request.Request(url, data=data, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read().decode('utf-8', 'replace')
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode('utf-8', 'replace')


def _strip_dataurl(s):
    """把 dataURL 变成纯 base64；本来就是纯 base64 就原样返回"""
    s = str(s or '')
    m = re.match(r'^data:[^;,]*;base64,(.*)$', s, re.S)
    return m.group(1) if m else s


def _clamp_int(v, lo, hi, default):
    try:
        n = int(float(str(v).strip()))
    except Exception:
        return default
    return max(lo, min(hi, n))


# ---------------------------------------------------------------------------
# 提交
# ---------------------------------------------------------------------------

def build_body(job):
    """
    按白名单重建请求体。返回 (body, error)。
    客户端传来的东西一律不信任 —— 这是公开站点的基本要求。
    """
    kind = job.get('kind') if job.get('kind') in ('image', 'video') else 'image'
    prompt = str(job.get('prompt') or '').strip()
    if not prompt:
        return None, '提示词不能为空'
    if len(prompt) > MAX_PROMPT_LEN:
        prompt = prompt[:MAX_PROMPT_LEN]

    body = {'prompt': prompt, 'replyType': 'async'}

    # 参考图：统一成 base64（中转站两种都收）
    refs = job.get('refs') or []
    if isinstance(refs, list) and refs:
        imgs = []
        for r in refs[:MAX_REF_IMAGES]:
            data = r.get('image') if isinstance(r, dict) else r
            b64 = _strip_dataurl(data)
            if not b64:
                continue
            if len(b64) > MAX_REF_BYTES:
                return None, '参考图太大（超过 %d MB）' % (MAX_REF_BYTES // 1048576)
            imgs.append(b64)
        if imgs:
            body['images'] = imgs

    if kind == 'video':
        model = job.get('model') if job.get('model') in VIDEO_MODELS else VIDEO_MODELS[0]
        ratio = job.get('ratio') if job.get('ratio') in VIDEO_RATIOS else VIDEO_RATIOS[0]
        res = job.get('resolution') if job.get('resolution') in VIDEO_RES_CAPS else '768p'
        cap = VIDEO_RES_CAPS[res]
        # 时长按分辨率夹紧 —— 客户端可以伪造请求，不能让它提交 1080p+15秒
        dur = _clamp_int(job.get('duration'), 1, cap, min(5, cap))
        body.update({
            'model': model,
            'aspectRatio': ratio,
            'resolution': res,
            'duration': dur,
        })
        if job.get('seed') is not None:
            body['seed'] = _clamp_int(job.get('seed'), 0, 2 ** 31 - 1, 0)
    else:
        model = job.get('model') if job.get('model') in IMAGE_MODELS else IMAGE_MODELS[0]
        ratio = job.get('ratio') if job.get('ratio') in IMAGE_RATIOS else 'auto'
        body.update({
            'model': model,
            'aspectRatio': ratio,
            'quality': 'auto',      # gpt-image-2/2.5 只支持 auto
        })

    return body, None


def submit(cfg, job):
    body, err = build_body(job)
    if err:
        return {'ok': False, 'error': err}

    data = json.dumps(body, ensure_ascii=False).encode('utf-8')
    st, txt = _request(cfg['base'] + '/v1/api/generate', data, {
        'Content-Type': 'application/json',
        cfg['header']: cfg['prefix'] + cfg['key'],
    }, timeout=90)

    try:
        obj = json.loads(txt)
    except Exception:
        return {'ok': False, 'error': '返回不是 JSON（HTTP %s）：%s' % (st, txt[:200])}

    tid = obj.get('id')
    status = obj.get('status')
    error = obj.get('error')

    # 额度不足这类错误要翻译成人话
    if error and 'insufficient' in str(error).lower():
        error = ('额度不足：Grsai 账户余额不够这次生成。'
                 '去 https://grsai.ai/zh/dashboard 充值')

    if not tid:
        return {'ok': False, 'error': error or ('提交失败 HTTP %s' % st), 'raw': obj}

    return {'ok': True, 'id': str(tid), 'status': status, 'error': error}


# ---------------------------------------------------------------------------
# 查询
# ---------------------------------------------------------------------------

def result(cfg, task_id):
    if not task_id:
        return {'ok': False, 'error': '缺少 id'}
    url = cfg['base'] + '/v1/api/result?id=' + urllib.parse.quote(str(task_id))
    st, txt = _request(url, None, {
        cfg['header']: cfg['prefix'] + cfg['key'],
    }, timeout=60)

    try:
        obj = json.loads(txt)
    except Exception:
        return {'ok': False, 'error': '返回不是 JSON（HTTP %s）' % st,
                'status': 'failed'}

    status = str(obj.get('status') or 'running')
    url_out = None
    res = obj.get('results')
    if isinstance(res, list) and res:
        first = res[0]
        if isinstance(first, dict):
            url_out = first.get('url')
        elif isinstance(first, str):
            url_out = first

    error = obj.get('error')
    if error and 'insufficient' in str(error).lower():
        error = '额度不足：账户余额不够这次生成'

    return {
        'ok': True,
        'status': status,
        'progress': obj.get('progress'),
        'url': url_out,
        'error': error,
    }