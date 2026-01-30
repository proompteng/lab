# Ollama on `docker-host` (RTX 3090) for Jangar OpenWebUI

This runbook installs NVIDIA drivers + Ollama on `docker-host` (`kalmyk@192.168.1.190`), pulls a quantized Qwen model for chat/coding (**Qwen3 Coder**) plus a small embeddings model (**Qwen3 Embedding**), and wires OpenWebUI (in the `jangar` namespace) to use that Ollama endpoint.

## Prerequisites
- GPU is passed through to `docker-host` from Harvester.
  - See `docs/harvester-gpu-pci-passthrough.md`.

## Install NVIDIA driver + CUDA (inside the VM)
SSH to the VM:

```bash
ssh kalmyk@192.168.1.190
```

Confirm the PCI device is present:

```bash
sudo lspci -nn | grep -i nvidia
```

Install the driver packages:

```bash
sudo apt-get update
sudo apt-get install -y nvidia-driver-550 nvidia-utils-550
sudo apt-get install -y nvidia-cuda-toolkit
sudo reboot
```

After reboot, verify the driver:

```bash
nvidia-smi
ls -la /dev/nvidia*
```

## Install Ollama + Saigak (recommended)
Saigak wires Ollama for throughput tuning plus a host-level proxy on `:11434`
that exports OTEL metrics.

From the repo root (local machine), copy Saigak to the VM and install:

```bash
scp -r services/saigak kalmyk@192.168.1.190:/tmp/saigak
ssh kalmyk@192.168.1.190
cd /tmp/saigak
SAIGAK_SKIP_MODELS=1 ./scripts/install.sh
```

Saigak keeps Ollama bound to `127.0.0.1:11435` and exposes the proxy on
`0.0.0.0:11434` (so Kubernetes pods can reach it).

If a legacy `ollama-proxy.service` is running, disable it so the container
proxy can bind `:11434`:

```bash
sudo systemctl disable --now ollama-proxy.service
```

Verify listeners:

```bash
ss -lntp | grep -E '11434|11435'
curl -fsS http://127.0.0.1:11434/api/tags
```

## Install Ollama (manual fallback)
If you need to bootstrap without Saigak, install Ollama via the upstream script:

```bash
curl -fsSL https://ollama.com/install.sh | sh
sudo systemctl enable --now ollama
```

Then configure a host proxy separately or adjust consumers to talk to
`127.0.0.1:11435`.

## Pull models
### Chat/coding: Qwen3 Coder (quantized)
Pull Qwen3 Coder 30B A3B (Q4_K_M):

```bash
ollama pull qwen3-coder:30b-a3b-q4_K_M
ollama list
```

Smoke test:

```bash
curl -fsS http://127.0.0.1:11434/api/generate \
  -H 'Content-Type: application/json' \
  -d '{"model":"qwen3-coder:30b-a3b-q4_K_M","prompt":"Return only a bash one-liner that prints hello","stream":false}'
```

### Embeddings: Qwen3 Embedding (OpenAI-compatible)
Pull an embeddings model:

```bash
ollama pull qwen3-embedding:0.6b
ollama list
```

Validate the OpenAI-compatible embeddings endpoint (this is what you’ll use later for pgvector ingestion):

```bash
curl -fsS http://127.0.0.1:11434/v1/embeddings \
  -H 'Content-Type: application/json' \
  -d '{"model":"qwen3-embedding:0.6b","input":"hello"}' | \
  python3 -c 'import json,sys; r=json.load(sys.stdin); print(len(r["data"][0]["embedding"]))'
```

Note: no changes to `jangar` are required for embeddings — as long as clients can reach `http://192.168.1.190:11434`, they can call `POST /v1/embeddings` directly.

### Create tuned aliases (Saigak defaults)
If you have the repo available on the host, create tuned aliases using the Saigak modelfiles:

```bash
ollama create qwen3-coder-saigak:30b-a3b-q4_K_M \
  -f /path/to/lab/services/saigak/config/models/qwen3-coder-30b-a3b-q4-k-m.modelfile
ollama create qwen3-embedding-saigak:0.6b \
  -f /path/to/lab/services/saigak/config/models/qwen3-embedding-0-6b.modelfile
```

To keep OpenWebUI’s model picker clean, remove the base tags after creating aliases:

```bash
ollama rm qwen3-coder:30b-a3b-q4_K_M qwen3-embedding:0.6b
```

### Configure Jangar / memories to use Ollama embeddings

Both `services/jangar` (MCP memories tools) and `services/memories` (CLI helpers) can point at Ollama via the same OpenAI-style env vars:

```bash
export OPENAI_API_BASE_URL='http://192.168.1.190:11434/v1'
export OPENAI_EMBEDDING_MODEL='qwen3-embedding-saigak:0.6b'
export OPENAI_EMBEDDING_DIMENSION='1024'
# OPENAI_API_KEY is optional for Ollama
```

## Wire Jangar OpenWebUI to `docker-host` Ollama
OpenWebUI in the `jangar` namespace is Helm-managed via `argocd/applications/jangar/openwebui-values.yaml`. It’s configured to use Jangar as the OpenAI-compatible backend, but can also be given one or more Ollama endpoints.

Desired state (GitOps):
- `argocd/applications/jangar/openwebui-values.yaml` sets:
  - `ollamaUrls: [http://192.168.1.190:11434]`
  - `ENABLE_OLLAMA_API=true` (via `extraEnvVars`)

After ArgoCD reconciles, you can verify reachability from inside the OpenWebUI pod:

```bash
kubectl -n jangar exec open-webui-0 -- sh -lc 'curl -fsS http://192.168.1.190:11434/api/tags | head -c 400; echo'
```

If the models are available, OpenWebUI should include `qwen3-coder-saigak:30b-a3b-q4_K_M` and
`qwen3-embedding-saigak:0.6b` in its model list.

## Troubleshooting
### Ollama running but completions time out
Symptoms:
- `/v1/chat/completions` hangs or returns 500s after minutes.
- Ollama logs show `offloaded 0/.. layers to GPU` or CUDA init errors.
- `nvidia-smi` fails with driver/library mismatch.

Fix (driver mismatch on `docker-host`):
1) Remove stray 550 packages (if present):
   ```bash
   sudo apt-get purge -y 'nvidia-*550*'
   ```
2) Reinstall the 580 stack and rebuild initramfs:
   ```bash
   sudo apt-get install -y nvidia-driver-580 nvidia-utils-580 nvidia-kernel-common-580 nvidia-kernel-source-580 nvidia-dkms-580 nvidia-compute-utils-580
   sudo update-initramfs -u
   sudo reboot
   ```
3) Verify:
   ```bash
   nvidia-smi
   journalctl -u ollama -n 50 --no-pager | grep -i cuda
   ```

### Saigak Alloy keeps restarting after reboot
Cause: the Saigak compose stack lives in `/tmp/saigak`, and `/tmp` may be wiped on reboot.

Fix:
1) Restore the Saigak files on the host:
   ```bash
   scp -r services/saigak/* kalmyk@192.168.1.190:/tmp/saigak/
   ```
2) Restart the stack:
   ```bash
   ssh kalmyk@192.168.1.190 'cd /tmp/saigak && docker compose up -d'
   ```
3) Confirm:
   ```bash
   docker ps --format 'table {{.Names}}\t{{.Status}}' | grep saigak
   ```

Long-term: move the Saigak compose directory to a persistent path (e.g., `/opt/saigak`)
and update the install script or systemd units accordingly.
