package main

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"github.com/coder/websocket"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/proompteng/lab/services/nanoagent/internal/guestauth"
)

func signFixturePreview(request *http.Request, body []byte, change func(*guestauth.Context)) error {
	var nonce [16]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		return err
	}
	nonce[6], nonce[8] = (nonce[6]&15)|64, (nonce[8]&63)|128
	id := hex.EncodeToString(nonce[:])
	now := uint64(time.Now().UnixMilli())
	claim := fixtureGuestClaim
	context := guestauth.Context{ProtocolVersion: guestauth.ProtocolVersion,
		Actor:  guestauth.Actor{Kind: "human", Subject: strings.Repeat("a", 64), SessionID: "44444444-4444-4444-8444-444444444444"},
		Action: guestauth.PreviewAccess, WorkspaceUID: claim.WorkspaceUID, RuntimeEpoch: claim.RuntimeEpoch, SlotEpoch: claim.SlotEpoch, PodUID: claim.PodUID,
		LeaderOwner: "55555555-5555-4555-8555-555555555555", LeaderGeneration: 2, RecoveryGeneration: 1,
		AuditReceiptID: "66666666-6666-4666-8666-666666666666", Method: "HTTP " + request.Method, Target: request.URL.RequestURI(), BodySHA256: guestauth.BodySHA256(body),
		IssuedAtUnixMS: now, DeadlineUnixMS: now + 2000, Nonce: id[:8] + "-" + id[8:12] + "-" + id[12:16] + "-" + id[16:20] + "-" + id[20:]}
	if change != nil {
		change(&context)
	}
	payload, err := json.Marshal(context)
	if err != nil {
		return err
	}
	signature := ed25519.Sign(fixtureGuestKey(), append([]byte("tengri-guest-request-v4\x00"), payload...))
	request.Header.Set(guestauth.ContextHeader, base64.RawURLEncoding.EncodeToString(payload))
	request.Header.Set(guestauth.SignatureHeader, base64.RawURLEncoding.EncodeToString(signature))
	request.Header.Set(guestClaimUIDHeader, claim.WorkspaceUID)
	request.Header.Set(guestClaimEpochHeader, strconv.FormatUint(claim.SlotEpoch, 10))
	request.Header.Set(guestRuntimeEpochHeader, claim.RuntimeEpoch)
	return nil
}

type fixtureDeadlineRecorder struct{ *httptest.ResponseRecorder }

func TestEveryHTTPPreviewVerbRequiresPrivilegedApplicationAccess(t *testing.T) {
	for _, method := range []string{"GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"} {
		action, err := guestauth.RequestAction("HTTP " + method)
		if err != nil || action != guestauth.PreviewAccess {
			t.Fatalf("preview action %s = %s: %v", method, action, err)
		}
	}
	for _, method := range []string{"CONNECT", "TRACE", "PRI", "get", "GET /other"} {
		if _, err := guestauth.RequestAction("HTTP " + method); err == nil {
			t.Fatalf("unknown preview method %q accepted", method)
		}
	}
}

func (fixtureDeadlineRecorder) SetReadDeadline(time.Time) error { return nil }

