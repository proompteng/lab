#!/bin/sh

echo "Setting up primary server 1"
k3sup install --host 192.168.1.150 \
--user kalmyk \
--cluster \
--local-path "$HOME/.kube/config" \
--context default \
--ssh-key "$HOME/.ssh/id_ed25519" \
--k3s-extra-args '--disable servicelb --flannel-backend=host-gw --etcd-arg=auto-compaction-mode=periodic --etcd-arg=auto-compaction-retention=1h --etcd-arg=quota-backend-bytes=8589934592 --etcd-snapshot-schedule-cron="0 */6 * * *" --etcd-snapshot-retention=20 --kube-proxy-arg=proxy-mode=ipvs --kube-proxy-arg=ipvs-scheduler=wrr --kubelet-arg=cpu-manager-policy=static --kubelet-arg=topology-manager-policy=single-numa-node --kubelet-arg=reserved-cpus=0-1 --kubelet-arg=kube-reserved=cpu=500m,memory=1Gi,ephemeral-storage=1Gi --kubelet-arg=system-reserved=cpu=500m,memory=1Gi,ephemeral-storage=1Gi --kubelet-arg=container-log-max-size=10Mi --kubelet-arg=container-log-max-files=3 --kubelet-arg=serialize-image-pulls=false --node-taint=node-role.kubernetes.io/control-plane=true:NoSchedule'

echo "Fetching the server's node-token into memory"

NODE_TOKEN=$(k3sup node-token --host 192.168.1.150 --user kalmyk \
--ssh-key "$HOME/.ssh/id_ed25519")
export NODE_TOKEN

echo "Setting up additional server: 2"
k3sup join \
--host 192.168.1.151 \
--server-host 192.168.1.150 \
--server \
--node-token "$NODE_TOKEN" \
--user kalmyk \
--ssh-key "$HOME/.ssh/id_ed25519" \
--k3s-extra-args '--disable servicelb --flannel-backend=host-gw --etcd-arg=auto-compaction-mode=periodic --etcd-arg=auto-compaction-retention=1h --etcd-arg=quota-backend-bytes=8589934592 --etcd-snapshot-schedule-cron="0 */6 * * *" --etcd-snapshot-retention=20 --kube-proxy-arg=proxy-mode=ipvs --kube-proxy-arg=ipvs-scheduler=wrr --kubelet-arg=cpu-manager-policy=static --kubelet-arg=topology-manager-policy=single-numa-node --kubelet-arg=reserved-cpus=0-1 --kubelet-arg=kube-reserved=cpu=500m,memory=1Gi,ephemeral-storage=1Gi --kubelet-arg=system-reserved=cpu=500m,memory=1Gi,ephemeral-storage=1Gi --kubelet-arg=container-log-max-size=10Mi --kubelet-arg=container-log-max-files=3 --kubelet-arg=serialize-image-pulls=false --node-taint=node-role.kubernetes.io/control-plane=true:NoSchedule'

echo "Setting up additional server: 3"
k3sup join \
--host 192.168.1.152 \
--server-host 192.168.1.150 \
--server \
--node-token "$NODE_TOKEN" \
--user kalmyk \
--ssh-key "$HOME/.ssh/id_ed25519" \
--k3s-extra-args '--disable servicelb --flannel-backend=host-gw --etcd-arg=auto-compaction-mode=periodic --etcd-arg=auto-compaction-retention=1h --etcd-arg=quota-backend-bytes=8589934592 --etcd-snapshot-schedule-cron="0 */6 * * *" --etcd-snapshot-retention=20 --kube-proxy-arg=proxy-mode=ipvs --kube-proxy-arg=ipvs-scheduler=wrr --kubelet-arg=cpu-manager-policy=static --kubelet-arg=topology-manager-policy=single-numa-node --kubelet-arg=reserved-cpus=0-1 --kubelet-arg=kube-reserved=cpu=500m,memory=1Gi,ephemeral-storage=1Gi --kubelet-arg=system-reserved=cpu=500m,memory=1Gi,ephemeral-storage=1Gi --kubelet-arg=container-log-max-size=10Mi --kubelet-arg=container-log-max-files=3 --kubelet-arg=serialize-image-pulls=false --node-taint=node-role.kubernetes.io/control-plane=true:NoSchedule'

