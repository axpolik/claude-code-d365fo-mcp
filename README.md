# Claude Code ↔ Dynamics 365 F&O — MCP Integration

A small proxy that lets [Claude Code](https://docs.anthropic.com/en/docs/claude-code) talk to **Microsoft Dynamics 365 Finance & Operations** through the [Model Context Protocol (MCP)](https://modelcontextprotocol.io/).

Once set up, you can query D365 data, navigate forms, and call custom X++ actions — all from Claude Code using natural language.

Tested on WSL Ubuntu, VSCode with Azure CLI Extension installed.

## Why is this needed? 
**Why not connect directly via HTTP?**

While the Model Context Protocol (MCP) officially supports HTTP transport (via Server-Sent Events - SSE), connecting Claude Code directly to a remote Dynamics 365 F&O MCP server isn't straightforward. This proxy bridges the gap by solving three main architectural constraints:

***1. No native support for dynamic HTTP headers (Authentication)***
Claude Code's configuration relies on static setups. Connecting to D365 F&O requires dynamically injecting an `Authorization: Bearer <token>` header into the requests. Claude Code currently lacks a built-in mechanism to dynamically fetch an Entra ID (Azure AD) token and inject it into the HTTP headers on the fly.

***2. Token Expiration (Entra ID)***
Even if you could hardcode a Bearer token into the Claude Code configuration, Entra ID access tokens typically expire within 60-90 minutes. A static configuration would lead to `401 Unauthorized` errors after an hour of work. This Node.js proxy solves this by dynamically fetching and managing valid tokens via the Azure CLI in the background.

***3. Claude Code's `stdio` design***
Claude Code is primarily a developer CLI tool designed to interact with local resources. It natively prefers spawning MCP servers as local child processes communicating over `stdio`. 

**The Solution:** This proxy acts as an adapter. From Claude Code's perspective, it's just a simple local script running via `stdio`. From D365 F&O's perspective, it's a properly authenticated HTTP/SSE client making requests with valid Bearer tokens.


## How it works

The idea is simple: a tiny Node.js script sits in the middle and translates between the two worlds.

```
┌─────────────┐  stdio (JSON-RPC)  ┌───────────────────┐  HTTPS + Bearer  ┌──────────────────┐
│ Claude Code │ ◄───────────────►  │ mcp-dynamics365fo │ ◄──────────────► │ D365 F&O MCP     │
│ (IDE/CLI)   │  stdin / stdout    │ proxy.mjs         │  HTTP POST       │ Server (remote)  │
└─────────────┘                    └───────────────────┘                  └──────────────────┘
                                          │
                                          │ az account get-access-token
                                          ▼
                                   ┌──────────────────┐
                                   │ Azure CLI (az)   │
                                   │ Token Provider   │
                                   └──────────────────┘
```

1. Claude Code spawns the proxy as a child process (configured in `.mcp.json`).
2. It sends JSON-RPC messages to the proxy's stdin.
3. The proxy grabs a Bearer token from Azure CLI and forwards each message as an HTTP POST to the D365 MCP endpoint.
4. D365 responds (plain JSON or SSE stream) — the proxy parses it and writes the result back to stdout.
5. An `mcp-session-id` header is tracked across requests to maintain D365 server-side state.

## Design decisions

**Why Azure CLI for auth?** The D365 MCP server needs Azure AD tokens. Using `az account get-access-token` is the path of least resistance — no client secrets to manage, no app registrations to create, just your existing `az login` session. It works with MFA, conditional access, all of that.

**Why refresh tokens every 45 min?** Azure AD tokens expire after roughly 60–75 minutes. The proxy refreshes proactively every 45 min so you don't get random failures in the middle of a conversation.

**Why handle SSE by proxy?** D365 sometimes responds with `text/event-stream` instead of plain JSON. The proxy handles both transparently — you don't need to worry about it.

## About the ClientID

**The Azure CLI Client ID is:** `04b07795-8ddb-461a-bbee-02f9e1bf7b46`

This is a first-party Microsoft app registered in Azure AD — the same for all Azure CLI users worldwide. You don't need to create your own app registration. Just copy this ID into the D365 "Allowed MCP clients" form in Step 2.

Note: this is different from the default VSCode [ClientID](https://learn.microsoft.com/en-us/dynamics365/fin-ops-core/dev-itpro/copilot/copilot-mcp#allowed-mcp-clients).

**Optional — verify it yourself:**
1. Run: `az account get-access-token --resource https://YOUR-ENVIRONMENT.operations.dynamics.com --query accessToken -o tsv`
2. Paste the token into [jwt.ms](https://jwt.ms)
3. Check the `appid` claim — it should match the ID above.

More info: [Microsoft docs — Sign in with Azure CLI](https://learn.microsoft.com/en-us/cli/azure/authenticate-azure-cli)

## Prerequisites

- **Node.js 22+** (needs native `fetch`; Node 18+ might work with `--experimental-fetch`)
- **Azure CLI** installed and logged in (`az login`)
- **D365 F&O** environment with MCP server enabled
- **Claude Code** (VSCode extension or CLI)

## Setup

### Step 1: Azure CLI

```bash
# Install if needed: https://learn.microsoft.com/en-us/cli/azure/install-azure-cli

# Log in
az login

# Quick test — should print a long token string
az account get-access-token \
  --resource "https://YOUR-ENVIRONMENT.operations.dynamics.com" \
  --query accessToken -o tsv
```

### Step 2: Register the ClientID in D365

This part is important — D365 won't accept MCP connections unless the client app is explicitly allowed.

1. Open your D365 F&O environment in the browser.
2. Go to **System administration** and search for **"Allowed MCP clients"**.
3. Add a new row:
   - **Name**: `AzureCLI-ClaudeCode` (or whatever you like)
   - **ClientId**: `04b07795-8ddb-461a-bbee-02f9e1bf7b46`
   - **Allowed**: `true`
4. Save.

![Allowed MCP Clients form in D365](d365foMCPclient_form.jpg)

### Step 3: Clone the repo

```bash
git clone https://github.com/axpolik/claude-code-d365fo-mcp.git
```

No need to edit the proxy script — all configuration is done through environment variables in `.mcp.json`.

### Step 4: Configure Claude Code

Copy `.mcp.json` to your project root (or `~/.claude/.mcp.json` for global config):

```bash
cp .mcp.json /path/to/your/project/.mcp.json
```

Then edit `.mcp.json` — set your D365 environment URL and the path to the proxy script:

```json
{
  "mcpServers": {
    "dynamics365fo": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/mcp-dynamics365fo-proxy.mjs"],
      "env": {
        "PATH": "/mnt/c/Program Files/Microsoft SDKs/Azure/CLI2/wbin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        "D365_MCP_URL": "https://YOUR-ENVIRONMENT.sandbox.operations.dynamics.com/mcp",
        "D365_RESOURCE": "https://YOUR-ENVIRONMENT.sandbox.operations.dynamics.com"
      }
    }
  }
}
```

A few things to keep in mind:
- `command` — can be just `"node"` if it's in your PATH, or the full path like `"/home/user/.nvm/versions/node/v22.22.0/bin/node"`.
- `args` — needs the **absolute path** to the proxy script.
- `D365_MCP_URL` / `D365_RESOURCE` — your D365 F&O environment URL. Find it in the browser address bar when you open D365 (e.g. `https://mycompany.sandbox.operations.eu.dynamics.com`).
- `env.PATH` — must include the directory where `az` lives. On WSL you might need to add the Windows-side path too (see Troubleshooting).

### Step 5: Test it

1. Open Claude Code in VSCode or terminal.
2. Check the MCP server status — `dynamics365fo` should show up.
3. Try something like: *"Find the SalesOrderHeaders entity in D365"*.

## Files

```
claude-code-d365fo-mcp/
├── README.md                       # You're reading it
├── mcp-dynamics365fo-proxy.mjs     # The proxy (stdio ↔ HTTP)
├── .mcp.json                       # Claude Code MCP config template
└── d365foMCPclient_form.jpg        # Screenshot of the D365fo config form
```

## Troubleshooting

**"Token refresh failed"** — Your `az login` session expired. Just run `az login` again.

**Proxy starts but no tools show up** — Check three things: (1) MCP server is enabled on your D365 environment, (2) your ClientID is in the "Allowed MCP clients" form, (3) your Azure AD user has the right D365 security roles.

**"fetch is not defined"** — You need Node.js 22+ (which has native `fetch`). On Node 18–21, add the `--experimental-fetch` flag as a Node.js argument *before* the script path in `.mcp.json`:

```json
"args": ["--experimental-fetch", "/path/to/mcp-dynamics365fo-proxy.mjs"]
```

**How to debug the proxy locally?** — If Claude Code isn't showing any tools, run the proxy directly in your terminal to see raw errors:
```bash
D365_MCP_URL="https://YOUR-ENV.operations.dynamics.com/mcp" \
D365_RESOURCE="https://YOUR-ENV.operations.dynamics.com" \
node mcp-dynamics365fo-proxy.mjs
```
If it crashes, you'll see the Node.js error stack immediately. If it waits silently, it's running correctly and waiting for JSON-RPC input from stdin.

**PATH issues on WSL** — If `az` is installed on the Windows side, add it to the PATH in `.mcp.json`:

```json
"env": {
  "PATH": "/usr/local/bin:/usr/bin:/bin:/mnt/c/Program Files/Microsoft SDKs/Azure/CLI2/wbin"
}
```

## D365 MCP Tools

Once connected, you get three categories of tools: **data** (OData CRUD), **form** (UI navigation), and **API** (custom X++ calls). For CRUD operations, prefer data tools — currently they are faster and more reliable.

## ⚠️ High Token Consumption Warning

D365 F&O can return massive JSON payloads (data entities, metadata). Querying it without limits will quickly drain your Claude context window and increase API costs.

**How to minimize token usage:**
- **Filter heavily:** Always instruct Claude to use limits like `$top`, `$select`, or `$filter` to fetch only the exact rows and columns you need.
- **💡 Pro Tip: Use local files as "memory":** Ask Claude to save frequently used, static D365 data (like schemas, metadata, or specific IDs) into a local file (e.g., `d365_memory.md`). Claude can read this file later instead of re-querying the MCP server, saving a huge amount of tokens!

**Example: Initial prompt for new Claude Code session with memory file used**

```json
## Session context:
- The file `d365fo-mcp-memory.md` in the project root is a local cache for dynamics365fo MCP tool data
- Before any query to the dynamics365fo MCP tool, check this file first — if data is there and current, use it without calling MCP tools
- If data is missing, insufficient, or ambiguous — call dynamics365fo MCP tool and save the result to the memory file
- Save to memory: entity metadata, field schemas, control names, semi-static query results (with query date)
- Modify the memory file without asking for confirmation

##Start by reading d365fo-mcp-memory.md to load context.
```

## License

MIT
