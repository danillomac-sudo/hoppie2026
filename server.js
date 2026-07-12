"use strict";

const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
const PUBLIC_DIR = path.join(__dirname, "public");
const DATA_DIR =
  process.env.DATA_DIR ||
  (process.env.VERCEL
    ? path.join(os.tmpdir(), "simbrief-hoppie-dispatcher")
    : path.join(__dirname, ".data"));
const JOBS_FILE = path.join(DATA_DIR, "jobs.json");
const ENV_FILE = path.join(__dirname, ".env");

loadEnvFile(ENV_FILE);

const SIMBRIEF_ENDPOINT = "https://www.simbrief.com/api/xml.fetcher.php";
const HOPPIE_ENDPOINT =
  process.env.HOPPIE_ENDPOINT ||
  "http://www.hoppie.nl/acars/system/connect.html";
const SITE_USER = process.env.SITE_USER || "admin";
const SITE_PASSWORD = process.env.SITE_PASSWORD || "";
const DEFAULT_SIMBRIEF_USERID = process.env.DEFAULT_SIMBRIEF_USERID || "";
const DEFAULT_HOPPIE_LOGON = process.env.HOPPIE_LOGON || "";
const DEFAULT_HOPPIE_FROM = process.env.DEFAULT_HOPPIE_FROM || "DANOPS";

const HOPPIE_TYPES = new Set(["telex", "progress", "cpdlc", "ping"]);
const jobs = new Map();
const timers = new Map();

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8",
};

function loadEnvFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      return;
    }

    const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }

      const separator = trimmed.indexOf("=");
      if (separator === -1) {
        continue;
      }

      const key = trimmed.slice(0, separator).trim();
      const value = trimmed
        .slice(separator + 1)
        .trim()
        .replace(/^['"]|['"]$/g, "");

      if (key && process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  } catch (error) {
    console.warn(`Nao foi possivel carregar .env: ${error.message}`);
  }
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body, null, 2));
}

function sendText(res, status, body, headers = {}) {
  res.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    ...headers,
  });
  res.end(body);
}

function timingSafeEqualText(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function isAuthorized(req) {
  if (!SITE_PASSWORD) {
    return true;
  }

  const header = req.headers.authorization || "";
  if (!header.startsWith("Basic ")) {
    return false;
  }

  const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  const separator = decoded.indexOf(":");
  if (separator === -1) {
    return false;
  }

  const user = decoded.slice(0, separator);
  const password = decoded.slice(separator + 1);
  return (
    timingSafeEqualText(user, SITE_USER) &&
    timingSafeEqualText(password, SITE_PASSWORD)
  );
}

function requireAuth(req, res) {
  if (isAuthorized(req)) {
    return true;
  }

  sendText(res, 401, "Autenticacao necessaria.", {
    "WWW-Authenticate": 'Basic realm="SimBrief Hoppie Dispatcher"',
  });
  return false;
}

function ensureDataDir() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    return true;
  } catch (error) {
    console.warn(
      `Persistencia em arquivo desativada; nao foi possivel criar ${DATA_DIR}: ${error.message}`
    );
    return false;
  }
}

function loadJobs() {
  try {
    if (!fs.existsSync(JOBS_FILE)) {
      return;
    }
    const savedJobs = JSON.parse(fs.readFileSync(JOBS_FILE, "utf8"));
    for (const job of savedJobs) {
      jobs.set(job.id, job);
    }
  } catch (error) {
    console.warn(`Nao foi possivel carregar jobs salvos: ${error.message}`);
  }
}

function saveJobs() {
  try {
    if (!ensureDataDir()) {
      return;
    }
    const safeJobs = Array.from(jobs.values()).map(({ logon, ...job }) => job);
    fs.writeFileSync(JOBS_FILE, JSON.stringify(safeJobs, null, 2));
  } catch (error) {
    console.warn(`Nao foi possivel salvar jobs em arquivo: ${error.message}`);
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 128_000) {
        req.destroy();
        reject(new Error("Payload muito grande."));
      }
    });
    req.on("end", () => {
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("JSON invalido."));
      }
    });
    req.on("error", reject);
  });
}

function cleanCallsign(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_-]/g, "");
}

function requiredString(value, fieldName) {
  const text = String(value || "").trim();
  if (!text) {
    throw new Error(`Campo obrigatorio: ${fieldName}.`);
  }
  return text;
}

function normalizeSimbriefValue(value) {
  if (value === undefined || value === null) {
    return "";
  }
  if (Array.isArray(value)) {
    return value.map(normalizeSimbriefValue).filter(Boolean).join(" ");
  }
  if (typeof value === "object") {
    return "";
  }
  return String(value).trim();
}

