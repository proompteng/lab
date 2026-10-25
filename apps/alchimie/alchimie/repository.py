from dagster import repository
from assets import postgres_query_asset


@repository
def alchimie_repository():
    """Define all jobs, assets, schedules, and sensors for this repository."""
    return [
        postgres_query_asset,
    ]
