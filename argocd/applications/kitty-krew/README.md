# Kitty Krew Application

This directory contains the Kubernetes manifests for deploying the Kitty Krew application using a Kustomize-based approach.

## Structure

```text
kitty-krew/
├── base/              # Base resources
│   ├── configmap.yaml # Common configuration
│   ├── deployment.yaml # Base deployment spec
│   ├── kustomization.yaml # Base kustomization
│   └── service.yaml   # Service definition
├── overlays/          # Environment-specific overlays
│   ├── dev/           # Development environment
│   │   ├── configmap.yaml # Dev-specific config patch
│   │   ├── deployment.yaml # Dev-specific deployment patch
│   │   └── kustomization.yaml # Dev kustomization
│   └── prod/          # Production environment
│       ├── configmap.yaml # Prod-specific config patch
│       ├── deployment.yaml # Prod-specific deployment patch
│       └── kustomization.yaml # Prod kustomization
└── kustomization.yaml # Root kustomization (points to dev by default)
```

## Application Configuration

### Base Configuration

- **Port**: Application runs on port 3000
- **Resources**: Moderate CPU and memory allocation
- **Health Checks**: Configured for `/health` and `/ready` endpoints
- **Environment**: Default production settings

### Development Overlay

- Lower resource limits
- Debug logging enabled
- Development environment variables

### Production Overlay

- Higher replica count (3)
- Increased resource limits
- Production-optimized logging

## Deployment

This application is automatically deployed by the ApplicationSet defined in `argocd/applicationsets/lovely-apps.yaml`.

### Switching to Production

To deploy the production configuration, modify the root `kustomization.yaml`:

```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization

resources:
  - overlays/prod # Switch to production overlay
```

## Local Testing

You can preview the manifests that will be applied using:

```bash
# Preview dev configuration
kubectl kustomize .

# Preview production configuration
kubectl kustomize overlays/prod
```

## Image Updates

The image references are configured in the overlay kustomization files:

```yaml
images:
  - name: kitty-krew
    newName: ghcr.io/example/kitty-krew
    newTag: dev # or stable for production
```

Update these references to point to your specific image repository and tags.
