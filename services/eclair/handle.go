package function

import (
	"fmt"
	"net/http"
	"time"
)

// Handle is the HTTP entrypoint for Knative Functions (Go runtime).
func Handle(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")

	switch r.URL.Path {
	case "/healthz":
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	case "/":
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("eclair\n"))
	default:
		_, _ = fmt.Fprintf(w, "eclair responding - %s\n", time.Now().Format(time.RFC3339))
	}
}
