/**
 * テストの道具：メモリの保存先と、時刻・乱数を固定した部屋の処理を作り、N人分の接続をまねる
 *
 * 使い方（Vitest）:
 *   const server = createTestServer(game);
 *   const [a, b] = await server.createRoom(['あお', 'みどり']);
 *   await a.send('start');
 *   expect(b.last('state').view).toEqual(...);
 */

import { RoomService } from './room-service.js';
import { MemoryStore } from './memory-store.js';

// 決まった順の乱数（同じテストは毎回同じ結果になる）
export function createSeededRandom(seed = 1) {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6D2B79F5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// options の store などは、RoomService にそのまま渡す（保存がぶつかる場合を試すときなど）
export function createTestServer(game, { now = 1_000_000, seed = 1, store = new MemoryStore(), ...options } = {}) {
    const clock = { now };
    const inboxes = new Map();
    let tokenCount = 0;
    const service = new RoomService({
        game,
        store,
        send: async (connectionId, message) => {
            const inbox = inboxes.get(connectionId);
            if (!inbox || inbox.closed) throw new Error('接続が切れています');
            inbox.messages.push(message);
        },
        createToken: () => `token-${++tokenCount}`,
        now: () => clock.now,
        random: createSeededRandom(seed),
        ...options
    });

    // 1つの接続（端末）をまねる
    const connect = (connectionId) => {
        const inbox = { messages: [], closed: false };
        inboxes.set(connectionId, inbox);
        return {
            id: connectionId,
            get messages() { return inbox.messages; },
            send: (action, payload = {}) => service.handle(connectionId, { action, ...payload }),
            sendRaw: (raw) => service.handleRaw(connectionId, raw),
            disconnect: async () => {
                inbox.closed = true;
                await service.disconnect(connectionId);
            },
            last: (type) => [...inbox.messages].reverse().find(message => message.type === type),
            all: (type) => inbox.messages.filter(message => message.type === type),
            clear: () => { inbox.messages.length = 0; }
        };
    };

    let connectionCount = 0;
    const server = {
        service,
        store,
        clock,
        connect: (connectionId = `c${connectionCount++}`) => connect(connectionId),

        // 部屋を作り、ほかの人を参加させる。各人の接続を席の順に返す
        async createRoom(names) {
            const host = server.connect();
            await host.send('create', { name: names[0] });
            const code = host.last('joined')?.roomCode;
            const clients = [host];
            for (const name of names.slice(1)) {
                const client = server.connect();
                await client.send('join', { roomCode: code, name });
                clients.push(client);
            }
            clients.code = code;
            return clients;
        },

        // 同じ席に、新しい接続でつなぎ直す
        async reconnect(client) {
            const joined = client.last('joined');
            await client.disconnect();
            const next = server.connect();
            await next.send('join', { roomCode: joined.roomCode, token: joined.token });
            return next;
        }
    };
    return server;
}