function valueAt(data, paths, fallback = "") {
  for (const dottedPath of paths) {
    const value = dottedPath.split(".").reduce((current, key) => {
      if (current && Object.prototype.hasOwnProperty.call(current, key)) {
        return current[key];
      }
      return undefined;
    }, data);

    const normalized = normalizeSimbriefValue(value);
    if (normalized) {
      return normalized;
    }
  }
  return fallback;
}

function simplifyRoute(route) {
  const tokens = String(route || "")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);

  if (tokens.length <= 10) {
    return tokens.join(" ");
  }

  return `${tokens.slice(0, 5).join(" ")} ... ${tokens.slice(-4).join(" ")}`;
}

function formatNumber(value, suffix = "") {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return String(value || "");
  }
  return `${Math.round(numeric).toLocaleString("en-US")}${suffix}`;
}

function formatEpoch(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return "";
  }
  return new Date(numeric * 1000).toISOString().replace("T", " ").slice(0, 16);
}

function formatDuration(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return String(value || "");
  }
  const hours = Math.floor(numeric / 3600);
  const minutes = Math.round((numeric % 3600) / 60);
  return `${String(hours).padStart(2, "0")}h${String(minutes).padStart(2, "0")}`;
}

function buildFlightSummary(ofp) {
  const origin = String(
    valueAt(ofp, ["origin.icao_code", "origin.icao", "origin.iata_code"], "")
  ).toUpperCase();
  const destination = String(
    valueAt(ofp, [
      "destination.icao_code",
      "destination.icao",
      "destination.iata_code",
    ])
  ).toUpperCase();
  const alternate = String(
    valueAt(ofp, ["alternate.icao_code", "alternate.icao", "alternate.iata_code"])
  ).toUpperCase();
  const flightNumber = String(
    valueAt(ofp, [
      "general.flight_number",
      "general.icao_airline",
      "params.flight_number",
    ])
  ).toUpperCase();
  const callsign =
    String(valueAt(ofp, ["atc.callsign", "general.callsign"], "")).toUpperCase() ||
    flightNumber;
  const route = String(valueAt(ofp, ["general.route", "route"], ""));
  const sidIdent = String(valueAt(ofp, ["general.sid_ident"], "")).toUpperCase();
  const sidTrans = String(valueAt(ofp, ["general.sid_trans"], "")).toUpperCase();
  const sid = [sidIdent, sidTrans].filter(Boolean).join(" ");
  const cruiseAltitude = String(
    valueAt(ofp, [
      "general.initial_altitude",
      "general.cruise_altitude",
      "params.fl",
    ])
  ).toUpperCase();
  const aircraft = String(
    valueAt(ofp, ["aircraft.icaocode", "aircraft.icao_code", "params.type"], "")
  ).toUpperCase();
  const registration = String(
    valueAt(ofp, ["aircraft.reg", "aircraft.registration"], "")
  ).toUpperCase();
  const schedOut =
    formatEpoch(valueAt(ofp, ["times.sched_out", "times.scheduled_out"])) ||
    String(valueAt(ofp, ["times.sched_out_local", "times.est_out"], ""));

  return {
    callsign,
    flightNumber,
    origin,
    destination,
    alternate,
    aircraft,
    registration,
    cruiseAltitude,
    sid,
    sidIdent,
    sidTrans,
    sid_ident: sidIdent,
    sid_trans: sidTrans,
    route,
    routeShort: simplifyRoute(route),
    distance: formatNumber(
      valueAt(ofp, ["general.route_distance", "general.distance", "distance"]),
      " NM"
    ),
    ete:
      formatDuration(valueAt(ofp, ["times.est_time_enroute", "times.enroute"])) ||
      String(valueAt(ofp, ["times.est_time_enroute_text", "times.enroute_text"], "")),
    blockFuel: formatNumber(
      valueAt(ofp, ["fuel.plan_ramp", "fuel.plan_takeoff", "fuel.block"], "")
    ),
    costIndex: String(valueAt(ofp, ["general.costindex", "params.civalue"], "")),
    zfw: formatNumber(valueAt(ofp, ["weights.est_zfw", "weights.zfw"], "")),
    payload: formatNumber(valueAt(ofp, ["weights.payload"], "")),
    release: String(valueAt(ofp, ["general.release", "params.release"], "")),
    generatedAt:
      formatEpoch(valueAt(ofp, ["params.time_generated", "general.time_generated"])) ||
      new Date().toISOString().replace("T", " ").slice(0, 16),
    schedOut,
  };
}

