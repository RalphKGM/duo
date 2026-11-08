import fs from 'node:fs';
import path from 'node:path';
import { runAgent, AGENTS } from './agents.js';
import { DUO_DIR } from './config.js';
import { gitRoot, isDirty, makeWorktree, commitWorktree, removeWorktrees } from './git.js';

export async function runPrompt(ctx, prompt, route) {
  const runId = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  ctx.runId = runId;
  ctx.runDir = path.join(DUO_DIR, 'runs', runId);
  fs.mkdirSync(ctx.runDir, { recursive: true });
  save(ctx, 'prompt.txt', prompt);

  let final;
  ctx.trees = null;
  if (route) final = await runSingle(ctx, prompt, route);
  else if (ctx.config.mode === 'single') final = await runSingle(ctx, prompt, ctx.config.singleAgent);
  else if (ctx.config.mode === 'orchestrate') final = await runOrchestrate(ctx, prompt);
  else final = await runParallel(ctx, prompt);

  if (ctx.signal.aborted) ctx.ui.add({ type: 'info', text: 'Cancelled.' });
  if (final) save(ctx, 'final.md', final);
  return { final, runDir: ctx.runDir, trees: ctx.trees };
}

function save(ctx, name, text) {
  try {
    fs.writeFileSync(path.join(ctx.runDir, name), text ?? '');
  } catch {}
}

const enabledAgents = (cfg) => Object.keys(AGENTS).filter((a) => cfg.agents[a]);

async function lane(ctx, o) {
  const { config, ui } = ctx;
  const agent = o.agent;
  const model = o.model ?? config.models[agent];
  const effort = o.effort ?? config.effort[agent];
  const id = o.laneId ?? ui.lane({ agent, title: o.title, model });
  ui.update(id, { status: 'running', startedAt: Date.now(), model });

  const resumeKey = config.rememberContext && o.resumeKey ? `${o.resumeKey}|${agent}|${o.cwd ?? ctx.cwd}` : null;
  const res = await runAgent({
    agent,
    prompt: o.prompt,
    cwd: o.cwd ?? ctx.cwd,
    model,
    effort,
    access: o.access ?? config.access,
    search: config.webSearch,
    lean: config.lean,
    approvals: config.approvals,
    approval: ctx.approval,
    resumeId: resumeKey ? ctx.sessions[resumeKey] : null,
    signal: ctx.signal,
    onActivity: (line) => ui.activity(id, line),
    onSession: (sid) => {
      if (resumeKey) ctx.sessions[resumeKey] = sid;
    },
  });
  ui.update(id, { status: res.ok ? 'done' : 'error', endedAt: Date.now(), toolCalls: res.toolCalls });
  ctx.ui.spend?.(res.cost, res.tokens);
  if (o.file) save(ctx, o.file, res.text || `ERROR: ${res.error}`);

  const meta = { agent, model, ms: res.ms, cost: res.cost, tokens: res.tokens, title: o.title };
  if (res.cancelled) {
    ui.done(id);
  } else if (!res.ok) {
    ui.done(id, { type: 'error', text: `${AGENTS[agent].name} failed${o.title ? ` on “${o.title}”` : ''}: ${res.error}` });
  } else if (o.show === 'answer') {
    ui.done(id, { type: 'answer', text: res.text, ...meta });
  } else if (o.show === 'task') {
    ui.done(id, { type: 'task', text: res.text, ...meta });
  } else {
    ui.done(id);
  }
  return res;
}

async function runSingle(ctx, prompt, agent) {
  const r = await lane(ctx, { agent, prompt, title: '', resumeKey: 'chat', show: 'answer', file: `${agent}.md` });
  return r.ok ? r.text : null;
}

