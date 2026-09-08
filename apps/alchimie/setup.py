from setuptools import find_packages, setup

setup(
    name="alchimie",
    packages=find_packages(exclude=["alchimie_tests"]),
    install_requires=[
        "dagster==1.11.11",
        "dagster-cloud==1.11.11",
        "dagster-k8s==0.27.11",
        "psycopg2-binary==2.9.10",
        "polars==1.33.1",
    ],
    extras_require={
        "dev": [
            "dagster-webserver==1.11.11",
            "pytest==8.4.2",
        ]
    },
)
