// run-push.mjs — 【已并入 push-all.mjs，计划任务不再调用本文件（2026-09-26）】
// 保留用途：只想单独补一份 workbuddy 日报时手动跑 node run-push.mjs。
// 每日统一入口是 push-all.mjs（配置见 push-targets.json），它按顺序跑所有推送单元。
//
// 原职责：跑 push-daily.mjs → 解析 push.log → 把一行摘要追加到 daily-log.md（UTF-8 无 BOM）
import { spawnSync } from 'node:child_process';
import { readFileSync, appendFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const NODE = 'C:\\Users\\1\\.workbuddy\\binaries\\node\\versions\\22.22.2-3\\node.exe';
const ROOT = 'D:/code/workbuddy/git-daily';
const PUSH = path.join(ROOT, 'push-daily.mjs');
const PUSHLOG = path.join(ROOT, 'push.log');
const DAILYLOG = 'D:/code/workbuddy/.workbuddy/memory/automations/e08d34ac-4596-4385-8939-482d4ed9e72c/daily-log.md';

const now = new Date();
const pad = (n) => String(n).padStart(2, '0');
const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;

function main() {
  // GIT_TERMINAL_PROMPT=0：非交互环境禁止 git 弹出凭据询问，避免计划任务卡死
  // --backfill：先补齐历史缺口（某天计划任务没跑成时那天就没有 commit）
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  const r = spawnSync(NODE, [PUSH, '--backfill'], { cwd: ROOT, encoding: 'utf8', env });
  const rc = r.status ?? 1;

  let last = '';
  try {
    const raw = readFileSync(PUSHLOG, 'utf8').trim();
    const lines = raw.split('\n');
    last = lines[lines.length - 1] || '';
  } catch {}

  let items = 0;
  const m = last.match(/items=(\d+)/);
  if (m) items = +m[1];

  const map = { origin: 'GitHub', gitee: 'Gitee', atomgit: 'AtomGit' };
  const parts = [];
  for (const [k, label] of Object.entries(map)) {
    const mm = last.match(new RegExp(k + ':\\s*([^|]+)'));
    if (mm) {
      const st = mm[1].trim();
      if (st.includes('成功')) parts.push(`${label} 成功`);
      else if (st.includes('失败')) parts.push(`${label} 失败`);
      else parts.push(`${label} ${st}`);
    } else {
      parts.push(`${label} 未运行`);
    }
  }
  const summary = `活动${items}条，` + parts.join(' / ');
  // 若本次补录了历史缺口，从 push.log 里取出补录清单一起写进摘要
  const bfRaw = last.match(/backfilled=\[([^\]]*)\]/);
  const bfPart = bfRaw ? `补录${bfRaw[1].split(',').length}天(${bfRaw[1]}) ` : '';
  const line = `${stamp} ｜ AI效率日报三平台推送 ｜ ${bfPart}${summary}\n`;
  appendFileSync(DAILYLOG, line, 'utf8');
  appendFileSync(path.join(ROOT, 'auto-run.log'), `[${stamp}] node rc=${rc} | ${bfPart}${summary}\n`, 'utf8');
  console.log(`[${stamp}] ${summary} (node rc=${rc})`);
}

main();
