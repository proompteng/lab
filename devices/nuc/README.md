# NUC device configuration

This directory describes services hosted on the NUC at `192.168.1.130`.

- `nginx-proxy-manager/` — Docker compose bundle and data snapshot for Nginx Proxy Manager.
- `k8s-api-lb/` — HAProxy TCP load balancer for the Talos/Kubernetes API (`:6443`) on the LAN.