function fillTemplate(template, summary) {
  return String(template || "")
    .replace(/\{([a-zA-Z0-9_]+)\}/g, (_, key) => summary[key] ?? "")
    .replace(/[ \t]+$/gm, "")
    .trim();
}

function defaultPacket(summary) {
  return fillTemplate(
    [
      "DISPATCH {callsign}",
      "FLT {flightNumber} {origin}-{destination} SID {sid} ALT {cruiseAltitude} ETE {ete}",
      "ACFT {aircraft} REG {registration} ALTN {alternate}",
      "BLOCK FUEL {blockFuel} CI {costIndex}",
    ].join("\n"),
    summary
  );
}

async function fetchSimbrief({ username, userid, staticId }) {
  const url = new URL(SIMBRIEF_ENDPOINT);
  if (userid) {
    url.searchParams.set("userid", userid);
  } else {
    url.searchParams.set("username", username);
  }
  if (staticId) {
    url.searchParams.set("static_id", staticId);
  }
  url.searchParams.set("json", "1");

  let response;
  try {
    response = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    const detail = error.cause?.code || error.cause?.message || error.message;
    if (detail === "EACCES") {
      throw new Error(
        "Nao foi possivel conectar ao SimBrief porque o processo local esta sem permissao de rede. Reinicie o servidor fora do sandbox/restricao do Codex."
      );
    }
    throw new Error(
      `Nao foi possivel conectar ao SimBrief. Detalhe: ${detail}.`
    );
  }
  const body = await response.text();

  if (!response.ok) {
    throw new Error(`SimBrief retornou HTTP ${response.status}: ${body.slice(0, 200)}`);
  }

  let data;
  try {
    data = JSON.parse(body);
  } catch {
    throw new Error("SimBrief nao retornou JSON valido.");
  }

  if (data?.fetch?.status === "Error" || data?.error) {
    throw new Error(data?.fetch?.message || data?.error || "Erro no SimBrief.");
  }

  return { raw: data, summary: buildFlightSummary(data) };
}

