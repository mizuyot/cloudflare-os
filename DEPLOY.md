# musapo-os のデプロイ

本番 URL: https://musapo-os.musapo-os.workers.dev  
Wrangler の認証プロファイル: `musapo`  
設定ファイル `packages/*/wrangler.prod.jsonc` はこの Mac にあり、git には入れない。

パッケージ管理は **pnpm**。npm は使わない。

---

## 1. 正本ブランチ

| 名前 | 役割 |
|---|---|
| `feat/xlsx-font` | **本番 musapo-os の正本。** 新しい作業はここから切る |
| `feat/pdf-export-inline` | 一つ前の正本（PDF インライン取り込みまで）。比較用 |
| `add-latest-llm-models` | 取り込み前の基準点。比較用に残してある。ここから作業を始めない |
| `main` | 本番と歴史が分かれている（衝突 35 件）。**統合しない。ここから作業を始めない** |
| `backup/main-old-20260923` | 古い `main` の退避。触らない |

- push 先は **mine だけ**（`https://github.com/mizuyot/cloudflare-os.git`）
- **origin（cloudflare/cloudflare-os）には push しない**

```bash
git checkout feat/xlsx-font
git pull mine feat/xlsx-font
git checkout -b feat/your-work
# 作業後
git push -u mine HEAD
```

---

## 2. デプロイ手順

リポジトリのルートで行う。**裏側 → 玄関** の順。玄関を先に載せない。

### 2.1 フロントを Access モードでビルド

パスワード欄を出さず、Cloudflare Access で入る画面にする。

```bash
cd packages/workshop-frontend
VITE_CF_ACCESS_MODE=true pnpm build
```

同じこと（玄関パッケージ経由）:

```bash
pnpm --filter @gadgets/router build:frontend:access
```

成果物は `packages/workshop-frontend/dist`。玄関の本番設定はこのディレクトリを画面として載せる。

### 2.2 dry-run（バインドと変数。ここを飛ばさない）

`CF_ACCESS_AUD` / `CF_ACCESS_ISS` と `keep_vars: true` が消えると、**全員ログインできなくなる**。

裏側:

```bash
cd packages/workshop-backend
npx wrangler deploy --config wrangler.prod.jsonc --profile musapo --dry-run --outdir /tmp/wrangler-dry-backend
```

確認する値（dry-run の出力、または手元の `wrangler.prod.jsonc`）:

- Worker 名: `musapo-os-backend`
- `keep_vars`: `true`
- `CF_ACCESS_AUD`: `b75c5a68ef955594b1f5ea2117d0b7c9226cd6bc4ba48e5d00c0195fa18dd3a3`
- `CF_ACCESS_ISS`: `https://musapo-os.cloudflareaccess.com`
- バインド: `GATEKEEPER_CONTEXT` / `DISCORD` / `GOOGLE` / `SCHEDULER`、`BROWSER`、`BLUEPRINTS`、`BLUEPRINT_CONTENT`

玄関（フロントの Access ビルドが終わってから）:

```bash
cd packages/router
npx wrangler deploy --config wrangler.prod.jsonc --profile musapo --dry-run --outdir /tmp/wrangler-dry-router
```

確認する値:

- Worker 名: `musapo-os`
- `keep_vars`: `true`
- バインド: `WORKSHOP_BACKEND` → `musapo-os-backend`、上記ゲートキーパー、画面 `ASSETS` → `../workshop-frontend/dist`

dry-run で値が欠けていたら、本番へは載せない。

### 2.3 本番に載せる

```bash
# 1) 裏側
cd packages/workshop-backend
npx wrangler deploy --config wrangler.prod.jsonc --profile musapo --message "短い説明"

# 2) 玄関
cd packages/router
npx wrangler deploy --config wrangler.prod.jsonc --profile musapo --message "短い説明"
```

### 2.4 直後に版番号を控える

最新が今の本番。その一つ上が、戻すときの候補。

