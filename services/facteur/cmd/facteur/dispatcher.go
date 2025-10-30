package facteur

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/clientcmd"
	"k8s.io/client-go/util/homedir"

	"github.com/proompteng/lab/services/facteur/internal/argo"
	"github.com/proompteng/lab/services/facteur/internal/bridge"
	"github.com/proompteng/lab/services/facteur/internal/config"
)

func buildDispatcher(cfg *config.Config) (bridge.Dispatcher, argo.Runner, error) {
	if isDispatcherDisabled() {
		return bridge.NoopDispatcher{}, nil, nil
	}

	restCfg, err := resolveRESTConfig()
	if err != nil {
		return nil, nil, err
	}

	argoClient, err := argo.NewKubernetesClientForConfig(restCfg)
	if err != nil {
		return nil, nil, err
	}

	runner := argo.NewWorkflowRunner(argoClient)

	dispatcher, err := bridge.NewDispatcher(runner, bridge.ServiceConfig{
		Namespace:        cfg.Argo.Namespace,
		WorkflowTemplate: cfg.Argo.WorkflowTemplate,
		ServiceAccount:   cfg.Argo.ServiceAccount,
		Parameters:       cfg.Argo.Parameters,
	})
	if err != nil {
		return nil, nil, err
	}

	return dispatcher, runner, nil
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

func resolveRESTConfig() (*rest.Config, error) {
	if path := os.Getenv("FACTEUR_KUBECONFIG"); path != "" {
		cfg, err := clientcmd.BuildConfigFromFlags("", path)
		if err != nil {
			return nil, fmt.Errorf("kubeconfig %s: %w", path, err)
		}
		return cfg, nil
	}

	if env := os.Getenv("KUBECONFIG"); env != "" {
		cfg, err := clientcmd.BuildConfigFromFlags("", env)
		if err == nil {
			return cfg, nil
		}
	}

	if cfg, err := rest.InClusterConfig(); err == nil {
		return cfg, nil
	}

	if home := homedir.HomeDir(); home != "" {
		path := filepath.Join(home, ".kube", "config")
		if _, err := os.Stat(path); err == nil {
			cfg, err := clientcmd.BuildConfigFromFlags("", path)
			if err == nil {
				return cfg, nil
			}
		}
	}

	return nil, fmt.Errorf("unable to locate Kubernetes configuration; set FACTEUR_KUBECONFIG or KUBECONFIG")
}
