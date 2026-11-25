const PRICE_COP = 4900;
const PRICE_IN_CENTS = PRICE_COP * 100;
const CURRENCY = "COP";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin");

    if (request.method === "OPTIONS") {
      if (origin !== env.PUBLIC_SITE_ORIGIN) {
        return new Response(null, { status: 403 });
      }
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    try {
      if (url.pathname === "/health" && request.method === "GET") {
        // Verifica D1, el bucket R2 y el archivo completo esperado.
        const dbResult = await env.DB.prepare(
          "SELECT COUNT(*) AS table_rows FROM purchases"
        ).first();
        await env.PRIVATE_ASSETS.list({ limit: 1 });
        const assetKey = env.PRIVATE_ASSET_KEY || "drum-studio-beta1-full.html";
        const asset = await env.PRIVATE_ASSETS.head(assetKey);
        return json({
          ok: true,
          service: "IngeniaLab Beta 1 access",
          bindings: {
            database: typeof dbResult?.table_rows === "number",
            privateStorage: true,
            privateAsset: Boolean(asset),
            privateAssetSize: asset ? asset.size : 0
          }
        }, 200, origin, env);
      }

      if (url.pathname === "/api/checkout" && request.method === "POST") {
        assertBrowserOrigin(origin, env);
        return await createCheckout(request, env, origin);
      }

      if (url.pathname === "/api/content" && request.method === "POST") {
        assertBrowserOrigin(origin, env);
        return await deliverContent(request, env, origin);
      }

      if (url.pathname === "/api/wompi/events" && request.method === "POST") {
        return await handleWompiEvent(request, env);
      }

      return json({ error: "Ruta no encontrada." }, 404, origin, env);
    } catch (error) {
      console.error("Request failed:", error instanceof Error ? error.message : "unknown");
      const status = error && Number.isInteger(error.status) ? error.status : 500;
      const message = status >= 500
        ? "No fue posible procesar la solicitud. Intenta nuevamente."
        : (error.message || "Solicitud no válida.");
      return json({ error: message }, status, origin, env);
    }
  },
};

async function createCheckout(request, env, origin) {
  requireConfig(env, [
    "WOMPI_ENV",
    "WOMPI_PUBLIC_KEY",
    "WOMPI_INTEGRITY_SECRET",
    "PUBLIC_RETURN_URL",
    "ACCESS_TOKEN_PEPPER",
  ]);
  validateAccessPepper(env.ACCESS_TOKEN_PEPPER);
  validateWompiEnvironment(env, ["public", "integrity"]);

  const body = await readJson(request);
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 254) {
    throw httpError(400, "Escribe un correo electrónico válido.");
  }

  const reference = "ILAB-BETA1-" + crypto.randomUUID().replaceAll("-", "").toUpperCase();
  const accessToken = randomHex(32);
  const tokenHash = await sha256Hex(accessToken + env.ACCESS_TOKEN_PEPPER);
  const integrity = await sha256Hex(
    reference + String(PRICE_IN_CENTS) + CURRENCY + env.WOMPI_INTEGRITY_SECRET
  );

  const checkout = new URL("https://checkout.wompi.co/p/");
  checkout.searchParams.set("public-key", env.WOMPI_PUBLIC_KEY);
  checkout.searchParams.set("currency", CURRENCY);
  checkout.searchParams.set("amount-in-cents", String(PRICE_IN_CENTS));
  checkout.searchParams.set("reference", reference);
  checkout.searchParams.set("signature:integrity", integrity);
  checkout.searchParams.set("redirect-url", appendQuery(env.PUBLIC_RETURN_URL, "ref", reference));
  checkout.searchParams.set("customer-data:email", email);

  await env.DB.prepare(
    `INSERT INTO purchases
      (reference, email, amount_in_cents, currency, status, access_token_hash)
     VALUES (?, ?, ?, ?, 'pending', ?)`
  ).bind(reference, email, PRICE_IN_CENTS, CURRENCY, tokenHash).run();

  return json({
    reference,
    accessToken,
    checkoutUrl: checkout.toString(),
    amountCop: PRICE_COP,
    currency: CURRENCY,
    product: "Drum Studio 5.9 — Beta 1",
    updatesIncluded: false,
  }, 201, origin, env);
}

