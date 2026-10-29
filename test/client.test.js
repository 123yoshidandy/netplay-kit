import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import vm from 'node:vm';
import NetplayClient from '../client/netplay-client.mjs';
import { startDevServer } from '../server/dev-server.js';
import relayGame from '../examples/relay-game.js';
import turnGame from '../examples/turn-game.js';

// 条件を満たすまで待つ
async function waitFor(check, timeout = 2000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
        if (check()) return;
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('待ちきれませんでした');
}

// 届いたメッセージを type ごとに記録する
function record(client, types) {
    const log = [];
    types.forEach(type => client.on(type, message => log.push({ type, message })));
    return log;
}

describe('NetplayClient（手元のテスト用サーバーにつなぐ）', () => {
    let dev;
    let url;

    beforeAll(() => {
        const port = 18787 + Math.floor(Math.random() * 1000);
        dev = startDevServer(relayGame, { port, log: () => {} });
        url = `ws://localhost:${port}`;
    });
    afterAll(() => dev.close());

    it('部屋を作って参加し、対戦の開始・中継・時計の補正・退出ができる', async () => {
        const a = new NetplayClient({ serverUrl: url, storageKey: 'test.a' });
        const b = new NetplayClient({ serverUrl: url, storageKey: 'test.b' });
        const logA = record(a, ['joined', 'lobby', 'state', 'pong']);
        const logB = record(b, ['joined', 'lobby', 'state', 'relay', 'left']);

        await a.createRoom('あお');
        await waitFor(() => a.lobby);
        expect(a.isHost()).toBe(true);
        expect(logA.filter(entry => entry.type !== 'pong').map(entry => entry.type)).toEqual(['joined', 'lobby']);

        await b.joinRoom(a.lobby.roomCode, 'みどり');
        await waitFor(() => a.lobby.players.length === 2 && b.lobby);
        expect(b.seat).toBe(1);
        expect(b.isHost()).toBe(false);

        a.start();
        await waitFor(() => logB.some(entry => entry.type === 'state'));
        expect(b.matchId).toBe(1);

        a.send('relay', { kind: 'attack', data: { lines: 3 } });
        await waitFor(() => logB.some(entry => entry.type === 'relay'));
        expect(logB.find(entry => entry.type === 'relay').message.data).toEqual({ lines: 3 });

        // 接続したときの ping の返事で、時計のずれを直している
        await waitFor(() => logA.some(entry => entry.type === 'pong'));
        expect(Math.abs(a.serverNow() - Date.now())).toBeLessThan(100);

        b.leave();
        await waitFor(() => logB.some(entry => entry.type === 'left'));
        expect(b.session).toBeNull();
        expect(b.isInRoom()).toBe(false);
        await waitFor(() => a.lobby.status === 'ended');
        a.close();
    });

    it('lobby・state がしばらく届かなければ、版を添えた ping で取りこぼした分を取り直す', async () => {
        const a = new NetplayClient({ serverUrl: url, storageKey: 'test.sync', syncIdleMs: 50 });
        const pings = [];
        const request = a.request.bind(a);
        a.request = (message) => {
            if (message.action === 'ping') pings.push(message);
            return request(message);
        };
        const lobbies = record(a, ['lobby']);
        await a.createRoom('あお');
        await waitFor(() => a.lobby);
        const version = a.lastVersion;
        await waitFor(() => pings.some(ping => ping.version === version));
        await new Promise(resolve => setTimeout(resolve, 150));
        expect(lobbies).toHaveLength(1);   // 版が同じなら送り直さない

        a.lastVersion = version - 1;       // 最後の lobby を取りこぼしたことにする
        await waitFor(() => lobbies.length === 2);
        expect(lobbies[1].message.version).toBe(version);
        a.close();
    });

    it('接続が切れたら、同じ席に自動でつなぎ直す', async () => {
        const a = new NetplayClient({ serverUrl: url, storageKey: 'test.c', reconnectDelayMs: 50 });
        const connection = [];
        a.on('connection', connected => connection.push(connected));
        await a.createRoom('あお');
        await waitFor(() => a.lobby);
        const token = a.session.token;

        a.socket.close();
        await waitFor(() => connection.length >= 3 && a.isOpen());
        await waitFor(() => a.lobby?.players[0].connected);
        expect(connection).toEqual([true, false, true]);
        expect(a.session.token).toBe(token);
        expect(a.seat).toBe(0);
        a.close();
    });

    it('部屋が消えていたら、保存した参加情報を消す', async () => {
        const a = new NetplayClient({ serverUrl: url, storageKey: 'test.d' });
        a.session = { roomCode: '99999', token: 'old', seat: 0 };
        const errors = record(a, ['error']);
        await a.resume();
        await waitFor(() => errors.length > 0);
        expect(errors[0].message.code).toBe('room_not_found');
        expect(a.session).toBeNull();
        a.close();
    });

    it('enterRoom は、参加できたら resolve し、断られたらコード付きで reject する', async () => {
        const a = new NetplayClient({ serverUrl: url, storageKey: 'test.e' });
        const b = new NetplayClient({ serverUrl: url, storageKey: 'test.f' });
        await a.createRoom('あお');
        await waitFor(() => a.lobby);

        const joined = await b.enterRoom(a.lobby.roomCode, 'みどり');
        expect(joined.seat).toBe(1);

        const c = new NetplayClient({ serverUrl: url, storageKey: 'test.g' });
        const error = await c.enterRoom('0000', 'きいろ').catch(e => e);
        expect([error.code, error.fromServer]).toEqual(['room_not_found', true]);

        const offline = new NetplayClient({ serverUrl: 'ws://localhost:1', storageKey: 'test.h' });
        const failed = await offline.enterRoom('0000', 'きいろ').catch(e => e);
        expect([failed.code, failed.fromServer]).toEqual(['not_connected', false]);
        [a, b, c, offline].forEach(client => client.close());
    });

    it('招待URLで開いたら joinFromInvite で入り、断られたときと退出したときは URL から部屋番号を外す', async () => {
        const saved = { location: globalThis.location, history: globalThis.history };
        const open = (href) => { globalThis.location = new URL(href); };
        globalThis.history = { state: null, replaceState: (state, title, next) => open(String(next)) };
        try {
            const host = new NetplayClient({ serverUrl: url, storageKey: 'test.i' });
            await host.createRoom('あお');
            await waitFor(() => host.lobby);
            const guest = new NetplayClient({ serverUrl: url, storageKey: 'test.j' });

            open('http://localhost/?server=x');
            expect(await guest.joinFromInvite('みどり')).toBeNull();

            open('http://localhost/?server=x&room=0000');
            const error = await guest.joinFromInvite('みどり').catch(e => e);
            expect(error.code).toBe('room_not_found');
            expect(location.search).toBe('?server=x');

            open(`http://localhost/?server=x&room=${host.lobby.roomCode}`);
            expect((await guest.joinFromInvite('みどり')).roomCode).toBe(host.lobby.roomCode);
            guest.leave();
            expect(location.search).toBe('?server=x');
            host.close();
        } finally {
            globalThis.location = saved.location;
            globalThis.history = saved.history;
        }
    });
});