echo "Setting up worker: 1"
k3sup join \
--host 192.168.1.160 \
--server-host 192.168.1.150 \
--node-token "$NODE_TOKEN" \
--user kalmyk \
--ssh-key "$HOME/.ssh/id_ed25519" \
--k3s-extra-args '--kubelet-arg=cpu-manager-policy=static --kubelet-arg=topology-manager-policy=single-numa-node --kubelet-arg=reserved-cpus=0-1 --kubelet-arg=kube-reserved=cpu=500m,memory=1Gi,ephemeral-storage=1Gi --kubelet-arg=system-reserved=cpu=500m,memory=1Gi,ephemeral-storage=1Gi --kubelet-arg=container-log-max-size=10Mi --kubelet-arg=container-log-max-files=3 --kubelet-arg=serialize-image-pulls=false'

echo "Setting up worker: 2"
k3sup join \
--host 192.168.1.161 \
--server-host 192.168.1.150 \
--node-token "$NODE_TOKEN" \
--user kalmyk \
--ssh-key "$HOME/.ssh/id_ed25519" \
--k3s-extra-args '--kubelet-arg=cpu-manager-policy=static --kubelet-arg=topology-manager-policy=single-numa-node --kubelet-arg=reserved-cpus=0-1 --kubelet-arg=kube-reserved=cpu=500m,memory=1Gi,ephemeral-storage=1Gi --kubelet-arg=system-reserved=cpu=500m,memory=1Gi,ephemeral-storage=1Gi --kubelet-arg=container-log-max-size=10Mi --kubelet-arg=container-log-max-files=3 --kubelet-arg=serialize-image-pulls=false'

echo "Setting up worker: 3"
k3sup join \
--host 192.168.1.162 \
--server-host 192.168.1.150 \
--node-token "$NODE_TOKEN" \
--user kalmyk \
--ssh-key "$HOME/.ssh/id_ed25519" \
--k3s-extra-args '--kubelet-arg=cpu-manager-policy=static --kubelet-arg=topology-manager-policy=single-numa-node --kubelet-arg=reserved-cpus=0-1 --kubelet-arg=kube-reserved=cpu=500m,memory=1Gi,ephemeral-storage=1Gi --kubelet-arg=system-reserved=cpu=500m,memory=1Gi,ephemeral-storage=1Gi --kubelet-arg=container-log-max-size=10Mi --kubelet-arg=container-log-max-files=3 --kubelet-arg=serialize-image-pulls=false'

echo "Setting up worker: 4"
k3sup join \
--host 192.168.1.163 \
--server-host 192.168.1.150 \
--node-token "$NODE_TOKEN" \
--user kalmyk \
--ssh-key "$HOME/.ssh/id_ed25519" \
--k3s-extra-args '--kubelet-arg=cpu-manager-policy=static --kubelet-arg=topology-manager-policy=single-numa-node --kubelet-arg=reserved-cpus=0-1 --kubelet-arg=kube-reserved=cpu=500m,memory=1Gi,ephemeral-storage=1Gi --kubelet-arg=system-reserved=cpu=500m,memory=1Gi,ephemeral-storage=1Gi --kubelet-arg=container-log-max-size=10Mi --kubelet-arg=container-log-max-files=3 --kubelet-arg=serialize-image-pulls=false'

echo "Setting up worker: 5"
k3sup join \
--host 192.168.1.164 \
--server-host 192.168.1.150 \
--node-token "$NODE_TOKEN" \
--user kalmyk \
--ssh-key "$HOME/.ssh/id_ed25519" \
--k3s-extra-args '--kubelet-arg=cpu-manager-policy=static --kubelet-arg=topology-manager-policy=single-numa-node --kubelet-arg=reserved-cpus=0-1 --kubelet-arg=kube-reserved=cpu=500m,memory=1Gi,ephemeral-storage=1Gi --kubelet-arg=system-reserved=cpu=500m,memory=1Gi,ephemeral-storage=1Gi --kubelet-arg=container-log-max-size=10Mi --kubelet-arg=container-log-max-files=3 --kubelet-arg=serialize-image-pulls=false'

