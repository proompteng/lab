# Nginx Proxy Manager (NUC)

This directory is a live snapshot of the Docker Compose deployment running on `nuc`
at `kalmyk@192.168.1.130` in `~/github.com/homelab/nuc/nginx-proxy-manager`.

`nginx-proxy-manager` currently runs in Docker Compose on the host, not in Kubernetes.

## Source of truth

- `docker-compose.yaml` mirrors the live Compose deployment.
- `settings-export.json` is a generated local export of the live NPM SQLite configuration.
- `data/nginx/` contains generated nginx config from the live instance for inspection.

Runtime-only or secret-bearing files are intentionally not tracked in Git:

- `data/database.sqlite`
- `data/keys.json`
- `data/custom_ssl/`
- `letsencrypt/`
- `data/logs/`
- `settings-export.json`

These are still pulled locally from `nuc` when refreshing the snapshot, but `.gitignore`
keeps them out of version control.

## Refresh From NUC

```bash
mv devices/nuc/nginx-proxy-manager devices/nuc/nginx-proxy-manager.pre-sync-$(date +%Y%m%d%H%M%S)
mkdir -p devices/nuc/nginx-proxy-manager
ssh kalmyk@192.168.1.130 'cd ~/github.com/homelab/nuc/nginx-proxy-manager && tar --exclude="data/logs" --exclude="npm-config-*.tgz" -czf - .' | tar -xzf - -C devices/nuc/nginx-proxy-manager
python3 devices/nuc/nginx-proxy-manager/export-settings.py
```

## Run on NUC

```bash
ssh kalmyk@192.168.1.130
cd ~/github.com/homelab/nuc/nginx-proxy-manager
docker compose up -d
docker compose ps
```

## Notes

- The live admin user is not the default `admin@example.com` bootstrap user anymore.
- `settings-export.json` is useful for local inspection, but it should not be committed.
- To fully recreate the live instance byte-for-byte, you would also need the ignored DB,
  encryption key, and certificate material.
