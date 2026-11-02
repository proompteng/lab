package main

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/proompteng/lab/services/nanoagent/internal/guestauth"
)

const maxGuestPreviewBody = 32 << 20

func (authorization *guestRPCAdmission) admitHTTP(writer http.ResponseWriter, request *http.Request) (guestauth.RuntimeClaim, error) {
	proof, err := guestauth.ProofFromValues(request.Header.Values(guestauth.ContextHeader), request.Header.Values(guestauth.SignatureHeader))
	if err != nil {
		return guestauth.RuntimeClaim{}, err
	}
	opening, err := authorization.admission.VerifyProof(proof, uint64(time.Now().UnixMilli()))
	if err != nil {
		return guestauth.RuntimeClaim{}, err
	}
	method := "HTTP " + request.Method
	action, err := guestauth.RequestAction(method)
	if err != nil || action != guestauth.PreviewAccess || opening.Method != method || !strings.HasPrefix(request.URL.Path, "/v1/preview/") {
		return guestauth.RuntimeClaim{}, errors.New("signed preview request required")
	}
	claim, err := authorization.claim()
	if err != nil {
		return claim, err
	}
	for header, expected := range map[string]string{guestClaimUIDHeader: claim.WorkspaceUID, guestClaimEpochHeader: strconv.FormatUint(claim.SlotEpoch, 10), guestRuntimeEpochHeader: claim.RuntimeEpoch} {
		values := request.Header.Values(header)
		if len(values) != 1 || values[0] != expected {
			return claim, errors.New("preview runtime binding differs")
		}
	}
	var body []byte
	if request.Body != nil && request.Body != http.NoBody {
		controller := http.NewResponseController(writer)
		if err := controller.SetReadDeadline(time.UnixMilli(int64(opening.DeadlineUnixMS))); err != nil {
			return claim, err
		}
		limited := http.MaxBytesReader(writer, request.Body, maxGuestPreviewBody)
		body, err = io.ReadAll(limited)
		closeErr := limited.Close()
		resetErr := controller.SetReadDeadline(time.Time{})
		if err != nil {
			return claim, err
		}
		if closeErr != nil {
			return claim, closeErr
		}
		if resetErr != nil {
			return claim, resetErr
		}
		request.Body = io.NopCloser(bytes.NewReader(body))
	}
	_, err = authorization.admission.AdmitGuest(proof, claim, guestauth.RequestBinding{
		RecoveryGeneration: authorization.recoveryGeneration, Action: action, Method: method, Target: request.URL.RequestURI(), Body: body,
	}, uint64(time.Now().UnixMilli()))
	return claim, err
}

func (authorization *guestRPCAdmission) guardHTTPRuntime(parent context.Context, claim guestauth.RuntimeClaim) (context.Context, context.CancelFunc) {
	ctx, cancel := context.WithCancel(parent)
	go func() {
		ticker := time.NewTicker(time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if authorization.requireClaim(claim) != nil {
					cancel()
					return
				}
			}
		}
	}()
	return ctx, cancel
}

type guestResponseWriter struct {
	http.ResponseWriter
	check  func() error
	failed bool
}

func (writer *guestResponseWriter) Unwrap() http.ResponseWriter { return writer.ResponseWriter }
func (writer *guestResponseWriter) allowed() bool {
	if writer.failed {
		return false
	}
	if writer.check() == nil {
		return true
	}
	writer.failed = true
	for name := range writer.Header() {
		writer.Header().Del(name)
	}
	writer.ResponseWriter.WriteHeader(http.StatusForbidden)
	return false
}
func (writer *guestResponseWriter) WriteHeader(status int) {
	if writer.allowed() {
		writer.ResponseWriter.WriteHeader(status)
	}
}
func (writer *guestResponseWriter) Write(body []byte) (int, error) {
	if !writer.allowed() {
		return 0, errors.New("preview runtime changed before disclosure")
	}
	return writer.ResponseWriter.Write(body)
}
func (writer *guestResponseWriter) FlushError() error {
	if !writer.allowed() {
		return errors.New("preview runtime changed before flush")
	}
	return http.NewResponseController(writer.ResponseWriter).Flush()
}
func (writer *guestResponseWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	if !writer.allowed() {
		return nil, nil, errors.New("preview runtime changed before upgrade")
	}
	return http.NewResponseController(writer.ResponseWriter).Hijack()
}
