package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

const (
	defaultHTTPPort                = "8080"
	defaultTradingBaseURL          = "https://paper-api.alpaca.markets"
	defaultMarketDataURL           = "https://data.alpaca.markets"
	defaultRequestTimeoutSeconds   = 30
	defaultMaxBarsPerBacktest      = 5000
	defaultServiceName             = "miel"
	defaultOTLPProtocol            = "http/protobuf"
	defaultTigerBeetleLedger       = 1
	defaultTigerBeetleOrderCode    = 100
	defaultTigerBeetleBacktestCode = 200
	defaultTigerBeetleAmountScale  = 6
)

// Config captures runtime configuration derived from environment variables.
type Config struct {
	HTTPPort             string
	AlpacaAPIKey         string
	AlpacaAPISecret      string
	AlpacaTradingBaseURL string
	AlpacaMarketDataURL  string
	RequestTimeout       time.Duration
	MaxBarsPerBacktest   int
	ServiceName          string
	OTLPProtocol         string
	TigerBeetle          TigerBeetleConfig
}

// TigerBeetleConfig captures optional TigerBeetle ledger settings.
type TigerBeetleConfig struct {
	Enabled                 bool
	Addresses               []string
	ClusterID               uint64
	Ledger                  uint32
	OrderCode               uint16
	BacktestCode            uint16
	OrderDebitAccountID     uint64
	OrderCreditAccountID    uint64
	BacktestDebitAccountID  uint64
	BacktestCreditAccountID uint64
	AmountScale             int
}

// Load reads configuration from environment variables and applies safe defaults.
func Load() (Config, error) {
	cfg := Config{
		HTTPPort:             getEnv("HTTP_PORT", defaultHTTPPort),
		AlpacaAPIKey:         os.Getenv("ALPACA_API_KEY"),
		AlpacaAPISecret:      os.Getenv("ALPACA_SECRET_KEY"),
		AlpacaTradingBaseURL: getEnv("ALPACA_BASE_URL", defaultTradingBaseURL),
		AlpacaMarketDataURL:  getEnv("ALPACA_DATA_BASE_URL", defaultMarketDataURL),
		RequestTimeout:       time.Duration(getEnvAsInt("ALPACA_REQUEST_TIMEOUT_SECONDS", defaultRequestTimeoutSeconds)) * time.Second,
		MaxBarsPerBacktest:   getEnvAsInt("BACKTEST_MAX_BARS", defaultMaxBarsPerBacktest),
		ServiceName:          getEnv("OTEL_SERVICE_NAME", defaultServiceName),
		OTLPProtocol:         getEnv("OTEL_EXPORTER_OTLP_PROTOCOL", defaultOTLPProtocol),
	}

	tbCfg, err := loadTigerBeetleConfig()
	if err != nil {
		return Config{}, err
	}
	cfg.TigerBeetle = tbCfg

	if cfg.RequestTimeout <= 0 {
		return Config{}, fmt.Errorf("invalid ALPACA_REQUEST_TIMEOUT_SECONDS; must be positive")
	}

	if cfg.MaxBarsPerBacktest <= 0 {
		return Config{}, fmt.Errorf("invalid BACKTEST_MAX_BARS; must be positive")
	}

	if cfg.AlpacaAPIKey == "" {
		return Config{}, fmt.Errorf("ALPACA_API_KEY is required")
	}

	if cfg.AlpacaAPISecret == "" {
		return Config{}, fmt.Errorf("ALPACA_SECRET_KEY is required")
	}

	return cfg, nil
}

