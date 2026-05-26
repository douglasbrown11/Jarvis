"use strict";

const state = {
  config: null,
  armed: false,
  awake: false,
  micStream: null,
  audioContext: null,
  analyser: null,
  samples: null,
  animationFrameId: null,
  baseline: 0.008,
  clapHistory: [],
  lastPeakAt: 0,
  lastTriggerAt: 0,
  level: 0,
  youtubePlayer: null,
  youtubeApiPromise: null,
  musicPrimed: false,
  ttsSourceNode: null,
  wakeLinkHandled: false,
  recognition: null,
  mediaRecorder: null,
  mediaRecorderMimeType: "",
  recordedChunks: [],
  speechStartedAt: 0,
  speechLastHeardAt: 0,
  speechNetworkErrors: 0,
  recognitionCooldownUntil: 0,
  pendingTranscriptionPromise: null,
  shouldListen: false,
  isListening: false,
  isSpeaking: false,
  isSending: false,
  voicePrimed: false,
  speechPrimeTimer: null,
  launchTargets: [],
  appCatalog: [],
  microphones: [],
  voices: [],
  conversation: []
};

const query = new URLSearchParams(window.location.search);
const autoStartRequested = query.get("autostart") === "1";
const wakeRequested = query.get("wake") === "1";

const elements = {
  armButton: document.getElementById("arm-button"),
  triggerButton: document.getElementById("trigger-button"),
  standDownButton: document.getElementById("stand-down-button"),
  armStatus: document.getElementById("arm-status"),
  sensorDetail: document.getElementById("sensor-detail"),
  assistantStatus: document.getElementById("assistant-status"),
  assistantDetail: document.getElementById("assistant-detail"),
  conversationStatus: document.getElementById("conversation-status"),
  conversationDetail: document.getElementById("conversation-detail"),
  meterValue: document.getElementById("meter-value"),
  meterThresholdValue: document.getElementById("meter-threshold-value"),
  meterFill: document.getElementById("meter-fill"),
  meterThreshold: document.getElementById("meter-threshold"),
  youtubePlayerHost: document.getElementById("youtube-player-host"),
  voiceSelect: document.getElementById("voice-select"),
  microphoneSelect: document.getElementById("microphone-select"),
  refreshMicrophonesButton: document.getElementById("refresh-microphones-button"),
  lockMicrophoneButton: document.getElementById("lock-microphone-button"),
  unlockMicrophoneButton: document.getElementById("unlock-microphone-button"),
  autoSpeakToggle: document.getElementById("auto-speak-toggle"),
  installedAppsSelect: document.getElementById("installed-apps-select"),
  addInstalledAppButton: document.getElementById("add-installed-app-button"),
  customTargetName: document.getElementById("custom-target-name"),
  customTargetPath: document.getElementById("custom-target-path"),
  customTargetArgs: document.getElementById("custom-target-args"),
  customTargetShowWindow: document.getElementById("custom-target-show-window"),
  addCustomTargetButton: document.getElementById("add-custom-target-button"),
  launchList: document.getElementById("launch-list"),
  conversationLog: document.getElementById("conversation-log"),
  composer: document.getElementById("composer"),
  messageInput: document.getElementById("message-input")
};

function addMessage(role, text) {
  state.conversation.push({ role, text });
  renderConversation();
}

function renderConversation() {
  elements.conversationLog.innerHTML = "";

  for (const entry of state.conversation) {
    const item = document.createElement("article");
    item.className = `message message-${entry.role}`;

    const label = document.createElement("strong");
    label.textContent = entry.role === "assistant" ? "Jarvis" : entry.role === "user" ? "You" : "System";

    const body = document.createElement("div");
    body.textContent = entry.text;

    item.append(label, body);
    elements.conversationLog.appendChild(item);
  }

  elements.conversationLog.scrollTop = elements.conversationLog.scrollHeight;
}

function setAssistantStatus(label, detail) {
  elements.assistantStatus.textContent = label;
  elements.assistantDetail.textContent = detail;
}

function setSensorStatus(label, detail) {
  elements.armStatus.textContent = label;
  elements.sensorDetail.textContent = detail;
}

function setConversationStatus(label, detail) {
  elements.conversationStatus.textContent = label;
  elements.conversationDetail.textContent = detail;
}

function parseArgsInput(raw) {
  const text = String(raw || "").trim();
  if (!text) {
    return [];
  }

  const args = [];
  const matcher = /"([^"]*)"|[^\s]+/g;
  let match = matcher.exec(text);
  while (match) {
    args.push((match[1] || match[0] || "").trim());
    match = matcher.exec(text);
  }

  return args.filter(Boolean);
}

function inferTargetTypeFromAppId(appId) {
  const value = String(appId || "").trim();
  if (!value) {
    return "shell";
  }

  if (value.includes("!")) {
    return "appx";
  }

  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) {
    return "url";
  }

  if (/\.exe$/i.test(value)) {
    return "exe";
  }

  return "shell";
}

function targetSummary(target) {
  const type = target.type || "shell";
  if (type === "exe" && Array.isArray(target.args) && target.args.length > 0) {
    return `${target.target} ${target.args.join(" ")}`;
  }
  return target.target;
}

function renderLaunchTargets() {
  elements.launchList.innerHTML = "";

  if (!Array.isArray(state.launchTargets) || state.launchTargets.length === 0) {
    const item = document.createElement("li");
    item.textContent = "No launch targets configured yet.";
    elements.launchList.appendChild(item);
    return;
  }

  state.launchTargets.forEach((target, index) => {
    const item = document.createElement("li");
    const row = document.createElement("div");
    row.className = "target-row";

    const meta = document.createElement("div");
    meta.className = "target-meta";

    const name = document.createElement("strong");
    name.className = "target-name";
    name.textContent = target.name || target.target;

    const path = document.createElement("span");
    path.className = "target-path";
    path.textContent = targetSummary(target);

    meta.append(name, path);

    const removeButton = document.createElement("button");
    removeButton.className = "target-remove";
    removeButton.type = "button";
    removeButton.textContent = "Remove";
    removeButton.addEventListener("click", () => {
      void removeLaunchTarget(index);
    });

    row.append(meta, removeButton);
    item.appendChild(row);
    elements.launchList.appendChild(item);
  });
}

