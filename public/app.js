"use strict";

const form = document.querySelector("#dispatchForm");
const ifrForm = document.querySelector("#ifrForm");
const fetchButton = document.querySelector("#fetchButton");
const importIfrButton = document.querySelector("#importIfrButton");
const refreshJobsButton = document.querySelector("#refreshJobs");
const refreshPlansButton = document.querySelector("#refreshPlans");
const jobsList = document.querySelector("#jobsList");
const flightPlanList = document.querySelector("#flightPlanList");
const validationSteps = document.querySelector("#validationSteps");
const toast = document.querySelector("#toast");
const charCount = document.querySelector("#charCount");
const routeCanvas = document.querySelector("#routeCanvas");

let currentSummary = null;
let currentIfrPlan = null;
let toastTimer = null;

const fields = {
  generatedAt: document.querySelector("#generatedAt"),
  factFlight: document.querySelector("#factFlight"),
  factRoute: document.querySelector("#factRoute"),
  factAircraft: document.querySelector("#factAircraft"),
  factFuel: document.querySelector("#factFuel"),
  factHoppie: document.querySelector("#factHoppie"),
  quickPilot: document.querySelector("#quickPilot"),
  quickDispatcher: document.querySelector("#quickDispatcher"),
  quickTarget: document.querySelector("#quickTarget"),
  quickState: document.querySelector("#quickState"),
  flowFrom: document.querySelector("#flowFrom"),
  flowTo: document.querySelector("#flowTo"),
  hoppieStatus: document.querySelector("#hoppieStatus"),
  ifrStatus: document.querySelector("#ifrStatus"),
  ifrSquawk: document.querySelector("#ifrSquawk"),
  ifrClearance: document.querySelector("#ifrClearance"),
  ifrSourceHint: document.querySelector("#ifrSourceHint"),
};

let appConfig = {
  defaultHoppieFrom: "",
  hoppieLogonConfigured: false,
};

function showToast(message) {
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.classList.add("is-visible");
  toastTimer = setTimeout(() => toast.classList.remove("is-visible"), 4200);
}

function getFormData() {
  const data = Object.fromEntries(new FormData(form).entries());
  data.delayMinutes = Number(data.delayMinutes || 0);
  return data;
}

function getIfrFormData() {
  return Object.fromEntries(new FormData(ifrForm).entries());
}

function setIfEmpty(element, value) {
  if (!element || String(element.value || "").trim()) {
    return;
  }
  element.value = value || "";
}

function syncIfrFromSummary(summary) {
  if (!summary) {
    return;
  }

  setIfEmpty(ifrForm.callsign, summary.callsign || summary.flightNumber);
  setIfEmpty(ifrForm.aircraftType, summary.aircraft);
  setIfEmpty(ifrForm.origin, summary.origin);
  setIfEmpty(ifrForm.destination, summary.destination);
  setIfEmpty(ifrForm.alternate, summary.alternate);
  setIfEmpty(ifrForm.flightLevel, summary.cruiseAltitude);
  setIfEmpty(ifrForm.etdUtc, summary.schedOut);
  setIfEmpty(ifrForm.sid, summary.sidIdent || summary.sid);
  setIfEmpty(ifrForm.sidTransition, summary.sidTrans || summary.sidTransition);
  setIfEmpty(ifrForm.route, summary.route);
  setIfEmpty(ifrForm.equipment, "SDE2E3FGHIRWXY/LB1");
  setIfEmpty(ifrForm.remarks, "PBN/A1B1C1D1 OPR/VIRTUAL");
  fields.ifrSourceHint.textContent = `Preenchido com ${fmt(summary.callsign)} do SimBrief`;
}

function applyTemplate(template, summary) {
  return String(template || "")
    .replace(/\{([a-zA-Z0-9_]+)\}/g, (_, key) => summary?.[key] ?? "")
    .replace(/[ \t]+$/gm, "")
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .join("\n")
    .trim();
}

function updateCharCount() {
  const data = getFormData();
  const message = applyTemplate(data.template, currentSummary || {});
  charCount.textContent = `${message.length} caracteres`;
  charCount.style.color = message.length > 900 ? "#b33a3a" : "";
}

function fmt(value, fallback = "-") {
  const text = String(value ?? "").trim();
  return text || fallback;
}

