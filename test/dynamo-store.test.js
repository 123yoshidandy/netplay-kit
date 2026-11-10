import { describe, it, expect, vi } from 'vitest';

// AWS SDK は Lambda の側にあり、手元には入れていないので、送る命令の中身だけを持つものに差し替える
vi.mock('@aws-sdk/client-dynamodb', () => ({
    DynamoDBClient: class {},
    ConditionalCheckFailedException: class extends Error {}
}));
vi.mock('@aws-sdk/lib-dynamodb', () => {
    const command = (name) => class { constructor(input) { this.name = name; this.input = input; } };
    return {
        DynamoDBDocumentClient: { from: () => null },
        GetCommand: command('Get'), PutCommand: command('Put'), DeleteCommand: command('Delete'), ScanCommand: command('Scan')
    };
});

const { DynamoStore } = await import('../server/dynamo-store.js');

// pages を順に返すクライアント（送られた命令を sent に残す）
function fakeClient(pages) {
    const sent = [];
    return {
        sent,
        async send(command) {
            sent.push(command);
            return pages[sent.length - 1] ?? { Items: [] };
        }
    };
}

describe('DynamoStore の公開の部屋の一覧', () => {
    it('公開・ロビー・期限内の部屋だけを Scan で絞り、一覧に要る項目だけを読む', async () => {
        const client = fakeClient([{ Items: [{ code: '1234' }] }]);
        const rooms = await new DynamoStore('rooms', client).listPublicRooms(1000);

        expect(rooms).toEqual([{ code: '1234' }]);
        const [{ name, input }] = client.sent;
        expect(name).toBe('Scan');
        expect(input.TableName).toBe('rooms');
        expect(input.FilterExpression).toBe('begins_with(pk, :room) AND #isPublic = :true AND #status = :lobby AND #expiresAt > :now');
        expect(input.ExpressionAttributeValues).toEqual({ ':room': 'ROOM#', ':true': true, ':lobby': 'lobby', ':now': 1000 });
        expect(Object.values(input.ExpressionAttributeNames).sort())
            .toEqual(['code', 'createdAt', 'expiresAt', 'isPublic', 'players', 'settings', 'status']);
        expect(input.ExclusiveStartKey).toBeUndefined();
    });

    it('続きのページがあれば、続きから読んでつなげる', async () => {
        const client = fakeClient([
            { Items: [{ code: '1111' }], LastEvaluatedKey: { pk: 'ROOM#1111' } },
            { Items: [], LastEvaluatedKey: { pk: 'CONN#a' } },
            { Items: [{ code: '2222' }] }
        ]);
        const rooms = await new DynamoStore('rooms', client).listPublicRooms(1000);

        expect(rooms.map(room => room.code)).toEqual(['1111', '2222']);
        expect(client.sent.map(command => command.input.ExclusiveStartKey))
            .toEqual([undefined, { pk: 'ROOM#1111' }, { pk: 'CONN#a' }]);
    });

    it('読むページは10までで止める（テーブルが大きくなっても、1回の一覧で読みすぎない）', async () => {
        const client = fakeClient(Array.from({ length: 20 }, (_, i) => ({ Items: [{ code: String(i) }], LastEvaluatedKey: { pk: `ROOM#${i}` } })));
        const rooms = await new DynamoStore('rooms', client).listPublicRooms(1000);

        expect(client.sent).toHaveLength(10);
        expect(rooms).toHaveLength(10);
    });
});
