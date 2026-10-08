package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sync"
)

// The real Chromium acceptance fixture shares the production display, preview
// stream and stdio MCP. The website refuses framing and reports real JS input.
func installBrowserAcceptance(mux *http.ServeMux, browser *browserSupervisor, home string) {
	_ = os.Remove(filepath.Join(browser.downloads, "browser-proof.txt"))
	var mu sync.Mutex
	var loaded, submitted, input map[string]any
	mux.HandleFunc("POST /_test/computer", func(w http.ResponseWriter, r *http.Request) {
		data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxComputerRequestBytes))
		if err != nil {
			http.Error(w, err.Error(), 400)
			return
		}
		var arguments json.RawMessage
		if err := json.Unmarshal(data, &arguments); err != nil {
			http.Error(w, err.Error(), 400)
			return
		}
		request, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": map[string]any{"name": "computer", "arguments": arguments}})
		var output bytes.Buffer
		if err := runBrowserMCP(bytes.NewReader(append(request, '\n')), &output, home); err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(output.Bytes())
	})
	mux.HandleFunc("GET /_test/browser-state", func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		download, _ := os.ReadFile(filepath.Join(browser.downloads, "browser-proof.txt"))
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"loaded": loaded, "submitted": submitted, "input": input, "download": string(download)})
	})
	for _, name := range []string{"loaded", "submitted", "input"} {
		mux.HandleFunc("POST /_test/site-"+name, func(w http.ResponseWriter, r *http.Request) {
			var value map[string]any
			if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&value); err != nil {
				http.Error(w, err.Error(), 400)
				return
			}
			mu.Lock()
			defer mu.Unlock()
			if name == "loaded" {
				loaded = value
			} else if name == "submitted" {
				submitted = value
			} else {
				input = value
			}
			w.WriteHeader(http.StatusNoContent)
		})
	}
	mux.HandleFunc("GET /_test/download", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		w.Header().Set("Content-Disposition", `attachment; filename="browser-proof.txt"`)
		_, _ = w.Write([]byte("CHROMIUM_DOWNLOAD_OK\n"))
	})
	mux.HandleFunc("GET /_test/site", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Content-Security-Policy", "frame-ancestors 'none'")
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write([]byte(`<!doctype html><html><head><title>Real Chromium proof</title>
<style>body{background:#123c64;color:white;font:24px sans-serif;padding:32px}input,button,a{font:24px sans-serif}input{width:400px}a{color:#bdddff}</style></head>
<body><h1>Real Chromium proof</h1><form><input id="message" autofocus aria-label="Message"><button>Send</button></form>
<p><a href="/_test/site?second=1">Next page</a></p><p><a href="/_test/site?tab=1" target="_blank">New tab</a></p><p><a href="/_test/download">Download file</a></p><output></output>
<script>
const previousCookie=document.cookie;const previousStorage=localStorage.getItem('browser-proof');
document.cookie='browser-proof=persistent; Max-Age=600; SameSite=Lax';localStorage.setItem('browser-proof','persistent');
const report=()=>requestAnimationFrame(()=>requestAnimationFrame(()=>{const rect=document.querySelector('input').getBoundingClientRect();fetch('/_test/site-loaded',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url:location.href,previousCookie,previousStorage,userAgent:navigator.userAgent,messageCenter:{x:Math.round(screenX+rect.x+rect.width/2),y:Math.round(screenY+outerHeight-innerHeight+rect.y+rect.height/2)}})})}));addEventListener('pageshow',report);
document.querySelector('input').oninput=()=>fetch('/_test/site-input',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message:document.querySelector('input').value})});
document.querySelector('form').onsubmit=async e=>{e.preventDefault();const message=document.querySelector('input').value;await fetch('/_test/site-submitted',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message,userAgent:navigator.userAgent})});document.querySelector('output').textContent='Submitted: '+message};
</script></body></html>`))
	})
}
