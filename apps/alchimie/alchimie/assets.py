import dagster as dg


@dg.asset
def my_asset():
    return "Hello, world!"


@dg.asset(required_resource_keys={"postgres"})
def postgres_query_asset(context):
    """Asset that queries data from PostgreSQL database"""
    conn = context.resources.postgres

    with conn.cursor() as cursor:
        cursor.execute("SELECT * FROM information_schema.tables LIMIT 10")
        results = cursor.fetchall()

    return results
