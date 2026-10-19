# -*- coding: utf-8 -*-
"""
wan3.py — 速创 Wan3.0 视频接口的后端转发

为什么要在后端转发，而不是前端直连
----------------------------------
密钥是能花钱的东西。前端直连就意味着密钥写在 JS 里，任何人 F12 就能拿走。
放后端，密钥只在本机 / 你的服务器上，浏览器永远看不到。

它和 Grsai 的差别（接的时候必须注意）
------------------------------------
1. 没有 model 参数 —— 模型由 URL 路径决定（video_wan_3.0）
2. 任务 id 在 data.id，不在顶层（Grsai 在顶层）
3. duration / generate_audio 要传【字符串】，传数字会被拒：
     {"duration": 5}          -> 400 json: cannot unmarshal number ...
     {"duration": "5"}        -> ok
4. images 只收公网 URL，不收 base64
5. images 与 first_frame/last_frame 互斥（「与首尾帧选其一」）

结果查询的返回格式：官方文档没写
--------------------------------
doc/77 只写了提交的返回，查询那页抓不到。已知的错误响应是：
    {"code":400,"msg":"错误的ID","data":[]}      <- 注意 data 是【数组】
所以这里用一个「韧性解析器」：不猜死结构，递归找状态和媒体地址，
兼容数组 / 对象 / 各种字段名。等你充值跑一次真实任务，就能看到确切
结构、再把解析收紧（parse_detail 里会打印原始响应方便核对）。
"""

import json
import re
import urllib.error
import urllib.parse
import urllib.request

# ---------------------------------------------------------------------------
# 韧性解析
# ---------------------------------------------------------------------------

MEDIA_EXT = re.compile(r'\.(mp4|mov|webm|m4v|avi|mkv)(\?|#|$)', re.I)
URL_RE = re.compile(r'^https?://', re.I)

RUNNING_WORDS = ('处理中', '生成中', '排队', '等待', '进行中', '任务中',
                 'running', 'pending', 'processing', 'queue', 'waiting', 'in_progress')
FAILED_WORDS = ('失败', '错误', '违规', '拒绝', '异常',
                'fail', 'error', 'violation', 'reject', 'invalid', 'denied')


def _find_media_url(obj, depth=0):
    """递归找第一个像视频地址的字符串"""
    if depth > 8:
        return None
    if isinstance(obj, str):
        s = obj.strip()
        if URL_RE.match(s) and MEDIA_EXT.search(s):
            return s
        return None
    if isinstance(obj, dict):
        # 先看名字最像的字段，命中率更高
        for k in ('video_url', 'videoUrl', 'video', 'url', 'output',
                  'result', 'results', 'data', 'file', 'files', 'content'):
            if k in obj:
                r = _find_media_url(obj[k], depth + 1)
                if r:
                    return r
        for v in obj.values():
            r = _find_media_url(v, depth + 1)
            if r:
                return r
        return None
    if isinstance(obj, (list, tuple)):
        for v in obj:
            r = _find_media_url(v, depth + 1)
            if r:
                return r
    return None


def _collect_strings(obj, out=None, depth=0):
    """把这个 JSON 里所有短字符串收集起来，用来判断状态词"""
    if out is None:
        out = []
    if depth > 8:
        return out
    if isinstance(obj, str):
        if len(obj) <= 60:
            out.append(obj)
    elif isinstance(obj, dict):
        for v in obj.values():
            _collect_strings(v, out, depth + 1)
    elif isinstance(obj, (list, tuple)):
        for v in obj:
            _collect_strings(v, out, depth + 1)
    return out


def _is_empty_data(data):
    if data is None:
        return True
    if isinstance(data, (list, tuple, dict, str)) and len(data) == 0:
        return True
    return False


