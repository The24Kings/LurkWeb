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
        let a = attack, d = defense, r = regen;
        let leftover = total - a - d - r;
        if (leftover < 0) return;
        if (leftover > 0) {
            const third = Math.floor(leftover / 3);
            a += third;
            d += third;
            r += leftover - third - third;
        }
        const flagParts = ['ALIVE', 'READY'];
        if (joinBattle) flagParts.push('BATTLE');
        onSubmit({
            name: name.trim(),
            flags: flagParts.join(' | '),
            attack: a, defense: d, regen: r,
            health: 0, gold: 0, current_room: 0,
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

                    <div className="modal-section">
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

                        <div className="points-row">
                            <div className={`points-display ${remaining < 0 ? 'over' : 'ok'}`}>
                                Points: {remaining} / {total} remaining
                            </div>
                            <button type="button" className="quick-alloc-btn" onClick={quickAlloc} title="Quick Allocate (50/25/25)">💥</button>
                        </div>

                        <div className="toggle-row">
                            <label>Join Battles Automatically</label>
                            <label className="toggle-switch">
                                <input type="checkbox" checked={joinBattle} onChange={e => setJoinBattle(e.target.checked)} />
                                <span className="toggle-slider" />
                            </label>
                        </div>
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
