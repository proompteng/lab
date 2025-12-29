# Jangar local dev against a remote Kubernetes cluster.
#
# This Tiltfile intentionally DOES NOT deploy anything to Kubernetes.
# It runs Jangar locally (Bun) and uses `kubectl port-forward` to connect to
# remote in-cluster dependencies using your default kubeconfig/current context.

# Safety: require explicit opt-in to the current context.
allow_k8s_contexts(k8s_context())

# -----------------------------------------------------------------------------
# Config
# -----------------------------------------------------------------------------

config.define_string('jangar_port', usage='Local port for Jangar dev server (default: 3000)')
config.define_string('db_local_port', usage='Local port for remote Postgres (default: 15432)')
config.define_string('redis_local_port', usage='Local port for remote Redis (default: 16379)')
config.define_string('nats_local_port', usage='Local port for remote NATS (default: 14222)')
config.define_string('clickhouse_local_port', usage='Local port for remote ClickHouse (default: 18123)')

# Embeddings (memories/atlas)
config.define_string(
    'openai_api_base_url',
    usage='OpenAI-compatible API base URL for embeddings (default: http://127.0.0.1:11434/v1 for local Ollama)',
)
config.define_string(
    'openai_embedding_model',
    usage='Embedding model name (default: qwen3-embedding-saigak:0.6b)',
)
config.define_string(
    'openai_embedding_dimension',
    usage='Embedding dimension as integer string (default: 1024; must match DB vector dimension)',
)
config.define_string(
    'openai_api_key',
    usage='Optional API key for OpenAI-compatible endpoint (default: empty)',
)

config.define_bool('enable_redis', usage='Port-forward Redis + set JANGAR_REDIS_URL (default: true)')
config.define_bool('enable_nats', usage='Port-forward NATS + set NATS_* env (default: true)')
config.define_bool('enable_clickhouse', usage='Port-forward ClickHouse + set CH_* env (default: true)')

cfg = config.parse()

jangar_port = int(cfg.get('jangar_port', '3000'))
db_local_port = int(cfg.get('db_local_port', '15432'))
redis_local_port = int(cfg.get('redis_local_port', '16379'))
nats_local_port = int(cfg.get('nats_local_port', '14222'))
clickhouse_local_port = int(cfg.get('clickhouse_local_port', '18123'))

openai_api_base_url = str(cfg.get('openai_api_base_url', 'http://127.0.0.1:11434/v1')).strip()
openai_embedding_model = str(cfg.get('openai_embedding_model', 'qwen3-embedding-saigak:0.6b')).strip()
openai_embedding_dimension = str(cfg.get('openai_embedding_dimension', '1024')).strip()
openai_api_key = str(cfg.get('openai_api_key', '')).strip()

enable_redis = cfg.get('enable_redis', True)
enable_nats = cfg.get('enable_nats', True)
enable_clickhouse = cfg.get('enable_clickhouse', True)

# -----------------------------------------------------------------------------
# Helpers
# -----------------------------------------------------------------------------

def _sh(cmd):
    return str(local(['bash', '-lc', cmd], quiet=True)).strip()


def _choose_k8s_service(namespace, candidates):
    # Returns the first Service name that exists, or '' if none exist.
    candidate_list = ' '.join(["'%s'" % c for c in candidates])
    cmd = "set -euo pipefail; for svc in %s; do if kubectl -n %s get svc \"$svc\" >/dev/null 2>&1; then echo -n \"$svc\"; exit 0; fi; done; echo -n ''" % (
        candidate_list,
        namespace,
    )
    return _sh(cmd)


def _secret_key(namespace, secret_name, key):
    # Reads a Secret data key (base64) and returns the decoded string.
    # This works cross-platform (no GNU/BSD base64 differences).
    # If the Secret/key does not exist or you lack RBAC, return '' instead of failing Tiltfile evaluation.
    cmd = "set -euo pipefail; (kubectl -n %s get secret %s -o jsonpath='{.data.%s}' 2>/dev/null || true) | python3 -c 'import base64,sys;data=sys.stdin.read().strip();print(base64.b64decode(data).decode() if data else \"\")'" % (
        namespace,
        secret_name,
        key,
    )
    return _sh(cmd)


def _rewrite_postgres_uri_to_local(uri, local_port):
    # Keep username/password/db/query from CNPG-generated URI but point at localhost:local_port.
    py = """import os, urllib.parse
uri=os.environ['URI']
port=os.environ['PORT']
p=urllib.parse.urlsplit(uri)
scheme=p.scheme or 'postgresql'
user=p.username
pwd=p.password
netloc=''
if user is not None:
  netloc += urllib.parse.quote(user, safe='')
  if pwd is not None:
    netloc += ':' + urllib.parse.quote(pwd, safe='')
  netloc += '@'
netloc += '127.0.0.1:' + str(port)
print(urllib.parse.urlunsplit((scheme, netloc, p.path, p.query, p.fragment)))
"""
    return str(
        local(
            [
                'python3',
                '-c',
                py,
            ],
            env={'URI': uri, 'PORT': str(local_port)},
            quiet=True,
        )
    ).strip()


# -----------------------------------------------------------------------------
# Remote dependency port-forwards
# -----------------------------------------------------------------------------

# CNPG generates Services like: jangar-db-rw / jangar-db-ro / jangar-db-r
postgres_service = _choose_k8s_service('jangar', ['jangar-db-rw', 'jangar-db-r', 'jangar-db'])
if not postgres_service:
    warn("Could not find Postgres Service in namespace 'jangar' (tried jangar-db-rw/jangar-db-r/jangar-db).")
