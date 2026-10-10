//go:build linux

package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/exec"
	"syscall"
	"time"

	"github.com/mdlayher/vsock"
	"golang.org/x/sys/unix"
)

type guestSlotConfig struct {
	PodUID         string `json:"podUid"`
	Token          string `json:"token"`
	InitializeHome bool   `json:"initializeHome"`
}

type guestClaim struct {
	MicroVMID  string `json:"microvmId"`
	MicroVMUID string `json:"microvmUid"`
	Epoch      uint64 `json:"epoch"`
}

type guestLifecycleRequest struct {
	Action        string     `json:"action"`
	Claim         guestClaim `json:"claim"`
	UnixTimeNanos int64      `json:"unixTimeNanos"`
}

type guestLifecycle struct {
	root, home *os.File
	claim      *guestClaim
	frozen     bool
	terminal   *guestReadinessTerminal
}

const fsFreeze = 0xC0045877
const fsThaw = 0xC0045878

func runGuestInit(logger *slog.Logger) error {
	if os.Geteuid() != 0 {
		return errors.New("guest init requires guest root")
	}
	contents, err := os.ReadFile("/etc/tengri-slot.json")
	if err != nil {
		return err
	}
	var config guestSlotConfig
	if err := json.Unmarshal(contents, &config); err != nil {
		return err
	}
	clear(contents)
	if config.PodUID == "" || len(config.Token) < 32 {
		return errors.New("invalid private slot configuration")
	}
	if err := mountGuestHome(config.InitializeHome); err != nil {
		return err
	}
	root, err := os.Open("/")
	if err != nil {
		return err
	}
	defer root.Close()
	home, err := os.Open("/home/nanoagent")
	if err != nil {
		return err
	}
	defer home.Close()
	terminal, err := startGuestReadinessTerminal("/home/nanoagent/workspace", &syscall.Credential{Uid: 1000, Gid: 1000})
	if err != nil {
		return err
	}
	defer terminal.close()
	lifecycle := &guestLifecycle{root: root, home: home, terminal: terminal}
	listener, err := vsock.Listen(1025, nil)
	if err != nil {
		return err
	}
	defer listener.Close()
	reader, writer, err := os.Pipe()
	if err != nil {
		return err
	}
	defer reader.Close()
	if _, err := io.WriteString(writer, config.Token); err != nil {
		_ = writer.Close()
		return err
	}
	if err := writer.Close(); err != nil {
		return err
	}
	process := exec.Command("/usr/local/bin/nanoagent")
	process.Env = append(childEnvironment(),
		"MICROVM_ID="+config.PodUID, "MICROVM_BOOTSTRAP_TOKEN_FD=3")
	process.ExtraFiles = []*os.File{reader}
	process.SysProcAttr = &syscall.SysProcAttr{Credential: &syscall.Credential{Uid: 1000, Gid: 1000}, Setpgid: true}
	process.Stdout, process.Stderr = os.Stdout, os.Stderr
	if err := process.Start(); err != nil {
		return err
	}
	_ = reader.Close()
	exited := make(chan error, 1)
	go func() { exited <- process.Wait(); _ = listener.Close() }()
	logger.Info("private guest lifecycle listening", "vsockPort", 1025)
	for {
		connection, err := listener.Accept()
		if err != nil {
			select {
			case err := <-exited:
				return fmt.Errorf("Nanoagent exited: %w", err)
			default:
				return err
			}
		}
		// Serialize freeze/thaw. This root helper stays alive while both filesystems are frozen.
		lifecycle.handle(connection)
		_ = connection.Close()
	}
}

func mountGuestHome(initialize bool) error {
	if err := verifyHomeSize("/dev/vdb"); err != nil {
		return err
	}
	command := exec.Command("/usr/sbin/blkid", "-p", "-o", "value", "-s", "TYPE", "/dev/vdb")
	typeBytes, err := command.Output()
	if err != nil {
		var exit *exec.ExitError
		if !initialize || !errors.As(err, &exit) || exit.ExitCode() != 2 {
			return fmt.Errorf("inspect retained home filesystem: %w", err)
		}
		// A missing signature is insufficient proof: refuse to format any nonzero disk.
		if err := verifyBlankHome("/dev/vdb"); err != nil {
			return err
		}
		if output, err := exec.Command("/usr/sbin/mkfs.ext4", "-q", "/dev/vdb").CombinedOutput(); err != nil {
			return fmt.Errorf("format new blank home: %w: %s", err, output)
		}
	} else if string(bytes.TrimSpace(typeBytes)) != "ext4" {
		return errors.New("retained home must be ext4; refusing to modify it")
	}
	if err := resizeGuestHome("/dev/vdb"); err != nil {
		return err
	}
	if err := unix.Mount("/dev/vdb", "/home/nanoagent", "ext4", unix.MS_NODEV|unix.MS_NOSUID, ""); err != nil {
		return fmt.Errorf("mount private home: %w", err)
	}
	if err := os.Chown("/home/nanoagent", 1000, 1000); err != nil {
		return err
	}
	if _, err := os.Stat("/home/nanoagent/workspace"); errors.Is(err, os.ErrNotExist) {
		if err := os.Mkdir("/home/nanoagent/workspace", 0755); err != nil {
			return err
		}
		return os.Chown("/home/nanoagent/workspace", 1000, 1000)
	} else {
		return err
	}
}

