import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const APPROVE_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'approve-mcp.js');

export function startApprovalServer(handler) {
  const token = crypto.randomBytes(16).toString('hex');
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(403).end();
      return;
    }
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', async () => {
      let out;
      try {
        out = await handler(JSON.parse(body));
      } catch (e) {
        out = { allow: false, message: e.message };
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(out));
    });
  });
  server.requestTimeout = 0;
  server.headersTimeout = 0;
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ url: `http://127.0.0.1:${server.address().port}/approve`, token, close: () => server.close() });
    });
  });
}

export function describeAction(tool, input = {}) {
  switch (tool) {
    case 'Bash':
      return { kind: 'command', title: 'run a command', detail: `$ ${input.command}` };
    case 'Edit':
    case 'MultiEdit':
      return { kind: 'edit', title: `edit ${path.basename(input.file_path || '')}`, detail: input.file_path };
    case 'Write':
      return { kind: 'edit', title: `write ${path.basename(input.file_path || '')}`, detail: input.file_path };
    default:
      return { kind: 'other', title: `use ${tool}`, detail: JSON.stringify(input).slice(0, 300) };
  }
}
