# Codex MCP Bridge on docker-host

This playbook captures how we expose the Codex CLI as an MCP server on `docker-host` and surface it inside Open WebUI.

## Prerequisites

- `codex` CLI installed globally (`sudo npm install -g @openai/codex`).
- `mcpo` installed via `pipx` (`pipx install mcpo`).
- Tailscale agent running on the host.
- The repository cloned to `/home/kalmyk/github.com/lab`.

## Configure Codex

Copy the repo’s template config so Codex runs with the expected defaults (model, sandbox, trusted workspace):

```bash
install -d ~/.codex
cp ~/github.com/lab/services/jangar/scripts/codex-config-container.toml ~/.codex/config.toml
```

The template pins `gpt-5.3-codex`, disables approvals, and trusts `/home/kalmyk/github.com/lab`.

## Systemd service

`codex-mcp.service` lives at `/etc/systemd/system/codex-mcp.service` and wraps Codex with mcpo:

```ini
[Unit]
Description=Codex MCP server bridged by mcpo
After=network.target

[Service]
User=kalmyk
Group=kalmyk
WorkingDirectory=/home/kalmyk/github.com/lab
Environment=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/home/kalmyk/.local/bin:/home/kalmyk/.local/npm-global/bin
ExecStart=/home/kalmyk/.local/bin/mcpo --host 0.0.0.0 --port 8200 --name codex --api-key CODEx_MCP_KEY -- codex mcp-server
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Enable and verify:

```bash
sudo systemctl enable --now codex-mcp.service
sudo systemctl status codex-mcp.service
curl http://192.168.1.190:8200/openapi.json | jq '.info.title'
```

The last command should print `codex-mcp-server`. Use the `Authorization: Bearer CODEx_MCP_KEY` header when calling POST endpoints.

## Expose through Tailscale

Open WebUI’s frontend also needs to reach the MCP endpoint _and_ the chat UI over HTTPS. Proxy both through Tailscale:

```bash
sudo tailscale set --operator=$USER                   # allow non-root serve commands
tailscale serve --bg --set-path /codex http://127.0.0.1:8200
tailscale serve --bg --set-path /      http://127.0.0.1:3000
```

This exposes:

- `https://docker.ide-newton.ts.net/codex` → Codex MCP (requires the bearer token)
- `https://docker.ide-newton.ts.net/` → Open WebUI chat

Validate from your laptop (with Tailscale connected):

```bash
curl -I https://docker.ide-newton.ts.net/
curl -H 'Authorization: Bearer CODEx_MCP_KEY' \
  https://docker.ide-newton.ts.net/codex/openapi.json | jq '.info.title'
```

## Wire up Open WebUI

1. Edit `~/ollama-stack/docker-compose.yml` and add the tool server connection:

   ```yaml
   environment:
     - MCP_ENABLE=true
     - TOOL_SERVER_CONNECTIONS=[{"name":"codex-mcp","url":"https://docker.ide-newton.ts.net/codex/mcp","api_key":"CODEx_MCP_KEY"}]
   ```

2. Restart the stack:

   ```bash
   cd ~/ollama-stack
   docker compose down
   docker compose up -d
   ```

3. Import the helper JSON (see `~/Downloads/codex-mcp-tool.json`) via **Settings → External Tools → Import**, then toggle the tool on. Codex commands run inside `/home/kalmyk/github.com/lab`.

## Smoke test

Run a simple Codex call against the bridge:

```bash
curl -s -m 30 -X POST http://192.168.1.190:8200/codex \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer CODEx_MCP_KEY' \
  -d '{"prompt":"Say hello","cwd":"/home/kalmyk/github.com/lab"}'
```

Expected output: `"Hey there!"`

If you see 401/500 errors, recheck the bearer token, the config template, and the service status (`sudo systemctl status codex-mcp.service`).
