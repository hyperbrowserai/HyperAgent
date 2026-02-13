use crate::{
  error::ApiError,
  formula::{
    address_from_row_col, parse_aggregate_formula, parse_cell_address,
    parse_concat_formula, parse_if_formula, parse_single_ref_formula,
    parse_today_formula, parse_vlookup_formula, VLookupFormula,
  },
  models::{CellMutation, CellRange, CellSnapshot},
};
use chrono::Utc;
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

  if let Some((condition, true_value, false_value)) = parse_if_formula(formula) {
    let condition_result = evaluate_if_condition(connection, sheet, &condition)?;
    let chosen_value = if condition_result {
      true_value
    } else {
      false_value
    };
    return resolve_scalar_operand(connection, sheet, &chosen_value).map(Some);
  }

  if let Some(concat_args) = parse_concat_formula(formula) {
    let mut output = String::new();
    for argument in concat_args {
      output.push_str(&resolve_scalar_operand(connection, sheet, &argument)?);
    }
    return Ok(Some(output));
  }

  if parse_today_formula(formula).is_some() {
    return Ok(Some(Utc::now().date_naive().to_string()));
  }

  if let Some(vlookup_formula) = parse_vlookup_formula(formula) {
    return evaluate_vlookup_formula(connection, sheet, &vlookup_formula);
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

fn evaluate_if_condition(
  connection: &Connection,
  sheet: &str,
  condition: &str,
) -> Result<bool, ApiError> {
  const OPERATORS: [&str; 6] = ["<>", ">=", "<=", "=", ">", "<"];
  for operator in OPERATORS {
    if let Some((left, right)) = split_condition(condition, operator) {
      return evaluate_condition_operands(connection, sheet, &left, &right, operator);
    }
  }

  Ok(resolve_truthy_operand(
    &resolve_scalar_operand(connection, sheet, condition)?,
  ))
}

fn split_condition(condition: &str, operator: &str) -> Option<(String, String)> {
  let mut in_quotes = false;
  let mut paren_depth = 0i32;
  let chars: Vec<char> = condition.chars().collect();
  let op_chars: Vec<char> = operator.chars().collect();
  let mut index = 0usize;

  while index + op_chars.len() <= chars.len() {
    let ch = chars[index];
    if ch == '"' {
      in_quotes = !in_quotes;
      index += 1;
      continue;
    }

    if !in_quotes {
      if ch == '(' {
        paren_depth += 1;
      } else if ch == ')' && paren_depth > 0 {
        paren_depth -= 1;
      }

      if paren_depth == 0 && chars[index..(index + op_chars.len())] == op_chars[..] {
        let left = condition[..index].trim();
        let right = condition[(index + op_chars.len())..].trim();
        if left.is_empty() || right.is_empty() {
          return None;
        }
        return Some((left.to_string(), right.to_string()));
      }
    }

    index += 1;
  }

  None
}

fn evaluate_condition_operands(
  connection: &Connection,
  sheet: &str,
  left_operand: &str,
  right_operand: &str,
  operator: &str,
) -> Result<bool, ApiError> {
  let left_value = resolve_scalar_operand(connection, sheet, left_operand)?;
  let right_value = resolve_scalar_operand(connection, sheet, right_operand)?;

  if let Some((left_numeric, right_numeric)) = left_value
    .parse::<f64>()
    .ok()
    .zip(right_value.parse::<f64>().ok())
  {
    return Ok(compare_numbers(left_numeric, right_numeric, operator));
  }

  Ok(compare_strings(
    &left_value.to_lowercase(),
    &right_value.to_lowercase(),
    operator,
  ))
}

fn compare_numbers(left: f64, right: f64, operator: &str) -> bool {
  match operator {
    "=" => (left - right).abs() < f64::EPSILON,
    "<>" => (left - right).abs() >= f64::EPSILON,
    ">" => left > right,
    ">=" => left >= right,
    "<" => left < right,
    "<=" => left <= right,
    _ => false,
  }
}

fn compare_strings(left: &str, right: &str, operator: &str) -> bool {
  match operator {
    "=" => left == right,
    "<>" => left != right,
    ">" => left > right,
    ">=" => left >= right,
    "<" => left < right,
    "<=" => left <= right,
    _ => false,
  }
}

fn resolve_truthy_operand(value: &str) -> bool {
  let normalized = value.trim().to_lowercase();
  if normalized.is_empty() || normalized == "false" {
    return false;
  }
  if let Ok(number) = normalized.parse::<f64>() {
    return number != 0.0;
  }
  true
}

fn resolve_scalar_operand(
  connection: &Connection,
  sheet: &str,
  operand: &str,
) -> Result<String, ApiError> {
  let trimmed = operand.trim();
  if trimmed.starts_with('"') && trimmed.ends_with('"') && trimmed.len() >= 2 {
    return Ok(trimmed[1..(trimmed.len() - 1)].replace("\"\"", "\""));
  }

  if let Some((row_index, col_index)) = parse_cell_address(trimmed) {
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
      .unwrap_or_default();
    return Ok(value);
  }

  Ok(trimmed.to_string())
}

fn evaluate_vlookup_formula(
  connection: &Connection,
  sheet: &str,
  formula: &VLookupFormula,
) -> Result<Option<String>, ApiError> {
  if formula
    .range_lookup
    .as_deref()
    .map(|value| {
      let normalized = value.trim().to_uppercase();
      normalized == "TRUE" || normalized == "1"
    })
    .unwrap_or(false)
  {
    return Ok(None);
  }

  let start_row = formula.table_start.0.min(formula.table_end.0);
  let end_row = formula.table_start.0.max(formula.table_end.0);
  let start_col = formula.table_start.1.min(formula.table_end.1);
  let end_col = formula.table_start.1.max(formula.table_end.1);
  let width = end_col.saturating_sub(start_col) + 1;
  if formula.result_col_index > width {
    return Ok(Some(String::new()));
  }

  let lookup_value = resolve_scalar_operand(connection, sheet, &formula.lookup_value)?;
  let lookup_numeric = lookup_value.parse::<f64>().ok();
  let target_col = start_col + formula.result_col_index - 1;

  for row_index in start_row..=end_row {
    let candidate = connection
      .query_row(
        r#"
        SELECT COALESCE(evaluated_value, raw_value)
        FROM cells
        WHERE sheet = ?1 AND row_index = ?2 AND col_index = ?3
        "#,
        params![sheet, i64::from(row_index), i64::from(start_col)],
        |row| row.get::<_, Option<String>>(0),
      )
      .map_err(ApiError::internal)?
      .unwrap_or_default();

    let is_match = if let Some(target_numeric) = lookup_numeric {
      candidate
        .parse::<f64>()
        .map(|candidate_numeric| (candidate_numeric - target_numeric).abs() < f64::EPSILON)
        .unwrap_or(false)
    } else {
      candidate.trim().eq_ignore_ascii_case(lookup_value.trim())
    };

    if !is_match {
      continue;
    }

    let resolved = connection
      .query_row(
        r#"
        SELECT COALESCE(evaluated_value, raw_value)
        FROM cells
        WHERE sheet = ?1 AND row_index = ?2 AND col_index = ?3
        "#,
        params![sheet, i64::from(row_index), i64::from(target_col)],
        |row| row.get::<_, Option<String>>(0),
      )
      .map_err(ApiError::internal)?
      .unwrap_or_default();
    return Ok(Some(resolved));
  }

  Ok(Some(String::new()))
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

#[cfg(test)]
mod tests {
  use super::{get_cells, recalculate_formulas, set_cells};
  use crate::models::{CellMutation, CellRange};
  use chrono::NaiveDate;
  use duckdb::Connection;
  use serde_json::json;
  use std::path::PathBuf;
  use tempfile::{TempDir, tempdir};

  fn create_initialized_db_path() -> (TempDir, PathBuf) {
    let temp_dir = tempdir().expect("temp dir should be created");
    let db_path = temp_dir.path().join("test.duckdb");
    let connection = Connection::open(&db_path).expect("database should open");
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
      .expect("cells table should be created");
    (temp_dir, db_path)
  }

  #[test]
  fn should_recalculate_if_concat_today_and_vlookup_formulas() {
    let (_temp_dir, db_path) = create_initialized_db_path();
    let cells = vec![
      CellMutation {
        row: 1,
        col: 1,
        value: Some(json!(120)),
        formula: None,
      },
      CellMutation {
        row: 2,
        col: 1,
        value: Some(json!(80)),
        formula: None,
      },
      CellMutation {
        row: 1,
        col: 2,
        value: None,
        formula: Some(r#"=IF(A1>=100,"bonus","standard")"#.to_string()),
      },
      CellMutation {
        row: 2,
        col: 2,
        value: None,
        formula: Some(r#"=IF(A2>=100,"bonus","standard")"#.to_string()),
      },
      CellMutation {
        row: 1,
        col: 3,
        value: None,
        formula: Some(r#"=CONCAT("Q1-",B1)"#.to_string()),
      },
      CellMutation {
        row: 1,
        col: 4,
        value: None,
        formula: Some("=TODAY()".to_string()),
      },
      CellMutation {
        row: 1,
        col: 5,
        value: Some(json!("north")),
        formula: None,
      },
      CellMutation {
        row: 1,
        col: 6,
        value: Some(json!("Northeast")),
        formula: None,
      },
      CellMutation {
        row: 2,
        col: 5,
        value: Some(json!("south")),
        formula: None,
      },
      CellMutation {
        row: 2,
        col: 6,
        value: Some(json!("Southeast")),
        formula: None,
      },
      CellMutation {
        row: 1,
        col: 7,
        value: None,
        formula: Some(r#"=VLOOKUP("south",E1:F2,2,FALSE)"#.to_string()),
      },
      CellMutation {
        row: 1,
        col: 8,
        value: None,
        formula: Some(r#"=VLOOKUP("missing",E1:F2,2,FALSE)"#.to_string()),
      },
    ];
    set_cells(&db_path, "Sheet1", &cells).expect("cells should upsert");

    let (updated_cells, unsupported_formulas) =
      recalculate_formulas(&db_path).expect("recalculation should work");
    assert_eq!(updated_cells, 6);
    assert!(unsupported_formulas.is_empty());

    let snapshots = get_cells(
      &db_path,
      "Sheet1",
      &CellRange {
        start_row: 1,
        end_row: 2,
        start_col: 1,
        end_col: 8,
      },
    )
    .expect("cells should be fetched");

    let by_position = |row: u32, col: u32| {
      snapshots
        .iter()
        .find(|cell| cell.row == row && cell.col == col)
        .expect("cell should exist")
    };

    assert_eq!(
      by_position(1, 2).evaluated_value.as_deref(),
      Some("bonus"),
    );
    assert_eq!(
      by_position(2, 2).evaluated_value.as_deref(),
      Some("standard"),
    );
    assert_eq!(
      by_position(1, 3).evaluated_value.as_deref(),
      Some("Q1-bonus"),
    );
    let today = by_position(1, 4)
      .evaluated_value
      .as_deref()
      .expect("today formula should evaluate");
    assert!(
      NaiveDate::parse_from_str(today, "%Y-%m-%d").is_ok(),
      "today formula should produce an ISO date",
    );
    assert_eq!(
      by_position(1, 7).evaluated_value.as_deref(),
      Some("Southeast"),
    );
    assert_eq!(by_position(1, 8).evaluated_value.as_deref(), Some(""));
  }

  #[test]
  fn should_leave_approximate_vlookup_as_unsupported() {
    let (_temp_dir, db_path) = create_initialized_db_path();
    let cells = vec![
      CellMutation {
        row: 1,
        col: 1,
        value: Some(json!("a")),
        formula: None,
      },
      CellMutation {
        row: 1,
        col: 2,
        value: Some(json!("alpha")),
        formula: None,
      },
      CellMutation {
        row: 2,
        col: 3,
        value: None,
        formula: Some(r#"=VLOOKUP("a",A1:B1,2,TRUE)"#.to_string()),
      },
    ];
    set_cells(&db_path, "Sheet1", &cells).expect("cells should upsert");

    let (_updated_cells, unsupported_formulas) =
      recalculate_formulas(&db_path).expect("recalculation should work");
    assert_eq!(
      unsupported_formulas,
      vec![r#"=VLOOKUP("a",A1:B1,2,TRUE)"#.to_string()]
    );
  }
}

