import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DUO_DIR = path.join(os.homedir(), '.duo');
const CONFIG_FILE = path.join(DUO_DIR, 'config.json');
const HISTORY_FILE = path.join(DUO_DIR, 'history.json');

export const DEFAULTS = {
  mode: 'parallel',
  agents: { claude: true, codex: true },
  singleAgent: 'claude',
  models: { claude: 'default', codex: 'default' },
  effort: { claude: 'default', codex: 'default' },
  orchestrator: { agent: 'claude', model: 'opus', effort: 'default' },
  merge: { enabled: true, agent: 'claude', model: 'sonnet' },
  access: 'research',
  webSearch: true,
  isolation: 'worktree',
  planApproval: 'ask',
  approvals: 'commands',
  maxTasks: 6,
  maxParallel: 4,
  activityLines: 3,
  rememberContext: true,
  lean: true,
};

function deepMerge(base, over) {
  if (typeof base !== 'object' || base === null || Array.isArray(base)) return over ?? base;
  const out = { ...base };
  for (const k of Object.keys(over || {})) {
    out[k] = k in base ? deepMerge(base[k], over[k]) : over[k];
  }
  return out;
}

export function loadConfig() {
  try {
    return deepMerge(DEFAULTS, JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')));
  } catch {
    return structuredClone(DEFAULTS);
  }
}

export function saveConfig(cfg) {
  fs.mkdirSync(DUO_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

export function loadHistory() {
  try {
    return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
  } catch {
    return [];
  }
}

export function saveHistory(list) {
  try {
    fs.mkdirSync(DUO_DIR, { recursive: true });
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(list.slice(-300)));
  } catch {}
}

export function codexDefaults() {
  try {
    const t = fs.readFileSync(path.join(os.homedir(), '.codex', 'config.toml'), 'utf8');
    const top = t.split(/^\[/m)[0];
    return {
      model: top.match(/^model\s*=\s*"([^"]+)"/m)?.[1],
      effort: top.match(/^model_reasoning_effort\s*=\s*"([^"]+)"/m)?.[1],
    };
  } catch {
    return {};
  }
}

export function claudeDefaults() {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'settings.json'), 'utf8'));
    return { model: s.model, effort: s.effortLevel };
  } catch {
    return {};
  }
}

export const CLAUDE_MODELS = [
  { value: 'default', label: 'Default', description: 'whatever Claude Code is set to' },
  { value: 'opus', label: 'Opus', description: 'most capable, slower, pricier' },
  { value: 'sonnet', label: 'Sonnet', description: 'fast and strong, good default for workers' },
  { value: 'haiku', label: 'Haiku', description: 'fastest and cheapest' },
  { value: 'claude-fable-5-1', label: 'Fable 5.1', description: 'claude-fable-5-1' },
];

export function codexModels() {
  const base = [{ value: 'default', label: 'Default', description: `from ~/.codex/config.toml (${codexDefaults().model || 'codex default'})` }];
  try {
    const d = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.codex', 'models_cache.json'), 'utf8'));
    const list = Array.isArray(d) ? d : d.models || [];
    for (const m of list) {
      if (m.visibility && m.visibility !== 'list') continue;
      const slug = m.slug || m.id;
      if (slug) base.push({ value: slug, label: m.display_name || slug, description: slug });
    }
  } catch {}
  if (base.length === 1) base.push({ value: 'gpt-5-codex', label: 'gpt-5-codex', description: '' });
  return base;
}

export const EFFORTS = {
  claude: ['default', 'low', 'medium', 'high', 'xhigh', 'max'],
  codex: ['default', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
};