```bash
# 裏側
npx wrangler deployments list --name musapo-os-backend --config packages/workshop-backend/wrangler.prod.jsonc --profile musapo

# 玄関
npx wrangler deployments list --name musapo-os --config packages/router/wrangler.prod.jsonc --profile musapo
```

---

## 3. ロールバック

重大な不具合（ログインできない、書き出しが全部壊れた、など）のとき。  
`--yes` は確認を省略する。初回は付けずに対話で確認してよい。

### 裏側（`musapo-os-backend`）

```bash
cd packages/workshop-backend
npx wrangler rollback 前の版ID \
  --name musapo-os-backend \
  --config wrangler.prod.jsonc \
  --profile musapo \
  --message "理由"
```

### 玄関（`musapo-os`）

```bash
cd packages/router
npx wrangler rollback 前の版ID \
  --name musapo-os \
  --config wrangler.prod.jsonc \
  --profile musapo \
  --message "理由"
```

### 2026-09-23 時点の本番版

`wrangler deployments list` で確認した値。載せ替えたら、この表を更新すること。

| | 今の本番 | 一つ前（戻す先） |
|---|---|---|
| 裏側 `musapo-os-backend` | `2cf74859-4f40-4c72-abca-a4767a3bf767`（PDF snapshot declaration + output.id fallback） | `42cddee1-8c31-4476-a01b-10f3d9d7a0d7`（xlsx named fonts） |
| 玄関 `musapo-os` | `5ce10d72-5a7a-4cd8-b911-1b9f9484c196`（Access-mode frontend + PDF snapshot fallback） | `263a3cdc-cae7-463b-8fbf-9553542dbc0c`（Access-mode frontend + xlsx named fonts） |

2026-09-23 夜に宣言だけの版（裏側 `999a81e8` / 玄関 `888d80a2`）を載せたときは、すでに作ってある表の PDF が「snapshot is missing」で落ちたので `42cddee1` / `263a3cdc` に戻した。そのあと **宣言＋従来の `output.id` フォールバック** を載せて、既存の表も新しい表も PDF が出ることを確認した。

一つ前へ戻す例:

```bash
cd packages/workshop-backend
npx wrangler rollback 42cddee1-8c31-4476-a01b-10f3d9d7a0d7 \
  --name musapo-os-backend --config wrangler.prod.jsonc --profile musapo \
  --message "Rollback backend to xlsx named fonts"

cd packages/router
npx wrangler rollback 263a3cdc-cae7-463b-8fbf-9553542dbc0c \
  --name musapo-os --config wrangler.prod.jsonc --profile musapo \
  --message "Rollback router to xlsx named fonts"
```

---

## 4. 既知の制限

- **xlsx のフォント名は `fmt.fn` で指定できる。** 未指定は Calibri 13.5pt（画面のピクセル換算）。`fn` があるとき `fs` はポイントなので、Arial 10 は 10.0pt になる。色分け（青＝入力 / 黒＝数式 / 緑＝シート間参照）も反映される。
- **新しい表・文書・スライドは書き出し形式に `pdfSnapshot` を宣言する**（表・文書は `"document"`、スライドは `"deck"`）。宣言があればそれに従う。宣言が無い既存の表などは、従来どおり `output.id` で中身を取り込む。宣言が無いものは「準備完了の8秒待ち」には入らず、従来の短い待ちのまま撮る。
- **AI Gateway の 429（Wholesale Rate limited）** が出ることがある。書き出し機能とは無関係。
- **インライン取り込み（2026-09-23 14:28 JST）より前に作った文書は、当時の client.js のまま。** 例: `PDFPROBE-DOCS`（会話 13:00 JST）。同じ接続で HTML のあと PDF を出すと `move` が無いと言われることがある。画面を開き直して PDF だけ出す。

---

## 5. 開発時の注意

試験（`pnpm test` など）を回す前に、開発サーバーを止める。  
稼働中に依存を入れ直すと、開発サーバーが足場を失って落ちる。
