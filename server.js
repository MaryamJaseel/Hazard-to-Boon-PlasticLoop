const http = require("http");
const fs = require("fs");
const path = require("path");
const { randomBytes, randomUUID } = require("crypto");

const port = process.env.PORT || 3000;
const adminPin = process.env.ADMIN_PIN || randomBytes(4).toString("hex");
const rootDir = __dirname;
const dataDir = path.join(rootDir, "data");
const dbPath = path.join(dataDir, "db.json");
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabaseEnabled = Boolean(supabaseUrl && supabaseServiceRoleKey);

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8"
};

const securityHeaders = {
  "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "geolocation=(), microphone=(), camera=()"
};

const allowedPlasticTypes = new Set(["PET bottles", "HDPE containers", "LDPE covers", "PP packaging", "Mixed plastic"]);
const allowedSlots = new Set(["Today, 9 AM - 12 PM", "Today, 2 PM - 5 PM", "Tomorrow, 9 AM - 12 PM", "Tomorrow, 2 PM - 5 PM"]);

function sanitizeText(value, maxLength = 160) {
  return String(value || "").trim().slice(0, maxLength);
}

function isPhoneNumber(value) {
  return /^[0-9+\-\s]{7,15}$/.test(String(value || "").trim());
}

function ensureDatabase() {
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  if (!fs.existsSync(dbPath)) {
    fs.writeFileSync(dbPath, JSON.stringify({ collectors: [], pickupRequests: [], researchIdeas: [] }, null, 2));
    return;
  }

  const database = JSON.parse(fs.readFileSync(dbPath, "utf8"));
  const migratedDatabase = {
    collectors: Array.isArray(database.collectors) ? database.collectors : [],
    pickupRequests: Array.isArray(database.pickupRequests) ? database.pickupRequests : [],
    researchIdeas: Array.isArray(database.researchIdeas) ? database.researchIdeas : []
  };

  fs.writeFileSync(dbPath, JSON.stringify(migratedDatabase, null, 2));
}

function estimateReward(weightKg) {
  const numericWeight = Number.parseFloat(weightKg);

  if (Number.isNaN(numericWeight)) {
    return 0;
  }

  return Math.max(20, Math.round(numericWeight * 8));
}

function readDatabase() {
  ensureDatabase();
  return JSON.parse(fs.readFileSync(dbPath, "utf8"));
}

function writeDatabase(database) {
  ensureDatabase();
  fs.writeFileSync(dbPath, JSON.stringify(database, null, 2));
}

function toCollector(row) {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    area: row.area,
    vehicle: row.vehicle,
    createdAt: row.created_at || row.createdAt
  };
}

function toPickup(row) {
  return {
    id: row.id,
    customerName: row.customer_name || row.customerName,
    phone: row.phone,
    address: row.address,
    plasticType: row.plastic_type || row.plasticType,
    weight: String(row.weight),
    slot: row.slot,
    notes: row.notes || "",
    status: row.status,
    estimatedReward: row.estimated_reward || row.estimatedReward,
    assignedCollectorId: row.assigned_collector_id || row.assignedCollectorId,
    assignedCollectorName: row.assigned_collector_name || row.assignedCollectorName,
    assignedCollectorPhone: row.assigned_collector_phone || row.assignedCollectorPhone,
    assignedAt: row.assigned_at || row.assignedAt,
    createdAt: row.created_at || row.createdAt
  };
}

function toResearchIdea(row) {
  return {
    id: row.id,
    contributor: row.contributor,
    focus: row.focus,
    idea: row.idea,
    createdAt: row.created_at || row.createdAt
  };
}

