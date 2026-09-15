package main

import (
	"context"
	"encoding/json"
	"net/http"
	"regexp"
	"sync"
	"time"

	"github.com/coder/websocket"
)

var editorSessionPattern = regexp.MustCompile(`^[a-z0-9]{24}$`)

type editorPeers struct {
	browser, extension *websocket.Conn
	state              []byte
}

type editorBridge struct {
	mu       sync.Mutex
	closed   bool
	sessions map[string]*editorPeers
}

func newEditorBridge() *editorBridge { return &editorBridge{sessions: make(map[string]*editorPeers)} }

func isEditorStateMessage(data []byte) bool {
	var message struct {
		Type  string `json:"type"`
		Dirty *bool  `json:"dirty"`
	}
	return json.Unmarshal(data, &message) == nil && message.Type == "state" && message.Dirty != nil
}

func (bridge *editorBridge) browser(writer http.ResponseWriter, request *http.Request) {
	bridge.attach(writer, request, false)
}

func (bridge *editorBridge) extension(writer http.ResponseWriter, request *http.Request) {
	bridge.attach(writer, request, true)
}

func (bridge *editorBridge) attach(writer http.ResponseWriter, request *http.Request, extension bool) {
	id := request.URL.Query().Get("session")
	if !editorSessionPattern.MatchString(id) {
		writeAPIError(writer, http.StatusBadRequest, "invalid editor session")
		return
	}
	// Browser requests have already passed Nanoagent bearer authentication through the
	// owner-scoped preview gateway. The extension listener binds only to guest loopback.
	connection, err := websocket.Accept(writer, request, &websocket.AcceptOptions{InsecureSkipVerify: true})
	if err != nil {
		return
	}
	connection.SetReadLimit(64 << 10)
	defer connection.CloseNow()
	bridge.mu.Lock()
	if bridge.closed || (bridge.sessions[id] == nil && len(bridge.sessions) >= 16) {
		bridge.mu.Unlock()
		_ = connection.Close(websocket.StatusTryAgainLater, "editor connection limit reached")
		return
	}
	peers := bridge.sessions[id]
	if peers == nil {
		peers = &editorPeers{}
		bridge.sessions[id] = peers
	}
	previous := peers.browser
	if extension {
		previous = peers.extension
		peers.extension = connection
	} else {
		peers.browser = connection
	}
	state := append([]byte(nil), peers.state...)
	bridge.mu.Unlock()
	if previous != nil {
		_ = previous.Close(websocket.StatusGoingAway, "editor superseded")
	}
	defer func() {
		bridge.mu.Lock()
		defer bridge.mu.Unlock()
		if extension && peers.extension == connection {
			peers.extension = nil
			peers.state = nil
			if peers.browser != nil {
				go func(target *websocket.Conn) { _ = writeEditorMessage(target, []byte(`{"type":"disconnected"}`)) }(peers.browser)
			}
		}
		if !extension && peers.browser == connection {
			peers.browser = nil
		}
		if peers.extension == nil && peers.browser == nil {
			delete(bridge.sessions, id)
		}
	}()
	if !extension && len(state) > 0 {
		_ = writeEditorMessage(connection, state)
	}
	for {
		kind, data, err := connection.Read(request.Context())
		if err != nil {
			return
		}
		if kind != websocket.MessageText {
			continue
		}
		bridge.mu.Lock()
		if (extension && peers.extension != connection) || (!extension && peers.browser != connection) {
			bridge.mu.Unlock()
			return
		}
		target := peers.extension
		if extension {
			target = peers.browser
			// Only state notifications are replayed; command replies belong to their caller.
			if isEditorStateMessage(data) {
				peers.state = append([]byte(nil), data...)
			}
		}
		bridge.mu.Unlock()
		if target != nil {
			_ = writeEditorMessage(target, data)
		}
	}
}

func writeEditorMessage(connection *websocket.Conn, data []byte) error {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return connection.Write(ctx, websocket.MessageText, data)
}

func (bridge *editorBridge) close() {
	bridge.mu.Lock()
	bridge.closed = true
	connections := make([]*websocket.Conn, 0, len(bridge.sessions)*2)
	for _, peers := range bridge.sessions {
		if peers.browser != nil {
			connections = append(connections, peers.browser)
		}
		if peers.extension != nil {
			connections = append(connections, peers.extension)
		}
	}
	bridge.mu.Unlock()
	for _, connection := range connections {
		_ = connection.CloseNow()
	}
}
