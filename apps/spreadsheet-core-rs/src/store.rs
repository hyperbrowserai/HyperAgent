use crate::{
  error::ApiError,
  formula::{
    address_from_row_col, parse_aggregate_formula, parse_cell_address,
    parse_single_ref_formula,
  },
  models::{CellMutation, CellRange, CellSnapshot},
};
use duckdb::{params, Connection};
use regex::Regex;
use serde_json::Value;
use std::path::PathBuf;

pub fn set_cells(
  db_path: &PathBuf,
  sheet: &str,
  cells: &[CellMutation],
) -> Result<usize, ApiError> {
  let mut connection = Connection::open(db_path).map_err(ApiError::internal)?;
  let transaction = connection.transaction().map_err(ApiError::internal)?;

  for cell in cells {
    let (raw_value, formula, evaluated_value) = normalize_cell_payload(cell)?;
    transaction
      .execute(
        r#"
          INSERT INTO cells(sheet, row_index, col_index, raw_value, formula, evaluated_value)
          VALUES (?1, ?2, ?3, ?4, ?5, ?6)
          ON CONFLICT(sheet, row_index, col_index)
          DO UPDATE SET
            raw_value = excluded.raw_value,
            formula = excluded.formula,
            evaluated_value = excluded.evaluated_value,
            updated_at = now()
        "#,
        params![
          sheet,
          i64::from(cell.row),
          i64::from(cell.col),
          raw_value,
          formula,
          evaluated_value
        ],
      )
      .map_err(ApiError::internal)?;
  }

  transaction.commit().map_err(ApiError::internal)?;
  Ok(cells.len())
}

pub fn get_cells(
  db_path: &PathBuf,
  sheet: &str,
  range: &CellRange,
) -> Result<Vec<CellSnapshot>, ApiError> {
  let connection = Connection::open(db_path).map_err(ApiError::internal)?;
  let mut statement = connection
    .prepare(
      r#"
      SELECT row_index, col_index, raw_value, formula, evaluated_value
      FROM cells
      WHERE sheet = ?1
        AND row_index BETWEEN ?2 AND ?3
        AND col_index BETWEEN ?4 AND ?5
      ORDER BY row_index ASC, col_index ASC
      "#,
    )
    .map_err(ApiError::internal)?;

  let mapped_rows = statement
    .query_map(
      params![
        sheet,
        i64::from(range.start_row),
        i64::from(range.end_row),
        i64::from(range.start_col),
        i64::from(range.end_col)
      ],
      |row| {
        let row_index = row.get::<_, i64>(0)?;
        let col_index = row.get::<_, i64>(1)?;
        let row_u32 = u32::try_from(row_index).unwrap_or_default();
        let col_u32 = u32::try_from(col_index).unwrap_or_default();
        Ok(CellSnapshot {
          row: row_u32,
          col: col_u32,
          address: address_from_row_col(row_u32, col_u32),
          raw_value: row.get::<_, Option<String>>(2)?,
          formula: row.get::<_, Option<String>>(3)?,
          evaluated_value: row.get::<_, Option<String>>(4)?,
        })
      },
    )
    .map_err(ApiError::internal)?;

  let mut cells = Vec::new();
  for row in mapped_rows {
    cells.push(row.map_err(ApiError::internal)?);
  }
  Ok(cells)
}

pub fn recalculate_formulas(
  db_path: &PathBuf,
) -> Result<(usize, Vec<String>), ApiError> {
  let connection = Connection::open(db_path).map_err(ApiError::internal)?;
  let mut statement = connection
    .prepare(
      r#"
      SELECT sheet, row_index, col_index, formula
      FROM cells
      WHERE formula IS NOT NULL
      ORDER BY row_index ASC, col_index ASC
      "#,
    )
    .map_err(ApiError::internal)?;

  let formula_rows = statement
    .query_map([], |row| {
      Ok((
        row.get::<_, String>(0)?,
        row.get::<_, i64>(1)?,
        row.get::<_, i64>(2)?,
        row.get::<_, String>(3)?,
      ))
    })
    .map_err(ApiError::internal)?;

  let mut updated_cells = 0usize;
  let mut unsupported_formulas = Vec::new();
  for row in formula_rows {
    let (sheet, row_index, col_index, formula) = row.map_err(ApiError::internal)?;
    match evaluate_formula(&connection, &sheet, &formula) {
      Ok(Some(value)) => {
        connection
          .execute(
            r#"
            UPDATE cells
            SET evaluated_value = ?1, updated_at = now()
            WHERE sheet = ?2 AND row_index = ?3 AND col_index = ?4
            "#,
            params![value, sheet, row_index, col_index],
          )
          .map_err(ApiError::internal)?;
        updated_cells += 1;
      }
      Ok(None) => unsupported_formulas.push(formula),
      Err(_) => unsupported_formulas.push(formula),
    }
  }

  Ok((updated_cells, unsupported_formulas))
}