async function runParallel(ctx, prompt) {
  const { config, ui } = ctx;
  const agents = enabledAgents(config);
  if (agents.length === 0) {
    ui.add({ type: 'error', text: 'No agents enabled — turn one on with /agents.' });
    return null;
  }
  if (agents.length === 1) return runSingle(ctx, prompt, agents[0]);

  let trees = null;
  if (config.access === 'write' && config.isolation === 'worktree') {
    const root = gitRoot(ctx.cwd);
    if (!root) {
      ui.add({ type: 'warn', text: 'Not a git repo with commits, so both agents edit the same folder. Run `git init && git commit` to get separate worktrees.' });
    } else {
      if (isDirty(root)) ui.add({ type: 'warn', text: 'You have uncommitted changes — worktrees start from your last commit and won’t include them.' });
      trees = Object.fromEntries(agents.map((a) => [a, makeWorktree(root, ctx.cwd, ctx.runId, a)]));
      ctx.trees = { root, list: Object.values(trees) };
      ui.add({ type: 'info', text: `Each agent gets its own copy of the repo:\n${agents.map((a) => `${AGENTS[a].name}: ${trees[a].branch}`).join('\n')}` });
    }
  }

  ui.phase(`${agents.map((a) => AGENTS[a].name).join(' and ')} are working`);
  const results = await Promise.all(
    agents.map((a) =>
      lane(ctx, {
        agent: a,
        prompt,
        title: '',
        cwd: trees?.[a].cwd,
        resumeKey: trees ? null : 'chat',
        show: 'answer',
        file: `${a}.md`,
      }),
    ),
  );
  if (ctx.signal.aborted) {
    if (trees) removeWorktrees(ctx.trees.root, ctx.trees.list);
    ctx.trees = null;
    return null;
  }

  if (trees) {
    for (const a of agents) {
      try {
        const stat = commitWorktree(trees[a], `duo: ${AGENTS[a].name} — ${prompt.slice(0, 60)}`);
        ui.add({
          type: 'info',
          text: stat
            ? `${AGENTS[a].name}'s changes are on branch ${trees[a].branch}\n${stat}`
            : `${AGENTS[a].name} didn’t change any files.`,
        });
      } catch (e) {
        ui.add({ type: 'warn', text: `Couldn’t commit ${AGENTS[a].name}'s worktree: ${e.message}` });
      }
    }
  }

  if (trees) ui.add({ type: 'info', text: 'Type /keep to merge one agent\'s version into your repo (or throw both away).' });
  const ok = agents.map((a, i) => ({ a, r: results[i] })).filter((x) => x.r.ok);
  if (!config.merge.enabled || ok.length < 2) return ok[ok.length - 1]?.r.text ?? null;

  ui.phase('Combining the answers');
  const m = await lane(ctx, {
    agent: config.merge.agent,
    model: config.merge.model,
    effort: 'default',
    access: 'none',
    title: 'Combining answers',
    prompt: mergePrompt(prompt, ok),
    file: 'merged.md',
  });
  if (m.ok) ui.add({ type: 'final', title: 'Combined answer', text: m.text, agent: config.merge.agent, model: config.merge.model });
  return m.ok ? m.text : null;
}

function mergePrompt(prompt, ok) {
  return `Several AI agents answered the same request independently. Write ONE combined answer for the user.
- Start with the best merged answer. Keep useful specifics, links, numbers and commands from all of them.
- If they made file changes, summarize what each changed instead.
- End with a short "Where they disagree" section only if they actually disagree, and say which looks right and why.
Don't use tools. Be concise and well formatted (Markdown).

=== USER REQUEST ===
${prompt}

${ok.map((x) => `=== ${AGENTS[x.a].name.toUpperCase()}'S ANSWER ===\n${x.r.text}`).join('\n\n')}`;
}

