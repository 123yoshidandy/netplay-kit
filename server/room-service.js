/**
 * オンライン対戦の部屋の処理（ゲームに共通の部分）
 * 保存先（store）と送信（send）は外から渡すので、AWS でも手元のテスト用サーバーでも同じ処理を使える
 *
 * 部屋の作成・参加・再接続・退出・ホストの引き継ぎ・開始・再戦・CPU・スタンプ・ping はここで扱い、
 * ゲームの中身は「ゲームの定義」（game）として外から差し込む。ここからゲームのコードは import しない
 */

const DEFAULTS = {
    minPlayers: 2,
    maxPlayers: 4,
    joinMidGame: false,          // 対戦中に新しい人が参加できるか（token での再接続は、これと関係なくいつでもできる）
    allowCpu: false,             // ロビーで CPU を足せるか
    rematch: 'host',             // 'host'：部屋を作った人が始める / 'ready'：全員が「もう1回」を押したら始まる
    stamps: [],                  // 送れるスタンプの種類
    maxNameLength: 12,
    roomTtlSeconds: 2 * 24 * 60 * 60, // 部屋は最後の操作から2日で消える
    maxCpuSteps: 1000,           // CPU が止まらなくなったときの安全装置
    maxMessageLength: 8192,      // 端末から受け付けるメッセージの大きさの上限（JSON の文字数）
    messagesPerSecond: 10,       // 1接続あたりの送信回数の上限（Lambda のメモリで数えるので目安）
    messagesBurst: 20
};
const CODE_ALPHABET = '0123456789'; // 部屋番号は数字だけ（スマホの数字キーボードで入れやすい）
const CODE_LENGTH = 5;
const MAX_RETRIES = 3;              // 同時に操作されて保存がぶつかったときのやり直し回数
const CONNECTION_CACHE_SIZE = 1000;

// 共通側が受け付ける操作（ゲームの定義の actions に同じ名前は使えない）
export const RESERVED_ACTIONS = ['create', 'join', 'leave', 'ping', 'start', 'ready', 'backToLobby',
    'setSettings', 'addCpu', 'removeCpu', 'stamp'];

// 保存がぶつかったとき（他の操作が先に保存した）に store が投げるエラー
export class ConflictError extends Error {}

// 利用者に伝えるエラー（メッセージをそのまま画面に出す）。ゲームの定義からも投げてよい
export class GameError extends Error {
    constructor(message, code = 'invalid') {
        super(message);
        this.code = code;
    }
}

// 操作を断る（理由と一緒に、今の状態を本人に返す）。ctx.reject() で投げる
class RejectError extends GameError {
    constructor(message) {
        super(message, 'rejected');
    }
}

// 1接続あたりの送信回数を数える（決まった速さで回数が戻る方式）
export class RateLimiter {
    constructor({ perSecond, burst, now = () => Date.now() }) {
        this.perSecond = perSecond;
        this.burst = burst;
        this.now = now;
        this.buckets = new Map();
    }

    allow(key) {
        const now = this.now();
        const bucket = this.buckets.get(key) ?? { tokens: this.burst, at: now };
        bucket.tokens = Math.min(this.burst, bucket.tokens + (now - bucket.at) / 1000 * this.perSecond);
        bucket.at = now;
        this.buckets.delete(key);
        this.buckets.set(key, bucket);
        if (this.buckets.size > CONNECTION_CACHE_SIZE) this.buckets.delete(this.buckets.keys().next().value);
        if (bucket.tokens < 1) return false;
        bucket.tokens -= 1;
        return true;
    }

    forget(key) {
        this.buckets.delete(key);
    }
}

