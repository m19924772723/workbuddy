// push-all.mjs — 每日 git 推送的唯一入口（配置驱动）
//
// 设计目标（2026-09-26 用户要求）：「每天只有一个定时任务，git 推送归于一种脚本」
//   · 系统侧只保留 Windows 计划任务 WorkBuddy-DailyPush（每天 21:30）→ 只调本文件
//   · 所有需要每日推送的仓库都在 push-targets.json 里登记，本文件按序串行执行
//   · 新增仓库 = 配置文件加一条 unit，绝不再新建第二个计划任务
//
// 特性：
//   · 单元互不阻断：某个单元失败/超时，后面照跑
//   · 每单元独立超时（spawnSync timeout），不会有脚本挂死拖垮整晚
//   · 所有输出落盘前统一脱敏（token / URL 内嵌凭据 / ssh 目标）
//   · 汇总写三处：unified-push.log（详细）、auto-run.log（一行）、daily-log.md（一行）
import { spawnSync } from 'node:child_process';
import { readFileSync, appendFileSync, existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = 'D:/code/workbuddy/git-daily';
const NODE = 'C:\\Users\\1\\.workbuddy\\binaries\\node\\versions\\22.22.2-3\\node.exe';
const CFG = path.join(ROOT, 'push-targets.json');
const DETAIL_LOG = path.join(ROOT, 'unified-push.log');
const RUN_LOG = path.join(ROOT, 'auto-run.log');
const PUSH_LOG = path.join(ROOT, 'push.log');

const pad = (n) => String(n).padStart(2, '0');
const now = new Date();
const stampDate = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
const stampTime = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
const stamp = `${stampDate} ${stampTime}`;

// ---- 脱敏：任何写进日志的文本都过一遍，杜绝令牌泄漏 ----
const mask = (s) =>
  String(s == null ? '' : s)
    .replace(/(ghp_|github_pat_|oauth2:|token=)[A-Za-z0-9_-]+/g, '$1***')
    .replace(/https?:\/\/[^@\s/]+@/g, 'https://***@')
    .replace(/ssh:\/\/[^\s]+/g, 'ssh://***');

// ---- 从 node 单元（push-daily.mjs）的 push.log 末行提取结果 ----
function summaryFromPushLog() {
  let last = '';
  try {
    const raw = readFileSync(PUSH_LOG, 'utf8').trim();
    const lines = raw.split('\n').filter(Boolean);
    last = lines[lines.length - 1] || '';
  } catch {
    return '未读到 push.log';
  }
  // 本次没产生新记录时 push.log 末行可能是上一天的，用日期对一下
  if (!last.includes(`[${now.toISOString().slice(0, 10)}`) && !last.includes(stampDate)) {
    // push.log 里写的是 ISO 时间戳，跨日时容错：仍尝试解析，但标注
  }
  const items = (last.match(/items=(\d+)/) || [])[1];
  const map = { origin: 'GitHub', gitee: 'Gitee', atomgit: 'AtomGit' };
  const parts = [];
  for (const [k, label] of Object.entries(map)) {
    const mm = last.match(new RegExp(k + ':\\s*([^|]+)'));
    if (!mm) {
      parts.push(`${label} 未运行`);
      continue;
    }
    const st = mm[1].trim();
    if (st.includes('成功')) parts.push(`${label} 成功`);
    else if (st.includes('失败')) parts.push(`${label} 失败`);
    else parts.push(`${label} ${st}`);
  }
  const bfRaw = last.match(/backfilled=\[([^\]]*)\]/);
  const bfPart = bfRaw ? `补录${bfRaw[1].split(',').filter(Boolean).length}天 ` : '';
  return `${bfPart}活动${items ?? '?'}条，` + parts.join(' / ');
}

// ---- 从 bash 单元（hermes daily.sh）的 stdout 提取推送结果 ----
function summaryFromBash(out) {
  const lines = out.split('\n').map((l) => l.trim()).filter(Boolean);
  const hits = lines.filter((l) =>
    /^(push|gitee|atomgit):|myblog:|profile|daily:|ai_pm|无改动|未配置 remote|完成 ✅/.test(l)
  );
  if (!hits.length) {
    return lines.length ? lines.slice(-2).join(' ｜ ') : '无输出';
  }
  return hits.slice(-8).join(' ｜ ');
}

