package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"image"
	"image/png"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

func TestComputerActionValidation(t *testing.T) {
	for _, input := range []string{
		`{"action":"click"}`, `{"action":"drag","x":1,"y":2}`, `{"action":"scroll","x":1,"y":2,"direction":"down","steps":0}`,
		`{"action":"key","key":"--window"}`, `{"action":"type","text":""}`, `{"action":"navigate","url":"file:///etc/passwd"}`,
		`{"action":"navigate","url":"https://user:password@example.test"}`, `{"action":"shell"}`,
	} {
		var action computerAction
		if err := json.Unmarshal([]byte(input), &action); err != nil {
			t.Fatal(err)
		}
		if validateComputerAction(action) == nil {
			t.Errorf("accepted unsafe or incomplete action %s", input)
		}
	}
	for _, input := range []string{
		`{"action":"click","x":0,"y":0}`, `{"action":"drag","x":1,"y":2,"toX":3,"toY":4}`,
		`{"action":"scroll","x":1,"y":2,"direction":"down","steps":3}`, `{"action":"key","key":"ctrl+l"}`,
		`{"action":"type","text":"Hello, 世界"}`, `{"action":"navigate","url":"https://example.test/"}`, `{"action":"screenshot"}`,
	} {
		var action computerAction
		_ = json.Unmarshal([]byte(input), &action)
		if err := validateComputerAction(action); err != nil {
			t.Errorf("rejected valid action %s: %v", input, err)
		}
	}
}

func TestBrowserMCPUsesPrivateSocketAndHonorsUserTakeover(t *testing.T) {
	browser := newBrowserSupervisor("not-launched", "", browserTestHome(t), "", "")
	if err := browser.listenCUA(); err != nil {
		t.Fatal(err)
	}
	defer browser.close()
	second := newBrowserSupervisor("not-launched", "", browser.home, "", "")
	defer second.close()
	if err := second.listenCUA(); err == nil {
		t.Fatal("a second supervisor must not replace the active private socket")
	}
	info, err := os.Stat(filepath.Join(browser.home, ".tengri", "browser", "control.sock"))
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatalf("private socket permissions: %v %v", info, err)
	}
	request := httptest.NewRequest(http.MethodPost, "http://preview/control", strings.NewReader(`{"userControl":true}`))
	writer := httptest.NewRecorder()
	browser.serve(writer, request, "/control")
	if writer.Code != http.StatusOK {
		t.Fatalf("takeover failed: %d", writer.Code)
	}
	input := strings.NewReader("{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{}}\n{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}\n{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/list\"}\n{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"tools/call\",\"params\":{\"name\":\"computer\",\"arguments\":{\"action\":\"screenshot\"}}}\n")
	var output bytes.Buffer
	if err := runBrowserMCP(input, &output, browser.home); err != nil {
		t.Fatal(err)
	}
	decoder := json.NewDecoder(&output)
	var initialized, listed, result map[string]any
	for _, response := range []*map[string]any{&initialized, &listed, &result} {
		if err := decoder.Decode(response); err != nil {
			t.Fatal(err)
		}
	}
	if initialized["result"].(map[string]any)["serverInfo"].(map[string]any)["name"] != "tengri-browser" {
		t.Fatal(initialized)
	}
	if listed["result"].(map[string]any)["tools"].([]any)[0].(map[string]any)["name"] != "computer" {
		t.Fatal(listed)
	}
	blocked := result["result"].(map[string]any)
	if blocked["isError"] != true || !strings.Contains(blocked["content"].([]any)[0].(map[string]any)["text"].(string), "taken control") {
		t.Fatalf("takeover did not block screenshots: %v", result)
	}
	if browser.current != nil {
		t.Fatal("takeover must not launch a browser")
	}
	restarted := newBrowserSupervisor("not-launched", "", browser.home, "", "")
	defer restarted.close()
	if !restarted.userControl {
		t.Fatal("takeover must survive a guest restart")
	}
	if _, err := browser.perform(context.Background(), computerAction{Action: "status"}); err != nil {
		t.Fatal(err)
	}
}

func TestBrowserWebSocketBridgesOnlyThePrivateDisplay(t *testing.T) {
	browser := newBrowserSupervisor("", "", browserTestHome(t), "", "")
	root := filepath.Join(browser.home, ".tengri", "browser")
	if err := os.MkdirAll(root, 0700); err != nil {
		t.Fatal(err)
	}
	listener, err := net.Listen("unix", filepath.Join(root, "rfb.sock"))
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	go func() {
		connection, err := listener.Accept()
		if err != nil {
			return
		}
		defer connection.Close()
		_, _ = io.Copy(connection, connection)
	}()
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) { browser.serve(writer, request, "/websockify") }))
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	client, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(server.URL, "http"), &websocket.DialOptions{Subprotocols: []string{"binary"}})
	if err != nil {
		t.Fatal(err)
	}
	defer client.CloseNow()
	if err := client.Write(ctx, websocket.MessageBinary, []byte("RFB 003.008\n")); err != nil {
		t.Fatal(err)
	}
	_, data, err := client.Read(ctx)
	if err != nil || string(data) != "RFB 003.008\n" {
		t.Fatalf("browser bridge: %s, %v", data, err)
	}
}

