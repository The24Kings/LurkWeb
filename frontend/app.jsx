const { useState, useEffect, useRef, useCallback, useMemo } = React;

// ─────────────────────────────────────────────────────────
//  Logger
// ─────────────────────────────────────────────────────────
const LOG_LEVELS = { TRACE: 0, DEBUG: 1, INFO: 2, WARN: 3, ERROR: 4 };
let _logLevel = LOG_LEVELS.DEBUG; // Change to TRACE for maximum verbosity

const log = {
    _fmt(tag) { return [`%c[${tag}]`, 'color: #58a6ff; font-weight: bold']; },
    trace(tag, msg, ...args) { if (_logLevel <= LOG_LEVELS.TRACE) console.debug(...this._fmt(tag), msg, ...args); },
    debug(tag, msg, ...args) { if (_logLevel <= LOG_LEVELS.DEBUG) console.debug(...this._fmt(tag), msg, ...args); },
    info(tag, msg, ...args) { if (_logLevel <= LOG_LEVELS.INFO) console.info(...this._fmt(tag), msg, ...args); },
    warn(tag, msg, ...args) { if (_logLevel <= LOG_LEVELS.WARN) console.warn(...this._fmt(tag), msg, ...args); },
    error(tag, msg, ...args) { console.error(...this._fmt(tag), msg, ...args); },
    setLevel(level) { _logLevel = LOG_LEVELS[level] ?? LOG_LEVELS.DEBUG; },
};

// Expose on window so you can do `log.setLevel('TRACE')` in the console
window.log = log;

// ─────────────────────────────────────────────────────────
//  API Layer
// ─────────────────────────────────────────────────────────
const api = {
    base: '',
    sid: null,

    _headers() {
        const h = { 'Content-Type': 'application/json' };
        if (this.sid) h['X-Session-Id'] = this.sid;
        return h;
    },

    async req(method, path, body) {
        const opts = { method, headers: this._headers() };
        if (body !== undefined) opts.body = JSON.stringify(body);
        log.debug('API', `${method} ${path}`, body !== undefined ? body : '');
        const res = await fetch(`${this.base}${path}`, opts);
        const txt = await res.text();
        let data; try { data = JSON.parse(txt); } catch { data = txt; }
        if (!res.ok) {
            log.error('API', `${method} ${path} → ${res.status}`, data);
            throw { status: res.status, data };
        }
        log.trace('API', `${method} ${path} → ${res.status}`, data);
        return data;
    },

    async connect(proxyUrl, address, port) {
        this.base = proxyUrl.replace(/\/+$/, '');
        log.info('API', `Connecting to game server ${address}:${port} via proxy ${proxyUrl}`);
        const d = await this.req('POST', '/connect', { address, port });
        this.sid = d.session_id;
        log.info('API', `Session established: ${d.session_id}`);
        return d.session_id;
    },

    character(pkt) { return this.req('POST', '/character', pkt); },
    changeRoom(num) { return this.req('POST', '/change_room', { room_number: num, packet_type: 'CHANGEROOM' }); },
    fight() { return this.req('POST', '/fight'); },
    start() { return this.req('POST', '/start'); },
    loot(name) { return this.req('POST', '/loot', { target_name: name, packet_type: 'LOOT' }); },
    message(recipient, sender, text) {
        return this.req('POST', '/message', {
            packet_type: 'MESSAGE',
            message_len: text.length,
            recipient: recipient || '',
            sender: sender || '',
            narration: false,
            message: text,
        });
    },
    async leave() {
        log.info('API', 'Leaving session', this.sid);
        const r = await this.req('POST', '/leave');
        this.sid = null;
        return r;
    },
    poll() { return this.req('GET', '/poll'); },
    sessionStatus() { return this.req('GET', '/session_status'); },

    // Rejoin an existing session by setting base/sid and checking status
    async rejoin(proxyUrl, sessionId) {
        this.base = proxyUrl.replace(/\/+$/, '');
        this.sid = sessionId;
        log.info('API', `Attempting to rejoin session ${sessionId} via ${proxyUrl}`);
        const status = await this.sessionStatus();
        if (!status.active) {
            this.sid = null;
            throw new Error('Session is no longer active');
        }
        log.info('API', `Rejoined session ${sessionId}`);
        return status;
    },
};

// ─────────────────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────────────────
const ts = () => new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
let _msgId = 0;
const mkMsg = (type, sender, text, preformatted = false) => ({ type, sender, text, time: ts(), id: ++_msgId, pre: preformatted });

