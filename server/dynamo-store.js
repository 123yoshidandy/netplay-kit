/**
 * DynamoDB の保存先
 * 1つのテーブルに、部屋（pk = ROOM#部屋番号）と接続（pk = CONN#接続ID）を入れる
 * 接続には部屋番号だけを持ち、席番号は持たない（席は部屋の players から connectionId で求める）
 * どちらも expiresAt（UNIX秒）を過ぎると DynamoDB の TTL で自動的に消える
 */

import { DynamoDBClient, ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { ConflictError } from './room-service.js';

export class DynamoStore {
    constructor(tableName, client = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
        marshallOptions: { removeUndefinedValues: true }
    })) {
        this.tableName = tableName;
        this.client = client;
    }

    // 強い整合性で読む（既定の結果整合性では、保存した直後に1つ前の部屋が返ることがあり、古い部屋で操作を判定してしまう）
    async getItem(pk) {
        const { Item } = await this.client.send(new GetCommand({ TableName: this.tableName, Key: { pk }, ConsistentRead: true }));
        if (!Item) return null;
        const { pk: _pk, ...data } = Item;
        return data;
    }

    async getRoom(code) {
        return this.getItem(`ROOM#${code}`);
    }

    // 読み込んだときの版のままなら保存する
    // 新しい部屋は、同じ番号の部屋がないか、あっても期限（nowSeconds）を過ぎているときだけ作る
    async putRoom(room, previousVersion, nowSeconds = Math.floor(Date.now() / 1000)) {
        const condition = previousVersion === 0
            ? {
                ConditionExpression: 'attribute_not_exists(pk) OR expiresAt <= :now',
                ExpressionAttributeValues: { ':now': nowSeconds }
            }
            : { ConditionExpression: 'version = :previous', ExpressionAttributeValues: { ':previous': previousVersion } };
        try {
            await this.client.send(new PutCommand({
                TableName: this.tableName,
                Item: { pk: `ROOM#${room.code}`, ...room },
                ...condition
            }));
        } catch (error) {
            if (error instanceof ConditionalCheckFailedException || error.name === 'ConditionalCheckFailedException') {
                throw new ConflictError();
            }
            throw error;
        }
    }

    async getConnection(connectionId) {
        return this.getItem(`CONN#${connectionId}`);
    }

    async putConnection(connection) {
        await this.client.send(new PutCommand({
            TableName: this.tableName,
            Item: { pk: `CONN#${connection.connectionId}`, ...connection }
        }));
    }

    async deleteConnection(connectionId) {
        await this.client.send(new DeleteCommand({ TableName: this.tableName, Key: { pk: `CONN#${connectionId}` } }));
    }
}
