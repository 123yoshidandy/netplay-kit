import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main } from '../scripts/sync.mjs';

describe('同期の仕組み', () => {
    let repo;

    beforeEach(() => {
        repo = fs.mkdtempSync(path.join(os.tmpdir(), 'netplay-sync-'));
        fs.mkdirSync(path.join(repo, 'js'));
        vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.spyOn(console, 'error').mockImplementation(() => {});
    });
    afterEach(() => {
        fs.rmSync(repo, { recursive: true, force: true });
        vi.restoreAllMocks();
    });

    const lock = () => JSON.parse(fs.readFileSync(path.join(repo, 'netplay-kit.lock.json'), 'utf8'));

    it('決まったフォルダにコピーし、版と各ファイルのハッシュを書く', () => {
        expect(main([repo])).toBe(0);
        expect(fs.existsSync(path.join(repo, 'server/netplay/room-service.js'))).toBe(true);
        expect(fs.existsSync(path.join(repo, 'js/netplay/netplay-client.mjs'))).toBe(true);
        const { version, serverDir, clientDir, files } = lock();
        expect(version).toMatch(/^\d+\.\d+\.\d+$/);
        expect([serverDir, clientDir]).toEqual(['server/netplay', 'js/netplay']);
        expect(Object.keys(files)).toHaveLength(8);
        expect(fs.readFileSync(path.join(repo, 'server/netplay/handler.js'), 'utf8')).toMatch(/^\/\/ netplay-kit .*からコピーしたファイル/);
        expect(main(['check', repo])).toBe(0);
    });

    it('public/js があれば、画面側はそこにコピーする', () => {
        fs.mkdirSync(path.join(repo, 'public/js'), { recursive: true });
        main([repo]);
        expect(lock().clientDir).toBe('public/js/netplay');
    });

    it('手で直されたら check が失敗し、同期は止まる（--force で上書きできる）', () => {
        main([repo]);
        const file = path.join(repo, 'server/netplay/room-service.js');
        fs.appendFileSync(file, '// 手で直した\n');
        expect(main(['check', repo])).toBe(1);
        expect(main([repo])).toBe(1);
        expect(fs.readFileSync(file, 'utf8')).toContain('手で直した');
        expect(main([repo, '--force'])).toBe(0);
        expect(main(['check', repo])).toBe(0);
    });

    it('消したファイルや、同期していないファイルも check で見つける', () => {
        main([repo]);
        fs.rmSync(path.join(repo, 'js/netplay/netplay-client.mjs'));
        fs.writeFileSync(path.join(repo, 'server/netplay/extra.js'), '');
        expect(main(['check', repo])).toBe(1);
        const messages = console.error.mock.calls.flat().join('\n');
        expect(messages).toContain('見つかりません: js/netplay/netplay-client.mjs');
        expect(messages).toContain('同期していないファイル: server/netplay/extra.js');
    });

    it('初めての同期で、コピー先にファイルがあれば止める', () => {
        fs.mkdirSync(path.join(repo, 'server/netplay'), { recursive: true });
        fs.writeFileSync(path.join(repo, 'server/netplay/room-service.js'), '// 前からあるファイル');
        expect(main([repo])).toBe(1);
    });

    it('コピーしたサーバー側は、コピー先でも import がつながる', async () => {
        main([repo]);
        const { createTestServer } = await import(path.join(repo, 'server/netplay/testing.js'));
        const { default: race } = await import('../examples/race-game.js');
        const server = createTestServer(race);
        const [a] = await server.createRoom(['A']);
        expect(a.last('joined').roomCode).toMatch(/^\d{4}$/);
    });
});