// bitflags v2 with serde serializes as "ALIVE | BATTLE | MONSTER" etc.
function parseFlags(flags) {
    if (typeof flags === 'number') return flags; // fallback if raw int
    if (typeof flags !== 'string') return 0;
    const map = { ALIVE: 0x80, BATTLE: 0x40, MONSTER: 0x20, STARTED: 0x10, READY: 0x08 };
    let val = 0;
    for (const part of flags.split('|')) {
        const key = part.trim();
        if (map[key] !== undefined) val |= map[key];
    }
    return val;
}

function flagBits(raw) { return typeof raw === 'number' ? raw : parseFlags(raw); }
function isAlive(f) { return !!(flagBits(f) & 0x80); }
function isMonster(f) { return !!(flagBits(f) & 0x20); }
function isStarted(f) { return !!(flagBits(f) & 0x10); }
function flagLabel(f) {
    const b = flagBits(f);
    const parts = [];
    if (b & 0x80) parts.push('Alive');
    if (b & 0x40) parts.push('Battle');
    if (b & 0x20) parts.push('Monster');
    if (b & 0x10) parts.push('Started');
    if (b & 0x08) parts.push('Ready');
    return parts.join(' · ') || 'None';
}

// PktType enum — serde derives Serialize as string variant name
const pktName = (p) => {
    if (typeof p === 'string') return p;
    const map = {
        0: 'DEFAULT', 1: 'MESSAGE', 2: 'CHANGEROOM', 3: 'FIGHT', 4: 'PVPFIGHT',
        5: 'LOOT', 6: 'START', 7: 'ERROR', 8: 'ACCEPT', 9: 'ROOM', 10: 'CHARACTER',
        11: 'GAME', 12: 'LEAVE', 13: 'CONNECTION', 14: 'VERSION'
    };
    return map[p] || String(p);
};

// ─────────────────────────────────────────────────────────
//  Context Menu
// ─────────────────────────────────────────────────────────
function ContextMenu({ x, y, items, onClose }) {
    const ref = useRef();
    useEffect(() => {
        const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) onClose(); };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, [onClose]);

    // Keep menu in viewport
    const style = { left: x, top: y };

    return (
        <div className="ctx-menu" style={style} ref={ref}>
            {items.map((item, i) =>
                item.divider
                    ? <div key={i} className="ctx-divider" />
                    : <div key={i} className="ctx-item" onClick={() => { item.action(); onClose(); }}>
                        <span className="ctx-icon">{item.icon}</span>
                        {item.label}
                    </div>
            )}
        </div>
    );
}

// ─────────────────────────────────────────────────────────
//  Entity Card
// ─────────────────────────────────────────────────────────
function EntityCard({ entity, onLoot, onMessage, onFight, disabled }) {
    const [showCtx, setShowCtx] = useState(null);
    const alive = isAlive(entity.flags);
    const monster = isMonster(entity.flags);

    function handleContext(e) {
        e.preventDefault();
        const items = [];
        if (!alive && monster && (entity.gold ?? 0) > 0) items.push({ icon: '💰', label: `Loot ${entity.name}`, action: () => onLoot(entity.name) });
        if (alive) items.push({ icon: '💬', label: `Message ${entity.name}`, action: () => onMessage(entity.name) });
        if (alive) items.push({ icon: '⚔️', label: 'Fight in room', action: () => onFight() });
        if (items.length) setShowCtx({ x: e.clientX, y: e.clientY, items });
    }

    const clickable = alive && !monster;

    return (
        <div
            className={`entity${alive ? '' : ' dead'}${clickable ? ' clickable' : ''}`}
            onContextMenu={handleContext}
            onClick={clickable ? () => onMessage(entity.name) : undefined}
            title={clickable ? `Message ${entity.name}` : undefined}
        >
            <div className="entity-top">
                <span className={`entity-name ${monster ? 'is-monster' : 'is-player'}`}>
                    {monster ? '🗡 ' : '👤 '}{entity.name}
                </span>
                <span className={`entity-badge ${alive ? 'alive' : 'dead-badge'}`}>
                    {alive ? 'ALIVE' : 'DEAD'}
                </span>
            </div>
            <div className="entity-stats">
                <span>ATK {entity.attack ?? '?'}</span>
                <span>DEF {entity.defense ?? '?'}</span>
                <span>REG {entity.regen ?? '?'}</span>
                <span>HP {entity.health ?? '?'}</span>
                <span>Gold {entity.gold ?? 0}</span>
            </div>
            {entity.description && (
                <div className="entity-desc">{entity.description}</div>
            )}
            {/* Inline quick-action buttons */}
            <div className="entity-actions">
                {!alive && monster && (entity.gold ?? 0) > 0 && <button className="entity-action-btn loot" onClick={() => onLoot(entity.name)} disabled={disabled}>Loot</button>}
            </div>
            {showCtx && <ContextMenu {...showCtx} onClose={() => setShowCtx(null)} />}
        </div>
    );
}

