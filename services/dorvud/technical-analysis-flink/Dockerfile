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

FROM flink:1.20.1-scala_2.12-java17
WORKDIR /opt/flink/usrlib
COPY --from=build /workspace/technical-analysis-flink/build/libs/technical-analysis-flink-all.jar /opt/flink/usrlib/app.jar
ARG TORGHUT_TA_VERSION=dev
ARG TORGHUT_TA_COMMIT=dev
ENV TORGHUT_TA_VERSION=$TORGHUT_TA_VERSION
ENV TORGHUT_TA_COMMIT=$TORGHUT_TA_COMMIT
