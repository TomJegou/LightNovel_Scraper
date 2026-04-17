import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";

// `createRequire` must be obtained via a dynamic import to avoid webpack's
// static analysis ("module.createRequire failed parsing argument" warning)
// which otherwise produces a non-functional `require` in the runtime bundle.
// Depending on how webpack rewrites the `node:module` import, the factory
// may live on the namespace root or on `.default` (ESM/CJS interop).
async function nodeCreateRequire(from: string): Promise<NodeRequire> {
  const mod = (await import("node:module")) as unknown as {
    createRequire?: (from: string) => NodeRequire;
    default?: { createRequire: (from: string) => NodeRequire };
  };
  const factory = mod.createRequire ?? mod.default?.createRequire;
  if (typeof factory !== "function") {
    throw new Error("node:module.createRequire is not available");
  }
  return factory(from);
}

type DeModule = {
  wasmBinary: Buffer;
  noInitialRun: boolean;
  print: (x: string) => void;
  printErr: (x: string) => void;
  isReady?: boolean;
  _DeString: (ptr: number) => number;
  _FreeMemory?: (ptr: number) => void;
  _free?: (ptr: number) => void;
};

type Sandbox = {
  Module: DeModule;
  allocateUTF8: (s: string) => number;
  UTF8ToString: (ptr: number) => string;
};

let cached: Promise<Sandbox> | null = null;

function loadDecoder(): Promise<Sandbox> {
  if (cached) return cached;
  cached = (async () => {
    const scriptPath = path.join(process.cwd(), "src", "lib", "fliphtml5", "deString.js");
    const src = fs.readFileSync(scriptPath, "utf8");

    const match = src.match(
      /wasmBinaryFile\s*=\s*'(data:application\/octet-stream;base64,[^']+)'/,
    );
    if (!match) throw new Error("WASM data URI not found in deString.js");
    const b64 = match[1].replace("data:application/octet-stream;base64,", "");
    const wasmBinary = Buffer.from(b64, "base64");

    const requireFn = await nodeCreateRequire(scriptPath);

    const sandbox: Record<string, unknown> = {
      console,
      process,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      require: requireFn,
      Buffer,
      TextDecoder,
      TextEncoder,
      URL,
      URLSearchParams,
      WebAssembly,
      fetch,
      __dirname: path.dirname(scriptPath),
      __filename: scriptPath,
      Module: {
        wasmBinary,
        noInitialRun: true,
        print: () => {},
        printErr: () => {},
      } satisfies Partial<DeModule>,
    };
    sandbox.globalThis = sandbox;
    sandbox.global = sandbox;

    vm.createContext(sandbox);
    vm.runInContext(src, sandbox, { filename: "deString.js" });

    const start = Date.now();
    const mod = sandbox.Module as DeModule;
    while (!mod.isReady) {
      if (Date.now() - start > 10_000) {
        throw new Error("Timed out waiting for WASM module to initialize");
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    return sandbox as unknown as Sandbox;
  })();
  return cached;
}

export async function deString(encrypted: string): Promise<string> {
  const sb = await loadDecoder();
  const { Module, allocateUTF8, UTF8ToString } = sb;
  const ptr = allocateUTF8(encrypted);
  const out = Module._DeString(ptr);
  const value = UTF8ToString(out);
  Module._FreeMemory?.(out);
  Module._free?.(ptr);
  return value;
}
