ARG BASE_IMAGE=python:3.12-slim
ARG PLATFORM=linux/arm64

FROM --platform=${PLATFORM} ${BASE_IMAGE}

ARG DAGSTER_VERSION=1.11.11

# All packages are hard-pinned to `dagster`, so setting the version on just `DAGSTER` will ensure
# compatible versions.
RUN pip install -U uv

RUN python -m uv pip install \
    dagster==${DAGSTER_VERSION} \
    dagster-azure \
    dagster-postgres \
    dagster-k8s \
    dagster-aws \
    dagster-celery[flower,redis,kubernetes] \
    dagster-celery-k8s \
    dagster-gcp \
    dagster-graphql \
    dagster-webserver \
    grpcio==1.75.0 # Align with Dagster 1.11.11 runtime expectations

COPY . /app

WORKDIR /app

ENV DAGSTER_HOME=/app

RUN uv pip install --system ".[dev]"
