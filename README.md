# netplay-kit

ブラウザゲーム（dominion・lucky-numbers・panel-de-pon・mine-blocks）に共通の、オンライン対戦の部屋の仕組み。

- 部屋の作成・参加・再接続・退出・ホストの引き継ぎ・開始・再戦・CPU・スタンプ・接続の生存確認を、ゲームに共通の部品として持つ
- ゲームの中身は「ゲームの定義」として外から差し込む（共通部品からゲームのコードは import しない）
- 配り方は「コピーして同期」。このリポジトリを正の版とし、各ゲームの決まったフォルダにコピーしてコミットする（npm パッケージや git submodule にはしない）
- 各ゲームは今までどおり、GitHub Pages と自分の SAM スタックで別々にデプロイする

## フォルダ構成

- `server/`: サーバー側（各ゲームの `server/netplay/` にコピーする）
  - `room-service.js`: 部屋の処理（ゲームに共通の部分）
  - `handler.js`: `createHandler(ゲームの定義)` で Lambda の入口を作る
  - `dynamo-store.js` / `memory-store.js`: DynamoDB／メモリへの保存
  - `dev-server.js`: `startDevServer(ゲームの定義)` で手元のテスト用サーバーを動かす
  - `testing.js`: テストの道具（メモリの保存先、時刻・乱数の固定、N人分の接続）
- `client/`: 画面側（各ゲームの `js/netplay/`、`public/js` があるゲームは `public/js/netplay/` にコピーする）
  - `netplay-client.js`: 本体（普通の `<script>` で読むと `window.NetplayClient` になる）
  - `netplay-client.mjs`: ES モジュールから使うための入口
- `examples/`: 3つの型のサンプルゲーム（テストに使う。コピーはしない）
  - `turn-game.js`: ①サーバーがゲームを進める型（dominion・lucky-numbers）
  - `relay-game.js`: ②中継の型（panel-de-pon）
  - `race-game.js`: ③早解きの型（mine-blocks）
  - `web/index.html` / `e2e.mjs`: 最小の画面と、ヘッドレス Chrome での通し試験の例
- `tools/chrome.mjs`: 通し試験の道具（ヘッドレス Chrome を DevTools Protocol で操作する。コピーはしない）
- `template/template.yaml`: AWS SAM のテンプレートの見本（同期はしない）
- `scripts/sync.mjs`: 各ゲームへの同期と確認
- `test/`: テスト（Vitest）

## ゲームの定義

各ゲームは、次の形のオブジェクトを `server/src/game-definition.js` などに書き、`createHandler` と `startDevServer` に渡す。省略した項目は既定値になる。

