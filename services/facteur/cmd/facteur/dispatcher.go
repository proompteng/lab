package facteur

import (
	"os"
	"strings"

	"github.com/proompteng/lab/services/facteur/internal/agents"
	"github.com/proompteng/lab/services/facteur/internal/bridge"
	"github.com/proompteng/lab/services/facteur/internal/config"
)

func buildDispatcher(cfg *config.Config) (bridge.Dispatcher, agents.Submitter, error) {
	if isDispatcherDisabled() {
		return bridge.NoopDispatcher{}, nil, nil
	}

	submitter, err := agents.NewHTTPSubmitter(cfg.Implementer.AgentsBaseURL, nil)
	if err != nil {
		return nil, nil, err
	}

	parameters := cloneStringMap(cfg.Argo.Parameters)
	for k, v := range cfg.Implementer.Parameters {
		parameters[k] = v
	}

	dispatcher, err := bridge.NewDispatcher(submitter, submitter, bridge.ServiceConfig{
		Namespace:               cfg.Implementer.Namespace,
		AgentName:               cfg.Implementer.AgentName,
		RuntimeType:             cfg.Implementer.RuntimeType,
		RuntimeConfig:           cfg.Implementer.RuntimeConfig,
		Parameters:              parameters,
		Secrets:                 cfg.Implementer.Secrets,
		SecretBindingRef:        cfg.Implementer.SecretBindingRef,
		VCSProvider:             cfg.Implementer.VCSProvider,
		VCSPolicyMode:           cfg.Implementer.VCSPolicyMode,
		VCSRequired:             cfg.Implementer.VCSRequired,
		GoalTokenBudget:         cfg.Implementer.GoalTokenBudget,
		TTLSecondsAfterFinished: cfg.Implementer.TTLSecondsAfterFinished,
	})
	if err != nil {
		return nil, nil, err
	}

	return dispatcher, submitter, nil
}

func isDispatcherDisabled() bool {
	value := strings.TrimSpace(os.Getenv("FACTEUR_DISABLE_DISPATCHER"))
	if value == "" {
		return false
	}
	value = strings.ToLower(value)
	switch value {
	case "0", "false", "no":
		return false
	default:
		return true
	}
}
