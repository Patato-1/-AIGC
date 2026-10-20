# -*- coding: utf-8 -*-
"""
oss_client.py — 极简阿里云 OSS 客户端（纯标准库，零依赖）

为什么自己写而不用官方的 oss2
-----------------------------
oss2 的依赖链里有 C 扩展（crcmod、pycryptodome）。这带来两个问题：

1. **部署麻烦**：函数计算是 Linux 环境，在 Windows 上打不出能用的包；
   配「层」又需要另做一套构建流程。
2. **本地和线上不一致**：本地能跑不代表传上去能跑 —— 这正是最该避免的。

而我们只用到 OSS 的两个操作（上传对象、查 Bucket 信息）。签名算法本身
不复杂：HMAC-SHA1 + Base64，标准库全都有。所以直接实现，把唯一的第三方
依赖去掉 —— 整个后端变成「纯标准库」，zip 传到哪都能跑。

安全性说明
----------
签名只在本机/服务端计算，AccessKeySecret 不出现在任何请求里（OSS 的
签名机制就是这样设计的），所以这段代码放到前端也不泄密 —— 当然它本来
就只在后端跑。
"""

import base64
import hashlib
import hmac
import mimetypes
import time
import urllib.error
import urllib.parse
import urllib.request
from email.utils import formatdate

__all__ = ['OSSClient', 'OSSError']


class OSSError(Exception):
    """OSS 返回了错误（带状态码和 OSS 的原始错误信息，方便排查）"""

    def __init__(self, status, code, message, request_id=None):
        self.status = status
        self.code = code
        self.message = message
        self.request_id = request_id
        super(OSSError, self).__init__(
            'HTTP %s %s: %s%s' % (status, code, message,
                                  (' (RequestId: %s)' % request_id) if request_id else ''))


def _url_quote(s, safe=''):
    """OSS 用的 URL 编码：空格编码成 %20 而不是 +"""
    return urllib.parse.quote(s, safe=safe)


def _quote_key(key):
    """
    编码对象键，但【保留斜杠】。

    对象键是路径结构（ai-canvas/20260101_x.png），斜杠是目录分隔符。
    如果整串丢给 quote()，斜杠会变成 %2F —— OSS 虽然也能解析，
    但生成的公开地址跟已有对象不一致，排查问题时容易看懵。
    所以按段编码，再把斜杠拼回去。
    """
    return '/'.join(urllib.parse.quote(seg, safe='') for seg in str(key).split('/'))


