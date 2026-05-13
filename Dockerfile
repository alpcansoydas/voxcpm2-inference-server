FROM vllm/vllm-openai:v0.20.0

ARG VLLM_OMNI_REF=v0.20.0

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    VOXCPM2_MODEL=openbmb/VoxCPM2 \
    VLLM_OMNI_HOST=0.0.0.0 \
    VLLM_OMNI_PORT=8000 \
    VLLM_OMNI_BASE_URL=http://127.0.0.1:8000 \
    VLLM_OMNI_VOXCPM_CODE_PATH=/app/VoxCPM-main/src \
    APP_HOST=0.0.0.0 \
    APP_PORT=8080

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends git libsndfile1 \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt ./
COPY VoxCPM-main ./VoxCPM-main

RUN python3 -m pip install --upgrade pip \
    && python3 -m pip install -r requirements.txt \
    && python3 -m pip install "setuptools_scm" \
    && python3 -m pip install "vllm-omni @ git+https://github.com/vllm-project/vllm-omni.git@${VLLM_OMNI_REF}" \
    && SETUPTOOLS_SCM_PRETEND_VERSION_FOR_VOXCPM=2.0.0 \
       python3 -m pip install -e ./VoxCPM-main

COPY app ./app
COPY voice_presets ./voice_presets
COPY README.md ./

EXPOSE 8000 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 \
    CMD python3 -c "import os, urllib.request; urllib.request.urlopen(f'http://127.0.0.1:{os.environ.get(\"APP_PORT\", \"8080\")}/api/health', timeout=5).read()"

CMD ["bash", "-lc", "set -euo pipefail\nvllm-omni serve \"${VOXCPM2_MODEL}\" --omni --host \"${VLLM_OMNI_HOST}\" --port \"${VLLM_OMNI_PORT}\" ${VLLM_OMNI_ARGS:-} &\nvllm_pid=$!\npython3 -m uvicorn app.main:app --host \"${APP_HOST}\" --port \"${APP_PORT}\" &\napp_pid=$!\ntrap 'kill ${vllm_pid} ${app_pid} 2>/dev/null || true; wait' TERM INT\nwait -n ${vllm_pid} ${app_pid}\nstatus=$?\nkill ${vllm_pid} ${app_pid} 2>/dev/null || true\nwait || true\nexit ${status}"]
