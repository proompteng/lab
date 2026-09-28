from dagster import job, op
from dagster_k8s import k8s_job_executor


@op
def hello():
    return "Hello, world!"

@op
def world(hello):
    return hello + " world!"

@job(executor_def=k8s_job_executor)
def my_k8s_job():
    world(hello())