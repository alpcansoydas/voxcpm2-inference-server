from __future__ import annotations

import base64
import json
import logging
import mimetypes
import os
from pathlib import Path
from typing import Any

import httpx
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles

logger = logging.getLogger("voxcpm2_gateway")

APP_DIR = Path(__file__).resolve().parent
STATIC_DIR = APP_DIR / "static"
ROOT_DIR = APP_DIR.parent
VOICE_PRESETS_DIR = ROOT_DIR / "voice_presets"

DEFAULT_VLLM_BASE_URL = os.getenv("VLLM_OMNI_BASE_URL", "http://localhost:8000")
DEFAULT_MODEL = os.getenv("VOXCPM2_MODEL", "openbmb/VoxCPM2")
DEFAULT_API_KEY = os.getenv("VLLM_OMNI_API_KEY", "EMPTY")
DEFAULT_VOICE = os.getenv("VOXCPM2_VOICE", "")


class VllmOmniClient:
    def __init__(self, base_url: str, api_key: str) -> None:
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key

    @property
    def speech_url(self) -> str:
        return f"{self.base_url}/v1/audio/speech"

    @property
    def headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }

    async def request_speech(self, payload: dict[str, Any], *, stream: bool) -> httpx.Response:
        client = httpx.AsyncClient(timeout=httpx.Timeout(300.0, connect=20.0))
        request = client.build_request(
            "POST",
            self.speech_url,
            json=payload,
            headers=self.headers,
        )
        try:
            response = await client.send(request, stream=stream)
        except Exception:
            await client.aclose()
            raise
        response.extensions["client"] = client
        return response


client = VllmOmniClient(DEFAULT_VLLM_BASE_URL, DEFAULT_API_KEY)
app = FastAPI(
    title="VoxCPM2 Inference Gateway",
    description="FastAPI service and streaming demo for VoxCPM2 served by vLLM-Omni.",
    version="0.1.0",
)
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
app.mount("/voice_presets", StaticFiles(directory=VOICE_PRESETS_DIR), name="voice_presets")


@app.get("/")
async def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/api/config")
async def config() -> dict[str, str | int]:
    return {
        "vllm_base_url": client.base_url,
        "default_model": DEFAULT_MODEL,
        "default_voice": DEFAULT_VOICE,
        "sample_rate": 48000,
    }


@app.get("/api/voice-presets")
async def voice_presets() -> dict[str, Any]:
    languages: dict[str, dict[str, Any]] = {}
    if not VOICE_PRESETS_DIR.exists():
        return {"languages": []}

    for wav_path in sorted(VOICE_PRESETS_DIR.glob("*/*/*.wav")):
        relative = wav_path.relative_to(VOICE_PRESETS_DIR)
        if "expressions" in relative.parts:
            continue
        mp3_path = wav_path.with_suffix(".mp3")
        language_code, voice_id = relative.parts[0], relative.parts[1]
        preset_id = str(relative.with_suffix("")).replace(os.sep, "/")
        language = languages.setdefault(
            language_code,
            {
                "code": language_code,
                "label": _language_label(language_code),
                "voices": {},
            },
        )
        voice = language["voices"].setdefault(
            voice_id,
            {
                "id": f"{language_code}/{voice_id}",
                "label": _human_label(voice_id),
                "samples": [],
            },
        )
        formats = {
            "wav": f"/voice_presets/{relative.as_posix()}",
        }
        if mp3_path.exists():
            formats["mp3"] = f"/voice_presets/{relative.with_suffix('.mp3').as_posix()}"
        voice["samples"].append(
            {
                "id": preset_id,
                "label": _sample_label(wav_path.stem),
                "formats": formats,
            }
        )

    return {
        "languages": [
            {
                **language,
                "voices": sorted(language["voices"].values(), key=lambda item: item["label"]),
            }
            for language in sorted(languages.values(), key=lambda item: item["label"])
        ]
    }


@app.get("/api/health")
async def health() -> dict[str, Any]:
    try:
        async with httpx.AsyncClient(timeout=5.0) as http:
            response = await http.get(f"{client.base_url}/health")
    except Exception as exc:
        return {
            "ok": False,
            "gateway": "ok",
            "vllm_base_url": client.base_url,
            "vllm_error": str(exc),
        }
    return {
        "ok": response.status_code < 500,
        "gateway": "ok",
        "vllm_base_url": client.base_url,
        "vllm_status_code": response.status_code,
    }


