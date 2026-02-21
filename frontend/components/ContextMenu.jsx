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

    return (
        <div className="ctx-menu" style={{ left: x, top: y }} ref={ref}>
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