async function handleWompiEvent(request, env) {
  requireConfig(env, ["WOMPI_EVENTS_SECRET", "WOMPI_PRIVATE_KEY", "WOMPI_ENV"]);
  validateWompiEnvironment(env, ["events", "private"]);

  const raw = await request.text();
  if (raw.length > 64_000) throw httpError(413, "Evento demasiado grande.");

  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    throw httpError(400, "JSON de evento no válido.");
  }

  if (event?.event !== "transaction.updated") {
    return new Response("ignored", { status: 200 });
  }

  const expectedEnvironment = env.WOMPI_ENV === "prod" ? "prod" : "test";
  if (event.environment !== expectedEnvironment) {
    throw httpError(400, "El ambiente del evento no coincide.");
  }

  const isAuthentic = await verifyWompiEvent(event, request.headers, env.WOMPI_EVENTS_SECRET);
  if (!isAuthentic) throw httpError(401, "Firma de evento inválida.");

  const transaction = event?.data?.transaction;
  if (!transaction || typeof transaction.id !== "string" || typeof transaction.reference !== "string") {
    throw httpError(400, "El evento no contiene una transacción válida.");
  }

  const order = await env.DB.prepare(
    "SELECT reference, amount_in_cents, currency, status FROM purchases WHERE reference = ?"
  ).bind(transaction.reference).first();

  // Este Worker solo administra las compras de IngeniaLab Beta 1.
  // Los demás pagos procesados por la misma cuenta Wompi se ignoran.
  if (!order) return new Response("ignored", { status: 200 });

  // Verificación independiente en Wompi para confirmar referencia, monto y moneda.
  const confirmed = await fetchWompiTransaction(transaction.id, env);
  if (
    confirmed?.id !== transaction.id ||
    confirmed?.reference !== order.reference ||
    Number(confirmed?.amount_in_cents) !== PRICE_IN_CENTS ||
    confirmed?.currency !== CURRENCY ||
    confirmed?.status !== transaction.status ||
    Number(transaction.amount_in_cents) !== PRICE_IN_CENTS
  ) {
    throw httpError(409, "Los datos de la transacción no coinciden.");
  }

  if (transaction.status === "APPROVED") {
    await env.DB.prepare(
      `UPDATE purchases
       SET status = 'paid', wompi_transaction_id = ?, paid_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
       WHERE reference = ? AND amount_in_cents = ? AND currency = ?
         AND status IN ('pending', 'paid')`
    ).bind(transaction.id, order.reference, PRICE_IN_CENTS, CURRENCY).run();
  } else if (transaction.status === "VOIDED") {
    await env.DB.prepare(
      `UPDATE purchases SET status = 'revoked', updated_at = CURRENT_TIMESTAMP
       WHERE reference = ? AND wompi_transaction_id = ?`
    ).bind(order.reference, transaction.id).run();
  } else if (["DECLINED", "ERROR"].includes(transaction.status)) {
    await env.DB.prepare(
      `UPDATE purchases SET status = 'rejected', updated_at = CURRENT_TIMESTAMP
       WHERE reference = ? AND status = 'pending'`
    ).bind(order.reference).run();
  }

  return new Response("ok", { status: 200 });
}

async function deliverContent(request, env, origin) {
  requireConfig(env, ["ACCESS_TOKEN_PEPPER"]);
  validateAccessPepper(env.ACCESS_TOKEN_PEPPER);
  const body = await readJson(request);
  const reference = typeof body.reference === "string" ? body.reference : "";
  const accessToken = typeof body.accessToken === "string" ? body.accessToken : "";

  if (
    !/^ILAB-BETA1-[A-F0-9]{32}$/.test(reference) ||
    !/^[a-f0-9]{64}$/.test(accessToken)
  ) {
    throw httpError(400, "Datos de acceso no válidos.");
  }

  const tokenHash = await sha256Hex(accessToken + env.ACCESS_TOKEN_PEPPER);
  const purchase = await env.DB.prepare(
    `SELECT status, access_token_hash, amount_in_cents, currency
     FROM purchases WHERE reference = ?`
  ).bind(reference).first();

  // Solo el webhook firmado, verificado contra la API de Wompi en el servidor,
  // puede cambiar una compra a "paid". La redirección del navegador no desbloquea.
  if (
    !purchase ||
    purchase.status !== "paid" ||
    purchase.amount_in_cents !== PRICE_IN_CENTS ||
    purchase.currency !== CURRENCY ||
    !constantTimeEqual(tokenHash, purchase.access_token_hash || "")
  ) {
    throw httpError(403, "El pago aún no está confirmado o el acceso no es válido.");
  }

  const assetKey = env.PRIVATE_ASSET_KEY || "drum-studio-beta1-full.html";
  const object = await env.PRIVATE_ASSETS.get(assetKey);
  if (!object) throw httpError(503, "El simulador todavía no está instalado en el almacenamiento privado.");

  const headers = new Headers({
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store, private",
    "Content-Disposition": 'inline; filename="IngeniaLab_Drum_Studio_5_9_Beta1.html"',
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  });
  if (origin === env.PUBLIC_SITE_ORIGIN) {
    Object.entries(corsHeaders(origin)).forEach(([key, value]) => headers.set(key, value));
  }
  return new Response(object.body, { status: 200, headers });
}

