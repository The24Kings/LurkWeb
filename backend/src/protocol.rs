use lurk_protocol::Protocol;
use serde::Deserialize;
use serde_json::Value;
use tracing::{trace, warn};

/// Request body for POST /connect — not a lurk packet.
#[derive(Deserialize)]
pub struct ConnectRequest {
    pub address: String,
    pub port: u16,
}

/// Serialize the inner `Pkt*` struct of a `Protocol` variant to a JSON value,
/// logging the JSON at trace level for deep debugging.
pub fn protocol_to_json(msg: &Protocol) -> Value {
    let value = match msg {
        Protocol::Message(pkt) => serde_json::to_value(pkt),
        Protocol::ChangeRoom(pkt) => serde_json::to_value(pkt),
        Protocol::Fight(pkt) => serde_json::to_value(pkt),
        Protocol::PVPFight(pkt) => serde_json::to_value(pkt),
        Protocol::Loot(pkt) => serde_json::to_value(pkt),
        Protocol::Start(pkt) => serde_json::to_value(pkt),
        Protocol::Error(pkt) => serde_json::to_value(pkt),
        Protocol::Accept(pkt) => serde_json::to_value(pkt),
        Protocol::Room(pkt) => serde_json::to_value(pkt),
        Protocol::Character(pkt) => serde_json::to_value(pkt),
        Protocol::Game(pkt) => serde_json::to_value(pkt),
        Protocol::Leave(pkt) => serde_json::to_value(pkt),
        Protocol::Connection(pkt) => serde_json::to_value(pkt),
        Protocol::Version(pkt) => serde_json::to_value(pkt),
    };

    match value {
        Ok(v) => {
            trace!(json = %v, "Serialized packet to JSON");
            v
        }
        Err(e) => {
            warn!(error = %e, "Failed to serialize packet to JSON");
            Value::default()
        }
    }
}
