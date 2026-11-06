import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChrome } from '../tools/chrome.mjs';

const fakeChrome = fileURLToPath(new URL('./fixtures/fake-chrome.mjs', import.meta.url));
const version = async (port) => (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
const isAlive = (pid) => {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
};

describe('launchChrome の片付け', () => {
    let tmp;
    let originalTmp;

    beforeEach(() => {
        originalTmp = process.env.TMPDIR;
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'netplay-chrome-test-'));
        process.env.TMPDIR = tmp; // プロフィールをここに作らせて、残りを数える
        fs.chmodSync(fakeChrome, 0o755);
    });
    afterEach(() => {
        process.env.TMPDIR = originalTmp;
        delete process.env.FAKE_CHROME_IGNORE_TERM;
        vi.restoreAllMocks();
        fs.rmSync(tmp, { recursive: true, force: true });
    });

    it('close は Chrome の終了を待ち、ユーザーデータのディレクトリを消す', async () => {
        const chrome = await launchChrome({ port: 9364, chromePath: fakeChrome });
        const { pid, userDataDir } = await version(9364);
        expect(fs.existsSync(userDataDir)).toBe(true);
        await chrome.close();
        expect(isAlive(pid)).toBe(false);
        expect(fs.readdirSync(tmp)).toEqual([]);
    });

    it('SIGTERM で止まらない Chrome は、killTimeout のあとに SIGKILL で止める', async () => {
        process.env.FAKE_CHROME_IGNORE_TERM = '1';
        const chrome = await launchChrome({ port: 9365, chromePath: fakeChrome, killTimeout: 300 });
        const { pid } = await version(9365);
        await chrome.close();
        expect(isAlive(pid)).toBe(false);
        expect(fs.readdirSync(tmp)).toEqual([]);
    });

    it('ユーザーデータのディレクトリを消せなくても、close は投げずに警告だけ出す', async () => {
        const chrome = await launchChrome({ port: 9368, chromePath: fakeChrome });
        const { pid } = await version(9368);
        const rmSync = vi.spyOn(fs, 'rmSync').mockImplementation(() => {
            throw Object.assign(new Error('directory not empty'), { code: 'ENOTEMPTY' });
        });
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        await expect(chrome.close()).resolves.toBeUndefined();
        expect(rmSync).toHaveBeenCalledWith(expect.stringContaining('netplay-chrome-'), expect.objectContaining({ maxRetries: expect.any(Number) }));
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('ENOTEMPTY'));
        expect(isAlive(pid)).toBe(false);
    });

    it('ポートが使われていれば、その Chrome につながずにエラーにする', async () => {
        const first = await launchChrome({ port: 9366, chromePath: fakeChrome });
        const { pid } = await version(9366);
        try {
            await expect(launchChrome({ port: 9366, chromePath: fakeChrome })).rejects.toThrow('すでに使われています');
            expect(isAlive(pid)).toBe(true);
        } finally {
            await first.close();
        }
        expect(fs.readdirSync(tmp)).toEqual([]);
    });

    it('Chrome がすぐ落ちたら、待ちきらずにエラーにし、ユーザーデータのディレクトリを消す', async () => {
        const start = Date.now();
        await expect(launchChrome({ port: 9367, chromePath: '/usr/bin/false' })).rejects.toThrow('起動しませんでした');
        expect(Date.now() - start).toBeLessThan(5000);
        expect(fs.readdirSync(tmp)).toEqual([]);
    });
});
