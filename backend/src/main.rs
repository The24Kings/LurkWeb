use std::time::Duration;

use actix_cors::Cors;
use actix_files::Files;
use actix_web::{App, HttpServer, web};
use clap::Parser;
use clap_verbosity_flag::Verbosity;
use time::{UtcOffset, format_description::parse};
use tracing::info;
use tracing_subscriber::fmt::time::OffsetTime;

mod listener;
mod protocol;
mod routes;
mod session;

use session::SessionManager;

#[derive(Debug, Parser)]
#[command(version, about, long_about = None)]
struct Cli {
    // Address that users will connect to
    #[arg(short, long, default_value_t = String::from("127.0.0.1"))]
    addr: String,
    /// Port to bind the Web Proxy
    #[arg(short, long, default_value_t = 8080)]
    port: u16,
    #[command(flatten)]
    verbosity: Verbosity,
}

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    // Setup tracing subscriber for logging
    let timer = parse("[year]-[month padding:zero]-[day padding:zero] [hour]:[minute]:[second]")
        .expect("Tracing time format is invalid");
    let time_offset = UtcOffset::current_local_offset().unwrap_or(UtcOffset::UTC);
    let timer = OffsetTime::new(time_offset, timer);

    let cli = Cli::parse();

    tracing_subscriber::fmt()
        .with_max_level(cli.verbosity)
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

    info!("Starting web proxy on {}:{}", cli.addr, cli.port);

    HttpServer::new(move || {
        let cors = Cors::default()
            .allow_any_origin()
            .allow_any_method()
            .allow_any_header()
            .expose_headers(["X-Session-Id"])
            .max_age(3600);

        App::new()
            .wrap(cors)
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
            .route("/session_status", web::get().to(routes::session_status))
            .service(Files::new("/", "frontend").index_file("index.html"))
    })
    .bind((cli.addr, cli.port))?
    .run()
    .await
}
