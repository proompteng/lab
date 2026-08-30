# KubeVirt On Turin

Turin can host ordinary KubeVirt VMs after KubeVirt infra pods are scheduled on
the node. This is separate from NVIDIA GPU passthrough.

## Current Boundary

Plain VMs require:

- CPU virtualization exposed by the host (`svm` on AMD).
- `/dev/kvm`.
- `/dev/vhost-net`.
- `/dev/net/tun`.
- `virt-handler` running on the node.

The live Turin readback already showed the host prerequisites. The GitOps change
for plain VMs is a KubeVirt component customization that lets only
`virt-handler` tolerate Turin's control-plane taint:

```yaml
spec:
  customizeComponents:
    patches:
      - resourceType: DaemonSet
        resourceName: virt-handler
        type: strategic
        patch: '{"spec":{"template":{"spec":{"tolerations":[{"key":"CriticalAddonsOnly","operator":"Exists"},{"key":"node-role.kubernetes.io/control-plane","operator":"Exists","effect":"NoSchedule"}]}}}}'
```

Do not add broad KubeVirt workload placement. VMs that should run on Turin must
opt in with their own `nodeSelector` and toleration.

KubeVirt validates `customizeComponents.patches[].patch` as JSON even when the
patch type is `strategic`. Do not use YAML block syntax for this field.

## Pre-Sync Checks

```bash
talosctl -n 100.100.244.171 read /proc/cpuinfo | rg -m 1 'svm|vmx'
talosctl -n 100.100.244.171 ls /dev | rg 'kvm|vhost-net|vhost-vsock'
talosctl -n 100.100.244.171 ls /dev/net | rg '^100.100.244.171 +tun$'
kubectl get node turin -o json | jq '.spec.taints, .metadata.labels["kubevirt.io/schedulable"]'
kubectl -n kubevirt get ds virt-handler -o json | jq '.spec.template.spec.tolerations'
```

Expected before the KubeVirt patch is synced:

- KVM, vhost, and tun are present.
- Turin has the `node-role.kubernetes.io/control-plane=NoSchedule` taint.
- `virt-handler` does not yet run on Turin.

## Post-Sync Checks

```bash
kubectl -n kubevirt rollout status ds/virt-handler --timeout=10m
kubectl -n kubevirt get pod -o wide | rg 'virt-handler|turin'
kubectl get node turin -o json | jq -r '.metadata.labels["kubevirt.io/schedulable"]'
kubectl get vms,vmis --all-namespaces -o wide
```

Expected:

- A `virt-handler` pod runs on Turin.
- Turin is labeled `kubevirt.io/schedulable=true`.
- Existing `saigak` and `openclaw` VMs stay Running on their current nodes.

## Temporary Non-GPU Canary

Use a canary VMI that requests no GPU, no PVC, and no host devices. Set
`architecture: amd64`; otherwise KubeVirt can default the guest architecture from
existing components and leave the launcher pod unschedulable on Turin. Delete it
immediately after the scheduling and boot check.

```yaml
apiVersion: kubevirt.io/v1
kind: VirtualMachineInstance
metadata:
  name: turin-kubevirt-canary
  namespace: kubevirt
spec:
  architecture: amd64
  nodeSelector:
    kubernetes.io/arch: amd64
    kubernetes.io/hostname: turin
  tolerations:
    - key: node-role.kubernetes.io/control-plane
      operator: Exists
      effect: NoSchedule
  domain:
    devices:
      disks:
        - name: containerdisk
          disk:
            bus: virtio
        - name: cloudinitdisk
          disk:
            bus: virtio
    resources:
      requests:
        memory: 512Mi
  volumes:
    - name: containerdisk
      containerDisk:
        image: quay.io/kubevirt/cirros-container-disk-demo
    - name: cloudinitdisk
      cloudInitNoCloud:
        userData: |-
          #cloud-config
          password: turin
          chpasswd: { expire: False }
```

Apply and clean up:

```bash
kubectl apply -f /tmp/turin-kubevirt-canary.yaml
kubectl -n kubevirt wait vmi/turin-kubevirt-canary --for=condition=Ready --timeout=5m
kubectl -n kubevirt get vmi turin-kubevirt-canary -o wide
kubectl -n kubevirt delete vmi turin-kubevirt-canary --wait=true
```

## GPU Passthrough Is A Separate Project

Do not mix GPU passthrough with the Flamingo Kubernetes GPU pod lane.

GPU passthrough VMs would require a separate plan:

- Confirm IOMMU groups and boot arguments such as `amd_iommu=on` if needed.
- Add Talos VFIO module preload, following the `devices/altra` pattern:
  `vfio`, `vfio_iommu_type1`, `vfio_pci`, and `irqbypass`.
- Switch the target GPU away from the host NVIDIA driver path.
- Configure NVIDIA GPU Operator sandbox workload mode and VFIO manager.
- Add a Turin-specific KubeVirt `permittedHostDevices` entry for the Blackwell
  PCI ID.
- Stop container GPU workloads before rebinding the device.

That would make the GPU unavailable to normal Kubernetes pods, so it is not part
of Flamingo.
