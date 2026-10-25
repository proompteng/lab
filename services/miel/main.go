package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/proompteng/lab/services/miel/internal/alpaca"
	"github.com/proompteng/lab/services/miel/internal/backtest"
	"github.com/proompteng/lab/services/miel/internal/config"
	"github.com/proompteng/lab/services/miel/internal/ledger"
	"github.com/proompteng/lab/services/miel/internal/server"
	"github.com/proompteng/lab/services/miel/internal/telemetry"
	"github.com/proompteng/lab/services/miel/internal/trading"
)

func main() {
	config.LoadDotEnv()

	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("failed to load config: %v", err)
	}

	ctx := context.Background()

	teleShutdown, err := telemetry.Setup(ctx, cfg.ServiceName, cfg.OTLPProtocol)
	if err != nil {
		log.Fatalf("failed to initialize telemetry: %v", err)
	}
	defer func() {
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := telemetry.ForceFlush(shutdownCtx); err != nil {
			log.Printf("telemetry force flush error: %v", err)
		}
		if err := teleShutdown(shutdownCtx); err != nil {
			log.Printf("telemetry shutdown error: %v", err)
		}
	}()

	alpacaClient := alpaca.NewClient(cfg)
	ledgerRecorder, err := ledger.New(cfg.TigerBeetle)
	if err != nil {
		log.Fatalf("failed to initialize tigerbeetle: %v", err)
	}
	defer func() {
		if err := ledgerRecorder.Close(); err != nil {
			log.Printf("tigerbeetle close error: %v", err)
		}
	}()

	tradingSvc := trading.NewService(alpacaClient, ledgerRecorder)
	backtestEngine := backtest.NewEngine(alpacaClient, cfg.MaxBarsPerBacktest)

	httpServer := &http.Server{
		Addr:              normalizeAddr(cfg.HTTPPort),
		Handler:           server.New(cfg.ServiceName, tradingSvc, backtestEngine, ledgerRecorder).Router(),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       2 * time.Minute,
	}

	go func() {
		log.Printf("miel listening on %s", httpServer.Addr)
		if err := httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("http server failed: %v", err)
		}
	}()

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)

	sig := <-sigCh
	log.Printf("received signal %s, shutting down", sig)

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	if err := httpServer.Shutdown(ctx); err != nil {
		log.Printf("graceful shutdown failed: %v", err)
	}
}

func normalizeAddr(port string) string {
	if strings.HasPrefix(port, ":") {
		return port
	}
	return ":" + port
}
