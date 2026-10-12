/**
 * オンライン対戦のサーバーとの通信（画面側、ゲームに共通の部分）
 * 接続・再接続・参加情報の保存・ping・時計のずれの補正・送信・招待URL・イベント通知を行う。画面の描画はしない
 *
 * 普通の <script> で読み込むと window.NetplayClient になる。ES モジュールからは netplay-client.mjs を import する
 *
 * 使い方:
 *   const net = new NetplayClient({ serverUrl, storageKey: 'mineBlocks.online' });
 *   net.on('lobby', (lobby) => ...);       // 部屋の状態（対戦中も、参加者が変わるたびに届く）
 *   net.on('state', (state) => ...);       // 自分のビュー（CPU の手は cpuStepDelayMs ごとに順に届く）
 *   net.on('relay', (message) => ...);     // ゲーム独自のメッセージは type 名で受け取る
 *   await net.createRoom('あお');
 *   net.send('solved', { round: 1 });
 */

(function () {
    const DEFAULT_PING_INTERVAL_MS = 5 * 60 * 1000; // API Gateway は10分間何も送らないと切るので、その前に送る
    const DEFAULT_RECONNECT_DELAY_MS = 2000;
    const LEAVE_TIMEOUT_MS = 1500;                   // 退出の返事を待つ時間（届かなくても片付ける）

    class NetplayClient {
        // serverUrl: 接続先（NetplayClient.resolveServerUrl で決めるとよい）
        // storageKey: 参加情報を保存する localStorage のキー（ゲームごとに変える）
        // cpuStepDelayMs: cpu: true の state を、この間隔で順に届ける（0 ならすぐ届ける）
        constructor({ serverUrl, storageKey, pingIntervalMs = DEFAULT_PING_INTERVAL_MS,
            reconnectDelayMs = DEFAULT_RECONNECT_DELAY_MS, cpuStepDelayMs = 0, roomParam = 'room', keepParams = ['server'] } = {}) {
            this.serverUrl = serverUrl;
            this.storageKey = storageKey;
            this.pingIntervalMs = pingIntervalMs;
            this.reconnectDelayMs = reconnectDelayMs;
            this.cpuStepDelayMs = cpuStepDelayMs;
            this.roomParam = roomParam;
            this.keepParams = keepParams;    // 招待URLに残す項目（接続先の ?server= など）

            this.listeners = new Map();
            this.socket = null;
            this.session = this.loadSession(); // { roomCode, token, seat, name }
            this.lobby = null;                 // 最後に届いた部屋の状態（部屋に入っていなければ null）
            this.seat = this.session?.seat ?? null;
            this.matchId = null;
            this.clockOffset = 0;              // サーバーの時計 - 端末の時計
            this.bestRoundTrip = Infinity;     // 一番速かった ping の往復時間（この時の補正を信用する）
            this.stateQueue = [];
            this.stateTimer = null;
            this.lastStateAt = 0;
            this.pingTimer = null;
            this.reconnectTimer = null;
            this.isLeaving = false;
            this.pendingName = null;
            this.joiningRoomCode = null;       // 最後に参加を頼んだ部屋番号

            // スマホのスリープから戻ったら、待たずにつなぎ直す
            if (typeof document !== 'undefined') {
                document.addEventListener('visibilitychange', () => {
                    if (document.visibilityState === 'visible' && this.session && !this.isOpen()) this.reconnect();
                });
            }
        }

        // ?server=wss://... で接続先を変えられる。手元（localhost）で開いたときはテスト用サーバーにつなぐ
        static resolveServerUrl({ deployed, local = 'ws://localhost:8787' }) {
            if (typeof location === 'undefined') return deployed;
            const override = new URLSearchParams(location.search).get('server');
            if (override) return override;
            if (['localhost', '127.0.0.1'].includes(location.hostname) || location.protocol === 'file:') return local;
            return deployed;
        }

        // ===== イベント =====

        // type: 'joined' / 'lobby' / 'state' / 'error' / 'left' / 'stamp' / 'pong' / 'connection'（true/false）
        //       / 'message'（すべてのメッセージ）/ ゲーム独自のメッセージの type
        on(type, listener) {
            if (!this.listeners.has(type)) this.listeners.set(type, new Set());
            this.listeners.get(type).add(listener);
            return () => this.listeners.get(type).delete(listener);
        }

        emit(type, payload) {
            this.listeners.get(type)?.forEach(listener => listener(payload));
        }

        // ===== 接続 =====

        connect() {
            return new Promise((resolve, reject) => {
                if (!this.serverUrl) {
                    reject(new Error('オンライン対戦のサーバーが設定されていません'));
                    return;
                }
                const socket = new WebSocket(this.serverUrl);
                this.socket = socket;
                socket.addEventListener('open', () => {
                    this.emit('connection', true);
                    this.startPing();
                    resolve();
                });
                socket.addEventListener('error', () => reject(new Error('サーバーに接続できませんでした')));
                socket.addEventListener('message', (event) => {
                    let message;
                    try {
                        message = JSON.parse(event.data);
                    } catch {
                        return;
                    }
                    this.receive(message);
                });
                socket.addEventListener('close', () => {
                    if (this.socket !== socket) return;
                    this.stopPing();
                    this.emit('connection', false);
                    // 部屋に入っていれば、少し待ってつなぎ直す（スマホのスリープや、API Gateway の2時間の上限で切れたとき）
                    if (!this.isLeaving && this.session) this.scheduleReconnect();
                });
            });
        }

        scheduleReconnect() {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = setTimeout(() => this.reconnect(), this.reconnectDelayMs);
        }

        async reconnect() {
            clearTimeout(this.reconnectTimer);
            if (this.isLeaving || !this.session || this.isOpen() || this.isConnecting()) return;
            try {
                await this.connect();
                this.request({ action: 'join', roomCode: this.session.roomCode, token: this.session.token });
            } catch {
                this.scheduleReconnect();
            }
        }

        isOpen() {
            return this.socket?.readyState === WebSocket.OPEN;
        }

        isConnecting() {
            return this.socket?.readyState === WebSocket.CONNECTING;
        }

        async ensureConnected() {
            this.isLeaving = false;
            if (!this.isOpen()) await this.connect();
        }

        request(message) {
            if (!this.isOpen()) {
                if (this.session) this.reconnect();
                return false;
            }
            if (message.action === 'join') this.joiningRoomCode = message.roomCode;
            this.socket.send(JSON.stringify(message));
            return true;
        }

        // 接続を保つための ping。往復時間から時計のずれも直す
        startPing() {
            this.stopPing();
            this.ping();
            this.pingTimer = setInterval(() => this.ping(), this.pingIntervalMs);
        }

        stopPing() {
            clearInterval(this.pingTimer);
            this.pingTimer = null;
        }

        ping() {
            this.request({ action: 'ping', clientTime: Date.now() });
        }

        // ===== 部屋の操作 =====

        async createRoom(name) {
            await this.ensureConnected();
            this.pendingName = name;
            return this.request({ action: 'create', name });
        }

        // 同じ部屋に入ったことがあれば、その席に戻る
        async joinRoom(roomCode, name) {
            await this.ensureConnected();
            this.pendingName = name;
            const code = String(roomCode ?? '').trim();
            const token = this.session?.roomCode === code ? this.session.token : undefined;
            return this.request({ action: 'join', roomCode: code, name, token });
        }

        // 保存した参加情報で、前の席に戻る
        async resume() {
            if (!this.session) return false;
            await this.ensureConnected();
            return this.request({ action: 'join', roomCode: this.session.roomCode, token: this.session.token });
        }

        // 部屋を出る（サーバーの返事を少し待って、接続を閉じる。参加情報も消す）
        leave() {
            const sent = this.request({ action: 'leave' });
            this.isLeaving = true;
            this.clearSession();
            if (!sent) {
                this.close();
                return;
            }
            this.leaveTimer = setTimeout(() => this.close(), LEAVE_TIMEOUT_MS);
        }

        close() {
            clearTimeout(this.leaveTimer);
            clearTimeout(this.reconnectTimer);
            this.stopPing();
            this.clearStates();
            const socket = this.socket;
            this.socket = null;
            socket?.close();
            this.lobby = null;
            this.seat = null;
            this.matchId = null;
        }

        // ゲームの操作を送る。対戦中の操作には今の matchId を付ける（前の対戦の操作が混ざらないように）
        send(action, payload = {}) {
            return this.request({ matchId: this.matchId ?? undefined, ...payload, action });
        }

        start() { return this.request({ action: 'start' }); }
        ready(ready = true) { return this.request({ action: 'ready', ready }); }
        backToLobby() { return this.request({ action: 'backToLobby' }); }
        setSettings(settings) { return this.request({ action: 'setSettings', settings }); }
        addCpu() { return this.request({ action: 'addCpu' }); }
        removeCpu(seat) { return this.request({ action: 'removeCpu', seat }); }
        stamp(stamp) { return this.request({ action: 'stamp', stamp }); }

        isInRoom() {
            return this.lobby !== null;
        }

        isHost() {
            return this.lobby !== null && this.lobby.hostSeat === this.seat;
        }

        // サーバーの今の時刻（開始時刻などを端末の時計に直すときに使う）
        serverNow() {
            return Date.now() + this.clockOffset;
        }

        // サーバーの時刻を、端末の時刻に直す
        toLocalTime(serverTime) {
            return serverTime - this.clockOffset;
        }

        // ===== サーバーからのメッセージ =====

        receive(message) {
            this.updateClock(message);
            switch (message.type) {
                case 'joined':
                    this.seat = message.seat;
                    this.session = { roomCode: message.roomCode, token: message.token, seat: message.seat, name: this.pendingName ?? this.session?.name };
                    this.saveSession(this.session);
                    break;
                case 'lobby':
                    // まだ見せていない state（CPU の手）があれば、その後ろに並べる（state より先に「対戦後」を知らせないため）
                    if (message.status !== 'lobby' && (this.stateTimer || this.stateQueue.length > 0)) {
                        this.stateQueue.push(message);
                        return;
                    }
                    this.applyLobby(message);
                    break;
                case 'state':
                    if (message.matchId !== undefined && this.matchId !== null && message.matchId < this.matchId) return;
                    this.enqueueState(message);
                    this.emit('message', message);
                    return;
                case 'left':
                    this.emit('left', message);
                    this.emit('message', message);
                    this.close();
                    return;
                case 'error':
                    // 保存した部屋に戻れなかったら（部屋が消えた・退出済み）、参加情報を消して再接続しない
                    if (!this.lobby && this.session?.roomCode === this.joiningRoomCode
                        && ['room_not_found', 'not_member', 'already_started'].includes(message.code)) {
                        this.clearSession();
                    }
                    break;
            }
            this.emit(message.type, message);
            this.emit('message', message);
        }

        applyLobby(message) {
            this.lobby = message;
            this.seat = message.seat;
            this.matchId = message.matchId;
            if (this.session && this.session.seat !== message.seat) {
                this.session.seat = message.seat;
                this.saveSession(this.session);
            }
            // ロビーに戻ったら、まだ見せていない前の対戦のビューを捨てる
            if (message.status === 'lobby') this.clearStates();
        }

        // ping の返事は往復時間の半分を引いて、一番速かったときの値を使う。それ以外は ping が届くまでの仮の値
        updateClock(message) {
            if (!Number.isFinite(message.serverNow)) return;
            const now = Date.now();
            if (message.type === 'pong' && Number.isFinite(message.clientTime)) {
                const roundTrip = now - message.clientTime;
                if (roundTrip <= this.bestRoundTrip) {
                    this.bestRoundTrip = roundTrip;
                    this.clockOffset = message.serverNow - (message.clientTime + roundTrip / 2);
                }
                return;
            }
            if (this.bestRoundTrip === Infinity) this.clockOffset = message.serverNow - now;
        }

        // CPU の手（cpu: true）は間を置いて1手ずつ届ける（そのあいだに届いた lobby も、順番を守って届ける）
        enqueueState(message) {
            if (!this.cpuStepDelayMs) {
                this.emit('state', message);
                return;
            }
            this.stateQueue.push(message);
            this.playStates();
        }

        // 前の state を見せてから cpuStepDelayMs たつまで、次の CPU の手を待たせる（1通ずつ別々に届いても間を置く）
        playStates() {
            if (this.stateTimer || this.stateQueue.length === 0) return;
            const next = this.stateQueue[0];
            const wait = next.cpu ? this.lastStateAt + this.cpuStepDelayMs - Date.now() : 0;
            if (wait > 0) {
                this.stateTimer = setTimeout(() => {
                    this.stateTimer = null;
                    this.playStates();
                }, wait);
                return;
            }
            this.stateQueue.shift();
            if (next.type === 'lobby') {
                this.applyLobby(next);
                this.emit('lobby', next);
                this.emit('message', next);
            } else {
                this.lastStateAt = Date.now();
                this.emit('state', next);
            }
            this.playStates();
        }

        clearStates() {
            clearTimeout(this.stateTimer);
            this.stateTimer = null;
            this.stateQueue = [];
        }

        // ===== 招待URL =====

        // 招待URL（?room=部屋番号）。接続先の ?server= は残す（手元で別のポートのサーバーを試すときも、同じサーバーにつながるように）
        inviteUrl(roomCode = this.lobby?.roomCode ?? this.session?.roomCode) {
            const current = new URL(location.href);
            const url = new URL(location.href);
            url.search = '';
            url.hash = '';
            this.keepParams.forEach(name => {
                const value = current.searchParams.get(name);
                if (value !== null) url.searchParams.set(name, value);
            });
            url.searchParams.set(this.roomParam, roomCode);
            return url.toString();
        }

        // 開いた URL の部屋番号（招待URLから開いたとき）
        static roomCodeFromUrl(roomParam = 'room') {
            if (typeof location === 'undefined') return null;
            return new URLSearchParams(location.search).get(roomParam);
        }

        // 今の URL に部屋番号を入れる（再読み込みしても部屋に戻れる）。null で外す
        setRoomUrl(roomCode) {
            const url = new URL(location.href);
            if (roomCode) {
                url.searchParams.set(this.roomParam, roomCode);
            } else {
                url.searchParams.delete(this.roomParam);
            }
            history.replaceState(history.state, '', url);
        }

        // ===== 参加情報の保存 =====

        loadSession() {
            try {
                return JSON.parse(localStorage.getItem(this.storageKey) || 'null');
            } catch {
                return null;
            }
        }

        saveSession(session) {
            try {
                if (session) {
                    localStorage.setItem(this.storageKey, JSON.stringify(session));
                } else {
                    localStorage.removeItem(this.storageKey);
                }
            } catch {
                // 保存できなくても、このページを開いている間は遊べる
            }
        }

        clearSession() {
            this.session = null;
            this.saveSession(null);
        }
    }

    globalThis.NetplayClient = NetplayClient;
})();
