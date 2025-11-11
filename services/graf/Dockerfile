# syntax=docker/dockerfile:1.6

FROM gradle:8.5-jdk21 as builder
WORKDIR /workspace
COPY --chown=gradle:gradle . .
RUN ./gradlew :services:graf:clean :services:graf:quarkusBuild --no-daemon

FROM gcr.io/distroless/java21-debian12:nonroot
WORKDIR /app
COPY --from=builder /workspace/services/graf/build/quarkus-app /app/quarkus-app
ENV PORT=8080
EXPOSE 8080
ENTRYPOINT ["java", "-jar", "/app/quarkus-app/quarkus-run.jar"]
