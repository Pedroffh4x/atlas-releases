// Atlas Desktop — ponte com o PC (pareamento, tarefas e análise local de sites).
const { exec } = require("node:child_process");
const { hostname, type: osType, release } = require("node:os");

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Atlas/1.0 Chrome/124 Safari/537.36";

function normalizeUrl(input) {
  const trimmed = String(input).trim();
  return new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
}

class CookieJar {
  constructor() {
    this.jar = new Map();
  }
  absorb(response) {
    const list =
      response.headers.getSetCookie?.() ??
      (response.headers.get("set-cookie") ? [response.headers.get("set-cookie")] : []);
    for (const cookie of list) {
      const pair = cookie.split(";")[0] ?? "";
      const idx = pair.indexOf("=");
      if (idx < 0) continue;
      this.jar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
    }
  }
  header() {
    if (this.jar.size === 0) return undefined;
    return Array.from(this.jar.entries()).map(([k, v]) => `${k}=${v}`).join("; ");
  }
}

const match = (html, re) => html.match(re)?.[1]?.trim() ?? null;
const matchAll = (html, re) => Array.from(html.matchAll(re)).map((m) => (m[1] ?? "").trim());

async function fetchPage(url, jar, timeoutMs = 15000) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const cookie = jar.header();
    const response = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent": UA,
        Accept: "text/html,application/xhtml+xml",
        ...(cookie ? { Cookie: cookie } : {}),
      },
    });
    jar.absorb(response);
    const body = await response.text();
    return { response, body, responseMs: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

function analyzeHtml(url, html, status, responseMs) {
  const title = match(html, /<title[^>]*>([\s\S]*?)<\/title>/i);
  const description = match(html, /<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i);
  const h1 = matchAll(html, /<h1[^>]*>([\s\S]*?)<\/h1>/gi).map((t) => t.replace(/<[^>]+>/g, "").trim());
  const imgs = Array.from(html.matchAll(/<img\b[^>]*>/gi)).map((m) => m[0]);
  const imagesWithoutAlt = imgs.filter((tag) => !/\balt\s*=/i.test(tag)).length;
  const links = Array.from(html.matchAll(/<a\b[^>]*href=["']([^"']+)["']/gi)).length;

  const issues = [];
  if (!title) issues.push("Sem <title>.");
  else if (title.length > 60) issues.push(`Título com ${title.length} caracteres (ideal < 60).`);
  if (!description) issues.push("Sem meta description.");
  else if (description.length > 160) issues.push(`Meta description com ${description.length} caracteres (ideal < 160).`);
  if (h1.length === 0) issues.push("Nenhum H1 na página.");
  if (h1.length > 1) issues.push(`${h1.length} H1 na mesma página (deve ser 1).`);
  if (imagesWithoutAlt > 0) issues.push(`${imagesWithoutAlt} imagens sem texto alternativo.`);
  if (!/<meta[^>]+property=["']og:title["']/i.test(html)) issues.push("Sem og:title.");
  if (!/<html[^>]+lang=/i.test(html)) issues.push("Sem atributo lang no <html>.");
  if (responseMs > 1500) issues.push(`Resposta lenta: ${responseMs} ms.`);
  if (status >= 400) issues.push(`Status HTTP ${status}.`);

  return {
    url, status, responseMs, bytes: html.length, title, description, h1,
    imagesWithoutAlt, imagesTotal: imgs.length, links, issues,
  };
}

function collectInternalLinks(base, html, limit) {
  const out = [];
  for (const m of html.matchAll(/<a\b[^>]*href=["']([^"']+)["']/gi)) {
    if (out.length >= limit) break;
    const href = m[1];
    if (!href || href.startsWith("#") || href.startsWith("mailto:") || href.startsWith("tel:")) continue;
    try {
      const abs = new URL(href, base);
      if (abs.hostname !== base.hostname) continue;
      abs.hash = "";
      const clean = abs.toString();
      if (!out.includes(clean)) out.push(clean);
    } catch { /* ignora */ }
  }
  return out;
}

async function tryLogin(loginUrl, username, password, jar) {
  try {
    const { body } = await fetchPage(loginUrl, jar);
    const form = body.match(/<form[\s\S]*?<\/form>/i)?.[0] ?? "";
    const actionRaw = match(form, /action=["']([^"']*)["']/i) ?? loginUrl;
    const action = new URL(actionRaw || loginUrl, loginUrl).toString();

    const fields = new URLSearchParams();
    for (const tag of form.matchAll(/<input\b[^>]*>/gi)) {
      const input = tag[0];
      const name = match(input, /name=["']([^"']+)["']/i);
      if (!name) continue;
      const type = (match(input, /type=["']([^"']+)["']/i) ?? "text").toLowerCase();
      const value = match(input, /value=["']([^"']*)["']/i) ?? "";
      if (type === "password") fields.set(name, password);
      else if (/user|email|login|nome/i.test(name) && type !== "hidden") fields.set(name, username);
      else fields.set(name, value);
    }
    if (!Array.from(fields.values()).includes(password)) {
      fields.set("password", password);
      fields.set("username", username);
    }

    const response = await fetch(action, {
      method: "POST",
      redirect: "follow",
      headers: {
        "User-Agent": UA,
        "Content-Type": "application/x-www-form-urlencoded",
        ...(jar.header() ? { Cookie: jar.header() } : {}),
      },
      body: fields.toString(),
    });
    jar.absorb(response);
    const after = await response.text();
    return response.status < 400 && !/senha inv|invalid (password|login)|incorret/i.test(after);
  } catch {
    return false;
  }
}

async function analyzeSite(options) {
  const base = normalizeUrl(options.url);
  const jar = new CookieJar();
  const maxPages = Math.min(Math.max(Number(options.maxPages) || 6, 1), 40);

  let loggedIn = false;
  if (options.username && options.password) {
    loggedIn = await tryLogin(options.loginUrl || base.toString(), options.username, options.password, jar);
  }

  const first = await fetchPage(base.toString(), jar);
  const headers = first.response.headers;
  const securityHeaders = {
    "strict-transport-security": headers.get("strict-transport-security"),
    "content-security-policy": headers.get("content-security-policy"),
    "x-frame-options": headers.get("x-frame-options"),
    "x-content-type-options": headers.get("x-content-type-options"),
    "referrer-policy": headers.get("referrer-policy"),
    "permissions-policy": headers.get("permissions-policy"),
  };

  const pages = [analyzeHtml(base.toString(), first.body, first.response.status, first.responseMs)];
  const queue = collectInternalLinks(base, first.body, maxPages - 1);
  const seen = new Set([base.toString()]);
  while (queue.length && pages.length < maxPages) {
    const link = queue.shift();
    if (seen.has(link)) continue;
    seen.add(link);
    try {
      const page = await fetchPage(link, jar);
      pages.push(analyzeHtml(link, page.body, page.response.status, page.responseMs));
      if (pages.length < maxPages) {
        for (const next of collectInternalLinks(base, page.body, maxPages)) {
          if (!seen.has(next) && !queue.includes(next)) queue.push(next);
        }
      }
    } catch {
      pages.push({
        url: link, status: 0, responseMs: 0, bytes: 0, title: null, description: null,
        h1: [], imagesWithoutAlt: 0, imagesTotal: 0, links: 0,
        issues: ["Não foi possível carregar a página."],
      });
    }
  }

  const brokenLinks = pages
    .filter((p) => p.status === 0 || p.status >= 400)
    .map((p) => ({ url: p.url, status: p.status }));

  const [robots, sitemap] = await Promise.all([
    fetch(new URL("/robots.txt", base).toString(), { headers: { "User-Agent": UA } }).then((r) => r.ok).catch(() => false),
    fetch(new URL("/sitemap.xml", base).toString(), { headers: { "User-Agent": UA } }).then((r) => r.ok).catch(() => false),
  ]);

  const avgMs = Math.round(pages.reduce((a, p) => a + p.responseMs, 0) / pages.length);
  const seoIssues = pages.reduce((a, p) => a + p.issues.length, 0);
  const securityPresent = Object.values(securityHeaders).filter(Boolean).length;
  const altIssues = pages.reduce((a, p) => a + p.imagesWithoutAlt, 0);
  const clamp = (n) => Math.max(0, Math.min(100, Math.round(n)));

  const scores = {
    performance: clamp(100 - avgMs / 25 - brokenLinks.length * 5),
    seo: clamp(100 - (seoIssues / pages.length) * 6 - (robots ? 0 : 5) - (sitemap ? 0 : 5)),
    security: clamp((base.protocol === "https:" ? 55 : 10) + (securityPresent / 6) * 45),
    accessibility: clamp(100 - altIssues * 2 - pages.filter((p) => p.h1.length === 0).length * 6),
  };

  const summary = [];
  summary.push(`${pages.length} páginas analisadas neste PC, tempo médio de resposta ${avgMs} ms.`);
  if (base.protocol !== "https:") summary.push("O site não usa HTTPS.");
  const missingHeaders = Object.entries(securityHeaders).filter(([, v]) => !v).map(([k]) => k);
  if (missingHeaders.length) summary.push(`Cabeçalhos de segurança ausentes: ${missingHeaders.join(", ")}.`);
  if (!robots) summary.push("robots.txt não encontrado.");
  if (!sitemap) summary.push("sitemap.xml não encontrado.");
  if (brokenLinks.length) summary.push(`${brokenLinks.length} páginas com erro de carregamento.`);
  if (options.username) {
    summary.push(loggedIn ? "Login realizado com sucesso." : "Login não confirmado — a área interna pode não ter sido analisada.");
  }

  return {
    target: base.toString(),
    https: base.protocol === "https:",
    loggedIn,
    securityHeaders,
    robotsTxt: robots,
    sitemap,
    pages,
    brokenLinks,
    scores,
    summary,
    ranOn: hostname(),
  };
}

function runCommand(command) {
  return new Promise((resolve) => {
    exec(command, { timeout: 5 * 60 * 1000, maxBuffer: 10 * 1024 * 1024 }, (error, stdoutStr, stderrStr) => {
      resolve({
        stdout: String(stdoutStr ?? ""),
        stderr: String(stderrStr ?? (error?.message || "")),
        exit_code: error?.code ?? 0,
      });
    });
  });
}

// Identificação deste computador enviada ao site (nunca inclui token nem dados sensíveis).
function deviceMeta(appVersion) {
  return {
    hostname: hostname(),
    app_version: String(appVersion ?? ""),
    os: `${osType()} ${release()}`,
    arch: process.arch,
    platform: process.platform,
  };
}

// Pareia este computador com a conta do Atlas usando o código da página "Meu PC".
async function pair(baseUrl, code, appVersion) {
  const res = await fetch(`${baseUrl}/api/public/agent/pair`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pair_code: String(code).trim().toUpperCase(), ...deviceMeta(appVersion) }),
  });
  if (!res.ok) throw new Error(`Falha ao parear (${res.status}). Confira o endereço do site e o código.`);
  return res.json();
}

