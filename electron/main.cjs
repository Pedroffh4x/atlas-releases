// Atlas Desktop — processo principal do Electron.
//
// Janela principal = painel de status (home.html).
// Pareamento por interface gráfica (setup.html), ponte com o PC em segundo plano (bridge.cjs)
// e atualização automática com verificação de integridade (updater.cjs).
const { app, BrowserWindow, ipcMain, Menu, Tray, shell, dialog, nativeImage } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { pair, startLoop } = require("./bridge.cjs");
const updater = require("./updater.cjs");

const DEFAULT_URL = "https://id-preview--e20f8630-666a-484f-915b-b81dfdc65b94.lovable.app";
const ICON = path.join(__dirname, "assets", "icon.png");

let win = null;
let tray = null;
let stopLoop = null;
let stopChecks = null;
let pendingUpdate = null;
let quitting = false;
let lastStatus = { state: "desligado", message: "Ainda não conectado." };

/* ---------------- Configuração local (preservada entre atualizações) ---------------- */

function configPath() {
  return path.join(app.getPath("userData"), "atlas-config.json");
}

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(configPath(), "utf8"));
  } catch {
    return null;
  }
}

function saveConfig(config) {
  fs.writeFileSync(configPath(), JSON.stringify(config, null, 2), { mode: 0o600 });
}

function baseUrl() {
  return loadConfig()?.baseUrl ?? DEFAULT_URL;
}

/* ---------------- Status ---------------- */

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function pushStatus(status) {
  lastStatus = status;
  send("atlas:status", status);
  updateTray();
}

function startBridge(config) {
  stopLoop?.();
  stopLoop = startLoop({
    baseUrl: config.baseUrl,
    token: config.token,
    onStatus: pushStatus,
    appVersion: updater.currentVersion(),
  });
}

function openHome() {
  win.loadFile(path.join(__dirname, "home.html"));
}

function openSetup() {
  win.loadFile(path.join(__dirname, "setup.html"));
}

function openUpdates() {
  showWindow();
  win.loadFile(path.join(__dirname, "updates.html"));
}


/* ---------------- Bandeja do Windows ---------------- */

function updateTray() {
  if (!tray) return;
  const conectado = lastStatus.state === "conectado" || lastStatus.state === "trabalhando";
  tray.setToolTip(`Atlas — ${conectado ? "conectado" : "desconectado"}`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: conectado ? "● Conectado" : "○ Desconectado", enabled: false },
      { type: "separator" },
      { label: "Abrir Atlas", click: () => showWindow() },
      { label: "Atualizações", click: () => openUpdates() },
      { type: "separator" },
      { label: "Sair", click: () => { quitting = true; app.quit(); } },
    ]),
  );
}

function showWindow() {
  if (!win || win.isDestroyed()) return createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/* ---------------- Atualização ---------------- */

async function checkUpdateNow(manual = false) {
  try {
    const info = await updater.checkForUpdates(baseUrl());
    if (info.atualizacao_disponivel) {
      pendingUpdate = info;
      openUpdates();
      send("atlas:update-available", info);
    } else if (manual) {
      // a própria tela de Atualizações mostra "Seu Atlas está atualizado".
    }
    return { ok: true, info };
  } catch (error) {
    if (manual) dialog.showMessageBox({ message: `Não foi possível verificar atualizações: ${error.message}` });
    return { ok: false, error: error.message };
  }
}

ipcMain.handle("atlas:get-update", () => pendingUpdate);
ipcMain.handle("atlas:dismiss-update", () => { pendingUpdate = null; return { ok: true }; });
ipcMain.handle("atlas:check-update", () => checkUpdateNow(true));

ipcMain.handle("atlas:install-update", async () => {
  if (!pendingUpdate) return { ok: false, error: "Nenhuma atualização pendente." };
  try {
    const result = await updater.installUpdate(pendingUpdate, (p) => send("atlas:update-progress", p));
    if (result.pacoteCompleto) {
      // Pacote completo baixado e validado: abre a pasta para o usuário concluir.
      shell.showItemInFolder(result.pacoteCompleto);
      return { ok: true, pacoteCompleto: true };
    }
    send("atlas:update-progress", { etapa: "instalando", feito: 1, total: 1, mensagem: "Atualização concluída. Reiniciando Atlas..." });
    setTimeout(() => { quitting = true; app.relaunch(); app.exit(0); }, 1500);
    return { ok: true };
  } catch (error) {
    // O updater já restaurou a versão anterior (rollback).
    send("atlas:update-progress", { etapa: "erro", feito: 0, total: 1, mensagem: error.message });
    return { ok: false, error: error.message };
  }
});

/* ---------------- Menu ---------------- */

function buildMenu() {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: "Atlas",
        submenu: [
          { label: "Painel de status", click: () => openHome() },
          { label: "Abrir o Atlas", click: () => { const c = loadConfig(); if (c?.baseUrl) win.loadURL(c.baseUrl); } },
          { label: "Conectar este PC de novo", click: () => openSetup() },
          { label: "Atualizações", click: () => openUpdates() },
          { type: "separator" },
          { label: "Minimizar para a bandeja", click: () => win?.hide() },
          { label: "Sair", click: () => { quitting = true; app.quit(); } },
        ],
      },
      { label: "Editar", role: "editMenu" },
      { label: "Janela", role: "windowMenu" },
    ]),
  );
}

