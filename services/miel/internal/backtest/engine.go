package backtest

import (
	"context"
	"errors"
	"time"

	marketdata "github.com/alpacahq/alpaca-trade-api-go/v3/marketdata"
)

// StrategyKind enumerates supported backtesting strategies.
type StrategyKind string

const (
	StrategyBuyAndHold StrategyKind = "buy-and-hold"
	StrategySMACross   StrategyKind = "sma-cross"
)

var (
	errUnsupportedStrategy = errors.New("unsupported strategy")
	errInsufficientBars    = errors.New("not enough bars to run strategy")
)

// MarketDataProvider fetches historical market bars.
type MarketDataProvider interface {
	FetchBars(ctx context.Context, symbol string, tf marketdata.TimeFrame, start, end time.Time, limit int) ([]marketdata.Bar, error)
}

// Engine coordinates strategy execution on top of a MarketDataProvider.
type Engine struct {
	data    MarketDataProvider
	maxBars int
}

// NewEngine returns a configured Engine.
func NewEngine(provider MarketDataProvider, maxBars int) *Engine {
	return &Engine{
		data:    provider,
		maxBars: maxBars,
	}
}

// RunRequest encapsulates a backtest invocation.
type RunRequest struct {
	Symbol     string
	TimeFrame  marketdata.TimeFrame
	Start      time.Time
	End        time.Time
	Quantity   float64
	Strategy   StrategyKind
	FastPeriod int
	SlowPeriod int
}

// Trade represents a single completed trade during the backtest.
type Trade struct {
	EntryTime  time.Time `json:"entry_time"`
	ExitTime   time.Time `json:"exit_time"`
	EntryPrice float64   `json:"entry_price"`
	ExitPrice  float64   `json:"exit_price"`
	Quantity   float64   `json:"quantity"`
	Profit     float64   `json:"profit"`
}

// Result aggregates the outcome of a backtest run.
type Result struct {
	Strategy    StrategyKind `json:"strategy"`
	Symbol      string       `json:"symbol"`
	Quantity    float64      `json:"quantity"`
	BarCount    int          `json:"bar_count"`
	NetProfit   float64      `json:"net_profit"`
	ReturnPct   float64      `json:"return_pct"`
	MaxDrawdown float64      `json:"max_drawdown"`
	Trades      []Trade      `json:"trades"`
	StartedAt   time.Time    `json:"started_at"`
	CompletedAt time.Time    `json:"completed_at"`
}

// Run executes the requested strategy and returns the backtest result.
func (e *Engine) Run(ctx context.Context, req RunRequest) (Result, error) {
	quantity := req.Quantity
	if quantity <= 0 {
		quantity = 1
	}

	bars, err := e.data.FetchBars(ctx, req.Symbol, req.TimeFrame, req.Start, req.End, e.maxBars)
	if err != nil {
		return Result{}, err
	}
	if len(bars) < 2 {
		return Result{}, errInsufficientBars
	}

	result := Result{
		Strategy:    req.Strategy,
		Symbol:      req.Symbol,
		Quantity:    quantity,
		BarCount:    len(bars),
		StartedAt:   bars[0].Timestamp,
		CompletedAt: bars[len(bars)-1].Timestamp,
	}

	switch req.Strategy {
	case StrategyBuyAndHold:
		return runBuyAndHold(result, bars, quantity)
	case StrategySMACross:
		fast := req.FastPeriod
		slow := req.SlowPeriod
		if fast <= 0 {
			fast = 5
		}
		if slow <= 0 {
			slow = 20
		}
		if fast >= slow {
			fast, slow = 5, 20
		}
		return runSMACross(result, bars, quantity, fast, slow)
	default:
		return Result{}, errUnsupportedStrategy
	}
}