@app.post("/api/speech")
async def speech_json(request: Request) -> Response:
    payload = await request.json()
    payload.setdefault("model", DEFAULT_MODEL)
    _normalize_voice(payload)
    response_format = str(payload.get("response_format") or "wav")
    payload["stream"] = False
    payload["response_format"] = response_format
    return await _forward_non_streaming(payload, _media_type_for_format(response_format))


@app.post("/api/speech/stream")
async def speech_stream_form(
    input: str = Form(...),
    model: str = Form(DEFAULT_MODEL),
    mode: str = Form("voice_design"),
    voice: str = Form(DEFAULT_VOICE),
    control_instruction: str = Form(""),
    response_format: str = Form("pcm"),
    ref_audio_url: str = Form(""),
    preset_voice: str = Form(""),
    preset_format: str = Form("wav"),
    prompt_audio_url: str = Form(""),
    prompt_text: str = Form(""),
    cfg_value: str = Form("2.0"),
    inference_timesteps: str = Form("10"),
    min_len: str = Form("2"),
    max_len: str = Form("4096"),
    normalize: bool = Form(False),
    denoise: bool = Form(False),
    retry_badcase: bool = Form(True),
    retry_badcase_max_times: str = Form("3"),
    retry_badcase_ratio_threshold: str = Form("6.0"),
    extra_json: str = Form(""),
    ref_audio: UploadFile | None = File(None),
    prompt_audio: UploadFile | None = File(None),
) -> StreamingResponse:
    payload = await _build_payload_from_form(
        input_text=input,
        model=model,
        mode=mode,
        voice=voice,
        control_instruction=control_instruction,
        response_format=response_format,
        stream=True,
        ref_audio_url=ref_audio_url,
        preset_voice=preset_voice,
        preset_format=preset_format,
        prompt_audio_url=prompt_audio_url,
        prompt_text=prompt_text,
        cfg_value=cfg_value,
        inference_timesteps=inference_timesteps,
        min_len=min_len,
        max_len=max_len,
        normalize=normalize,
        denoise=denoise,
        retry_badcase=retry_badcase,
        retry_badcase_max_times=retry_badcase_max_times,
        retry_badcase_ratio_threshold=retry_badcase_ratio_threshold,
        extra_json=extra_json,
        ref_audio=ref_audio,
        prompt_audio=prompt_audio,
    )
    return await _forward_streaming(payload, _media_type_for_format(response_format))


@app.post("/api/speech/file")
async def speech_file_form(
    input: str = Form(...),
    model: str = Form(DEFAULT_MODEL),
    mode: str = Form("voice_design"),
    voice: str = Form(DEFAULT_VOICE),
    control_instruction: str = Form(""),
    response_format: str = Form("wav"),
    ref_audio_url: str = Form(""),
    preset_voice: str = Form(""),
    preset_format: str = Form("wav"),
    prompt_audio_url: str = Form(""),
    prompt_text: str = Form(""),
    cfg_value: str = Form("2.0"),
    inference_timesteps: str = Form("10"),
    min_len: str = Form("2"),
    max_len: str = Form("4096"),
    normalize: bool = Form(False),
    denoise: bool = Form(False),
    retry_badcase: bool = Form(True),
    retry_badcase_max_times: str = Form("3"),
    retry_badcase_ratio_threshold: str = Form("6.0"),
    extra_json: str = Form(""),
    ref_audio: UploadFile | None = File(None),
    prompt_audio: UploadFile | None = File(None),
) -> Response:
    payload = await _build_payload_from_form(
        input_text=input,
        model=model,
        mode=mode,
        voice=voice,
        control_instruction=control_instruction,
        response_format=response_format,
        stream=False,
        ref_audio_url=ref_audio_url,
        preset_voice=preset_voice,
        preset_format=preset_format,
        prompt_audio_url=prompt_audio_url,
        prompt_text=prompt_text,
        cfg_value=cfg_value,
        inference_timesteps=inference_timesteps,
        min_len=min_len,
        max_len=max_len,
        normalize=normalize,
        denoise=denoise,
        retry_badcase=retry_badcase,
        retry_badcase_max_times=retry_badcase_max_times,
        retry_badcase_ratio_threshold=retry_badcase_ratio_threshold,
        extra_json=extra_json,
        ref_audio=ref_audio,
        prompt_audio=prompt_audio,
    )
    return await _forward_non_streaming(payload, _media_type_for_format(response_format))


