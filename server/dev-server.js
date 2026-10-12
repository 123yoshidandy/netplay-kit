/**
 * 手元でオンライン対戦を試すための WebSocket サーバー（AWS と同じ部屋の処理を、保存先をメモリにして動かす）
 *
 * 使い方（各ゲームの server/dev-server.js）:
 *   import { startDevServer } from './netplay/dev-server.js';
 *   import game from './src/game-definition.js';
 *   startDevServer(game);
 * npm run dev:server で起動し、画面は別に python3 -m http.server などで配信する
 */

import { WebSocketServer } from 'ws';
import { RoomService } from './room-service.js';
import { MemoryStore } from './memory-store.js';

export function startDevServer(game, { port = Number(process.env.PORT ?? 8787), log = console.log } = {}) {
    const sockets = new Map();
    let connectionCount = 0;

    const service = new RoomService({
        game,
        store: new MemoryStore(),
        send: async (connectionId, message) => {
            const socket = sockets.get(connectionId);
            if (!socket || socket.readyState !== socket.OPEN) throw new Error('接続が切れています');
            socket.send(JSON.stringify(message));
        }
    });

    const server = new WebSocketServer({ port });
    server.on('connection', (socket) => {
        const connectionId = `local-${++connectionCount}`;
        sockets.set(connectionId, socket);

        socket.on('message', (data) => {
            service.handleRaw(connectionId, String(data)).catch(error => console.error(error));
        });
        socket.on('close', () => {
            sockets.delete(connectionId);
            service.disconnect(connectionId).catch(error => console.error(error));
        });
    });

    log(`オンライン対戦のテスト用サーバー: ws://localhost:${port}`);
    // 止めるときは、残っている接続も切る
    const close = () => new Promise(resolve => {
        server.clients.forEach(socket => socket.terminate());
        server.close(resolve);
    });
    return { server, service, close };
}
