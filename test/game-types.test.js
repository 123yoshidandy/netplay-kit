import { describe, it, expect } from 'vitest';
import { createTestServer } from '../server/testing.js';
import turnGame from '../examples/turn-game.js';
import relayGame from '../examples/relay-game.js';

describe('サンプル①：サーバーがゲームを進める型', () => {
    async function startWithCpu() {
        const server = createTestServer(turnGame);
        const [a, b] = await server.createRoom(['A', 'B']);
        await a.send('addCpu');
        await a.send('start');
        return { server, a, b };
    }

    it('CPU を足して始められ、CPU は外せるが人間は外せない', async () => {
        const server = createTestServer(turnGame);
        const [a, b] = await server.createRoom(['A', 'B']);
        await a.send('addCpu');
        expect(b.last('lobby').players.map(p => p.name)).toEqual(['A', 'B', 'CPU1']);
        await a.send('removeCpu', { seat: 1 });
        expect(a.last('error').message).toBe('外せるのは CPU だけです');
        await a.send('removeCpu', { seat: 2 });
        expect(b.last('lobby').players).toHaveLength(2);
    });

    it('ビューは人ごとに作られ、自分のひみつの数だけが見える', async () => {
        const { a, b } = await startWithCpu();
        const viewA = a.last('state').view;
        const viewB = b.last('state').view;
        expect(viewA.isMyTurn).toBe(true);
        expect(viewB.isMyTurn).toBe(false);
        expect(viewA.secret).toBeGreaterThan(0);
        expect(viewB.secret).toBeGreaterThan(0);
        expect(viewA.players.every(player => !('secret' in player))).toBe(true);
    });

    it('CPU の手は1手ずつ cpu: true を付けて送り、人間の番で止まる', async () => {
        const { a, b } = await startWithCpu();
        a.clear();
        await a.send('command', { command: { type: 'add', amount: 2 } });
        await b.send('command', { command: { type: 'add', amount: 1 } });
        const states = a.all('state');
        expect(states.at(-1).cpu).toBe(true);
        expect(states.filter(s => s.cpu)).toHaveLength(1);
        expect(states.at(-1).view.isMyTurn).toBe(true);
        // ログは操作の前の位置から送る（dominion の logsFrom）
        expect(states.at(-1).view.logsFrom).toBe(2);
        expect(states.at(-1).view.logs).toHaveLength(1);
    });

    it('断った操作には、理由と今の状態を本人にだけ返し、保存しない', async () => {
        const { server, a, b } = await startWithCpu();
        a.clear();
        const writes = server.store.writes;
        await b.send('command', { command: { type: 'add', amount: 1 } });
        expect(b.messages.slice(-2).map(m => m.type)).toEqual(['error', 'state']);
        expect(b.last('error')).toMatchObject({ message: 'あなたの番ではありません', code: 'rejected' });
        expect(a.messages).toEqual([]);
        expect(server.store.writes).toBe(writes);
    });

    it('部屋には操作の記録だけを保存し、再接続すると最近のログを送る', async () => {
        const { server, a, b } = await startWithCpu();
        await a.send('command', { command: { type: 'add', amount: 1 } });
        const saved = [...server.store.rooms.values()][0].game;
        expect(Object.keys(saved).sort()).toEqual(['commands', 'options', 'players', 'turnStartedAt']);
        const b2 = await server.reconnect(b);
        expect(b2.last('state').view.logsFrom).toBe(0);
        expect(b2.last('state').view.total).toBe(1);
    });

    it('対戦中に抜けた人の手番は CPU が代わりに打つ', async () => {
        const server = createTestServer(turnGame);
        const [a, b] = await server.createRoom(['A', 'B', 'C']);
        await a.send('start');
        await b.send('leave');
        await a.send('command', { command: { type: 'add', amount: 1 } });
        // B の番は CPU が代わりに打ち、C の番で止まる
        const view = a.last('state').view;
        expect(view.players[1].proxy).toBe(true);
        expect(view.current).toBe(2);
        expect(view.total).toBeGreaterThan(1);
    });

    it('手番の時間制限は、届いたメッセージ（ping を含む）のたびに確かめる', async () => {
        const server = createTestServer(turnGame);
        const [a, b] = await server.createRoom(['A', 'B']);
        await a.send('setSettings', { settings: { turnSeconds: 30 } });
        await a.send('start');
        server.clock.now += 29_000;
        await b.send('ping');
        expect(b.last('state').view.total).toBe(0);
        server.clock.now += 2_000;
        await b.send('ping');
        expect(b.last('pong')).toBeTruthy();
        expect(b.last('state').view).toMatchObject({ total: 1, current: 1 });
    });

    it('最後まで進むと対戦が終わり、ホストが同じ顔ぶれで始め直せる', async () => {
        const server = createTestServer(turnGame);
        const [a, b] = await server.createRoom(['A', 'B']);
        await a.send('start');
        const players = [a, b];
        for (let turn = 0; a.last('lobby').status === 'playing' && turn < 30; turn++) {
            await players[turn % 2].send('command', { command: { type: 'add', amount: 3 } });
        }
        expect(a.last('lobby').status).toBe('ended');
        expect(a.last('state').view.loser).toBe(0);
        await b.send('start');
        expect(b.last('error').code).toBe('not_host');
        await a.send('start');
        expect(b.last('lobby')).toMatchObject({ status: 'playing', matchId: 2 });
    });

    it('CPU が進まなくなったら止める（手数の上限と、記録が増えないときの安全装置）', async () => {
        const stuck = { ...turnGame, cpu: { needsStep: () => true, step: () => true, progress: () => 0 } };
        const server = createTestServer(stuck);
        const [a] = await server.createRoom(['A']);
        await a.send('addCpu');
        await a.send('start');
        expect(a.all('state').filter(s => s.cpu)).toHaveLength(0);

        const endless = { ...turnGame, maxCpuSteps: 5, cpu: { step: () => true } };
        const server2 = createTestServer(endless);
        const [c] = await server2.createRoom(['A']);
        await c.send('addCpu');
        await c.send('start');
        expect(c.all('state').filter(s => s.cpu)).toHaveLength(5);
    });

    it('スタンプは決めた種類だけを全員に送り、保存しない', async () => {
        const { server, a, b } = await startWithCpu();
        const writes = server.store.writes;
        await b.send('stamp', { stamp: '👍' });
        await b.send('stamp', { stamp: '💣' });
        expect(a.all('stamp')).toEqual([expect.objectContaining({ seat: 1, stamp: '👍' })]);
        expect(server.store.writes).toBe(writes);
    });
});

