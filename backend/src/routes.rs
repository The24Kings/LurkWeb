use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

use actix_web::{HttpRequest, HttpResponse, web};
use lurk_lcsc::{
    PktChangeRoom, PktCharacter, PktFight, PktLeave, PktLoot, PktMessage, PktStart, Protocol,
};
use serde_json::json;
use tracing::{debug, error, info, warn};

use crate::protocol::ConnectRequest;
use crate::session::{Session, SessionManager};

/// Extract the session ID from the `X-Session-Id` header.
fn get_session(req: &HttpRequest, manager: &SessionManager) -> Result<Arc<Session>, HttpResponse> {
    let session_id = req
        .headers()
        .get("X-Session-Id")
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| {
            warn!("Request missing X-Session-Id header");
            HttpResponse::BadRequest().json(json!({"error": "Missing X-Session-Id header"}))
        })?;

    manager.get_session(&session_id.to_string()).ok_or_else(|| {
        warn!(session_id, "Session not found");
        HttpResponse::NotFound().json(json!({"error": "Session not found"}))
    })
}

/// Touch the session's last_activity timestamp.
fn touch(session: &Session) {
    *session.last_activity.lock().unwrap() = Instant::now();
}

/// Send a Protocol packet over the session's stream.
fn send_packet(packet: Protocol) -> Result<(), HttpResponse> {
    packet.send().map_err(|e| {
        error!("Failed to send packet: {}", e);
        HttpResponse::InternalServerError().json(json!({"error": format!("Send failed: {}", e)}))
    })
}

// POST /connect
pub async fn connect(
    manager: web::Data<SessionManager>,
    body: web::Json<ConnectRequest>,
) -> HttpResponse {
    info!(address = %body.address, port = body.port, "POST /connect — connecting to game server");
    match manager.create_session(&body.address, body.port) {
        Ok(session_id) => {
            info!(session_id = %session_id, "Session created successfully");
            HttpResponse::Ok().json(json!({"session_id": session_id}))
        }
        Err(e) => {
            error!(address = %body.address, port = body.port, error = %e, "Connection to game server failed");
            HttpResponse::BadGateway().json(json!({"error": e}))
        }
    }
}

// POST /character
pub async fn character(
    req: HttpRequest,
    manager: web::Data<SessionManager>,
    body: web::Json<PktCharacter>,
) -> HttpResponse {
    let session = match get_session(&req, &manager) {
        Ok(s) => s,
        Err(resp) => return resp,
    };
    touch(&session);
    info!(name = %body.name, attack = body.attack, defense = body.defense, regen = body.regen, "POST /character — sending character");
    let packet = Protocol::Character(Arc::clone(&session.stream), body.into_inner());
    match send_packet(packet) {
        Ok(()) => HttpResponse::Ok().finish(),
        Err(resp) => resp,
    }
}

// POST /change_room
pub async fn change_room(
    req: HttpRequest,
    manager: web::Data<SessionManager>,
    body: web::Json<PktChangeRoom>,
) -> HttpResponse {
    let session = match get_session(&req, &manager) {
        Ok(s) => s,
        Err(resp) => return resp,
    };
    touch(&session);
    info!(room_number = body.room_number, "POST /change_room");
    let packet = Protocol::ChangeRoom(Arc::clone(&session.stream), body.into_inner());
    match send_packet(packet) {
        Ok(()) => HttpResponse::Ok().finish(),
        Err(resp) => resp,
    }
}

// POST /loot
pub async fn loot(
    req: HttpRequest,
    manager: web::Data<SessionManager>,
    body: web::Json<PktLoot>,
) -> HttpResponse {
    let session = match get_session(&req, &manager) {
        Ok(s) => s,
        Err(resp) => return resp,
    };
    touch(&session);
    info!(target_name = %body.target_name, "POST /loot");
    let packet = Protocol::Loot(Arc::clone(&session.stream), body.into_inner());
    match send_packet(packet) {
        Ok(()) => HttpResponse::Ok().finish(),
        Err(resp) => resp,
    }
}

