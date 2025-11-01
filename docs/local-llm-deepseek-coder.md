# Local DeepSeek Coder on docker-host (RTX 3090)

Date: 1 Nov 2025

## Goal
Run a coding-tuned LLM locally on the `docker-host` VM (Ubuntu 24.04, RTX 3090 24 GB) and expose it through Ollama + Open WebUI for interactive use.

## Prerequisites
- `docker-host` accessible via SSH (`kalmyk@192.168.1.190`).
- NVIDIA 580.95 driver + CUDA 13.0 installed (see “GPU passthrough & driver notes”).
- Ollama service running under systemd `/etc/systemd/system/ollama.service`.
- Open WebUI container deployed from `~/ollama-stack/docker-compose.yml`.

## GPU passthrough & driver notes
1. **Enable passthrough in Harvester**: Select the GA102 device (`altra-000c01000`) and turn passthrough on.
2. **Bind both GPU + audio functions to `vfio-pci`** (PCIs `000c:01:00.0` & `000c:01:00.1`). If the audio function stays on `snd_hda_intel`, the passthrough toggle hangs in “In Progress”.
3. **Install NVIDIA driver + CUDA toolkit inside the VM**:
   ```bash
   sudo apt-get update
   sudo apt-get install -y nvidia-driver-550 nvidia-cuda-toolkit
   ```
   `nvidia-smi` should show the RTX 3090 with driver 580.95.
4. **Typical issues**
   - `modprobe nvidia: No such device` → GPU not bound to VM; recheck Harvester claim/binding.
   - Passthrough stuck → unbind the audio device, bind both functions to `vfio-pci`, restart `harvester-pcidevices-controller` pod.

## Install Ollama
Use the official script to install the binary and unit:

```bash
curl -fsSL https://ollama.com/install.sh | sh
sudo systemctl enable --now ollama
```

This places the binary at `/usr/local/bin/ollama`, creates `/etc/systemd/system/ollama.service`, and starts the service.

## Configure Ollama for remote clients
Ollama defaults to 127.0.0.1. Allow container access by editing the unit:

```bash
sudo tee /etc/systemd/system/ollama.service <<'EOF_UNIT'
[Unit]
Description=Ollama Service
After=network-online.target

[Service]
ExecStart=/usr/local/bin/ollama serve
User=ollama
Group=ollama
Restart=always
RestartSec=3
Environment=OLLAMA_HOST=0.0.0.0
Environment=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/games:/usr/local/games:/snap/bin

[Install]
WantedBy=default.target
EOF_UNIT

sudo systemctl daemon-reload
sudo systemctl restart ollama
```

## Deploy Open WebUI
`~/ollama-stack/docker-compose.yml` contains:

```yaml
services:
  open-webui:
    image: ghcr.io/open-webui/open-webui:latest
    container_name: open-webui
    restart: unless-stopped
    environment:
      - OLLAMA_BASE_URL=http://host.docker.internal:11434
    extra_hosts:
      - "host.docker.internal:host-gateway"
    ports:
      - "3000:8080"
    volumes:
      - openwebui-data:/app/backend/data

volumes:
  openwebui-data:
    driver: local
```

Start/stop the stack:

```bash
cd ~/ollama-stack
docker compose up -d      # start
docker compose down       # stop
```

## Pull DeepSeek Coder
Select the 6.7 B model (fits in VRAM with good speed):

```bash
ollama pull deepseek-coder:6.7b
```

Smoke-test the model:

```bash
ollama list
printf 'Write a Python function that returns True if a number is prime.' | \
  ollama run deepseek-coder:6.7b
```

## Register models in Open WebUI
Restart the compose stack after pulling new models so WebUI refreshes `/api/tags`:

```bash
cd ~/ollama-stack
docker compose restart
```

Browse to `http://192.168.1.190:3000`, sign in, and pick **deepseek-coder:6.7b** from the dropdown (use “Set as default” for coding sessions).

## Runtime notes
- DeepSeek Coder download size: ~3.8 GB in `/usr/share/ollama/.ollama/models`.
- Expected throughput on the 3090: ~30 tokens/s.
- Keep one heavy model resident at a time to avoid VRAM thrash.
- Always restart the WebUI container after adding new Ollama models.

## Troubleshooting checklist
- **Model dropdown empty / 500 errors** → ensure `OLLAMA_HOST=0.0.0.0` in the unit; restart `ollama` and `docker compose restart`.
- **`nvidia-smi` missing** → rebind passthrough devices and reinstall driver/toolkit.
- **Passthrough toggle stuck** → unbind audio function, bind both to `vfio-pci`, bounce `harvester-pcidevices-controller`.
- Logs: `journalctl -u ollama -f`, `docker logs open-webui`.
