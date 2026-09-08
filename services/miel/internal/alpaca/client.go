package alpaca

import (
	"context"
	"fmt"
	"time"

	"github.com/alpacahq/alpaca-trade-api-go/v3/alpaca"
	marketdata "github.com/alpacahq/alpaca-trade-api-go/v3/marketdata"
	"github.com/proompteng/lab/services/miel/internal/config"
	"github.com/shopspring/decimal"
)

var defaultTimeFrame = marketdata.OneDay

// Client wraps Alpaca trading and market data clients with shared configuration.
type Client struct {
	trading *alpaca.Client
	data    *marketdata.Client
	timeout time.Duration
}

// NewClient constructs a trading + market data client pair.
func NewClient(cfg config.Config) *Client {
	trading := alpaca.NewClient(alpaca.ClientOpts{
		APIKey:    cfg.AlpacaAPIKey,
		APISecret: cfg.AlpacaAPISecret,
		BaseURL:   cfg.AlpacaTradingBaseURL,
	})

	data := marketdata.NewClient(marketdata.ClientOpts{
		APIKey:    cfg.AlpacaAPIKey,
		APISecret: cfg.AlpacaAPISecret,
		BaseURL:   cfg.AlpacaMarketDataURL,
	})

	return &Client{
		trading: trading,
		data:    data,
		timeout: cfg.RequestTimeout,
	}
}

// MarketOrderInput represents the minimum details needed for a market order.
type MarketOrderInput struct {
	Symbol        string
	Quantity      float64
	Side          alpaca.Side
	TimeInForce   alpaca.TimeInForce
	ExtendedHours bool
}

// PlaceMarketOrder submits a market order to Alpaca.
func (c *Client) PlaceMarketOrder(ctx context.Context, input MarketOrderInput) (*alpaca.Order, error) {
	if input.Symbol == "" {
		return nil, fmt.Errorf("symbol is required")
	}
	if input.Quantity <= 0 {
		return nil, fmt.Errorf("quantity must be positive")
	}
	if input.Side != alpaca.Buy && input.Side != alpaca.Sell {
		return nil, fmt.Errorf("side must be buy or sell")
	}
	if input.TimeInForce == "" {
		input.TimeInForce = alpaca.Day
	}

	ctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()

	qty := decimal.NewFromFloat(input.Quantity)
	order, err := c.trading.PlaceOrder(alpaca.PlaceOrderRequest{
		Symbol:        input.Symbol,
		Qty:           &qty,
		Side:          input.Side,
		Type:          alpaca.Market,
		TimeInForce:   input.TimeInForce,
		ExtendedHours: input.ExtendedHours,
	})
	if err != nil {
		return nil, err
	}
	return order, nil
}

// FetchBars retrieves aggregated historical bars for a symbol.
func (c *Client) FetchBars(ctx context.Context, symbol string, tf marketdata.TimeFrame, start, end time.Time, limit int) ([]marketdata.Bar, error) {
	if symbol == "" {
		return nil, fmt.Errorf("symbol is required")
	}
	if limit <= 0 {
		return nil, fmt.Errorf("limit must be positive")
	}
	if tf.N == 0 {
		tf = defaultTimeFrame
	}
	if end.IsZero() {
		end = time.Now().UTC()
	}
	if start.IsZero() {
		start = end.AddDate(0, 0, -30)
	}
	if !start.Before(end) {
		return nil, fmt.Errorf("start must be before end")
	}

	req := marketdata.GetBarsRequest{
		TimeFrame:  tf,
		Start:      start,
		End:        end,
		TotalLimit: limit,
	}

	ctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()

	return c.data.GetBars(symbol, req)
}
