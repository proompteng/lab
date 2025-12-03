FROM flink:1.20.3-scala_2.12-java17

# The Flink K8s Operator mounts this image and runs the job in application mode
# using the shaded jar placed in /opt/flink/usrlib.
COPY target/flink-ta.jar /opt/flink/usrlib/flink-ta.jar

ENV FLINK_PROPERTIES="jobmanager.execution.failover-strategy: region"

CMD ["bash", "-c", "ls /opt/flink/usrlib && /docker-entrypoint.sh jobmanager"]
