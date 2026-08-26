/**
 * wxapp 全套脚本批量运行 + 分类报告
 *
 * 逐个调用 wxapp/ 下的业务脚本(.js/.py)，每两个脚本之间间隔若干秒，规避
 * YYB 服务端 /wx/code 接口的 429 限流。完整输出写入 wxapp/_run/ 目录。
 *
 * 用法（仓库根目录执行）：
 *   node wxapp/run_all_report.js
 *   node wxapp/run_all_report.js --filter=tcl     # 只跑名字包含 tcl 的
 *   node wxapp/run_all_report.js --limit=10       # 只跑前 10 个
 *
 * 输出：
 *   wxapp/_run/logs/<script>.log           每个脚本完整运行日志
 *   wxapp/_run/result.json                 全部脚本状态 + 输出摘要
 */
const { spawnSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const WXAPP_DIR = __dirname;
const RUN_DIR = path.join(WXAPP_DIR, "_run");
const LOGS_DIR = path.join(RUN_DIR, "logs");
const DEFAULT_YYB_SERVER = "http://3.112.226.233:8000@1";
const INTERVAL_SEC = parseFloat(process.env.INTERVAL_SEC || "4");

// 辅助/非业务脚本，不参与运行
const HELPER_FILES = new Set([
  "wcs.js",
  "yyb_helper.py",
  "batch_run.js",
  "run_all_report.js",
]);
const INTERPRETER = { ".js": "node", ".py": "python" };

// 判为成功必须不含以下失败特征词
const FAILURE_KEYWORDS = [
  "执行失败", "运行失败", "获取code失败", "获取code异常",
  "exception", "traceback", "error", "错误", "未知", "未配置",
  "❌", "failed", "reject", "挂科", "禁用",
];
const RATE_LIMIT_KEYWORDS = ["429", "too many request", "rate limit", "frequent"];
// YYB 服务端并发过高时会返回 code:"" 的空 envelope（取 code 为空），同样视为限流类
const EMPTY_CODE_KEYWORDS = ["取 code 为空", "code 为空"];

function parseArgs() {
  const a = { filter: "", limit: Infinity, start: 0, timeoutMs: 200000, intervalSec: INTERVAL_SEC, file: "" };
  for (const raw of process.argv.slice(2)) {
    if (raw.startsWith("--filter=")) a.filter = raw.slice(9);
    else if (raw.startsWith("--limit=")) a.limit = parseInt(raw.slice(8), 10);
    else if (raw.startsWith("--start=")) a.start = parseInt(raw.slice(8), 10);
    else if (raw.startsWith("--timeout=")) a.timeoutMs = parseInt(raw.slice(10), 10);
    else if (raw.startsWith("--file=")) a.file = raw.slice(7);
  }
  return a;
}

function collectScripts() {
  return fs.readdirSync(WXAPP_DIR)
    .filter((f) => INTERPRETER[path.extname(f).toLowerCase()])
    .filter((f) => !HELPER_FILES.has(f))
    .sort();
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function tail(text, lines = 40) {
  const t = String(text || "").replace(/\s+$/u, "");
  return t.split(/\r?\n/u).slice(-lines).join("\n");
}

function judgeStatus(file, exitCode, output) {
  const lower = String(output || "").toLowerCase();
  if (exitCode !== 0) {
    return RATE_LIMIT_KEYWORDS.some((k) => lower.includes(k)) ? "限流" : "异常退出";
  }
  if (RATE_LIMIT_KEYWORDS.some((k) => lower.includes(k)) || EMPTY_CODE_KEYWORDS.some((k) => lower.includes(k))) return "限流";
  if (FAILURE_KEYWORDS.some((k) => lower.includes(k.toLowerCase()))) return "失败";
  return "成功";
}

async function main() {
  const args = parseArgs();
  const yybServer = process.env.YYB_SERVER || DEFAULT_YYB_SERVER;
  fs.mkdirSync(LOGS_DIR, { recursive: true });

  let scripts = collectScripts();
  if (args.file) {
    scripts = fs.readFileSync(args.file, "utf-8").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  }
  if (args.filter) scripts = scripts.filter((f) => f.includes(args.filter));
  scripts = scripts.slice(args.start, args.start + args.limit);
  console.log(`YYB_SERVER = ${yybServer}\n脚本区间   = [${args.start}+${args.limit})\n间隔       = ${args.intervalSec}s\n`);

  const results = [];
  for (let i = 0; i < scripts.length; i++) {
    const file = scripts[i];
    const scriptPath = path.join(WXAPP_DIR, file);
    const started = Date.now();
    const r = spawnSync(INTERPRETER[path.extname(file).toLowerCase()], [scriptPath], {
      cwd: path.dirname(scriptPath),
      env: { ...process.env, YYB_SERVER: yybServer },
      encoding: "utf8",
      timeout: args.timeoutMs,
      maxBuffer: 128 * 1024 * 1024,
    });
    const combined = `${r.stdout || ""}\n${r.stderr || ""}`.trim();
    const exitCode = r.status ?? (r.error ? r.error.code : -1);
    const status = judgeStatus(file, exitCode, combined);
    const elapsed = ((Date.now() - started) / 1000).toFixed(1);

    fs.writeFileSync(path.join(LOGS_DIR, `${file}.log`), `# ${file}  [${status}] ${elapsed}s  exit=${exitCode}\n${combined}\n`);
    const obj = { file, status, exitCode, elapsedSec: elapsed, tail: tail(combined, 30) };
    results.push(obj);
    console.log(`[${(i + 1).toString().padStart(3)}/${scripts.length}] ${file.padEnd(28)} -> ${status.padEnd(4)} ${elapsed}s`);

    if (i < scripts.length - 1) await sleep(args.intervalSec * 1000);
  }

  fs.writeFileSync(path.join(RUN_DIR, "result.json"), JSON.stringify(results, null, 2));

  const cnt = (p) => results.filter(p).length;
  console.log("\n" + "=".repeat(60));
  console.log(`成功: ${cnt((r) => r.status === "成功")}`);
  console.log(`失败: ${cnt((r) => r.status === "失败")}`);
  console.log(`限流: ${cnt((r) => r.status === "限流")}`);
  console.log(`异常: ${cnt((r) => r.status === "异常退出")}`);
  console.log("=".repeat(60));
}

main().catch((e) => { console.error(e); process.exit(1); });