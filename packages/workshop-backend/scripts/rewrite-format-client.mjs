// Rewrites client.js inside a bundled .gadget archive. Used by the PDF export-ready fix.
import { readFileSync, writeFileSync } from "node:fs";
import { gzipSync, gunzipSync } from "node:zlib";
import * as Y from "yjs";

const MAGIC = 0xec2e2d3a2300e317n;
const PREFIX = 24;

const [gadgetPath, clientPath] = process.argv.slice(2);
if (!gadgetPath || !clientPath) {
  console.error("usage: rewrite-format-client.mjs <archive.gadget> <client.js>");
  process.exit(1);
}

const bytes = readFileSync(gadgetPath);
const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
if (view.getBigUint64(0) !== MAGIC) throw new Error("not a gadget");
const metaLen = view.getUint32(12);
const metadata = bytes.subarray(PREFIX, PREFIX + metaLen);
const oldDoc = new Y.Doc();
Y.applyUpdateV2(oldDoc, gunzipSync(bytes.subarray(PREFIX + metaLen)));
const oldRoot = oldDoc.getMap();

const next = new Y.Doc();
next.clientID = 1;
const root = next.getMap();
for (const [filename, value] of [...oldRoot].sort(([a], [b]) => a.localeCompare(b))) {
  const text = new Y.Text();
  root.set(filename, text);
  text.insert(0, filename === "client.js" ? readFileSync(clientPath, "utf8") : value.toString());
}

const nextUpdate = gzipSync(Y.encodeStateAsUpdateV2(next), { level: 9 });
const out = new Uint8Array(PREFIX + metadata.byteLength + nextUpdate.byteLength);
const outView = new DataView(out.buffer);
outView.setBigUint64(0, MAGIC);
outView.setUint32(8, 1);
outView.setUint32(12, metadata.byteLength);
outView.setBigUint64(16, BigInt(nextUpdate.byteLength));
out.set(metadata, PREFIX);
out.set(nextUpdate, PREFIX + metadata.byteLength);
writeFileSync(gadgetPath, out);
console.log("updated", gadgetPath, "->", out.byteLength, "bytes");
