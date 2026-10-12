import { describe, it, expect } from 'vitest';
import { RoomService, ConflictError } from '../server/room-service.js';
import { MemoryStore } from '../server/memory-store.js';
import { createTestServer } from '../server/testing.js';
import raceGame, { COUNTDOWN_MS } from '../examples/race-game.js';

describe('部屋の作成と参加', () => {
    it('部屋を作ると5桁の部屋番号と席0が返り、自分がホストになる', async () => {
        const server = createTestServer(raceGame);
        const [a] = await server.createRoom(['あお']);
        const joined = a.last('joined');
        expect(joined.roomCode).toMatch(/^\d{5}$/);
        expect(joined.seat).toBe(0);
        expect(joined.token).toBeTruthy();
        const lobby = a.last('lobby');
        expect(lobby.status).toBe('lobby');
        expect(lobby.hostSeat).toBe(0);
        expect(lobby.seat).toBe(0);
        expect(lobby.settings).toEqual({ winsNeeded: 3 });
    });

    it('参加すると全員に参加者が届き、満員なら断られる', async () => {
        const server = createTestServer(raceGame);
        const clients = await server.createRoom(['A', 'B', 'C', 'D']);
        expect(clients[0].last('lobby').players.map(p => p.name)).toEqual(['A', 'B', 'C', 'D']);
        expect(clients[3].last('lobby').seat).toBe(3);

        const e = server.connect();
        await e.send('join', { roomCode: clients.code, name: 'E' });
        expect(e.last('error')).toMatchObject({ message: 'この部屋は満員です', code: 'room_full' });
    });

    it('部屋番号の前後の空白は無視し、ない部屋は room_not_found で断る', async () => {
        const server = createTestServer(raceGame);
        const [, ] = await server.createRoom(['A']);
        const code = server.store.rooms.keys().next().value;
        const b = server.connect();
        await b.send('join', { roomCode: ` ${code} `, name: 'B' });
        expect(b.last('joined').seat).toBe(1);

        const x = server.connect();
        await x.send('join', { roomCode: '00000', name: 'X' });
        expect(x.last('error')).toMatchObject({ message: '部屋が見つかりません', code: 'room_not_found' });
    });

    it('名前は12文字までで、空なら「プレイヤー」になる', async () => {
        const server = createTestServer(raceGame);
        const [a, b] = await server.createRoom(['  ', 'あいうえおかきくけこさしすせそ']);
        expect(a.last('lobby').players.map(p => p.name)).toEqual(['プレイヤー', 'あいうえおかきくけこさし']);
        expect(b.last('lobby').players[0].id).toBeTruthy();
    });

    it('対戦が始まった部屋には新しく入れない', async () => {
        const server = createTestServer(raceGame);
        const [a] = await server.createRoom(['A', 'B']);
        await a.send('start');
        const c = server.connect();
        await c.send('join', { roomCode: a.last('joined').roomCode, name: 'C' });
        expect(c.last('error').code).toBe('already_started');
    });

    it('すべてのメッセージにサーバーの時刻が付く', async () => {
        const server = createTestServer(raceGame);
        const [a, b] = await server.createRoom(['A', 'B']);
        await a.send('start');
        await b.send('nope');
        [...a.messages, ...b.messages].forEach(message => expect(message.serverNow).toBe(server.clock.now));
    });

    it('知らない操作は断り、共通の操作名はゲームの定義に使えない', async () => {
        const server = createTestServer(raceGame);
        const [a] = await server.createRoom(['A']);
        await a.send('dance');
        expect(a.last('error').message).toBe('不明な操作です');
        expect(() => new RoomService({ game: { ...raceGame, actions: { start: () => {} } }, store: new MemoryStore(), send: async () => {} }))
            .toThrow(/start/);
    });

    it('部屋に入っていない接続の操作は not_member で断る', async () => {
        const server = createTestServer(raceGame);
        const x = server.connect();
        await x.send('start');
        expect(x.last('error').code).toBe('not_member');
    });
});

describe('ロビーでも受け付ける操作', () => {
    it("when: 'any' の操作は、ゲームがないロビーでも動き、対戦中だけの操作は黙って捨てる", async () => {
        const game = {
            ...raceGame,
            actions: {
                ...raceGame.actions,
                wave: { when: 'any', handle: ({ broadcast, seat }) => broadcast({ type: 'wave', seat }) }
            }
        };
        const server = createTestServer(game);
        const [a, b] = await server.createRoom(['A', 'B']);
        await b.send('wave');
        expect(a.last('wave')).toMatchObject({ seat: 1 });
        await b.send('solved', { round: 1 });
        expect(b.last('error')).toBeUndefined();
    });
});

