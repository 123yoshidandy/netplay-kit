/**
 * サンプル②：中継の型（panel-de-pon と同じ形、2人対戦）
 *
 * ゲームはそれぞれの端末で進め、サーバーは同じシードを配り、攻撃・フィールドの様子を相手に中継する
 * 中継は保存しない（readOnly）。負けは端末が申告する。通算の勝ち数は対戦をまたいで残す（carryOver）
 */

export const RELAY_KINDS = ['attack', 'snapshot'];
export const MAX_RELAY_LENGTH = 4096; // 中継するデータの大きさの上限（JSON の文字数）

export default {
    minPlayers: 2,
    maxPlayers: 2,
    rematch: 'ready',            // 2人とも「もう1回」を押したら始まる
    stamps: ['👍', '🔥', '🙏'],
    messagesPerSecond: 25,       // 1人あたり毎秒5回ほどフィールドの様子を送るので多めにする
    messagesBurst: 50,

    create: ({ players, random, carry }) => ({
        seed: Math.floor(random() * 2 ** 32),
        loser: null,
        wins: players.map(player => carry?.wins?.[player.id] ?? 0),
        ids: players.map(player => player.id)
    }),

    view: (game) => ({ seed: game.seed, loser: game.loser, wins: game.wins }),

    actions: {
        // 攻撃・フィールドの様子を相手に送る。前の対戦（matchId 違い）や対戦の後に届いたものは共通側が捨てる
        relay: {
            readOnly: true,
            handle({ message, opponents, toSeat, seat }) {
                if (!RELAY_KINDS.includes(message.kind)) return;
                if (JSON.stringify(message.data ?? null).length > MAX_RELAY_LENGTH) return;
                opponents().forEach(opponent => toSeat(opponent, { type: 'relay', kind: message.kind, data: message.data, from: seat }));
            }
        },

        // ゲームオーバーになった。相手の勝ち
        lose({ game, seat, opponents, endMatch }) {
            lose(game, seat, opponents());
            endMatch();
        }
    },

    // 対戦中に部屋を出たら相手の勝ち。切断は戻ってくるかもしれないので待つ
    onPlayerGone(ctx, { seat, reason }) {
        if (reason !== 'left') return ctx.ignore();
        lose(ctx.game, seat, ctx.opponents());
        ctx.endMatch();
    },

    // 通算の勝ち数を、参加者の id ごとに残す（席が変わっても引き継げるように）
    carryOver: (game) => ({ wins: Object.fromEntries(game.ids.map((id, seat) => [id, game.wins[seat]])) })
};

function lose(game, seat, opponents) {
    game.loser = seat;
    opponents.forEach(opponent => { game.wins[opponent] += 1; });
}
