// ─────────────────────────────────────────────────────────
//  Entity Card (memoized to prevent re-renders from uptime tick)
// ─────────────────────────────────────────────────────────
const EntityCard = React.memo(function EntityCard({ entity, onLoot, onMessage, onFight, disabled }) {
    const [showCtx, setShowCtx] = useState(null);
    const alive = isAlive(entity.flags);
    const monster = isMonster(entity.flags);

    function handleContext(e) {
        e.preventDefault();
        const items = [];
        if (!alive && monster && (entity.gold ?? 0) > 0) {
            items.push({ icon: '💰', label: `Loot ${entity.name}`, action: () => onLoot(entity.name) });
        }
        if (alive) {
            items.push({ icon: '💬', label: `Message ${entity.name}`, action: () => onMessage(entity.name) });
            items.push({ icon: '⚔️', label: 'Fight in room', action: () => onFight() });
        }
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
            {entity.description && <div className="entity-desc">{entity.description}</div>}
            <div className="entity-actions">
                {!alive && monster && (entity.gold ?? 0) > 0 && (
                    <button className="entity-action-btn loot" onClick={() => onLoot(entity.name)} disabled={disabled}>Loot</button>
                )}
            </div>
            {showCtx && <ContextMenu {...showCtx} onClose={() => setShowCtx(null)} />}
        </div>
    );
});
