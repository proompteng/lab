# syntax=docker/dockerfile:1
FROM rust:1.96.1-bookworm@sha256:a339861ae23e9abb272cea45dfafde21760d2ce6577a70f8a926153677902663 AS rust

FROM nvidia/cuda:13.0.2-cudnn-runtime-ubuntu24.04@sha256:14d94b039cb94bbd5da559f303b46bc4b0d5d6c24ab1a9d7b186e566ed3400dc AS python-dependencies
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-venv libcurl4t64 libgomp1 ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && python3 -m venv /opt/venv
COPY requirements.txt /opt/rune/requirements.txt
RUN /opt/venv/bin/pip install --no-cache-dir --require-hashes -r /opt/rune/requirements.txt

FROM nvidia/cuda:13.0.2-cudnn-devel-ubuntu24.04@sha256:e071e85c52ad91fc9ea24158ff5330876b2d1a5c4ac83ccc6066976835873c01 AS compiled
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential cmake ninja-build git curl ca-certificates \
       libnccl-dev=2.28.3-1+cuda13.0 libcurl4-openssl-dev libicu-dev pkg-config python3 python3-venv \
    && rm -rf /var/lib/apt/lists/*
COPY --from=rust /usr/local/rustup /usr/local/rustup
COPY --from=rust /usr/local/cargo /usr/local/cargo
COPY --from=python-dependencies /opt/venv /opt/venv
ENV RUSTUP_HOME=/usr/local/rustup CARGO_HOME=/usr/local/cargo PATH=/usr/local/cargo/bin:$PATH
WORKDIR /opt/surogate
RUN curl --fail --location --retry 3 https://codeload.github.com/invergent-ai/surogate/tar.gz/4888528abcfdcd36e2f4a6a1ffa0262b67683c66 -o /tmp/source.tar.gz \
    && echo '8c37dfa3b1695fcd60ca9374a8e17bf3a2c224220db2401867f9829442be33fa  /tmp/source.tar.gz' | sha256sum --check \
    && tar -xzf /tmp/source.tar.gz --strip-components=1 \
    && rm /tmp/source.tar.gz
COPY patches/cpu-expert-architecture.patch /tmp/cpu-expert-architecture.patch
RUN git apply --check /tmp/cpu-expert-architecture.patch \
    && git apply /tmp/cpu-expert-architecture.patch \
    && c++ -std=c++20 -fsyntax-only -I csrc/src/serve -I /usr/local/cuda/include \
       csrc/src/serve/ops/cpu_expert_compute/cpu_expert_compute.cpp
RUN curl --fail --location --retry 3 https://codeload.github.com/ochafik/minja/tar.gz/143465ab2f924f7729a8ca5313a12fb83a106d6d -o /tmp/minja.tar.gz \
    && echo '8f9951345f77d4474826b9b4fedcd7ea3bd521d7c086cd78233e7ecdfec8bc87  /tmp/minja.tar.gz' | sha256sum --check \
    && mkdir /opt/minja && tar -xzf /tmp/minja.tar.gz -C /opt/minja --strip-components=1 \
    && cd /opt/minja && bash /opt/surogate/csrc/cmake/patch_minja.sh \
    && rm /tmp/minja.tar.gz
RUN cmake -S csrc -B csrc/build-serve -G Ninja \
    -DCMAKE_BUILD_TYPE=Release -DPYTHON_BINDING=OFF \
    -DPython_EXECUTABLE=/opt/venv/bin/python3 \
    -DFETCHCONTENT_SOURCE_DIR_MINJA=/opt/minja \
    -DSUROGATE_BUILD_SERVE=ON -DSUROGATE_REQUIRE_SERVE=ON -DSUROGATE_SERVE_TESTS=ON \
    -DSUROGATE_SERVE_CUDA_ARCHS=120a -DCMAKE_CUDA_ARCHITECTURES=120a -DSINFER_ENABLE_FFMPEG=OFF
RUN cmake --build csrc/build-serve --parallel 4 --target sinfer-serve \
    sinfer_decisions_test sinfer_decisions_v1_test sinfer_decisions_thinking_test sinfer_cpu_expert_compute_test
COPY patches/decisions-fp-contract.patch /tmp/decisions-fp-contract.patch
RUN git apply --check /tmp/decisions-fp-contract.patch \
    && git apply /tmp/decisions-fp-contract.patch \
    && cmake --build csrc/build-serve --parallel 4 --target sinfer-serve \
       sinfer_decisions_test sinfer_decisions_v1_test sinfer_decisions_thinking_test sinfer_cpu_expert_compute_test

FROM compiled AS builder
RUN mkdir /tmp/cuda-test-stubs \
    && ln -s /usr/local/cuda/lib64/stubs/libcuda.so /tmp/cuda-test-stubs/libcuda.so.1 \
    && (LD_LIBRARY_PATH=/tmp/cuda-test-stubs:$LD_LIBRARY_PATH \
        ctest --test-dir csrc/build-serve --output-on-failure -R '^sinfer_(decisions(_v1|_thinking)?|cpu_expert_compute)_test$' --no-tests=error > /tmp/native-tests.log 2>&1 \
        || { cat /tmp/native-tests.log; exit 1; }) \
    && cat /tmp/native-tests.log \
    && rm -r /tmp/cuda-test-stubs

FROM python-dependencies AS runtime
RUN useradd --uid 10001 --create-home rune
ENV PATH=/opt/venv/bin:$PATH PYTHONPATH=/opt/surogate PYTHONUNBUFFERED=1 \
    HF_HUB_DISABLE_IMPLICIT_TOKEN=1 HF_HUB_DISABLE_TELEMETRY=1 \
    XDG_CACHE_HOME=/models/cache CUDA_CACHE_PATH=/models/cache/cuda OMP_NUM_THREADS=8
WORKDIR /opt/rune
COPY --from=builder /opt/surogate/surogate /opt/surogate/surogate
COPY --from=builder /opt/surogate/LICENSE /opt/surogate/LICENSE
COPY --from=builder /opt/surogate/csrc/build-serve/surogate-engine /usr/local/bin/surogate-engine
COPY --from=builder /opt/surogate/csrc/build-serve/libsinfer.so /usr/local/lib/libsinfer.so
COPY --from=builder /tmp/native-tests.log /opt/rune/native-tests.log
RUN ldconfig
COPY runtime.py model-lock.json ./
LABEL ai.proompteng.rune.engine-revision="4888528abcfdcd36e2f4a6a1ffa0262b67683c66" \
      ai.proompteng.rune.model-revision="c6b360d47895bb77bdf3805a13ee5a5557ab1921"
USER 10001:10001
EXPOSE 8080
ENTRYPOINT ["python3", "/opt/rune/runtime.py"]

FROM runtime AS test
COPY test_runtime.py ./
RUN python3 -m unittest -v test_runtime.py \
    && python3 -c 'import surogate.serve.convert.gemma_vl.convert; import surogate.serve.convert.gemma4_moe.convert'
