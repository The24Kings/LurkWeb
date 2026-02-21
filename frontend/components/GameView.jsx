// ─────────────────────────────────────────────────────────
//  Game View
// ─────────────────────────────────────────────────────────
function GameView({ sessionId, serverAddr, serverPort, onDisconnect }) {

    // ── Persisted state ──────────────────────────────────
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

    // ── State ────────────────────────────────────────────
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
    const [msgTo, setMsgTo] = useState('');
    const [msgText, setMsgText] = useState('');

    // ── Refs ─────────────────────────────────────────────
    const connectTimeRef = useRef(savedState?.connectTime || Date.now());
    const msgEndRef = useRef(null);
    const pollingRef = useRef(true);
    const pendingCharRef = useRef(null);
    const roomRef = useRef(room);
    const saveTimerRef = useRef(null);
    const hasStartedRef = useRef(hasStarted);

    // ── Derived values ───────────────────────────────────
    const isDead = myChar ? !isAlive(myChar.flags) : false;
    const isDeadRef = useRef(isDead);

    // Keep refs synced on every render (synchronous, no effect delay)
    roomRef.current = room;
    isDeadRef.current = isDead;
    hasStartedRef.current = hasStarted;

    // ── Memoised entity lists ────────────────────────────
    const entityList = useMemo(() => Object.values(entities), [entities]);
    const players = useMemo(() => entityList.filter(e => !isMonster(e.flags)), [entityList]);
    const monsters = useMemo(() => entityList.filter(e => isMonster(e.flags)), [entityList]);
    const filtered = rightTab === 'players' ? players : rightTab === 'monsters' ? monsters : entityList;

    // ── Debounced localStorage save ──────────────────────
    useEffect(() => {
        if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
        saveTimerRef.current = setTimeout(() => {
            const state = {
                messages, room, connections, entities, myChar,
                initPoints, hasStarted, connectTime: connectTimeRef.current,
            };
            try { localStorage.setItem(stateKey, JSON.stringify(state)); } catch { }
        }, 500);
        return () => { if (saveTimerRef.current) clearTimeout(saveTimerRef.current); };
    }, [messages, room, connections, entities, myChar, initPoints, hasStarted, stateKey]);

    // ── Stable callbacks ─────────────────────────────────
    const addMsg = useCallback((type, sender, text, preformatted = false) => {
        setMessages(prev => {
            const next = [...prev, mkMsg(type, sender, text, preformatted)];
            return next.length > MAX_MESSAGES ? next.slice(-MAX_MESSAGES) : next;
        });
    }, []);

    const addToast = useCallback((text) => {
        const id = Date.now() + Math.random();
        setToasts(prev => [...prev, { id, text }]);
        setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 5000);
    }, []);

    const addError = useCallback((sender, text) => {
        addToast(`${sender}: ${text}`);
    }, [addToast]);

    // ── Stable action callbacks (passed to memoised EntityCard) ──
    const doFight = useCallback(async () => {
        if (isDeadRef.current) return;
        log.info('ACTION', 'Fight');
        try { await api.fight(); } catch (e) { addError('Error', e?.data?.error || 'Fight failed'); }
    }, [addError]);

    const doLoot = useCallback(async (name) => {
        if (isDeadRef.current) return;
        log.info('ACTION', `Loot → ${name}`);
        try { await api.loot(name); } catch (e) { addError('Error', e?.data?.error || 'Loot failed'); }
    }, [addError]);

    const startMessageTo = useCallback((name) => {
        setMsgTo(name);
        setTimeout(() => document.getElementById('msg-text-input')?.focus(), 50);
    }, []);

    // ── Packet handler ───────────────────────────────────
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
                    5: 'Loot', 6: 'Start', 7: 'Error', 8: 'Accept', 9: 'Room',
                    10: 'Character', 11: 'Game', 12: 'Leave', 13: 'Connection', 14: 'Version'
                };
                addMsg('t-accept', 'Accepted', typeMap[pkt.accept_type] || `Type ${pkt.accept_type}`);
                if (pkt.accept_type === 6) setHasStarted(true);
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

            case 'ROOM': {
                const newRoom = { number: pkt.room_number, name: pkt.room_name, description: pkt.description };
                roomRef.current = newRoom; // sync immediately for same-batch CHARACTER packets
                setRoom(newRoom);
                setEntities(() => ({}));
                setConnections([]);
                addMsg('t-narration', 'Room', `Entered ${pkt.room_name || 'Room ' + pkt.room_number}`);
                break;
            }

            case 'CHARACTER': {
                const n = typeof pkt.name === 'string' ? pkt.name : String(pkt.name);
                const pktRoom = Number(pkt.current_room);
                const ourRoom = roomRef.current ? Number(roomRef.current.number) : null;
                log.debug('PKT', `Character "${n}" room=${pktRoom}, our room=${ourRoom}`);

                // Always keep our own character stats current
                setMyChar(prev => (prev && prev.name === n) ? pkt : prev);

                // Add/update entity if in our room, remove if they left
                setEntities(prev => {
                    if (ourRoom != null && pktRoom !== ourRoom) {
                        if (n in prev) {
                            log.info('PKT', `"${n}" left room ${ourRoom} → ${pktRoom}, removing`);
                            const next = { ...prev };
                            delete next[n];
                            return next;
                        }
                        return prev; // not in our list anyway
                    }
                    return { ...prev, [n]: pkt };
                });
                break;
            }

            case 'GAME':
                setInitPoints(pkt.initial_points || 100);
                addMsg('t-game', 'Game Server', pkt.description || 'Welcome!', true);
                break;

            case 'CONNECTION':
                setConnections(prev => {
                    if (prev.find(c => c.room_number === pkt.room_number)) return prev;
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

    // ── Polling loop ─────────────────────────────────────
    useEffect(() => {
        pollingRef.current = true;
        let alive = true;
        log.info('POLL', 'Starting poll loop');
        (async () => {
            while (alive && pollingRef.current) {
                try {
                    const pkts = await api.poll();
                    if (Array.isArray(pkts) && pkts.length > 0) {
                        log.debug('POLL', `${pkts.length} packet(s)`);
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
                // Small yield — gives React a chance to commit renders
                await new Promise(r => setTimeout(r, 50));
            }
            log.info('POLL', 'Poll loop ended');
        })();
        return () => { alive = false; pollingRef.current = false; };
    }, [processPacket, addError]);

    // Auto-scroll
    useEffect(() => { msgEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);

    // Uptime
    useEffect(() => {
        const iv = setInterval(() => setUptime(Math.floor((Date.now() - connectTimeRef.current) / 1000)), 1000);
        return () => clearInterval(iv);
    }, []);

    // ── Non-stable actions (not passed to memo'd children) ──
    async function doChangeRoom(num) {
        if (isDead) return;
        log.info('ACTION', `Change room → ${num}`);
        try { await api.changeRoom(parseInt(num, 10)); }
        catch (e) { addError('Error', e?.data?.error || 'Move failed'); }
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
            if (!hasStartedRef.current) {
                log.info('ACTION', 'Auto-starting after character sent');
                try { await api.start(); } catch { }
            }
        } catch (e) {
            pendingCharRef.current = null;
            addError('Error', e?.data?.error || 'Character creation failed');
        }
    }

    // ── Render ───────────────────────────────────────────
    return (
        <div className="app">
            {/* Header */}
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
                    {myChar && <span className="player-badge">⚔ {myChar.name}</span>}
                    <button className="btn btn-danger btn-sm" onClick={doLeave}>Disconnect</button>
                </div>
            </div>

            {!connected && (
                <div className="dc-banner">Connection lost. You may need to reconnect.</div>
            )}

            {/* Main Grid */}
            <div className="main-grid">

                {/* Left Sidebar */}
                <div className="left-sidebar">
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

                {/* Center — Messages */}
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

                {/* Right Sidebar — Entities */}
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
                                    <input placeholder="Recipient" value={msgTo} onChange={e => setMsgTo(e.target.value)} />
                                </div>
                                <div className="form-group-stacked">
                                    <label>Message</label>
                                    <input id="msg-text-input" placeholder="Type a message…" value={msgText} onChange={e => setMsgText(e.target.value)} />
                                </div>
                                <button type="submit" className="btn btn-primary btn-sm" style={{ width: '100%' }}
                                    disabled={!connected || isDead || !msgTo.trim() || !msgText.trim()}>Send</button>
                            </form>
                        </div>
                    </div>
                </div>
            </div>

            {/* Character Modal */}
            {charModal && (
                <CharacterModal
                    onSubmit={doCharacter}
                    onCancel={() => setCharModal(false)}
                    budget={initPoints}
                />
            )}

            {/* Death Overlay */}
            {isDead && (
                <div className="modal-overlay">
                    <div className="modal death-modal">
                        <div className="death-icon">💀</div>
                        <h3>You have fallen!</h3>
                        <p style={{ color: 'var(--text-dim)', marginBottom: '1rem' }}>
                            Your character has been slain. Disconnect and reconnect to create a new character.
                        </p>
                        <button className="btn btn-primary btn-block" onClick={doLeave}>Restart</button>
                    </div>
                </div>
            )}

            {/* Toast Container (portal to body) */}
            {ReactDOM.createPortal(
                <div className="toast-container">
                    {toasts.map(t => (
                        <div key={t.id} className="toast-error">
                            <span className="toast-icon">⚠️</span>
                            <span className="toast-text">{t.text}</span>
                            <button className="toast-close" onClick={() => setToasts(prev => prev.filter(x => x.id !== t.id))}>x</button>
                        </div>
                    ))}
                </div>,
                document.body
            )}
        </div>
    );
}
