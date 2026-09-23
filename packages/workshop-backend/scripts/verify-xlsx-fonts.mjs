// xlsx のフォント名・サイズ・文字色を openpyxl 相当で確認する。
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { workbookToXlsx } from "../format-blueprints/workspace-sheets/files/xlsx.js";

const arial = (c) => ({ fn: "Arial", fs: 10, c });
const outDir = process.argv[2] || "/tmp/xlsx-font-verify";
mkdirSync(outDir, { recursive: true });

const document = {
  title: "見積書",
  sheetOrder: ["quote", "tax"],
  sheets: {
    quote: { name: "見積書", rows: 20, cols: 8, colWidths: {}, rowHeights: {} },
    tax: { name: "税率", rows: 10, cols: 4, colWidths: {}, rowHeights: {} },
  },
  cells: {
    quote: {
      A1: { value: "見積書", fmt: arial("#0000FF") },
      B11: { value: "商品A", fmt: arial("#0000FF") },
      E11: { value: "2000", fmt: arial("#0000FF") },
      E12: { value: "2500", fmt: arial("#0000FF") },
      E14: { value: "=E11+E12", fmt: arial("#000000") },
      E16: { value: "=tax!B2", fmt: arial("#008000") },
      E17: { value: "=E14+E16", fmt: arial("#000000") },
      Z1: { value: "no-fn", fmt: { fs: 18 } },
    },
    tax: {
      B2: { value: "450", fmt: arial("#0000FF") },
    },
  },
};

const bytes = new Uint8Array(await new Response(workbookToXlsx(document)).arrayBuffer());
const xlsxPath = `${outDir}/quote.xlsx`;
writeFileSync(xlsxPath, bytes);

const py = `
from openpyxl import load_workbook
wb = load_workbook(${JSON.stringify(xlsxPath)}, data_only=False)
print("sheet\\tcell\\tname\\tsize\\tcolor\\tvalue")
for ws in wb.worksheets:
    for row in ws.iter_rows():
        for cell in row:
            if cell.value is None and (cell.font is None or cell.font.name is None):
                continue
            if cell.value is None:
                continue
            color = None
            if cell.font and cell.font.color and cell.font.color.rgb:
                color = str(cell.font.color.rgb)
            print(f"{ws.title}\\t{cell.coordinate}\\t{cell.font.name}\\t{cell.font.size}\\t{color}\\t{cell.value}")
`;

const result = spawnSync("python3", ["-c", py], { encoding: "utf8" });
if (result.status !== 0) {
  const venv = "/tmp/xlsx-font-venv/bin/python";
  const retry = spawnSync(venv, ["-c", py], { encoding: "utf8" });
  if (retry.status !== 0) {
    process.stderr.write(result.stderr || retry.stderr || "openpyxl failed\n");
    process.exit(1);
  }
  process.stdout.write(retry.stdout);
} else {
  process.stdout.write(result.stdout);
}
