#![recursion_limit = "512"]

mod api;
mod error;
mod formula;
mod models;
mod state;
mod store;
mod xlsx;

use crate::{api::create_router, state::AppState};
use std::{env, net::SocketAddr, path::PathBuf};
use tower_http::{cors::CorsLayer, trace::TraceLayer};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
  tracing_subscriber::registry()
    .with(
      tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| "spreadsheet_core_rs=info,tower_http=info".into()),
    )
    .with(tracing_subscriber::fmt::layer())
    .init();

  let data_dir = env::var("SPREADSHEET_DATA_DIR")
    .map(PathBuf::from)
    .unwrap_or_else(|_| PathBuf::from("./data"));
  let state = AppState::new(data_dir).map_err(|err| anyhow::anyhow!("{err:?}"))?;
  let app = create_router(state)
    .layer(CorsLayer::very_permissive())
    .layer(TraceLayer::new_for_http());

  let port = env::var("PORT")
    .ok()
    .and_then(|value| value.parse::<u16>().ok())
    .unwrap_or(8787);
  let address = SocketAddr::from(([0, 0, 0, 0], port));
  let listener = tokio::net::TcpListener::bind(address).await?;
  tracing::info!("Spreadsheet API listening on {}", listener.local_addr()?);

  axum::serve(listener, app).await?;
  Ok(())
}
