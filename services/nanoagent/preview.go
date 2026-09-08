package main

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strconv"
	"strings"
	"sync"
)

var dangerousForwardHeaders = []string{
	"Authorization",
	"Forwarded",
	nanoagentAuthFailureHeader,
	"Proxy-Authorization",
	"X-Forwarded-For",
	"X-Forwarded-Host",
	"X-Forwarded-Proto",
}

type previewRequestTracker struct {
	mu     sync.Mutex
	closed bool
	nextID uint64
	active map[uint64]context.CancelFunc
}

func newPreviewRequestTracker() *previewRequestTracker {
	return &previewRequestTracker{active: make(map[uint64]context.CancelFunc)}
}

func (tracker *previewRequestTracker) track(parent context.Context) (context.Context, func(), bool) {
	ctx, cancel := context.WithCancel(parent)
	tracker.mu.Lock()
	if tracker.closed {
		tracker.mu.Unlock()
		cancel()
		return ctx, func() {}, false
	}
	tracker.nextID++
	id := tracker.nextID
	tracker.active[id] = cancel
	tracker.mu.Unlock()

	var releaseOnce sync.Once
	release := func() {
		releaseOnce.Do(func() {
			tracker.mu.Lock()
			delete(tracker.active, id)
			tracker.mu.Unlock()
			cancel()
		})
	}
	return ctx, release, true
}

func (tracker *previewRequestTracker) close() {
	tracker.mu.Lock()
	tracker.closed = true
	cancellations := make([]context.CancelFunc, 0, len(tracker.active))
	for id, cancel := range tracker.active {
		cancellations = append(cancellations, cancel)
		delete(tracker.active, id)
	}
	tracker.mu.Unlock()
	for _, cancel := range cancellations {
		cancel()
	}
}

func (server *apiServer) handlePreview(writer http.ResponseWriter, request *http.Request) {
	port, err := strconv.Atoi(request.PathValue("port"))
	if err != nil || validatePreviewPort(port) != nil {
		writeAPIError(writer, http.StatusBadRequest, "invalid preview port")
		return
	}
	path := request.PathValue("path")
	if path == "" {
		path = "/"
	} else if !strings.HasPrefix(path, "/") {
		path = "/" + path
	}
	if strings.ContainsRune(path, '\x00') {
		writeAPIError(writer, http.StatusBadRequest, "invalid preview path")
		return
	}
	previewContext, release, tracked := server.previewRequests.track(request.Context())
	if !tracked {
		writeAPIError(writer, http.StatusServiceUnavailable, "Nanoagent is shutting down")
		return
	}
	defer release()
	request = request.WithContext(previewContext)
	target, _ := url.Parse(fmt.Sprintf("http://%s", loopbackAddress(port)))
	proxy := httputil.NewSingleHostReverseProxy(target)
	proxy.Transport = server.previewTransport
	originalDirector := proxy.Director
	proxy.Director = func(upstream *http.Request) {
		originalDirector(upstream)
		upstream.URL.Path = path
		upstream.URL.RawPath = ""
		upstream.Host = target.Host
		if upstream.Header.Get("Origin") != "" {
			upstream.Header.Set("Origin", target.Scheme+"://"+target.Host)
		}
		for _, header := range dangerousForwardHeaders {
			upstream.Header.Del(header)
		}
		// A nil value prevents ReverseProxy from synthesizing the caller's address after Director returns.
		upstream.Header["X-Forwarded-For"] = nil
		upstream.Header.Set("X-Tengri-Preview", "1")
	}
	proxy.ModifyResponse = func(response *http.Response) error {
		// This marker is reserved for Nanoagent's own authentication middleware. Guest applications
		// must not be able to spoof an authentication failure and evict Tengri's cached guest binding.
		response.Header.Del(nanoagentAuthFailureHeader)
		response.Header.Del("Server")
		response.Header.Set("Cache-Control", "no-store")
		return nil
	}
	proxy.ErrorHandler = func(writer http.ResponseWriter, _ *http.Request, _ error) {
		writeAPIError(writer, http.StatusBadGateway, "preview service is unavailable inside the microVM")
	}
	proxy.ServeHTTP(writer, request)
}