export class RoomService {
    // game: ゲームの定義（README の「ゲームの定義」）
    // store: getRoom(code) / putRoom(room, previousVersion) / getConnection(id) / putConnection(connection) / deleteConnection(id)
    // send: (connectionId, message) => Promise（接続が切れていれば失敗してよい）
    // connectionCache / limiter: Lambda の呼び出しをまたいで使い回すもの（省略するとこのインスタンスだけで持つ）
    constructor({ game, store, send, createToken = () => crypto.randomUUID(), now = () => Date.now(), random = Math.random,
        connectionCache = new Map(), limiter = null }) {
        this.game = { ...DEFAULTS, ...game };
        this.store = store;
        this.sendRaw = send;
        this.createToken = createToken;
        this.now = now;
        this.random = random;
        this.connectionCache = connectionCache;
        this.limiter = limiter ?? new RateLimiter({ perSecond: this.game.messagesPerSecond, burst: this.game.messagesBurst, now });

        const reserved = Object.keys(this.game.actions ?? {}).filter(name => RESERVED_ACTIONS.includes(name));
        if (reserved.length > 0) throw new Error(`ゲームの定義の actions に共通の操作名は使えません: ${reserved.join(', ')}`);
    }

    // ===== 入口 =====

    // 届いた生のメッセージ（文字列）を処理する。大きすぎる・送りすぎ・読めないものは黙って捨てる
    async handleRaw(connectionId, raw) {
        const text = typeof raw === 'string' ? raw : String(raw ?? '');
        if (text.length > this.game.maxMessageLength) return;
        if (!this.limiter.allow(connectionId)) return;
        let message;
        try {
            message = JSON.parse(text || '{}');
        } catch {
            return;
        }
        if (!message || typeof message !== 'object' || Array.isArray(message)) return;
        await this.handle(connectionId, message);
    }

