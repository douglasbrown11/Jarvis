"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("jarvisTray", {
  getConfig: () => ipcRenderer.invoke("tray:get-config"),
  setStatus: (status) => ipcRenderer.send("tray:status", { status }),
  wake: () => ipcRenderer.send("tray:wake")
});
