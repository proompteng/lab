package main

import (
	"bufio"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	pb "github.com/proompteng/lab/services/nanoagent/internal/guestpb"
	workloadpb "github.com/spiffe/go-spiffe/v2/proto/spiffe/workload"
	"github.com/spiffe/go-spiffe/v2/spiffeid"
	"github.com/spiffe/go-spiffe/v2/spiffetls/tlsconfig"
	"github.com/spiffe/go-spiffe/v2/svid/x509svid"
	"github.com/spiffe/go-spiffe/v2/workloadapi"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/metadata"
)

const fixtureDomain = "proompteng.ai"
const controllerID = "spiffe://" + fixtureDomain + "/ns/tengri/sa/tengri"
const bffID = "spiffe://" + fixtureDomain + "/ns/proompteng/sa/proompteng"
const guestID = "spiffe://" + fixtureDomain + "/ns/tengri/slot/pod/interop-agent"

func TestKVMWorkloadAPI(t *testing.T) {
	if os.Getenv("NANOAGENT_KVM_INTEROP") != "1" {
		t.Skip("explicit KVM fixture")
	}
	fixture := newWorkloadFixture(t)
	refresh := func() {
		expires := time.Now().Add(2 * time.Minute)
		fixture.publish(t, fixture.certificate(t, controllerID, expires),
			fixture.certificate(t, guestID, expires), fixture.certificate(t, bffID, expires))
	}
	refresh()
	done := make(chan struct{})
	defer close(done)
	go func() {
		ticker := time.NewTicker(30 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				refresh()
			case <-done:
				return
			}
		}
	}()
	fmt.Println("WORKLOAD_ENDPOINT=" + fixture.endpoint)
	scanner := bufio.NewScanner(os.Stdin)
	for scanner.Scan() {
		if scanner.Text() == "rotate" {
			refresh()
		}
	}
}

type workloadFixture struct {
	workloadpb.UnimplementedSpiffeWorkloadAPIServer
	mu       sync.Mutex
	response *workloadpb.X509SVIDResponse
	watchers map[chan *workloadpb.X509SVIDResponse]struct{}
	endpoint string
	ca       *x509.Certificate
	key      *ecdsa.PrivateKey
}

func (fixture *workloadFixture) certificate(t *testing.T, id string, expires time.Time) *x509svid.SVID {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	uri, err := url.Parse(id)
	if err != nil {
		t.Fatal(err)
	}
	serial, _ := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 120))
	certificate, err := x509.CreateCertificate(rand.Reader, &x509.Certificate{
		SerialNumber: serial, BasicConstraintsValid: true, NotBefore: time.Now().Add(-time.Hour), NotAfter: expires,
		URIs: []*url.URL{uri}, KeyUsage: x509.KeyUsageDigitalSignature,
		ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth, x509.ExtKeyUsageClientAuth},
	}, fixture.ca, &key.PublicKey, fixture.key)
	if err != nil {
		t.Fatal(err)
	}
	encodedKey, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	svid, err := x509svid.ParseRaw(certificate, encodedKey)
	if err != nil {
		t.Fatal(err)
	}
	return svid
}