async function sendHoppieMessage({ logon, from, to, type, packet }) {
  const form = new URLSearchParams();
  form.set("logon", logon);
  form.set("from", from);
  form.set("to", to);
  form.set("type", type);
  form.set("packet", packet);

  const response = await fetch(HOPPIE_ENDPOINT, {
    method: "POST",
    body: form,
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "SimBrief-Hoppie-Dispatcher/1.0",
    },
    signal: AbortSignal.timeout(15_000),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Hoppie retornou HTTP ${response.status}: ${text.slice(0, 200)}`);
  }
  if (/^error\b/i.test(text.trim())) {
    throw new Error(text.trim());
  }

  return text.trim() || "OK";
}

function publicJob(job) {
  const { logon, ...safeJob } = job;
  return safeJob;
}

function persistJob(job) {
  jobs.set(job.id, job);
  saveJobs();
}

async function executeJob(id) {
  const job = jobs.get(id);
  if (!job || job.status !== "queued") {
    return;
  }

  if (!job.logon) {
    job.status = "error";
    job.error = "Logon do Hoppie nao foi preservado apos reinicio do servidor.";
    job.failedAt = new Date().toISOString();
    persistJob(job);
    return;
  }

  job.status = "sending";
  job.startedAt = new Date().toISOString();
  persistJob(job);

  try {
    const response = await sendHoppieMessage({
      logon: job.logon,
      from: job.from,
      to: job.to,
      type: job.type,
      packet: job.packet,
    });
    job.status = "sent";
    job.response = response;
    job.sentAt = new Date().toISOString();
  } catch (error) {
    job.status = "error";
    job.error = error.message;
    job.failedAt = new Date().toISOString();
  } finally {
    timers.delete(id);
    persistJob(job);
  }
}

function scheduleTimer(job) {
  clearTimeout(timers.get(job.id));
  if (job.status !== "queued") {
    return;
  }

  const delayMs = Math.max(0, new Date(job.sendAt).getTime() - Date.now());
  const timer = setTimeout(() => executeJob(job.id), delayMs);
  timers.set(job.id, timer);
}

function restoreTimers() {
  for (const job of jobs.values()) {
    scheduleTimer(job);
  }
}

async function handleApi(req, res, url) {
  try {
    if (req.method === "GET" && url.pathname === "/api/health") {
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/config") {
      sendJson(res, 200, {
        defaultSimbriefUserid: DEFAULT_SIMBRIEF_USERID,
        defaultHoppieFrom: DEFAULT_HOPPIE_FROM,
        hoppieLogonConfigured: Boolean(DEFAULT_HOPPIE_LOGON),
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/simbrief") {
      const username = String(url.searchParams.get("username") || "").trim();
      const userid = String(url.searchParams.get("userid") || "").trim();
      const staticId = String(url.searchParams.get("staticId") || "").trim();

      if (!username && !userid) {
        sendJson(res, 400, { error: "Informe username ou Pilot ID do SimBrief." });
        return;
      }

      const result = await fetchSimbrief({ username, userid, staticId });
      sendJson(res, 200, result);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/jobs") {
      sendJson(res, 200, { jobs: Array.from(jobs.values()).map(publicJob) });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/schedule") {
      const body = await readBody(req);
      const username = String(body.username || "").trim();
      const userid = String(body.userid || DEFAULT_SIMBRIEF_USERID).trim();
      const staticId = String(body.staticId || "").trim();
      const logon = String(body.logon || DEFAULT_HOPPIE_LOGON).trim();
      const from = cleanCallsign(body.from || DEFAULT_HOPPIE_FROM);
      const type = String(body.type || "telex").toLowerCase();
      const delayMinutes = Number(body.delayMinutes ?? 5);

      if (!username && !userid) {
        throw new Error("Informe username ou Pilot ID do SimBrief.");
      }
      if (!logon) {
        throw new Error("Configure o Hoppie logon no servidor ou informe na tela.");
      }
      if (!from) {
        throw new Error("Configure o callsign remetente do Hoppie no servidor.");
      }
      if (!HOPPIE_TYPES.has(type)) {
        throw new Error("Tipo Hoppie invalido.");
      }
      if (!Number.isFinite(delayMinutes) || delayMinutes < 0 || delayMinutes > 180) {
        throw new Error("Delay deve estar entre 0 e 180 minutos.");
      }

      const { summary } = await fetchSimbrief({ username, userid, staticId });
      const to = cleanCallsign(body.to || summary.callsign || summary.flightNumber);
      if (!to) {
        throw new Error("O SimBrief nao retornou callsign para usar como destino Hoppie.");
      }
      const packet = fillTemplate(body.template || defaultPacket(summary), summary);
      if (!packet) {
        throw new Error("Mensagem vazia apos aplicar o template.");
      }
      if (packet.length > 900) {
        throw new Error("Mensagem muito longa. Mantenha abaixo de 900 caracteres.");
      }

      const id = crypto.randomUUID();
      const createdAt = new Date();
      const sendAt = new Date(createdAt.getTime() + delayMinutes * 60_000);
      const job = {
        id,
        status: "queued",
        createdAt: createdAt.toISOString(),
        sendAt: sendAt.toISOString(),
        from,
        to,
        type,
        packet,
        summary,
        response: "",
        error: "",
        logon,
      };

      persistJob(job);
      scheduleTimer(job);
      sendJson(res, 201, { job: publicJob(job) });
      return;
    }

    const cancelMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)\/cancel$/);
    if (req.method === "POST" && cancelMatch) {
      const id = cancelMatch[1];
      const job = jobs.get(id);
      if (!job) {
        sendJson(res, 404, { error: "Agendamento nao encontrado." });
        return;
      }
      if (job.status !== "queued") {
        sendJson(res, 409, { error: "Esse agendamento nao pode mais ser cancelado." });
        return;
      }
      clearTimeout(timers.get(id));
      timers.delete(id);
      job.status = "cancelled";
      job.cancelledAt = new Date().toISOString();
      persistJob(job);
      sendJson(res, 200, { job: publicJob(job) });
      return;
    }

    sendJson(res, 404, { error: "Endpoint nao encontrado." });
  } catch (error) {
    sendJson(res, 400, { error: error.message });
  }
}

function serveStatic(req, res, url) {
  const requestedPath = url.pathname === "/" ? "/index.html" : url.pathname;
  const resolvedPath = path.normalize(path.join(PUBLIC_DIR, requestedPath));

  if (!resolvedPath.startsWith(PUBLIC_DIR)) {
    sendText(res, 403, "Acesso negado.");
    return;
  }

  fs.readFile(resolvedPath, (error, data) => {
    if (error) {
      sendText(res, 404, "Arquivo nao encontrado.");
      return;
    }
    const contentType =
      MIME_TYPES[path.extname(resolvedPath).toLowerCase()] ||
      "application/octet-stream";
    res.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": "no-store",
    });
    res.end(data);
  });
}

loadJobs();
restoreTimers();

const server = http.createServer((req, res) => {
  if (!requireAuth(req, res)) {
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  if (url.pathname.startsWith("/api/")) {
    handleApi(req, res, url);
    return;
  }
  serveStatic(req, res, url);
});

server.listen(PORT, HOST, () => {
  console.log(`SimBrief Hoppie Dispatcher em http://${HOST}:${PORT}`);
});
