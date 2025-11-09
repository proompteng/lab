package ai.proompteng.graf.di

import ai.proompteng.graf.config.MinioConfig
import ai.proompteng.graf.config.Neo4jConfig
import ai.proompteng.graf.neo4j.Neo4jClient
import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respondOk
import io.minio.MinioClient
import io.mockk.mockk
import io.temporal.client.WorkflowClient
import io.temporal.serviceclient.WorkflowServiceStubs
import io.temporal.worker.WorkerFactory
import org.koin.dsl.module

internal val standardTestOverrides =
  module {
    single<Neo4jConfig> {
      Neo4jConfig(
        uri = "bolt://localhost:7687",
        username = "neo4j",
        password = "password",
        database = "neo4j",
      )
    }
    single<MinioConfig> {
      MinioConfig(
        endpoint = "http://localhost:9000",
        bucket = "graf",
        accessKey = "access",
        secretKey = "secret",
        secure = false,
        region = "us-east-1",
      )
    }
    single<Neo4jClient> { mockk(relaxed = true) }
    single<MinioClient> { mockk(relaxed = true) }
    single<HttpClient> { HttpClient(MockEngine { respondOk() }) }
    single<WorkflowServiceStubs> { mockk(relaxed = true) }
    single<WorkflowClient> { mockk(relaxed = true) }
    single<WorkerFactory> { mockk(relaxed = true) }
  }