// ---- 执行一个单元 ----
function runUnit(u) {
  const started = Date.now();
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  let r;
  if (u.type === 'node') {
    const file = path.isAbsolute(u.file) ? u.file : path.join(u.cwd || ROOT, u.file);
    r = spawnSync(NODE, [file, ...(u.args || [])], {
      cwd: u.cwd || ROOT,
      env,
      encoding: 'utf8',
      timeout: u.timeoutMs || 300000,
      maxBuffer: 12 * 1024 * 1024,
    });
  } else if (u.type === 'bash') {
    r = spawnSync(u.bash, ['-l', u.script], {
      cwd: u.cwd || ROOT,
      env,
      encoding: 'utf8',
      timeout: u.timeoutMs || 600000,
      maxBuffer: 12 * 1024 * 1024,
    });
  } else {
    return { ok: false, summary: `未知单元类型 ${u.type}`, detail: '', ms: 0 };
  }

  const ms = Date.now() - started;
  const err = r.error ? `${r.error.code || ''} ${r.error.message || ''}`.trim() : '';
  const timedOut = err.includes('ETIMEDOUT') || err.includes('SIGTERM');
  const rc = timedOut ? 'TIMEOUT' : (r.status ?? 'ERR');
  const ok = rc === 0;

  const stdout = mask(r.stdout || '');
  const stderr = mask(r.stderr || '').split('\n').slice(-6).join('\n');

  let summary;
  if (!ok) {
    summary = `失败(rc=${rc}) ${err || stderr.split('\n').filter(Boolean).slice(-1)[0] || ''}`.trim();
  } else if (u.type === 'node') {
    summary = summaryFromPushLog();
  } else {
    summary = summaryFromBash(stdout);
  }

  const detail = [
    `--- ${u.id} [${u.name}] rc=${rc} ${(ms / 1000).toFixed(1)}s`,
    stdout.trim() ? `stdout(tail): ${stdout.trim().split('\n').slice(-12).join('\n  ')}` : 'stdout: (空)',
    stderr.trim() ? `stderr(tail6): ${stderr.trim()}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  return { ok, summary, detail, ms, rc };
}

function main() {
  let cfg;
  try {
    cfg = JSON.parse(readFileSync(CFG, 'utf8'));
  } catch (e) {
    const msg = `[${stamp}] 配置读取失败：${e.message}`;
    appendFileSync(RUN_LOG, msg + '\n', 'utf8');
    console.error(msg);
    process.exit(1);
  }

  const units = (cfg.units || []).filter((u) => u.enabled !== false);
  const detailLines = [`===== ${stamp} 每日统一推送 =====`];
  const results = [];

  for (const u of units) {
    let res;
    try {
      res = runUnit(u);
    } catch (e) {
      res = { ok: false, summary: `异常：${e.message}`, detail: `--- ${u.id} 抛出异常 ${e.message}`, ms: 0, rc: 'EX' };
    }
    results.push({ u, res });
    detailLines.push(res.detail);
    detailLines.push(`>>> ${u.id}: ${res.ok ? 'OK' : 'FAIL'} — ${mask(res.summary)}`);
  }

  const allOk = results.every((x) => x.res.ok);
  const oneLine =
    `${results.map((x) => `${x.u.name}: ${x.res.ok ? 'OK' : 'FAIL'}`).join('；')}` +
    ` ｜ ${results.map((x) => `${x.u.id}=${mask(x.res.summary)}`).join(' ｜ ')}`;

  detailLines.push(`===== 汇总: ${allOk ? '全部成功' : '有失败项'} =====`);
  appendFileSync(DETAIL_LOG, detailLines.join('\n') + '\n\n', 'utf8');
  appendFileSync(RUN_LOG, `[${stamp}] push-all ${allOk ? 'rc=0' : 'rc=1'} | ${oneLine}\n`, 'utf8');

  const dailyLog = cfg.dailyLog;
  if (dailyLog) {
    try {
      appendFileSync(dailyLog, `${stamp} ｜ 每日统一推送(1个任务) ｜ ${oneLine}\n`, 'utf8');
    } catch (e) {
      detailLines.push(`daily-log 写入失败：${e.message}`);
    }
  }

  console.log(`[${stamp}] ${allOk ? 'OK' : 'FAIL'} | ${oneLine}`);
  process.exit(allOk ? 0 : 1);
}

main();