func resizeGuestHome(device string) error {
	output, err := exec.Command("/usr/sbin/e2fsck", "-p", "-f", device).CombinedOutput()
	var exit *exec.ExitError
	if err != nil && (!errors.As(err, &exit) || exit.ExitCode() != 1) {
		return fmt.Errorf("grow private home filesystem: check ext4: %w: %s", err, output)
	}
	if output, err := exec.Command("/usr/sbin/resize2fs", device).CombinedOutput(); err != nil {
		return fmt.Errorf("grow private home filesystem: %w: %s", err, output)
	}
	return nil
}

func verifyHomeSize(path string) error {
	disk, err := os.Open(path)
	if err != nil {
		return err
	}
	defer disk.Close()
	size, err := disk.Seek(0, io.SeekEnd)
	if err != nil {
		return fmt.Errorf("inspect private home capacity: %w", err)
	}
	if size != 32<<30 {
		return fmt.Errorf("unexpected private home size: %d", size)
	}
	return nil
}

func verifyBlankHome(path string) error {
	disk, err := os.Open(path)
	if err != nil {
		return err
	}
	defer disk.Close()
	buffer, zero := make([]byte, 256<<10), make([]byte, 256<<10)
	var total uint64
	for {
		n, err := disk.Read(buffer)
		if !bytes.Equal(buffer[:n], zero[:n]) {
			return errors.New("home contains data without a recognized filesystem; refusing to format")
		}
		total += uint64(n)
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return err
		}
	}
	if total != 32<<30 {
		return fmt.Errorf("unexpected private home size: %d", total)
	}
	return nil
}

func (guest *guestLifecycle) handle(connection net.Conn) {
	_ = connection.SetDeadline(time.Now().Add(30 * time.Second))
	reader := bufio.NewReader(io.LimitReader(connection, 4097))
	line, err := reader.ReadBytes('\n')
	var request guestLifecycleRequest
	if err == nil && len(line) <= 4096 {
		decoder := json.NewDecoder(bytes.NewReader(line))
		decoder.DisallowUnknownFields()
		err = decoder.Decode(&request)
	} else if err == nil {
		err = errors.New("guest control request too large")
	}
	if err == nil {
		err = guest.apply(request)
	}
	response := map[string]any{"ok": err == nil}
	if err != nil {
		response["error"] = err.Error()
	} else {
		response["claim"] = guest.claim
	}
	_ = json.NewEncoder(connection).Encode(response)
}

func (guest *guestLifecycle) apply(request guestLifecycleRequest) error {
	switch request.Action {
	case "ready":
		return guest.usable()
	case "freeze":
		if guest.frozen {
			return errors.New("guest is already frozen")
		}
		unix.Sync()
		if err := unix.IoctlSetInt(int(guest.home.Fd()), fsFreeze, 0); err != nil {
			return err
		}
		if err := unix.IoctlSetInt(int(guest.root.Fd()), fsFreeze, 0); err != nil {
			_ = unix.IoctlSetInt(int(guest.home.Fd()), fsThaw, 0)
			return err
		}
		guest.frozen = true
		return nil
	case "resume":
		if request.Claim.MicroVMID == "" || request.Claim.MicroVMUID == "" || request.Claim.Epoch == 0 {
			return errors.New("resume requires a slot owner and epoch")
		}
		if guest.claim != nil && *guest.claim != request.Claim {
			return errors.New("guest is already bound to another owner or epoch")
		}
		if request.UnixTimeNanos <= 0 {
			return errors.New("resume requires the host clock")
		}
		if guest.frozen {
			if err := unix.IoctlSetInt(int(guest.root.Fd()), fsThaw, 0); err != nil {
				return err
			}
			if err := unix.IoctlSetInt(int(guest.home.Fd()), fsThaw, 0); err != nil {
				return err
			}
			guest.frozen = false
		}
		clock := unix.NsecToTimespec(request.UnixTimeNanos)
		if err := unix.ClockSettime(unix.CLOCK_REALTIME, &clock); err != nil {
			return err
		}
		guest.claim = &request.Claim
		return guest.usable()
	default:
		return errors.New("unknown guest lifecycle action")
	}
}

func (guest *guestLifecycle) usable() error {
	client := &http.Client{Timeout: time.Second}
	response, err := client.Get("http://127.0.0.1:8080/readyz")
	if err != nil {
		return err
	}
	_ = response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return errors.New("Nanoagent or Codex is not initialized")
	}
	directory, err := os.Open("/home/nanoagent/workspace")
	if err != nil {
		return err
	}
	_, err = directory.Readdirnames(1)
	_ = directory.Close()
	if err != nil && !errors.Is(err, io.EOF) {
		return fmt.Errorf("read workspace: %w", err)
	}
	return guest.terminal.check()
}