function renderInstalledApps() {
  elements.installedAppsSelect.innerHTML = "";

  if (!Array.isArray(state.appCatalog) || state.appCatalog.length === 0) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "No installed apps found";
    elements.installedAppsSelect.appendChild(option);
    return;
  }

  const prompt = document.createElement("option");
  prompt.value = "";
  prompt.textContent = "Choose an installed app...";
  elements.installedAppsSelect.appendChild(prompt);

  state.appCatalog.forEach((app, index) => {
    const option = document.createElement("option");
    option.value = String(index);
    option.textContent = `${app.name}`;
    elements.installedAppsSelect.appendChild(option);
  });
}

async function requestJson(path, options = {}) {
  const method = options.method || "GET";
  const headers = {
    "Content-Type": "application/json",
    ...(options.headers || {})
  };
  const response = await fetch(path, {
    method,
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || "Request failed.");
  }
  return data;
}

function getLockedMicrophoneConfig() {
  const microphone = state.config && state.config.microphone ? state.config.microphone : {};
  return {
    lockedDeviceId: typeof microphone.lockedDeviceId === "string" ? microphone.lockedDeviceId.trim() : "",
    lockedLabel: typeof microphone.lockedLabel === "string" ? microphone.lockedLabel.trim() : ""
  };
}

function microphoneLabel(device, index) {
  const label = String(device.label || "").trim();
  if (label) {
    return label;
  }
  return `Microphone ${index + 1}`;
}

function renderMicrophones() {
  if (!elements.microphoneSelect) {
    return;
  }

  elements.microphoneSelect.innerHTML = "";
  const defaultOption = document.createElement("option");
  defaultOption.value = "";
  defaultOption.textContent = "System Default Microphone";
  elements.microphoneSelect.appendChild(defaultOption);

  state.microphones.forEach((device, index) => {
    const option = document.createElement("option");
    option.value = device.deviceId;
    option.textContent = microphoneLabel(device, index);
    elements.microphoneSelect.appendChild(option);
  });

  const locked = getLockedMicrophoneConfig();
  if (!locked.lockedDeviceId && !locked.lockedLabel) {
    elements.microphoneSelect.value = "";
    return;
  }

  let selectedValue = "";
  if (locked.lockedDeviceId && state.microphones.some((device) => device.deviceId === locked.lockedDeviceId)) {
    selectedValue = locked.lockedDeviceId;
  } else if (locked.lockedLabel) {
    const normalized = locked.lockedLabel.toLowerCase();
    const byLabel = state.microphones.find((device) => (device.label || "").trim().toLowerCase() === normalized)
      || state.microphones.find((device) => (device.label || "").trim().toLowerCase().includes(normalized));
    if (byLabel) {
      selectedValue = byLabel.deviceId;
    }
  }

  if (selectedValue) {
    elements.microphoneSelect.value = selectedValue;
    return;
  }

  const missingValue = "__locked_missing__";
  const missingOption = document.createElement("option");
  missingOption.value = missingValue;
  missingOption.textContent = `Locked mic unavailable: ${locked.lockedLabel || locked.lockedDeviceId}`;
  elements.microphoneSelect.appendChild(missingOption);
  elements.microphoneSelect.value = missingValue;
}

async function refreshMicrophones() {
  if (!navigator.mediaDevices || typeof navigator.mediaDevices.enumerateDevices !== "function") {
    state.microphones = [];
    renderMicrophones();
    addMessage("system", "This browser cannot enumerate microphones.");
    return;
  }

  const devices = await navigator.mediaDevices.enumerateDevices();
  state.microphones = devices.filter((device) => device.kind === "audioinput");
  renderMicrophones();
}

async function persistMicrophoneLock(lockedDeviceId, lockedLabel) {
  const payload = await requestJson("/api/microphone", {
    method: "POST",
    body: {
      microphone: {
        lockedDeviceId: lockedDeviceId || "",
        lockedLabel: lockedLabel || ""
      }
    }
  });

  if (!state.config) {
    state.config = {};
  }
  state.config.microphone = payload.microphone || {
    lockedDeviceId: "",
    lockedLabel: ""
  };
  renderMicrophones();
}

async function lockSelectedMicrophone() {
  const selected = elements.microphoneSelect.value;
  if (!selected || selected === "__locked_missing__") {
    addMessage("system", "Select a valid microphone first.");
    return;
  }

  const device = state.microphones.find((entry) => entry.deviceId === selected);
  const label = device ? (device.label || "") : "";
  await persistMicrophoneLock(selected, label);
  addMessage("system", `Locked microphone: ${label || selected}. Re-arm Jarvis to apply now.`);
}

async function unlockMicrophone() {
  await persistMicrophoneLock("", "");
  addMessage("system", "Microphone lock cleared. Jarvis will use the system default input.");
}

async function resolveLockedMicrophoneDeviceId() {
  const locked = getLockedMicrophoneConfig();
  if (!locked.lockedDeviceId && !locked.lockedLabel) {
    return "";
  }

  if (!navigator.mediaDevices || typeof navigator.mediaDevices.enumerateDevices !== "function") {
    return locked.lockedDeviceId;
  }

  const devices = await navigator.mediaDevices.enumerateDevices();
  const inputs = devices.filter((device) => device.kind === "audioinput");

  if (locked.lockedDeviceId) {
    const byId = inputs.find((device) => device.deviceId === locked.lockedDeviceId);
    if (byId && byId.deviceId) {
      return byId.deviceId;
    }
  }

  if (locked.lockedLabel) {
    const normalized = locked.lockedLabel.toLowerCase();
    const exact = inputs.find((device) => (device.label || "").trim().toLowerCase() === normalized);
    if (exact && exact.deviceId) {
      return exact.deviceId;
    }

    const fuzzy = inputs.find((device) => (device.label || "").trim().toLowerCase().includes(normalized));
    if (fuzzy && fuzzy.deviceId) {
      return fuzzy.deviceId;
    }
  }

  return locked.lockedDeviceId;
}

