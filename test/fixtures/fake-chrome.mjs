#!/usr/bin/env node
// テスト用の偽の Chrome：--remote-debugging-port で /json/version と WebSocket だけを受ける
// FAKE_CHROME_IGNORE_TERM=1 のときは SIGTERM を無視する（SIGKILL まで残る Chrome のまね）
import http from 'node:http';
import { WebSocketServer } from 'ws';

const arg = (name) => process.argv.find(a => a.startsWith(`--${name}=`))?.split('=')[1];
const port = Number(arg('remote-debugging-port'));

if (process.env.FAKE_CHROME_IGNORE_TERM === '1') process.on('SIGTERM', () => {});

const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
        webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/fake`,
        pid: process.pid,
        userDataDir: arg('user-data-dir')
    }));
});
new WebSocketServer({ server });
server.listen(port, '127.0.0.1');
