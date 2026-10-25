# Workers VM (ryzen) setup and verification

Date: 2026-01-17

## Overview

The ryzen Talos cluster runs a KubeVirt VM named `workers` via Argo CD. The VM uses:

- 2 vCPU, 4 GiB RAM
- Root disk: CDI DataVolume from Ubuntu 24.04 server cloud image (50Gi, local-path)
- Data disk: 10Gi PVC (local-path) mounted at `/home/ubuntu/data`
- Ubuntu Desktop installed via cloud-init
- Chrome remote debugging on `127.0.0.1:9222`
- Node LTS via nvm, Bun, and Codex CLI

Argo CD apps involved:

- `argocd/local-path-ryzen`
- `argocd/cdi-ryzen`
- `argocd/workers-ryzen`

## Apply / Re-run cloud-init

To apply changes (or rerun cloud-init on a fresh root disk):

```bash
argocd app sync argocd/workers-ryzen
kubectl --kubeconfig /home/coder/.kube/ryzen.yaml -n workers delete vm workers
kubectl --kubeconfig /home/coder/.kube/ryzen.yaml -n workers delete datavolume workers-rootdisk
argocd app sync argocd/workers-ryzen
```

Wait for the DataVolume to import and the VM to be running:

```bash
kubectl --kubeconfig /home/coder/.kube/ryzen.yaml -n workers get dv,vm,vmi
```

## Access (SSH via virtctl port-forward)

Use the KubeVirt port-forward subresource:

```bash
ssh -o 'ProxyCommand=virtctl --kubeconfig /home/coder/.kube/ryzen.yaml -n workers port-forward --stdio=true vmi/workers 22' \
  -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
  -i /home/coder/.ssh/id_ed25519 ubuntu@vmi/workers
```

## Verification (2026-01-17)

Cloud-init completed:

```bash
cloud-init status --long
```

Output:

```
status: done
extended_status: done
boot_status_code: enabled-by-generator
last_update: Thu, 01 Jan 1970 00:07:41 +0000
detail: DataSourceNoCloud [seed=/dev/vdc]
errors: []
recoverable_errors: {}
```

Ubuntu Desktop installed:

```bash
dpkg -l | grep -E '^ii\s+ubuntu-desktop'
```

Output:

```
ii  ubuntu-desktop         1.539.2  amd64  Ubuntu desktop system
ii  ubuntu-desktop-minimal 1.539.2  amd64  Ubuntu desktop minimal system
```

Node/Bun/Codex (available on PATH without sourcing):

```bash
node -v
bun -v
codex --version
```

Output:

```
v24.13.0
1.3.6
codex-cli 0.87.0
```

Chrome + remote debugging:

```bash
google-chrome --version
curl -sSf http://127.0.0.1:9222/json/version | head -n 5
```

Output:

```
Google Chrome 144.0.7559.59
{
   "Browser": "Chrome/144.0.7559.59",
   "Protocol-Version": "1.3",
   "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/144.0.0.0 Safari/537.36",
   "V8-Version": "14.4.258.16",
```

Services (note: MCP server is a stdio process; systemd may show `activating` while it waits for a client):

```bash
systemctl is-active ssh
systemctl is-active chrome-remote-debug
systemctl is-active chrome-devtools-mcp
```

Output:

```
active
active
activating
```

Note: `chrome-devtools-mcp` is a stdio MCP server that exits when no client is attached, so systemd may restart it and show `activating`. Use on-demand invocation to verify connectivity (next section).

MCP connectivity (on-demand):

```bash
bash -lc 'source /home/ubuntu/.profile; npx -y chrome-devtools-mcp@latest --browserUrl http://127.0.0.1:9222 --logFile /tmp/mcp.log'
```

Confirm it connects:

```bash
tail -n 5 /tmp/mcp.log
```

Output:

```
2026-01-17T14:44:06.714Z mcp:log Starting Chrome DevTools MCP Server v0.13.0
2026-01-17T14:44:06.753Z mcp:log Chrome DevTools MCP Server connected
2026-01-17T14:45:31.034Z mcp:log Starting Chrome DevTools MCP Server v0.13.0
2026-01-17T14:45:31.079Z mcp:log Chrome DevTools MCP Server connected
```
