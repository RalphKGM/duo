import React, { useState, useRef, useCallback, useEffect } from 'react';
import { Box, Text, Static, useInput, useApp, useStdout } from 'ink';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  html, T, agentColor, tildify, fmtMs, fmtTokens, metaLine, renderMd, useTick, frame,
  Select, TextPrompt, useLineEditor, EditorText,
} from './components.js';
import { AGENTS } from '../lib/agents.js';
import {
  loadConfig, saveConfig, loadHistory, saveHistory, codexDefaults, claudeDefaults,
  CLAUDE_MODELS, codexModels, EFFORTS, DUO_DIR, DEFAULTS,
} from '../lib/config.js';
import { runPrompt } from '../lib/engine.js';
import { mergeWorktree, removeWorktrees, diffWorktree } from '../lib/git.js';
import { startApprovalServer, describeAction } from '../lib/approval.js';

const MODES = {
  parallel: { label: 'Parallel', description: 'all agents answer the same prompt, then the answers are merged' },
  orchestrate: { label: 'Orchestrate', description: 'one agent plans, hands tasks to the team, then writes the final answer' },
  single: { label: 'Single', description: 'chat with just one agent' },
};

const COMMANDS = [
  { name: '/mode', description: 'switch mode: parallel · orchestrate · single' },
  { name: '/orchestrator', description: 'choose which agent orchestrates, and its model' },
  { name: '/model', description: 'set the default model for each agent' },
  { name: '/effort', description: 'set reasoning effort for each agent' },
  { name: '/agents', description: 'turn agents on or off' },
  { name: '/settings', description: 'every setting in one place' },
  { name: '/write', description: 'toggle between read-only research and editing files' },
  { name: '/diff', description: 'after a write run: show what each agent changed' },
  { name: '/keep', description: 'after a write run: merge one agent\'s changes, discard the rest' },
  { name: '/new', description: 'start a fresh conversation (agents forget context)' },
  { name: '/cwd', description: 'change the folder the agents work in' },
  { name: '/copy', description: 'copy the last answer to the clipboard' },
  { name: '/runs', description: 'open the folder of saved runs' },
  { name: '/status', description: 'show the current setup' },
  { name: '/clear', description: 'clear the screen' },
  { name: '/help', description: 'commands and shortcuts' },
  { name: '/quit', description: 'exit duo' },
];

const modelName = (agent, m) => {
  if (m && m !== 'default') return m;
  const d = agent === 'codex' ? codexDefaults().model : claudeDefaults().model;
  return d ? `default (${d})` : 'default';
};
const effortName = (agent, e) => {
  if (e && e !== 'default') return e;
  const d = agent === 'codex' ? codexDefaults().effort : claudeDefaults().effort;
  return d ? `default (${d})` : 'default';
};
const accessName = (c) => (c.access === 'write' ? 'can edit files + run commands' : `read-only${c.webSearch ? ' + web search' : ''}`);

let nextId = 1;
const uid = () => `i${nextId++}`;

function Header({ config, cwd, width }) {
  const row = (k, v, color) => html`<${Box} key=${k}><${Box} width=${14} flexShrink=${0}><${Text} color=${T.dim}>${k}</${Text}></${Box}><${Text} color=${color}>${v}</${Text}></${Box}>`;
  const enabled = Object.keys(AGENTS).filter((a) => config.agents[a]);
  return html`
    <${Box} flexDirection="column" marginBottom=${1}>
      <${Box} flexDirection="column" borderStyle="round" borderColor=${T.accent} paddingX=${1} width=${Math.min(width, 76)}>
        <${Text}><${Text} color=${T.accent} bold>✻ duo</${Text}><${Text} color=${T.dim}>  ·  </${Text}><${Text} color=${T.claude}>Claude Code</${Text}><${Text} color=${T.dim}> + </${Text}><${Text} color=${T.codex}>Codex</${Text}><${Text} color=${T.dim}>, working together</${Text}></${Text}>
        <${Text}> </${Text}>
        ${row('mode', `${MODES[config.mode].label} — ${MODES[config.mode].description}`)}
        ${config.mode === 'orchestrate' ? row('orchestrator', `${AGENTS[config.orchestrator.agent].name} · ${modelName(config.orchestrator.agent, config.orchestrator.model)}`, agentColor(config.orchestrator.agent)) : null}
        ${config.mode === 'single' ? row('talking to', AGENTS[config.singleAgent].name, agentColor(config.singleAgent)) : null}
        ${enabled.map((a) => row(a, `${modelName(a, config.models[a])} · effort ${effortName(a, config.effort[a])}`, agentColor(a)))}
        ${row('access', accessName(config), config.access === 'write' ? T.warn : undefined)}
        ${row('folder', tildify(cwd))}
      </${Box}>
      <${Text} color=${T.dim}>  Type a question and press enter.  / for commands  ·  @claude or @codex to ask just one  ·  esc to cancel</${Text}>
    </${Box}>`;
}