echo "Setting up worker: 6"
k3sup join \
--host 192.168.1.165 \
--server-host 192.168.1.150 \
--node-token "$NODE_TOKEN" \
--user kalmyk \
--ssh-key "$HOME/.ssh/id_ed25519" \
--k3s-extra-args '--kubelet-arg=cpu-manager-policy=static --kubelet-arg=topology-manager-policy=single-numa-node --kubelet-arg=reserved-cpus=0-1 --kubelet-arg=kube-reserved=cpu=500m,memory=1Gi,ephemeral-storage=1Gi --kubelet-arg=system-reserved=cpu=500m,memory=1Gi,ephemeral-storage=1Gi --kubelet-arg=container-log-max-size=10Mi --kubelet-arg=container-log-max-files=3 --kubelet-arg=serialize-image-pulls=false'

echo "Setting up worker: 7"
k3sup join \
--host 192.168.1.166 \
--server-host 192.168.1.150 \
--node-token "$NODE_TOKEN" \
--user kalmyk \
--ssh-key "$HOME/.ssh/id_ed25519" \
--k3s-extra-args '--kubelet-arg=cpu-manager-policy=static --kubelet-arg=topology-manager-policy=single-numa-node --kubelet-arg=reserved-cpus=0-1 --kubelet-arg=kube-reserved=cpu=500m,memory=1Gi,ephemeral-storage=1Gi --kubelet-arg=system-reserved=cpu=500m,memory=1Gi,ephemeral-storage=1Gi --kubelet-arg=container-log-max-size=10Mi --kubelet-arg=container-log-max-files=3 --kubelet-arg=serialize-image-pulls=false'

echo "Setting up worker: 8"
k3sup join \
--host 192.168.1.167 \
--server-host 192.168.1.150 \
--node-token "$NODE_TOKEN" \
--user kalmyk \
--ssh-key "$HOME/.ssh/id_ed25519" \
--k3s-extra-args '--kubelet-arg=cpu-manager-policy=static --kubelet-arg=topology-manager-policy=single-numa-node --kubelet-arg=reserved-cpus=0-1 --kubelet-arg=kube-reserved=cpu=500m,memory=1Gi,ephemeral-storage=1Gi --kubelet-arg=system-reserved=cpu=500m,memory=1Gi,ephemeral-storage=1Gi --kubelet-arg=container-log-max-size=10Mi --kubelet-arg=container-log-max-files=3 --kubelet-arg=serialize-image-pulls=false'

echo "Setting up worker: 9"
k3sup join \
--host 192.168.1.168 \
--server-host 192.168.1.150 \
--node-token "$NODE_TOKEN" \
--user kalmyk \
--ssh-key "$HOME/.ssh/id_ed25519" \
--k3s-extra-args '--kubelet-arg=cpu-manager-policy=static --kubelet-arg=topology-manager-policy=single-numa-node --kubelet-arg=reserved-cpus=0-1 --kubelet-arg=kube-reserved=cpu=500m,memory=1Gi,ephemeral-storage=1Gi --kubelet-arg=system-reserved=cpu=500m,memory=1Gi,ephemeral-storage=1Gi --kubelet-arg=container-log-max-size=10Mi --kubelet-arg=container-log-max-files=3 --kubelet-arg=serialize-image-pulls=false'

echo "Setting up worker: 10"
k3sup join \
--host 192.168.1.169 \
--server-host 192.168.1.150 \
--node-token "$NODE_TOKEN" \
--user kalmyk \
--ssh-key "$HOME/.ssh/id_ed25519" \
--k3s-extra-args '--kubelet-arg=cpu-manager-policy=static --kubelet-arg=topology-manager-policy=single-numa-node --kubelet-arg=reserved-cpus=0-1 --kubelet-arg=kube-reserved=cpu=500m,memory=1Gi,ephemeral-storage=1Gi --kubelet-arg=system-reserved=cpu=500m,memory=1Gi,ephemeral-storage=1Gi --kubelet-arg=container-log-max-size=10Mi --kubelet-arg=container-log-max-files=3 --kubelet-arg=serialize-image-pulls=false'

