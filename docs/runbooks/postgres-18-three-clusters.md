# PostgreSQL 18 preparation: Buzz, Jangar and Torghut

The serving databases remain on their qualified PostgreSQL 17.11 images.
Enable CloudNativePG's existing CSI volume snapshot backup method with the
`rook-ceph-block` class in addition to each cluster's existing Barman archive.
This configuration change preserves the Barman destinations, server names,
credentials, retention, topology and application images.

After normal Kargo/GitOps delivery, verify the live snapshot configuration on
all three source clusters before creating the generation's cold primary
Backups. Record their original cluster/PVC identities and native control data,
retain the snapshots, restore isolated 17.11 clones, then qualify PostgreSQL
18.6 against those clones. Use Trixie for Buzz and Bullseye for Jangar/Torghut.
The existing original four-cluster recovery phase must not be applied to
already upgraded clones; add these new source clones without downgrading any
existing data volume.

This preparation alone creates no backup and changes no serving version.
The later cold snapshot briefly stops each selected primary; execute and
verify backups before any major image activation. PostgreSQL 18 activation
also requires a new Barman server prefix for that major version, preserved
credential identity, a successful new-major archive/backup, and native restore
verification. Do not mix PostgreSQL 18 backups or WAL with the retained
PostgreSQL 17 archive lineage. Preserve every native original snapshot and
archive until the complete rollout and recovery checks pass.