describe('席とホスト', () => {
    it('ロビーで部屋を作った人が抜けると、次の人が席0になって引き継ぐ', async () => {
        const server = createTestServer(raceGame);
        const [a, b, c] = await server.createRoom(['A', 'B', 'C']);
        await a.send('leave');
        expect(a.last('left')).toBeTruthy();
        expect(b.last('lobby')).toMatchObject({ seat: 0, hostSeat: 0 });
        expect(c.last('lobby').seat).toBe(1);

        await b.send('setSettings', { settings: { winsNeeded: 1 } });
        expect(c.last('lobby').settings.winsNeeded).toBe(1);
        await c.send('setSettings', { settings: { winsNeeded: 2 } });
        expect(c.last('error').code).toBe('not_host');
    });

    it('席が詰まっても、席番号は接続から正しく求まる（接続の記録に席を持たない）', async () => {
        const server = createTestServer(raceGame);
        const [a, b, c] = await server.createRoom(['A', 'B', 'C']);
        await a.send('leave');
        await b.send('start');
        const round = c.last('state').view.round;
        await c.send('solved', { round: round.number });
        expect(b.last('state').view.round.winner).toBe(1);
        expect([...server.store.connections.values()].every(connection => !('seat' in connection))).toBe(true);
    });

    it('対戦中にホストが抜けると「退出」として席が残り、次の人がホストを引き継ぐ', async () => {
        const server = createTestServer(raceGame);
        const [a, b, c] = await server.createRoom(['A', 'B', 'C']);
        await a.send('start');
        await a.send('leave');
        const lobby = b.last('lobby');
        expect(lobby.players[0].left).toBe(true);
        expect(lobby.hostSeat).toBe(1);

        // ホストの役は、対戦中の「部屋に戻る」にも使える。退出した人はそこで外れる
        await c.send('backToLobby');
        expect(c.last('error').code).toBe('not_host');
        await b.send('backToLobby');
        expect(c.last('lobby')).toMatchObject({ status: 'lobby', seat: 1, hostSeat: 0 });
        expect(c.last('lobby').players.map(p => p.name)).toEqual(['B', 'C']);
    });

    it('ホストが切断中なら、接続している次の人がホストになる', async () => {
        const server = createTestServer(raceGame);
        const [a, b] = await server.createRoom(['A', 'B']);
        await a.disconnect();
        expect(b.last('lobby')).toMatchObject({ hostSeat: 1 });
        expect(b.last('lobby').players[0].connected).toBe(false);
    });
});

describe('再接続', () => {
    it('同じトークンで同じ席に戻ると、joined → lobby → state の順に届く', async () => {
        const server = createTestServer(raceGame);
        const [a, b] = await server.createRoom(['A', 'B']);
        await a.send('start');
        const b2 = await server.reconnect(b);
        expect(b2.messages.map(m => m.type)).toEqual(['joined', 'lobby', 'state']);
        expect(b2.last('joined').seat).toBe(1);
        expect(b2.last('state').view.round.number).toBe(1);
        expect(a.last('lobby').players[1].connected).toBe(true);
    });

    it('退出した人は、トークンがあっても戻れない', async () => {
        const server = createTestServer(raceGame);
        const [a, b] = await server.createRoom(['A', 'B', 'C']);
        await a.send('start');
        const joined = b.last('joined');
        await b.send('leave');
        const b2 = server.connect();
        await b2.send('join', { roomCode: joined.roomCode, token: joined.token });
        expect(b2.last('error').code).toBe('already_started');
    });
});

describe('接続の生存確認と制限', () => {
    it('ping には pong と端末の時刻を返し、期限のないゲームでは部屋を読まない', async () => {
        const server = createTestServer(raceGame);
        const [a] = await server.createRoom(['A']);
        const reads = server.store.reads;
        await a.send('ping', { clientTime: 123 });
        expect(a.last('pong')).toMatchObject({ clientTime: 123, serverNow: server.clock.now });
        expect(server.store.reads).toBe(reads);
    });

    it('大きすぎる・読めないメッセージは黙って捨てる', async () => {
        const server = createTestServer(raceGame);
        const [a] = await server.createRoom(['A']);
        a.clear();
        await a.sendRaw(JSON.stringify({ action: 'ping', pad: 'x'.repeat(9000) }));
        await a.sendRaw('{');
        await a.sendRaw('[1]');
        expect(a.messages).toEqual([]);
    });

    it('1接続あたりの送信回数が上限を超えたら捨てる（時間がたてば戻る）', async () => {
        const server = createTestServer({ ...raceGame, messagesPerSecond: 1, messagesBurst: 3 });
        const a = server.connect();
        for (let i = 0; i < 5; i++) await a.sendRaw(JSON.stringify({ action: 'ping' }));
        expect(a.all('pong')).toHaveLength(3);
        server.clock.now += 2000;
        await a.sendRaw(JSON.stringify({ action: 'ping' }));
        expect(a.all('pong')).toHaveLength(4);
    });

    it('保存がぶつかったら、読み直してやり直す', async () => {
        const store = new MemoryStore();
        const putRoom = store.putRoom.bind(store);
        let failNext = false;
        store.putRoom = async (room, previous) => {
            if (failNext) {
                failNext = false;
                throw new ConflictError();
            }
            return putRoom(room, previous);
        };
        const server = createTestServer(raceGame, { store });
        const [a] = await server.createRoom(['A', 'B']);
        failNext = true;
        await a.send('setSettings', { settings: { winsNeeded: 2 } });
        expect(a.last('lobby').settings.winsNeeded).toBe(2);
        expect(a.last('error')).toBeUndefined();
    });
});

