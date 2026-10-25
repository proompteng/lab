#!/bin/bash

set -euo pipefail

# Install Knative CLI
if ! command -v kn &> /dev/null; then
    echo "Installing Knative CLI..."
    brew install knative/client/kn
fi

# Add Knative plugins tap
echo "Adding Knative plugins tap..."
brew tap knative-extensions/kn-plugins

# Install func plugin
echo "Installing func plugin..."
brew install func

# Install operator plugin
echo "Installing operator plugin..."

# Download the binary
curl -LO "https://github.com/knative-extensions/kn-plugin-operator/releases/download/knative-v1.17.0/kn-operator-darwin-arm64"

# Rename and make executable
mv "kn-operator-darwin-arm64" kn-operator
chmod +x kn-operator

# Create plugin directory and move binary
mkdir -p ~/.config/kn/plugins
mv kn-operator ~/.config/kn/plugins/

# Verify installations
echo "Verifying installations..."
kn version
kn func version
kn operator -h

echo "Installing Knative Operator and components..."

# Install serving
kn operator install -c serving

# Install eventing
kn operator install -c eventing

echo "Installation complete!"
