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

    // 新しい部屋（previousVersion が 0）は、同じ番号の部屋がないか、あっても期限を過ぎているときだけ作る
    async putRoom(room, previousVersion, nowSeconds = Math.floor(Date.now() / 1000)) {
        const current = this.rooms.get(room.code);
        const expired = current?.expiresAt !== undefined && current.expiresAt <= nowSeconds;
        const currentVersion = !current || (previousVersion === 0 && expired) ? 0 : current.version;
        if (currentVersion !== previousVersion) {
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
