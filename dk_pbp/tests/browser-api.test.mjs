import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const engine = readFileSync(new URL("../browser-api.js", import.meta.url), "utf8");
const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");

assert.ok(html.indexOf("/browser-api.js") < html.indexOf("/app.js"), "browser API must load before the existing UI");
assert.match(engine, /gp-football-nfl-/, "Fastcast topic subscription is present");
assert.match(engine, /coreLoop/, "half-second Core fallback is present");
assert.match(engine, /reconcileLoop/, "summary\/CDN reconciliation is present");
assert.match(engine, /VirtualEventSource/, "the existing live-update contract is preserved");
assert.match(app, /NFLLiveEngine\.csvText/, "session CSV export uses browser data");
assert.doesNotMatch(html, /Python through Windows Firewall/, "cloud UI must not show local-install instructions");

console.log("Vercel static structure: PASS");