async function verifyWompiEvent(event, requestHeaders, secret) {
  const properties = event?.signature?.properties;
  // Wompi puede variar la lista y el orden de propiedades firmadas.
  // Se recorren todas en el orden exacto recibido y se exige que el ID
  // de la transacción esté firmado; referencia, estado, monto y moneda
  // se contrastan después con la consulta servidor-a-servidor a Wompi.
  if (!Array.isArray(properties) || properties.length === 0 || !properties.includes("transaction.id")) {
    return false;
  }

  let signedValues = "";
  for (const property of properties) {
    if (typeof property !== "string") return false;
    const value = getSafePath(event.data, property.split("."));
    if (value === undefined || value === null) return false;
    signedValues += String(value);
  }

  if (!Number.isInteger(event.timestamp)) return false;
  const calculated = await sha256Hex(signedValues + String(event.timestamp) + secret);
  const bodyChecksum = event?.signature?.checksum;
  const headerChecksum = requestHeaders.get("X-Event-Checksum");

  if (typeof bodyChecksum !== "string" || !constantTimeEqual(calculated, bodyChecksum.toLowerCase())) {
    return false;
  }
  if (headerChecksum && !constantTimeEqual(calculated, headerChecksum.toLowerCase())) {
    return false;
  }
  return true;
}

function getSafePath(object, parts) {
  let value = object;
  for (const part of parts) {
    if (["__proto__", "prototype", "constructor"].includes(part)) return undefined;
    if (value === null || typeof value !== "object") return undefined;
    value = value[part];
  }
  return value;
}

async function fetchWompiTransaction(transactionId, env) {
  const environment = env.WOMPI_ENV;
  if (!/^[A-Za-z0-9-]{6,100}$/.test(transactionId)) {
    throw httpError(400, "Identificador de transacción no válido.");
  }

  const base = environment === "prod"
    ? "https://production.wompi.co"
    : "https://sandbox.wompi.co";
  const expectedPrivatePrefix = environment === "prod" ? "prv_prod_" : "prv_test_";
  if (!env.WOMPI_PRIVATE_KEY || !env.WOMPI_PRIVATE_KEY.startsWith(expectedPrivatePrefix)) {
    throw httpError(503, "La llave privada de Wompi no corresponde al ambiente configurado.");
  }

  const response = await fetch(base + "/v1/transactions/" + encodeURIComponent(transactionId), {
    headers: {
      "Accept": "application/json",
      "Authorization": "Bearer " + env.WOMPI_PRIVATE_KEY,
    },
  });

  if (!response.ok) throw httpError(503, "No se pudo confirmar la transacción con Wompi.");
  const payload = await response.json();
  return payload?.data || null;
}


function validateWompiEnvironment(env, requiredTypes) {
  const environment = env.WOMPI_ENV;
  if (!["test", "prod"].includes(environment)) {
    throw httpError(503, "WOMPI_ENV debe ser test o prod.");
  }

  const prefixes = environment === "test"
    ? {
        public: "pub_test_",
        private: "prv_test_",
        events: "test_events_",
        integrity: "test_integrity_",
      }
    : {
        public: "pub_prod_",
        private: "prv_prod_",
        events: "prod_events_",
        integrity: "prod_integrity_",
      };

  const variableNames = {
    public: "WOMPI_PUBLIC_KEY",
    private: "WOMPI_PRIVATE_KEY",
    events: "WOMPI_EVENTS_SECRET",
    integrity: "WOMPI_INTEGRITY_SECRET",
  };

  for (const type of requiredTypes) {
    const name = variableNames[type];
    if (!name || typeof env[name] !== "string" || !env[name].startsWith(prefixes[type])) {
      throw httpError(503, "La credencial " + (name || type) + " no corresponde al ambiente configurado.");
    }
  }
}

function validateAccessPepper(value) {
  if (typeof value !== "string" || value.length < 64) {
    throw httpError(503, "ACCESS_TOKEN_PEPPER debe ser una cadena aleatoria de al menos 64 caracteres.");
  }
}

async function readJson(request) {
  const contentType = request.headers.get("Content-Type") || "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw httpError(415, "Se requiere contenido JSON.");
  }
  const length = Number(request.headers.get("Content-Length") || 0);
  if (length > 5_000) throw httpError(413, "Solicitud demasiado grande.");
  try {
    return await request.json();
  } catch {
    throw httpError(400, "JSON no válido.");
  }
}

function requireConfig(env, names) {
  const missing = names.filter((name) => !env[name]);
  if (missing.length) throw httpError(503, "El servicio todavía no está configurado.");
}

function assertBrowserOrigin(origin, env) {
  if (!origin || origin !== env.PUBLIC_SITE_ORIGIN) {
    throw httpError(403, "Origen no autorizado.");
  }
}

function appendQuery(base, key, value) {
  const url = new URL(base);
  url.searchParams.set(key, value);
  return url.toString();
}

async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function randomHex(length) {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string" || left.length !== right.length) return false;
  let difference = 0;
  for (let i = 0; i < left.length; i += 1) {
    difference |= left.charCodeAt(i) ^ right.charCodeAt(i);
  }
  return difference === 0;
}

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

function json(payload, status, origin, env) {
  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  });
  if (env && origin === env.PUBLIC_SITE_ORIGIN) {
    Object.entries(corsHeaders(origin)).forEach(([key, value]) => headers.set(key, value));
  }
  return new Response(JSON.stringify(payload), { status, headers });
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}