async function buildMicAudioConstraints() {
  const locked = getLockedMicrophoneConfig();
  const hasLock = Boolean(locked.lockedDeviceId || locked.lockedLabel);
  const audio = {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false
  };

  if (!hasLock) {
    return {
      audio,
      usingLock: false,
      lockResolved: true
    };
  }

  const deviceId = await resolveLockedMicrophoneDeviceId();
  if (deviceId) {
    audio.deviceId = { exact: deviceId };
  }

  return {
    audio,
    usingLock: true,
    lockResolved: Boolean(deviceId)
  };
}

async function loadInstalledApps() {
  const payload = await requestJson("/api/apps");
  state.appCatalog = Array.isArray(payload.apps) ? payload.apps : [];
  renderInstalledApps();
}

async function loadLaunchTargets() {
  const payload = await requestJson("/api/launch-targets");
  state.launchTargets = Array.isArray(payload.targets) ? payload.targets : [];
  renderLaunchTargets();
}

async function persistLaunchTargets() {
  const payload = await requestJson("/api/launch-targets", {
    method: "POST",
    body: {
      targets: state.launchTargets
    }
  });
  state.launchTargets = Array.isArray(payload.targets) ? payload.targets : [];
  renderLaunchTargets();
}

function makeTargetFromInstalledApp(app) {
  if (!app || !app.appId) {
    return null;
  }

  if (app.suggestedTarget && app.suggestedTarget.target) {
    return {
      name: app.suggestedTarget.name || app.name,
      type: app.suggestedTarget.type || inferTargetTypeFromAppId(app.appId),
      target: app.suggestedTarget.target
    };
  }

  return {
    name: app.name,
    type: inferTargetTypeFromAppId(app.appId),
    target: app.appId
  };
}

async function addInstalledAppTarget() {
  const selectedIndex = Number(elements.installedAppsSelect.value);
  if (!Number.isInteger(selectedIndex) || selectedIndex < 0 || selectedIndex >= state.appCatalog.length) {
    addMessage("system", "Choose an installed app first.");
    return;
  }

  const target = makeTargetFromInstalledApp(state.appCatalog[selectedIndex]);
  if (!target) {
    addMessage("system", "Could not build a target for that app.");
    return;
  }

  const exists = state.launchTargets.some((entry) => entry.target === target.target && entry.type === target.type);
  if (exists) {
    addMessage("system", `${target.name} is already in launch targets.`);
    return;
  }

  state.launchTargets.push(target);
  await persistLaunchTargets();
  addMessage("system", `Added launch target: ${target.name}.`);
}

async function addCustomLaunchTarget() {
  const name = elements.customTargetName.value.trim();
  const targetPath = elements.customTargetPath.value.trim();
  const args = parseArgsInput(elements.customTargetArgs.value);
  const showWindow = elements.customTargetShowWindow.checked;

  if (!targetPath) {
    addMessage("system", "Enter an executable path for custom app launch.");
    return;
  }

  const target = {
    name: name || pathBaseName(targetPath),
    type: /^[a-z][a-z0-9+.-]*:/i.test(targetPath) ? "url" : (/\.exe$/i.test(targetPath) ? "exe" : "shell"),
    target: targetPath,
    hideWindow: !showWindow
  };

  if (target.type === "exe" && args.length > 0) {
    target.args = args;
  }

  state.launchTargets.push(target);
  await persistLaunchTargets();
  elements.customTargetName.value = "";
  elements.customTargetPath.value = "";
  elements.customTargetArgs.value = "";
  addMessage("system", `Added custom launch target: ${target.name}.`);
}

async function removeLaunchTarget(index) {
  if (index < 0 || index >= state.launchTargets.length) {
    return;
  }

  const [removed] = state.launchTargets.splice(index, 1);
  await persistLaunchTargets();
  addMessage("system", `Removed launch target: ${removed.name || removed.target}.`);
}

function pathBaseName(value) {
  const normalized = String(value || "").replace(/[\\/]+$/, "");
  const pieces = normalized.split(/[\\/]/);
  return pieces[pieces.length - 1] || "Custom App";
}

function musicIsYouTube() {
  return Boolean(
    state.config &&
    state.config.music &&
    state.config.music.enabled &&
    state.config.music.type === "youtube" &&
    state.config.music.target
  );
}

function transcriptionConfigured() {
  if (!state.config || !state.config.transcription) {
    return false;
  }

  if (state.config.transcription.provider === "browser") {
    return supportsRecognition();
  }

  return Boolean(state.config.transcription.configured);
}

function updateMeter(level, threshold) {
  const safeLevel = Math.max(0, Math.min(1, level));
  const safeThreshold = Math.max(0, Math.min(1, threshold));
  elements.meterValue.textContent = safeLevel.toFixed(3);
  elements.meterThresholdValue.textContent = safeThreshold.toFixed(3);
  elements.meterFill.style.width = `${safeLevel * 100}%`;
  elements.meterThreshold.style.left = `${safeThreshold * 100}%`;
}

function pickVoiceName() {
  const preferred = window.localStorage.getItem("jarvis-voice-name");
  if (preferred && state.voices.some((voice) => voice.name === preferred)) {
    return preferred;
  }

  const configured = state.config ? state.config.voice.preferredName.toLowerCase() : "";
  const candidate = state.voices.find((voice) => voice.name.toLowerCase().includes(configured));
  if (candidate) {
    return candidate.name;
  }

  const maleHint = state.voices.find((voice) => /guy|david|george|daniel|ryan|mark/i.test(voice.name));
  if (maleHint) {
    return maleHint.name;
  }

  const englishVoice = state.voices.find((voice) => voice.lang.startsWith("en"));
  return englishVoice ? englishVoice.name : "";
}

