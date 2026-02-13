use crate::{
  error::ApiError,
  models::{CellMutation, ChartType, CompatibilityReport, WorkbookSummary},
  store::{load_sheet_snapshot, set_cells},
};
use calamine::{open_workbook_auto, Data, Reader};
use rust_xlsxwriter::{Chart, ChartType as XlsxChartType, Formula, Workbook};
use std::{io::Write, path::PathBuf};
use tempfile::NamedTempFile;

#[derive(Debug, Clone)]
pub struct ImportResult {
  pub sheet_names: Vec<String>,
  pub sheets_imported: usize,
  pub cells_imported: usize,
  pub warnings: Vec<String>,
}

pub fn import_xlsx(db_path: &PathBuf, bytes: &[u8]) -> Result<ImportResult, ApiError> {
  let mut temp_file = NamedTempFile::new().map_err(ApiError::internal)?;
  temp_file.write_all(bytes).map_err(ApiError::internal)?;

  let mut workbook =
    open_workbook_auto(temp_file.path()).map_err(ApiError::internal)?;
  let sheet_names = workbook.sheet_names().to_vec();
  let mut cells_imported = 0usize;

  for sheet_name in &sheet_names {
    let Ok(range) = workbook.worksheet_range(sheet_name) else {
      continue;
    };
    let formula_range = workbook.worksheet_formula(sheet_name).ok();
    let mut mutations = Vec::new();

    for (row_index, row) in range.rows().enumerate() {
      for (col_index, cell_value) in row.iter().enumerate() {
        let row_number = (row_index + 1) as u32;
        let col_number = (col_index + 1) as u32;
        let formula = formula_range
          .as_ref()
          .and_then(|formula_grid| formula_grid.get((row_index, col_index)))
          .map(ToString::to_string)
          .filter(|value| !value.trim().is_empty());

        if let Some(value) = map_data_to_json(cell_value) {
          mutations.push(CellMutation {
            row: row_number,
            col: col_number,
            value: Some(value),
            formula,
          });
        } else if formula.is_some() {
          mutations.push(CellMutation {
            row: row_number,
            col: col_number,
            value: None,
            formula,
          });
        }
      }
    }

    cells_imported += mutations.len();
    if !mutations.is_empty() {
      set_cells(db_path, sheet_name, &mutations)?;
    }
  }

  Ok(ImportResult {
    sheet_names: sheet_names.clone(),
    sheets_imported: sheet_names.len(),
    cells_imported,
    warnings: vec![
      "Charts, VBA/macros, and pivot artifacts are not imported in v1; formulas and cells are imported best-effort.".to_string(),
    ],
  })
}

pub fn export_xlsx(
  db_path: &PathBuf,
  workbook_summary: &WorkbookSummary,
) -> Result<(Vec<u8>, CompatibilityReport), ApiError> {
  let mut workbook = Workbook::new();

  for sheet_name in &workbook_summary.sheets {
    let worksheet = workbook.add_worksheet();
    worksheet
      .set_name(sheet_name)
      .map_err(ApiError::internal)?;

    let cells = load_sheet_snapshot(db_path, sheet_name)?;
    for cell in cells {
      let row = cell.row.saturating_sub(1);
      let col = u16::try_from(cell.col.saturating_sub(1))
        .map_err(|_| ApiError::BadRequest("Column index exceeds XLSX limits.".to_string()))?;
      if let Some(formula) = cell.formula {
        let normalized_formula = formula.trim();
        let formula_expression = normalized_formula
          .strip_prefix('=')
          .unwrap_or(normalized_formula);
        worksheet
          .write_formula(row, col, Formula::new(formula_expression))
          .map_err(ApiError::internal)?;
        continue;
      }

      if let Some(raw_value) = cell.raw_value {
        if let Ok(number) = raw_value.parse::<f64>() {
          worksheet.write_number(row, col, number).map_err(ApiError::internal)?;
        } else if raw_value.eq_ignore_ascii_case("true")
          || raw_value.eq_ignore_ascii_case("false")
        {
          worksheet
            .write_boolean(row, col, raw_value.eq_ignore_ascii_case("true"))
            .map_err(ApiError::internal)?;
        } else {
          worksheet
            .write_string(row, col, raw_value)
            .map_err(ApiError::internal)?;
        }
      }
    }

    for chart in workbook_summary
      .charts
      .iter()
      .filter(|chart| chart.sheet == *sheet_name)
    {
      let mut workbook_chart = Chart::new(map_chart_type(chart.chart_type.clone()));
      workbook_chart
        .add_series()
        .set_categories(chart.categories_range.as_str())
        .set_values(chart.values_range.as_str());
      workbook_chart.title().set_name(chart.title.as_str());
      worksheet
        .insert_chart(1, 8, &workbook_chart)
        .map_err(ApiError::internal)?;
    }
  }

  let bytes = workbook.save_to_buffer().map_err(ApiError::internal)?;
  let report = CompatibilityReport {
    preserved: vec![
      "Sheet structure".to_string(),
      "Cell values".to_string(),
      "Supported formulas".to_string(),
      "API-defined charts".to_string(),
    ],
    transformed: vec![
      "Cell styles are minimally preserved in v1 export".to_string(),
      "Formula evaluation values recomputed by hybrid engine".to_string(),
    ],
    unsupported: vec![
      "Pivot charts".to_string(),
      "VBA/macros execution".to_string(),
      "External workbook links".to_string(),
    ],
  };

  Ok((bytes, report))
}