function Item({ item, width }) {
  const w = width - 4;
  switch (item.type) {
    case 'header':
      return html`<${Header} config=${item.config} cwd=${item.cwd} width=${width} />`;
    case 'user':
      return html`
        <${Box} marginTop=${1} marginBottom=${1} paddingX=${1} width=${Math.min(width, 110)}>
          <${Text} color=${T.dim}>❯ </${Text}><${Text} bold>${item.text}</${Text}>
          ${item.route ? html`<${Text} color=${agentColor(item.route)}>  → ${AGENTS[item.route].name} only</${Text}>` : null}
        </${Box}>`;
    case 'answer':
    case 'final': {
      const isFinal = item.type === 'final';
      const color = isFinal ? T.accent : agentColor(item.agent);
      const title = isFinal ? item.title : AGENTS[item.agent].name;
      const meta = isFinal ? [AGENTS[item.agent]?.name, item.model && item.model !== 'default' ? item.model : null].filter(Boolean).join(' · ') : metaLine(item);
      return html`
        <${Box} flexDirection="column" marginBottom=${1}>
          <${Text}><${Text} color=${color} bold>${isFinal ? '★' : '●'} ${title}</${Text}><${Text} color=${T.dim}>  ${meta}</${Text}></${Text}>
          <${Box} paddingLeft=${2} width=${width}><${Text}>${renderMd(item.text, w)}</${Text}></${Box}>
        </${Box}>`;
    }
    case 'task': {
      const preview = String(item.text || '').split('\n').map((s) => s.replace(/^[\s#>*|-]+/, '').replace(/[*_`]/g, '').trim()).filter(Boolean)[0] || '';
      return html`
        <${Box} flexDirection="column">
          <${Text}><${Text} color=${T.ok}>✓ </${Text}><${Text} color=${agentColor(item.agent)} bold>${item.agent.padEnd(7)}</${Text}><${Text}>${item.title}</${Text}><${Text} color=${T.dim}>  ${metaLine(item)}</${Text}></${Text}>
          <${Box} paddingLeft=${2} width=${width}><${Text} color=${T.dim} wrap="truncate-end">⎿ ${preview}</${Text}></${Box}>
        </${Box}>`;
    }
    case 'plan':
      return html`
        <${Box} flexDirection="column" marginBottom=${1}>
          <${Text}><${Text} color=${agentColor(item.agent)} bold>● Plan</${Text}><${Text} color=${T.dim}>  by ${AGENTS[item.agent].name} · ${item.model}</${Text}></${Text}>
          ${item.plan.summary ? html`<${Box} paddingLeft=${2}><${Text} color=${T.dim}>${item.plan.summary}</${Text}></${Box}>` : null}
          ${item.plan.tasks.map(
            (t, i) => html`
              <${Box} key=${t.id} paddingLeft=${2}>
                <${Text}>
                  <${Text} color=${T.dim}>${String(i + 1).padStart(2)}. </${Text}>
                  <${Text} color=${agentColor(t.agent)} bold>${t.agent.padEnd(7)}</${Text}>
                  <${Text}>${t.title}</${Text}>
                  ${t.depends_on.length ? html`<${Text} color=${T.dim}>  (after ${t.depends_on.map((d) => item.plan.tasks.findIndex((x) => x.id === d) + 1).join(', ')})</${Text}>` : null}
                </${Text}>
              </${Box}>`,
          )}
        </${Box}>`;
    case 'info':
      return html`<${Box} paddingLeft=${2} marginBottom=${1} width=${width}><${Text} color=${T.dim}>⎿ ${item.text}</${Text}></${Box}>`;
    case 'warn':
      return html`<${Box} paddingLeft=${2} marginBottom=${1} width=${width}><${Text} color=${T.warn}>⚠ ${item.text}</${Text}></${Box}>`;
    case 'error':
      return html`<${Box} paddingLeft=${2} marginBottom=${1} width=${width}><${Text} color=${T.err}>✗ ${item.text}</${Text}></${Box}>`;
    case 'diff': {
      const lines = item.patch.split('\n');
      const max = 300;
      const shown = lines.slice(0, max);
      const color = (l) => (l.startsWith('+++') || l.startsWith('---') ? undefined : l.startsWith('+') ? T.ok : l.startsWith('-') ? T.err : l.startsWith('@@') ? T.codex : l.startsWith('diff ') ? T.accent : T.dim);
      return html`
        <${Box} flexDirection="column" marginBottom=${1}>
          <${Text}><${Text} color=${agentColor(item.agent)} bold>● ${AGENTS[item.agent].name}'s changes</${Text}><${Text} color=${T.dim}>  ${item.branch}</${Text}></${Text}>
          <${Box} paddingLeft=${2} flexDirection="column" width=${width}>
            ${item.patch ? shown.map((l, i) => html`<${Text} key=${i} color=${color(l)} bold=${l.startsWith('diff ')} wrap="truncate-end">${l || ' '}</${Text}>`) : html`<${Text} color=${T.dim}>No changes.</${Text}>`}
            ${lines.length > max ? html`<${Text} color=${T.warn}>… ${lines.length - max} more lines. Full diff: git diff ${item.base.slice(0, 8)} ${item.branch}</${Text}>` : null}
          </${Box}>
        </${Box}>`;
    }
    case 'help':
      return html`
        <${Box} flexDirection="column" marginBottom=${1} paddingLeft=${2}>
          <${Text} bold>Commands</${Text}>
          ${COMMANDS.map((c) => html`<${Text} key=${c.name}><${Text} color=${T.accent}>${c.name.padEnd(15)}</${Text}><${Text} color=${T.dim}>${c.description}</${Text}></${Text}>`)}
          <${Text}> </${Text}>
          <${Text} bold>Shortcuts</${Text}>
          ${[
            ['@claude …', 'send a prompt to Claude Code only'],
            ['@codex …', 'send a prompt to Codex only'],
            ['esc', 'cancel what’s running (or clear the input)'],
            ['↑ / ↓', 'previous prompts'],
            ['tab', 'complete a command'],
            ['\\ + enter', 'new line (also option+enter)'],
            ['ctrl+l', 'clear the screen'],
            ['ctrl+c ×2', 'quit'],
          ].map(([k, d]) => html`<${Text} key=${k}><${Text} color=${T.accent}>${k.padEnd(15)}</${Text}><${Text} color=${T.dim}>${d}</${Text}></${Text}>`)}
        </${Box}>`;
    default:
      return null;
  }
}

function Live({ phase, lanes, activityLines, width, busy }) {
  const t = useTick(120, busy);
  const now = Date.now();
  return html`
    <${Box} flexDirection="column" marginBottom=${1}>
      ${lanes.map((l) => {
        const color = agentColor(l.agent);
        const icon = l.status === 'queued' ? html`<${Text} color=${T.dim}>○</${Text}>` : l.status === 'done' ? html`<${Text} color=${T.ok}>✓</${Text}>` : l.status === 'error' ? html`<${Text} color=${T.err}>✗</${Text}>` : html`<${Text} color=${color}>${frame(t)}</${Text}>`;
        const elapsed = l.startedAt ? fmtMs((l.endedAt || now) - l.startedAt) : '';
        const acts = l.activity.slice(-activityLines);
        return html`
          <${Box} key=${l.id} flexDirection="column" marginBottom=${acts.length ? 1 : 0}>
            <${Text} wrap="truncate-end">
              ${icon} <${Text} color=${color} bold>${AGENTS[l.agent].name}</${Text}>
              ${l.title ? html`<${Text}>  ${l.title}</${Text}>` : null}
              <${Text} color=${T.dim}>  ${[l.model && l.model !== 'default' ? l.model : null, l.status === 'queued' ? 'waiting' : elapsed, l.activity.length ? `${l.activity.length} steps` : null].filter(Boolean).join(' · ')}</${Text}>
            </${Text}>
            ${acts.map((a, i) => html`<${Box} key=${i} paddingLeft=${2} width=${width}><${Text} color=${T.dim} wrap="truncate-end">⎿ ${a}</${Text}></${Box}>`)}
          </${Box}>`;
      })}
      ${phase ? html`<${Text}><${Text} color=${T.accent}>${frame(t)} ${phase}…</${Text}><${Text} color=${T.dim}>  (esc to cancel)</${Text}></${Text}>` : null}
    </${Box}>`;
}

function PromptInput({ active, onSubmit, onExit, onClear, history, width, config, spent }) {
  const ed = useLineEditor('');
  const [sel, setSel] = useState(0);
  const [hIdx, setHIdx] = useState(-1);
  const [armed, setArmed] = useState(false);
  const draft = useRef('');
  const v = ed.value;
  const sugg = v.startsWith('/') && !/\s/.test(v) ? COMMANDS.filter((c) => c.name.startsWith(v.toLowerCase())) : [];
  const selIdx = Math.min(sel, Math.max(0, sugg.length - 1));

  useEffect(() => {
    if (!armed) return;
    const id = setTimeout(() => setArmed(false), 2000);
    return () => clearTimeout(id);
  }, [armed]);

  const submit = (text) => {
    ed.set('');
    setSel(0);
    setHIdx(-1);
    onSubmit(text);
  };

  useInput(
    (input, key) => {
      if (key.ctrl && input === 'c') {
        if (ed.value) return ed.set('');
        if (armed) return onExit();
        return setArmed(true);
      }
      if (key.ctrl && input === 'l') return onClear();
      if (key.escape) return ed.set('');
      if (key.return) {
        if (key.meta) return ed.handle('\n', {});
        if (ed.value.endsWith('\\')) return ed.set(ed.value.slice(0, -1) + '\n');
        if (sugg.length) return submit(sugg[selIdx].name);
        if (ed.value.trim()) return submit(ed.value);
        return;
      }
      if (key.tab) {
        if (sugg.length) ed.set(sugg[selIdx].name + ' ');
        return;
      }
      if (key.upArrow || key.downArrow) {
        if (sugg.length) return setSel((s) => (s + (key.upArrow ? -1 : 1) + sugg.length) % sugg.length);
        if (!history.length) return;
        if (key.downArrow && hIdx === -1) return;
        if (hIdx === -1) draft.current = ed.value;
        const i = key.upArrow ? Math.min(history.length - 1, hIdx + 1) : Math.max(-1, hIdx - 1);
        setHIdx(i);
        return ed.set(i === -1 ? draft.current : history[history.length - 1 - i] ?? '');
      }
      if (ed.handle(input, key)) {
        setSel(0);
        setArmed(false);
      }
    },
    { isActive: active },
  );

  const status = [
    MODES[config.mode].label.toLowerCase() + (config.mode === 'orchestrate' ? ` by ${config.orchestrator.agent}` : config.mode === 'single' ? ` · ${config.singleAgent}` : ''),
    ...Object.keys(AGENTS).filter((a) => config.agents[a]).map((a) => `${a} ${config.models[a] === 'default' ? (a === 'codex' ? codexDefaults().model || 'default' : 'default') : config.models[a]}`),
    config.access === 'write' ? 'WRITE' : 'read-only',
  ].join(' · ');

  return html`
    <${Box} flexDirection="column">
      <${Box} borderStyle="round" borderColor=${active ? T.dim : '#444444'} paddingX=${1} width=${width}>
        <${Text} color=${active ? T.accent : T.dim}>❯ </${Text}>
        <${EditorText} value=${v} cursor=${ed.cursor} showCursor=${active} placeholder=${active ? 'Ask anything…' : 'working… press esc to cancel'} />
      </${Box}>
      ${sugg.length
        ? html`<${Box} flexDirection="column" paddingLeft=${2}>${sugg.map(
            (c, i) => html`<${Text} key=${c.name}><${Text} color=${i === selIdx ? T.accent : undefined} bold=${i === selIdx}>${c.name.padEnd(15)}</${Text}><${Text} color=${T.dim}>${c.description}</${Text}></${Text}>`,
          )}</${Box}>`
        : html`<${Box} paddingX=${2} justifyContent="space-between" width=${width}>
            <${Text} color=${armed ? T.warn : T.dim} wrap="truncate-end">${armed ? 'Press ctrl+c again to quit' : status}</${Text}>
            <${Text} color=${T.dim}>${spent.cost || spent.tokens ? `$${spent.cost.toFixed(2)} · ${fmtTokens(spent.tokens)} tok   ` : ''}/help</${Text}>
          </${Box}>`}
    </${Box}>`;
}

export function App({ initialPrompt, initialCwd }) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [width, setWidth] = useState(stdout.columns || 100);
  useEffect(() => {
    const on = () => setWidth(stdout.columns || 100);
    stdout.on('resize', on);
    return () => stdout.off('resize', on);
  }, [stdout]);

  const [config, setConfigState] = useState(loadConfig);
  const cfg = useRef(config);
  const setConfig = (fn) => {
    const next = typeof fn === 'function' ? fn(structuredClone(cfg.current)) : fn;
    cfg.current = next;
    saveConfig(next);
    setConfigState(next);
  };

  const [cwd, setCwdState] = useState(initialCwd);
  const cwdRef = useRef(initialCwd);
  const [items, setItems] = useState(() => [{ id: uid(), type: 'header', config, cwd: initialCwd }]);
  const [staticKey, setStaticKey] = useState(0);
  const [lanes, setLanes] = useState([]);
  const [phase, setPhase] = useState(null);
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState(null);
  const [spent, setSpent] = useState({ cost: 0, tokens: 0 });
  const [history, setHistory] = useState(loadHistory);
  const sessions = useRef({});
  const abortRef = useRef(null);
  const lastAnswer = useRef('');
  const lastTrees = useRef(null);
  const approvalSrv = useRef(null);
  const allowAll = useRef(new Set());
  const approvalQueue = useRef(Promise.resolve());

  const add = useCallback((item) => setItems((xs) => [...xs, { id: uid(), ...item }]), []);
  const info = (text) => add({ type: 'info', text });

  const clearScreen = () => {
    stdout.write('\x1b[2J\x1b[3J\x1b[H');
    setItems([{ id: uid(), type: 'header', config: cfg.current, cwd: cwdRef.current }]);
    setStaticKey((k) => k + 1);
  };

  const quit = () => {
    abortRef.current?.abort();
    exit();
  };

  useInput(
    (input, key) => {
      if (key.escape || (key.ctrl && input === 'c')) abortRef.current?.abort();
    },
    { isActive: busy && !dialog },
  );

  const pick = (title, options, { hint, current, body } = {}) =>
    new Promise((resolve) => {
      const opts = options.map((o) => ({ ...o, current: current !== undefined && o.value === current }));
      setDialog({
        kind: 'select',
        title,
        hint,
        body,
        options: opts,
        initial: Math.max(0, opts.findIndex((o) => o.current)),
        onSelect: (o) => (setDialog(null), resolve(o.value)),
        onCancel: () => (setDialog(null), resolve(null)),
      });
    });
  const ask = (title, initial = '', hint) =>
    new Promise((resolve) => {
      setDialog({ kind: 'text', title, hint, initial, onSubmit: (v) => (setDialog(null), resolve(v)), onCancel: () => (setDialog(null), resolve(null)) });
    });

  const askApproval = async ({ agent, tool, input }) => {
    const key = `${agent}:${tool}`;
    if (allowAll.current.has(key)) return { allow: true };
    if (!abortRef.current || abortRef.current.signal.aborted) return { allow: false, message: 'The run was cancelled.' };
    const d = describeAction(tool, input);
    const what = d.kind === 'command' ? 'commands' : d.kind === 'edit' ? 'file edits' : tool;
    const v = await pick(`${AGENTS[agent]?.name || agent} wants to ${d.title}`, [
      { value: 'yes', label: 'Yes', description: 'allow this once' },
      { value: 'all', label: `Yes, and don't ask again`, description: `for ${AGENTS[agent]?.name || agent} ${what} this run` },
      { value: 'no', label: 'No', description: 'deny it' },
      { value: 'why', label: 'No, and say why…', description: 'tell the agent what to do instead' },
    ], { body: d.detail });
    if (v === 'yes') return { allow: true };
    if (v === 'all') {
      allowAll.current.add(key);
      return { allow: true };
    }
    if (v === 'why') {
      const msg = await ask('What should it do instead?');
      return { allow: false, message: msg ? `The user denied this and said: ${msg}` : 'The user denied this action.' };
    }
    return { allow: false, message: 'The user denied this action.' };
  };

  useEffect(() => {
    let srv;
    startApprovalServer((req) => {
      const p = approvalQueue.current.then(() => askApproval(req));
      approvalQueue.current = p.catch(() => {});
      return p;
    }).then((s) => {
      srv = s;
      approvalSrv.current = s;
    });
    return () => srv?.close();
  }, []);

  const agentOptions = () => Object.keys(AGENTS).map((a) => ({ value: a, label: AGENTS[a].name, description: a }));
  const modelOptions = (agent) => [...(agent === 'codex' ? codexModels() : CLAUDE_MODELS), { value: '__custom', label: 'Custom…', description: 'type any model id' }];

  const pickModel = async (agent, current, title) => {
    let m = await pick(title || `Model for ${AGENTS[agent].name}`, modelOptions(agent), { current });
    if (m === '__custom') m = await ask(`Model id for ${AGENTS[agent].name}`, current === 'default' ? '' : current);
    return m || null;
  };
  const pickEffort = (agent, current, title) =>
    pick(title || `Reasoning effort for ${AGENTS[agent].name}`, EFFORTS[agent].map((e) => ({ value: e, label: e, description: e === 'default' ? `use ${agent}'s own setting` : '' })), { current });

  const cmdMode = async () => {
    const m = await pick('Mode', Object.entries(MODES).map(([value, x]) => ({ value, ...x })), { current: cfg.current.mode });
    if (!m) return false;
    setConfig((c) => ((c.mode = m), c));
    if (m === 'single') {
      const a = await pick('Talk to which agent?', agentOptions(), { current: cfg.current.singleAgent });
      if (a) setConfig((c) => ((c.singleAgent = a), c));
    }
    info(`Mode: ${MODES[m].label}${m === 'single' ? ` with ${AGENTS[cfg.current.singleAgent].name}` : ''} — ${MODES[m].description}`);
    return true;
  };

  const cmdOrchestrator = async () => {
    const a = await pick('Who orchestrates?', agentOptions().map((o) => ({ ...o, description: 'plans the work, hands out tasks, writes the final answer' })), { current: cfg.current.orchestrator.agent });
    if (!a) return false;
    const m = await pickModel(a, a === cfg.current.orchestrator.agent ? cfg.current.orchestrator.model : 'default', `Orchestrator model (${AGENTS[a].name})`);
    if (!m) return false;
    const e = await pickEffort(a, a === cfg.current.orchestrator.agent ? cfg.current.orchestrator.effort : 'default', 'Orchestrator effort');
    setConfig((c) => ((c.orchestrator = { agent: a, model: m, effort: e || 'default' }), c));
    const wasOther = cfg.current.mode !== 'orchestrate';
    if (wasOther) setConfig((c) => ((c.mode = 'orchestrate'), c));
    info(`Orchestrator: ${AGENTS[a].name} · ${m} · effort ${e || 'default'}${wasOther ? ' (switched to Orchestrate mode)' : ''}`);
    return true;
  };

  const cmdModel = async () => {
    const a = await pick('Set the default model for…', agentOptions().map((o) => ({ ...o, description: modelName(o.value, cfg.current.models[o.value]) })));
    if (!a) return false;
    const m = await pickModel(a, cfg.current.models[a]);
    if (!m) return false;
    setConfig((c) => ((c.models[a] = m), c));
    info(`${AGENTS[a].name} model: ${modelName(a, m)}`);
    return true;
  };

  const cmdEffort = async () => {
    const a = await pick('Set reasoning effort for…', agentOptions().map((o) => ({ ...o, description: effortName(o.value, cfg.current.effort[o.value]) })));
    if (!a) return false;
    const e = await pickEffort(a, cfg.current.effort[a]);
    if (!e) return false;
    setConfig((c) => ((c.effort[a] = e), c));
    info(`${AGENTS[a].name} effort: ${effortName(a, e)}`);
    return true;
  };

  const cmdAgents = async () => {
    for (;;) {
      const a = await pick(
        'Agents (enter toggles)',
        [...agentOptions().map((o) => ({ ...o, label: `${cfg.current.agents[o.value] ? '◉' : '○'} ${o.label}`, description: cfg.current.agents[o.value] ? 'on' : 'off' })), { value: '__done', label: 'Done', description: '' }],
      );
      if (!a || a === '__done') break;
      setConfig((c) => ((c.agents[a] = !c.agents[a]), c));
    }
    const on = Object.keys(AGENTS).filter((a) => cfg.current.agents[a]);
    info(on.length ? `Agents on: ${on.map((a) => AGENTS[a].name).join(', ')}` : 'All agents are off — turn one back on with /agents.');
    return true;
  };

  const toggleWrite = () => {
    setConfig((c) => ((c.access = c.access === 'write' ? 'research' : 'write'), c));
    if (cfg.current.access === 'write') {
      add({ type: 'warn', text: `Write mode: agents can edit files and run commands in ${tildify(cwdRef.current)}.${cfg.current.isolation === 'worktree' ? ' In parallel mode each agent gets its own git worktree.' : ''} /write again to go back to read-only.` });
    } else info('Read-only: agents can read files and search the web, but not change anything.');
  };

  const cmdSettings = async () => {
    for (;;) {
      const c = cfg.current;
      const onOff = (b) => (b ? 'on' : 'off');
      const key = await pick('Settings', [
        { value: 'mode', label: 'Mode', description: MODES[c.mode].label },
        { value: 'orch', label: 'Orchestrator', description: `${AGENTS[c.orchestrator.agent].name} · ${c.orchestrator.model} · effort ${c.orchestrator.effort}` },
        { value: 'single', label: 'Single-mode agent', description: AGENTS[c.singleAgent].name },
        { value: 'agents', label: 'Agents on', description: Object.keys(AGENTS).filter((a) => c.agents[a]).join(', ') || 'none' },
        { value: 'claudeModel', label: 'Claude model', description: modelName('claude', c.models.claude) },
        { value: 'claudeEffort', label: 'Claude effort', description: effortName('claude', c.effort.claude) },
        { value: 'codexModel', label: 'Codex model', description: modelName('codex', c.models.codex) },
        { value: 'codexEffort', label: 'Codex effort', description: effortName('codex', c.effort.codex) },
        { value: 'merge', label: 'Merge answers', description: c.merge.enabled ? `on · ${AGENTS[c.merge.agent].name} · ${c.merge.model}` : 'off' },
        { value: 'access', label: 'Access', description: accessName(c) },
        { value: 'web', label: 'Web search', description: onOff(c.webSearch) },
        { value: 'isolation', label: 'Write isolation', description: c.isolation === 'worktree' ? 'separate git worktree per agent' : 'shared folder' },
        { value: 'approvals', label: 'Write approvals', description: { commands: 'ask before Claude runs commands', everything: 'ask before every command and edit', never: 'never ask (Claude runs anything)' }[c.approvals] + ' · Codex stays sandboxed' },
        { value: 'approval', label: 'Plan approval', description: c.planApproval === 'ask' ? 'ask before running a plan' : 'run plans right away' },
        { value: 'maxTasks', label: 'Max tasks per plan', description: String(c.maxTasks) },
        { value: 'maxParallel', label: 'Tasks at once', description: String(c.maxParallel) },
        { value: 'activity', label: 'Activity lines', description: `${c.activityLines} per agent while working` },
        { value: 'memory', label: 'Remember context', description: c.rememberContext ? 'follow-ups continue the conversation' : 'every prompt starts fresh' },
        { value: 'lean', label: 'Lean mode', description: c.lean ? 'on · skips your MCP servers + skills (much cheaper)' : 'off · loads your full Claude Code setup' },
        { value: 'reset', label: 'Reset to defaults', description: '' },
        { value: 'done', label: 'Done', description: '' },
      ]);
      if (!key || key === 'done') break;
      const num = async (title, cur, min, max) => {
        const v = Number(await ask(title, String(cur), `a number from ${min} to ${max}`));
        return Number.isFinite(v) && v >= min && v <= max ? Math.round(v) : null;
      };
      switch (key) {
        case 'mode': await cmdMode(); break;
        case 'orch': await cmdOrchestrator(); break;
        case 'single': {
          const a = await pick('Single-mode agent', agentOptions(), { current: c.singleAgent });
          if (a) setConfig((x) => ((x.singleAgent = a), x));
          break;
        }
        case 'agents': await cmdAgents(); break;
        case 'claudeModel': case 'codexModel': {
          const a = key.startsWith('claude') ? 'claude' : 'codex';
          const m = await pickModel(a, c.models[a]);
          if (m) setConfig((x) => ((x.models[a] = m), x));
          break;
        }
        case 'claudeEffort': case 'codexEffort': {
          const a = key.startsWith('claude') ? 'claude' : 'codex';
          const e = await pickEffort(a, c.effort[a]);
          if (e) setConfig((x) => ((x.effort[a] = e), x));
          break;
        }
        case 'merge': {
          const v = await pick('Merge answers in parallel mode', [
            { value: 'off', label: 'Off', description: 'just show each answer' },
            ...Object.keys(AGENTS).map((a) => ({ value: a, label: `On, merged by ${AGENTS[a].name}`, description: '' })),
          ], { current: c.merge.enabled ? c.merge.agent : 'off' });
          if (!v) break;
          if (v === 'off') setConfig((x) => ((x.merge.enabled = false), x));
          else {
            const m = await pickModel(v, v === c.merge.agent ? c.merge.model : 'default', 'Model for merging');
            if (m) setConfig((x) => ((x.merge = { enabled: true, agent: v, model: m }), x));
          }
          break;
        }
        case 'access': toggleWrite(); break;
        case 'web': setConfig((x) => ((x.webSearch = !x.webSearch), x)); break;
        case 'isolation': setConfig((x) => ((x.isolation = x.isolation === 'worktree' ? 'shared' : 'worktree'), x)); break;
        case 'approvals': {
          const v = await pick('When should Claude Code ask before acting in write mode?', [
            { value: 'commands', label: 'Commands', description: 'edits are fine, ask before shell commands' },
            { value: 'everything', label: 'Everything', description: 'ask before every command and every file edit' },
            { value: 'never', label: 'Never', description: 'run anything without asking' },
          ], { current: c.approvals, hint: 'Codex always runs in its own sandbox: it can only write inside the folder and has no network.' });
          if (v) setConfig((x) => ((x.approvals = v), x));
          break;
        }
        case 'approval': setConfig((x) => ((x.planApproval = x.planApproval === 'ask' ? 'auto' : 'ask'), x)); break;
        case 'lean': setConfig((x) => ((x.lean = !x.lean), x)); break;
        case 'memory': setConfig((x) => ((x.rememberContext = !x.rememberContext), x)); break;
        case 'maxTasks': { const n = await num('Max tasks per plan', c.maxTasks, 1, 12); if (n) setConfig((x) => ((x.maxTasks = n), x)); break; }
        case 'maxParallel': { const n = await num('How many tasks can run at once', c.maxParallel, 1, 8); if (n) setConfig((x) => ((x.maxParallel = n), x)); break; }
        case 'activity': { const n = await num('Activity lines per agent', c.activityLines, 0, 10); if (n !== null) setConfig((x) => ((x.activityLines = n), x)); break; }
        case 'reset': {
          const ok = await pick('Reset every setting to the default?', [{ value: 'yes', label: 'Yes, reset' }, { value: 'no', label: 'No' }]);
          if (ok === 'yes') setConfig(structuredClone(DEFAULTS));
          break;
        }
      }
    }
    info('Settings saved to ~/.duo/config.json');
  };

  const cmdCwd = async (arg) => {
    let p = arg || (await ask('Folder for the agents to work in', cwdRef.current));
    if (!p) return;
    p = path.resolve(cwdRef.current, p.replace(/^~(?=$|\/)/, process.env.HOME));
    if (!fs.existsSync(p) || !fs.statSync(p).isDirectory()) return add({ type: 'error', text: `Not a folder: ${p}` });
    cwdRef.current = p;
    setCwdState(p);
    info(`Working in ${tildify(p)}`);
  };

  const runCommand = async (text) => {
    const [name, ...rest] = text.trim().split(/\s+/);
    const arg = rest.join(' ');
    const cmd = COMMANDS.find((c) => c.name === name.toLowerCase()) || COMMANDS.find((c) => c.name.startsWith(name.toLowerCase()));
    if (!cmd) return add({ type: 'error', text: `Unknown command ${name}. Type /help to see them all.` });
    switch (cmd.name) {
      case '/help': return add({ type: 'help' });
      case '/mode':
        if (MODES[arg]) {
          setConfig((c) => ((c.mode = arg), c));
          return info(`Mode: ${MODES[arg].label} — ${MODES[arg].description}`);
        }
        return cmdMode();
      case '/orchestrator': return cmdOrchestrator();
      case '/model': return cmdModel();
      case '/effort': return cmdEffort();
      case '/agents': return cmdAgents();
      case '/settings': return cmdSettings();
      case '/write': return toggleWrite();
      case '/new':
        sessions.current = {};
        return info('Fresh start — the agents won’t remember earlier prompts.');
      case '/diff': {
        const t = lastTrees.current;
        if (!t) return info('No changes to show — /diff works after a parallel run in write mode.');
        const want = t.list.filter((wt) => !arg || wt.agent.startsWith(arg.toLowerCase()));
        if (!want.length) return add({ type: 'error', text: `No agent called ${arg} in the last run.` });
        for (const wt of want) {
          try {
            add({ type: 'diff', agent: wt.agent, branch: wt.branch, base: wt.base, patch: diffWorktree(t.root, wt).patch });
          } catch (e) {
            add({ type: 'error', text: `Couldn’t diff ${wt.branch}: ${e.message}` });
          }
        }
        return;
      }
      case '/keep': {
        const t = lastTrees.current;
        if (!t) return info('Nothing to keep — /keep works after a parallel run in write mode.');
        const stats = Object.fromEntries(t.list.map((wt) => {
          try {
            const s = diffWorktree(t.root, wt).stat.trim().split('\n').pop() || 'no changes';
            return [wt.agent, s.trim()];
          } catch {
            return [wt.agent, ''];
          }
        }));
        let choice;
        for (;;) {
          choice = await pick('Keep whose changes?', [
            ...t.list.map((wt) => ({ value: wt.agent, label: `${AGENTS[wt.agent].name}'s version`, description: stats[wt.agent] })),
            { value: '__diff', label: 'Show the diffs first', description: '' },
            { value: '__none', label: 'Neither', description: 'throw away both' },
            { value: '__later', label: 'Decide later', description: 'leave the branches as they are' },
          ]);
          if (choice !== '__diff') break;
          await runCommand('/diff');
        }
        if (!choice || choice === '__later') return;
        if (choice !== '__none') {
          try {
            mergeWorktree(t.root, t.list.find((w) => w.agent === choice));
            info(`Merged ${AGENTS[choice].name}'s changes into ${tildify(t.root)}.`);
          } catch (e) {
            return add({ type: 'error', text: `Merge failed (your repo may have conflicting changes): ${e.stderr || e.message}` });
          }
        }
        removeWorktrees(t.root, t.list);
        lastTrees.current = null;
        return info('Cleaned up the worktrees and branches.');
      }
      case '/cwd': return cmdCwd(arg);
      case '/copy':
        if (!lastAnswer.current) return info('Nothing to copy yet.');
        try {
          execFileSync('pbcopy', { input: lastAnswer.current });
          return info('Copied the last answer to the clipboard.');
        } catch (e) {
          return add({ type: 'error', text: `Couldn’t copy: ${e.message}` });
        }
      case '/runs':
        fs.mkdirSync(path.join(DUO_DIR, 'runs'), { recursive: true });
        spawn('open', [path.join(DUO_DIR, 'runs')], { stdio: 'ignore', detached: true }).unref();
        return info(`Opened ${tildify(path.join(DUO_DIR, 'runs'))}`);
      case '/status': return add({ type: 'header', config: cfg.current, cwd: cwdRef.current });
      case '/clear': return clearScreen();
      case '/quit': return quit();
    }
  };

  const ui = {
    add,
    phase: setPhase,
    lane: (l) => {
      const id = uid();
      setLanes((ls) => [...ls, { id, status: 'queued', activity: [], ...l }]);
      return id;
    },
    update: (id, patch) => setLanes((ls) => ls.map((l) => (l.id === id ? { ...l, ...patch } : l))),
    activity: (id, line) => setLanes((ls) => ls.map((l) => (l.id === id ? { ...l, activity: [...l.activity.slice(-20), line] } : l))),
    done: (id, item) => {
      setLanes((ls) => ls.filter((l) => l.id !== id));
      if (item) {
        add(item);
        if (item.type === 'answer') lastAnswer.current = item.text;
      }
    },
    spend: (cost, tokens) => setSpent((s) => ({ cost: s.cost + (cost || 0), tokens: s.tokens + (tokens || 0) })),
    choose: ({ title, options }) => pick(title, options),
  };

  const submit = async (raw) => {
    const text = raw.trim();
    if (!text) return;
    const h = [...history.filter((x) => x !== text), text];
    setHistory(h);
    saveHistory(h);
    if (text.startsWith('/')) {
      setBusy(true);
      try {
        await runCommand(text);
      } finally {
        setBusy(false);
      }
      return;
    }
    let prompt = text;
    let route = null;
    const m = text.match(/^@(claude|codex)\b\s*([\s\S]*)$/i);
    if (m) {
      route = m[1].toLowerCase();
      prompt = m[2].trim();
      if (!prompt) return info(`Type a prompt after @${route}.`);
    }
    add({ type: 'user', text: prompt, route });
    const ac = new AbortController();
    abortRef.current = ac;
    allowAll.current = new Set();
    setBusy(true);
    try {
      const res = await runPrompt({ config: cfg.current, cwd: cwdRef.current, sessions: sessions.current, signal: ac.signal, ui, approval: approvalSrv.current }, prompt, route);
      if (res.final) lastAnswer.current = res.final;
      if (res.trees) lastTrees.current = res.trees;
      if (!ac.signal.aborted) info(`Saved to ${tildify(res.runDir)}`);
    } catch (e) {
      add({ type: 'error', text: e.stack || e.message });
    } finally {
      abortRef.current = null;
      setLanes([]);
      setPhase(null);
      setBusy(false);
    }
  };

  useEffect(() => {
    if (initialPrompt) submit(initialPrompt);
  }, []);

  const boxW = Math.max(40, width - 2);
  return html`
    <${Box} flexDirection="column">
      <${Static} key=${staticKey} items=${items}>${(item) => html`<${Item} key=${item.id} item=${item} width=${boxW} />`}</${Static}>
      ${lanes.length || phase ? html`<${Live} phase=${phase} lanes=${lanes} activityLines=${config.activityLines} width=${boxW} busy=${busy} />` : null}
      ${dialog?.kind === 'select'
        ? html`<${Select} key=${dialog.title} ...${dialog} width=${Math.min(boxW, 100)} />`
        : dialog?.kind === 'text'
          ? html`<${TextPrompt} key=${dialog.title} ...${dialog} width=${Math.min(boxW, 100)} />`
          : html`<${PromptInput} active=${!busy} onSubmit=${submit} onExit=${quit} onClear=${clearScreen} history=${history} width=${boxW} config=${config} spent=${spent} />`}
    </${Box}>`;
}