function renderVoiceOptions() {
  if (!("speechSynthesis" in window)) {
    elements.voiceSelect.innerHTML = "";
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "Speech synthesis unavailable";
    elements.voiceSelect.appendChild(option);
    return;
  }

  state.voices = window.speechSynthesis.getVoices().sort((left, right) => left.name.localeCompare(right.name));
  elements.voiceSelect.innerHTML = "";

  if (state.voices.length === 0) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "No browser voices available";
    elements.voiceSelect.appendChild(option);
    return;
  }

  for (const voice of state.voices) {
    const option = document.createElement("option");
    option.value = voice.name;
    option.textContent = `${voice.name} (${voice.lang})`;
    elements.voiceSelect.appendChild(option);
  }

  elements.voiceSelect.value = pickVoiceName();
}

function currentGreeting() {
  const hour = new Date().getHours();
  if (hour < 12) {
    return state.config.greetings.morning;
  }

  if (hour < 18) {
    return state.config.greetings.afternoon;
  }

  return state.config.greetings.evening;
}

function selectedVoice() {
  return state.voices.find((voice) => voice.name === elements.voiceSelect.value) || null;
}

function primeSpeechEngine() {
  if (state.voicePrimed || !("speechSynthesis" in window)) {
    return;
  }

  try {
    const utterance = new SpeechSynthesisUtterance(".");
    utterance.volume = 0;
    utterance.rate = 1;
    utterance.pitch = 1;
    const voice = selectedVoice();
    if (voice) {
      utterance.voice = voice;
      utterance.lang = voice.lang;
    }
    window.speechSynthesis.speak(utterance);
    if (state.speechPrimeTimer) {
      window.clearTimeout(state.speechPrimeTimer);
    }
    state.speechPrimeTimer = window.setTimeout(() => {
      if (state.isSpeaking) {
        return;
      }
      window.speechSynthesis.cancel();
      state.speechPrimeTimer = null;
    }, 90);
    state.voicePrimed = true;
  } catch (_error) {
    // Ignore warmup failures; normal speech path will still run.
  }
}

function stopCurrentSpeechPlayback() {
  if (state.ttsSourceNode) {
    try {
      state.ttsSourceNode.onended = null;
      state.ttsSourceNode.stop();
    } catch (_error) {
      // Ignore stop errors on already-finished nodes.
    }
    state.ttsSourceNode.disconnect();
    state.ttsSourceNode = null;
  }

  if ("speechSynthesis" in window) {
    window.speechSynthesis.cancel();
  }
}

async function speakWithOpenAI(text) {
  if (!state.audioContext) {
    throw new Error("Audio context is not ready.");
  }

  const response = await fetch("/api/tts", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ text })
  });

  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || "OpenAI TTS request failed.");
  }

  const arrayBuffer = await response.arrayBuffer();
  const audioBuffer = await state.audioContext.decodeAudioData(arrayBuffer.slice(0));
  stopCurrentSpeechPlayback();

  return new Promise((resolve) => {
    const source = state.audioContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(state.audioContext.destination);
    state.ttsSourceNode = source;
    source.onended = () => {
      if (state.ttsSourceNode === source) {
        state.ttsSourceNode = null;
      }
      resolve();
    };
    source.start(0);
  });
}

function finishSpeechCycle() {
  state.isSpeaking = false;
  setConversationStatus(
    state.awake ? "Listening" : "Idle",
    state.awake ? "Jarvis is waiting for your next line." : "Waiting for wake event."
  );
}

function speakWithBrowser(text, options = {}) {
  const preferDefaultVoice = Boolean(options.preferDefaultVoice);
  return new Promise((resolve) => {
    let completed = false;
    let attempt = 0;
    let guardTimer = null;

    const done = () => {
      if (completed) {
        return;
      }
      completed = true;
      if (guardTimer) {
        window.clearTimeout(guardTimer);
      }
      finishSpeechCycle();
      resolve();
    };

    const attemptSpeak = (useDefaultVoice) => {
      if (completed) {
        return;
      }

      attempt += 1;
      let started = false;
      const utterance = new SpeechSynthesisUtterance(text);

      if (!useDefaultVoice) {
        const voice = selectedVoice();
        if (voice) {
          utterance.voice = voice;
          utterance.lang = voice.lang;
        }
      }

      utterance.rate = state.config.voice.rate;
      utterance.pitch = state.config.voice.pitch;
      utterance.volume = state.config.voice.volume;

      utterance.onstart = () => {
        started = true;
      };

      utterance.onend = () => {
        done();
      };

      utterance.onerror = () => {
        if (attempt < 2) {
          if (guardTimer) {
            window.clearTimeout(guardTimer);
          }
          try {
            window.speechSynthesis.cancel();
          } catch (_error) {
            // Ignore cancellation errors.
          }
          window.setTimeout(() => {
            attemptSpeak(!useDefaultVoice);
          }, 90);
          return;
        }
        done();
      };

      if (guardTimer) {
        window.clearTimeout(guardTimer);
      }

      guardTimer = window.setTimeout(() => {
        if (completed) {
          return;
        }

        if (started) {
          return;
        }

        if (attempt < 2) {
          try {
            window.speechSynthesis.cancel();
          } catch (_error) {
            // Ignore cancellation errors.
          }
          attemptSpeak(!useDefaultVoice);
          return;
        }

        addMessage("system", "Speech output did not start. Click the Jarvis window once, then try again.");
        done();
      }, 1200);

      window.speechSynthesis.speak(utterance);
    };

    if (state.speechPrimeTimer) {
      window.clearTimeout(state.speechPrimeTimer);
      state.speechPrimeTimer = null;
    }
    stopCurrentSpeechPlayback();
    attemptSpeak(preferDefaultVoice);
  });
}