function setFlightSummary(summary) {
  currentSummary = summary;
  const dispatcher = fmt(appConfig.defaultHoppieFrom, "DANOPS");
  const target = summary ? fmt(summary.callsign) : "OFP";

  fields.generatedAt.textContent = summary
    ? `Gerado em ${fmt(summary.generatedAt)}`
    : "Aguardando SimBrief";
  fields.factFlight.textContent = summary
    ? `${fmt(summary.flightNumber)} / ${fmt(summary.callsign)}`
    : "-";
  fields.factRoute.textContent = summary
    ? `${fmt(summary.origin)} - ${fmt(summary.destination)}`
    : "-";
  fields.factAircraft.textContent = summary
    ? `${fmt(summary.aircraft)} ${fmt(summary.registration, "")}`.trim()
    : "-";
  fields.factFuel.textContent = summary
    ? `${fmt(summary.blockFuel)} ${summary.costIndex ? `CI ${summary.costIndex}` : ""}`.trim()
    : "-";
  fields.factHoppie.textContent = summary
    ? `${dispatcher} -> ${target}`
    : dispatcher;
  fields.quickDispatcher.textContent = dispatcher;
  fields.quickTarget.textContent = target;
  fields.quickState.textContent = summary ? "OFP pronto" : "Aguardando";
  fields.flowFrom.textContent = dispatcher;
  fields.flowTo.textContent = summary ? target : "callsign do OFP";
  fields.hoppieStatus.textContent = appConfig.hoppieLogonConfigured
    ? "Hoppie pronto"
    : "Hoppie pendente";
  if (summary) {
    syncIfrFromSummary(summary);
  }
  drawRoute(summary);
  updateCharCount();
}

function drawRoute(summary) {
  const canvas = routeCanvas;
  const ctx = canvas.getContext("2d");
  const width = canvas.width;
  const height = canvas.height;

  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#e6eee8";
  ctx.fillRect(0, 0, width, height);

  const gradient = ctx.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, "rgba(255, 255, 255, 0.72)");
  gradient.addColorStop(1, "rgba(228, 243, 239, 0.4)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);

  ctx.strokeStyle = "rgba(104, 115, 111, 0.18)";
  ctx.lineWidth = 1;
  for (let x = 70; x < width; x += 95) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  }
  for (let y = 48; y < height; y += 58) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }

  if (!summary) {
    ctx.fillStyle = "#181d1b";
    ctx.font = "800 24px system-ui";
    ctx.fillText("Aguardando OFP", 34, 58);
    ctx.font = "700 15px system-ui";
    ctx.fillStyle = "#68736f";
    ctx.fillText("SimBrief pronto para carregar o proximo plano.", 34, 86);
    return;
  }

  const start = { x: 90, y: height * 0.62 };
  const end = { x: width - 90, y: height * 0.38 };
  const control = { x: width * 0.52, y: height * 0.13 };

  ctx.strokeStyle = "rgba(15, 118, 110, 0.18)";
  ctx.lineWidth = 12;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(start.x, start.y);
  ctx.quadraticCurveTo(control.x, control.y, end.x, end.y);
  ctx.stroke();

  ctx.strokeStyle = "#0f766e";
  ctx.lineWidth = 5;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(start.x, start.y);
  ctx.quadraticCurveTo(control.x, control.y, end.x, end.y);
  ctx.stroke();

  drawAirport(ctx, start.x, start.y, summary.origin, "Origem");
  drawAirport(ctx, end.x, end.y, summary.destination, "Destino");

  ctx.fillStyle = "#181d1b";
  ctx.font = "800 24px system-ui";
  ctx.fillText(fmt(summary.flightNumber, "VOO"), 34, 48);
  ctx.font = "600 15px system-ui";
  ctx.fillStyle = "#68736f";
  ctx.fillText(
    `${fmt(summary.aircraft)}  ${fmt(summary.distance)}  ${fmt(summary.ete)}`.trim(),
    34,
    76
  );

  const route = fmt(summary.routeShort, "Rota nao informada");
  ctx.font = "600 14px system-ui";
  wrapCanvasText(ctx, route, 34, height - 52, width - 68, 20);

  if (summary.sid) {
    ctx.fillStyle = "#295b85";
    ctx.font = "800 13px system-ui";
    ctx.fillText(`SID ${summary.sid}`, 34, 104);
  }
}

