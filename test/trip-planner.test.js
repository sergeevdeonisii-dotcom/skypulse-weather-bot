"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { buildTransitOptions, prepareTransitNetwork } = require("../trip-planner");

const network = prepareTransitNetwork([
  {
    id: "bus-1", type: "A", num: "1", title: "Автобус 1", stops: [
      { id: "a", name: "А", lat: 53.7000, lon: 23.8000 },
      { id: "b", name: "Б", lat: 53.7100, lon: 23.8000 },
      { id: "c", name: "В", lat: 53.7200, lon: 23.8000 }
    ]
  },
  {
    id: "trolley-2", type: "Tb", num: "2", title: "Троллейбус 2", stops: [
      { id: "c", name: "В", lat: 53.7200, lon: 23.8000 },
      { id: "d", name: "Г", lat: 53.7300, lon: 23.8000 },
      { id: "e", name: "Д", lat: 53.7400, lon: 23.8000 }
    ]
  }
]);

test("finds a direct trip with boarding and alighting stops", () => {
  const result = buildTransitOptions(network, { lat: 53.7000, lon: 23.8000 }, { lat: 53.7200, lon: 23.8000 });
  const direct = result.options.find((option) => option.kind === "direct");
  assert.ok(direct);
  assert.equal(direct.legs[0].num, "1");
  assert.equal(direct.legs[0].fromStop.name, "А");
  assert.equal(direct.legs[0].toStop.name, "В");
  assert.equal(direct.legs[0].stopsCount, 2);
});

test("finds a trip with one transfer and estimates its duration", () => {
  const result = buildTransitOptions(network, { lat: 53.7000, lon: 23.8000 }, { lat: 53.7400, lon: 23.8000 });
  const transfer = result.options.find((option) => option.kind === "transfer");
  assert.ok(transfer);
  assert.deepEqual(transfer.legs.map((leg) => leg.num), ["1", "2"]);
  assert.equal(transfer.transfers, 1);
  assert.ok(transfer.estimatedMinutes > 0);
});
