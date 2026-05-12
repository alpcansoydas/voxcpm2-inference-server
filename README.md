# VoxCPM2 Inference Server

FastAPI gateway and browser demo UI for VoxCPM2 served by
[vLLM-Omni](https://github.com/vllm-project/vllm-omni).

The gateway keeps model execution in vLLM-Omni and exposes a small app-owned API
for voice design, controllable voice cloning, ultimate cloning, non-streaming WAV
generation, and raw PCM streaming playback.

## Start Both Servers

This project runs as two separate services:

- vLLM-Omni server: owns GPU inference and serves VoxCPM2 at `/v1/audio/speech`
- FastAPI gateway: owns uploads, payload shaping, streaming relay, and the browser demo UI

### 1. Start vLLM-Omni

Install and run vLLM-Omni in the GPU environment. This is separate from the
lightweight gateway requirements in `requirements.txt`.

```bash
uv pip install -r requirements-vllm-omni.txt --torch-backend=auto
git clone https://github.com/vllm-project/vllm-omni.git
cd vllm-omni
uv pip install -e . --no-build-isolation
hash -r
```

Check that vLLM-Omni imports cleanly and that the `--omni` CLI flag is
registered before starting the server:

```bash
python -m pip show vllm vllm-omni
python -c "import vllm_omni; print('vllm-omni ok')"
vllm serve --help | grep omni
```

Then launch the OpenAI-compatible VoxCPM2 speech server:

```bash
vllm serve openbmb/VoxCPM2 --omni --host 0.0.0.0 --port 8000
```

If `--omni` is unrecognized, or importing `vllm_omni` warns about mismatched
versions, reinstall vLLM and vLLM-Omni in the same active Python environment.
For example, a `vllm-omni 0.20.x` checkout needs `vllm 0.20.x`; pairing it with
`vllm 0.19.x` can fail with missing vLLM internal symbols.

VoxCPM2 serving is OpenAI-compatible through `/v1/audio/speech`. For streaming,
the gateway sends `stream=true` and `response_format=pcm`, then relays chunks to
the browser as they arrive.

### 2. Start this FastAPI gateway and demo

Install this service:

```bash
uv venv
source .venv/bin/activate
uv pip install -e .
```

Or with pip:

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

Run it:

```bash
VLLM_OMNI_BASE_URL=http://localhost:8000 \
VOXCPM2_MODEL=openbmb/VoxCPM2 \
uvicorn app.main:app --host 0.0.0.0 --port 8080 --reload
```

Open the demo at:

```text
http://localhost:8080
```

The gateway does not load model weights and does not import `vllm-omni`; it only
proxies to the running vLLM-Omni server configured by `VLLM_OMNI_BASE_URL`.

## Docker

Build a lightweight gateway image:

```bash
docker build -t voxcpm2-gateway .
```

Run it against a vLLM-Omni server reachable from the container:

```bash
docker run --rm -p 8080:8080 \
  -e VLLM_OMNI_BASE_URL=http://host.docker.internal:8000 \
  voxcpm2-gateway
```

On Linux, replace `host.docker.internal` with the host IP or run with an
appropriate Docker network.

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
