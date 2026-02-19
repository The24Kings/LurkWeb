use std::collections::HashMap;
use std::collections::VecDeque;
use std::net::TcpStream;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tracing::{debug, info, warn};

use crate::listener;

pub type SessionId = String;

pub struct Session {
    /// The TCP stream to the Lurk server.
    pub stream: Arc<TcpStream>,
    /// Queue of JSON-encoded lurk packets..
    pub queue: Arc<Mutex<VecDeque<String>>>,
    /// Timestamp of last client activity.
    pub last_activity: Mutex<Instant>,
    /// Set by the listener thread when the Lurk server disconnects.
    pub disconnected: Arc<AtomicBool>,
    /// Handle to the listener thread (used for cleanup).
    listener_handle: Mutex<Option<std::thread::JoinHandle<()>>>,
}

pub struct SessionManager {
    pub sessions: Mutex<HashMap<SessionId, Arc<Session>>>,
}

impl SessionManager {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
        }
    }

    /// Connect to a Lurk server and create a new session.
    pub fn create_session(&self, addr: &str, port: u16) -> Result<SessionId, String> {
        let address = format!("{}:{}", addr, port);
        info!(address = %address, "Attempting TCP connection to game server");
        let tcp_stream = TcpStream::connect(&address)
            .map_err(|e| format!("Failed to connect to {}: {}", address, e))?;

        info!("Connected");

        let stream = Arc::new(tcp_stream);
        let queue = Arc::new(Mutex::new(VecDeque::<String>::new()));
        let disconnected = Arc::new(AtomicBool::new(false));

        let handle = listener::spawn_listener(
            Arc::clone(&stream),
            Arc::clone(&queue),
            Arc::clone(&disconnected),
        );

        info!("Spawned listening thread {:?}", handle);

        let session_id = uuid::Uuid::new_v4().to_string();

        let session = Arc::new(Session {
            stream,
            queue,
            last_activity: Mutex::new(Instant::now()),
            disconnected,
            listener_handle: Mutex::new(Some(handle)),
        });

        self.sessions
            .lock()
            .unwrap()
            .insert(session_id.clone(), session);

        info!("Created session {} -> {}", session_id, address);
        Ok(session_id)
    }

    /// Retrieve the Session from SessionID
    pub fn get_session(&self, id: &SessionId) -> Option<Arc<Session>> {
        let result = self.sessions.lock().unwrap().get(id).cloned();
        if result.is_none() {
            debug!(session_id = %id, "Session lookup miss");
        }
        result
    }

    /// Remove the Session from provided SessionID
    pub fn remove_session(&self, id: &SessionId) {
        if let Some(session) = self.sessions.lock().unwrap().remove(id) {
            info!("Removing session: {}", id);
            // Signal disconnect so listener exits its loop
            session.disconnected.store(true, Ordering::Relaxed);
            // Shut down the stream to unblock the listener's read
            let _ = session.stream.shutdown(std::net::Shutdown::Both);
            if let Some(handle) = session.listener_handle.lock().unwrap().take() {
                let _ = handle.join();
            }
        }
    }

    /// Remove sessions that have been idle longer than `timeout`.
    pub fn reap_stale_sessions(&self, timeout: Duration) {
        let mut sessions = self.sessions.lock().unwrap();
        let stale: Vec<SessionId> = sessions
            .iter()
            .filter(|(_, session)| session.last_activity.lock().unwrap().elapsed() > timeout)
            .map(|(id, _)| id.clone())
            .collect();

        if !stale.is_empty() {
            warn!(count = stale.len(), "Reaping stale sessions");
        }

        for id in stale {
            warn!("Reaping stale session: {}", id);
            if let Some(session) = sessions.remove(&id) {
                session.disconnected.store(true, Ordering::Relaxed);
                let _ = session.stream.shutdown(std::net::Shutdown::Both);
            }
        }
    }
}
