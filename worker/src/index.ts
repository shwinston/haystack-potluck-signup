/**
 * Shared haystack potluck sign-ups.
 *
 * Exclusive dishes are inserted under a unique claim_key (the item name).
 * D1 runs a batch as one transaction, so two people claiming the same dish
 * cannot both succeed. Cooked Rice uses a per-signup key and stays open.
 *
 * Item names must match ITEMS in index.html.
 */

const PAGES_ORIGIN = "https://shwinston.github.io";

const ITEM_NAMES = [
  "Corn or Tortilla Chips (Fritos or sturdy)",
  "Seasoned Beans",
  "Shredded Cheese (cheddar or Mexican blend)",
  "Shredded Lettuce (iceberg or romaine)",
  "Diced Tomatoes",
  "Sliced Black Olives",
  "Salsa",
  "Guacamole",
  "Cooked Rice",
  "Diced Onions",
  "Ranch Dressing",
  "Sour Cream",
  "Apple Juice",
  "Grape Juice",
  "Dessert",
] as const;

const ITEM_SET = new Set<string>(ITEM_NAMES);
const REPEATABLE_ITEMS = new Set<string>(["Cooked Rice"]);

const MAX_NAME = 80;
const MAX_NOTES = 400;
const MAX_BODY = 8000;
const WINDOW_MS = 10 * 60 * 1000;
const SIGNUP_LIMIT = 80;
const REMOVE_LIMIT = 30;
const RESET_LIMIT = 10;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Signup = {
  id: string;
  name: string;
  party: number;
  notes: string;
  items: string[];
  createdAt: string;
};

type SignupList = {
  signups: Signup[];
  headcount: number;
};

type Database = {
  prepare(query: string): D1PreparedStatement;
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
};

