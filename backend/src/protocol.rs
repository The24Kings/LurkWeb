use lurk_lcsc::Protocol;
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
        Protocol::Message(_, pkt) => serde_json::to_value(pkt),
        Protocol::ChangeRoom(_, pkt) => serde_json::to_value(pkt),
        Protocol::Fight(_, pkt) => serde_json::to_value(pkt),
        Protocol::PVPFight(_, pkt) => serde_json::to_value(pkt),
        Protocol::Loot(_, pkt) => serde_json::to_value(pkt),
        Protocol::Start(_, pkt) => serde_json::to_value(pkt),
        Protocol::Error(_, pkt) => serde_json::to_value(pkt),
        Protocol::Accept(_, pkt) => serde_json::to_value(pkt),
        Protocol::Room(_, pkt) => serde_json::to_value(pkt),
        Protocol::Character(_, pkt) => serde_json::to_value(pkt),
        Protocol::Game(_, pkt) => serde_json::to_value(pkt),
        Protocol::Leave(_, pkt) => serde_json::to_value(pkt),
        Protocol::Connection(_, pkt) => serde_json::to_value(pkt),
        Protocol::Version(_, pkt) => serde_json::to_value(pkt),
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
