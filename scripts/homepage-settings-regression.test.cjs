/* eslint-disable @typescript-eslint/no-require-imports -- Next's AsyncLocalStorage global must be initialized before loading its CommonJS server runtime. */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");
// Next's server bootstrap provides this global in production.
globalThis.AsyncLocalStorage ??= require("node:async_hooks").AsyncLocalStorage;
const { unstable_cache } = require("next/cache");
const { workAsyncStorage } = require("next/dist/server/app-render/work-async-storage.external");

const root = path.join(__dirname, "..");
const source = fs.readFileSync(path.join(root, "lib/db.ts"), "utf8");
const ast = ts.createSourceFile("db.ts", source, ts.ScriptTarget.Latest, true);
const names = new Set([
  "fetchHomepageSettingsFromDb", "rowToCamel", "snakeToCamel", "pickReviewsSectionString",
]);
const functions = ast.statements
  .filter((statement) => ts.isFunctionDeclaration(statement) && names.has(statement.name?.text))
  .map((statement) => statement.getText(ast)).join("\n");

function loader(sql) {
  const errors = [];
  const context = vm.createContext({
    sql, HOMEPAGE_DEFAULTS: { platformName: "DEMO_DEFAULT" },
    console: { error: (...args) => errors.push(args) },
  });
  vm.runInContext(ts.transpile(functions, { target: ts.ScriptTarget.ES2020 }), context);
  return { read: context.fetchHomepageSettingsFromDb, errors };
}

test("database errors reject and are logged instead of returning demo settings", async () => {
  const failure = new Error("Simulated database outage");
  const { read, errors } = loader(async () => { throw failure; });
  await assert.rejects(read(), (error) => error === failure);
  assert.equal(errors.length, 1);
});

test("missing settings reject instead of returning demo settings", async () => {
  const { read, errors } = loader(async () => []);
  await assert.rejects(read(), /settings row "default" is missing/);
  assert.equal(errors.length, 1);
});

test("actual Next cache keeps successful settings when a subsequent read fails", async (t) => {
  let fail = false;
  const { read } = loader(async () => {
    if (fail) throw new Error("Simulated database outage");
    return [{ platform_name: "Client platform", hero_title: "Client title" }];
  });
  let entry;
  let stale = false;
  let writes = 0;
  const previousCache = globalThis.__incrementalCache;
  globalThis.__incrementalCache = {
    generateCacheKey: async (key) => key,
    get: async () => entry ? { value: entry, isStale: stale } : null,
    set: async (_key, value) => { entry = value; writes++; },
  };
  try {
    const cached = unstable_cache(read, ["homepage-regression"], { revalidate: 60 });
    assert.equal((await cached()).platformName, "Client platform");
    assert.equal(writes, 1);
    fail = true;
    stale = true;
    await assert.rejects(cached(), /Simulated database outage/);
    assert.equal(writes, 1);
    assert.equal(JSON.parse(entry.data.body).platformName, "Client platform");
    const store = { incrementalCache: globalThis.__incrementalCache, route: "/" };
    // App Router requests serve the last good value while refreshing in the background.
    const cacheLog = t.mock.method(console, "error", () => {});
    assert.equal((await workAsyncStorage.run(store, cached)).platformName, "Client platform");
    await Promise.all(Object.values(store.pendingRevalidates));
    assert.equal(cacheLog.mock.callCount(), 1);
    assert.equal(writes, 1);
    assert.equal(JSON.parse(entry.data.body).platformName, "Client platform");
    stale = false;
    assert.equal((await cached()).platformName, "Client platform");
  } finally {
    globalThis.__incrementalCache = previousCache;
  }
});

test("settings API returns an uncached 503 without demo data on failure", async () => {
  const route = fs.readFileSync(path.join(root, "app/api/settings/homepage/route.ts"), "utf8");
  const context = vm.createContext({
    exports: {},
    require: (name) => name === "next/server"
      ? { NextResponse: { json: (body, options) => ({ body, ...options }) } }
      : { getHomepageSettings: async () => { throw new Error("Simulated outage"); } },
    console: { error() {} },
  });
  vm.runInContext(ts.transpile(route, { module: ts.ModuleKind.CommonJS }), context);
  const response = await context.exports.GET();
  assert.equal(response.status, 503);
  assert.equal(response.headers["Cache-Control"], "no-store");
  assert.equal(response.body.platformName, undefined);
});

test("cache key bypasses defaults cached by the previous implementation", () => {
  assert.match(source, /\["homepage-settings-v2"\]/);
});
