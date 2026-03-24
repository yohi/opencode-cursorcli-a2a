# opencode-cursorcli-a2a

OpenCode カスタムプロバイダー。Cursor CLI を A2A プロトコル経由で OpenCode から呼び出すプラグインです。

## 特徴

- **堅牢な実行環境**: `node_modules` への直接パッチに依存せず、内製 A2A サーバー（`dist/server.js`）を起動するため、`npm ci` や依存関係の更新後も安定して動作します。
- **Thinking サポート**: Cursor CLI の `thinking`（思考プロセス）イベントをネイティブにサポートし、OpenCode のストリーム表示に反映します。
- **自動検出**: ローカル環境の `cursor` コマンドを自動検出し、複雑な設定なしで動作します。

## 必要条件

- Node.js 20 以上
- Cursor CLI がインストール済み（`cursor` コマンドが PATH に通っていること）

## インストール

### 1. このプラグインをセットアップ

```bash
git clone <this-repo>
cd opencode-cursorcli-a2a
npm install
npm run build
```

ビルド成功すると `dist/index.cjs`（プロバイダー）と `dist/server.js`（内製 A2A サーバー）が生成されます。

---

## OpenCode の設定

`~/.config/opencode/opencode.jsonc` （またはプロジェクトルートの `.opencode/opencode.jsonc`）を編集します。

このプロバイダーを有効にするには、**① `plugin` 配列への登録** と **② `provider` オブジェクトへの設定** の両方が必要です。

### 基本設定（最小構成）

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  // 1. プラグインの登録（パッケージ名）
  "plugin": [
    "opencode-cursorcli-a2a-provider"
  ],
  // 2. プロバイダーの詳細設定（パスとモデルの定義）
  "provider": {
    "opencode-cursorcli-a2a": {
      "npm": "file:///absolute/path/to/opencode-cursorcli-a2a/dist/index.cjs",
      "models": {
        "claude-4.6-sonnet-medium": {}
      },
      "options": {
        "port": 4937,
        "autoStart": {}
      }
    }
  },
  // 3. 使用するモデルの指定
  "model": "opencode-cursorcli-a2a/claude-4.6-sonnet-medium"
}
```

> **`autoStart: {}`** を設定すると、OpenCode から初めてリクエストが来たとき自動的に内製 A2A サーバーを起動します。

### 詳細設定

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "opencode-cursorcli-a2a-provider"
  ],
  "provider": {
    "opencode-cursorcli-a2a": {
      "npm": "file:///absolute/path/to/opencode-cursorcli-a2a/dist/index.cjs",
      "models": {
        // cursorModel オプションを指定して明示的に指定可能
        "claude-4.6-sonnet-medium": {
          "name": "Claude 4.6 Sonnet (Cursor)",
          "options": {
            "cursorModel": "claude-4.6-sonnet-medium"
          }
        }
      },
      "options": {
        // サーバー接続先
        "host": "127.0.0.1",
        "port": 4937,

        // cursor-agent-a2a に渡す Cursor モデル名（最高優先度）
        // 省略するとサーバー側の CURSOR_DEFAULT_MODEL → "auto" を使用
        "cursorModel": "auto",

        // CursorAgent が操作するワークスペースパス（省略時は process.cwd()）
        "workspace": "/path/to/your/project",

        // 自動起動設定（サーバーが未起動の場合に自動で cursor-agent-a2a を起動）
        "autoStart": {
          // serverPath は省略可（グローバル npm から自動検出）
          // "serverPath": "/usr/local/bin/cursor-agent-a2a",

          // 起動タイムアウト（ms、デフォルト: 15000）
          "startupTimeoutMs": 15000
        },

        // API 認証トークン（cursor-agent-a2a が認証を要求する場合）
        "token": "your-api-key"
      }
    }
  },
  "model": "opencode-cursorcli-a2a/claude-4.6-sonnet-medium"
}
```

### 利用可能な Cursor モデル名

| モデル名 | 説明 |
|---|---|
| `auto` | 自動選択 (デフォルト) |
| `claude-4.6-sonnet-medium` | Sonnet 4.6 1M |
| `claude-4.6-opus-high-thinking` | Opus 4.6 1M Thinking |
| `gpt-5.4-high` | GPT-5.4 1M High |
| `gpt-5.4-medium` | GPT-5.4 1M |
| `composer-2` | Composer 2 |
| `gemini-3.1-pro` | Gemini 3.1 Pro |

<details>
<summary>すべての利用可能なモデル一覧（展開して表示）</summary>