fn map_chart_type(chart_type: ChartType) -> XlsxChartType {
  match chart_type {
    ChartType::Line => XlsxChartType::Line,
    ChartType::Bar => XlsxChartType::Bar,
    ChartType::Pie => XlsxChartType::Pie,
    ChartType::Area => XlsxChartType::Area,
    ChartType::Scatter => XlsxChartType::Scatter,
  }
}

fn map_data_to_json(value: &Data) -> Option<serde_json::Value> {
  match value {
    Data::Empty => None,
    Data::String(v) => Some(serde_json::Value::String(v.to_string())),
    Data::Float(v) => serde_json::Number::from_f64(*v).map(serde_json::Value::Number),
    Data::Int(v) => Some(serde_json::Value::Number((*v).into())),
    Data::Bool(v) => Some(serde_json::Value::Bool(*v)),
    Data::DateTime(v) => Some(serde_json::Value::String(v.to_string())),
    Data::DateTimeIso(v) => Some(serde_json::Value::String(v.to_string())),
    Data::DurationIso(v) => Some(serde_json::Value::String(v.to_string())),
    Data::Error(_) => None,
  }
}

#[cfg(test)]
mod tests {
  use super::{export_xlsx, import_xlsx};
  use crate::{
    models::{ChartSpec, ChartType, WorkbookSummary},
    state::AppState,
    store::load_sheet_snapshot,
  };
  use chrono::Utc;
  use rust_xlsxwriter::{Formula, Workbook};
  use std::collections::HashMap;
  use tempfile::tempdir;

  fn fixture_workbook_bytes() -> Vec<u8> {
    let mut workbook = Workbook::new();
    let inputs_sheet = workbook.add_worksheet();
    inputs_sheet.set_name("Inputs").expect("sheet should be renamed");
    inputs_sheet
      .write_string(0, 0, "Region")
      .expect("header should write");
    inputs_sheet
      .write_string(1, 0, "North")
      .expect("text should write");
    inputs_sheet
      .write_string(2, 0, "South")
      .expect("text should write");
    inputs_sheet
      .write_string(0, 1, "Sales")
      .expect("header should write");
    inputs_sheet
      .write_number(1, 1, 120.0)
      .expect("number should write");
    inputs_sheet
      .write_number(2, 1, 80.0)
      .expect("number should write");
    inputs_sheet
      .write_string(0, 2, "Total")
      .expect("header should write");
    inputs_sheet
      .write_formula(1, 2, Formula::new("=SUM(B2:B3)"))
      .expect("formula should write");
    inputs_sheet
      .write_string(0, 3, "Active")
      .expect("header should write");
    inputs_sheet
      .write_boolean(1, 3, true)
      .expect("boolean should write");

    let notes_sheet = workbook.add_worksheet();
    notes_sheet.set_name("Notes").expect("sheet should be renamed");
    notes_sheet
      .write_string(0, 0, "Generated from fixture workbook")
      .expect("notes text should write");

    workbook
      .save_to_buffer()
      .expect("fixture workbook should serialize")
  }

  fn snapshot_map(
    cells: &[crate::models::CellSnapshot],
  ) -> HashMap<String, crate::models::CellSnapshot> {
    cells
      .iter()
      .cloned()
      .map(|cell| (cell.address.clone(), cell))
      .collect::<HashMap<_, _>>()
  }