func TestPreviewRequiresSignedExactMethodTargetBodyAndRecoveryBeforeSideEffects(t *testing.T) {
	api := testAPIServer(t)
	forwarded := 0
	api.previewTransport = roundTripFunc(func(request *http.Request) (*http.Response, error) {
		forwarded++
		for _, header := range []string{guestauth.ContextHeader, guestauth.SignatureHeader, guestClaimUIDHeader, guestClaimEpochHeader, guestRuntimeEpochHeader} {
			if request.Header.Get(header) != "" {
				t.Errorf("internal guest header %s reached the application", header)
			}
		}
		return &http.Response{StatusCode: http.StatusOK, Header: http.Header{}, Body: io.NopCloser(strings.NewReader("allowed"))}, nil
	})
	for _, test := range []struct {
		name     string
		change   func(*guestauth.Context)
		unsigned bool
		tamper   bool
	}{
		{name: "unsigned", unsigned: true},
		{name: "runtime", change: func(c *guestauth.Context) { c.RuntimeEpoch = "77777777-7777-4777-8777-777777777777" }},
		{name: "recovery", change: func(c *guestauth.Context) { c.RecoveryGeneration++ }},
		{name: "target", change: func(c *guestauth.Context) { c.Target += "&other=1" }},
		{name: "method", change: func(c *guestauth.Context) { c.Method = "HTTP DELETE" }},
		{name: "body", tamper: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodPost, "/v1/preview/43210/submit?mode=full", strings.NewReader("actual body"))
			request.Header.Set("Authorization", "Bearer test-bootstrap-token")
			if !test.unsigned {
				if err := signFixturePreview(request, []byte("actual body"), test.change); err != nil {
					t.Fatal(err)
				}
			}
			if test.tamper {
				request.Body = io.NopCloser(strings.NewReader("changed body"))
			}
			response := httptest.NewRecorder()
			api.previewRoutes().ServeHTTP(fixtureDeadlineRecorder{response}, request)
			if response.Code != http.StatusUnauthorized || forwarded != 0 {
				t.Fatalf("invalid preview admitted: %d, forwarded=%d", response.Code, forwarded)
			}
		})
	}
	request := httptest.NewRequest(http.MethodPost, "/v1/preview/43210/submit?mode=full", bytes.NewReader([]byte("actual body")))
	request.Header.Set("Authorization", "Bearer test-bootstrap-token")
	if err := signFixturePreview(request, []byte("actual body"), nil); err != nil {
		t.Fatal(err)
	}
	response := httptest.NewRecorder()
	api.previewRoutes().ServeHTTP(fixtureDeadlineRecorder{response}, request)
	if response.Code != http.StatusOK || forwarded != 1 {
		t.Fatalf("valid preview denied: %d, forwarded=%d", response.Code, forwarded)
	}
	request.Body = io.NopCloser(strings.NewReader("actual body"))
	response = httptest.NewRecorder()
	api.previewRoutes().ServeHTTP(fixtureDeadlineRecorder{response}, request)
	if response.Code != http.StatusUnauthorized || forwarded != 1 {
		t.Fatalf("replayed preview admitted: %d, forwarded=%d", response.Code, forwarded)
	}
}

func TestPreviewRechecksGuestClaimBeforeDisclosingResponse(t *testing.T) {
	api := testAPIServer(t)
	var changed atomic.Bool
	api.guestAuthorization.claim = func() (guestauth.RuntimeClaim, error) {
		if changed.Load() {
			return guestauth.RuntimeClaim{}, errors.New("runtime changed")
		}
		return fixtureGuestClaim, nil
	}
	api.previewTransport = roundTripFunc(func(*http.Request) (*http.Response, error) {
		changed.Store(true)
		return &http.Response{StatusCode: http.StatusOK, Header: http.Header{}, Body: io.NopCloser(strings.NewReader("private response"))}, nil
	})
	response := performAuthorizedRequest(api.previewRoutes(), http.MethodGet, "/v1/preview/43210/", nil)
	if response.Code != http.StatusForbidden || strings.Contains(response.Body.String(), "private response") {
		t.Fatalf("changed runtime disclosed preview: %d %q", response.Code, response.Body.String())
	}
}

func TestPreviewWebSocketClosesWhenRuntimeChanges(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		connection, err := websocket.Accept(writer, request, &websocket.AcceptOptions{InsecureSkipVerify: true})
		if err != nil {
			return
		}
		defer connection.CloseNow()
		for {
			kind, data, err := connection.Read(request.Context())
			if err != nil {
				return
			}
			if connection.Write(request.Context(), kind, data) != nil {
				return
			}
		}
	}))
	defer upstream.Close()
	upstreamURL, err := url.Parse(upstream.URL)
	if err != nil {
		t.Fatal(err)
	}
	api := testAPIServer(t)
	var changed atomic.Bool
	api.guestAuthorization.claim = func() (guestauth.RuntimeClaim, error) {
		if changed.Load() {
			return guestauth.RuntimeClaim{}, errors.New("runtime changed")
		}
		return fixtureGuestClaim, nil
	}
	server := httptest.NewServer(api.previewRoutes())
	defer server.Close()
	path := "/v1/preview/" + upstreamURL.Port() + "/ws"
	request := httptest.NewRequest(http.MethodGet, path, nil)
	request.Header.Set("Authorization", "Bearer test-bootstrap-token")
	if err := signFixturePreview(request, nil, nil); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	connection, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(server.URL, "http")+path, &websocket.DialOptions{HTTPHeader: request.Header})
	if err != nil {
		t.Fatal(err)
	}
	defer connection.CloseNow()
	if err := connection.Write(ctx, websocket.MessageText, []byte("before change")); err != nil {
		t.Fatal(err)
	}
	if _, data, err := connection.Read(ctx); err != nil || string(data) != "before change" {
		t.Fatalf("initial preview round trip %q: %v", data, err)
	}
	changed.Store(true)
	readContext, stop := context.WithTimeout(context.Background(), 2500*time.Millisecond)
	defer stop()
	if _, _, err := connection.Read(readContext); err == nil || readContext.Err() != nil {
		t.Fatalf("runtime change did not close the preview before its deadline: %v", err)
	}
}