```js
import { GameError } from '../netplay/room-service.js';
import Game from '../../public/js/game.js'; // ゲームのコードは、ゲームの側で import する

export default {
    minPlayers: 2,            // 開始に必要な人数（既定 2）
    maxPlayers: 4,            // 部屋に入れる人数（既定 4）
    joinMidGame: false,       // 対戦中に新しい人が参加できるか（token での再接続は、これと関係なくいつでもできる）
    allowCpu: false,          // ロビーで CPU を足せるか
    rematch: 'host',          // 'host'：ホストが「開始」で始める / 'ready'：全員が「もう1回」を押したら始まる（ホストの「開始」も使える）
    stamps: ['👍', '😮'],     // 送れるスタンプの種類
    maxNameLength: 12,
    roomTtlSeconds: 172800,   // 部屋は最後の操作からこの秒数で消える（既定 2日）
    maxCpuSteps: 1000,        // CPU が止まらなくなったときの安全装置
    maxMessageLength: 8192,   // 端末から受け付けるメッセージの大きさの上限（JSON の文字数）
    messagesPerSecond: 10,    // 1接続あたりの送信回数の上限（Lambda のメモリで数えるので目安）
    messagesBurst: 20,

    // ロビーの設定。共通部品は中身を知らない
    settings: {
        defaults: () => ({ winsNeeded: 3 }),                    // 既定値
        validate: (patch, current) => ({ ...current, ...patch }), // 検証して新しい設定を返す（だめなら GameError を投げる）
        forStart: (settings) => settings,                       // 開始時に create へ渡す内容（省略するとそのまま）
        forLobby: (settings) => settings                        // ロビーのメッセージに載せる項目（省略するとそのまま）
    },

    // 対戦を始める。返した値が room.game に入る
    // players: [{ id, name, isCPU }]、carry: 前の対戦の carryOver の結果、random: 乱数、now: サーバーの時刻
    create: ({ players, settings, carry, matchId, random, now }) => game,

    // 保存する形と動く形の変換（①型の replay 用）。省略すると、保存した値をそのまま使う
    restore: (saved, room) => Game.replay(saved.players, saved.options, saved.commands),
    persist: (game) => ({ players, options, commands }),

    // 各人に送るビュー。since は mark の値（操作の前のログの数など。最初は null）、room は部屋の状態（lobby と同じ形）
    view: (game, seat, { since, room }) => view,
    mark: (game) => game.logs.length,                            // 操作の前に呼び、view の since に渡す
    joinMark: (game) => Math.max(0, game.logs.length - 200),     // 再接続したときの since

    // 操作ごとの処理。名前が端末から送る action になる
    actions: {
        command: { handle(ctx) { /* 保存する操作 */ } },
        relay: { readOnly: true, handle(ctx) { /* 保存しない操作（中継など） */ } },
        nextRound: (ctx) => { /* 関数だけ書くと { handle } と同じ */ },
        chat: { when: 'any', handle(ctx) { /* ロビーでも受け付ける（既定の 'playing' は対戦中だけ） */ } }
    },

    // 開始の条件を足す（lobby は部屋の状態）。始められない理由を返すと断り、null なら始める
    canStart: (lobby) => lobby.players.every(p => p.connected) ? null : '全員そろってから開始してください',

    isOver: (game) => game.phase === 'end',      // true になったら status を 'ended' にする
    carryOver: (game, carry) => ({ wins }),      // 対戦が終わったとき、次の対戦に残すもの（通算の勝ち数など）

    // CPU（共通側が、手数の上限まで、または人間の操作が必要になるまで進める）
    cpu: {
        needsStep: (game, room) => true,         // CPU が打つ番か（省略すると、step が false を返すまで進める）
        step: (game, { random, now, room }) => true, // 1手進める。false なら止める
        progress: (game) => game.commands.length // 記録の数。増えなければ止める（省略可）
    },

    // 対戦中に参加者がいなくなった（reason: 'left' 退出 / 'disconnected' 切断）。何もしなければ ctx.ignore()
    onPlayerGone(ctx, { seat, reason }) {},
    // 対戦中に新しい人が参加した（joinMidGame: true のとき）
    onJoin(ctx, { seat }) {},
    // 期限（手番の時間制限など）。Lambda はタイマーを持てないので、届いたメッセージ（ping を含む）のたびに確かめる
    deadline: (game, room) => game.turnStartedAt + 30000, // null なら期限なし
    onDeadline(ctx) {}
};
```

### 操作に渡す道具（ctx）

`actions` の `handle`・`onPlayerGone`・`onJoin`・`onDeadline` には、同じ形の `ctx` が渡る。関数は取り出して使ってよい（`({ game, reject, now }) => ...`）。

| 項目 | 内容 |
| --- | --- |
| `game` | 動く形のゲーム（最初に読んだときに restore する）。中身を変えれば、保存して各人にビューを送る |
| `seat` / `message` | 操作した人の席と、届いたメッセージ（期限切れでは `seat` は null） |
| `room` / `players` / `settings` / `matchId` / `status` | 部屋の状態（players には `left`・`connectionId`・`isCPU` がある） |
| `now()` / `random()` | サーバーの時刻と乱数（テストでは固定できる） |
| `isConnected(seat)` | 接続中か（CPU は常に接続中、退出した人は接続していない） |
| `opponents(seat = 自分)` | 自分以外の、退出していない参加者の席（2人対戦なら相手） |
| `reply(message)` / `toSeat(seat, message)` / `broadcast(message, { except })` | ゲーム独自のメッセージを送る |
| `reject(理由)` | 操作を断る。理由（`error`）と今のビュー（`state`）を本人にだけ返し、保存しない |
| `ignore()` | 古い操作・届く順のずれた操作などを、エラーを返さずに黙って捨てる（保存も、状態の送信もしない） |
| `noState()` | 保存はするが、各人のビューは送らない |
| `endMatch()` | 対戦を終える（`isOver` を使わないゲーム用） |

