package trading

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	sdkalpaca "github.com/alpacahq/alpaca-trade-api-go/v3/alpaca"
	"github.com/proompteng/lab/services/miel/internal/alpaca"
	"github.com/proompteng/lab/services/miel/internal/backtest"
	"github.com/proompteng/lab/services/miel/internal/config"
)

type ledgerRecorderStub struct {
	orders []*sdkalpaca.Order
	err    error
}

func (s *ledgerRecorderStub) RecordOrder(_ context.Context, order *sdkalpaca.Order) error {
	s.orders = append(s.orders, order)
	return s.err
}

func TestSubmitMarketOrderReturnsAcceptedOrderWhenLedgerWriteFails(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(w).Encode(sdkalpaca.Order{ID: "order-accepted", Symbol: "AAPL", Side: sdkalpaca.Buy}); err != nil {
			t.Fatalf("encode order: %v", err)
		}
	}))
	defer server.Close()

	cfg := config.Config{
		AlpacaAPIKey:         "key",
		AlpacaAPISecret:      "secret",
		AlpacaTradingBaseURL: server.URL,
		AlpacaMarketDataURL:  server.URL,
		RequestTimeout:       time.Second,
	}
	recorder := &ledgerRecorderStub{err: errors.New("ledger unavailable")}
	svc := NewService(alpaca.NewClient(cfg), recorder)

	order, err := svc.SubmitMarketOrder(context.Background(), "AAPL", 1, "buy", "day", false)
	if err != nil {
		t.Fatalf("accepted broker order must not be reported as failed: %v", err)
	}
	if order.ID != "order-accepted" {
		t.Fatalf("unexpected order id %s", order.ID)
	}
}

func (s *ledgerRecorderStub) RecordBacktest(context.Context, backtest.Result) error { return nil }
func (s *ledgerRecorderStub) Close() error                                          { return nil }

func TestSubmitMarketOrderCallsLedger(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/v2/orders" {
			t.Fatalf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(w).Encode(sdkalpaca.Order{ID: "order-xyz", Symbol: "AAPL", Side: sdkalpaca.Buy}); err != nil {
			t.Fatalf("encode order: %v", err)
		}
	}))
	defer server.Close()

	cfg := config.Config{
		AlpacaAPIKey:         "key",
		AlpacaAPISecret:      "secret",
		AlpacaTradingBaseURL: server.URL,
		AlpacaMarketDataURL:  server.URL,
		RequestTimeout:       time.Second,
	}

	alpacaClient := alpaca.NewClient(cfg)
	recorder := &ledgerRecorderStub{}
	svc := NewService(alpacaClient, recorder)

	order, err := svc.SubmitMarketOrder(context.Background(), "AAPL", 1, "buy", "day", false)
	if err != nil {
		t.Fatalf("SubmitMarketOrder returned error: %v", err)
	}
	if order.ID != "order-xyz" {
		t.Fatalf("unexpected order id %s", order.ID)
	}
	if len(recorder.orders) != 1 {
		t.Fatalf("expected ledger recorder to capture one order")
	}
}

func TestSubmitMarketOrderValidation(t *testing.T) {
	cfg := config.Config{RequestTimeout: time.Second}
	svc := NewService(alpaca.NewClient(cfg), nil)

	if _, err := svc.SubmitMarketOrder(context.Background(), "AAPL", 1, "invalid", "day", false); err == nil {
		t.Fatalf("expected error for invalid side")
	}
}
