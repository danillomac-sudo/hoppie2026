"use strict";

const crypto = require("node:crypto");
const {
  ACTIVE_PLAN_STATUSES,
  AIRCRAFT_TYPES,
  AIRPORTS,
  PLAN_STATUSES,
  PROHIBITED_SQUAWKS,
} = require("./reference-data");

const ROUTE_TOKEN_PATTERN = /^[A-Z0-9./-]+$/;
const AIRWAY_PATTERN = /^(?:U|L|N|Q|T|V|W|Y|Z)?[A-Z]{1,3}\d{1,4}[A-Z]?$/;

function normalizeText(value) {
  return String(value || "").trim();
}

function normalizeUpper(value) {
  return normalizeText(value).toUpperCase();
}

function normalizeCallsign(value) {
  return normalizeUpper(value).replace(/[^A-Z0-9]/g, "");
}

function normalizeIcao(value) {
  return normalizeUpper(value).replace(/[^A-Z]/g, "").slice(0, 4);
}

function normalizeAircraftType(value) {
  return normalizeUpper(value).replace(/[^A-Z0-9]/g, "").slice(0, 4);
}

function normalizeRoute(value) {
  return normalizeUpper(value)
    .replace(/\s+/g, " ")
    .replace(/\bDIRECT\b/g, "DCT")
    .trim();
}

function safeRandomInt(max) {
  if (typeof crypto.randomInt === "function") {
    return crypto.randomInt(max);
  }
  return Math.floor(Math.random() * max);
}

