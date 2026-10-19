# ============================================================================
# config.oss.example.py — 阿里云 OSS 配置模板
# ----------------------------------------------------------------------------
# 用法：复制这个文件成 config.oss.local.py，然后填上你自己的值。
#
#   config.oss.example.py  →  config.oss.local.py
#
# config.oss.local.py 已经在 .gitignore 里，不会被提交。
#
# 这些值去哪拿：
#   1. AccessKey：阿里云控制台右上角头像 → AccessKey 管理
#      强烈建议用 RAM 子账号的 AccessKey，不要用主账号的！
#      子账号只授权 OSS 权限即可。主账号 AK 泄露 = 整个账号沦陷。
#   2. Endpoint / Bucket：OSS 控制台 → Bucket 列表 → 点进你的 bucket 就能看到
# ============================================================================

# 你的 AccessKey ID，形如 LTAI5tXXXXXXXXXXXXXX
OSS_ACCESS_KEY_ID = ''

# 你的 AccessKey Secret
OSS_ACCESS_KEY_SECRET = ''

# Bucket 所在地域节点，形如 oss-cn-hangzhou（杭州）
# 常见：oss-cn-hangzhou 杭州 / oss-cn-beijing 北京 / oss-cn-shanghai 上海
#      oss-cn-shenzhen 深圳 / oss-cn-chengdu 成都
OSS_ENDPOINT = 'oss-cn-hangzhou.aliyuncs.com'

# Bucket 名称（只能小写字母、数字、短横线）
OSS_BUCKET = ''

# 上传后在 bucket 里放的目录前缀
OSS_PREFIX = 'ai-canvas/'

# ----------------------------------------------------------------------------
# 下面是可选项，一般不用改
# ----------------------------------------------------------------------------

# 后端监听端口（前端要调它，默认 8778）
PORT = 8778

# 单张图最大多少字节（默认 20MB）
MAX_UPLOAD_BYTES = 100 * 1024 * 1024

# URL 用不用 HTTPS（一般不用改）
USE_HTTPS = True

# 自定义域名（如果你给 bucket 绑了 CDN / 自定义域名，填这里）
# 例如 'https://img.your-domain.com'
# 留空则用阿里云默认域名
CUSTOM_DOMAIN = ''