func runBuyAndHold(result Result, bars []marketdata.Bar, qty float64) (Result, error) {
	entry := bars[0]
	exit := bars[len(bars)-1]
	profit := (exit.Close - entry.Open) * qty
	result.Trades = []Trade{
		{
			EntryTime:  entry.Timestamp,
			ExitTime:   exit.Timestamp,
			EntryPrice: entry.Open,
			ExitPrice:  exit.Close,
			Quantity:   qty,
			Profit:     profit,
		},
	}
	result.NetProfit = profit
	result.ReturnPct = percentDelta(entry.Open, exit.Close)
	result.MaxDrawdown = priceDrawdown(bars)
	return result, nil
}

func runSMACross(result Result, bars []marketdata.Bar, qty float64, fastPeriod, slowPeriod int) (Result, error) {
	var trades []Trade
	var realized float64
	var entryPrice float64
	var entryTime time.Time
	var inPosition bool

	fastSum := 0.0
	slowSum := 0.0
	fastWindow := make([]float64, 0, fastPeriod)
	slowWindow := make([]float64, 0, slowPeriod)

	peakEquity := 0.0
	maxDrawdown := 0.0

	for i, bar := range bars {
		close := bar.Close

		fastSum += close
		fastWindow = append(fastWindow, close)
		if len(fastWindow) > fastPeriod {
			fastSum -= fastWindow[0]
			fastWindow = fastWindow[1:]
		}

		slowSum += close
		slowWindow = append(slowWindow, close)
		if len(slowWindow) > slowPeriod {
			slowSum -= slowWindow[0]
			slowWindow = slowWindow[1:]
		}

		if len(slowWindow) < slowPeriod {
			updateDrawdown(&peakEquity, &maxDrawdown, realized)
			continue
		}

		fastAvg := fastSum / float64(len(fastWindow))
		slowAvg := slowSum / float64(len(slowWindow))

		if !inPosition && fastAvg > slowAvg {
			inPosition = true
			entryPrice = close
			entryTime = bar.Timestamp
		}

		if inPosition && fastAvg < slowAvg {
			profit := (close - entryPrice) * qty
			realized += profit
			trades = append(trades, Trade{
				EntryTime:  entryTime,
				ExitTime:   bar.Timestamp,
				EntryPrice: entryPrice,
				ExitPrice:  close,
				Quantity:   qty,
				Profit:     profit,
			})
			inPosition = false
		}

		unrealized := 0.0
		if inPosition {
			unrealized = (close - entryPrice) * qty
		}
		updateDrawdown(&peakEquity, &maxDrawdown, realized+unrealized)

		if i == len(bars)-1 && inPosition {
			profit := (close - entryPrice) * qty
			realized += profit
			trades = append(trades, Trade{
				EntryTime:  entryTime,
				ExitTime:   bar.Timestamp,
				EntryPrice: entryPrice,
				ExitPrice:  close,
				Quantity:   qty,
				Profit:     profit,
			})
			inPosition = false
			updateDrawdown(&peakEquity, &maxDrawdown, realized)
		}
	}

	result.Trades = trades
	result.NetProfit = realized

	initialPrice := bars[0].Open
	if initialPrice > 0 {
		result.ReturnPct = (realized / (initialPrice * qty)) * 100
	}

	result.MaxDrawdown = maxDrawdown
	return result, nil
}

func updateDrawdown(peak *float64, maxDD *float64, equity float64) {
	if equity > *peak {
		*peak = equity
	}
	if *peak <= 0 {
		return
	}
	drawdown := (*peak - equity) / *peak
	if drawdown > *maxDD {
		*maxDD = drawdown
	}
}

func percentDelta(entry, exit float64) float64 {
	if entry == 0 {
		return 0
	}
	return ((exit - entry) / entry) * 100
}

func priceDrawdown(bars []marketdata.Bar) float64 {
	peak := bars[0].High
	maxDD := 0.0
	for _, bar := range bars {
		if bar.High > peak {
			peak = bar.High
		}
		if peak > 0 {
			drop := (peak - bar.Low) / peak
			if drop > maxDD {
				maxDD = drop
			}
		}
	}
	return maxDD
}
