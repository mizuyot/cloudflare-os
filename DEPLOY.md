# musapo-os のデプロイ

本番 URL: https://musapo-os.musapo-os.workers.dev  
Wrangler の認証プロファイル: `musapo`  
設定ファイル `packages/*/wrangler.prod.jsonc` はこの Mac にあり、git には入れない。

パッケージ管理は **pnpm**。npm は使わない。

---

## 1. 正本ブランチ

| 名前 | 役割 |
|---|---|
| `feat/access-service-probe` | Access 確認トークン（`cursor-probe`）。2026-09-24 から本番に載っている。新しい作業はここから切る |
| `feat/xlsx-font` | 一つ前の正本（xlsx フォントまで）。比較用 |
| `feat/pdf-export-inline` | 一つ前の正本（PDF インライン取り込みまで）。比較用 |
| `add-latest-llm-models` | 取り込み前の基準点。比較用に残してある。ここから作業を始めない |
| `main` | 本番と歴史が分かれている（衝突 35 件）。**統合しない。ここから作業を始めない** |
| `backup/main-old-20260923` | 古い `main` の退避。触らない |

- push 先は **mine だけ**（`https://github.com/mizuyot/cloudflare-os.git`）
- **origin（cloudflare/cloudflare-os）には push しない**

```bash
git checkout feat/access-service-probe
git pull mine feat/access-service-probe
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
- `CF_ACCESS_PROBE_CLIENT_ID`: 確認用サービストークンの Client ID（秘密ではない。期限と入れ替えは §6）
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

### 2026-09-24 時点の本番版

`wrangler deployments list` で確認した値。載せ替えたら、この表を更新すること。

| | 今の本番 | 一つ前（戻す先） |
|---|---|---|
| 裏側 `musapo-os-backend` | `cddef546-cb6d-48a3-a6a0-760eb4c695d6`（429 の最後の失敗を日本語に） | `bfe9d88d-8c80-43f9-940a-681184c5e81c`（Access service-token → `cursor-probe`） |
| 玄関 `musapo-os` | `37c7a6c9-b739-4541-94be-752cb768baea`（Access-mode frontend + 日本語 429） | `f9452365-d706-45e6-9bf0-f1e40b5b45eb`（Access-mode frontend + probe deploy） |

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
- **AI Gateway の 429（Wholesale Rate limited）** が出ることがある。書き出し機能とは無関係。最後まで失敗したときは「混雑しています。Retry を押すか、少し待ってください」と出す。
- **インライン取り込み（2026-09-23 14:28 JST）より前に作った文書は、当時の client.js のまま。** 例: `PDFPROBE-DOCS`（会話 13:00 JST）。同じ接続で HTML のあと PDF を出すと `move` が無いと言われることがある。画面を開き直して PDF だけ出す。

---

## 5. 開発時の注意

試験（`pnpm test` など）を回す前に、開発サーバーを止める。  
稼働中に依存を入れ直すと、開発サーバーが足場を失って落ちる。

---

## 6. 確認用 Access サービストークン

Cursor が本番を自動確認するためのトークン。人間のログイン方針は変えない。

| 項目 | 値 |
|---|---|
| トークン名 | `musapo-os-cursor-probe` |
| 期限 | **2027-09-24**（作成時 1 年） |
| 運用上の入れ替え目安 | **90 日ごと。次回 2026-12-23** |
| 秘密の置き場 | この Mac のキーチェーン。サービス名 `musapo-os-cursor-probe` |
| Client ID | 裏側の `wrangler.prod.jsonc` の `CF_ACCESS_PROBE_CLIENT_ID`（秘密ではない） |
| アプリの方針 | Action **Service Auth**。Include は Service Token `musapo-os-cursor-probe` だけ（Any Access Service Token にはしない） |
| 通ったあとのユーザー | `cursor-probe`（管理者ではない。Yota の表は見えない） |

漏れたら、ダッシュボードで **すぐ失効**する。入れ替えを待たない。

入れ替え手順:

1. ダッシュボードで新しいトークンを作る（期限 1 年でよい）
2. Client Secret をキーチェーンに上書きする（画面・ログ・git に残さない）
3. `wrangler.prod.jsonc` の `CF_ACCESS_PROBE_CLIENT_ID` を新しい Client ID に変え、裏側を載せる
4. 新しいトークンで確認が通ってから、旧トークンを失効する

確認スクリプト: `node scripts/verify-access-probe.mjs`（キーチェーンから読み、秘密は出さない）

---

## 7. AI Gateway の Dynamic Route（`dynamic/primary`）

Gateway: `musapo-os-ai`  
ルート名: `primary`（呼び出しは `dynamic/primary`）  
ルート ID: `46001cd2-2c34-4112-b5c6-95c87a962b6d`

**モデル欄に提供元の接頭辞（`anthropic/` など）を重ねない。** 重ねると第一候補がすぐ失敗してログにも残らず、毎回次の箱に落ちる（2026-09 の 4.6 失敗の原因）。

### 今の公開（2026-09-24）

| 順 | 提供元 | モデル欄 | 失敗したら |
|---|---|---|---|
| 1 | Anthropic | `claude-sonnet-5` | 2 へ |
| 2 | Google AI Studio | `gemini-2.5-pro` | 3 へ |
| 3 | OpenAI | `gpt-5.6-sol` | エラー |

公開版: `4c91f893-e156-4f38-b1b2-b8e728483464`  
公開デプロイ: `f6c0acf2-c94b-432c-b88d-af8c84ff384e`

### 変更前（戻す先）

1. Anthropic / `anthropic/claude-sonnet-4.6`（接頭辞が重なっていた）
2. Google AI Studio / `gemini-2.5-pro`

公開版: `d29bf732-3422-4b16-804f-c2f9f0ecdf5c`  
公開デプロイ: `d59c54be-4d2e-4799-af09-8507490f8d15`（2026-09-01 07:05 UTC）

戻し方: ダッシュボードの Dynamic Routes → `primary` → Versions で上の変更前の版を Deploy する。API なら `POST .../routes/46001cd2-2c34-4112-b5c6-95c87a962b6d/deployments` に `{ "version_id": "d29bf732-3422-4b16-804f-c2f9f0ecdf5c" }`。
