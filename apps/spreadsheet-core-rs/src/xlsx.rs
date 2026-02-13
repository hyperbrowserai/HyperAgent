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
        worksheet
          .write_formula(row, col, Formula::new(formula))
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
