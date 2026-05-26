"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { URL } = require("node:url");

const rootDir = __dirname;
const publicDir = path.join(rootDir, "public");
const configPath = path.join(rootDir, "config.json");

const defaultConfig = {
  server: {
    port: 3080,
    openBrowserOnStart: true
  },
  launchTargets: [],
  music: {
    name: "Wake Song",
    type: "none",
    target: "",
    startSeconds: 0
  },
  voice: {
    provider: "openai",
    preferredName: "Guy",
    rate: 0.92,
    pitch: 0.84,
    volume: 1,
    openaiModel: "gpt-4o-mini-tts",
    openaiVoice: "onyx",
    openaiInstructions: "Speak like a polished British executive assistant."
  },
  greetings: {
    morning: "Good morning, sir.",
    afternoon: "Good afternoon, sir.",
    evening: "Good evening, sir."
  },
  clapDetector: {
    threshold: 0.17,
    multiplier: 5.5,
    minGapMs: 140,
    maxGapMs: 900,
    cooldownMs: 6000
  },
  microphone: {
    lockedDeviceId: "",
    lockedLabel: ""
  },
  transcription: {
    provider: "openai",
    openai: {
      model: "gpt-4o-mini-transcribe",
      language: "en",
      prompt: "Transcribe short spoken commands for a desktop assistant."
    },
    startThreshold: 0.018,
    multiplier: 2.2,
    silenceMs: 900,
    maxRecordingMs: 10000,
    minSpeechMs: 350,
    minBlobBytes: 3000
  },
  assistant: {
    provider: "none",
    systemPrompt: "You are a formal, concise, polished home assistant.",
    openai: {
      model: "gpt-5.4-mini"
    },
    anthropic: {
      model: "claude-sonnet-4-20250514",
      maxTokens: 500
    },
    unconfiguredReply: "Voice control is local now, but AI chat is currently disabled."
  }
};

