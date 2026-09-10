package ledger

import (
	"context"
	"testing"
	"time"

	sdkalpaca "github.com/alpacahq/alpaca-trade-api-go/v3/alpaca"
	"github.com/proompteng/lab/services/miel/internal/backtest"
	"github.com/proompteng/lab/services/miel/internal/config"
	"github.com/shopspring/decimal"
	"github.com/tigerbeetle/tigerbeetle-go/pkg/types"
)

type stubTigerBeetle struct {
	transfers []types.Transfer
	err       error
}

func (s *stubTigerBeetle) CreateAccounts([]types.Account) ([]types.AccountEventResult, error) {
	return nil, nil
}
func (s *stubTigerBeetle) CreateTransfers(transfers []types.Transfer) ([]types.TransferEventResult, error) {
	s.transfers = append(s.transfers, transfers...)
	return []types.TransferEventResult{{Result: types.TransferOK}}, s.err
}
func (s *stubTigerBeetle) LookupAccounts([]types.Uint128) ([]types.Account, error)   { return nil, nil }
func (s *stubTigerBeetle) LookupTransfers([]types.Uint128) ([]types.Transfer, error) { return nil, nil }
func (s *stubTigerBeetle) GetAccountTransfers(types.AccountFilter) ([]types.Transfer, error) {
	return nil, nil
}
func (s *stubTigerBeetle) GetAccountBalances(types.AccountFilter) ([]types.AccountBalance, error) {
	return nil, nil
}
func (s *stubTigerBeetle) QueryAccounts(types.QueryFilter) ([]types.Account, error) { return nil, nil }
func (s *stubTigerBeetle) QueryTransfers(types.QueryFilter) ([]types.Transfer, error) {
	return nil, nil
}
func (s *stubTigerBeetle) GetChangeEvents(types.ChangeEventsFilter) ([]types.ChangeEvent, error) {
	return nil, nil
}
func (s *stubTigerBeetle) Nop() error { return nil }
func (s *stubTigerBeetle) Close()     {}

func TestRecordOrderCreatesTransfer(t *testing.T) {
	cfg := config.TigerBeetleConfig{
		Enabled:                 true,
		Ledger:                  99,
		OrderCode:               11,
		BacktestCode:            22,
		AmountScale:             2,
		OrderDebitAccountID:     1001,
		OrderCreditAccountID:    1002,
		BacktestDebitAccountID:  2001,
		BacktestCreditAccountID: 2002,
	}

	tbClient := &stubTigerBeetle{}
	svc := &Service{
		client:         tbClient,
		cfg:            cfg,
		orderDebit:     types.ToUint128(cfg.OrderDebitAccountID),
		orderCredit:    types.ToUint128(cfg.OrderCreditAccountID),
		backtestDebit:  types.ToUint128(cfg.BacktestDebitAccountID),
		backtestCredit: types.ToUint128(cfg.BacktestCreditAccountID),
	}

	notional := decimal.NewFromFloat(123.45)
	order := &sdkalpaca.Order{
		ID:        "order-123",
		Symbol:    "AAPL",
		Side:      sdkalpaca.Buy,
		Notional:  &notional,
		CreatedAt: time.Unix(1710000000, 0),
	}

	if err := svc.RecordOrder(context.Background(), order); err != nil {
		t.Fatalf("RecordOrder returned error: %v", err)
	}

	if len(tbClient.transfers) != 1 {
		t.Fatalf("expected one transfer, got %d", len(tbClient.transfers))
	}
	transfer := tbClient.transfers[0]
	if transfer.Code != cfg.OrderCode {
		t.Fatalf("expected code %d, got %d", cfg.OrderCode, transfer.Code)
	}
	if transfer.DebitAccountID != types.ToUint128(cfg.OrderDebitAccountID) {
		t.Fatalf("unexpected debit account")
	}
}

func TestRecordBacktestHandlesProfitAndLoss(t *testing.T) {
	cfg := config.TigerBeetleConfig{
		Enabled:                 true,
		Ledger:                  77,
		OrderCode:               10,
		BacktestCode:            20,
		AmountScale:             3,
		OrderDebitAccountID:     3001,
		OrderCreditAccountID:    3002,
		BacktestDebitAccountID:  4001,
		BacktestCreditAccountID: 4002,
	}

	tbClient := &stubTigerBeetle{}
	svc := &Service{
		client:         tbClient,
		cfg:            cfg,
		orderDebit:     types.ToUint128(cfg.OrderDebitAccountID),
		orderCredit:    types.ToUint128(cfg.OrderCreditAccountID),
		backtestDebit:  types.ToUint128(cfg.BacktestDebitAccountID),
		backtestCredit: types.ToUint128(cfg.BacktestCreditAccountID),
	}

	result := backtest.Result{Symbol: "AAPL", NetProfit: 12.345, BarCount: 5, CompletedAt: time.Now()}
	if err := svc.RecordBacktest(context.Background(), result); err != nil {
		t.Fatalf("RecordBacktest returned error: %v", err)
	}

	if len(tbClient.transfers) != 1 {
		t.Fatalf("expected single transfer for profit")
	}

	tbClient.transfers = nil
	result.NetProfit = -7.89
	if err := svc.RecordBacktest(context.Background(), result); err != nil {
		t.Fatalf("RecordBacktest loss returned error: %v", err)
	}
	if len(tbClient.transfers) != 1 {
		t.Fatalf("expected single transfer for loss")
	}
	lossTransfer := tbClient.transfers[0]
	if lossTransfer.DebitAccountID != types.ToUint128(cfg.BacktestCreditAccountID) {
		t.Fatalf("expected debit to swap for losses")
	}
}

func TestDecimalToUint128Scaling(t *testing.T) {
	value := decimal.NewFromFloat(12.345)
	scaled, err := decimalToUint128(value, 3)
	if err != nil {
		t.Fatalf("decimalToUint128 returned error: %v", err)
	}
	expected := types.ToUint128(12345)
	if scaled != expected {
		t.Fatalf("expected %v, got %v", expected, scaled)
	}

	if _, err := decimalToUint128(decimal.NewFromFloat(-1), 0); err == nil {
		t.Fatalf("expected error for negative value")
	}

	if _, err := decimalToUint128(decimal.NewFromFloat(1.234), 1); err == nil {
		t.Fatalf("expected error when fractional component remains")
	}
}