async def _build_payload_from_form(
    *,
    input_text: str,
    model: str,
    mode: str,
    voice: str,
    control_instruction: str,
    response_format: str,
    stream: bool,
    ref_audio_url: str,
    preset_voice: str,
    preset_format: str,
    prompt_audio_url: str,
    prompt_text: str,
    cfg_value: str,
    inference_timesteps: str,
    min_len: str,
    max_len: str,
    normalize: bool,
    denoise: bool,
    retry_badcase: bool,
    retry_badcase_max_times: str,
    retry_badcase_ratio_threshold: str,
    extra_json: str,
    ref_audio: UploadFile | None,
    prompt_audio: UploadFile | None,
) -> dict[str, Any]:
    text = input_text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="input text is required")

    mode = mode.strip() or "voice_design"
    control = control_instruction.strip()
    final_text = f"({control}){text}" if control and mode != "ultimate_cloning" else text

    payload: dict[str, Any] = {
        "model": model.strip() or DEFAULT_MODEL,
        "input": final_text,
        "response_format": response_format.strip() or ("pcm" if stream else "wav"),
        "stream": stream,
    }
    normalized_voice = _normalized_voice(voice)
    if normalized_voice:
        payload["voice"] = normalized_voice

    ref_audio_value = ""
    if preset_voice.strip():
        ref_audio_value = _preset_to_data_uri(preset_voice, preset_format)
    if not ref_audio_value:
        ref_audio_value = ref_audio_url.strip()
    if not ref_audio_value and ref_audio is not None and ref_audio.filename:
        ref_audio_value = await _upload_to_data_uri(ref_audio)
    if ref_audio_value:
        payload["ref_audio"] = ref_audio_value

    if mode == "ultimate_cloning":
        prompt_audio_value = prompt_audio_url.strip()
        if not prompt_audio_value and prompt_audio is not None and prompt_audio.filename:
            prompt_audio_value = await _upload_to_data_uri(prompt_audio)
        if not prompt_audio_value:
            prompt_audio_value = ref_audio_value
        if prompt_audio_value:
            payload["prompt_audio"] = prompt_audio_value
        if prompt_text.strip():
            payload["prompt_text"] = prompt_text.strip()

    payload.update(
        _build_inference_params(
            cfg_value=cfg_value,
            inference_timesteps=inference_timesteps,
            min_len=min_len,
            max_len=max_len,
            normalize=normalize,
            denoise=denoise,
            retry_badcase=retry_badcase,
            retry_badcase_max_times=retry_badcase_max_times,
            retry_badcase_ratio_threshold=retry_badcase_ratio_threshold,
        )
    )

    if extra_json.strip():
        try:
            extra = json.loads(extra_json)
        except json.JSONDecodeError as exc:
            raise HTTPException(status_code=400, detail=f"extra_json is invalid JSON: {exc}") from exc
        if not isinstance(extra, dict):
            raise HTTPException(status_code=400, detail="extra_json must be a JSON object")
        payload.update(extra)
        payload["stream"] = stream
        payload.setdefault("response_format", response_format)

    return payload


def _build_inference_params(
    *,
    cfg_value: str,
    inference_timesteps: str,
    min_len: str,
    max_len: str,
    normalize: bool,
    denoise: bool,
    retry_badcase: bool,
    retry_badcase_max_times: str,
    retry_badcase_ratio_threshold: str,
) -> dict[str, Any]:
    parsed_min_len = _parse_int(min_len, "min_len", minimum=0, maximum=8192)
    parsed_max_len = _parse_int(max_len, "max_len", minimum=1, maximum=8192)
    if parsed_min_len > parsed_max_len:
        raise HTTPException(status_code=400, detail="min_len must be less than or equal to max_len")

    return {
        "cfg_value": _parse_float(cfg_value, "cfg_value", minimum=0.1, maximum=10.0),
        "inference_timesteps": _parse_int(
            inference_timesteps, "inference_timesteps", minimum=1, maximum=100
        ),
        "min_len": parsed_min_len,
        "max_len": parsed_max_len,
        "normalize": normalize,
        "denoise": denoise,
        "retry_badcase": retry_badcase,
        "retry_badcase_max_times": _parse_int(
            retry_badcase_max_times, "retry_badcase_max_times", minimum=0, maximum=20
        ),
        "retry_badcase_ratio_threshold": _parse_float(
            retry_badcase_ratio_threshold,
            "retry_badcase_ratio_threshold",
            minimum=0.1,
            maximum=100.0,
        ),
    }


def _parse_float(value: str, field_name: str, *, minimum: float, maximum: float) -> float:
    try:
        parsed = float(value)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=f"{field_name} must be a number") from exc
    if parsed < minimum or parsed > maximum:
        raise HTTPException(
            status_code=400,
            detail=f"{field_name} must be between {minimum:g} and {maximum:g}",
        )
    return parsed


