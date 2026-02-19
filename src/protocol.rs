use lurk_lcsc::Protocol;
use serde::Deserialize;
use serde_json::Value;

/// Request body for POST /connect — not a lurk packet.
#[derive(Deserialize)]
pub struct ConnectRequest {
    pub address: String,
    pub port: u16,
}

/// Serialize the inner `Pkt*` struct of a `Protocol` variant to a JSON value.
/// Each packet already contains a `packet_type` field the client can use to distinguish types.
pub fn protocol_to_json(msg: &Protocol) -> Value {
    match msg {
        Protocol::Message(_, pkt) => serde_json::to_value(pkt).unwrap_or_default(),
        Protocol::ChangeRoom(_, pkt) => serde_json::to_value(pkt).unwrap_or_default(),
        Protocol::Fight(_, pkt) => serde_json::to_value(pkt).unwrap_or_default(),
        Protocol::PVPFight(_, pkt) => serde_json::to_value(pkt).unwrap_or_default(),
        Protocol::Loot(_, pkt) => serde_json::to_value(pkt).unwrap_or_default(),
        Protocol::Start(_, pkt) => serde_json::to_value(pkt).unwrap_or_default(),
        Protocol::Error(_, pkt) => serde_json::to_value(pkt).unwrap_or_default(),
        Protocol::Accept(_, pkt) => serde_json::to_value(pkt).unwrap_or_default(),
        Protocol::Room(_, pkt) => serde_json::to_value(pkt).unwrap_or_default(),
        Protocol::Character(_, pkt) => serde_json::to_value(pkt).unwrap_or_default(),
        Protocol::Game(_, pkt) => serde_json::to_value(pkt).unwrap_or_default(),
        Protocol::Leave(_, pkt) => serde_json::to_value(pkt).unwrap_or_default(),
        Protocol::Connection(_, pkt) => serde_json::to_value(pkt).unwrap_or_default(),
        Protocol::Version(_, pkt) => serde_json::to_value(pkt).unwrap_or_default(),
    }
}
