use std::time::Duration;

use actix_files::Files;
use actix_web::{App, HttpServer, web};
use time::{UtcOffset, format_description::parse};
use tracing::info;
use tracing_subscriber::fmt::time::OffsetTime;

mod listener;
mod protocol;
mod routes;
mod session;

use session::SessionManager;

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    // Setup tracing subscriber for logging
    let timer = parse("[year]-[month padding:zero]-[day padding:zero] [hour]:[minute]:[second]")
        .expect("Tracing time format is invalid");
    let time_offset = UtcOffset::current_local_offset().unwrap_or(UtcOffset::UTC);
    let timer = OffsetTime::new(time_offset, timer);

    tracing_subscriber::fmt()
        .with_line_number(true)
        .with_target(false)
        .with_timer(timer)
        .with_file(true)
        .with_ansi(true)
        .compact()
        .init();

    let manager = web::Data::new(SessionManager::new());

    // Spawn session reaper background task
    let reaper_manager = manager.clone();
    actix_rt::spawn(async move {
        let reap_interval = Duration::from_secs(30);
        let stale_timeout = Duration::from_secs(300); // 5 minutes
        loop {
            actix_rt::time::sleep(reap_interval).await;
            reaper_manager.reap_stale_sessions(stale_timeout);
        }
    });

    info!("Starting web proxy on 127.0.0.1:8080");

    HttpServer::new(move || {
        App::new()
            .app_data(manager.clone())
            .route("/connect", web::post().to(routes::connect))
            .route("/character", web::post().to(routes::character))
            .route("/change_room", web::post().to(routes::change_room))
            .route("/loot", web::post().to(routes::loot))
            .route("/fight", web::post().to(routes::fight))
            .route("/start", web::post().to(routes::start))
            .route("/message", web::post().to(routes::message))
            .route("/leave", web::post().to(routes::leave))
            .route("/poll", web::get().to(routes::poll))
            .service(Files::new("/", "static").index_file("index.html"))
    })
    .bind(("127.0.0.1", 8080))?
    .run()
    .await
}
