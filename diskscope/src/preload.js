"use strict";
/**
 * 渲染进程唯一的后门。
 * contextIsolation 打开, 渲染进程拿不到 Node, 只能调用这里白名单里的方法。
 */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  drives:        ()                 => ipcRenderer.invoke("drives"),
  list:          (p)                => ipcRenderer.invoke("list", p),
  scanStart:     (opts)             => ipcRenderer.invoke("scan:start", opts),
  scanProgress:  (id)               => ipcRenderer.invoke("scan:progress", id),
  scanCancel:    (id)               => ipcRenderer.invoke("scan:cancel", id),
  cleanDryRun:   (paths)            => ipcRenderer.invoke("clean:dryrun", paths),
  clean:         (paths, mode)      => ipcRenderer.invoke("clean", { paths, mode }),
  reveal:        (p)                => ipcRenderer.invoke("reveal", p),
  confirm:       (o)                => ipcRenderer.invoke("confirm", o),

  isElectron: true,
});
