/**
 * 通し試験の道具：ヘッドレス Chrome を DevTools Protocol で操作する（Node 22 標準の WebSocket を使い、依存なし）
 * 2人分のページを開いて、オンライン対戦を部屋の作成から最後まで動かすときに使う。各ゲームにはコピーしない
 *
 * 使い方:
 *   import { launchChrome } from '<netplay-kit>/tools/chrome.mjs';
 *   const chrome = await launchChrome();
 *   const a = await chrome.openPage('http://localhost:8089/', { ready: 'typeof onlineState !== "undefined"' });
 *   const b = await chrome.openPage('http://127.0.0.1:8089/');   // 別のアドレスで開くと参加情報が混ざらない
 *   await a.eval(`document.querySelector('#create').click(); true`);
 *   await b.waitFor(`document.querySelector('#players').children.length === 2`);
 *   await a.shot('lobby.png');
 *   await chrome.close();
 */

import fs from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const CHROME_PATHS = [
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium'
].filter(Boolean);

// Chrome を起動して、DevTools Protocol につなぐ
export async function launchChrome({ port = 9333, headless = true, chromePath = CHROME_PATHS.find(p => fs.existsSync(p)) } = {}) {
    if (!chromePath) throw new Error('Chrome が見つかりません。CHROME_PATH で場所を指定してください');
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'netplay-chrome-'));
    const child = spawn(chromePath, [
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${profile}`,
        '--no-first-run',
        '--no-default-browser-check',
        ...(headless ? ['--headless=new'] : [])
    ], { stdio: 'ignore' });

    const version = await waitForJson(`http://127.0.0.1:${port}/json/version`);
    const chrome = await connectChrome(version.webSocketDebuggerUrl);
    const close = chrome.close;
    chrome.close = async () => {
        await close();
        child.kill();
    };
    return chrome;
}

// 起動している Chrome につなぐ
export async function connectChrome(webSocketDebuggerUrl) {
    const ws = new WebSocket(webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
        ws.addEventListener('open', resolve);
        ws.addEventListener('error', () => reject(new Error('Chrome につなげませんでした')));
    });

    let nextId = 0;
    const pending = new Map();
    const consoleListeners = new Map(); // sessionId → ページのコンソールに出た内容を受け取る関数
    ws.addEventListener('message', (event) => {
        const message = JSON.parse(event.data);
        if (message.id && pending.has(message.id)) {
            const { resolve, reject } = pending.get(message.id);
            pending.delete(message.id);
            if (message.error) reject(new Error(JSON.stringify(message.error)));
            else resolve(message.result);
        } else if (message.method === 'Runtime.consoleAPICalled') {
            const text = message.params.args.map(arg => arg.value ?? arg.description).join(' ');
            consoleListeners.get(message.sessionId)?.(`${message.params.type}: ${text}`);
        }
    });
    const cdp = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
        const id = ++nextId;
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params, sessionId }));
    });

    // ページを開く。ready に式を渡すと、それが true になるまで待つ（画面の準備ができるまで）
    // mobile: true でスマホの画面の大きさにする
    async function openPage(url, { ready = 'true', mobile = true, onConsole = null } = {}) {
        const { targetId } = await cdp('Target.createTarget', { url: 'about:blank' });
        const { sessionId } = await cdp('Target.attachToTarget', { targetId, flatten: true });
        await cdp('Page.enable', {}, sessionId);
        await cdp('Runtime.enable', {}, sessionId);
        // ファイルを直したあとの試験で、古い JS をキャッシュから読まないようにする
        await cdp('Network.enable', {}, sessionId);
        await cdp('Network.setCacheDisabled', { cacheDisabled: true }, sessionId);
        if (onConsole) consoleListeners.set(sessionId, onConsole);
        if (mobile) {
            await cdp('Emulation.setDeviceMetricsOverride', { width: 375, height: 667, deviceScaleFactor: 2, mobile: true }, sessionId);
        }

        const page = {
            sessionId,
            cdp: (method, params) => cdp(method, params, sessionId),

            // ページの中で式を評価し、値を返す（Promise は待つ）
            async eval(expression) {
                const result = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
                if (result.exceptionDetails) throw new Error(`${expression}\n${JSON.stringify(result.exceptionDetails)}`);
                return result.result.value;
            },

            async goto(nextUrl, { ready: nextReady = ready } = {}) {
                await cdp('Page.navigate', { url: nextUrl }, sessionId);
                await page.waitFor(`document.readyState === "complete" && (${nextReady})`);
            },

            // 式が true になるまで待つ
            async waitFor(expression, timeout = 10000) {
                const start = Date.now();
                while (Date.now() - start < timeout) {
                    try {
                        if (await page.eval(expression)) return;
                    } catch {
                        // ページの切り替え中は評価できないことがある
                    }
                    await new Promise(resolve => setTimeout(resolve, 100));
                }
                throw new Error(`待ちきれませんでした: ${expression}`);
            },

            // 画面を PNG で保存する
            async shot(file) {
                const { data } = await cdp('Page.captureScreenshot', { format: 'png' }, sessionId);
                fs.writeFileSync(file, Buffer.from(data, 'base64'));
            },

            close: () => cdp('Target.closeTarget', { targetId })
        };
        await page.goto(url);
        return page;
    }

    return {
        cdp,
        openPage,
        close: async () => ws.close()
    };
}

async function waitForJson(url, timeout = 10000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
        try {
            return await (await fetch(url)).json();
        } catch {
            await new Promise(resolve => setTimeout(resolve, 100));
        }
    }
    throw new Error(`Chrome が起動しませんでした: ${url}`);
}

// 結果を「OK／NG 名前」の形で集める（最後に report() で表示し、NG があれば終了コード1）
export function createChecklist() {
    const results = [];
    return {
        ok(name, condition, info = '') {
            results.push({ name, ok: Boolean(condition), info });
        },
        report() {
            results.forEach(({ name, ok, info }) => console.log(`${ok ? 'OK' : 'NG'} ${name} ${info}`.trim()));
            const failed = results.filter(result => !result.ok).length;
            if (failed > 0) process.exitCode = 1;
            return failed === 0;
        }
    };
}
