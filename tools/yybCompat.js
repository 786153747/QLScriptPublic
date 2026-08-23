const Module = require("module");
const fs = require("fs");
const path = require("path");

// 原名单内的脚本依赖旧版 /wx/getuserinfo(取 code + getUserProfile 加密资料)。
// 已通过桥接方案迁移:请求改写为 YYB /wx/code,响应阶段再调 /wxapp/operateWxData
// (getUserProfile) 补齐 encryptedData/iv/signature,因此不再需要跳过注入。
const UNSUPPORTED_GETUSERINFO_SCRIPTS = new Set([]);

// 账号变量名与脚本文件名不一致的脚本,兼容层按此映射注入,否则启发式匹配不到。
const SCRIPT_ACCOUNT_ENV_OVERRIDES = {
    choubao: ["choubaoleyuan"],
    kangshifu: ["ksfcys"],
    wanyazhenxuan: ["wyzx"],
    yingshujufeng: ["yingshijufeng"],
    yz9d: ["dks"],
    yz19: ["tuoluzhe"],
};

const LEGACY_ROUTE_MAPPING = {
    "/wx/code": "/wx/code",
    "/wx/getphonenumber": "/wx/getphonenumber",
    "/wx/encryptkey": "/wx/encryptkey",
    "/wx/refresh": "/accounts/refresh",
    "/wx/getuserinfo": "/wx/code",
};

function splitYybEntries(rawValue = "") {
    return String(rawValue || "")
        .split(/\r?\n|&/)
        .map((item) => item.trim())
        .filter(Boolean);
}

function normalizeServerUrl(rawServer = "") {
    const trimmedServer = String(rawServer || "").trim().replace(/\/+$/, "");
    if (!trimmedServer) {
        return "";
    }
    if (/^https?:\/\//i.test(trimmedServer)) {
        return trimmedServer;
    }
    return `http://${trimmedServer}`;
}

function parseYybEntry(rawEntry = "") {
    const entryText = String(rawEntry || "").trim();
    if (!entryText || !entryText.includes("@")) {
        return null;
    }
    const separatorIndex = entryText.indexOf("@");
    const rawServer = entryText.slice(0, separatorIndex).trim();
    const accountValue = entryText.slice(separatorIndex + 1).trim();
    const referenceValue = accountValue.split("#", 1)[0].trim();
    const serverUrl = normalizeServerUrl(rawServer);
    if (!serverUrl || !referenceValue) {
        return null;
    }
    return {
        rawEntry: entryText,
        rawServer,
        serverUrl,
        accountValue,
        referenceValue,
    };
}

function loadYybEntries() {
    const rawValue = process.env.YYB_SERVER || "";
    return splitYybEntries(rawValue)
        .map(parseYybEntry)
        .filter(Boolean);
}

function getCurrentScriptBaseName() {
    const currentScriptPath = process.argv[1] || "";
    if (!currentScriptPath) {
        return "";
    }
    return path.basename(currentScriptPath, path.extname(currentScriptPath)).toLowerCase();
}

function getCurrentScriptSource() {
    const currentScriptPath = process.argv[1] || "";
    if (!currentScriptPath || !fs.existsSync(currentScriptPath)) {
        return "";
    }
    try {
        return fs.readFileSync(currentScriptPath, "utf-8");
    } catch {
        return "";
    }
}

function extractEnvNamesFromSource(sourceText) {
    const envNames = new Set();
    const regularExpressions = [
        /process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g,
        /process\.env\["([^"]+)"\]/g,
        /process\.env\['([^']+)'\]/g,
        /process\.env\.get\(["']([^"']+)["']/g,
        /process\.env\[([A-Za-z_][A-Za-z0-9_]*)\]/g,
    ];

    for (const expression of regularExpressions) {
        let matchResult;
        while ((matchResult = expression.exec(sourceText)) !== null) {
            if (matchResult[1]) {
                envNames.add(matchResult[1]);
            }
        }
    }
    return Array.from(envNames);
}