function drawAirport(ctx, x, y, code, label) {
  ctx.fillStyle = "#ffffff";
  ctx.strokeStyle = "#202622";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(x, y, 14, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = "#202622";
  ctx.font = "900 26px system-ui";
  ctx.textAlign = "center";
  ctx.fillText(fmt(code, "----"), x, y + 48);
  ctx.font = "700 13px system-ui";
  ctx.fillStyle = "#637069";
  ctx.fillText(label, x, y + 70);
  ctx.textAlign = "start";
}

function wrapCanvasText(ctx, text, x, y, maxWidth, lineHeight) {
  const words = text.split(/\s+/);
  let line = "";
  for (const word of words) {
    const testLine = `${line}${word} `;
    if (ctx.measureText(testLine).width > maxWidth && line) {
      ctx.fillText(line.trim(), x, y);
      line = `${word} `;
      y += lineHeight;
    } else {
      line = testLine;
    }
  }
  ctx.fillText(line.trim(), x, y);
}

async function requestJson(url, options) {
  const response = await fetch(url, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.error || `HTTP ${response.status}`);
  }
  return body;
}

async function fetchOfp() {
  const data = getFormData();
  const params = new URLSearchParams();
  if (data.username) params.set("username", data.username);
  if (data.userid) params.set("userid", data.userid);
  if (data.staticId) params.set("staticId", data.staticId);

  if (!data.username && !data.userid) {
    showToast("Informe o username ou Pilot ID do SimBrief.");
    return;
  }

  fetchButton.disabled = true;
  fetchButton.textContent = "Buscando...";

  try {
    const result = await requestJson(`/api/simbrief?${params.toString()}`);
    setFlightSummary(result.summary);
    showToast("OFP carregado do SimBrief.");
  } catch (error) {
    showToast(error.message);
  } finally {
    fetchButton.disabled = false;
    fetchButton.textContent = "Buscar OFP";
  }
}

async function scheduleSend(event) {
  event.preventDefault();
  const data = getFormData();
  const submitButton = form.querySelector("button[type='submit']");

  submitButton.disabled = true;
  try {
    const result = await requestJson("/api/schedule", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    setFlightSummary(result.job.summary);
    showToast(`Mensagem agendada para ${new Date(result.job.sendAt).toLocaleTimeString()}.`);
    await loadJobs();
  } catch (error) {
    showToast(error.message);
  } finally {
    submitButton.disabled = false;
  }
}

async function validateIfrPlan(event) {
  event.preventDefault();
  const submitButton = ifrForm.querySelector("button[type='submit']");
  submitButton.disabled = true;

  try {
    const result = await requestJson("/api/flight-plans", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(getIfrFormData()),
    });
    renderIfrPlan(result.plan);
    showToast(
      result.plan.status === "Approved"
        ? `Plano aprovado. Squawk ${result.plan.squawk}.`
        : "Plano rejeitado. Veja as etapas de validacao."
    );
    await loadFlightPlans();
  } catch (error) {
    showToast(error.message);
  } finally {
    submitButton.disabled = false;
  }
}

async function importIfrFromSimbrief() {
  const data = getFormData();
  if (!data.username && !data.userid) {
    showToast("Informe o username ou Pilot ID do SimBrief.");
    return;
  }

  importIfrButton.disabled = true;
  importIfrButton.textContent = "Importando...";

  try {
    const result = await requestJson("/api/flight-plans/import-simbrief", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: data.username,
        userid: data.userid,
        staticId: data.staticId,
      }),
    });
    setFlightSummary(result.summary);
    renderIfrPlan(result.plan);
    showToast(
      result.plan.status === "Approved"
        ? `SimBrief aprovado. Squawk ${result.plan.squawk}.`
        : "SimBrief importado, mas o plano foi rejeitado."
    );
    await loadFlightPlans();
  } catch (error) {
    showToast(error.message);
  } finally {
    importIfrButton.disabled = false;
    importIfrButton.textContent = "Importar SimBrief";
  }
}

