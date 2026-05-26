"use strict";

const state = {
  config: null,
  audioContext: null,
  analyser: null,
  samples: null,
  micStream: null,
  baseline: 0.008,
  clapHistory: [],
  lastPeakAt: 0,
  lastWakeAt: 0,
  animationFrameId: null,
  rebootTimer: null,
  bootInFlight: false
};

function setStatus(status) {
  window.jarvisTray.setStatus(status);
}

function getLockedMicConfig() {
  const microphone = state.config && state.config.microphone ? state.config.microphone : {};
  return {
    lockedDeviceId: typeof microphone.lockedDeviceId === "string" ? microphone.lockedDeviceId.trim() : "",
    lockedLabel: typeof microphone.lockedLabel === "string" ? microphone.lockedLabel.trim().toLowerCase() : ""
  };
}

async function resolveLockedDeviceId() {
  const mic = getLockedMicConfig();
  if (!mic.lockedDeviceId && !mic.lockedLabel) {
    return "";
  }

  if (!navigator.mediaDevices || typeof navigator.mediaDevices.enumerateDevices !== "function") {
    return mic.lockedDeviceId;
  }

  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const inputs = devices.filter((device) => device.kind === "audioinput");

    if (mic.lockedLabel) {
      const exact = inputs.find((device) => (device.label || "").trim().toLowerCase() === mic.lockedLabel);
      if (exact && exact.deviceId) {
        return exact.deviceId;
      }

      const fuzzy = inputs.find((device) => (device.label || "").trim().toLowerCase().includes(mic.lockedLabel));
      if (fuzzy && fuzzy.deviceId) {
        return fuzzy.deviceId;
      }
    }

    if (mic.lockedDeviceId) {
      const byId = inputs.find((device) => device.deviceId === mic.lockedDeviceId);
      if (byId && byId.deviceId) {
        return byId.deviceId;
      }
    }
  } catch (_error) {
    // Fall back to configured value below.
  }

  return mic.lockedDeviceId;
}

async function buildMicConstraints() {
  const locked = getLockedMicConfig();
  const hasLock = Boolean(locked.lockedDeviceId || locked.lockedLabel);
  const deviceId = await resolveLockedDeviceId();
  const audio = {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false
  };

  if (deviceId) {
    audio.deviceId = { exact: deviceId };
  }

  return {
    audio,
    usingLockedMic: hasLock,
    lockResolved: Boolean(deviceId)
  };
}

function computeRms(data) {
  let sum = 0;
  for (let index = 0; index < data.length; index += 1) {
    sum += data[index] * data[index];
  }
  return Math.sqrt(sum / data.length);
}

function monitor() {
  if (!state.analyser || !state.samples) {
    return;
  }

  state.analyser.getFloatTimeDomainData(state.samples);
  const rms = computeRms(state.samples);
  const detector = state.config.clapDetector;
  state.baseline = state.baseline * 0.94 + rms * 0.06;
  const threshold = Math.max(detector.threshold, state.baseline * detector.multiplier);
  const now = performance.now();

  if (
    rms >= threshold &&
    now - state.lastPeakAt >= detector.minGapMs &&
    Date.now() - state.lastWakeAt >= detector.cooldownMs
  ) {
    state.lastPeakAt = now;
    state.clapHistory.push(now);
    state.clapHistory = state.clapHistory.filter((stamp) => now - stamp <= detector.maxGapMs);

    if (state.clapHistory.length >= 2) {
      const gap = state.clapHistory[state.clapHistory.length - 1] - state.clapHistory[state.clapHistory.length - 2];
      if (gap >= detector.minGapMs && gap <= detector.maxGapMs) {
        state.clapHistory.length = 0;
        state.lastWakeAt = Date.now();
        setStatus("Wake Triggered");
        window.jarvisTray.wake();
      }
    }
  }

  state.animationFrameId = window.requestAnimationFrame(monitor);
}

function clearRebootTimer() {
  if (state.rebootTimer) {
    window.clearTimeout(state.rebootTimer);
    state.rebootTimer = null;
  }
}

function scheduleReboot(status, delayMs = 1400) {
  clearRebootTimer();
  if (status) {
    setStatus(status);
  }
  state.rebootTimer = window.setTimeout(() => {
    void boot();
  }, delayMs);
}

async function teardownAudioPipeline() {
  if (state.animationFrameId) {
    cancelAnimationFrame(state.animationFrameId);
    state.animationFrameId = null;
  }

  if (state.micStream) {
    for (const track of state.micStream.getTracks()) {
      track.stop();
    }
    state.micStream = null;
  }

  if (state.audioContext) {
    try {
      await state.audioContext.close();
    } catch (_error) {
      // Ignore close failures.
    }
    state.audioContext = null;
  }

  state.analyser = null;
  state.samples = null;
  state.clapHistory = [];
  state.lastPeakAt = 0;
  state.baseline = 0.008;
}

function bindStreamHealth(stream) {
  const [track] = stream.getAudioTracks();
  if (!track) {
    return;
  }

  track.addEventListener("ended", () => {
    scheduleReboot("Mic Reconnecting", 600);
  }, { once: true });
}

async function boot() {
  if (state.bootInFlight) {
    return;
  }

  state.bootInFlight = true;
  clearRebootTimer();
  await teardownAudioPipeline();

  try {
    state.config = await window.jarvisTray.getConfig();
    const micConstraints = await buildMicConstraints();
    if (micConstraints.usingLockedMic && !micConstraints.lockResolved) {
      setStatus("Locked Mic Missing");
      scheduleReboot("Locked Mic Missing", 3500);
      return;
    }
    setStatus(micConstraints.usingLockedMic ? "Requesting Locked Mic" : "Requesting Mic");

    state.micStream = await navigator.mediaDevices.getUserMedia({
      audio: micConstraints.audio
    });
    bindStreamHealth(state.micStream);

    state.audioContext = new AudioContext();
    await state.audioContext.resume();
    const source = state.audioContext.createMediaStreamSource(state.micStream);
    state.analyser = state.audioContext.createAnalyser();
    state.analyser.fftSize = 2048;
    state.samples = new Float32Array(state.analyser.fftSize);
    source.connect(state.analyser);
    setStatus("Listening");
    monitor();
  } catch (error) {
    if (error && (error.name === "OverconstrainedError" || error.name === "NotFoundError")) {
      scheduleReboot("Locked Mic Missing", 3500);
      return;
    }

    if (error && error.name === "NotAllowedError") {
      setStatus("Mic Permission Needed");
      return;
    }
    scheduleReboot("Mic Reconnecting", 2200);
  } finally {
    state.bootInFlight = false;
  }
}

window.addEventListener("beforeunload", () => {
  clearRebootTimer();
  void teardownAudioPipeline();
});

if (navigator.mediaDevices && typeof navigator.mediaDevices.addEventListener === "function") {
  navigator.mediaDevices.addEventListener("devicechange", () => {
    scheduleReboot("Mic Device Changed", 500);
  });
}

boot();