async function runOrchestrate(ctx, prompt) {
  const { config, ui } = ctx;
  const o = config.orchestrator;
  const workers = enabledAgents(config);
  if (!workers.length) {
    ui.add({ type: 'error', text: 'No worker agents enabled — turn one on with /agents.' });
    return null;
  }

  ui.phase(`${AGENTS[o.agent].name} is planning`);
  const planRes = await lane(ctx, {
    agent: o.agent,
    model: o.model,
    effort: o.effort,
    access: 'read',
    title: 'Planning',
    prompt: planPrompt(ctx, prompt, workers),
    resumeKey: 'orchestrator',
    file: 'plan.txt',
  });
  if (ctx.signal.aborted) return null;
  if (!planRes.ok) return null;

  let plan = parsePlan(planRes.text, workers, o.agent, config.maxTasks);
  if (!plan) {
    ui.add({ type: 'warn', text: 'The orchestrator didn’t return a usable plan, so both agents get the prompt directly instead.' });
    return runParallel(ctx, prompt);
  }
  save(ctx, 'plan.json', JSON.stringify(plan, null, 2));

  if (!plan.tasks.length) {
    ui.add({ type: 'final', title: 'Answer', text: plan.answer || planRes.text, agent: o.agent, model: o.model });
    return plan.answer;
  }

  ui.add({ type: 'plan', plan, agent: o.agent, model: o.model });

  if (config.planApproval === 'ask') {
    ui.phase(null);
    const choice = await ui.choose({
      title: `Run this plan? (${plan.tasks.length} task${plan.tasks.length > 1 ? 's' : ''})`,
      options: [
        { value: 'run', label: 'Run it', description: 'as planned' },
        ...workers.map((a) => ({ value: a, label: `Run it, all on ${AGENTS[a].name}`, description: 'reassign every task' })),
        { value: 'cancel', label: 'Cancel', description: 'drop this plan' },
      ],
    });
    if (choice === 'cancel' || choice == null) {
      ui.add({ type: 'info', text: 'Plan cancelled.' });
      return null;
    }
    if (choice !== 'run') plan.tasks.forEach((t) => (t.agent = choice));
  }

  const ids = Object.fromEntries(plan.tasks.map((t) => [t.id, ui.lane({ agent: t.agent, title: t.title, model: config.models[t.agent], status: 'queued' })]));
  ui.phase(`Working on ${plan.tasks.length} task${plan.tasks.length > 1 ? 's' : ''}`);

  const results = await schedule(plan.tasks, config.maxParallel, ctx.signal, (t, deps) =>
    lane(ctx, {
      agent: t.agent,
      laneId: ids[t.id],
      title: t.title,
      prompt: workerPrompt(prompt, t, deps),
      show: 'task',
      file: `task-${t.id}-${t.agent}.md`,
    }),
  );
  if (ctx.signal.aborted) return null;
  const okCount = results.filter((x) => x.res.ok).length;
  if (!okCount) {
    ui.add({ type: 'error', text: 'Every task failed, so there’s nothing to combine.' });
    return null;
  }

  ui.phase(`${AGENTS[o.agent].name} is writing the final answer`);
  const fin = await lane(ctx, {
    agent: o.agent,
    model: o.model,
    effort: o.effort,
    access: 'none',
    title: 'Final answer',
    prompt: synthPrompt(prompt, results),
    resumeKey: 'orchestrator',
    file: 'final-answer.md',
  });
  if (fin.ok) ui.add({ type: 'final', title: 'Final answer', text: fin.text, agent: o.agent, model: o.model });
  return fin.ok ? fin.text : null;
}

