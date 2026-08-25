/*
------------------------------------------
@name: 京东Code采集（YYB-Go-Enhanced 风格）
@Description: 京东(JDCode) - 微信小程序静默登录 + 采集 JD_COOKIE(pt_key/pt_pin)，自动同步青龙
cron: 0 0,6,12,18 * * *
------------------------------------------
变量名：YYB_SERVER（YYB-Go-Enhanced，格式：地址@微信账号标识，多行换行）
  示例：YYB_SERVER = 3.112.226.233:8000@账号ID或OpenID   （@ 后可用账号 ID/OpenID，可加 #备注）

可选变量：
  QL_URL / QL_CLIENT_ID / QL_CLIENT_SECRET   配置后自动把 JD_COOKIE 同步到青龙
  QL_COOKIE_ENV_NAME                       同步用的青龙变量名（默认 JD_COOKIE）
  JD_LOGIN_MODE                             auto | code | full（默认 auto，先静默，失败转 full）
  JD_COOKIE_MODE                            pt | all（默认 pt，只存 pt_key/pt_pin）
  JD_APPID                                  取 code 用的京东小程序 appid（默认 wx91d27dbf599dff74）
  JD_PT_APPID / JD_PT_APP / JD_PT_RETURN_URL  PT OAuth 兜底链路参数

依赖：YYB-Go-Enhanced 服务的 /wxapp/getCode 接口（如 http://3.112.226.233:8000/）。
  该脚本产出的本质是京东账号会话凭证 JD_COOKIE(pt_key;pt_pin)，由 login_lt 在“该微信
  openid 已绑定京东账号”时下发；未绑定时无法凭微信 code 静默生成，判 blocked。
------------------------------------------
契约（appid：京东小程序）：
  登录 GET https://wq.jd.com/mlogin/wxapp/login_lt
      query: appid=<JD_APPID> & code=<wx.login code> & type=silent & isIgnoreCookie=false ...
      成功（该微信绑定京东账号）：Set-Cookie 返回 pt_key/pt_pin，body.info.pin 非空
      未绑定：retCode=21 / "get apppwd failed"，info.pin/skey/unionid 全空，仅返回 sfstoken
  login_lt 未给出 pt 票据时，可用 JD_PT_APPID 走 plogin.m.jd.com 的 PT OAuth 链兜底。
  脚本内 APPID/端口均为配置项，不内置任何个人凭证；pt_key/pt_pin 每次运行现取。
------------------------------------------
*/

const { Env } = require("../tools/env.js");
const $ = new Env("京东Code采集");
const axios = require("axios");
const fs = require("fs");
const path = require("path");

const COOKIE_CACHE_FILE = path.join(__dirname, "jdcode_cookie_cache.json");
const LOGIN_URL = "https://wq.jd.com/mlogin/wxapp/login_lt";
const JD_REDIRECT_SUFFIXES = ["jd.com", ".jd.com", "jd.hk", ".jd.hk", "3.cn", ".3.cn"];

// ---------------- 配置（环境变量优先，默认对齐 YYB-Go-Enhanced 的 JDCode.py） ----------------

