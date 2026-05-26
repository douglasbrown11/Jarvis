# Jarvis Clap Console

1. Double clap.
2. Open ChatGPT, Claude, and Terminal .
3. Play "Should I Stay or Should I Go" automatically inside the Jarvis page.
4. Speak a time-of-day greeting.
5. Keep listening so you can talk back to Jarvis.
6. Run a Windows tray listener so Jarvis can keep waiting for the clap even when the console window is closed.

It runs as a local Node server with a browser front end. The browser handles:

- microphone access
- double-clap detection
- browser speech recognition
- text-to-speech voice output

The Node process handles:

- opening ChatGPT and Claude
- launching non-browser music targets when configured
- calling OpenAI or Anthropic for Jarvis replies

## What It Does Right Now

- Opens ChatGPT, Claude, and Terminal.
- Uses a configurable wake routine.
- Plays the official YouTube video for "Should I Stay or Should I Go" by default.
- Speaks "Good morning, sir", "Good afternoon, sir", or "Good evening, sir".
- Starts a speech loop after the wake routine.
- Lets you choose between OpenAI and Anthropic by setting environment variables.

## What You Need To Configure

### 1. Song target

Edit `config.json` and change the `music` block.

- The default setup uses the official YouTube video so it can auto-play from inside the Jarvis page.
- If you want another source later, replace it with another supported target.

Examples:

```json
{
  "music": {
    "name": "Should I Stay or Should I Go",
    "type": "youtube",
    "target": "xMaE6toi4mk",
    "startSeconds": 0
  }
}
```

```json
{
  "music": {
    "name": "Should I Stay or Should I Go",
    "type": "command",
    "target": "Start-Process 'C:\\Music\\Should I Stay or Should I Go.mp3'"
  }
}
```

### 2. App targets

On this Windows machine, the desktop apps are registered as Start menu app IDs, and the default config now uses those IDs directly:

- `OpenAI.ChatGPT-Desktop_2p2nqsd0c76g0!ChatGPT`
- `Claude_pzs8sxrjxfjjc!Claude`

That means the clap routine now targets the installed desktop apps instead of the websites.

If you ever need to swap back to web URLs or local executables, change the `type` in `config.json`.

Example:

```json
{
  "launchTargets": [
    {
      "name": "ChatGPT",
      "type": "appx",
      "target": "OpenAI.ChatGPT-Desktop_2p2nqsd0c76g0!ChatGPT"
    },
    {
      "name": "Claude",
      "type": "appx",
      "target": "Claude_pzs8sxrjxfjjc!Claude"
    }
  ]
}
```

### 3. API key for actual conversation

Without an API key, the wake routine still works, but Jarvis cannot generate real replies.

PowerShell examples:

```powershell
$env:OPENAI_API_KEY="your-openai-key"
node server.js
```

```powershell
$env:ANTHROPIC_API_KEY="your-anthropic-key"
node server.js
```

If both keys are set, `provider: "auto"` prefers OpenAI first.

## Run It

From this folder:

```powershell
node server.js
```

Then open:

```text
http://localhost:3080
```

Click **Arm Jarvis** once so the browser can request microphone permission.

## Tray App

Jarvis now includes a Windows tray listener built with Electron.

What it does:

- starts a hidden microphone listener in the tray
- keeps listening for the double-clap even when the Jarvis browser console is closed
- opens the Jarvis console only after the clap is detected

### One-click launch

Double-click:

```text
launch-jarvis-tray.cmd
```

Or run:

```powershell
npm run tray
```

### Start automatically at login

Run this once:

```powershell
powershell -ExecutionPolicy Bypass -File .\install-jarvis-startup.ps1
```

That creates a Startup shortcut that launches the tray listener when you sign in.

### First-run requirements

- Windows must allow microphone access for desktop apps.
- The tray process has to remain running.
- The Jarvis console window no longer needs to stay open for clap detection.

### Manual console

If you want to open the control UI without waiting for a clap:

```powershell
launch-jarvis.cmd
```

## Notes About The "Jarvis" Voice

This uses your browser's installed speech voices, so it can sound polished, but it will not exactly match the Iron Man movie voice.

If you want a more convincing cinematic voice later, the next upgrade would be:

- a custom TTS provider
- a cloned or tuned voice
- optional push-to-talk or noise-gated speech input

## Practical Limits

- Double-clap detection is threshold-based, so you may need to tune `clapDetector` in `config.json`.
- If the song plays loudly through speakers, speech recognition can pick it up. Headphones or a lower song volume help.
- Browser speech recognition works best in Chrome or Edge on Windows.
