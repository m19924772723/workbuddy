// push-daily.mjs — 每日 AI 效率日报生成与三平台推送
// 数据源: D:\code\workbuddy\workbench\data\activities.json（个人工作台活动日志）
// 用法: node push-daily.mjs [--date YYYY-MM-DD] [--no-push]
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const ROOT = 'D:/code/workbuddy/git-daily';
const ACTIVITIES = 'D:/code/workbuddy/workbench/data/activities.json';
const GIT = 'D:/code/environment/PortableGit-2.55.0.5/cmd/git.exe';

const args = process.argv.slice(2);
const noPush = args.includes('--no-push');
const withBackfill = args.includes('--backfill');
const dateArg = args.includes('--date') ? args[args.indexOf('--date') + 1] : null;
const LOOKBACK = 14; // 补录时回溯的天数上限

// 本地日期（Asia/Shanghai，本机时区即 GMT+8）
function todayStr() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
const targetDate = dateArg || todayStr();

function loadActivities() {
  if (!existsSync(ACTIVITIES)) return [];
  try { return JSON.parse(readFileSync(ACTIVITIES, 'utf8')); } catch { return []; }
}

function localDayOf(isoUtc) {
  const d = new Date(isoUtc);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function localTimeOf(isoUtc) {
  const d = new Date(isoUtc);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const KIND_LABEL = { task: '任务', build: '构建', note: '笔记', fix: '修复' };

function buildDailyMd(date, items) {
  const lines = [];
  lines.push(`# AI 效率日报 — ${date}`);
  lines.push('');
  if (items.length === 0) {
    lines.push('> 今日工作台暂无活动记录。');
    lines.push('');
  } else {
    lines.push(`> 今日共 **${items.length}** 项活动，由 WorkBuddy AI 辅助完成。`);
    lines.push('');
    items.forEach((it, i) => {
      const t = localTimeOf(it.at);
      const kind = KIND_LABEL[it.kind] || it.kind || '';
      const tags = (it.tags || []).map((x) => `\`${x}\``).join(' ');
      lines.push(`## ${i + 1}. ${it.what}`);
      lines.push('');
      lines.push(`- 时间：${t}　类型：${kind}${tags ? `　标签：${tags}` : ''}`);
      if (it.desc) { lines.push(`- 说明：${it.desc}`); }
      lines.push('');
    });
  }
  lines.push('---');
  lines.push('');
  lines.push('*本文由 [workbuddy](https://github.com/m19924772723/workbuddy) 每日流水线自动生成，内容来自个人工作台活动日志。*');
  lines.push('');
  return lines.join('\n');
}

function buildReadme(dailyDir) {
  const files = readdirSync(dailyDir).filter((f) => f.endsWith('.md')).sort().reverse();
  const total = files.length;
  const lines = [];
  lines.push('# workbuddy — AI 效率日报');
  lines.push('');
  lines.push('每天自动推送当日的 AI 工作日志到本仓库（GitHub / Gitee / AtomGit 三平台同步）。');
  lines.push('');
  lines.push(`**已连续记录 ${total} 天**`);
  lines.push('');
  lines.push('## 日报索引');
  lines.push('');
  files.slice(0, 30).forEach((f) => {
    const d = f.replace('.md', '');
    lines.push(`- [${d} 日报](daily/${f})`);
  });
  if (total > 30) lines.push(`- …（共 ${total} 篇，见 daily/ 目录）`);
  lines.push('');
  lines.push('## 数据来源');
  lines.push('');
  lines.push('内容来自本地「个人工作台」活动日志（WorkBuddy AI 完成任务后自动登记），由 `push-daily.mjs` 每日生成，非人工撰写。');
  lines.push('');
  return lines.join('\n');
}

// ---- 生成内容 ----
const dailyDir = path.join(ROOT, 'daily');
mkdirSync(dailyDir, { recursive: true });

const activities = loadActivities();

// ---- 缺口补录（--backfill）：把「当天有活动但缺日报」的日子补齐，保证贡献图连续 ----
// 只补真实有活动的日子，不为了绿点刷空日报；commit 日期回填为当天 21:30
let backfilled = [];
if (withBackfill) {
  const active = new Set(activities.map((a) => (a.at || '').slice(0, 10)).filter(Boolean));
  for (let i = LOOKBACK; i >= 1; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const pad = (n) => String(n).padStart(2, '0');
    const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    if (!active.has(day)) continue;                                   // 当天无活动，跳过
    if (existsSync(path.join(dailyDir, `${day}.md`))) continue;       // 已有日报，跳过

    const dayItems = activities
      .filter((a) => localDayOf(a.at) === day)
      .sort((a, b) => new Date(a.at) - new Date(b.at));
    writeFileSync(path.join(dailyDir, `${day}.md`), buildDailyMd(day, dayItems), 'utf8');
    writeFileSync(path.join(ROOT, 'README.md'), buildReadme(dailyDir), 'utf8');
    git('add', '-A');
    if (git('status', '--porcelain').trim()) {
      gitDated(`${day}T21:30:00+08:00`, 'commit', '-m', `daily: ${day} AI 效率日报（${dayItems.length} 条活动）`);
      backfilled.push(`${day}(${dayItems.length}条)`);
    }
  }
  if (backfilled.length) console.log(`补录 ${backfilled.length} 天：${backfilled.join(', ')}`);
}

const items = activities
  .filter((a) => localDayOf(a.at) === targetDate)
  .sort((a, b) => new Date(a.at) - new Date(b.at));

writeFileSync(path.join(dailyDir, `${targetDate}.md`), buildDailyMd(targetDate, items), 'utf8');
writeFileSync(path.join(ROOT, 'README.md'), buildReadme(dailyDir), 'utf8');
console.log(`生成日报 ${targetDate}，含 ${items.length} 条活动`);

// ---- git 提交与推送 ----
function git(...gitArgs) {
  return execFileSync(GIT, gitArgs, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
function gitDated(stamp, ...gitArgs) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_AUTHOR_DATE: stamp, GIT_COMMITTER_DATE: stamp };
  return execFileSync(GIT, gitArgs, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env });
}

let committed = false;
git('add', '-A');
const status = git('status', '--porcelain');
if (status.trim()) {
  git('commit', '-m', `daily: ${targetDate} AI 效率日报（${items.length} 条活动）`);
  committed = true;
  console.log('已提交');
} else {
  console.log('无内容变化，跳过提交');
}

const results = [];
if (noPush) {
  results.push('跳过推送（--no-push）');
} else if (committed) {
  const remotes = git('remote').trim().split('\n').filter(Boolean);
  for (const r of remotes) {
    try {
      git('push', r, 'HEAD:main');
      results.push(`${r}: 推送成功`);
    } catch (e) {
      const msg = (e.stderr || e.message || '').toString().replace(/https?:\/\/[^@\s]+@/g, 'https://***@');
      results.push(`${r}: 推送失败 — ${msg.split('\n').slice(0, 3).join(' | ')}`);
    }
  }
} else {
  results.push('无提交，跳过推送');
}
const bfPart = backfilled.length ? ` backfilled=[${backfilled.join(',')}]` : '';
const logLine = `[${new Date().toISOString()}] ${targetDate} items=${items.length} committed=${committed}${bfPart} | ${results.join(' | ')}`;
writeFileSync(path.join(ROOT, 'push.log'), (existsSync(path.join(ROOT, 'push.log')) ? readFileSync(path.join(ROOT, 'push.log'), 'utf8') : '') + logLine + '\n', 'utf8');
console.log(results.join('\n'));