func newWorkloadFixture(t *testing.T) *workloadFixture {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	der, err := x509.CreateCertificate(rand.Reader, &x509.Certificate{
		SerialNumber: big.NewInt(1), IsCA: true, BasicConstraintsValid: true,
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(3 * time.Hour),
		KeyUsage: x509.KeyUsageCertSign | x509.KeyUsageCRLSign,
	}, &x509.Certificate{SerialNumber: big.NewInt(1), IsCA: true}, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	ca, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatal(err)
	}
	// macOS imposes a short sockaddr_un path limit.
	directory, err := os.MkdirTemp("/tmp", "spire-fixture-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(directory) })
	fixture := &workloadFixture{ca: ca, key: key, watchers: make(map[chan *workloadpb.X509SVIDResponse]struct{}), endpoint: "unix://" + filepath.Join(directory, "api.sock")}
	fixture.rotate(t)
	listener, err := net.Listen("unix", filepath.Join(directory, "api.sock"))
	if err != nil {
		t.Fatal(err)
	}
	server := grpc.NewServer()
	workloadpb.RegisterSpiffeWorkloadAPIServer(server, fixture)
	t.Cleanup(server.Stop)
	go func() { _ = server.Serve(listener) }()
	return fixture
}

func (fixture *workloadFixture) rotate(t *testing.T) {
	fixture.publish(t,
		fixture.certificate(t, controllerID, time.Now().Add(30*time.Minute)),
		fixture.certificate(t, guestID, time.Now().Add(30*time.Minute)),
		fixture.certificate(t, bffID, time.Now().Add(30*time.Minute)))
}

func (fixture *workloadFixture) publish(t *testing.T, svids ...*x509svid.SVID) {
	t.Helper()
	response := &workloadpb.X509SVIDResponse{}
	for _, svid := range svids {
		certificate, key, err := svid.MarshalRaw()
		if err != nil {
			t.Fatal(err)
		}
		response.Svids = append(response.Svids, &workloadpb.X509SVID{SpiffeId: svid.ID.String(), X509Svid: certificate, X509SvidKey: key, Bundle: fixture.ca.Raw})
	}
	fixture.mu.Lock()
	defer fixture.mu.Unlock()
	fixture.response = response
	for watcher := range fixture.watchers {
		watcher <- response
	}
}

func (fixture *workloadFixture) FetchX509SVID(_ *workloadpb.X509SVIDRequest, stream grpc.ServerStreamingServer[workloadpb.X509SVIDResponse]) error {
	if values := metadata.ValueFromIncomingContext(stream.Context(), "workload.spiffe.io"); len(values) != 1 || values[0] != "true" {
		return context.Canceled
	}
	updates := make(chan *workloadpb.X509SVIDResponse, 4)
	fixture.mu.Lock()
	fixture.watchers[updates] = struct{}{}
	updates <- fixture.response
	fixture.mu.Unlock()
	defer func() { fixture.mu.Lock(); delete(fixture.watchers, updates); fixture.mu.Unlock() }()
	for {
		select {
		case response := <-updates:
			if err := stream.Send(response); err != nil {
				return err
			}
		case <-stream.Context().Done():
			return stream.Context().Err()
		}
	}
}

func (fixture *workloadFixture) source(t *testing.T, id string) *workloadapi.X509Source {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	source, err := workloadapi.NewX509Source(ctx, workloadapi.WithClientOptions(workloadapi.WithAddr(fixture.endpoint)),
		workloadapi.WithDefaultX509SVIDPicker(func(svids []*x509svid.SVID) *x509svid.SVID {
			for _, svid := range svids {
				if svid.ID.String() == id {
					return svid
				}
			}
			return nil
		}))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = source.Close() })
	return source
}

func secureRPCTestServer(t *testing.T, api *apiServer, fixture *workloadFixture) *httptest.Server {
	t.Helper()
	api.evidence.MicroVMID = "interop-agent"
	source := fixture.source(t, guestID)
	config := tlsconfig.MTLSServerConfig(source, source, tlsconfig.AuthorizeID(spiffeid.RequireFromString(controllerID)))
	config.NextProtos = []string{"h2", "http/1.1"}
	server := httptest.NewUnstartedServer(newHandler(api))
	server.EnableHTTP2 = true
	server.Config.Protocols = guestHTTPProtocols()
	server.Config.TLSConfig = config
	server.Listener = tls.NewListener(server.Listener, config)
	server.Start()
	server.URL = strings.Replace(server.URL, "http://", "https://", 1)
	t.Cleanup(server.Close)
	return server
}

func TestSupervisorMutualTLSRequiresTheExactControllerAndSlot(t *testing.T) {
	fixture := newWorkloadFixture(t)
	api := testAPIServer(t)
	server := secureRPCTestServer(t, api, fixture)
	source := fixture.source(t, controllerID)
	for _, peer := range []string{guestID, "spiffe://" + fixtureDomain + "/ns/tengri/slot/pod/previous-pod"} {
		config := tlsconfig.MTLSClientConfig(source, source, tlsconfig.AuthorizeID(spiffeid.RequireFromString(peer)))
		connection, err := grpc.NewClient(server.Listener.Addr().String(), grpc.WithTransportCredentials(credentials.NewTLS(config)))
		if err != nil {
			t.Fatal(err)
		}
		ctx, cancel := context.WithTimeout(rpcTestContext(t), 2*time.Second)
		_, err = pb.NewNanoagentServiceClient(connection).GetInfo(ctx, &pb.Empty{})
		cancel()
		_ = connection.Close()
		if (err == nil) != (peer == guestID) {
			t.Fatalf("peer %s: %v", peer, err)
		}
	}
	wrong := fixture.source(t, guestID)
	config := tlsconfig.MTLSClientConfig(wrong, wrong, tlsconfig.AuthorizeID(spiffeid.RequireFromString(guestID)))
	connection, err := grpc.NewClient(server.Listener.Addr().String(), grpc.WithTransportCredentials(credentials.NewTLS(config)))
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	ctx, cancel := context.WithTimeout(rpcTestContext(t), 2*time.Second)
	defer cancel()
	if _, err := pb.NewNanoagentServiceClient(connection).GetInfo(ctx, &pb.Empty{}); err == nil {
		t.Fatal("guest certificate was accepted as the controller")
	}
}

