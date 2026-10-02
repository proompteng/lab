package main

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/spiffe/go-spiffe/v2/spiffeid"
	"github.com/spiffe/go-spiffe/v2/spiffetls/tlsconfig"
	"github.com/spiffe/go-spiffe/v2/svid/x509svid"
	"github.com/spiffe/go-spiffe/v2/workloadapi"
)

const spireRuntimeDirectory = "/tmp/nanoagent-spire"

type guestIdentity struct {
	source    *workloadapi.X509Source
	process   *exec.Cmd
	exited    chan error
	mu        sync.Mutex
	podUID    string
	directory string
}

func startGuestIdentity(ctx context.Context, podUID string, logger *slog.Logger) (_ *guestIdentity, err error) {
	domain, err := spiffeid.TrustDomainFromString(os.Getenv("SPIFFE_TRUST_DOMAIN"))
	if err != nil {
		return nil, errors.New("SPIFFE_TRUST_DOMAIN is required and must be valid")
	}
	if podUID == "" || strings.ContainsAny(podUID, "/\\\x00\r\n") {
		return nil, errors.New("SPIRE guest requires its Pod UID")
	}
	if err := bootstrapPersistentInstall(ctx, os.Getenv("SPIRE_BOOTSTRAP_COMMAND"), 4*time.Minute, "SPIRE_BOOTSTRAP_COMMAND", "SPIRE agent"); err != nil {
		return nil, err
	}
	if err := os.MkdirAll(spireRuntimeDirectory, 0700); err != nil {
		return nil, err
	}
	if err := os.Chmod(spireRuntimeDirectory, 0700); err != nil {
		return nil, err
	}
	identity := &guestIdentity{podUID: podUID, directory: spireRuntimeDirectory, exited: make(chan error, 1)}
	token, err := os.ReadFile("/var/run/secrets/spire/token")
	if err != nil {
		return nil, fmt.Errorf("read SPIRE attestation token: %w", err)
	}
	defer clear(token)
	cached, cacheErr := os.ReadFile(filepath.Join(identity.directory, "token"))
	if cacheErr != nil && !errors.Is(cacheErr, os.ErrNotExist) {
		return nil, fmt.Errorf("read cached SPIRE attestation token: %w", cacheErr)
	}
	defer clear(cached)
	selected, err := freshestAttestationToken(podUID, token, cached, time.Now())
	if err != nil {
		return nil, err
	}
	bundle, err := os.ReadFile("/var/run/secrets/spire-bundle/bundle.pem")
	if err != nil {
		return nil, fmt.Errorf("read SPIRE trust bundle: %w", err)
	}
	cachedBundle, bundleErr := os.ReadFile(filepath.Join(identity.directory, "bundle.pem"))
	if bundleErr != nil && !errors.Is(bundleErr, os.ErrNotExist) {
		return nil, fmt.Errorf("read cached SPIRE trust bundle: %w", bundleErr)
	}
	if len(cachedBundle) > 0 {
		bundle = cachedBundle
	}
	if err := identity.refreshBootstrap(podUID, selected, bundle); err != nil {
		return nil, err
	}
	socket := filepath.Join(spireRuntimeDirectory, "agent.sock")
	config, err := guestAgentConfig(domain.String(), socket)
	if err != nil {
		return nil, err
	}
	configPath := filepath.Join(spireRuntimeDirectory, "agent.conf")
	if err := atomicIdentityFile(configPath, config, 0600); err != nil {
		return nil, err
	}
	binary := strings.TrimSpace(os.Getenv("SPIRE_AGENT_BINARY"))
	if !filepath.IsAbs(binary) {
		return nil, errors.New("SPIRE_AGENT_BINARY must be an absolute path")
	}
	identity.process = exec.Command(binary, "run", "-config", configPath)
	identity.process.Env = childEnvironment()
	identity.process.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	identity.process.Stdout = os.Stdout
	identity.process.Stderr = os.Stderr
	if err := identity.process.Start(); err != nil {
		return nil, fmt.Errorf("start SPIRE agent: %w", err)
	}
	go func() { identity.exited <- identity.process.Wait() }()
	defer func() {
		if err != nil {
			identity.close()
		}
	}()
	ownID, err := spiffeid.FromPath(domain, "/ns/tengri/nanoagent/pod/"+podUID)
	if err != nil {
		return nil, err
	}
	initial, cancel := context.WithTimeout(ctx, time.Minute)
	defer cancel()
	identity.source, err = workloadapi.NewX509Source(initial,
		workloadapi.WithClientOptions(workloadapi.WithAddr("unix://"+socket)),
		workloadapi.WithDefaultX509SVIDPicker(func(svids []*x509svid.SVID) *x509svid.SVID {
			for _, svid := range svids {
				if svid.ID == ownID {
					return svid
				}
			}
			return nil
		}),
	)
	if err != nil {
		return nil, fmt.Errorf("obtain guest SPIFFE identity: %w", err)
	}
	logger.Info("guest SPIFFE identity ready", "spiffeId", ownID.String())
	return identity, nil
}

