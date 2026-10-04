package alpaca

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/alpacahq/alpaca-trade-api-go/v3/alpaca"
	marketdata "github.com/alpacahq/alpaca-trade-api-go/v3/marketdata"
	"github.com/proompteng/lab/services/miel/internal/config"
)

func TestPlaceMarketOrderValidation(t *testing.T) {
	cfg := config.Config{RequestTimeout: 50 * time.Millisecond}
	client := NewClient(cfg)

	cases := []MarketOrderInput{
		{Symbol: "", Quantity: 1, Side: alpaca.Buy},
		{Symbol: "AAPL", Quantity: 0, Side: alpaca.Buy},
		{Symbol: "AAPL", Quantity: 1, Side: "invalid"},
	}

	for _, input := range cases {
		if _, err := client.PlaceMarketOrder(context.Background(), input); err == nil {
			t.Fatalf("expected validation error for input %+v", input)
		}
	}
}

func TestPlaceMarketOrderSuccess(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/v2/orders" {
			t.Fatalf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(w).Encode(alpaca.Order{ID: "order-1", Symbol: "AAPL", Side: alpaca.Buy}); err != nil {
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

	client := NewClient(cfg)

	order, err := client.PlaceMarketOrder(context.Background(), MarketOrderInput{
		Symbol: "AAPL", Quantity: 1, Side: alpaca.Buy, TimeInForce: alpaca.Day,
	})
	if err != nil {
		t.Fatalf("PlaceMarketOrder returned error: %v", err)
	}
	if order.ID != "order-1" {
		t.Fatalf("unexpected order id %s", order.ID)
	}
}

func TestFetchBarsValidation(t *testing.T) {
	cfg := config.Config{RequestTimeout: 50 * time.Millisecond}
	client := NewClient(cfg)

	if _, err := client.FetchBars(context.Background(), "", marketdata.OneDay, time.Time{}, time.Time{}, 10); err == nil {
		t.Fatalf("expected error for missing symbol")
	}

	if _, err := client.FetchBars(context.Background(), "AAPL", marketdata.OneDay, time.Time{}, time.Time{}, 0); err == nil {
		t.Fatalf("expected error for non-positive limit")
	}

	start := time.Now()
	end := start.Add(-time.Hour)
	if _, err := client.FetchBars(context.Background(), "AAPL", marketdata.OneDay, start, end, 1); err == nil {
		t.Fatalf("expected error for start >= end")
	}
}

func TestFetchBarsSuccess(t *testing.T) {
	barsResp := map[string][]marketdata.Bar{
		"AAPL": {
			{
				Timestamp:  time.Date(2024, 1, 1, 0, 0, 0, 0, time.UTC),
				Open:       10,
				High:       11,
				Low:        9,
				Close:      10.5,
				Volume:     100,
				TradeCount: 1,
				VWAP:       10.2,
			},
		},
	}

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/v2/stocks/bars" {
			t.Fatalf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		resp := struct {
			Bars map[string][]marketdata.Bar `json:"bars"`
		}{Bars: barsResp}
		if err := json.NewEncoder(w).Encode(resp); err != nil {
			t.Fatalf("encode bars: %v", err)
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

	client := NewClient(cfg)

	bars, err := client.FetchBars(context.Background(), "AAPL", marketdata.OneDay, time.Time{}, time.Time{}, 1)
	if err != nil {
		t.Fatalf("FetchBars returned error: %v", err)
	}
	if len(bars) != 1 {
		t.Fatalf("expected 1 bar, got %d", len(bars))
	}
	if bars[0].Close != 10.5 {
		t.Fatalf("unexpected bar close %.2f", bars[0].Close)
	}
}