async function loadFlightPlans() {
  try {
    const { plans } = await requestJson("/api/flight-plans");
    renderFlightPlans(plans);
    if (!currentIfrPlan && plans.length) {
      renderIfrPlan(plans[0]);
    }
  } catch (error) {
    showToast(error.message);
  }
}

async function updateFlightPlanStatus(id, status) {
  try {
    const result = await requestJson(`/api/flight-plans/${id}/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    renderIfrPlan(result.plan);
    showToast(`Plano atualizado para ${status}.`);
    await loadFlightPlans();
  } catch (error) {
    showToast(error.message);
  }
}

async function cancelJob(id) {
  try {
    await requestJson(`/api/jobs/${id}/cancel`, { method: "POST" });
    showToast("Agendamento cancelado.");
    await loadJobs();
  } catch (error) {
    showToast(error.message);
  }
}

async function loadJobs() {
  try {
    const { jobs } = await requestJson("/api/jobs");
    renderJobs(jobs);
  } catch (error) {
    showToast(error.message);
  }
}

async function loadConfig() {
  try {
    const config = await requestJson("/api/config");
    appConfig = {
      defaultHoppieFrom: config.defaultHoppieFrom || "",
      hoppieLogonConfigured: Boolean(config.hoppieLogonConfigured),
    };
    if (config.defaultSimbriefUserid && !form.userid.value) {
      form.userid.value = config.defaultSimbriefUserid;
    }
    fields.quickPilot.textContent = form.userid.value || config.defaultSimbriefUserid || "-";
    setFlightSummary(currentSummary);
  } catch {
    appConfig = { defaultHoppieFrom: "", hoppieLogonConfigured: false };
    fields.quickPilot.textContent = form.userid.value || "-";
    setFlightSummary(currentSummary);
  }
}

function statusSlug(value) {
  return String(value || "draft").toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

function renderIfrPlan(plan) {
  currentIfrPlan = plan || null;

  if (!plan) {
    fields.ifrStatus.textContent = "Draft";
    fields.ifrSquawk.textContent = "----";
    fields.ifrClearance.textContent = "Aguardando aprovacao IFR.";
    renderValidationSteps([]);
    return;
  }

  fields.ifrStatus.textContent = plan.status || "Draft";
  fields.ifrSquawk.textContent = plan.squawk || "----";
  fields.ifrClearance.textContent =
    plan.clearance ||
    firstValidationFailure(plan) ||
    "Plano ainda nao possui clearance IFR.";

  const resultCards = document.querySelectorAll(".clearance-card");
  for (const card of resultCards) {
    card.dataset.status = statusSlug(plan.status);
  }

  fields.ifrSourceHint.textContent = `${fmt(plan.callsign)} ${fmt(plan.origin)}-${fmt(
    plan.destination
  )}`;
  renderValidationSteps(plan.validation?.steps || []);
}

function firstValidationFailure(plan) {
  const failed = plan.validation?.steps?.find((step) => step.status === "failed");
  return failed ? failed.message : "";
}

function renderValidationSteps(steps) {
  if (!steps.length) {
    validationSteps.innerHTML =
      '<p class="empty-state">Nenhuma validacao executada ainda.</p>';
    return;
  }

  validationSteps.innerHTML = steps
    .map(
      (step) => `
        <article class="validation-step ${escapeHtml(step.status)}">
          <span>${escapeHtml(step.status)}</span>
          <strong>${escapeHtml(step.label)}</strong>
          <p>${escapeHtml(step.message)}</p>
        </article>
      `
    )
    .join("");
}

function renderFlightPlans(plans) {
  if (!plans.length) {
    flightPlanList.innerHTML =
      '<p class="empty-state">Nenhum plano IFR criado ainda.</p>';
    return;
  }

  flightPlanList.innerHTML = "";
  for (const plan of plans) {
    const card = document.createElement("article");
    card.className = "plan-card";
    const title = `${fmt(plan.callsign)} ${fmt(plan.origin)}-${fmt(plan.destination)}`;
    const clearance = plan.clearance || firstValidationFailure(plan) || "Sem clearance.";
    const departureInfo = [
      plan.sid ? `SID ${plan.sid}` : "",
      plan.sidTransition ? `TRANS ${plan.sidTransition}` : "",
    ]
      .filter(Boolean)
      .join(" / ");
    const actions = nextPlanActions(plan)
      .map(
        (action) =>
          `<button type="button" class="secondary-button" data-plan-action="${escapeHtml(
            action.status
          )}" data-plan-id="${escapeHtml(plan.id)}">${escapeHtml(action.label)}</button>`
      )
      .join("");

    card.innerHTML = `
      <div>
        <h3>${escapeHtml(title)}</h3>
        <p>${escapeHtml(fmt(plan.aircraftType))} / ${escapeHtml(
          fmt(plan.flightLevel)
        )} / ${escapeHtml(fmt(plan.etdUtc).replace("T", " ").slice(0, 16))}Z</p>
        ${departureInfo ? `<p>${escapeHtml(departureInfo)}</p>` : ""}
        <p>${escapeHtml(clearance)}</p>
      </div>
      <div class="plan-side">
        <span class="badge ${escapeHtml(statusSlug(plan.status))}">${escapeHtml(
          plan.status
        )}</span>
        <strong>${escapeHtml(plan.squawk || "----")}</strong>
      </div>
      ${actions ? `<div class="plan-actions">${actions}</div>` : ""}
    `;

    card.addEventListener("click", (event) => {
      const button = event.target.closest("[data-plan-action]");
      if (button) {
        updateFlightPlanStatus(button.dataset.planId, button.dataset.planAction);
        return;
      }
      renderIfrPlan(plan);
    });

    flightPlanList.appendChild(card);
  }
}

