//go:build linux

package main

import (
	"encoding/json"
	"fmt"
	"os"
	"runtime"

	"github.com/containerd/containerd/v2/contrib/seccomp"
	"github.com/opencontainers/runtime-spec/specs-go"
)

func profile() *specs.LinuxSeccomp {
	baseline := seccomp.DefaultProfile(&specs.Spec{Process: &specs.Process{
		Capabilities: &specs.LinuxCapabilities{Bounding: []string{"CAP_MKNOD", "CAP_SETUID", "CAP_SETGID"}},
	}})
	baseline.Syscalls = append(baseline.Syscalls, specs.LinuxSyscall{
		Names:  []string{"io_uring_setup"},
		Action: specs.ActAllow,
		Args:   []specs.LinuxSeccompArg{{Index: 0, Value: 128, Op: specs.OpEqualTo}},
	})
	for _, flags := range []uint64{0, 1} {
		baseline.Syscalls = append(baseline.Syscalls, specs.LinuxSyscall{
			Names:  []string{"io_uring_enter"},
			Action: specs.ActAllow,
			Args:   []specs.LinuxSeccompArg{{Index: 3, Value: flags, Op: specs.OpEqualTo}},
		})
	}
	// FILES, EVENTFD, PROBE, RESTRICTIONS, ENABLE_RINGS, IOWQ_MAX_WORKERS.
	for _, operation := range []uint64{2, 4, 8, 11, 12, 19} {
		baseline.Syscalls = append(baseline.Syscalls, specs.LinuxSyscall{
			Names:  []string{"io_uring_register"},
			Action: specs.ActAllow,
			Args:   []specs.LinuxSeccompArg{{Index: 1, Value: operation, Op: specs.OpEqualTo}},
		})
	}
	return baseline
}

func main() {
	if runtime.GOARCH != "amd64" && runtime.GOARCH != "arm64" {
		fmt.Fprintln(os.Stderr, "Tengri requires amd64 or arm64")
		os.Exit(1)
	}
	encoder := json.NewEncoder(os.Stdout)
	encoder.SetIndent("", "  ")
	patch := map[string]any{"machine": map[string]any{"seccompProfiles": []map[string]any{{
		"name": "tengri-runner.json", "value": profile(),
	}}}}
	if err := encoder.Encode(patch); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
