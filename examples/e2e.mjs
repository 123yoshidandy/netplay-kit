/**
 * 通し試験の例：ヘッドレス Chrome で2人分のページを開き、サンプル②の部屋を最後まで動かす
 * 使い方: node examples/e2e.mjs （Chrome が必要。場所は CHROME_PATH で変えられる）
 * ポートは WEB_PORT（画面）・PORT（テスト用サーバー）・CHROME_PORT（Chrome のリモートデバッグ）で変えられる
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChrome, createChecklist } from '../tools/chrome.mjs';
import { startDevServer } from '../server/dev-server.js';
import relayGame from './relay-game.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB_PORT = Number(process.env.WEB_PORT ?? 8790);
const DEV_PORT = Number(process.env.PORT ?? 8787);
const CHROME_PORT = process.env.CHROME_PORT ? Number(process.env.CHROME_PORT) : undefined;

// 画面を配る（python3 -m http.server の代わり）
const web = http.createServer((request, response) => {
    const file = path.join(ROOT, decodeURIComponent(new URL(request.url, 'http://localhost').pathname));
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        response.writeHead(404).end();
        return;
    }
    response.writeHead(200, { 'Content-Type': file.endsWith('.html') ? 'text/html; charset=utf-8' : 'text/javascript' });
    fs.createReadStream(file).pipe(response);
}).listen(WEB_PORT);
const dev = startDevServer(relayGame, { port: DEV_PORT, log: () => {} });
const chrome = await launchChrome({ port: CHROME_PORT });
const check = createChecklist();
const has = (type) => `received.some(m => m.type === '${type}')`;
const roomList = `[...document.querySelectorAll('#rooms button')].map(b => b.textContent).join(',') || document.getElementById('rooms').textContent`;

try {
    const page = `/examples/web/index.html?server=ws://localhost:${DEV_PORT}`;
    const a = await chrome.openPage(`http://localhost:${WEB_PORT}${page}`, { ready: 'window.net' });
    const b = await chrome.openPage(`http://127.0.0.1:${WEB_PORT}${page}`, { ready: 'window.net' });

    await a.eval(`document.getElementById('name').value = 'あお'; document.getElementById('create').click(); true`);
    await a.waitFor(`net.lobby?.status === 'lobby'`);
    const code = await a.eval('net.lobby.roomCode');
    check.ok('A: 部屋を作り、URL に部屋番号が入る', (await a.eval('location.search')).includes(`room=${code}`), code);

    await b.eval(`document.getElementById('find').click(); true`);
    await b.waitFor(`document.getElementById('rooms').textContent === '待っている部屋はありません'`);
    check.ok('B: 公開にしていない部屋は、公開の部屋の一覧に出ない', true);

    await b.goto(`http://127.0.0.1:${WEB_PORT}${page}&room=${code}`, { ready: 'window.net' });
    await b.eval(`document.getElementById('name').value = 'みどり'; document.getElementById('join').click(); true`);
    await a.waitFor(`net.lobby.players.length === 2`);
    check.ok('B: 招待URLから参加し、席1になる', await b.eval('net.seat === 1 && !net.isHost()'));

    await a.eval(`document.getElementById('start').click(); true`);
    await b.waitFor(has('state'));
    check.ok('開始すると両方に同じシードが届く', await a.eval(`received.find(m => m.type === 'state').view.seed`)
        === await b.eval(`received.find(m => m.type === 'state').view.seed`));

    await a.eval(`document.getElementById('attack').click(); true`);
    await b.waitFor(has('relay'));
    check.ok('攻撃が相手にだけ届く', !(await a.eval(has('relay'))));

    await b.eval(`document.getElementById('stamp').click(); true`);
    await a.waitFor(has('stamp'));
    check.ok('スタンプが届く', true);
    check.ok('時計のずれが小さい', await a.eval('Math.abs(net.serverNow() - Date.now()) < 200'));

    // 再読み込みしても、同じ席に戻れる
    await b.goto(`http://127.0.0.1:${WEB_PORT}${page}&room=${code}`, { ready: 'window.net' });
    await b.waitFor(`net.lobby?.status === 'playing' && ${has('state')}`);
    check.ok('B: 再読み込みで同じ席に戻り、対戦の状態が届く', await b.eval('net.seat === 1'));

    await b.eval(`document.getElementById('leave').click(); true`);
    await a.waitFor(`net.lobby.status === 'ended'`);
    check.ok('B が出ると A の勝ちで対戦が終わる', await a.eval(`received.filter(m => m.type === 'state').at(-1).view.loser === 1`));
    check.ok('B: 参加情報が消え、URL から部屋番号が外れる', await b.eval(`!net.session && !location.search.includes('room=')`));

    // 公開の部屋：部屋番号を知らなくても、一覧から押すだけで入れる
    const c = await chrome.openPage(`http://localhost:${WEB_PORT}${page}`, { ready: 'window.net' });
    const d = await chrome.openPage(`http://127.0.0.1:${WEB_PORT}${page}`, { ready: 'window.net' });
    await c.eval(`document.getElementById('name').value = 'き'; document.getElementById('public').checked = true;
        document.getElementById('create').click(); true`);
    await c.waitFor(`net.lobby?.public === true`);
    await d.eval(`document.getElementById('name').value = 'あか'; document.getElementById('find').click(); true`);
    await d.waitFor(`document.querySelectorAll('#rooms button').length > 0`);
    check.ok('D: 公開の部屋が一覧に出る', await d.eval(roomList) === 'きの部屋（1/2人）', await d.eval(roomList));

    await d.eval(`document.querySelector('#rooms button').click(); true`);
    await c.waitFor(`net.lobby.players.length === 2`);
    check.ok('D: 一覧を押して入り、席1になり、一覧が消える',
        await d.eval(`net.seat === 1 && document.querySelectorAll('#rooms button').length === 0`));

    await c.eval(`document.getElementById('start').click(); true`);
    await c.waitFor(`net.lobby.status === 'playing'`);
    const e = await chrome.openPage(`http://localhost:${WEB_PORT}${page}`, { ready: 'window.net' });
    await e.eval(`document.getElementById('find').click(); true`);
    await e.waitFor(`document.getElementById('rooms').textContent === '待っている部屋はありません'`);
    check.ok('始まった公開の部屋は、一覧から消える', true);
} finally {
    check.report();
    await chrome.close();
    await dev.close();
    web.close();
}
