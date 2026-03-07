#!/usr/bin/env node
/**
 * MCP stdio-to-HTTP proxy for Dynamics 365 Finance & Operations.
 *
 * Claude Code communicates with MCP servers over stdio (JSON-RPC on stdin/stdout).
 * The D365 F&O MCP server is a remote HTTP endpoint requiring Azure AD Bearer auth.
 * This proxy bridges the two worlds:
 *   stdin (JSON-RPC from Claude Code) → HTTP POST (to D365 MCP endpoint) → stdout (JSON-RPC back)
 *
 * Authentication: uses Azure CLI (`az account get-access-token`) to obtain OAuth2 tokens.
 */
import { execSync } from 'child_process';
import { createInterface } from 'readline';

// ── Configuration ──────────────────────────────────────────────────────────────
// Replace with your Dynamics 365 F&O environment URL
const MCP_URL  = 'https://YOUR-ENVIRONMENT.sandbox.operations.dynamics.com/mcp';
const RESOURCE = 'https://YOUR-ENVIRONMENT.sandbox.operations.dynamics.com';
// ───────────────────────────────────────────────────────────────────────────────

function getToken() {
  const token = execSync(
    `az account get-access-token --resource "${RESOURCE}" --query accessToken -o tsv`,
    { encoding: 'utf-8' }
  ).replace(/[\r\n]/g, '');
  return token;
}

let token = getToken();
let sessionId = null;

// Azure AD tokens expire after ~60 min; refresh every 45 min to stay ahead.
setInterval(() => {
  try {
    token = getToken();
    process.stderr.write('[mcp-proxy] Token refreshed\n');
  } catch (e) {
    process.stderr.write(`[mcp-proxy] Token refresh failed: ${e.message}\n`);
  }
}, 45 * 60 * 1000);

const rl = createInterface({ input: process.stdin, terminal: false });

rl.on('line', async (line) => {
  if (!line.trim()) return;

  try {
    const message = JSON.parse(line);

    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'Authorization': `Bearer ${token}`,
    };
    if (sessionId) {
      headers['mcp-session-id'] = sessionId;
    }

    const response = await fetch(MCP_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify(message),
    });

    // Capture session ID from response
    const newSessionId = response.headers.get('mcp-session-id');
    if (newSessionId) {
      sessionId = newSessionId;
    }

    const contentType = response.headers.get('content-type') || '';

    if (contentType.includes('text/event-stream')) {
      // SSE response — parse individual data events
      const text = await response.text();
      for (const chunk of text.split('\n')) {
        if (chunk.startsWith('data: ')) {
          const data = chunk.slice(6).trim();
          if (data) {
            process.stdout.write(data + '\n');
          }
        }
      }
    } else {
      // Regular JSON response
      const text = await response.text();
      if (text.trim()) {
        process.stdout.write(text.trim() + '\n');
      }
    }
  } catch (err) {
    // Send JSON-RPC error response back to Claude Code
    process.stderr.write(`[mcp-proxy] Error: ${err.message}\n`);
    try {
      const parsed = JSON.parse(line);
      if (parsed.id !== undefined) {
        const errorResponse = {
          jsonrpc: '2.0',
          id: parsed.id,
          error: { code: -32000, message: `Proxy error: ${err.message}` },
        };
        process.stdout.write(JSON.stringify(errorResponse) + '\n');
      }
    } catch {}
  }
});

// Keep process alive — Claude Code keeps stdin open for the session lifetime.
// Only exit when parent process terminates (SIGTERM/SIGPIPE).
rl.on('close', () => {
  process.stderr.write('[mcp-proxy] stdin closed, waiting for pending requests...\n');
  setTimeout(() => process.exit(0), 2000);
});

process.stderr.write('[mcp-proxy] Dynamics 365 MCP proxy started\n');
