# VoxCPM2 Inference Server

FastAPI gateway and browser demo UI for VoxCPM2 served by
[vLLM-Omni](https://github.com/vllm-project/vllm-omni).

The gateway keeps model execution in vLLM-Omni and exposes a small app-owned API
for voice design, controllable voice cloning, ultimate cloning, non-streaming WAV
generation, and raw PCM streaming playback.

## Quick Start

From a fresh clone, start the lightweight FastAPI gateway first:

```bash
git clone <your-github-repo-url>
cd voxcpm2-inference-server
uv venv .venv
uv pip install --python .venv/bin/python -e .
VLLM_OMNI_BASE_URL=http://localhost:8000 \
VOXCPM2_MODEL=openbmb/VoxCPM2 \
.venv/bin/python -m uvicorn app.main:app --host 0.0.0.0 --port 8080
```

Open the demo at:

```text
http://localhost:8080
```

The gateway can start before the GPU inference server is running. In that case
`/api/health` returns `"gateway": "ok"` and reports the vLLM connection error;
audio generation starts working after the vLLM-Omni server is available at
`VLLM_OMNI_BASE_URL`.

If port `8080` is already in use, change the gateway port:

```bash
.venv/bin/python -m uvicorn app.main:app --host 0.0.0.0 --port 8081
```

If you prefer standard `venv` and `pip`:

```bash
python -m venv .venv
. .venv/bin/activate
python -m pip install -r requirements.txt
VLLM_OMNI_BASE_URL=http://localhost:8000 \
VOXCPM2_MODEL=openbmb/VoxCPM2 \
python -m uvicorn app.main:app --host 0.0.0.0 --port 8080
```

## Start Both Servers

This project runs as two separate services:

- vLLM-Omni server: owns GPU inference and serves VoxCPM2 at `/v1/audio/speech`
- FastAPI gateway: owns uploads, payload shaping, streaming relay, and the browser demo UI

### 1. Start vLLM-Omni

Install and run vLLM-Omni in the GPU environment. This is separate from the
lightweight gateway requirements in `requirements.txt`. Use Python 3.12 for
the vLLM-Omni environment.

```bash
uv venv .venv-vllm --python 3.12 --seed
uv pip install --python .venv-vllm/bin/python -r requirements-vllm-omni.txt --torch-backend=auto
env SETUPTOOLS_SCM_PRETEND_VERSION_FOR_VOXCPM=2.0.0 \
  uv pip install --python .venv-vllm/bin/python -e ./VoxCPM-main --index-strategy unsafe-best-match
hash -r
```

If your `nvidia-smi` reports driver 550 / CUDA 12.6, the plain `vllm==0.20.0`
PyPI wheel fails with `ImportError: libcudart.so.13`. Reinstall vLLM with the
official CUDA 12.9 wheel:

```bash
uv pip install --python .venv-vllm/bin/python --reinstall \
  'https://github.com/vllm-project/vllm/releases/download/v0.20.0/vllm-0.20.0%2Bcu129-cp38-abi3-manylinux_2_31_x86_64.whl' \
  --extra-index-url https://download.pytorch.org/whl/cu129 \
  --index-strategy unsafe-best-match
```

Check that vLLM-Omni imports cleanly and that the Omni CLI exposes
`OmniConfig`:

```bash
.venv-vllm/bin/python -m pip show vllm vllm-omni voxcpm
.venv-vllm/bin/python -c "import vllm_omni; print('vllm-omni ok')"
.venv-vllm/bin/vllm-omni serve openbmb/VoxCPM2 --omni --help=OmniConfig
```

Then launch the OpenAI-compatible VoxCPM2 speech server:

```bash
VLLM_OMNI_VOXCPM_CODE_PATH="$PWD/VoxCPM-main/src" \
.venv-vllm/bin/vllm-omni serve openbmb/VoxCPM2 --omni --host 0.0.0.0 --port 8000
```

In vLLM-Omni 0.20.0, the installed `vllm-omni` command is the reliable entry
point for Omni serving. If you run plain `vllm serve ... --omni` and get an
unrecognized-argument error, use the `vllm-omni serve ... --omni` command above.
If importing `vllm_omni` warns about mismatched versions, reinstall vLLM and
vLLM-Omni in the same active Python environment. A `vllm-omni 0.20.x` checkout
needs `vllm 0.20.x`; pairing it with `vllm 0.19.x` can fail with missing vLLM
internal symbols.

The local VoxCPM install uses `SETUPTOOLS_SCM_PRETEND_VERSION_FOR_VOXCPM`
because the bundled `VoxCPM-main` directory does not include its own `.git`
metadata. Without the local install, startup can fail with imports such as
`No module named 'voxcpm'` or `No module named 'librosa'`.

VoxCPM2 serving is OpenAI-compatible through `/v1/audio/speech`. For streaming,
the gateway sends `stream=true` and `response_format=pcm`, then relays chunks to
the browser as they arrive.

### 2. Start this FastAPI gateway and demo

Install this service. The explicit `--python` form avoids accidentally
installing into a previously active virtual environment:

```bash
uv venv
uv pip install --python .venv/bin/python -e .
```

Or with pip:

```bash
python -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
```

Run it:

```bash
VLLM_OMNI_BASE_URL=http://localhost:8000 \
VOXCPM2_MODEL=openbmb/VoxCPM2 \
.venv/bin/python -m uvicorn app.main:app --host 0.0.0.0 --port 8080
```

Open the demo at:

```text
http://localhost:8080
```

The gateway does not load model weights and does not import `vllm-omni`; it only
proxies to the running vLLM-Omni server configured by `VLLM_OMNI_BASE_URL`.

## Docker

Build a GPU image that starts both vLLM-Omni and the FastAPI gateway:

```bash
docker build -t voxcpm2-inference-server .
```

Run it with NVIDIA GPU access:

```bash
docker run --rm --gpus all \
  -p 8000:8000 -p 8080:8080 \
  -v ~/.cache/huggingface:/root/.cache/huggingface \
  voxcpm2-inference-server
```

Open the demo at:

```text
http://localhost:8080
```

The image defaults to `openbmb/VoxCPM2`, serves vLLM-Omni on port `8000`, and
serves the gateway on port `8080`. Override startup settings with environment
variables when needed:

```bash
docker run --rm --gpus all \
  -p 8000:8000 -p 8080:8080 \
  -e VOXCPM2_MODEL=openbmb/VoxCPM2 \
  -e VLLM_OMNI_ARGS="--gpu-memory-utilization 0.90" \
  -v ~/.cache/huggingface:/root/.cache/huggingface \
  voxcpm2-inference-server
```

## API

### Streaming form endpoint

`POST /api/speech/stream`

Multipart form fields:

- `input`: target text
- `model`: defaults to `openbmb/VoxCPM2`
- `mode`: `voice_design`, `controllable_cloning`, or `ultimate_cloning`
- `voice`: defaults to `default`
- `control_instruction`: prepended as `(instruction)` for voice design and controllable cloning
- `response_format`: use `pcm` for browser streaming
- `ref_audio`: uploaded reference audio for cloning
- `ref_audio_url`: reference audio URL or base64 data URI
- `prompt_audio`: uploaded continuation prompt audio for ultimate cloning
- `prompt_audio_url`: prompt audio URL or base64 data URI
- `prompt_text`: transcript of the prompt audio for ultimate cloning
- `extra_json`: optional JSON object merged into the vLLM-Omni payload

The browser demo consumes the PCM response through `fetch()` and plays the first
hearable chunk immediately via an `AudioWorklet` FIFO buffer.

### Non-streaming form endpoint

`POST /api/speech/file`

Uses the same form fields, with `stream=false`. Select `wav` in the demo for
normal browser audio playback and download.

### JSON passthrough endpoint

`POST /api/speech`

Accepts an OpenAI-compatible JSON body and forwards it to vLLM-Omni with
`stream=false`.

## Sources Checked

- [vLLM-Omni VoxCPM2 online serving docs](https://docs.vllm.ai/projects/vllm-omni/en/latest/user_guide/examples/online_serving/voxcpm2/)
- [vLLM-Omni text-to-speech online examples](https://docs.vllm.ai/projects/vllm-omni/en/latest/user_guide/examples/online_serving/text_to_speech/)
