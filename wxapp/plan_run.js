/**
 * wxapp 分批运行器（plan 状态文件 + 429 自动重试）
 *
 * 背景：YYB /wx/code 接口有频率限制，连续调用会触发 429（或空 code 降级）。
 * 此运行器：
 *   1. 生成 plan 状态文件（wxapp/_run/plan.json + plan.md），跑完一个立即更新一个
 *   2. 一批默认 5 个，批间休眠；支持中断后按 plan 断点续跑（--reset 可强制重建）
 *   3. 失败的脚本在 plan 里记录原因
 *   4. 触发 429/限流的脚本等 10 分钟后重试；重试仍 429 则置回 pending 再等 10 分钟，
 *      循环直到该脚本跑出确定结果（成功/失败）为止
 *
 * 用法（仓库根目录执行）：
 *   node wxapp/plan_run.js                    # 全量跑（已有 plan 则断点续跑）
 *   node wxapp/plan_run.js --reset            # 重建 plan，从零开始
 *   node wxapp/plan_run.js --filter=tcl       # 只跑名字包含 tcl 的（改变 filter 会重建 plan）
 *   node wxapp/plan_run.js --file=a.txt       # 按文件列表跑（改变 file 会重建 plan）
 *
 * 可调参数：
 *   --batch-size=5      每批脚本数
 *   --step-delay=3      批内脚本间隔秒数
 *   --batch-delay=30    批次之间休眠秒数
 *   --retry-wait=600    触发 429 后等待重试的秒数（默认 10 分钟）
 *   --timeout=200000    单脚本超时毫秒
 *
 * 输出：
 *   wxapp/_run/plan.json   状态文件（断点续跑依据，机器可读）
 *   wxapp/_run/plan.md     进度报告（人类可读）
 *   wxapp/_run/logs/*.log  每脚本完整运行日志
 */
const { spawnSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const WXAPP_DIR = __dirname;
const RUN_DIR = path.join(WXAPP_DIR, "_run");
const LOGS_DIR = path.join(RUN_DIR, "logs");
const PLAN_JSON = path.join(RUN_DIR, "plan.json");
const PLAN_MD = path.join(RUN_DIR, "plan.md");
const DEFAULT_YYB_SERVER = "http://3.112.226.233:8000@1";

// 辅助/非业务脚本，不参与运行
const HELPER_FILES = new Set([
    "wcs.js",
    "yyb_helper.py",
    "batch_run.js",
    "run_all_report.js",
    "plan_run.js",
]);
const INTERPRETER = { ".js": "node", ".py": "python" };

// 判为失败的特征词（"未知"一词太宽泛：正常输出里"积分: 未知"会导致误判，故不收录）
const FAILURE_KEYWORDS = [
    "执行失败", "运行失败", "获取code失败", "获取code异常",
    "exception", "traceback", "error", "错误", "未配置",
    "❌", "failed", "reject", "挂科", "禁用",
];
// 429/限流特征词；空 code 是服务端限流降级，同样按限流处理走重试
const RATE_LIMIT_KEYWORDS = ["429", "too many request", "rate limit", "frequent"];
const EMPTY_CODE_KEYWORDS = ["取 code 为空", "code 为空"];

const STATUS_TEXT = {
    pending: "待运行",
    running: "运行中",
    success: "成功",
    failed: "失败",
    rate_limited: "限流待重试",
};
const STATUS_ORDER = ["success", "failed", "rate_limited", "running", "pending"];

function parseArgs() {
    const args = {
        filter: "",
        file: "",
        reset: false,
        batchSize: 5,
        stepDelaySec: 3,
        batchDelaySec: 30,
        retryWaitSec: 600,
        timeoutMs: 200000,
    };
    for (const raw of process.argv.slice(2)) {
        if (raw.startsWith("--filter=")) args.filter = raw.slice(9);
        else if (raw.startsWith("--file=")) args.file = raw.slice(7);
        else if (raw === "--reset") args.reset = true;
        else if (raw.startsWith("--batch-size=")) args.batchSize = parseInt(raw.slice(13), 10);
        else if (raw.startsWith("--step-delay=")) args.stepDelaySec = parseFloat(raw.slice(13));
        else if (raw.startsWith("--batch-delay=")) args.batchDelaySec = parseFloat(raw.slice(14));
        else if (raw.startsWith("--retry-wait=")) args.retryWaitSec = parseFloat(raw.slice(13));
        else if (raw.startsWith("--timeout=")) args.timeoutMs = parseInt(raw.slice(10), 10);
    }
    return args;
}

function collectScripts() {
    return fs.readdirSync(WXAPP_DIR)
        .filter((f) => INTERPRETER[path.extname(f).toLowerCase()])
        .filter((f) => !HELPER_FILES.has(f))
        .sort();
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadPlan() {
    try {
        if (fs.existsSync(PLAN_JSON)) return JSON.parse(fs.readFileSync(PLAN_JSON, "utf8"));
    } catch {}
    return null;
}

function createPlan(scripts, yybServer, args) {
    return {
        yybServer,
        filter: args.filter,
        file: args.file,
        batchSize: args.batchSize,
        retryWaitSec: args.retryWaitSec,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        scripts: scripts.map((name) => ({
            name,
            status: "pending",
            attempts: 0,
            lastRunAt: null,
            elapsedSec: null,
            exitCode: null,
            error: null,
        })),
    };
}

function countByStatus(plan) {
    const counts = { pending: 0, running: 0, success: 0, failed: 0, rate_limited: 0 };
    for (const entry of plan.scripts) counts[entry.status] = (counts[entry.status] || 0) + 1;
    return counts;
}

function writePlanMd(plan) {
    const counts = countByStatus(plan);
    const total = plan.scripts.length;
    const finished = counts.success + counts.failed;
    const lines = [];
    lines.push("# wxapp 分批运行 plan");
    lines.push("");
    lines.push(`- 创建时间: ${plan.createdAt}`);
    lines.push(`- 更新时间: ${plan.updatedAt}`);
    lines.push(`- YYB_SERVER: ${plan.yybServer}`);
    if (plan.filter) lines.push(`- 过滤条件: ${plan.filter}`);
    lines.push(`- 进度: **${finished}/${total}**（成功 ${counts.success}｜失败 ${counts.failed}｜限流待重试 ${counts.rate_limited}｜待运行 ${counts.pending}｜运行中 ${counts.running}）`);
    lines.push(`- 限流重试: 触发 429 后等待 ${Math.round(plan.retryWaitSec / 60)} 分钟重试，仍限流则置回 pending 继续等，直到跑出确定结果`);
    lines.push("");

    for (const status of STATUS_ORDER) {
        const group = plan.scripts.filter((s) => s.status === status);
        if (!group.length) continue;
        lines.push(`## ${STATUS_TEXT[status]} (${group.length})`);
        lines.push("");
        for (const entry of group) {
            const parts = [entry.name];
            if (entry.attempts > 1) parts.push(`尝试${entry.attempts}次`);
            if (entry.elapsedSec) parts.push(`${entry.elapsedSec}s`);
            if (entry.error) parts.push(`原因: ${entry.error}`);
            lines.push(`- ${parts.join(" ｜ ")}`);
        }
        lines.push("");
    }
    fs.writeFileSync(PLAN_MD, lines.join("\n"), "utf8");
}

function savePlan(plan) {
    plan.updatedAt = new Date().toISOString();
    fs.writeFileSync(PLAN_JSON, JSON.stringify(plan, null, 2));
    writePlanMd(plan);
}

function judge(exitCode, output) {
    const text = String(output || "");
    const lower = text.toLowerCase();
    // YYB 返回 code:0 + msg:"success" 时，空 code 表示账号未给该小程序授权（业务状态），
    // 接口调用本身成功且重试不会改变授权状态——此判定优先级最高（含脚本内部重试导致超时被杀的情况）
    if (EMPTY_CODE_KEYWORDS.some((k) => text.includes(k)) && /"msg"\s*:\s*"success"/i.test(text)) {
        return "success";
    }
    if (RATE_LIMIT_KEYWORDS.some((k) => lower.includes(String(k).toLowerCase()))) return "rate_limited";
    if (exitCode !== 0) return "failed";
    if (EMPTY_CODE_KEYWORDS.some((k) => text.includes(k))) return "rate_limited";
    if (FAILURE_KEYWORDS.some((k) => lower.includes(String(k).toLowerCase()))) return "failed";
    return "success";
}

// 从输出中提取最能代表失败原因的一行（含失败关键词的最后一行，否则取最后一行）
function extractReason(output) {
    const lines = String(output || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (!lines.length) return "";
    const errorLine = [...lines].reverse().find((l) =>
        [...FAILURE_KEYWORDS, ...RATE_LIMIT_KEYWORDS].some((k) => l.toLowerCase().includes(String(k).toLowerCase()))
    );
    return (errorLine || lines[lines.length - 1]).replace(/\s+/g, " ").slice(0, 120);
}

function runScript(entry, args, yybServer) {
    const scriptPath = path.join(WXAPP_DIR, entry.name);
    const interpreter = INTERPRETER[path.extname(entry.name).toLowerCase()];
    const startedAt = Date.now();
    const result = spawnSync(interpreter, [scriptPath], {
        cwd: path.dirname(scriptPath),
        env: { ...process.env, YYB_SERVER: yybServer },
        encoding: "utf8",
        timeout: args.timeoutMs,
        maxBuffer: 128 * 1024 * 1024,
    });
    const combined = `${result.stdout || ""}\n${result.stderr || ""}`.trim();
    const exitCode = result.status ?? (result.error ? result.error.code : -1);
    const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);

    fs.writeFileSync(
        path.join(LOGS_DIR, `${entry.name}.log`),
        `# ${entry.name}  [attempt ${entry.attempts + 1}]  exit=${exitCode}  ${elapsedSec}s\n${combined}\n`
    );
    return { exitCode, elapsedSec, output: combined };
}

// 长等待时每分钟打一次心跳，方便确认进程还活着
async function sleepWithHeartbeat(totalMs) {
    const stepMs = 60 * 1000;
    let waited = 0;
    while (waited < totalMs) {
        const ms = Math.min(stepMs, totalMs - waited);
        await sleep(ms);
        waited += ms;
        const remainMin = ((totalMs - waited) / 60000).toFixed(1);
        console.log(`  ⏳ 限流等待中... 剩余 ${remainMin} 分钟  (${new Date().toLocaleTimeString()})`);
    }
}

async function main() {
    const args = parseArgs();
    const yybServer = process.env.YYB_SERVER || DEFAULT_YYB_SERVER;
    fs.mkdirSync(LOGS_DIR, { recursive: true });

    let scripts = collectScripts();
    if (args.file) {
        scripts = fs.readFileSync(args.file, "utf8").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    }
    if (args.filter) scripts = scripts.filter((f) => f.includes(args.filter));

    // plan 复用规则：无 plan / --reset / 过滤条件变化 时重建；否则断点续跑
    const existingPlan = loadPlan();
    const filterChanged = existingPlan && (existingPlan.filter !== args.filter || existingPlan.file !== args.file);
    let plan;
    if (existingPlan && !args.reset && !filterChanged) {
        plan = existingPlan;
        // 上次中断遗留的 running/rate_limited 状态重置为 pending（rate_limited 是等待重试的中间态）
        let resumed = 0;
        for (const entry of plan.scripts) {
            if (entry.status === "running" || entry.status === "rate_limited") {
                entry.status = "pending";
                resumed += 1;
            }
        }
        plan.yybServer = yybServer;
        console.log(`复用已有 plan：${plan.scripts.length} 个脚本，断点续跑${resumed ? `（重置 ${resumed} 个运行中状态）` : ""}`);
    } else {
        plan = createPlan(scripts, yybServer, args);
        console.log(filterChanged ? "过滤条件与 plan 不一致，重建 plan" : "创建新 plan");
    }
    savePlan(plan);

    const counts = countByStatus(plan);
    console.log(`YYB_SERVER = ${yybServer}`);
    console.log(`脚本总数   = ${plan.scripts.length}（待跑 ${counts.pending}，已完成 ${counts.success + counts.failed}）`);
    console.log(`批次       = 每批 ${args.batchSize} 个，批内间隔 ${args.stepDelaySec}s，批间休眠 ${args.batchDelaySec}s`);
    console.log(`限流策略   = 429 后等 ${Math.round(args.retryWaitSec / 60)} 分钟重试，仍限流则置回 pending 再等，直到跑完`);
    console.log(`状态文件   = ${PLAN_JSON}`);
    console.log("");

    while (true) {
        const pending = plan.scripts.filter((s) => s.status === "pending");
        if (!pending.length) break;

        const batch = pending.slice(0, args.batchSize);
        const countsNow = countByStatus(plan);
        const finishedNow = countsNow.success + countsNow.failed;
        console.log(`${"=".repeat(64)}`);
        console.log(`▶▶ 本批 ${batch.length} 个（总进度 ${finishedNow}/${plan.scripts.length}）: ${batch.map((s) => s.name).join(", ")}`);
        console.log(`${"=".repeat(64)}`);

        const rateLimitedEntries = [];
        for (let i = 0; i < batch.length; i++) {
            const entry = batch[i];
            entry.status = "running";
            savePlan(plan);
            console.log(`  ▶ ${entry.name} 开始执行 (第 ${entry.attempts + 1} 次尝试)...`);

            const { exitCode, elapsedSec, output } = runScript(entry, args, yybServer);
            entry.attempts += 1;
            entry.lastRunAt = new Date().toISOString();
            entry.exitCode = exitCode;
            entry.elapsedSec = elapsedSec;

            const verdict = judge(exitCode, output);
            if (verdict === "rate_limited") {
                entry.status = "rate_limited";
                entry.error = extractReason(output) || "触发 429/限流";
                rateLimitedEntries.push(entry);
            } else if (verdict === "success") {
                entry.status = "success";
                entry.error = null;
            } else {
                entry.status = "failed";
                entry.error = extractReason(output) || `exit=${exitCode}`;
            }
            savePlan(plan);
            console.log(`    ${entry.name} -> ${STATUS_TEXT[entry.status]}  ${elapsedSec}s${entry.error ? `  ｜ ${entry.error}` : ""}`);

            if (i < batch.length - 1 && args.stepDelaySec > 0) await sleep(args.stepDelaySec * 1000);
        }

        if (rateLimitedEntries.length) {
            console.log(`\n  ⏳ 本批 ${rateLimitedEntries.length} 个触发限流: ${rateLimitedEntries.map((s) => s.name).join(", ")}`);
            console.log(`  ⏳ 等待 ${Math.round(args.retryWaitSec / 60)} 分钟后重试...`);
            await sleepWithHeartbeat(args.retryWaitSec * 1000);
            for (const entry of rateLimitedEntries) {
                entry.status = "pending";
                savePlan(plan);
            }
            console.log(`  ↩ 已将 ${rateLimitedEntries.length} 个限流脚本置回待运行，进入重试`);
            continue;
        }

        const remaining = plan.scripts.filter((s) => s.status === "pending" || s.status === "rate_limited").length;
        if (remaining > 0 && args.batchDelaySec > 0) {
            console.log(`  (批间休眠 ${args.batchDelaySec}s，剩余 ${remaining} 个待跑)\n`);
            await sleep(args.batchDelaySec * 1000);
        }
    }

    savePlan(plan);
    const finalCounts = countByStatus(plan);
    console.log("\n" + "=".repeat(64));
    console.log("🔥 全部运行完成");
    console.log("=".repeat(64));
    console.log(`成功        : ${finalCounts.success}`);
    console.log(`失败        : ${finalCounts.failed}`);
    console.log(`限流待重试  : ${finalCounts.rate_limited}`);
    console.log(`详情见      : ${PLAN_MD}`);
    console.log("=".repeat(64));
}

main().catch((error) => {
    console.error("plan 运行器执行出错：", error);
    process.exit(1);
});
