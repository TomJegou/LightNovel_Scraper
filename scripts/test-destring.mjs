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
console.log("wasm binary size:", wasmBinary.length);

const sandbox = {
  console,
  process,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  require,
  Buffer,
  TextDecoder,
  TextEncoder,
  URL,
  URLSearchParams,
  WebAssembly,
  fetch,
  __dirname,
  __filename: path.join(__dirname, "deString.js"),
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

async function main() {
  await waitReady();
  console.log("Module ready.");

  const configJs = await fetch(
    "https://online.fliphtml5.com/eogmc/laiw/javascript/config.js?1776439284"
  ).then((r) => r.text());

  const m = configJs.match(/"bookConfig":"([^"]+)"/);
  if (!m) throw new Error("bookConfig not found");
  const encrypted = m[1];
  console.log("encrypted length:", encrypted.length);

  const bookPtr = sandbox.allocateUTF8(encrypted);
  const keyIndex = Module._DeConfig_Parse(bookPtr);
  console.log("key_index:", keyIndex);

  function getConfig(name) {
    const keyPtr = sandbox.allocateUTF8(name);
    const valPtr = Module._DeConfig_Get(keyIndex, keyPtr);
    const val = sandbox.UTF8ToString(valPtr);
    Module._free?.(keyPtr);
    return val;
  }

  console.log("totalPageCount:", getConfig("totalPageCount"));
  
  // Capture print output
  let printed = "";
  sandbox.out = (x) => { printed += x + "\n"; };
  Module.print = sandbox.out;
  try {
    Module._DeConfig_Print(keyIndex);
  } catch(e) { console.log("print err:", e); }
  fs.writeFileSync("scripts/config-print.txt", printed);
  console.log("printed length:", printed.length);
  console.log("printed head:", printed.slice(0, 2000));

  const ptrIn = sandbox.allocateUTF8(encrypted);
  const ptrOut = Module._DeString(ptrIn);
  const decoded = sandbox.UTF8ToString(ptrOut);
  Module._FreeMemory?.(ptrOut);
  Module._free?.(ptrIn);

  fs.writeFileSync("scripts/decoded.json", decoded);
  const idx = decoded.lastIndexOf("}");
  const jsonStr = decoded.slice(0, idx + 1);
  const json = JSON.parse(jsonStr);
  console.log("all keys:", Object.keys(json));
  console.log("totalPageCount:", json.totalPageCount);
  console.log("largePath:", json.largePath);
  console.log("largeSuffix:", json.largeSuffix);
  console.log("normalSuffix:", json.normalSuffix);
  console.log("fliphtml5_pages type:", typeof json.fliphtml5_pages, Array.isArray(json.fliphtml5_pages) ? json.fliphtml5_pages.length : (json.fliphtml5_pages||"").toString().slice(0,80));
  
  // Try to decode fliphtml5_pages if it's a string
  if (typeof json.fliphtml5_pages === "string") {
    const p2 = sandbox.allocateUTF8(json.fliphtml5_pages);
    const o2 = Module._DeString(p2);
    const dec2 = sandbox.UTF8ToString(o2);
    Module._FreeMemory?.(o2);
    Module._free?.(p2);
    const idx2 = dec2.lastIndexOf("]");
    const jstr = dec2.slice(0, idx2 + 1);
    const pages = JSON.parse(jstr);
    console.log("pages count:", pages.length);
    console.log("first page:", pages[0]);
    console.log("last page:", pages[pages.length - 1]);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
