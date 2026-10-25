# Research market data

Research does not attach observers, record buffers, storage clients, or persistence waits to the trading worker.
The former in-process recorder, session timer, SQL capture writer and manual S3 export implementation are removed.
Existing stored objects and SQL rows are retained. Their existence does not qualify a complete session.

The October 12 cluster readback found Kafka 4.3.1, three topic replicas, minimum ISR two, and 35-day retention on
bars, quotes, trades, market features and technical features. These retained logs are durable across consumer
replacement. Kafka retention remains a limit on how long an offset range can be read.

Longer-lived archives should use a separate Apache Kafka Connect worker and a maintained S3 sink plugin.
Kafka Connect is Apache-licensed. Confluent's S3 sink uses the separate Confluent Community License; its source
availability does not make it an Apache-licensed connector. Aiven's S3 connector is an Apache 2.0 alternative.
Plugin selection must include exact-byte format verification and restart recovery against Ceph. Restate should coordinate the
registered session, frozen offset range and completion checks. Bayn should not implement the bulk copy.
No Kafka Connect worker or S3 connector was deployed at the time of that readback. This cleanup does not claim one
has been deployed or a complete research dataset has been captured.

Archive configuration must preserve original value bytes and partition/offset/timestamp identities, retain or
explicitly reject tombstones, and avoid silently dropping records. A producer timestamp is not evidence of when
the trading worker received a record. Complete source coverage, replay acceptance, costs and economic qualification
remain separate checks.

References:

- [Kafka Connect REST API and offset management](https://kafka.apache.org/41/kafka-connect/user-guide/)
- [Confluent S3 Sink connector](https://docs.confluent.io/kafka-connectors/s3-sink/current/overview.html)
- [S3 formats, tombstones and metadata options](https://docs.confluent.io/kafka-connectors/s3-sink/current/configuration_options.html)
- [Aiven connector license](https://github.com/Aiven-Open/cloud-storage-connectors-for-apache-kafka/blob/v3.4.3/LICENSE)
- [Aiven S3 sink format and configuration](https://github.com/Aiven-Open/cloud-storage-connectors-for-apache-kafka/blob/v3.4.3/s3-sink-connector/README.md)