else:
    local_resource(
        'pf-postgres',
        serve_cmd='kubectl -n jangar port-forward svc/%s %d:5432' % (postgres_service, db_local_port),
        labels=['port-forward'],
    )

jangar_deps = []
if postgres_service:
    jangar_deps.append('pf-postgres')

redis_service = ''
if enable_redis:
    # Opstree Redis operator service naming varies a bit across versions.
    redis_service = _choose_k8s_service(
        'jangar',
        [
            'jangar-openwebui-redis',
            'jangar-openwebui-redis-master',
            'jangar-openwebui-redis-leader',
            'jangar-openwebui-redis-primary',
        ],
    )
    if not redis_service:
        warn("Redis port-forward enabled but no Service found in namespace 'jangar' for jangar-openwebui-redis.")
    else:
        local_resource(
            'pf-redis',
            serve_cmd='kubectl -n jangar port-forward svc/%s %d:6379' % (redis_service, redis_local_port),
            labels=['port-forward'],
        )
        jangar_deps.append('pf-redis')

if enable_nats:
    # NATS is installed via Helm in the 'nats' namespace; the client port is typically 4222.
    local_resource(
        'pf-nats',
        serve_cmd='kubectl -n nats port-forward svc/nats %d:4222' % nats_local_port,
        labels=['port-forward'],
    )
    jangar_deps.append('pf-nats')

if enable_clickhouse:
    # ClickHouse service is defined in argocd/applications/torghut/clickhouse/clickhouse-service.yaml
    local_resource(
        'pf-clickhouse',
        serve_cmd='kubectl -n torghut port-forward svc/torghut-clickhouse %d:8123' % clickhouse_local_port,
        labels=['port-forward'],
    )
    jangar_deps.append('pf-clickhouse')

# -----------------------------------------------------------------------------
# Local Jangar
# -----------------------------------------------------------------------------

# DB creds come from CNPG-generated Secret in the jangar namespace.
# We rewrite the URI to point at localhost:<db_local_port>.
try_db_uri = ''
if postgres_service:
    try_db_uri = _secret_key('jangar', 'jangar-db-app', 'uri')

jangar_env = {
    'NODE_ENV': 'development',
    'PORT': str(jangar_port),
    'UI_PORT': str(jangar_port),
    # Jangar defaults to require; keep it explicit.
    'PGSSLMODE': 'require',
    # Default to self-hosted embeddings matching existing DB schema: vector(1024).
    'OPENAI_API_BASE_URL': openai_api_base_url,
    'OPENAI_EMBEDDING_MODEL': openai_embedding_model,
    'OPENAI_EMBEDDING_DIMENSION': openai_embedding_dimension,
}

if openai_api_key:
    jangar_env['OPENAI_API_KEY'] = openai_api_key

if try_db_uri:
    jangar_env['DATABASE_URL'] = _rewrite_postgres_uri_to_local(try_db_uri, db_local_port)

if enable_redis and redis_service:
    # Jangar uses DB index 1 in production for OpenWebUI thread/worktree state.
    jangar_env['JANGAR_REDIS_URL'] = 'redis://127.0.0.1:%d/1' % redis_local_port

if enable_nats:
    jangar_env['NATS_URL'] = 'nats://127.0.0.1:%d' % nats_local_port
    # Credentials are mirrored into the jangar namespace for the deployment.
    # If they are missing, Jangar will error when you hit the agent comms endpoint.
    nats_user = _secret_key('jangar', 'nats-jangar-credentials', 'username')
    nats_password = _secret_key('jangar', 'nats-jangar-credentials', 'password')
    if nats_user:
        jangar_env['NATS_USER'] = nats_user
    if nats_password:
        jangar_env['NATS_PASSWORD'] = nats_password
    if not nats_user or not nats_password:
        warn("NATS is enabled but credentials are missing (Secret jangar/nats-jangar-credentials username/password).")

if enable_clickhouse:
    jangar_env['CH_HOST'] = '127.0.0.1'
    jangar_env['CH_PORT'] = str(clickhouse_local_port)
    jangar_env['CH_DATABASE'] = 'default'
    jangar_env['CH_SECURE'] = 'false'
    ch_user = _secret_key('jangar', 'jangar-clickhouse-auth', 'username')
    ch_password = _secret_key('jangar', 'jangar-clickhouse-auth', 'password')
    if ch_user:
        jangar_env['CH_USER'] = ch_user
    if ch_password:
        jangar_env['CH_PASSWORD'] = ch_password
    if not ch_user or not ch_password:
        warn("ClickHouse is enabled but credentials are missing (Secret jangar/jangar-clickhouse-auth username/password).")

local_resource(
    'jangar',
    serve_cmd='cd services/jangar && bun --bun vite dev --host --port %d' % jangar_port,
    # Watch only source/config inputs; avoid node_modules/.vite-temp causing restart loops.
    deps=[
        'services/jangar/src',
        'services/jangar/public',
        'services/jangar/package.json',
        'services/jangar/tsconfig.json',
        'services/jangar/vite.config.ts',
        'services/jangar/bunfig.toml',
    ],
    ignore=[
        'services/jangar/node_modules',
        'services/jangar/.output',
        'services/jangar/.tanstack',
        'services/jangar/test-results',
        'services/jangar/playwright-report',
        'services/jangar/.turbo',
    ],
    resource_deps=jangar_deps,
    serve_env=jangar_env,
    readiness_probe=probe(http_get=http_get_action(port=jangar_port, path='/health'), period_secs=5),
    links=[
        link('http://localhost:%d' % jangar_port, 'Jangar UI'),
        link('http://localhost:%d/openai/v1/models' % jangar_port, 'OpenAI models'),
        link('http://localhost:%d/health' % jangar_port, 'Health'),
    ],
    labels=['local'],
)
