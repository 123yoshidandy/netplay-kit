#!/usr/bin/env node
/**
 * netplay-kit のファイルを、各ゲームのリポジトリにコピーする（コピーして同期）
 *
 *   node scripts/sync.mjs <ゲームのリポジトリ> [--server-dir server/netplay] [--client-dir js/netplay] [--force]
 *     サーバー用と画面用のファイルを決まったフォルダにコピーし、netplay-kit.lock.json（版・コミット・各ファイルの sha256）を置く
 *     コピー先が手で直されていたら、上書きせずに止める（--force で上書きする）
 *
 *   node scripts/sync.mjs check <ゲームのリポジトリ>
 *     コピー先が手で直されていないかを確かめる（直されていたら終了コード1）。netplay-kit より古ければ知らせる
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const KIT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOCK_FILE = 'netplay-kit.lock.json';
const SERVER_FILES = ['room-service.js', 'handler.js', 'dynamo-store.js', 'memory-store.js', 'dev-server.js', 'testing.js'];
const CLIENT_FILES = ['netplay-client.js', 'netplay-client.mjs'];

// ===== 入口 =====

export function main(argv) {
    const args = parseArgs(argv);
    if (!args.repo) {
        console.error('使い方: node scripts/sync.mjs [check] <ゲームのリポジトリ> [--server-dir 場所] [--client-dir 場所] [--force]');
        return 2;
    }
    const repo = path.resolve(args.repo);
    if (!fs.existsSync(repo)) {
        console.error(`リポジトリが見つかりません: ${repo}`);
        return 2;
    }
    return args.command === 'check' ? check(repo) : sync(repo, args);
}

function parseArgs(argv) {
    const args = { command: 'sync', repo: null, serverDir: null, clientDir: null, force: false };
    const rest = [...argv];
    if (rest[0] === 'check' || rest[0] === 'sync') args.command = rest.shift();
    while (rest.length > 0) {
        const arg = rest.shift();
        if (arg === '--force') args.force = true;
        else if (arg === '--server-dir') args.serverDir = rest.shift();
        else if (arg === '--client-dir') args.clientDir = rest.shift();
        else args.repo = arg;
    }
    return args;
}

// ===== 同期 =====

function sync(repo, args) {
    const lock = readLock(repo);
    const serverDir = args.serverDir ?? lock?.serverDir ?? 'server/netplay';
    const clientDir = args.clientDir ?? lock?.clientDir ?? detectClientDir(repo);
    if (!clientDir) {
        console.error('画面側のフォルダが見つかりません。--client-dir で指定してください（例: js/netplay）');
        return 2;
    }

    // 手で直されたファイルがあれば止める（同期で消えてしまうため）
    if (!args.force) {
        const problems = lock ? findModified(repo, lock) : findUnmanaged(repo, [serverDir, clientDir]);
        if (problems.length > 0) {
            console.error('コピー先が手で直されています。netplay-kit 側に直しを移してから同期してください（上書きしてよければ --force）:');
            problems.forEach(problem => console.error(`  ${problem}`));
            return 1;
        }
    }

    const { version, commit } = kitVersion();
    const header = `// netplay-kit ${version}（${commit}）からコピーしたファイル。ここでは直さず、netplay-kit で直してから同期する\n`;
    const files = {};
    const copy = (sourceDir, names, targetDir) => names.forEach(name => {
        const content = header + fs.readFileSync(path.join(KIT_ROOT, sourceDir, name), 'utf8');
        const target = path.posix.join(targetDir, name);
        fs.mkdirSync(path.join(repo, targetDir), { recursive: true });
        fs.writeFileSync(path.join(repo, target), content);
        files[target] = hash(content);
    });
    copy('server', SERVER_FILES, serverDir);
    copy('client', CLIENT_FILES, clientDir);

    // 前の版にあって、今の版にないファイルは消す
    Object.keys(lock?.files ?? {}).filter(file => !(file in files)).forEach(file => {
        fs.rmSync(path.join(repo, file), { force: true });
        console.log(`消しました: ${file}`);
    });

    const nextLock = { version, commit, serverDir, clientDir, files };
    fs.writeFileSync(path.join(repo, LOCK_FILE), JSON.stringify(nextLock, null, 2) + '\n');
    console.log(`netplay-kit ${version}（${commit}）を ${repo} に同期しました`);
    console.log(`  サーバー: ${serverDir}/  画面: ${clientDir}/`);
    return 0;
}

// dominion・lucky-numbers は public/js、mine-blocks・panel-de-pon は js
function detectClientDir(repo) {
    if (fs.existsSync(path.join(repo, 'public/js'))) return 'public/js/netplay';
    if (fs.existsSync(path.join(repo, 'js'))) return 'js/netplay';
    return null;
}

// ===== 確認 =====

function check(repo) {
    const lock = readLock(repo);
    if (!lock) {
        console.error(`${LOCK_FILE} がありません。先に node scripts/sync.mjs ${repo} で同期してください`);
        return 1;
    }
    const problems = [...findModified(repo, lock), ...findExtra(repo, lock)];
    const { version, commit } = kitVersion();
    if (problems.length > 0) {
        console.error('コピー先が手で直されています:');
        problems.forEach(problem => console.error(`  ${problem}`));
        return 1;
    }
    console.log(`手で直されたファイルはありません（netplay-kit ${lock.version}（${lock.commit})）`);
    if (lock.commit !== commit || lock.version !== version) {
        console.log(`netplay-kit の今の版は ${version}（${commit}）です。node scripts/sync.mjs ${repo} で更新できます`);
    }
    return 0;
}

function findModified(repo, lock) {
    return Object.entries(lock.files).flatMap(([file, expected]) => {
        const full = path.join(repo, file);
        if (!fs.existsSync(full)) return [`見つかりません: ${file}`];
        return hash(fs.readFileSync(full, 'utf8')) === expected ? [] : [`直されています: ${file}`];
    });
}

// 同期したフォルダに、同期していないファイルが置かれていないか
function findExtra(repo, lock) {
    return [lock.serverDir, lock.clientDir].flatMap(dir => {
        const full = path.join(repo, dir);
        if (!fs.existsSync(full)) return [];
        return fs.readdirSync(full)
            .map(name => path.posix.join(dir, name))
            .filter(file => !(file in lock.files))
            .map(file => `同期していないファイル: ${file}`);
    });
}

// 初めて同期する前に、コピー先のフォルダにファイルがあれば止める
function findUnmanaged(repo, dirs) {
    return dirs.flatMap(dir => {
        const full = path.join(repo, dir);
        if (!fs.existsSync(full)) return [];
        return fs.readdirSync(full).map(name => `同期していないファイル: ${path.posix.join(dir, name)}`);
    });
}

// ===== 補助 =====

function readLock(repo) {
    const file = path.join(repo, LOCK_FILE);
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
}

function hash(content) {
    return crypto.createHash('sha256').update(content).digest('hex');
}

// package.json の版と、git のコミット（配るファイルにコミットしていない変更があれば -dirty を付ける）
function kitVersion() {
    const { version } = JSON.parse(fs.readFileSync(path.join(KIT_ROOT, 'package.json'), 'utf8'));
    let commit = 'unknown';
    try {
        commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: KIT_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
        const dirty = execFileSync('git', ['status', '--porcelain', '--', 'server', 'client'], { cwd: KIT_ROOT, encoding: 'utf8' }).trim();
        if (dirty) commit += '-dirty';
    } catch {
        // git がなくても同期はできる
    }
    return { version, commit };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    process.exitCode = main(process.argv.slice(2));
}
