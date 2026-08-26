#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
AgentRouter 自动签到脚本 (青龙面板 / 任意 Python3 环境)
站点: https://ps.air-outer.com

依赖:
    pip install requests
    pip install "requests[socks]"   # 仅在使用 socks 代理时需要, 等价于额外安装 PySocks

环境变量:
    AGENTROUTER_ACCOUNTS         多账号 JSON 数组, 元素形如 {"name":"x","account":"邮箱#密码"}
    AGENTROUTER_ACCOUNT          单账号, 格式 邮箱#密码
    AGENTROUTER_BASE_URL         站点地址, 默认 https://ps.air-outer.com
    AGENTROUTER_PROXY            代理地址, 支持 http:// https:// socks5:// socks5h://
                                 需认证时可直接写 socks5h://用户名:密码@主机:端口
    AGENTROUTER_PROXY_USERNAME   代理用户名, 密码含 @ : / # 等特殊字符时优先用这两个变量
    AGENTROUTER_PROXY_PASSWORD   代理密码, 脚本会自动做 URL 编码, 无需手工转义
    AGENTROUTER_SOCKS_REMOTE_DNS 是否让 socks 代理侧解析域名, 默认开启
    AGENTROUTER_FORCE_IPV4       强制 IPv4 出站
    AGENTROUTER_PROXY_SELFTEST   启动时打印代理出口 IP, 便于排查 WAF 拦截

    AGENTROUTER_SPIDERRY_URL     代理源地址, 默认 http://demo.spiderpy.cn/all/
    AGENTROUTER_PROXIFLY_URL     备用代理源地址, 默认 https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/all/data.txt

代理测速选优:
    未配置签到账号, 或设置 AGENTROUTER_SPEEDTEST_ONLY=1 时, 脚本从代理池获取
    能访问 PROXY_SPEEDTEST_URL 的最快 TopN 代理并输出。
    AGENTROUTER_SPEEDTEST_URL       探测站点, 默认 https://agentrouter.org/v1
    AGENTROUTER_PROXY_TOP_N         输出条数, 默认 10
    AGENTROUTER_PROXY_SPEED_ROUNDS  每个代理复测次数取最小耗时, 默认 2
    AGENTROUTER_SPEEDTEST_OUTPUT    结果写入文件路径(可选)
