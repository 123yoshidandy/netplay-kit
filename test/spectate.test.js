import { describe, it, expect } from 'vitest';
import { createTestServer } from '../server/testing.js';
import turnGame from '../examples/turn-game.js';
import raceGame from '../examples/race-game.js';
import relayGame from '../examples/relay-game.js';

// 2人で始めた対戦（サンプル①）と、観戦者の接続
async function playing({ isPublic = false, names = ['A', 'B'] } = {}) {
    const server = createTestServer(turnGame);
    const host = server.connect();
    await host.send('create', { name: names[0], public: isPublic });
    const code = host.last('joined').roomCode;
    const clients = [host];
    for (const name of names.slice(1)) {
        const client = server.connect();
        await client.send('join', { roomCode: code, name });
        clients.push(client);
    }
    await host.send('start');
    return { server, clients, code };
}

const spectate = async (server, code, name = '見る人', extra = {}) => {
    const watcher = server.connect();
    await watcher.send('join', { roomCode: code, name, spectate: true, ...extra });
    return watcher;
};

// 手番の人が1を足す
async function play(clients) {
    const current = clients[0].last('state').view.current;
    await clients[current].send('command', { command: { type: 'add', amount: 1 } });
}

describe('観戦', () => {
    it('対戦中の部屋に部屋番号から観戦で入ると、joined → lobby → 観戦者用のビューが届く。席は持たない', async () => {
        const { server, clients, code } = await playing();
        await play(clients);
        const watcher = await spectate(server, code);

        expect(watcher.messages.map(m => m.type)).toEqual(['joined', 'lobby', 'state']);
        const joined = watcher.last('joined');
        expect(joined).toMatchObject({ roomCode: code, seat: null, spectator: true });
        expect(joined.token).toBeTruthy();
        expect(watcher.last('lobby')).toMatchObject({ seat: null, spectator: true, status: 'playing' });
        // 観戦者用のビュー：ひみつの数（手札にあたるもの）は誰のものも入らない
        const view = watcher.last('state').view;
        expect(view.total).toBe(1);
        expect(view.secret).toBeUndefined();
        expect(JSON.stringify(view)).not.toContain('secret');
        // 参加者には、観戦者が増えたことだけが届く（席や人数は変わらない）
        const lobby = clients[0].last('lobby');
        expect(lobby.players).toHaveLength(2);
        expect(lobby.spectators).toEqual([{ id: joined.playerId, name: '見る人', connected: true }]);
    });

    it('人数の上限に数えない（満員の部屋でも観戦できる）', async () => {
        const { server, code } = await playing({ names: ['A', 'B', 'C', 'D'] });
        const late = server.connect();
        await late.send('join', { roomCode: code, name: 'E' });
        expect(late.last('error').code).toBe('already_started');
        const watcher = await spectate(server, code);
        expect(watcher.last('joined').spectator).toBe(true);
    });

    it('観戦者は操作を送れない（code: spectator）。スタンプは送れて、参加者と観戦者に届く', async () => {
        const { server, clients, code } = await playing();
        const watcher = await spectate(server, code, 'みどり');
        await watcher.send('command', { command: { type: 'add', amount: 1 } });
        expect(watcher.last('error').code).toBe('spectator');
        await watcher.send('start');
        expect(watcher.last('error').code).toBe('spectator');
        expect(clients[0].last('state').view.total).toBe(0);

        await watcher.send('stamp', { stamp: '👍' });
        expect(clients[1].last('stamp')).toMatchObject({ seat: null, stamp: '👍', spectator: { name: 'みどり' } });
        expect(watcher.last('stamp').stamp).toBe('👍');
        await clients[0].send('stamp', { stamp: '😮' });
        expect(watcher.last('stamp')).toMatchObject({ seat: 0, stamp: '😮' });
    });

    it('操作や CPU の手のたびに、観戦者にもビューが届く', async () => {
        const server = createTestServer(turnGame);
        const host = server.connect();
        await host.send('create', { name: 'A' });
        await host.send('addCpu');
        await host.send('start');
        const code = host.last('joined').roomCode;
        const watcher = await spectate(server, code);
        watcher.clear();
        await host.send('command', { command: { type: 'add', amount: 2 } });
        const states = watcher.all('state');
        // 自分の手と、続く CPU の手（cpu: true）
        expect(states.length).toBe(2);
        expect(states[1].cpu).toBe(true);
        expect(states.at(-1).view.total).toBe(host.last('state').view.total);
    });

    it('観戦者の上限は、つながっている人の数で数える。切れた観戦者は、満ちたときに古い順に外す', async () => {
        const { server, code } = await playing();
        const watchers = [];
        for (let i = 0; i < turnGame.maxSpectators; i++) watchers.push(await spectate(server, code, `W${i}`));
        const extra = await spectate(server, code, 'あふれ');
        expect(extra.last('error').code).toBe('spectators_full');

        await watchers[0].disconnect();
        const again = await spectate(server, code, 'あふれ');
        expect(again.last('joined').spectator).toBe(true);
        expect(again.last('lobby').spectators.map(s => s.name)).toEqual(['W1', 'W2', 'W3', 'W4', 'あふれ']);
    });

    it('切れても token で観戦者として戻り、今のビューが届く。部屋を出ると一覧から外れる', async () => {
        const { server, clients, code } = await playing();
        const watcher = await spectate(server, code);
        const { token } = watcher.last('joined');
        await watcher.disconnect();
        expect(clients[0].last('lobby').spectators[0].connected).toBe(false);
        await play(clients);

        const back = server.connect();
        await back.send('join', { roomCode: code, token });
        expect(back.last('joined')).toMatchObject({ seat: null, spectator: true, token });
        expect(back.last('state').view.total).toBe(1);
        expect(clients[0].last('lobby').spectators[0].connected).toBe(true);

        await back.send('leave');
        expect(back.last('left')).toBeTruthy();
        expect(clients[0].last('lobby').spectators).toEqual([]);
    });

    it('取りこぼしたら、版を添えた ping で今の lobby とビューを取り直せる', async () => {
        const { server, clients, code } = await playing();
        const watcher = await spectate(server, code);
        const version = watcher.last('state').version;
        await play(clients);
        watcher.clear();
        await watcher.send('ping', { clientTime: 0, version });
        expect(watcher.messages.map(m => m.type)).toEqual(['pong', 'lobby', 'state']);
        expect(watcher.last('state').view.total).toBe(1);
    });

    it('試合が終わると、最後のビュー → 対戦後の lobby の順で届き、観戦は続く。再戦も見られる', async () => {
        const { server, clients, code } = await playing();
        const watcher = await spectate(server, code);
        while (clients[0].last('lobby').status === 'playing') {
            const current = clients[0].last('state').view.current;
            await clients[current].send('command', { command: { type: 'add', amount: 3 } });
        }
        const tail = watcher.messages.filter(m => ['lobby', 'state'].includes(m.type)).slice(-2);
        expect(tail.map(m => m.type)).toEqual(['state', 'lobby']);
        expect(tail[0].view.loser).not.toBeNull();
        expect(tail[1].status).toBe('ended');

        await clients[0].send('start');
        expect(watcher.last('lobby').status).toBe('playing');
        expect(watcher.last('state').matchId).toBe(2);
        expect(watcher.last('state').view.total).toBe(0);
    });

    it('ロビーでも観戦で入れる（始まったら、そのまま観戦者用のビューが届く）', async () => {
        const server = createTestServer(turnGame);
        const [a] = await server.createRoom(['A', 'B']);
        const watcher = await spectate(server, a.last('joined').roomCode);
        expect(watcher.messages.map(m => m.type)).toEqual(['joined', 'lobby']);
        await a.send('start');
        expect(watcher.last('state').view.total).toBe(0);
        expect(a.last('lobby').players).toHaveLength(2);
    });

    it('観戦できる公開の部屋の一覧：対戦中の公開の部屋だけ、観戦者の数つきで載る', async () => {
        const { server, code } = await playing({ isPublic: true });
        // 同じサーバーの、対戦中の非公開の部屋は載らない
        const secret = server.connect();
        await secret.send('create', { name: 'ひみつ' });
        await secret.send('addCpu');
        await secret.send('start');
        expect(secret.last('lobby').status).toBe('playing');
        const waiting = server.connect();
        await waiting.send('create', { name: 'まつ', public: true });
        await spectate(server, code);

        const finder = server.connect();
        await finder.send('listRooms', { spectate: true });
        expect(finder.last('rooms')).toMatchObject({ spectate: true });
        expect(finder.last('rooms').rooms).toEqual([expect.objectContaining({
            roomCode: code, hostName: 'A', players: 2, spectators: 1, maxSpectators: turnGame.maxSpectators
        })]);
        // ふだんの一覧（参加者の募集）には、対戦中の部屋は載らない
        await finder.send('listRooms');
        expect(finder.last('rooms').rooms.map(room => room.hostName)).toEqual(['まつ']);
    });

    it('観戦を有効にしていないゲームでは、観戦を断り、観戦の一覧も空', async () => {
        const server = createTestServer(raceGame);
        const [a] = await server.createRoom(['A', 'B']);
        await a.send('start');
        const watcher = await spectate(server, a.last('joined').roomCode);
        expect(watcher.last('error').code).toBe('spectate_unavailable');
        await watcher.send('listRooms', { spectate: true });
        expect(watcher.last('rooms').rooms).toEqual([]);
        expect(a.last('lobby').spectators).toEqual([]);
    });

    it('ゲームの定義は toSpectators・broadcast({ spectators: true }) で観戦者にも独自のメッセージを送れる（中継型）', async () => {
        const game = {
            ...relayGame,
            maxSpectators: 2,
            spectatorView: undefined,
            actions: {
                ...relayGame.actions,
                relay: {
                    readOnly: true,
                    handle({ message, opponents, toSeat, toSpectators, seat }) {
                        opponents().forEach(opponent => toSeat(opponent, { type: 'relay', kind: message.kind, from: seat }));
                        toSpectators({ type: 'relay', kind: message.kind, from: seat });
                    }
                },
                shout: { readOnly: true, handle: ({ broadcast }) => broadcast({ type: 'shout' }, { spectators: true }) }
            }
        };
        const server = createTestServer(game);
        const [a, b] = await server.createRoom(['A', 'B']);
        await a.send('ready');
        await b.send('ready');
        const watcher = await spectate(server, a.last('joined').roomCode);
        // spectatorView のないゲームでは、観戦者に state は送らない
        expect(watcher.all('state')).toEqual([]);
        await a.send('relay', { kind: 'snapshot', matchId: 1 });
        expect(watcher.last('relay')).toMatchObject({ kind: 'snapshot', from: 0 });
        await b.send('shout', { matchId: 1 });
        expect(watcher.last('shout')).toBeTruthy();
        expect(a.last('shout')).toBeTruthy();
    });

    it('観戦を入れる前に作られた部屋（spectators がない）にも観戦で入れる', async () => {
        const { server, code } = await playing();
        const stored = server.store.rooms.get(code);
        delete stored.spectators;
        const watcher = await spectate(server, code);
        expect(watcher.last('joined').spectator).toBe(true);
    });
});
