package trading

import (
	"context"
	"fmt"
	"log/slog"
	"strings"

	sdkalpaca "github.com/alpacahq/alpaca-trade-api-go/v3/alpaca"
	"github.com/proompteng/lab/services/miel/internal/alpaca"
	"github.com/proompteng/lab/services/miel/internal/ledger"
)

// Service exposes trading-centric operations powered by Alpaca.
type Service struct {
	client *alpaca.Client
	ledger ledger.Recorder
}

// NewService wires an Alpaca client into the trading service.
func NewService(client *alpaca.Client, recorder ledger.Recorder) *Service {
	return &Service{client: client, ledger: recorder}
}

// SubmitMarketOrder is a convenience wrapper that validates user input before
// delegating to the Alpaca client.
func (s *Service) SubmitMarketOrder(ctx context.Context, symbol string, qty float64, side string, tif string, extended bool) (*sdkalpaca.Order, error) {
	alpacaSide, err := parseSide(side)
	if err != nil {
		return nil, err
	}

	alpacaTIF := parseTimeInForce(tif)

	order, err := s.client.PlaceMarketOrder(ctx, alpaca.MarketOrderInput{
		Symbol:        strings.ToUpper(symbol),
		Quantity:      qty,
		Side:          alpacaSide,
		TimeInForce:   alpacaTIF,
		ExtendedHours: extended,
	})
	if err != nil {
		return nil, err
	}

	if s.ledger != nil {
		if err := s.ledger.RecordOrder(ctx, order); err != nil {
			// The broker has already accepted the order. Returning an error here invites
			// callers to retry and submit a duplicate live order, so surface the
			// accounting failure operationally while preserving the broker result.
			slog.ErrorContext(ctx, "failed to record accepted broker order in ledger", "order_id", order.ID, "error", err)
		}
	}

	return order, nil
}

func parseSide(side string) (sdkalpaca.Side, error) {
	switch strings.ToLower(strings.TrimSpace(side)) {
	case "buy", "long":
		return sdkalpaca.Buy, nil
	case "sell", "short":
		return sdkalpaca.Sell, nil
	default:
		return "", fmt.Errorf("invalid side: %s", side)
	}
}

func parseTimeInForce(tif string) sdkalpaca.TimeInForce {
	switch strings.ToUpper(strings.TrimSpace(tif)) {
	case "GTC":
		return sdkalpaca.GTC
	case "IOC":
		return sdkalpaca.IOC
	case "FOK":
		return sdkalpaca.FOK
	case "OPG":
		return sdkalpaca.OPG
	default:
		return sdkalpaca.Day
	}
}
