# Recreate Turin's Three 24TB OSDs

This runbook is for the path where the old external DB device is abandoned and
the three transferred 24TB HDDs are reused as new Rook/Ceph OSDs on `turin`.

This is a historical emergency recreate path. For the current healthy-cluster
performance restore, use `docs/runbooks/rook-ceph-on-talos.md` and keep Turin's
`metadataDevice` on the Kingston 1TB NVMe so replacement HDD OSDs are prepared
with active BlueStore DB/WAL.

This path is destructive to old OSD IDs `0`, `1`, and `2`. It does not wipe the
ORICO Talos OS disk.

## Execution Status

The destructive precondition was accepted before execution.

Completed:

- Ceph reported no inactive PGs and no stale PGs before the purge.
- Old OSD identities `0`, `1`, and `2` were purged from the Ceph cluster.
- The three old HDD-backed LVM OSD block volumes were zapped on `turin`.
- `ceph-volume lvm list --format json` returned `{}` inside the Turin zap pod
  after the zap.
- The temporary `turin-ceph-osd-zap` pod was deleted.
- `argocd/applications/rook-ceph/cluster-values.yaml` now points the second
  storage node at `turin`, keeps only the three 24TB HDD by-id paths, and omits
  `metadataDevice` for that node.

Remaining:

- Sync Argo CD for `rook-ceph`.
- Watch Rook prepare and create the replacement OSDs on `turin`.
- Validate Ceph recovery/backfill and final health.

## Current Evidence

Turin sees the three transferred HDDs:

```text
/dev/disk/by-id/ata-ST24000NM000C-3WD103_ZXA0NL5D
/dev/disk/by-id/ata-ST24000NM000C-3WD103_ZXA0MZ1M
/dev/disk/by-id/ata-ST24000NM000C-3WD103_ZXA0LVM9
```

`ceph-volume lvm list` sees old OSDs `0`, `1`, and `2` on those drives, but all
three have LVM tags pointing to absent external DB LVs:

```text
osd.0 db uuid mkCFn0-dZlx-qwyp-DBpf-hTjy-P8Ox-Ie1uVk
osd.1 db uuid 5tt84t-fD4F-LEnh-WyqM-AT8r-OZyy-0APfRc
osd.2 db uuid VTAxqx-egqu-IfU4-VonO-zNiJ-zW2s-2yb2Tb
```

`ceph-volume lvm activate --no-systemd --bluestore` fails for each old OSD
because the external DB LV is missing. Recreating the three HDDs as new OSDs is
therefore a different operation from adopting the old OSDs.

## Preconditions

Run these immediately before any purge/zap:

```bash
kubectl --context galactic-tailscale -n rook-ceph exec deploy/rook-ceph-tools -- ceph -s
kubectl --context galactic-tailscale -n rook-ceph exec deploy/rook-ceph-tools -- ceph pg dump_stuck inactive
kubectl --context galactic-tailscale -n rook-ceph exec deploy/rook-ceph-tools -- ceph pg dump_stuck stale
kubectl --context galactic-tailscale -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd tree
```

Expected preflight shape:

- `ceph pg dump_stuck inactive` returns `ok`.
- `ceph pg dump_stuck stale` returns `ok`.
- Pools remain active with `size 2` and `min_size 1`.
- OSDs `0`, `1`, and `2` are down under `talos-192-168-1-203`.
- OSDs `3`, `4`, and `5` are up under `talos-192-168-1-85`.

Do not use `ceph osd safe-to-destroy 0 1 2` as the sole gate here. In the
current degraded posture it returns inconclusive because the old OSDs have no
reported stats and the cluster is not `active+clean`.

## Purge Old OSD Identities

Only run this after accepting that old OSD IDs `0`, `1`, and `2` are not being
recovered.

```bash
kubectl --context galactic-tailscale -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd purge 0 --yes-i-really-mean-it
kubectl --context galactic-tailscale -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd purge 1 --yes-i-really-mean-it
kubectl --context galactic-tailscale -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd purge 2 --yes-i-really-mean-it
```

Verify the old IDs are gone:

```bash
kubectl --context galactic-tailscale -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd tree
```

## Zap Old HDD LVM OSD Blocks

Create a temporary privileged pod on `turin`:

