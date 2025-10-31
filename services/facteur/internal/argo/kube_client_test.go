package argo

import (
	"testing"

	"github.com/stretchr/testify/require"
	"k8s.io/client-go/rest"
)

func TestNewKubernetesClientForConfig(t *testing.T) {
	cfg := &rest.Config{
		Host: "https://127.0.0.1:6443",
		TLSClientConfig: rest.TLSClientConfig{
			Insecure: true,
		},
		APIPath: "/apis",
	}

	client, err := NewKubernetesClientForConfig(cfg)
	require.NoError(t, err)
	require.NotNil(t, client)

	_, err = NewKubernetesClientForConfig(nil)
	require.Error(t, err)
}