// ─────────────────────────────────────────────────────────
//  Character Modal
// ─────────────────────────────────────────────────────────
function CharacterModal({ onSubmit, onCancel, budget, existing }) {
    const [name, setName] = useState(existing?.name || '');
    const [attack, setAttack] = useState(existing?.attack || 0);
    const [defense, setDefense] = useState(existing?.defense || 0);
    const [regen, setRegen] = useState(existing?.regen || 0);
    const [desc, setDesc] = useState(existing?.description || '');
    const [joinBattle, setJoinBattle] = useState(true);

    const total = budget || 100;
    const remaining = total - attack - defense - regen;

    function quickAlloc() {
        setAttack(Math.floor(total / 2));
        setDefense(Math.floor(total / 4));
        setRegen(Math.floor(total / 4));
    }

    function handleSubmit(e) {
        e.preventDefault();
        if (!name.trim()) return;
        // Auto-allocate remaining points
        let a = attack, d = defense, r = regen;
        let leftover = total - a - d - r;
        if (leftover < 0) return; // over budget
        if (leftover > 0) {
            const third = Math.floor(leftover / 3);
            a += third;
            d += third;
            r += leftover - third - third; // remainder goes to regen
        }
        // Build flags string matching bitflags serde format
        const flagParts = ['ALIVE', 'READY'];
        if (joinBattle) flagParts.push('BATTLE');
        onSubmit({
            name: name.trim(),
            flags: flagParts.join(' | '),
            attack: a,
            defense: d,
            regen: r,
            health: 0,
            gold: 0,
            current_room: 0,
            description_len: desc.length,
            description: desc,
            packet_type: 'CHARACTER',
        });
    }

    return (
        <div className="modal-overlay" onClick={onCancel}>
            <div className="modal" onClick={e => e.stopPropagation()}>
                <h3>{existing ? 'Update Character' : 'Create Character'}</h3>
                <form onSubmit={handleSubmit}>
                    <div className="form-group">
                        <label>Character Name</label>
                        <input value={name} onChange={e => setName(e.target.value)} maxLength={32} required autoFocus placeholder="Enter a name..." />
                    </div>

                    <div className={`points-display ${remaining < 0 ? 'over' : 'ok'}`}>
                        Points: {remaining} / {total} remaining
                    </div>

                    <div className="stat-grid">
                        <div className="form-group">
                            <label>Attack</label>
                            <input type="number" min="0" value={attack} onChange={e => setAttack(Math.max(0, +e.target.value))} />
                        </div>
                        <div className="form-group">
                            <label>Defense</label>
                            <input type="number" min="0" value={defense} onChange={e => setDefense(Math.max(0, +e.target.value))} />
                        </div>
                        <div className="form-group">
                            <label>Regen</label>
                            <input type="number" min="0" value={regen} onChange={e => setRegen(Math.max(0, +e.target.value))} />
                        </div>
                    </div>

                    <div style={{ textAlign: 'center', marginBottom: '0.5rem' }}>
                        <button type="button" className="btn btn-ghost btn-sm" onClick={quickAlloc}>
                            Quick Allocate (50/25/25)
                        </button>
                    </div>

                    <div className="form-group">
                        <label>Join Battles Automatically</label>
                        <select value={joinBattle ? 'yes' : 'no'} onChange={e => setJoinBattle(e.target.value === 'yes')}>
                            <option value="yes">Yes</option>
                            <option value="no">No</option>
                        </select>
                    </div>

                    <div className="form-group">
                        <label>Description</label>
                        <textarea value={desc} onChange={e => setDesc(e.target.value)} maxLength={256} rows={3} placeholder="A brave adventurer..." />
                    </div>

                    <div className="modal-footer">
                        <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel}>Cancel</button>
                        <button type="submit" className="btn btn-primary btn-sm" disabled={remaining < 0 || !name.trim()}>
                            {existing ? 'Update' : 'Create'}
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
}

