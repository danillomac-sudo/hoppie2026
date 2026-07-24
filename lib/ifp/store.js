"use strict";

const fs = require("node:fs");
const path = require("node:path");

function createFlightPlanStore(filePath) {
  let plans = [];

  function load() {
    try {
      if (!fs.existsSync(filePath)) {
        plans = [];
        return;
      }
      const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
      plans = Array.isArray(data.plans) ? data.plans : [];
    } catch (error) {
      console.warn(`Nao foi possivel carregar planos IFR: ${error.message}`);
      plans = [];
    }
  }

  function save() {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify({ plans }, null, 2));
    } catch (error) {
      console.warn(`Nao foi possivel salvar planos IFR: ${error.message}`);
    }
  }

  function list() {
    return [...plans];
  }

  function get(id) {
    return plans.find((plan) => plan.id === id) || null;
  }

  function upsert(plan) {
    const index = plans.findIndex((current) => current.id === plan.id);
    if (index === -1) {
      plans.push(plan);
    } else {
      plans[index] = plan;
    }
    save();
    return plan;
  }

  load();

  return {
    get,
    list,
    upsert,
  };
}

module.exports = {
  createFlightPlanStore,
};
