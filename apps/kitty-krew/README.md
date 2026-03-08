# Kitty Krew Application

A Bun-based application containerized for deployment in Kubernetes with ArgoCD.

## Containerization

### Dockerfile

The application uses a multi-stage build process to create an optimized container image:

- **Stage 1 (Builder)**: Installs dependencies and prepares the application
- **Stage 2 (Production)**: Creates a minimal production image

Key features:

- Based on official `oven/bun:1.3.10` image
- Layer optimization for faster builds and smaller images
- Health checks for Kubernetes readiness/liveness probes
- Proper environment variable configuration

### GitHub Actions CI/CD Workflow

The application is automatically built and deployed using GitHub Actions:

- Workflow: `.github/workflows/docker-build-push.yaml`
- Trigger: Pull requests modifying files in `apps/kitty-krew/**`
- Context: Set to `./apps/kitty-krew` to ensure proper build context
- Output: Docker image pushed to the registry with version tag

**Important**:

- The workflow uses the context parameter `./apps/kitty-krew` to ensure correct path resolution
- The Dockerfile is written to work specifically with this context path
- When editing Dockerfile, maintain paths relative to the app directory, not the workspace root

### Build Script

A build script is provided at `scripts/build-kitty-krew.sh` to simplify the build and push process.

The script:

- Builds the Docker image with proper context
- Targets ARM64 architecture via Docker Buildx
- Automatically pushes to the registry
- Tags images with timestamps or custom tags
- Provides instructions for updating the Kubernetes deployment
- Automatically runs the container locally for testing after a successful build
- Verifies application health with a curl request to the /health endpoint

### Prerequisites

Before using the build script, ensure you have:

- Docker installed with Buildx enabled (comes with Docker Desktop 2.2.0+)
- Docker logged in to your container registry
- Permissions to push to the target repository
- curl installed on your local machine for health checks

## Usage

### Building the Image

To build and push the Docker image:

```bash
# With default timestamp tag
./scripts/build-kitty-krew.sh

# With custom tag
./scripts/build-kitty-krew.sh v1.0.0
```

After a successful build, the script automatically:

1. Runs the container locally with the `--rm` flag
2. Waits a few seconds for the application to initialize
3. Performs a health check using curl to verify the application is responding
4. Displays the response from the health endpoint

The container will run in detached mode with the name `kitty-krew-test` and can be stopped with `docker stop kitty-krew-test`.

### Updating Kubernetes Configuration

After building, update your kustomization.yaml in the appropriate overlay:

```yaml
images:
  - name: kitty-krew
    newName: registry.ide-newton.ts.net/lab/kitty-krew
    newTag: YOUR_TAG
```

## Deployment

The application is configured for deployment with ArgoCD using Kustomize.

Application properties:

- Port: 3000
- Health check: `/health`
- Readiness check: `/ready`
- Environment configuration via ConfigMap

See the ArgoCD manifests in `argocd/applications/kitty-krew` for complete deployment configuration.

## Development

### Local Testing

To test the application locally:

```bash
# Navigate to the app directory
cd apps/kitty-krew

# Install dependencies
bun install

# Run in development mode
bun run dev
```

### Docker Testing

To test the containerized application manually:

```bash
# Run with auto-removal when stopped
docker run --rm -p 3000:3000 registry.ide-newton.ts.net/lab/kitty-krew:YOUR_TAG

# Or run in detached mode
docker run -d -p 3000:3000 registry.ide-newton.ts.net/lab/kitty-krew:YOUR_TAG

# Verify it's working with curl
curl http://localhost:3000/health
```

Access the application at [http://localhost:3000](http://localhost:3000)

## Troubleshooting Docker Builds

If you encounter build issues:

1. **Check context**: Ensure the Docker build context is correctly set to `./apps/kitty-krew` in workflows
2. **Path resolution**: The Dockerfile paths must be relative to the app directory, not the workspace root
3. **Logging information**: The Dockerfile includes echo statements for troubleshooting
4. **Build inspection**: Review logs for each build stage to identify where failures occur
5. **Script output**: For local builds, check the output from the build script for errors