function nextPlanActions(plan) {
  if (plan.status === "Approved") {
    return [
      { label: "Ativar", status: "Active" },
      { label: "Arquivar", status: "Archived" },
    ];
  }
  if (plan.status === "Active") {
    return [{ label: "Completar", status: "Completed" }];
  }
  if (["Completed", "Rejected"].includes(plan.status)) {
    return [{ label: "Arquivar", status: "Archived" }];
  }
  return [];
}

function renderJobs(jobs) {
  if (!jobs.length) {
    jobsList.innerHTML = '<p class="empty-state">Nenhum envio agendado.</p>';
    return;
  }

  jobsList.innerHTML = "";
  for (const job of jobs.sort((a, b) => b.createdAt.localeCompare(a.createdAt))) {
    const card = document.createElement("article");
    card.className = "job-card";
    const title = `${fmt(job.from)} -> ${fmt(job.to)} / ${fmt(job.type).toUpperCase()}`;
    const sendAt = new Date(job.sendAt).toLocaleString();
    const status = fmt(job.status);

    card.innerHTML = `
      <div>
        <h3>${escapeHtml(title)}</h3>
        <p>Envio: ${escapeHtml(sendAt)}</p>
        ${job.response ? `<p>Resposta: ${escapeHtml(job.response)}</p>` : ""}
        ${job.error ? `<p>Erro: ${escapeHtml(job.error)}</p>` : ""}
      </div>
      <div>
        <span class="badge ${escapeHtml(status)}">${escapeHtml(status)}</span>
      </div>
      <pre class="job-packet">${escapeHtml(job.packet)}</pre>
    `;

    if (job.status === "queued") {
      const actions = document.createElement("div");
      actions.className = "job-actions";
      const button = document.createElement("button");
      button.className = "danger-button";
      button.type = "button";
      button.textContent = "Cancelar";
      button.addEventListener("click", () => cancelJob(job.id));
      actions.appendChild(button);
      card.children[1].appendChild(actions);
    }

    jobsList.appendChild(card);
  }
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

fetchButton.addEventListener("click", fetchOfp);
importIfrButton.addEventListener("click", importIfrFromSimbrief);
refreshJobsButton.addEventListener("click", loadJobs);
refreshPlansButton.addEventListener("click", loadFlightPlans);
form.addEventListener("submit", scheduleSend);
ifrForm.addEventListener("submit", validateIfrPlan);
form.template.addEventListener("input", updateCharCount);
form.userid.addEventListener("input", () => {
  fields.quickPilot.textContent = form.userid.value || "-";
});

setFlightSummary(null);
renderIfrPlan(null);
loadConfig();
loadJobs();
loadFlightPlans();
setInterval(loadJobs, 10_000);
setInterval(loadFlightPlans, 30_000);