describe('サンプル②：中継の型', () => {
    async function startRelay() {
        const server = createTestServer(relayGame);
        const [a, b] = await server.createRoom(['A', 'B']);
        await a.send('start');
        return { server, a, b, matchId: a.last('state').matchId };
    }

    it('同じシードを配り、中継は相手にだけ届き、保存せず、部屋の読み込みは1回だけ', async () => {
        const { server, a, b, matchId } = await startRelay();
        expect(a.last('state').view.seed).toBe(b.last('state').view.seed);
        const { reads, writes } = server.store;
        await a.send('relay', { kind: 'attack', data: { lines: 2 }, matchId });
        expect(b.last('relay')).toMatchObject({ kind: 'attack', data: { lines: 2 }, from: 0 });
        expect(a.last('relay')).toBeUndefined();
        expect(server.store.writes).toBe(writes);
        expect(server.store.reads - reads).toBe(1);
    });

    it('前の対戦・対戦の後・知らない種類・大きすぎる中継は、エラーを出さずに捨てる', async () => {
        const { a, b, matchId } = await startRelay();
        await a.send('relay', { kind: 'attack', data: {}, matchId: matchId - 1 });
        await a.send('relay', { kind: 'cheat', data: {}, matchId });
        await a.send('relay', { kind: 'snapshot', data: 'x'.repeat(5000), matchId });
        await a.send('lose', { matchId });
        await a.send('relay', { kind: 'snapshot', data: {}, matchId });
        expect(b.all('relay')).toHaveLength(0);
        expect(a.all('error')).toHaveLength(0);
    });

    it('相手が再接続したら、新しい接続に中継する', async () => {
        const { server, a, b, matchId } = await startRelay();
        await a.send('relay', { kind: 'attack', data: 1, matchId });
        const b2 = await server.reconnect(b);
        await a.send('relay', { kind: 'attack', data: 2, matchId });
        expect(b2.last('relay').data).toBe(2);
    });

    it('ゲームが足した開始の条件（全員の接続）を満たさなければ、理由を返して始めない', async () => {
        const game = { ...relayGame, canStart: (lobby) => lobby.players.every(p => p.connected) ? null : '2人そろってから開始してください' };
        const server = createTestServer(game);
        const [a, b] = await server.createRoom(['A', 'B']);
        await b.disconnect();
        await a.send('start');
        expect(a.last('error')).toMatchObject({ message: '2人そろってから開始してください', code: 'cannot_start' });
        expect(a.last('lobby').status).toBe('lobby');
    });

    it('負けを申告すると相手の勝ち。2人とも「もう1回」を押すと、勝ち数を引き継いで始まる', async () => {
        const { a, b, matchId } = await startRelay();
        await b.send('lose', { matchId });
        expect(a.last('lobby').status).toBe('ended');
        expect(a.last('state').view).toMatchObject({ loser: 1, wins: [1, 0] });

        await a.send('ready');
        expect(b.last('lobby').players[0].ready).toBe(true);
        expect(b.last('lobby').status).toBe('ended');
        await b.send('ready');
        expect(a.last('lobby')).toMatchObject({ status: 'playing', matchId: matchId + 1 });
        expect(a.last('state').view).toMatchObject({ loser: null, wins: [1, 0] });
        expect(a.last('lobby').players.every(p => !p.ready)).toBe(true);
    });

    it('対戦中に部屋を出たら相手の勝ち。切断だけなら待つ', async () => {
        const { a, b } = await startRelay();
        await b.disconnect();
        expect(a.last('lobby').status).toBe('playing');
        expect(a.last('lobby').players[1].connected).toBe(false);

        const second = await startRelay();
        await second.b.send('leave');
        expect(second.a.last('lobby').status).toBe('ended');
        expect(second.a.last('state').view.wins).toEqual([1, 0]);
    });
});
