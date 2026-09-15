# dernier

Rails 8.0.3 API application backed by PostgreSQL (managed via [CloudNativePG](https://cloudnative-pg.io/documentation/1.27/)) and Redis (OT-Container-Kit operator). The service exposes a `/health` endpoint for uptime checks and is designed to run in Kubernetes via Argo CD, following the deployment guidance in the [Rails 8 release notes](https://weblog.rubyonrails.org/2024/9/24/Rails-8-0-final/).

## Requirements

- Ruby 3.4.7 (local development installs via [`ruby-build`](https://github.com/rbenv/ruby-build) or similar)
- Bundler 2.7+
- PostgreSQL 14+ reachable by `DATABASE_URL`
- Redis 7+ reachable by `REDIS_URL`

## Setup

```bash
bundle install
# optional: configure .env or export environment variables
export DATABASE_URL=postgres://localhost/dernier_development
export REDIS_URL=redis://localhost:6379/1
bundle exec rails db:prepare
```

Run the server locally:

```bash
bundle exec rails server
```

### Tailwind CSS workflow

Tailwind is wired in via [`tailwindcss-rails`](https://github.com/rails/tailwindcss-rails) and matches the tooling described in the [Tailwind CSS v3.4 announcement](https://tailwindcss.com/blog/tailwindcss-v3-4). For a live-reloading loop, use the Foreman-backed dev script:

```bash
bin/dev
```

This runs both `rails server` and `rails tailwindcss:watch`. The compiled stylesheet lives at `app/assets/builds/tailwind.css` and is generated from `app/assets/tailwind/application.css`.

## Tests

The test suite requires a reachable PostgreSQL database. Provide a test database URL before running:

```bash
export DATABASE_URL=postgres://localhost/dernier_test
bundle exec rails test
```

## Docker

Build the container image and run it locally:

```bash
docker build -t dernier:dev .
docker run --rm \
  -p 3000:3000 \
  -e DATABASE_URL=postgres://postgres:postgres@postgres.example/dernier \
  -e REDIS_URL=redis://redis.example:6379/1 \
  -e RAILS_MASTER_KEY=... \
  dernier:dev
```

The container entrypoint runs `bundle exec rails db:prepare` on startup and serves Puma on `0.0.0.0:3000`.

## Health Check

- `GET /health` – returns `{ "status": "ok" }` when the application boots successfully.
