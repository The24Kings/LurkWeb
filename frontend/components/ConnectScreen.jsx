// ─────────────────────────────────────────────────────────
//  Connect Screen
// ─────────────────────────────────────────────────────────
function ConnectScreen({ onConnect }) {
    const [address, setAddress] = useState(() => localStorage.getItem('lurk_addr') || '');
    const [port, setPort] = useState(() => localStorage.getItem('lurk_port') || '5024');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);

    async function handleSubmit(e) {
        e.preventDefault();
        setError(null);
        setLoading(true);
        log.info('CONNECT', `Attempting connection: ${address}:${port}`);
        try {
            localStorage.setItem('lurk_addr', address);
            localStorage.setItem('lurk_port', port);
            const sid = await api.connect(address, parseInt(port, 10));
            log.info('CONNECT', `Connected! Session: ${sid}`);
            onConnect(sid, address, port);
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
                    Enter the Lurk game server address and port to connect.
                </div>
            </div>
        </div>
    );
}