```bash
kubectl --context galactic-tailscale -n rook-ceph apply -f - <<'EOF'
apiVersion: v1
kind: Pod
metadata:
  name: turin-ceph-osd-zap
spec:
  restartPolicy: Never
  nodeSelector:
    kubernetes.io/hostname: turin
  tolerations:
    - operator: Exists
  containers:
    - name: ceph
      image: quay.io/ceph/ceph:v19.2.3
      imagePullPolicy: IfNotPresent
      command: ["/bin/bash", "-lc", "sleep 3600"]
      env:
        - name: CEPH_VOLUME_DEBUG
          value: "1"
        - name: CEPH_VOLUME_SKIP_RESTORECON
          value: "1"
        - name: DM_DISABLE_UDEV
          value: "1"
      securityContext:
        privileged: true
        runAsUser: 0
      volumeMounts:
        - name: dev
          mountPath: /dev
        - name: run-udev
          mountPath: /run/udev
          readOnly: true
  volumes:
    - name: dev
      hostPath:
        path: /dev
    - name: run-udev
      hostPath:
        path: /run/udev
EOF

kubectl --context galactic-tailscale -n rook-ceph wait --for=condition=Ready pod/turin-ceph-osd-zap --timeout=120s
```

Confirm the target LVs are exactly the three old HDD-backed OSD blocks:

```bash
kubectl --context galactic-tailscale -n rook-ceph exec turin-ceph-osd-zap -- ceph-volume lvm list --format json
```

Zap only these three old OSD block LVs:

```bash
kubectl --context galactic-tailscale -n rook-ceph exec turin-ceph-osd-zap -- \
  ceph-volume lvm zap --destroy /dev/ceph-af8f93cb-80cc-43fb-9a3b-d927c95534e5/osd-block-834f32e1-93b0-4f79-91ad-5a6771bdf38b

kubectl --context galactic-tailscale -n rook-ceph exec turin-ceph-osd-zap -- \
  ceph-volume lvm zap --destroy /dev/ceph-4f30c39a-cd26-427b-9d15-18a15333b1d0/osd-block-63a3b2d6-0d39-436f-a517-4296d04e782c

kubectl --context galactic-tailscale -n rook-ceph exec turin-ceph-osd-zap -- \
  ceph-volume lvm zap --destroy /dev/ceph-c04a0830-d083-47fe-8cc9-b25314cd7137/osd-block-6c12f6b3-23dd-4cb1-b482-673f3c160ffc
```

Delete the temporary pod:

```bash
kubectl --context galactic-tailscale -n rook-ceph delete pod turin-ceph-osd-zap
```

## GitOps Change

This section is retained only for the earlier emergency recreate. Do not use it
for the current healthy-cluster NVMe DB/WAL migration.

Use `devices/turin/docs/rook-ceph-turin-recreate-osds-values-draft.yaml` as the
replacement shape for the second storage node in
`argocd/applications/rook-ceph/cluster-values.yaml` only when intentionally
abandoning the external DB path.

The intended storage section is:

```yaml
nodes:
  - name: talos-192-168-1-85
    config:
      metadataDevice: /dev/disk/by-id/nvme-CT4000P3PSSD8_2402E88D0863
    devices:
      - name: /dev/disk/by-id/ata-ST24000NM000C-3WD103_ZXA12R7C
      - name: /dev/disk/by-id/ata-ST24000NM000C-3WD103_ZXA0LKW9
      - name: /dev/disk/by-id/ata-ST24000NM000C-3WD103_ZXA0HS7E
  - name: turin
    devices:
      - name: /dev/disk/by-id/ata-ST24000NM000C-3WD103_ZXA0NL5D
      - name: /dev/disk/by-id/ata-ST24000NM000C-3WD103_ZXA0MZ1M
      - name: /dev/disk/by-id/ata-ST24000NM000C-3WD103_ZXA0LVM9
```

Do not set `useAllDevices: true`. Do not include the ORICO OS disk. Do not
include a `metadataDevice` for `turin` on this recreate path.

## Sync And Watch

After the GitOps change is committed and pushed:

```bash
argocd app sync rook-ceph

kubectl --context galactic-tailscale -n rook-ceph get pods -o wide
kubectl --context galactic-tailscale -n rook-ceph get jobs -o wide | rg 'osd-prepare|turin'
kubectl --context galactic-tailscale -n rook-ceph logs -f job/rook-ceph-osd-prepare-turin
```

Validate the result:

```bash
kubectl --context galactic-tailscale -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd tree
kubectl --context galactic-tailscale -n rook-ceph exec deploy/rook-ceph-tools -- ceph -s
kubectl --context galactic-tailscale -n rook-ceph exec deploy/rook-ceph-tools -- ceph health detail
```

Expected direction after successful OSD creation:

- three new OSDs appear under host `turin`;
- PGs move from undersized/degraded into recovery/backfill;
- final clean state may take time because about half of the replicated objects
  are currently degraded.
