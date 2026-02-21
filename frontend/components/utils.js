// ─────────────────────────────────────────────────────────
//  React hooks (global destructure)
// ─────────────────────────────────────────────────────────
const { useState, useEffect, useRef, useCallback, useMemo } = React;

// ─────────────────────────────────────────────────────────
//  Logger
// ─────────────────────────────────────────────────────────
const LOG_LEVELS = { TRACE: 0, DEBUG: 1, INFO: 2, WARN: 3, ERROR: 4 };
let _logLevel = LOG_LEVELS.DEBUG;

const log = {
    _fmt(tag) { return [`%c[${tag}]`, 'color: #58a6ff; font-weight: bold']; },
    trace(tag, msg, ...args) { if (_logLevel <= LOG_LEVELS.TRACE) console.debug(...this._fmt(tag), msg, ...args); },
    debug(tag, msg, ...args) { if (_logLevel <= LOG_LEVELS.DEBUG) console.debug(...this._fmt(tag), msg, ...args); },
    info(tag, msg, ...args) { if (_logLevel <= LOG_LEVELS.INFO) console.info(...this._fmt(tag), msg, ...args); },
    warn(tag, msg, ...args) { if (_logLevel <= LOG_LEVELS.WARN) console.warn(...this._fmt(tag), msg, ...args); },
    error(tag, msg, ...args) { console.error(...this._fmt(tag), msg, ...args); },
    setLevel(level) { _logLevel = LOG_LEVELS[level] ?? LOG_LEVELS.DEBUG; },
};

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

    async connect(address, port) {
        this.base = window.location.origin;
        log.info('API', `Connecting to ${address}:${port}`);
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

    async rejoin(sessionId) {
        this.base = window.location.origin;
        this.sid = sessionId;
        log.info('API', `Attempting to rejoin session ${sessionId}`);
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
const MAX_MESSAGES = 500;
const mkMsg = (type, sender, text, preformatted = false) => ({ type, sender, text, time: ts(), id: ++_msgId, pre: preformatted });

function fmtUptime(s) {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return h > 0 ? `${h}h ${m}m ${sec}s` : m > 0 ? `${m}m ${sec}s` : `${sec}s`;
}

function parseFlags(flags) {
    if (typeof flags === 'number') return flags;
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

const pktName = (p) => {
    if (typeof p === 'string') return p;
    const map = {
        0: 'DEFAULT', 1: 'MESSAGE', 2: 'CHANGEROOM', 3: 'FIGHT', 4: 'PVPFIGHT',
        5: 'LOOT', 6: 'START', 7: 'ERROR', 8: 'ACCEPT', 9: 'ROOM', 10: 'CHARACTER',
        11: 'GAME', 12: 'LEAVE', 13: 'CONNECTION', 14: 'VERSION'
    };
    return map[p] || String(p);
};
