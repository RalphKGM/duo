#!/usr/bin/env node
import readline from 'node:readline';

const URL_ = process.env.DUO_APPROVE_URL;
const TOKEN = process.env.DUO_APPROVE_TOKEN;
const AGENT = process.env.DUO_AGENT || 'claude';

const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');

async function decide(args) {
  try {
    const res = await fetch(URL_, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ agent: AGENT, tool: args.tool_name, input: args.input || {} }),
    });
    const d = await res.json();
    return d.allow
      ? { behavior: 'allow', updatedInput: args.input || {} }
      : { behavior: 'deny', message: d.message || 'The user denied this action.' };
  } catch (e) {
    return { behavior: 'deny', message: `Approval unavailable: ${e.message}` };
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = msg;
  if (id === undefined) return;
  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: params?.protocolVersion || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'duo', version: '0.1.0' },
      },
    });
  } else if (method === 'tools/list') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        tools: [
          {
            name: 'approve',
            description: 'Asks the duo user to approve a tool call. Used by the permission system only; do not call it yourself.',
            inputSchema: {
              type: 'object',
              properties: { tool_name: { type: 'string' }, input: { type: 'object' }, tool_use_id: { type: 'string' } },
              required: ['tool_name', 'input'],
            },
          },
        ],
      },
    });
  } else if (method === 'tools/call') {
    const out = await decide(params?.arguments || {});
    send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(out) }] } });
  } else if (method === 'ping') {
    send({ jsonrpc: '2.0', id, result: {} });
  } else {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown method ${method}` } });
  }
});
