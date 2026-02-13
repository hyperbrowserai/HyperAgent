use crate::{
  error::ApiError,
  models::{AgentOpsResponse, ChartSpec, WorkbookEvent, WorkbookSummary},
};
use chrono::Utc;
use duckdb::Connection;
use serde_json::Value;
use std::{
  collections::{HashMap, VecDeque},
  fs,
  path::PathBuf,
  sync::Arc,
};
use tokio::sync::{broadcast, RwLock};
use uuid::Uuid;

const MAX_AGENT_OPS_CACHE_ENTRIES: usize = 256;

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
  pub agent_ops_cache: HashMap<String, AgentOpsResponse>,
  pub agent_ops_cache_order: VecDeque<String>,
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
      agent_ops_cache: HashMap::new(),
      agent_ops_cache_order: VecDeque::new(),
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
  ) -> Result<bool, ApiError> {
    let mut guard = self.workbooks.write().await;
    let record = guard
      .get_mut(&workbook_id)
      .ok_or_else(|| ApiError::NotFound(format!("Workbook {workbook_id} was not found.")))?;

    if !record.summary.sheets.iter().any(|entry| entry == sheet) {
      record.summary.sheets.push(sheet.to_string());
      return Ok(true);
    }
    Ok(false)
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

  pub async fn get_cached_agent_ops_response(
    &self,
    workbook_id: Uuid,
    request_id: &str,
  ) -> Result<Option<AgentOpsResponse>, ApiError> {
    let guard = self.workbooks.read().await;
    let record = guard
      .get(&workbook_id)
      .ok_or_else(|| ApiError::NotFound(format!("Workbook {workbook_id} was not found.")))?;
    Ok(record.agent_ops_cache.get(request_id).cloned())
  }

  pub async fn cache_agent_ops_response(
    &self,
    workbook_id: Uuid,
    request_id: String,
    response: AgentOpsResponse,
  ) -> Result<(), ApiError> {
    let mut guard = self.workbooks.write().await;
    let record = guard
      .get_mut(&workbook_id)
      .ok_or_else(|| ApiError::NotFound(format!("Workbook {workbook_id} was not found.")))?;

    if !record.agent_ops_cache.contains_key(&request_id) {
      record.agent_ops_cache_order.push_back(request_id.clone());
    }
    record.agent_ops_cache.insert(request_id, response);

    while record.agent_ops_cache_order.len() > MAX_AGENT_OPS_CACHE_ENTRIES {
      if let Some(evicted) = record.agent_ops_cache_order.pop_front() {
        record.agent_ops_cache.remove(&evicted);
      }
    }
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

#[cfg(test)]
mod tests {
  use super::{AppState, MAX_AGENT_OPS_CACHE_ENTRIES};
  use crate::models::{AgentOperationResult, AgentOpsResponse};
  use serde_json::json;
  use tempfile::tempdir;

  #[tokio::test]
  async fn should_cache_and_retrieve_agent_ops_response() {
    let temp_dir = tempdir().expect("temp dir should be created");
    let state =
      AppState::new(temp_dir.path().to_path_buf()).expect("state should initialize");
    let workbook = state
      .create_workbook(Some("cache-test".to_string()))
      .await
      .expect("workbook should be created");

    let response = AgentOpsResponse {
      request_id: Some("req-1".to_string()),
      operations_signature: Some("abc".to_string()),
      served_from_cache: false,
      results: vec![AgentOperationResult {
        op_index: 0,
        op_type: "recalculate".to_string(),
        ok: true,
        data: json!({ "updated_cells": 0 }),
      }],
    };
    state
      .cache_agent_ops_response(workbook.id, "req-1".to_string(), response.clone())
      .await
      .expect("cache should be updated");

    let cached = state
      .get_cached_agent_ops_response(workbook.id, "req-1")
      .await
      .expect("cache lookup should succeed");
    assert!(cached.is_some());
    assert_eq!(
      cached.and_then(|value| value.request_id),
      Some("req-1".to_string()),
    );
  }

  #[tokio::test]
  async fn should_evict_oldest_agent_ops_cache_entry() {
    let temp_dir = tempdir().expect("temp dir should be created");
    let state =
      AppState::new(temp_dir.path().to_path_buf()).expect("state should initialize");
    let workbook = state
      .create_workbook(Some("cache-eviction".to_string()))
      .await
      .expect("workbook should be created");

    for index in 0..=MAX_AGENT_OPS_CACHE_ENTRIES {
      let request_id = format!("req-{index}");
      let response = AgentOpsResponse {
        request_id: Some(request_id.clone()),
        operations_signature: Some(request_id.clone()),
        served_from_cache: false,
        results: Vec::new(),
      };
      state
        .cache_agent_ops_response(workbook.id, request_id, response)
        .await
        .expect("cache update should succeed");
    }

    let evicted = state
      .get_cached_agent_ops_response(workbook.id, "req-0")
      .await
      .expect("cache lookup should succeed");
    let newest = state
      .get_cached_agent_ops_response(
        workbook.id,
        format!("req-{MAX_AGENT_OPS_CACHE_ENTRIES}").as_str(),
      )
      .await
      .expect("cache lookup should succeed");
    assert!(evicted.is_none(), "oldest entry should be evicted");
    assert!(newest.is_some(), "newest entry should remain cached");
  }
}
