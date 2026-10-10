package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestDeveloperProfileConfiguresShellWithoutStartingHomebrew(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("guest profile requires a POSIX shell")
	}
	profile, err := filepath.Abs("developer-profile.sh")
	if err != nil {
		t.Fatal(err)
	}
	for _, scenario := range []struct {
		name      string
		installed bool
		env       []string
		manpath   string
		infopath  string
		editor    string
		visual    string
	}{
		{name: "installed defaults", installed: true, manpath: "<unset>", editor: "nvim", visual: "nvim"},
		{name: "installed custom settings", installed: true, env: []string{"MANPATH=::/manuals::", "INFOPATH=/info", "EDITOR=vim", "VISUAL=code"}, manpath: ":/manuals", infopath: "/info", editor: "vim", visual: "code"},
		{name: "installed empty manual path", installed: true, env: []string{"MANPATH="}, manpath: "", editor: "nvim", visual: "nvim"},
		{name: "uninstalled", manpath: "<unset>", infopath: "<unset>", editor: "nvim", visual: "nvim"},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			home := t.TempDir()
			prefix := filepath.Join(home, ".linuxbrew")
			if scenario.installed {
				if err := os.MkdirAll(filepath.Join(prefix, "bin"), 0o755); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(filepath.Join(prefix, "bin", "brew"), []byte("#!/bin/sh\n: > \"$HOME/brew-started\"\nexit 97\n"), 0o755); err != nil {
					t.Fatal(err)
				}
			}
			command := exec.Command("/bin/sh", "-c", `. "$1"
printf '%s\n' "${HOMEBREW_PREFIX-<unset>}" "${HOMEBREW_CELLAR-<unset>}" "${HOMEBREW_REPOSITORY-<unset>}" "$PATH" "${MANPATH-<unset>}" "${INFOPATH-<unset>}" "$EDITOR" "$VISUAL"
`, "profile-test", profile)
			command.Env = append([]string{"HOME=" + home, "PATH=/usr/bin:/bin"}, scenario.env...)
			output, err := command.CombinedOutput()
			if err != nil {
				t.Fatalf("source profile: %v: %s", err, output)
			}
			if _, err := os.Stat(filepath.Join(home, "brew-started")); !os.IsNotExist(err) {
				t.Fatalf("shell startup executed Homebrew: %v", err)
			}
			path := home + "/.local/bin:" + home + "/go/bin:" + home + "/.cargo/bin:"
			want := []string{"<unset>", "<unset>", "<unset>", "", scenario.manpath, scenario.infopath, scenario.editor, scenario.visual}
			if scenario.installed {
				want[0], want[1], want[2] = prefix, prefix+"/Cellar", prefix+"/Homebrew"
				path += prefix + "/bin:" + prefix + "/sbin:"
				want[5] = prefix + "/share/info:" + scenario.infopath
			}
			want[3] = path + "/usr/bin:/bin"
			if string(output) != strings.Join(want, "\n")+"\n" {
				t.Fatalf("profile environment = %q, want %q", output, strings.Join(want, "\n"))
			}
		})
	}
}
