import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { APPROVE_SCRIPT } from './approval.js';

export const AGENTS = {
  claude: { name: 'Claude Code', color: '#D97757' },
  codex: { name: 'Codex', color: '#6CA0F6' },
};

export async function runAgent(opts) {
  const fn = opts.agent === 'codex' ? runCodex : runClaude;
  let res = await fn(opts);
  if (!res.ok && !res.cancelled && opts.resumeId) {
    opts.onActivity?.('could not resume previous session, starting fresh');
    res = await fn({ ...opts, resumeId: null });
  }
  return res;
}

function spawnJsonl(cmd, args, { cwd, signal, stdin }, onEvent) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
    } catch (e) {
      return resolve({ code: -1, stderr: e.message, cancelled: false });
    }
    let stderr = '';
    child.stderr.on('data', (d) => {
      stderr = (stderr + d).slice(-8000);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(stdin ?? '');
    const rl = readline.createInterface({ input: child.stdout });
    rl.on('line', (line) => {
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        return;
      }
      try {
        onEvent(ev);
      } catch {}
    });
    const onAbort = () => child.kill('SIGTERM');
    if (signal?.aborted) onAbort();
    signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', (e) => {
      stderr += `\n${e.message}`;
    });
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      resolve({ code, stderr, cancelled: !!signal?.aborted });
    });
  });
}