function normalizeApiKey(value) {
  return typeof value === "string" ? value.replace(/\s+/g, "").trim() : "";
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function deepMerge(base, override) {
  if (Array.isArray(base)) {
    return Array.isArray(override) ? override : base.slice();
  }

  if (!isObject(base)) {
    return override === undefined ? base : override;
  }

  const result = { ...base };
  for (const [key, value] of Object.entries(override || {})) {
    if (Array.isArray(value)) {
      result[key] = value;
      continue;
    }

    if (isObject(value) && isObject(base[key])) {
      result[key] = deepMerge(base[key], value);
      continue;
    }

    result[key] = value;
  }

  return result;
}

function loadConfig() {
  try {
    if (!fs.existsSync(configPath)) {
      return defaultConfig;
    }

    const raw = fs.readFileSync(configPath, "utf8");
    return deepMerge(defaultConfig, JSON.parse(raw));
  } catch (error) {
    console.error("Failed to load config.json:", error.message);
    return defaultConfig;
  }
}

const config = loadConfig();
const port = Number(process.env.PORT || config.server.port || 3080);
let lastTriggerAt = 0;

function saveConfig() {
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

function sanitizeMicrophoneConfig(input) {
  const source = isObject(input) ? input : {};
  const lockedDeviceId = typeof source.lockedDeviceId === "string" ? source.lockedDeviceId.trim() : "";
  const lockedLabel = typeof source.lockedLabel === "string" ? source.lockedLabel.trim() : "";
  return {
    lockedDeviceId: lockedDeviceId.slice(0, 512),
    lockedLabel: lockedLabel.slice(0, 512)
  };
}

function getMicrophoneConfig() {
  config.microphone = sanitizeMicrophoneConfig(config.microphone);
  return {
    ...config.microphone
  };
}

function setMicrophoneConfig(nextConfig) {
  config.microphone = sanitizeMicrophoneConfig(nextConfig);
  saveConfig();
  return getMicrophoneConfig();
}

function inferLaunchTargetType(rawType, rawTarget) {
  const type = typeof rawType === "string" ? rawType.trim().toLowerCase() : "";
  if (["appx", "exe", "command", "url", "shell"].includes(type)) {
    return type;
  }

  const target = String(rawTarget || "").trim();
  if (!target) {
    return "shell";
  }

  if (target.includes("!")) {
    return "appx";
  }

  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) {
    return "url";
  }

  if (/\.exe$/i.test(target)) {
    return "exe";
  }

  return "shell";
}

function sanitizeLaunchTarget(entry, index) {
  if (!isObject(entry)) {
    return null;
  }

  const rawTarget = typeof entry.target === "string" ? entry.target.trim() : "";
  if (!rawTarget) {
    return null;
  }

  const type = inferLaunchTargetType(entry.type, rawTarget);
  const fallbackName = type === "appx" ? `App ${index + 1}` : path.basename(rawTarget) || `App ${index + 1}`;
  const name = typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : fallbackName;
  const normalized = {
    name,
    type,
    target: rawTarget
  };

  if (Array.isArray(entry.args) && entry.args.length > 0) {
    normalized.args = entry.args
      .map((value) => String(value || "").trim())
      .filter(Boolean)
      .slice(0, 20);
  }

  if (typeof entry.hideWindow === "boolean") {
    normalized.hideWindow = entry.hideWindow;
  }

  return normalized;
}

function sanitizeLaunchTargets(list) {
  if (!Array.isArray(list)) {
    return [];
  }

  const sanitized = [];
  for (let index = 0; index < list.length; index += 1) {
    const target = sanitizeLaunchTarget(list[index], index);
    if (target) {
      sanitized.push(target);
    }
  }

  return sanitized.slice(0, 40);
}

function serializeLaunchTargets() {
  return (config.launchTargets || []).map((target) => ({
    name: target.name || target.target,
    type: target.type || inferLaunchTargetType(target.type, target.target),
    target: target.target,
    args: Array.isArray(target.args) ? target.args : [],
    hideWindow: typeof target.hideWindow === "boolean" ? target.hideWindow : undefined
  }));
}

function upsertLaunchTargets(targets) {
  config.launchTargets = sanitizeLaunchTargets(targets);
  saveConfig();
  return serializeLaunchTargets();
}

function toStartAppSuggestion(name, appId) {
  const normalizedName = String(name || "").trim();
  const normalizedId = String(appId || "").trim();
  const type = inferLaunchTargetType("", normalizedId);
  return {
    name: normalizedName,
    appId: normalizedId,
    suggestedTarget: {
      name: normalizedName,
      type,
      target: normalizedId
    }
  };
}

function listStartApps() {
  const script = "Get-StartApps | Sort-Object Name | Select-Object Name,AppID | ConvertTo-Json -Depth 4 -Compress";
  const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", script], {
    windowsHide: true,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || "Get-StartApps failed.").trim());
  }

  const raw = (result.stdout || "").trim();
  if (!raw) {
    return [];
  }

  const parsed = JSON.parse(raw);
  const items = Array.isArray(parsed) ? parsed : [parsed];
  const seen = new Set();
  const apps = [];

  for (const item of items) {
    const name = item && typeof item.Name === "string" ? item.Name.trim() : "";
    const appId = item && typeof item.AppID === "string" ? item.AppID.trim() : "";
    if (!name || !appId) {
      continue;
    }

    const key = `${name}::${appId}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    apps.push(toStartAppSuggestion(name, appId));
  }

  return apps;
}

function json(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(payload));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;

    req.on("data", (chunk) => {
      totalBytes += chunk.length;
      if (totalBytes > 1024 * 1024) {
        reject(new Error("Request body too large."));
        req.destroy();
        return;
      }

      chunks.push(chunk);
    });

    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve(text ? JSON.parse(text) : {});
      } catch (_error) {
        reject(new Error("Invalid JSON payload."));
      }
    });

    req.on("error", reject);
  });
}

function getContentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const types = {
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".ico": "image/x-icon",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml; charset=utf-8"
  };

  return types[ext] || "application/octet-stream";
}

function serveFile(res, filePath) {
  fs.readFile(filePath, (error, data) => {
    if (error) {
      json(res, 404, { error: "Not found." });
      return;
    }

    res.writeHead(200, {
      "Content-Type": getContentType(filePath),
      "Cache-Control": "no-store"
    });
    res.end(data);
  });
}

function sanitizeHistory(history) {
  if (!Array.isArray(history)) {
    return [];
  }

  return history
    .filter((entry) => entry && typeof entry.content === "string")
    .map((entry) => ({
      role: entry.role === "assistant" ? "assistant" : "user",
      content: entry.content.trim()
    }))
    .filter((entry) => entry.content.length > 0)
    .slice(-12);
}

function resolveProvider() {
  const preferred = (config.assistant.provider || "auto").toLowerCase();
  const hasOpenAI = Boolean(normalizeApiKey(process.env.OPENAI_API_KEY));
  const hasAnthropic = Boolean(normalizeApiKey(process.env.ANTHROPIC_API_KEY));

  if (preferred === "none" || preferred === "local") {
    return "local";
  }

  if (preferred === "openai") {
    return hasOpenAI ? "openai" : "local";
  }

  if (preferred === "anthropic") {
    return hasAnthropic ? "anthropic" : "local";
  }

  if (hasOpenAI) {
    return "openai";
  }

  if (hasAnthropic) {
    return "anthropic";
  }

  return "local";
}

function getAssistantStatus() {
  const provider = resolveProvider();
  return {
    provider: provider || "local",
    configured: Boolean(provider)
  };
}

function getTranscriptionStatus() {
  const provider = (config.transcription.provider || "openai").toLowerCase();
  const hasOpenAI = Boolean(normalizeApiKey(process.env.OPENAI_API_KEY));
  return {
    provider,
    configured: provider === "browser" ? true : hasOpenAI
  };
}

function extractOpenAIText(data) {
  if (typeof data.output_text === "string" && data.output_text.trim()) {
    return data.output_text.trim();
  }

  const chunks = [];
  for (const item of data.output || []) {
    if (item.type !== "message") {
      continue;
    }

    for (const content of item.content || []) {
      if (content.type === "output_text" && typeof content.text === "string") {
        chunks.push(content.text.trim());
      }
    }
  }

  return chunks.filter(Boolean).join("\n").trim();
}

function getCurrentGreeting() {
  const hour = new Date().getHours();
  if (hour < 12) {
    return config.greetings.morning;
  }

  if (hour < 18) {
    return config.greetings.afternoon;
  }

  return config.greetings.evening;
}

function getLatestUserMessage(history) {
  const reversed = [...history].reverse();
  const latest = reversed.find((entry) => entry.role === "user" && typeof entry.content === "string");
  return latest ? latest.content.trim() : "";
}

function buildLaunchReply(result) {
  if (result.ok) {
    return `Opening ${result.name}, sir.`;
  }

  return `I could not open ${result.name}: ${result.error}.`;
}

function launchNamedTarget(namePattern) {
  const target = (config.launchTargets || []).find((entry) =>
    namePattern.test(String(entry.name || entry.target || ""))
  );

  if (!target) {
    return null;
  }

  return buildLaunchReply(launchTarget(target));
}

function askLocalAssistant(history) {
  const latest = getLatestUserMessage(history);
  if (!latest) {
    return "Listening, sir.";
  }

  const text = latest.toLowerCase();

  if (/\b(hello|hi|hey|good morning|good afternoon|good evening)\b/.test(text)) {
    return `${getCurrentGreeting()} How can I help?`;
  }

  if (/\b(what(?:'s| is)? the time|current time|time is it)\b/.test(text)) {
    const now = new Date();
    return `It is ${now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}, sir.`;
  }

  if (/\b(today'?s date|what(?:'s| is)? the date|what day is it)\b/.test(text)) {
    const now = new Date();
    return `Today is ${now.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric", year: "numeric" })}.`;
  }

  if (/\b(open|launch|start)\b/.test(text) && /\bchat\s*gpt\b/.test(text)) {
    const reply = launchNamedTarget(/chatgpt/i);
    return reply || "I could not find ChatGPT in the launch targets.";
  }

  if (/\b(open|launch|start)\b/.test(text) && /\bclaude\b/.test(text)) {
    const reply = launchNamedTarget(/claude/i);
    return reply || "I could not find Claude in the launch targets.";
  }

  if (/\b(open|launch|start)\b/.test(text) && /\b(power\s*shell|terminal)\b/.test(text)) {
    const reply = launchNamedTarget(/power\s*shell|terminal/i);
    return reply || "I could not find Windows PowerShell in the launch targets.";
  }

  if (/\b(wake routine|launch everything|open everything)\b/.test(text)) {
    const result = triggerJarvis();
    const opened = result.appResults.filter((entry) => entry.ok).map((entry) => entry.name);
    const failed = result.appResults.filter((entry) => !entry.ok).map((entry) => entry.name);
    const parts = [];

    if (opened.length) {
      parts.push(`Opened: ${opened.join(", ")}.`);
    }

    if (failed.length) {
      parts.push(`Failed: ${failed.join(", ")}.`);
    }

    if (!parts.length) {
      return "No launch targets are configured yet.";
    }

    return parts.join(" ");
  }

  if (/\b(thanks|thank you)\b/.test(text)) {
    return "Anytime, sir.";
  }

  if (/\b(help|what can you do|commands)\b/.test(text)) {
    return "I am running in local mode. I can open ChatGPT, Claude, and PowerShell, run the wake routine, and report time or date.";
  }

  return "I am running in local mode. Ask me to open an app, run the wake routine, or give you the time.";
}

