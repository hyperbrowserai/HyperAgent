use crate::{
  error::ApiError,
  models::{ChartSpec, WorkbookEvent, WorkbookSummary},
};
use chrono::Utc;
use duckdb::Connection;
use serde_json::Value;
use std::{collections::HashMap, fs, path::PathBuf, sync::Arc};
use tokio::sync::{broadcast, RwLock};
use uuid::Uuid;

#[derive(Debug, Clone)]
pub struct AppState {
  pub workbooks: Arc<RwLock<HashMap<Uuid, WorkbookRecord>>>,
  pub data_dir: Arc<PathBuf>,
}

#[derive(Debug, Clone)]
pub struct WorkbookRecord {
  pub summary: WorkbookSummary,
  pub db_path: PathBuf,
  pub events_tx: broadcast::Sender<WorkbookEvent>,
  pub next_seq: u64,
}

impl AppState {
  pub fn new(data_dir: PathBuf) -> Result<Self, ApiError> {
    fs::create_dir_all(&data_dir).map_err(ApiError::internal)?;
    Ok(Self {
      workbooks: Arc::new(RwLock::new(HashMap::new())),
      data_dir: Arc::new(data_dir),
    })
  }

  pub async fn create_workbook(
    &self,
    name: Option<String>,
  ) -> Result<WorkbookSummary, ApiError> {
    let id = Uuid::new_v4();
    let sheet_name = "Sheet1".to_string();
    let workbook_name = name.unwrap_or_else(|| format!("Workbook-{id}"));
    let db_path = self.data_dir.join(format!("{id}.duckdb"));
    initialize_duckdb(&db_path)?;

    let (events_tx, _events_rx) = broadcast::channel(2048);
    let summary = WorkbookSummary {
      id,
      name: workbook_name,
      created_at: Utc::now(),
      sheets: vec![sheet_name],
      charts: Vec::new(),
      compatibility_warnings: Vec::new(),
    };
    let record = WorkbookRecord {
      summary: summary.clone(),
      db_path,
      events_tx,
      next_seq: 1,
    };

    self.workbooks.write().await.insert(id, record);
    Ok(summary)
  }

  pub async fn get_workbook(&self, id: Uuid) -> Result<WorkbookSummary, ApiError> {
    self
      .workbooks
      .read()
      .await
      .get(&id)
      .map(|record| record.summary.clone())
      .ok_or_else(|| ApiError::NotFound(format!("Workbook {id} was not found.")))
  }

  pub async fn list_sheets(&self, id: Uuid) -> Result<Vec<String>, ApiError> {
    Ok(self.get_workbook(id).await?.sheets)
  }

  pub async fn db_path(&self, id: Uuid) -> Result<PathBuf, ApiError> {
    self
      .workbooks
      .read()
      .await
      .get(&id)
      .map(|record| record.db_path.clone())
      .ok_or_else(|| ApiError::NotFound(format!("Workbook {id} was not found.")))
  }

  pub async fn subscribe(
    &self,
    id: Uuid,
  ) -> Result<broadcast::Receiver<WorkbookEvent>, ApiError> {
    let sender = self
      .workbooks
      .read()
      .await
      .get(&id)
      .map(|record| record.events_tx.clone())
      .ok_or_else(|| ApiError::NotFound(format!("Workbook {id} was not found.")))?;

    Ok(sender.subscribe())
  }

  pub async fn register_sheet_if_missing(
    &self,
    workbook_id: Uuid,
    sheet: &str,
  ) -> Result<(), ApiError> {
    let mut guard = self.workbooks.write().await;
    let record = guard
      .get_mut(&workbook_id)
      .ok_or_else(|| ApiError::NotFound(format!("Workbook {workbook_id} was not found.")))?;

    if !record.summary.sheets.iter().any(|entry| entry == sheet) {
      record.summary.sheets.push(sheet.to_string());
    }
    Ok(())
  }

  pub async fn upsert_chart(
    &self,
    workbook_id: Uuid,
    chart: ChartSpec,
  ) -> Result<(), ApiError> {
    let mut guard = self.workbooks.write().await;
    let record = guard
      .get_mut(&workbook_id)
      .ok_or_else(|| ApiError::NotFound(format!("Workbook {workbook_id} was not found.")))?;

    if let Some(existing) = record
      .summary
      .charts
      .iter_mut()
      .find(|item| item.id == chart.id)
    {
      *existing = chart;
    } else {
      record.summary.charts.push(chart);
    }
    Ok(())
  }

  pub async fn add_warning(
    &self,
    workbook_id: Uuid,
    warning: String,
  ) -> Result<(), ApiError> {
    let mut guard = self.workbooks.write().await;
    let record = guard
      .get_mut(&workbook_id)
      .ok_or_else(|| ApiError::NotFound(format!("Workbook {workbook_id} was not found.")))?;

    if !record.summary.compatibility_warnings.contains(&warning) {
      record.summary.compatibility_warnings.push(warning);
    }
    Ok(())
  }

  pub async fn emit_event(
    &self,
    workbook_id: Uuid,
    event_type: &str,
    actor: &str,
    payload: Value,
  ) -> Result<(), ApiError> {
    let mut guard = self.workbooks.write().await;
    let record = guard
      .get_mut(&workbook_id)
      .ok_or_else(|| ApiError::NotFound(format!("Workbook {workbook_id} was not found.")))?;

    let event = WorkbookEvent {
      seq: record.next_seq,
      event_type: event_type.to_string(),
      workbook_id,
      timestamp: Utc::now(),
      actor: actor.to_string(),
      payload,
    };
    record.next_seq += 1;
    let _ = record.events_tx.send(event);
    Ok(())
  }
}

fn initialize_duckdb(db_path: &PathBuf) -> Result<(), ApiError> {
  let connection = Connection::open(db_path).map_err(ApiError::internal)?;
  connection
    .execute_batch(
      r#"
      CREATE TABLE IF NOT EXISTS cells (
        sheet TEXT NOT NULL,
        row_index INTEGER NOT NULL,
        col_index INTEGER NOT NULL,
        raw_value TEXT,
        formula TEXT,
        evaluated_value TEXT,
        updated_at TIMESTAMP DEFAULT now(),
        PRIMARY KEY(sheet, row_index, col_index)
      );
      "#,
    )
    .map_err(ApiError::internal)?;

  Ok(())
}