async function speak(text, options = {}) {
  const force = Boolean(options.force);
  if (!force && !elements.autoSpeakToggle.checked) {
    return;
  }

  state.isSpeaking = true;
  setConversationStatus("Speaking", "Jarvis is replying aloud.");

  if (state.config.voice.provider === "openai") {
    try {
      await speakWithOpenAI(text);
      finishSpeechCycle();
      return;
    } catch (error) {
      addMessage("system", `OpenAI TTS failed, falling back to browser voice: ${error.message}`);
      if (!("speechSynthesis" in window)) {
        state.isSpeaking = false;
        setConversationStatus("Error", "OpenAI TTS failed and browser speech is unavailable.");
        return;
      }
    }
  }

  if (!("speechSynthesis" in window)) {
    if (state.config.voice.provider !== "openai") {
      state.isSpeaking = false;
      setConversationStatus("Error", "Browser speech synthesis is unavailable.");
    }
    return;
  }

  await speakWithBrowser(text, options);
}

function supportsRecognition() {
  return Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);
}

function usingOpenAITranscription() {
  return Boolean(state.config && state.config.transcription && state.config.transcription.provider === "openai");
}

function usingBrowserTranscription() {
  return Boolean(state.config && state.config.transcription && state.config.transcription.provider === "browser");
}

function pickRecorderMimeType() {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4"
  ];

  for (const candidate of candidates) {
    if (window.MediaRecorder && window.MediaRecorder.isTypeSupported(candidate)) {
      return candidate;
    }
  }

  return "";
}

async function blobToBase64(blob) {
  const arrayBuffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);
  let binary = "";

  for (let index = 0; index < bytes.byteLength; index += 1) {
    binary += String.fromCharCode(bytes[index]);
  }

  return window.btoa(binary);
}

function resetVoiceCaptureState() {
  state.recordedChunks = [];
  state.speechStartedAt = 0;
  state.speechLastHeardAt = 0;
}

function buildMediaRecorder() {
  if (!state.micStream || !window.MediaRecorder) {
    return null;
  }

  const mimeType = pickRecorderMimeType();
  state.mediaRecorderMimeType = mimeType;

  const recorder = mimeType
    ? new MediaRecorder(state.micStream, { mimeType })
    : new MediaRecorder(state.micStream);

  recorder.ondataavailable = (event) => {
    if (event.data && event.data.size > 0) {
      state.recordedChunks.push(event.data);
    }
  };

  recorder.onstart = () => {
    state.isListening = true;
    setConversationStatus("Listening", "Jarvis is listening for your voice.");
  };

  recorder.onstop = async () => {
    state.isListening = false;

    if (!state.awake || !state.shouldListen) {
      resetVoiceCaptureState();
      return;
    }

    const durationMs = state.speechLastHeardAt - state.speechStartedAt;
    const blob = new Blob(state.recordedChunks, {
      type: state.mediaRecorderMimeType || "audio/webm"
    });
    resetVoiceCaptureState();

    if (durationMs < state.config.transcription.minSpeechMs || blob.size < state.config.transcription.minBlobBytes) {
      setConversationStatus("Listening", "Jarvis is waiting for your next line.");
      return;
    }

    state.pendingTranscriptionPromise = transcribeAudioBlob(blob)
      .catch((error) => {
        addMessage("system", `Transcription failed: ${error.message}`);
        setConversationStatus("Error", error.message);
      })
      .finally(() => {
        state.pendingTranscriptionPromise = null;
        if (state.awake && state.shouldListen && !state.isSpeaking && !state.isSending) {
          setConversationStatus("Listening", "Jarvis is waiting for your next line.");
        }
      });
  };

  recorder.onerror = (event) => {
    state.isListening = false;
    const message = event.error && event.error.message ? event.error.message : "Media recorder error.";
    addMessage("system", `Recorder error: ${message}`);
  };

  return recorder;
}

async function transcribeAudioBlob(blob) {
  const audioBase64 = await blobToBase64(blob);
  const response = await fetch("/api/transcribe", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      audioBase64,
      mimeType: blob.type || state.mediaRecorderMimeType || "audio/webm"
    })
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || "Transcription request failed.");
  }

  if (data.text) {
    await handleUserMessage(data.text);
  }
}

function stopVoiceCapture() {
  if (state.recognition && state.isListening) {
    state.recognition.stop();
  }

  if (state.mediaRecorder && state.mediaRecorder.state !== "inactive") {
    state.mediaRecorder.stop();
  }
}

function updateVoiceCapture(rms) {
  if (!state.shouldListen || !state.mediaRecorder || state.pendingTranscriptionPromise) {
    return;
  }

  if (state.isSpeaking || state.isSending) {
    if (state.mediaRecorder.state !== "inactive") {
      stopVoiceCapture();
    }
    return;
  }

  const detector = state.config.transcription;
  const threshold = Math.max(detector.startThreshold, state.baseline * detector.multiplier);
  const now = performance.now();

  if (rms >= threshold) {
    state.speechLastHeardAt = now;

    if (state.mediaRecorder.state === "inactive") {
      state.recordedChunks = [];
      state.speechStartedAt = now;
      state.speechLastHeardAt = now;
      state.mediaRecorder.start();
    }
    return;
  }

  if (
    state.mediaRecorder.state !== "inactive" &&
    state.speechLastHeardAt > 0 &&
    now - state.speechLastHeardAt >= detector.silenceMs
  ) {
    stopVoiceCapture();
    return;
  }

  if (
    state.mediaRecorder.state !== "inactive" &&
    state.speechStartedAt > 0 &&
    now - state.speechStartedAt >= detector.maxRecordingMs
  ) {
    stopVoiceCapture();
  }
}

