# syntax=docker/dockerfile:1
FROM eclipse-temurin:21-jdk AS build
WORKDIR /workspace

COPY gradlew gradle.properties settings.gradle.kts build.gradle.kts ./
COPY gradle ./gradle
COPY platform ./platform
COPY technical-analysis ./technical-analysis
COPY technical-analysis-flink ./technical-analysis-flink
COPY websockets ./websockets
COPY flink-integration ./flink-integration

RUN chmod +x ./gradlew
RUN ./gradlew :technical-analysis-flink:uberJar --no-daemon

FROM flink:2.0.1-scala_2.12-java21
WORKDIR /opt/flink/usrlib
COPY --from=build /workspace/technical-analysis-flink/build/libs/technical-analysis-flink-all.jar /opt/flink/usrlib/app.jar
RUN mkdir -p /opt/flink/plugins/s3-fs-hadoop \
  && curl -fsSL https://repo1.maven.org/maven2/org/apache/flink/flink-s3-fs-hadoop/2.0.1/flink-s3-fs-hadoop-2.0.1.jar \
    -o /opt/flink/plugins/s3-fs-hadoop/flink-s3-fs-hadoop-2.0.1.jar
ARG TORGHUT_TA_VERSION=dev
ARG TORGHUT_TA_COMMIT=dev
ENV TORGHUT_TA_VERSION=$TORGHUT_TA_VERSION
ENV TORGHUT_TA_COMMIT=$TORGHUT_TA_COMMIT