// ─────────────────────────────────────────────────────────
//  Connect Screen
// ─────────────────────────────────────────────────────────
function ConnectScreen({ onConnect }) {
    const [proxyUrl, setProxyUrl] = useState(() => localStorage.getItem('lurk_proxy') || 'http://localhost:8080');
    const [address, setAddress] = useState(() => localStorage.getItem('lurk_addr') || '');
    const [port, setPort] = useState(() => localStorage.getItem('lurk_port') || '5024');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);

    async function handleSubmit(e) {
        e.preventDefault();
        setError(null);
        setLoading(true);
        log.info('CONNECT', `Attempting connection: ${address}:${port} via ${proxyUrl}`);
        try {
            localStorage.setItem('lurk_proxy', proxyUrl);
            localStorage.setItem('lurk_addr', address);
            localStorage.setItem('lurk_port', port);
            const sid = await api.connect(proxyUrl, address, parseInt(port, 10));
            log.info('CONNECT', `Connected! Session: ${sid}`);
            onConnect(sid, address, port, proxyUrl);
        } catch (err) {
            log.error('CONNECT', 'Connection failed', err);
            setError(err?.data?.error || err?.message || 'Connection failed. Is the proxy running?');
        } finally {
            setLoading(false);
        }
    }

    return (
        <div className="connect-screen">
            <div className="connect-box">
                <div className="logo">
                    <div className="logo-title">LURK</div>
                    <div className="logo-sub">Web Client</div>
                </div>
                <form onSubmit={handleSubmit}>
                    <div className="form-group">
                        <label>Proxy Server URL</label>
                        <input value={proxyUrl} onChange={e => setProxyUrl(e.target.value)} placeholder="http://localhost:8080" />
                    </div>
                    <div className="connect-row">
                        <div className="form-group">
                            <label>Game Server Address</label>
                            <input value={address} onChange={e => setAddress(e.target.value)} placeholder="hostname or IP" required />
                        </div>
                        <div className="form-group port">
                            <label>Port</label>
                            <input type="number" value={port} onChange={e => setPort(e.target.value)} placeholder="5024" required />
                        </div>
                    </div>
                    {error && <div className="connect-error">{error}</div>}
                    <button type="submit" className="btn btn-primary btn-block" disabled={loading} style={{ marginTop: '0.5rem' }}>
                        {loading ? 'Connecting…' : 'Connect'}
                    </button>
                </form>
                <div className="connect-hint">
                    The proxy bridges HTTP to the Lurk TCP protocol.<br />
                    Run the backend proxy first, then connect.
                </div>
            </div>
        </div>
    );
}

