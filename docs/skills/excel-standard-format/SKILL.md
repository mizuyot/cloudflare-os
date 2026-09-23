---
name: excel-standard-format
description: 634 Excel standard format. Arial 10pt, no fill except highlight cells, blue typed values, black formulas, green cross-sheet refs.
---

# Excel標準書式（634）

表（Workspace Sheets）を作るときは、セル書式 `fmt` を必ず付ける。画面にフォント選択は無い。`applyOperation` の `cellOps[].fmt` で指定する。

## 既定

- フォント名 `fn`: `"Arial"`
- サイズ `fs`: `10`（`fn` があるとき、これは Excel のポイント。Arial 10pt になる）
- 背景 `bg`: 付けない。強調したいセルだけ色を付ける
- 文字色 `c`:
  - 手入力の数値・文言: `#0000FF`（青 0,0,255）
  - 数式（`=` で始まる）: `#000000`（黒 0,0,0）
  - 別シート参照（`Sheet!A1` など）: `#008000`（緑 0,128,0）

## 例

```json
{
  "cellOps": [
    { "sheetId": "quote", "ref": "B11", "value": "商品A", "fmt": { "fn": "Arial", "fs": 10, "c": "#0000FF" } },
    { "sheetId": "quote", "ref": "E11", "value": "2000", "fmt": { "fn": "Arial", "fs": 10, "c": "#0000FF" } },
    { "sheetId": "quote", "ref": "E14", "value": "=E11+E12", "fmt": { "fn": "Arial", "fs": 10, "c": "#000000" } },
    { "sheetId": "quote", "ref": "E16", "value": "=Tax!B2", "fmt": { "fn": "Arial", "fs": 10, "c": "#008000" } }
  ]
}
```

`fn` を付けないと、Excel 側は Calibri のままになる。
