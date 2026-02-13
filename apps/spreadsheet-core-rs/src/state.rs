use crate::{
  error::ApiError,
  models::{
    AgentOperation, AgentOpsResponse, ChartSpec, WorkbookEvent, WorkbookSummary,
  },
};
use chrono::{DateTime, Utc};
use duckdb::Connection;
use serde_json::Value;
use std::{
  collections::{HashMap, HashSet, VecDeque},
  fs,
  path::PathBuf,
  sync::Arc,
};
use tokio::sync::{broadcast, RwLock};
use uuid::Uuid;

pub const AGENT_OPS_CACHE_MAX_ENTRIES: usize = 256;

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
  pub agent_ops_cached_operations: HashMap<String, Vec<AgentOperation>>,
  pub agent_ops_cache_timestamps: HashMap<String, DateTime<Utc>>,
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
      agent_ops_cached_operations: HashMap::new(),
      agent_ops_cache_timestamps: HashMap::new(),
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
    operations: Vec<AgentOperation>,
    response: AgentOpsResponse,
  ) -> Result<(), ApiError> {
    let mut guard = self.workbooks.write().await;
    let record = guard
      .get_mut(&workbook_id)
      .ok_or_else(|| ApiError::NotFound(format!("Workbook {workbook_id} was not found.")))?;

    if !record.agent_ops_cache.contains_key(&request_id) {
      record.agent_ops_cache_order.push_back(request_id.clone());
    }
    let cache_key = request_id.clone();
    record.agent_ops_cache.insert(cache_key.clone(), response);
    record.agent_ops_cached_operations.insert(cache_key, operations);
    record
      .agent_ops_cache_timestamps
      .insert(request_id, Utc::now());

    while record.agent_ops_cache_order.len() > AGENT_OPS_CACHE_MAX_ENTRIES {
      if let Some(evicted) = record.agent_ops_cache_order.pop_front() {
        record.agent_ops_cache.remove(&evicted);
        record.agent_ops_cached_operations.remove(&evicted);
        record.agent_ops_cache_timestamps.remove(&evicted);
      }
    }
    Ok(())
  }

  pub async fn get_cached_agent_ops_replay_data(
    &self,
    workbook_id: Uuid,
    request_id: &str,
  ) -> Result<Option<(AgentOpsResponse, Vec<AgentOperation>, DateTime<Utc>)>, ApiError> {
    let guard = self.workbooks.read().await;
    let record = guard
      .get(&workbook_id)
      .ok_or_else(|| ApiError::NotFound(format!("Workbook {workbook_id} was not found.")))?;
    let response = record.agent_ops_cache.get(request_id).cloned();
    let operations = record.agent_ops_cached_operations.get(request_id).cloned();
    let cached_at = record.agent_ops_cache_timestamps.get(request_id).cloned();
    Ok(match (response, operations, cached_at) {
      (Some(existing_response), Some(existing_operations), Some(existing_cached_at)) => {
        Some((existing_response, existing_operations, existing_cached_at))
      }
      _ => None,
    })
  }

  pub async fn agent_ops_cache_stats(
    &self,
    workbook_id: Uuid,
    request_id_prefix: Option<&str>,
    cutoff_timestamp: Option<DateTime<Utc>>,
  ) -> Result<
    (
      usize,
      usize,
      Option<String>,
      Option<String>,
      Option<DateTime<Utc>>,
      Option<DateTime<Utc>>,
    ),
    ApiError,
  > {
    let guard = self.workbooks.read().await;
    let record = guard
      .get(&workbook_id)
      .ok_or_else(|| ApiError::NotFound(format!("Workbook {workbook_id} was not found.")))?;
    let normalized_prefix = request_id_prefix
      .map(str::trim)
      .filter(|prefix| !prefix.is_empty());
    let scoped_request_ids = record
      .agent_ops_cache_order
      .iter()
      .filter(|request_id| {
        let prefix_matches = normalized_prefix
          .map(|prefix| request_id.starts_with(prefix))
          .unwrap_or(true);
        cutoff_timestamp
          .as_ref()
          .map(|cutoff| {
            record
              .agent_ops_cache_timestamps
              .get(*request_id)
              .map(|cached_at| cached_at <= cutoff)
              .unwrap_or(false)
          })
          .unwrap_or(true)
          && prefix_matches
      })
      .cloned()
      .collect::<Vec<_>>();
    let oldest_request_id = scoped_request_ids.first().cloned();
    let newest_request_id = scoped_request_ids.last().cloned();
    let oldest_cached_at = oldest_request_id
      .as_ref()
      .and_then(|request_id| record.agent_ops_cache_timestamps.get(request_id).cloned());
    let newest_cached_at = newest_request_id
      .as_ref()
      .and_then(|request_id| record.agent_ops_cache_timestamps.get(request_id).cloned());
    Ok((
      scoped_request_ids.len(),
      record.agent_ops_cache_order.len(),
      oldest_request_id,
      newest_request_id,
      oldest_cached_at,
      newest_cached_at,
    ))
  }

  pub async fn agent_ops_cache_entries(
    &self,
    workbook_id: Uuid,
    request_id_prefix: Option<&str>,
    cutoff_timestamp: Option<DateTime<Utc>>,
    offset: usize,
    limit: usize,
  ) -> Result<
    (
      usize,
      usize,
      Vec<(String, Option<String>, usize, usize, DateTime<Utc>)>,
    ),
    ApiError,
  > {
    let guard = self.workbooks.read().await;
    let record = guard
      .get(&workbook_id)
      .ok_or_else(|| ApiError::NotFound(format!("Workbook {workbook_id} was not found.")))?;
    let normalized_prefix = request_id_prefix
      .map(str::trim)
      .filter(|prefix| !prefix.is_empty());
    let filtered_request_ids = record
      .agent_ops_cache_order
      .iter()
      .rev()
      .filter(|request_id| {
        let prefix_matches = normalized_prefix
          .map(|prefix| request_id.starts_with(prefix))
          .unwrap_or(true);
        let within_cutoff = cutoff_timestamp
          .as_ref()
          .map(|cutoff| {
            record
              .agent_ops_cache_timestamps
              .get(*request_id)
              .map(|cached_at| cached_at <= cutoff)
              .unwrap_or(false)
          })
          .unwrap_or(true);
        prefix_matches && within_cutoff
      })
      .cloned()
      .collect::<Vec<_>>();
    let unscoped_total_entries = record.agent_ops_cache_order.len();
    let total_entries = filtered_request_ids.len();
    let entries = filtered_request_ids
      .into_iter()
      .skip(offset)
      .take(limit)
      .filter_map(|request_id| {
        let response = record.agent_ops_cache.get(&request_id)?;
        let operations = record.agent_ops_cached_operations.get(&request_id)?;
        let cached_at = record.agent_ops_cache_timestamps.get(&request_id)?.to_owned();
        Some((
          request_id,
          response.operations_signature.clone(),
          operations.len(),
          response.results.len(),
          cached_at,
        ))
      })
      .collect::<Vec<_>>();
    Ok((total_entries, unscoped_total_entries, entries))
  }

  pub async fn clear_agent_ops_cache(
    &self,
    workbook_id: Uuid,
  ) -> Result<usize, ApiError> {
    let mut guard = self.workbooks.write().await;
    let record = guard
      .get_mut(&workbook_id)
      .ok_or_else(|| ApiError::NotFound(format!("Workbook {workbook_id} was not found.")))?;
    let cleared_entries = record.agent_ops_cache_order.len();
    record.agent_ops_cache_order.clear();
    record.agent_ops_cache.clear();
    record.agent_ops_cached_operations.clear();
    record.agent_ops_cache_timestamps.clear();
    Ok(cleared_entries)
  }

  pub async fn remove_agent_ops_cache_entries_by_prefix(
    &self,
    workbook_id: Uuid,
    request_id_prefix: &str,
    cutoff_timestamp: Option<DateTime<Utc>>,
  ) -> Result<(usize, usize, usize), ApiError> {
    let mut guard = self.workbooks.write().await;
    let record = guard
      .get_mut(&workbook_id)
      .ok_or_else(|| ApiError::NotFound(format!("Workbook {workbook_id} was not found.")))?;

    let unscoped_matched_entries = record
      .agent_ops_cache_order
      .iter()
      .filter(|request_id| {
        cutoff_timestamp
          .as_ref()
          .map(|cutoff| {
            record
              .agent_ops_cache_timestamps
              .get(*request_id)
              .map(|cached_at| cached_at <= cutoff)
              .unwrap_or(false)
          })
          .unwrap_or(true)
      })
      .count();
    let matching_request_ids = record
      .agent_ops_cache_order
      .iter()
      .filter(|request_id| {
        let prefix_matches = request_id.starts_with(request_id_prefix);
        let within_cutoff = cutoff_timestamp
          .as_ref()
          .map(|cutoff| {
            record
              .agent_ops_cache_timestamps
              .get(*request_id)
              .map(|cached_at| cached_at <= cutoff)
              .unwrap_or(false)
          })
          .unwrap_or(true);
        prefix_matches && within_cutoff
      })
      .cloned()
      .collect::<Vec<_>>();
    let removed_entries = matching_request_ids.len();

    if removed_entries > 0 {
      let matching_request_id_set = matching_request_ids
        .iter()
        .cloned()
        .collect::<HashSet<_>>();
      record
        .agent_ops_cache_order
        .retain(|request_id| !matching_request_id_set.contains(request_id));
      for request_id in matching_request_ids {
        record.agent_ops_cache.remove(&request_id);
        record.agent_ops_cached_operations.remove(&request_id);
        record.agent_ops_cache_timestamps.remove(&request_id);
      }
    }

    Ok((
      removed_entries,
      unscoped_matched_entries,
      record.agent_ops_cache_order.len(),
    ))
  }

  pub async fn remove_stale_agent_ops_cache_entries(
    &self,
    workbook_id: Uuid,
    request_id_prefix: Option<&str>,
    cutoff_timestamp: DateTime<Utc>,
    dry_run: bool,
    sample_limit: usize,
  ) -> Result<(usize, usize, usize, usize, Vec<String>), ApiError> {
    let mut guard = self.workbooks.write().await;
    let record = guard
      .get_mut(&workbook_id)
      .ok_or_else(|| ApiError::NotFound(format!("Workbook {workbook_id} was not found.")))?;

    let normalized_prefix = request_id_prefix
      .map(str::trim)
      .filter(|prefix| !prefix.is_empty());
    let unscoped_matched_entries = record
      .agent_ops_cache_order
      .iter()
      .filter(|request_id| {
        record
          .agent_ops_cache_timestamps
          .get(*request_id)
          .map(|cached_at| *cached_at <= cutoff_timestamp)
          .unwrap_or(false)
      })
      .count();
    let matching_request_ids = record
      .agent_ops_cache_order
      .iter()
      .filter(|request_id| {
        let prefix_matches = normalized_prefix
          .map(|prefix| request_id.starts_with(prefix))
          .unwrap_or(true);
        record
          .agent_ops_cache_timestamps
          .get(*request_id)
          .map(|cached_at| *cached_at <= cutoff_timestamp)
          .unwrap_or(false)
          && prefix_matches
      })
      .cloned()
      .collect::<Vec<_>>();
    let matched_entries = matching_request_ids.len();

    let sample_request_ids = record
      .agent_ops_cache_order
      .iter()
      .rev()
      .filter(|request_id| {
        let prefix_matches = normalized_prefix
          .map(|prefix| request_id.starts_with(prefix))
          .unwrap_or(true);
        record
          .agent_ops_cache_timestamps
          .get(*request_id)
          .map(|cached_at| *cached_at <= cutoff_timestamp)
          .unwrap_or(false)
          && prefix_matches
      })
      .take(sample_limit)
      .cloned()
      .collect::<Vec<_>>();

    if !dry_run && matched_entries > 0 {
      let matching_request_id_set = matching_request_ids
        .iter()
        .cloned()
        .collect::<HashSet<_>>();
      record
        .agent_ops_cache_order
        .retain(|request_id| !matching_request_id_set.contains(request_id));
      for request_id in matching_request_ids {
        record.agent_ops_cache.remove(&request_id);
        record.agent_ops_cached_operations.remove(&request_id);
        record.agent_ops_cache_timestamps.remove(&request_id);
      }
    }

    let removed_entries = if dry_run { 0 } else { matched_entries };
    let remaining_entries = record.agent_ops_cache_order.len();
    Ok((
      matched_entries,
      unscoped_matched_entries,
      removed_entries,
      remaining_entries,
      sample_request_ids,
    ))
  }

  pub async fn agent_ops_cache_prefixes(
    &self,
    workbook_id: Uuid,
    request_id_prefix: Option<&str>,
    cutoff_timestamp: Option<DateTime<Utc>>,
    min_entry_count: usize,
    sort_by: &str,
    offset: usize,
    limit: usize,
  ) -> Result<(usize, usize, usize, usize, Vec<(String, usize, String, Option<DateTime<Utc>>)>), ApiError> {
    let guard = self.workbooks.read().await;
    let record = guard
      .get(&workbook_id)
      .ok_or_else(|| ApiError::NotFound(format!("Workbook {workbook_id} was not found.")))?;

    let mut prefix_counts: HashMap<String, usize> = HashMap::new();
    let mut newest_request_ids: HashMap<String, String> = HashMap::new();
    let mut newest_cached_ats: HashMap<String, Option<DateTime<Utc>>> = HashMap::new();
    let mut unscoped_prefix_counts: HashMap<String, usize> = HashMap::new();
    let normalized_prefix = request_id_prefix
      .map(str::trim)
      .filter(|prefix| !prefix.is_empty());
    for request_id in &record.agent_ops_cache_order {
      let Some(delimiter_index) = request_id.find('-') else {
        continue;
      };
      if delimiter_index == 0 {
        continue;
      }
      let prefix = request_id[..=delimiter_index].to_string();
      let unscoped_entry = unscoped_prefix_counts.entry(prefix.clone()).or_insert(0);
      *unscoped_entry += 1;
      if normalized_prefix
        .is_some_and(|candidate_prefix| !request_id.starts_with(candidate_prefix))
      {
        continue;
      }
      if cutoff_timestamp
        .as_ref()
        .is_some_and(|cutoff| {
          record
            .agent_ops_cache_timestamps
            .get(request_id)
            .map(|cached_at| cached_at > cutoff)
            .unwrap_or(true)
        })
      {
        continue;
      }
      let entry = prefix_counts.entry(prefix.clone()).or_insert(0);
      *entry += 1;
      newest_request_ids.insert(prefix.clone(), request_id.clone());
      newest_cached_ats.insert(
        prefix.clone(),
        record.agent_ops_cache_timestamps.get(request_id).cloned(),
      );
    }

    let unscoped_total_prefixes = unscoped_prefix_counts.len();
    let unscoped_total_entries = record.agent_ops_cache_order.len();
    let mut prefixes = prefix_counts
      .into_iter()
      .map(|(prefix, entry_count)| {
        let newest_request_id = newest_request_ids
          .get(&prefix)
          .cloned()
          .unwrap_or_default();
        let newest_cached_at = newest_cached_ats
          .get(&prefix)
          .cloned()
          .unwrap_or(None);
        (prefix, entry_count, newest_request_id, newest_cached_at)
      })
      .collect::<Vec<_>>();
    prefixes.retain(|(_, entry_count, _, _)| *entry_count >= min_entry_count);
    let total_prefixes = prefixes.len();
    let scoped_total_entries = prefixes.iter().map(|(_, entry_count, _, _)| *entry_count).sum();
    match sort_by {
      "recent" => prefixes.sort_by(|left, right| {
        right
          .3
          .cmp(&left.3)
          .then_with(|| right.1.cmp(&left.1))
          .then_with(|| left.0.cmp(&right.0))
      }),
      "alpha" => prefixes.sort_by(|left, right| {
        left
          .0
          .cmp(&right.0)
          .then_with(|| right.1.cmp(&left.1))
          .then_with(|| right.3.cmp(&left.3))
      }),
      _ => prefixes.sort_by(|left, right| {
        right
          .1
          .cmp(&left.1)
          .then_with(|| right.3.cmp(&left.3))
          .then_with(|| left.0.cmp(&right.0))
      }),
    }
    let paged_prefixes = prefixes
      .into_iter()
      .skip(offset)
      .take(limit)
      .collect::<Vec<_>>();
    Ok((
      total_prefixes,
      unscoped_total_prefixes,
      unscoped_total_entries,
      scoped_total_entries,
      paged_prefixes,
    ))
  }

  pub async fn remove_agent_ops_cache_entry(
    &self,
    workbook_id: Uuid,
    request_id: &str,
  ) -> Result<(bool, usize), ApiError> {
    let mut guard = self.workbooks.write().await;
    let record = guard
      .get_mut(&workbook_id)
      .ok_or_else(|| ApiError::NotFound(format!("Workbook {workbook_id} was not found.")))?;
    let removed = record.agent_ops_cache.remove(request_id).is_some();
    if removed {
      record.agent_ops_cache_order.retain(|entry| entry != request_id);
      record.agent_ops_cached_operations.remove(request_id);
      record.agent_ops_cache_timestamps.remove(request_id);
    }
    Ok((removed, record.agent_ops_cache_order.len()))
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
  use super::{AppState, AGENT_OPS_CACHE_MAX_ENTRIES};
  use chrono::{Duration as ChronoDuration, Utc};
  use crate::models::{AgentOperation, AgentOperationResult, AgentOpsResponse};
  use serde_json::json;
  use std::time::Duration;
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
      .cache_agent_ops_response(
        workbook.id,
        "req-1".to_string(),
        vec![AgentOperation::Recalculate],
        response.clone(),
      )
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

    let replay_data = state
      .get_cached_agent_ops_replay_data(workbook.id, "req-1")
      .await
      .expect("cache replay lookup should succeed")
      .expect("cache replay data should be present");
    assert_eq!(replay_data.1.len(), 1);
    assert!(matches!(replay_data.1[0], AgentOperation::Recalculate));
    assert!(replay_data.2 <= Utc::now());
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

    for index in 0..=AGENT_OPS_CACHE_MAX_ENTRIES {
      let request_id = format!("req-{index}");
      let response = AgentOpsResponse {
        request_id: Some(request_id.clone()),
        operations_signature: Some(request_id.clone()),
        served_from_cache: false,
        results: Vec::new(),
      };
      state
        .cache_agent_ops_response(
          workbook.id,
          request_id,
          vec![AgentOperation::Recalculate],
          response,
        )
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
        format!("req-{AGENT_OPS_CACHE_MAX_ENTRIES}").as_str(),
      )
      .await
      .expect("cache lookup should succeed");
    assert!(evicted.is_none(), "oldest entry should be evicted");
    assert!(newest.is_some(), "newest entry should remain cached");
  }

  #[tokio::test]
  async fn should_report_and_clear_agent_ops_cache_stats() {
    let temp_dir = tempdir().expect("temp dir should be created");
    let state =
      AppState::new(temp_dir.path().to_path_buf()).expect("state should initialize");
    let workbook = state
      .create_workbook(Some("cache-stats".to_string()))
      .await
      .expect("workbook should be created");

    let response = AgentOpsResponse {
      request_id: Some("req-1".to_string()),
      operations_signature: Some("sig-1".to_string()),
      served_from_cache: false,
      results: Vec::new(),
    };
    state
      .cache_agent_ops_response(
        workbook.id,
        "req-1".to_string(),
        vec![AgentOperation::Recalculate],
        response,
      )
      .await
      .expect("cache update should succeed");

    let (entries, unscoped_entries, oldest, newest, oldest_cached_at, newest_cached_at) = state
      .agent_ops_cache_stats(workbook.id, None, None)
      .await
      .expect("cache stats should load");
    assert_eq!(entries, 1);
    assert_eq!(unscoped_entries, 1);
    assert_eq!(oldest.as_deref(), Some("req-1"));
    assert_eq!(newest.as_deref(), Some("req-1"));
    assert!(oldest_cached_at.is_some());
    assert!(newest_cached_at.is_some());

    let prefix_stats = state
      .agent_ops_cache_stats(workbook.id, Some("req-"), None)
      .await
      .expect("prefix-scoped cache stats should load");
    assert_eq!(prefix_stats.0, 1);
    assert_eq!(prefix_stats.1, 1);
    assert_eq!(prefix_stats.2.as_deref(), Some("req-1"));
    assert_eq!(prefix_stats.3.as_deref(), Some("req-1"));

    let cleared = state
      .clear_agent_ops_cache(workbook.id)
      .await
      .expect("cache clear should succeed");
    assert_eq!(cleared, 1);

    let scoped_stats = state
      .agent_ops_cache_stats(
        workbook.id,
        None,
        Some(Utc::now() - ChronoDuration::hours(1)),
      )
      .await
      .expect("age-scoped cache stats should load");
    assert_eq!(scoped_stats.0, 0);
    assert_eq!(scoped_stats.1, 0);
    assert!(scoped_stats.2.is_none());
    assert!(scoped_stats.3.is_none());

    let (
      entries_after,
      unscoped_entries_after,
      oldest_after,
      newest_after,
      oldest_cached_at_after,
      newest_cached_at_after,
    ) = state
      .agent_ops_cache_stats(workbook.id, None, None)
      .await
      .expect("cache stats should load");
    assert_eq!(entries_after, 0);
    assert_eq!(unscoped_entries_after, 0);
    assert!(oldest_after.is_none());
    assert!(newest_after.is_none());
    assert!(oldest_cached_at_after.is_none());
    assert!(newest_cached_at_after.is_none());
  }

  #[tokio::test]
  async fn should_return_newest_first_cache_entries_with_limit() {
    let temp_dir = tempdir().expect("temp dir should be created");
    let state =
      AppState::new(temp_dir.path().to_path_buf()).expect("state should initialize");
    let workbook = state
      .create_workbook(Some("cache-entry-list".to_string()))
      .await
      .expect("workbook should be created");

    for index in 1..=3 {
      let request_id = format!("req-{index}");
      state
        .cache_agent_ops_response(
          workbook.id,
          request_id.clone(),
          vec![AgentOperation::Recalculate],
          AgentOpsResponse {
            request_id: Some(request_id),
            operations_signature: Some(format!("sig-{index}")),
            served_from_cache: false,
            results: Vec::new(),
          },
        )
        .await
        .expect("cache update should succeed");
    }

    let (total_entries, unscoped_total_entries, entries) = state
      .agent_ops_cache_entries(workbook.id, None, None, 0, 2)
      .await
      .expect("cache entries should load");
    assert_eq!(total_entries, 3);
    assert_eq!(unscoped_total_entries, 3);
    assert_eq!(entries.len(), 2);
    assert_eq!(entries[0].0, "req-3");
    assert_eq!(entries[1].0, "req-2");
    assert_eq!(entries[0].1.as_deref(), Some("sig-3"));
    assert_eq!(entries[0].2, 1);
    assert_eq!(entries[0].3, 0);
    assert!(entries[0].4 <= Utc::now());

    let (_, _, paged_entries) = state
      .agent_ops_cache_entries(workbook.id, None, None, 2, 2)
      .await
      .expect("cache entries should load");
    assert_eq!(paged_entries.len(), 1);
    assert_eq!(paged_entries[0].0, "req-1");

    let (filtered_total, filtered_unscoped_total, filtered_entries) = state
      .agent_ops_cache_entries(workbook.id, Some("req-2"), None, 0, 5)
      .await
      .expect("filtered cache entries should load");
    assert_eq!(filtered_total, 1);
    assert_eq!(filtered_unscoped_total, 3);
    assert_eq!(filtered_entries.len(), 1);
    assert_eq!(filtered_entries[0].0, "req-2");
    assert_eq!(filtered_entries[0].2, 1);

    let cutoff_timestamp = Utc::now() - ChronoDuration::hours(1);
    let (age_filtered_total, age_filtered_unscoped_total, age_filtered_entries) = state
      .agent_ops_cache_entries(
        workbook.id,
        None,
        Some(cutoff_timestamp),
        0,
        5,
      )
      .await
      .expect("age-filtered cache entries should load");
    assert_eq!(age_filtered_total, 0);
    assert_eq!(age_filtered_unscoped_total, 3);
    assert!(age_filtered_entries.is_empty());
  }

  #[tokio::test]
  async fn should_remove_single_agent_ops_cache_entry() {
    let temp_dir = tempdir().expect("temp dir should be created");
    let state =
      AppState::new(temp_dir.path().to_path_buf()).expect("state should initialize");
    let workbook = state
      .create_workbook(Some("cache-remove-entry".to_string()))
      .await
      .expect("workbook should be created");

    for index in 1..=2 {
      let request_id = format!("req-{index}");
      state
        .cache_agent_ops_response(
          workbook.id,
          request_id.clone(),
          vec![AgentOperation::Recalculate],
          AgentOpsResponse {
            request_id: Some(request_id),
            operations_signature: Some(format!("sig-{index}")),
            served_from_cache: false,
            results: Vec::new(),
          },
        )
        .await
        .expect("cache update should succeed");
    }

    let (removed, remaining_entries) = state
      .remove_agent_ops_cache_entry(workbook.id, "req-1")
      .await
      .expect("cache removal should succeed");
    assert!(removed);
    assert_eq!(remaining_entries, 1);

    let removed_entry = state
      .get_cached_agent_ops_response(workbook.id, "req-1")
      .await
      .expect("cache lookup should succeed");
    assert!(removed_entry.is_none());
    let kept_entry = state
      .get_cached_agent_ops_response(workbook.id, "req-2")
      .await
      .expect("cache lookup should succeed");
    assert!(kept_entry.is_some());
  }

  #[tokio::test]
  async fn should_remove_agent_ops_cache_entries_by_prefix() {
    let temp_dir = tempdir().expect("temp dir should be created");
    let state =
      AppState::new(temp_dir.path().to_path_buf()).expect("state should initialize");
    let workbook = state
      .create_workbook(Some("cache-remove-prefix".to_string()))
      .await
      .expect("workbook should be created");

    for request_id in ["scenario-1", "scenario-2", "preset-1"] {
      state
        .cache_agent_ops_response(
          workbook.id,
          request_id.to_string(),
          vec![AgentOperation::Recalculate],
          AgentOpsResponse {
            request_id: Some(request_id.to_string()),
            operations_signature: Some(format!("sig-{request_id}")),
            served_from_cache: false,
            results: Vec::new(),
          },
        )
        .await
        .expect("cache update should succeed");
    }

    let (removed_entries, unscoped_matched_entries, remaining_entries) = state
      .remove_agent_ops_cache_entries_by_prefix(workbook.id, "scenario-", None)
      .await
      .expect("prefix removal should succeed");
    assert_eq!(removed_entries, 2);
    assert_eq!(unscoped_matched_entries, 3);
    assert_eq!(remaining_entries, 1);

    let scenario_entry = state
      .get_cached_agent_ops_response(workbook.id, "scenario-1")
      .await
      .expect("cache lookup should succeed");
    assert!(scenario_entry.is_none());
    let preset_entry = state
      .get_cached_agent_ops_response(workbook.id, "preset-1")
      .await
      .expect("cache lookup should succeed");
    assert!(preset_entry.is_some());

    let cutoff_timestamp = Utc::now() - ChronoDuration::hours(1);
    let (
      age_removed_entries,
      age_unscoped_matched_entries,
      age_remaining_entries,
    ) = state
      .remove_agent_ops_cache_entries_by_prefix(
        workbook.id,
        "preset-",
        Some(cutoff_timestamp),
      )
      .await
      .expect("age-filtered prefix removal should succeed");
    assert_eq!(age_removed_entries, 0);
    assert_eq!(age_unscoped_matched_entries, 0);
    assert_eq!(age_remaining_entries, 1);
  }

  #[tokio::test]
  async fn should_list_cache_prefix_suggestions_by_count() {
    let temp_dir = tempdir().expect("temp dir should be created");
    let state =
      AppState::new(temp_dir.path().to_path_buf()).expect("state should initialize");
    let workbook = state
      .create_workbook(Some("cache-prefixes".to_string()))
      .await
      .expect("workbook should be created");

    for request_id in [
      "scenario-a",
      "scenario-b",
      "preset-a",
      "preset-b",
      "preset-c",
      "other",
    ] {
      state
        .cache_agent_ops_response(
          workbook.id,
          request_id.to_string(),
          vec![AgentOperation::Recalculate],
          AgentOpsResponse {
            request_id: Some(request_id.to_string()),
            operations_signature: Some(format!("sig-{request_id}")),
            served_from_cache: false,
            results: Vec::new(),
          },
        )
        .await
        .expect("cache update should succeed");
    }

    let (
      total_prefixes,
      unscoped_total_prefixes,
      unscoped_total_entries,
      scoped_total_entries,
      prefixes,
    ) = state
      .agent_ops_cache_prefixes(workbook.id, None, None, 1, "count", 0, 5)
      .await
      .expect("prefix suggestions should load");
    assert_eq!(total_prefixes, 2);
    assert_eq!(unscoped_total_prefixes, 2);
    assert_eq!(unscoped_total_entries, 6);
    assert_eq!(scoped_total_entries, 5);
    assert_eq!(prefixes.len(), 2);
    assert_eq!(prefixes[0].0, "preset-");
    assert_eq!(prefixes[0].1, 3);
    assert_eq!(prefixes[0].2, "preset-c");
    assert!(prefixes[0].3.is_some());
    assert_eq!(prefixes[1].0, "scenario-");
    assert_eq!(prefixes[1].1, 2);
    assert_eq!(prefixes[1].2, "scenario-b");
    assert!(prefixes[1].3.is_some());

    let cutoff_timestamp = Utc::now() - ChronoDuration::hours(1);
    let (
      filtered_total_prefixes,
      filtered_unscoped_total_prefixes,
      filtered_unscoped_total_entries,
      filtered_scoped_total_entries,
      filtered_prefixes,
    ) = state
      .agent_ops_cache_prefixes(workbook.id, None, Some(cutoff_timestamp), 1, "count", 0, 5)
      .await
      .expect("age-filtered prefixes should load");
    assert_eq!(filtered_total_prefixes, 0);
    assert_eq!(filtered_unscoped_total_prefixes, 2);
    assert_eq!(filtered_unscoped_total_entries, 6);
    assert_eq!(filtered_scoped_total_entries, 0);
    assert!(filtered_prefixes.is_empty());

    let (
      prefix_scoped_total_prefixes,
      prefix_scoped_unscoped_total_prefixes,
      prefix_scoped_unscoped_total_entries,
      prefix_scoped_total_entries,
      prefix_scoped_prefixes,
    ) = state
      .agent_ops_cache_prefixes(workbook.id, Some("scenario-"), None, 1, "count", 0, 5)
      .await
      .expect("prefix-scoped suggestions should load");
    assert_eq!(prefix_scoped_total_prefixes, 1);
    assert_eq!(prefix_scoped_unscoped_total_prefixes, 2);
    assert_eq!(prefix_scoped_unscoped_total_entries, 6);
    assert_eq!(prefix_scoped_total_entries, 2);
    assert_eq!(prefix_scoped_prefixes.len(), 1);
    assert_eq!(prefix_scoped_prefixes[0].0, "scenario-");
    assert_eq!(prefix_scoped_prefixes[0].1, 2);
    assert_eq!(prefix_scoped_prefixes[0].2, "scenario-b");
    assert!(prefix_scoped_prefixes[0].3.is_some());

    let (
      min_filtered_total_prefixes,
      min_filtered_unscoped_total_prefixes,
      min_filtered_unscoped_total_entries,
      min_filtered_scoped_total_entries,
      min_filtered_prefixes,
    ) = state
      .agent_ops_cache_prefixes(workbook.id, None, None, 3, "count", 0, 5)
      .await
      .expect("min-entry-count filtered suggestions should load");
    assert_eq!(min_filtered_total_prefixes, 1);
    assert_eq!(min_filtered_unscoped_total_prefixes, 2);
    assert_eq!(min_filtered_unscoped_total_entries, 6);
    assert_eq!(min_filtered_scoped_total_entries, 3);
    assert_eq!(min_filtered_prefixes.len(), 1);
    assert_eq!(min_filtered_prefixes[0].0, "preset-");
    assert_eq!(min_filtered_prefixes[0].1, 3);
  }

  #[tokio::test]
  async fn should_sort_equal_prefix_counts_by_newest_cached_at() {
    let temp_dir = tempdir().expect("temp dir should be created");
    let state =
      AppState::new(temp_dir.path().to_path_buf()).expect("state should initialize");
    let workbook = state
      .create_workbook(Some("cache-prefix-order".to_string()))
      .await
      .expect("workbook should be created");

    for request_id in ["alpha-1", "beta-1"] {
      state
        .cache_agent_ops_response(
          workbook.id,
          request_id.to_string(),
          vec![AgentOperation::Recalculate],
          AgentOpsResponse {
            request_id: Some(request_id.to_string()),
            operations_signature: Some(format!("sig-{request_id}")),
            served_from_cache: false,
            results: Vec::new(),
          },
        )
        .await
        .expect("cache update should succeed");
      tokio::time::sleep(Duration::from_millis(2)).await;
    }

    let (_, _, _, _, prefixes) = state
      .agent_ops_cache_prefixes(workbook.id, None, None, 1, "count", 0, 5)
      .await
      .expect("prefix suggestions should load");
    assert_eq!(prefixes.len(), 2);
    assert_eq!(prefixes[0].0, "beta-");
    assert_eq!(prefixes[1].0, "alpha-");
  }

  #[tokio::test]
  async fn should_sort_prefix_suggestions_by_recent_when_requested() {
    let temp_dir = tempdir().expect("temp dir should be created");
    let state =
      AppState::new(temp_dir.path().to_path_buf()).expect("state should initialize");
    let workbook = state
      .create_workbook(Some("cache-prefix-sort-recent".to_string()))
      .await
      .expect("workbook should be created");

    for request_id in ["many-1", "many-2", "few-1"] {
      state
        .cache_agent_ops_response(
          workbook.id,
          request_id.to_string(),
          vec![AgentOperation::Recalculate],
          AgentOpsResponse {
            request_id: Some(request_id.to_string()),
            operations_signature: Some(format!("sig-{request_id}")),
            served_from_cache: false,
            results: Vec::new(),
          },
        )
        .await
        .expect("cache update should succeed");
      tokio::time::sleep(Duration::from_millis(2)).await;
    }

    let (_, _, _, _, count_sorted_prefixes) = state
      .agent_ops_cache_prefixes(workbook.id, None, None, 1, "count", 0, 5)
      .await
      .expect("count-sorted prefixes should load");
    assert_eq!(count_sorted_prefixes[0].0, "many-");
    assert_eq!(count_sorted_prefixes[1].0, "few-");

    let (_, _, _, _, recent_sorted_prefixes) = state
      .agent_ops_cache_prefixes(workbook.id, None, None, 1, "recent", 0, 5)
      .await
      .expect("recent-sorted prefixes should load");
    assert_eq!(recent_sorted_prefixes[0].0, "few-");
    assert_eq!(recent_sorted_prefixes[1].0, "many-");

    let (_, _, _, _, alpha_sorted_prefixes) = state
      .agent_ops_cache_prefixes(workbook.id, None, None, 1, "alpha", 0, 5)
      .await
      .expect("alpha-sorted prefixes should load");
    assert_eq!(alpha_sorted_prefixes[0].0, "few-");
    assert_eq!(alpha_sorted_prefixes[1].0, "many-");
  }

  #[tokio::test]
  async fn should_page_prefix_suggestions_with_offset() {
    let temp_dir = tempdir().expect("temp dir should be created");
    let state =
      AppState::new(temp_dir.path().to_path_buf()).expect("state should initialize");
    let workbook = state
      .create_workbook(Some("cache-prefix-offset".to_string()))
      .await
      .expect("workbook should be created");

    for request_id in ["alpha-1", "beta-1", "gamma-1"] {
      state
        .cache_agent_ops_response(
          workbook.id,
          request_id.to_string(),
          vec![AgentOperation::Recalculate],
          AgentOpsResponse {
            request_id: Some(request_id.to_string()),
            operations_signature: Some(format!("sig-{request_id}")),
            served_from_cache: false,
            results: Vec::new(),
          },
        )
        .await
        .expect("cache update should succeed");
      tokio::time::sleep(Duration::from_millis(2)).await;
    }

    let (total_prefixes, _, unscoped_total_entries, scoped_total_entries, first_page) = state
      .agent_ops_cache_prefixes(workbook.id, None, None, 1, "recent", 0, 2)
      .await
      .expect("first page should load");
    assert_eq!(total_prefixes, 3);
    assert_eq!(unscoped_total_entries, 3);
    assert_eq!(scoped_total_entries, 3);
    assert_eq!(first_page.len(), 2);
    assert_eq!(first_page[0].0, "gamma-");
    assert_eq!(first_page[1].0, "beta-");

    let (_, _, _, _, second_page) = state
      .agent_ops_cache_prefixes(workbook.id, None, None, 1, "recent", 2, 2)
      .await
      .expect("second page should load");
    assert_eq!(second_page.len(), 1);
    assert_eq!(second_page[0].0, "alpha-");
  }

  #[tokio::test]
  async fn should_preview_and_remove_stale_cache_entries() {
    let temp_dir = tempdir().expect("temp dir should be created");
    let state =
      AppState::new(temp_dir.path().to_path_buf()).expect("state should initialize");
    let workbook = state
      .create_workbook(Some("cache-remove-stale".to_string()))
      .await
      .expect("workbook should be created");

    for request_id in ["stale-1", "stale-2"] {
      state
        .cache_agent_ops_response(
          workbook.id,
          request_id.to_string(),
          vec![AgentOperation::Recalculate],
          AgentOpsResponse {
            request_id: Some(request_id.to_string()),
            operations_signature: Some(format!("sig-{request_id}")),
            served_from_cache: false,
            results: Vec::new(),
          },
        )
        .await
        .expect("cache update should succeed");
    }

    let cutoff_timestamp = Utc::now() + ChronoDuration::seconds(1);
    let preview = state
      .remove_stale_agent_ops_cache_entries(workbook.id, None, cutoff_timestamp, true, 1)
      .await
      .expect("stale preview should succeed");
    assert_eq!(preview.0, 2);
    assert_eq!(preview.1, 2);
    assert_eq!(preview.2, 0);
    assert_eq!(preview.3, 2);
    assert_eq!(preview.4.len(), 1);

    let remove = state
      .remove_stale_agent_ops_cache_entries(workbook.id, None, cutoff_timestamp, false, 10)
      .await
      .expect("stale remove should succeed");
    assert_eq!(remove.0, 2);
    assert_eq!(remove.1, 2);
    assert_eq!(remove.2, 2);
    assert_eq!(remove.3, 0);
  }

  #[tokio::test]
  async fn should_preview_and_remove_stale_cache_entries_by_prefix() {
    let temp_dir = tempdir().expect("temp dir should be created");
    let state =
      AppState::new(temp_dir.path().to_path_buf()).expect("state should initialize");
    let workbook = state
      .create_workbook(Some("cache-remove-stale-prefix".to_string()))
      .await
      .expect("workbook should be created");

    for request_id in ["scenario-1", "scenario-2", "preset-1"] {
      state
        .cache_agent_ops_response(
          workbook.id,
          request_id.to_string(),
          vec![AgentOperation::Recalculate],
          AgentOpsResponse {
            request_id: Some(request_id.to_string()),
            operations_signature: Some(format!("sig-{request_id}")),
            served_from_cache: false,
            results: Vec::new(),
          },
        )
        .await
        .expect("cache update should succeed");
    }

    let cutoff_timestamp = Utc::now() + ChronoDuration::seconds(1);
    let preview = state
      .remove_stale_agent_ops_cache_entries(
        workbook.id,
        Some("scenario-"),
        cutoff_timestamp,
        true,
        5,
      )
      .await
      .expect("stale preview should succeed");
    assert_eq!(preview.0, 2);
    assert_eq!(preview.1, 3);
    assert_eq!(preview.2, 0);
    assert_eq!(preview.3, 3);

    let remove = state
      .remove_stale_agent_ops_cache_entries(
        workbook.id,
        Some("scenario-"),
        cutoff_timestamp,
        false,
        5,
      )
      .await
      .expect("stale remove should succeed");
    assert_eq!(remove.0, 2);
    assert_eq!(remove.1, 3);
    assert_eq!(remove.2, 2);
    assert_eq!(remove.3, 1);
  }
}
