package server

import (
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/proompteng/lab/services/miel/internal/alpaca"
	"github.com/proompteng/lab/services/miel/internal/backtest"
	"github.com/proompteng/lab/services/miel/internal/ledger"
	"github.com/proompteng/lab/services/miel/internal/trading"
	"go.opentelemetry.io/contrib/instrumentation/github.com/gin-gonic/gin/otelgin"
)

// Server wires HTTP routes to business services.
type Server struct {
	router   *gin.Engine
	trading  *trading.Service
	backtest *backtest.Engine
	ledger   ledger.Recorder
}

// New constructs a Server with all dependencies pre-wired.
func New(serviceName string, tradingSvc *trading.Service, backtestEngine *backtest.Engine, recorder ledger.Recorder) *Server {
	gin.SetMode(gin.ReleaseMode)
	r := gin.New()
	r.Use(gin.Recovery())
	r.Use(otelgin.Middleware(serviceName))

	s := &Server{
		router:   r,
		trading:  tradingSvc,
		backtest: backtestEngine,
		ledger:   recorder,
	}

	s.registerRoutes()
	return s
}

// Router exposes the underlying Gin engine for HTTP serving.
func (s *Server) Router() *gin.Engine { return s.router }

func (s *Server) registerRoutes() {
	s.router.GET("/healthz", s.handleHealth)

	api := s.router.Group("/api/v1")
	{
		api.POST("/orders/market", s.handleMarketOrder)
		api.POST("/backtests", s.handleBacktest)
	}
}

func (s *Server) handleHealth(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{"status": "ok", "service": "miel"})
}

type marketOrderRequest struct {
	Symbol        string  `json:"symbol" binding:"required"`
	Quantity      float64 `json:"quantity" binding:"required"`
	Side          string  `json:"side" binding:"required"`
	TimeInForce   string  `json:"time_in_force"`
	ExtendedHours bool    `json:"extended_hours"`
}

func (s *Server) handleMarketOrder(c *gin.Context) {
	var req marketOrderRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	order, err := s.trading.SubmitMarketOrder(c.Request.Context(), req.Symbol, req.Quantity, req.Side, req.TimeInForce, req.ExtendedHours)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, order)
}

type backtestRequest struct {
	Symbol     string  `json:"symbol" binding:"required"`
	TimeFrame  string  `json:"timeframe"`
	Start      string  `json:"start"`
	End        string  `json:"end"`
	Quantity   float64 `json:"quantity"`
	Strategy   string  `json:"strategy"`
	FastPeriod int     `json:"fast_period"`
	SlowPeriod int     `json:"slow_period"`
}

func (s *Server) handleBacktest(c *gin.Context) {
	var req backtestRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	tf, err := alpaca.ParseTimeFrame(defaultTimeframe(req.TimeFrame))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	start, err := parseTime(req.Start)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	end, err := parseTime(req.End)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	strategy := toStrategyKind(req.Strategy)

	result, err := s.backtest.Run(c.Request.Context(), backtest.RunRequest{
		Symbol:     req.Symbol,
		TimeFrame:  tf,
		Start:      start,
		End:        end,
		Quantity:   req.Quantity,
		Strategy:   strategy,
		FastPeriod: req.FastPeriod,
		SlowPeriod: req.SlowPeriod,
	})
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	if s.ledger != nil {
		if err := s.ledger.RecordBacktest(c.Request.Context(), result); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
	}

	c.JSON(http.StatusOK, result)
}

func defaultTimeframe(input string) string {
	if strings.TrimSpace(input) == "" {
		return "1Day"
	}
	return input
}

func parseTime(raw string) (time.Time, error) {
	if strings.TrimSpace(raw) == "" {
		return time.Time{}, nil
	}
	t, err := time.Parse(time.RFC3339, raw)
	if err != nil {
		return time.Time{}, err
	}
	return t, nil
}

func toStrategyKind(raw string) backtest.StrategyKind {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "sma-cross", "sma", "moving-average":
		return backtest.StrategySMACross
	default:
		return backtest.StrategyBuyAndHold
	}
}
