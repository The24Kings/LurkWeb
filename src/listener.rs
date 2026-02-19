use std::collections::VecDeque;
use std::net::TcpStream;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use lurk_lcsc::Protocol;
use tracing::{error, info};

use crate::protocol::protocol_to_json;

/// Spawn a listener thread that reads packets from the Lurk server and enqueues
/// their JSON representations into the shared queue.
pub fn spawn_listener(
    stream: Arc<TcpStream>,
    queue: Arc<Mutex<VecDeque<String>>>,
    disconnected: Arc<AtomicBool>,
) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        info!("Listener thread started");

        loop {
            match Protocol::recv(&stream) {
                Ok(packet) => {
                    let json = protocol_to_json(&packet);
                    let json_str = json.to_string();
                    queue.lock().unwrap().push_back(json_str);
                }
                Err(e) => {
                    error!("Listener stream error: {}", e);
                    disconnected.store(true, Ordering::Relaxed);
                    let disconnect_msg =
                        serde_json::json!({"packet_type": "DISCONNECTED"}).to_string();
                    queue.lock().unwrap().push_back(disconnect_msg);
                    break;
                }
            }
        }

        info!("Listener thread exiting");
    })
}