function createId() {
  if (typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return crypto.randomBytes(16).toString("hex");
}

function addStep(steps, key, label, status, message, details = {}) {
  steps.push({ key, label, status, message, details });
}

function failStep(steps, key, label, message, details) {
  addStep(steps, key, label, "failed", message, details);
}

function passStep(steps, key, label, message, details) {
  addStep(steps, key, label, "passed", message, details);
}

function warnStep(steps, key, label, message, details) {
  addStep(steps, key, label, "warning", message, details);
}

function parseFlightLevel(value) {
  const raw = normalizeUpper(value);
  if (!raw) {
    return null;
  }

  const match = raw.match(/^(?:FL)?\s*(\d{2,5})$/);
  if (!match) {
    return null;
  }

  let numeric = Number(match[1]);
  if (!Number.isFinite(numeric)) {
    return null;
  }

  if (numeric > 999) {
    numeric = Math.round(numeric / 100);
  }

  return {
    level: numeric,
    text: `FL${String(numeric).padStart(3, "0")}`,
    altitudeFeet: numeric * 100,
  };
}

function parseEtdUtc(value, now = new Date()) {
  const raw = normalizeText(value);
  if (!raw) {
    return null;
  }

  const hhmm = raw.match(/^(\d{2})(\d{2})$/);
  if (hhmm) {
    const hours = Number(hhmm[1]);
    const minutes = Number(hhmm[2]);
    if (hours <= 23 && minutes <= 59) {
      const date = new Date(
        Date.UTC(
          now.getUTCFullYear(),
          now.getUTCMonth(),
          now.getUTCDate(),
          hours,
          minutes,
          0
        )
      );
      return date.toISOString();
    }
  }

  const normalized = raw.includes("T") ? raw : raw.replace(" ", "T");
  const date = new Date(normalized.endsWith("Z") ? normalized : `${normalized}Z`);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date.toISOString();
}

function parseEquipment(equipment, remarks) {
  const raw = normalizeUpper(equipment);
  const remarkText = normalizeUpper(remarks);
  const beforeSlash = raw.split("/")[0] || "";
  const afterSlash = raw.split("/")[1] || "";
  const combined = `${raw} ${remarkText}`;

  return {
    raw,
    standard: beforeSlash,
    surveillance: afterSlash,
    gps: beforeSlash.includes("G") || combined.includes("GNSS"),
    rnav: beforeSlash.includes("R") || combined.includes("RNAV"),
    pbn: beforeSlash.includes("R") || combined.includes("PBN/"),
    adsb: /[BL]/.test(afterSlash) || combined.includes("ADS-B"),
    adsc: /D/.test(afterSlash) || combined.includes("ADS-C"),
    cpdlc: beforeSlash.includes("J") || combined.includes("CPDLC"),
    rvsm: beforeSlash.includes("W") || combined.includes("RVSM"),
  };
}

function isAirway(token) {
  return AIRWAY_PATTERN.test(token);
}

function routeTokens(route) {
  return normalizeRoute(route).split(" ").filter(Boolean);
}

function bearingBetween(origin, destination) {
  const start = AIRPORTS[origin];
  const end = AIRPORTS[destination];
  if (!start || !end) {
    return null;
  }

  const lat1 = (start.lat * Math.PI) / 180;
  const lat2 = (end.lat * Math.PI) / 180;
  const deltaLon = ((end.lon - start.lon) * Math.PI) / 180;
  const y = Math.sin(deltaLon) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(deltaLon);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

function expectedSemicircularParity(origin, destination) {
  const bearing = bearingBetween(origin, destination);
  if (bearing === null) {
    return null;
  }
  return bearing >= 0 && bearing < 180 ? "odd" : "even";
}

function hasActiveCallsignConflict(existingPlans, callsign, currentId) {
  return existingPlans.some((plan) => {
    if (plan.id === currentId) {
      return false;
    }
    return (
      normalizeCallsign(plan.callsign) === callsign &&
      ACTIVE_PLAN_STATUSES.has(plan.status)
    );
  });
}

function activeSquawks(existingPlans, currentId) {
  return new Set(
    existingPlans
      .filter((plan) => plan.id !== currentId)
      .filter((plan) => ACTIVE_PLAN_STATUSES.has(plan.status))
      .map((plan) => normalizeText(plan.squawk))
      .filter(Boolean)
  );
}

function generateSquawk(existingPlans, currentId) {
  const used = activeSquawks(existingPlans, currentId);

  for (let attempt = 0; attempt < 2500; attempt += 1) {
    const digits = Array.from({ length: 4 }, () => safeRandomInt(8)).join("");
    if (digits[0] === "0") {
      continue;
    }
    if (PROHIBITED_SQUAWKS.has(digits) || used.has(digits)) {
      continue;
    }
    return digits;
  }

  for (let code = 1000; code <= 7777; code += 1) {
    const squawk = String(code);
    if (!/^[0-7]{4}$/.test(squawk)) {
      continue;
    }
    if (!PROHIBITED_SQUAWKS.has(squawk) && !used.has(squawk)) {
      return squawk;
    }
  }

  return "";
}

function simbriefValueAt(data, paths, fallback = "") {
  for (const path of paths) {
    const value = path.split(".").reduce((current, key) => {
      if (current && Object.prototype.hasOwnProperty.call(current, key)) {
        return current[key];
      }
      return undefined;
    }, data);

    if (value !== undefined && value !== null && typeof value !== "object") {
      const normalized = normalizeText(value);
      if (normalized) {
        return normalized;
      }
    }
  }
  return fallback;
}

function buildInputFromSimbrief(summary, raw, request = {}) {
  return {
    source: "SimBrief",
    callsign: summary.callsign || summary.flightNumber,
    aircraftType: summary.aircraft,
    origin: summary.origin,
    destination: summary.destination,
    alternate: summary.alternate,
    route: summary.route,
    flightLevel: summary.cruiseAltitude,
    etdUtc: summary.schedOut,
    equipment: simbriefValueAt(raw, [
      "aircraft.equip",
      "aircraft.equipment",
      "atc.equipment",
      "atc.equipment_code",
      "params.equipment",
    ]),
    remarks: simbriefValueAt(raw, [
      "atc.remarks",
      "atc.remark",
      "general.remarks",
      "params.remarks",
    ]),
    simbriefId:
      request.staticId ||
      summary.release ||
      simbriefValueAt(raw, ["params.static_id", "params.userid"]),
    sid: summary.sid || summary.sidIdent || "",
  };
}

function normalizeFlightPlanInput(input, now = new Date()) {
  const flightLevel = parseFlightLevel(input.flightLevel || input.cruiseAltitude);
  const etdUtc = parseEtdUtc(input.etdUtc || input.schedOut || input.departureTime, now);

  return {
    id: input.id || createId(),
    callsign: normalizeCallsign(input.callsign),
    aircraftType: normalizeAircraftType(input.aircraftType || input.aircraft),
    origin: normalizeIcao(input.origin),
    destination: normalizeIcao(input.destination),
    alternate: normalizeIcao(input.alternate),
    route: normalizeRoute(input.route),
    flightLevel: flightLevel ? flightLevel.text : normalizeUpper(input.flightLevel),
    flightLevelValue: flightLevel ? flightLevel.level : null,
    etdUtc,
    equipment: normalizeUpper(input.equipment),
    remarks: normalizeText(input.remarks),
    simbriefId: normalizeText(input.simbriefId),
    sid: normalizeUpper(input.sid),
    source: normalizeText(input.source) || "Manual",
  };
}

function validateFlightPlan(plan, existingPlans) {
  const steps = [];

  if (!plan.callsign) {
    failStep(steps, "callsign", "Callsign", "Callsign obrigatorio.");
  } else if (!/^[A-Z0-9]{3,7}$/.test(plan.callsign)) {
    failStep(
      steps,
      "callsign",
      "Callsign",
      "Callsign deve ter 3 a 7 caracteres alfanumericos."
    );
  } else if (hasActiveCallsignConflict(existingPlans, plan.callsign, plan.id)) {
    failStep(steps, "callsign", "Callsign", "Callsign ja utilizado em voo ativo.");
  } else {
    passStep(steps, "callsign", "Callsign", "Callsign validado.");
  }

  const aircraft = AIRCRAFT_TYPES[plan.aircraftType];
  if (!plan.aircraftType) {
    failStep(steps, "aircraft", "Aeronave", "Tipo da aeronave obrigatorio.");
  } else if (!/^[A-Z0-9]{2,4}$/.test(plan.aircraftType)) {
    failStep(steps, "aircraft", "Aeronave", "ICAO Type Designator invalido.");
  } else if (!aircraft) {
    failStep(
      steps,
      "aircraft",
      "Aeronave",
      `Aeronave ${plan.aircraftType} nao existe na base interna.`
    );
  } else {
    passStep(
      steps,
      "aircraft",
      "Aeronave",
      `${aircraft.name} validada (${aircraft.wake}/RVSM ${aircraft.rvsm ? "sim" : "nao"}).`
    );
  }

  const capabilities = parseEquipment(plan.equipment, plan.remarks);
  if (!plan.equipment) {
    warnStep(
      steps,
      "equipment",
      "Equipamentos",
      "Campo 10 vazio; usando apenas capacidades conhecidas da aeronave."
    );
  } else {
    passStep(
      steps,
      "equipment",
      "Equipamentos",
      [
        capabilities.pbn ? "PBN" : "",
        capabilities.gps ? "GPS" : "",
        capabilities.rvsm ? "RVSM" : "",
        capabilities.cpdlc ? "CPDLC" : "",
        capabilities.adsb ? "ADS-B" : "",
      ]
        .filter(Boolean)
        .join(", ") || "Campo 10 interpretado."
    );
  }

  const origin = AIRPORTS[plan.origin];
  const destination = AIRPORTS[plan.destination];
  const alternate = AIRPORTS[plan.alternate];
  const airportIssues = [];

  for (const [field, code, airport] of [
    ["origem", plan.origin, origin],
    ["destino", plan.destination, destination],
    ["alternado", plan.alternate, alternate],
  ]) {
    if (!code) {
      airportIssues.push(`${field} obrigatorio`);
    } else if (!/^[A-Z]{4}$/.test(code)) {
      airportIssues.push(`${field} com ICAO invalido`);
    } else if (!airport) {
      airportIssues.push(`${code} nao existe na base interna`);
    } else if (!airport.ifr) {
      airportIssues.push(`${code} nao permite operacao IFR`);
    } else if (aircraft && airport.runwayMeters < aircraft.minRunwayMeters) {
      airportIssues.push(`${code} possui pista curta para ${plan.aircraftType}`);
    }
  }

  if (plan.origin && plan.destination && plan.origin === plan.destination) {
    airportIssues.push("origem e destino nao podem ser iguais");
  }

  if (airportIssues.length) {
    failStep(steps, "airports", "Aeroportos", airportIssues.join("; "));
  } else {
    passStep(
      steps,
      "airports",
      "Aeroportos",
      `${plan.origin}, ${plan.destination} e alternado ${plan.alternate} validados.`
    );
  }

  if (!plan.alternate) {
    failStep(steps, "alternate", "Alternado", "Alternado obrigatorio.");
  } else if (!alternate) {
    failStep(steps, "alternate", "Alternado", "Alternado inexistente na base interna.");
  } else {
    passStep(steps, "alternate", "Alternado", `Alternado ${plan.alternate} validado.`);
  }

  const tokens = routeTokens(plan.route);
  const routeIssues = [];
  const routeWarnings = [];
  if (!tokens.length) {
    routeIssues.push("rota completa obrigatoria");
  }
  if (tokens.some((token) => !ROUTE_TOKEN_PATTERN.test(token))) {
    routeIssues.push("rota contem caracteres invalidos");
  }
  if (tokens[0] === "DCT" || tokens.at(-1) === "DCT") {
    routeWarnings.push("DCT no inicio ou fim da rota sera tratado como trecho direto");
  }
  if (tokens.some((token) => ["INVALID", "XXXX", "XXXXX"].includes(token))) {
    routeIssues.push("waypoint inexistente informado");
  }
  if (tokens.some(isAirway) && !(capabilities.pbn || capabilities.rnav || capabilities.gps)) {
    routeIssues.push("equipamento PBN/RNAV/GPS obrigatorio para rota com aerovia");
  }

  if (routeIssues.length) {
    failStep(steps, "route", "Rota", routeIssues.join("; "));
  } else if (routeWarnings.length) {
    warnStep(steps, "route", "Rota", routeWarnings.join("; "), {
      tokenCount: tokens.length,
    });
  } else {
    const navdataNote = tokens.some(isAirway)
      ? "Estrutura de rota e aerovias validadas em modo navdata leve."
      : "Estrutura de rota validada.";
    passStep(steps, "route", "Rota", navdataNote, { tokenCount: tokens.length });
  }

  if (!plan.flightLevelValue) {
    failStep(steps, "flightLevel", "Flight Level", "Flight Level invalido.");
  } else if (plan.flightLevelValue < 10 || plan.flightLevelValue > 600) {
    failStep(steps, "flightLevel", "Flight Level", "Flight Level fora do intervalo operacional.");
  } else if (aircraft && plan.flightLevelValue > aircraft.maxFlightLevel) {
    failStep(
      steps,
      "flightLevel",
      "Flight Level",
      `Aeronave incompativel com ${plan.flightLevel}; teto ${aircraft.maxFlightLevel}.`
    );
  } else if (
    plan.flightLevelValue >= 290 &&
    aircraft &&
    (!aircraft.rvsm || !(capabilities.rvsm || aircraft.rvsm))
  ) {
    failStep(
      steps,
      "flightLevel",
      "Flight Level",
      "RVSM obrigatorio para operacao no espaco FL290+."
    );
  } else {
    const parity = expectedSemicircularParity(plan.origin, plan.destination);
    const pair = Math.floor(plan.flightLevelValue / 10);
    const actualParity = pair % 2 === 0 ? "even" : "odd";
    if (parity && parity !== actualParity) {
      warnStep(
        steps,
        "flightLevel",
        "Flight Level",
        `Regra semicircular sugere nivel ${parity === "odd" ? "impar" : "par"} para essa rota.`
      );
    } else {
      passStep(steps, "flightLevel", "Flight Level", `${plan.flightLevel} validado.`);
    }
  }

  if (!plan.etdUtc) {
    failStep(steps, "etd", "ETD UTC", "ETD UTC invalido ou ausente.");
  } else {
    passStep(
      steps,
      "etd",
      "ETD UTC",
      `Partida prevista ${plan.etdUtc.replace("T", " ").slice(0, 16)}Z.`
    );
  }

  const failed = steps.filter((step) => step.status === "failed");
  const warnings = steps.filter((step) => step.status === "warning");
  return {
    approved: failed.length === 0,
    failedCount: failed.length,
    warningCount: warnings.length,
    steps,
  };
}

function buildClearance(plan) {
  const sid = plan.sid || "SID AS FILED";
  const initialLevel = plan.flightLevelValue
    ? `FL${String(Math.min(plan.flightLevelValue, 150)).padStart(3, "0")}`
    : "FL150";
  const etd = plan.etdUtc ? plan.etdUtc.replace("T", " ").slice(11, 16) : "ETD";
  const route = plan.route || "FLIGHT PLANNED ROUTE";

  return [
    `${plan.callsign} CLEARED TO ${plan.destination} VIA ${sid}.`,
    `AFTER DEPARTURE CLIMB ${initialLevel}, EXPECT ${plan.flightLevel}.`,
    `ROUTE ${route}.`,
    `SQUAWK ${plan.squawk}. ETD ${etd}Z. ATIS CURRENT.`,
  ].join(" ");
}

function publicFlightPlan(plan) {
  return {
    id: plan.id,
    callsign: plan.callsign,
    aircraftType: plan.aircraftType,
    origin: plan.origin,
    destination: plan.destination,
    alternate: plan.alternate,
    route: plan.route,
    flightLevel: plan.flightLevel,
    etdUtc: plan.etdUtc,
    equipment: plan.equipment,
    remarks: plan.remarks,
    simbriefId: plan.simbriefId,
    sid: plan.sid,
    status: plan.status,
    squawk: plan.squawk,
    squawkStatus: plan.squawkStatus,
    squawkReleasedAt: plan.squawkReleasedAt,
    clearance: plan.clearance,
    source: plan.source,
    validation: plan.validation,
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt,
  };
}

function approveFlightPlan(input, existingPlans = [], now = new Date()) {
  const base = normalizeFlightPlanInput(input, now);
  const createdAt = input.createdAt || now.toISOString();
  const plan = {
    ...base,
    status: "Pending Validation",
    squawk: "",
    squawkStatus: "unassigned",
    squawkReleasedAt: "",
    clearance: "",
    createdAt,
    updatedAt: now.toISOString(),
  };

  const validation = validateFlightPlan(plan, existingPlans);
  plan.validation = validation;

  if (!validation.approved) {
    plan.status = "Rejected";
    return plan;
  }

  const squawk = generateSquawk(existingPlans, plan.id);
  if (!squawk) {
    plan.status = "Rejected";
    plan.validation = {
      ...validation,
      approved: false,
      failedCount: validation.failedCount + 1,
      steps: [
        ...validation.steps,
        {
          key: "squawk",
          label: "Squawk",
          status: "failed",
          message: "Nenhum squawk disponivel.",
          details: {},
        },
      ],
    };
    return plan;
  }

  plan.status = "Approved";
  plan.squawk = squawk;
  plan.squawkStatus = "reserved";
  plan.clearance = buildClearance(plan);
  plan.validation = {
    ...validation,
    steps: [
      ...validation.steps,
      {
        key: "squawk",
        label: "Squawk",
        status: "passed",
        message: `Squawk ${squawk} reservado.`,
        details: { prohibited: Array.from(PROHIBITED_SQUAWKS) },
      },
      {
        key: "clearance",
        label: "Clearance IFR",
        status: "passed",
        message: "Flight Clearance gerado.",
        details: {},
      },
    ],
  };

  return plan;
}

function applyStatusTransition(plan, nextStatus, now = new Date()) {
  if (!PLAN_STATUSES.includes(nextStatus)) {
    throw new Error("Status de plano de voo invalido.");
  }

  const updated = {
    ...plan,
    status: nextStatus,
    updatedAt: now.toISOString(),
  };

  if (["Completed", "Archived", "Rejected"].includes(nextStatus) && updated.squawk) {
    updated.squawkStatus = "released";
    updated.squawkReleasedAt = now.toISOString();
  }

  if (nextStatus === "Active" && updated.squawk) {
    updated.squawkStatus = "in_use";
  }

  return updated;
}

module.exports = {
  ACTIVE_PLAN_STATUSES,
  PLAN_STATUSES,
  approveFlightPlan,
  applyStatusTransition,
  buildInputFromSimbrief,
  publicFlightPlan,
};
