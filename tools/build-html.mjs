// Inline the compiled wasm module (base64) into the HTML template, producing a
// single self-contained file that runs from file:// with no network access.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

const wasmPath = resolve(root, "build", "sluice.wasm");
const templatePath = resolve(root, "web", "template.html");
const outPath = resolve(root, "dist", "sluice-sort.html");

const wasm = readFileSync(wasmPath);
const template = readFileSync(templatePath, "utf8");
const b64 = wasm.toString("base64");

if (!template.includes("__WASM_BASE64__")) {
  throw new Error("template is missing the __WASM_BASE64__ placeholder");
}

const html = template.replace("__WASM_BASE64__", b64);
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, html);

// Guard against accidental external requests: a self-contained page has none.
const external = [...html.matchAll(/\b(?:src|href)\s*=\s*["'](?!data:|#)([^"']+)["']/gi)].map((m) => m[1]);
if (external.length) throw new Error(`single-file build references external assets: ${external.join(", ")}`);

console.log(`wasm    ${wasm.length} bytes  ->  base64 ${b64.length} chars`);
console.log(`html    ${html.length} bytes  (${(html.length / 1024).toFixed(1)} KiB)`);
console.log(`output  ${outPath}`);
