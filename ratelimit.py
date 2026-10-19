# -*- coding: utf-8 -*-
"""
ratelimit.py — 简单的防滥用限流

为什么需要
----------
站点公开之后，任何人点一下「生成」都在花站长的钱：

    生图   ¥0.03/次
    视频   ¥0.15 ~ ¥1.5/次

链接可能被发到群里、被爬虫扫到。有人狂点几分钟就能烧掉几十块。
所以在后端做一层限流 —— 前端可以被绕过，后端不能。

策略（都在 config.limits.local.py 里可调）
------------------------------------------
1. 每 IP 每分钟 / 每小时 / 每天 的请求次数上限
2. 全局每天总次数上限（兜底，防止被分布式刷）
3. 视频比生图贵，单独一个更严的上限

实现说明
--------
内存里存滑动窗口，进程重启就清零 —— 单进程部署够用。

⚠️ 已知限制：多实例部署时限额会被放大
    函数计算（FC）之类会自动扩缩容。同时有 3 个实例时，每个实例各算各的，
    实际放行量最多是限额的 3 倍。

    演示站可以先这样（限额本身留了余量，而且成本还有账户余额兜底）。
    生产环境应该换成 Redis —— 只要保持 check() 的签名不变，
    调用方（upload_server.route）一行都不用改。
"""

import threading
import time

_lock = threading.Lock()
# { key: [时间戳, ...] }
_hits = {}

# 默认策略
DEFAULT_LIMITS = {
    'per_ip_minute': 6,        # 每 IP 每分钟
    'per_ip_hour': 30,         # 每 IP 每小时
    'per_ip_day': 60,          # 每 IP 每天
    'global_day': 400,         # 全站每天总次数（兜底）
    'video_per_ip_day': 8,     # 每 IP 每天的视频次数（视频贵，单独限）
}

_limits = dict(DEFAULT_LIMITS)
_global = []      # 全站请求时间戳


def configure(cfg):
    """从配置里覆盖默认值"""
    if not isinstance(cfg, dict):
        return
    for k in DEFAULT_LIMITS:
        v = cfg.get(k)
        if isinstance(v, int) and v >= 0:
            _limits[k] = v


def _prune(now, window):
    return [t for t in _global if t > now - window]


def check(ip, is_video=False):
    """
    检查是否允许这次请求。
    @returns (allowed: bool, reason: str, retry_after: int)
    """
    now = time.time()
    ip = str(ip or 'unknown')

    with _lock:
        # 全站每天总量
        day = [t for t in _global if t > now - 86400]
        _global[:] = day
        if _limits['global_day'] and len(day) >= _limits['global_day']:
            return False, '今天全站的使用额度已用完，请明天再来', 3600

        arr = _hits.get(ip, [])
        # 只留最近 24 小时
        arr = [t for t in arr if t > now - 86400]

        # 各窗口计数
        checks = [
            (60, _limits['per_ip_minute'], '一分钟内请求太频繁'),
            (3600, _limits['per_ip_hour'], '一小时内请求太多了'),
            (86400, _limits['per_ip_day'], '今天的使用次数已用完'),
        ]
        for win, cap, msg in checks:
            if not cap:
                continue
            n = len([t for t in arr if t > now - win])
            if n >= cap:
                return False, '%s（上限 %d 次）' % (msg, cap), win

        # 视频单独限
        if is_video and _limits['video_per_ip_day']:
            # 视频次数另外记，用负时间戳区分不方便，这里单独存一份
            vkey = ip + '|video'
            varr = [t for t in _hits.get(vkey, []) if t > now - 86400]
            if len(varr) >= _limits['video_per_ip_day']:
                return False, ('今天的视频生成次数已用完（上限 %d 次，视频较贵所以单独限制）'
                               % _limits['video_per_ip_day']), 86400
            varr.append(now)
            _hits[vkey] = varr

        arr.append(now)
        _hits[ip] = arr
        _global.append(now)

    return True, '', 0


def snapshot():
    """当前用量，给 /api/health 看"""
    now = time.time()
    with _lock:
        day = [t for t in _global if t > now - 86400]
        return {
            'limits': dict(_limits),
            'global_used_today': len(day),
            'ips_seen_today': len([k for k in _hits if '|' not in k and
                                   any(t > now - 86400 for t in _hits[k])]),
        }


def reset():
    """测试用：清空计数"""
    with _lock:
        _hits.clear()
        _global[:] = []