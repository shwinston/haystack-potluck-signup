/**
 * Checks the local Worker. Reads RESET_CODE from the environment or from
 * .dev.vars and never prints it.
 *
 *   node scripts/check-api.mjs
 *   API_BASE=http://127.0.0.1:8787 node scripts/check-api.mjs
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const repo = join(root, "..");
const API = (process.env.API_BASE || "http://127.0.0.1:8787").replace(/\/$/, "");
const resetCode = process.env.RESET_CODE || readDevCode();

const failures = [];

function readDevCode() {
  const text = readFileSync(join(root, ".dev.vars"), "utf8");
  const match = text.match(/^RESET_CODE\s*=\s*"?([^"\n]+)"?/m);
  if (!match) throw new Error("RESET_CODE is missing from .dev.vars");
  return match[1];
}

function assert(condition, message) {
  if (!condition) failures.push(message);
}

async function call(path, options = {}) {
  const response = await fetch(API + path, {
    method: options.method || "GET",
    headers: {
      Origin: "http://127.0.0.1:8080",
      ...(options.body ? { "Content-Type": "application/json" } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  return { response, data, text };
}

function itemNamesFromPage() {
  const html = readFileSync(join(repo, "index.html"), "utf8");
  const block = html.split("const ITEMS = [")[1].split("];")[0];
  return [...block.matchAll(/name:\s*"([^"]+)"/g)].map((match) => match[1]);
}

function optionalFromPage() {
  const html = readFileSync(join(repo, "index.html"), "utf8");
  const block = html.split("const ITEMS = [")[1].split("];")[0];
  return [...block.matchAll(/name:\s*"([^"]+)"([\s\S]*?)\}/g)]
    .filter((match) => /optional:\s*true/.test(match[2]))
    .map((match) => match[1]);
}

function itemNamesFromWorker() {
  const source = readFileSync(join(root, "src/index.ts"), "utf8");
  const block = source.split("const ITEM_NAMES = [")[1].split("] as const;")[0];
  return [...block.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

function staticChecks() {
  const page = readFileSync(join(repo, "index.html"), "utf8");
  const worker = readFileSync(join(root, "src/index.ts"), "utf8");
  const readme = readFileSync(join(repo, "README.md"), "utf8");
  assert(!page.includes("localStorage.setItem(STORAGE_KEY") && !page.includes("haystackSignups"), "page still stores signups in localStorage");
  assert(!page.includes("Seasoned Beans or Vegetarian Chili"), "old item normalizer is still in the page");
  assert(!page.includes("const RESET_CODE"), "reset code constant is still in the page");
  assert(!page.includes("const rates"), "per-person rates are still in the page");
  assert(page.includes("const API_BASE_URL"), "API_BASE_URL constant is missing");
  assert(page.includes("https://haystack-potluck-signup.weathered-feather-4569.workers.dev"), "page is not pointed at the deployed Worker");
  assert(page.includes("Shane Hilde"), "contact name is missing");
  assert(!page.includes("TODO"), "placeholder text is still on the page");
  assert(page.includes("Ceres SDA Church"), "place is missing");
  assert(page.includes("Sabbath, November 7, 2026"), "date is missing");
  assert(page.includes("50 oz (about 3 lb)"), "chips amount is missing");
  assert(page.includes("12.5 cups cooked (about 4 cups dry)"), "rice amount is missing");
  assert(page.includes("25 servings"), "dessert amount is missing");
  assert(page.includes('og:image'), "Open Graph image tag is missing");
  assert(!worker.includes('RESET_CODE = "') && !worker.includes("RESET_CODE='"), "worker source contains a reset code literal");
  assert(readme.includes("1f14a2d7-ef79-4a1f-8238-1e47e5eb674a"), "root README is missing the live database id");
  assert(readme.includes("https://haystack-potluck-signup.weathered-feather-4569.workers.dev"), "root README is missing the deployed Worker URL");
  assert(readme.includes("npx wrangler secret put RESET_CODE"), "root README is missing the secret command");
  assert(readme.includes("API_BASE_URL"), "root README does not say where to paste the Worker URL");
  const pageItems = itemNamesFromPage();
  const workerItems = itemNamesFromWorker();
  assert(JSON.stringify(pageItems) === JSON.stringify(workerItems), "page items and worker items differ");
  const optional = optionalFromPage();
  assert(optional.length === 1 && optional[0] === "Cooked Rice", "only Cooked Rice should be optional");
  assert(worker.includes('new Set<string>(["Cooked Rice"])'), "worker repeatable set is not Cooked Rice");
}

async function reset() {
  const { response, data } = await call("/api/reset", { method: "POST", body: { resetCode } });
  assert(response.status === 200 && data && data.signups.length === 0, "reset did not clear the list");
}

async function main() {
  staticChecks();
  await reset();

  const bad = await call("/api/signups", { method: "POST", body: { name: "   ", party: 2, items: ["Salsa"] } });
  assert(bad.response.status === 400, "whitespace name was accepted");

  const empty = await call("/api/signups", { method: "POST", body: { name: "Ana", party: 0, items: ["Salsa"] } });
  assert(empty.response.status === 400, "party size 0 was accepted");

  const unknown = await call("/api/signups", {
    method: "POST",
    body: { name: "Ana", party: 2, items: ["Not a dish"] },
  });
  assert(unknown.response.status === 400, "unknown item was accepted");

  const trimmed = await call("/api/signups", {
    method: "POST",
    body: { name: "  Ana  ", party: "4", items: ["Diced Onions"], notes: "  mild  " },
  });
  assert(trimmed.response.status === 201, "trimmed signup failed: " + (trimmed.data && trimmed.data.message));
  assert(trimmed.data.signup.name === "Ana", "name was not trimmed");
  assert(trimmed.data.signup.party === 4, "numeric string party was not accepted");
  assert(trimmed.data.signup.notes === "mild", "notes were not trimmed");
  assert(typeof trimmed.data.cancelToken === "string" && trimmed.data.cancelToken.length >= 32, "cancel token missing");
  const anaToken = trimmed.data.cancelToken;
  const anaId = trimmed.data.signup.id;

  const listed = await call("/api/signups");
  assert(listed.response.status === 200, "list failed");
  assert(!listed.text.includes(anaToken), "list response included a cancel token");
  assert(!listed.text.includes("cancel_token"), "list response included a token field");
  assert(!listed.text.includes(resetCode), "list response included the reset code");
  assert(listed.response.headers.get("access-control-allow-origin") === "http://127.0.0.1:8080", "CORS origin missing");

  const blocked = await fetch(API + "/api/signups", { headers: { Origin: "https://evil.example" } });
  assert(blocked.status === 403, "foreign origin was allowed");
  assert(!blocked.headers.get("access-control-allow-origin"), "foreign origin received CORS header");

  const pages = await fetch(API + "/api/signups", { headers: { Origin: "https://shwinston.github.io" } });
  assert(pages.status === 200, "GitHub Pages origin was blocked");
  assert(pages.headers.get("access-control-allow-origin") === "https://shwinston.github.io", "Pages CORS header missing");

  const item = "Salsa";
  const raced = await Promise.all(
    Array.from({ length: 8 }, (_, index) =>
      call("/api/signups", {
        method: "POST",
        body: { name: "Racer " + index, party: 2, items: [item, "Guacamole"] },
      }),
    ),
  );
  const won = raced.filter((entry) => entry.response.status === 201);
  const lost = raced.filter((entry) => entry.response.status === 409);
  assert(won.length === 1, "concurrent claim winners: " + won.length);
  assert(lost.length === 7, "concurrent claim losers: " + lost.length);
  assert(
    lost.every((entry) => entry.data && entry.data.error === "just_taken" && /just taken/i.test(entry.data.message)),
    "loser did not get a just-taken message",
  );
  const afterRace = await call("/api/signups");
  const holders = afterRace.data.signups.filter((signup) => signup.items.includes("Guacamole") || signup.items.includes("Salsa"));
  assert(holders.length === 1, "a losing signup still saved an item");
  assert(afterRace.data.signups.every((signup) => signup.items.length > 0), "a signup was saved with no items");
  assert(holders[0].items.includes("Salsa") && holders[0].items.includes("Guacamole"), "winner did not keep both items");

  const riceA = await call("/api/signups", { method: "POST", body: { name: "Rice A", party: 3, items: ["Cooked Rice"] } });
  const riceB = await call("/api/signups", { method: "POST", body: { name: "Rice B", party: 5, items: ["Cooked Rice"] } });
  assert(riceA.response.status === 201 && riceB.response.status === 201, "rice could not be claimed twice");

  const first = await call("/api/signups", {
    method: "POST",
    body: { name: "Jane Doe", party: 4, items: ["Ranch Dressing"], notes: "family" },
  });
  const second = await call("/api/signups", {
    method: "POST",
    body: { name: "Jane Doe", party: 9, items: ["Sour Cream"] },
  });
  assert(first.response.status === 201 && second.response.status === 201, "same-name signup failed");
  const both = await call("/api/signups");
  const janes = both.data.signups.filter((signup) => signup.name === "Jane Doe");
  assert(janes.length === 2, "same name did not create two signups");
  const ranch = janes.find((signup) => signup.items.includes("Ranch Dressing"));
  const cream = janes.find((signup) => signup.items.includes("Sour Cream"));
  assert(ranch && ranch.party === 4, "earlier party size was overwritten");
  assert(cream && cream.party === 9, "later party size was not stored");
  const expectedHead = both.data.signups.reduce((sum, signup) => sum + signup.party, 0);
  assert(both.data.headcount === expectedHead, "headcount does not match party sizes");

  const wrongCancel = await call("/api/signups/" + anaId, { method: "DELETE", body: { cancelToken: "not-a-real-token" } });
  assert(wrongCancel.response.status === 401, "bad cancel token was accepted");
  const otherToken = first.data.cancelToken;
  const stolen = await call("/api/signups/" + anaId, { method: "DELETE", body: { cancelToken: otherToken } });
  assert(stolen.response.status === 401, "another signup's token cancelled this one");
  const cancelled = await call("/api/signups/" + anaId, { method: "DELETE", body: { cancelToken: anaToken } });
  assert(cancelled.response.status === 200, "owner cancel failed");
  assert(!cancelled.data.signups.some((signup) => signup.id === anaId), "cancelled signup is still listed");
  assert(cancelled.data.signups.some((signup) => signup.items.includes("Ranch Dressing")), "cancel removed a different signup");

  const wrongRemove = await call("/api/signups/" + cream.id, { method: "DELETE", body: { resetCode: "not-the-code" } });
  assert(wrongRemove.response.status === 401, "wrong reset code removed a signup");
  const removed = await call("/api/signups/" + cream.id, { method: "DELETE", body: { resetCode } });
  assert(removed.response.status === 200, "admin remove failed: " + (removed.data && removed.data.message));
  assert(!removed.data.signups.some((signup) => signup.id === cream.id), "admin-removed signup remains");
  assert(removed.data.signups.some((signup) => signup.id === ranch.id && signup.party === 4), "admin remove changed another party size");

  const wrongReset = await call("/api/reset", { method: "POST", body: { resetCode: "not-the-code" } });
  assert(wrongReset.response.status === 401, "wrong reset code cleared the list");
  const stillThere = await call("/api/signups");
  assert(stillThere.data.signups.length > 0, "list was cleared by a bad code");

  await reset();
  const emptyList = await call("/api/signups");
  assert(emptyList.data.headcount === 0 && emptyList.data.signups.length === 0, "reset left rows behind");

  let limited = 0;
  let saved = 0;
  for (let i = 0; i < 90; i += 1) {
    const result = await call("/api/signups", {
      method: "POST",
      body: { name: "Limit " + i, party: 1, items: ["Cooked Rice"] },
    });
    if (result.response.status === 429) limited += 1;
    else if (result.response.status === 201) saved += 1;
    else failures.push("unexpected status during rate limit: " + result.response.status);
    if (limited > 0) break;
  }
  assert(limited === 1, "rate limit did not trip");
  assert(saved > 0 && saved <= 80, "rate limit saved an unexpected number: " + saved);
  const stillReading = await call("/api/signups");
  assert(stillReading.response.status === 200, "GET was rate limited");

  await reset();

  if (failures.length) {
    console.error(failures.map((failure) => "FAIL " + failure).join("\n"));
    process.exit(1);
  }
  console.log("All API checks passed.");
}

main().catch((error) => {
  console.error(error && error.message ? error.message : error);
  process.exit(1);
});