    // 端末からのメッセージを処理する。保存がぶつかったら読み直してやり直す
    async handle(connectionId, message) {
        for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
            try {
                const outbox = await this.route(connectionId, message ?? {});
                await this.flush(outbox);
                return;
            } catch (error) {
                if (error instanceof ConflictError) continue;
                if (error instanceof GameError) {
                    await this.send(connectionId, { type: 'error', message: error.message, code: error.code });
                    return;
                }
                throw error;
            }
        }
        await this.send(connectionId, { type: 'error', message: '混み合っています。もう一度操作してください', code: 'busy' });
    }

    // 接続が切れたら、参加者を「切断中」にする（席はそのまま残し、再接続できるようにする）
    async disconnect(connectionId) {
        const connection = await this.store.getConnection(connectionId);
        await this.store.deleteConnection(connectionId);
        this.connectionCache.delete(connectionId);
        this.limiter.forget(connectionId);
        if (!connection) return;

        for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
            const room = await this.store.getRoom(connection.roomCode);
            const seat = room ? this.seatOf(room, connectionId) : -1;
            if (seat < 0) return;
            const lobbyBefore = this.lobbyKey(room);
            room.players[seat].connectionId = null;
            const outbox = [];
            if (room.status === 'playing') {
                outbox.push(...this.runHook(room, seat, {}, ctx => this.game.onPlayerGone?.(ctx, { seat, reason: 'disconnected' })));
            }
            try {
                await this.saveRoom(room);
                await this.flush(this.withLobby(room, lobbyBefore, outbox));
                return;
            } catch (error) {
                if (!(error instanceof ConflictError)) throw error;
            }
        }
    }

    async route(connectionId, message) {
        switch (message.action) {
            case 'create': return this.createRoom(connectionId, message);
            case 'join': return this.joinRoom(connectionId, message);
            case 'ping':
                // 期限を使わないゲームは、部屋を読まずに返す（接続を保つための ping で読み込みを増やさない）
                if (!this.game.deadline) return [this.pong(connectionId, message)];
                break;
        }

        // ここから先は部屋に入っている端末だけ
        const { room, seat } = await this.loadMember(connectionId, { quiet: message.action === 'ping' });
        if (!room) return [this.pong(connectionId, message)];
        const lobbyBefore = this.lobbyKey(room);
        const deadline = this.checkDeadline(room);

        let outbox;
        switch (message.action) {
            case 'ping': outbox = [this.pong(connectionId, message)]; break;
            case 'leave': return [...deadline.outbox, ...await this.leaveRoom(room, seat, connectionId, lobbyBefore)];
            case 'start': outbox = this.startMatch(room, seat); break;
            case 'ready': outbox = this.setReady(room, seat, message.ready !== false); break;
            case 'backToLobby': outbox = this.backToLobby(room, seat); break;
            case 'setSettings': outbox = this.setSettings(room, seat, message.settings); break;
            case 'addCpu': outbox = this.addCpu(room, seat); break;
            case 'removeCpu': outbox = this.removeCpu(room, seat, message.seat); break;
            case 'stamp': outbox = this.stamp(room, seat, message.stamp); break;
            default: outbox = this.gameAction(room, seat, message); break;
        }

        // 保存するのは、部屋が変わったときだけ（期限切れの処理を含む）
        if (outbox.save || deadline.save) await this.saveRoom(room);
        return this.withLobby(room, lobbyBefore, [...deadline.outbox, ...outbox]);
    }

    // ===== 部屋に入る =====

    async createRoom(connectionId, { name }) {
        const room = {
            code: null,
            version: 0,
            status: 'lobby', // lobby → playing → ended → playing（再戦）／lobby
            matchId: 0,      // 対戦ごとに増える番号（前の対戦のメッセージが混ざらないように）
            settings: this.game.settings?.defaults?.() ?? {},
            players: [this.newPlayer(name, connectionId)],
            game: null,
            carry: null      // 対戦をまたいで残すもの（通算の勝ち数など。ゲームの carryOver が決める）
        };

        // 部屋番号が既存の部屋とぶつかったら作り直す
        for (let attempt = 0; ; attempt++) {
            room.code = this.createRoomCode();
            try {
                await this.saveRoom(room);
                break;
            } catch (error) {
                if (!(error instanceof ConflictError) || attempt >= 5) throw error;
            }
        }
        await this.putConnection(connectionId, room.code);
        return [this.joinedMessage(room, 0), ...this.lobbyMessages(room)];
    }

    // 部屋に参加する。token が参加者のものなら、その席に再接続する（対戦中でも戻れる。退出した人は戻れない）
    // 再接続したら joined → lobby → state の順で送る
    async joinRoom(connectionId, { roomCode, name, token }) {
        const room = await this.store.getRoom(String(roomCode ?? '').trim());
        if (!room) throw new GameError('部屋が見つかりません', 'room_not_found');
        const lobbyBefore = this.lobbyKey(room);

        let seat = token ? room.players.findIndex(player => player.token === token && !player.left) : -1;
        const outbox = [];
        if (seat >= 0) {
            room.players[seat].connectionId = connectionId;
        } else {
            const canJoinMidGame = this.game.joinMidGame && room.status !== 'lobby';
            if (room.status !== 'lobby' && !canJoinMidGame) throw new GameError('この部屋は対戦が始まっています', 'already_started');
            if (this.activePlayers(room).length >= this.game.maxPlayers) throw new GameError('この部屋は満員です', 'room_full');
            room.players.push(this.newPlayer(name, connectionId));
            seat = room.players.length - 1;
            if (canJoinMidGame && room.game) {
                outbox.push(...this.runHook(room, seat, {}, ctx => this.game.onJoin?.(ctx, { seat })));
            }
        }

        await this.saveRoom(room);
        await this.putConnection(connectionId, room.code);

        const messages = [this.joinedMessage(room, seat), ...this.lobbyMessages(room)];
        if (room.status !== 'lobby' && room.game) {
            const game = this.restoreGame(room);
            const since = this.game.joinMark ? this.game.joinMark(game) : null;
            messages.push(this.stateMessage(room, game, seat, since));
        }
        const others = this.withLobby(room, lobbyBefore, outbox)
            .filter(entry => entry.connectionId !== connectionId);
        return [...messages, ...others];
    }

    // 部屋を出る。ロビーでは席から外し（後ろの人の席が詰まる）、対戦中・対戦後は「退出」として席を残す
    async leaveRoom(room, seat, connectionId, lobbyBefore) {
        const outbox = [];
        if (room.status === 'lobby') {
            room.players.splice(seat, 1);
        } else {
            const player = room.players[seat];
            player.left = true;
            player.ready = false;
            player.connectionId = null;
            if (room.status === 'playing') {
                outbox.push(...this.runHook(room, seat, {}, ctx => this.game.onPlayerGone?.(ctx, { seat, reason: 'left' })));
            }
        }
        // 抜けた人以外が全員「もう1回」を押していれば、ここで始まる
        const started = this.readyStartIfAll(room);
        await this.saveRoom(room);
        await this.store.deleteConnection(connectionId);
        this.connectionCache.delete(connectionId);
        return [
            { connectionId, message: { type: 'left' } },
            ...this.withLobby(room, lobbyBefore, outbox).filter(entry => entry.connectionId !== connectionId),
            ...started
        ];
    }

    // ===== ロビー・開始・再戦 =====

    setSettings(room, seat, patch) {
        this.assertHost(room, seat);
        if (room.status !== 'lobby') throw new GameError('対戦中は変更できません', 'already_started');
        const validate = this.game.settings?.validate;
        if (!validate) throw new GameError('変えられる設定がありません');
        room.settings = validate(patch ?? {}, room.settings);
        return withSave([]);
    }

    addCpu(room, seat) {
        this.assertHost(room, seat);
        if (!this.game.allowCpu) throw new GameError('CPU は使えません');
        if (room.status !== 'lobby') throw new GameError('対戦中は変更できません', 'already_started');
        if (this.activePlayers(room).length >= this.game.maxPlayers) throw new GameError('これ以上参加できません', 'room_full');
        const cpuCount = room.players.filter(player => player.isCPU).length;
        room.players.push({ id: this.createPlayerId(), name: `CPU${cpuCount + 1}`, isCPU: true, token: null, connectionId: null });
        return withSave([]);
    }

    // CPU を外す（人間の参加者は外さない）
    removeCpu(room, seat, targetSeat) {
        this.assertHost(room, seat);
        if (room.status !== 'lobby') throw new GameError('対戦中は変更できません', 'already_started');
        if (!room.players[targetSeat]?.isCPU) throw new GameError('外せるのは CPU だけです');
        room.players.splice(targetSeat, 1);
        return withSave([]);
    }

    // 対戦を始める（ロビーから、または対戦後の再戦）。部屋を作った人だけが操作できる
    startMatch(room, seat) {
        this.assertHost(room, seat);
        if (room.status === 'playing') throw new GameError('対戦中です', 'already_started');
        return this.beginMatch(room);
    }

    // 「もう1回」の準備ができた（rematch: 'ready' のとき、全員がそろったら始まる）
    setReady(room, seat, ready) {
        if (this.game.rematch !== 'ready') throw new GameError('今はその操作はできません');
        if (room.status === 'playing') return withoutSave([]);
        room.players[seat].ready = ready;
        const started = this.readyStartIfAll(room);
        return withSave(started);
    }

    readyStartIfAll(room) {
        if (this.game.rematch !== 'ready' || room.status === 'playing') return [];
        const humans = this.activePlayers(room).filter(player => !player.isCPU);
        if (humans.length === 0 || !humans.every(player => player.ready)) return [];
        if (this.activePlayers(room).length < this.game.minPlayers) return [];
        return this.beginMatch(room);
    }

    beginMatch(room) {
        if (room.status === 'ended') this.removeLeftPlayers(room);
        const players = this.activePlayers(room);
        if (players.length < this.game.minPlayers) {
            throw new GameError(`${this.game.minPlayers}人以上で始めてください`, 'not_enough_players');
        }
        // ゲームが足す開始の条件（全員が接続しているときだけ、など）。理由を返したら始めない
        const reason = this.game.canStart?.(this.lobbyState(room));
        if (reason) throw new GameError(reason, 'cannot_start');
        room.players.forEach(player => { player.ready = false; });
        room.status = 'playing';
        room.matchId += 1;
        const game = this.game.create({
            players: room.players.map(({ id, name, isCPU }) => ({ id, name, isCPU: Boolean(isCPU) })),
            settings: this.game.settings?.forStart ? this.game.settings.forStart(room.settings) : room.settings,
            carry: room.carry,
            matchId: room.matchId,
            random: this.random,
            now: this.now()
        });
        const ctx = new GameContext(this, room, null, {});
        ctx.setGame(game);
        return withSave(this.afterGameChange(ctx, null));
    }

    // 部屋（ロビー）に戻る。対戦後は誰でも、対戦中は部屋を作った人だけが操作できる
    // 退出した人はここで席から外し、残った人の先頭が部屋を作った人の役を引き継ぐ
    backToLobby(room, seat) {
        if (room.status === 'lobby') return withoutSave([]);
        if (room.status === 'playing') this.assertHost(room, seat);
        room.status = 'lobby';
        room.game = null;
        this.removeLeftPlayers(room);
        room.players.forEach(player => { player.ready = false; });
        return withSave([]);
    }

    // スタンプ（短い定型の反応）を全員に送る。保存しない
    stamp(room, seat, stamp) {
        if (!this.game.stamps.includes(stamp)) return withoutSave([]);
        return withoutSave(this.toConnected(room, () => ({ type: 'stamp', seat, stamp })));
    }

    // ===== ゲームの操作 =====

    gameAction(room, seat, message) {
        const action = this.game.actions?.[message.action];
        if (!action) throw new GameError('不明な操作です');
        const { handle, readOnly = false, when = 'playing' } = typeof action === 'function' ? { handle: action } : action;

        // 対戦中だけの操作は、対戦の外や前の対戦（matchId 違い）から届いたら黙って捨てる
        if (when === 'playing' && (room.status !== 'playing' || !room.game)) return withoutSave([]);
        if (message.matchId !== undefined && message.matchId !== room.matchId) return withoutSave([]);

        const ctx = new GameContext(this, room, seat, message);
        const since = !readOnly && this.game.mark && room.game ? this.game.mark(ctx.game) : null;
        try {
            handle(ctx);
        } catch (error) {
            if (!(error instanceof RejectError)) throw error;
            // 受け付けられなかったら理由と今の状態を返し、画面を正しい状態に戻す
            const reply = [{ connectionId: room.players[seat].connectionId, message: { type: 'error', message: error.message, code: error.code } }];
            if (room.game) {
                const game = this.restoreGame(room);
                reply.push(this.stateMessage(room, game, seat, this.game.mark ? this.game.mark(game) : null));
            }
            return withoutSave(reply);
        }
        if (readOnly || ctx.ignored) return withoutSave(ctx.outbox);
        // ロビーでも受け付ける操作（when: 'any'）で、まだゲームがないときは、ビューを作らずに保存だけする
        if (!room.game && !ctx.liveGame) return withSave(ctx.outbox);
        return withSave(this.afterGameChange(ctx, since));
    }

    // 退出・切断・参加・期限切れをゲームに知らせる。ゲームが何もしなければ（ignore）状態は送らない
    runHook(room, seat, message, call) {
        if (!room.game) return [];
        const ctx = new GameContext(this, room, seat, message);
        const since = this.game.mark ? this.game.mark(ctx.game) : null;
        call(ctx);
        if (ctx.ignored || !ctx.touched) return ctx.outbox;
        return this.afterGameChange(ctx, since);
    }

    // 届いたメッセージのたびに、ゲームの期限（手番の時間制限など）を確かめる。Lambda はタイマーを持てないため
    checkDeadline(room) {
        if (!this.game.deadline || room.status !== 'playing' || !room.game) return { outbox: [], save: false };
        const deadline = this.game.deadline(this.restoreGame(room), room);
        if (deadline === null || deadline === undefined || this.now() < deadline) return { outbox: [], save: false };
        const outbox = this.runHook(room, null, {}, ctx => { ctx.touched = true; this.game.onDeadline(ctx); });
        return { outbox, save: true };
    }

    // ゲームが変わったあと：CPU を進め、終わりを判定し、保存する形に戻して、各人のビューを作る
    afterGameChange(ctx, since) {
        const { room } = ctx;
        const game = ctx.game;
        const states = [];
        if (!ctx.stateSuppressed) states.push(...this.snapshot(room, game, since));
        states.push(...this.runCpu(room, game));

        if (room.status === 'playing' && this.game.isOver?.(game)) room.status = 'ended';
        if (room.status === 'ended' && this.game.carryOver) room.carry = this.game.carryOver(game, room.carry);
        room.game = this.game.persist ? this.game.persist(game) : game;
        return [...ctx.outbox, ...states];
    }

    // 人間の操作が必要になるまで CPU を進め、1手ごとの各人のビューを残す（画面で間を置いて見せるため cpu: true を付ける）
    runCpu(room, game) {
        const cpu = this.game.cpu;
        if (!cpu || room.status !== 'playing') return [];
        const states = [];
        for (let step = 0; step < this.game.maxCpuSteps; step++) {
            if (this.game.isOver?.(game)) break;
            if (cpu.needsStep && !cpu.needsStep(game, room)) break;
            const since = this.game.mark ? this.game.mark(game) : null;
            const progressBefore = cpu.progress?.(game);
            const moved = cpu.step(game, { random: this.random, now: this.now(), room });
            if (moved === false) break;
            if (cpu.progress && cpu.progress(game) === progressBefore) break; // 記録が増えなければ止める
            states.push(...this.snapshot(room, game, since, { cpu: true }));
        }
        return states;
    }

    // ===== 保存と送信 =====

    // 部屋を保存する（読み込んだときと版が違えば ConflictError）
    async saveRoom(room) {
        const previousVersion = room.version;
        room.version = previousVersion + 1;
        room.expiresAt = this.expiresAt();
        try {
            await this.store.putRoom(room, previousVersion);
        } catch (error) {
            room.version = previousVersion;
            throw error;
        }
    }

    async flush(outbox) {
        // 同じ端末へのメッセージは順番を守り、端末どうしは並べて送る
        // すべてのメッセージにサーバーの今の時刻を付ける（端末で時計のずれを直すため）
        const serverNow = this.now();
        const byConnection = new Map();
        outbox.forEach(({ connectionId, message }) => {
            if (!connectionId) return;
            if (!byConnection.has(connectionId)) byConnection.set(connectionId, []);
            byConnection.get(connectionId).push({ ...message, serverNow });
        });
        await Promise.all([...byConnection].map(async ([connectionId, messages]) => {
            for (const message of messages) {
                await this.send(connectionId, message);
            }
        }));
    }

    async send(connectionId, message) {
        try {
            await this.sendRaw(connectionId, message.serverNow ? message : { ...message, serverNow: this.now() });
        } catch {
            // 切れた接続には送れなくてよい（切断の通知で片付ける）
        }
    }

    // ===== メッセージ =====

    joinedMessage(room, seat) {
        const player = room.players[seat];
        return {
            connectionId: player.connectionId,
            message: { type: 'joined', roomCode: room.code, seat, token: player.token, playerId: player.id }
        };
    }

    // 部屋の状態（参加者・接続状況・ホスト・設定）。対戦中も、参加者の状態が変わるたびに全員へ送る
    // 席番号は詰まることがあるので、受け取る人の今の席番号を添える
    lobbyMessages(room) {
        const lobby = this.lobbyState(room);
        return room.players
            .map((player, seat) => ({ player, seat }))
            .filter(({ player }) => player.connectionId)
            .map(({ player, seat }) => ({ connectionId: player.connectionId, message: { ...lobby, seat } }));
    }

    lobbyState(room) {
        return {
            type: 'lobby',
            roomCode: room.code,
            status: room.status,
            matchId: room.matchId,
            hostSeat: this.hostSeat(room),
            rematch: this.game.rematch,
            settings: this.game.settings?.forLobby ? this.game.settings.forLobby(room.settings) : room.settings,
            players: room.players.map((player, seat) => ({
                seat,
                id: player.id,
                name: player.name,
                isCPU: Boolean(player.isCPU),
                connected: Boolean(player.isCPU || player.connectionId),
                left: Boolean(player.left),
                ready: Boolean(player.ready)
            }))
        };
    }

    // 部屋の状態が変わったときだけ、全員に送り直す
    lobbyKey(room) {
        return JSON.stringify(this.lobbyState(room));
    }

    // 部屋の状態（変わったときだけ）と、ほかのメッセージを並べる
    // ふだんは部屋の状態を先に送る。対戦が終わったときだけ、最後の操作を反映したビューを先に送る
    // （終わったことを知った端末が、勝者の決まる前のビューで「対戦後の画面」を描かないように）
    withLobby(room, before, outbox) {
        const lobby = this.lobbyMessagesIfChanged(room, before);
        const justEnded = room.status === 'ended' && JSON.parse(before).status !== 'ended';
        return justEnded ? [...outbox, ...lobby] : [...lobby, ...outbox];
    }

    lobbyMessagesIfChanged(room, before) {
        return this.lobbyKey(room) === before ? [] : this.lobbyMessages(room);
    }

    stateMessage(room, game, seat, since, extra = {}) {
        const view = this.game.view(game, seat, { since, room: this.lobbyState(room) });
        return {
            connectionId: room.players[seat].connectionId,
            message: { type: 'state', matchId: room.matchId, view, ...extra }
        };
    }

    // 今のゲームの状態を、接続している人間それぞれのビューにして残す
    snapshot(room, game, since, extra = {}) {
        return room.players
            .map((player, seat) => ({ player, seat }))
            .filter(({ player }) => player.connectionId)
            .map(({ seat }) => this.stateMessage(room, game, seat, since, extra));
    }

    toConnected(room, createMessage) {
        return room.players
            .map((player, seat) => ({ player, seat }))
            .filter(({ player }) => player.connectionId)
            .map(({ player, seat }) => ({ connectionId: player.connectionId, message: createMessage(player, seat) }));
    }

    pong(connectionId, { clientTime }) {
        return { connectionId, message: { type: 'pong', clientTime: Number.isFinite(clientTime) ? clientTime : null } };
    }

    // ===== 補助 =====

    // 接続から部屋と席を求める。席は接続の記録に持たず、部屋の players から connectionId で探す（席が詰まってもずれない）
    // 接続→部屋番号の対応はメモリに置き、部屋は毎回読む（中継のたびの読み込みを1回にするため）
    async loadMember(connectionId, { quiet = false } = {}) {
        const cachedCode = this.connectionCache.get(connectionId);
        if (cachedCode) {
            const room = await this.store.getRoom(cachedCode);
            const seat = room ? this.seatOf(room, connectionId) : -1;
            if (seat >= 0) return { room, seat };
            this.connectionCache.delete(connectionId);
        }
        const connection = await this.store.getConnection(connectionId);
        const room = connection ? await this.store.getRoom(connection.roomCode) : null;
        const seat = room ? this.seatOf(room, connectionId) : -1;
        if (seat < 0) {
            if (quiet) return { room: null, seat: -1 };
            throw new GameError('部屋に入っていません', 'not_member');
        }
        this.rememberConnection(connectionId, room.code);
        return { room, seat };
    }

    rememberConnection(connectionId, roomCode) {
        this.connectionCache.delete(connectionId);
        this.connectionCache.set(connectionId, roomCode);
        if (this.connectionCache.size > CONNECTION_CACHE_SIZE) {
            this.connectionCache.delete(this.connectionCache.keys().next().value);
        }
    }

    seatOf(room, connectionId) {
        return room.players.findIndex(player => player.connectionId === connectionId);
    }

    // 部屋を作った人の役：退出していない最初の人間（接続中の人を優先）。席0が抜けても次の人が引き継ぐ
    hostSeat(room) {
        const candidates = room.players
            .map((player, seat) => ({ player, seat }))
            .filter(({ player }) => !player.isCPU && !player.left);
        return (candidates.find(({ player }) => player.connectionId) ?? candidates[0])?.seat ?? -1;
    }

    assertHost(room, seat) {
        if (seat !== this.hostSeat(room)) throw new GameError('部屋を作った人だけが操作できます', 'not_host');
    }

    activePlayers(room) {
        return room.players.filter(player => !player.left);
    }

    removeLeftPlayers(room) {
        room.players = room.players.filter(player => !player.left);
    }

    restoreGame(room) {
        return this.game.restore ? this.game.restore(room.game, room) : room.game;
    }

    async putConnection(connectionId, roomCode) {
        await this.store.putConnection({ connectionId, roomCode, expiresAt: this.expiresAt() });
        this.rememberConnection(connectionId, roomCode);
    }

    newPlayer(name, connectionId) {
        const trimmed = String(name ?? '').trim().slice(0, this.game.maxNameLength);
        return { id: this.createPlayerId(), name: trimmed || 'プレイヤー', isCPU: false, token: this.createToken(), connectionId };
    }

    // 参加者を見分ける番号（token と違って、ほかの人に見せてよい）
    createPlayerId() {
        return Math.floor(this.random() * 2 ** 32).toString(36);
    }

    createRoomCode() {
        return Array.from({ length: CODE_LENGTH },
            () => CODE_ALPHABET[Math.floor(this.random() * CODE_ALPHABET.length)]).join('');
    }

    expiresAt() {
        return Math.floor(this.now() / 1000) + this.game.roomTtlSeconds;
    }
}

