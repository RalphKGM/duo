import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { DUO_DIR } from './config.js';

const git = (cwd, ...args) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

export function gitRoot(cwd) {
  try {
    const root = git(cwd, 'rev-parse', '--show-toplevel');
    git(root, 'rev-parse', 'HEAD');
    return root;
  } catch {
    return null;
  }
}

export function isDirty(root) {
  try {
    return git(root, 'status', '--porcelain').length > 0;
  } catch {
    return false;
  }
}

export function makeWorktree(root, cwd, runId, agent) {
  const dir = path.join(DUO_DIR, 'worktrees', `${path.basename(root)}-${runId}`, agent);
  const branch = `duo/${runId}/${agent}`;
  git(root, 'worktree', 'add', '-b', branch, dir, 'HEAD');
  return { agent, dir, branch, cwd: path.join(dir, path.relative(root, cwd)) };
}

export function commitWorktree(wt, message) {
  git(wt.dir, 'add', '-A');
  if (!git(wt.dir, 'status', '--porcelain')) return null;
  try {
    git(wt.dir, 'commit', '-m', message, '--no-verify');
  } catch {
    git(wt.dir, '-c', 'user.name=duo', '-c', 'user.email=duo@localhost', 'commit', '-m', message, '--no-verify');
  }
  return git(wt.dir, 'diff', '--stat', 'HEAD~1', 'HEAD');
}

export function mergeWorktree(root, wt) {
  return git(root, 'merge', '--no-edit', wt.branch);
}

export function removeWorktrees(root, trees) {
  for (const wt of trees) {
    try { git(root, 'worktree', 'remove', '--force', wt.dir); } catch {}
    try { git(root, 'branch', '-D', wt.branch); } catch {}
  }
}
