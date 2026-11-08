import React, { useState, useEffect, useRef } from 'react';
import { Box, Text, useInput } from 'ink';
import htm from 'htm';
import { Marked } from 'marked';
import { markedTerminal } from 'marked-terminal';
import os from 'node:os';
import { AGENTS } from '../lib/agents.js';

export const html = htm.bind(React.createElement);

export const T = {
  accent: '#C3A6FF',
  claude: AGENTS.claude.color,
  codex: AGENTS.codex.color,
  dim: 'gray',
  ok: '#7BD88F',
  warn: '#E5C07B',
  err: '#F7768E',
};
export const agentColor = (a) => T[a] || T.accent;
export const tildify = (p) => (p.startsWith(os.homedir()) ? '~' + p.slice(os.homedir().length) : p);

export const fmtMs = (ms) => {
  const s = Math.round((ms || 0) / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
};
export const fmtTokens = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : `${n || 0}`);

export function metaLine({ model, ms, cost, tokens }) {
  return [model && model !== 'default' ? model : null, ms ? fmtMs(ms) : null, cost ? `$${cost.toFixed(2)}` : tokens ? `${fmtTokens(tokens)} tokens` : null]
    .filter(Boolean)
    .join(' · ');
}

const mdCache = new Map();
export function renderMd(text, width) {
  const w = Math.max(40, Math.min(width, 110));
  if (!mdCache.has(w)) {
    const m = new Marked();
    m.use(markedTerminal({ width: w, reflowText: true, tab: 2, showSectionPrefix: false, emoji: false }));
    mdCache.set(w, m);
  }
  try {
    return mdCache.get(w).parse(fitTables(String(text ?? ''), w)).replace(/\n{3,}/g, '\n\n').trimEnd();
  } catch {
    return String(text ?? '');
  }
}

function fitTables(md, width) {
  const lines = md.split('\n');
  const out = [];
  const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
  for (let i = 0; i < lines.length; i++) {
    const isTable = /^\s*\|.*\|\s*$/.test(lines[i]) && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] || '');
    if (!isTable) {
      out.push(lines[i]);
      continue;
    }
    const block = [];
    while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) block.push(lines[i++]);
    i--;
    const [head, , ...rows] = block.map(cells);
    const widths = head.map((_, c) => Math.max(...[head, ...rows].map((r) => (r[c] || '').length)));
    if (widths.reduce((a, b) => a + b + 3, 1) <= width) {
      out.push(...block);
      continue;
    }
    for (const r of rows) {
      out.push('', `**${r[0] || ''}**`);
      head.slice(1).forEach((h, c) => r[c + 1] && out.push(`- ${h ? `${h}: ` : ''}${r[c + 1]}`));
    }
    out.push('');
  }
  return out.join('\n');
}

const FRAMES = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢'];
export function useTick(ms = 120, active = true) {
  const [t, setT] = useState(0);
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setT((x) => x + 1), ms);
    return () => clearInterval(id);
  }, [active, ms]);
  return t;
}
export const frame = (t) => FRAMES[t % FRAMES.length];

export function Select({ title, hint, body, options, initial = 0, onSelect, onCancel, width }) {
  const [i, setI] = useState(Math.max(0, Math.min(initial, options.length - 1)));
  useInput((input, key) => {
    if (key.upArrow || input === 'k') setI((x) => (x - 1 + options.length) % options.length);
    else if (key.downArrow || input === 'j') setI((x) => (x + 1) % options.length);
    else if (key.return) onSelect(options[i]);
    else if (key.escape || (key.ctrl && input === 'c')) onCancel?.();
    else if (/^[1-9]$/.test(input) && options[Number(input) - 1]) onSelect(options[Number(input) - 1]);
  });
  const labelW = Math.min(34, Math.max(...options.map((o) => o.label.length)) + 2);
  return html`
    <${Box} flexDirection="column" borderStyle="round" borderColor=${T.accent} paddingX=${1} width=${width}>
      <${Text} bold color=${T.accent}>${title}</${Text}>
      ${hint ? html`<${Text} color=${T.dim}>${hint}</${Text}>` : null}
      ${body ? html`<${Box} marginTop=${1} paddingX=${1} borderStyle="single" borderColor=${T.dim}><${Text}>${body}</${Text}></${Box}>` : null}
      <${Box} flexDirection="column" marginTop=${1}>
        ${options.map(
          (o, idx) => html`
            <${Box} key=${idx}>
              <${Text} color=${idx === i ? T.accent : undefined} bold=${idx === i}>
                ${idx === i ? '❯ ' : '  '}${idx < 9 ? `${idx + 1}. ` : '   '}${o.label.padEnd(labelW)}
              </${Text}>
              <${Text} color=${o.current ? T.ok : T.dim}>${o.current ? '✓ ' : ''}${o.description || ''}</${Text}>
            </${Box}>`,
        )}
      </${Box}>
      <${Box} marginTop=${1}><${Text} color=${T.dim}>↑/↓ to move · enter to pick · esc to go back</${Text}></${Box}>
    </${Box}>`;
}