pub fn load_sheet_snapshot(
  db_path: &PathBuf,
  sheet: &str,
) -> Result<Vec<CellSnapshot>, ApiError> {
  let connection = Connection::open(db_path).map_err(ApiError::internal)?;
  let mut statement = connection
    .prepare(
      r#"
      SELECT row_index, col_index, raw_value, formula, evaluated_value
      FROM cells
      WHERE sheet = ?1
      ORDER BY row_index ASC, col_index ASC
      "#,
    )
    .map_err(ApiError::internal)?;

  let mapped_rows = statement
    .query_map(params![sheet], |row| {
      let row_index = row.get::<_, i64>(0)?;
      let col_index = row.get::<_, i64>(1)?;
      let row_u32 = u32::try_from(row_index).unwrap_or_default();
      let col_u32 = u32::try_from(col_index).unwrap_or_default();
      Ok(CellSnapshot {
        row: row_u32,
        col: col_u32,
        address: address_from_row_col(row_u32, col_u32),
        raw_value: row.get::<_, Option<String>>(2)?,
        formula: row.get::<_, Option<String>>(3)?,
        evaluated_value: row.get::<_, Option<String>>(4)?,
      })
    })
    .map_err(ApiError::internal)?;

  let mut cells = Vec::new();
  for row in mapped_rows {
    cells.push(row.map_err(ApiError::internal)?);
  }
  Ok(cells)
}

fn evaluate_formula(
  connection: &Connection,
  sheet: &str,
  formula: &str,
) -> Result<Option<String>, ApiError> {
  if let Some((function, start, end)) = parse_aggregate_formula(formula) {
    let aggregate_sql = match function.as_str() {
      "SUM" => "SUM",
      "AVERAGE" => "AVG",
      "MIN" => "MIN",
      "MAX" => "MAX",
      "COUNT" => "COUNT",
      _ => return Ok(None),
    };
    let value_expr = if function == "COUNT" {
      format!(
        "{}(TRY_CAST(COALESCE(evaluated_value, raw_value) AS DOUBLE))",
        aggregate_sql
      )
    } else {
      format!(
        "{}(CAST(COALESCE(evaluated_value, raw_value) AS DOUBLE))",
        aggregate_sql
      )
    };

    let query = format!(
      "SELECT COALESCE(CAST({value_expr} AS VARCHAR), '0') FROM cells WHERE sheet = ?1 AND row_index BETWEEN ?2 AND ?3 AND col_index BETWEEN ?4 AND ?5"
    );
    let value = connection
      .query_row(
        &query,
        params![
          sheet,
          i64::from(start.0.min(end.0)),
          i64::from(start.0.max(end.0)),
          i64::from(start.1.min(end.1)),
          i64::from(start.1.max(end.1))
        ],
        |row| row.get::<_, String>(0),
      )
      .map_err(ApiError::internal)?;
    return Ok(Some(value));
  }

  if let Some((row_index, col_index)) = parse_single_ref_formula(formula) {
    let value = connection
      .query_row(
        r#"
        SELECT COALESCE(evaluated_value, raw_value)
        FROM cells
        WHERE sheet = ?1 AND row_index = ?2 AND col_index = ?3
        "#,
        params![sheet, i64::from(row_index), i64::from(col_index)],
        |row| row.get::<_, Option<String>>(0),
      )
      .map_err(ApiError::internal)?
      .unwrap_or_else(|| "0".to_string());
    return Ok(Some(value));
  }

  if formula.starts_with('=') {
    return evaluate_expression_formula(connection, sheet, formula);
  }

  Ok(None)
}

fn evaluate_expression_formula(
  connection: &Connection,
  sheet: &str,
  formula: &str,
) -> Result<Option<String>, ApiError> {
  let expression = formula.trim_start_matches('=').trim();
  let reference_re = Regex::new(r"([A-Za-z]+\d+)").map_err(ApiError::internal)?;

  let mut translated = expression.to_string();
  for capture in reference_re.captures_iter(expression) {
    if let Some(reference) = capture.get(1).map(|entry| entry.as_str()) {
      if let Some((row_index, col_index)) = parse_cell_address(reference) {
        let numeric_value = connection
          .query_row(
            r#"
            SELECT COALESCE(TRY_CAST(evaluated_value AS DOUBLE), TRY_CAST(raw_value AS DOUBLE), 0)
            FROM cells
            WHERE sheet = ?1 AND row_index = ?2 AND col_index = ?3
            "#,
            params![sheet, i64::from(row_index), i64::from(col_index)],
            |row| row.get::<_, f64>(0),
          )
          .unwrap_or(0.0);
        translated = translated.replace(reference, &numeric_value.to_string());
      }
    }
  }

  let safety_re = Regex::new(r"^[0-9+\-*/().\s]+$").map_err(ApiError::internal)?;
  if !safety_re.is_match(&translated) {
    return Ok(None);
  }

  let sql = format!("SELECT TRY_CAST(({}) AS DOUBLE)", translated);
  let result = connection
    .query_row(&sql, [], |row| row.get::<_, Option<f64>>(0))
    .map_err(ApiError::internal)?
    .unwrap_or(0.0);
  Ok(Some(result.to_string()))
}

fn normalize_cell_payload(
  cell: &CellMutation,
) -> Result<(Option<String>, Option<String>, Option<String>), ApiError> {
  if let Some(formula) = &cell.formula {
    let normalized = if formula.starts_with('=') {
      formula.clone()
    } else {
      format!("={formula}")
    };
    let cached_formula_value = cell
      .value
      .as_ref()
      .map(json_value_to_string)
      .transpose()
      .map_err(ApiError::BadRequest)?;
    return Ok((None, Some(normalized), cached_formula_value));
  }

  let value = cell
    .value
    .as_ref()
    .map(json_value_to_string)
    .transpose()
    .map_err(ApiError::BadRequest)?;
  Ok((value.clone(), None, value))
}

fn json_value_to_string(value: &Value) -> Result<String, String> {
  match value {
    Value::Null => Ok(String::new()),
    Value::Bool(v) => Ok(v.to_string()),
    Value::Number(v) => Ok(v.to_string()),
    Value::String(v) => Ok(v.clone()),
    _ => Err("Cell values must be scalar JSON values.".to_string()),
  }
}

