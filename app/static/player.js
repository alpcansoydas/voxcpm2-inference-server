const SAMPLE_RATE = 48000;

const workletSource = `
class VoxCPM2PlaybackProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];
    this.current = null;
    this.offset = 0;
    this.playing = false;
    this.port.onmessage = (event) => {
      if (event.data && event.data.type === "clear") {
        this.queue = [];
        this.current = null;
        this.offset = 0;
        this.playing = false;
        return;
      }
      this.queue.push(event.data);
    };
  }

  process(_inputs, outputs) {
    const out = outputs[0][0];
    for (let i = 0; i < out.length; i += 1) {
      if (!this.current || this.offset >= this.current.length) {
        if (this.queue.length === 0) {
          out.fill(0, i);
          if (this.playing) {
            this.playing = false;
            this.port.postMessage({ type: "drained" });
          }
          return true;
        }
        this.current = this.queue.shift();
        this.offset = 0;
      }
      out[i] = this.current[this.offset] / 32768;
      this.offset += 1;
    }
    if (!this.playing) {
      this.playing = true;
      this.port.postMessage({ type: "playing" });
    }
    return true;
  }
}
registerProcessor("voxcpm2-playback-processor", VoxCPM2PlaybackProcessor);
`;

const form = document.getElementById("speechForm");
const modeInput = document.getElementById("modeInput");
const modeTabs = Array.from(document.querySelectorAll(".mode-tab"));
const modePanels = Array.from(document.querySelectorAll(".mode-panel"));
const formatInput = document.getElementById("formatInput");
const deliverySelect = document.getElementById("deliverySelect");
const stopBtn = document.getElementById("stopBtn");
const generateBtn = document.getElementById("generateBtn");
const logEl = document.getElementById("log");
const fileAudio = document.getElementById("fileAudio");
const downloadLink = document.getElementById("downloadLink");
const presetPickers = Array.from(document.querySelectorAll(".preset-picker"));

let audioContext;
let playbackNode;
let fallbackQueue = [];
let fallbackCurrent;
let fallbackOffset = 0;
let fallbackPlaying = false;
let abortController;
let objectUrl;
let stats = resetStats();
let streamedChunks = [];
let presetLanguages = [];

function resetStats() {
  return {
    startedAt: 0,
    firstChunkAt: 0,
    streamEndedAt: 0,
    chunks: 0,
    samples: 0,
  };
}