// ゲームの定義の actions・onPlayerGone・onJoin・onDeadline に渡す道具
class GameContext {
    constructor(service, room, seat, message) {
        this.service = service;
        this.room = room;
        this.seat = seat;
        this.message = message;
        this.outbox = [];
        this.ignored = false;
        this.touched = false;        // game を読んだ・変えた（フックでは、読んだら変わったものとして扱う）
        this.stateSuppressed = false;
        this.liveGame = undefined;
        // ({ game, reject, now }) => ... のように取り出しても使えるようにする
        ['now', 'random', 'isConnected', 'opponents', 'reply', 'toSeat', 'broadcast', 'reject', 'ignore', 'noState', 'endMatch']
            .forEach(name => { this[name] = this[name].bind(this); });
    }

    // 動く形のゲーム（restore したもの）。最初に読んだときに作る
    get game() {
        if (this.liveGame === undefined) this.liveGame = this.service.restoreGame(this.room);
        this.touched = true;
        return this.liveGame;
    }

    set game(game) {
        this.setGame(game);
    }

    setGame(game) {
        this.liveGame = game;
        this.touched = true;
    }

    get players() { return this.room.players; }
    get settings() { return this.room.settings; }
    get matchId() { return this.room.matchId; }
    get status() { return this.room.status; }
    now() { return this.service.now(); }
    random() { return this.service.random(); }