def parse_detail(raw_text):
    """
    把速创的查询响应解析成统一格式：
        {'status': 'running'|'succeeded'|'failed', 'url': str|None,
         'error': str|None, 'raw': dict}

    不确定结构，所以按可能性从高到低依次判断。
    """
    try:
        obj = json.loads(raw_text)
    except Exception:
        return {'status': 'failed', 'url': None,
                'error': '返回不是 JSON：%s' % raw_text[:200], 'raw': raw_text}

    out = {'status': 'running', 'url': None, 'error': None, 'raw': obj}

    # --- 1) 先看 code ---
    code = obj.get('code')
    msg = str(obj.get('msg') or '')

    if code is not None and code != 200:
        low = msg.lower()
        if any(w in msg for w in FAILED_WORDS) or any(w in low for w in FAILED_WORDS):
            out['status'] = 'failed'
            out['error'] = msg or ('code=%s' % code)
        elif any(w in msg for w in RUNNING_WORDS) or any(w in low for w in RUNNING_WORDS):
            out['status'] = 'running'
        elif '错误的ID' in msg or 'not found' in low or '不存在' in msg:
            out['status'] = 'failed'
            out['error'] = msg
        else:
            # code 非 200 但看不出是"还在跑" —— 当成失败，别让前端无限等
            out['status'] = 'failed'
            out['error'] = msg or ('code=%s' % code)
        return out

    data = obj.get('data')

    # --- 2) 找视频地址（找到就算成功）---
    url = _find_media_url(data)
    if url:
        out['status'] = 'succeeded'
        out['url'] = url
        return out

    # 有时候顶层就带 url
    url = _find_media_url(obj)
    if url:
        out['status'] = 'succeeded'
        out['url'] = url
        return out

    # --- 3) 没地址，用状态词判断 ---
    words = _collect_strings(data) + [msg]
    joined = ' '.join(words)
    low = joined.lower()

    if any(w in joined for w in FAILED_WORDS) or any(w in low for w in FAILED_WORDS):
        out['status'] = 'failed'
        out['error'] = joined[:200] or '任务失败'
        return out

    # 明确表示还在跑
    if any(w in joined for w in RUNNING_WORDS) or any(w in low for w in RUNNING_WORDS):
        out['status'] = 'running'
        return out

    # --- 4) data 有内容但没地址、也没状态词 ---
    #      可能是进度数字之类，当作还在跑
    if _is_empty_data(data):
        out['status'] = 'running'
        return out

    # 有内容但认不出 —— 保守当还在跑，让前端继续轮询；
    # 真正的失败会被上面的 code / 状态词抓住。
    out['status'] = 'running'
    return out


# ---------------------------------------------------------------------------
# 请求
# ---------------------------------------------------------------------------

def _load_cfg(base_dir):
    """读 config.wuyinkeji.local.py"""
    import io
    import os
    path = os.path.join(base_dir, 'config.wuyinkeji.local.py')
    if not os.path.isfile(path):
        return {}
    ns = {}
    try:
        with io.open(path, encoding='utf-8') as f:
            exec(compile(f.read(), path, 'exec'), ns)
    except Exception as e:
        return {'_error': '读 config.wuyinkeji.local.py 失败: %s' % e}
    return ns