async function askOpenAI(history) {
  const apiKey = normalizeApiKey(process.env.OPENAI_API_KEY);
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: config.assistant.openai.model,
      input: [
        {
          role: "system",
          content: config.assistant.systemPrompt
        },
        ...history.map((entry) => ({
          role: entry.role,
          content: entry.content
        }))
      ]
    })
  });

  const data = await response.json();
  if (!response.ok) {
    const message = data.error && data.error.message ? data.error.message : "OpenAI request failed.";
    throw new Error(message);
  }

  const text = extractOpenAIText(data);
  return text || "I have no spoken response yet.";
}

async function synthesizeOpenAISpeech(text) {
  const apiKey = normalizeApiKey(process.env.OPENAI_API_KEY);
  if (!apiKey) {
    throw new Error("OpenAI API key is not configured for TTS.");
  }

  const response = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: config.voice.openaiModel,
      voice: config.voice.openaiVoice,
      input: text,
      response_format: "wav",
      instructions: config.voice.openaiInstructions
    })
  });

  if (!response.ok) {
    const raw = await response.text();
    try {
      const parsed = JSON.parse(raw);
      const message = parsed.error && parsed.error.message ? parsed.error.message : raw;
      throw new Error(message);
    } catch (_error) {
      if (_error instanceof SyntaxError) {
        throw new Error(raw || "OpenAI speech synthesis failed.");
      }
      throw _error;
    }
  }

  return Buffer.from(await response.arrayBuffer());
}

