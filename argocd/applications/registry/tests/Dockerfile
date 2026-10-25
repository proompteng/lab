FROM haproxy:3.4.4-alpine@sha256:c0afc4864dca9c68694cd1290433f0ee79b5c55be80f6745a165ffe373b9a564
USER root
RUN apk add --no-cache python3
USER 99:99
COPY tests/upload-pacing.py /test.py
COPY haproxy.cfg /proxy.cfg
ENTRYPOINT ["python3", "/test.py"]
CMD ["/proxy.cfg"]
