"use strict";

const WALKING_SPEED_METERS_PER_MINUTE = 80;
const RIDE_MINUTES_PER_STOP = 1.7;
const BOARDING_WAIT_MINUTES = 5;
const TRANSFER_WAIT_MINUTES = 6;
const MAX_WALK_TO_STOP_METERS = 900;
const MAX_TRANSFER_WALK_METERS = 160;

function radians(value) {
  return Number(value) * Math.PI / 180;
}

function haversineMeters(left, right) {
  const earthRadius = 6371000;
  const latDelta = radians(Number(right.lat) - Number(left.lat));
  const lonDelta = radians(Number(right.lon) - Number(left.lon));
  const lat1 = radians(left.lat);
  const lat2 = radians(right.lat);
  const value = Math.sin(latDelta / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(lonDelta / 2) ** 2;
  return earthRadius * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}

function roundedMeters(value) {
  return Math.max(0, Math.round(value / 10) * 10);
}

function stopSummary(stop) {
  return {
    id: String(stop.id),
    name: String(stop.name || "Остановка"),
    lat: Number(stop.lat),
    lon: Number(stop.lon)
  };
}

function routeKey(route) {
  return String(route.id || `${route.type}:${route.num}:${route.title || ""}`);
}

function prepareTransitNetwork(rawRoutes) {
  const routes = [];
  const stopsById = new Map();
  const routesAtStop = new Map();

  for (const rawRoute of rawRoutes || []) {
    const stops = [];
    let previousStopId = null;
    for (const item of rawRoute.stops || []) {
      const stop = stopSummary(item);
      if (!Number.isFinite(stop.lat) || !Number.isFinite(stop.lon)) continue;
      if (previousStopId === stop.id) continue;
      previousStopId = stop.id;
      stops.push(stop);
      stopsById.set(stop.id, stop);
    }
    if (stops.length < 2) continue;
    const route = {
      id: routeKey(rawRoute),
      type: rawRoute.type === "Tb" ? "Tb" : "A",
      num: String(rawRoute.num || ""),
      title: String(rawRoute.title || ""),
      stops
    };
    routes.push(route);
    route.stops.forEach((stop, index) => {
      const entries = routesAtStop.get(stop.id) || [];
      entries.push({ route, index });
      routesAtStop.set(stop.id, entries);
    });
  }

  const stops = [...stopsById.values()];
  const transferStops = new Map(stops.map((stop) => [stop.id, [stop]]));
  for (let left = 0; left < stops.length; left += 1) {
    for (let right = left + 1; right < stops.length; right += 1) {
      if (haversineMeters(stops[left], stops[right]) > MAX_TRANSFER_WALK_METERS) continue;
      transferStops.get(stops[left].id).push(stops[right]);
      transferStops.get(stops[right].id).push(stops[left]);
    }
  }

  return { routes, stops, routesAtStop, transferStops };
}

function closestStops(point, stops, limit = 8) {
  return (stops || [])
    .map((stop) => ({ stop, walkMeters: haversineMeters(point, stop) }))
    .filter((item) => item.walkMeters <= MAX_WALK_TO_STOP_METERS)
    .sort((left, right) => left.walkMeters - right.walkMeters || left.stop.name.localeCompare(right.stop.name, "ru"))
    .slice(0, limit)
    .map((item) => ({ ...item, walkMeters: roundedMeters(item.walkMeters) }));
}

function routeSegment(route, fromIndex, toIndex) {
  return route.stops.slice(fromIndex, toIndex + 1).map((stop) => ({ lat: stop.lat, lon: stop.lon }));
}

function rideMinutes(stopsCount) {
  return Math.max(2, Math.round(stopsCount * RIDE_MINUTES_PER_STOP));
}

function makeLeg(route, fromIndex, toIndex) {
  const stopsCount = toIndex - fromIndex;
  return {
    type: route.type,
    num: route.num,
    title: route.title,
    fromStop: stopSummary(route.stops[fromIndex]),
    toStop: stopSummary(route.stops[toIndex]),
    stopsCount,
    rideMinutes: rideMinutes(stopsCount),
    geometry: routeSegment(route, fromIndex, toIndex)
  };
}

function estimateMinutes({ walkToMeters, walkFromMeters, transferWalkMeters = 0, legs }) {
  const ride = legs.reduce((sum, leg) => sum + leg.rideMinutes, 0);
  const wait = BOARDING_WAIT_MINUTES + Math.max(0, legs.length - 1) * TRANSFER_WAIT_MINUTES;
  return Math.max(1, Math.round(
    ride + wait + (walkToMeters + walkFromMeters + transferWalkMeters) / WALKING_SPEED_METERS_PER_MINUTE
  ));
}

function optionSignature(option) {
  return option.legs.map((leg) => `${leg.type}:${leg.num}:${leg.fromStop.id}:${leg.toStop.id}`).join("|");
}

function addOption(options, seen, option) {
  const signature = optionSignature(option);
  if (seen.has(signature)) return;
  seen.add(signature);
  options.push(option);
}

function directOptions(network, originCandidates, destinationCandidates, options, seen) {
  for (const origin of originCandidates) {
    const starts = network.routesAtStop.get(origin.stop.id) || [];
    for (const start of starts) {
      for (const destination of destinationCandidates) {
        const ends = network.routesAtStop.get(destination.stop.id) || [];
        for (const end of ends) {
          if (start.route !== end.route || end.index <= start.index) continue;
          const legs = [makeLeg(start.route, start.index, end.index)];
          addOption(options, seen, {
            kind: "direct",
            transfers: 0,
            walkToMeters: origin.walkMeters,
            walkFromMeters: destination.walkMeters,
            transferWalkMeters: 0,
            legs,
            estimatedMinutes: estimateMinutes({
              walkToMeters: origin.walkMeters,
              walkFromMeters: destination.walkMeters,
              legs
            })
          });
        }
      }
    }
  }
}

function destinationEntriesByRoute(network, destinationCandidates) {
  const result = new Map();
  for (const destination of destinationCandidates) {
    for (const entry of network.routesAtStop.get(destination.stop.id) || []) {
      const entries = result.get(entry.route) || [];
      entries.push({ ...entry, destination });
      result.set(entry.route, entries);
    }
  }
  return result;
}

function transferOptions(network, originCandidates, destinationCandidates, options, seen) {
  const endsByRoute = destinationEntriesByRoute(network, destinationCandidates);
  for (const origin of originCandidates) {
    for (const first of network.routesAtStop.get(origin.stop.id) || []) {
      for (let transferIndex = first.index + 1; transferIndex < first.route.stops.length; transferIndex += 1) {
        const firstTransferStop = first.route.stops[transferIndex];
        const nearbyStops = network.transferStops.get(firstTransferStop.id) || [firstTransferStop];
        for (const secondTransferStop of nearbyStops) {
          const transferWalkMeters = roundedMeters(haversineMeters(firstTransferStop, secondTransferStop));
          for (const second of network.routesAtStop.get(secondTransferStop.id) || []) {
            if (second.route === first.route) continue;
            for (const end of endsByRoute.get(second.route) || []) {
              if (end.index <= second.index) continue;
              const legs = [
                makeLeg(first.route, first.index, transferIndex),
                makeLeg(second.route, second.index, end.index)
              ];
              addOption(options, seen, {
                kind: "transfer",
                transfers: 1,
                walkToMeters: origin.walkMeters,
                walkFromMeters: end.destination.walkMeters,
                transferWalkMeters,
                transferStop: stopSummary(firstTransferStop),
                legs,
                estimatedMinutes: estimateMinutes({
                  walkToMeters: origin.walkMeters,
                  walkFromMeters: end.destination.walkMeters,
                  transferWalkMeters,
                  legs
                })
              });
            }
          }
        }
      }
    }
  }
}

function buildTransitOptions(network, origin, destination) {
  const originCandidates = closestStops(origin, network?.stops);
  const destinationCandidates = closestStops(destination, network?.stops);
  if (!originCandidates.length || !destinationCandidates.length) {
    return { originCandidates, destinationCandidates, options: [] };
  }

  const options = [];
  const seen = new Set();
  directOptions(network, originCandidates, destinationCandidates, options, seen);
  transferOptions(network, originCandidates, destinationCandidates, options, seen);
  options.sort((left, right) => left.estimatedMinutes - right.estimatedMinutes
    || left.transfers - right.transfers
    || left.walkToMeters + left.walkFromMeters - right.walkToMeters - right.walkFromMeters);
  return {
    originCandidates,
    destinationCandidates,
    options: options.slice(0, 5)
  };
}

module.exports = {
  buildTransitOptions,
  haversineMeters,
  prepareTransitNetwork
};
