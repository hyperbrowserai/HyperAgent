use crate::{
  error::ApiError,
  formula::{
    address_from_row_col, parse_aggregate_formula, parse_and_formula,
    parse_averageif_formula, parse_averageifs_formula, parse_cell_address,
    parse_concat_formula, parse_countif_formula, parse_countifs_formula,
    parse_date_formula, parse_day_formula, parse_if_formula, parse_iferror_formula,
    parse_left_formula, parse_index_formula, parse_isblank_formula,
    parse_isnumber_formula, parse_istext_formula, parse_len_formula, parse_lower_formula,
    parse_match_formula, parse_month_formula, parse_not_formula,
    parse_or_formula, parse_right_formula, parse_single_ref_formula,
    parse_trim_formula, parse_sumif_formula, parse_sumifs_formula,
    parse_today_formula, parse_upper_formula, parse_vlookup_formula,
    parse_xlookup_formula, parse_year_formula, ConditionalAggregateFormula,
    IndexFormula, MatchFormula, MultiCriteriaAggregateFormula, VLookupFormula,
    XLookupFormula,
  },
  models::{CellMutation, CellRange, CellSnapshot},
};
use chrono::{Datelike, NaiveDate, Utc};
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

  if let Some((start, end, criteria_operand)) = parse_countif_formula(formula) {
    return evaluate_countif_formula(connection, sheet, start, end, &criteria_operand)
      .map(Some);
  }

  if let Some(sumif_formula) = parse_sumif_formula(formula) {
    return evaluate_sumif_formula(connection, sheet, &sumif_formula);
  }

  if let Some(averageif_formula) = parse_averageif_formula(formula) {
    return evaluate_averageif_formula(connection, sheet, &averageif_formula);
  }

  if let Some(countifs_formula) = parse_countifs_formula(formula) {
    return evaluate_countifs_formula(connection, sheet, &countifs_formula);
  }

  if let Some(sumifs_formula) = parse_sumifs_formula(formula) {
    return evaluate_sumifs_formula(connection, sheet, &sumifs_formula);
  }

  if let Some(averageifs_formula) = parse_averageifs_formula(formula) {
    return evaluate_averageifs_formula(connection, sheet, &averageifs_formula);
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

  if let Some((value_expression, fallback_expression)) = parse_iferror_formula(formula) {
    if let Some(value) = evaluate_formula_argument(connection, sheet, &value_expression)? {
      return Ok(Some(value));
    }
    return resolve_scalar_operand(connection, sheet, &fallback_expression).map(Some);
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

  if let Some(xlookup_formula) = parse_xlookup_formula(formula) {
    return evaluate_xlookup_formula(connection, sheet, &xlookup_formula);
  }

  if let Some(match_formula) = parse_match_formula(formula) {
    return evaluate_match_formula(connection, sheet, &match_formula);
  }

  if let Some(index_formula) = parse_index_formula(formula) {
    return evaluate_index_formula(connection, sheet, &index_formula);
  }

  if let Some(and_args) = parse_and_formula(formula) {
    let result = and_args
      .iter()
      .map(|arg| evaluate_if_condition(connection, sheet, arg))
      .collect::<Result<Vec<bool>, ApiError>>()?
      .into_iter()
      .all(|value| value);
    return Ok(Some(result.to_string()));
  }

  if let Some(or_args) = parse_or_formula(formula) {
    let result = or_args
      .iter()
      .map(|arg| evaluate_if_condition(connection, sheet, arg))
      .collect::<Result<Vec<bool>, ApiError>>()?
      .into_iter()
      .any(|value| value);
    return Ok(Some(result.to_string()));
  }

  if let Some(not_arg) = parse_not_formula(formula) {
    return Ok(Some((!evaluate_if_condition(connection, sheet, &not_arg)?).to_string()));
  }

  if let Some(len_arg) = parse_len_formula(formula) {
    let text = resolve_scalar_operand(connection, sheet, &len_arg)?;
    return Ok(Some(text.chars().count().to_string()));
  }

  if let Some(upper_arg) = parse_upper_formula(formula) {
    let text = resolve_scalar_operand(connection, sheet, &upper_arg)?;
    return Ok(Some(text.to_uppercase()));
  }

  if let Some(lower_arg) = parse_lower_formula(formula) {
    let text = resolve_scalar_operand(connection, sheet, &lower_arg)?;
    return Ok(Some(text.to_lowercase()));
  }

  if let Some(trim_arg) = parse_trim_formula(formula) {
    let text = resolve_scalar_operand(connection, sheet, &trim_arg)?;
    let trimmed = text.split_whitespace().collect::<Vec<&str>>().join(" ");
    return Ok(Some(trimmed));
  }

  if let Some(is_blank_arg) = parse_isblank_formula(formula) {
    let value = resolve_scalar_operand(connection, sheet, &is_blank_arg)?;
    return Ok(Some(value.is_empty().to_string()));
  }

  if let Some(is_number_arg) = parse_isnumber_formula(formula) {
    let value = resolve_scalar_operand(connection, sheet, &is_number_arg)?;
    return Ok(Some(value.trim().parse::<f64>().is_ok().to_string()));
  }

  if let Some(is_text_arg) = parse_istext_formula(formula) {
    let value = resolve_scalar_operand(connection, sheet, &is_text_arg)?;
    let is_text = !value.is_empty() && value.trim().parse::<f64>().is_err();
    return Ok(Some(is_text.to_string()));
  }

  if let Some((text_arg, count_arg)) = parse_left_formula(formula) {
    let text = resolve_scalar_operand(connection, sheet, &text_arg)?;
    let char_count = parse_optional_char_count(connection, sheet, count_arg)?;
    let value = text.chars().take(char_count).collect::<String>();
    return Ok(Some(value));
  }

  if let Some((text_arg, count_arg)) = parse_right_formula(formula) {
    let text = resolve_scalar_operand(connection, sheet, &text_arg)?;
    let char_count = parse_optional_char_count(connection, sheet, count_arg)?;
    let total = text.chars().count();
    let skip_count = total.saturating_sub(char_count);
    let value = text.chars().skip(skip_count).collect::<String>();
    return Ok(Some(value));
  }

  if let Some((year_arg, month_arg, day_arg)) = parse_date_formula(formula) {
    let year = parse_required_integer(connection, sheet, &year_arg)?;
    let month = parse_required_unsigned(connection, sheet, &month_arg)?;
    let day = parse_required_unsigned(connection, sheet, &day_arg)?;
    let value = NaiveDate::from_ymd_opt(year, month, day)
      .map(|date| date.to_string())
      .unwrap_or_default();
    return Ok(Some(value));
  }

  if let Some(year_arg) = parse_year_formula(formula) {
    let date = parse_date_operand(connection, sheet, &year_arg)?;
    return Ok(Some(date.map(|value| value.year().to_string()).unwrap_or_default()));
  }

  if let Some(month_arg) = parse_month_formula(formula) {
    let date = parse_date_operand(connection, sheet, &month_arg)?;
    return Ok(Some(
      date.map(|value| value.month().to_string()).unwrap_or_default(),
    ));
  }

  if let Some(day_arg) = parse_day_formula(formula) {
    let date = parse_date_operand(connection, sheet, &day_arg)?;
    return Ok(Some(date.map(|value| value.day().to_string()).unwrap_or_default()));
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

fn evaluate_countif_formula(
  connection: &Connection,
  sheet: &str,
  start: (u32, u32),
  end: (u32, u32),
  criteria_operand: &str,
) -> Result<String, ApiError> {
  let criteria = resolve_scalar_operand(connection, sheet, criteria_operand)?;
  let start_row = start.0.min(end.0);
  let end_row = start.0.max(end.0);
  let start_col = start.1.min(end.1);
  let end_col = start.1.max(end.1);
  let mut count = 0usize;

  for row_index in start_row..=end_row {
    for col_index in start_col..=end_col {
      let candidate = load_cell_scalar(connection, sheet, row_index, col_index)?;
      if countif_matches_criteria(&candidate, &criteria) {
        count += 1;
      }
    }
  }

  Ok(count.to_string())
}

fn evaluate_formula_argument(
  connection: &Connection,
  sheet: &str,
  expression: &str,
) -> Result<Option<String>, ApiError> {
  let trimmed = expression.trim();
  if trimmed.is_empty() {
    return Ok(Some(String::new()));
  }
  if trimmed.starts_with('"') && trimmed.ends_with('"') {
    return resolve_scalar_operand(connection, sheet, trimmed).map(Some);
  }
  if parse_cell_address(trimmed).is_some() {
    return resolve_scalar_operand(connection, sheet, trimmed).map(Some);
  }
  if trimmed.parse::<f64>().is_ok() {
    return Ok(Some(trimmed.to_string()));
  }

  let normalized = if trimmed.starts_with('=') {
    trimmed.to_string()
  } else {
    format!("={trimmed}")
  };
  match evaluate_formula(connection, sheet, &normalized) {
    Ok(Some(value)) => Ok(Some(value)),
    Ok(None) => Ok(None),
    Err(_) => Ok(None),
  }
}

fn evaluate_sumif_formula(
  connection: &Connection,
  sheet: &str,
  formula: &ConditionalAggregateFormula,
) -> Result<Option<String>, ApiError> {
  let criteria = resolve_scalar_operand(connection, sheet, &formula.criteria)?;
  let Some(cell_pairs) = build_conditional_cell_pairs(formula) else {
    return Ok(None);
  };

  let mut total = 0f64;
  for (criteria_row, criteria_col, value_row, value_col) in cell_pairs {
    let candidate =
      load_cell_scalar(connection, sheet, criteria_row, criteria_col)?;
    if !countif_matches_criteria(&candidate, &criteria) {
      continue;
    }
    let value = load_cell_scalar(connection, sheet, value_row, value_col)?;
    if let Ok(number) = value.trim().parse::<f64>() {
      total += number;
    }
  }

  Ok(Some(total.to_string()))
}

fn evaluate_averageif_formula(
  connection: &Connection,
  sheet: &str,
  formula: &ConditionalAggregateFormula,
) -> Result<Option<String>, ApiError> {
  let criteria = resolve_scalar_operand(connection, sheet, &formula.criteria)?;
  let Some(cell_pairs) = build_conditional_cell_pairs(formula) else {
    return Ok(None);
  };

  let mut total = 0f64;
  let mut numeric_matches = 0usize;
  for (criteria_row, criteria_col, value_row, value_col) in cell_pairs {
    let candidate =
      load_cell_scalar(connection, sheet, criteria_row, criteria_col)?;
    if !countif_matches_criteria(&candidate, &criteria) {
      continue;
    }
    let value = load_cell_scalar(connection, sheet, value_row, value_col)?;
    if let Ok(number) = value.trim().parse::<f64>() {
      total += number;
      numeric_matches += 1;
    }
  }

  if numeric_matches == 0 {
    return Ok(Some("0".to_string()));
  }
  Ok(Some((total / numeric_matches as f64).to_string()))
}

fn build_conditional_cell_pairs(
  formula: &ConditionalAggregateFormula,
) -> Option<Vec<(u32, u32, u32, u32)>> {
  let criteria_start_row = formula
    .criteria_range_start
    .0
    .min(formula.criteria_range_end.0);
  let criteria_end_row = formula
    .criteria_range_start
    .0
    .max(formula.criteria_range_end.0);
  let criteria_start_col = formula
    .criteria_range_start
    .1
    .min(formula.criteria_range_end.1);
  let criteria_end_col = formula
    .criteria_range_start
    .1
    .max(formula.criteria_range_end.1);
  let criteria_height = criteria_end_row.saturating_sub(criteria_start_row) + 1;
  let criteria_width = criteria_end_col.saturating_sub(criteria_start_col) + 1;

  let (value_start_row, value_end_row, value_start_col, value_end_col) = match (
    formula.value_range_start,
    formula.value_range_end,
  ) {
    (Some(start), Some(end)) => (
      start.0.min(end.0),
      start.0.max(end.0),
      start.1.min(end.1),
      start.1.max(end.1),
    ),
    _ => (
      criteria_start_row,
      criteria_end_row,
      criteria_start_col,
      criteria_end_col,
    ),
  };
  let value_height = value_end_row.saturating_sub(value_start_row) + 1;
  let value_width = value_end_col.saturating_sub(value_start_col) + 1;
  if criteria_height != value_height || criteria_width != value_width {
    return None;
  }

  let mut pairs = Vec::new();
  for row_offset in 0..criteria_height {
    for col_offset in 0..criteria_width {
      pairs.push((
        criteria_start_row + row_offset,
        criteria_start_col + col_offset,
        value_start_row + row_offset,
        value_start_col + col_offset,
      ));
    }
  }
  Some(pairs)
}

#[derive(Clone, Copy)]
struct RangeBounds {
  start_row: u32,
  start_col: u32,
  height: u32,
  width: u32,
}

fn normalized_range_bounds(start: (u32, u32), end: (u32, u32)) -> RangeBounds {
  let start_row = start.0.min(end.0);
  let end_row = start.0.max(end.0);
  let start_col = start.1.min(end.1);
  let end_col = start.1.max(end.1);
  RangeBounds {
    start_row,
    start_col,
    height: end_row.saturating_sub(start_row) + 1,
    width: end_col.saturating_sub(start_col) + 1,
  }
}

fn evaluate_countifs_formula(
  connection: &Connection,
  sheet: &str,
  formula: &MultiCriteriaAggregateFormula,
) -> Result<Option<String>, ApiError> {
  let Some(first_condition) = formula.conditions.first() else {
    return Ok(None);
  };
  let criteria_bounds = normalized_range_bounds(
    first_condition.range_start,
    first_condition.range_end,
  );

  let mut conditions = Vec::new();
  for condition in &formula.conditions {
    let bounds = normalized_range_bounds(condition.range_start, condition.range_end);
    if bounds.height != criteria_bounds.height || bounds.width != criteria_bounds.width {
      return Ok(None);
    }
    conditions.push((
      bounds,
      resolve_scalar_operand(connection, sheet, &condition.criteria)?,
    ));
  }

  let mut matches = 0usize;
  for row_offset in 0..criteria_bounds.height {
    for col_offset in 0..criteria_bounds.width {
      if evaluate_multi_criteria_match(
        connection,
        sheet,
        &conditions,
        row_offset,
        col_offset,
      )? {
        matches += 1;
      }
    }
  }

  Ok(Some(matches.to_string()))
}

fn evaluate_sumifs_formula(
  connection: &Connection,
  sheet: &str,
  formula: &MultiCriteriaAggregateFormula,
) -> Result<Option<String>, ApiError> {
  let Some((value_bounds, conditions)) = build_multi_criteria_runtime(
    connection,
    sheet,
    formula,
  )? else {
    return Ok(None);
  };

  let mut total = 0f64;
  for row_offset in 0..value_bounds.height {
    for col_offset in 0..value_bounds.width {
      if !evaluate_multi_criteria_match(
        connection,
        sheet,
        &conditions,
        row_offset,
        col_offset,
      )? {
        continue;
      }
      let value = load_cell_scalar(
        connection,
        sheet,
        value_bounds.start_row + row_offset,
        value_bounds.start_col + col_offset,
      )?;
      if let Ok(number) = value.trim().parse::<f64>() {
        total += number;
      }
    }
  }

  Ok(Some(total.to_string()))
}

fn evaluate_averageifs_formula(
  connection: &Connection,
  sheet: &str,
  formula: &MultiCriteriaAggregateFormula,
) -> Result<Option<String>, ApiError> {
  let Some((value_bounds, conditions)) = build_multi_criteria_runtime(
    connection,
    sheet,
    formula,
  )? else {
    return Ok(None);
  };

  let mut total = 0f64;
  let mut numeric_matches = 0usize;
  for row_offset in 0..value_bounds.height {
    for col_offset in 0..value_bounds.width {
      if !evaluate_multi_criteria_match(
        connection,
        sheet,
        &conditions,
        row_offset,
        col_offset,
      )? {
        continue;
      }
      let value = load_cell_scalar(
        connection,
        sheet,
        value_bounds.start_row + row_offset,
        value_bounds.start_col + col_offset,
      )?;
      if let Ok(number) = value.trim().parse::<f64>() {
        total += number;
        numeric_matches += 1;
      }
    }
  }

  if numeric_matches == 0 {
    return Ok(Some("0".to_string()));
  }
  Ok(Some((total / numeric_matches as f64).to_string()))
}

fn build_multi_criteria_runtime(
  connection: &Connection,
  sheet: &str,
  formula: &MultiCriteriaAggregateFormula,
) -> Result<Option<(RangeBounds, Vec<(RangeBounds, String)>)>, ApiError> {
  let (Some(value_start), Some(value_end)) = (
    formula.value_range_start,
    formula.value_range_end,
  ) else {
    return Ok(None);
  };
  if formula.conditions.is_empty() {
    return Ok(None);
  }

  let value_bounds = normalized_range_bounds(value_start, value_end);
  let mut conditions = Vec::new();
  for condition in &formula.conditions {
    let condition_bounds = normalized_range_bounds(
      condition.range_start,
      condition.range_end,
    );
    if condition_bounds.height != value_bounds.height
      || condition_bounds.width != value_bounds.width
    {
      return Ok(None);
    }
    conditions.push((
      condition_bounds,
      resolve_scalar_operand(connection, sheet, &condition.criteria)?,
    ));
  }

  Ok(Some((value_bounds, conditions)))
}

fn evaluate_multi_criteria_match(
  connection: &Connection,
  sheet: &str,
  conditions: &[(RangeBounds, String)],
  row_offset: u32,
  col_offset: u32,
) -> Result<bool, ApiError> {
  for (bounds, criteria) in conditions {
    let candidate = load_cell_scalar(
      connection,
      sheet,
      bounds.start_row + row_offset,
      bounds.start_col + col_offset,
    )?;
    if !countif_matches_criteria(&candidate, criteria) {
      return Ok(false);
    }
  }
  Ok(true)
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

  if let Some(logical_result) = evaluate_inline_logical_condition(connection, sheet, condition)?
  {
    return Ok(logical_result);
  }

  Ok(resolve_truthy_operand(
    &resolve_scalar_operand(connection, sheet, condition)?,
  ))
}

fn evaluate_inline_logical_condition(
  connection: &Connection,
  sheet: &str,
  condition: &str,
) -> Result<Option<bool>, ApiError> {
  let normalized = format!("={}", condition.trim());
  if let Some(and_args) = parse_and_formula(&normalized) {
    let values = and_args
      .iter()
      .map(|arg| evaluate_if_condition(connection, sheet, arg))
      .collect::<Result<Vec<bool>, ApiError>>()?;
    return Ok(Some(values.into_iter().all(|value| value)));
  }

  if let Some(or_args) = parse_or_formula(&normalized) {
    let values = or_args
      .iter()
      .map(|arg| evaluate_if_condition(connection, sheet, arg))
      .collect::<Result<Vec<bool>, ApiError>>()?;
    return Ok(Some(values.into_iter().any(|value| value)));
  }

  if let Some(not_arg) = parse_not_formula(&normalized) {
    let value = evaluate_if_condition(connection, sheet, &not_arg)?;
    return Ok(Some(!value));
  }

  Ok(None)
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

fn countif_matches_criteria(candidate: &str, criteria: &str) -> bool {
  const OPERATORS: [&str; 6] = ["<>", ">=", "<=", "=", ">", "<"];
  for operator in OPERATORS {
    if let Some(target) = criteria.strip_prefix(operator) {
      let target_trimmed = target.trim();
      if let Some((candidate_number, target_number)) = candidate
        .trim()
        .parse::<f64>()
        .ok()
        .zip(target_trimmed.parse::<f64>().ok())
      {
        return compare_numbers(candidate_number, target_number, operator);
      }
      return compare_strings(
        &candidate.trim().to_lowercase(),
        &target_trimmed.to_lowercase(),
        operator,
      );
    }
  }

  if let Some((candidate_number, target_number)) = candidate
    .trim()
    .parse::<f64>()
    .ok()
    .zip(criteria.trim().parse::<f64>().ok())
  {
    return compare_numbers(candidate_number, target_number, "=");
  }

  candidate.trim().eq_ignore_ascii_case(criteria.trim())
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
    return load_cell_scalar(connection, sheet, row_index, col_index);
  }

  Ok(trimmed.to_string())
}

fn load_cell_scalar(
  connection: &Connection,
  sheet: &str,
  row_index: u32,
  col_index: u32,
) -> Result<String, ApiError> {
  connection
    .query_row(
      r#"
      SELECT COALESCE((
        SELECT COALESCE(evaluated_value, raw_value)
        FROM cells
        WHERE sheet = ?1 AND row_index = ?2 AND col_index = ?3
      ), '')
      "#,
      params![sheet, i64::from(row_index), i64::from(col_index)],
      |row| row.get::<_, String>(0),
    )
    .map_err(ApiError::internal)
}

fn matches_lookup_value(
  candidate: &str,
  lookup_value: &str,
  lookup_numeric: Option<f64>,
) -> bool {
  if let Some(target_numeric) = lookup_numeric {
    return candidate
      .parse::<f64>()
      .map(|candidate_numeric| (candidate_numeric - target_numeric).abs() < f64::EPSILON)
      .unwrap_or(false);
  }
  candidate.trim().eq_ignore_ascii_case(lookup_value.trim())
}

fn parse_optional_char_count(
  connection: &Connection,
  sheet: &str,
  maybe_operand: Option<String>,
) -> Result<usize, ApiError> {
  match maybe_operand {
    Some(operand) => {
      let value = resolve_scalar_operand(connection, sheet, &operand)?;
      let parsed = value.trim().parse::<usize>().unwrap_or(0);
      Ok(parsed)
    }
    None => Ok(1),
  }
}

fn parse_required_integer(
  connection: &Connection,
  sheet: &str,
  operand: &str,
) -> Result<i32, ApiError> {
  let resolved = resolve_scalar_operand(connection, sheet, operand)?;
  let value = resolved
    .trim()
    .parse::<f64>()
    .map(|number| number as i32)
    .unwrap_or_default();
  Ok(value)
}

fn parse_required_unsigned(
  connection: &Connection,
  sheet: &str,
  operand: &str,
) -> Result<u32, ApiError> {
  let resolved = resolve_scalar_operand(connection, sheet, operand)?;
  let value = resolved
    .trim()
    .parse::<f64>()
    .map(|number| number.max(0.0) as u32)
    .unwrap_or_default();
  Ok(value)
}

fn parse_date_operand(
  connection: &Connection,
  sheet: &str,
  operand: &str,
) -> Result<Option<NaiveDate>, ApiError> {
  let resolved = resolve_scalar_operand(connection, sheet, operand)?;
  let trimmed = resolved.trim();
  if trimmed.is_empty() {
    return Ok(None);
  }

  let iso_parsed = NaiveDate::parse_from_str(trimmed, "%Y-%m-%d").ok();
  if iso_parsed.is_some() {
    return Ok(iso_parsed);
  }

  Ok(NaiveDate::parse_from_str(trimmed, "%m/%d/%Y").ok())
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
    let candidate = load_cell_scalar(connection, sheet, row_index, start_col)?;
    let is_match = matches_lookup_value(&candidate, &lookup_value, lookup_numeric);

    if !is_match {
      continue;
    }

    let resolved = load_cell_scalar(connection, sheet, row_index, target_col)?;
    return Ok(Some(resolved));
  }

  Ok(Some(String::new()))
}

fn evaluate_xlookup_formula(
  connection: &Connection,
  sheet: &str,
  formula: &XLookupFormula,
) -> Result<Option<String>, ApiError> {
  let match_mode = parse_lookup_mode_operand(
    connection,
    sheet,
    formula.match_mode.as_deref(),
    0,
  )?;
  if match_mode != 0 {
    return Ok(None);
  }
  let search_mode = parse_lookup_mode_operand(
    connection,
    sheet,
    formula.search_mode.as_deref(),
    1,
  )?;
  if search_mode != 1 && search_mode != -1 {
    return Ok(None);
  }

  let lookup_start_row = formula.lookup_array_start.0.min(formula.lookup_array_end.0);
  let lookup_end_row = formula.lookup_array_start.0.max(formula.lookup_array_end.0);
  let lookup_start_col = formula.lookup_array_start.1.min(formula.lookup_array_end.1);
  let lookup_end_col = formula.lookup_array_start.1.max(formula.lookup_array_end.1);
  let return_start_row = formula.return_array_start.0.min(formula.return_array_end.0);
  let return_end_row = formula.return_array_start.0.max(formula.return_array_end.0);
  let return_start_col = formula.return_array_start.1.min(formula.return_array_end.1);
  let return_end_col = formula.return_array_start.1.max(formula.return_array_end.1);

  let lookup_height = lookup_end_row.saturating_sub(lookup_start_row) + 1;
  let lookup_width = lookup_end_col.saturating_sub(lookup_start_col) + 1;
  let return_height = return_end_row.saturating_sub(return_start_row) + 1;
  let return_width = return_end_col.saturating_sub(return_start_col) + 1;

  let is_vertical_lookup = lookup_width == 1;
  let is_horizontal_lookup = lookup_height == 1;
  if !is_vertical_lookup && !is_horizontal_lookup {
    return Ok(None);
  }

  let is_vertical_return = return_width == 1;
  let is_horizontal_return = return_height == 1;
  if !is_vertical_return && !is_horizontal_return {
    return Ok(None);
  }

  if is_vertical_lookup && (!is_vertical_return || lookup_height != return_height) {
    return Ok(None);
  }
  if is_horizontal_lookup && (!is_horizontal_return || lookup_width != return_width) {
    return Ok(None);
  }

  let lookup_value = resolve_scalar_operand(connection, sheet, &formula.lookup_value)?;
  let lookup_numeric = lookup_value.parse::<f64>().ok();

  if is_vertical_lookup {
    let mut offsets: Vec<u32> = (0..lookup_height).collect();
    if search_mode == -1 {
      offsets.reverse();
    }
    for offset in offsets {
      let lookup_row = lookup_start_row + offset;
      let candidate =
        load_cell_scalar(connection, sheet, lookup_row, lookup_start_col)?;
      if !matches_lookup_value(&candidate, &lookup_value, lookup_numeric) {
        continue;
      }
      let return_row = return_start_row + offset;
      let resolved =
        load_cell_scalar(connection, sheet, return_row, return_start_col)?;
      return Ok(Some(resolved));
    }
  } else {
    let mut offsets: Vec<u32> = (0..lookup_width).collect();
    if search_mode == -1 {
      offsets.reverse();
    }
    for offset in offsets {
      let lookup_col = lookup_start_col + offset;
      let candidate =
        load_cell_scalar(connection, sheet, lookup_start_row, lookup_col)?;
      if !matches_lookup_value(&candidate, &lookup_value, lookup_numeric) {
        continue;
      }
      let return_col = return_start_col + offset;
      let resolved =
        load_cell_scalar(connection, sheet, return_start_row, return_col)?;
      return Ok(Some(resolved));
    }
  }

  if let Some(if_not_found) = formula.if_not_found.as_deref() {
    return resolve_scalar_operand(connection, sheet, if_not_found).map(Some);
  }

  Ok(Some(String::new()))
}

fn evaluate_match_formula(
  connection: &Connection,
  sheet: &str,
  formula: &MatchFormula,
) -> Result<Option<String>, ApiError> {
  let match_type = parse_lookup_mode_operand(
    connection,
    sheet,
    formula.match_type.as_deref(),
    0,
  )?;
  if match_type != 0 {
    return Ok(None);
  }

  let array_bounds = normalized_range_bounds(formula.array_start, formula.array_end);
  if array_bounds.width != 1 && array_bounds.height != 1 {
    return Ok(None);
  }

  let lookup_value = resolve_scalar_operand(connection, sheet, &formula.lookup_value)?;
  let lookup_numeric = lookup_value.parse::<f64>().ok();

  if array_bounds.width == 1 {
    for offset in 0..array_bounds.height {
      let candidate = load_cell_scalar(
        connection,
        sheet,
        array_bounds.start_row + offset,
        array_bounds.start_col,
      )?;
      if matches_lookup_value(&candidate, &lookup_value, lookup_numeric) {
        return Ok(Some((offset + 1).to_string()));
      }
    }
  } else {
    for offset in 0..array_bounds.width {
      let candidate = load_cell_scalar(
        connection,
        sheet,
        array_bounds.start_row,
        array_bounds.start_col + offset,
      )?;
      if matches_lookup_value(&candidate, &lookup_value, lookup_numeric) {
        return Ok(Some((offset + 1).to_string()));
      }
    }
  }

  Ok(Some("0".to_string()))
}

fn evaluate_index_formula(
  connection: &Connection,
  sheet: &str,
  formula: &IndexFormula,
) -> Result<Option<String>, ApiError> {
  let array_bounds = normalized_range_bounds(formula.array_start, formula.array_end);
  let row_num = parse_required_unsigned(connection, sheet, &formula.row_num)?;
  if row_num == 0 {
    return Ok(Some(String::new()));
  }
  let col_num = match formula.col_num.as_deref() {
    Some(value) => parse_required_unsigned(connection, sheet, value)?,
    None => 1,
  };
  if col_num == 0 {
    return Ok(Some(String::new()));
  }

  if row_num > array_bounds.height || col_num > array_bounds.width {
    return Ok(Some(String::new()));
  }

  let target_row = array_bounds.start_row + row_num - 1;
  let target_col = array_bounds.start_col + col_num - 1;
  let resolved = load_cell_scalar(connection, sheet, target_row, target_col)?;
  Ok(Some(resolved))
}

fn parse_lookup_mode_operand(
  connection: &Connection,
  sheet: &str,
  mode_operand: Option<&str>,
  default_value: i32,
) -> Result<i32, ApiError> {
  let Some(raw_operand) = mode_operand else {
    return Ok(default_value);
  };
  let resolved = resolve_scalar_operand(connection, sheet, raw_operand)?;
  resolved
    .trim()
    .parse::<i32>()
    .map_err(|_| ApiError::internal("lookup mode must be an integer"))
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
      CellMutation {
        row: 1,
        col: 9,
        value: None,
        formula: Some(r#"=LEN("spreadsheet")"#.to_string()),
      },
      CellMutation {
        row: 1,
        col: 10,
        value: None,
        formula: Some(r#"=LEFT("spreadsheet",6)"#.to_string()),
      },
      CellMutation {
        row: 1,
        col: 11,
        value: None,
        formula: Some(r#"=RIGHT("spreadsheet",5)"#.to_string()),
      },
      CellMutation {
        row: 1,
        col: 12,
        value: None,
        formula: Some("=DATE(2026,2,13)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 13,
        value: None,
        formula: Some("=YEAR(L1)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 14,
        value: None,
        formula: Some("=MONTH(L1)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 15,
        value: None,
        formula: Some("=DAY(L1)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 16,
        value: None,
        formula: Some("=AND(A1>=100,A2<100)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 17,
        value: None,
        formula: Some("=OR(A1<100,A2<100)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 18,
        value: None,
        formula: Some("=NOT(A2>=100)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 19,
        value: None,
        formula: Some(r#"=IF(AND(A1>=100,A2<100),"eligible","ineligible")"#.to_string()),
      },
      CellMutation {
        row: 1,
        col: 20,
        value: None,
        formula: Some(r#"=XLOOKUP("north",E1:E2,F1:F2,"missing",0,1)"#.to_string()),
      },
      CellMutation {
        row: 1,
        col: 21,
        value: None,
        formula: Some(r#"=XLOOKUP("missing",E1:E2,F1:F2,"fallback",0,1)"#.to_string()),
      },
      CellMutation {
        row: 1,
        col: 22,
        value: None,
        formula: Some(r#"=XLOOKUP("south",E1:E2,F1:F2,"missing",0,-1)"#.to_string()),
      },
      CellMutation {
        row: 1,
        col: 23,
        value: None,
        formula: Some(r#"=COUNTIF(A1:A2,">=100")"#.to_string()),
      },
      CellMutation {
        row: 1,
        col: 24,
        value: None,
        formula: Some(r#"=COUNTIF(E1:E2,"south")"#.to_string()),
      },
      CellMutation {
        row: 1,
        col: 25,
        value: None,
        formula: Some(r#"=COUNTIF(E1:E2,"<>south")"#.to_string()),
      },
      CellMutation {
        row: 1,
        col: 26,
        value: None,
        formula: Some(r#"=SUMIF(A1:A2,">=100",A1:A2)"#.to_string()),
      },
      CellMutation {
        row: 1,
        col: 27,
        value: None,
        formula: Some(r#"=AVERAGEIF(A1:A2,">=80",A1:A2)"#.to_string()),
      },
      CellMutation {
        row: 1,
        col: 28,
        value: None,
        formula: Some(r#"=AVERAGEIF(E1:E2,"south",A1:A2)"#.to_string()),
      },
      CellMutation {
        row: 1,
        col: 29,
        value: None,
        formula: Some(r#"=COUNTIFS(A1:A2,">=80",E1:E2,"south")"#.to_string()),
      },
      CellMutation {
        row: 1,
        col: 30,
        value: None,
        formula: Some(r#"=SUMIFS(A1:A2,E1:E2,"south",A1:A2,">=80")"#.to_string()),
      },
      CellMutation {
        row: 1,
        col: 31,
        value: None,
        formula: Some(r#"=AVERAGEIFS(A1:A2,E1:E2,"south",A1:A2,">=80")"#.to_string()),
      },
      CellMutation {
        row: 1,
        col: 32,
        value: None,
        formula: Some(r#"=UPPER("mixed Case")"#.to_string()),
      },
      CellMutation {
        row: 1,
        col: 33,
        value: None,
        formula: Some(r#"=LOWER("MIXED Case")"#.to_string()),
      },
      CellMutation {
        row: 1,
        col: 34,
        value: None,
        formula: Some(r#"=TRIM("  north   region  ")"#.to_string()),
      },
      CellMutation {
        row: 1,
        col: 35,
        value: None,
        formula: Some(r#"=MATCH("south",E1:E2,0)"#.to_string()),
      },
      CellMutation {
        row: 1,
        col: 36,
        value: None,
        formula: Some(r#"=MATCH("Northeast",F1:F2,0)"#.to_string()),
      },
      CellMutation {
        row: 1,
        col: 37,
        value: None,
        formula: Some("=INDEX(E1:F2,2,2)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 38,
        value: None,
        formula: Some("=INDEX(A1:A2,1)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 39,
        value: None,
        formula: Some("=INDEX(E1:F2,3,1)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 40,
        value: None,
        formula: Some("=ISBLANK(Z99)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 41,
        value: None,
        formula: Some("=ISNUMBER(A1)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 42,
        value: None,
        formula: Some("=ISTEXT(E1)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 43,
        value: None,
        formula: Some(r#"=IFERROR(VLOOKUP("south",E1:F2,2,TRUE),"fallback")"#.to_string()),
      },
      CellMutation {
        row: 1,
        col: 44,
        value: None,
        formula: Some(r#"=IFERROR(MATCH("south",E1:E2,1),"fallback")"#.to_string()),
      },
      CellMutation {
        row: 1,
        col: 45,
        value: None,
        formula: Some("=IFERROR(A1,0)".to_string()),
      },
    ];
    set_cells(&db_path, "Sheet1", &cells).expect("cells should upsert");

    let (updated_cells, unsupported_formulas) =
      recalculate_formulas(&db_path).expect("recalculation should work");
    assert_eq!(updated_cells, 43);
    assert!(
      unsupported_formulas.is_empty(),
      "unexpected unsupported formulas: {:?}",
      unsupported_formulas,
    );

    let snapshots = get_cells(
      &db_path,
      "Sheet1",
      &CellRange {
        start_row: 1,
        end_row: 2,
        start_col: 1,
        end_col: 45,
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
    assert_eq!(by_position(1, 9).evaluated_value.as_deref(), Some("11"));
    assert_eq!(by_position(1, 10).evaluated_value.as_deref(), Some("spread"));
    assert_eq!(by_position(1, 11).evaluated_value.as_deref(), Some("sheet"));
    assert_eq!(by_position(1, 12).evaluated_value.as_deref(), Some("2026-02-13"));
    assert_eq!(by_position(1, 13).evaluated_value.as_deref(), Some("2026"));
    assert_eq!(by_position(1, 14).evaluated_value.as_deref(), Some("2"));
    assert_eq!(by_position(1, 15).evaluated_value.as_deref(), Some("13"));
    assert_eq!(by_position(1, 16).evaluated_value.as_deref(), Some("true"));
    assert_eq!(by_position(1, 17).evaluated_value.as_deref(), Some("true"));
    assert_eq!(by_position(1, 18).evaluated_value.as_deref(), Some("true"));
    assert_eq!(by_position(1, 19).evaluated_value.as_deref(), Some("eligible"));
    assert_eq!(by_position(1, 20).evaluated_value.as_deref(), Some("Northeast"));
    assert_eq!(by_position(1, 21).evaluated_value.as_deref(), Some("fallback"));
    assert_eq!(by_position(1, 22).evaluated_value.as_deref(), Some("Southeast"));
    assert_eq!(by_position(1, 23).evaluated_value.as_deref(), Some("1"));
    assert_eq!(by_position(1, 24).evaluated_value.as_deref(), Some("1"));
    assert_eq!(by_position(1, 25).evaluated_value.as_deref(), Some("1"));
    assert_eq!(by_position(1, 26).evaluated_value.as_deref(), Some("120"));
    assert_eq!(by_position(1, 27).evaluated_value.as_deref(), Some("100"));
    assert_eq!(by_position(1, 28).evaluated_value.as_deref(), Some("80"));
    assert_eq!(by_position(1, 29).evaluated_value.as_deref(), Some("1"));
    assert_eq!(by_position(1, 30).evaluated_value.as_deref(), Some("80"));
    assert_eq!(by_position(1, 31).evaluated_value.as_deref(), Some("80"));
    assert_eq!(by_position(1, 32).evaluated_value.as_deref(), Some("MIXED CASE"));
    assert_eq!(by_position(1, 33).evaluated_value.as_deref(), Some("mixed case"));
    assert_eq!(by_position(1, 34).evaluated_value.as_deref(), Some("north region"));
    assert_eq!(by_position(1, 35).evaluated_value.as_deref(), Some("2"));
    assert_eq!(by_position(1, 36).evaluated_value.as_deref(), Some("1"));
    assert_eq!(by_position(1, 37).evaluated_value.as_deref(), Some("Southeast"));
    assert_eq!(by_position(1, 38).evaluated_value.as_deref(), Some("120"));
    assert_eq!(by_position(1, 39).evaluated_value.as_deref(), Some(""));
    assert_eq!(by_position(1, 40).evaluated_value.as_deref(), Some("true"));
    assert_eq!(by_position(1, 41).evaluated_value.as_deref(), Some("true"));
    assert_eq!(by_position(1, 42).evaluated_value.as_deref(), Some("true"));
    assert_eq!(by_position(1, 43).evaluated_value.as_deref(), Some("fallback"));
    assert_eq!(by_position(1, 44).evaluated_value.as_deref(), Some("fallback"));
    assert_eq!(by_position(1, 45).evaluated_value.as_deref(), Some("120"));
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

  #[test]
  fn should_leave_non_exact_xlookup_modes_as_unsupported() {
    let (_temp_dir, db_path) = create_initialized_db_path();
    let cells = vec![
      CellMutation {
        row: 1,
        col: 1,
        value: Some(json!("north")),
        formula: None,
      },
      CellMutation {
        row: 1,
        col: 2,
        value: Some(json!("Northeast")),
        formula: None,
      },
      CellMutation {
        row: 2,
        col: 3,
        value: None,
        formula: Some(r#"=XLOOKUP("north",A1:A1,B1:B1,"missing",1,1)"#.to_string()),
      },
    ];
    set_cells(&db_path, "Sheet1", &cells).expect("cells should upsert");

    let (_updated_cells, unsupported_formulas) =
      recalculate_formulas(&db_path).expect("recalculation should work");
    assert_eq!(
      unsupported_formulas,
      vec![r#"=XLOOKUP("north",A1:A1,B1:B1,"missing",1,1)"#.to_string()]
    );
  }

  #[test]
  fn should_leave_non_exact_match_modes_as_unsupported() {
    let (_temp_dir, db_path) = create_initialized_db_path();
    let cells = vec![
      CellMutation {
        row: 1,
        col: 1,
        value: Some(json!("north")),
        formula: None,
      },
      CellMutation {
        row: 2,
        col: 1,
        value: Some(json!("south")),
        formula: None,
      },
      CellMutation {
        row: 1,
        col: 2,
        value: None,
        formula: Some(r#"=MATCH("south",A1:A2,1)"#.to_string()),
      },
    ];
    set_cells(&db_path, "Sheet1", &cells).expect("cells should upsert");

    let (_updated_cells, unsupported_formulas) =
      recalculate_formulas(&db_path).expect("recalculation should work");
    assert_eq!(
      unsupported_formulas,
      vec![r#"=MATCH("south",A1:A2,1)"#.to_string()]
    );
  }

  #[test]
  fn should_leave_mismatched_sumif_ranges_as_unsupported() {
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
        value: Some(json!(10)),
        formula: None,
      },
      CellMutation {
        row: 2,
        col: 2,
        value: Some(json!(20)),
        formula: None,
      },
      CellMutation {
        row: 3,
        col: 2,
        value: Some(json!(30)),
        formula: None,
      },
      CellMutation {
        row: 4,
        col: 1,
        value: None,
        formula: Some(r#"=SUMIF(A1:A2,">=100",B1:B3)"#.to_string()),
      },
    ];
    set_cells(&db_path, "Sheet1", &cells).expect("cells should upsert");

    let (_updated_cells, unsupported_formulas) =
      recalculate_formulas(&db_path).expect("recalculation should work");
    assert_eq!(
      unsupported_formulas,
      vec![r#"=SUMIF(A1:A2,">=100",B1:B3)"#.to_string()]
    );
  }

  #[test]
  fn should_leave_mismatched_countifs_ranges_as_unsupported() {
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
        value: Some(json!("north")),
        formula: None,
      },
      CellMutation {
        row: 2,
        col: 2,
        value: Some(json!("south")),
        formula: None,
      },
      CellMutation {
        row: 3,
        col: 2,
        value: Some(json!("south")),
        formula: None,
      },
      CellMutation {
        row: 4,
        col: 1,
        value: None,
        formula: Some(r#"=COUNTIFS(A1:A2,">=80",B1:B3,"south")"#.to_string()),
      },
    ];
    set_cells(&db_path, "Sheet1", &cells).expect("cells should upsert");

    let (_updated_cells, unsupported_formulas) =
      recalculate_formulas(&db_path).expect("recalculation should work");
    assert_eq!(
      unsupported_formulas,
      vec![r#"=COUNTIFS(A1:A2,">=80",B1:B3,"south")"#.to_string()]
    );
  }

  #[test]
  fn should_leave_mismatched_sumifs_ranges_as_unsupported() {
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
        value: Some(json!("north")),
        formula: None,
      },
      CellMutation {
        row: 2,
        col: 2,
        value: Some(json!("south")),
        formula: None,
      },
      CellMutation {
        row: 4,
        col: 1,
        value: None,
        formula: Some(r#"=SUMIFS(A1:A2,B1:B2,"south",A1:A3,">=80")"#.to_string()),
      },
    ];
    set_cells(&db_path, "Sheet1", &cells).expect("cells should upsert");

    let (_updated_cells, unsupported_formulas) =
      recalculate_formulas(&db_path).expect("recalculation should work");
    assert_eq!(
      unsupported_formulas,
      vec![r#"=SUMIFS(A1:A2,B1:B2,"south",A1:A3,">=80")"#.to_string()]
    );
  }
}

