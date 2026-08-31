# Inference endpoints

最終更新: 2026-09-01

秘密（トークン・アカウントIDの完全な値）は書かない。

## AI Gateway（Unified Billing）

| 項目 | 値 |
|---|---|
| ゲートウェイ名 | `musapo-os-ai` |
| エンドポイント | `https://gateway.ai.cloudflare.com/v1/<ACCOUNT_ID>/musapo-os-ai/compat` |
| 既定モデル | `anthropic/claude-sonnet-4-6` |
| フォールバック | Dynamic Route `primary` → `google-ai-studio/gemini-2.5-pro`（第一候補失敗時のみ） |
| 課金 | プロバイダー個別契約なし（Unified Billing）。クレジットから引き落とし |
| 認証 | HTTP は `cf-aig-authorization: Bearer <AI_GATEWAY_TOKEN>`。Worker バインディング経由ならヘッダ不要 |

クレジットが尽きたら推論は止まる。別経路（Ollama など）へは逃げない。FC 窓口は「現在応答できません。管理者に連絡してください」を返す。

`@cf/` 始まりの Workers AI モデルは使わない。使う場合はゲートウェイの Workers AI Billing を Unified にする別設定が必要（README 参照）。