function buildRecognition() {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition) {
    return null;
  }

  const recognition = new Recognition();
  recognition.continuous = false;
  recognition.interimResults = false;
  recognition.lang = "en-US";
  if ("processLocally" in recognition) {
    recognition.processLocally = true;
  }

  recognition.onstart = () => {
    state.isListening = true;
    state.speechNetworkErrors = 0;
    setConversationStatus("Listening", "Jarvis is listening for your voice.");
  };

  recognition.onresult = async (event) => {
    let finalTranscript = "";
    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      const result = event.results[index];
      if (result.isFinal) {
        finalTranscript += result[0].transcript;
      }
    }

    const text = finalTranscript.trim();
    if (!text) {
      return;
    }

    state.speechNetworkErrors = 0;
    state.recognitionCooldownUntil = 0;
    recognition.stop();
    await handleUserMessage(text);
  };

  recognition.onend = () => {
    state.isListening = false;
    if (state.shouldListen && usingBrowserTranscription() && !state.isSpeaking && !state.isSending) {
      queueRecognitionRestart();
    }
  };

  recognition.onerror = (event) => {
    state.isListening = false;
    if (event.error === "network") {
      state.speechNetworkErrors += 1;
      const waitMs = Math.min(1200 + state.speechNetworkErrors * 700, 6000);
      state.recognitionCooldownUntil = Date.now() + waitMs;
      addMessage(
        "system",
        "Speech recognition network issue. If it continues, turn on Windows Online Speech (Settings > Privacy & security > Speech), then reopen Jarvis."
      );
    } else if (event.error !== "no-speech") {
      addMessage("system", `Speech recognition error: ${event.error}.`);
    }
    if (state.shouldListen && usingBrowserTranscription() && !state.isSpeaking && !state.isSending) {
      queueRecognitionRestart();
    }
  };

  return recognition;
}

function queueRecognitionRestart() {
  if (!usingBrowserTranscription()) {
    return;
  }

  window.clearTimeout(queueRecognitionRestart.timer);
  queueRecognitionRestart.timer = window.setTimeout(() => {
    if (!state.shouldListen || state.isListening || state.isSpeaking || state.isSending) {
      return;
    }
    if (!state.recognition) {
      queueRecognitionRestart();
      return;
    }
    if (Date.now() < state.recognitionCooldownUntil) {
      queueRecognitionRestart();
      return;
    }

    try {
      state.recognition.start();
    } catch (_error) {
      window.setTimeout(queueRecognitionRestart, 600);
    }
  }, 350);
}

function loadYouTubeApi() {
  if (!musicIsYouTube()) {
    return Promise.resolve(false);
  }

  if (window.YT && typeof window.YT.Player === "function") {
    return Promise.resolve(true);
  }

  if (state.youtubeApiPromise) {
    return state.youtubeApiPromise;
  }

  state.youtubeApiPromise = new Promise((resolve, reject) => {
    const priorHandler = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      if (typeof priorHandler === "function") {
        priorHandler();
      }
      resolve(true);
    };

    const script = document.createElement("script");
    script.src = "https://www.youtube.com/iframe_api";
    script.async = true;
    script.onerror = () => reject(new Error("Failed to load YouTube player API."));
    document.head.appendChild(script);
  });

  return state.youtubeApiPromise;
}

async function ensureYouTubePlayer() {
  if (!musicIsYouTube()) {
    return null;
  }

  if (state.youtubePlayer) {
    return state.youtubePlayer;
  }

  await loadYouTubeApi();

  return new Promise((resolve, reject) => {
    let resolved = false;
    const startSeconds = Number(state.config.music.startSeconds) || 0;

    const player = new window.YT.Player(elements.youtubePlayerHost, {
      width: "1",
      height: "1",
      videoId: state.config.music.target,
      playerVars: {
        autoplay: 0,
        controls: 0,
        playsinline: 1,
        rel: 0,
        start: startSeconds
      },
      events: {
        onReady: () => {
          state.youtubePlayer = player;
          resolved = true;
          resolve(player);
        },
        onError: () => {
          if (!resolved) {
            reject(new Error("YouTube player could not load the wake track."));
          }
        }
      }
    });
  });
}

async function primeMusicPlayback() {
  if (!musicIsYouTube() || state.musicPrimed) {
    return;
  }

  const player = await ensureYouTubePlayer();
  if (!player) {
    return;
  }

  const startSeconds = Number(state.config.music.startSeconds) || 0;
  if (typeof player.mute === "function") {
    player.mute();
  }
  player.seekTo(startSeconds, true);
  player.playVideo();

  window.setTimeout(() => {
    try {
      player.pauseVideo();
      player.seekTo(startSeconds, true);
      if (typeof player.unMute === "function") {
        player.unMute();
      }
      state.musicPrimed = true;
    } catch (_error) {
      addMessage("system", "Music player priming failed. Playback may require a manual test trigger.");
    }
  }, 300);
}

async function playConfiguredMusic() {
  if (!state.config.music.enabled) {
    return null;
  }

  if (!musicIsYouTube()) {
    return null;
  }

  const player = await ensureYouTubePlayer();
  const startSeconds = Number(state.config.music.startSeconds) || 0;

  if (typeof player.unMute === "function") {
    player.unMute();
  }
  player.seekTo(startSeconds, true);
  player.playVideo();

  return {
    ok: true,
    handledByClient: true,
    name: state.config.music.name
  };
}

function stopConfiguredMusic() {
  if (state.youtubePlayer && typeof state.youtubePlayer.stopVideo === "function") {
    state.youtubePlayer.stopVideo();
  }
}

function goStandby() {
  state.awake = false;
  state.shouldListen = false;
  state.speechNetworkErrors = 0;
  state.recognitionCooldownUntil = 0;
  stopVoiceCapture();
  stopCurrentSpeechPlayback();
  stopConfiguredMusic();
  setConversationStatus("Idle", "Waiting for wake event.");
  addMessage("system", "Jarvis is standing down.");
}

async function api(path, payload) {
  return requestJson(path, {
    method: "POST",
    body: payload || {}
  });
}

