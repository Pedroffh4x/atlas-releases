// Atlas Desktop — atualização automática.
//
// Como funciona:
// 1. Ao abrir (e a cada 6 horas) o app pergunta ao site qual é a última versão publicada:
//    POST /api/public/atualizacao  { versao, arquivos: [{ path, sha256 }] }
// 2. O servidor devolve o manifesto + "delta": só os arquivos que mudaram neste PC.
// 3. Baixa apenas esses arquivos para uma pasta temporária e confere o sha256 de cada um.
// 4. Se algum arquivo falhar na verificação (ou não houver delta), baixa o pacote completo.
// 5. Instala: faz backup dos arquivos atuais, troca pelos novos e grava a versão.
//    Qualquer erro no meio do caminho restaura o backup (rollback) e a versão antiga continua.

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { app } = require("electron");

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 horas

// Pasta onde ficam os arquivos do app que podem ser atualizados.
function appRoot() {
  return app.isPackaged ? path.join(process.resourcesPath, "app") : path.join(__dirname, "..");
}

function currentVersion() {
  try {
    const stateFile = path.join(app.getPath("userData"), "atlas-version.json");
    if (fs.existsSync(stateFile)) return JSON.parse(fs.readFileSync(stateFile, "utf8")).version;
  } catch { /* usa a versão do pacote */ }
  return app.getVersion();
}

function setCurrentVersion(version) {
  fs.writeFileSync(path.join(app.getPath("userData"), "atlas-version.json"), JSON.stringify({ version }, null, 2));
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

// Lista os arquivos atualizáveis do app com seus hashes (ignora node_modules e o Electron em si).
async function localFiles(dir = appRoot(), base = appRoot()) {
  const out = [];
  let entries = [];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await localFiles(full, base)));
    } else {
      const buf = await fsp.readFile(full);
      out.push({ path: path.relative(base, full).split(path.sep).join("/"), sha256: sha256(buf), size: buf.length });
    }
  }
  return out;
}

// Compara versões no formato 1.2.3 (-1 menor, 0 igual, 1 maior).
function compareVersions(a, b) {
  const pa = String(a).split(".").map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0) ? 1 : -1;
  }
  return 0;
}

async function checkForUpdates(baseUrl) {
  const versao = currentVersion();
  const arquivos = (await localFiles()).map((f) => ({ path: f.path, sha256: f.sha256 }));
  const res = await fetch(`${baseUrl}/api/public/atualizacao`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ versao, arquivos }),
  });
  if (!res.ok) throw new Error(`Não foi possível consultar atualizações (${res.status}).`);
  const info = await res.json();

  // Proteção contra downgrade: só aceita versões maiores que a instalada,
  // e só se o servidor informar a origem (URL https) dos arquivos.
  const maior = info.version ? compareVersions(info.version, versao) > 0 : false;
  const origemOk = (info.arquivos ?? []).every((f) => /^https:\/\//i.test(String(f.url ?? "")));
  return {
    ...info,
    versao_atual: versao,
    atualizacao_disponivel: Boolean(info.atualizacao_disponivel && maior && origemOk),
  };
}

async function downloadAndVerify(file) {
  const res = await fetch(file.url);
  if (!res.ok) throw new Error(`Falha ao baixar ${file.path} (${res.status}).`);
  const buf = Buffer.from(await res.arrayBuffer());
  const hash = sha256(buf);
  if (hash !== String(file.sha256).toLowerCase()) {
    throw new Error(`Arquivo corrompido: ${file.path}.`);
  }
  return buf;
}

/**
 * Baixa e instala a atualização.
 * onProgress({ etapa, feito, total, mensagem })
 */
async function installUpdate(info, onProgress = () => {}) {
  const root = appRoot();
  const staging = path.join(app.getPath("userData"), "atualizacao", String(info.version));
  await fsp.rm(staging, { recursive: true, force: true });
  await fsp.mkdir(staging, { recursive: true });

  let alvos = Array.isArray(info.delta) && info.delta.length ? info.delta : info.arquivos ?? [];
  let usouPacoteCompleto = false;

  // 1) Tenta a atualização incremental (só os arquivos alterados).
  const baixados = [];
  try {
    if (!alvos.length) throw new Error("Nada para baixar.");
    let feito = 0;
    for (const file of alvos) {
      onProgress({ etapa: "baixando", feito, total: alvos.length, mensagem: `Baixando ${file.path}` });
      const buf = await downloadAndVerify(file);
      const dest = path.join(staging, file.path);
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.writeFile(dest, buf);
      baixados.push(file.path);
      feito += 1;
    }
  } catch (error) {
    // 2) Fallback: pacote completo, também validado por checksum.
    if (!info.pacote?.url) throw error;
    onProgress({ etapa: "baixando", feito: 0, total: 1, mensagem: "Baixando o pacote completo..." });
    const buf = await downloadAndVerify({ path: "pacote", url: info.pacote.url, sha256: info.pacote.sha256 });
    const zipPath = path.join(staging, `atlas-${info.version}.zip`);
    await fsp.writeFile(zipPath, buf);
    usouPacoteCompleto = true;
    return { ok: true, pacoteCompleto: zipPath, version: info.version };
  }

  // 3) Instala com backup + rollback.
  const backup = path.join(app.getPath("userData"), "backup", String(currentVersion()));
  await fsp.rm(backup, { recursive: true, force: true });
  await fsp.mkdir(backup, { recursive: true });

  const trocados = [];
  try {
    onProgress({ etapa: "instalando", feito: 0, total: baixados.length, mensagem: "Instalando..." });
    for (const rel of baixados) {
      const atual = path.join(root, rel);
      if (fs.existsSync(atual)) {
        const copia = path.join(backup, rel);
        await fsp.mkdir(path.dirname(copia), { recursive: true });
        await fsp.copyFile(atual, copia);
      }
      await fsp.mkdir(path.dirname(atual), { recursive: true });
      await fsp.copyFile(path.join(staging, rel), atual);
      trocados.push(rel);
    }
    setCurrentVersion(info.version);
    await fsp.rm(staging, { recursive: true, force: true });
    return { ok: true, version: info.version, pacoteCompleto: null, usouPacoteCompleto };
  } catch (error) {
    // Rollback: devolve todos os arquivos trocados.
    for (const rel of trocados) {
      const copia = path.join(backup, rel);
      if (fs.existsSync(copia)) {
        try { await fsp.copyFile(copia, path.join(root, rel)); } catch { /* segue restaurando */ }
      }
    }
    throw new Error(`A atualização falhou e a versão anterior foi restaurada: ${error.message}`);
  }
}

// Verificação periódica em segundo plano.
function startBackgroundChecks(baseUrl, onUpdateAvailable) {
  const run = async () => {
    try {
      const info = await checkForUpdates(baseUrl);
      if (info.atualizacao_disponivel) onUpdateAvailable(info);
    } catch { /* sem internet: tenta na próxima */ }
  };
  setTimeout(run, 4000);
  const timer = setInterval(run, CHECK_INTERVAL_MS);
  return () => clearInterval(timer);
}

module.exports = { checkForUpdates, installUpdate, startBackgroundChecks, currentVersion, localFiles };