    isConnected(seat) {
        const player = this.room.players[seat];
        return Boolean(player && !player.left && (player.isCPU || player.connectionId));
    }

    // 自分以外の、退出していない参加者の席（2人対戦なら相手）
    opponents(seat = this.seat) {
        return this.room.players.map((player, index) => index)
            .filter(index => index !== seat && !this.room.players[index].left);
    }

    reply(message) { this.toSeat(this.seat, message); }

    toSeat(seat, message) {
        const connectionId = this.room.players[seat]?.connectionId;
        if (connectionId) this.outbox.push({ connectionId, message });
    }

    broadcast(message, { except = null } = {}) {
        this.room.players.forEach((player, seat) => {
            if (seat !== except) this.toSeat(seat, message);
        });
    }

    // 操作を断る：理由（画面に出す）と一緒に、今の状態を本人に返す
    reject(message = '今はその操作はできません') {
        throw new RejectError(message);
    }

    // 古い操作・届く順のずれた操作などを黙って捨てる（保存も、状態の送信もしない）
    ignore() { this.ignored = true; }

    // 保存はするが、各人のビュー（state）は送らない
    noState() { this.stateSuppressed = true; }

    // 対戦を終える（isOver を使わないゲーム用）
    endMatch() {
        this.touched = true;
        if (this.room.status === 'playing') this.room.status = 'ended';
    }
}

function withSave(outbox) {
    outbox.save = true;
    return outbox;
}

function withoutSave(outbox) {
    outbox.save = false;
    return outbox;
}