echo "Setting up worker: 11"
k3sup join \
--host 192.168.1.170 \
--server-host 192.168.1.150 \
--node-token "$NODE_TOKEN" \
--user kalmyk \
--ssh-key "$HOME/.ssh/id_ed25519" \
--k3s-extra-args '--kubelet-arg=cpu-manager-policy=static --kubelet-arg=topology-manager-policy=single-numa-node --kubelet-arg=reserved-cpus=0-1 --kubelet-arg=kube-reserved=cpu=500m,memory=1Gi,ephemeral-storage=1Gi --kubelet-arg=system-reserved=cpu=500m,memory=1Gi,ephemeral-storage=1Gi --kubelet-arg=container-log-max-size=10Mi --kubelet-arg=container-log-max-files=3 --kubelet-arg=serialize-image-pulls=false'

echo "Setting up worker: 12"
k3sup join \
--host 192.168.1.171 \
--server-host 192.168.1.150 \
--node-token "$NODE_TOKEN" \
--user kalmyk \
--ssh-key "$HOME/.ssh/id_ed25519" \
--k3s-extra-args '--kubelet-arg=cpu-manager-policy=static --kubelet-arg=topology-manager-policy=single-numa-node --kubelet-arg=reserved-cpus=0-1 --kubelet-arg=kube-reserved=cpu=500m,memory=1Gi,ephemeral-storage=1Gi --kubelet-arg=system-reserved=cpu=500m,memory=1Gi,ephemeral-storage=1Gi --kubelet-arg=container-log-max-size=10Mi --kubelet-arg=container-log-max-files=3 --kubelet-arg=serialize-image-pulls=false'

echo "Setting up worker: 13"
k3sup join \
--host 192.168.1.172 \
--server-host 192.168.1.150 \
--node-token "$NODE_TOKEN" \
--user kalmyk \
--ssh-key "$HOME/.ssh/id_ed25519" \
--k3s-extra-args '--kubelet-arg=cpu-manager-policy=static --kubelet-arg=topology-manager-policy=single-numa-node --kubelet-arg=reserved-cpus=0-1 --kubelet-arg=kube-reserved=cpu=500m,memory=1Gi,ephemeral-storage=1Gi --kubelet-arg=system-reserved=cpu=500m,memory=1Gi,ephemeral-storage=1Gi --kubelet-arg=container-log-max-size=10Mi --kubelet-arg=container-log-max-files=3 --kubelet-arg=serialize-image-pulls=false'

echo "Setting up worker: 14"
k3sup join \
--host 192.168.1.173 \
--server-host 192.168.1.150 \
--node-token "$NODE_TOKEN" \
--user kalmyk \
--ssh-key "$HOME/.ssh/id_ed25519" \
--k3s-extra-args '--kubelet-arg=cpu-manager-policy=static --kubelet-arg=topology-manager-policy=single-numa-node --kubelet-arg=reserved-cpus=0-1 --kubelet-arg=kube-reserved=cpu=500m,memory=1Gi,ephemeral-storage=1Gi --kubelet-arg=system-reserved=cpu=500m,memory=1Gi,ephemeral-storage=1Gi --kubelet-arg=container-log-max-size=10Mi --kubelet-arg=container-log-max-files=3 --kubelet-arg=serialize-image-pulls=false'

echo "Setting up worker: 15"
k3sup join \
--host 192.168.1.174 \
--server-host 192.168.1.150 \
--node-token "$NODE_TOKEN" \
--user kalmyk \
--ssh-key "$HOME/.ssh/id_ed25519" \
--k3s-extra-args '--kubelet-arg=cpu-manager-policy=static --kubelet-arg=topology-manager-policy=single-numa-node --kubelet-arg=reserved-cpus=0-1 --kubelet-arg=kube-reserved=cpu=500m,memory=1Gi,ephemeral-storage=1Gi --kubelet-arg=system-reserved=cpu=500m,memory=1Gi,ephemeral-storage=1Gi --kubelet-arg=container-log-max-size=10Mi --kubelet-arg=container-log-max-files=3 --kubelet-arg=serialize-image-pulls=false'