function formatMs(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return "-";
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`;
}

function log(message) {
  const now = new Date().toLocaleTimeString();
  logEl.textContent = `[${now}] ${message}\n${logEl.textContent}`;
}

function setPlaybackState(text, color = "#a6adb1") {
  document.getElementById("playbackState").textContent = text;
  document.getElementById("playbackDot").style.background = color;
}

function renderStats(final = false) {
  if (!stats.startedAt) return;
  const elapsedMs = final && stats.streamEndedAt
    ? stats.streamEndedAt - stats.startedAt
    : performance.now() - stats.startedAt;
  const audioSeconds = stats.samples / SAMPLE_RATE;
  document.getElementById("chunks").textContent = String(stats.chunks);
  document.getElementById("duration").textContent = `${audioSeconds.toFixed(1)}s`;
  document.getElementById("ttfb").textContent = stats.firstChunkAt
    ? formatMs(stats.firstChunkAt - stats.startedAt)
    : "-";
  document.getElementById("totalLatency").textContent = final ? formatMs(elapsedMs) : "-";
  if (audioSeconds > 0 && elapsedMs > 0) {
    const rtf = elapsedMs / 1000 / audioSeconds;
    document.getElementById("rtf").textContent = `${rtf.toFixed(2)}x`;
    document.getElementById("progressBar").style.width = `${Math.min((1 / rtf) * 50, 100)}%`;
  }
}

function resetMetricDisplay() {
  document.getElementById("chunks").textContent = "0";
  document.getElementById("duration").textContent = "0.0s";
  document.getElementById("ttfb").textContent = "-";
  document.getElementById("totalLatency").textContent = "-";
  document.getElementById("rtf").textContent = "-";
  document.getElementById("progressBar").style.width = "0%";
}

async function ensureAudio() {
  if (audioContext && playbackNode) {
    if (audioContext.state === "suspended") await audioContext.resume();
    return;
  }

  audioContext = new AudioContext({ sampleRate: SAMPLE_RATE });
  if (
    audioContext.audioWorklet &&
    typeof audioContext.audioWorklet.addModule === "function" &&
    typeof AudioWorkletNode !== "undefined"
  ) {
    const blob = new Blob([workletSource], { type: "application/javascript" });
    const url = URL.createObjectURL(blob);
    try {
      await audioContext.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }

    playbackNode = new AudioWorkletNode(audioContext, "voxcpm2-playback-processor");
    playbackNode.connect(audioContext.destination);
    playbackNode.port.onmessage = (event) => {
      if (event.data.type === "playing") setPlaybackState("Playing", "#0b7f7a");
      if (event.data.type === "drained" && !abortController) setPlaybackState("Done", "#0b7f7a");
    };
    return;
  }

  playbackNode = audioContext.createScriptProcessor(4096, 0, 1);
  playbackNode.onaudioprocess = (event) => {
    const out = event.outputBuffer.getChannelData(0);
    for (let i = 0; i < out.length; i += 1) {
      if (!fallbackCurrent || fallbackOffset >= fallbackCurrent.length) {
        if (fallbackQueue.length === 0) {
          out.fill(0, i);
          if (fallbackPlaying) {
            fallbackPlaying = false;
            if (!abortController) setPlaybackState("Done", "#0b7f7a");
          }
          return;
        }
        fallbackCurrent = fallbackQueue.shift();
        fallbackOffset = 0;
      }
      out[i] = fallbackCurrent[fallbackOffset] / 32768;
      fallbackOffset += 1;
    }
    if (!fallbackPlaying) {
      fallbackPlaying = true;
      setPlaybackState("Playing", "#0b7f7a");
    }
  };
  playbackNode.connect(audioContext.destination);
}

function clearPlayback() {
  if (playbackNode && playbackNode.port) playbackNode.port.postMessage({ type: "clear" });
  fallbackQueue = [];
  fallbackCurrent = undefined;
  fallbackOffset = 0;
  fallbackPlaying = false;
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = undefined;
  fileAudio.hidden = true;
  fileAudio.removeAttribute("src");
  downloadLink.hidden = true;
  downloadLink.removeAttribute("href");
  resetMetricDisplay();
}

function enqueuePcm(pcm) {
  if (playbackNode.port) {
    playbackNode.port.postMessage(pcm);
  } else {
    fallbackQueue.push(pcm);
  }
}

function wavBlobFromPcmChunks(chunks) {
  const dataLength = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const buffer = new ArrayBuffer(44 + dataLength);
  const view = new DataView(buffer);
  let offset = 0;

  function writeString(value) {
    for (let i = 0; i < value.length; i += 1) {
      view.setUint8(offset, value.charCodeAt(i));
      offset += 1;
    }
  }

  writeString("RIFF");
  view.setUint32(offset, 36 + dataLength, true); offset += 4;
  writeString("WAVE");
  writeString("fmt ");
  view.setUint32(offset, 16, true); offset += 4;
  view.setUint16(offset, 1, true); offset += 2;
  view.setUint16(offset, 1, true); offset += 2;
  view.setUint32(offset, SAMPLE_RATE, true); offset += 4;
  view.setUint32(offset, SAMPLE_RATE * 2, true); offset += 4;
  view.setUint16(offset, 2, true); offset += 2;
  view.setUint16(offset, 16, true); offset += 2;
  writeString("data");
  view.setUint32(offset, dataLength, true); offset += 4;

  const bytes = new Uint8Array(buffer, 44);
  let writeOffset = 0;
  chunks.forEach((chunk) => {
    bytes.set(chunk, writeOffset);
    writeOffset += chunk.byteLength;
  });

  return new Blob([buffer], { type: "audio/wav" });
}

function showDownload(blob, filename) {
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = URL.createObjectURL(blob);
  fileAudio.src = objectUrl;
  fileAudio.hidden = false;
  downloadLink.href = objectUrl;
  downloadLink.download = filename;
  downloadLink.hidden = false;
}

async function playStreaming(formData) {
  await ensureAudio();
  clearPlayback();
  abortController = new AbortController();
  stats = resetStats();
  streamedChunks = [];
  stats.startedAt = performance.now();
  generateBtn.disabled = true;
  setPlaybackState("Connecting", "#b25e09");
  log("Streaming request started.");

  const response = await fetch("/api/speech/stream", {
    method: "POST",
    body: formData,
    signal: abortController.signal,
  });

  if (!response.ok) throw new Error(await response.text());
  if (!response.body) throw new Error("Browser did not expose a streaming response body.");

  setPlaybackState("Streaming", "#0b7f7a");
  const reader = response.body.getReader();
  let carry = new Uint8Array(0);

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value || value.length === 0) continue;

    const raw = new Uint8Array(carry.length + value.length);
    raw.set(carry);
    raw.set(value, carry.length);

    const usableLength = raw.length - (raw.length % 2);
    carry = usableLength < raw.length ? raw.slice(usableLength) : new Uint8Array(0);
    if (usableLength === 0) continue;

    const pcmBuffer = new ArrayBuffer(usableLength);
    new Uint8Array(pcmBuffer).set(raw.subarray(0, usableLength));
    const pcm = new Int16Array(pcmBuffer);
    streamedChunks.push(new Uint8Array(pcmBuffer.slice(0)));
    enqueuePcm(pcm);

    stats.chunks += 1;
    stats.samples += pcm.length;
    if (!stats.firstChunkAt) {
      stats.firstChunkAt = performance.now();
      log("First playable audio chunk received.");
    }
    renderStats(false);
  }

  stats.streamEndedAt = performance.now();
  if (streamedChunks.length > 0) {
    showDownload(wavBlobFromPcmChunks(streamedChunks), "voxcpm2-stream.wav");
  }
  abortController = undefined;
  setPlaybackState("Finishing playback", "#0b7f7a");
  renderStats(true);
  log("Stream completed. Final WAV is ready to download.");
}

async function playFile(formData) {
  clearPlayback();
  abortController = new AbortController();
  stats = resetStats();
  stats.startedAt = performance.now();
  generateBtn.disabled = true;
  setPlaybackState("Generating file", "#b25e09");
  log("Non-streaming request started.");

  const response = await fetch("/api/speech/file", {
    method: "POST",
    body: formData,
    signal: abortController.signal,
  });
  if (!response.ok) throw new Error(await response.text());
  stats.firstChunkAt = performance.now();

  const blob = await response.blob();
  stats.streamEndedAt = performance.now();
  showDownload(blob, "voxcpm2-output.wav");
  fileAudio.play().catch(() => {});
  abortController = undefined;
  setPlaybackState("Playing file", "#0b7f7a");
  renderStats(true);
  log("Audio file received.");
}

function forceActiveFields(formData) {
  const activePanel = document.querySelector(".mode-panel.active");
  if (!activePanel) return;

  const targetText = activePanel.querySelector("textarea[name='input']");
  if (targetText) formData.set("input", targetText.value);

  const control = activePanel.querySelector("[name='control_instruction']");
  formData.delete("control_instruction");
  if (control && !control.disabled) formData.set("control_instruction", control.value);

  ["preset_voice", "preset_format", "ref_audio", "ref_audio_url", "prompt_audio", "prompt_audio_url", "prompt_text"].forEach((name) => {
    formData.delete(name);
    const field = activePanel.querySelector(`[name='${name}']`);
    if (field && !field.disabled) {
      const value = field.type === "file" ? field.files[0] : field.value;
      if (value) formData.set(name, value);
    }
  });
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const formData = new FormData(form);
  forceActiveFields(formData);
  const shouldStream = deliverySelect.value === "stream";
  const responseFormat = shouldStream ? "pcm" : "wav";
  formatInput.value = responseFormat;
  formData.set("response_format", responseFormat);

  try {
    if (shouldStream) await playStreaming(formData);
    else await playFile(formData);
  } catch (error) {
    if (error.name !== "AbortError") {
      setPlaybackState("Error", "#b42318");
      if (error instanceof TypeError && error.message === "Failed to fetch") {
        log("Request failed before the gateway responded. Check that the FastAPI server is still running and refresh the page.");
      } else {
        log(error.message || String(error));
      }
    }
  } finally {
    generateBtn.disabled = false;
  }
});

stopBtn.addEventListener("click", () => {
  if (abortController) {
    abortController.abort();
    abortController = undefined;
  }
  if (playbackNode && playbackNode.port) playbackNode.port.postMessage({ type: "clear" });
  fallbackQueue = [];
  fallbackCurrent = undefined;
  fallbackOffset = 0;
  fallbackPlaying = false;
  setPlaybackState("Stopped", "#667075");
  log("Playback stopped.");
});

function setMode(mode) {
  modeInput.value = mode;
  modeTabs.forEach((tab) => {
    const active = tab.dataset.mode === mode;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-pressed", String(active));
  });
  modePanels.forEach((panel) => {
    const active = panel.dataset.modePanel === mode;
    panel.hidden = !active;
    panel.setAttribute("aria-hidden", String(!active));
    panel.classList.toggle("active", active);
    panel.querySelectorAll("input, textarea, select").forEach((field) => {
      field.disabled = !active;
    });
    if (active) {
      panel.querySelectorAll(".preset-picker").forEach(syncPresetPickerState);
    }
  });
  clearPlayback();
  setPlaybackState("Ready", "#a6adb1");
}

deliverySelect.addEventListener("change", () => {
  formatInput.value = deliverySelect.value === "stream" ? "pcm" : "wav";
});

modeTabs.forEach((tab) => {
  tab.addEventListener("click", () => setMode(tab.dataset.mode));
});

function setSelectOptions(select, items, placeholder, valueField = "id") {
  select.innerHTML = "";
  const empty = document.createElement("option");
  empty.value = "";
  empty.textContent = placeholder;
  select.appendChild(empty);
  items.forEach((item) => {
    const option = document.createElement("option");
    option.value = item[valueField];
    option.textContent = item.label;
    select.appendChild(option);
  });
}

function findPresetSelection(picker) {
  const languageSelect = picker.querySelector("[data-preset-language]");
  const voiceSelect = picker.querySelector("[data-preset-voice]");
  const sampleSelect = picker.querySelector("[data-preset-sample]");
  const language = presetLanguages.find((item) => item.code === languageSelect.value);
  const voice = language ? language.voices.find((item) => item.id === voiceSelect.value) : undefined;
  const sample = voice ? voice.samples.find((item) => item.id === sampleSelect.value) : undefined;
  return { language, voice, sample };
}

function updatePresetPreview(picker) {
  const formatSelect = picker.querySelector("[data-preset-format]");
  const presetValue = picker.querySelector("[data-preset-value]");
  const preview = picker.querySelector("[data-preset-preview]");
  const { sample } = findPresetSelection(picker);

  presetValue.value = sample ? sample.id : "";
  formatSelect.disabled = !sample;
  preview.hidden = !sample;
  if (!sample) {
    preview.removeAttribute("src");
    return;
  }

  if (!sample.formats[formatSelect.value]) {
    formatSelect.value = sample.formats.mp3 ? "mp3" : "wav";
  }
  preview.src = sample.formats[formatSelect.value];
}

function syncPresetPickerState(picker) {
  const voiceSelect = picker.querySelector("[data-preset-voice]");
  const sampleSelect = picker.querySelector("[data-preset-sample]");
  const { language, voice } = findPresetSelection(picker);
  voiceSelect.disabled = !language;
  sampleSelect.disabled = !voice;
  updatePresetPreview(picker);
}

function populateSamples(picker) {
  const sampleSelect = picker.querySelector("[data-preset-sample]");
  const { voice } = findPresetSelection(picker);
  setSelectOptions(sampleSelect, voice ? voice.samples : [], "Select sample");
  sampleSelect.disabled = !voice;
  if (voice && voice.samples.length > 0) sampleSelect.value = voice.samples[0].id;
  updatePresetPreview(picker);
}

function populateVoices(picker) {
  const voiceSelect = picker.querySelector("[data-preset-voice]");
  const { language } = findPresetSelection(picker);
  setSelectOptions(voiceSelect, language ? language.voices : [], "Select voice");
  voiceSelect.disabled = !language;
  if (language && language.voices.length > 0) voiceSelect.value = language.voices[0].id;
  populateSamples(picker);
}

function setupPresetPicker(picker) {
  const languageSelect = picker.querySelector("[data-preset-language]");
  const voiceSelect = picker.querySelector("[data-preset-voice]");
  const sampleSelect = picker.querySelector("[data-preset-sample]");
  const formatSelect = picker.querySelector("[data-preset-format]");

  setSelectOptions(languageSelect, presetLanguages, "Upload or URL", "code");
  languageSelect.addEventListener("change", () => populateVoices(picker));
  voiceSelect.addEventListener("change", () => populateSamples(picker));
  sampleSelect.addEventListener("change", () => updatePresetPreview(picker));
  formatSelect.addEventListener("change", () => updatePresetPreview(picker));
}

async function loadVoicePresets() {
  try {
    const response = await fetch("/api/voice-presets");
    if (!response.ok) throw new Error(await response.text());
    const payload = await response.json();
    presetLanguages = payload.languages || [];
    presetPickers.forEach(setupPresetPicker);
  } catch (error) {
    log(`Voice presets unavailable: ${error.message || String(error)}`);
  }
}

async function loadConfig() {
  try {
    const response = await fetch("/api/config");
    const config = await response.json();
    document.getElementById("modelInput").value = config.default_model;
    document.getElementById("voiceInput").value = config.default_voice || "";
    document.getElementById("serverStatus").textContent = config.vllm_base_url;
  } catch {
    document.getElementById("serverStatus").textContent = "Gateway config unavailable";
  }

  try {
    const response = await fetch("/api/health");
    const health = await response.json();
    document.getElementById("serverStatus").textContent = health.ok
      ? `vLLM ready at ${health.vllm_base_url}`
      : `Gateway ready, vLLM unavailable`;
  } catch {
    document.getElementById("serverStatus").textContent = "Health check failed";
  }
}

setMode(modeInput.value);
loadVoicePresets();
loadConfig();