class OSSClient(object):
    """
    只用得到这几个能力，所以只实现这几个。

        client.put_object(key, data, content_type=...)   上传
        client.bucket_info()                            查 Bucket（健康检查用）
        client.head_object(key)                         看对象在不在
        client.delete_object(key)                       删对象

    签名走 V1（HMAC-SHA1），这是 OSS 最通用、最少坑的一版。
    """

    def __init__(self, access_key_id, access_key_secret, endpoint, bucket,
                 use_https=True, timeout=60):
        if not (access_key_id and access_key_secret and endpoint and bucket):
            raise ValueError('OSS 配置不全（AccessKeyId / Secret / Endpoint / Bucket）')
        self.ak = access_key_id
        self.sk = access_key_secret
        # endpoint 可能写成 https://oss-cn-beijing.aliyuncs.com，统一成纯域名
        ep = endpoint.strip()
        if '://' in ep:
            use_https = ep.split('://', 1)[0].lower() == 'https'
            ep = ep.split('://', 1)[1]
        self.endpoint = ep.rstrip('/')
        self.bucket = bucket
        self.scheme = 'https' if use_https else 'http'
        self.timeout = timeout
        self.host = '%s.%s' % (bucket, self.endpoint)

    # ------------------------------------------------------------------
    # 签名
    # ------------------------------------------------------------------

    def _sign(self, method, key, content_type, date, headers=None,
              subresource=None):
        """
        构造 Authorization 头。OSS V1 签名的规范串是：

            VERB + "\n"
            + Content-MD5 + "\n"
            + Content-Type + "\n"
            + Date + "\n"
            + CanonicalizedOSSHeaders       (x-oss-* 头，按 key 排序)
            + CanonicalizedResource         (/bucket/key?子资源)

        注意 CanonicalizedResource 里的子资源（如 ?acl）必须按字典序、
        且要从 query 里挑出来参与签名 —— 少一个就会 SignatureDoesNotMatch。
        """
        canon_headers = ''
        if headers:
            xs = sorted((k.lower(), str(v)) for k, v in headers.items()
                        if k.lower().startswith('x-oss-'))
            if xs:
                canon_headers = ''.join('%s:%s\n' % (k, v) for k, v in xs)

        resource = '/%s/' % self.bucket
        if key:
            resource += key
        if subresource:
            resource += '?' + subresource

        string_to_sign = '\n'.join([
            method,
            '',                 # Content-MD5：我们不用
            content_type or '',
            date,
            canon_headers + resource,
        ])

        sig = hmac.new(self.sk.encode('utf-8'),
                       string_to_sign.encode('utf-8'),
                       hashlib.sha1).digest()
        return 'OSS %s:%s' % (self.ak, base64.b64encode(sig).decode('ascii'))

    # ------------------------------------------------------------------
    # 请求
    # ------------------------------------------------------------------

    def _request(self, method, key='', data=None, content_type=None,
                 extra_headers=None, subresource=None, query=None):
        date = formatdate(usegmt=True)
        headers = {'Date': date}
        if content_type:
            headers['Content-Type'] = content_type
        if extra_headers:
            headers.update(extra_headers)

        headers['Authorization'] = self._sign(
            method, key, content_type, date, headers, subresource)

        url = '%s://%s/%s' % (self.scheme, self.host, _quote_key(key))
        if query:
            url += '?' + urllib.parse.urlencode(query)

        req = urllib.request.Request(url, data=data, method=method, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as r:
                return r.status, r.read(), dict(r.headers)
        except urllib.error.HTTPError as e:
            body = e.read().decode('utf-8', 'replace')
            code, msg, rid = '', body[:200], None
            # OSS 的错误是 XML，抠出 Code / Message 比整段抛出去好读得多
            try:
                import re
                code = (re.search(r'<Code>([^<]*)</Code>', body) or [None, ''])[1]
                msg = (re.search(r'<Message>([^<]*)</Message>', body) or [None, body[:200]])[1]
                rid = (re.search(r'<RequestId>([^<]*)</RequestId>', body) or [None, None])[1]
            except Exception:
                pass
            raise OSSError(e.code, code or 'HTTPError', msg, rid)
        except urllib.error.URLError as e:
            raise OSSError(0, 'NetworkError', str(e.reason))

    # ------------------------------------------------------------------
    # 对外的几个操作
    # ------------------------------------------------------------------

    def put_object(self, key, data, content_type=None, extra_headers=None):
        """
        上传一个对象。
        @param key            对象键，如 'ai-canvas/20260101-120000_foo.png'
        @param data           bytes
        @param content_type   不传就按扩展名猜
        @param extra_headers  额外请求头（会参与签名）。例如
                              Content-Disposition: inline —— 用来对抗
                              bucket 上的「强制下载」设置
        @returns 服务端返回的响应头 dict
        """
        if not content_type:
            content_type = mimetypes.guess_type(key)[0] or 'application/octet-stream'
        if not isinstance(data, (bytes, bytearray)):
            raise TypeError('data 必须是 bytes')
        _, _, hdrs = self._request('PUT', key, bytes(data),
                                   content_type=content_type,
                                   extra_headers=extra_headers)
        return hdrs

    def head_object(self, key):
        """对象存在就返回响应头，不存在返回 None"""
        try:
            _, _, hdrs = self._request('HEAD', key)
            return hdrs
        except OSSError as e:
            if e.status == 404:
                return None
            raise

    def delete_object(self, key):
        try:
            self._request('DELETE', key)
            return True
        except OSSError as e:
            if e.status == 404:
                return False
            raise

    def bucket_info(self):
        """
        查 Bucket 信息，用作健康检查。
        GET /?bucketInfo  需要签名带上子资源 bucketInfo。
        """
        _, body, _ = self._request('GET', '',
                                   subresource='bucketInfo',
                                   query={'bucketInfo': ''})
        return body

    def object_url(self, key):
        """对象的公开访问地址（前提：Bucket 是公共读）"""
        return '%s://%s/%s' % (self.scheme, self.host, _quote_key(key))