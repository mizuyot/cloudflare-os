// Prints the three bundled format clients with sample data and checks the PDFs contain text.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, "..");
const outDir = "/tmp/musapo-pdf-export-wait";
const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const pypdf = "/tmp/xlsx-venv/bin/python";

function clientFromUnpacked(name) {
  return readFileSync(join(pkgRoot, "format-blueprints", name, "files", "client.js"), "utf8");
}

const payloads = {
  sheets: {
    revision: 1,
    title: "見積書",
    sheetOrder: ["quote"],
    sheets: { quote: { name: "見積書", rows: 20, cols: 8, colWidths: {}, rowHeights: {} } },
    cells: {
      quote: {
        A1: { value: "見積書" },
        B11: { value: "商品A" },
        E11: { value: "2000" },
        E12: { value: "2500" },
        E14: { value: "4500" },
        E16: { value: "450" },
        E17: { value: "4950" },
      },
    },
  },
  docs: {
    revision: 1,
    title: "Probe Doc",
    blocks: [{ id: "b1", html: "<p>PDFPROBE-DOCS 本文 4950</p>", version: 1 }],
  },
  slides: {
    slides: [{
      id: "s1",
      background: { inset: true },
      blocks: [
        { id: "t1", type: "title", x: 48, y: 200, w: 1000,
          props: { text: "Compose your deck from primitives.", fontSize: 40 } },
      ],
    }],
  },
};

function prelude(kind) {
  return `
class RpcTarget {}
const __payload = ${JSON.stringify(payloads[kind])};
const gadget = new Proxy({}, {
  get(_t, prop) {
    if (prop === "subscribe") return async () => __payload;
    if (prop === "getDeck") return async () => __payload;
    if (prop === "getUndoState") return async () => ({ canUndo: false, canRedo: false });
    return async () => {};
  }
});
`;
}

function extractText(pdfPath) {
  const py = `
from pypdf import PdfReader
import sys
reader = PdfReader(sys.argv[1])
print("\\n".join((page.extract_text() or "") for page in reader.pages))
`;
  const result = spawnSync(pypdf, ["-c", py, pdfPath], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || "pypdf failed");
  }
  return result.stdout;
}

async function main() {
  if (!existsSync(chrome)) throw new Error("Google Chrome is required for format PDF checks");
  if (!existsSync(pypdf)) throw new Error("pypdf venv missing at /tmp/xlsx-venv");
  const require = createRequire(import.meta.url);
  const puppeteer = require(join(pkgRoot, "node_modules/puppeteer-core"));
  mkdirSync(outDir, { recursive: true });

  const cases = [
    { kind: "sheets", gadget: "workspace-sheets", needles: ["見積書", "商品A", "2000", "4500", "450", "4950"] },
    { kind: "docs", gadget: "workspace-docs", needles: ["PDFPROBE-DOCS", "本文"] },
    { kind: "slides", gadget: "workspace-slides", needles: ["Compose", "primitives"] },
  ];

  const browser = await puppeteer.launch({
    executablePath: chrome,
    headless: "new",
    args: ["--no-sandbox", "--disable-gpu"],
  });
  try {
    for (const { kind, gadget, needles } of cases) {
      const page = await browser.newPage();
      const html = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>
<script type="module">
globalThis.gadgetExportFormatId = "pdf";
${prelude(kind)}
${clientFromUnpacked(gadget)}
</script></body></html>`;
      await page.setContent(html, { waitUntil: "load" });
      await page.waitForFunction(
        () => document.documentElement.dataset.exportReady === "1",
        { timeout: 8000 },
      );
      await page.emulateMediaType("print");
      const pdfPath = join(outDir, `${kind}.pdf`);
      await page.pdf({ path: pdfPath, preferCSSPageSize: true, printBackground: true });
      await page.close();
      const text = extractText(pdfPath);
      const haystack = text.normalize("NFKC").replace(/\s+/g, "");
      const missing = needles.filter(needle => !haystack.includes(needle.normalize("NFKC").replace(/\s+/g, "")));
      if (missing.length) {
        throw new Error(`${kind} PDF missing ${missing.join(", ")} (got ${JSON.stringify(text.slice(0, 200))})`);
      }
      console.log(`ok ${kind}`, pdfPath, "chars", text.length);
    }
  } finally {
    await browser.close();
  }
}

await main();
