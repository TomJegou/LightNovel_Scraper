import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const src = fs.readFileSync(path.join(__dirname, "deString.js"), "utf8");

const match = src.match(/wasmBinaryFile\s*=\s*'(data:application\/octet-stream;base64,[^']+)'/);
if (!match) throw new Error("wasm data URI not found");
const b64 = match[1].replace("data:application/octet-stream;base64,", "");
const wasmBinary = Buffer.from(b64, "base64");

const sandbox = {
  console, process, setTimeout, clearTimeout, setInterval, clearInterval,
  require, Buffer, TextDecoder, TextEncoder, URL, URLSearchParams,
  WebAssembly, fetch,
  __dirname, __filename: path.join(__dirname, "deString.js"),
  globalThis: null,
  Module: { wasmBinary, noInitialRun: true, print: () => {}, printErr: () => {} },
};
sandbox.globalThis = sandbox;
sandbox.global = sandbox;

vm.createContext(sandbox);
vm.runInContext(src, sandbox, { filename: "deString.js" });
const Module = sandbox.Module;

async function waitReady() {
  const start = Date.now();
  while (!Module.isReady) {
    if (Date.now() - start > 10_000) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 50));
  }
}

function deString(s) {
  const p = sandbox.allocateUTF8(s);
  const o = Module._DeString(p);
  const out = sandbox.UTF8ToString(o);
  Module._FreeMemory?.(o);
  Module._free?.(p);
  return out;
}

async function main() {
  await waitReady();

  const configJs = fs.readFileSync("scripts/config.js.raw.txt", "utf8");

  const mPages = configJs.match(/"fliphtml5_pages":"([^"]+)"/);
  if (!mPages) throw new Error("fliphtml5_pages not found");
  const enc = mPages[1];
  console.log("encrypted pages length:", enc.length);

  const decoded = deString(enc);
  console.log("decoded length:", decoded.length);
  console.log("head:", decoded.slice(0, 400));
  console.log("tail:", decoded.slice(-200));

  fs.writeFileSync("scripts/pages-decoded.txt", decoded);

  // try to parse as JSON array
  const lastBracket = decoded.lastIndexOf("]");
  const jsonStr = decoded.slice(0, lastBracket + 1);
  try {
    const arr = JSON.parse(jsonStr);
    console.log("pages count:", arr.length);
    console.log("first:", JSON.stringify(arr[0]).slice(0, 300));
    console.log("last:", JSON.stringify(arr[arr.length - 1]).slice(0, 300));
    fs.writeFileSync("scripts/pages.json", JSON.stringify(arr, null, 2));
  } catch (e) {
    console.log("parse failed:", e.message);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