function isLikelyAccountEnvName(envName, scriptBaseName) {
    const normalizedName = String(envName || "").toLowerCase();
    const normalizedScriptName = String(scriptBaseName || "").toLowerCase();
    const ignoredNameFragments = [
        "debug",
        "token",
        "url",
        "auth",
        "version",
        "appid",
        "app_id",
        "phone",
        "proxy",
        "pool",
        "nickname",
        "timeout",
    ];
    if (ignoredNameFragments.some((fragment) => normalizedName.includes(fragment))) {
        return false;
    }
    if (normalizedName === normalizedScriptName || normalizedName === normalizedScriptName.toLowerCase()) {
        return true;
    }
    return ["openid", "account", "cookie", "ck", "user", "wxtx"].some((fragment) => normalizedName.includes(fragment));
}

function requireFromCurrentScript(moduleName) {
    const currentScriptPath = process.argv[1] || __filename;
    const scriptAwareRequire = Module.createRequire(path.resolve(currentScriptPath));
    return scriptAwareRequire(moduleName);
}

function getScriptEnvAliases(scriptBaseName) {
    const aliases = new Set();
    if (!scriptBaseName) {
        return [];
    }
    aliases.add(scriptBaseName);
    aliases.add(scriptBaseName.toUpperCase());
    aliases.add(scriptBaseName.toLowerCase());
    aliases.add("wx_openid");
    for (const overrideName of SCRIPT_ACCOUNT_ENV_OVERRIDES[scriptBaseName] || []) {
        aliases.add(overrideName);
        aliases.add(overrideName.toUpperCase());
    }
    return Array.from(aliases);
}

function hasAnyExplicitAccountEnv(scriptBaseName) {
    return getScriptEnvAliases(scriptBaseName).some((alias) => {
        const value = process.env[alias];
        return typeof value === "string" && value.trim();
    });
}

function injectYybAccountEnv(scriptBaseName, entries) {
    if (!scriptBaseName || !entries.length) {
        return { injected: false, skippedUnsupported: false };
    }
    if (UNSUPPORTED_GETUSERINFO_SCRIPTS.has(scriptBaseName)) {
        return { injected: false, skippedUnsupported: true };
    }
    if (hasAnyExplicitAccountEnv(scriptBaseName)) {
        return { injected: false, skippedUnsupported: false };
    }

    const accountListValue = entries.map((entry) => entry.accountValue).join("\n");
    const sourceEnvNames = extractEnvNamesFromSource(getCurrentScriptSource());
    const targetEnvNames = new Set([
        ...getScriptEnvAliases(scriptBaseName),
        "wx_openid",
        "wxtxopenids",
        "wxtxopenid",
    ]);

    for (const sourceEnvName of sourceEnvNames) {
        if (isLikelyAccountEnvName(sourceEnvName, scriptBaseName)) {
            targetEnvNames.add(sourceEnvName);
        }
    }

    for (const alias of targetEnvNames) {
        process.env[alias] = accountListValue;
    }
    return { injected: true, skippedUnsupported: false };
}

function injectLegacyBridgeEnv(entries) {
    if (!entries.length) {
        return;
    }
    if (!process.env.wx_server_url) {
        process.env.wx_server_url = entries[0].serverUrl;
    }
    if (!process.env.wx_auth) {
        process.env.wx_auth = "YYB_SERVER";
    }
}

function resolveRoutePath(rawUrl = "") {
    const routeMatchers = Object.keys(LEGACY_ROUTE_MAPPING);
    for (const routePath of routeMatchers) {
        if (String(rawUrl || "").includes(routePath)) {
            return routePath;
        }
    }
    return "";
}

function tryParseJsonBody(body) {
    if (!body) {
        return {};
    }
    if (typeof body === "object") {
        return body;
    }
    if (typeof body !== "string") {
        return {};
    }
    try {
        return JSON.parse(body);
    } catch {
        return {};
    }
}

