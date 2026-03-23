# OpenCode CursorCLI A2A Plugin — Implementation Plan

OpenCode プラグインとして、CursorCLI (CursorAgent) を A2A プロトコル経由で呼び出すプロバイダーを実装する。
既存の [opencode-geminicli-a2a](file:///home/y_ohi/program/private/opencode-geminicli-a2a) プロジェクトのアーキテクチャを踏襲しつつ、CursorCLI 固有の要件（トリガー設定、ペイロード最適化、エラーハンドリング）に適応させる。

## Proposed Changes

### Project Foundation

#### [NEW] [package.json](file:///home/y_ohi/program/private/opencode-cursorcli-a2a/package.json)

- OpenCode プラグインメタデータ (`opencode.id`, `opencode.type`, `opencode.models`)
- CursorCLI 向けの依存関係: `@ai-sdk/provider`, `@ai-sdk/provider-utils`, [ai](file:///home/y_ohi/program/private/opencode-geminicli-a2a/src/server-manager.ts#30-48), `ofetch`, `zod`
- ビルドスクリプト: esbuild による CJS/ESM デュアルビルド（Gemini 版と同じ CJS factory パターン）
- テスト: `vitest run`、型チェック: `tsc --noEmit`

#### [NEW] [tsup.config.ts](file:///home/y_ohi/program/private/opencode-cursorcli-a2a/tsup.config.ts)

- `format: ['cjs', 'esm']`, `dts: true`, `sourcemap: true`
- `external: ['@ai-sdk/provider', '@ai-sdk/provider-utils']`

#### [NEW] [vitest.config.ts](file:///home/y_ohi/program/private/opencode-cursorcli-a2a/vitest.config.ts)

- テスト環境設定（Node.js）

#### [NEW] [tsconfig.json](file:///home/y_ohi/program/private/opencode-cursorcli-a2a/tsconfig.json)

- `strict: true`, `target: ES2022`, `moduleResolution: bundler`

#### [NEW] [.gitignore](file:///home/y_ohi/program/private/opencode-cursorcli-a2a/.gitignore)

- `node_modules/`, `dist/`, `*.log`

---

### Devcontainer

#### [NEW] [.devcontainer/devcontainer.json](file:///home/y_ohi/program/private/opencode-cursorcli-a2a/.devcontainer/devcontainer.json)

- Node.js 22 ベースイメージ
- `npm install` を postCreateCommand で実行
- VS Code 拡張: ESLint, TypeScript

#### [NEW] [.devcontainer/Dockerfile](file:///home/y_ohi/program/private/opencode-cursorcli-a2a/.devcontainer/Dockerfile)

- `node:22-bookworm-slim` ベース
- 開発ツール（git, curl）のインストール

---

### Core Types & Schemas

#### [NEW] [src/schemas.ts](file:///home/y_ohi/program/private/opencode-cursorcli-a2a/src/schemas.ts)

- Gemini 版と同等の A2A JSON-RPC スキーマ（Zod）
- CursorCLI のステータス値 (`submitted`, `working`, `completed`, `input-required` 等) を反映
- `ConfigSchema` (host, port, token, protocol) — デフォルトポート: 3000 (CursorAgent 標準)
- `GenerationConfigSchema`, `AgentEndpointSchema`

---

### Configuration Manager

#### [NEW] [src/config.ts](file:///home/y_ohi/program/private/opencode-cursorcli-a2a/src/config.ts)

- [OpenCodeProviderOptions](file:///home/y_ohi/program/private/opencode-geminicli-a2a/src/config.ts#10-52) インターフェース:
  - `host`, `port`, `token`, `protocol`
  - `triggerConfig` — エージェントごとのトリガー設定（ユーザーが OpenCode 設定 UI から構成可能）
  - `contextConfig` — ペイロードに含める動的コンテキスト設定
  - `generationConfig`, `toolMapping`, `internalTools`
  - `sessionStore`, `fallback`, `agents`, `autoStart`, `configPath`, `hotReload`
- [ConfigManager](file:///home/y_ohi/program/private/opencode-geminicli-a2a/src/config.ts#64-172) シングルトン: 外部 JSON ファイルの読み込み、ファイル監視、ホットリロード
- [resolveConfig()](file:///home/y_ohi/program/private/opencode-geminicli-a2a/src/config.ts#214-254) — オプション + 外部設定 + 環境変数のマージ
  - 環境変数: `CURSOR_A2A_HOST`, `CURSOR_A2A_PORT`, `CURSOR_A2A_TOKEN`
- CursorCLI 向けデフォルトツールマッピング

#### [NEW] [src/config.test.ts](file:///home/y_ohi/program/private/opencode-cursorcli-a2a/src/config.test.ts)

- [resolveConfig](file:///home/y_ohi/program/private/opencode-geminicli-a2a/src/config.ts#214-254) のデフォルト値、環境変数上書き、外部設定ファイルマージのテスト
- [ConfigManager](file:///home/y_ohi/program/private/opencode-geminicli-a2a/src/config.ts#64-172) のロード、リロード、ホットリロードのテスト

---

### Session Management

#### [NEW] [src/session.ts](file:///home/y_ohi/program/private/opencode-cursorcli-a2a/src/session.ts)

- [A2ASession](file:///home/y_ohi/program/private/opencode-geminicli-a2a/src/session.ts#3-12) インターフェース: [contextId](file:///home/y_ohi/program/private/opencode-geminicli-a2a/src/utils/mapper.ts#480-482), [taskId](file:///home/y_ohi/program/private/opencode-geminicli-a2a/src/utils/mapper.ts#482-484), [lastFinishReason](file:///home/y_ohi/program/private/opencode-geminicli-a2a/src/utils/mapper.ts#484-486), `processedMessagesCount`, `inputRequired`, `rawState`
- [SessionStore](file:///home/y_ohi/program/private/opencode-geminicli-a2a/src/session.ts#13-26) インターフェース: [get](file:///home/y_ohi/program/private/opencode-geminicli-a2a/src/session.ts#14-15), [update](file:///home/y_ohi/program/private/opencode-geminicli-a2a/src/session.ts#91-113), [delete](file:///home/y_ohi/program/private/opencode-geminicli-a2a/src/session.ts#16-17), [resetSession](file:///home/y_ohi/program/private/opencode-geminicli-a2a/src/index.ts#114-117), [clear](file:///home/y_ohi/program/private/opencode-geminicli-a2a/src/session.ts#124-127), [prune](file:///home/y_ohi/program/private/opencode-geminicli-a2a/src/session.ts#128-137)
- [InMemorySessionStore](file:///home/y_ohi/program/private/opencode-geminicli-a2a/src/session.ts#32-138) 実装（TTL + LRU eviction）

#### [NEW] [src/session.test.ts](file:///home/y_ohi/program/private/opencode-cursorcli-a2a/src/session.test.ts)

- CRUD 操作、TTL 失効、LRU eviction のテスト

---

### A2A Client

#### [NEW] [src/a2a-client.ts](file:///home/y_ohi/program/private/opencode-cursorcli-a2a/src/a2a-client.ts)

- [A2AClient](file:///home/y_ohi/program/private/opencode-geminicli-a2a/src/a2a-client.ts#22-135) クラス: [chatStream()](file:///home/y_ohi/program/private/opencode-geminicli-a2a/src/a2a-client.ts#33-134) メソッド
  - `ofetch` による HTTP POST
  - リトライ (408, 429, 500, 502, 503, 504)
  - Idempotency-Key, Authorization ヘッダー
  - `APICallError` へのラッピング
- CursorCLI 固有: CLI 存在確認エラーの検出ロジック

#### [NEW] [src/a2a-client.test.ts](file:///home/y_ohi/program/private/opencode-cursorcli-a2a/src/a2a-client.test.ts)

- ofetch モックによる正常系・異常系テスト（Gemini 版のパターンを踏襲）

---

### Payload Builder & Mapper

#### [NEW] [src/utils/mapper.ts](file:///home/y_ohi/program/private/opencode-cursorcli-a2a/src/utils/mapper.ts)

- [mapPromptToA2AJsonRpcRequest()](file:///home/y_ohi/program/private/opencode-geminicli-a2a/src/utils/mapper.ts#129-196) — AI SDK プロンプト → A2A JSON-RPC 変換
- [buildConfirmationRequest()](file:///home/y_ohi/program/private/opencode-geminicli-a2a/src/utils/mapper.ts#197-224) — 内部ツール auto-confirm 用リクエスト構築
- [A2AStreamMapper](file:///home/y_ohi/program/private/opencode-geminicli-a2a/src/utils/mapper.ts#433-871) クラス — A2A レスポンスストリーム → AI SDK ストリームパーツ変換
  - スナップショット重複排除
  - ツール呼び出しバッファリング（部分引数対策）
  - invalid ツールインターセプト
  - ツール名リバースマッピング
  - reasoning パーツ変換
- CursorCLI 向けの内部ツールリスト（`codebase_search`, `read_file`, `run_terminal_command` 等）
- CursorCLI 向けコンテキスト注入（アクティブファイルパス、選択コード、ワークスペースルート）

#### [NEW] [src/utils/stream.ts](file:///home/y_ohi/program/private/opencode-cursorcli-a2a/src/utils/stream.ts)

- [parseA2AStream()](file:///home/y_ohi/program/private/opencode-geminicli-a2a/src/utils/stream.ts#60-101) — SSE ストリームパーサー（async generator）

#### [NEW] [src/utils/logger.ts](file:///home/y_ohi/program/private/opencode-cursorcli-a2a/src/utils/logger.ts)

- `Logger` ユーティリティ: `debug`, `info`, `warn`, `error`

#### [NEW] [src/utils/mapper.test.ts](file:///home/y_ohi/program/private/opencode-cursorcli-a2a/src/utils/mapper.test.ts)

- プロンプト変換、コンテキスト注入、ツールマッピングのテスト

#### [NEW] [src/utils/stream.test.ts](file:///home/y_ohi/program/private/opencode-cursorcli-a2a/src/utils/stream.test.ts)

- SSE パース、不正 JSON、複数チャンクのテスト

---

### Provider Implementation

#### [NEW] [src/provider.ts](file:///home/y_ohi/program/private/opencode-cursorcli-a2a/src/provider.ts)

- `OpenCodeCursorA2AProvider` クラス (AI SDK LanguageModel V2 互換)
  - [doStream()](file:///home/y_ohi/program/private/opencode-geminicli-a2a/src/provider.ts#195-267) / [doGenerate()](file:///home/y_ohi/program/private/opencode-geminicli-a2a/src/provider.ts#542-611) メソッド
  - auto-confirm ループ（MAX_AUTO_CONFIRM: 50, MAX_TOOL_CONFIRM: 1）
  - フォールバック処理（クォータエラー時の代替モデル自動切替）
  - セッション管理（contextId / taskId の引き継ぎ）

#### [NEW] [src/provider.test.ts](file:///home/y_ohi/program/private/opencode-cursorcli-a2a/src/provider.test.ts)

- [doStream](file:///home/y_ohi/program/private/opencode-geminicli-a2a/src/provider.ts#195-267) / [doGenerate](file:///home/y_ohi/program/private/opencode-geminicli-a2a/src/provider.ts#542-611) のモック対応テスト

---

### Error Handling

#### [NEW] [src/errors.ts](file:///home/y_ohi/program/private/opencode-cursorcli-a2a/src/errors.ts)

- `CursorCLINotFoundError` — CursorCLI 未インストール検出
- `A2ATimeoutError` — A2A 通信タイムアウト
- `A2AProtocolError` — プロトコルレベルのエラー
- エラー→ UI 通知変換ユーティリティ

#### [NEW] [src/fallback.ts](file:///home/y_ohi/program/private/opencode-cursorcli-a2a/src/fallback.ts)

- フォールバック設定・判定ロジック（Gemini 版踏襲）

---

### Server Manager

#### [NEW] [src/server-manager.ts](file:///home/y_ohi/program/private/opencode-cursorcli-a2a/src/server-manager.ts)

- [ServerManager](file:///home/y_ohi/program/private/opencode-geminicli-a2a/src/server-manager.ts#97-307) シングルトン: CursorCLI A2A サーバープロセスの起動・停止
- ポートプローブ、待機、プロセス管理
- CursorCLI 固有: `cursor-agent` コマンドのパス解決

---

### Plugin Entry Point

#### [NEW] [src/index.ts](file:///home/y_ohi/program/private/opencode-cursorcli-a2a/src/index.ts)

- `createCursorA2AProvider()` ファクトリ関数
- `CursorA2AProvider` インターフェース（ProviderV1 互換）
- [createModel()](file:///home/y_ohi/program/private/opencode-geminicli-a2a/src/index.ts#63-98) — モデルID → Provider インスタンス生成
- [initProvider()](file:///home/y_ohi/program/private/opencode-geminicli-a2a/src/index.ts#156-169) / `provider` Proxy / `createProvider` エクスポート
- プラグインID: [opencode-cursorcli-a2a](file:///home/y_ohi/program/private/opencode-cursorcli-a2a)

---

### Multi-Agent Router

#### [NEW] [src/router.ts](file:///home/y_ohi/program/private/opencode-cursorcli-a2a/src/router.ts)

- [DefaultMultiAgentRouter](file:///home/y_ohi/program/private/opencode-geminicli-a2a/src/router.ts#16-72) — モデルID → エンドポイント解決

---

## Verification Plan

### Automated Tests

テストはすべて devcontainer 内で実行する。

```bash
# Devcontainer 内で実行
npm install
npm run test        # vitest run — 全ユニットテストを実行
npm run typecheck   # tsc --noEmit — 型チェック
npm run build       # esbuild — CJS/ESM デュアルビルド
```

テスト対象:
- [src/config.test.ts](file:///home/y_ohi/program/private/opencode-geminicli-a2a/src/config.test.ts) — ConfigManager、resolveConfig
- [src/session.test.ts](file:///home/y_ohi/program/private/opencode-geminicli-a2a/src/session.test.ts) — InMemorySessionStore
- [src/a2a-client.test.ts](file:///home/y_ohi/program/private/opencode-geminicli-a2a/src/a2a-client.test.ts) — A2AClient (ofetch モック)
- [src/utils/mapper.test.ts](file:///home/y_ohi/program/private/opencode-geminicli-a2a/src/utils/mapper.test.ts) — mapPromptToA2AJsonRpcRequest、A2AStreamMapper
- [src/utils/stream.test.ts](file:///home/y_ohi/program/private/opencode-geminicli-a2a/src/utils/stream.test.ts) — parseA2AStream
- [src/provider.test.ts](file:///home/y_ohi/program/private/opencode-geminicli-a2a/src/provider.test.ts) — OpenCodeCursorA2AProvider
- [src/schemas.test.ts](file:///home/y_ohi/program/private/opencode-geminicli-a2a/src/schemas.test.ts) — Zod スキーマバリデーション

### Manual Verification

1. `npm run build` 実行後、`dist/index.cjs` と `dist/index.js` が生成されていることを確認
2. `node -e "const m = require('./dist/index.cjs'); console.log(typeof m)"` で `function` が出力されることを確認
3. OpenCode の `opencode.jsonc` に本プラグインを追加し、CursorCLI サーバーとの疎通テスト（要 CursorCLI インストール）
