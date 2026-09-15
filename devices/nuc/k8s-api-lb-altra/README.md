# Kubernetes API load balancer (NUC) for `altra`

This runs a second HAProxy instance on the NUC (`kalmyk@192.168.1.130`) listening on
TCP `:6444` and forwarding to the `altra` control plane nodes on `:6443`.

Why a second port:

- The existing cluster uses `192.168.1.130:6443`.
- This keeps `altra` independent (`192.168.1.130:6444`).

## 1) Edit backends

Edit `devices/nuc/k8s-api-lb-altra/haproxy.cfg` and set the backend servers to your
`altra` control plane node IPs.

## 2) Deploy on the NUC

```bash
ssh kalmyk@192.168.1.130
mkdir -p ~/k8s-api-lb-altra
```

Copy the files over:

```bash
scp devices/nuc/k8s-api-lb-altra/docker-compose.yaml \
  devices/nuc/k8s-api-lb-altra/haproxy.cfg \
  kalmyk@192.168.1.130:~/k8s-api-lb-altra/
```

Start it:

```bash
ssh kalmyk@192.168.1.130
cd ~/k8s-api-lb-altra
docker compose up -d
docker compose ps
docker compose logs --tail=200 -f
```

## 3) Firewall reminder

Keep `6444/tcp` LAN-only.
