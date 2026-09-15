package ledger

import (
	"context"
	"crypto/sha256"
	"fmt"
	"math/big"
	"time"

	sdkalpaca "github.com/alpacahq/alpaca-trade-api-go/v3/alpaca"
	"github.com/shopspring/decimal"
	tb "github.com/tigerbeetle/tigerbeetle-go"
	"github.com/tigerbeetle/tigerbeetle-go/pkg/types"

	"github.com/proompteng/lab/services/miel/internal/backtest"
	"github.com/proompteng/lab/services/miel/internal/config"
)

// Recorder captures ledger events for downstream reconciliation.
type Recorder interface {
	RecordOrder(ctx context.Context, order *sdkalpaca.Order) error
	RecordBacktest(ctx context.Context, result backtest.Result) error
	Close() error
}

// New constructs a TigerBeetle-backed Recorder or a no-op recorder when disabled.
func New(cfg config.TigerBeetleConfig) (Recorder, error) {
	if !cfg.Enabled {
		return noopRecorder{}, nil
	}

	if len(cfg.Addresses) == 0 {
		return nil, fmt.Errorf("tigerbeetle addresses must not be empty when enabled")
	}

	client, err := tb.NewClient(types.ToUint128(cfg.ClusterID), cfg.Addresses)
	if err != nil {
		return nil, fmt.Errorf("tigerbeetle: new client: %w", err)
	}

	svc := &Service{
		client:         client,
		cfg:            cfg,
		orderDebit:     types.ToUint128(cfg.OrderDebitAccountID),
		orderCredit:    types.ToUint128(cfg.OrderCreditAccountID),
		backtestDebit:  types.ToUint128(cfg.BacktestDebitAccountID),
		backtestCredit: types.ToUint128(cfg.BacktestCreditAccountID),
	}

	return svc, nil
}

// Service implements Recorder using TigerBeetle transfers.
type Service struct {
	client         tb.Client
	cfg            config.TigerBeetleConfig
	orderDebit     types.Uint128
	orderCredit    types.Uint128
	backtestDebit  types.Uint128
	backtestCredit types.Uint128
}

// Close releases underlying TigerBeetle client resources.
func (s *Service) Close() error {
	if s == nil || s.client == nil {
		return nil
	}
	s.client.Close()
	return nil
}