func guestAgentConfig(domain, socket string) ([]byte, error) {
	return json.Marshal(map[string]any{
		"agent": map[string]any{
			"data_dir": filepath.Join(spireRuntimeDirectory, "data"), "log_level": "INFO",
			"server_address": "spire-server.spire-server.svc.cluster.local", "server_port": 8081,
			"socket_path": socket, "trust_domain": domain,
			"trust_bundle_path": filepath.Join(spireRuntimeDirectory, "bundle.pem"),
		},
		"plugins": map[string]any{
			"NodeAttestor": map[string]any{"k8s_psat": map[string]any{"plugin_data": map[string]any{
				"cluster": "galactic-guests", "token_path": filepath.Join(spireRuntimeDirectory, "token"),
			}}},
			"WorkloadAttestor": map[string]any{"unix": map[string]any{"plugin_data": map[string]any{"discover_workload_path": false}}},
			"KeyManager":       map[string]any{"disk": map[string]any{"plugin_data": map[string]any{"directory": filepath.Join(spireRuntimeDirectory, "keys")}}},
		},
	})
}

func (identity *guestIdentity) tlsConfig() (*tls.Config, error) {
	svid, err := identity.source.GetX509SVID()
	if err != nil {
		return nil, err
	}
	peer, err := spiffeid.FromPath(svid.ID.TrustDomain(), "/ns/tengri/sa/tengri")
	if err != nil {
		return nil, err
	}
	config := tlsconfig.MTLSServerConfig(identity.source, identity.source, tlsconfig.AuthorizeID(peer))
	config.MinVersion = tls.VersionTLS12
	config.NextProtos = []string{"h2", "http/1.1"}
	return config, nil
}

func (identity *guestIdentity) ready() bool {
	svid, err := identity.source.GetX509SVID()
	now := time.Now()
	return err == nil && len(svid.Certificates) > 0 && !now.Before(svid.Certificates[0].NotBefore) && now.Before(svid.Certificates[0].NotAfter)
}

func (identity *guestIdentity) close() {
	if identity.source != nil {
		_ = identity.source.Close()
	}
	if identity.process != nil {
		killProcessGroup(identity.process)
	}
}

func (identity *guestIdentity) refreshBootstrap(podUID string, token, bundle []byte) error {
	if podUID != identity.podUID {
		return errors.New("SPIRE bootstrap belongs to another Pod")
	}
	if _, err := attestationExpiry(podUID, token, time.Now()); err != nil {
		return err
	}
	if len(bundle) == 0 || len(bundle) > 1<<20 {
		return errors.New("invalid SPIRE trust bundle")
	}
	rest := bundle
	count := 0
	for len(strings.TrimSpace(string(rest))) > 0 {
		block, remaining := pem.Decode(rest)
		if block == nil || block.Type != "CERTIFICATE" {
			return errors.New("SPIRE bundle must contain only certificates")
		}
		certificate, err := x509.ParseCertificate(block.Bytes)
		if err != nil || !certificate.IsCA {
			return errors.New("SPIRE bundle requires CA certificates")
		}
		count++
		rest = remaining
	}
	if count == 0 {
		return errors.New("SPIRE bundle is empty")
	}
	identity.mu.Lock()
	defer identity.mu.Unlock()
	if err := atomicIdentityFile(filepath.Join(identity.directory, "bundle.pem"), bundle, 0600); err != nil {
		return err
	}
	return atomicIdentityFile(filepath.Join(identity.directory, "token"), token, 0600)
}

func attestationExpiry(podUID string, token []byte, now time.Time) (int64, error) {
	if len(token) == 0 || len(token) > 16<<10 {
		return 0, errors.New("invalid SPIRE attestation token")
	}
	parts := strings.Split(string(token), ".")
	if len(parts) != 3 || parts[0] == "" || parts[2] == "" {
		return 0, errors.New("invalid SPIRE attestation token")
	}
	encoded, err := base64.RawURLEncoding.DecodeString(parts[1])
	var claims struct {
		Expires    int64    `json:"exp"`
		Audience   []string `json:"aud"`
		Kubernetes struct {
			Namespace string `json:"namespace"`
			Pod       struct {
				UID string `json:"uid"`
			} `json:"pod"`
			Account struct {
				Name string `json:"name"`
			} `json:"serviceaccount"`
		} `json:"kubernetes.io"`
	}
	if err != nil || json.Unmarshal(encoded, &claims) != nil || claims.Expires <= now.Unix() ||
		len(claims.Audience) != 1 || claims.Audience[0] != "spire-server" || claims.Kubernetes.Namespace != "tengri" ||
		claims.Kubernetes.Pod.UID != podUID || claims.Kubernetes.Account.Name != "nanoagent" {
		return 0, errors.New("SPIRE requires an unexpired token bound to this guest Pod")
	}
	// SPIRE verifies the signature. Local claims only select a fresh bootstrap token.
	return claims.Expires, nil
}

func freshestAttestationToken(podUID string, projected, cached []byte, now time.Time) ([]byte, error) {
	projectedExpiry, projectedErr := attestationExpiry(podUID, projected, now)
	cachedExpiry, cachedErr := attestationExpiry(podUID, cached, now)
	if cachedErr == nil && (projectedErr != nil || cachedExpiry > projectedExpiry) {
		return cached, nil
	}
	if projectedErr == nil {
		return projected, nil
	}
	return nil, errors.New("SPIRE attestation token expired; sleep and resume the guest to project a fresh token")
}

func atomicIdentityFile(path string, contents []byte, mode os.FileMode) error {
	file, err := os.CreateTemp(filepath.Dir(path), ".identity-*")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	defer file.Close()
	if err := file.Chmod(mode); err != nil {
		return err
	}
	if _, err := file.Write(contents); err != nil {
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	return os.Rename(file.Name(), path)
}