async function handleJarvisTrigger(sourceLabel) {
  const now = Date.now();
  if (state.awake || now - state.lastTriggerAt < state.config.clapDetector.cooldownMs) {
    return;
  }

  state.lastTriggerAt = now;
  state.awake = true;
  state.shouldListen = transcriptionConfigured();
  setConversationStatus("Launching", `Wake routine triggered by ${sourceLabel}.`);

  try {
    const greeting = currentGreeting();
    addMessage("assistant", greeting);
    const speakPromise = speak(greeting, { force: true, preferDefaultVoice: true });
    const eagerMusicPromise = state.config.music.enabled && musicIsYouTube()
      ? playConfiguredMusic()
      : Promise.resolve(null);
    const result = await api("/api/trigger");
    const musicResult = result.musicResult || null;

    const successfulApps = result.appResults.filter((entry) => entry.ok).map((entry) => entry.name);
    const failedApps = result.appResults.filter((entry) => !entry.ok).map((entry) => entry.name);

    if (successfulApps.length > 0) {
      addMessage("system", `Opened: ${successfulApps.join(", ")}.`);
    }

    if (musicResult && musicResult.ok && !musicResult.handledByClient) {
      addMessage("system", `Music target launched: ${state.config.music.name}.`);
    }

    if (musicResult && !musicResult.ok && musicResult.error) {
      addMessage("system", `Music target failed: ${musicResult.error}`);
    }

    if ((!musicResult || musicResult.handledByClient) && state.config.music.enabled && musicIsYouTube()) {
      void eagerMusicPromise
        .then((clientMusicResult) => {
          if (clientMusicResult && clientMusicResult.ok) {
            addMessage("system", `Music target launched: ${state.config.music.name}.`);
          }
        })
        .catch((error) => {
          addMessage("system", `Music target failed: ${error.message}`);
        });
    }

    if (failedApps.length > 0) {
      addMessage("system", `These launch targets failed: ${failedApps.join(", ")}.`);
    }

    await speakPromise;

    if (state.shouldListen && usingBrowserTranscription()) {
      queueRecognitionRestart();
      setConversationStatus("Listening", "Jarvis is waiting for your next line.");
    } else if (state.shouldListen && usingOpenAITranscription()) {
      setConversationStatus("Listening", "Jarvis is waiting for your next line.");
    } else if (!transcriptionConfigured()) {
      addMessage("system", "Local speech recognition is unavailable in this browser. Use the text box instead.");
      setConversationStatus("Awake", "Voice loop is unavailable in this browser.");
    } else if (!result.assistant.configured) {
      setConversationStatus("Awake", "Voice loop is ready, but the LLM provider is not configured yet.");
    }
  } catch (error) {
    state.awake = false;
    state.shouldListen = false;
    addMessage("system", `Wake routine failed: ${error.message}`);
    setConversationStatus("Error", error.message);
  }
}

function recentChatHistory() {
  return state.conversation
    .filter((entry) => entry.role === "user" || entry.role === "assistant")
    .map((entry) => ({
      role: entry.role,
      content: entry.text
    }))
    .slice(-12);
}

async function handleUserMessage(text) {
  const normalized = text.trim();
  if (!normalized) {
    return;
  }

  if (/stand down|go to sleep|sleep mode/i.test(normalized)) {
    addMessage("user", normalized);
    await speak("Standing down, sir.");
    goStandby();
    return;
  }

  addMessage("user", normalized);
  state.isSending = true;
  setConversationStatus("Thinking", "Jarvis is composing a reply.");

  try {
    const result = await api("/api/chat", {
      history: recentChatHistory()
    });
    addMessage("assistant", result.reply);
    await speak(result.reply);
  } catch (error) {
    addMessage("system", `Chat request failed: ${error.message}`);
    setConversationStatus("Error", error.message);
  } finally {
    state.isSending = false;
    if (state.awake && !state.isSpeaking) {
      setConversationStatus("Listening", "Jarvis is waiting for your next line.");
      if (state.shouldListen && usingBrowserTranscription()) {
        queueRecognitionRestart();
      }
    }
  }
}

function computeRms(data) {
  let sum = 0;
  for (let index = 0; index < data.length; index += 1) {
    const sample = data[index];
    sum += sample * sample;
  }
  return Math.sqrt(sum / data.length);
}

function monitorClaps() {
  if (!state.analyser || !state.samples) {
    return;
  }

  state.analyser.getFloatTimeDomainData(state.samples);
  const rms = computeRms(state.samples);
  state.level = rms;
  state.baseline = state.baseline * 0.94 + rms * 0.06;

  const detector = state.config.clapDetector;
  const threshold = Math.max(detector.threshold, state.baseline * detector.multiplier);
  updateMeter(rms, threshold);
  const now = performance.now();

  if (
    rms >= threshold &&
    now - state.lastPeakAt >= detector.minGapMs &&
    Date.now() - state.lastTriggerAt >= detector.cooldownMs &&
    !state.awake
  ) {
    state.lastPeakAt = now;
    state.clapHistory.push(now);
    state.clapHistory = state.clapHistory.filter((stamp) => now - stamp <= detector.maxGapMs);

    if (state.clapHistory.length >= 2) {
      const gap = state.clapHistory[state.clapHistory.length - 1] - state.clapHistory[state.clapHistory.length - 2];
      if (gap >= detector.minGapMs && gap <= detector.maxGapMs) {
        state.clapHistory.length = 0;
        handleJarvisTrigger("double clap");
      }
    }
  }

  if (state.awake && usingOpenAITranscription()) {
    updateVoiceCapture(rms);
  }

  state.animationFrameId = window.requestAnimationFrame(monitorClaps);
}