describe('NetplayClient の CPU の手の見せ方', () => {
    it('cpu: true の state は、1通ずつ別々に届いても間を置いて順に届く', async () => {
        const port = 19787 + Math.floor(Math.random() * 1000);
        const dev = startDevServer(turnGame, { port, log: () => {} });
        const a = new NetplayClient({ serverUrl: `ws://localhost:${port}`, storageKey: 'test.e', cpuStepDelayMs: 40 });
        const times = [];
        a.on('state', message => times.push({ at: Date.now(), cpu: Boolean(message.cpu) }));

        await a.createRoom('あお');
        await waitFor(() => a.lobby);
        a.addCpu();
        a.addCpu();
        await waitFor(() => a.lobby.players.length === 3);
        a.start();
        await waitFor(() => times.length === 1);
        a.send('command', { command: { type: 'add', amount: 1 } });
        await waitFor(() => times.length === 4);
        expect(times.slice(1).map(t => t.cpu)).toEqual([false, true, true]);
        expect(times[3].at - times[2].at).toBeGreaterThanOrEqual(35);

        a.close();
        await dev.close();
    });
});

describe('NetplayClient の届く順番', () => {
    it('CPU の手を見せているあいだに届いた部屋の状態（ended）は、最後のビューのあとに知らせる', async () => {
        const net = new NetplayClient({ storageKey: 'test.order', cpuStepDelayMs: 30 });
        const order = [];
        net.on('state', message => order.push(`state:${message.view.step}`));
        net.on('lobby', message => order.push(`lobby:${message.status}`));
        net.receive({ type: 'lobby', status: 'playing', matchId: 1, seat: 0, hostSeat: 0 });
        net.receive({ type: 'state', matchId: 1, view: { step: 1 } });
        net.receive({ type: 'state', matchId: 1, view: { step: 2 }, cpu: true });
        net.receive({ type: 'state', matchId: 1, view: { step: 3 }, cpu: true });
        net.receive({ type: 'lobby', status: 'ended', matchId: 1, seat: 0, hostSeat: 0 });
        expect(net.lobby.status).toBe('playing');
        await waitFor(() => order.length === 5);
        expect(order).toEqual(['lobby:playing', 'state:1', 'state:2', 'state:3', 'lobby:ended']);
        expect(net.lobby.status).toBe('ended');
    });

    it('前に受け取ったものより古い版の state・lobby は捨て、同じ版は受け取る', () => {
        const net = new NetplayClient({ storageKey: 'test.version' });
        const order = [];
        net.on('state', message => order.push(`state:${message.version}`));
        net.on('lobby', message => order.push(`lobby:${message.version}`));
        net.receive({ type: 'lobby', status: 'playing', matchId: 1, seat: 0, hostSeat: 0, version: 3 });
        net.receive({ type: 'state', matchId: 1, view: {}, version: 5 });
        net.receive({ type: 'state', matchId: 1, view: {}, version: 4 });   // 後から届いた古いビュー
        net.receive({ type: 'lobby', status: 'playing', matchId: 1, seat: 0, hostSeat: 0, version: 4 });
        net.receive({ type: 'state', matchId: 1, view: {}, version: 5 });   // 同じ版（断られた操作の返事など）
        net.receive({ type: 'state', matchId: 1, view: {}, version: 6 });
        net.receive({ type: 'state', matchId: 1, view: {} });               // 版のない古いサーバー
        expect(order).toEqual(['lobby:3', 'state:5', 'state:5', 'state:6', 'state:undefined']);

        // 部屋に入り直したら、版を数え直す
        net.receive({ type: 'joined', roomCode: '1234', seat: 0, token: 't' });
        net.receive({ type: 'lobby', status: 'lobby', matchId: 0, seat: 0, hostSeat: 0, version: 1 });
        expect(order.at(-1)).toBe('lobby:1');
        net.close();
    });

    it('cpuStepDelayMs に関数を渡すと、CPU の手ごとに間を変えられる（1手に1回だけ呼ぶ）', async () => {
        const calls = [];
        const net = new NetplayClient({
            storageKey: 'test.delayFn',
            cpuStepDelayMs: (next, previous) => {
                calls.push([next.view.step, previous?.view.step ?? null]);
                return next.view.step === 2 ? 80 : 0;
            }
        });
        const shown = [];
        net.on('state', message => shown.push({ step: message.view.step, at: Date.now() }));
        net.receive({ type: 'state', matchId: 1, view: { step: 0 } });
        net.receive({ type: 'state', matchId: 1, view: { step: 1 }, cpu: true });
        net.receive({ type: 'state', matchId: 1, view: { step: 2 }, cpu: true });
        expect(shown.map(s => s.step)).toEqual([0, 1]);
        await waitFor(() => shown.length === 3);
        expect(shown[2].at - shown[1].at).toBeGreaterThanOrEqual(75);
        expect(calls).toEqual([[1, 0], [2, 1]]);
        net.close();
    });

    it('ロビーに戻ったら、まだ見せていない前の対戦のビューを捨てる', () => {
        const net = new NetplayClient({ storageKey: 'test.order2', cpuStepDelayMs: 1000 });
        const order = [];
        net.on('state', () => order.push('state'));
        net.on('lobby', message => order.push(`lobby:${message.status}`));
        net.receive({ type: 'state', matchId: 1, view: {} });
        net.receive({ type: 'state', matchId: 1, view: {}, cpu: true });
        net.receive({ type: 'lobby', status: 'lobby', matchId: 1, seat: 0, hostSeat: 0 });
        expect(order).toEqual(['state', 'lobby:lobby']);
        expect(net.stateQueue).toEqual([]);
        net.close();
    });
});

