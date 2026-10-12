/**
 * API Gateway（WebSocket）から呼ばれる Lambda の入口を作る
 * $connect は受け付けるだけ、$disconnect で切断を片付け、それ以外のメッセージは部屋の処理に渡す
 *
 * 使い方（各ゲームの server/src/handler.js）:
 *   import { createHandler } from '../netplay/handler.js';
 *   import game from './game-definition.js';
 *   export const handler = createHandler(game);
 */

import { ApiGatewayManagementApiClient, PostToConnectionCommand } from '@aws-sdk/client-apigatewaymanagementapi';
import { RoomService, RateLimiter } from './room-service.js';
import { DynamoStore } from './dynamo-store.js';

export function createHandler(game, { tableName = process.env.TABLE_NAME } = {}) {
    // 以下は Lambda の呼び出しをまたいで使い回す
    const store = new DynamoStore(tableName);
    const clients = new Map();          // 送信用のクライアント
    const connectionCache = new Map();  // 接続→部屋番号
    const limiter = new RateLimiter({ perSecond: game.messagesPerSecond ?? 10, burst: game.messagesBurst ?? 20 });

    const createService = ({ domainName, stage }) => {
        const endpoint = `https://${domainName}/${stage}`;
        if (!clients.has(endpoint)) {
            clients.set(endpoint, new ApiGatewayManagementApiClient({ endpoint }));
        }
        const client = clients.get(endpoint);
        const send = (connectionId, message) => client.send(new PostToConnectionCommand({
            ConnectionId: connectionId,
            Data: JSON.stringify(message)
        }));
        return new RoomService({ game, store, send, connectionCache, limiter });
    };

    return async (event) => {
        const { routeKey, connectionId } = event.requestContext;
        const service = createService(event.requestContext);

        if (routeKey === '$connect') {
            return { statusCode: 200 };
        }
        if (routeKey === '$disconnect') {
            await service.disconnect(connectionId);
            return { statusCode: 200 };
        }
        await service.handleRaw(connectionId, event.body ?? '');
        return { statusCode: 200 };
    };
}
