# Ollama on `docker-host` (RTX 3090) for Jangar OpenWebUI

This runbook installs NVIDIA drivers + Ollama on `docker-host` (`kalmyk@192.168.1.190`), pulls a quantized Qwen model, and wires OpenWebUI (in the `jangar` namespace) to use that Ollama endpoint.

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

## Install Ollama (systemd)
Install Ollama via the upstream script:

```bash
curl -fsSL https://ollama.com/install.sh | sh
```

Expose Ollama on `0.0.0.0:11434` (so Kubernetes pods can reach it):

```bash
sudo install -d /etc/systemd/system/ollama.service.d
cat <<'EOF' | sudo tee /etc/systemd/system/ollama.service.d/override.conf >/dev/null
[Service]
Environment=OLLAMA_HOST=0.0.0.0
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now ollama
sudo systemctl restart ollama
```

Verify it’s listening and serving:

```bash
ss -lntp | grep 11434
curl -fsS http://127.0.0.1:11434/api/tags
```

## Pull a quantized Qwen model
Pull Qwen 2.5 7B Instruct (Q4_K_M):

```bash
ollama pull qwen2.5:7b-instruct-q4_K_M
ollama list
```

Smoke test:

```bash
printf 'Say hello in one sentence.' | ollama run qwen2.5:7b-instruct-q4_K_M
```

## Wire Jangar OpenWebUI to `docker-host` Ollama
OpenWebUI in the `jangar` namespace is Helm-managed via `argocd/applications/jangar/openwebui-values.yaml`. It’s configured to use Jangar as the OpenAI-compatible backend, but can also be given one or more Ollama endpoints.

Desired state (GitOps):
- `argocd/applications/jangar/openwebui-values.yaml` sets:
  - `ollamaUrls: [http://docker-host.pihole.lan:11434]`
  - `ENABLE_OLLAMA_API=true` (via `extraEnvVars`)

After ArgoCD reconciles, you can verify reachability from inside the OpenWebUI pod:

```bash
kubectl -n jangar exec open-webui-0 -- sh -lc 'curl -fsS http://docker-host.pihole.lan:11434/api/tags | head -c 400; echo'
```

If the model is available, OpenWebUI should include `qwen2.5:7b-instruct-q4_K_M` in its model list.
