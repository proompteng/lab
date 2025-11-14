# baozi: Bun S2I Builder
FROM ubuntu:24.04

LABEL maintainer="Greg Konush <greg.konush@gmail.com>"

# Environment variables
ENV BUN_INSTALL=/opt/app-root/.bun \
    BUN_INSTALL_CACHE_DIR=/opt/app-root/.bun/cache \
    BUN_INSTALL_TMPDIR=/opt/app-root/.bun/tmp \
    BUN_INSTALL_GLOBAL_DIR=/opt/app-root/.bun/global \
    PATH=/opt/app-root/.bun/bin:${PATH} \
    BUILDER_VERSION=1.0 \
    DEBIAN_FRONTEND=noninteractive

# Labels for OpenShift/S2I convention
LABEL io.k8s.description="Platform for building and running Bun applications" \
      io.k8s.display-name="Bun S2I Builder" \
      io.openshift.expose-services="3000:http" \
      io.openshift.tags="builder,bun" \
      io.openshift.s2i.scripts-url="image:///usr/libexec/s2i"

# Install dependencies: curl for Bun install, unzip, git, ca-certificates, rsync, and create user
RUN apt-get update && apt-get install -y --no-install-recommends curl unzip git ca-certificates rsync \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd -r bun --gid=1001 && useradd -r -g bun --uid=1001 bun

# Create app directory and set permissions before switching user
RUN mkdir -p /opt/app-root/.bun/cache /opt/app-root/.bun/tmp /opt/app-root/.bun/global \
    && chown -R bun:bun /opt/app-root

# Switch to the application user using a numeric UID for Kubernetes PSP compatibility
USER 1001
WORKDIR /opt/app-root

# Install Bun as the application user using the already-defined BUN_INSTALL
RUN bash -c "curl -fsSL https://bun.sh/install | bash"

# Copy the S2I scripts
# The user is already 'bun', so ownership is implicitly correct, but --chown is kept for clarity.
COPY --chown=bun:bun ./s2i/bin/ /usr/libexec/s2i

# Set the default port for Bun applications
EXPOSE 3000

# Set the default CMD for the image
CMD ["/usr/libexec/s2i/usage"]
