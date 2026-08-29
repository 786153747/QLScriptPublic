/*
------------------------------------------
@Author: sm
@Date: 2026.08.29
@Description: YYB 取 code 接口健康探测(空码/异常推送告警)
cron: 0,30 * * * *    (每 30 分钟一次)
------------------------------------------
每 30 分钟探测一次 YYB 服务端取 code 接口(/wx/code,
即 /wxapp/getCode 的规范别名,两者等价):

  正常取到 code      -> 只记录日志,不打扰
  取 code 为空       -> 等待 10s 复探一次,复现才推送告警(排除间歇性抖动)
  账号登录态过期     -> 推送告警(409 login_buffer expired,需控制台重新扫码)
  服务不可用/网络错误 -> 等待 10s 复探一次,复现才推送告警

消息推送走 tools/sendNotify.js,与签到脚本同一套通知渠道
(Bark/Telegram/企业微信/PushPlus/Server酱等,按青龙环境变量配置)。

变量名:
  YYB_SERVER     YYB 服务端与账号,默认 http://3.112.226.233:8000@1
  PROBE_APP_ID   探测用小程序 appid,默认 wxba70fb8e3eb3aab9(老板电器ROKI)
                 ⚠️ 必须选微信里已授权登录过的小程序,
                    否则该 appid 永远取不到 code,会持续误报

青龙任务: task wxapp/probe_wxcode.js  定时: 0,30 * * * *(每 30 分钟)
------------------------------------------
*/

const { Env } = require("../tools/env.js");
const $ = new Env("YYB取码探测");
const axios = require("axios");

const DEFAULT_YYB_SERVER = "http://3.112.226.233:8000@1";
const DEFAULT_PROBE_APP_ID = "wxba70fb8e3eb3aab9";
const GET_CODE_ENDPOINT = "/wxapp/getCode";
const CONFIRM_REPROBE_DELAY_MS = 10 * 1000;

// 解析 "http://host:port@ref" 格式的 YYB_SERVER 配置
function parseYybServer(rawServer) {
    const text = String(rawServer || "").trim();
    const atIndex = text.lastIndexOf("@");
    if (atIndex === -1) {
        return { baseUrl: text.replace(/\/+$/, ""), ref: "1" };
    }
    return {
        baseUrl: text.slice(0, atIndex).replace(/\/+$/, ""),
        ref: text.slice(atIndex + 1) || "1",
    };
}

function summarizePayload(payload) {
    const text = JSON.stringify(payload);
    return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

// 判定单次探测结果 -> { ok, reason }
function judgeProbeOutcome(httpStatus, payload) {
    const body = payload || {};
    const message = String(body.msg || body.message || body.error || "");
    // 登录态过期在 YYB 上是 HTTP 409 + body.code 409,优先识别并给出准确处置建议
    if (httpStatus === 409 || Number(body.code) === 409 || message.includes("login_buffer expired")) {
        return { ok: false, reason: `账号登录态过期(409 login_buffer expired): ${message || "re-scan required"},需到 YYB 控制台重新扫码` };
    }
    if (httpStatus !== 200) {
        return { ok: false, reason: `服务不可用(HTTP ${httpStatus}): ${summarizePayload(body)}` };
    }
    if (Number(body.code) !== 0) {
        return { ok: false, reason: `接口返回异常 code=${body.code} msg=${message}` };
    }
    const dataNode = body.data || {};
    const wxCode = dataNode.result?.code || dataNode.code || "";
    if (!wxCode) {
        return { ok: false, reason: `取 code 为空(服务端降级或该 appid 无微信会话): ${summarizePayload(body)}` };
    }
    return { ok: true, reason: "正常", wxCode };
}

async function probeOnce(baseUrl, ref, appId) {
    try {
        const response = await axios.post(
            `${baseUrl}${GET_CODE_ENDPOINT}`,
            { ref, app_id: appId },
            { timeout: 30 * 1000, proxy: false, validateStatus: () => true }
        );
        return judgeProbeOutcome(response.status, response.data);
    } catch (error) {
        return { ok: false, reason: `请求失败: ${error.code || error.message}` };
    }
}

function nowText() {
    return new Date().toLocaleString("zh-CN", { hour12: false });
}

async function main() {
    const { baseUrl, ref } = parseYybServer(process.env.YYB_SERVER || DEFAULT_YYB_SERVER);
    const appId = (process.env.PROBE_APP_ID || DEFAULT_PROBE_APP_ID).trim();

    console.log(`探测目标: ${baseUrl}${GET_CODE_ENDPOINT}  ref=${ref}  app_id=${appId}`);

    const firstOutcome = await probeOnce(baseUrl, ref, appId);
    if (firstOutcome.ok) {
        console.log(`✅ [${nowText()}] 探测正常,取到 code: ${String(firstOutcome.wxCode).slice(0, 8)}…`);
        process.exit(0);
    }

    console.log(`⚠️ 首次探测异常: ${firstOutcome.reason}`);
    console.log(`等待 ${CONFIRM_REPROBE_DELAY_MS / 1000}s 后复探确认(排除瞬时抖动)…`);
    await new Promise((resolve) => setTimeout(resolve, CONFIRM_REPROBE_DELAY_MS));

    const confirmOutcome = await probeOnce(baseUrl, ref, appId);
    if (confirmOutcome.ok) {
        console.log(`✅ [${nowText()}] 复探已恢复,首次为瞬时抖动,不推送`);
        process.exit(0);
    }

    $.log(`❌ YYB 取码探测告警 ${nowText()}`);
    $.log(`接口: ${baseUrl}${GET_CODE_ENDPOINT}(app_id=${appId}, ref=${ref})`);
    $.log(`首次探测: ${firstOutcome.reason}`);
    $.log(`复探确认: ${confirmOutcome.reason}`);
    $.log("排查建议: ① YYB 服务是否存活;② 微信账号登录态是否过期(控制台重新扫码);③ PROBE_APP_ID 对应小程序是否仍在微信中授权");
    await $.sendMsg();
    process.exit(0);
}

main().catch(async (error) => {
    $.log(`探测脚本自身出错: ${error.stack || error.message || error}`);
    await $.sendMsg().catch(() => {});
    process.exit(1);
});