  #[tokio::test]
  async fn should_import_fixture_workbook_cells_and_formulas() {
    let temp_dir = tempdir().expect("temp dir should be created");
    let state =
      AppState::new(temp_dir.path().to_path_buf()).expect("state should initialize");
    let workbook = state
      .create_workbook(Some("xlsx-import-fixture".to_string()))
      .await
      .expect("workbook should be created");
    let db_path = state
      .db_path(workbook.id)
      .await
      .expect("db path should be accessible");

    let fixture_bytes = fixture_workbook_bytes();
    let import_result =
      import_xlsx(&db_path, &fixture_bytes).expect("fixture workbook should import");
    assert_eq!(import_result.sheets_imported, 2);
    assert_eq!(import_result.cells_imported, 11);
    assert_eq!(
      import_result.sheet_names,
      vec!["Inputs".to_string(), "Notes".to_string()],
    );
    assert!(
      import_result
        .warnings
        .iter()
        .any(|warning| warning.contains("not imported")),
      "import warning should mention unsupported artifacts",
    );

    let inputs_snapshot =
      load_sheet_snapshot(&db_path, "Inputs").expect("inputs snapshot should load");
    let inputs_map = snapshot_map(&inputs_snapshot);
    assert_eq!(
      inputs_map
        .get("A2")
        .and_then(|cell| cell.raw_value.as_deref()),
      Some("North"),
    );
    assert_eq!(
      inputs_map
        .get("B2")
        .and_then(|cell| cell.raw_value.as_deref())
        .and_then(|raw_value| raw_value.parse::<f64>().ok())
        .map(|value| value as i64),
      Some(120),
    );
    let imported_total_cell = inputs_map
      .get("C2")
      .expect("C2 should exist in imported fixture");
    assert!(
      imported_total_cell.formula.as_deref() == Some("=SUM(B2:B3)")
        || imported_total_cell.raw_value.is_some(),
      "expected C2 to preserve formula metadata or fallback value",
    );
    assert_eq!(
      inputs_map
        .get("D2")
        .and_then(|cell| cell.raw_value.as_deref()),
      Some("true"),
    );

    let notes_snapshot =
      load_sheet_snapshot(&db_path, "Notes").expect("notes snapshot should load");
    let notes_map = snapshot_map(&notes_snapshot);
    assert_eq!(
      notes_map
        .get("A1")
        .and_then(|cell| cell.raw_value.as_deref()),
      Some("Generated from fixture workbook"),
    );
  }

  #[tokio::test]
  async fn should_export_and_reimport_fixture_workbook() {
    let temp_dir = tempdir().expect("temp dir should be created");
    let source_state =
      AppState::new(temp_dir.path().join("source")).expect("state should initialize");
    let source_workbook = source_state
      .create_workbook(Some("xlsx-roundtrip-source".to_string()))
      .await
      .expect("source workbook should be created");
    let source_db_path = source_state
      .db_path(source_workbook.id)
      .await
      .expect("source db path should be accessible");
    let fixture_bytes = fixture_workbook_bytes();
    let import_result =
      import_xlsx(&source_db_path, &fixture_bytes).expect("source fixture should import");
    let summary = WorkbookSummary {
      id: source_workbook.id,
      name: "roundtrip".to_string(),
      created_at: Utc::now(),
      sheets: import_result.sheet_names,
      charts: vec![ChartSpec {
        id: "fixture-sales-chart".to_string(),
        sheet: "Inputs".to_string(),
        title: "Fixture Sales".to_string(),
        chart_type: ChartType::Bar,
        categories_range: "Inputs!A2:A3".to_string(),
        values_range: "Inputs!B2:B3".to_string(),
      }],
      compatibility_warnings: Vec::new(),
    };
    let (exported_bytes, compatibility_report) =
      export_xlsx(&source_db_path, &summary).expect("fixture workbook should export");
    assert!(
      exported_bytes.len() > 1_000,
      "expected non-trivial xlsx payload size",
    );
    assert!(
      compatibility_report
        .preserved
        .contains(&"Sheet structure".to_string()),
      "compatibility report should include preserved sheet structure",
    );

    let replay_state =
      AppState::new(temp_dir.path().join("replay")).expect("state should initialize");
    let replay_workbook = replay_state
      .create_workbook(Some("xlsx-roundtrip-replay".to_string()))
      .await
      .expect("replay workbook should be created");
    let replay_db_path = replay_state
      .db_path(replay_workbook.id)
      .await
      .expect("replay db path should be accessible");
    let replay_import_result = import_xlsx(&replay_db_path, &exported_bytes)
      .expect("exported workbook should reimport");
    assert_eq!(replay_import_result.sheets_imported, 2);

    let replay_snapshot =
      load_sheet_snapshot(&replay_db_path, "Inputs").expect("replay inputs should load");
    let replay_map = snapshot_map(&replay_snapshot);
    let replay_total_cell = replay_map
      .get("C2")
      .expect("C2 should exist after roundtrip import");
    assert!(
      replay_total_cell.formula.as_deref() == Some("=SUM(B2:B3)")
        || replay_total_cell.raw_value.is_some(),
      "expected C2 to preserve formula metadata or fallback value",
    );
    assert_eq!(
      replay_map
        .get("A2")
        .and_then(|cell| cell.raw_value.as_deref()),
      Some("North"),
    );
    assert_eq!(
      replay_map
        .get("B3")
        .and_then(|cell| cell.raw_value.as_deref())
        .and_then(|raw_value| raw_value.parse::<f64>().ok())
        .map(|value| value as i64),
      Some(80),
    );
  }
}