- auto
- composer-2-fast
- composer-2
- composer-1.5
- gpt-5.3-codex-low
- gpt-5.3-codex-low-fast
- gpt-5.3-codex
- gpt-5.3-codex-fast
- gpt-5.3-codex-high
- gpt-5.3-codex-high-fast
- gpt-5.3-codex-xhigh
- gpt-5.3-codex-xhigh-fast
- gpt-5.2
- gpt-5.3-codex-spark-preview-low
- gpt-5.3-codex-spark-preview
- gpt-5.3-codex-spark-preview-high
- gpt-5.3-codex-spark-preview-xhigh
- gpt-5.2-codex-low
- gpt-5.2-codex-low-fast
- gpt-5.2-codex
- gpt-5.2-codex-fast
- gpt-5.2-codex-high
- gpt-5.2-codex-high-fast
- gpt-5.2-codex-xhigh
- gpt-5.2-codex-xhigh-fast
- gpt-5.1-codex-max-low
- gpt-5.1-codex-max-low-fast
- gpt-5.1-codex-max-medium
- gpt-5.1-codex-max-medium-fast
- gpt-5.1-codex-max-high
- gpt-5.1-codex-max-high-fast
- gpt-5.1-codex-max-xhigh
- gpt-5.1-codex-max-xhigh-fast
- gpt-5.4-high
- gpt-5.4-high-fast
- gpt-5.4-xhigh-fast
- claude-4.6-opus-high-thinking
- gpt-5.4-low
- gpt-5.4-medium
- gpt-5.4-medium-fast
- gpt-5.4-xhigh
- claude-4.6-sonnet-medium
- claude-4.6-sonnet-medium-thinking
- claude-4.6-opus-high
- claude-4.6-opus-max
- claude-4.6-opus-max-thinking
- claude-4.5-opus-high
- claude-4.5-opus-high-thinking
- gpt-5.2-low
- gpt-5.2-low-fast
- gpt-5.2-fast
- gpt-5.2-high
- gpt-5.2-high-fast
- gpt-5.2-xhigh
- gpt-5.2-xhigh-fast
- gemini-3.1-pro
- gpt-5.4-mini-none
- gpt-5.4-mini-low
- gpt-5.4-mini-medium
- gpt-5.4-mini-high
- gpt-5.4-mini-xhigh
- gpt-5.4-nano-none
- gpt-5.4-nano-low
- gpt-5.4-nano-medium
- gpt-5.4-nano-high
- gpt-5.4-nano-xhigh
- grok-4-20
- grok-4-20-thinking
- claude-4.5-sonnet
- claude-4.5-sonnet-thinking
- gpt-5.1-low
- gpt-5.1
- gpt-5.1-high
- gemini-3-pro
- gemini-3-flash
- gpt-5.1-codex-mini-low
- gpt-5.1-codex-mini
- gpt-5.1-codex-mini-high
- claude-4-sonnet
- claude-4-sonnet-1m
- claude-4-sonnet-thinking
- claude-4-sonnet-1m-thinking
- gpt-5-mini
- kimi-k2.5

</details>

> 最新の一覧は `cursor agent --list-models` で確認できます。

---

## 環境変数

| 変数名 | 説明 | デフォルト |
|---|---|---|
| `CURSOR_AGENT_API_KEY` | cursor-agent-a2a の認証 Bearer トークン | なし |
| `CURSOR_DEFAULT_MODEL` | デフォルトモデル名 | `auto` |
| `CURSOR_A2A_HOST` | サーバーホスト | `127.0.0.1` |
| `CURSOR_A2A_PORT` | サーバーポート | `4937` |
| `CURSOR_A2A_WORKSPACE` | デフォルトワークスペースパス | `process.cwd()` |
| `DEBUG_OPENCODE` | デバッグログを有効化 | なし |

---

## 動作の仕組み

```text
OpenCode
  └─► Provider (doStream)
        ├─ [1] autoStart が有効なら 内製 A2A サーバー を await 起動
        ├─ [2] POST /messages?stream=true  →  Internal Server (port 4937)
        └─ [3] SSE レスポンスを AI SDK ストリームパーツに変換して返却
```

- **セッション管理**: `sessionId` を自動生成し multi-turn 会話を維持します
- **自動起動**: `autoStart` 設定時、初回 API 呼び出し前にサーバー起動完了を await します
- **フォールバック**: レート制限 (429) 時に別のモデルへ自動切り替え可能

---

## 開発

```bash
npm run build      # ビルド
npm run test       # テスト（83 件）
npm run typecheck  # 型チェック
```

## ライセンス

MIT