export function useLineEditor(initial = '') {
  const st = useRef({ value: initial, cursor: initial.length });
  const [, force] = useState(0);
  const set = (value, cursor = value.length) => {
    st.current = { value, cursor: Math.max(0, Math.min(cursor, value.length)) };
    force((x) => x + 1);
  };
  const handle = (input, key) => {
    const { value: v, cursor: c } = st.current;
    if (key.leftArrow) return set(v, key.meta ? wordLeft(v, c) : c - 1), true;
    if (key.rightArrow) return set(v, key.meta ? wordRight(v, c) : c + 1), true;
    if (key.backspace || key.delete) return c > 0 && set(v.slice(0, c - 1) + v.slice(c), c - 1), true;
    if (key.ctrl && input === 'a') return set(v, 0), true;
    if (key.ctrl && input === 'e') return set(v, v.length), true;
    if (key.ctrl && input === 'u') return set(v.slice(c), 0), true;
    if (key.ctrl && input === 'k') return set(v.slice(0, c), c), true;
    if (key.ctrl && input === 'w') {
      const w = wordLeft(v, c);
      return set(v.slice(0, w) + v.slice(c), w), true;
    }
    if (input && !key.ctrl && !key.meta && !key.escape && !key.return && !key.tab) {
      const text = input.replace(/\r\n?/g, '\n').replace(/\x1b\[[0-9;]*[~A-Za-z]/g, '');
      if (text) set(v.slice(0, c) + text + v.slice(c), c + text.length);
      return true;
    }
    return false;
  };
  return { get value() { return st.current.value; }, get cursor() { return st.current.cursor; }, set, handle };
}
const wordLeft = (v, c) => {
  let i = c;
  while (i > 0 && /\s/.test(v[i - 1])) i--;
  while (i > 0 && !/\s/.test(v[i - 1])) i--;
  return i;
};
const wordRight = (v, c) => {
  let i = c;
  while (i < v.length && /\s/.test(v[i])) i++;
  while (i < v.length && !/\s/.test(v[i])) i++;
  return i;
};

export function EditorText({ value, cursor, placeholder, showCursor = true }) {
  if (!value) {
    return html`<${Text}>${showCursor ? html`<${Text} inverse>${placeholder?.[0] || ' '}</${Text}>` : null}<${Text} color=${T.dim}>${(placeholder || '').slice(showCursor ? 1 : 0)}</${Text}></${Text}>`;
  }
  const before = value.slice(0, cursor);
  const at = value[cursor];
  const after = value.slice(cursor + 1);
  return html`<${Text}>${before}${showCursor ? html`<${Text} inverse>${at === '\n' || at == null ? ' ' : at}</${Text}>` : at ?? ''}${at === '\n' ? '\n' : ''}${after}</${Text}>`;
}

export function TextPrompt({ title, hint, initial = '', onSubmit, onCancel, width }) {
  const ed = useLineEditor(initial);
  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === 'c')) return onCancel?.();
    if (key.return) return onSubmit(ed.value.trim());
    ed.handle(input, key);
  });
  return html`
    <${Box} flexDirection="column" borderStyle="round" borderColor=${T.accent} paddingX=${1} width=${width}>
      <${Text} bold color=${T.accent}>${title}</${Text}>
      ${hint ? html`<${Text} color=${T.dim}>${hint}</${Text}>` : null}
      <${Box} marginTop=${1}><${Text} color=${T.accent}>❯ </${Text}><${EditorText} value=${ed.value} cursor=${ed.cursor} /></${Box}>
      <${Box} marginTop=${1}><${Text} color=${T.dim}>enter to save · esc to go back</${Text}></${Box}>
    </${Box}>`;
}