const firstLine = (s) => String(s ?? '').trim().split('\n').find(Boolean) ?? '';
const clip = (s, n = 140) => {
  s = String(s ?? '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
};

const CLAUDE_TOOLS = {
  none: [],
  read: ['Read', 'Grep', 'Glob'],
  research: ['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch'],
  write: ['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch', 'Edit', 'Write', 'Bash'],
};

function fmtClaudeTool(name, i = {}) {
  switch (name) {
    case 'WebSearch': return `Search  ${clip(i.query)}`;
    case 'WebFetch': return `Fetch   ${clip(i.url)}`;
    case 'Read': return `Read    ${clip(i.file_path)}`;
    case 'Grep': return `Grep    ${clip(i.pattern)}`;
    case 'Glob': return `Glob    ${clip(i.pattern)}`;
    case 'Bash': return `Run     $ ${clip(i.command)}`;
    case 'Edit': case 'Write': case 'MultiEdit': return `${name.padEnd(7)} ${clip(i.file_path)}`;
    default: return `${name}  ${clip(JSON.stringify(i), 80)}`;
  }
}

async function runClaude(o) {
  const t0 = Date.now();
  let tools = [...CLAUDE_TOOLS[o.access || 'research']];
  if (o.search === false) tools = tools.filter((t) => !t.startsWith('Web'));
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--tools', tools.join(',')];
  const approving = o.access === 'write' && o.approval && o.approvals !== 'never';
  let allowed = tools;
  if (approving) {
    const gated = o.approvals === 'everything' ? ['Edit', 'Write', 'Bash'] : ['Bash'];
    allowed = tools.filter((t) => !gated.includes(t));
    const mcp = {
      mcpServers: {
        duo: {
          command: process.execPath,
          args: [APPROVE_SCRIPT],
          env: { DUO_APPROVE_URL: o.approval.url, DUO_APPROVE_TOKEN: o.approval.token, DUO_AGENT: 'claude' },
        },
      },
    };
    args.push('--mcp-config', JSON.stringify(mcp), '--permission-prompt-tool', 'mcp__duo__approve');
    args.push('--permission-mode', o.approvals === 'everything' ? 'manual' : 'acceptEdits');
  } else if (o.access === 'write') {
    args.push('--permission-mode', 'acceptEdits');
  }
  if (allowed.length) args.push('--allowedTools', allowed.join(','));
  if (o.model && o.model !== 'default') args.push('--model', o.model);
  if (o.effort && o.effort !== 'default') args.push('--effort', o.effort);
  if (o.resumeId) args.push('--resume', o.resumeId);
  if (o.lean !== false) args.push('--strict-mcp-config', '--disable-slash-commands');

  const r = { ok: false, text: '', sessionId: null, cost: 0, tokens: 0, toolCalls: 0 };
  let lastText = '';
  let resultSeen = false;
  const proc = await spawnJsonl('claude', args, { cwd: o.cwd, signal: o.signal, stdin: o.prompt }, (ev) => {
    if (ev.session_id && !r.sessionId) {
      r.sessionId = ev.session_id;
      o.onSession?.(ev.session_id);
    }
    if (ev.type === 'assistant') {
      for (const b of ev.message?.content || []) {
        if (b.type === 'tool_use') {
          r.toolCalls++;
          o.onActivity?.(fmtClaudeTool(b.name, b.input));
        } else if (b.type === 'text' && b.text?.trim()) {
          lastText = b.text;
          o.onActivity?.(clip(firstLine(b.text)));
        }
      }
    } else if (ev.type === 'result') {
      resultSeen = true;
      r.text = ev.result || lastText;
      r.cost = ev.total_cost_usd || 0;
      const u = ev.usage || {};
      r.tokens = (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      r.ok = !ev.is_error;
      if (ev.is_error) r.error = ev.result || ev.subtype;
    }
  });
  r.ms = Date.now() - t0;
  r.cancelled = proc.cancelled;
  if (!resultSeen) {
    r.text = lastText;
    r.ok = false;
    r.error = proc.cancelled ? 'cancelled' : clip(proc.stderr.trim().split('\n').slice(-3).join(' '), 400) || `exited with code ${proc.code}`;
  }
  return r;
}

async function runCodex(o) {
  const t0 = Date.now();
  const access = o.access || 'research';
  const args = [];
  if (o.search !== false && (access === 'research' || access === 'write')) args.push('--search');
  args.push('exec');
  if (o.resumeId) args.push('resume');
  args.push('--json', '--skip-git-repo-check');
  args.push('-c', `sandbox_mode="${access === 'write' ? 'workspace-write' : 'read-only'}"`);
  if (o.model && o.model !== 'default') args.push('-m', o.model);
  if (o.effort && o.effort !== 'default') args.push('-c', `model_reasoning_effort="${o.effort}"`);
  if (o.resumeId) args.push(o.resumeId);
  args.push('-');

  const r = { ok: false, text: '', sessionId: null, cost: 0, tokens: 0, toolCalls: 0 };
  let failed = null;
  const proc = await spawnJsonl('codex', args, { cwd: o.cwd, signal: o.signal, stdin: o.prompt }, (ev) => {
    const it = ev.item || {};
    if (ev.type === 'thread.started') {
      r.sessionId = ev.thread_id;
      o.onSession?.(ev.thread_id);
    } else if (ev.type === 'item.completed' && it.type === 'agent_message') {
      r.text = it.text || r.text;
      o.onActivity?.(clip(firstLine(it.text)));
    } else if (ev.type === 'item.completed' && it.type === 'web_search') {
      r.toolCalls++;
      const q = it.query || it.action?.query || it.action?.url || '';
      if (q) o.onActivity?.(`Search  ${clip(q)}`);
    } else if (ev.type === 'item.started' && it.type === 'command_execution') {
      r.toolCalls++;
      o.onActivity?.(`Run     $ ${clip(it.command)}`);
    } else if (ev.type === 'item.started' && it.type === 'mcp_tool_call') {
      r.toolCalls++;
      o.onActivity?.(`Tool    ${it.server}.${it.tool} ${clip(it.arguments?.title || '', 60)}`);
    } else if (ev.type === 'item.completed' && it.type === 'file_change') {
      r.toolCalls++;
      const files = (it.changes || []).map((c) => c.path).join(', ');
      o.onActivity?.(`Edit    ${clip(files || 'files')}`);
    } else if (ev.type === 'turn.completed') {
      const u = ev.usage || {};
      r.tokens += (u.input_tokens || 0) + (u.output_tokens || 0);
    } else if (ev.type === 'turn.failed' || ev.type === 'error') {
      failed = ev.error?.message || ev.message || 'codex error';
      o.onActivity?.(`error: ${clip(failed)}`);
    }
  });
  r.ms = Date.now() - t0;
  r.cancelled = proc.cancelled;
  r.ok = !!r.text && !failed && !proc.cancelled;
  if (!r.ok) {
    r.error = proc.cancelled
      ? 'cancelled'
      : failed || clip(proc.stderr.trim().split('\n').filter((l) => !/Reading additional input/.test(l)).slice(-3).join(' '), 400) || `exited with code ${proc.code}`;
  }
  return r;
}