describe('サンプル③：早解き', () => {
    async function startRace(names = ['A', 'B', 'C'], winsNeeded = 2) {
        const server = createTestServer(raceGame);
        const clients = await server.createRoom(names);
        await clients[0].send('setSettings', { settings: { winsNeeded } });
        await clients[0].send('start');
        return { server, clients };
    }

    it('開始すると全員に同じ問題番号と開始時刻（3秒後）が届く', async () => {
        const { server, clients: [a, b] } = await startRace();
        expect(a.last('lobby').status).toBe('playing');
        const round = a.last('state').view.round;
        expect(round.number).toBe(1);
        expect(round.seed).toBe(b.last('state').view.round.seed);
        expect(round.startAt).toBe(server.clock.now + COUNTDOWN_MS);
        expect(a.last('state').matchId).toBe(1);
    });

    it('勝ち数の検証はゲームが行い、範囲外ならその理由で断る', async () => {
        const server = createTestServer(raceGame);
        const [a] = await server.createRoom(['A']);
        await a.send('setSettings', { settings: { winsNeeded: 6 } });
        expect(a.last('error').message).toBe('勝ち数は1〜5で選んでください');
    });

    it('2番目の通知や前の問題の遅れた通知は、エラーを出さずに捨てる', async () => {
        const { server, clients: [a, b, c] } = await startRace();
        server.clock.now += COUNTDOWN_MS + 1234;
        await b.send('solved', { round: 1 });
        const writes = server.store.writes;
        await c.send('solved', { round: 1 });
        await b.send('solved', { round: 1 });
        expect(server.store.writes).toBe(writes);
        expect(c.last('error')).toBeUndefined();
        const view = a.last('state').view;
        expect(view.round).toMatchObject({ winner: 1, winnerTime: 1234 });
        expect(view.wins).toEqual([0, 1, 0]);

        await a.send('nextRound', { round: 1 });
        await c.send('nextRound', { round: 1 });
        expect(a.last('state').view.round.number).toBe(2);
    });

    it('まだ解いている人が全員切断したら、勝者なしで問題を終え、切断も全員に届く', async () => {
        const { clients: [a, b, c] } = await startRace();
        await a.send('surrender', { round: 1 });
        await b.disconnect();
        expect(a.last('lobby').players[1].connected).toBe(false);
        expect(a.last('state').view.phase).toBe('playing');
        await c.disconnect();
        expect(a.last('state').view.phase).toBe('roundEnd');
    });

    it('勝ち数に届いたら対戦が終わり、誰でも部屋に戻れる', async () => {
        const { clients: [a, b, c] } = await startRace();
        await c.send('solved', { round: 1 });
        await a.send('nextRound', { round: 1 });
        await c.send('solved', { round: 2 });
        expect(a.last('lobby').status).toBe('ended');
        await b.send('backToLobby');
        expect(a.last('lobby').status).toBe('lobby');
    });

    it('対戦が終わるときは、最後のビューを先に、部屋の状態（ended）をあとに送る。開始のときは部屋の状態が先', async () => {
        const { clients: [a, b] } = await startRace(['A', 'B'], 1);
        const types = (client) => client.messages.map(m => m.type === 'lobby' ? `lobby:${m.status}` : m.type);
        expect(types(a).slice(-2)).toEqual(['lobby:playing', 'state']);
        a.clear();
        b.clear();
        await b.send('solved', { round: 1 });
        expect(types(a)).toEqual(['state', 'lobby:ended']);
        expect(types(b)).toEqual(['state', 'lobby:ended']);
        expect(a.last('state').view.round.winner).toBe(1);
    });

    it('対戦後はホストが「開始」で再戦できる', async () => {
        const { clients: [a, b] } = await startRace(['A', 'B'], 1);
        await b.send('solved', { round: 1 });
        expect(a.last('lobby').status).toBe('ended');
        await a.send('start');
        expect(b.last('lobby')).toMatchObject({ status: 'playing', matchId: 2 });
        expect(b.last('state').view.wins).toEqual([0, 0]);
    });
});
