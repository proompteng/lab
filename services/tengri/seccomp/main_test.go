//go:build linux

package main

import (
	"reflect"
	"testing"

	"github.com/containerd/containerd/v2/contrib/seccomp"
	"github.com/opencontainers/runtime-spec/specs-go"
)

func TestPreservesRuntimeDefaultAndOnlyAddsConstrainedUringCalls(t *testing.T) {
	baseline := seccomp.DefaultProfile(&specs.Spec{Process: &specs.Process{
		Capabilities: &specs.LinuxCapabilities{Bounding: []string{"CAP_MKNOD", "CAP_SETUID", "CAP_SETGID"}},
	}})
	actual := profile()
	added := actual.Syscalls[len(baseline.Syscalls):]
	actual.Syscalls = actual.Syscalls[:len(baseline.Syscalls)]
	if !reflect.DeepEqual(actual, baseline) {
		t.Fatal("containerd RuntimeDefault confinement changed")
	}
	if len(added) != 9 {
		t.Fatalf("unexpected additional rules: %v", added)
	}
	for _, rule := range added {
		if rule.Action != specs.ActAllow || len(rule.Names) != 1 || len(rule.Args) != 1 || rule.Args[0].Op != specs.OpEqualTo {
			t.Fatalf("unrestricted rule: %+v", rule)
		}
		switch rule.Names[0] {
		case "io_uring_setup":
			if rule.Args[0].Index != 0 || rule.Args[0].Value != 128 {
				t.Fatal("ring size is not bounded to Firecracker's 128 entries")
			}
		case "io_uring_enter":
			if rule.Args[0].Index != 3 || rule.Args[0].Value > 1 {
				t.Fatal("unexpected enter flags")
			}
		case "io_uring_register":
			if rule.Args[0].Index != 1 || !map[uint64]bool{2: true, 4: true, 8: true, 11: true, 12: true, 19: true}[rule.Args[0].Value] {
				t.Fatal("unexpected register operation")
			}
		default:
			t.Fatalf("unexpected syscall: %v", rule.Names)
		}
	}
}