echo "Setting up worker: 16"
k3sup join \
--host 192.168.1.175 \
--server-host 192.168.1.150 \
--node-token "$NODE_TOKEN" \
--user kalmyk \
--ssh-key "$HOME/.ssh/id_ed25519" \
--k3s-extra-args '--kubelet-arg=cpu-manager-policy=static --kubelet-arg=topology-manager-policy=single-numa-node --kubelet-arg=reserved-cpus=0-1 --kubelet-arg=kube-reserved=cpu=500m,memory=1Gi,ephemeral-storage=1Gi --kubelet-arg=system-reserved=cpu=500m,memory=1Gi,ephemeral-storage=1Gi --kubelet-arg=container-log-max-size=10Mi --kubelet-arg=container-log-max-files=3 --kubelet-arg=serialize-image-pulls=false'

echo "Setting up worker: 17"
k3sup join \
--host 192.168.1.176 \
--server-host 192.168.1.150 \
--node-token "$NODE_TOKEN" \
--user kalmyk \
--ssh-key "$HOME/.ssh/id_ed25519" \
--k3s-extra-args '--kubelet-arg=cpu-manager-policy=static --kubelet-arg=topology-manager-policy=single-numa-node --kubelet-arg=reserved-cpus=0-1 --kubelet-arg=kube-reserved=cpu=500m,memory=1Gi,ephemeral-storage=1Gi --kubelet-arg=system-reserved=cpu=500m,memory=1Gi,ephemeral-storage=1Gi --kubelet-arg=container-log-max-size=10Mi --kubelet-arg=container-log-max-files=3 --kubelet-arg=serialize-image-pulls=false'

echo "Setting up worker: 18"
k3sup join \
--host 192.168.1.177 \
--server-host 192.168.1.150 \
--node-token "$NODE_TOKEN" \
--user kalmyk \
--ssh-key "$HOME/.ssh/id_ed25519" \
--k3s-extra-args '--kubelet-arg=cpu-manager-policy=static --kubelet-arg=topology-manager-policy=single-numa-node --kubelet-arg=reserved-cpus=0-1 --kubelet-arg=kube-reserved=cpu=500m,memory=1Gi,ephemeral-storage=1Gi --kubelet-arg=system-reserved=cpu=500m,memory=1Gi,ephemeral-storage=1Gi --kubelet-arg=container-log-max-size=10Mi --kubelet-arg=container-log-max-files=3 --kubelet-arg=serialize-image-pulls=false'

echo "Setting up worker: 19"
k3sup join \
--host 192.168.1.178 \
--server-host 192.168.1.150 \
--node-token "$NODE_TOKEN" \
--user kalmyk \
--ssh-key "$HOME/.ssh/id_ed25519" \
--k3s-extra-args '--kubelet-arg=cpu-manager-policy=static --kubelet-arg=topology-manager-policy=single-numa-node --kubelet-arg=reserved-cpus=0-1 --kubelet-arg=kube-reserved=cpu=500m,memory=1Gi,ephemeral-storage=1Gi --kubelet-arg=system-reserved=cpu=500m,memory=1Gi,ephemeral-storage=1Gi --kubelet-arg=container-log-max-size=10Mi --kubelet-arg=container-log-max-files=3 --kubelet-arg=serialize-image-pulls=false'

echo "Setting up worker: 20"
k3sup join \
--host 192.168.1.179 \
--server-host 192.168.1.150 \
--node-token "$NODE_TOKEN" \
--user kalmyk \
--ssh-key "$HOME/.ssh/id_ed25519" \
--k3s-extra-args '--kubelet-arg=cpu-manager-policy=static --kubelet-arg=topology-manager-policy=single-numa-node --kubelet-arg=reserved-cpus=0-1 --kubelet-arg=kube-reserved=cpu=500m,memory=1Gi,ephemeral-storage=1Gi --kubelet-arg=system-reserved=cpu=500m,memory=1Gi,ephemeral-storage=1Gi --kubelet-arg=container-log-max-size=10Mi --kubelet-arg=container-log-max-files=3 --kubelet-arg=serialize-image-pulls=false'