async function armJarvis() {
  if (state.armed) {
    state.armed = false;
    state.awake = false;
    state.shouldListen = false;
    state.speechNetworkErrors = 0;
    state.recognitionCooldownUntil = 0;
    stopConfiguredMusic();
    stopVoiceCapture();
    if (state.animationFrameId) {
      window.cancelAnimationFrame(state.animationFrameId);
    }
    if (state.audioContext) {
      stopCurrentSpeechPlayback();
      await state.audioContext.close();
      state.audioContext = null;
    }
    if (state.micStream) {
      for (const track of state.micStream.getTracks()) {
        track.stop();
      }
      state.micStream = null;
    }
    state.recognition = null;
    state.mediaRecorder = null;
    resetVoiceCaptureState();
    setSensorStatus("Offline", "Microphone disarmed.");
    setConversationStatus("Idle", "Waiting for wake event.");
    elements.armButton.textContent = "Arm Jarvis";
    return;
  }

  try {
    const micConstraints = await buildMicAudioConstraints();
    if (micConstraints.usingLock && !micConstraints.lockResolved) {
      const error = new Error("Locked microphone was not found.");
      error.name = "NotFoundError";
      throw error;
    }
    state.micStream = await navigator.mediaDevices.getUserMedia({
      audio: micConstraints.audio
    });

    state.audioContext = new AudioContext();
    await state.audioContext.resume();
    const source = state.audioContext.createMediaStreamSource(state.micStream);
    state.analyser = state.audioContext.createAnalyser();
    state.analyser.fftSize = 2048;
    state.samples = new Float32Array(state.analyser.fftSize);
    source.connect(state.analyser);
    state.recognition = null;
    state.mediaRecorder = null;

    if (usingOpenAITranscription()) {
      state.mediaRecorder = buildMediaRecorder();
      if (!state.mediaRecorder) {
        throw new Error("This browser does not support background audio recording for transcription.");
      }
    } else if (usingBrowserTranscription()) {
      state.recognition = buildRecognition();
      if (!state.recognition) {
        throw new Error("This browser does not support local speech recognition.");
      }
    }
    state.armed = true;
    setSensorStatus("Armed", "Double clap detection is live.");
    setConversationStatus("Idle", "Waiting for wake event.");
    elements.armButton.textContent = "Disarm Jarvis";
    addMessage("system", "Jarvis is armed. Double clap to wake.");
    if (!wakeRequested) {
      primeSpeechEngine();
      void primeMusicPlayback().catch((error) => {
        addMessage("system", `Music setup failed: ${error.message}`);
      });
    }
    if (state.awake && state.shouldListen && usingBrowserTranscription()) {
      queueRecognitionRestart();
    }
    monitorClaps();
  } catch (error) {
    if (error && (error.name === "OverconstrainedError" || error.name === "NotFoundError")) {
      addMessage("system", "Locked microphone was not found. Select another mic in the Voice panel.");
      setSensorStatus("Error", "Locked microphone not found.");
      return;
    }
    if (autoStartRequested) {
      addMessage("system", `Auto-arm failed: ${error.message}`);
      setSensorStatus("Needs Attention", "Auto-arm did not complete. Click Arm Jarvis once or re-grant mic access.");
      return;
    }
    addMessage("system", `Microphone access failed: ${error.message}`);
    setSensorStatus("Error", error.message);
  }
}

async function bootstrap() {
  const response = await fetch("/api/config");
  state.config = await response.json();

  if (state.config.assistant.provider === "none") {
    setAssistantStatus("Local Mode", "Wake, apps, and local voice are available. AI chat is off.");
  } else if (state.config.assistant.configured) {
    setAssistantStatus(`Ready (${state.config.assistant.provider})`, "LLM provider is configured.");
  } else {
    setAssistantStatus("Not Configured", "Set OPENAI_API_KEY or ANTHROPIC_API_KEY before starting the server.");
  }

  loadLaunchTargets().catch((error) => {
    addMessage("system", `Could not load launch targets: ${error.message}`);
  });

  loadInstalledApps().catch((error) => {
    addMessage("system", `Could not enumerate installed apps: ${error.message}`);
  });

  addMessage("system", "Console online. Click Arm Jarvis once to grant microphone access.");
  updateMeter(0, state.config.clapDetector.threshold);
  renderVoiceOptions();
  renderMicrophones();
  refreshMicrophones().catch((error) => {
    addMessage("system", `Could not enumerate microphones: ${error.message}`);
  });
  if (!wakeRequested) {
    primeSpeechEngine();
    void primeMusicPlayback().catch(() => {
      // Non-blocking warmup; wake routine will retry playback if needed.
    });
  }

  if (autoStartRequested) {
    addMessage("system", "Auto-start mode requested. Attempting to arm Jarvis.");
    window.setTimeout(() => {
      armJarvis();
    }, 60);
  }

  if (wakeRequested && !state.wakeLinkHandled) {
    state.wakeLinkHandled = true;
    window.setTimeout(() => {
      handleJarvisTrigger("tray listener");
    }, 10);
  }
}

elements.armButton.addEventListener("click", () => {
  armJarvis();
});

elements.triggerButton.addEventListener("click", () => {
  handleJarvisTrigger("manual override");
});

elements.standDownButton.addEventListener("click", () => {
  goStandby();
});

elements.voiceSelect.addEventListener("change", () => {
  window.localStorage.setItem("jarvis-voice-name", elements.voiceSelect.value);
});

elements.refreshMicrophonesButton.addEventListener("click", () => {
  refreshMicrophones().catch((error) => {
    addMessage("system", `Could not refresh microphones: ${error.message}`);
  });
});

elements.lockMicrophoneButton.addEventListener("click", () => {
  lockSelectedMicrophone().catch((error) => {
    addMessage("system", `Could not lock microphone: ${error.message}`);
  });
});

elements.unlockMicrophoneButton.addEventListener("click", () => {
  unlockMicrophone().catch((error) => {
    addMessage("system", `Could not clear microphone lock: ${error.message}`);
  });
});

elements.addInstalledAppButton.addEventListener("click", () => {
  void addInstalledAppTarget().catch((error) => {
    addMessage("system", `Could not add installed app: ${error.message}`);
  });
});

elements.addCustomTargetButton.addEventListener("click", () => {
  void addCustomLaunchTarget().catch((error) => {
    addMessage("system", `Could not add custom app: ${error.message}`);
  });
});

elements.composer.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = elements.messageInput.value.trim();
  elements.messageInput.value = "";
  await handleUserMessage(text);
});

if ("speechSynthesis" in window) {
  if (typeof window.speechSynthesis.addEventListener === "function") {
    window.speechSynthesis.addEventListener("voiceschanged", renderVoiceOptions);
  } else {
    window.speechSynthesis.onvoiceschanged = renderVoiceOptions;
  }
}

bootstrap().catch((error) => {
  addMessage("system", `Startup failed: ${error.message}`);
  setAssistantStatus("Error", error.message);
});
