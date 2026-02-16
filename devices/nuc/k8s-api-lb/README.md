# Kubernetes API load balancer (NUC)

This runbook configures the Intel NUC (`kalmyk@192.168.1.130`) as the stable
Talos/Kubernetes control plane endpoint on the LAN by running HAProxy as a TCP
load balancer on port `6443`.

Design:
- Clients (Talos nodes, `kubectl`) talk to `https://192.168.1.130:6443`.
- HAProxy forwards to the control plane nodes on the LAN (TCP passthrough).
- Do not expose `:6443` to the internet.

## Prereqs

- Docker + Docker Compose on the NUC.
- The control plane nodes have static IPs (examples below).

## 1) Configure backends

Edit `devices/nuc/k8s-api-lb/haproxy.cfg` and set the backend servers to your
control plane nodes. Example:

- `ryzen`: `192.168.1.194:6443`
- `ampone`: `192.168.1.203:6443`
- `altra`: `192.168.1.85:6443`

## 2) Deploy on the NUC

```bash
# The NUC does not need a full repo checkout. Keep a small runtime folder.
ssh kalmyk@192.168.1.130 'mkdir -p ~/k8s-api-lb'

# Copy the compose + haproxy config from this repo to the NUC.
scp devices/nuc/k8s-api-lb/docker-compose.yaml kalmyk@192.168.1.130:~/k8s-api-lb/docker-compose.yaml
scp devices/nuc/k8s-api-lb/haproxy.cfg kalmyk@192.168.1.130:~/k8s-api-lb/haproxy.cfg

ssh kalmyk@192.168.1.130
cd ~/k8s-api-lb

# optional sanity check: ensure nothing is already listening on 6443
sudo ss -lntp | grep -F ':6443' || true

docker compose up -d
docker compose ps
docker compose logs --tail=200 -f
```

## 2.1 Update backends (add/remove control planes)

If you change `haproxy.cfg`, re-copy it then restart the container:

```bash
scp devices/nuc/k8s-api-lb/haproxy.cfg kalmyk@192.168.1.130:~/k8s-api-lb/haproxy.cfg
ssh kalmyk@192.168.1.130 'cd ~/k8s-api-lb && docker compose up -d'
```

## 3) Use the NUC as the Talos cluster endpoint

When generating Talos machine configs, set:

- `cluster.controlPlane.endpoint: https://192.168.1.130:6443`

For an existing cluster, you must update the endpoint across all control plane
machine configs before you rely on it.

## 4) Firewall reminder

Keep `6443/tcp` LAN-only. Example (UFW):

```bash
sudo ufw allow from 192.168.1.0/24 to any port 6443 proto tcp
sudo ufw deny 6443/tcp
```

If you use a different firewall, implement the equivalent rule.