def _parse_int(value: str, field_name: str, *, minimum: int, maximum: int) -> int:
    try:
        parsed = int(value)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=f"{field_name} must be an integer") from exc
    if parsed < minimum or parsed > maximum:
        raise HTTPException(
            status_code=400,
            detail=f"{field_name} must be between {minimum} and {maximum}",
        )
    return parsed


def _normalized_voice(voice: str | None) -> str:
    normalized = (voice or DEFAULT_VOICE).strip()
    if normalized.lower() in {"", "default", "none"}:
        return ""
    return normalized


def _normalize_voice(payload: dict[str, Any]) -> None:
    voice = _normalized_voice(str(payload.get("voice") or ""))
    if voice:
        payload["voice"] = voice
    else:
        payload.pop("voice", None)


def _preset_to_data_uri(preset_voice: str, preset_format: str) -> str:
    normalized_format = preset_format.lower().strip() or "wav"
    if normalized_format not in {"wav", "mp3"}:
        raise HTTPException(status_code=400, detail="preset_format must be wav or mp3")

    preset_id = preset_voice.strip().replace("\\", "/")
    if not preset_id:
        return ""
    if preset_id.endswith((".wav", ".mp3")):
        preset_id = str(Path(preset_id).with_suffix(""))

    candidate = (VOICE_PRESETS_DIR / f"{preset_id}.{normalized_format}").resolve()
    try:
        candidate.relative_to(VOICE_PRESETS_DIR.resolve())
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="preset_voice is invalid") from exc
    if not candidate.is_file():
        raise HTTPException(status_code=400, detail=f"preset voice not found: {preset_voice}.{normalized_format}")

    content_type = "audio/mpeg" if normalized_format == "mp3" else "audio/wav"
    encoded = base64.b64encode(candidate.read_bytes()).decode("ascii")
    return f"data:{content_type};base64,{encoded}"


def _language_label(code: str) -> str:
    labels = {
        "ar": "Arabic",
        "de": "German",
        "en": "English",
        "es": "Spanish",
        "fr": "French",
        "hu": "Hungarian",
        "it": "Italian",
        "ja": "Japanese",
        "pl": "Polish",
        "pt": "Portuguese",
        "ru": "Russian",
        "tr": "Turkish",
        "zh": "Chinese",
    }
    return labels.get(code, code.upper())


def _human_label(value: str) -> str:
    return value.replace("_", " ").strip().title()


def _sample_label(stem: str) -> str:
    parts = stem.split("_")
    if parts and len(parts[-1]) > 1:
        return _human_label(parts[-1])
    return _human_label(stem)


async def _upload_to_data_uri(upload: UploadFile) -> str:
    data = await upload.read()
    if not data:
        raise HTTPException(status_code=400, detail=f"{upload.filename or 'audio upload'} is empty")
    content_type = upload.content_type
    if not content_type or content_type == "application/octet-stream":
        guessed, _ = mimetypes.guess_type(upload.filename or "")
        content_type = guessed or "audio/wav"
    encoded = base64.b64encode(data).decode("ascii")
    return f"data:{content_type};base64,{encoded}"


async def _forward_streaming(payload: dict[str, Any], media_type: str) -> StreamingResponse:
    try:
        response = await client.request_speech(payload, stream=True)
    except Exception as exc:
        logger.exception("vLLM-Omni streaming request failed")
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    owning_client: httpx.AsyncClient = response.extensions["client"]
    if response.status_code >= 400:
        content = await response.aread()
        await response.aclose()
        await owning_client.aclose()
        raise HTTPException(status_code=response.status_code, detail=content.decode(errors="replace"))

    async def relay():
        try:
            async for chunk in response.aiter_bytes():
                if chunk:
                    yield chunk
        finally:
            await response.aclose()
            await owning_client.aclose()

    return StreamingResponse(relay(), media_type=media_type)


async def _forward_non_streaming(payload: dict[str, Any], media_type: str) -> Response:
    try:
        response = await client.request_speech(payload, stream=False)
    except Exception as exc:
        logger.exception("vLLM-Omni speech request failed")
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    owning_client: httpx.AsyncClient = response.extensions["client"]
    try:
        content = await response.aread()
    finally:
        await response.aclose()
        await owning_client.aclose()

    if response.status_code >= 400:
        raise HTTPException(status_code=response.status_code, detail=content.decode(errors="replace"))
    return Response(content=content, media_type=media_type)


def _media_type_for_format(response_format: str) -> str:
    normalized = response_format.lower().strip()
    if normalized == "pcm":
        return "audio/L16;rate=48000;channels=1"
    if normalized == "mp3":
        return "audio/mpeg"
    if normalized == "flac":
        return "audio/flac"
    return "audio/wav"
