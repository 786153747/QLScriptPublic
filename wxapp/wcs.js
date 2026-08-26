const axios = require("axios");

// YYB 服务端取微信登录 code 的标准接口（参考 YYB-GO-Script 仓库的写法）：
// POST /wxapp/getCode  body: { ref, app_id }，返回 { code:0, data: { ..., result: { code: <wxCode> } } }
// 与旧 wx_server(192.168.x.x) 的 /wx/code + auth header 格式不同。
const GET_CODE_ENDPOINT = "/wxapp/getCode";

function normalizeServerBase(rawUrl) {
    return String(rawUrl || "").trim().replace(/\/+$/, "");
}

class WeChatCodeServer {
    constructor(options) {
        this.serverUrl = normalizeServerBase(options.url);
        this.appid = options.appid;
        // 兼容旧版：auth 仅在旧 /wx/code 格式使用，YYB 不再需要；保留字段以免外部读取报错
        this.auth = options.auth;
    }

    // 短时连续调用会触发服务器限流降级（返回 code:"" 空 code），遇空 code 自动等待重试几次。
    sleep(ms) {
        return new Promise((r) => setTimeout(r, ms));
    }

    async _fetchCode(openid) {
        const response = await axios.post(
            `${this.serverUrl}${GET_CODE_ENDPOINT}`,
            { ref: openid, app_id: this.appid },
            { timeout: 30 * 1000, proxy: false }
        );
        return response.data || {};
    }

    /**
     * 走 YYB /wxapp/getCode 取一次性微信 code。
     * 返回 axios response 形状 { data: {...} }，data 归一化为旧结构，方便下游无需改动：
     *   成功 -> { status:true, code:<wxCode>, data:{ code:<wxCode>, result:{ code:<wxCode> } } }
     *   失败 -> { status:false, message, error }
     */
    async getCode(openid) {
        const maxRetries = parseInt(process.env.WX_CODE_RETRY || "3", 10);
        const baseDelay = 3000; // 首段等待，避开限流窗口
        console.log("等待获取code(YYB /wxapp/getCode):");
        let lastMsg = "";
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            let payload;
            try {
                payload = await this._fetchCode(openid);
            } catch (error) {
                if (attempt >= maxRetries) {
                    console.log(`获取code异常: ${error.message || error}`);
                    return { data: { status: false, message: error.message || String(error) } };
                }
                lastMsg = error.message || String(error);
                await this.sleep(baseDelay);
                continue;
            }
            if (Number(payload.code) !== 0) {
                const message = payload.msg || payload.message || payload.error || JSON.stringify(payload);
                if (attempt >= maxRetries) {
                    console.log(`获取code失败: ${message}`);
                    return { data: { status: false, message, error: message } };
                }
                lastMsg = message;
                await this.sleep(baseDelay);
                continue;
            }
            const node = payload.data || {};
            const wxCode = node.result?.code || node.code || "";
            if (!wxCode) {
                if (attempt >= maxRetries) {
                    const message = `取 code 为空(服务器限流降级): ${JSON.stringify(payload)}`;
                    console.log(`获取code失败: ${message}`);
                    return { data: { status: false, message } };
                }
                console.log(`获取code为空，等待 ${baseDelay / 1000}s 后重试(${attempt + 1}/${maxRetries})...`);
                lastMsg = `取 code 为空: ${JSON.stringify(payload)}`;
                await this.sleep(baseDelay);
                continue;
            }
            console.log("获取code成功:");
            return {
                data: {
                    status: true,
                    code: wxCode,
                    data: { code: wxCode, result: { code: wxCode } },
                },
            };
        }
        return { data: { status: false, message: lastMsg } };
    }

    cloudInit(openid) {
        console.log("等待云函数初始化:");
        return new Promise((resolve, reject) => {
            axios.post(this.serverUrl + "/wx/call/init", { appid: this.appid, openid }, {
                headers: { auth: this.auth },
                timeout: 30 * 1000,
            }).then((res) => {
                console.log("云函数初始化成功:");
                resolve(res);
            }).catch((err) => reject(err));
        });
    }

    cloudCall(openid) {
        console.log("等待云函数调用:");
        return new Promise((resolve, reject) => {
            axios.post(this.serverUrl + "/wx/cloud/call", { appid: this.appid, openid }, {
                headers: { auth: this.auth },
                timeout: 30 * 1000,
            }).then((res) => {
                console.log("云函数调用成功:");
                resolve(res);
            }).catch((err) => reject(err));
        });
    }
}

module.exports = WeChatCodeServer;
