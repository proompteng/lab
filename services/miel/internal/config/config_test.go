package config

import "testing"

func setRequiredSecrets(t *testing.T) {
	t.Helper()
	t.Setenv("ALPACA_API_KEY", "test-key")
	t.Setenv("ALPACA_SECRET_KEY", "test-secret")
}

func TestLoadTigerBeetleDisabled(t *testing.T) {
    setRequiredSecrets(t)

    cfg, err := Load()
    if err != nil {
        t.Fatalf("Load() returned error: %v", err)
    }
    if cfg.TigerBeetle.Enabled {
        t.Fatalf("expected TigerBeetle to be disabled by default")
    }
    if cfg.ServiceName != "miel" {
        t.Fatalf("expected service name default 'miel', got %s", cfg.ServiceName)
    }
    if cfg.OTLPProtocol != "http/protobuf" {
        t.Fatalf("expected default OTLP protocol http/protobuf, got %s", cfg.OTLPProtocol)
    }
}

func TestLoadTigerBeetleEnabledMissingAddresses(t *testing.T) {
	setRequiredSecrets(t)
	t.Setenv("TIGERBEETLE_ENABLED", "true")
	t.Setenv("TIGERBEETLE_CLUSTER_ID", "1")
	t.Setenv("TIGERBEETLE_ORDER_DEBIT_ACCOUNT_ID", "10")
	t.Setenv("TIGERBEETLE_ORDER_CREDIT_ACCOUNT_ID", "11")

	if _, err := Load(); err == nil {
		t.Fatalf("expected error when TIGERBEETLE_ADDRESSES is missing")
	}
}

func TestLoadTigerBeetleEnabledSuccess(t *testing.T) {
    setRequiredSecrets(t)
    t.Setenv("TIGERBEETLE_ENABLED", "true")
    t.Setenv("TIGERBEETLE_ADDRESSES", "127.0.0.1:3000,127.0.0.2:3000")
    t.Setenv("TIGERBEETLE_CLUSTER_ID", "42")
	t.Setenv("TIGERBEETLE_ORDER_DEBIT_ACCOUNT_ID", "1001")
	t.Setenv("TIGERBEETLE_ORDER_CREDIT_ACCOUNT_ID", "1002")
	t.Setenv("TIGERBEETLE_BACKTEST_DEBIT_ACCOUNT_ID", "2001")
	t.Setenv("TIGERBEETLE_BACKTEST_CREDIT_ACCOUNT_ID", "2002")
	t.Setenv("TIGERBEETLE_LEDGER", "321")
    t.Setenv("TIGERBEETLE_ORDER_CODE", "901")
    t.Setenv("TIGERBEETLE_BACKTEST_CODE", "902")
    t.Setenv("TIGERBEETLE_AMOUNT_SCALE", "5")
    t.Setenv("OTEL_SERVICE_NAME", "miel-test")
    t.Setenv("OTEL_EXPORTER_OTLP_PROTOCOL", "grpc")

    cfg, err := Load()
    if err != nil {
        t.Fatalf("Load() returned error: %v", err)
    }

	tb := cfg.TigerBeetle
	if !tb.Enabled {
		t.Fatalf("expected TigerBeetle to be enabled")
	}
	if len(tb.Addresses) != 2 {
		t.Fatalf("expected two addresses, got %d", len(tb.Addresses))
	}
	if tb.ClusterID != 42 {
		t.Fatalf("expected cluster id 42, got %d", tb.ClusterID)
	}
	if tb.Ledger != 321 {
		t.Fatalf("expected ledger 321, got %d", tb.Ledger)
	}
	if tb.OrderCode != 901 || tb.BacktestCode != 902 {
		t.Fatalf("unexpected codes: %+v", tb)
	}
	if tb.AmountScale != 5 {
		t.Fatalf("expected amount scale 5, got %d", tb.AmountScale)
	}
	if tb.OrderDebitAccountID != 1001 || tb.OrderCreditAccountID != 1002 {
		t.Fatalf("unexpected order accounts: %+v", tb)
	}
    if tb.BacktestDebitAccountID != 2001 || tb.BacktestCreditAccountID != 2002 {
        t.Fatalf("unexpected backtest accounts: %+v", tb)
    }
    if cfg.ServiceName != "miel-test" {
        t.Fatalf("expected service name override, got %s", cfg.ServiceName)
    }
    if cfg.OTLPProtocol != "grpc" {
        t.Fatalf("expected OTLP protocol override, got %s", cfg.OTLPProtocol)
    }
}