describe('部屋番号の形', () => {
    it('招待URLの部屋番号は、数字4桁のときだけ返す', () => {
        const saved = globalThis.location;
        try {
            globalThis.location = new URL('http://localhost/?room=%201234%20');
            expect(NetplayClient.inviteRoomCode()).toBe('1234');
            globalThis.location = new URL('http://localhost/?room=12a4');
            expect(NetplayClient.inviteRoomCode()).toBeNull();
            globalThis.location = new URL('http://localhost/');
            expect(NetplayClient.inviteRoomCode()).toBeNull();
        } finally {
            globalThis.location = saved;
        }
    });

    it('数字4桁だけを部屋番号として受け付け、前後の空白は無視する', () => {
        expect(NetplayClient.ROOM_CODE_LENGTH).toBe(4);
        expect(NetplayClient.isRoomCode('0123')).toBe(true);
        expect(NetplayClient.isRoomCode(' 4567 ')).toBe(true);
        expect(['123', '12345', '12a4', '', null, undefined].some(code => NetplayClient.isRoomCode(code))).toBe(false);
    });
});

describe('招待URL', () => {
    it('部屋番号を入れ、接続先の ?server= は残し、ほかの項目は外す', () => {
        const saved = globalThis.location;
        globalThis.location = new URL('http://localhost:8089/game/?server=ws%3A%2F%2Flocalhost%3A8788&seed=5&room=11111#top');
        try {
            const net = new NetplayClient({ storageKey: 'test.invite' });
            const url = new URL(net.inviteUrl('12345'));
            expect(url.pathname).toBe('/game/');
            expect(url.searchParams.get('room')).toBe('12345');
            expect(url.searchParams.get('server')).toBe('ws://localhost:8788');
            expect(url.searchParams.has('seed')).toBe(false);
            expect(url.hash).toBe('');
        } finally {
            globalThis.location = saved;
        }
    });
});

describe('読み込み方', () => {
    it('普通の <script> として読んでも（モジュールでなくても）NetplayClient が置かれる', () => {
        const code = fs.readFileSync(new URL('../client/netplay-client.js', import.meta.url), 'utf8');
        const context = vm.createContext({});
        vm.runInContext(code, context);
        expect(typeof context.NetplayClient).toBe('function');
        expect(Object.keys(context)).toEqual(['NetplayClient']);
    });
});
