package server

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	sdkalpaca "github.com/alpacahq/alpaca-trade-api-go/v3/alpaca"
	marketdata "github.com/alpacahq/alpaca-trade-api-go/v3/marketdata"
	"github.com/gin-gonic/gin"
	"github.com/proompteng/lab/services/miel/internal/alpaca"
	"github.com/proompteng/lab/services/miel/internal/backtest"
	"github.com/proompteng/lab/services/miel/internal/config"
	"github.com/proompteng/lab/services/miel/internal/trading"
)

type ledgerStub struct {
	orders    []*sdkalpaca.Order
	backtests []backtest.Result
}

func (l *ledgerStub) RecordOrder(_ context.Context, order *sdkalpaca.Order) error {
	l.orders = append(l.orders, order)
	return nil
}

func (l *ledgerStub) RecordBacktest(_ context.Context, result backtest.Result) error {
	l.backtests = append(l.backtests, result)
	return nil
}

func (l *ledgerStub) Close() error { return nil }

type barProvider struct {
	bars []marketdata.Bar
}

func (p *barProvider) FetchBars(context.Context, string, marketdata.TimeFrame, time.Time, time.Time, int) ([]marketdata.Bar, error) {
	return p.bars, nil
}

func TestHandleMarketOrder(t *testing.T) {
	gin.SetMode(gin.TestMode)

	apiServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/v2/orders" {
			t.Fatalf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(w).Encode(sdkalpaca.Order{ID: "order-abc", Symbol: "AAPL", Side: sdkalpaca.Buy}); err != nil {
			t.Fatalf("encode order: %v", err)
		}
	}))
	defer apiServer.Close()

	cfg := config.Config{
		AlpacaAPIKey:         "key",
		AlpacaAPISecret:      "secret",
		AlpacaTradingBaseURL: apiServer.URL,
		AlpacaMarketDataURL:  apiServer.URL,
		RequestTimeout:       time.Second,
		ServiceName:          "miel-test",
	}

	alpacaClient := alpaca.NewClient(cfg)
	recorder := &ledgerStub{}
	tradingSvc := trading.NewService(alpacaClient, recorder)
	backtestEngine := backtest.NewEngine(&barProvider{bars: []marketdata.Bar{
		{Timestamp: time.Now().Add(-24 * time.Hour), Open: 10, Close: 11},
		{Timestamp: time.Now(), Open: 11, Close: 12},
	}}, 100)

	srv := New(cfg.ServiceName, tradingSvc, backtestEngine, recorder)

	body := map[string]any{
		"symbol":   "AAPL",
		"quantity": 1,
		"side":     "buy",
	}
	payload, _ := json.Marshal(body)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/orders/market", bytes.NewReader(payload))
	req.Header.Set("Content-Type", "application/json")
	resp := httptest.NewRecorder()

	srv.Router().ServeHTTP(resp, req)

	if resp.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", resp.Code)
	}
	if len(recorder.orders) != 1 {
		t.Fatalf("expected ledger to capture one order")
	}
}

func TestHandleBacktest(t *testing.T) {
	gin.SetMode(gin.TestMode)

	recorder := &ledgerStub{}
	tradingSvc := trading.NewService(alpaca.NewClient(config.Config{RequestTimeout: time.Second}), recorder)
	bars := []marketdata.Bar{
		{Timestamp: time.Now().Add(-48 * time.Hour), Open: 10, Close: 11},
		{Timestamp: time.Now().Add(-24 * time.Hour), Open: 11, Close: 12},
		{Timestamp: time.Now(), Open: 12, Close: 13},
	}
	engine := backtest.NewEngine(&barProvider{bars: bars}, 100)

	srv := New("miel-test", tradingSvc, engine, recorder)

	body := map[string]any{
		"symbol":    "AAPL",
		"timeframe": "1Day",
		"start":     bars[0].Timestamp.Format(time.RFC3339),
		"end":       bars[2].Timestamp.Format(time.RFC3339),
	}
	payload, _ := json.Marshal(body)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/backtests", bytes.NewReader(payload))
	req.Header.Set("Content-Type", "application/json")
	resp := httptest.NewRecorder()

	srv.Router().ServeHTTP(resp, req)

	if resp.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", resp.Code)
	}
	if len(recorder.backtests) != 1 {
		t.Fatalf("expected ledger to capture backtest result")
	}
}
