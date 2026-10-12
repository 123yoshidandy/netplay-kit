/**
 * 手元で使う保存先（テストと手元のテスト用サーバー用）
 * DynamoDB の保存先と同じ形で、部屋の版が違えば ConflictError を投げる
 */

import { ConflictError } from './room-service.js';

const clone = (value) => (value === undefined ? undefined : structuredClone(value));

export class MemoryStore {
    constructor() {
        this.rooms = new Map();
        this.connections = new Map();
        this.reads = 0;  // 読み込みの回数（テストで、中継のたびの読み込みを確かめるため）
        this.writes = 0;
    }

    async getRoom(code) {
        this.reads++;
        return clone(this.rooms.get(code)) ?? null;
    }

    async putRoom(room, previousVersion) {
        const current = this.rooms.get(room.code);
        if ((current?.version ?? 0) !== previousVersion) {
            throw new ConflictError();
        }
        this.writes++;
        this.rooms.set(room.code, clone(room));
    }

    async getConnection(connectionId) {
        this.reads++;
        return clone(this.connections.get(connectionId)) ?? null;
    }

    async putConnection(connection) {
        this.writes++;
        this.connections.set(connection.connectionId, clone(connection));
    }

    async deleteConnection(connectionId) {
        this.connections.delete(connectionId);
    }
}
