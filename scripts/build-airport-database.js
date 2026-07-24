"use strict";

const fs = require("node:fs");
const path = require("node:path");

const inputDir = process.argv[2] || process.cwd();
const outputFile =
  process.argv[3] ||
  path.join(__dirname, "..", "lib", "ifp", "airport-database.js");

const AIRPORT_TYPES = new Set(["large_airport", "medium_airport", "small_airport"]);

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (quoted) {
      if (char === '"' && next === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (char !== "\r") {
      field += char;
    }
  }

  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

function indexByHeader(header) {
  return Object.fromEntries(header.map((name, index) => [name, index]));
}

function ascii(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\x20-\x7E]/g, "")
    .trim();
}

function codeFromAirport(row, indexes) {
  const candidates = [
    row[indexes.icao_code],
    row[indexes.gps_code],
    row[indexes.ident],
  ];
  return candidates
    .map((value) => String(value || "").trim().toUpperCase())
    .find((value) => /^[A-Z]{4}$/.test(value));
}

function numberOrZero(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : 0;
}

const airportsCsv = fs.readFileSync(path.join(inputDir, "airports.csv"), "utf8");
const runwaysCsv = fs.readFileSync(path.join(inputDir, "runways.csv"), "utf8");

const airportRows = parseCsv(airportsCsv);
const runwayRows = parseCsv(runwaysCsv);
const airportIndexes = indexByHeader(airportRows.shift());
const runwayIndexes = indexByHeader(runwayRows.shift());
const maxRunwayByAirport = new Map();

for (const row of runwayRows) {
  const airportIdent = String(row[runwayIndexes.airport_ident] || "")
    .trim()
    .toUpperCase();
  const closed = String(row[runwayIndexes.closed] || "").trim();
  if (!airportIdent || closed === "1") {
    continue;
  }

  const lengthFeet = numberOrZero(row[runwayIndexes.length_ft]);
  const lengthMeters = Math.round(lengthFeet * 0.3048);
  if (lengthMeters > (maxRunwayByAirport.get(airportIdent) || 0)) {
    maxRunwayByAirport.set(airportIdent, lengthMeters);
  }
}

const database = {};

for (const row of airportRows) {
  const type = String(row[airportIndexes.type] || "").trim();
  if (!AIRPORT_TYPES.has(type)) {
    continue;
  }

  const code = codeFromAirport(row, airportIndexes);
  if (!code) {
    continue;
  }

  const ident = String(row[airportIndexes.ident] || "").trim().toUpperCase();
  const gpsCode = String(row[airportIndexes.gps_code] || "").trim().toUpperCase();
  const name = ascii(row[airportIndexes.name]);
  const municipality = ascii(row[airportIndexes.municipality]);
  const lat = Number(row[airportIndexes.latitude_deg]);
  const lon = Number(row[airportIndexes.longitude_deg]);
  const runwayMeters =
    maxRunwayByAirport.get(ident) ||
    maxRunwayByAirport.get(gpsCode) ||
    maxRunwayByAirport.get(code) ||
    0;

  database[code] = {
    name: municipality ? `${name}, ${municipality}` : name,
    ifr: true,
    runwayMeters,
    lat: Number.isFinite(lat) ? Number(lat.toFixed(5)) : 0,
    lon: Number.isFinite(lon) ? Number(lon.toFixed(5)) : 0,
    type,
    country: String(row[airportIndexes.iso_country] || "").trim(),
  };
}

const ordered = Object.fromEntries(
  Object.entries(database).sort(([left], [right]) => left.localeCompare(right))
);

const body = [
  '"use strict";',
  "",
  "// Generated from OurAirports airports.csv and runways.csv.",
  "// Source: https://ourairports.com/data/",
  `const AIRPORT_DATABASE = ${JSON.stringify(ordered)};`,
  "",
  "module.exports = { AIRPORT_DATABASE };",
  "",
].join("\n");

fs.mkdirSync(path.dirname(outputFile), { recursive: true });
fs.writeFileSync(outputFile, body);

console.log(
  `Generated ${Object.keys(ordered).length} ICAO-like airports at ${outputFile}`
);
