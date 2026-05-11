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
const modeSelect = document.getElementById("modeSelect");
const ultimateFields = document.getElementById("ultimateFields");
const formatSelect = document.getElementById("formatSelect");
const deliverySelect = document.getElementById("deliverySelect");
const stopBtn = document.getElementById("stopBtn");
const generateBtn = document.getElementById("generateBtn");
const logEl = document.getElementById("log");
const fileAudio = document.getElementById("fileAudio");
const downloadLink = document.getElementById("downloadLink");

let audioContext;
let playbackNode;
let abortController;
let objectUrl;
let stats = resetStats();

function resetStats() {
  return {
    startedAt: 0,
    firstChunkAt: 0,
    streamEndedAt: 0,
    chunks: 0,
    samples: 0,
  };
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
  const elapsedMs = final && stats.streamEndedAt
    ? stats.streamEndedAt - stats.startedAt
    : performance.now() - stats.startedAt;
  const audioSeconds = stats.samples / SAMPLE_RATE;
  document.getElementById("chunks").textContent = String(stats.chunks);
  document.getElementById("duration").textContent = `${audioSeconds.toFixed(1)}s`;
  document.getElementById("ttfp").textContent = stats.firstChunkAt
    ? `${Math.round(stats.firstChunkAt - stats.startedAt)}ms`
    : "-";
  if (audioSeconds > 0 && elapsedMs > 0) {
    const rtf = elapsedMs / 1000 / audioSeconds;
    document.getElementById("rtf").textContent = `${rtf.toFixed(2)}x`;
    document.getElementById("progressBar").style.width = `${Math.min((1 / rtf) * 50, 100)}%`;
  }
}

async function ensureAudio() {
  if (audioContext && playbackNode) {
    if (audioContext.state === "suspended") await audioContext.resume();
    return;
  }

  audioContext = new AudioContext({ sampleRate: SAMPLE_RATE });
  const blob = new Blob([workletSource], { type: "application/javascript" });
  const url = URL.createObjectURL(blob);
  await audioContext.audioWorklet.addModule(url);
  URL.revokeObjectURL(url);

  playbackNode = new AudioWorkletNode(audioContext, "voxcpm2-playback-processor");
  playbackNode.connect(audioContext.destination);
  playbackNode.port.onmessage = (event) => {
    if (event.data.type === "playing") setPlaybackState("Playing", "#0b7f7a");
    if (event.data.type === "drained" && !abortController) setPlaybackState("Done", "#0b7f7a");
  };
}

function clearPlayback() {
  if (playbackNode) playbackNode.port.postMessage({ type: "clear" });
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = undefined;
  fileAudio.hidden = true;
  fileAudio.removeAttribute("src");
  downloadLink.hidden = true;
  downloadLink.removeAttribute("href");
  document.getElementById("progressBar").style.width = "0%";
}

async function playStreaming(formData) {
  await ensureAudio();
  clearPlayback();
  abortController = new AbortController();
  stats = resetStats();
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
    playbackNode.port.postMessage(pcm);

    stats.chunks += 1;
    stats.samples += pcm.length;
    if (!stats.firstChunkAt) {
      stats.firstChunkAt = performance.now();
      log("First playable audio chunk received.");
    }
    renderStats(false);
  }

  stats.streamEndedAt = performance.now();
  abortController = undefined;
  setPlaybackState("Finishing playback", "#0b7f7a");
  renderStats(true);
  log("Stream completed.");
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

  const blob = await response.blob();
  objectUrl = URL.createObjectURL(blob);
  fileAudio.src = objectUrl;
  fileAudio.hidden = false;
  downloadLink.href = objectUrl;
  downloadLink.hidden = false;
  await fileAudio.play();
  abortController = undefined;
  setPlaybackState("Playing file", "#0b7f7a");
  log("Audio file received.");
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const formData = new FormData(form);
  const shouldStream = deliverySelect.value === "stream";
  if (shouldStream && formatSelect.value !== "pcm") {
    formData.set("response_format", "pcm");
    formatSelect.value = "pcm";
    log("Streaming playback uses PCM, so the response format was set to PCM.");
  }

  try {
    if (shouldStream) await playStreaming(formData);
    else await playFile(formData);
  } catch (error) {
    if (error.name !== "AbortError") {
      setPlaybackState("Error", "#b42318");
      log(error.message || String(error));
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
  if (playbackNode) playbackNode.port.postMessage({ type: "clear" });
  setPlaybackState("Stopped", "#667075");
  log("Playback stopped.");
});

modeSelect.addEventListener("change", () => {
  ultimateFields.hidden = modeSelect.value !== "ultimate_cloning";
});

deliverySelect.addEventListener("change", () => {
  if (deliverySelect.value === "stream") {
    formatSelect.value = "pcm";
  } else if (formatSelect.value === "pcm") {
    formatSelect.value = "wav";
  }
});

async function loadConfig() {
  try {
    const response = await fetch("/api/config");
    const config = await response.json();
    document.getElementById("modelInput").value = config.default_model;
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

loadConfig();