echo "Setting up worker: 21"
k3sup join \
--host 192.168.1.180 \
--server-host 192.168.1.150 \
--node-token "$NODE_TOKEN" \
--user kalmyk \
--ssh-key "$HOME/.ssh/id_ed25519" \
--k3s-extra-args '--kubelet-arg=cpu-manager-policy=static --kubelet-arg=topology-manager-policy=single-numa-node --kubelet-arg=reserved-cpus=0-1 --kubelet-arg=kube-reserved=cpu=500m,memory=1Gi,ephemeral-storage=1Gi --kubelet-arg=system-reserved=cpu=500m,memory=1Gi,ephemeral-storage=1Gi --kubelet-arg=container-log-max-size=10Mi --kubelet-arg=container-log-max-files=3 --kubelet-arg=serialize-image-pulls=false'

echo "Setting up worker: 22"
k3sup join \
--host 192.168.1.181 \
--server-host 192.168.1.150 \
--node-token "$NODE_TOKEN" \
--user kalmyk \
--ssh-key "$HOME/.ssh/id_ed25519" \
--k3s-extra-args '--kubelet-arg=cpu-manager-policy=static --kubelet-arg=topology-manager-policy=single-numa-node --kubelet-arg=reserved-cpus=0-1 --kubelet-arg=kube-reserved=cpu=500m,memory=1Gi,ephemeral-storage=1Gi --kubelet-arg=system-reserved=cpu=500m,memory=1Gi,ephemeral-storage=1Gi --kubelet-arg=container-log-max-size=10Mi --kubelet-arg=container-log-max-files=3 --kubelet-arg=serialize-image-pulls=false'

echo "Setting up worker: 23"
k3sup join \
--host 192.168.1.182 \
--server-host 192.168.1.150 \
--node-token "$NODE_TOKEN" \
--user kalmyk \
--ssh-key "$HOME/.ssh/id_ed25519" \
--k3s-extra-args '--kubelet-arg=cpu-manager-policy=static --kubelet-arg=topology-manager-policy=single-numa-node --kubelet-arg=reserved-cpus=0-1 --kubelet-arg=kube-reserved=cpu=500m,memory=1Gi,ephemeral-storage=1Gi --kubelet-arg=system-reserved=cpu=500m,memory=1Gi,ephemeral-storage=1Gi --kubelet-arg=container-log-max-size=10Mi --kubelet-arg=container-log-max-files=3 --kubelet-arg=serialize-image-pulls=false'

echo "Setting up worker: 24"
k3sup join \
--host 192.168.1.183 \
--server-host 192.168.1.150 \
--node-token "$NODE_TOKEN" \
--user kalmyk \
--ssh-key "$HOME/.ssh/id_ed25519" \
--k3s-extra-args '--kubelet-arg=cpu-manager-policy=static --kubelet-arg=topology-manager-policy=single-numa-node --kubelet-arg=reserved-cpus=0-1 --kubelet-arg=kube-reserved=cpu=500m,memory=1Gi,ephemeral-storage=1Gi --kubelet-arg=system-reserved=cpu=500m,memory=1Gi,ephemeral-storage=1Gi --kubelet-arg=container-log-max-size=10Mi --kubelet-arg=container-log-max-files=3 --kubelet-arg=serialize-image-pulls=false'

echo "Setting up worker: 25"
k3sup join \
--host 192.168.1.184 \
--server-host 192.168.1.150 \
--node-token "$NODE_TOKEN" \
--user kalmyk \
--ssh-key "$HOME/.ssh/id_ed25519" \
--k3s-extra-args '--kubelet-arg=cpu-manager-policy=static --kubelet-arg=topology-manager-policy=single-numa-node --kubelet-arg=reserved-cpus=0-1 --kubelet-arg=kube-reserved=cpu=500m,memory=1Gi,ephemeral-storage=1Gi --kubelet-arg=system-reserved=cpu=500m,memory=1Gi,ephemeral-storage=1Gi --kubelet-arg=container-log-max-size=10Mi --kubelet-arg=container-log-max-files=3 --kubelet-arg=serialize-image-pulls=false'

