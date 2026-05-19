package discord

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/proompteng/lab/services/facteur/internal/bridge"
	"github.com/proompteng/lab/services/facteur/internal/session"
)

const (
	CommandPlan   = "plan"
	CommandStatus = "status"
)

var (
	ErrUnknownCommand = errors.New("discord: unknown command")
	ErrForbidden      = errors.New("discord: insufficient permissions")
)

// Interaction models the minimal data facteur needs from a Discord command invocation.
type Interaction struct {
	Name    string
	UserID  string
	UserTag string
	Roles   []string
	Options map[string]string
}

// Response contains the message that should be sent back to Discord.
type Response struct {
	Content   string
	Ephemeral bool
}

// Handler routes commands to the bridge dispatcher while enforcing role checks.
type Handler struct {
	roleMap    map[string][]string
	dispatcher bridge.Dispatcher
	store      session.Store
}

// NewHandler constructs a Handler with a role map copy for immutability.
func NewHandler(roleMap map[string][]string, dispatcher bridge.Dispatcher, store session.Store) (*Handler, error) {
	if dispatcher == nil {
		return nil, errors.New("discord: dispatcher is required")
	}

	copyMap := make(map[string][]string, len(roleMap))
	for key, value := range roleMap {
		copyMap[key] = slices.Clone(value)
	}

	return &Handler{roleMap: copyMap, dispatcher: dispatcher, store: store}, nil
}

// Handle executes the named command and returns the Discord response payload.
func (h *Handler) Handle(ctx context.Context, interaction Interaction) (Response, error) {
	if err := h.authorise(interaction); err != nil {
		return Response{Content: fmt.Sprintf("You do not have permission to run `%s`.", interaction.Name), Ephemeral: true}, err
	}

	switch strings.ToLower(interaction.Name) {
	case CommandPlan:
		return h.handlePlan(ctx, interaction)
	case CommandStatus:
		return h.handleStatus(ctx, interaction)
	default:
		return Response{Content: fmt.Sprintf("Unknown command `%s`.", interaction.Name), Ephemeral: true}, ErrUnknownCommand
	}
}

func (h *Handler) authorise(interaction Interaction) error {
	allowed, ok := h.roleMap[interaction.Name]
	if !ok {
		return nil
	}

	for _, role := range interaction.Roles {
		if contains(allowed, role) {
			return nil
		}
	}

	return ErrForbidden
}

func (h *Handler) handlePlan(ctx context.Context, interaction Interaction) (Response, error) {
	result, err := h.dispatcher.Dispatch(ctx, bridge.DispatchRequest{
		Command: interaction.Name,
		UserID:  interaction.UserID,
		Options: interaction.Options,
	})
	if err != nil {
		return Response{}, err
	}

	if h.store != nil && interaction.UserID != "" {
		payload, marshalErr := json.Marshal(result)
		if marshalErr != nil {
			return Response{}, fmt.Errorf("discord: marshal dispatch result: %w", marshalErr)
		}
		if err := h.store.Set(ctx, session.DispatchKey(interaction.UserID), payload, 15*time.Minute); err != nil {
			return Response{}, fmt.Errorf("discord: persist dispatch result: %w", err)
		}
	}

	msg := result.Message
	if msg == "" {
		name := result.AgentRunName
		if name == "" {
			name = result.WorkflowName
		}
		msg = fmt.Sprintf("AgentRun `%s` submitted in namespace `%s`.", name, result.Namespace)
	}

	return Response{Content: msg, Ephemeral: true}, nil
}

func (h *Handler) handleStatus(ctx context.Context, interaction Interaction) (Response, error) {
	report, err := h.dispatcher.Status(ctx)
	if err != nil {
		return Response{}, err
	}

	msg := report.Message
	if msg == "" {
		name := report.AgentName
		if name == "" {
			name = report.WorkflowTemplate
		}
		msg = fmt.Sprintf("AgentRun dispatch target `%s` in namespace `%s` is %s.", name, report.Namespace, statusText(report.Ready))
	}

	if h.store != nil && interaction.UserID != "" {
		payload, serr := h.store.Get(ctx, session.DispatchKey(interaction.UserID))
		if serr == nil {
			var last bridge.DispatchResult
			if err := json.Unmarshal(payload, &last); err == nil && last.CorrelationID != "" {
				msg += fmt.Sprintf(" Last request correlation: `%s`.", last.CorrelationID)
			}
		} else if !errors.Is(serr, session.ErrNotFound) {
			return Response{}, fmt.Errorf("discord: load dispatch session: %w", serr)
		}
	}

	return Response{Content: msg, Ephemeral: true}, nil
}

func statusText(ready bool) string {
	if ready {
		return "ready"
	}
	return "currently unavailable"
}

func contains(values []string, candidate string) bool {
	for _, value := range values {
		if value == candidate {
			return true
		}
	}
	return false
}