"""

import os
import sys
import json
import time
import random
import traceback
from concurrent.futures import ThreadPoolExecutor, as_completed
from urllib.parse import quote, urlsplit, urlunsplit

# Windows 控制台默认 GBK 编码, 无法输出 emoji/中文会崩溃, 强制 UTF-8 输出
if hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

try:
    import requests
except ImportError:
    print("缺少依赖 requests, 请先执行: pip install requests")
    sys.exit(1)

# ---------- 基础配置 ----------
BASE_URL = os.environ.get("AGENTROUTER_BASE_URL", "https://ps.air-outer.com").rstrip("/")
LOGIN_PATH = "/api/user/login"
SELF_LOG_PATH = "/api/log/self/"
SELF_LOG_HEADER = "New-API-User"
CHECKIN_LOG_TYPE = 4
TIMEOUT = 20

SPIDERRY_API_URL = os.environ.get("AGENTROUTER_SPIDERRY_URL", "http://demo.spiderpy.cn/all/").strip()
PROXIFLY_PROXY_LIST_URL = os.environ.get(
    "AGENTROUTER_PROXIFLY_URL",
    "https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/all/data.txt",
).strip()
# 每个候选代理的连通性测试超时(秒), 免费代理质量参差, 用较短超时快速淘汰失效节点
PROXY_PROBE_TIMEOUT = 6
PROXY_PROBE_WORKERS = max(1, int(os.environ.get("AGENTROUTER_PROXY_PROBE_WORKERS", "30") or "30"))
PROXY_PROBE_BATCH_SIZE = max(1, int(os.environ.get("AGENTROUTER_PROXY_PROBE_BATCH_SIZE", "120") or "120"))
PROXY_SUCCESS_POOL_SIZE = max(1, int(os.environ.get("AGENTROUTER_PROXY_SUCCESS_POOL_SIZE", "3") or "3"))
ACCOUNT_PROXY_RETRY_LIMIT = max(1, int(os.environ.get("AGENTROUTER_ACCOUNT_PROXY_RETRY_LIMIT", "3") or "3"))

# ---------- 代理测速选优(获取 TopN 最快能访问目标站点的代理) ----------
# 目标站点探测地址, 默认探测 agentrouter 的 OpenAI 兼容网关
PROXY_SPEEDTEST_URL = os.environ.get("AGENTROUTER_SPEEDTEST_URL", "https://agentrouter.org/v1").strip()
# 需要输出的最快代理数量
PROXY_TOP_N = max(1, int(os.environ.get("AGENTROUTER_PROXY_TOP_N", "10") or "10"))
# 每个候选代理复测次数, 取最小耗时作为稳定速度分, 让 TopN 更可靠
PROXY_SPEEDTEST_ROUNDS = max(1, int(os.environ.get("AGENTROUTER_PROXY_SPEED_ROUNDS", "2") or "2"))
# 设置后会把 TopN 代理结果写入该文件(每行: 代理URL  耗时秒)
PROXY_SPEEDTEST_OUTPUT = os.environ.get("AGENTROUTER_SPEEDTEST_OUTPUT", "").strip()

USER_AGENT = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36")

SOCKS_SCHEMES = ("socks5://", "socks5h://", "socks4://", "socks4a://")
TRUTHY_VALUES = ("1", "true", "yes", "on")

STATUS_TAGS = {"success": "✅ 成功", "already": "🟡 已签到", "fail": "❌ 失败"}
STATUS_ICONS = {"success": "✅", "already": "🟡", "fail": "❌"}

# 通知: 青龙自带 notify 模块
send = None
try:
    from notify import send
except Exception:
    send = None


def log(message):
    timestamp = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime())
    print(f"[{timestamp}] {message}")


def read_bool_env(name, default=False):
    raw_value = os.environ.get(name, "").strip().lower()
    if not raw_value:
        return default
    return raw_value in TRUTHY_VALUES


def is_socks_proxy(proxy_url):
    return proxy_url.lower().startswith(SOCKS_SCHEMES)


def upgrade_socks_scheme_for_remote_dns(proxy_url):
    """socks5:// 由本机解析域名, socks5h:// 交给代理解析。

    青龙容器内的 DNS 往往被污染或无法解析被墙域名, 因此默认升级为 socks5h,
    这样 TCP 连接和域名解析都走代理出口, 避免连到错误 IP 后被 WAF 返回 405。
    """
    if proxy_url.lower().startswith("socks5://") and read_bool_env("AGENTROUTER_SOCKS_REMOTE_DNS", True):
        return "socks5h://" + proxy_url[len("socks5://"):]
    return proxy_url


def inject_proxy_credentials(proxy_url):
    """把 AGENTROUTER_PROXY_USERNAME/PASSWORD 注入代理 URL 的 userinfo 段。

    SOCKS5 握手时, PySocks 只有在拿到用户名密码后才会声明支持 0x02 认证方式;
    否则仅声明 0x00(无认证), 遇到强制认证的代理就会收到
    "All offered SOCKS5 authentication methods were rejected"。

    密码里的 @ : / # 等字符若直接写进 URL 会破坏解析, 因此统一做百分号编码。
    URL 中已自带凭据时以 URL 为准, 不覆盖。
    """
    username = os.environ.get("AGENTROUTER_PROXY_USERNAME", "").strip()
    password = os.environ.get("AGENTROUTER_PROXY_PASSWORD", "")
    if not username:
        return proxy_url

    split_result = urlsplit(proxy_url)
    if split_result.username:
        log("[DEBUG] 代理 URL 已内联凭据, 忽略 AGENTROUTER_PROXY_USERNAME/PASSWORD")
        return proxy_url

    host_and_port = split_result.netloc.rsplit("@", 1)[-1]
    encoded_userinfo = quote(username, safe="")
    if password:
        encoded_userinfo += ":" + quote(password, safe="")

    return urlunsplit((
        split_result.scheme,
        f"{encoded_userinfo}@{host_and_port}",
        split_result.path,
        split_result.query,
        split_result.fragment,
    ))


def mask_proxy_credentials(proxy_url):
    """日志中隐去代理密码, 避免凭据出现在青龙面板日志里。"""
    if not proxy_url:
        return "未配置"
    split_result = urlsplit(proxy_url)
    if not split_result.username:
        return proxy_url
    host_and_port = split_result.netloc.rsplit("@", 1)[-1]
    masked_netloc = f"{split_result.username}:****@{host_and_port}"
    return urlunsplit((split_result.scheme, masked_netloc, split_result.path,
                       split_result.query, split_result.fragment))


def resolve_proxy_url(probe_account=None, excluded_proxy_urls=None):
    raw_proxy = os.environ.get("AGENTROUTER_PROXY", "").strip()
    if not raw_proxy:
        fetched_proxy = pick_usable_proxy(probe_account or get_proxy_probe_account(), excluded_proxy_urls=excluded_proxy_urls)
        if not fetched_proxy:
            return ""
        raw_proxy = fetched_proxy

    resolved_url = upgrade_socks_scheme_for_remote_dns(raw_proxy)
    if resolved_url != raw_proxy:
        log(f"[DEBUG] 代理协议已升级为远端 DNS 解析: {mask_proxy_credentials(resolved_url)}")

    resolved_url = inject_proxy_credentials(resolved_url)
    return resolved_url


def ensure_socks_dependency():
    """PySocks 安装后暴露的模块名是 socks, 不是 pysocks。"""
    try:
        import socks  # noqa: F401
        return True, ""
    except ImportError as import_error:
        return False, str(import_error)


# ---------- 强制 IPv4(可选) ----------
if read_bool_env("AGENTROUTER_FORCE_IPV4"):
    import socket as _socket

    _original_getaddrinfo = _socket.getaddrinfo

    def _getaddrinfo_ipv4_only(host, port, family=0, type=0, proto=0, flags=0):
        return _original_getaddrinfo(host, port, _socket.AF_INET, type, proto, flags)

    _socket.getaddrinfo = _getaddrinfo_ipv4_only


def build_session():
    """构建带通用请求头与代理的 Session。

    requests 只要安装了 PySocks, 就能直接识别 proxies 字典里的 socks 协议,
    内部会自动使用 SOCKSProxyManager, 无需手工 mount 适配器。
    """
    session = requests.Session()
    session.headers.update({
        "User-Agent": USER_AGENT,
        "Content-Type": "application/json",
        "Accept": "application/json, text/plain, */*",
        "Referer": f"{BASE_URL}/login",
        "Origin": BASE_URL,
    })

    if not PROXY_URL:
        return session

    if is_socks_proxy(PROXY_URL):
        dependency_ready, dependency_error = ensure_socks_dependency()
        if not dependency_ready:
            log(f"[ERROR] SOCKS 代理依赖缺失: {dependency_error}")
            log("[ERROR] 请执行: pip install \"requests[socks]\"  (或 pip install PySocks)")
            log("[WARN] 本次将直连出站, 可能被站点 WAF 拦截")
            return session

    session.proxies = {"http": PROXY_URL, "https": PROXY_URL}
    log(f"[DEBUG] 已启用代理: {PROXY_URL_FOR_LOG}")
    return session


def describe_request_error(request_error):
    """把底层网络异常翻译成可操作的排查提示。"""
    error_text = str(request_error)
    if "authentication methods were rejected" in error_text:
        return ("SOCKS5 认证被拒: 该代理要求用户名密码, 但当前未提供(或凭据错误)。"
                "请设置 AGENTROUTER_PROXY_USERNAME / AGENTROUTER_PROXY_PASSWORD, "
                "或把代理写成 socks5h://用户名:密码@主机:端口")
    if "Connection refused" in error_text or "timed out" in error_text:
        return f"代理不可达(端口未开放/已失效): {error_text}"
    return f"登录请求异常: {error_text}"


def should_retry_account_result(result):
    return bool(result and result.get("status") == "fail" and result.get("retryable"))


def report_proxy_exit_ip():
    """打印代理出口 IP, 用于确认代理是否真的生效。"""
    probe_session = build_session()
    try:
        response = probe_session.get("https://api.ipify.org?format=json", timeout=TIMEOUT)
        log(f"[DEBUG] 代理出口 IP: {response.text.strip()[:120]}")
    except Exception as probe_error:
        log(f"[DEBUG] 代理出口 IP 探测失败: {probe_error}")


def safe_notify(title, content):
    if send:
        try:
            send(title, content)
        except Exception as notify_error:
            log(f"通知发送失败(不影响签到): {notify_error}")
    else:
        log(f"[通知] {title}\n{content}")


def parse_account(raw_account):
    raw_account = (raw_account or "").strip()
    if "#" in raw_account:
        email, password = raw_account.split("#", 1)
        return email.strip(), password.strip()
    return raw_account.strip(), ""


def get_proxy_probe_account():
    """为代理预检提供一个账号。优先使用多账号列表中的第一个有效账号, 否则回退到单账号。"""
    multi_account_raw = os.environ.get("AGENTROUTER_ACCOUNTS", "").strip()
    if multi_account_raw:
        try:
            account_entries = json.loads(multi_account_raw)
            if isinstance(account_entries, list):
                for entry in account_entries:
                    if not isinstance(entry, dict):
                        continue
                    email, password = parse_account(entry.get("account") or "")
                    if (not email or not password) and entry.get("email") and entry.get("password"):
                        email, password = entry["email"], entry["password"]
                    if email and password:
                        return {
                            "name": entry.get("name", "代理预检账号"),
                            "email": email,
                            "password": password,
                        }
        except Exception:
            pass

    single_account_raw = os.environ.get("AGENTROUTER_ACCOUNT", "").strip()
    if single_account_raw:
        email, password = parse_account(single_account_raw)
        if email and password:
            return {"name": "代理预检账号", "email": email, "password": password}
    return None


def extract_quota(payload):
    if isinstance(payload, dict):
        for quota_key in ("quota", "remainder_quota", "balance"):
            if quota_key in payload:
                return payload[quota_key]
    return None


def normalize_proxy_url(proxy_value):
    """把代理地址规范成 requests 可直接使用的 URL。

    支持以下格式:
    - socks5://ip:port
    - socks4://ip:port
    - http://ip:port
    - https://ip:port
    - ip:port   -> 默认补 http://, 兼容 spiderpy 的裸地址格式
    """
    candidate_proxy = str(proxy_value or "").strip()
    if not candidate_proxy:
        return ""

    lower_candidate_proxy = candidate_proxy.lower()
    if lower_candidate_proxy.startswith(("http://", "https://")) or lower_candidate_proxy.startswith(SOCKS_SCHEMES):
        return candidate_proxy
    return f"http://{candidate_proxy}"


def fetch_spiderpy_proxies():
    """从 demo.spiderpy.cn/all/ 拉取全部代理地址。该源通常返回裸 ip:port。"""
    if not SPIDERRY_API_URL:
        log("[DEBUG] 未配置 AGENTROUTER_SPIDERRY_URL, 跳过代理自动获取")
        return ""

    session = requests.Session()
    session.trust_env = False
    try:
        response = session.get(SPIDERRY_API_URL, timeout=TIMEOUT)
    except Exception as request_error:
        log(f"[WARN] demo.spiderpy.cn 代理列表获取失败: {request_error}")
        return ""

    if response.status_code != 200:
        log(f"[WARN] demo.spiderpy.cn 返回异常状态码 {response.status_code}")
        return ""

    try:
        proxy_items = response.json()
    except Exception:
        log("[WARN] demo.spiderpy.cn 返回内容不是 JSON, 无法解析代理")
        return ""
    if not isinstance(proxy_items, list):
        log("[WARN] demo.spiderpy.cn 返回内容不是 JSON 数组")
        return ""

    proxy_addresses = [
        str(item.get("proxy") or "").strip()
        for item in proxy_items
        if isinstance(item, dict)
        and str(item.get("proxy") or "").strip()
    ]
    if not proxy_addresses:
        log("[WARN] demo.spiderpy.cn 中没有可用的代理")
        return ""
    log(f"[DEBUG] demo.spiderpy.cn 共 {len(proxy_items)} 条, 可用代理 {len(proxy_addresses)} 条")
    return proxy_addresses


def fetch_proxifly_proxies():
    """从 proxifly 拉取代理列表。该源通常返回带协议头的一行一个代理。"""
    if not PROXIFLY_PROXY_LIST_URL:
        log("[DEBUG] 未配置 AGENTROUTER_PROXIFLY_URL, 跳过 proxifly 代理获取")
        return ""

    session = requests.Session()
    session.trust_env = False
    try:
        response = session.get(PROXIFLY_PROXY_LIST_URL, timeout=TIMEOUT)
    except Exception as request_error:
        log(f"[WARN] proxifly 代理列表获取失败: {request_error}")
        return ""

    if response.status_code != 200:
        log(f"[WARN] proxifly 返回异常状态码 {response.status_code}")
        return ""

    proxy_addresses = [line.strip() for line in response.text.splitlines() if line.strip()]
    if not proxy_addresses:
        log("[WARN] proxifly 代理列表为空")
        return ""

    log(f"[DEBUG] proxifly 共 {len(proxy_addresses)} 条代理")
    return proxy_addresses


def is_waf_blocked(response):
    """判断响应是否为阿里云 WAF 拦截页(指纹验证/滑块), 而非正常页面。"""
    content_type = response.headers.get("Content-Type", "")
    if "text/html" not in content_type:
        return False
    body_lower = response.text[:4000].lower()
    return ("aliyun_waf" in body_lower
            or "aliyuncaptcha" in body_lower
            or "aliyun-captcha" in body_lower)


def is_login_probe_successful(response):
    """判断登录接口预检是否成功: 必须不是 WAF HTML, 且能返回 success=true 的 JSON。"""
    if is_waf_blocked(response):
        return False

    content_type = response.headers.get("Content-Type", "")
    if "text/html" in content_type:
        return False

    try:
        login_payload = response.json()
    except Exception:
        return False
    return bool(login_payload.get("success"))


def proxy_url_is_excluded(proxy_url, excluded_proxy_urls):
    """判断代理是否已在当前账号的失败代理排除列表中。"""
    if not excluded_proxy_urls:
        return False

    normalized_proxy_url = normalize_proxy_url(proxy_url)
    upgraded_proxy_url = upgrade_socks_scheme_for_remote_dns(normalized_proxy_url)
    return normalized_proxy_url in excluded_proxy_urls or upgraded_proxy_url in excluded_proxy_urls


def probe_proxy_candidate(source_name, proxy_address, probe_account, excluded_proxy_urls=None):
    """测试单个代理是否可真正打通登录接口。成功时返回规范化后的代理 URL。"""
    candidate_url = normalize_proxy_url(proxy_address)
    if not candidate_url:
        return ""
    if proxy_url_is_excluded(candidate_url, excluded_proxy_urls):
        return ""

    probe_session = requests.Session()
    probe_session.trust_env = False
    probe_session.headers.update({
        "User-Agent": USER_AGENT,
        "Content-Type": "application/json",
        "Accept": "application/json, text/plain, */*",
        "Referer": f"{BASE_URL}/login",
        "Origin": BASE_URL,
    })
    probe_session.proxies = {"http": candidate_url, "https": candidate_url}
    try:
        if probe_account:
            probe_response = probe_session.post(
                f"{BASE_URL}{LOGIN_PATH}",
                json={"username": probe_account["email"], "password": probe_account["password"]},
                timeout=PROXY_PROBE_TIMEOUT,
            )
            if not is_login_probe_successful(probe_response):
                log(f"[DEBUG] {source_name} 代理未通过登录预检, 跳过: {candidate_url} (HTTP {probe_response.status_code})")
                return ""
        else:
            probe_response = probe_session.get(BASE_URL, timeout=PROXY_PROBE_TIMEOUT)
            if is_waf_blocked(probe_response):
                log(f"[DEBUG] {source_name} 代理被 WAF 拦截, 跳过: {candidate_url} (HTTP {probe_response.status_code})")
                return ""

        if is_waf_blocked(probe_response):
            return ""
        log(f"[DEBUG] {source_name} 代理可用: {candidate_url} (HTTP {probe_response.status_code})")
        return candidate_url
    except Exception:
        return ""


def collect_usable_proxies(source_name, proxy_addresses, probe_account, excluded_proxy_urls=None):
    """按批次并发测试代理, 收集少量可用代理供后续随机挑选。"""
    shuffled_proxy_addresses = list(proxy_addresses)
    random.shuffle(shuffled_proxy_addresses)

    usable_list = []
    for batch_start_index in range(0, len(shuffled_proxy_addresses), PROXY_PROBE_BATCH_SIZE):
        batch_proxy_addresses = shuffled_proxy_addresses[batch_start_index: batch_start_index + PROXY_PROBE_BATCH_SIZE]
        if not batch_proxy_addresses:
            continue

        with ThreadPoolExecutor(max_workers=min(PROXY_PROBE_WORKERS, len(batch_proxy_addresses))) as executor:
            future_to_proxy = {
                executor.submit(probe_proxy_candidate, source_name, proxy_address, probe_account, excluded_proxy_urls): proxy_address
                for proxy_address in batch_proxy_addresses
            }
            for completed_future in as_completed(future_to_proxy):
                usable_proxy_url = completed_future.result()
                if usable_proxy_url:
                    usable_list.append(usable_proxy_url)
                    if len(usable_list) >= PROXY_SUCCESS_POOL_SIZE:
                        return usable_list

    return usable_list


def pick_usable_proxy(probe_account=None, excluded_proxy_urls=None):
    """按顺序从多个代理池中挑选可用代理。

    先尝试 spiderpy, 若整池都不可用或被 WAF 拦截, 再尝试 proxifly。
    每个来源内部会打乱顺序逐一测试, 最后从该来源存活代理中随机挑一个。
    """
    proxy_sources = [
        ("demo.spiderpy.cn", fetch_spiderpy_proxies),
        ("proxifly", fetch_proxifly_proxies),
    ]

    for source_name, fetch_proxy_list in proxy_sources:
        proxy_addresses = fetch_proxy_list()
        if not proxy_addresses:
            continue

        usable_list = collect_usable_proxies(source_name, proxy_addresses, probe_account, excluded_proxy_urls)

        if usable_list:
            log(f"[DEBUG] {source_name} 存活代理 {len(usable_list)} 条, 随机挑选")
            return random.choice(usable_list)

        log(f"[WARN] {source_name} 的所有代理均不可用或被 WAF 拦截")

    return ""


# ===================== 代理测速选优(获取 TopN 能访问目标站点的最快代理) =====================
def probe_proxy_speed(proxy_address):
    """测试单个代理访问 PROXY_SPEEDTEST_URL 的往返耗时(秒)。

    只要能够走代理完成一次 HTTP 请求并返回响应(含 4xx/5xx), 就认为该代理能访问目标站点;
    网络异常或返回 WAF 拦截页则视为不可达。返回 (耗时秒, 规范化代理URL) 或 None。
    """
    candidate_url = normalize_proxy_url(proxy_address)
    if not candidate_url:
        return None

    probe_session = requests.Session()
    probe_session.trust_env = False
    probe_session.proxies = {"http": candidate_url, "https": candidate_url}
    probe_session.headers.update({"User-Agent": USER_AGENT})
    try:
        start_time = time.perf_counter()
        probe_response = probe_session.get(
            PROXY_SPEEDTEST_URL,
            timeout=(4, 15),
            allow_redirects=True,
        )
        elapsed_seconds = time.perf_counter() - start_time
    except Exception:
        return None

    if is_waf_blocked(probe_response):
        return None
    return elapsed_seconds, candidate_url


def measure_stable_speed(proxy_url):
    """对一个已知可达代理复测 PROXY_SPEEDTEST_ROUNDS 次, 取最小耗时作为稳定速度分。"""
    best_elapsed = None
    for _ in range(PROXY_SPEEDTEST_ROUNDS):
        probe_result = probe_proxy_speed(proxy_url)
        if probe_result is None:
            continue
        elapsed_seconds = probe_result[0]
        if best_elapsed is None or elapsed_seconds < best_elapsed:
            best_elapsed = elapsed_seconds
    return best_elapsed


def find_fastest_proxies(top_n=None, stable_candidate_ratio=3):
    """并发拉取代理池并按速度挑选出 TopN 最快可达目标站点的代理。

    流程:
    1. 依序从 spiderpy / proxifly 拉取代理列表;
    2. 分批并发做首轮速测, 累计收集可达代理及其耗时;
       只要收集满 top_n * stable_candidate_ratio 个候选就不再继续测速, 避免全量拖垮耗时;
    3. 对前 top_n * stable_candidate_ratio 名复测取最小值, 得出稳定排序;
    4. 返回 [(耗时秒, 规范化代理URL), ...] 按耗时升序, 最多 top_n 条。
    """
    top_n = max(1, top_n or PROXY_TOP_N)
    needed_candidates = top_n * stable_candidate_ratio
    proxy_sources = [
        ("demo.spiderpy.cn", fetch_spiderpy_proxies),
        ("proxifly", fetch_proxifly_proxies),
    ]

    first_round_results = []  # 元素: (耗时秒, 代理URL)
    for source_name, fetch_proxy_list in proxy_sources:
        proxy_addresses = fetch_proxy_list()
        if not proxy_addresses:
            continue

        already_supplied = len(first_round_results) >= needed_candidates
        batch_candidates_needed = needed_candidates - len(first_round_results)
        if already_supplied:
            break

        shuffled_addresses = list(proxy_addresses)
        random.shuffle(shuffled_addresses)

        for batch_start_index in range(0, len(shuffled_addresses), PROXY_PROBE_BATCH_SIZE):
            if len(first_round_results) >= needed_candidates:
                break
            batch_proxy_addresses = shuffled_addresses[batch_start_index: batch_start_index + PROXY_PROBE_BATCH_SIZE]
            if not batch_proxy_addresses:
                continue
            with ThreadPoolExecutor(max_workers=min(PROXY_PROBE_WORKERS, len(batch_proxy_addresses))) as executor:
                future_to_proxy = {
                    executor.submit(probe_proxy_speed, proxy_address): proxy_address
                    for proxy_address in batch_proxy_addresses
                }
                for completed_future in as_completed(future_to_proxy):
                    probe_result = completed_future.result()
                    if probe_result:
                        first_round_results.append(probe_result)
            log(f"[DEBUG] {source_name} 批次测速完成, 累计可达代理 {len(first_round_results)} 条"
                f"(目标 {needed_candidates} 条)")

    if not first_round_results:
        log(f"[WARN] 没有任何代理能访问 {PROXY_SPEEDTEST_URL}")
        return []

    first_round_results.sort(key=lambda pair: pair[0])
    stable_candidates = [proxy_url for _elapsed, proxy_url in first_round_results[:needed_candidates]]

    log(f"[DEBUG] 对前 {len(stable_candidates)} 条候选复测稳定性(各 {PROXY_SPEEDTEST_ROUNDS} 次取最小)")
    stable_results = []
    with ThreadPoolExecutor(max_workers=min(PROXY_PROBE_WORKERS, len(stable_candidates))) as executor:
        future_to_url = {
            executor.submit(measure_stable_speed, proxy_url): proxy_url
            for proxy_url in stable_candidates
        }
        for completed_future in as_completed(future_to_url):
            stable_elapsed = completed_future.result()
            if stable_elapsed is not None:
                stable_results.append((stable_elapsed, future_to_url[completed_future]))

    stable_results.sort(key=lambda pair: pair[0])
    return stable_results[:top_n]


def run_proxy_speedtest(top_n=None):
    """执行一次完整的代理测速选优, 打印 TopN 结果, 可选写入文件。返回 TopN 列表。"""
    top_n = max(1, top_n or PROXY_TOP_N)
    log(f"开始代理测速选优: 目标 {PROXY_SPEEDTEST_URL}, 取最快 top {top_n}")
    proxy_ranking = find_fastest_proxies(top_n=top_n)
    if not proxy_ranking:
        log("[WARN] 未找到能访问该站点的代理")
        return []

    log("=" * 70)
    log(f"能访问 {PROXY_SPEEDTEST_URL} 的最快代理 Top {len(proxy_ranking)}")
    log("=" * 70)
    output_lines = []
    for rank_index, (elapsed_seconds, proxy_url) in enumerate(proxy_ranking, start=1):
        display_proxy = mask_proxy_credentials(proxy_url)
        log(f"Top {rank_index:<2}: {display_proxy:<45} 耗时 {elapsed_seconds * 1000:6.0f} ms")
        output_lines.append(f"{proxy_url}  {elapsed_seconds:.3f}")
    log("=" * 70)

    if PROXY_SPEEDTEST_OUTPUT:
        try:
            with open(PROXY_SPEEDTEST_OUTPUT, "w", encoding="utf-8") as proxy_output_file:
                proxy_output_file.write("\n".join(output_lines) + "\n")
            log(f"[DEBUG] Top 代理已写入: {PROXY_SPEEDTEST_OUTPUT}")
        except Exception as file_error:
            log(f"[WARN] 写入代理结果文件失败: {file_error}")
    else:
        log("[DEBUG] 如需保存结果, 可设置 AGENTROUTER_SPEEDTEST_OUTPUT=文件路径")
    return proxy_ranking


def ensure_proxy_available(retry_interval_seconds=600, probe_account=None, excluded_proxy_urls=None):
    """确保取到可用代理; 若未取到(如 spiderpy 代理全部失败/被 WAF 拦截)则每 10 分钟重试, 直到成功。

    仅在用户未显式配置 AGENTROUTER_PROXY 时才可能走到重试; 显式代理会立即返回。
    """
    global PROXY_URL, PROXY_URL_FOR_LOG
    attempt_number = 1
    while True:
        PROXY_URL = resolve_proxy_url(probe_account=probe_account, excluded_proxy_urls=excluded_proxy_urls)
        PROXY_URL_FOR_LOG = mask_proxy_credentials(PROXY_URL)
        if PROXY_URL:
            return
        log(f"[WARN] 未获取到可用代理(第 {attempt_number} 次), 等待 {retry_interval_seconds} 秒后将重试, 直至成功")
        time.sleep(retry_interval_seconds)
        attempt_number += 1


PROXY_URL = ""
PROXY_URL_FOR_LOG = "未配置"


# ===================== 账号密码登录 =====================
def password_login(account):
    account_name = account.get("name", "默认账号")
    email = (account.get("email") or "").strip()
    password = (account.get("password") or "").strip()
    if not email or not password:
        return build_result(account_name, "fail", "未配置 email/password, 跳过", None, None)

    log(f"====== 开始处理账号(账号密码登录): {account_name} ======")
    session = build_session()

    log(f"[DEBUG] 请求地址: {BASE_URL}{LOGIN_PATH}")
    log(f"[DEBUG] 请求体: username={email}, password={'*' * len(password)}")
    try:
        response = session.post(f"{BASE_URL}{LOGIN_PATH}",
                                json={"username": email, "password": password},
                                timeout=TIMEOUT)
    except Exception as request_error:
        return build_result(account_name, "fail", describe_request_error(request_error), None, None, retryable=True)

    content_type = response.headers.get("Content-Type", "")
    log(f"[DEBUG] 响应状态码: {response.status_code}")
    log(f"[DEBUG] 响应头 Content-Type: {content_type}")
    log(f"[DEBUG] 响应 Set-Cookie: {response.headers.get('Set-Cookie', '无')[:200]}")
    log(f"[DEBUG] 响应体(前2000字符): {response.text[:2000]}")

    if response.status_code == 405:
        return build_result(account_name, "fail",
                           "登录接口返回 405, 通常是代理未生效或出口 IP 被 WAF 拦截, "
                           "请设置 AGENTROUTER_PROXY_SELFTEST=1 核对出口 IP",
                           None, None, retryable=True)

    if "text/html" in content_type:
        return build_result(account_name, "fail",
                           f"登录接口返回 HTML, 状态码 {response.status_code}(可能被 WAF 拦截或路径变化)",
                           None, None, retryable=True)

    try:
        login_payload = response.json()
    except Exception:
        return build_result(account_name, "fail", f"登录响应非 JSON: {response.text[:120]}", None, None, retryable=True)

    if not login_payload.get("success"):
        return build_result(account_name, "fail",
                           f"登录失败: {login_payload.get('message') or response.text[:120]}",
                           None, None)

    login_data = login_payload.get("data") or {}
    already_checked_in = bool(login_data.get("checked_in"))
    username = login_data.get("username") or login_data.get("display_name") or email
    quota = extract_quota(login_data)
    user_id = login_data.get("id")

    if not already_checked_in:
        return build_result(account_name, "success",
                           "登录成功, 但 checked_in=false(可能今日额度已发或接口变化)",
                           username, quota)

    verify_level, verify_detail, _newest_timestamp, _newest_content = verify_checkin(session, user_id)
    if verify_level in ("new", "today"):
        message = f"签到成功, 日志已确认({verify_detail})"
    else:
        message = f"登录成功且服务端返回已签到, 但日志未确认: {verify_detail}"
    return build_result(account_name, "success", message, username, quota)


# ===================== 签到日志核验 =====================
def verify_checkin(session, user_id, fresh_log_window_seconds=300, recent_window_days=1):
    if not user_id:
        return "error", "缺少 uid, 跳过日志核验", None, None
    try:
        response = session.get(f"{BASE_URL}{SELF_LOG_PATH}",
                               params={"p": 1, "page_size": 20},
                               headers={SELF_LOG_HEADER: str(user_id)},
                               timeout=TIMEOUT)
        if response.status_code != 200 or "text/html" in response.headers.get("Content-Type", ""):
            return "error", f"日志接口返回 HTTP {response.status_code}", None, None
        log_items = (response.json().get("data") or {}).get("items") or []
    except Exception as log_error:
        return "error", f"日志查询异常: {log_error}", None, None

    current_timestamp = int(time.time())
    newest_timestamp = None
    newest_content = None
    for log_item in log_items:
        content = log_item.get("content") or ""
        if ("签到成功" in content) or (log_item.get("type") == CHECKIN_LOG_TYPE):
            created_at = log_item.get("created_at")
            if isinstance(created_at, (int, float)) and (newest_timestamp is None or created_at > newest_timestamp):
                newest_timestamp, newest_content = created_at, content

    if newest_timestamp is None:
        return "none", "日志中未找到任何签到记录", None, None

    elapsed_seconds = current_timestamp - newest_timestamp
    if elapsed_seconds < 60:
        elapsed_text = f"{elapsed_seconds} 秒前"
    elif elapsed_seconds < 3600:
        elapsed_text = f"{int(elapsed_seconds / 60)} 分钟前"
    elif elapsed_seconds < 86400:
        elapsed_text = f"{int(elapsed_seconds / 3600)} 小时前"
    else:
        elapsed_text = f"{int(elapsed_seconds / 86400)} 天前"

    if newest_timestamp >= current_timestamp - fresh_log_window_seconds:
        return "new", f"本次运行已生成签到日志({elapsed_text})", newest_timestamp, newest_content
    if newest_timestamp >= current_timestamp - recent_window_days * 86400:
        return "today", f"近 {recent_window_days} 天内有签到记录({elapsed_text}), 本次未新增", newest_timestamp, newest_content
    return "none", f"最近一条签到日志较旧({elapsed_text})", newest_timestamp, newest_content


# ===================== 调度 =====================
def do_checkin(account):
    email = (account.get("email") or "").strip()
    password = (account.get("password") or "").strip()
    if email and password:
        return password_login(account)
    return build_result(account.get("name", "默认账号"), "fail",
                        "账号未配置 email/password, 跳过", None, None)


def do_checkin_with_proxy_retry(account, probe_account=None):
    account_name = account.get("name", "默认账号")
    excluded_proxy_urls = set()
    latest_result = None

    for attempt_number in range(1, ACCOUNT_PROXY_RETRY_LIMIT + 1):
        latest_result = do_checkin(account)
        if not should_retry_account_result(latest_result):
            return latest_result

        current_proxy_url = PROXY_URL
        if current_proxy_url:
            excluded_proxy_urls.add(current_proxy_url)

        if attempt_number >= ACCOUNT_PROXY_RETRY_LIMIT:
            log(f"[{account_name}] 代理类失败已达到重试上限 {ACCOUNT_PROXY_RETRY_LIMIT} 次, 放弃当前账号")
            return latest_result

        log(f"[{account_name}] 当前失败可重试, 准备更换代理后重试 ({attempt_number}/{ACCOUNT_PROXY_RETRY_LIMIT})")
        ensure_proxy_available(
            retry_interval_seconds=600,
            probe_account=probe_account or account,
            excluded_proxy_urls=excluded_proxy_urls,
        )

    return latest_result


def build_result(account_name, status, message, username, quota, retryable=False):
    result = {
        "name": account_name,
        "status": status,
        "message": message,
        "username": username or "",
        "quota": quota,
        "retryable": retryable,
        "time": time.strftime("%Y-%m-%d %H:%M:%S", time.localtime()),
    }
    status_tag = STATUS_TAGS.get(status, status)
    quota_text = f"{quota}" if quota is not None else "未知"
    log(f"[{account_name}] {status_tag} | {message} | 额度: {quota_text}")
    return result


def collect_accounts():
    accounts = []
    multi_account_raw = os.environ.get("AGENTROUTER_ACCOUNTS", "").strip()
    if multi_account_raw:
        try:
            account_entries = json.loads(multi_account_raw)
            if isinstance(account_entries, list):
                for index, entry in enumerate(account_entries):
                    email, password = parse_account(entry.get("account") or "")
                    if (not email or not password) and entry.get("email") and entry.get("password"):
                        email, password = entry["email"], entry["password"]
                    if email and password:
                        accounts.append({
                            "name": entry.get("name", f"账号{index + 1}"),
                            "email": email,
                            "password": password,
                        })
                if accounts:
                    log(f"已读取多账号配置, 共 {len(accounts)} 个")
                    return accounts
        except Exception as parse_error:
            log(f"AGENTROUTER_ACCOUNTS 解析失败: {parse_error}, 回退到单账号")

    single_account_raw = os.environ.get("AGENTROUTER_ACCOUNT", "").strip()
    if single_account_raw:
        email, password = parse_account(single_account_raw)
        if email and password:
            accounts.append({"name": "默认账号", "email": email, "password": password})
            log("已读取单账号配置(AGENTROUTER_ACCOUNT = 邮箱#密码)")
            return accounts

    log("未检测到任何配置: 请设置 AGENTROUTER_ACCOUNT=邮箱#密码 或 AGENTROUTER_ACCOUNTS")
    return accounts


def main():
    accounts = collect_accounts()

    # 未配置签到账号, 或显式开启测速模式时, 仅执行代理测速选优
    if read_bool_env("AGENTROUTER_SPEEDTEST_ONLY") or not accounts:
        run_proxy_speedtest(top_n=PROXY_TOP_N)
        if read_bool_env("AGENTROUTER_SPEEDTEST_ONLY"):
            return
        safe_notify("[AgentRouter] 未检测到账号配置", "未设置 AGENTROUTER_ACCOUNT / AGENTROUTER_ACCOUNTS, 已执行代理测速选优")
        return

    # 先确保取到可用代理; 取不到则每 10 分钟重试, 直到成功才继续签到
    ensure_proxy_available(retry_interval_seconds=600)

    log("AgentRouter 自动签到启动 (账号密码登录即签到)")
    log(f"[DEBUG] PROXY={PROXY_URL_FOR_LOG}")

    if PROXY_URL and is_socks_proxy(PROXY_URL):
        dependency_ready, dependency_error = ensure_socks_dependency()
        log(f"[DEBUG] PySocks 依赖: {'可用' if dependency_ready else '缺失 -> ' + dependency_error}")

    if read_bool_env("AGENTROUTER_PROXY_SELFTEST"):
        report_proxy_exit_ip()

    results = []
    for account in accounts:
        try:
            result = do_checkin_with_proxy_retry(account, probe_account=account)
            if result:
                results.append(result)
        except Exception:
            log(f"[{account.get('name', '?')}] 处理异常:\n{traceback.format_exc()}")
        if len(accounts) > 1:
            time.sleep(random.uniform(2, 5))

    if not results:
        safe_notify("[AgentRouter] 签到失败", "所有账号均未成功执行")
        return

    summary_lines = []
    for result in results:
        status_icon = STATUS_ICONS.get(result["status"], result["status"])
        quota_text = f"{result['quota']}" if result["quota"] is not None else "未知"
        display_name = result["username"] or result["name"]
        summary_lines.append(
            f"{status_icon} {result['name']}({display_name})：{result['message']} | 额度 {quota_text}")
    safe_notify("[AgentRouter] 签到汇总", "\n".join(summary_lines))
    log("全部账号处理完毕")


if __name__ == "__main__":
    main()
