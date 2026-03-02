ARG PG_MAJOR=18
ARG RELEASE=202509290807
ARG FLAVOR=minimal
ARG OS=trixie

FROM ghcr.io/cloudnative-pg/postgresql:${PG_MAJOR}.0-${RELEASE}-${FLAVOR}-${OS}

ARG PG_MAJOR

USER root

RUN set -euxo pipefail \
  && export DEBIAN_FRONTEND=noninteractive \
  && apt-get update \
  && apt-get install -y --no-install-recommends \
    postgresql-${PG_MAJOR}-pgvector \
  && rm -rf /var/lib/apt/lists/*

USER 26