// Loop de tarefas: busca, executa no PC e devolve o resultado.
function startLoop({ baseUrl, token, onStatus, appVersion }) {
  let stopped = false;
  const auth = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const meta = JSON.stringify(deviceMeta(appVersion));

  (async () => {
    while (!stopped) {
      try {
        const res = await fetch(`${baseUrl}/api/public/agent/poll`, { method: "POST", headers: auth, body: meta });
        if (res.status === 401) {
          onStatus?.({ state: "erro", message: "Computador não autorizado. Conecte novamente." });
          return;
        }
        const { tasks = [] } = await res.json();
        onStatus?.({ state: "conectado", message: tasks.length ? `Executando ${tasks.length} tarefa(s)...` : "Conectado e aguardando tarefas." });
        for (const task of tasks) {
          let result;
          if (task.kind === "analise") {
            const options = JSON.parse(task.command);
            onStatus?.({ state: "trabalhando", message: `Analisando ${options.url} neste PC...` });
            try {
              const report = await analyzeSite(options);
              result = { stdout: JSON.stringify(report), stderr: "", exit_code: 0 };
            } catch (error) {
              result = { stdout: "", stderr: error.message, exit_code: 1 };
            }
          } else {
            onStatus?.({ state: "trabalhando", message: `Executando: ${task.command}` });
            result = await runCommand(task.command);
          }
          await fetch(`${baseUrl}/api/public/agent/result`, {
            method: "POST",
            headers: auth,
            body: JSON.stringify({ task_id: task.id, ...result }),
          });
        }
      } catch (error) {
        onStatus?.({ state: "erro", message: `Sem conexão com o site: ${error.message}` });
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
  })();

  return () => { stopped = true; };
}

module.exports = { pair, startLoop, analyzeSite, deviceMeta };
