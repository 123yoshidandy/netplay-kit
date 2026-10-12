/**
 * サンプル①：サーバーがゲームを進める型（dominion・lucky-numbers と同じ形）
 *
 * 遊び方：順番に、場の数に1〜3を足す。21以上にした人の負け
 * 各人は自分にだけ見える「ひみつの数」を持つ（ビューが人ごとに違うことを確かめるため）
 *
 * 部屋には参加者・シード・操作の記録だけを保存し、操作のたびに記録からゲームを再現する（restore／persist）
 * CPU・抜けた人の代行・手番の時間制限も、この例で扱う
 */

import { GameError } from '../server/room-service.js';
import { createSeededRandom } from '../server/testing.js';

export const TARGET = 21;
export const TURN_SECONDS = [0, 30, 60]; // 0 は時間制限なし

// ===== ゲーム本体（各ゲームでは public/js/game.js にあたる） =====

export class TurnGame {
    constructor(players, options) {
        const random = createSeededRandom(options.seed);
        this.players = players.map(player => ({ ...player, secret: 1 + Math.floor(random() * 9), proxy: false }));
        this.options = options;
        this.total = 0;
        this.current = 0;
        this.loser = null;
        this.commands = [];
        this.logs = [];
        this.lastError = null;
    }

    static replay(players, options, commands) {
        const game = new TurnGame(players, options);
        commands.forEach(({ seat, command }) => game.applyCommand(seat, command));
        return game;
    }

    get isOver() {
        return this.loser !== null;
    }

    // 操作を受け付けたら true。受け付けられなければ false と理由（lastError）
    applyCommand(seat, command) {
        this.lastError = null;
        if (command.type === 'proxy') {
            // 抜けた人の手番を CPU が代わりに打つ
            this.players[seat].proxy = true;
            this.record(seat, command, `${this.players[seat].name}さんの代わりに CPU が打ちます`);
            return true;
        }
        if (this.isOver) return this.fail('ゲームは終わっています');
        if (seat !== this.current) return this.fail('あなたの番ではありません');
        if (command.type !== 'add' || ![1, 2, 3].includes(command.amount)) return this.fail('1〜3を選んでください');

        this.total += command.amount;
        this.record(seat, command, `${this.players[seat].name}さんが${command.amount}を足して${this.total}`);
        if (this.total >= TARGET) {
            this.loser = seat;
        } else {
            this.current = this.nextSeat(seat);
        }
        return true;
    }

    nextSeat(seat) {
        return (seat + 1) % this.players.length;
    }

    isCpuTurn() {
        const player = this.players[this.current];
        return !this.isOver && (player.isCPU || player.proxy);
    }

    record(seat, command, log) {
        this.commands.push({ seat, command });
        this.logs.push(log);
    }

    fail(message) {
        this.lastError = message;
        return false;
    }
}

// CPU の1手：場の数を「4の倍数＋（21−1）の余り」にそろえる
export function runCpuStep(game) {
    if (!game.isCpuTurn()) return false;
    const amount = ((TARGET - 1 - game.total) % 4 + 4) % 4 || 1;
    return game.applyCommand(game.current, { type: 'add', amount: Math.min(3, amount) });
}

// ===== ゲームの定義（netplay の部屋に差し込むもの） =====

export default {
    minPlayers: 2,
    maxPlayers: 4,
    allowCpu: true,
    stamps: ['👍', '😮', '😭'],

    settings: {
        defaults: () => ({ turnSeconds: 0 }),
        validate(patch, current) {
            const turnSeconds = Number(patch.turnSeconds ?? current.turnSeconds);
            if (!TURN_SECONDS.includes(turnSeconds)) throw new GameError('持ち時間の指定が正しくありません');
            return { ...current, turnSeconds };
        }
    },

    create({ players, settings, random, now }) {
        const game = new TurnGame(players, { seed: Math.floor(random() * 2 ** 32), turnSeconds: settings.turnSeconds });
        game.turnStartedAt = now;
        return game;
    },

    // 保存するのは記録だけ。読み込むたびに記録から再現する
    persist: (game) => ({
        players: game.players.map(({ id, name, isCPU }) => ({ id, name, isCPU })),
        options: game.options,
        commands: game.commands,
        turnStartedAt: game.turnStartedAt
    }),
    restore(saved) {
        const game = TurnGame.replay(saved.players, saved.options, saved.commands);
        game.turnStartedAt = saved.turnStartedAt;
        return game;
    },

    // ログをどこから送るか（操作の前のログの数）。再接続したときは最近の20件だけ送る
    mark: (game) => game.logs.length,
    joinMark: (game) => Math.max(0, game.logs.length - 20),

    view(game, seat, { since }) {
        return {
            total: game.total,
            current: game.current,
            isMyTurn: !game.isOver && game.current === seat,
            loser: game.loser,
            secret: game.players[seat].secret,
            players: game.players.map(({ name, proxy }) => ({ name, proxy })),
            logsFrom: since ?? 0,
            logs: game.logs.slice(since ?? 0)
        };
    },

    actions: {
        command({ game, seat, message, reject, now }) {
            const command = message.command;
            // 端末から届いた操作は、記録する項目だけに絞る
            if (!command || typeof command !== 'object') reject('操作が正しくありません');
            if (!game.applyCommand(seat, { type: command.type, amount: command.amount })) reject(game.lastError);
            game.turnStartedAt = now();
        }
    },

    isOver: (game) => game.isOver,

    cpu: {
        needsStep: (game) => game.isCpuTurn(),
        step(game, { now }) {
            const moved = runCpuStep(game);
            game.turnStartedAt = now;
            return moved;
        },
        progress: (game) => game.commands.length
    },

    // 対戦中に抜けたら、その人の手番は CPU が代わりに打つ（切断は戻ってくるかもしれないので待つ）
    onPlayerGone(ctx, { seat, reason }) {
        if (reason !== 'left') return ctx.ignore();
        ctx.game.applyCommand(seat, { type: 'proxy' });
    },

    // 手番の時間制限：期限を過ぎたら、その人の代わりに1を足す
    deadline(game) {
        if (!game.options.turnSeconds || game.isOver) return null;
        return game.turnStartedAt + game.options.turnSeconds * 1000;
    },
    onDeadline(ctx) {
        const game = ctx.game;
        game.applyCommand(game.current, { type: 'add', amount: 1 });
        game.turnStartedAt = ctx.now();
    }
};
