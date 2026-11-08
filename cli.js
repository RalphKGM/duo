#!/usr/bin/env node
import React from 'react';
import { render } from 'ink';
import fs from 'node:fs';
import path from 'node:path';
import { App } from './ui/app.js';

const args = process.argv.slice(2);
if (args.includes('-h') || args.includes('--help')) {
  console.log(`duo — Claude Code + Codex, working together

  duo                 open duo
  duo "question"      open duo and ask right away
  duo -d <folder>     work in another folder

Inside duo, type /help for commands.`);
  process.exit(0);
}

let cwd = process.cwd();
const di = args.findIndex((a) => a === '-d' || a === '--dir');
if (di >= 0) {
  cwd = path.resolve(args[di + 1] || '.');
  args.splice(di, 2);
  if (!fs.existsSync(cwd)) {
    console.error(`No such folder: ${cwd}`);
    process.exit(1);
  }
}

if (!process.stdin.isTTY) {
  console.error('duo needs an interactive terminal.');
  process.exit(1);
}

const { waitUntilExit } = render(React.createElement(App, { initialPrompt: args.join(' ').trim(), initialCwd: cwd }), {
  exitOnCtrlC: false,
});
await waitUntilExit();
process.exit(0);
