// Reads the Access service token from the macOS Keychain (never prints the secret)
// and checks that cursor-probe can enter production, create a sheet, fill a quote,
// and export xlsx/PDF. A request without the token must not enter.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const WebSocket = require(join(
  dirname(fileURLToPath(import.meta.url)),
  "../node_modules/.pnpm/ws@8.21.3/node_modules/ws/index.js",
));
const { newWebSocketRpcSession, RpcTarget } = await import(
  join(dirname(fileURLToPath(import.meta.url)), "../packages/workshop-backend/node_modules/capnweb/dist/index.js")
);

class WorkpieceCollector extends RpcTarget {
  entries = [];
  #resolve;
  readyPromise = new Promise((resolve) => { this.#resolve = resolve; });
  entry(summary) { this.entries.push(summary); }
  removed() {}
  ready() { this.#resolve(); }
}

const SERVICE = "musapo-os-cursor-probe";
const ORIGIN = "https://musapo-os.musapo-os.workers.dev";
const NEEDLES = ["2000", "4500", "450", "4950"];

function die(msg) {
  process.stderr.write(msg + "\n");
  process.exit(1);
}

function keychainAccount() {
  const listed = spawnSync("security", ["find-generic-password", "-s", SERVICE], { encoding: "utf8" });
  if (listed.status !== 0) die("keychain item missing");
  const match = listed.stdout.match(/"acct"<blob>="([^"]+)"/);
  if (!match) die("keychain account missing");
  return match[1];
}

function keychainSecret(account) {
  const got = spawnSync("security", [
    "find-generic-password",
    "-s", SERVICE,
    "-a", account,
    "-w",
  ], { encoding: "utf8" });
  if (got.status !== 0 || !got.stdout) die("keychain secret missing");
  return got.stdout.replace(/\n$/, "");
}

function accessHeaders(account, secret) {
  return {
    "CF-Access-Client-Id": account,
    "CF-Access-Client-Secret": secret,
    Origin: ORIGIN,
  };
}

async function checkHttpGate(account, secret) {
  const noToken = await fetch(ORIGIN + "/", { redirect: "manual" });
  const noLoc = noToken.headers.get("location") || "";
  const noTokenBlocked = noToken.status === 302 && /cloudflareaccess\.com/.test(noLoc);
  if (!noTokenBlocked) {
    die(`no-token expected Access login redirect, got ${noToken.status} ${noLoc.slice(0, 80)}`);
  }

  const withToken = await fetch(ORIGIN + "/", {
    redirect: "manual",
    headers: accessHeaders(account, secret),
  });
  if (withToken.status !== 200) {
    const loc = withToken.headers.get("location") || "";
    let host = "";
    try { host = new URL(loc, ORIGIN).host; } catch { host = "unparseable"; }
    die(`token GET expected 200, got ${withToken.status} host=${host} secretMeta=${JSON.stringify({
      len: secret.length,
      hasCfPrefix: secret.includes("CF-Access"),
      hasWhitespace: /\s/.test(secret),
      charsetOk: /^[A-Za-z0-9._~+/-]+=*$/.test(secret),
    })}`);
  }
  return { noTokenStatus: noToken.status, tokenStatus: withToken.status };
}

function openSession(account, secret) {
  const ws = new WebSocket(ORIGIN.replace("https://", "wss://") + "/api", {
    headers: accessHeaders(account, secret),
  });
  return newWebSocketRpcSession(ws);
}

async function streamToFile(stream, path) {
  const buf = Buffer.from(await new Response(stream).arrayBuffer());
  writeFileSync(path, buf);
  return buf.length;
}

function pdfHasNeedles(pdfPath) {
  const py = `
from pypdf import PdfReader
text = ""
for page in PdfReader(${JSON.stringify(pdfPath)}).pages:
    text += page.extract_text() or ""
print(text)
`;
  const tries = [
    "/tmp/pdf-verify/venv/bin/python",
    "python3",
  ];
  let out = "";
  for (const bin of tries) {
    const r = spawnSync(bin, ["-c", py], { encoding: "utf8" });
    if (r.status === 0) {
      out = r.stdout;
      break;
    }
  }
  if (!out) die("pdf text extract failed");
  const missing = NEEDLES.filter((n) => !out.includes(n));
  return { textLen: out.length, missing, sample: out.replace(/\s+/g, " ").slice(0, 200) };
}

async function main() {
  const account = keychainAccount();
  if (!account.endsWith(".access")) die("unexpected keychain account shape");
  const secret = keychainSecret(account);
  if (secret.length < 8) die("secret too short");
  const secretMeta = {
    len: secret.length,
    hasCfPrefix: secret.includes("CF-Access"),
    hasWhitespace: /\s/.test(secret),
    charsetOk: /^[A-Za-z0-9._~+/-]+=*$/.test(secret),
  };
  if (secretMeta.hasCfPrefix) {
    die(`keychain secret looks labeled, not raw (${JSON.stringify(secretMeta)})`);
  }

  const http = await checkHttpGate(account, secret);

  using api = openSession(account, secret);
  const authed = api.authenticateFromCfAccess();
  const me = await authed.whoami();
  if (me.id !== "cursor-probe") {
    die(`whoami expected cursor-probe, got ${me.id}`);
  }

  const listed = await authed.listGadgets();
  const overseer = await authed.newGadgetFromBlueprint("format.spreadsheet", {});
  await overseer.setTitle("cursor-probe quote");
  const meta = await overseer.getMetadata();
  let gadgetId = meta.defaultGadgetId;
  if (gadgetId == null) {
    const collector = new WorkpieceCollector();
    using sub = await overseer.subscribeToWorkpieces(collector);
    await Promise.race([
      collector.readyPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error("workpieces timeout")), 8000)),
    ]);
    const gadgets = collector.entries.filter((e) => e.type === "gadget");
    gadgetId = gadgets[0]?.id;
  }
  if (gadgetId == null) {
    die(`no gadget id metaKeys=${Object.keys(meta).join(",")} workspace=${meta.id}`);
  }
  const gadget = overseer.getGadget(gadgetId);
  const inner = await gadget.connectToGadget();
  const doc = await inner.getDocument();
  const s1 = doc.sheetOrder[0];
  const s2 = "s_tax";
  await inner.applyOperation({
    senderId: "cursor-probe",
    structure: {
      title: "cursor-probe quote",
      sheetOrder: [s1, s2],
      sheets: {
        [s1]: { ...(doc.sheets[s1] || {}), name: "quote" },
        [s2]: { name: "tax", rows: 10, cols: 4 },
      },
    },
    cellOps: [
      { sheetId: s1, ref: "E11", value: "2000", fmt: {}, baseVersion: 0 },
      { sheetId: s1, ref: "E12", value: "2500", fmt: {}, baseVersion: 0 },
      { sheetId: s1, ref: "E14", value: "=E11+E12", fmt: {}, baseVersion: 0 },
      { sheetId: s2, ref: "B2", value: "450", fmt: {}, baseVersion: 0 },
      { sheetId: s1, ref: "E16", value: "=tax!B2", fmt: {}, baseVersion: 0 },
      { sheetId: s1, ref: "E17", value: "=E14+E16", fmt: {}, baseVersion: 0 },
    ],
  });

  const formats = await gadget.getExportFormats();
  const formatIds = formats.map((f) => f.id);
  if (!formatIds.includes("xlsx") || !formatIds.includes("pdf")) {
    die(`missing export formats: ${formatIds.join(",")}`);
  }

  const outDir = "/tmp/access-probe-verify";
  mkdirSync(outDir, { recursive: true });
  const xlsxBytes = await streamToFile(await gadget.export("xlsx"), join(outDir, "quote.xlsx"));
  await new Promise((r) => setTimeout(r, 2000));
  const pdfBytes = await streamToFile(await gadget.export("pdf"), join(outDir, "quote.pdf"));
  const pdf = pdfHasNeedles(join(outDir, "quote.pdf"));
  if (pdf.missing.length) {
    die(`pdf missing needles ${pdf.missing.join(",")} textLen=${pdf.textLen} sample=${pdf.sample}`);
  }

  process.stdout.write(JSON.stringify({
    ok: true,
    clientIdSuffix: account.slice(-10),
    http,
    whoami: { id: me.id, type: me.type, name: me.name },
    listedBefore: listed.length,
    workspaceId: meta.id,
    gadgetId,
    formats: formatIds,
    xlsxBytes,
    pdfBytes,
    pdfTextLen: pdf.textLen,
    needles: NEEDLES,
  }, null, 2) + "\n");
}

await main();