function planPrompt(ctx, prompt, workers) {
  const { config } = ctx;
  const team = workers
    .map((a) => `- "${a}": ${AGENTS[a].name} (model: ${config.models[a]}). Can ${config.access === 'write' ? 'read and edit files, run shell commands' : 'read files'}${config.webSearch ? ', search the web' : ''}.`)
    .join('\n');
  return `You are the ORCHESTRATOR of a small team of AI agents. You don't do the work yourself: you plan it and hand out tasks, and later you'll combine the results.

Team:
${team}
Working directory: ${ctx.cwd}
Permissions this run: ${config.access === 'write' ? 'agents CAN edit files in the working directory' : 'read-only research (no file edits)'}.

Rules:
- Split the request into 1 to ${config.maxTasks} focused tasks. Prefer tasks that can run at the same time.
- Each task prompt must stand on its own: the worker can't see this conversation. Include every needed detail.
- Use "depends_on" only when a task really needs another task's output (that output will be given to it).
- Spread work across the team when it helps, e.g. have both agents research the same key question for a second opinion.
- When editing files, never let two tasks that run at the same time edit the same file.
- If the request is trivial (a greeting, or something you can answer right away without research), return no tasks and put your reply in "answer".
- You may look at files in the working directory to plan better, but keep it quick.

Reply with ONLY this JSON object, no other text:
{"summary": "one line on the approach", "tasks": [{"id": "t1", "agent": "${workers[0]}", "title": "short title", "prompt": "full instructions", "depends_on": []}], "answer": null}

User request:
${prompt}`;
}

function parsePlan(text, workers, fallbackAgent, maxTasks) {
  if (!text) return null;
  let s = text.replace(/```(?:json)?/g, '');
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  let p;
  try {
    p = JSON.parse(s.slice(a, b + 1));
  } catch {
    return null;
  }
  const tasks = (Array.isArray(p.tasks) ? p.tasks : []).slice(0, maxTasks).map((t, i) => ({
    id: String(t.id || `t${i + 1}`),
    agent: workers.includes(t.agent) ? t.agent : workers.includes(fallbackAgent) ? fallbackAgent : workers[0],
    title: String(t.title || `Task ${i + 1}`).slice(0, 80),
    prompt: String(t.prompt || t.title || ''),
    depends_on: Array.isArray(t.depends_on) ? t.depends_on.map(String) : [],
  }));
  const ids = new Set(tasks.map((t) => t.id));
  tasks.forEach((t) => (t.depends_on = t.depends_on.filter((d) => ids.has(d) && d !== t.id)));
  if (!tasks.length && !p.answer) return null;
  return { summary: p.summary || '', tasks, answer: p.answer || null };
}

function workerPrompt(userPrompt, task, deps) {
  let s = `You are one member of a team of AI agents working on this request from a user:
"""${userPrompt}"""

Your task: ${task.title}
${task.prompt}
`;
  if (deps.length) {
    s += `\nResults from earlier tasks you can build on:\n${deps.map((d) => `--- ${d.task.title} (${AGENTS[d.task.agent].name}) ---\n${d.res.text}`).join('\n\n')}\n`;
  }
  s += `\nDo only your task. A coordinator will combine your output with the others', so be complete but concise, and include sources/links for facts.`;
  return s;
}

function synthPrompt(userPrompt, results) {
  return `Your team finished. Here are the results:

${results
  .map((x) => `### ${x.task.id} · ${x.task.title} · ${AGENTS[x.task.agent].name}\n${x.res.ok ? x.res.text : `(failed: ${x.res.error})`}`)
  .join('\n\n')}

Now write the final answer to the user's original request:
"""${userPrompt}"""

Combine the results into one clear, well-structured Markdown answer. Resolve any conflicts between agents (say which is right and why), keep useful links and specifics, and don't mention task ids. Don't use tools.`;
}

async function schedule(tasks, max, signal, run) {
  const done = new Map();
  const running = new Map();
  const pending = [...tasks];
  while ((pending.length || running.size) && !signal.aborted) {
    for (const t of [...pending]) {
      if (running.size >= max) break;
      if (t.depends_on.every((d) => done.has(d))) {
        pending.splice(pending.indexOf(t), 1);
        const deps = t.depends_on.map((d) => done.get(d)).filter((x) => x.res.ok);
        running.set(
          t.id,
          run(t, deps).then((res) => {
            done.set(t.id, { task: t, res });
            running.delete(t.id);
          }),
        );
      }
    }
    if (!running.size && pending.length) {
      pending.forEach((t) => (t.depends_on = []));
      continue;
    }
    if (running.size) await Promise.race(running.values());
  }
  return tasks.map((t) => done.get(t.id)).filter(Boolean);
}
