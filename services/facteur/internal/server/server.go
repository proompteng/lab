package server

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/gofiber/contrib/otelfiber"
	"github.com/gofiber/fiber/v2"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/trace"
	"google.golang.org/protobuf/proto"

	"github.com/proompteng/lab/services/facteur/internal/bridge"
	"github.com/proompteng/lab/services/facteur/internal/consumer"
	"github.com/proompteng/lab/services/facteur/internal/facteurpb"
	"github.com/proompteng/lab/services/facteur/internal/froussardpb"
	"github.com/proompteng/lab/services/facteur/internal/orchestrator"
	"github.com/proompteng/lab/services/facteur/internal/session"
	"github.com/proompteng/lab/services/facteur/internal/telemetry"
)

var (
	buildVersion = "dev"
	buildCommit  = "unknown"
)

func init() {
	if v := os.Getenv("FACTEUR_VERSION"); v != "" {
		buildVersion = v
	}
	if c := os.Getenv("FACTEUR_COMMIT"); c != "" {
		buildCommit = c
	}
}

const (
	defaultListenAddress = ":8080"
	shutdownTimeout      = 10 * time.Second
)

// Options configures the HTTP server lifecycle.
type Options struct {
	ListenAddress    string
	Prefork          bool
	Dispatcher       bridge.Dispatcher
	Store            session.Store
	SessionTTL       time.Duration
	CodexImplementer CodexImplementerOptions
}

// CodexImplementer defines the implementation orchestration surface required for Codex tasks.
type CodexImplementer interface {
	Implement(ctx context.Context, task *froussardpb.CodexTask) (orchestrator.Result, error)
}

// CodexImplementerOptions wires the implementation orchestrator into the HTTP layer.
type CodexImplementerOptions struct {
	Enabled     bool
	Implementer CodexImplementer
}

// Server wraps a Fiber application with lifecycle helpers.
type Server struct {
	app  *fiber.App
	opts Options
}

// New constructs a Server using the high-performance Fiber framework.
func New(opts Options) (*Server, error) {
	if opts.ListenAddress == "" {
		opts.ListenAddress = defaultListenAddress
	}
	if opts.SessionTTL <= 0 {
		opts.SessionTTL = consumer.DefaultSessionTTL
	}
	app := fiber.New(fiber.Config{
		Prefork:               opts.Prefork,
		DisableStartupMessage: true,
		AppName:               "facteur",
		ReadTimeout:           15 * time.Second,
		WriteTimeout:          15 * time.Second,
		IdleTimeout:           60 * time.Second,
	})

	app.Use(otelfiber.Middleware())

	registerRoutes(app, opts)

	return &Server{
		app:  app,
		opts: opts,
	}, nil
}

// App exposes the underlying Fiber application for advanced routing.
func (s *Server) App() *fiber.App {
	return s.app
}

// Run starts the Fiber server and blocks until the context is cancelled or an error occurs.
func (s *Server) Run(ctx context.Context) error {
	errCh := make(chan error, 1)

	go func() {
		if err := s.app.Listen(s.opts.ListenAddress); err != nil {
			errCh <- err
			return
		}
		errCh <- nil
	}()

	select {
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
		defer cancel()

		if err := s.app.ShutdownWithContext(shutdownCtx); err != nil {
			return fmt.Errorf("shutdown server: %w", err)
		}

		// Drain the listener outcome to avoid leaking the goroutine.
		if listenErr := <-errCh; !isServerClosedError(listenErr) {
			return fmt.Errorf("listen after shutdown: %w", listenErr)
		}

		return nil
	case err := <-errCh:
		if isServerClosedError(err) {
			return nil
		}
		return fmt.Errorf("start server: %w", err)
	}
}

func isServerClosedError(err error) bool {
	if err == nil {
		return true
	}
	if errors.Is(err, context.Canceled) {
		return true
	}
	if errors.Is(err, net.ErrClosed) {
		return true
	}
	if errors.Is(err, http.ErrServerClosed) {
		return true
	}
	msg := err.Error()
	return msg == "" || strings.Contains(strings.ToLower(msg), "server closed")
}

