# Harvester

## Install opentofu

```bash
brew install opentofu
```

Force delete virtual machine:

```bash
ssh rancher@192.168.1.56
sudo su
kubectl get virtualmachineinstances.kubevirt.io
kubectl delete virtualmachineinstances.kubevirt.io rancher2
```
