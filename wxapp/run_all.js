/**
 * wxapp 逐个执行器(取 code 空/限流自动等待重试版)
 *
 * 行为:
 *   1. 按文件名顺序逐个执行 wxapp/ 下的 .js / .py 签到脚本(一次只跑一个)
 *   2. 脚本执行完后,若输出中检测到「取 code 为空 / 限流 / 429」,
 *      等待 5 分钟后重试该脚本;重试后仍是空 code/限流,则再等 5 分钟继续重试,
 *      默认最多重试 50 次,达到上限后跳过进入下一个脚本
 *   3. 其他失败(业务失败/超时/异常退出)不重试,直接进入下一个脚本
 *
 *   4. 判定重试前会先检查输出:若已出现「非空有效 code」(如 "code":"0b..."),
 *      说明 code 已拿到,后续只是业务层失败——不进入等待重试,直接跳下一个脚本。
 *
 * 用法(在仓库根目录执行):
 *   node wxapp/run_all.js                     # 全量逐个执行
 *   node wxapp/run_all.js --list              # 仅列出将执行的脚本
 *   node wxapp/run_all.js --filter=roki       # 只执行文件名包含 roki 的脚本
 *   node wxapp/run_all.js --limit=5           # 只执行前 5 个
 *
 * 可调参数(命令行或同名环境变量):
 *   --retry-wait=300      触发空 code/限流后的等待秒数,默认 300(即 5 分钟)
 *   --step-delay=5        相邻两个脚本之间的间隔秒数,默认 5
 *   --timeout=180000      单个脚本执行超时毫秒,默认 180000
 *   --max-retries=50      空 code/限流最大重试次数,默认 50;设为 0 = 无限重试
 *   YYB_SERVER            服务端配置,默认 http://3.112.226.233:8000@1
 *
 * ⚠️ 注意: 小程序未授权/接口不匹配导致的空 code 是永久性的(重试多久都不会恢复),
 *    默认最多重试 50 次后跳过该脚本。如需无限重试可显式设 0,但会让队列卡死在这类脚本上:
 *      RUNALL_MAX_RETRIES=0 node wxapp/run_all.js   (每个脚本无限重试直到成功)
 *
 * 输出:
 *   控制台实时摘要 + wxapp/_run/logs/<脚本名>.log 每脚本完整日志(重试时追加)
 */
const { spawnSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const WXAPP_DIR = __dirname;
const LOGS_DIR = path.join(WXAPP_DIR, "_run", "logs");
const DEFAULT_YYB_SERVER = "http://3.112.226.233:8000@1";

// 辅助文件/非业务脚本,不参与执行
// qqpcmgr.js: 其依赖的 /wx/qrcodeauth 接口与 YYB-Go-Enhanced 服务端语义不匹配
// (服务端只生成待人工扫码的会话,不会返回 authCode),重试永远不会成功,暂时排除
const HELPER_FILES = new Set([
    "wcs.js",
    "yyb_helper.py",
    "run_all.js",
    "probe_wxcode.js",
    "qqpcmgr.js",
]);

const INTERPRETER_BY_EXT = {
    ".js": "node",
    ".py": "python",
};

// 空 code / 限流特征词(命中则等 5 分钟重试同一脚本)
const EMPTY_CODE_OR_RATE_LIMIT_KEYWORDS = [
    "取 code 为空",
    "code 为空",
    "code空",
    "code 空",
    "空code",
    "空 code",
    "未返回 code",
    "未返回完整登录数据",
    "限流",
    "降级",
    "429",
    "too many request",
    "rate limit",
    "frequent",
];

// 业务失败特征词(仅用于最终汇总分类,不触发重试)
const FAILURE_KEYWORDS = [
    "执行失败",
    "运行失败",
    "获取失败",
    "未配置",
    "错误",
    "exception",
    "traceback",
    "error",
    "failed",
    "❌",
];

function parseArgs() {
    const args = {
        list: false,
        filter: "",
        limit: Infinity,
        retryWaitSec: parseInt(process.env.RUNALL_RETRY_WAIT_SEC || "300", 10),
        stepDelaySec: parseInt(process.env.RUNALL_STEP_DELAY_SEC || "5", 10),
        timeoutMs: parseInt(process.env.RUNALL_TIMEOUT_MS || "180000", 10),
        maxRetries: parseInt(process.env.RUNALL_MAX_RETRIES || "50", 10),
    };
    for (const rawArg of process.argv.slice(2)) {
        if (rawArg === "--list") args.list = true;
        else if (rawArg.startsWith("--filter=")) args.filter = rawArg.slice("--filter=".length);
        else if (rawArg.startsWith("--limit=")) args.limit = parseInt(rawArg.slice("--limit=".length), 10);
        else if (rawArg.startsWith("--retry-wait=")) args.retryWaitSec = parseInt(rawArg.slice("--retry-wait=".length), 10);
        else if (rawArg.startsWith("--step-delay=")) args.stepDelaySec = parseFloat(rawArg.slice("--step-delay=".length));
        else if (rawArg.startsWith("--timeout=")) args.timeoutMs = parseInt(rawArg.slice("--timeout=".length), 10);
        else if (rawArg.startsWith("--max-retries=")) args.maxRetries = parseInt(rawArg.slice("--max-retries=".length), 10);
    }
    return args;
}

function collectScripts() {
    return fs
        .readdirSync(WXAPP_DIR)
        .filter((file) => INTERPRETER_BY_EXT[path.extname(file).toLowerCase()])
        .filter((file) => !HELPER_FILES.has(file))
        .sort();
}

function formatTimestamp(date) {
    const pad = (value) => String(value).padStart(2, "0");
    return (
        `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
        `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    );
}

function appendScriptLog(fileName, attemptNumber, status, elapsedSec, output) {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
    const header =
        `\n===== ${formatTimestamp(new Date())} 第 ${attemptNumber} 次执行 [${status}] 耗时 ${elapsedSec}s =====\n`;
    fs.appendFileSync(path.join(LOGS_DIR, `${fileName}.log`), header + `${output || "(无输出)"}\n`);
}

function matchesAnyKeyword(outputText, keywords) {
    const lowercased = String(outputText || "").toLowerCase();
    return keywords.some((keyword) => lowercased.includes(keyword.toLowerCase()));
}

// 输出中是否已出现「非空有效 code」——微信 code 通常是 20+ 字符的随机串,
// 这里按 8 字符以上判定,避免把 "code":"0" 之类的业务占位值误判成"已拿到 code"。
function hasValidWxCode(outputText) {
    return /"code"\s*:\s*"[^"]{8}[^"]*"/i.test(String(outputText || ""));
}

// 是否应因「空 code / 限流」而等待重试:
// 只有输出中确实没有拿到有效 code 时才重试;
// 若 code 已拿到,说明 wx_server 侧正常,后续只是业务层失败——不进入等待重试。
function shouldRetryForEmptyCodeOrRateLimit(outputText) {
    if (hasValidWxCode(outputText)) return false;
    return matchesAnyKeyword(outputText, EMPTY_CODE_OR_RATE_LIMIT_KEYWORDS);
}

function tail(text, lines = 8) {
    const trimmed = String(text || "").replace(/\s+$/u, "");
    if (!trimmed) return "";
    return trimmed.split(/\r?\n/u).slice(-lines).join("\n");
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 执行单个脚本并返回执行结果。
 * status: "成功" | "失败" | "超时" | "异常退出"
 * emptyCodeOrRateLimited: 输出中是否检测到空 code/限流(触发 5 分钟重试的依据)
 */
function executeScript(fileName, config, yybServer) {
    const scriptPath = path.join(WXAPP_DIR, fileName);
    const interpreter = INTERPRETER_BY_EXT[path.extname(fileName).toLowerCase()];
    const startedAt = Date.now();

    const result = spawnSync(interpreter, [scriptPath], {
        cwd: WXAPP_DIR,
        env: {
            ...process.env,
            YYB_SERVER: yybServer,
            PYTHONIOENCODING: "utf-8",
        },
        encoding: "utf8",
        timeout: config.timeoutMs,
        maxBuffer: 32 * 1024 * 1024,
    });

    const combinedOutput = `${result.stdout || ""}\n${result.stderr || ""}`.trim();
    const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);

    const isTimeout = result.error && result.error.code === "ETIMEDOUT";
    const exitCode = result.status === null && result.error ? -1 : (result.status ?? -1);

    let status;
    if (isTimeout) status = "超时";
    else if (exitCode !== 0) status = "异常退出";
    else if (matchesAnyKeyword(combinedOutput, FAILURE_KEYWORDS)) status = "失败";
    else status = "成功";

    const emptyCodeOrRateLimited = shouldRetryForEmptyCodeOrRateLimit(combinedOutput);

    return { status, exitCode, elapsedSec, output: combinedOutput, emptyCodeOrRateLimited };
}

async function waitWithCountdown(totalSeconds, fileName, attemptNumber) {
    const startedAt = Date.now();
    while (true) {
        const remainingMs = totalSeconds * 1000 - (Date.now() - startedAt);
        if (remainingMs <= 0) break;
        const remainingMinutes = Math.ceil(remainingMs / 60000);
        console.log(`  ⏳ ${fileName}: 等 ${totalSeconds}s 后重试(第 ${attemptNumber} 次重试),剩余约 ${remainingMinutes} 分钟 …`);
        await sleep(Math.min(remainingMs, 60 * 1000));
    }
}

async function runScriptWithRetry(fileName, config, yybServer) {
    let attemptNumber = 0;
    while (true) {
        attemptNumber += 1;
        const outcome = executeScript(fileName, config, yybServer);
        appendScriptLog(fileName, attemptNumber, outcome.status, outcome.elapsedSec, outcome.output);

        console.log("\n" + "=".repeat(64));
        console.log(`▶ ${fileName}  [${outcome.status}]  耗时 ${outcome.elapsedSec}s  (第 ${attemptNumber} 次执行)`);
        console.log("-".repeat(64));
        console.log(tail(outcome.output) || "(无输出)");
        console.log("=".repeat(64));

        if (!outcome.emptyCodeOrRateLimited) {
            return { fileName, finalStatus: outcome.status, attempts: attemptNumber };
        }

        // 空 code/限流:等待后重试;达到上限(若配置了上限)则放弃
        if (config.maxRetries > 0 && attemptNumber > config.maxRetries) {
            console.log(`  ⛔ ${fileName}: 重试 ${config.maxRetries} 次后仍为空 code/限流,跳过进入下一个脚本`);
            return { fileName, finalStatus: "限流未恢复", attempts: attemptNumber };
        }

        console.log(`  ⏳ ${fileName}: 检测到空 code/限流,等待 ${config.retryWaitSec}s 后重试 …`);
        await waitWithCountdown(config.retryWaitSec, fileName, attemptNumber);
    }
}

async function main() {
    const config = parseArgs();
    const yybServer = process.env.YYB_SERVER || DEFAULT_YYB_SERVER;

    let scripts = collectScripts();
    if (config.filter) scripts = scripts.filter((file) => file.includes(config.filter));
    if (config.list) {
        console.log(`将执行的脚本共 ${scripts.length} 个(排除辅助文件 ${[...HELPER_FILES].join(" / ")}):`);
        scripts.forEach((file, index) => console.log(`${index + 1}. ${file}`));
        return;
    }
    scripts = scripts.slice(0, config.limit);

    console.log(`YYB_SERVER   = ${yybServer}`);
    console.log(`脚本数量     = ${scripts.length}`);
    console.log(`脚本间隔     = ${config.stepDelaySec}s`);
    console.log(`重试等待     = ${config.retryWaitSec}s(空 code/限流后)`);
    console.log(`最大重试     = ${config.maxRetries === 0 ? "无限重试直到成功" : `${config.maxRetries} 次`}`);
    console.log(`单脚本超时   = ${config.timeoutMs}ms`);
    console.log("开始逐个执行……\n");

    const overallStartedAt = Date.now();
    const results = [];
    for (let index = 0; index < scripts.length; index++) {
        const fileName = scripts[index];
        results.push(await runScriptWithRetry(fileName, config, yybServer));

        const isLastScript = index === scripts.length - 1;
        if (!isLastScript && config.stepDelaySec > 0) {
            console.log(`  (间隔 ${config.stepDelaySec}s,还剩 ${scripts.length - index - 1} 个脚本 …)\n`);
            await sleep(config.stepDelaySec * 1000);
        }
    }

    const countByStatus = (status) => results.filter((result) => result.finalStatus === status).length;
    const totalMinutes = ((Date.now() - overallStartedAt) / 60000).toFixed(1);

    console.log("\n" + "=".repeat(64));
    console.log("🔥 运行汇总");
    console.log("=".repeat(64));
    console.log(`总耗时     : ${totalMinutes} 分钟`);
    console.log(`成功       : ${countByStatus("成功")} 个`);
    console.log(`失败       : ${countByStatus("失败")} 个`);
    console.log(`限流未恢复 : ${countByStatus("限流未恢复")} 个`);
    console.log(`超时       : ${countByStatus("超时")} 个`);
    console.log(`异常退出   : ${countByStatus("异常退出")} 个`);
    const troubleList = results.filter((result) => result.finalStatus !== "成功");
    if (troubleList.length) {
        console.log("\n存在问题(非成功):");
        troubleList.forEach((result) =>
            console.log(`  · ${result.fileName}  [${result.finalStatus}] (执行 ${result.attempts} 次)`)
        );
    }
    console.log("=".repeat(64));
}

main().catch((error) => {
    console.error("执行器出错:", error);
    process.exit(1);
});
