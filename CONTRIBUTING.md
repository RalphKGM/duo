# Contributing to duo

Thanks for helping! duo is small on purpose, so it's easy to get around:

```
cli.js            entry point (args → Ink app)
lib/agents.js     adapters that run each CLI headless and stream its events
lib/engine.js     parallel / orchestrate / single modes, plan scheduling
lib/git.js        worktree isolation for write mode
lib/config.js     settings, defaults, model lists
ui/app.js         the terminal UI: transcript, live panels, commands, settings
ui/components.js  pickers, text editing, Markdown rendering
```

## Run it locally

```bash
git clone https://github.com/RalphKGM/duo.git
cd duo && npm install
node cli.js
```

## Adding a new agent

1. Add it to `AGENTS` in `lib/agents.js` (name + color).
2. Write a `runYourAgent(opts)` adapter that spawns the CLI, calls `opts.onActivity(line)` for progress, and resolves `{ ok, text, sessionId, cost, tokens, ms, error }`.
3. Add its model/effort options in `lib/config.js`.

## Pull requests

- Keep PRs focused, and describe how you tested (a screenshot or terminal paste helps).
- Never commit API keys or anything from `~/.duo`.
