package backtest

import (
	"context"
	"testing"
	"time"

	marketdata "github.com/alpacahq/alpaca-trade-api-go/v3/marketdata"
	"github.com/stretchr/testify/require"
)

type fakeProvider struct {
	bars []marketdata.Bar
	err  error
}

func (f *fakeProvider) FetchBars(ctx context.Context, symbol string, tf marketdata.TimeFrame, start, end time.Time, limit int) ([]marketdata.Bar, error) {
	if f.err != nil {
		return nil, f.err
	}
	if len(f.bars) > limit {
		return f.bars[:limit], nil
	}
	return f.bars, nil
}

func TestRunBuyAndHold(t *testing.T) {
	bars := []marketdata.Bar{
		{Timestamp: time.Date(2024, 1, 1, 0, 0, 0, 0, time.UTC), Open: 100, High: 110, Low: 95, Close: 105},
		{Timestamp: time.Date(2024, 1, 2, 0, 0, 0, 0, time.UTC), Open: 105, High: 120, Low: 100, Close: 118},
	}

	engine := NewEngine(&fakeProvider{bars: bars}, 100)
	res, err := engine.Run(context.Background(), RunRequest{
		Symbol:   "AAPL",
		Strategy: StrategyBuyAndHold,
		Quantity: 10,
	})

	require.NoError(t, err)
	require.Len(t, res.Trades, 1)
	require.InDelta(t, 180.0, res.NetProfit, 1e-6)
	require.InDelta(t, 18.0, res.ReturnPct, 1e-6)
	require.GreaterOrEqual(t, res.MaxDrawdown, 0.0)
}

func TestRunSMACross(t *testing.T) {
	bars := []marketdata.Bar{
		{Timestamp: time.Date(2024, 2, 1, 0, 0, 0, 0, time.UTC), Close: 100},
		{Timestamp: time.Date(2024, 2, 2, 0, 0, 0, 0, time.UTC), Close: 102},
		{Timestamp: time.Date(2024, 2, 3, 0, 0, 0, 0, time.UTC), Close: 104},
		{Timestamp: time.Date(2024, 2, 4, 0, 0, 0, 0, time.UTC), Close: 103},
		{Timestamp: time.Date(2024, 2, 5, 0, 0, 0, 0, time.UTC), Close: 105},
		{Timestamp: time.Date(2024, 2, 6, 0, 0, 0, 0, time.UTC), Close: 108},
	}

	engine := NewEngine(&fakeProvider{bars: bars}, 100)
	res, err := engine.Run(context.Background(), RunRequest{
		Symbol:     "AAPL",
		Strategy:   StrategySMACross,
		Quantity:   5,
		FastPeriod: 2,
		SlowPeriod: 3,
	})

	require.NoError(t, err)
	require.NotEmpty(t, res.Trades)
	require.NotZero(t, res.NetProfit)
	require.InDelta(t, float64(len(bars)), float64(res.BarCount), 0.1)
}