function envString(name, fallback = "") {
  const value = process.env[name];
  return typeof value === "string" ? value.trim() : fallback;
}
function clampInt(raw, min, max, fallback) {
  const n = parseInt(raw, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

const JD_APPID = envString("JD_APPID", "wx91d27dbf599dff74");
const JD_PT_APPID = envString("JD_PT_APPID", "wx2f5d8f9715c59d10");
const JD_PT_APP = envString("JD_PT_APP", "300");
const JD_PT_RETURN_URL = envString("JD_PT_RETURN_URL", "https://my.m.jd.com/account/index.html");
const QL_URL = envString("QL_URL").replace(/\/+$/, "");
const QL_CLIENT_ID = envString("QL_CLIENT_ID");
const QL_CLIENT_SECRET = envString("QL_CLIENT_SECRET");
const QL_COOKIE_ENV_NAME = envString("QL_COOKIE_ENV_NAME", "JD_COOKIE");
const LOGIN_MODE = envString("JD_LOGIN_MODE", "auto").toLowerCase();
const COOKIE_MODE = envString("JD_COOKIE_MODE", "pt").toLowerCase();
const REQUEST_TIMEOUT = clampInt(envString("REQUEST_TIMEOUT", "30"), 5, 90, 30);

const UA_WX =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.49 NetType/WIFI " +
  `Language/zh_CN miniProgram/${JD_APPID}`;

// ---------------- YYB_SERVER 账号解析（地址@账号标识，多行） ----------------

function splitYybEntries() {
  return (process.env.YYB_SERVER || "")
    .split(/\r?\n|&/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseYybEntry(rawEntry) {
  const entryText = String(rawEntry || "").trim();
  if (!entryText || !entryText.includes("@")) return null;
  const separatorIndex = entryText.indexOf("@");
  let server = entryText.slice(0, separatorIndex).trim();
  const accountValue = entryText.slice(separatorIndex + 1).trim();
  const ref = accountValue.split("#", 1)[0].trim();
  const remark = (accountValue.split("#")[1] || "").trim();
  if (!/^https?:\/\//i.test(server)) server = "http://" + server;
  server = server.replace(/\/+$/, "");
  if (!server || !ref) return null;
  return { rawEntry: entryText, server, ref, remark, accountValue };
}

// ---------------- 通用小工具 ----------------

function short(value, maxLength = 300) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (!text) return "";
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function mask(value) {
  const text = String(value || "");
  if (text.length <= 8) return text.replace(/./g, "*");
  return `${text.slice(0, 4)}****${text.slice(-4)}`;
}

// 从某个对象的各层递归查找指定 key（兼容多种包装格式），返回首个非空值
function nestedValue(payload, keys) {
  if (payload === null || payload === undefined) return undefined;
  const wantedLower = keys.map((key) => String(key).toLowerCase());
  if (typeof payload === "object") {
    for (const [key, value] of Object.entries(payload)) {
      if (
        (keys.includes(key) || wantedLower.includes(String(key).toLowerCase())) &&
        value !== null &&
        value !== ""
      ) {
        return value;
      }
    }
    for (const value of Object.values(payload)) {
      const found = nestedValue(value, keys);
      if (found !== null && found !== undefined && found !== "") return found;
    }
  } else if (typeof payload === "string") {
    const text = payload.trim();
    if (text.startsWith("{")) {
      try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === "object") return nestedValue(parsed, keys);
      } catch (e) {
        /* 非 JSON 字符串，忽略 */
      }
    }
  }
  return undefined;
}

function nestedString(payload, keys) {
  const value = nestedValue(payload, keys);
  return typeof value === "string" ? value.trim() : "";
}

// 兼容 YYB 返回的 {code, data, msg} 信封结构，解出业务 data
function unwrapServicePayload(payload) {
  if (payload && typeof payload === "object" && "code" in payload && "data" in payload) {
    const code = String(payload.code);
    if (!["0", "200", "201"].includes(code)) {
      const message = nestedString(payload, ["msg", "message", "errmsg", "error"]);
      throw new Error(message || `接口业务状态异常：${code}`);
    }
    const data = payload.data;
    if (data && typeof data === "object") return data;
    return { value: data };
  }
  return payload;
}

// Set-Cookie 数组里提取指定 cookie 名的值
function pickCookie(setCookies, name) {
  for (const cookie of setCookies || []) {
    const match = new RegExp(`(?:^|[;,\\s])${name}=([^;]+)`).exec(String(cookie));
    if (match) return match[1];
  }
  return "";
}

function ptCookieFromHeaders(setCookies) {
  const ptKey = pickCookie(setCookies, "pt_key");
  const ptPin = pickCookie(setCookies, "pt_pin");
  if (ptKey && ptPin) return `pt_key=${ptKey};pt_pin=${ptPin};`;
  return "";
}

function ptCookieFromPayload(payload) {
  const ptKey = nestedString(payload, ["pt_key", "ptKey"]);
  const ptPin = nestedString(payload, ["pt_pin", "ptPin"]);
  const infoPin = nestedString(payload.info, ["pin"]) || "";
  let pin = ptPin;
  if (!pin && infoPin) {
    try {
      pin = decodeURIComponent(infoPin);
    } catch (e) {
      pin = infoPin;
    }
  }
  if (ptKey && pin) return `pt_key=${ptKey};pt_pin=${pin};`;
  return "";
}

function allCookieFromHeaders(setCookies) {
  const parts = [];
  for (const cookie of setCookies || []) {
    const match = /^([^=\s]+)=([^;]*)/.exec(String(cookie).trim());
    if (match) parts.push(`${match[1]}=${match[2]}`);
  }
  return parts.length ? `${parts.join("; ")};` : "";
}

function ptKeyValue(cookie) {
  // 兼容两种格式：旧版 pt_key=…；新版 skey=…（都是登录票据）
  const match = /(?:^|[,;\s])(?:pt_key|skey)=([^;,\s]+)/.exec(String(cookie || ""));
  return match ? match[1] : "";
}

function cookiePin(cookie) {
  // 兼容两种格式：旧版 pt_pin=…；新版 pin=…
  const match = /(?:^|[,;\s])(?:pt_pin|pin)=([^;,\s]+)/.exec(String(cookie || ""));
  return match ? match[1] : "";
}

// 统一归一化为青龙要求的 JD_COOKIE 标准格式：pt_key=xxx;pt_pin=xxx;
// 兼容 pt_key/skey、pt_pin/pin 多种采集来源；无法提取时原样返回。
function normalizeJdCookie(cookie) {
  const ptKey = ptKeyValue(cookie);
  const ptPin = cookiePin(cookie);
  if (ptKey && ptPin) return `pt_key=${ptKey};pt_pin=${ptPin};`;
  return cookie;
}

function normalizePin(pin) {
  const raw = String(pin || "").trim();
  if (!raw) return "";
  try {
    return encodeURIComponent(decodeURIComponent(raw));
  } catch (e) {
    return raw;
  }
}

function pinVariants(pin) {
  const result = new Set();
  const raw = String(pin || "").trim();
  if (!raw) return result;
  result.add(raw);
  try {
    result.add(decodeURIComponent(raw));
  } catch (e) {
    /* 忽略 */
  }
  try {
    result.add(encodeURIComponent(raw));
    result.add(encodeURIComponent(decodeURIComponent(raw)));
  } catch (e) {
    /* 忽略 */
  }
  result.delete("");
  return result;
}

function allowedJdHost(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "https:") return false;
    const host = url.hostname.toLowerCase();
    return JD_REDIRECT_SUFFIXES.some((suffix) => host === suffix || host.endsWith(suffix));
  } catch (e) {
    return false;
  }
}

function htmlRedirectUrl(baseUrl, raw) {
  const text = String(raw || "")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
  const patterns = [
    /<meta[^>]+url\s*=\s*["']?([^"' >]+)/i,
    /(?:window\.)?location(?:\.href)?\s*=\s*["']([^"']+)/i,
    /location\.replace\s*\(\s*["']([^"']+)/i,
    /location\.assign\s*\(\s*["']([^"']+)/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match && match[1]) {
      try {
        return new URL(match[1].trim(), baseUrl).toString();
      } catch (e) {
        /* 继续尝试下一个 */
      }
    }
  }
  return "";
}

async function axiosNoRedirect({ method = "GET", url, headers, data }) {
  return axios({
    method,
    url,
    headers,
    data,
    maxRedirects: 0,
    validateStatus: () => true,
    timeout: REQUEST_TIMEOUT * 1000,
  });
}

// ---------------- YYB-Go /wxapp/getCode 取 code ----------------

async function yybGetCode(account, appId = JD_APPID) {
  const url = `${account.server}/wxapp/getCode`;
  const response = await axios.post(
    url,
    { ref: account.ref, app_id: appId },
    { timeout: REQUEST_TIMEOUT * 1000, proxy: false }
  );
  const code = extractWxCode(response.data);
  if (!code) throw new Error(`YYB ${url} 未返回有效 code: ${short(response.data)}`);
  return code;
}

function extractWxCode(data) {
  const boxes = [];
  const push = (obj) => {
    if (obj && typeof obj === "object") boxes.push(obj);
  };
  push(data);
  push(data && data.data);
  push(data && data.data && data.data.result);
  for (const box of boxes) {
    for (const key of ["wxCode", "wx_code", "jsCode", "jscode", "code", "wxcode", "code_value"]) {
      const value = box[key];
      if (typeof value === "string" && value.length >= 8) return value;
      if (typeof value === "number" && value > 0 && key === "code") continue; // code=0/200 等状态码跳过
    }
  }
  return "";
}

// ---------------- YYB /wxapp/operateWxData 取用户加密资料（full 模式） ----------------

async function yybGetUserInfo(account) {
  const url = `${account.server}/wxapp/operateWxData`;
  const response = await axios.post(
    url,
    {
      ref: account.ref,
      app_id: JD_APPID,
      payload: { api_name: "getUserInfo", data: { withCredentials: true }, env: 1 },
    },
    { timeout: REQUEST_TIMEOUT * 1000, proxy: false }
  );
  const result = unwrapServicePayload(response.data);
  // 该 YYB 服务把 rawData(原始 userInfo JSON 字符串) 放在 result.data 下；
  // 部分实现直接放在 rawData/raw_data。两处都兼容。
  let rawData = nestedValue(result, ["rawData", "raw_data", "data"]);
  if (rawData === null || rawData === undefined || rawData === "") {
    rawData = nestedValue(result, ["userInfo", "user_info"]);
  }
  if (typeof rawData === "object") rawData = JSON.stringify(rawData);
  const encrypted = nestedString(result, ["encryptedData", "encrytData", "encrypted_data", "encrypteddata"]);
  const info = {
    rawData: String(rawData || "").trim(),
    signature: nestedString(result, ["signature"]),
    encrytData: encrypted,
    iv: nestedString(result, ["iv"]),
    openid: nestedString(result, ["openid", "openId", "open_id"]),
  };
  const missing = ["rawData", "signature", "encrytData", "iv"].filter((key) => !info[key]);
  if (missing.length) throw new Error(`YYB getUserInfo 缺少字段：${missing.join(",")}`);
  return info;
}

// ---------------- JD login_lt 静默登录 ----------------

function loginHeaders() {
  return {
    "User-Agent": UA_WX,
    Referer: `https://servicewechat.com/${JD_APPID}/873/page-frame.html`,
    Accept: "application/json,text/plain,*/*",
  };
}

async function callLoginLt(account, code, userInfo) {
  const params = {
    appid: JD_APPID,
    code,
    type: "silent",
    isPopup: "false",
    isIgnoreCookie: "false",
    isOfficialPin: "false",
    loginColor: "{}",
    returnUrl: "pages/my/index/index",
    deviceName: "iPhone",
    deviceOS: "iOS",
    deviceOSVersion: "17.0",
    deviceVersion: "8.0.49",
    g_tk: "0",
    g_ty: "ls",
  };
  if (userInfo) {
    Object.assign(params, {
      rawData: userInfo.rawData,
      signature: userInfo.signature,
      encrytData: userInfo.encrytData,
      encryptedData: userInfo.encrytData,
      iv: userInfo.iv,
      ou: userInfo.openid || "",
    });
  }
  const response = await axios.get(LOGIN_URL, {
    params,
    headers: loginHeaders(),
    timeout: REQUEST_TIMEOUT * 1000,
    maxRedirects: 0,
    validateStatus: () => true,
  });
  let body = response.data;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch (e) {
      body = { raw: body };
    }
  }
  return { status: response.status, setCookies: response.headers["set-cookie"] || [], body: body || {} };
}

// ---------------- JD PT OAuth 兜底链路（对应 yyb_go void jdpt.go） ----------------

function jdPtHeaders() {
  return {
    "User-Agent":
      "Mozilla/5.0 (Linux; Android 10; Pixel 4 XL) AppleWebKit/537.36 (KHTML, like Gecko) " +
      "Chrome/126.0.0.0 Mobile Safari/537.36 MicroMessenger/7.0.20.1781 NetType/WIFI " +
      "MiniProgramEnv/Windows WindowsWechat/WMPF",
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9",
  };
}

async function jdPtCookieLogin(code) {
  const loginUrl =
    "https://plogin.m.jd.com/user/login.action?" +
    new URLSearchParams({ appid: JD_PT_APP, returnurl: JD_PT_RETURN_URL }).toString();
  const first = await axiosNoRedirect({ url: loginUrl, headers: jdPtHeaders() });
  const firstLocation = first.headers.location || "";
  if (first.status < 300 || first.status >= 400 || !firstLocation) {
    throw new Error(`JD PT login.action 未跳转：HTTP ${first.status}`);
  }
  const oauthUrl = new URL(firstLocation, loginUrl).toString();
  const oauthQuery = new URL(oauthUrl).searchParams;
  if (oauthQuery.get("appid") !== JD_PT_APPID) throw new Error("JD PT OAuth appid 不匹配");
  const redirectUri = oauthQuery.get("redirect_uri");
  const state = oauthQuery.get("state");
  if (!redirectUri || !state) throw new Error("JD PT OAuth 缺少 redirect_uri/state");
  const callback = new URL(redirectUri);
  callback.searchParams.set("code", code);
  callback.searchParams.set("state", state);

  const allSetCookies = [];
  let current = callback.toString();
  let lastStatus = 0;
  for (let step = 0; step < 8; step++) {
    if (!allowedJdHost(current)) throw new Error("JD PT 刷新跳转超出允许的京东域名");
    const response = await axiosNoRedirect({ url: current, headers: jdPtHeaders() });
    lastStatus = response.status;
    const setCookies = response.headers["set-cookie"] || [];
    allSetCookies.push(...setCookies);
    const cookie = ptCookieFromHeaders(setCookies);
    if (cookie) return cookie;
    let location = response.headers.location || "";
    if (!location && lastStatus === 200) {
      location = htmlRedirectUrl(current, typeof response.data === "string" ? response.data : JSON.stringify(response.data));
    }
    if (!location || ![200, 301, 302, 303, 307, 308].includes(lastStatus)) break;
    current = new URL(location, current).toString();
  }
  const fromAll = ptCookieFromHeaders(allSetCookies);
  if (fromAll) return fromAll;
  throw new Error(`JD PT 刷新链未返回 pt_key/pt_pin；last_status=${lastStatus}`);
}

// ---------------- 登录组合（code / full / auto + PT 兜底） ----------------

async function attemptCodeLogin(account, fullMode) {
  const code = await yybGetCode(account);
  const userInfo = fullMode ? await yybGetUserInfo(account) : null;
  const { setCookies, body } = await callLoginLt(account, code, userInfo);
  const info = (body && body.info) || {};

  const retMsg = body.retMsg || body.retmsg || "";
  const retCode = body.retCode ?? body.retcode;
  const unbound =
    String(retMsg).includes("apppwd") || String(retCode) === "21" || (!info.pin && info.pinStatus === 0);

  // 1) 经典格式：login_lt 下发 pt_key/pt_pin
  let cookie = ptCookieFromHeaders(setCookies);
  if (!cookie) cookie = ptCookieFromPayload(body);
  if (cookie) {
    return COOKIE_MODE === "all" ? allCookieFromHeaders(setCookies) || cookie : cookie;
  }

  // 2) 新版格式：静默登录成功只给 skey（等价 pt_key 地位）+ pin + unionid
  //    登录成功特征：pin 存在且 retCode!=21；此时用 skey/pin/unionid 拼 JD_COOKIE
  if (!unbound && info.pin && info.skey) {
    const sessionCookie =
      `pin=${info.pin};skey=${info.skey};unionid=${info.unionid || ""};` +
      (info.sfstoken ? `sfstoken=${info.sfstoken};` : "");
    return COOKIE_MODE === "all" ? allCookieFromHeaders(setCookies) || sessionCookie : sessionCookie;
  }

  if (!unbound && (COOKIE_MODE === "pt" || COOKIE_MODE === "all")) {
    try {
      const ptCode = await yybGetCode(account, JD_PT_APPID);
      const ptCookie = await jdPtCookieLogin(ptCode);
      if (ptCookie) return ptCookie;
    } catch (exchangeError) {
      /* PT 兜底失败，统一走下方报错 */
    }
  }
  if (unbound) {
    throw new Error("该微信未绑定京东账号，无法凭 code 静默登录取票据（get apppwd failed）");
  }
  throw new Error(`${retMsg || "login_lt 未返回 pt_key/pt_pin 或 skey"}`);
}

async function loginViaCode(account) {
  if (LOGIN_MODE === "code") return attemptCodeLogin(account, false);
  if (LOGIN_MODE === "full") return attemptCodeLogin(account, true);
  if (LOGIN_MODE !== "auto") throw new Error("JD_LOGIN_MODE 只能是 auto、code 或 full");
  try {
    return await attemptCodeLogin(account, false);
  } catch (codeError) {
    if (/login_buffer expired|登录缓存已过期/i.test(String(codeError))) throw codeError;
    return await attemptCodeLogin(account, true);
  }
}

// ---------------- 青龙同步 ----------------

function qlOk(payload) {
  if (!payload || typeof payload !== "object") return false;
  if (payload.success === true) return true;
  if (!("code" in payload)) return true;
  return ["0", "200", "201"].includes(String(payload.code));
}

function qlItems(payload) {
  const data = payload && payload.data;
  if (Array.isArray(data)) return data.filter((item) => item && typeof item === "object");
  if (data && typeof data === "object") {
    for (const key of ["data", "list", "items", "envs", "records"]) {
      const value = data[key];
      if (Array.isArray(value)) return value.filter((item) => item && typeof item === "object");
    }
    if (data.name || data.value) return [data];
  }
  return [];
}

async function qlRequest(token, method, requestPath, data) {
  // 取 token 阶段 token 为空，绝不能发送空的 Authorization: Bearer 头，
  // 否则青龙/网关会把它当成"Token 已失效"直接返回 401，而不会走开放应用认证。
  const headers = { Accept: "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await axios({
    method,
    url: QL_URL + requestPath,
    headers,
    data,
    timeout: REQUEST_TIMEOUT * 1000,
  });
  return response.data;
}

async function qlToken() {
  const query = new URLSearchParams({ client_id: QL_CLIENT_ID, client_secret: QL_CLIENT_SECRET }).toString();
  let payload;
  try {
    payload = await qlRequest("", "GET", `/open/auth/token?${query}`);
  } catch (tokenError) {
    const detail = tokenError && tokenError.message ? tokenError.message : String(tokenError);
    $.log(`获取青龙 token 失败(Token 已失效, 带上了空的 Authorization 头): ${detail}`);
    $.log(`请使用已修复版本：取 token 阶段不再发送空的 Authorization: Bearer 头。`);
    throw tokenError;
  }
  if (!qlOk(payload)) throw new Error(`获取青龙 token 失败：${short(payload)}`);
  const data = payload && payload.data && typeof payload.data === "object" ? payload.data : {};
  const token = data.token || data.access_token || (payload && payload.token) || "";
  if (!token) throw new Error("青龙未返回 token");
  return token;
}

async function qlEnvs(token) {
  const query = new URLSearchParams({ searchValue: QL_COOKIE_ENV_NAME }).toString();
  const payload = await qlRequest(token, "GET", `/open/envs?${query}`);
  if (!qlOk(payload)) throw new Error(`读取青龙变量失败：${short(payload)}`);
  return qlItems(payload).filter((item) => item.name === QL_COOKIE_ENV_NAME);
}

function findExistingEnv(envs, cookie, remark) {
  const targetPin = normalizePin(cookiePin(cookie));
  const targetVariants = pinVariants(targetPin);
  for (const item of envs) {
    const oldCookie = ptCookieFromPayload({ pt_key: ptKeyValue(item.value), pt_pin: cookiePin(item.value) });
    const oldPin = normalizePin(cookiePin(oldCookie));
    const oldRemark = String(item.remarks || item.remark || "").trim();
    const oldVariants = pinVariants(oldPin);
    for (const variant of oldVariants) {
      if (targetVariants.has(variant)) return item;
    }
    if (oldRemark) {
      for (const variant of pinVariants(oldRemark)) {
        if (targetVariants.has(variant)) return item;
      }
    }
    if (oldRemark === remark || oldCookie === cookie) return item;
  }
  return null;
}

async function updateQlEnv(token, itemId, cookie, remark) {
  const base = { name: QL_COOKIE_ENV_NAME, value: cookie, remarks: remark };
  const idString = String(itemId);
  const candidates = /^\d+$/.test(idString)
    ? [{ ...base, id: Number(idString) }, { ...base, _id: idString }]
    : [{ ...base, _id: idString }, { ...base, id: idString }];
  for (const body of candidates) {
    try {
      const payload = await qlRequest(token, "PUT", "/open/envs", body);
      if (qlOk(payload)) return;
    } catch (e) {
      /* 换用另一个 id 字段重试 */
    }
  }
  throw new Error("更新青龙变量失败");
}

async function createQlEnv(token, cookie, remark) {
  const payload = await qlRequest(token, "POST", "/open/envs", [
    { name: QL_COOKIE_ENV_NAME, value: cookie, remarks: remark },
  ]);
  if (!qlOk(payload)) throw new Error(`创建青龙变量失败：${short(payload)}`);
}

async function syncToQl(account, cookie) {
  // 青龙 JD_COOKIE 固定使用 pt_key=xxx;pt_pin=xxx; 格式，写入前统一样式。
  const normalized = normalizeJdCookie(cookie);
  const token = await qlToken();
  const envs = await qlEnvs(token);
  const remark = account.remark || normalizePin(cookiePin(normalized)) || `JD_COOKIE-${account.ref}`;
  const existing = findExistingEnv(envs, normalized, remark);
  if (existing) {
    await updateQlEnv(token, existing.id !== undefined ? existing.id : existing._id, normalized, remark);
    return "update";
  }
  await createQlEnv(token, normalized, remark);
  return "create";
}

// ---------------- 任务执行 ----------------

function readCache() {
  try {
    if (!fs.existsSync(COOKIE_CACHE_FILE)) return {};
    return JSON.parse(fs.readFileSync(COOKIE_CACHE_FILE, "utf8")) || {};
  } catch (e) {
    return {};
  }
}

function writeCache(cache) {
  try {
    fs.writeFileSync(COOKIE_CACHE_FILE, JSON.stringify(cache, null, 2), "utf8");
  } catch (e) {
    $.log(`写入缓存失败: ${e.message || e}`);
  }
}

class Task {
  constructor(account) {
    this.account = account;
    this.index = $.userIdx++;
  }
  log(text) {
    $.log(`账号[${this.index}]${this.account.remark ? `[${this.account.remark}]` : ""} ${text}`);
  }
  async run() {
    try {
      const cookie = await loginViaCode(this.account);
      const pin = cookiePin(cookie) || "";
      const cache = readCache();
      cache[this.account.ref] = { pin, jdCookie: cookie, updatedAt: new Date().toISOString() };
      writeCache(cache);
      this.log(`✅ 采集 JD_COOKIE 成功：pin=${pin} pt_key=${mask(ptKeyValue(cookie))}（已写入本地缓存）`);

      if (QL_URL && QL_CLIENT_ID && QL_CLIENT_SECRET) {
        try {
          const action = await syncToQl(this.account, cookie);
          this.log(`同步青龙变量 ${QL_COOKIE_ENV_NAME}：${action === "update" ? "已更新" : "已创建"}`);
        } catch (syncError) {
          this.log(`❌ 同步青龙失败: ${syncError.message || syncError}`);
        }
      } else {
        this.log("   提示：如需同步到青龙 JD_COOKIE，请配置 QL_URL / QL_CLIENT_ID / QL_CLIENT_SECRET。");
      }
    } catch (e) {
      this.log(`执行失败: ${e.message || e}`);
    }
  }
}

!(async () => {
  const entries = splitYybEntries();
  if (!entries.length) {
    $.log("未配置环境变量 YYB_SERVER（格式：地址@微信账号标识，多行换行，如 3.112.226.233:8000@账号ID）");
    return;
  }
  const accounts = entries.map(parseYybEntry).filter(Boolean);
  if (!accounts.length) {
    $.log("YYB_SERVER 格式应为 地址@微信账号标识（每行一个，需含 @ 分隔符）");
    return;
  }
  $.log(`共读取到 ${accounts.length} 个 YYB 账号`);
  for (let i = 0; i < accounts.length; i++) {
    await new Task(accounts[i]).run();
    if (i < accounts.length - 1) await $.wait(1500, 3000);
  }
})().catch((e) => $.log(e.message || e)).finally(() => $.done());
