from __future__ import annotations

import inspect
import json
import os
import re
import sys
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import requests


class YybConfigError(RuntimeError):
    pass


IGNORED_ENV_SUFFIXES = (
    "_url",
    "_auth",
    "_version",
    "_ver",
    "_token",
    "_pool",
    "_phone",
    "_debug",
    "_enable",
    "_nickname",
    "_nick",
    "_appid",
    "_app_id",
)


def split_yyb_entries(raw_value: str) -> list[str]:
    return [item.strip() for item in str(raw_value or "").replace("&", "\n").splitlines() if item.strip()]


def normalize_server_url(raw_server: str) -> str:
    candidate_url = str(raw_server or "").strip().rstrip("/")
    if not candidate_url:
        return ""
    parsed_url = urlparse(candidate_url)
    if parsed_url.scheme and parsed_url.netloc:
        return candidate_url
    return f"http://{candidate_url}"


def parse_yyb_entry(raw_entry: str) -> tuple[str, str]:
    entry_text = str(raw_entry or "").strip()
    if "@" not in entry_text:
        raise YybConfigError(f"YYB_SERVER 格式错误，必须为 server@ref：{entry_text}")
    raw_server, raw_account = entry_text.split("@", 1)
    server_url = normalize_server_url(raw_server)
    account_value = raw_account.strip()
    reference_value = account_value.split("#", 1)[0].strip()
    if not server_url or not reference_value:
        raise YybConfigError(f"YYB_SERVER 缺少 server 或 ref：{entry_text}")
    return server_url, reference_value


def load_yyb_mapping() -> dict[str, tuple[str, str]]:
    mapping: dict[str, tuple[str, str]] = {}
    for raw_entry in split_yyb_entries(os.getenv("YYB_SERVER", "")):
        server_url, reference_value = parse_yyb_entry(raw_entry)
        mapping[reference_value] = (server_url, reference_value)
        mapping[raw_entry.split("@", 1)[1].strip()] = (server_url, reference_value)
    return mapping


def _extract_env_names_from_source(source_text: str) -> set[str]:
    env_names: set[str] = set()
    for pattern in (
        r'os\.getenv\(["\']([^"\']+)["\']',
        r'os\.environ\.get\(["\']([^"\']+)["\']',
        r'get_env_variable\(["\']([^"\']+)["\']',
    ):
        for match in re.finditer(pattern, source_text):
            env_names.add(match.group(1))
    for pattern in (r'process\.env\.([A-Za-z_][A-Za-z0-9_]*)', r'process\.env\["([^"]+)"\]', r"process\.env\['([^']+)'\]"):
        for match in re.finditer(pattern, source_text):
            env_names.add(match.group(1))
    return env_names


def _looks_like_account_env(env_name: str) -> bool:
    lowered_name = env_name.lower()
    if lowered_name in {"wx_server_url", "wx_auth", "plusplus_token", "proxy_api", "proxy_type"}:
        return False
    if lowered_name.endswith(IGNORED_ENV_SUFFIXES):
        return False
    if any(keyword in lowered_name for keyword in ("openid", "account", "cookie", "ck", "user", "xxh", "wuying", "wxtx", "trsj", "breo", "liy", "xmsq", "hongse", "bjhq", "yyb")):
        return True
    return lowered_name.islower() and lowered_name not in {"path", "time", "token", "version", "nickname"}