func TestPlainHealthListenerCannotDispatchGuestRPCs(t *testing.T) {
	server := httptest.NewServer(newHealthHandler(testAPIServer(t)))
	defer server.Close()
	for path, expected := range map[string]int{"/livez": 200, "/readyz": 200, "/v1/preview/3000/": 404, "/proompteng.runtime.guest.v1.NanoagentService/GetInfo": 404} {
		response, err := http.Get(server.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		_ = response.Body.Close()
		if response.StatusCode != expected {
			t.Fatalf("%s: %d", path, response.StatusCode)
		}
	}
}

func TestSupervisorRejectsExpiredUntrustedAndPlaintextClients(t *testing.T) {
	fixture := newWorkloadFixture(t)
	server := secureRPCTestServer(t, testAPIServer(t), fixture)
	source := fixture.source(t, controllerID)
	untrusted := newWorkloadFixture(t)
	for _, testCase := range []struct {
		name string
		svid *x509svid.SVID
	}{
		{"expired", fixture.certificate(t, controllerID, time.Now().Add(-time.Minute))},
		{"untrusted", untrusted.certificate(t, controllerID, time.Now().Add(time.Minute))},
		{"plaintext", nil},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			var transport credentials.TransportCredentials = insecure.NewCredentials()
			if testCase.svid != nil {
				config := tlsconfig.MTLSClientConfig(source, source, tlsconfig.AuthorizeID(spiffeid.RequireFromString(guestID)))
				config.GetClientCertificate = nil
				config.Certificates = []tls.Certificate{{Certificate: [][]byte{testCase.svid.Certificates[0].Raw}, PrivateKey: testCase.svid.PrivateKey}}
				transport = credentials.NewTLS(config)
			}
			connection, err := grpc.NewClient(server.Listener.Addr().String(), grpc.WithTransportCredentials(transport))
			if err != nil {
				t.Fatal(err)
			}
			defer connection.Close()
			ctx, cancel := context.WithTimeout(rpcTestContext(t), 2*time.Second)
			defer cancel()
			if _, err := pb.NewNanoagentServiceClient(connection).GetInfo(ctx, &pb.Empty{}); err == nil {
				t.Fatal("unauthenticated client reached GetInfo")
			}
		})
	}
}

func TestSupervisorIdentityRotatesWithoutRestartingTheTLSListener(t *testing.T) {
	fixture := newWorkloadFixture(t)
	api := testAPIServer(t)
	server := secureRPCTestServer(t, api, fixture)
	source := fixture.source(t, controllerID)
	client := &http.Client{Transport: &http.Transport{TLSClientConfig: tlsconfig.MTLSClientConfig(source, source, tlsconfig.AuthorizeID(spiffeid.RequireFromString(guestID))), DisableKeepAlives: true}}
	defer client.CloseIdleConnections()
	first, err := client.Get(server.URL + "/livez")
	if err != nil {
		t.Fatal(err)
	}
	serial := first.TLS.PeerCertificates[0].SerialNumber.String()
	_ = first.Body.Close()
	rotated := fixture.certificate(t, guestID, time.Now().Add(30*time.Minute))
	fixture.publish(t, fixture.certificate(t, controllerID, time.Now().Add(30*time.Minute)), rotated)
	deadline := time.Now().Add(3 * time.Second)
	for {
		response, err := client.Get(server.URL + "/livez")
		if err != nil {
			t.Fatal(err)
		}
		current := response.TLS.PeerCertificates[0].SerialNumber.String()
		_ = response.Body.Close()
		if current != serial {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("server did not use the renewed SVID")
		}
		time.Sleep(10 * time.Millisecond)
	}
}