async function supabaseRequest(table, options = {}) {
  const url = new URL(`${supabaseUrl}/rest/v1/${table}`);

  if (options.query) {
    Object.entries(options.query).forEach(([key, value]) => {
      url.searchParams.set(key, value);
    });
  }

  const response = await fetch(url, {
    method: options.method || "GET",
    headers: {
      apikey: supabaseServiceRoleKey,
      Authorization: `Bearer ${supabaseServiceRoleKey}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
      ...(options.headers || {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });

  const text = await response.text();
  const data = text ? JSON.parse(text) : null;

  if (!response.ok) {
    throw new Error(data?.message || "Supabase request failed.");
  }

  return data;
}

const store = {
  async getCollectors({ admin = false } = {}) {
    if (supabaseEnabled) {
      const rows = await supabaseRequest("collectors", {
        query: { select: "*", order: "created_at.desc" }
      });
      const collectors = rows.map(toCollector);
      return admin ? collectors : collectors.map(publicCollector);
    }

    const collectors = readDatabase().collectors;
    return admin ? collectors : collectors.map(publicCollector);
  },

  async createCollector(collector) {
    if (supabaseEnabled) {
      const rows = await supabaseRequest("collectors", {
        method: "POST",
        body: {
          name: collector.name,
          phone: collector.phone,
          area: collector.area,
          vehicle: collector.vehicle
        }
      });
      return toCollector(rows[0]);
    }

    const database = readDatabase();
    const created = { id: randomUUID(), ...collector, createdAt: new Date().toISOString() };
    database.collectors.unshift(created);
    writeDatabase(database);
    return created;
  },

  async clearCollectors() {
    if (supabaseEnabled) {
      await supabaseRequest("collectors", {
        method: "DELETE",
        query: { id: "not.is.null" },
        headers: { Prefer: "return=minimal" }
      });
      return { ok: true };
    }

    const database = readDatabase();
    database.collectors = [];
    writeDatabase(database);
    return { ok: true };
  },

  async getPickups({ admin = false } = {}) {
    if (supabaseEnabled) {
      const rows = await supabaseRequest("pickup_requests", {
        query: { select: "*", order: "created_at.desc" }
      });
      const pickups = rows.map(toPickup);
      return admin ? pickups : pickups.map(publicPickup);
    }

    const pickups = readDatabase().pickupRequests;
    return admin ? pickups : pickups.map(publicPickup);
  },

  async createPickup(pickup) {
    if (supabaseEnabled) {
      const rows = await supabaseRequest("pickup_requests", {
        method: "POST",
        body: {
          customer_name: pickup.customerName,
          phone: pickup.phone,
          address: pickup.address,
          plastic_type: pickup.plasticType,
          weight: pickup.weight,
          slot: pickup.slot,
          notes: pickup.notes,
          status: pickup.status,
          estimated_reward: pickup.estimatedReward
        }
      });
      return toPickup(rows[0]);
    }

    const database = readDatabase();
    const created = { id: randomUUID(), ...pickup, createdAt: new Date().toISOString() };
    database.pickupRequests.unshift(created);
    writeDatabase(database);
    return created;
  },

  async clearPickups() {
    if (supabaseEnabled) {
      await supabaseRequest("pickup_requests", {
        method: "DELETE",
        query: { id: "not.is.null" },
        headers: { Prefer: "return=minimal" }
      });
      return { ok: true };
    }

    const database = readDatabase();
    database.pickupRequests = [];
    writeDatabase(database);
    return { ok: true };
  },

  async assignPickup(pickupId, collectorId) {
    if (supabaseEnabled) {
      const collectors = await supabaseRequest("collectors", {
        query: { select: "*", id: `eq.${collectorId}`, limit: "1" }
      });

      if (!collectors.length) {
        return { error: "Collector not found." };
      }

      const collector = toCollector(collectors[0]);
      const rows = await supabaseRequest("pickup_requests", {
        method: "PATCH",
        query: { id: `eq.${pickupId}` },
        body: {
          status: "Collector assigned",
          assigned_collector_id: collector.id,
          assigned_collector_name: collector.name,
          assigned_collector_phone: collector.phone,
          assigned_at: new Date().toISOString()
        }
      });

      if (!rows.length) {
        return { error: "Pickup request not found." };
      }

      return toPickup(rows[0]);
    }

    const database = readDatabase();
    const pickupRequest = database.pickupRequests.find((pickup) => pickup.id === pickupId);
    const collector = database.collectors.find((candidate) => candidate.id === collectorId);

    if (!pickupRequest) {
      return { error: "Pickup request not found." };
    }

    if (!collector) {
      return { error: "Collector not found." };
    }

    pickupRequest.status = "Collector assigned";
    pickupRequest.assignedCollectorId = collector.id;
    pickupRequest.assignedCollectorName = collector.name;
    pickupRequest.assignedCollectorPhone = collector.phone;
    pickupRequest.assignedAt = new Date().toISOString();
    writeDatabase(database);
    return pickupRequest;
  },

  async createResearchIdea(researchIdea) {
    if (supabaseEnabled) {
      const rows = await supabaseRequest("research_ideas", {
        method: "POST",
        body: {
          contributor: researchIdea.contributor,
          focus: researchIdea.focus,
          idea: researchIdea.idea
        }
      });
      return toResearchIdea(rows[0]);
    }

    const database = readDatabase();
    const created = { id: randomUUID(), ...researchIdea, createdAt: new Date().toISOString() };
    database.researchIdeas.unshift(created);
    writeDatabase(database);
    return created;
  },

  async getResearchIdeas() {
    if (supabaseEnabled) {
      const rows = await supabaseRequest("research_ideas", {
        query: { select: "*", order: "created_at.desc" }
      });
      return rows.map(toResearchIdea);
    }

    return readDatabase().researchIdeas;
  }
};

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, { ...securityHeaders, "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function requireAdmin(request, response) {
  if (request.headers["x-admin-pin"] === adminPin) {
    return true;
  }

  sendJson(response, 401, { error: "Admin PIN required." });
  return false;
}

function publicCollector(collector) {
  return {
    id: collector.id,
    name: collector.name,
    area: collector.area,
    vehicle: collector.vehicle,
    createdAt: collector.createdAt
  };
}

function publicPickup(pickup) {
  return {
    id: pickup.id,
    customerName: pickup.customerName,
    plasticType: pickup.plasticType,
    weight: pickup.weight,
    slot: pickup.slot,
    status: pickup.status,
    estimatedReward: pickup.estimatedReward,
    assignedCollectorName: pickup.assignedCollectorName,
    createdAt: pickup.createdAt
  };
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";

    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 25_000) {
        request.destroy();
        reject(new Error("Request body is too large."));
      }
    });

    request.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
  });
}

function validateFields(payload, fields) {
  const missing = fields.filter((field) => !String(payload[field] || "").trim());
  return missing;
}

function getRouteParts(pathname) {
  return pathname.split("/").filter(Boolean);
}

function serveStatic(request, response) {
  const requestUrl = new URL(request.url, `http://${request.headers.host}`);
  const cleanPath = requestUrl.pathname === "/" ? "/index.html" : requestUrl.pathname;
  const filePath = path.normalize(path.join(rootDir, cleanPath));

  if (!filePath.startsWith(rootDir)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (error, content) => {
    if (error) {
      response.writeHead(404);
      response.end("Not found");
      return;
    }

    response.writeHead(200, { ...securityHeaders, "Content-Type": mimeTypes[path.extname(filePath)] || "text/plain; charset=utf-8" });
    response.end(content);
  });
}

async function handleApi(request, response) {
  const requestUrl = new URL(request.url, `http://${request.headers.host}`);

  if (request.method === "GET" && requestUrl.pathname === "/api/collectors") {
    sendJson(response, 200, await store.getCollectors());
    return;
  }

  if (request.method === "GET" && requestUrl.pathname === "/api/admin/collectors") {
    if (!requireAdmin(request, response)) {
      return;
    }

    sendJson(response, 200, await store.getCollectors({ admin: true }));
    return;
  }

  if (request.method === "POST" && requestUrl.pathname === "/api/collectors") {
    const payload = await readBody(request);
    const missing = validateFields(payload, ["name", "phone", "area", "vehicle"]);

    if (missing.length) {
      sendJson(response, 400, { error: `Missing fields: ${missing.join(", ")}` });
      return;
    }

    if (!isPhoneNumber(payload.phone)) {
      sendJson(response, 400, { error: "Enter a valid phone number." });
      return;
    }

    const collector = {
      name: sanitizeText(payload.name, 80),
      phone: sanitizeText(payload.phone, 20),
      area: sanitizeText(payload.area, 120),
      vehicle: sanitizeText(payload.vehicle, 40)
    };

    sendJson(response, 201, await store.createCollector(collector));
    return;
  }

  if (request.method === "DELETE" && requestUrl.pathname === "/api/collectors") {
    if (!requireAdmin(request, response)) {
      return;
    }

    sendJson(response, 200, await store.clearCollectors());
    return;
  }

  if (request.method === "GET" && requestUrl.pathname === "/api/pickup-requests") {
    sendJson(response, 200, await store.getPickups());
    return;
  }

  if (request.method === "GET" && requestUrl.pathname === "/api/admin/pickup-requests") {
    if (!requireAdmin(request, response)) {
      return;
    }

    sendJson(response, 200, await store.getPickups({ admin: true }));
    return;
  }

  if (request.method === "POST" && requestUrl.pathname === "/api/pickup-requests") {
    const payload = await readBody(request);
    const missing = validateFields(payload, ["customerName", "phone", "address", "plasticType", "weight", "slot"]);

    if (missing.length) {
      sendJson(response, 400, { error: `Missing fields: ${missing.join(", ")}` });
      return;
    }

    const weight = Number.parseFloat(payload.weight);

    if (!isPhoneNumber(payload.phone)) {
      sendJson(response, 400, { error: "Enter a valid phone number." });
      return;
    }

    if (!Number.isFinite(weight) || weight <= 0 || weight > 500) {
      sendJson(response, 400, { error: "Pickup weight must be between 1 and 500 kg." });
      return;
    }

    if (!allowedPlasticTypes.has(payload.plasticType)) {
      sendJson(response, 400, { error: "Select a valid plastic type." });
      return;
    }

    if (!allowedSlots.has(payload.slot)) {
      sendJson(response, 400, { error: "Select a valid pickup slot." });
      return;
    }

    const pickupRequest = {
      customerName: sanitizeText(payload.customerName, 80),
      phone: sanitizeText(payload.phone, 20),
      address: sanitizeText(payload.address, 240),
      plasticType: sanitizeText(payload.plasticType, 40),
      weight: String(weight),
      slot: sanitizeText(payload.slot, 40),
      notes: sanitizeText(payload.notes, 180),
      status: "Searching collector",
      estimatedReward: estimateReward(weight)
    };

    sendJson(response, 201, await store.createPickup(pickupRequest));
    return;
  }

  if (request.method === "DELETE" && requestUrl.pathname === "/api/pickup-requests") {
    if (!requireAdmin(request, response)) {
      return;
    }

    sendJson(response, 200, await store.clearPickups());
    return;
  }

  const routeParts = getRouteParts(requestUrl.pathname);

  if (
    request.method === "PATCH" &&
    routeParts.length === 4 &&
    routeParts[0] === "api" &&
    routeParts[1] === "pickup-requests" &&
    routeParts[3] === "assign"
  ) {
    if (!requireAdmin(request, response)) {
      return;
    }

    const payload = await readBody(request);
    const missing = validateFields(payload, ["collectorId"]);

    if (missing.length) {
      sendJson(response, 400, { error: `Missing fields: ${missing.join(", ")}` });
      return;
    }

    const assignedPickup = await store.assignPickup(routeParts[2], payload.collectorId);

    if (assignedPickup.error) {
      sendJson(response, 404, { error: assignedPickup.error });
      return;
    }

    sendJson(response, 200, assignedPickup);
    return;
  }

  if (request.method === "GET" && requestUrl.pathname === "/api/research-ideas") {
    sendJson(response, 200, await store.getResearchIdeas());
    return;
  }

  if (request.method === "POST" && requestUrl.pathname === "/api/research-ideas") {
    const payload = await readBody(request);
    const missing = validateFields(payload, ["contributor", "focus", "idea"]);

    if (missing.length) {
      sendJson(response, 400, { error: `Missing fields: ${missing.join(", ")}` });
      return;
    }

    const researchIdea = {
      contributor: sanitizeText(payload.contributor, 80),
      focus: sanitizeText(payload.focus, 80),
      idea: sanitizeText(payload.idea, 1000)
    };

    sendJson(response, 201, await store.createResearchIdea(researchIdea));
    return;
  }

  sendJson(response, 404, { error: "API route not found." });
}

const server = http.createServer((request, response) => {
  if (request.url.startsWith("/api/")) {
    handleApi(request, response).catch((error) => {
      sendJson(response, 500, { error: error.message || "Server error." });
    });
    return;
  }

  serveStatic(request, response);
});

ensureDatabase();

server.listen(port, () => {
  console.log(`PlasticLoop running at http://localhost:${port}`);
  console.log(`Admin PIN: ${adminPin}`);
});