function mimeTypeToExtension(mimeType) {
  const normalized = String(mimeType || "").toLowerCase();

  if (normalized.includes("webm")) {
    return "webm";
  }

  if (normalized.includes("wav")) {
    return "wav";
  }

  if (normalized.includes("mp4")) {
    return "mp4";
  }

  if (normalized.includes("mpeg") || normalized.includes("mp3")) {
    return "mp3";
  }

  return "webm";
}

async function transcribeWithOpenAI(audioBase64, mimeType) {
  const apiKey = normalizeApiKey(process.env.OPENAI_API_KEY);
  if (!apiKey) {
    throw new Error("OpenAI API key is not configured for transcription.");
  }

  const audioBuffer = Buffer.from(audioBase64, "base64");
  const form = new FormData();
  const blob = new Blob([audioBuffer], {
    type: mimeType || "audio/webm"
  });

  form.set("file", blob, `utterance.${mimeTypeToExtension(mimeType)}`);
  form.set("model", config.transcription.openai.model);

  if (config.transcription.openai.language) {
    form.set("language", config.transcription.openai.language);
  }

  if (config.transcription.openai.prompt) {
    form.set("prompt", config.transcription.openai.prompt);
  }

  form.set("response_format", "json");

  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`
    },
    body: form
  });

  const raw = await response.text();
  let payload = {};

  try {
    payload = raw ? JSON.parse(raw) : {};
  } catch (_error) {
    payload = {};
  }

  if (!response.ok) {
    const message = payload.error && payload.error.message ? payload.error.message : raw || "OpenAI transcription failed.";
    throw new Error(message);
  }

  return typeof payload.text === "string" ? payload.text.trim() : "";
}

async function askAnthropic(history) {
  const apiKey = normalizeApiKey(process.env.ANTHROPIC_API_KEY);
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
      "x-api-key": apiKey
    },
    body: JSON.stringify({
      model: config.assistant.anthropic.model,
      max_tokens: config.assistant.anthropic.maxTokens,
      system: config.assistant.systemPrompt,
      messages: history
    })
  });

  const data = await response.json();
  if (!response.ok) {
    const message = data.error && data.error.message ? data.error.message : "Anthropic request failed.";
    throw new Error(message);
  }

  const text = (data.content || [])
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text.trim())
    .filter(Boolean)
    .join("\n");

  return text || "I have no spoken response yet.";
}

async function askAssistant(history) {
  const provider = resolveProvider();
  if (provider === "local") {
    return askLocalAssistant(history);
  }

  if (provider === "openai") {
    return askOpenAI(history);
  }

  if (provider === "anthropic") {
    return askAnthropic(history);
  }

  return config.assistant.unconfiguredReply;
}

function launchWithCommand(target) {
  const child = spawn("cmd.exe", ["/c", "start", "\"\"", target], {
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
}

function launchVisibleExecutable(targetPath, args) {
  const child = spawn("cmd.exe", ["/c", "start", "\"\"", targetPath, ...(args || [])], {
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
}

function launchAppId(appId) {
  const child = spawn("explorer.exe", [`shell:AppsFolder\\${appId}`], {
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
}

function shouldHideWindow(target) {
  if (target && typeof target.hideWindow === "boolean") {
    return target.hideWindow;
  }

  if (!target || typeof target.target !== "string") {
    return true;
  }

  if (
    target.type === "exe" &&
    /\\(powershell|pwsh|cmd|wt)\.exe$/i.test(target.target.trim())
  ) {
    return false;
  }

  return true;
}

function launchTarget(target) {
  if (!target || !target.target) {
    return {
      name: target && target.name ? target.name : "Unknown",
      ok: false,
      error: "Missing target."
    };
  }

  try {
    if (target.type === "appx") {
      launchAppId(target.target);
    } else if (target.type === "exe") {
      const exeArgs = Array.isArray(target.args) ? target.args.map((value) => String(value)) : [];
      if (shouldHideWindow(target)) {
        const child = spawn(target.target, exeArgs, {
          detached: true,
          stdio: "ignore",
          windowsHide: true
        });
        child.unref();
      } else {
        launchVisibleExecutable(target.target, exeArgs);
      }
    } else if (target.type === "command") {
      if (shouldHideWindow(target)) {
        const child = spawn("powershell.exe", ["-NoProfile", "-Command", target.target], {
          detached: true,
          stdio: "ignore",
          windowsHide: true
        });
        child.unref();
      } else {
        launchVisibleExecutable("powershell.exe", ["-NoProfile", "-Command", target.target]);
      }
    } else {
      launchWithCommand(target.target);
    }

    return {
      name: target.name || target.target,
      ok: true
    };
  } catch (error) {
    return {
      name: target.name || target.target,
      ok: false,
      error: error.message
    };
  }
}

function triggerJarvis() {
  const now = Date.now();
  const cooldownMs = Number(config.clapDetector.cooldownMs) || 6000;
  if (now - lastTriggerAt < cooldownMs) {
    return {
      ok: true,
      skipped: true,
      appResults: [],
      musicResult: null
    };
  }

  lastTriggerAt = now;
  const appResults = (config.launchTargets || []).map(launchTarget);
  let musicResult = null;

  if (config.music && config.music.type !== "none" && config.music.target) {
    if (config.music.type === "youtube") {
      musicResult = {
        name: config.music.name || "Wake Song",
        ok: true,
        handledByClient: true
      };
    } else {
      musicResult = launchTarget(config.music);
    }
  }

  return {
    ok: true,
    skipped: false,
    appResults,
    musicResult
  };
}

function getPublicRuntimeConfig() {
  return {
    voice: config.voice,
    greetings: config.greetings,
    clapDetector: config.clapDetector,
    microphone: getMicrophoneConfig(),
    assistant: getAssistantStatus(),
    transcription: {
      ...config.transcription,
      ...getTranscriptionStatus()
    },
    launchTargets: (config.launchTargets || []).map((target) => ({
      name: target.name || target.target
    })),
    music: {
      name: config.music && config.music.name ? config.music.name : "Wake Song",
      enabled: Boolean(config.music && config.music.target && config.music.type !== "none"),
      type: config.music && config.music.type ? config.music.type : "none",
      target: config.music && config.music.target ? config.music.target : "",
      startSeconds: config.music && Number.isFinite(config.music.startSeconds) ? config.music.startSeconds : 0
    }
  };
}

const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (req.method === "GET" && requestUrl.pathname === "/api/apps") {
    try {
      const apps = listStartApps();
      json(res, 200, { apps });
    } catch (error) {
      json(res, 500, { error: error.message || "Could not enumerate installed apps." });
    }
    return;
  }

  if (req.method === "GET" && requestUrl.pathname === "/api/launch-targets") {
    json(res, 200, {
      targets: serializeLaunchTargets()
    });
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/launch-targets") {
    try {
      const body = await readBody(req);
      const targets = upsertLaunchTargets(body.targets);
      json(res, 200, { targets });
    } catch (error) {
      json(res, 500, { error: error.message || "Could not save launch targets." });
    }
    return;
  }

  if (req.method === "GET" && requestUrl.pathname === "/api/microphone") {
    json(res, 200, {
      microphone: getMicrophoneConfig()
    });
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/microphone") {
    try {
      const body = await readBody(req);
      const microphone = setMicrophoneConfig(body.microphone);
      json(res, 200, { microphone });
    } catch (error) {
      json(res, 500, { error: error.message || "Could not save microphone settings." });
    }
    return;
  }

  if (req.method === "GET" && requestUrl.pathname === "/api/config") {
    json(res, 200, getPublicRuntimeConfig());
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/trigger") {
    json(res, 200, {
      ...triggerJarvis(),
      assistant: getAssistantStatus()
    });
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/chat") {
    try {
      const body = await readBody(req);
      const history = sanitizeHistory(body.history);

      if (history.length === 0) {
        json(res, 400, { error: "No chat message provided." });
        return;
      }

      const reply = await askAssistant(history);
      json(res, 200, {
        reply,
        assistant: getAssistantStatus()
      });
    } catch (error) {
      json(res, 500, { error: error.message || "Chat request failed." });
    }
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/tts") {
    try {
      const body = await readBody(req);
      const text = typeof body.text === "string" ? body.text.trim() : "";

      if (!text) {
        json(res, 400, { error: "No text provided for speech synthesis." });
        return;
      }

      if (config.voice.provider !== "openai") {
        json(res, 400, { error: "OpenAI TTS is not enabled in config." });
        return;
      }

      const audio = await synthesizeOpenAISpeech(text);
      res.writeHead(200, {
        "Content-Type": "audio/wav",
        "Cache-Control": "no-store"
      });
      res.end(audio);
    } catch (error) {
      json(res, 500, { error: error.message || "Speech synthesis failed." });
    }
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/transcribe") {
    try {
      const body = await readBody(req);
      const audioBase64 = typeof body.audioBase64 === "string" ? body.audioBase64 : "";
      const mimeType = typeof body.mimeType === "string" ? body.mimeType : "audio/webm";

      if (!audioBase64) {
        json(res, 400, { error: "No audio payload provided." });
        return;
      }

      if ((config.transcription.provider || "openai") !== "openai") {
        json(res, 400, { error: "OpenAI transcription is not enabled in config." });
        return;
      }

      const text = await transcribeWithOpenAI(audioBase64, mimeType);
      json(res, 200, { text });
    } catch (error) {
      json(res, 500, { error: error.message || "Transcription failed." });
    }
    return;
  }

  if (req.method !== "GET") {
    json(res, 405, { error: "Method not allowed." });
    return;
  }

  const relativePath = requestUrl.pathname === "/" ? "/index.html" : requestUrl.pathname;
  const filePath = path.join(publicDir, relativePath);
  if (!filePath.startsWith(publicDir)) {
    json(res, 403, { error: "Forbidden." });
    return;
  }

  serveFile(res, filePath);
});

function maybeOpenBrowser() {
  const startBrowser = process.env.JARVIS_OPEN_BROWSER !== "0" && config.server.openBrowserOnStart;
  if (!startBrowser) {
    return;
  }

  launchWithCommand(`http://localhost:${port}`);
}

server.listen(port, () => {
  console.log(`Jarvis prototype running at http://localhost:${port}`);
  maybeOpenBrowser();
});
