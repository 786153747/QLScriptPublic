/**
 * wxapp 目录脚本批量(分批)调用器
 *
 * 背景：YYB_SERVER 的取 code 接口存在 429 频率限制，一次性连跑会大量触发限流。
 * 此脚本按「步进休眠 + 分批次休眠」的方式逐个调用 wxapp/ 下的脚本。
 *
 * 用法（在仓库根目录执行）：
 *   node wxapp/batch_run.js                # 默认跑全部 .js/.py
 *   node wxapp/batch_run.js --list         # 仅列出可跑脚本
 *   node wxapp/batch_run.js --filter=jdy   # 只跑脚本名包含 jdy 的
 *   node wxapp/batch_run.js --limit=5      # 只跑前 5 个
 *
 * 可调参数（环境变量或同名单引）：
 *   YYB_SERVER        服务端配置(缺省为命令行默认值)
 *   STEP_DELAY_SEC     单脚本执行后的休眠秒数，默认 6
 *   BATCH_SIZE        每批次脚本数量，默认 5
 *   BATCH_DELAY_SEC   批次之间的休眠秒数，默认 30
 *   SCRIPT_TIMEOUT_MS 单个脚本最大执行毫秒，默认 180000
 */
const { spawnSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const WXAPP_DIR = __dirname;
const DEFAULT_YYB_SERVER = "http://3.112.226.233:8000@1";

// 辅助文件/非业务脚本，不参与批量调用
const HELPER_FILES = new Set([
    "wcs.js",
    "yyb_helper.py",
    "batch_run.js",
]);

const INTERPRETER_BY_EXT = {
    ".js": "node",
    ".py": "python",
};

// 输出中出现这些关键词视为运行失败（多数脚本失败也走 exit 0，故需按日志判定）
const FAILURE_KEYWORDS = ["执行失败", "失败", "运行失败", "❌", "exception", "traceback", "error occurred", "429"];
const RATE_LIMIT_KEYWORDS = ["429", "too many request", "rate limit", "frequent"];

function parseArgs() {
    const args = {
        list: false,
        filter: "",
        limit: Infinity,
        stepDelaySec: parseFloat(process.env.STEP_DELAY_SEC || "6"),
        batchSize: parseInt(process.env.BATCH_SIZE || "5", 10),
        batchDelaySec: parseFloat(process.env.BATCH_DELAY_SEC || "30"),
        timeoutMs: parseInt(process.env.SCRIPT_TIMEOUT_MS || "180000", 10),
    };
    for (const raw of process.argv.slice(2)) {
        if (raw === "--list") args.list = true;
        else if (raw.startsWith("--filter=")) args.filter = raw.slice("--filter=".length);
        else if (raw.startsWith("--limit=")) args.limit = parseInt(raw.slice("--limit=".length), 10);
        else if (raw.startsWith("--step-delay=")) args.stepDelaySec = parseFloat(raw.slice("--step-delay=".length));
        else if (raw.startsWith("--batch-size=")) args.batchSize = parseInt(raw.slice("--batch-size=".length), 10);
        else if (raw.startsWith("--batch-delay=")) args.batchDelaySec = parseFloat(raw.slice("--batch-delay=".length));
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

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function tail(text, lines = 8) {
    const trimmed = String(text || "").replace(/\s+$/u, "");
    if (!trimmed) return "";
    const parts = trimmed.split(/\r?\n/u);
    return parts.slice(-lines).join("\n");
}

function judgeStatus(file, exitCode, output) {
    const lower = String(output || "").toLowerCase();
    if (exitCode !== 0) {
        return RATE_LIMIT_KEYWORDS.some((kw) => lower.includes(kw)) ? "限流" : "异常退出";
    }
    if (RATE_LIMIT_KEYWORDS.some((kw) => lower.includes(kw))) return "限流";
    if (FAILURE_KEYWORDS.some((kw) => lower.includes(String(kw).toLowerCase()))) return "失败";
    return "成功";
}

async function runSingleScript(file, args, yybServer) {
    const scriptPath = path.join(WXAPP_DIR, file);
    const interpreter = INTERPRETER_BY_EXT[path.extname(file).toLowerCase()];
    const startedAt = Date.now();

    const result = spawnSync(interpreter, [scriptPath], {
        cwd: path.dirname(scriptPath),
        env: { ...process.env, YYB_SERVER: yybServer },
        encoding: "utf8",
        timeout: args.timeoutMs,
        maxBuffer: 32 * 1024 * 1024,
    });

    const combinedOutput =
        `${result.stdout || ""}\n${result.stderr || ""}`.trim();
    const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
    const status = judgeStatus(file, result.status ?? result.error ? result.error.code : 0, combinedOutput);

    console.log("\n" + "=".repeat(64));
    console.log(`▶ ${file}  [${status}]  耗时 ${elapsedSec}s`);
    console.log("-".repeat(64));
    console.log(tail(combinedOutput) || "(无输出)");
    console.log("=".repeat(64) + "\n");

    return { file, status, elapsedSec };
}

async function main() {
    const args = parseArgs();
    const yybServer = process.env.YYB_SERVER || DEFAULT_YYB_SERVER;

    let scripts = collectScripts();
    if (args.filter) scripts = scripts.filter((file) => file.includes(args.filter));
    if (args.list) {
        console.log(`可调用脚本共 ${scripts.length} 个：`);
        scripts.forEach((file, index) => console.log(`${index + 1}. ${file}`));
        return;
    }
    scripts = scripts.slice(0, args.limit);

    console.log(`YYB_SERVER  = ${yybServer}`);
    console.log(`脚本数量    = ${scripts.length}`);
    console.log(`步进休眠    = ${args.stepDelaySec}s / 每批 ${args.batchSize} 个 / 批次休眠 ${args.batchDelaySec}s`);
    console.log("开始分批调用……\n");

    const results = [];
    for (let index = 0; index < scripts.length; index++) {
        const file = scripts[index];
        const result = await runSingleScript(file, args, yybServer);
        results.push(result);

        const isLast = index === scripts.length - 1;
        if (isLast) break;

        const inBatchEnd = (index + 1) % args.batchSize === 0;
        const nextBatchRemaining = args.batchSize - ((index + 1) % args.batchSize);
        const waitSeconds = inBatchEnd ? args.batchDelaySec : args.stepDelaySec;
        const reason = inBatchEnd ? "批次间隔" : "单脚本间隔";
        console.log(`  (休眠 ${waitSeconds}s [${reason}]，剩余约 ${scripts.length - index - 1} 个 …)\n`);
        await sleep(waitSeconds * 1000);
    }

    const count = (predicate) => results.filter(predicate).length;
    console.log("\n" + "=".repeat(64));
    console.log("🔥 运行汇总");
    console.log("=".repeat(64));
    console.log(`成功      : ${count((r) => r.status === "成功")} 个`);
    console.log(`失败      : ${count((r) => r.status === "失败")} 个`);
    console.log(`限流      : ${count((r) => r.status === "限流")} 个`);
    console.log(`异常退出  : ${count((r) => r.status === "异常退出")} 个`);
    const trouble = results.filter((r) => r.status !== "成功");
    if (trouble.length) {
        console.log("\n存在问题(失败/限流/异常)：");
        trouble.forEach((r) => console.log(`  · ${r.file}  [${r.status}]`));
    }
    console.log("=".repeat(64));
}

main().catch((error) => {
    console.error("批量调用器执行出错：", error);
    process.exit(1);
});
