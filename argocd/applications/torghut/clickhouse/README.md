# Keeper storage

Keeper uses its existing Ceph RBD claim. The local NVMe migration was not activated, and no dedicated Keeper
StorageClass is provisioned. Preserve the existing PVC, server identity and native membership during rollouts.