func TestBrowserMCPFramesMaximumEscapedTextWithoutExiting(t *testing.T) {
	browser := newBrowserSupervisor("not-launched", "", browserTestHome(t), "", "")
	browser.userControl = true
	if err := browser.listenCUA(); err != nil {
		t.Fatal(err)
	}
	defer browser.close()
	for _, character := range []string{"\\", "\x1f"} {
		action := computerAction{Action: "type", Text: strings.Repeat(character, 65536)}
		if err := validateComputerAction(action); err != nil {
			t.Fatal(err)
		}
		request, err := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": map[string]any{"name": "computer", "arguments": action}})
		if err != nil {
			t.Fatal(err)
		}
		input := append(request, []byte("\n{\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"computer\",\"arguments\":{\"action\":\"status\"}}}\n")...)
		var output bytes.Buffer
		if err := runBrowserMCP(bytes.NewReader(input), &output, browser.home); err != nil {
			t.Fatalf("valid escaped text terminated MCP: %v", err)
		}
		decoder := json.NewDecoder(&output)
		var actionResult, statusResult struct {
			Error  json.RawMessage `json:"error"`
			Result struct {
				IsError           bool `json:"isError"`
				StructuredContent struct {
					UserControl bool `json:"userControl"`
				} `json:"structuredContent"`
			} `json:"result"`
		}
		if err := decoder.Decode(&actionResult); err != nil || len(actionResult.Error) > 0 || !actionResult.Result.IsError {
			t.Fatalf("valid request did not reach the takeover check: %v %s", err, output.Bytes())
		}
		if err := decoder.Decode(&statusResult); err != nil || len(statusResult.Error) > 0 || !statusResult.Result.StructuredContent.UserControl {
			t.Fatalf("MCP did not continue after large request: %v %s", err, output.Bytes())
		}
	}
}

func TestBrowserScreenshotRejectsImageThatWouldBreakAppServerFraming(t *testing.T) {
	browser := newBrowserSupervisor("not-launched", "", browserTestHome(t), "", "")
	defer browser.close()
	root := filepath.Join(browser.home, ".tengri", "browser")
	runtime := filepath.Join(root, "libraries-test")
	if err := os.MkdirAll(filepath.Join(runtime, "usr/bin"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "runtime-path"), []byte(runtime), 0600); err != nil {
		t.Fatal(err)
	}
	picture := image.NewRGBA(image.Rect(0, 0, 1600, 1400))
	for i := 3; i < len(picture.Pix); i += 4 {
		picture.Pix[i] = 255
	}
	path := filepath.Join(root, "large-valid.png")
	file, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	encoder := png.Encoder{CompressionLevel: png.NoCompression}
	if err := encoder.Encode(file, picture); err != nil {
		t.Fatal(err)
	}
	_ = file.Close()
	if err := os.WriteFile(filepath.Join(runtime, "usr/bin/scrot"), []byte(fmt.Sprintf("#!/bin/sh\n/bin/cp %q \"$3\"\n", path)), 0700); err != nil {
		t.Fatal(err)
	}
	if _, err := browser.screenshot(context.Background()); err == nil || !strings.Contains(err.Error(), "reduce the Chrome window size") {
		t.Fatalf("oversized screenshot must return a tool error before breaking app-server framing: %v", err)
	}
}

func TestBrowserPasteRejectsInvalidInputWithoutStarting(t *testing.T) {
	browser := newBrowserSupervisor("not-launched", "", browserTestHome(t), "", "")
	defer browser.close()
	for _, input := range []string{`{}`, `{"text":""}`, `{"text":"a\u0000b"}`, `{"text":"hello","command":"sh"}`} {
		request := httptest.NewRequest(http.MethodPost, "/paste", strings.NewReader(input))
		response := httptest.NewRecorder()
		browser.serve(response, request, "/paste")
		if response.Code != http.StatusBadRequest || browser.current != nil {
			t.Fatalf("invalid paste started a browser or succeeded: %s, %d", input, response.Code)
		}
	}
	response := httptest.NewRecorder()
	browser.serve(response, httptest.NewRequest(http.MethodGet, "/paste", nil), "/paste")
	if response.Code != http.StatusMethodNotAllowed {
		t.Fatalf("GET must not paste: %d", response.Code)
	}
}

func browserTestHome(t *testing.T) string {
	t.Helper()
	home, err := os.MkdirTemp("/tmp", "browser-test-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(home) })
	return home
}