/* ---------------- Janela principal ---------------- */

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    backgroundColor: "#000000",
    title: "Atlas",
    icon: fs.existsSync(ICON) ? ICON : undefined,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.cjs"),
    },
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  // Fechar a janela pergunta: minimizar para a bandeja ou encerrar.
  win.on("close", (event) => {
    if (quitting) return;
    event.preventDefault();
    const choice = dialog.showMessageBoxSync(win, {
      type: "question",
      buttons: ["Minimizar para a bandeja", "Encerrar Atlas"],
      defaultId: 0,
      cancelId: 0,
      title: "Atlas",
      message: "O Atlas continua trabalhando em segundo plano se você minimizar.",
    });
    if (choice === 0) win.hide();
    else { quitting = true; app.quit(); }
  });

  const config = loadConfig();
  if (config?.token && config?.baseUrl) {
    startBridge(config);
    openHome();
  } else {
    openSetup();
  }
}

ipcMain.handle("atlas:get-state", () => ({
  status: lastStatus,
  baseUrl: baseUrl(),
  version: updater.currentVersion(),
  hostname: os.hostname(),
  os: `${os.type()} ${os.release()} (${process.arch})`,
}));

ipcMain.handle("atlas:open-site", () => { win.loadURL(baseUrl()); return { ok: true }; });
ipcMain.handle("atlas:open-setup", () => { openSetup(); return { ok: true }; });
ipcMain.handle("atlas:open-updates", () => { openUpdates(); return { ok: true }; });

ipcMain.handle("atlas:connect", async (_event, { baseUrl: url, code }) => {
  const clean = String(url || DEFAULT_URL).trim().replace(/\/+$/, "");
  try {
    const paired = await pair(clean, code, updater.currentVersion());
    const config = { ...paired, baseUrl: clean };
    saveConfig(config);
    startBridge(config);
    setTimeout(() => openHome(), 600);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

ipcMain.handle("atlas:skip", async (_event, { baseUrl: url }) => {
  const clean = String(url || DEFAULT_URL).trim().replace(/\/+$/, "");
  win.loadURL(clean);
  return { ok: true };
});

/* ---------------- Ciclo de vida ---------------- */

// Uma instância só: abrir de novo apenas traz a janela para frente.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => showWindow());

  app.whenReady().then(() => {
    buildMenu();
    createWindow();

    const image = fs.existsSync(ICON) ? nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 }) : nativeImage.createEmpty();
    tray = new Tray(image);
    tray.on("click", () => showWindow());
    updateTray();

    // Verificação de atualização ao abrir e a cada 6 horas, em segundo plano.
    stopChecks = updater.startBackgroundChecks(baseUrl(), (info) => {
      pendingUpdate = info;
      showWindow();
      send("atlas:update-available", info);
    });

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on("before-quit", () => {
  quitting = true;
  stopLoop?.();
  stopChecks?.();
});

// A janela fechada não encerra o app: a ponte continua rodando na bandeja.
app.on("window-all-closed", () => {});