// POST /fight
pub async fn fight(req: HttpRequest, manager: web::Data<SessionManager>) -> HttpResponse {
    let session = match get_session(&req, &manager) {
        Ok(s) => s,
        Err(resp) => return resp,
    };
    touch(&session);
    info!("POST /fight");
    let packet = Protocol::Fight(Arc::clone(&session.stream), PktFight::default());
    match send_packet(packet) {
        Ok(()) => HttpResponse::Ok().finish(),
        Err(resp) => resp,
    }
}

// POST /start
pub async fn start(req: HttpRequest, manager: web::Data<SessionManager>) -> HttpResponse {
    let session = match get_session(&req, &manager) {
        Ok(s) => s,
        Err(resp) => return resp,
    };
    touch(&session);
    info!("POST /start");
    let packet = Protocol::Start(Arc::clone(&session.stream), PktStart::default());
    match send_packet(packet) {
        Ok(()) => HttpResponse::Ok().finish(),
        Err(resp) => resp,
    }
}

// POST /message
pub async fn message(
    req: HttpRequest,
    manager: web::Data<SessionManager>,
    body: web::Json<PktMessage>,
) -> HttpResponse {
    let session = match get_session(&req, &manager) {
        Ok(s) => s,
        Err(resp) => return resp,
    };
    touch(&session);
    info!(recipient = %body.recipient, sender = %body.sender, len = body.message_len, "POST /message");
    let packet = Protocol::Message(Arc::clone(&session.stream), body.into_inner());
    match send_packet(packet) {
        Ok(()) => HttpResponse::Ok().finish(),
        Err(resp) => resp,
    }
}

// POST /leave
pub async fn leave(req: HttpRequest, manager: web::Data<SessionManager>) -> HttpResponse {
    let session_id = match req
        .headers()
        .get("X-Session-Id")
        .and_then(|v| v.to_str().ok())
    {
        Some(id) => id.to_string(),
        None => {
            return HttpResponse::BadRequest()
                .json(json!({"error": "Missing X-Session-Id header"}));
        }
    };

    info!(session_id = %session_id, "POST /leave — disconnecting");

    // Send leave packet before removing the session
    if let Some(session) = manager.get_session(&session_id) {
        let packet = Protocol::Leave(Arc::clone(&session.stream), PktLeave::default());
        let _ = packet.send();
    }

    manager.remove_session(&session_id);
    info!(session_id = %session_id, "Session removed");
    HttpResponse::Ok().json(json!({"status": "disconnected"}))
}

// GET /poll
pub async fn poll(req: HttpRequest, manager: web::Data<SessionManager>) -> HttpResponse {
    let session = match get_session(&req, &manager) {
        Ok(s) => s,
        Err(resp) => return resp,
    };
    touch(&session);

    debug!("GET /poll — waiting for packets");

    let start = Instant::now();
    let timeout = Duration::from_secs(3);
    let sleep_duration = Duration::from_millis(2);
    let mut batch: Vec<serde_json::Value> = Vec::new();

    loop {
        // Drain any available messages
        if let Some(msg) = session.queue.lock().unwrap().pop_front() {
            if let Ok(val) = serde_json::from_str(&msg) {
                batch.push(val);
            }
            continue; // Drain greedily
        }

        // If we have messages or timed out, return
        if !batch.is_empty() || start.elapsed() > timeout {
            break;
        }

        // If the lurk server disconnected, return immediately
        if session.disconnected.load(Ordering::Relaxed) {
            // Drain any remaining disconnect event
            while let Some(msg) = session.queue.lock().unwrap().pop_front() {
                if let Ok(val) = serde_json::from_str(&msg) {
                    batch.push(val);
                }
            }
            break;
        }

        // Brief sleep to avoid busy-waiting
        std::thread::sleep(sleep_duration);
    }

    if !batch.is_empty() {
        debug!(
            count = batch.len(),
            elapsed_ms = start.elapsed().as_millis() as u64,
            "Poll returning packets"
        );
    }

    HttpResponse::Ok().json(batch)
}

// GET /session_status
pub async fn session_status(req: HttpRequest, manager: web::Data<SessionManager>) -> HttpResponse {
    let session = match get_session(&req, &manager) {
        Ok(s) => s,
        Err(resp) => return resp,
    };
    touch(&session);
    let disconnected = session.disconnected.load(Ordering::Relaxed);
    info!(disconnected, "GET /session_status");
    HttpResponse::Ok().json(json!({
        "active": !disconnected,
        "disconnected": disconnected
    }))
}