// RecordOrder captures an Alpaca order as a ledger transfer.
func (s *Service) RecordOrder(ctx context.Context, order *sdkalpaca.Order) error {
	if s == nil || s.client == nil {
		return nil
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if order == nil {
		return fmt.Errorf("order must not be nil")
	}

	amount := s.deriveOrderAmount(order)
	if amount.IsZero() {
		return nil
	}

	amount128, err := decimalToUint128(amount, s.cfg.AmountScale)
	if err != nil {
		return fmt.Errorf("order amount conversion failed: %w", err)
	}
	if isZeroUint128(amount128) {
		return nil
	}

	debit := s.orderDebit
	credit := s.orderCredit
	if order.Side == sdkalpaca.Sell {
		debit, credit = credit, debit
	}

	transfer := types.Transfer{
		ID:              types.ID(),
		DebitAccountID:  debit,
		CreditAccountID: credit,
		Amount:          amount128,
		Ledger:          s.cfg.Ledger,
		Code:            s.cfg.OrderCode,
		Timestamp:       uint64(time.Now().UnixMicro()),
		UserData128:     hashString(order.ID),
		UserData64:      uint64(order.CreatedAt.Unix()),
	}

	return s.submitTransfers(ctx, []types.Transfer{transfer})
}

// RecordBacktest records aggregate P&L for a backtest run.
func (s *Service) RecordBacktest(ctx context.Context, result backtest.Result) error {
	if s == nil || s.client == nil {
		return nil
	}
	if err := ctx.Err(); err != nil {
		return err
	}

	profit := decimal.NewFromFloat(result.NetProfit)
	if profit.IsZero() {
		return nil
	}

	amount128, err := decimalToUint128(profit.Abs(), s.cfg.AmountScale)
	if err != nil {
		return fmt.Errorf("backtest amount conversion failed: %w", err)
	}
	if isZeroUint128(amount128) {
		return nil
	}

	debit := s.backtestDebit
	credit := s.backtestCredit
	if profit.Sign() < 0 {
		debit, credit = credit, debit
	}

	transfer := types.Transfer{
		ID:              types.ID(),
		DebitAccountID:  debit,
		CreditAccountID: credit,
		Amount:          amount128,
		Ledger:          s.cfg.Ledger,
		Code:            s.cfg.BacktestCode,
		Timestamp:       uint64(time.Now().UnixMicro()),
		UserData128:     hashString(fmt.Sprintf("%s|%s|%d", result.Symbol, result.Strategy, result.CompletedAt.UnixNano())),
		UserData64:      uint64(result.BarCount),
	}

	return s.submitTransfers(ctx, []types.Transfer{transfer})
}

func (s *Service) submitTransfers(ctx context.Context, transfers []types.Transfer) error {
	if len(transfers) == 0 {
		return nil
	}
	if err := ctx.Err(); err != nil {
		return err
	}

	results, err := s.client.CreateTransfers(transfers)
	if err != nil {
		return err
	}
	for _, res := range results {
		if res.Result != types.TransferOK {
			return fmt.Errorf("tigerbeetle transfer index %d failed: %s", res.Index, res.Result)
		}
	}
	return nil
}

func (s *Service) deriveOrderAmount(order *sdkalpaca.Order) decimal.Decimal {
	if order == nil {
		return decimal.Zero
	}
	if order.Notional != nil && !order.Notional.IsZero() {
		return order.Notional.Abs()
	}

	if order.FilledAvgPrice != nil && !order.FilledAvgPrice.IsZero() && order.FilledQty.Cmp(decimal.Zero) > 0 {
		return order.FilledAvgPrice.Mul(order.FilledQty.Abs())
	}

	if order.Qty != nil && !order.Qty.IsZero() {
		qty := order.Qty.Abs()
		if order.FilledAvgPrice != nil && !order.FilledAvgPrice.IsZero() {
			return order.FilledAvgPrice.Mul(qty)
		}
		if order.LimitPrice != nil && !order.LimitPrice.IsZero() {
			return order.LimitPrice.Abs().Mul(qty)
		}
		if order.StopPrice != nil && !order.StopPrice.IsZero() {
			return order.StopPrice.Abs().Mul(qty)
		}
	}

	return decimal.Zero
}

func decimalToUint128(value decimal.Decimal, scale int) (types.Uint128, error) {
	if value.IsZero() {
		return types.Uint128{}, nil
	}

	scaled := value.Shift(int32(scale))
	if scaled.Exponent() < 0 {
		return types.Uint128{}, fmt.Errorf("value retains fractional component after scaling")
	}

	coeff := new(big.Int).Set(scaled.Coefficient())
	if scaled.Exponent() > 0 {
		multiplier := new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(scaled.Exponent())), nil)
		coeff.Mul(coeff, multiplier)
	}

	if coeff.Sign() < 0 {
		return types.Uint128{}, fmt.Errorf("negative amount not supported")
	}
	if coeff.BitLen() > 128 {
		return types.Uint128{}, fmt.Errorf("amount exceeds 128-bit capacity")
	}

	return types.BigIntToUint128(*coeff), nil
}

func hashString(input string) types.Uint128 {
	if input == "" {
		return types.Uint128{}
	}
	sum := sha256.Sum256([]byte(input))
	var buf [16]byte
	copy(buf[:], sum[:])
	return types.BytesToUint128(buf)
}

func isZeroUint128(value types.Uint128) bool {
	return value == (types.Uint128{})
}

// noopRecorder implements Recorder but performs no work.
type noopRecorder struct{}

func (noopRecorder) RecordOrder(context.Context, *sdkalpaca.Order) error {
	return nil
}

func (noopRecorder) RecordBacktest(context.Context, backtest.Result) error {
	return nil
}

func (noopRecorder) Close() error { return nil }