func registerRoutes(app *fiber.App, opts Options) {
	app.Get("/healthz", func(c *fiber.Ctx) error {
		return c.JSON(fiber.Map{"status": "ok"})
	})

	app.Get("/readyz", func(c *fiber.Ctx) error {
		return c.JSON(fiber.Map{"status": "ready"})
	})

	app.All("/", func(c *fiber.Ctx) error {
		return c.JSON(fiber.Map{
			"service": "facteur",
			"status":  "ok",
			"version": buildVersion,
			"commit":  buildCommit,
		})
	})

	app.Post("/events", func(c *fiber.Ctx) error {
		if opts.Dispatcher == nil {
			return c.Status(fiber.StatusServiceUnavailable).JSON(fiber.Map{"error": "dispatcher unavailable"})
		}

		body := c.Body()
		if len(body) == 0 {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "empty payload"})
		}

		var event facteurpb.CommandEvent
		if err := proto.Unmarshal(body, &event); err != nil {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid payload", "details": err.Error()})
		}

		if event.GetCommand() == "" {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "missing command"})
		}

		userID := ""
		if user := event.GetUser(); user != nil {
			userID = user.GetId()
		} else if member := event.GetMember(); member != nil {
			userID = member.GetId()
		}

		log.Printf(
			"event received: command=%s user=%s correlation=%s trace=%s",
			event.GetCommand(),
			emptyIfNone(userID),
			emptyIfNone(event.GetCorrelationId()),
			emptyIfNone(event.GetTraceId()),
		)

		ctx := c.UserContext()
		if ctx == nil {
			ctx = context.Background()
		}

		result, err := consumer.ProcessEvent(ctx, &event, opts.Dispatcher, opts.Store, opts.SessionTTL)
		if err != nil {
			log.Printf("event dispatch failed: %v", err)
			return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "dispatch failed"})
		}

		log.Printf("event dispatch succeeded: command=%s workflow=%s namespace=%s correlation=%s trace=%s", event.GetCommand(), result.WorkflowName, result.Namespace, result.CorrelationID, event.GetTraceId())

		return c.Status(fiber.StatusAccepted).JSON(fiber.Map{
			"workflowName":  result.WorkflowName,
			"namespace":     result.Namespace,
			"correlationId": result.CorrelationID,
		})
	})

	app.Post("/codex/tasks", func(c *fiber.Ctx) error {
		body := c.Body()
		if len(body) == 0 {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "empty payload"})
		}

		var task froussardpb.CodexTask
		if err := proto.Unmarshal(body, &task); err != nil {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid payload", "details": err.Error()})
		}

		log.Printf(
			"codex task received: stage=%s repo=%s issue=%d head=%s delivery=%s",
			task.GetStage().String(),
			task.GetRepository(),
			task.GetIssueNumber(),
			task.GetHead(),
			task.GetDeliveryId(),
		)

		ctx := c.UserContext()
		if ctx == nil {
			ctx = context.Background()
		}

		ctx, span := telemetry.Tracer().Start(ctx, "facteur.server.codex_tasks", trace.WithSpanKind(trace.SpanKindServer))
		defer span.End()

		span.SetAttributes(
			attribute.String("codex.stage", strings.ToLower(strings.TrimPrefix(task.GetStage().String(), "CODEX_TASK_STAGE_"))),
			attribute.String("codex.repository", task.GetRepository()),
			attribute.Int64("codex.issue_number", task.GetIssueNumber()),
			attribute.String("codex.delivery_id", task.GetDeliveryId()),
		)

		if task.GetStage() != froussardpb.CodexTaskStage_CODEX_TASK_STAGE_IMPLEMENTATION {
			span.SetStatus(codes.Error, "unsupported codex stage")
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "unsupported codex stage"})
		}

		if !opts.CodexImplementer.Enabled || opts.CodexImplementer.Implementer == nil {
			span.SetStatus(codes.Error, "implementation orchestrator disabled")
			return c.Status(fiber.StatusServiceUnavailable).JSON(fiber.Map{"error": "implementation orchestrator disabled"})
		}

		result, err := opts.CodexImplementer.Implementer.Implement(ctx, &task)
		if err != nil {
			span.RecordError(err)
			span.SetStatus(codes.Error, "implementation orchestrator failed")
			log.Printf(
				"codex implementation orchestrator failed: repo=%s issue=%d delivery=%s err=%v",
				task.GetRepository(),
				task.GetIssueNumber(),
				task.GetDeliveryId(),
				err,
			)
			return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
				"error":   "implementation orchestrator failed",
				"details": err.Error(),
			})
		}

		span.SetAttributes(
			attribute.String("facteur.codex.namespace", result.Namespace),
			attribute.String("facteur.codex.workflow", result.WorkflowName),
			attribute.Bool("facteur.codex.duplicate", result.Duplicate),
		)
		span.SetStatus(codes.Ok, "implementation orchestrator dispatched")

		log.Printf(
			"codex implementation orchestrated: repo=%s issue=%d delivery=%s workflow=%s namespace=%s duplicate=%t",
			task.GetRepository(),
			task.GetIssueNumber(),
			task.GetDeliveryId(),
			result.WorkflowName,
			result.Namespace,
			result.Duplicate,
		)

		return c.Status(fiber.StatusAccepted).JSON(fiber.Map{
			"stage":        "implementation",
			"namespace":    result.Namespace,
			"workflowName": result.WorkflowName,
			"submittedAt":  result.SubmittedAt.UTC().Format(time.RFC3339),
			"duplicate":    result.Duplicate,
		})
	})
}

// RunWithLogger is a helper that logs fatal errors from Run.
func RunWithLogger(ctx context.Context, srv *Server) error {
	if err := srv.Run(ctx); err != nil {
		log.Printf("facteur server exited with error: %v", err)
		return err
	}
	return nil
}

func emptyIfNone(value string) string {
	if value == "" {
		return "(none)"
	}
	return value
}