- 操作は `handle` が返ったあと、CPU を進め、`isOver` を確かめ、`persist` して保存し、部屋の状態（変わったときだけ）→ 各人のビュー → CPU の1手ごとのビュー（`cpu: true`）の順に送る
- `readOnly: true` の操作は保存しない。部屋の読み込みは1回だけ（接続→部屋番号の対応を Lambda のメモリに置くため）
- 対戦中だけの操作（既定）は、対戦の外から届いたものや、`matchId` が今の対戦と違うものを黙って捨てる
- 端末から届いた操作の検証と、記録する項目の絞り込みは、ゲームの側で行う。代行（proxy）のような「サーバーだけが記録する操作」があるゲームでは、端末から届いた操作を決まった種類と項目に絞り、その操作を端末から送れないようにする
- `reject` は、`game` を変える前に呼ぶ（保存はしないが、ビューは変えたあとの状態で作られるため）
- `onPlayerGone` などのフックで `game` を読んだら、変えたものとして保存してビューを送る。何も変えないときは `ignore()` を呼ぶ

### 部屋の状態

`room.status` は `'lobby'`（ロビー）→ `'playing'`（対戦中）→ `'ended'`（対戦後）。ゲームの細かい段階（mine-blocks の「問題の終わり」など）は `room.game` の中に置く。

- 対戦後は、ホストの「開始」（または全員の「もう1回」）で同じ顔ぶれのまま再戦し、「部屋に戻る」（誰でも）でロビーに戻る
- ロビーで抜けた人は席から外れ、後ろの人の席が詰まる。対戦中・対戦後に抜けた人は「退出」として席を残し、再戦かロビーに戻るときに外す
- ホストは「退出していない最初の人間」（接続中の人を優先）。席0が抜けても、次の人が引き継ぐ
- 席番号は接続の記録に持たず、部屋の players から connectionId で求める（席が詰まってもずれない）

## メッセージ

すべてのメッセージに `serverNow`（サーバーの時刻）が付く。

### 端末 → サーバー（`action`）

| action | 内容 |
| --- | --- |
| `create` `{ name }` | 部屋を作る |
| `join` `{ roomCode, name, token? }` | 部屋に入る（token が参加者のものなら、その席に再接続する） |
| `leave` | 部屋を出る |
| `ping` `{ clientTime }` | 接続の生存確認（期限のあるゲームでは、期限も確かめる） |
| `start` / `ready` `{ ready }` / `backToLobby` | 開始・再戦の準備・ロビーに戻る |
| `setSettings` `{ settings }` / `addCpu` / `removeCpu` `{ seat }` | ロビーの操作（ホストだけ） |
| `stamp` `{ stamp }` | スタンプを全員に送る（保存しない） |
| それ以外 | ゲームの定義の `actions`（対戦中の操作には `matchId` を付ける） |

### サーバー → 端末（`type`）

| type | 内容 |
| --- | --- |
| `joined` | `{ roomCode, seat, token, playerId }` 部屋に入った（再接続の情報として保存する） |
| `lobby` | `{ roomCode, status, matchId, hostSeat, rematch, settings, players, seat }` 部屋の状態。対戦中も、参加者が変わるたびに届く。`seat` は受け取る人の今の席 |
| `state` | `{ matchId, view, cpu? }` 自分のビュー |
| `error` | `{ message, code }`（`room_not_found`・`not_member`・`room_full`・`already_started`・`not_host`・`not_enough_players`・`cannot_start`・`rejected`・`busy`・`invalid`） |
| `left` / `pong` `{ clientTime }` / `stamp` `{ seat, stamp }` | 退出した / ping の返事 / スタンプ |
| それ以外 | ゲーム独自のメッセージ（`ctx.reply` などで送ったもの） |