function resolveEntryForPayload(entries, payload) {
    const candidateValues = [
        payload.ref,
        payload.openid,
        payload.userKey,
        payload.account,
    ]
        .map((item) => String(item || "").trim())
        .filter(Boolean);

    for (const candidateValue of candidateValues) {
        const matchedEntry = entries.find((entry) => {
            return entry.referenceValue === candidateValue || entry.accountValue === candidateValue;
        });
        if (matchedEntry) {
            return matchedEntry;
        }
    }
    return entries[0] || null;
}

function buildModernPayload(routePath, payload, matchedEntry) {
    const basePayload = {
        ref: matchedEntry.referenceValue,
        app_id: payload.app_id || payload.appid || payload.appId || "",
    };

    if (routePath === "/accounts/refresh") {
        return { ref: matchedEntry.referenceValue };
    }

    if (payload.payload && typeof payload.payload === "object") {
        basePayload.payload = payload.payload;
    }

    if (payload.data && typeof payload.data === "object" && !basePayload.payload) {
        basePayload.payload = payload.data;
    }

    for (const [key, value] of Object.entries(payload)) {
        if (["ref", "openid", "userKey", "appid", "app_id", "appId", "account"].includes(key)) {
            continue;
        }
        if (key === "payload" || key === "data") {
            continue;
        }
        basePayload[key] = value;
    }
    return basePayload;
}

function normalizeLegacySuccess(routePath, rawResponse) {
    const responseEnvelope = rawResponse && typeof rawResponse === "object" ? rawResponse : {};
    const responseData = responseEnvelope.data && typeof responseEnvelope.data === "object" ? responseEnvelope.data : {};
    const responseResult = responseData.result && typeof responseData.result === "object" ? responseData.result : {};

    if (routePath === "/wx/code") {
        const codeValue = responseResult.code || responseData.code || "";
        return {
            status: true,
            message: "success",
            code: codeValue,
            data: { code: codeValue },
            _yybRaw: responseEnvelope,
        };
    }

    if (routePath === "/wx/getphonenumber") {
        const codeValue = responseResult.code || responseData.code || "";
        const rawValue = responseResult.raw && typeof responseResult.raw === "object" ? responseResult.raw : {};
        return {
            status: true,
            message: "success",
            code: codeValue,
            data: {
                ...responseResult,
                code: codeValue,
                raw: rawValue,
            },
            _yybRaw: responseEnvelope,
        };
    }

    if (routePath === "/wx/encryptkey") {
        return {
            status: true,
            message: "success",
            data: responseResult,
            _yybRaw: responseEnvelope,
        };
    }

    if (routePath === "/wx/refresh") {
        return {
            status: true,
            message: "success",
            data: responseData,
            _yybRaw: responseEnvelope,
        };
    }

    return responseEnvelope;
}

function normalizeLegacyError(error) {
    const response = error && error.response;
    const responseBody = response && response.data;
    const message = responseBody && typeof responseBody === "object"
        ? responseBody.msg || responseBody.message || JSON.stringify(responseBody)
        : error.message;

    if (response) {
        response.data = {
            status: false,
            message,
            _yybRaw: responseBody,
        };
    }
    return Promise.reject(error);
}

async function fetchProfileFields(axios, matchedEntry, appIdValue) {
    // 旧版 /wx/getuserinfo 会顺带返回 getUserProfile 加密资料;
    // YYB 需另调 /wxapp/operateWxData(name=getUserProfile) 取得,失败时降级为仅返回 code。
    if (!matchedEntry || !appIdValue) {
        return {};
    }
    try {
        const profileResponse = await axios.post(
            `${matchedEntry.serverUrl}/wxapp/operateWxData`,
            {
                ref: matchedEntry.referenceValue,
                app_id: appIdValue,
                payload: { name: "getUserProfile", data: { desc: "用于完善会员资料" } },
            },
            { timeout: 20000 }
        );
        const profileEnvelope = profileResponse.data || {};
        if (Number(profileEnvelope.code) !== 0) {
            return {};
        }
        const profileResult = (profileEnvelope.data && profileEnvelope.data.result) || {};
        return {
            encryptedData: profileResult.encryptedData || "",
            iv: profileResult.iv || "",
            signature: profileResult.signature || "",
            cloud_id: profileResult.cloudID || profileResult.cloud_id || "",
            data: typeof profileResult.rawData === "string"
                ? profileResult.rawData
                : JSON.stringify(profileResult.userInfo || {}),
        };
    } catch (error) {
        return {};
    }
}