func loadTigerBeetleConfig() (TigerBeetleConfig, error) {
	enabled := getEnvAsBool("TIGERBEETLE_ENABLED", false)
	cfg := TigerBeetleConfig{Enabled: enabled, AmountScale: defaultTigerBeetleAmountScale}

	if !enabled {
		return cfg, nil
	}

	addresses := splitAndTrim(os.Getenv("TIGERBEETLE_ADDRESSES"), ",")
	if len(addresses) == 0 {
		return TigerBeetleConfig{}, fmt.Errorf("TIGERBEETLE_ADDRESSES is required when TigerBeetle integration is enabled")
	}

	clusterID, ok, err := getEnvAsUint64("TIGERBEETLE_CLUSTER_ID")
	if err != nil {
		return TigerBeetleConfig{}, fmt.Errorf("invalid TIGERBEETLE_CLUSTER_ID: %w", err)
	}
	if !ok {
		return TigerBeetleConfig{}, fmt.Errorf("TIGERBEETLE_CLUSTER_ID is required when TigerBeetle integration is enabled")
	}

	ledger := uint32(getEnvAsInt("TIGERBEETLE_LEDGER", defaultTigerBeetleLedger))
	if ledger == 0 {
		return TigerBeetleConfig{}, fmt.Errorf("TIGERBEETLE_LEDGER must be positive")
	}

	orderCode := uint16(getEnvAsInt("TIGERBEETLE_ORDER_CODE", defaultTigerBeetleOrderCode))
	backtestCode := uint16(getEnvAsInt("TIGERBEETLE_BACKTEST_CODE", defaultTigerBeetleBacktestCode))

	amountScale := getEnvAsInt("TIGERBEETLE_AMOUNT_SCALE", defaultTigerBeetleAmountScale)
	if amountScale < 0 {
		return TigerBeetleConfig{}, fmt.Errorf("TIGERBEETLE_AMOUNT_SCALE must be non-negative")
	}

	orderDebit, present, err := getEnvAsUint64("TIGERBEETLE_ORDER_DEBIT_ACCOUNT_ID")
	if err != nil {
		return TigerBeetleConfig{}, fmt.Errorf("invalid TIGERBEETLE_ORDER_DEBIT_ACCOUNT_ID: %w", err)
	}
	if !present {
		return TigerBeetleConfig{}, fmt.Errorf("TIGERBEETLE_ORDER_DEBIT_ACCOUNT_ID is required when TigerBeetle integration is enabled")
	}

	orderCredit, present, err := getEnvAsUint64("TIGERBEETLE_ORDER_CREDIT_ACCOUNT_ID")
	if err != nil {
		return TigerBeetleConfig{}, fmt.Errorf("invalid TIGERBEETLE_ORDER_CREDIT_ACCOUNT_ID: %w", err)
	}
	if !present {
		return TigerBeetleConfig{}, fmt.Errorf("TIGERBEETLE_ORDER_CREDIT_ACCOUNT_ID is required when TigerBeetle integration is enabled")
	}

	backtestDebit, present, err := getEnvAsUint64("TIGERBEETLE_BACKTEST_DEBIT_ACCOUNT_ID")
	if err != nil {
		return TigerBeetleConfig{}, fmt.Errorf("invalid TIGERBEETLE_BACKTEST_DEBIT_ACCOUNT_ID: %w", err)
	}
	if !present {
		backtestDebit = orderDebit
	}

	backtestCredit, present, err := getEnvAsUint64("TIGERBEETLE_BACKTEST_CREDIT_ACCOUNT_ID")
	if err != nil {
		return TigerBeetleConfig{}, fmt.Errorf("invalid TIGERBEETLE_BACKTEST_CREDIT_ACCOUNT_ID: %w", err)
	}
	if !present {
		backtestCredit = orderCredit
	}

	cfg.Addresses = addresses
	cfg.ClusterID = clusterID
	cfg.Ledger = ledger
	cfg.OrderCode = orderCode
	cfg.BacktestCode = backtestCode
	cfg.AmountScale = amountScale
	cfg.OrderDebitAccountID = orderDebit
	cfg.OrderCreditAccountID = orderCredit
	cfg.BacktestDebitAccountID = backtestDebit
	cfg.BacktestCreditAccountID = backtestCredit

	return cfg, nil
}

func getEnv(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}

func getEnvAsInt(key string, fallback int) int {
	if value := os.Getenv(key); value != "" {
		parsed, err := strconv.Atoi(value)
		if err == nil {
			return parsed
		}
	}
	return fallback
}

func getEnvAsBool(key string, fallback bool) bool {
	if value := os.Getenv(key); value != "" {
		parsed, err := strconv.ParseBool(value)
		if err == nil {
			return parsed
		}
	}
	return fallback
}

func getEnvAsUint64(key string) (uint64, bool, error) {
	value := os.Getenv(key)
	if value == "" {
		return 0, false, nil
	}
	parsed, err := strconv.ParseUint(value, 10, 64)
	if err != nil {
		return 0, false, err
	}
	return parsed, true, nil
}

func splitAndTrim(raw string, sep string) []string {
	if raw == "" {
		return nil
	}
	parts := strings.Split(raw, sep)
	result := make([]string, 0, len(parts))
	for _, part := range parts {
		trimmed := strings.TrimSpace(part)
		if trimmed != "" {
			result = append(result, trimmed)
		}
	}
	return result
}