### 届く順番

- 再接続したときは `joined` → `lobby` → `state` の順に届く
- 操作のあとは、部屋の状態（変わったときだけ）→ 各人のビュー → CPU の1手ごとのビュー の順に届く
- ただし対戦が終わったとき（`status` が `'ended'` に変わったとき）だけは、最後の操作を反映したビューが先、`lobby`（`'ended'`）があとに届く。`lobby` が届いた時点で、ビューはもう終わった状態になっている
- NetplayClient は、CPU の手を間を置いて見せているあいだに届いた `lobby` を、まだ見せていないビューの後ろに並べて知らせる（ロビーに戻る `lobby` だけは、すぐ知らせて、残りのビューを捨てる）
- AWS では、メッセージどうしの間に時間差がある。手元のテスト用サーバーではほぼ同時に届くので、順番に頼る画面は AWS でも確かめる

### 部屋の状態の players

`lobby.players` には、対戦中・対戦後に抜けた人（`left: true`）も入る。席番号（`seat`）を崩さないためで、ロビーに戻るか再戦すると外れる。画面で表示から外すときも、参加者は配列の位置ではなく `seat` で引く。

## 画面側（NetplayClient）

```js
// ES モジュール（dominion・lucky-numbers・panel-de-pon）
import NetplayClient from './netplay/netplay-client.mjs';
// 普通の <script>（mine-blocks）: <script src="js/netplay/netplay-client.js"></script> のあと window.NetplayClient

const net = new NetplayClient({
    serverUrl: NetplayClient.resolveServerUrl({ deployed: 'wss://...' }), // localhost では ws://localhost:8787、?server= で変えられる
    storageKey: 'mineBlocks.online',  // 参加情報を保存するキー（ゲームごとに変える）
    cpuStepDelayMs: 450               // CPU の手（cpu: true）を間を置いて届ける（省略するとすぐ届ける）
});
net.on('lobby', (lobby) => render(lobby));
net.on('state', ({ view, cpu }) => show(view));
net.on('relay', (message) => applyAttack(message.data)); // ゲーム独自のメッセージは type 名で受け取る
net.on('error', ({ message, code }) => showError(message));
net.on('connection', (connected) => showConnection(connected));

await net.createRoom(name);          // joinRoom(code, name) / resume()
net.send('solved', { round: 1 });    // ゲームの操作（今の matchId を付けて送る）
net.start(); net.ready(); net.backToLobby(); net.setSettings({ winsNeeded: 2 }); net.stamp('👍'); net.leave();
net.serverNow();                     // サーバーの今の時刻（toLocalTime(serverTime) で端末の時刻に直す）
net.inviteUrl(); net.setRoomUrl(code); NetplayClient.roomCodeFromUrl();  // 招待URLには ?server= を残す（keepParams で変えられる）
```

- 接続中は5分ごとに ping を送る（API Gateway の WebSocket は、10分間何も送らないと切れる）。切れたら（2時間で必ず切れる）同じ席につなぎ直す。スマホのスリープから戻ったときは、待たずにつなぎ直す
- 時計のずれは、ping の往復時間の半分を引いて、一番速かったときの値で直す
- 保存した部屋に戻れなかったら（部屋が消えた・退出済み）、保存した参加情報を消す
- 画面の描画は持たない。dominion の OnlineGameController のような「ローカル対戦と同じ形」の包みは、各ゲームの側で NetplayClient を使って作る

## 同期

```bash
# 各ゲームにコピーする（ゲームの直下に netplay-kit.lock.json を置く）
node scripts/sync.mjs ~/MyProjects/mine-blocks

# コピー先が手で直されていないか確かめる（直されていたら終了コード1）
node scripts/sync.mjs check ~/MyProjects/mine-blocks
```

