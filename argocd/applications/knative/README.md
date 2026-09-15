# Knative Installation Guide

## Prerequisites

- Kubernetes cluster
- kubectl CLI
- Homebrew (for macOS users)

## Install Knative CLI (kn)

```bash
# macOS
brew install knative/client/kn

# Verify installation
kn version
```

## Install Knative Plugins

First, add the Knative plugins tap:

```bash
brew tap knative-extensions/kn-plugins
```

### Func Plugin

```bash
brew install func

# Verify installation
kn func version
```

### Operator Plugin

```bash
# Download the binary
curl -LO https://github.com/knative/client-pkg/releases/download/knative-v1.17.5/kn-operator-darwin-arm64

# Rename the binary
mv kn-operator-darwin-arm64 kn-operator

# Make it executable
chmod +x kn-operator

# Create plugin directory
mkdir -p ~/.config/kn/plugins

# Move to plugins directory
mv kn-operator ~/.config/kn/plugins

# Verify installation
kn operator -h
```

For automated installation, use the script in `/scripts/install-knative.sh`

## Verify Installation

```bash
# Check operator status
kubectl get deployment knative-operator -n knative-operator

# Check if CRDs are installed
kubectl get crd | grep knative
```

## Next Steps

1. Install Knative Serving
2. Install Knative Eventing
3. Configure DNS
4. Set up first application

For more details, visit [Knative Documentation](https://knative.dev/docs/).
