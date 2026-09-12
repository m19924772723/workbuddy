// backfill-daily.mjs — 日报缺口补录（保证 GitHub 贡献图每天有绿点）
// 背景：若某天计划任务没触发（关机/未登录/网络失败），当天就不会有 commit → 贡献图断档。
// 作用：扫描最近 LOOKBACK 天内缺哪天的日报，用当天**真实存在的活动记录**补生成，
//       commit 的 author/committer date 回填为当天 21:30（内容真实，不是伪造活动）。
// 通常由 run-push.mjs 在每日推送前自动调用；也可手动跑：node backfill-daily.mjs
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const NODE = 'C:\\Users\\1\\.workbuddy\\binaries\\node\\versions\\22.22.2-3\\node.exe';
const GIT = 'D:\\code\\environment\\PortableGit-2.55.0.5\\cmd\\git.exe';
const ROOT = 'D:/code/workbuddy/git-daily';
const PUSH = path.join(ROOT, 'push-daily.mjs');
const ACTIVITIES = 'D:/code/workbuddy/workbench/data/activities.json';
const LOOKBACK = 14; // 只回溯最近 14 天，避免把远古未工作的日子也补上

const pad = (n) => String(n).padStart(2, '0');
const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

// 只补「当天确实有活动记录」的日子：既还原事实，也避免为了绿点刷一堆空日报
function activeDays() {
  const set = new Set();
  if (!existsSync(ACTIVITIES)) return set;
  try {
    const arr = JSON.parse(readFileSync(ACTIVITIES, 'utf8'));
    for (const a of arr) if (a && a.at) set.add(a.at.slice(0, 10));
  } catch {}
  return set;
}

function missingDays() {
  const today = new Date();
  const active = activeDays();
  const first = new Date(Math.min(...[...active].map((s) => new Date(s + 'T00:00:00').getTime())));
  const miss = [];
  for (let i = LOOKBACK; i >= 1; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const day = fmt(d);
    if (d < first) continue;            // 早于第一条活动记录，跳过
    if (!active.has(day)) continue;     // 当天没活动，不刷空提交
    if (!existsSync(path.join(ROOT, 'daily', `${day}.md`))) miss.push(day);
  }
  return miss;
}

function sh(cmd, args, opts = {}) {
  // Windows 上 spawnSync 偶发 EBUSY（尤其在计划任务上下文连续拉起进程时），重试几次即可
  const baseEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0', ...(opts.env || {}) };
  let last = { rc: 1, out: '' };
  for (let attempt = 1; attempt <= 4; attempt++) {
    const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', env: baseEnv });
    if (r.error) {
      last = { rc: 1, out: `spawn error: ${r.error.message}` };
      sleepSync(800);
      continue;
    }
    last = { rc: r.status ?? 1, out: ((r.stdout || '') + (r.stderr || '')).trim() };
    if (last.rc === 0) return last;
    sleepSync(800);
  }
  return last;
}

function sleepSync(ms) {
  // 同步等待（Node 无内置 sleep；用 Atomics.wait）
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function backfill(day) {
  // 1) 生成当天日报（push-daily 内部会 add + commit，日期是「现在」）
  const gen = sh(NODE, [PUSH, '--date', day, '--no-push']);
  if (gen.rc !== 0) return `生成失败(${gen.rc}): ${gen.out.slice(0, 120)}`;

  // 2) 把这次 commit 的作者/提交者日期回填到当天 21:30
  const stamp = `${day}T21:30:00+08:00`;
  const env = { GIT_AUTHOR_DATE: stamp, GIT_COMMITTER_DATE: stamp };
  const amend = sh(GIT, ['commit', '--amend', '--no-edit', '--date', stamp], { env });
  if (amend.rc !== 0) return `回填日期失败(${amend.rc}): ${amend.out.slice(0, 120)}`;
  return null;
}

function main() {
  const miss = missingDays();
  if (miss.length === 0) return '无缺口，跳过补录';

  const done = [];
  const failed = [];
  for (const day of miss) {
    const err = backfill(day);
    if (err) { failed.push(`${day}: ${err}`); break; } // 出错即停，避免连续 amend 串味
    done.push(day);
  }
  const parts = [];
  if (done.length) parts.push(`已补录 ${done.length} 天（${done.join(', ')}），日期已回填为当天 21:30`);
  if (failed.length) parts.push(`失败：${failed.join(' ; ')}`);
  return parts.join(' | ');
}

const msg = main();
console.log(`[backfill] ${msg}`);