- サーバー側は `server/netplay/`、画面側は `public/js` があれば `public/js/netplay/`、なければ `js/netplay/` にコピーする（`--server-dir` / `--client-dir` で変えられる。2回目からは lock の場所を使う）
- コピーしたファイルの先頭には、版とコミットを書いた1行が付く
- `netplay-kit.lock.json` には、版（package.json の version）・コミット・各ファイルの sha256 が入る。コピー先が手で直されていたら、同期は止まる（`--force` で上書きする）
- 直したいところがあれば、netplay-kit で直してテストし、コミットしてから各ゲームに同期する

## 各ゲームへの移し方

1. `node scripts/sync.mjs <ゲームのリポジトリ>` でコピーする
2. `server/src/room-service.js` を、ゲームの定義（`server/src/game-definition.js`）に書き換える
3. `server/src/handler.js` と `server/dev-server.js` を、それぞれ数行にする

   ```js
   // server/src/handler.js
   import { createHandler } from '../netplay/handler.js';
   import game from './game-definition.js';
   export const handler = createHandler(game);

   // server/dev-server.js
   import { startDevServer } from './netplay/dev-server.js';
   import game from './src/game-definition.js';
   startDevServer(game);
   ```

4. `server/src/dynamo-store.js` と `server/src/memory-store.js` は消す（`server/netplay/` のものを使う）。テストは `server/netplay/testing.js` の `createTestServer` を使うと短く書ける
5. 画面側の接続の処理を NetplayClient に置き換える
6. `package.json` の `build:server`・`dev:server`・`deploy:server` は今のままでよい

接続の記録（CONN#）から seat がなくなる以外、DynamoDB のテーブルの形は今と同じ。デプロイしたときに残っていた部屋は、形が違うので使えなくなる（部屋は TTL で消える）。

## サーバー（AWS）

`template/template.yaml` は見本で、同期はしない。各ゲームの `server/template.yaml` はこれと同じ形にそろえ、名前と受け付け上限を変える。

| ゲーム | ThrottlingRateLimit | ThrottlingBurstLimit |
| --- | --- | --- |
| ターン制（dominion・lucky-numbers・mine-blocks） | 10 | 20 |
| 中継（panel-de-pon。1人あたり毎秒5回ほど送る） | 50 | 100 |

- 料金の通知（AWS Budgets）はアカウント全体で1つ（dominion のスタック）にするので、ここには入れない
- ping も受け付け上限に数える（1人あたり5分に1回なので、ほとんど増えない）

## 開発

必要なもの：Node.js 22 以上（通し試験には Google Chrome も）

```bash
npm install

# テスト
npm test

# 通し試験の例（ヘッドレス Chrome で2人分のページを動かす）
node examples/e2e.mjs
```

### 手元で複数のゲームを同時に動かす

テスト用サーバーの既定のポートは 8787。ほかのゲームのテスト用サーバーと同時に動かすときは、`PORT=8788 npm run dev:server` のようにポートを変え、画面は `?server=ws://localhost:8788` を付けて開く。招待URLにも `?server=` が残るので、招待された側も同じサーバーにつながる。

### テストの道具

```js
import { createTestServer } from '../server/netplay/testing.js';
import game from '../server/src/game-definition.js';

const server = createTestServer(game);              // 時刻は server.clock.now で進められる
const [a, b] = await server.createRoom(['あお', 'みどり']);
await a.send('start');
await b.send('solved', { round: 1 });
expect(a.last('state').view.round.winner).toBe(1);
const b2 = await server.reconnect(b);               // 同じ席につなぎ直す
expect(server.store.writes).toBe(...);              // 保存・読み込みの回数も数えられる
```

### 通し試験の道具

`tools/chrome.mjs` の `launchChrome()` で Chrome を起動し、`openPage(url)` で開いたページに `eval`・`waitFor`・`goto`・`shot` を使う。使い方は `examples/e2e.mjs` を参照。