// ─────────────────────────────────────────────────────────
//  Game View
// ─────────────────────────────────────────────────────────
function GameView({ sessionId, serverAddr, serverPort, proxyUrl, onDisconnect }) {
    // ── State persistence helpers ────────────────────
    const stateKey = `lurk_state_${sessionId}`;
    const savedState = useMemo(() => {
        try {
            const raw = localStorage.getItem(stateKey);
            if (raw) {
                const s = JSON.parse(raw);
                log.info('STATE', 'Restored saved state', s);
                return s;
            }
        } catch (e) { log.warn('STATE', 'Failed to parse saved state', e); }
        return null;
    }, [stateKey]);

    const [messages, setMessages] = useState(savedState?.messages || []);
    const [room, setRoom] = useState(savedState?.room || null);
    const [connections, setConnections] = useState(savedState?.connections || []);
    const [entities, setEntities] = useState(savedState?.entities || {});
    const [myChar, setMyChar] = useState(savedState?.myChar || null);
    const [charModal, setCharModal] = useState(false);
    const [initPoints, setInitPoints] = useState(savedState?.initPoints || 100);
    const [connected, setConnected] = useState(true);
    const [hasStarted, setHasStarted] = useState(savedState?.hasStarted || false);
    const [toasts, setToasts] = useState([]);
    const [rightTab, setRightTab] = useState('all');
    const [uptime, setUptime] = useState(0);
    const connectTimeRef = useRef(savedState?.connectTime || Date.now());

    // Save state to localStorage on changes
    useEffect(() => {
        const state = { messages, room, connections, entities, myChar, initPoints, hasStarted, connectTime: connectTimeRef.current };
        try { localStorage.setItem(stateKey, JSON.stringify(state)); } catch { }
    }, [messages, room, connections, entities, myChar, initPoints, hasStarted, stateKey]);

    // Message bar state
    const [msgTo, setMsgTo] = useState('');
    const [msgText, setMsgText] = useState('');

    const msgEndRef = useRef(null);
    const pollingRef = useRef(true);
    const pendingCharRef = useRef(null);

    const addMsg = useCallback((type, sender, text, preformatted = false) => {
        setMessages(prev => [...prev, mkMsg(type, sender, text, preformatted)]);
    }, []);

    const addToast = useCallback((text) => {
        const id = Date.now() + Math.random();
        setToasts(prev => [...prev, { id, text }]);
        setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 5000);
    }, []);

    const addError = useCallback((sender, text) => {
        addToast(`${sender}: ${text}`);
    }, [addToast]);

    // ── Packet handler ──────────────────────────────────
    const processPacket = useCallback((pkt) => {
        const pt = pktName(pkt.packet_type);
        log.debug('PKT', `Received ${pt}`, pkt);

        switch (pt) {
            case 'MESSAGE': {
                const isNarration = pkt.narration === true;
                addMsg(
                    isNarration ? 't-narration' : 't-chat',
                    pkt.sender || 'Server',
                    pkt.message || ''
                );
                break;
            }
            case 'ERROR':
                addError(`Error (${pkt.error || '?'})`, pkt.message || '');
                break;

            case 'ACCEPT': {
                const typeMap = {
                    1: 'Message', 2: 'ChangeRoom', 3: 'Fight', 4: 'PVPFight',
                    5: 'Loot', 6: 'Start', 7: 'Error', 8: 'Accept', 9: 'Room', 10: 'Character',
                    11: 'Game', 12: 'Leave', 13: 'Connection', 14: 'Version'
                };
                addMsg('t-accept', 'Accepted', typeMap[pkt.accept_type] || `Type ${pkt.accept_type}`);
                if (pkt.accept_type === 6) setHasStarted(true);
                // Server accepts Character (10) — show char, close modal, auto-start
                if (pkt.accept_type === 10) {
                    if (pendingCharRef.current) {
                        setMyChar(pendingCharRef.current);
                        pendingCharRef.current = null;
                    }
                    setCharModal(false);
                    setHasStarted(true);
                }
                break;
            }
            case 'ROOM':
                setRoom({ number: pkt.room_number, name: pkt.room_name, description: pkt.description });
                setEntities({});
                setConnections([]);
                addMsg('t-narration', 'Room', `Entered ${pkt.room_name || 'Room ' + pkt.room_number}`);
                break;

            case 'CHARACTER': {
                const n = typeof pkt.name === 'string' ? pkt.name : String(pkt.name);
                setEntities(prev => ({ ...prev, [n]: pkt }));
                setMyChar(prev => {
                    if (prev && prev.name === n) return pkt;
                    return prev;
                });
                break;
            }
            case 'GAME':
                setInitPoints(pkt.initial_points || 100);
                addMsg('t-game', 'Game Server', pkt.description || 'Welcome!', true);
                break;

            case 'CONNECTION':
                setConnections(prev => {
                    const exists = prev.find(c => c.room_number === pkt.room_number);
                    if (exists) return prev;
                    return [...prev, { room_number: pkt.room_number, room_name: pkt.room_name, description: pkt.description }];
                });
                break;

            case 'VERSION':
                addMsg('t-server', 'Server', `Protocol v${pkt.major_rev}.${pkt.minor_rev}`);
                break;

            case 'LEAVE':
                addMsg('t-system', 'Server', 'Leave acknowledged.');
                break;

            case 'DISCONNECTED':
                setConnected(false);
                addError('System', 'Disconnected from server.');
                break;

            default:
                log.warn('PKT', `Unhandled packet type: ${pt}`, pkt);
                addMsg('t-system', 'Packet', JSON.stringify(pkt));
        }
    }, [addMsg, addError]);

    // ── Polling loop ────────────────────────────────────
    useEffect(() => {
        pollingRef.current = true;
        let alive = true;
        log.info('POLL', 'Starting poll loop');
        (async () => {
            while (alive && pollingRef.current) {
                try {
                    const pkts = await api.poll();
                    if (Array.isArray(pkts) && pkts.length > 0) {
                        log.debug('POLL', `Received ${pkts.length} packet(s)`);
                        pkts.forEach(processPacket);
                    }
                } catch (err) {
                    if (!alive) break;
                    if (err.status === 404) {
                        log.warn('POLL', 'Session expired (404)');
                        setConnected(false);
                        addError('System', 'Session expired.');
                        break;
                    }
                    log.warn('POLL', 'Poll error, retrying in 3s', err);
                    await new Promise(r => setTimeout(r, 3000));
                }
            }
            log.info('POLL', 'Poll loop ended');
        })();
        return () => { alive = false; pollingRef.current = false; };
    }, [processPacket, addMsg]);

    // Auto-scroll messages
    useEffect(() => { msgEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);

    // Uptime timer
    useEffect(() => {
        const iv = setInterval(() => setUptime(Math.floor((Date.now() - connectTimeRef.current) / 1000)), 1000);
        return () => clearInterval(iv);
    }, []);
    const fmtUptime = (s) => {
        const h = Math.floor(s / 3600);
        const m = Math.floor((s % 3600) / 60);
        const sec = s % 60;
        return h > 0 ? `${h}h ${m}m ${sec}s` : m > 0 ? `${m}m ${sec}s` : `${sec}s`;
    };

    // ── Actions ─────────────────────────────────────────
    async function doFight() {
        if (isDead) return;
        log.info('ACTION', 'Fight');
        try { await api.fight(); } catch (e) { addError('Error', e?.data?.error || 'Fight failed'); }
    }

    async function doChangeRoom(num) {
        if (isDead) return;
        log.info('ACTION', `Change room → ${num}`);
        try { await api.changeRoom(parseInt(num, 10)); }
        catch (e) { addError('Error', e?.data?.error || 'Move failed'); }
    }

    async function doLoot(name) {
        if (isDead) return;
        log.info('ACTION', `Loot → ${name}`);
        try { await api.loot(name); }
        catch (e) { addError('Error', e?.data?.error || 'Loot failed'); }
    }

    async function doMessage(to, text) {
        if (isDead) return;
        if (!text.trim()) return;
        log.info('ACTION', `Message → ${to || '(all)'}: ${text}`);
        try {
            await api.message(to, myChar?.name || '', text);
            addMsg('t-you', myChar?.name || 'You', `→ ${to || 'everyone'}: ${text}`);
            setMsgText('');
        } catch (e) { addError('Error', e?.data?.error || 'Message failed'); }
    }

    async function doLeave() {
        log.info('ACTION', 'Leave');
        pollingRef.current = false;
        try { localStorage.removeItem(stateKey); } catch { }
        try { await api.leave(); } catch { }
        onDisconnect();
    }

    async function doCharacter(pkt) {
        log.info('ACTION', `Character "${pkt.name}" (ATK:${pkt.attack} DEF:${pkt.defense} REG:${pkt.regen})`);
        try {
            pendingCharRef.current = pkt;
            await api.character(pkt);
            addMsg('t-system', 'System', `Character "${pkt.name}" sent to server. Waiting for accept...`);
            // Auto-start after character creation
            if (!hasStarted) {
                log.info('ACTION', 'Auto-starting after character sent');
                try { await api.start(); } catch { }
            }
        } catch (e) {
            pendingCharRef.current = null;
            addError('Error', e?.data?.error || 'Character creation failed');
        }
    }

    // Helper to open message to a specific player
    function startMessageTo(name) {
        setMsgTo(name);
        // Focus the message text input
        setTimeout(() => {
            document.getElementById('msg-text-input')?.focus();
        }, 50);
    }

    // Derived
    const entityList = useMemo(() => Object.values(entities), [entities]);
    const players = useMemo(() => entityList.filter(e => !isMonster(e.flags)), [entityList]);
    const monsters = useMemo(() => entityList.filter(e => isMonster(e.flags)), [entityList]);
    const filtered = rightTab === 'players' ? players : rightTab === 'monsters' ? monsters : entityList;
    const isDead = myChar && !isAlive(myChar.flags);

    return (
        <div className="app">
            {/* ── Header ───────────────────────────── */}
            <div className="header">
                <div className="header-left">
                    <h1>LURK</h1>
                </div>
                <div className="header-right">
                    <span className="uptime">{fmtUptime(uptime)}</span>
                    <span className={`connection-badge ${connected ? 'connected' : 'disconnected'}`}>
                        <span className="dot" />
                        {serverAddr}:{serverPort}
                    </span>
                    {myChar && (
                        <span className="player-badge">
                            ⚔ {myChar.name}
                        </span>
                    )}
                    <button className="btn btn-danger btn-sm" onClick={doLeave}>Disconnect</button>
                </div>
            </div>

            {/* ── Disconnected Banner ──────────────── */}
            {!connected && (
                <div className="dc-banner">
                    Connection lost. You may need to reconnect.
                </div>
            )}

            {/* ── Main Grid ────────────────────────── */}
            <div className="main-grid">

                {/* ── Left Sidebar ──────────────────── */}
                <div className="left-sidebar">
                    {/* Room panel */}
                    <div className="panel">
                        <div className="panel-head">Current Room</div>
                        <div className="panel-body">
                            {room ? (
                                <div className="room-card">
                                    <div className="room-header">
                                        <span className="room-name">{room.name || 'Unknown'}</span>
                                        <span className="room-number">#{room.number}</span>
                                    </div>
                                    {room.description && <div className="room-desc">{room.description}</div>}
                                    {connections.length > 0 && (
                                        <div className="connected-rooms">
                                            <div className="connections-header">Exits</div>
                                            {connections.map(c => (
                                                <button key={c.room_number} className="room-link"
                                                    onClick={() => doChangeRoom(c.room_number)}
                                                    disabled={isDead}
                                                    title={c.description || c.room_name}>
                                                    {c.room_name}
                                                </button>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            ) : (
                                <div className="empty">
                                    <div className="empty-icon">🗺</div>
                                    No room data yet.<br />Create a character and start!
                                </div>
                            )}
                        </div>
                    </div>

                    {/* Character panel */}
                    <div className="panel">
                        <div className="panel-head">
                            Your Character
                            {!myChar && (
                                <button className="btn btn-ghost btn-sm"
                                    onClick={() => setCharModal(true)}
                                    style={{ padding: '0.15rem 0.4rem', fontSize: '0.65rem' }}>
                                    Create
                                </button>
                            )}
                        </div>
                        <div className="panel-body">
                            {myChar ? (
                                <>
                                    <div style={{ fontWeight: 700, color: 'var(--accent-bright)', marginBottom: '0.3rem' }}>
                                        {myChar.name}
                                    </div>
                                    <div style={{ fontSize: '0.68rem', color: 'var(--text-dim)', marginBottom: '0.4rem' }}>
                                        {flagLabel(myChar.flags)}
                                    </div>
                                    <div className="my-stats">
                                        <div className="stat-box"><div className="stat-label">ATK</div><div className="stat-value">{myChar.attack}</div></div>
                                        <div className="stat-box"><div className="stat-label">DEF</div><div className="stat-value">{myChar.defense}</div></div>
                                        <div className="stat-box"><div className="stat-label">REG</div><div className="stat-value">{myChar.regen}</div></div>
                                        <div className="stat-box"><div className="stat-label">HP</div><div className="stat-value hp">{myChar.health}</div></div>
                                        <div className="stat-box"><div className="stat-label">Gold</div><div className="stat-value gold">{myChar.gold ?? 0}</div></div>
                                        <div className="stat-box"><div className="stat-label">Room</div><div className="stat-value">{myChar.current_room ?? '?'}</div></div>
                                    </div>
                                    {myChar.description && (
                                        <div style={{ fontSize: '0.72rem', color: 'var(--text-dim)', fontStyle: 'italic', marginTop: '0.4rem' }}>
                                            {myChar.description}
                                        </div>
                                    )}
                                    <button className="btn btn-danger fight-btn" onClick={doFight} disabled={!connected || isDead}>
                                        ⚔️ Fight
                                    </button>
                                </>
                            ) : (
                                <div className="empty">
                                    <div className="empty-icon">🧙</div>
                                    No character yet.
                                    <div style={{ marginTop: '0.5rem' }}>
                                        <button className="btn btn-primary btn-sm" onClick={() => setCharModal(true)}>Create Character</button>
                                    </div>
                                </div>
                            )}
                        </div>
                    </div>
                </div>

                {/* ── Center: Messages ──────────────── */}
                <div className="center-col">
                    <div className="panel">
                        <div className="panel-head">
                            Messages
                            <span style={{ fontSize: '0.6rem', color: 'var(--text-dim)' }}>{messages.length}</span>
                        </div>
                        <div className="panel-body">
                            <div className="msg-list">
                                {messages.length === 0 && (
                                    <div className="empty">
                                        <div className="empty-icon">💬</div>
                                        No messages yet. Connect and explore!
                                    </div>
                                )}
                                {messages.map(m => (
                                    <div key={m.id} className={`msg ${m.type}`}>
                                        <span className="msg-time">{m.time}</span>
                                        <div className="msg-sender">{m.sender}</div>
                                        {m.pre ? <pre>{m.text}</pre> : <div>{m.text}</div>}
                                    </div>
                                ))}
                                <div ref={msgEndRef} />
                            </div>
                        </div>
                    </div>
                </div>

                {/* ── Right Sidebar: Entities ──────── */}
                <div className="right-sidebar">
                    <div className="panel">
                        <div className="tab-row">
                            {['all', 'players', 'monsters'].map(t => (
                                <button key={t} className={`tab-btn ${rightTab === t ? 'active' : ''}`}
                                    onClick={() => setRightTab(t)}>
                                    {t === 'all' ? `In Room (${entityList.length})` :
                                        t === 'players' ? `Players (${players.length})` :
                                            `Monsters (${monsters.length})`}
                                </button>
                            ))}
                        </div>
                        <div className="panel-body">
                            {filtered.length === 0 ? (
                                <div className="empty">
                                    <div className="empty-icon">{rightTab === 'monsters' ? '🗡' : '👥'}</div>
                                    {rightTab === 'monsters' ? 'No monsters here.' :
                                        rightTab === 'players' ? 'No players here.' :
                                            'No one here yet.'}
                                </div>
                            ) : (
                                filtered.map(e => (
                                    <EntityCard key={typeof e.name === 'string' ? e.name : String(e.name)}
                                        entity={e}
                                        onLoot={doLoot}
                                        onMessage={startMessageTo}
                                        onFight={doFight}
                                        disabled={isDead}
                                    />
                                ))
                            )}
                        </div>
                    </div>

                    {/* Message compose */}
                    <div className="panel msg-panel">
                        <div className="panel-head">Send Message</div>
                        <div className="panel-body">
                            <form className="msg-compose-stacked" onSubmit={e => { e.preventDefault(); doMessage(msgTo, msgText); }}>
                                <div className="form-group-stacked">
                                    <label>To</label>
                                    <input placeholder="Recipient" value={msgTo}
                                        onChange={e => setMsgTo(e.target.value)} />
                                </div>
                                <div className="form-group-stacked">
                                    <label>Message</label>
                                    <input id="msg-text-input" placeholder="Type a message…" value={msgText}
                                        onChange={e => setMsgText(e.target.value)} />
                                </div>
                                <button type="submit" className="btn btn-primary btn-sm" style={{ width: '100%' }}
                                    disabled={!connected || isDead || !msgTo.trim() || !msgText.trim()}>Send</button>
                            </form>
                        </div>
                    </div>
                </div>
            </div>

            {/* ── Character Modal ───────────────────── */}
            {charModal && (
                <CharacterModal
                    onSubmit={doCharacter}
                    onCancel={() => setCharModal(false)}
                    budget={initPoints}
                />
            )}

            {/* ── Death Overlay ─────────────────────── */}
            {isDead && (
                <div className="modal-overlay">
                    <div className="modal death-modal">
                        <div className="death-icon">💀</div>
                        <h3>You have fallen!</h3>
                        <p style={{ color: 'var(--text-dim)', marginBottom: '1rem' }}>
                            Your character has been slain. Disconnect and reconnect to create a new character.
                        </p>
                        <button className="btn btn-primary btn-block" onClick={doLeave}>
                            Restart
                        </button>
                    </div>
                </div>
            )}

            {/* ── Toast Container (portal to body) ── */}
            {ReactDOM.createPortal(
                <div className="toast-container">
                    {toasts.map(t => (
                        <div key={t.id} className="toast-error">
                            <span className="toast-icon">⚠️</span>
                            <span className="toast-text">{t.text}</span>
                            <button className="toast-close" onClick={() => setToasts(prev => prev.filter(x => x.id !== t.id))}>×</button>
                        </div>
                    ))}
                </div>,
                document.body
            )}
        </div>
    );
}

// ─────────────────────────────────────────────────────────
//  App Root
// ─────────────────────────────────────────────────────────
function App() {
    const [session, setSession] = useState(null);
    const [checking, setChecking] = useState(true);

    // On mount, check URL hash for existing session
    useEffect(() => {
        const params = new URLSearchParams(window.location.hash.slice(1));
        const sid = params.get('sid');
        const proxy = params.get('proxy');
        const addr = params.get('addr');
        const port = params.get('port');
        if (sid && proxy) {
            log.info('APP', `Found session in URL: ${sid}`);
            api.rejoin(proxy, sid)
                .then(() => {
                    setSession({ sid, addr: addr || '', port: port || '', proxy });
                })
                .catch((e) => {
                    log.warn('APP', 'Session rejoin failed, clearing URL', e);
                    window.location.hash = '';
                })
                .finally(() => setChecking(false));
        } else {
            setChecking(false);
        }
    }, []);

    // Update URL hash when session changes
    useEffect(() => {
        if (session) {
            const params = new URLSearchParams();
            params.set('sid', session.sid);
            params.set('proxy', session.proxy);
            params.set('addr', session.addr);
            params.set('port', session.port);
            window.location.hash = params.toString();
        } else {
            window.location.hash = '';
        }
    }, [session]);

    if (checking) return <div className="connect-screen"><div className="connect-box"><div className="logo"><div className="logo-title">LURK</div><div className="logo-sub">Reconnecting…</div></div></div></div>;

    return session ? (
        <GameView
            sessionId={session.sid}
            serverAddr={session.addr}
            serverPort={session.port}
            proxyUrl={session.proxy}
            onDisconnect={() => { api.sid = null; setSession(null); }}
        />
    ) : (
        <ConnectScreen onConnect={(sid, addr, port, proxy) => setSession({ sid, addr, port, proxy })} />
    );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