function patchAxiosForYyb(entries) {
    if (!entries.length || global.__YYB_AXIOS_PATCHED__) {
        return;
    }

    const axios = requireFromCurrentScript("axios");
    axios.interceptors.request.use((config) => {
        const routePath = resolveRoutePath(config.url);
        if (!routePath) {
            return config;
        }

        const modernRoutePath = LEGACY_ROUTE_MAPPING[routePath];
        const payload = tryParseJsonBody(config.data);
        const matchedEntry = resolveEntryForPayload(entries, payload);
        if (!matchedEntry) {
            return config;
        }

        const rewrittenPayload = buildModernPayload(modernRoutePath, payload, matchedEntry);
        config.url = `${matchedEntry.serverUrl}${modernRoutePath}`;
        config.data = rewrittenPayload;
        config.headers = {
            ...(config.headers || {}),
            "Content-Type": "application/json",
        };
        delete config.headers.auth;
        config.__yybLegacyRoute = routePath;
        config.__yybMatchedEntry = matchedEntry;
        config.__yybAppId = rewrittenPayload.app_id || "";
        return config;
    });

    axios.interceptors.response.use(
        async (response) => {
            const routePath = response.config && response.config.__yybLegacyRoute;
            if (!routePath) {
                return response;
            }
            const rawResponseBody = response.data;
            if (routePath === "/wx/getuserinfo") {
                const responseData = (rawResponseBody && typeof rawResponseBody === "object" && rawResponseBody.data) || {};
                const responseResult = (responseData.result && typeof responseData.result === "object") ? responseData.result : {};
                const codeValue = responseResult.code || responseData.code || "";
                const profileFields = Number(rawResponseBody && rawResponseBody.code) === 0
                    ? await fetchProfileFields(axios, response.config.__yybMatchedEntry, response.config.__yybAppId)
                    : {};
                response.data = {
                    status: true,
                    message: "success",
                    code: codeValue,
                    data: { code: codeValue, ...profileFields },
                    _yybRaw: rawResponseBody,
                };
                return response;
            }
            if (rawResponseBody && typeof rawResponseBody === "object" && Number(rawResponseBody.code) === 0) {
                response.data = normalizeLegacySuccess(routePath, rawResponseBody);
            }
            return response;
        },
        (error) => {
            const routePath = error && error.config && error.config.__yybLegacyRoute;
            if (!routePath) {
                return Promise.reject(error);
            }
            return normalizeLegacyError(error);
        }
    );

    global.__YYB_AXIOS_PATCHED__ = true;
}

function initializeYybCompat() {
    if (global.__YYB_COMPAT_CONTEXT__) {
        return global.__YYB_COMPAT_CONTEXT__;
    }

    const scriptBaseName = getCurrentScriptBaseName();
    const yybEntries = loadYybEntries();
    const injectionState = injectYybAccountEnv(scriptBaseName, yybEntries);
    injectLegacyBridgeEnv(yybEntries);
    patchAxiosForYyb(yybEntries);

    const context = {
        scriptBaseName,
        yybEntries,
        unsupportedGetUserInfo: UNSUPPORTED_GETUSERINFO_SCRIPTS.has(scriptBaseName),
        skippedUnsupported: injectionState.skippedUnsupported,
        injectedAccountEnv: injectionState.injected,
    };
    global.__YYB_COMPAT_CONTEXT__ = context;
    return context;
}

module.exports = {
    initializeYybCompat,
};
