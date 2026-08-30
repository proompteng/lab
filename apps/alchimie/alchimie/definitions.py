from dagster import Definitions, load_assets_from_modules, ResourceDefinition
import psycopg2

from alchimie import assets  # noqa: TID252
from alchimie.jobs import my_k8s_job

all_assets = load_assets_from_modules([assets])


def get_sql_conn():
    return psycopg2.connect(
        "dbname=postgres user=postgres password=postgres host=localhost"
    )


postgres_resource = ResourceDefinition(
    resource_fn=lambda _: get_sql_conn(),
    description="Postgres connection resource",
)

defs = Definitions(
    assets=all_assets,
    jobs=[my_k8s_job],
    resources={
        "postgres": postgres_resource,
    },
)
