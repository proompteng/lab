//go:build linux

package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"syscall"
	"time"

	"github.com/mdlayher/vsock"
	"github.com/proompteng/lab/services/nanoagent/internal/guestauth"
	"go.opentelemetry.io/otel"
	otelcodes "go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/trace"
	"golang.org/x/sys/unix"
)

type guestSlotConfig struct {
	PodUID             string `json:"podUid"`
	Token              string `json:"token"`
	InitializeHome     bool   `json:"initializeHome"`
	VerificationKey    []byte `json:"verificationKey"`
	RecoveryGeneration uint64 `json:"recoveryGeneration"`
	ErrorDSN           string `json:"errorDsn"`
	TraceEndpoint      string `json:"traceEndpoint"`
	SourceRevision     string `json:"sourceRevision"`
}

type guestClaim struct {
	MicroVMID    string `json:"microvmId"`
	MicroVMUID   string `json:"microvmUid"`
	Epoch        uint64 `json:"epoch"`
	RuntimeEpoch string `json:"runtimeEpoch"`
}

var runtimeEpochPattern = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

func (guest *guestLifecycle) validateResume(claim guestClaim) error {
	for _, id := range []string{claim.MicroVMID, claim.MicroVMUID} {
		if len(id) == 0 || len(id) > 63 {
			return errors.New("invalid slot owner")
		}
		for _, c := range id {
			if !((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-') {
				return errors.New("invalid slot owner")
			}
		}
	}
	if claim.Epoch == 0 || !runtimeEpochPattern.MatchString(claim.RuntimeEpoch) {
		return errors.New("resume requires a slot and runtime epoch")
	}
	if previous := guest.claim; previous != nil && *previous != claim {
		if !guest.frozen || previous.MicroVMID != claim.MicroVMID || previous.MicroVMUID != claim.MicroVMUID || previous.Epoch != claim.Epoch {
			return errors.New("guest is already bound to another owner or active runtime")
		}
	}
	return nil
}

type guestLifecycleRequest struct {
	Action        string     `json:"action"`
	Claim         guestClaim `json:"claim"`
	UnixTimeNanos int64      `json:"unixTimeNanos"`
	Traceparent   string     `json:"traceparent,omitempty"`
}

type guestLifecycle struct {
	root, home *os.File
	claim      *guestClaim
	frozen     bool
	terminal   *guestReadinessTerminal
	podUID     string
	claimPath  string
}

const fsFreeze = 0xC0045877
const fsThaw = 0xC0045878

func runGuestInit(logger *slog.Logger) (runErr error) {
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
	for key, value := range map[string]string{
		"SENTRY_DSN": config.ErrorDSN, "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT": config.TraceEndpoint,
		"APP_SOURCE_REVISION": config.SourceRevision,
	} {
		if err := os.Setenv(key, value); err != nil {
			return fmt.Errorf("configure lifecycle telemetry %s: %w", key, err)
		}
	}
	closeTelemetry, err := initializeTelemetry("lifecycle")
	if err != nil {
		return fmt.Errorf("configure lifecycle telemetry: %w", err)
	}
	defer closeTelemetry()
	defer func() {
		if runErr != nil {
			reportGuestError(context.Background(), "guest.init", "failed")
		}
	}()
	if err := prepareGuestAuthority(filepath.Dir(guestVerificationKeyPath), config.VerificationKey, config.RecoveryGeneration); err != nil {
		return err
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
	lifecycle := &guestLifecycle{root: root, home: home, terminal: terminal, podUID: config.PodUID, claimPath: guestRuntimeClaimPath}
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
		"MICROVM_ID="+config.PodUID, "MICROVM_BOOTSTRAP_TOKEN_FD=3",
		"SENTRY_DSN="+config.ErrorDSN, "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT="+config.TraceEndpoint,
		"APP_SOURCE_REVISION="+config.SourceRevision)
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
	started := time.Now()
	_ = connection.SetDeadline(time.Now().Add(30 * time.Second))
	reader := bufio.NewReader(io.LimitReader(connection, 4097))
	line, err := reader.ReadBytes('\n')
	var request guestLifecycleRequest
	var clockApplied time.Time
	if err == nil && len(line) <= 4096 {
		decoder := json.NewDecoder(bytes.NewReader(line))
		decoder.DisallowUnknownFields()
		err = decoder.Decode(&request)
	} else if err == nil {
		err = errors.New("guest control request too large")
	}
	if err == nil {
		parent := propagation.TraceContext{}.Extract(context.Background(), propagation.MapCarrier{"traceparent": request.Traceparent})
		clockApplied, err = guest.apply(parent, request, started)
	}
	response := map[string]any{"ok": err == nil}
	if err != nil {
		response["error"] = err.Error()
	} else {
		response["claim"] = guest.claim
		if !clockApplied.IsZero() {
			response["clockElapsedNanos"] = time.Since(clockApplied).Nanoseconds()
		}
	}
	_ = json.NewEncoder(connection).Encode(response)
}

func (guest *guestLifecycle) apply(parent context.Context, request guestLifecycleRequest, started time.Time) (clockApplied time.Time, resultErr error) {
	var clockStarted time.Time
	var clockErr error
	if request.Action == "resume" {
		if err := guest.validateResume(request.Claim); err != nil {
			return time.Time{}, err
		}
		if request.UnixTimeNanos <= 0 {
			return time.Time{}, errors.New("resume requires the host clock")
		}
		clockStarted = time.Now()
		clock := unix.NsecToTimespec(request.UnixTimeNanos)
		clockErr = unix.ClockSettime(unix.CLOCK_REALTIME, &clock)
		clockApplied = time.Now()
	}
	operation := "guest.lifecycle.unknown"
	switch request.Action {
	case "ready", "freeze", "resume":
		operation = "guest.lifecycle." + request.Action
	}
	// Clock synchronization precedes span creation; retain the measured monotonic duration.
	now := time.Now()
	ctx, span := otel.Tracer("nanoagent.lifecycle").Start(parent, operation, trace.WithSpanKind(trace.SpanKindServer), trace.WithTimestamp(now.Add(-now.Sub(started))))
	defer func() {
		if resultErr != nil {
			span.SetStatus(otelcodes.Error, "failed")
			var phase *guestLifecyclePhaseError
			if request.Action != "ready" && errors.As(resultErr, &phase) {
				reportGuestError(ctx, phase.operation, "failed")
			}
		}
		span.End()
	}()
	if !clockApplied.IsZero() {
		if err := recordLifecycleClock(ctx, clockStarted, clockApplied, clockErr); err != nil {
			return time.Time{}, err
		}
	}
	switch request.Action {
	case "ready":
		return time.Time{}, guest.usable(ctx, "guest.ready")
	case "freeze":
		if guest.frozen {
			return time.Time{}, errors.New("guest is already frozen")
		}
		if err := observeLifecyclePhase(ctx, "guest.freeze.claim.clear", func(context.Context) error { return clearGuestClaim(guest.claimPath) }); err != nil {
			return time.Time{}, err
		}
		_ = observeLifecyclePhase(ctx, "guest.freeze.sync", func(context.Context) error { unix.Sync(); return nil })
		if err := observeLifecyclePhase(ctx, "guest.freeze.home", func(context.Context) error { return unix.IoctlSetInt(int(guest.home.Fd()), fsFreeze, 0) }); err != nil {
			return time.Time{}, err
		}
		if err := observeLifecyclePhase(ctx, "guest.freeze.root", func(context.Context) error { return unix.IoctlSetInt(int(guest.root.Fd()), fsFreeze, 0) }); err != nil {
			_ = unix.IoctlSetInt(int(guest.home.Fd()), fsThaw, 0)
			return time.Time{}, err
		}
		guest.frozen = true
		return time.Time{}, nil
	case "resume":
		if err := observeLifecyclePhase(ctx, "guest.resume.claim.clear", func(context.Context) error { return clearGuestClaim(guest.claimPath) }); err != nil {
			return time.Time{}, err
		}
		if guest.frozen {
			if err := observeLifecyclePhase(ctx, "guest.resume.thaw.root", func(context.Context) error { return unix.IoctlSetInt(int(guest.root.Fd()), fsThaw, 0) }); err != nil {
				return time.Time{}, err
			}
			if err := observeLifecyclePhase(ctx, "guest.resume.thaw.home", func(context.Context) error { return unix.IoctlSetInt(int(guest.home.Fd()), fsThaw, 0) }); err != nil {
				return time.Time{}, err
			}
			guest.frozen = false
		}
		if err := observeLifecyclePhase(ctx, "guest.resume.claim.publish", func(context.Context) error {
			return publishGuestClaim(guest.claimPath, guestauth.RuntimeClaim{WorkspaceUID: request.Claim.MicroVMUID, RuntimeEpoch: request.Claim.RuntimeEpoch, SlotEpoch: request.Claim.Epoch, PodUID: guest.podUID})
		}); err != nil {
			return time.Time{}, err
		}
		guest.claim = &request.Claim
		return clockApplied, guest.usable(ctx, "guest.resume")
	default:
		return time.Time{}, errors.New("unknown guest lifecycle action")
	}
}

func (guest *guestLifecycle) usable(ctx context.Context, operation string) error {
	if err := observeLifecyclePhase(ctx, operation+".api", func(ctx context.Context) error {
		request, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://127.0.0.1:8080/readyz", nil)
		if err != nil {
			return err
		}
		otel.GetTextMapPropagator().Inject(ctx, propagation.HeaderCarrier(request.Header))
		response, err := (&http.Client{Timeout: time.Second}).Do(request)
		if err != nil {
			return err
		}
		_ = response.Body.Close()
		if response.StatusCode != http.StatusOK {
			return errors.New("Nanoagent or Codex is not initialized")
		}
		return nil
	}); err != nil {
		return err
	}
	if err := observeLifecyclePhase(ctx, operation+".workspace", func(context.Context) error {
		directory, err := os.Open("/home/nanoagent/workspace")
		if err != nil {
			return err
		}
		_, err = directory.Readdirnames(1)
		_ = directory.Close()
		if err != nil && !errors.Is(err, io.EOF) {
			return fmt.Errorf("read workspace: %w", err)
		}
		return nil
	}); err != nil {
		return err
	}
	return observeLifecyclePhase(ctx, operation+".terminal", func(context.Context) error { return guest.terminal.check() })
}