type SignupInput = {
  name: string;
  party: number;
  notes: string;
  items: string[];
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin");

    try {
      const response = await route(request, env, url, origin);
      console.log(
        JSON.stringify({
          message: "request",
          method: request.method,
          path: url.pathname,
          status: response.status,
        }),
      );
      return response;
    } catch (error) {
      console.error(
        JSON.stringify({
          message: "request failed",
          method: request.method,
          path: url.pathname,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      return json(origin, { error: "server", message: "Something went wrong. Please try again." }, 500);
    }
  },
} satisfies ExportedHandler<Env>;

async function route(request: Request, env: Env, url: URL, origin: string | null): Promise<Response> {
  if (request.method === "OPTIONS") return preflight(origin);
  if (origin && !isAllowedOrigin(origin)) {
    return json(origin, { error: "forbidden", message: "This page is not allowed to use the signup list." }, 403);
  }

  if (url.pathname === "/" && request.method === "GET") {
    return json(origin, { ok: true, service: "haystack-potluck-signup" }, 200);
  }

  if (url.pathname === "/api/signups" && request.method === "GET") {
    return listResponse(env, origin);
  }

  if (url.pathname === "/api/signups" && request.method === "POST") {
    return createSignup(request, env, origin);
  }

  if (url.pathname === "/api/reset" && request.method === "POST") {
    return resetAll(request, env, origin);
  }

  const removal = url.pathname.match(/^\/api\/signups\/([^/]+)$/);
  if (removal && request.method === "DELETE") {
    return removeSignup(request, env, origin, decodeURIComponent(removal[1]));
  }

  return json(origin, { error: "not_found", message: "That page is not part of the signup list." }, 404);
}

function database(env: Env): Database {
  return env.DB.withSession("first-primary");
}

async function listResponse(env: Env, origin: string | null): Promise<Response> {
  const list = await listSignups(database(env));
  return json(origin, list, 200);
}

async function createSignup(request: Request, env: Env, origin: string | null): Promise<Response> {
  const limited = await rateLimit(env, request, "signup", SIGNUP_LIMIT);
  if (limited) return limited;

  const parsed = await readJson(request);
  if (!parsed.ok) return json(origin, { error: "invalid", message: parsed.message }, 400);

  const input = validateSignup(parsed.value);
  if (!input.ok) return json(origin, { error: "invalid", message: input.message }, 400);

  const id = crypto.randomUUID();
  const cancelToken = randomToken();
  const tokenHash = await sha256Hex(cancelToken);
  const createdAt = new Date().toISOString();

  try {
    await runBusy(async () => {
      const db = database(env);
      await db.batch([
        db
          .prepare(
            `INSERT INTO signups (id, name, party, notes, cancel_token_hash, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .bind(id, input.name, input.party, input.notes, tokenHash, createdAt),
        ...input.items.map((item) =>
          db
            .prepare(`INSERT INTO signup_items (signup_id, item, claim_key) VALUES (?, ?, ?)`)
            .bind(id, item, claimKey(item, id)),
        ),
      ]);
    });
  } catch (error) {
    if (!isUniqueError(error)) throw error;
    const list = await listSignups(database(env));
    const taken = exclusiveTaken(list.signups);
    const conflicts = input.items.filter((item) => taken.has(item));
    const subject = conflicts.length > 0 ? joinNames(conflicts) : "That item";
    const verb = conflicts.length === 1 || conflicts.length === 0 ? "was" : "were";
    console.log(JSON.stringify({ message: "claim conflict", count: conflicts.length }));
    return json(
      origin,
      {
        error: "just_taken",
        message: `${subject} ${verb} just taken. Nothing from this signup was saved. The list has been refreshed.`,
        takenItems: conflicts,
        ...list,
      },
      409,
    );
  }

  const list = await listSignups(database(env));
  const signup = list.signups.find((entry) => entry.id === id) ?? null;
  return json(origin, { signup, cancelToken, ...list }, 201);
}

async function removeSignup(
  request: Request,
  env: Env,
  origin: string | null,
  id: string,
): Promise<Response> {
  if (!UUID_RE.test(id)) {
    return json(origin, { error: "not_found", message: "That signup is already gone." }, 404);
  }

  const limited = await rateLimit(env, request, "remove", REMOVE_LIMIT);
  if (limited) return limited;

  const parsed = await readJson(request);
  if (!parsed.ok) return json(origin, { error: "invalid", message: parsed.message }, 400);

  const body = asRecord(parsed.value);
  const cancelToken = typeof body?.cancelToken === "string" ? body.cancelToken : "";
  const resetCode = typeof body?.resetCode === "string" ? body.resetCode : "";
  const db = database(env);
  const row = await db
    .prepare(`SELECT id, cancel_token_hash FROM signups WHERE id = ?`)
    .bind(id)
    .first<{ id: string; cancel_token_hash: string }>();

  if (!row) {
    const list = await listSignups(db);
    return json(
      origin,
      { error: "not_found", message: "That signup is already gone. The list has been refreshed.", ...list },
      404,
    );
  }

  const allowed = await removalAllowed(env, cancelToken, resetCode, row.cancel_token_hash);
  if (!allowed.ok) return json(origin, { error: allowed.error, message: allowed.message }, allowed.status);

  await runBusy(async () => {
    const writeDb = database(env);
    await writeDb.batch([
      writeDb.prepare(`DELETE FROM signup_items WHERE signup_id = ?`).bind(id),
      writeDb.prepare(`DELETE FROM signups WHERE id = ?`).bind(id),
    ]);
  });

  const list = await listSignups(database(env));
  return json(origin, { ok: true, ...list }, 200);
}

async function resetAll(request: Request, env: Env, origin: string | null): Promise<Response> {
  const limited = await rateLimit(env, request, "reset", RESET_LIMIT);
  if (limited) return limited;

  const parsed = await readJson(request);
  if (!parsed.ok) return json(origin, { error: "invalid", message: parsed.message }, 400);

  const body = asRecord(parsed.value);
  const resetCode = typeof body?.resetCode === "string" ? body.resetCode : "";
  const code = await checkResetCode(env, resetCode);
  if (!code.ok) return json(origin, { error: code.error, message: code.message }, code.status);

  await runBusy(async () => {
    const db = database(env);
    await db.batch([
      db.prepare(`DELETE FROM signup_items`),
      db.prepare(`DELETE FROM signups`),
      db.prepare(`DELETE FROM rate_limits`),
    ]);
  });
  const list = await listSignups(database(env));
  return json(origin, { ok: true, ...list }, 200);
}

async function removalAllowed(
  env: Env,
  cancelToken: string,
  resetCode: string,
  storedHash: string,
): Promise<{ ok: true } | { ok: false; status: number; error: string; message: string }> {
  if (cancelToken) {
    if (await tokenMatches(cancelToken, storedHash)) return { ok: true };
    if (!resetCode) {
      return {
        ok: false,
        status: 401,
        error: "unauthorized",
        message: "This device can't cancel that signup.",
      };
    }
  }

  if (resetCode) {
    const code = await checkResetCode(env, resetCode);
    if (!code.ok) return code;
    return { ok: true };
  }

  return {
    ok: false,
    status: 401,
    error: "unauthorized",
    message: "This device can't cancel that signup.",
  };
}

async function checkResetCode(
  env: Env,
  provided: string,
): Promise<{ ok: true } | { ok: false; status: number; error: string; message: string }> {
  if (!env.RESET_CODE) {
    console.error(JSON.stringify({ message: "RESET_CODE secret is not set" }));
    return {
      ok: false,
      status: 503,
      error: "unavailable",
      message: "Reset is not available right now.",
    };
  }
  if (!(await codeMatches(provided, env.RESET_CODE))) {
    return { ok: false, status: 401, error: "unauthorized", message: "That code is not right." };
  }
  return { ok: true };
}

async function listSignups(db: Database): Promise<SignupList> {
  const result = await db
    .prepare(
      `SELECT s.id, s.name, s.party, s.notes, s.created_at, i.item
       FROM signups s
       LEFT JOIN signup_items i ON i.signup_id = s.id
       ORDER BY s.created_at ASC, i.item ASC`,
    )
    .all<{
      id: string;
      name: string;
      party: number;
      notes: string;
      created_at: string;
      item: string | null;
    }>();

  const grouped = new Map<string, Signup>();
  for (const row of result.results) {
    let signup = grouped.get(row.id);
    if (!signup) {
      signup = {
        id: row.id,
        name: row.name,
        party: row.party,
        notes: row.notes,
        items: [],
        createdAt: row.created_at,
      };
      grouped.set(row.id, signup);
    }
    if (row.item) signup.items.push(row.item);
  }

  const signups = Array.from(grouped.values());
  const headcount = signups.reduce((sum, signup) => sum + signup.party, 0);
  return { signups, headcount };
}

async function rateLimit(
  env: Env,
  request: Request,
  action: string,
  limit: number,
): Promise<Response | null> {
  const ip = request.headers.get("CF-Connecting-IP") || "local";
  const bucket = Math.floor(Date.now() / WINDOW_MS);
  const key = `${action}:${ip}:${bucket}`;
  const row = await runBusy(() =>
    database(env)
      .prepare(
        `INSERT INTO rate_limits (bucket_key, hits) VALUES (?, 1)
         ON CONFLICT(bucket_key) DO UPDATE SET hits = hits + 1
         RETURNING hits`,
      )
      .bind(key)
      .first<{ hits: number }>(),
  );

  if (row && row.hits > limit) {
    console.log(JSON.stringify({ message: "rate limited", action }));
    return json(
      request.headers.get("Origin"),
      { error: "rate_limited", message: "Too many tries. Wait a few minutes and try again." },
      429,
    );
  }
  return null;
}

function validateSignup(value: unknown): { ok: true } & SignupInput | { ok: false; message: string } {
  const body = asRecord(value);
  if (!body) return { ok: false, message: "That signup could not be read." };

  if (typeof body.name !== "string") return { ok: false, message: "Please enter your name." };
  const name = body.name.trim();
  if (!name) return { ok: false, message: "Please enter your name." };
  if (name.length > MAX_NAME) {
    return { ok: false, message: "Please use a shorter name (80 characters or fewer)." };
  }
  if (/[\u0000-\u001F\u007F]/.test(name)) {
    return { ok: false, message: "Please enter your name without line breaks." };
  }

  const party = normalizeParty(body.party);
  if (party === null) return { ok: false, message: "Enter a party size from 1 to 99." };

  let notes = "";
  if (body.notes !== undefined && body.notes !== null) {
    if (typeof body.notes !== "string") return { ok: false, message: "Notes should be plain text." };
    notes = body.notes.trim();
    if (notes.length > MAX_NOTES) {
      return { ok: false, message: "Please keep notes under 400 characters." };
    }
  }

  if (!Array.isArray(body.items) || body.items.length === 0) {
    return { ok: false, message: "Pick at least one item." };
  }
  if (body.items.length > ITEM_NAMES.length) return { ok: false, message: "Pick fewer items." };

  const items: string[] = [];
  for (const item of body.items) {
    if (typeof item !== "string" || !ITEM_SET.has(item)) {
      return { ok: false, message: "That item isn't on the list." };
    }
    if (items.includes(item)) return { ok: false, message: "Each item can only be selected once." };
    items.push(item);
  }

  return { ok: true, name, party, notes, items };
}

function normalizeParty(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 99) return value;
  if (typeof value === "string" && /^[1-9]\d?$/.test(value.trim())) return Number(value.trim());
  return null;
}

function claimKey(item: string, signupId: string): string {
  return REPEATABLE_ITEMS.has(item) ? `${item}#${signupId}` : item;
}

function exclusiveTaken(signups: Signup[]): Set<string> {
  const taken = new Set<string>();
  for (const signup of signups) {
    for (const item of signup.items) {
      if (!REPEATABLE_ITEMS.has(item)) taken.add(item);
    }
  }
  return taken;
}

function joinNames(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "That item";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

function isUniqueError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("UNIQUE constraint failed");
}

function isBusyError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /SQLITE_BUSY|database is locked/i.test(message);
}

async function runBusy<T>(work: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return await work();
    } catch (error) {
      lastError = error;
      if (isUniqueError(error) || !isBusyError(error) || attempt === 4) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
    }
  }
  throw lastError;
}

async function readJson(
  request: Request,
): Promise<{ ok: true; value: unknown } | { ok: false; message: string }> {
  const claimed = Number(request.headers.get("content-length") || "0");
  if (Number.isFinite(claimed) && claimed > MAX_BODY) {
    return { ok: false, message: "That signup is too large." };
  }
  const text = await request.text();
  if (text.length > MAX_BODY) return { ok: false, message: "That signup is too large." };
  if (!text.trim()) return { ok: false, message: "That signup could not be read." };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, message: "That signup could not be read." };
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex: string): Uint8Array | null {
  if (!/^[0-9a-f]{64}$/i.test(hex)) return null;
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

async function tokenMatches(token: string, storedHash: string): Promise<boolean> {
  if (token.length < 32 || token.length > 200) return false;
  const provided = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
  const stored = hexToBytes(storedHash);
  if (!stored || stored.length !== provided.length) return false;
  return crypto.subtle.timingSafeEqual(provided, stored);
}

async function codeMatches(provided: string, expected: string): Promise<boolean> {
  if (provided.length > 200) return false;
  const encoder = new TextEncoder();
  const [left, right] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(new Uint8Array(left), new Uint8Array(right));
}

function isAllowedOrigin(origin: string): boolean {
  if (origin === PAGES_ORIGIN) return true;
  return /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

function preflight(origin: string | null): Response {
  if (origin && !isAllowedOrigin(origin)) return new Response(null, { status: 403 });
  const headers = corsHeaders(origin);
  headers.set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type");
  headers.set("Access-Control-Max-Age", "86400");
  return new Response(null, { status: 204, headers });
}

function json(origin: string | null, body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: corsHeaders(origin) });
}

function corsHeaders(origin: string | null): Headers {
  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    Vary: "Origin",
    "X-Content-Type-Options": "nosniff",
  });
  if (origin && isAllowedOrigin(origin)) headers.set("Access-Control-Allow-Origin", origin);
  return headers;
}
