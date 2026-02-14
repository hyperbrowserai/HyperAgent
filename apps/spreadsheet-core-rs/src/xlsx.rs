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
  pub formula_cells_imported: usize,
  pub formula_cells_with_cached_values: usize,
  pub formula_cells_without_cached_values: usize,
  pub warnings: Vec<String>,
}

pub fn import_xlsx(db_path: &PathBuf, bytes: &[u8]) -> Result<ImportResult, ApiError> {
  let mut temp_file = NamedTempFile::new().map_err(ApiError::internal)?;
  temp_file.write_all(bytes).map_err(ApiError::internal)?;

  let mut workbook =
    open_workbook_auto(temp_file.path()).map_err(ApiError::internal)?;
  let sheet_names = workbook.sheet_names().to_vec();
  let mut cells_imported = 0usize;
  let mut formula_cells_imported = 0usize;
  let mut formula_cells_with_cached_values = 0usize;

  for sheet_name in &sheet_names {
    let Ok(range) = workbook.worksheet_range(sheet_name) else {
      continue;
    };
    let formula_range = workbook.worksheet_formula(sheet_name).ok();
    let formula_start = formula_range
      .as_ref()
      .and_then(|formula_grid| formula_grid.start())
      .map(|(row, col)| (row as usize, col as usize));
    let (range_start_row, range_start_col) = range.start().unwrap_or((0, 0));
    let mut mutations = Vec::new();

    for (row_offset, row) in range.rows().enumerate() {
      for (col_offset, cell_value) in row.iter().enumerate() {
        let row_index = range_start_row as usize + row_offset;
        let col_index = range_start_col as usize + col_offset;
        let row_number = row_index as u32 + 1;
        let col_number = col_index as u32 + 1;
        let formula = formula_range
          .as_ref()
          .and_then(|formula_grid| {
            let (formula_start_row, formula_start_col) = formula_start?;
            if row_index < formula_start_row || col_index < formula_start_col {
              return None;
            }
            let formula_row = row_index - formula_start_row;
            let formula_col = col_index - formula_start_col;
            formula_grid.get((formula_row, formula_col))
          })
          .and_then(|value| normalize_imported_formula(value.to_string().as_str()));
        if formula.is_some() {
          formula_cells_imported += 1;
        }

        if let Some(value) = map_data_to_json(cell_value) {
          if formula.is_some() {
            formula_cells_with_cached_values += 1;
          }
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

  let formula_cells_without_cached_values =
    formula_cells_imported.saturating_sub(formula_cells_with_cached_values);

  Ok(ImportResult {
    sheet_names: sheet_names.clone(),
    sheets_imported: sheet_names.len(),
    cells_imported,
    formula_cells_imported,
    formula_cells_with_cached_values,
    formula_cells_without_cached_values,
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

fn normalize_imported_formula(formula: &str) -> Option<String> {
  let trimmed = formula.trim();
  if trimmed.is_empty() {
    return None;
  }

  let normalized_body =
    strip_known_formula_prefixes(trimmed.strip_prefix('=').unwrap_or(trimmed));
  let normalized_body =
    strip_implicit_intersection_operators(normalized_body.as_str());
  let normalized_body = normalized_body.trim();
  if normalized_body.is_empty() {
    return None;
  }

  Some(format!("={normalized_body}"))
}

fn strip_known_formula_prefixes(formula_body: &str) -> String {
  let mut normalized = String::with_capacity(formula_body.len());
  let mut byte_index = 0usize;

  while byte_index < formula_body.len() {
    let remaining = &formula_body[byte_index..];
    if remaining.len() >= 6 {
      let maybe_prefix = &remaining[..6];
      if maybe_prefix.eq_ignore_ascii_case("_xlfn.")
        || maybe_prefix.eq_ignore_ascii_case("_xlws.")
      {
        byte_index += 6;
        continue;
      }
    }

    let mut chars = remaining.chars();
    let ch = chars.next().expect("remaining string should contain a char");
    normalized.push(ch);
    byte_index += ch.len_utf8();
  }

  normalized
}

fn strip_implicit_intersection_operators(formula_body: &str) -> String {
  let chars = formula_body.chars().collect::<Vec<_>>();
  let mut normalized = String::with_capacity(formula_body.len());
  let mut index = 0usize;
  let mut in_string = false;
  let mut previous_non_whitespace = None;

  while index < chars.len() {
    let ch = chars[index];

    if ch == '"' {
      normalized.push(ch);
      if in_string && index + 1 < chars.len() && chars[index + 1] == '"' {
        normalized.push(chars[index + 1]);
        index += 2;
        continue;
      }
      in_string = !in_string;
      previous_non_whitespace = Some(ch);
      index += 1;
      continue;
    }

    if !in_string && ch == '@' {
      let mut lookahead_index = index + 1;
      while lookahead_index < chars.len() && chars[lookahead_index].is_whitespace() {
        lookahead_index += 1;
      }
      let next_non_whitespace = chars.get(lookahead_index).copied();
      let starts_identifier = next_non_whitespace
        .is_some_and(|next| next.is_ascii_alphabetic() || next == '_' || next == '$');
      let is_prefix_position = matches!(
        previous_non_whitespace,
        None
          | Some('(')
          | Some(',')
          | Some('+')
          | Some('-')
          | Some('*')
          | Some('/')
          | Some('^')
          | Some('&')
          | Some('=')
          | Some('<')
          | Some('>')
          | Some(':')
          | Some(';')
          | Some('{')
      );
      if starts_identifier && is_prefix_position {
        index += 1;
        continue;
      }
    }

    normalized.push(ch);
    if !ch.is_whitespace() {
      previous_non_whitespace = Some(ch);
    }
    index += 1;
  }

  normalized
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
  use super::{export_xlsx, import_xlsx, normalize_imported_formula};
  use crate::{
    models::{ChartSpec, ChartType, WorkbookSummary},
    state::AppState,
    store::{load_sheet_snapshot, recalculate_formulas},
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

  fn formula_matrix_fixture_workbook_bytes() -> Vec<u8> {
    let mut workbook = Workbook::new();
    let calc_sheet = workbook.add_worksheet();
    calc_sheet.set_name("Calc").expect("sheet should be renamed");
    calc_sheet
      .write_formula(0, 1, Formula::new("=BITAND(6,3)").set_result("2"))
      .expect("bitand should write");
    calc_sheet
      .write_formula(1, 1, Formula::new("=DEC2HEX(255,4)").set_result("00FF"))
      .expect("dec2hex should write");
    calc_sheet
      .write_formula(2, 1, Formula::new("=DOLLARDE(1.02,16)").set_result("1.125"))
      .expect("dollarde should write");
    calc_sheet
      .write_formula(3, 1, Formula::new("=DELTA(5,5)").set_result("1"))
      .expect("delta should write");

    workbook
      .save_to_buffer()
      .expect("formula matrix fixture workbook should serialize")
  }

  fn offset_range_fixture_workbook_bytes() -> Vec<u8> {
    let mut workbook = Workbook::new();
    let offset_sheet = workbook.add_worksheet();
    offset_sheet
      .set_name("Offset")
      .expect("sheet should be renamed");
    offset_sheet
      .write_number(3, 2, 10.0)
      .expect("first number should write");
    offset_sheet
      .write_number(4, 2, 20.0)
      .expect("second number should write");
    offset_sheet
      .write_formula(5, 3, Formula::new("=@SUM(C4:C5)").set_result("30"))
      .expect("sum formula should write");

    workbook
      .save_to_buffer()
      .expect("offset range fixture workbook should serialize")
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

  #[test]
  fn should_normalize_prefixed_formula_tokens() {
    assert_eq!(
      normalize_imported_formula("=_xlfn.BITAND(6,3)").as_deref(),
      Some("=BITAND(6,3)"),
    );
    assert_eq!(
      normalize_imported_formula("=_XLFN.BITAND(6,3)").as_deref(),
      Some("=BITAND(6,3)"),
    );
    assert_eq!(
      normalize_imported_formula("=_xlws.SUM(A1:A3)").as_deref(),
      Some("=SUM(A1:A3)"),
    );
    assert_eq!(
      normalize_imported_formula("=_XLWS.SUM(A1:A3)").as_deref(),
      Some("=SUM(A1:A3)"),
    );
    assert_eq!(
      normalize_imported_formula("=IF(_XLFN.BITAND(6,3)=2,1,0)").as_deref(),
      Some("=IF(BITAND(6,3)=2,1,0)"),
    );
    assert_eq!(
      normalize_imported_formula("=@SUM(A1:A3)").as_deref(),
      Some("=SUM(A1:A3)"),
    );
    assert_eq!(
      normalize_imported_formula("=IF(@A1>0,@_XLFN.BITAND(6,3),0)").as_deref(),
      Some("=IF(A1>0,BITAND(6,3),0)"),
    );
    assert_eq!(
      normalize_imported_formula("=Table[@Amount]").as_deref(),
      Some("=Table[@Amount]"),
    );
    assert_eq!(
      normalize_imported_formula("=\"user@example.com\"").as_deref(),
      Some("=\"user@example.com\""),
    );
    assert_eq!(
      normalize_imported_formula("  SUM(A1:A3)  ").as_deref(),
      Some("=SUM(A1:A3)"),
    );
    assert_eq!(normalize_imported_formula("  "), None);
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
    assert!(
      import_result.formula_cells_imported <= import_result.cells_imported,
      "formula cell count should not exceed total imported cells",
    );
    assert!(
      import_result.formula_cells_with_cached_values <= import_result.formula_cells_imported,
      "cached formula value count should not exceed formula cell count",
    );
    assert_eq!(
      import_result.formula_cells_imported,
      import_result.formula_cells_with_cached_values
        + import_result.formula_cells_without_cached_values,
      "formula cached/non-cached counts should add up",
    );
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
    if imported_total_cell.formula.is_some() {
      assert!(
        imported_total_cell.evaluated_value.is_some(),
        "formula imports should preserve cached evaluated value when available",
      );
    }
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
    if replay_total_cell.formula.is_some() {
      assert!(
        replay_total_cell.evaluated_value.is_some(),
        "formula roundtrip should preserve cached evaluated value when available",
      );
    }
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

  #[tokio::test]
  async fn should_import_non_a1_range_cells_at_original_coordinates() {
    let temp_dir = tempdir().expect("temp dir should be created");
    let state =
      AppState::new(temp_dir.path().to_path_buf()).expect("state should initialize");
    let workbook = state
      .create_workbook(Some("xlsx-offset-range-fixture".to_string()))
      .await
      .expect("workbook should be created");
    let db_path = state
      .db_path(workbook.id)
      .await
      .expect("db path should be accessible");

    let fixture_bytes = offset_range_fixture_workbook_bytes();
    let import_result =
      import_xlsx(&db_path, &fixture_bytes).expect("offset fixture should import");
    assert_eq!(import_result.sheets_imported, 1);
    assert_eq!(import_result.cells_imported, 3);
    assert_eq!(import_result.formula_cells_imported, 1);

    let (_, unsupported_formulas) =
      recalculate_formulas(&db_path).expect("offset fixture formulas should recalculate");
    assert!(
      unsupported_formulas.is_empty(),
      "offset fixture formulas should stay supported: {:?}",
      unsupported_formulas,
    );

    let offset_snapshot =
      load_sheet_snapshot(&db_path, "Offset").expect("offset snapshot should load");
    let offset_map = snapshot_map(&offset_snapshot);
    let mut offset_addresses = offset_map.keys().cloned().collect::<Vec<_>>();
    offset_addresses.sort();
    assert!(
      offset_map.contains_key("C4"),
      "expected C4 in imported offset snapshot, found addresses: {:?}",
      offset_addresses,
    );
    assert_eq!(
      offset_map
        .get("C4")
        .and_then(|cell| cell.raw_value.as_deref())
        .and_then(|raw_value| raw_value.parse::<f64>().ok())
        .map(|value| value as i64),
      Some(10),
      "first numeric value should stay at C4",
    );
    assert_eq!(
      offset_map
        .get("C5")
        .and_then(|cell| cell.raw_value.as_deref())
        .and_then(|raw_value| raw_value.parse::<f64>().ok())
        .map(|value| value as i64),
      Some(20),
      "second numeric value should stay at C5",
    );
    assert_eq!(
      offset_map
        .get("D6")
        .and_then(|cell| cell.formula.as_deref()),
      Some("=SUM(C4:C5)"),
      "implicit intersection formula should normalize and stay at D6",
    );
    assert_eq!(
      offset_map
        .get("D6")
        .and_then(|cell| cell.evaluated_value.as_deref())
        .and_then(|value| value.parse::<f64>().ok())
        .map(|value| value as i64),
      Some(30),
      "formula at D6 should evaluate with offset coordinates",
    );
  }

  #[tokio::test]
  async fn should_recalculate_and_roundtrip_supported_formula_fixture() {
    let temp_dir = tempdir().expect("temp dir should be created");
    let source_state =
      AppState::new(temp_dir.path().join("source-formulas")).expect("state should initialize");
    let source_workbook = source_state
      .create_workbook(Some("xlsx-formula-source".to_string()))
      .await
      .expect("source workbook should be created");
    let source_db_path = source_state
      .db_path(source_workbook.id)
      .await
      .expect("source db path should be accessible");

    let formula_fixture_bytes = formula_matrix_fixture_workbook_bytes();
    let import_result = import_xlsx(&source_db_path, &formula_fixture_bytes)
      .expect("formula fixture workbook should import");
    assert_eq!(import_result.sheets_imported, 1);
    assert_eq!(import_result.sheet_names, vec!["Calc".to_string()]);
    assert_eq!(
      import_result.formula_cells_imported, 4,
      "formula fixture should import all formula cells",
    );

    let (_updated_cells, unsupported_formulas) = recalculate_formulas(&source_db_path)
      .expect("formula fixture workbook should recalculate");
    assert!(
      unsupported_formulas.is_empty(),
      "no supported fixture formulas should be unsupported: {:?}",
      unsupported_formulas,
    );

    let source_snapshot =
      load_sheet_snapshot(&source_db_path, "Calc").expect("calc snapshot should load");
    let source_map = snapshot_map(&source_snapshot);
    let source_b1 = source_map.get("B1").expect("B1 should exist");
    let source_b2 = source_map.get("B2").expect("B2 should exist");
    let source_b3 = source_map.get("B3").expect("B3 should exist");
    let source_b4 = source_map.get("B4").expect("B4 should exist");
    assert_eq!(
      source_b1.evaluated_value.as_deref(),
      Some("2"),
      "bitand should evaluate in imported fixture",
    );
    assert_eq!(
      source_b2.evaluated_value.as_deref(),
      Some("00FF"),
      "dec2hex should evaluate in imported fixture",
    );
    assert_eq!(
      source_b3.evaluated_value.as_deref(),
      Some("1.125"),
      "dollarde should evaluate in imported fixture",
    );
    assert_eq!(
      source_b4.evaluated_value.as_deref(),
      Some("1"),
      "delta should evaluate in imported fixture",
    );
    let dollarde_value = source_map
      .get("B3")
      .and_then(|cell| cell.evaluated_value.as_deref())
      .and_then(|value| value.parse::<f64>().ok())
      .expect("dollarde value should parse as number");
    assert!(
      (dollarde_value - 1.125).abs() < 1e-9,
      "dollarde should evaluate to 1.125",
    );

    let summary = WorkbookSummary {
      id: source_workbook.id,
      name: "formula-roundtrip".to_string(),
      created_at: Utc::now(),
      sheets: vec!["Calc".to_string()],
      charts: Vec::new(),
      compatibility_warnings: Vec::new(),
    };
    let (exported_bytes, _) =
      export_xlsx(&source_db_path, &summary).expect("formula fixture workbook should export");

    let replay_state =
      AppState::new(temp_dir.path().join("replay-formulas")).expect("state should initialize");
    let replay_workbook = replay_state
      .create_workbook(Some("xlsx-formula-replay".to_string()))
      .await
      .expect("replay workbook should be created");
    let replay_db_path = replay_state
      .db_path(replay_workbook.id)
      .await
      .expect("replay db path should be accessible");
    import_xlsx(&replay_db_path, &exported_bytes)
      .expect("re-exported formula workbook should import");

    let (_, replay_unsupported_formulas) = recalculate_formulas(&replay_db_path)
      .expect("re-exported formula workbook should recalculate");
    assert!(
      replay_unsupported_formulas.is_empty(),
      "roundtrip formulas should remain evaluable: {:?}",
      replay_unsupported_formulas,
    );

    let replay_snapshot =
      load_sheet_snapshot(&replay_db_path, "Calc").expect("replay calc snapshot should load");
    let replay_map = snapshot_map(&replay_snapshot);
    assert_eq!(
      replay_map
        .get("B1")
        .and_then(|cell| cell.evaluated_value.as_deref()),
      Some("2"),
    );
    assert_eq!(
      replay_map
        .get("B2")
        .and_then(|cell| cell.evaluated_value.as_deref()),
      Some("00FF"),
    );
    assert_eq!(
      replay_map
        .get("B3")
        .and_then(|cell| cell.evaluated_value.as_deref()),
      Some("1.125"),
    );
    assert_eq!(
      replay_map
        .get("B4")
        .and_then(|cell| cell.evaluated_value.as_deref()),
      Some("1"),
    );
    let replay_dollarde_value = replay_map
      .get("B3")
      .and_then(|cell| cell.evaluated_value.as_deref())
      .and_then(|value| value.parse::<f64>().ok())
      .expect("replay dollarde value should parse as number");
    assert!(
      (replay_dollarde_value - 1.125).abs() < 1e-9,
      "replay dollarde should evaluate to 1.125",
    );
  }
}
