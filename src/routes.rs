use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

use actix_web::{HttpRequest, HttpResponse, web};
use lurk_lcsc::{
    PktChangeRoom, PktCharacter, PktFight, PktLeave, PktLoot, PktMessage, PktStart, Protocol,
};
use serde_json::json;
use tracing::{error, info};

use crate::protocol::ConnectRequest;
use crate::session::{Session, SessionManager};

/// Extract the session ID from the `X-Session-Id` header.
fn get_session(req: &HttpRequest, manager: &SessionManager) -> Result<Arc<Session>, HttpResponse> {
    let session_id = req
        .headers()
        .get("X-Session-Id")
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| {
            HttpResponse::BadRequest().json(json!({"error": "Missing X-Session-Id header"}))
        })?;

    manager
        .get_session(&session_id.to_string())
        .ok_or_else(|| HttpResponse::NotFound().json(json!({"error": "Session not found"})))
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
    match manager.create_session(&body.address, body.port) {
        Ok(session_id) => {
            info!("Client connected: {}", session_id);
            HttpResponse::Ok().json(json!({"session_id": session_id}))
        }
        Err(e) => {
            error!("Connection failed: {}", e);
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

    // Send leave packet before removing the session
    if let Some(session) = manager.get_session(&session_id) {
        let packet = Protocol::Leave(Arc::clone(&session.stream), PktLeave::default());
        let _ = packet.send();
    }

    manager.remove_session(&session_id);
    info!("Client left: {}", session_id);
    HttpResponse::Ok().json(json!({"status": "disconnected"}))
}

// GET /poll
pub async fn poll(req: HttpRequest, manager: web::Data<SessionManager>) -> HttpResponse {
    let session = match get_session(&req, &manager) {
        Ok(s) => s,
        Err(resp) => return resp,
    };
    touch(&session);

    let start = Instant::now();
    let timeout = Duration::from_secs(5);
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

    HttpResponse::Ok().json(batch)
}