echo "Setting up worker: 26"
k3sup join \
--host 192.168.1.185 \
--server-host 192.168.1.150 \
--node-token "$NODE_TOKEN" \
--user kalmyk \
--ssh-key "$HOME/.ssh/id_ed25519" \
--k3s-extra-args '--kubelet-arg=cpu-manager-policy=static --kubelet-arg=topology-manager-policy=single-numa-node --kubelet-arg=reserved-cpus=0-1 --kubelet-arg=kube-reserved=cpu=500m,memory=1Gi,ephemeral-storage=1Gi --kubelet-arg=system-reserved=cpu=500m,memory=1Gi,ephemeral-storage=1Gi --kubelet-arg=container-log-max-size=10Mi --kubelet-arg=container-log-max-files=3 --kubelet-arg=serialize-image-pulls=false'

echo "Setting up worker: 27"
k3sup join \
--host 192.168.1.186 \
--server-host 192.168.1.150 \
--node-token "$NODE_TOKEN" \
--user kalmyk \
--ssh-key "$HOME/.ssh/id_ed25519" \
--k3s-extra-args '--kubelet-arg=cpu-manager-policy=static --kubelet-arg=topology-manager-policy=single-numa-node --kubelet-arg=reserved-cpus=0-1 --kubelet-arg=kube-reserved=cpu=500m,memory=1Gi,ephemeral-storage=1Gi --kubelet-arg=system-reserved=cpu=500m,memory=1Gi,ephemeral-storage=1Gi --kubelet-arg=container-log-max-size=10Mi --kubelet-arg=container-log-max-files=3 --kubelet-arg=serialize-image-pulls=false'

echo "Setting up worker: 28"
k3sup join \
--host 192.168.1.187 \
--server-host 192.168.1.150 \
--node-token "$NODE_TOKEN" \
--user kalmyk \
--ssh-key "$HOME/.ssh/id_ed25519" \
--k3s-extra-args '--kubelet-arg=cpu-manager-policy=static --kubelet-arg=topology-manager-policy=single-numa-node --kubelet-arg=reserved-cpus=0-1 --kubelet-arg=kube-reserved=cpu=500m,memory=1Gi,ephemeral-storage=1Gi --kubelet-arg=system-reserved=cpu=500m,memory=1Gi,ephemeral-storage=1Gi --kubelet-arg=container-log-max-size=10Mi --kubelet-arg=container-log-max-files=3 --kubelet-arg=serialize-image-pulls=false'

echo "Setting up worker: 29"
k3sup join \
--host 192.168.1.188 \
--server-host 192.168.1.150 \
--node-token "$NODE_TOKEN" \
--user kalmyk \
--ssh-key "$HOME/.ssh/id_ed25519" \
--k3s-extra-args '--kubelet-arg=cpu-manager-policy=static --kubelet-arg=topology-manager-policy=single-numa-node --kubelet-arg=reserved-cpus=0-1 --kubelet-arg=kube-reserved=cpu=500m,memory=1Gi,ephemeral-storage=1Gi --kubelet-arg=system-reserved=cpu=500m,memory=1Gi,ephemeral-storage=1Gi --kubelet-arg=container-log-max-size=10Mi --kubelet-arg=container-log-max-files=3 --kubelet-arg=serialize-image-pulls=false'

echo "Setting up worker: 30"
k3sup join \
--host 192.168.1.189 \
--server-host 192.168.1.150 \
--node-token "$NODE_TOKEN" \
--user kalmyk \
--ssh-key "$HOME/.ssh/id_ed25519" \
--k3s-extra-args '--kubelet-arg=cpu-manager-policy=static --kubelet-arg=topology-manager-policy=single-numa-node --kubelet-arg=reserved-cpus=0-1 --kubelet-arg=kube-reserved=cpu=500m,memory=1Gi,ephemeral-storage=1Gi --kubelet-arg=system-reserved=cpu=500m,memory=1Gi,ephemeral-storage=1Gi --kubelet-arg=container-log-max-size=10Mi --kubelet-arg=container-log-max-files=3 --kubelet-arg=serialize-image-pulls=false'