def get_config(base_dir):
    """
    取速创配置，优先级：
        1. 环境变量（部署时用）
           WUYINKEJI_KEY / WUYINKEJI_SUBMIT_URL / WUYINKEJI_DETAIL_URL
        2. config.wuyinkeji.local.py（本地开发方便，在 .gitignore 里）
    """
    import os
    env_key = (os.environ.get('WUYINKEJI_KEY') or '').strip()
    if env_key:
        return {
            'key': env_key,
            'submit': (os.environ.get('WUYINKEJI_SUBMIT_URL')
                       or 'https://api.wuyinkeji.com/api/async/video_wan_3.0'),
            'detail': (os.environ.get('WUYINKEJI_DETAIL_URL')
                       or 'https://api.wuyinkeji.com/api/async/detail'),
            'duration': os.environ.get('DEFAULT_DURATION', 5),
            'ratio': os.environ.get('DEFAULT_RATIO', '16:9'),
            'audio': os.environ.get('DEFAULT_GENERATE_AUDIO', 'true').lower() == 'true',
            'source': 'env',
        }, None

    ns = _load_cfg(base_dir)
    if ns.get('_error'):
        return None, ns['_error']
    key = ns.get('WUYINKEJI_KEY') or ''
    if not key or '在这里' in key or '你的' in key:
        return None, ('没配速创密钥。去 https://api.wuyinkeji.com/user/key 拿，'
                      '填到 config.wuyinkeji.local.py 的 WUYINKEJI_KEY，'
                      '或设环境变量 WUYINKEJI_KEY')
    return {
        'key': key,
        'submit': ns.get('WUYINKEJI_SUBMIT_URL')
                  or 'https://api.wuyinkeji.com/api/async/video_wan_3.0',
        'detail': ns.get('WUYINKEJI_DETAIL_URL')
                  or 'https://api.wuyinkeji.com/api/async/detail',
        'duration': ns.get('DEFAULT_DURATION', 5),
        'ratio': ns.get('DEFAULT_RATIO', '16:9'),
        'audio': ns.get('DEFAULT_GENERATE_AUDIO', True),
        'source': 'file',
    }, None


def _request(url, data=None, headers=None, timeout=120):
    req = urllib.request.Request(url, data=data, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read().decode('utf-8', 'replace')
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode('utf-8', 'replace')


def submit(cfg, body):
    """
    body: {prompt, images(列表或逗号串), ratio, duration, generate_audio}
    返回 {'ok':bool, 'id':str, 'raw':..., 'error':...}
    """
    prompt = (body.get('prompt') or '').strip()
    if not prompt:
        return {'ok': False, 'error': '提示词不能为空'}

    images = body.get('images')
    if isinstance(images, (list, tuple)):
        images = ','.join([str(x) for x in images if x])
    images = (images or '').strip()

    # 关键：duration / generate_audio 必须是字符串
    duration = body.get('duration', cfg['duration'])
    duration = str(int(duration)) if str(duration).isdigit() else str(cfg['duration'])

    ratio = str(body.get('ratio') or cfg['ratio'])
    if ratio not in ('16:9', '9:16'):
        ratio = '16:9'      # 它只认这两个

    ga = body.get('generate_audio', cfg['audio'])
    ga = 'true' if (ga is True or str(ga).lower() in ('true', '1', 'yes')) else 'false'

    payload = {
        'prompt': prompt,
        'ratio': ratio,
        'duration': duration,          # 字符串！
        'generate_audio': ga,          # 字符串！
    }
    if images:
        payload['images'] = images      # 逗号分隔的 URL 串

    data = json.dumps(payload, ensure_ascii=False).encode('utf-8')
    st, txt = _request(cfg['submit'], data, {
        'Content-Type': 'application/json',
        'Authorization': cfg['key'],
    }, timeout=90)

    try:
        obj = json.loads(txt)
    except Exception:
        return {'ok': False, 'error': '返回不是 JSON（HTTP %s）：%s' % (st, txt[:200]),
                'raw': txt}

    code = obj.get('code')
    msg = str(obj.get('msg') or '')
    tid = None
    d = obj.get('data')
    if isinstance(d, dict):
        tid = d.get('id')

    if code != 200 or not tid:
        err = msg or ('提交失败 code=%s' % code)
        if '余额' in msg or '不足' in msg or '权限' in msg:
            err = '速创账户余额不足或没有权限 —— 去 https://api.wuyinkeji.com 充值'
        return {'ok': False, 'error': err, 'raw': obj}

    return {'ok': True, 'id': str(tid), 'raw': obj}


def detail(cfg, task_id):
    if not task_id:
        return {'ok': False, 'error': '缺少 id'}
    url = cfg['detail'] + '?id=' + urllib.parse.quote(str(task_id))
    st, txt = _request(url, None, {'Authorization': cfg['key']}, timeout=60)

    parsed = parse_detail(txt)
    parsed['ok'] = True
    parsed['http'] = st
    return parsed