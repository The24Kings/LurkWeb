// ─────────────────────────────────────────────────────────
//  App Root
// ─────────────────────────────────────────────────────────
function App() {
    const [session, setSession] = useState(null);
    const [checking, setChecking] = useState(true);

    useEffect(() => {
        const params = new URLSearchParams(window.location.hash.slice(1));
        const sid = params.get('sid');
        const addr = params.get('addr');
        const port = params.get('port');
        if (sid) {
            log.info('APP', `Found session in URL: ${sid}`);
            api.rejoin(sid)
                .then(() => setSession({ sid, addr: addr || '', port: port || '' }))
                .catch((e) => {
                    log.warn('APP', 'Session rejoin failed', e);
                    window.location.hash = '';
                })
                .finally(() => setChecking(false));
        } else {
            setChecking(false);
        }
    }, []);

    useEffect(() => {
        if (session) {
            const params = new URLSearchParams();
            params.set('sid', session.sid);
            params.set('addr', session.addr);
            params.set('port', session.port);
            window.location.hash = params.toString();
        } else {
            window.location.hash = '';
        }
    }, [session]);

    if (checking) {
        return (
            <div className="connect-screen">
                <div className="connect-box">
                    <div className="logo">
                        <div className="logo-title">LURK</div>
                        <div className="logo-sub">Reconnecting…</div>
                    </div>
                </div>
            </div>
        );
    }

    return session ? (
        <GameView
            sessionId={session.sid}
            serverAddr={session.addr}
            serverPort={session.port}
            onDisconnect={() => { api.sid = null; setSession(null); }}
        />
    ) : (
        <ConnectScreen onConnect={(sid, addr, port) => setSession({ sid, addr, port })} />
    );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
