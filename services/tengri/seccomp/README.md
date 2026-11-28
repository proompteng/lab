# Runner seccomp profile

The runner uses containerd 2.3.4's default profile for its existing startup capabilities
(`MKNOD`, `SETUID`, `SETGID`). The generator adds only `io_uring_setup` with 128 entries,
`io_uring_enter` with flags 0 or `GETEVENTS`, and the six registration operations used by
the pinned Firecracker. All other rules are preserved. Firecracker then drops every
capability, runs as UID 65532 with `NoNewPrivs`, and installs its own release seccomp filter.

From this directory, run `bash generate.sh` to test and regenerate both native Talos
machine patches in `devices/galactic/omni/tengri-runner-{amd64,arm64}.json`. Generation
requires Go and Docker. Revalidate the baseline when the host containerd version changes.

The current runner's RuntimeDefault profile rejects `io_uring_setup`. Async therefore
needs an explicit profile; selecting Async without it fails drive creation. This is a
container confinement restriction rather than a missing Talos kernel feature.

Talos 1.14 supports `machine.seccompProfiles` directly. Omni owns these machine patches;
Talos reconciles the named profile into `/var/lib/kubelet/seccomp/profiles/tengri-runner.json`.
No DaemonSet installer, hostPath write, system extension, kernel upgrade, or node reboot
is required. Slot admission selects `profiles/tengri-runner.json` only for the runner
and retains RuntimeDefault on every other container. A missing profile fails closed
at kubelet; it does not silently fall back to a weaker profile. Admission also permits
RuntimeDefault for runners, which grants fewer syscalls; the Async runner always selects
the named profile and fails boot if its calls are denied.

Render, validate, and dry-run the exact current Omni desired state using the
[Omni procedure](../../../devices/galactic/omni/README.md), then sync only after the
permission change has been approved. Verify the profile resource, file contents,
and runner startup before the fenced slot cutover. Roll back through the previous
immutable image pair and RuntimeDefault desired state with a fenced cold replacement;
snapshots from the new VMM revision must not be restored by the old one.

Both drives use Firecracker's Async engine with Writeback, so guest flushes reach storage.
Firecracker restricts each 128-entry ring to fixed-file read, write, and fsync. The packaged
patch bounds both worker classes to four workers per ring and aborts boot if the bound
cannot be installed. Seccomp checks scalar syscall arguments; it cannot inspect pointed-to
ring parameters or replace those VMM-enforced restrictions. The native fixture must prove
worker limits and cgroup attribution on the deployed kernel, and enforces a 512-PID ceiling.
No fallback to synchronous I/O is provided.

Upstream still calls Async a developer preview; this experimental adoption requires the
native KVM lifecycle, disk-error and responsiveness checks rather than treating the API
setting as proof. See [Firecracker's engine contract](https://github.com/firecracker-microvm/firecracker/blob/v1.16.1/docs/api_requests/block-io-engine.md),
[Talos's profile schema](https://github.com/siderolabs/talos/blob/v1.14.0/pkg/machinery/config/types/v1alpha1/v1alpha1_types.go),
[Talos's file reconciler](https://github.com/siderolabs/talos/blob/v1.14.0/internal/app/machined/pkg/controllers/cri/seccomp_profile_file.go),
[containerd's profile](https://github.com/containerd/containerd/blob/v2.3.4/contrib/seccomp/seccomp_default.go),
and [the worker limit API](https://kernel.googlesource.com/pub/scm/linux/kernel/git/axboe/liburing/+/refs/tags/liburing-2.11-rc1/man/io_uring_register_iowq_max_workers.3).