def bootstrap_yyb_script() -> dict[str, Any]:
    main_module = sys.modules.get("__main__")
    script_path = getattr(main_module, "__file__", "") or (inspect.stack()[1].filename if len(inspect.stack()) > 1 else "")
    script_source = ""
    if script_path:
        try:
            script_source = Path(script_path).read_text(encoding="utf-8")
        except Exception:
            script_source = ""

    env_names = _extract_env_names_from_source(script_source)
    yyb_mapping = load_yyb_mapping()
    account_value = "\n".join(entry_value for _, entry_value in yyb_mapping.values())
    first_server_url = next((server_url for server_url, _ in yyb_mapping.values()), "")

    if first_server_url and not os.getenv("wx_server_url"):
        os.environ["wx_server_url"] = first_server_url
    if not os.getenv("wx_auth"):
        os.environ["wx_auth"] = "YYB_SERVER"

    injected_envs: list[str] = []
    for env_name in sorted(env_names):
        if env_name in {"wx_server_url", "wx_auth"}:
            continue
        if env_name in os.environ and os.environ.get(env_name, "").strip():
            continue
        if _looks_like_account_env(env_name):
            os.environ[env_name] = account_value
            injected_envs.append(env_name)

    return {
        "script_path": script_path,
        "injected_envs": injected_envs,
        "account_value": account_value,
        "server_url": first_server_url,
    }


def resolve_yyb_account(account_id: str) -> tuple[str, str]:
    account_key = str(account_id or "").strip()
    yyb_mapping = load_yyb_mapping()
    if account_key in yyb_mapping:
        return yyb_mapping[account_key]
    if len(yyb_mapping) == 1:
        return next(iter(yyb_mapping.values()))
    if not yyb_mapping:
        raise YybConfigError("未配置 YYB_SERVER")
    raise YybConfigError(f"YYB_SERVER 未找到账号映射：{account_key}")


def extract_result_payload(response_json: dict[str, Any]) -> dict[str, Any]:
    response_data = response_json.get("data")
    if isinstance(response_data, dict):
        nested_result = response_data.get("result")
        if isinstance(nested_result, dict):
            return nested_result
        return response_data
    result = response_json.get("result")
    return result if isinstance(result, dict) else {}


def request_yyb(session: requests.Session, account_id: str, route_path: str, *, app_id: str, payload: dict[str, Any] | None = None, timeout: int = 30) -> dict[str, Any]:
    server_url, reference_value = resolve_yyb_account(account_id)
    request_payload: dict[str, Any] = {"ref": reference_value}

    if route_path != "/accounts/refresh":
        request_payload["app_id"] = app_id
    if payload:
        request_payload.update(payload)

    response = session.post(f"{server_url}{route_path}", json=request_payload, timeout=timeout)
    response.raise_for_status()
    response_json = response.json()
    if not isinstance(response_json, dict):
        raise RuntimeError(f"YYB_SERVER 返回格式异常：{response_json!r}")
    if int(response_json.get("code", -1)) != 0:
        raise RuntimeError(
            f"YYB_SERVER 调用失败：code={response_json.get('code')}，"
            f"msg={response_json.get('msg') or response_json.get('message') or '未知错误'}"
        )
    return response_json


def get_wx_code(session: requests.Session, account_id: str, app_id: str, timeout: int = 30) -> str:
    response_json = request_yyb(session, account_id, "/wx/code", app_id=app_id, timeout=timeout)
    result_payload = extract_result_payload(response_json)
    code_value = result_payload.get("code")
    if not isinstance(code_value, str) or not code_value:
        raise RuntimeError(f"YYB_SERVER 未返回 code：{response_json}")
    return code_value


def refresh_account(session: requests.Session, account_id: str, app_id: str, timeout: int = 30) -> dict[str, Any]:
    return request_yyb(session, account_id, "/accounts/refresh", app_id=app_id, timeout=timeout)


def get_encrypt_key(session: requests.Session, account_id: str, app_id: str, timeout: int = 30) -> dict[str, Any]:
    response_json = request_yyb(session, account_id, "/wx/encryptkey", app_id=app_id, timeout=timeout)
    return extract_result_payload(response_json)


def get_phone_number(session: requests.Session, account_id: str, app_id: str, timeout: int = 30) -> dict[str, Any]:
    response_json = request_yyb(session, account_id, "/wx/getphonenumber", app_id=app_id, timeout=timeout)
    return extract_result_payload(response_json)
