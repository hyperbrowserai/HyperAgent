use crate::{
  error::ApiError,
  formula::{
    address_from_row_col, parse_aggregate_formula, parse_and_formula,
    parse_averageif_formula, parse_averageifs_formula, parse_cell_address,
    parse_concat_formula, parse_textjoin_formula, parse_countif_formula, parse_countifs_formula,
    parse_counta_formula, parse_countblank_formula, parse_sumproduct_formula,
    parse_row_formula, parse_column_formula, parse_rows_formula,
    parse_columns_formula,
    parse_large_formula, parse_small_formula, parse_rank_formula,
    parse_percentile_inc_formula, parse_quartile_inc_formula,
    parse_percentile_exc_formula, parse_quartile_exc_formula,
    parse_mode_sngl_formula, parse_geomean_formula, parse_harmean_formula,
    parse_trimmean_formula, parse_devsq_formula, parse_avedev_formula,
    parse_averagea_formula, parse_stdeva_formula, parse_stdevpa_formula,
    parse_vara_formula, parse_varpa_formula,
    parse_covariance_formula, parse_correl_formula,
    parse_slope_formula, parse_intercept_formula, parse_rsq_formula,
    parse_forecast_linear_formula, parse_steyx_formula,
    parse_sumx_formula, parse_skew_formula, parse_skew_p_formula, parse_kurt_formula,
    parse_fisher_formula, parse_fisherinv_formula,
    parse_percentrank_inc_formula, parse_percentrank_exc_formula,
    parse_date_formula, parse_edate_formula, parse_eomonth_formula,
    parse_days_formula, parse_days360_formula, parse_datevalue_formula, parse_timevalue_formula,
    parse_time_formula, parse_datedif_formula, parse_networkdays_formula,
    parse_workday_formula, parse_networkdays_intl_formula, parse_workday_intl_formula,
    parse_day_formula,
    parse_if_formula, parse_ifs_formula, parse_iferror_formula,
    parse_abs_formula, parse_exp_formula, parse_ln_formula, parse_log10_formula,
    parse_log_formula, parse_fact_formula, parse_factdouble_formula,
    parse_combin_formula, parse_combina_formula, parse_gcd_formula, parse_lcm_formula,
    parse_pi_formula,
    parse_permut_formula, parse_permutationa_formula, parse_multinomial_formula,
    parse_sin_formula, parse_cos_formula, parse_tan_formula,
    parse_cot_formula, parse_sec_formula, parse_csc_formula,
    parse_sinh_formula,
    parse_cosh_formula, parse_tanh_formula,
    parse_coth_formula, parse_sech_formula, parse_csch_formula,
    parse_asinh_formula, parse_acosh_formula, parse_atanh_formula,
    parse_acot_formula, parse_asec_formula, parse_acsc_formula,
    parse_acoth_formula, parse_asech_formula, parse_acsch_formula,
    parse_asin_formula, parse_acos_formula,
    parse_atan_formula, parse_atan2_formula,
    parse_degrees_formula, parse_radians_formula,
    parse_choose_formula, parse_switch_formula, parse_left_formula,
    parse_ceiling_formula, parse_ceiling_math_formula, parse_exact_formula,
    parse_floor_formula, parse_floor_math_formula,
    parse_index_formula,
    parse_int_formula, parse_isblank_formula, parse_iseven_formula,
    parse_isnumber_formula, parse_isodd_formula,
    parse_istext_formula,
    parse_len_formula, parse_lower_formula, parse_hlookup_formula,
    parse_match_formula, parse_maxifs_formula, parse_minifs_formula,
    parse_mid_formula, parse_mod_formula, parse_month_formula,
    parse_not_formula,
    parse_power_formula,
    parse_quotient_formula, parse_mround_formula,
    parse_or_formula, parse_rept_formula, parse_right_formula,
    parse_replace_formula, parse_search_formula, parse_substitute_formula,
    parse_find_formula,
    parse_value_formula, parse_n_formula, parse_t_formula, parse_char_formula,
    parse_code_formula, parse_unichar_formula, parse_unicode_formula,
    parse_roman_formula, parse_arabic_formula,
    parse_even_formula, parse_odd_formula,
    parse_single_ref_formula,
    parse_xor_formula,
    parse_sign_formula,
    parse_round_formula, parse_rounddown_formula, parse_roundup_formula,
    parse_trunc_formula,
    parse_sqrt_formula, parse_hour_formula, parse_minute_formula,
    parse_second_formula,
    parse_trim_formula, parse_proper_formula, parse_clean_formula,
    parse_sumif_formula, parse_sumifs_formula,
    parse_today_formula, parse_now_formula, parse_rand_formula,
    parse_randbetween_formula, parse_true_formula,
    parse_false_formula, parse_upper_formula,
    parse_vlookup_formula,
    parse_xlookup_formula, parse_year_formula, parse_weekday_formula,
    parse_weeknum_formula, parse_isoweeknum_formula, ConditionalAggregateFormula,
    HLookupFormula, IndexFormula, MatchFormula, MultiCriteriaAggregateFormula,
    VLookupFormula, XLookupFormula,
  },
  models::{CellMutation, CellRange, CellSnapshot},
};
use chrono::{
  DateTime, Datelike, Duration, NaiveDate, NaiveDateTime, NaiveTime, Timelike, Utc,
};
use duckdb::{params, Connection};
use regex::Regex;
use serde_json::Value;
use std::collections::HashSet;
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
    if function == "PRODUCT" {
      let bounds = normalized_range_bounds(start, end);
      let mut product = 1f64;
      let mut has_numeric = false;
      for row_offset in 0..bounds.height {
        for col_offset in 0..bounds.width {
          let row_index = bounds.start_row + row_offset;
          let col_index = bounds.start_col + col_offset;
          let value = load_cell_scalar(connection, sheet, row_index, col_index)?;
          if let Ok(parsed) = value.trim().parse::<f64>() {
            product *= parsed;
            has_numeric = true;
          }
        }
      }
      return Ok(Some(if has_numeric {
        product.to_string()
      } else {
        "0".to_string()
      }));
    }

    let aggregate_sql = match function.as_str() {
      "SUM" => "SUM",
      "AVERAGE" => "AVG",
      "MIN" => "MIN",
      "MAX" => "MAX",
      "COUNT" => "COUNT",
      "MEDIAN" => "MEDIAN",
      "STDEV" => "STDDEV_SAMP",
      "STDEVP" => "STDDEV_POP",
      "STDEV.P" => "STDDEV_POP",
      "STDEV.S" => "STDDEV_SAMP",
      "VAR" => "VAR_SAMP",
      "VARP" => "VAR_POP",
      "VAR.P" => "VAR_POP",
      "VAR.S" => "VAR_SAMP",
      "SUMSQ" => "SUM",
      _ => return Ok(None),
    };
    let value_expr = if function == "COUNT" {
      format!(
        "{}(TRY_CAST(COALESCE(evaluated_value, raw_value) AS DOUBLE))",
        aggregate_sql
      )
    } else if function == "SUMSQ" {
      format!(
        "{}(POW(COALESCE(TRY_CAST(evaluated_value AS DOUBLE), TRY_CAST(raw_value AS DOUBLE), 0), 2))",
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

  if let Some((start, end)) = parse_counta_formula(formula) {
    let bounds = normalized_range_bounds(start, end);
    let mut count = 0u64;
    for row_offset in 0..bounds.height {
      for col_offset in 0..bounds.width {
        let row_index = bounds.start_row + row_offset;
        let col_index = bounds.start_col + col_offset;
        let value = load_cell_scalar(connection, sheet, row_index, col_index)?;
        if !value.is_empty() {
          count += 1;
        }
      }
    }
    return Ok(Some(count.to_string()));
  }

  if let Some((start, end)) = parse_countblank_formula(formula) {
    let bounds = normalized_range_bounds(start, end);
    let mut count = 0u64;
    for row_offset in 0..bounds.height {
      for col_offset in 0..bounds.width {
        let row_index = bounds.start_row + row_offset;
        let col_index = bounds.start_col + col_offset;
        let value = load_cell_scalar(connection, sheet, row_index, col_index)?;
        if value.is_empty() {
          count += 1;
        }
      }
    }
    return Ok(Some(count.to_string()));
  }

  if let Some(row_arg) = parse_row_formula(formula) {
    let cleaned = row_arg.trim().replace('$', "");
    if let Some((row_index, _col_index)) = parse_cell_address(&cleaned) {
      return Ok(Some(row_index.to_string()));
    }
    if let Some((start, _end)) = cleaned.split_once(':') {
      if let Some((row_index, _col_index)) = parse_cell_address(start.trim()) {
        return Ok(Some(row_index.to_string()));
      }
    }
    return Ok(None);
  }

  if let Some(column_arg) = parse_column_formula(formula) {
    let cleaned = column_arg.trim().replace('$', "");
    if let Some((_row_index, col_index)) = parse_cell_address(&cleaned) {
      return Ok(Some(col_index.to_string()));
    }
    if let Some((start, _end)) = cleaned.split_once(':') {
      if let Some((_row_index, col_index)) = parse_cell_address(start.trim()) {
        return Ok(Some(col_index.to_string()));
      }
    }
    return Ok(None);
  }

  if let Some(rows_arg) = parse_rows_formula(formula) {
    let cleaned = rows_arg.trim().replace('$', "");
    if let Some((row_index, _col_index)) = parse_cell_address(&cleaned) {
      let _ = row_index;
      return Ok(Some("1".to_string()));
    }
    if let Some((start, end)) = cleaned.split_once(':') {
      let Some(start_ref) = parse_cell_address(start.trim()) else {
        return Ok(None);
      };
      let Some(end_ref) = parse_cell_address(end.trim()) else {
        return Ok(None);
      };
      let bounds = normalized_range_bounds(start_ref, end_ref);
      return Ok(Some(bounds.height.to_string()));
    }
    return Ok(None);
  }

  if let Some(columns_arg) = parse_columns_formula(formula) {
    let cleaned = columns_arg.trim().replace('$', "");
    if let Some((_row_index, col_index)) = parse_cell_address(&cleaned) {
      let _ = col_index;
      return Ok(Some("1".to_string()));
    }
    if let Some((start, end)) = cleaned.split_once(':') {
      let Some(start_ref) = parse_cell_address(start.trim()) else {
        return Ok(None);
      };
      let Some(end_ref) = parse_cell_address(end.trim()) else {
        return Ok(None);
      };
      let bounds = normalized_range_bounds(start_ref, end_ref);
      return Ok(Some(bounds.width.to_string()));
    }
    return Ok(None);
  }

  if let Some(ranges) = parse_sumproduct_formula(formula) {
    let mut normalized_ranges = Vec::new();
    for range in ranges {
      normalized_ranges.push(normalized_range_bounds(range.0, range.1));
    }
    let Some(first_bounds) = normalized_ranges.first().copied() else {
      return Ok(None);
    };
    if normalized_ranges.iter().any(|bounds| {
      bounds.height != first_bounds.height || bounds.width != first_bounds.width
    }) {
      return Ok(None);
    }

    let mut total = 0.0f64;
    for row_offset in 0..first_bounds.height {
      for col_offset in 0..first_bounds.width {
        let mut product = 1.0f64;
        for bounds in &normalized_ranges {
          let row_index = bounds.start_row + row_offset;
          let col_index = bounds.start_col + col_offset;
          let value = load_cell_scalar(connection, sheet, row_index, col_index)?
            .trim()
            .parse::<f64>()
            .unwrap_or(0.0);
          product *= value;
        }
        total += product;
      }
    }
    return Ok(Some(total.to_string()));
  }

  if let Some((start, end, k_arg)) = parse_large_formula(formula) {
    let bounds = normalized_range_bounds(start, end);
    let k = parse_required_unsigned(connection, sheet, &k_arg)?;
    if k == 0 {
      return Ok(None);
    }
    let mut values = Vec::new();
    for row_offset in 0..bounds.height {
      for col_offset in 0..bounds.width {
        let row_index = bounds.start_row + row_offset;
        let col_index = bounds.start_col + col_offset;
        let value = load_cell_scalar(connection, sheet, row_index, col_index)?;
        if let Ok(parsed) = value.trim().parse::<f64>() {
          values.push(parsed);
        }
      }
    }
    if values.is_empty() || usize::try_from(k).unwrap_or(usize::MAX) > values.len() {
      return Ok(None);
    }
    values.sort_by(|left, right| right.partial_cmp(left).unwrap_or(std::cmp::Ordering::Equal));
    let index = usize::try_from(k - 1).unwrap_or(0);
    return Ok(Some(values[index].to_string()));
  }

  if let Some((start, end, k_arg)) = parse_small_formula(formula) {
    let bounds = normalized_range_bounds(start, end);
    let k = parse_required_unsigned(connection, sheet, &k_arg)?;
    if k == 0 {
      return Ok(None);
    }
    let mut values = Vec::new();
    for row_offset in 0..bounds.height {
      for col_offset in 0..bounds.width {
        let row_index = bounds.start_row + row_offset;
        let col_index = bounds.start_col + col_offset;
        let value = load_cell_scalar(connection, sheet, row_index, col_index)?;
        if let Ok(parsed) = value.trim().parse::<f64>() {
          values.push(parsed);
        }
      }
    }
    if values.is_empty() || usize::try_from(k).unwrap_or(usize::MAX) > values.len() {
      return Ok(None);
    }
    values.sort_by(|left, right| left.partial_cmp(right).unwrap_or(std::cmp::Ordering::Equal));
    let index = usize::try_from(k - 1).unwrap_or(0);
    return Ok(Some(values[index].to_string()));
  }

  if let Some((number_arg, start, end, order_arg)) = parse_rank_formula(formula) {
    let number = parse_required_float(connection, sheet, &number_arg)?;
    let values = collect_numeric_range_values(connection, sheet, start, end)?;
    if values.is_empty() {
      return Ok(None);
    }
    let order = match order_arg {
      Some(raw_order) => parse_required_integer(connection, sheet, &raw_order)?,
      None => 0,
    };
    let rank = if order == 0 {
      1 + values
        .iter()
        .filter(|candidate| **candidate > number)
        .count()
    } else {
      1 + values
        .iter()
        .filter(|candidate| **candidate < number)
        .count()
    };
    return Ok(Some(rank.to_string()));
  }

  if let Some((start, end, percentile_arg)) = parse_percentile_inc_formula(formula) {
    let percentile = parse_required_float(connection, sheet, &percentile_arg)?;
    if !(0.0..=1.0).contains(&percentile) {
      return Ok(None);
    }
    let mut values = collect_numeric_range_values(connection, sheet, start, end)?;
    if values.is_empty() {
      return Ok(None);
    }
    values.sort_by(|left, right| left.partial_cmp(right).unwrap_or(std::cmp::Ordering::Equal));
    let interpolated = interpolate_percentile_from_sorted_values(&values, percentile);
    return Ok(interpolated.map(|value| value.to_string()));
  }

  if let Some((start, end, quartile_arg)) = parse_quartile_inc_formula(formula) {
    let quartile = parse_required_integer(connection, sheet, &quartile_arg)?;
    let percentile = match quartile {
      0 => 0.0,
      1 => 0.25,
      2 => 0.5,
      3 => 0.75,
      4 => 1.0,
      _ => return Ok(None),
    };
    let mut values = collect_numeric_range_values(connection, sheet, start, end)?;
    if values.is_empty() {
      return Ok(None);
    }
    values.sort_by(|left, right| left.partial_cmp(right).unwrap_or(std::cmp::Ordering::Equal));
    let interpolated = interpolate_percentile_from_sorted_values(&values, percentile);
    return Ok(interpolated.map(|value| value.to_string()));
  }

  if let Some((start, end, percentile_arg)) = parse_percentile_exc_formula(formula) {
    let percentile = parse_required_float(connection, sheet, &percentile_arg)?;
    let mut values = collect_numeric_range_values(connection, sheet, start, end)?;
    if values.len() < 2 {
      return Ok(None);
    }
    values.sort_by(|left, right| left.partial_cmp(right).unwrap_or(std::cmp::Ordering::Equal));
    let interpolated = interpolate_percentile_exc_from_sorted_values(&values, percentile);
    return Ok(interpolated.map(|value| value.to_string()));
  }

  if let Some((start, end, quartile_arg)) = parse_quartile_exc_formula(formula) {
    let quartile = parse_required_integer(connection, sheet, &quartile_arg)?;
    let percentile = match quartile {
      1 => 0.25,
      2 => 0.5,
      3 => 0.75,
      _ => return Ok(None),
    };
    let mut values = collect_numeric_range_values(connection, sheet, start, end)?;
    if values.len() < 2 {
      return Ok(None);
    }
    values.sort_by(|left, right| left.partial_cmp(right).unwrap_or(std::cmp::Ordering::Equal));
    let interpolated = interpolate_percentile_exc_from_sorted_values(&values, percentile);
    return Ok(interpolated.map(|value| value.to_string()));
  }

  if let Some((start, end)) = parse_mode_sngl_formula(formula) {
    let mut values = collect_numeric_range_values(connection, sheet, start, end)?;
    if values.is_empty() {
      return Ok(None);
    }
    values.sort_by(|left, right| left.partial_cmp(right).unwrap_or(std::cmp::Ordering::Equal));

    let mut best_count = 0usize;
    let mut best_value: Option<f64> = None;
    let mut index = 0usize;
    while index < values.len() {
      let current = values[index];
      let mut count = 1usize;
      while index + count < values.len()
        && (values[index + count] - current).abs() < f64::EPSILON
      {
        count += 1;
      }
      if count > best_count {
        best_count = count;
        best_value = Some(current);
      } else if count == best_count && count > 1 {
        if let Some(existing_best) = best_value {
          if current < existing_best {
            best_value = Some(current);
          }
        }
      }
      index += count;
    }

    if best_count < 2 {
      return Ok(None);
    }
    return Ok(best_value.map(|value| value.to_string()));
  }

  if let Some((start, end)) = parse_geomean_formula(formula) {
    let values = collect_numeric_range_values(connection, sheet, start, end)?;
    if values.is_empty() {
      return Ok(None);
    }
    if values.iter().any(|value| *value <= 0.0) {
      return Ok(None);
    }
    let ln_sum = values.iter().map(|value| value.ln()).sum::<f64>();
    let mean = (ln_sum / values.len() as f64).exp();
    return Ok(Some(mean.to_string()));
  }

  if let Some((start, end)) = parse_harmean_formula(formula) {
    let values = collect_numeric_range_values(connection, sheet, start, end)?;
    if values.is_empty() {
      return Ok(None);
    }
    if values.iter().any(|value| *value <= 0.0) {
      return Ok(None);
    }
    let reciprocal_sum = values.iter().map(|value| 1.0 / value).sum::<f64>();
    if reciprocal_sum <= 0.0 {
      return Ok(None);
    }
    let mean = values.len() as f64 / reciprocal_sum;
    return Ok(Some(mean.to_string()));
  }

  if let Some((start, end, trim_percent_arg)) = parse_trimmean_formula(formula) {
    let trim_percent = parse_required_float(connection, sheet, &trim_percent_arg)?;
    if !(0.0..1.0).contains(&trim_percent) {
      return Ok(None);
    }
    let mut values = collect_numeric_range_values(connection, sheet, start, end)?;
    if values.is_empty() {
      return Ok(None);
    }
    values.sort_by(|left, right| left.partial_cmp(right).unwrap_or(std::cmp::Ordering::Equal));

    let mut trim_count = ((values.len() as f64) * trim_percent).floor() as usize;
    if trim_count % 2 != 0 {
      trim_count -= 1;
    }
    if trim_count >= values.len() {
      return Ok(None);
    }

    let trim_each_side = trim_count / 2;
    let start_index = trim_each_side;
    let end_index = values.len().saturating_sub(trim_each_side);
    if start_index >= end_index {
      return Ok(None);
    }
    let trimmed_values = &values[start_index..end_index];
    let mean =
      trimmed_values.iter().sum::<f64>() / trimmed_values.len() as f64;
    return Ok(Some(mean.to_string()));
  }

  if let Some((start, end)) = parse_devsq_formula(formula) {
    let values = collect_numeric_range_values(connection, sheet, start, end)?;
    if values.is_empty() {
      return Ok(None);
    }
    let mean = values.iter().sum::<f64>() / values.len() as f64;
    let total = values
      .iter()
      .map(|value| {
        let delta = *value - mean;
        delta * delta
      })
      .sum::<f64>();
    return Ok(Some(total.to_string()));
  }

  if let Some((start, end)) = parse_avedev_formula(formula) {
    let values = collect_numeric_range_values(connection, sheet, start, end)?;
    if values.is_empty() {
      return Ok(None);
    }
    let mean = values.iter().sum::<f64>() / values.len() as f64;
    let total_absolute_deviation =
      values.iter().map(|value| (*value - mean).abs()).sum::<f64>();
    let avedev = total_absolute_deviation / values.len() as f64;
    return Ok(Some(avedev.to_string()));
  }

  if let Some((start, end)) = parse_averagea_formula(formula) {
    let values = collect_statisticala_range_values(connection, sheet, start, end)?;
    if values.is_empty() {
      return Ok(None);
    }
    let average = values.iter().sum::<f64>() / values.len() as f64;
    return Ok(Some(average.to_string()));
  }

  if let Some((start, end)) = parse_stdeva_formula(formula) {
    let values = collect_statisticala_range_values(connection, sheet, start, end)?;
    if values.len() < 2 {
      return Ok(None);
    }
    let mean = values.iter().sum::<f64>() / values.len() as f64;
    let variance_sample = values
      .iter()
      .map(|value| {
        let delta = *value - mean;
        delta * delta
      })
      .sum::<f64>()
      / (values.len() as f64 - 1.0);
    return Ok(Some(variance_sample.sqrt().to_string()));
  }

  if let Some((start, end)) = parse_stdevpa_formula(formula) {
    let values = collect_statisticala_range_values(connection, sheet, start, end)?;
    if values.is_empty() {
      return Ok(None);
    }
    let mean = values.iter().sum::<f64>() / values.len() as f64;
    let variance_population = values
      .iter()
      .map(|value| {
        let delta = *value - mean;
        delta * delta
      })
      .sum::<f64>()
      / values.len() as f64;
    return Ok(Some(variance_population.sqrt().to_string()));
  }

  if let Some((start, end)) = parse_vara_formula(formula) {
    let values = collect_statisticala_range_values(connection, sheet, start, end)?;
    if values.len() < 2 {
      return Ok(None);
    }
    let mean = values.iter().sum::<f64>() / values.len() as f64;
    let variance_sample = values
      .iter()
      .map(|value| {
        let delta = *value - mean;
        delta * delta
      })
      .sum::<f64>()
      / (values.len() as f64 - 1.0);
    return Ok(Some(variance_sample.to_string()));
  }

  if let Some((start, end)) = parse_varpa_formula(formula) {
    let values = collect_statisticala_range_values(connection, sheet, start, end)?;
    if values.is_empty() {
      return Ok(None);
    }
    let mean = values.iter().sum::<f64>() / values.len() as f64;
    let variance_population = values
      .iter()
      .map(|value| {
        let delta = *value - mean;
        delta * delta
      })
      .sum::<f64>()
      / values.len() as f64;
    return Ok(Some(variance_population.to_string()));
  }

  if let Some((function, left_start, left_end, right_start, right_end)) =
    parse_covariance_formula(formula)
  {
    let Some(pairs) = collect_numeric_pairs_from_ranges(
      connection,
      sheet,
      left_start,
      left_end,
      right_start,
      right_end,
    )? else {
      return Ok(None);
    };
    if pairs.is_empty() {
      return Ok(None);
    }
    if function == "COVARIANCE.S" && pairs.len() < 2 {
      return Ok(None);
    }
    let (_, _, covariance_sum, _, _) = compute_pair_deviation_sums(&pairs)
      .ok_or_else(|| ApiError::internal("pair statistics should be available"))?;
    let count = pairs.len() as f64;
    let covariance = if function == "COVARIANCE.S" {
      covariance_sum / (count - 1.0)
    } else {
      covariance_sum / count
    };
    return Ok(Some(covariance.to_string()));
  }

  if let Some((left_start, left_end, right_start, right_end)) =
    parse_correl_formula(formula)
  {
    let Some(pairs) = collect_numeric_pairs_from_ranges(
      connection,
      sheet,
      left_start,
      left_end,
      right_start,
      right_end,
    )? else {
      return Ok(None);
    };
    if pairs.len() < 2 {
      return Ok(None);
    }
    let (_, _, sum_xy, sum_xx, sum_yy) = compute_pair_deviation_sums(&pairs)
      .ok_or_else(|| ApiError::internal("pair statistics should be available"))?;
    if sum_xx <= 0.0 || sum_yy <= 0.0 {
      return Ok(None);
    }
    let correl = sum_xy / (sum_xx * sum_yy).sqrt();
    return Ok(Some(correl.to_string()));
  }

  if let Some((known_y_start, known_y_end, known_x_start, known_x_end)) =
    parse_slope_formula(formula)
  {
    let Some(pairs) = collect_numeric_pairs_from_ranges(
      connection,
      sheet,
      known_x_start,
      known_x_end,
      known_y_start,
      known_y_end,
    )? else {
      return Ok(None);
    };
    if pairs.len() < 2 {
      return Ok(None);
    }
    let (_, _, sum_xy, sum_xx, _) = compute_pair_deviation_sums(&pairs)
      .ok_or_else(|| ApiError::internal("pair statistics should be available"))?;
    if sum_xx <= 0.0 {
      return Ok(None);
    }
    let slope = sum_xy / sum_xx;
    return Ok(Some(slope.to_string()));
  }

  if let Some((known_y_start, known_y_end, known_x_start, known_x_end)) =
    parse_intercept_formula(formula)
  {
    let Some(pairs) = collect_numeric_pairs_from_ranges(
      connection,
      sheet,
      known_x_start,
      known_x_end,
      known_y_start,
      known_y_end,
    )? else {
      return Ok(None);
    };
    if pairs.len() < 2 {
      return Ok(None);
    }
    let (mean_x, mean_y, sum_xy, sum_xx, _) = compute_pair_deviation_sums(&pairs)
      .ok_or_else(|| ApiError::internal("pair statistics should be available"))?;
    if sum_xx <= 0.0 {
      return Ok(None);
    }
    let slope = sum_xy / sum_xx;
    let intercept = mean_y - slope * mean_x;
    return Ok(Some(intercept.to_string()));
  }

  if let Some((known_y_start, known_y_end, known_x_start, known_x_end)) =
    parse_rsq_formula(formula)
  {
    let Some(pairs) = collect_numeric_pairs_from_ranges(
      connection,
      sheet,
      known_x_start,
      known_x_end,
      known_y_start,
      known_y_end,
    )? else {
      return Ok(None);
    };
    if pairs.len() < 2 {
      return Ok(None);
    }
    let (_, _, sum_xy, sum_xx, sum_yy) = compute_pair_deviation_sums(&pairs)
      .ok_or_else(|| ApiError::internal("pair statistics should be available"))?;
    if sum_xx <= 0.0 || sum_yy <= 0.0 {
      return Ok(None);
    }
    let correl = sum_xy / (sum_xx * sum_yy).sqrt();
    return Ok(Some((correl * correl).to_string()));
  }

  if let Some((_function, x_arg, known_y_start, known_y_end, known_x_start, known_x_end)) =
    parse_forecast_linear_formula(formula)
  {
    let Some(pairs) = collect_numeric_pairs_from_ranges(
      connection,
      sheet,
      known_x_start,
      known_x_end,
      known_y_start,
      known_y_end,
    )? else {
      return Ok(None);
    };
    if pairs.len() < 2 {
      return Ok(None);
    }
    let x = parse_required_float(connection, sheet, &x_arg)?;
    let (mean_x, mean_y, sum_xy, sum_xx, _) = compute_pair_deviation_sums(&pairs)
      .ok_or_else(|| ApiError::internal("pair statistics should be available"))?;
    if sum_xx <= 0.0 {
      return Ok(None);
    }
    let slope = sum_xy / sum_xx;
    let intercept = mean_y - slope * mean_x;
    let forecast = intercept + slope * x;
    return Ok(Some(forecast.to_string()));
  }

  if let Some((known_y_start, known_y_end, known_x_start, known_x_end)) =
    parse_steyx_formula(formula)
  {
    let Some(pairs) = collect_numeric_pairs_from_ranges(
      connection,
      sheet,
      known_x_start,
      known_x_end,
      known_y_start,
      known_y_end,
    )? else {
      return Ok(None);
    };
    if pairs.len() <= 2 {
      return Ok(None);
    }
    let (mean_x, mean_y, sum_xy, sum_xx, _) = compute_pair_deviation_sums(&pairs)
      .ok_or_else(|| ApiError::internal("pair statistics should be available"))?;
    if sum_xx <= 0.0 {
      return Ok(None);
    }
    let slope = sum_xy / sum_xx;
    let intercept = mean_y - slope * mean_x;
    let residual_sum = pairs
      .iter()
      .map(|pair| {
        let estimated = intercept + slope * pair.0;
        let error = pair.1 - estimated;
        error * error
      })
      .sum::<f64>();
    let steyx = (residual_sum / (pairs.len() as f64 - 2.0)).sqrt();
    return Ok(Some(steyx.to_string()));
  }

  if let Some((function, left_start, left_end, right_start, right_end)) =
    parse_sumx_formula(formula)
  {
    let Some(pairs) = collect_numeric_pairs_from_ranges(
      connection,
      sheet,
      left_start,
      left_end,
      right_start,
      right_end,
    )? else {
      return Ok(None);
    };
    if pairs.is_empty() {
      return Ok(None);
    }
    let total = pairs.iter().fold(0.0f64, |acc, (left, right)| {
      let term = match function.as_str() {
        "SUMXMY2" => {
          let delta = left - right;
          delta * delta
        }
        "SUMX2MY2" => left.powi(2) - right.powi(2),
        "SUMX2PY2" => left.powi(2) + right.powi(2),
        _ => 0.0,
      };
      acc + term
    });
    return Ok(Some(total.to_string()));
  }

  if let Some((start, end)) = parse_skew_formula(formula) {
    let values = collect_numeric_range_values(connection, sheet, start, end)?;
    if values.len() < 3 {
      return Ok(None);
    }
    let n = values.len() as f64;
    let mean = values.iter().sum::<f64>() / n;
    let sum_squares = values
      .iter()
      .map(|value| {
        let delta = *value - mean;
        delta * delta
      })
      .sum::<f64>();
    if sum_squares <= 0.0 {
      return Ok(None);
    }
    let sample_std = (sum_squares / (n - 1.0)).sqrt();
    if sample_std <= 0.0 {
      return Ok(None);
    }
    let third_moment = values
      .iter()
      .map(|value| ((*value - mean) / sample_std).powi(3))
      .sum::<f64>();
    let skew = (n / ((n - 1.0) * (n - 2.0))) * third_moment;
    return Ok(Some(skew.to_string()));
  }

  if let Some((start, end)) = parse_skew_p_formula(formula) {
    let values = collect_numeric_range_values(connection, sheet, start, end)?;
    if values.is_empty() {
      return Ok(None);
    }
    let n = values.len() as f64;
    let mean = values.iter().sum::<f64>() / n;
    let sum_squares = values
      .iter()
      .map(|value| {
        let delta = *value - mean;
        delta * delta
      })
      .sum::<f64>();
    if sum_squares <= 0.0 {
      return Ok(None);
    }
    let population_std = (sum_squares / n).sqrt();
    if population_std <= 0.0 {
      return Ok(None);
    }
    let skew_p = values
      .iter()
      .map(|value| ((*value - mean) / population_std).powi(3))
      .sum::<f64>()
      / n;
    return Ok(Some(skew_p.to_string()));
  }

  if let Some((start, end)) = parse_kurt_formula(formula) {
    let values = collect_numeric_range_values(connection, sheet, start, end)?;
    if values.len() < 4 {
      return Ok(None);
    }
    let n = values.len() as f64;
    let mean = values.iter().sum::<f64>() / n;
    let sum_squares = values
      .iter()
      .map(|value| {
        let delta = *value - mean;
        delta * delta
      })
      .sum::<f64>();
    if sum_squares <= 0.0 {
      return Ok(None);
    }
    let sample_std = (sum_squares / (n - 1.0)).sqrt();
    if sample_std <= 0.0 {
      return Ok(None);
    }
    let fourth_moment = values
      .iter()
      .map(|value| ((*value - mean) / sample_std).powi(4))
      .sum::<f64>();
    let kurt = (n * (n + 1.0) / ((n - 1.0) * (n - 2.0) * (n - 3.0))) * fourth_moment
      - (3.0 * (n - 1.0).powi(2) / ((n - 2.0) * (n - 3.0)));
    return Ok(Some(kurt.to_string()));
  }

  if let Some(x_arg) = parse_fisher_formula(formula) {
    let x = parse_required_float(connection, sheet, &x_arg)?;
    if !(x > -1.0 && x < 1.0) {
      return Ok(None);
    }
    let fisher = 0.5 * ((1.0 + x) / (1.0 - x)).ln();
    return Ok(Some(fisher.to_string()));
  }

  if let Some(y_arg) = parse_fisherinv_formula(formula) {
    let y = parse_required_float(connection, sheet, &y_arg)?;
    let exp_term = (2.0 * y).exp();
    let fisherinv = (exp_term - 1.0) / (exp_term + 1.0);
    return Ok(Some(fisherinv.to_string()));
  }

  if let Some((start, end, target_arg, significance_arg)) = parse_percentrank_inc_formula(formula)
  {
    let target = parse_required_float(connection, sheet, &target_arg)?;
    let significance = match significance_arg {
      Some(raw_significance) => {
        Some(parse_required_unsigned(connection, sheet, &raw_significance)?)
      }
      None => None,
    };
    let mut values = collect_numeric_range_values(connection, sheet, start, end)?;
    if values.len() < 2 {
      return Ok(None);
    }
    values.sort_by(|left, right| left.partial_cmp(right).unwrap_or(std::cmp::Ordering::Equal));
    let Some(position) = interpolate_sorted_position(&values, target) else {
      return Ok(None);
    };
    let rank = position / (values.len() as f64 - 1.0);
    let rounded = round_to_significance(rank, significance);
    return Ok(rounded.map(|value| value.to_string()));
  }

  if let Some((start, end, target_arg, significance_arg)) = parse_percentrank_exc_formula(formula)
  {
    let target = parse_required_float(connection, sheet, &target_arg)?;
    let significance = match significance_arg {
      Some(raw_significance) => {
        Some(parse_required_unsigned(connection, sheet, &raw_significance)?)
      }
      None => None,
    };
    let mut values = collect_numeric_range_values(connection, sheet, start, end)?;
    if values.len() < 2 {
      return Ok(None);
    }
    values.sort_by(|left, right| left.partial_cmp(right).unwrap_or(std::cmp::Ordering::Equal));
    let Some(position) = interpolate_sorted_position(&values, target) else {
      return Ok(None);
    };
    let rank = (position + 1.0) / (values.len() as f64 + 1.0);
    let rounded = round_to_significance(rank, significance);
    return Ok(rounded.map(|value| value.to_string()));
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

  if let Some(minifs_formula) = parse_minifs_formula(formula) {
    return evaluate_minifs_formula(connection, sheet, &minifs_formula);
  }

  if let Some(maxifs_formula) = parse_maxifs_formula(formula) {
    return evaluate_maxifs_formula(connection, sheet, &maxifs_formula);
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

  if let Some(conditions) = parse_ifs_formula(formula) {
    for (condition, value_expression) in conditions {
      if evaluate_if_condition(connection, sheet, &condition)? {
        return resolve_scalar_operand(connection, sheet, &value_expression).map(Some);
      }
    }
    return Ok(None);
  }

  if let Some((value_expression, fallback_expression)) = parse_iferror_formula(formula) {
    if let Some(value) = evaluate_formula_argument(connection, sheet, &value_expression)? {
      return Ok(Some(value));
    }
    return resolve_scalar_operand(connection, sheet, &fallback_expression).map(Some);
  }

  if let Some((selector_operand, options)) = parse_choose_formula(formula) {
    let selector = parse_required_unsigned(connection, sheet, &selector_operand)?;
    if selector == 0 {
      return Ok(Some(String::new()));
    }
    let option_index = usize::try_from(selector.saturating_sub(1)).unwrap_or_default();
    let selected = options.get(option_index).cloned().unwrap_or_default();
    if let Some(value) = evaluate_formula_argument(connection, sheet, &selected)? {
      return Ok(Some(value));
    }
    return Ok(Some(String::new()));
  }

  if let Some((expression_operand, cases, default_value)) = parse_switch_formula(formula) {
    let expression_value = resolve_scalar_operand(connection, sheet, &expression_operand)?;
    for (candidate_operand, result_operand) in cases {
      let candidate_value = resolve_scalar_operand(connection, sheet, &candidate_operand)?;
      if expression_value == candidate_value {
        return resolve_scalar_operand(connection, sheet, &result_operand).map(Some);
      }
    }
    if let Some(default_operand) = default_value {
      return resolve_scalar_operand(connection, sheet, &default_operand).map(Some);
    }
    return Ok(None);
  }

  if let Some(concat_args) = parse_concat_formula(formula) {
    let mut output = String::new();
    for argument in concat_args {
      output.push_str(&resolve_scalar_operand(connection, sheet, &argument)?);
    }
    return Ok(Some(output));
  }

  if let Some((delimiter_operand, ignore_empty_operand, text_operands)) =
    parse_textjoin_formula(formula)
  {
    let delimiter = resolve_scalar_operand(connection, sheet, &delimiter_operand)?;
    let ignore_empty_value =
      resolve_scalar_operand(connection, sheet, &ignore_empty_operand)?;
    let ignore_empty = resolve_truthy_operand(&ignore_empty_value);
    let mut values = Vec::new();
    for operand in text_operands {
      let resolved_values =
        resolve_textjoin_argument_values(connection, sheet, &operand)?;
      for value in resolved_values {
        if ignore_empty && value.is_empty() {
          continue;
        }
        values.push(value);
      }
    }
    return Ok(Some(values.join(&delimiter)));
  }

  if parse_today_formula(formula).is_some() {
    return Ok(Some(Utc::now().date_naive().to_string()));
  }

  if parse_now_formula(formula).is_some() {
    return Ok(Some(Utc::now().to_rfc3339()));
  }

  if parse_rand_formula(formula).is_some() {
    let random = connection
      .query_row("SELECT RANDOM()", [], |row| row.get::<_, f64>(0))
      .map_err(ApiError::internal)?;
    return Ok(Some(random.to_string()));
  }

  if let Some((min_arg, max_arg)) = parse_randbetween_formula(formula) {
    let min_value = parse_required_integer(connection, sheet, &min_arg)?;
    let max_value = parse_required_integer(connection, sheet, &max_arg)?;
    if min_value > max_value {
      return Ok(None);
    }
    let random = connection
      .query_row("SELECT RANDOM()", [], |row| row.get::<_, f64>(0))
      .map_err(ApiError::internal)?;
    let span = f64::from(max_value - min_value + 1);
    let sampled = f64::from(min_value) + (random * span).floor();
    return Ok(Some((sampled as i32).to_string()));
  }

  if parse_true_formula(formula).is_some() {
    return Ok(Some(true.to_string()));
  }

  if parse_false_formula(formula).is_some() {
    return Ok(Some(false.to_string()));
  }

  if let Some(vlookup_formula) = parse_vlookup_formula(formula) {
    return evaluate_vlookup_formula(connection, sheet, &vlookup_formula);
  }

  if let Some(hlookup_formula) = parse_hlookup_formula(formula) {
    return evaluate_hlookup_formula(connection, sheet, &hlookup_formula);
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

  if let Some(xor_args) = parse_xor_formula(formula) {
    let true_count = xor_args
      .iter()
      .map(|arg| evaluate_if_condition(connection, sheet, arg))
      .collect::<Result<Vec<bool>, ApiError>>()?
      .into_iter()
      .filter(|value| *value)
      .count();
    return Ok(Some((true_count % 2 == 1).to_string()));
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

  if let Some(proper_arg) = parse_proper_formula(formula) {
    let text = resolve_scalar_operand(connection, sheet, &proper_arg)?;
    let mut output = String::new();
    let mut is_word_start = true;
    for ch in text.chars() {
      if ch.is_alphabetic() {
        if is_word_start {
          for upper in ch.to_uppercase() {
            output.push(upper);
          }
        } else {
          for lower in ch.to_lowercase() {
            output.push(lower);
          }
        }
        is_word_start = false;
      } else {
        output.push(ch);
        is_word_start = !ch.is_alphanumeric();
      }
    }
    return Ok(Some(output));
  }

  if let Some(clean_arg) = parse_clean_formula(formula) {
    let text = resolve_scalar_operand(connection, sheet, &clean_arg)?;
    let cleaned = text
      .chars()
      .filter(|ch| (*ch as u32) >= 32)
      .collect::<String>();
    return Ok(Some(cleaned));
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

  if let Some(is_even_arg) = parse_iseven_formula(formula) {
    let value = resolve_scalar_operand(connection, sheet, &is_even_arg)?;
    let Some(number) = value.trim().parse::<f64>().ok() else {
      return Ok(None);
    };
    let integer_value = number.trunc() as i64;
    return Ok(Some((integer_value.abs() % 2 == 0).to_string()));
  }

  if let Some(is_odd_arg) = parse_isodd_formula(formula) {
    let value = resolve_scalar_operand(connection, sheet, &is_odd_arg)?;
    let Some(number) = value.trim().parse::<f64>().ok() else {
      return Ok(None);
    };
    let integer_value = number.trunc() as i64;
    return Ok(Some((integer_value.abs() % 2 == 1).to_string()));
  }

  if let Some(value_arg) = parse_value_formula(formula) {
    let value = resolve_scalar_operand(connection, sheet, &value_arg)?;
    let Some(parsed) = value.trim().parse::<f64>().ok() else {
      return Ok(None);
    };
    return Ok(Some(parsed.to_string()));
  }

  if let Some(n_arg) = parse_n_formula(formula) {
    let value = resolve_scalar_operand(connection, sheet, &n_arg)?;
    let trimmed = value.trim();
    let normalized = trimmed.to_uppercase();
    if normalized == "TRUE" {
      return Ok(Some("1".to_string()));
    }
    if normalized == "FALSE" || trimmed.is_empty() {
      return Ok(Some("0".to_string()));
    }
    if let Ok(parsed) = trimmed.parse::<f64>() {
      return Ok(Some(parsed.to_string()));
    }
    return Ok(Some("0".to_string()));
  }

  if let Some(t_arg) = parse_t_formula(formula) {
    let value = resolve_scalar_operand(connection, sheet, &t_arg)?;
    let trimmed = value.trim();
    let normalized = trimmed.to_uppercase();
    if trimmed.parse::<f64>().is_ok()
      || normalized == "TRUE"
      || normalized == "FALSE"
    {
      return Ok(Some(String::new()));
    }
    return Ok(Some(value));
  }

  if let Some(char_arg) = parse_char_formula(formula) {
    let code = parse_required_integer(connection, sheet, &char_arg)?;
    if !(1..=255).contains(&code) {
      return Ok(None);
    }
    let Some(character) = char::from_u32(code as u32) else {
      return Ok(None);
    };
    return Ok(Some(character.to_string()));
  }

  if let Some(code_arg) = parse_code_formula(formula) {
    let value = resolve_scalar_operand(connection, sheet, &code_arg)?;
    let Some(first_char) = value.chars().next() else {
      return Ok(None);
    };
    return Ok(Some((first_char as u32).to_string()));
  }

  if let Some(unichar_arg) = parse_unichar_formula(formula) {
    let code = parse_required_integer(connection, sheet, &unichar_arg)?;
    if !(1..=1_114_111).contains(&code) {
      return Ok(None);
    }
    let Some(character) = char::from_u32(code as u32) else {
      return Ok(None);
    };
    return Ok(Some(character.to_string()));
  }

  if let Some(unicode_arg) = parse_unicode_formula(formula) {
    let value = resolve_scalar_operand(connection, sheet, &unicode_arg)?;
    let Some(first_char) = value.chars().next() else {
      return Ok(None);
    };
    return Ok(Some((first_char as u32).to_string()));
  }

  if let Some((roman_number_arg, roman_form_arg)) = parse_roman_formula(formula) {
    if let Some(form_arg) = roman_form_arg {
      let form = parse_required_integer(connection, sheet, &form_arg)?;
      if form != 0 {
        return Ok(None);
      }
    }
    let value = parse_required_integer(connection, sheet, &roman_number_arg)?;
    if !(1..=3999).contains(&value) {
      return Ok(None);
    }
    let Some(numeral) = int_to_roman(value as u32) else {
      return Ok(None);
    };
    return Ok(Some(numeral));
  }

  if let Some(arabic_arg) = parse_arabic_formula(formula) {
    let value = resolve_scalar_operand(connection, sheet, &arabic_arg)?;
    let Some(parsed) = roman_to_int(&value) else {
      return Ok(None);
    };
    return Ok(Some(parsed.to_string()));
  }

  if parse_pi_formula(formula).is_some() {
    return Ok(Some(std::f64::consts::PI.to_string()));
  }

  if let Some(ln_arg) = parse_ln_formula(formula) {
    let value = parse_required_float(connection, sheet, &ln_arg)?;
    if value <= 0.0 {
      return Ok(None);
    }
    return Ok(Some(value.ln().to_string()));
  }

  if let Some(log10_arg) = parse_log10_formula(formula) {
    let value = parse_required_float(connection, sheet, &log10_arg)?;
    if value <= 0.0 {
      return Ok(None);
    }
    return Ok(Some(value.log10().to_string()));
  }

  if let Some(exp_arg) = parse_exp_formula(formula) {
    let value = parse_required_float(connection, sheet, &exp_arg)?;
    return Ok(Some(value.exp().to_string()));
  }

  if let Some((number_arg, base_arg)) = parse_log_formula(formula) {
    let value = parse_required_float(connection, sheet, &number_arg)?;
    let base = match base_arg {
      Some(raw_base) => parse_required_float(connection, sheet, &raw_base)?,
      None => 10.0,
    };
    if value <= 0.0 || base <= 0.0 || (base - 1.0).abs() < f64::EPSILON {
      return Ok(None);
    }
    return Ok(Some(value.log(base).to_string()));
  }

  if let Some(fact_arg) = parse_fact_formula(formula) {
    let value = parse_required_integer(connection, sheet, &fact_arg)?;
    if value < 0 || value > 170 {
      return Ok(None);
    }
    let mut result = 1f64;
    for index in 1..=value {
      result *= f64::from(index);
    }
    return Ok(Some(result.to_string()));
  }

  if let Some(factdouble_arg) = parse_factdouble_formula(formula) {
    let value = parse_required_integer(connection, sheet, &factdouble_arg)?;
    if value < 0 {
      return Ok(None);
    }
    let mut result = 1f64;
    let mut current = value;
    while current > 1 {
      result *= f64::from(current);
      if !result.is_finite() {
        return Ok(None);
      }
      current -= 2;
    }
    return Ok(Some(result.to_string()));
  }

  if let Some((number_arg, chosen_arg)) = parse_combin_formula(formula) {
    let number = parse_required_integer(connection, sheet, &number_arg)?;
    let chosen = parse_required_integer(connection, sheet, &chosen_arg)?;
    if number < 0 || chosen < 0 || chosen > number {
      return Ok(None);
    }
    let mut k = chosen;
    if k > number - k {
      k = number - k;
    }
    let mut result = 1f64;
    let mut step = 1i32;
    while step <= k {
      result *= f64::from(number - k + step);
      result /= f64::from(step);
      step += 1;
    }
    return Ok(Some(result.round().to_string()));
  }

  if let Some((number_arg, chosen_arg)) = parse_combina_formula(formula) {
    let number = parse_required_integer(connection, sheet, &number_arg)?;
    let chosen = parse_required_integer(connection, sheet, &chosen_arg)?;
    if number < 0 || chosen < 0 {
      return Ok(None);
    }
    if chosen == 0 {
      return Ok(Some("1".to_string()));
    }
    if number == 0 {
      return Ok(None);
    }
    let total = number + chosen - 1;
    if total > 170 {
      return Ok(None);
    }
    let mut k = chosen;
    if k > total - k {
      k = total - k;
    }
    let mut result = 1f64;
    let mut step = 1i32;
    while step <= k {
      result *= f64::from(total - k + step);
      result /= f64::from(step);
      step += 1;
    }
    return Ok(Some(result.round().to_string()));
  }

  if let Some((number_arg, chosen_arg)) = parse_permut_formula(formula) {
    let number = parse_required_integer(connection, sheet, &number_arg)?;
    let chosen = parse_required_integer(connection, sheet, &chosen_arg)?;
    if number < 0 || chosen < 0 || chosen > number || number > 170 {
      return Ok(None);
    }
    let mut result = 1f64;
    let mut step = 0i32;
    while step < chosen {
      result *= f64::from(number - step);
      step += 1;
    }
    return Ok(Some(result.round().to_string()));
  }

  if let Some((number_arg, chosen_arg)) = parse_permutationa_formula(formula) {
    let number = parse_required_integer(connection, sheet, &number_arg)?;
    let chosen = parse_required_integer(connection, sheet, &chosen_arg)?;
    if number < 0 || chosen < 0 {
      return Ok(None);
    }
    let result = f64::from(number).powi(chosen);
    return Ok(Some(result.to_string()));
  }

  if let Some(arguments) = parse_multinomial_formula(formula) {
    let mut terms = Vec::new();
    let mut total = 0i32;
    for argument in arguments {
      let value = parse_required_integer(connection, sheet, &argument)?;
      if value < 0 {
        return Ok(None);
      }
      terms.push(value);
      total += value;
    }
    if total > 170 {
      return Ok(None);
    }
    let mut numerator = 1f64;
    for index in 1..=total {
      numerator *= f64::from(index);
    }
    let mut denominator = 1f64;
    for term in terms {
      for index in 1..=term {
        denominator *= f64::from(index);
      }
    }
    if denominator <= 0.0 {
      return Ok(None);
    }
    let result = numerator / denominator;
    return Ok(Some(result.round().to_string()));
  }

  if let Some(gcd_args) = parse_gcd_formula(formula) {
    let mut values = Vec::new();
    for argument in gcd_args {
      let resolved = resolve_scalar_operand(connection, sheet, &argument)?;
      let Some(parsed) = resolved.trim().parse::<f64>().ok() else {
        return Ok(None);
      };
      values.push(parsed.abs().trunc() as u64);
    }
    let mut result = values[0];
    for value in values.into_iter().skip(1) {
      result = gcd_u64(result, value);
    }
    return Ok(Some(result.to_string()));
  }

  if let Some(lcm_args) = parse_lcm_formula(formula) {
    let mut values = Vec::new();
    for argument in lcm_args {
      let resolved = resolve_scalar_operand(connection, sheet, &argument)?;
      let Some(parsed) = resolved.trim().parse::<f64>().ok() else {
        return Ok(None);
      };
      values.push(parsed.abs().trunc() as u64);
    }
    let mut result = values[0];
    for value in values.into_iter().skip(1) {
      result = lcm_u64(result, value)?;
    }
    return Ok(Some(result.to_string()));
  }

  if let Some(sin_arg) = parse_sin_formula(formula) {
    let value = parse_required_float(connection, sheet, &sin_arg)?;
    return Ok(Some(value.sin().to_string()));
  }

  if let Some(cos_arg) = parse_cos_formula(formula) {
    let value = parse_required_float(connection, sheet, &cos_arg)?;
    return Ok(Some(value.cos().to_string()));
  }

  if let Some(tan_arg) = parse_tan_formula(formula) {
    let value = parse_required_float(connection, sheet, &tan_arg)?;
    return Ok(Some(value.tan().to_string()));
  }

  if let Some(cot_arg) = parse_cot_formula(formula) {
    let value = parse_required_float(connection, sheet, &cot_arg)?;
    let tan_value = value.tan();
    if tan_value.abs() < f64::EPSILON {
      return Ok(None);
    }
    return Ok(Some((1.0 / tan_value).to_string()));
  }

  if let Some(sec_arg) = parse_sec_formula(formula) {
    let value = parse_required_float(connection, sheet, &sec_arg)?;
    let cos_value = value.cos();
    if cos_value.abs() < f64::EPSILON {
      return Ok(None);
    }
    return Ok(Some((1.0 / cos_value).to_string()));
  }

  if let Some(csc_arg) = parse_csc_formula(formula) {
    let value = parse_required_float(connection, sheet, &csc_arg)?;
    let sin_value = value.sin();
    if sin_value.abs() < f64::EPSILON {
      return Ok(None);
    }
    return Ok(Some((1.0 / sin_value).to_string()));
  }

  if let Some(sinh_arg) = parse_sinh_formula(formula) {
    let value = parse_required_float(connection, sheet, &sinh_arg)?;
    return Ok(Some(value.sinh().to_string()));
  }

  if let Some(cosh_arg) = parse_cosh_formula(formula) {
    let value = parse_required_float(connection, sheet, &cosh_arg)?;
    return Ok(Some(value.cosh().to_string()));
  }

  if let Some(tanh_arg) = parse_tanh_formula(formula) {
    let value = parse_required_float(connection, sheet, &tanh_arg)?;
    return Ok(Some(value.tanh().to_string()));
  }

  if let Some(coth_arg) = parse_coth_formula(formula) {
    let value = parse_required_float(connection, sheet, &coth_arg)?;
    let tanh_value = value.tanh();
    if tanh_value.abs() < f64::EPSILON {
      return Ok(None);
    }
    return Ok(Some((1.0 / tanh_value).to_string()));
  }

  if let Some(sech_arg) = parse_sech_formula(formula) {
    let value = parse_required_float(connection, sheet, &sech_arg)?;
    let cosh_value = value.cosh();
    if cosh_value.abs() < f64::EPSILON {
      return Ok(None);
    }
    return Ok(Some((1.0 / cosh_value).to_string()));
  }

  if let Some(csch_arg) = parse_csch_formula(formula) {
    let value = parse_required_float(connection, sheet, &csch_arg)?;
    let sinh_value = value.sinh();
    if sinh_value.abs() < f64::EPSILON {
      return Ok(None);
    }
    return Ok(Some((1.0 / sinh_value).to_string()));
  }

  if let Some(asinh_arg) = parse_asinh_formula(formula) {
    let value = parse_required_float(connection, sheet, &asinh_arg)?;
    return Ok(Some(value.asinh().to_string()));
  }

  if let Some(acosh_arg) = parse_acosh_formula(formula) {
    let value = parse_required_float(connection, sheet, &acosh_arg)?;
    if value < 1.0 {
      return Ok(None);
    }
    return Ok(Some(value.acosh().to_string()));
  }

  if let Some(atanh_arg) = parse_atanh_formula(formula) {
    let value = parse_required_float(connection, sheet, &atanh_arg)?;
    if value <= -1.0 || value >= 1.0 {
      return Ok(None);
    }
    return Ok(Some(value.atanh().to_string()));
  }

  if let Some(acot_arg) = parse_acot_formula(formula) {
    let value = parse_required_float(connection, sheet, &acot_arg)?;
    let acot = if value.abs() < f64::EPSILON {
      std::f64::consts::FRAC_PI_2
    } else {
      (1.0 / value).atan()
    };
    return Ok(Some(acot.to_string()));
  }

  if let Some(asec_arg) = parse_asec_formula(formula) {
    let value = parse_required_float(connection, sheet, &asec_arg)?;
    if value.abs() < 1.0 {
      return Ok(None);
    }
    return Ok(Some((1.0 / value).acos().to_string()));
  }

  if let Some(acsc_arg) = parse_acsc_formula(formula) {
    let value = parse_required_float(connection, sheet, &acsc_arg)?;
    if value.abs() < 1.0 {
      return Ok(None);
    }
    return Ok(Some((1.0 / value).asin().to_string()));
  }

  if let Some(acoth_arg) = parse_acoth_formula(formula) {
    let value = parse_required_float(connection, sheet, &acoth_arg)?;
    if value.abs() <= 1.0 {
      return Ok(None);
    }
    let acoth = 0.5 * ((value + 1.0) / (value - 1.0)).ln();
    return Ok(Some(acoth.to_string()));
  }

  if let Some(asech_arg) = parse_asech_formula(formula) {
    let value = parse_required_float(connection, sheet, &asech_arg)?;
    if !(value > 0.0 && value <= 1.0) {
      return Ok(None);
    }
    return Ok(Some((1.0 / value).acosh().to_string()));
  }

  if let Some(acsch_arg) = parse_acsch_formula(formula) {
    let value = parse_required_float(connection, sheet, &acsch_arg)?;
    if value.abs() < f64::EPSILON {
      return Ok(None);
    }
    return Ok(Some((1.0 / value).asinh().to_string()));
  }

  if let Some(asin_arg) = parse_asin_formula(formula) {
    let value = parse_required_float(connection, sheet, &asin_arg)?;
    if !(-1.0..=1.0).contains(&value) {
      return Ok(None);
    }
    return Ok(Some(value.asin().to_string()));
  }

  if let Some(acos_arg) = parse_acos_formula(formula) {
    let value = parse_required_float(connection, sheet, &acos_arg)?;
    if !(-1.0..=1.0).contains(&value) {
      return Ok(None);
    }
    return Ok(Some(value.acos().to_string()));
  }

  if let Some(atan_arg) = parse_atan_formula(formula) {
    let value = parse_required_float(connection, sheet, &atan_arg)?;
    return Ok(Some(value.atan().to_string()));
  }

  if let Some((x_arg, y_arg)) = parse_atan2_formula(formula) {
    let x = parse_required_float(connection, sheet, &x_arg)?;
    let y = parse_required_float(connection, sheet, &y_arg)?;
    return Ok(Some(y.atan2(x).to_string()));
  }

  if let Some(degrees_arg) = parse_degrees_formula(formula) {
    let value = parse_required_float(connection, sheet, &degrees_arg)?;
    return Ok(Some(value.to_degrees().to_string()));
  }

  if let Some(radians_arg) = parse_radians_formula(formula) {
    let value = parse_required_float(connection, sheet, &radians_arg)?;
    return Ok(Some(value.to_radians().to_string()));
  }

  if let Some(abs_arg) = parse_abs_formula(formula) {
    let value = parse_required_float(connection, sheet, &abs_arg)?;
    return Ok(Some(value.abs().to_string()));
  }

  if let Some((value_arg, digits_arg)) = parse_round_formula(formula) {
    let value = parse_required_float(connection, sheet, &value_arg)?;
    let digits = parse_required_integer(connection, sheet, &digits_arg)?;
    let factor = 10f64.powi(digits);
    let rounded = (value * factor).round() / factor;
    return Ok(Some(rounded.to_string()));
  }

  if let Some((value_arg, digits_arg)) = parse_roundup_formula(formula) {
    let value = parse_required_float(connection, sheet, &value_arg)?;
    let digits = parse_required_integer(connection, sheet, &digits_arg)?;
    let factor = 10f64.powi(digits);
    let scaled = value * factor;
    let rounded = if scaled.is_sign_negative() {
      scaled.floor()
    } else {
      scaled.ceil()
    } / factor;
    return Ok(Some(rounded.to_string()));
  }

  if let Some((value_arg, digits_arg)) = parse_rounddown_formula(formula) {
    let value = parse_required_float(connection, sheet, &value_arg)?;
    let digits = parse_required_integer(connection, sheet, &digits_arg)?;
    let factor = 10f64.powi(digits);
    let scaled = value * factor;
    let rounded = if scaled.is_sign_negative() {
      scaled.ceil()
    } else {
      scaled.floor()
    } / factor;
    return Ok(Some(rounded.to_string()));
  }

  if let Some((value_arg, significance_arg, mode_arg)) =
    parse_ceiling_math_formula(formula)
  {
    let value = parse_required_float(connection, sheet, &value_arg)?;
    let significance = match significance_arg {
      Some(raw_significance) => parse_required_float(connection, sheet, &raw_significance)?,
      None => 1.0,
    };
    let mode = match mode_arg {
      Some(raw_mode) => parse_required_integer(connection, sheet, &raw_mode)?,
      None => 0,
    };
    let rounded = ceiling_math(value, significance, mode);
    return Ok(Some(rounded.to_string()));
  }

  if let Some((value_arg, significance_arg)) = parse_ceiling_formula(formula) {
    let value = parse_required_float(connection, sheet, &value_arg)?;
    let significance = parse_required_float(connection, sheet, &significance_arg)?;
    let rounded = ceiling_math(value, significance, 0);
    return Ok(Some(rounded.to_string()));
  }

  if let Some((value_arg, significance_arg, mode_arg)) = parse_floor_math_formula(formula)
  {
    let value = parse_required_float(connection, sheet, &value_arg)?;
    let significance = match significance_arg {
      Some(raw_significance) => parse_required_float(connection, sheet, &raw_significance)?,
      None => 1.0,
    };
    let mode = match mode_arg {
      Some(raw_mode) => parse_required_integer(connection, sheet, &raw_mode)?,
      None => 0,
    };
    let rounded = floor_math(value, significance, mode);
    return Ok(Some(rounded.to_string()));
  }

  if let Some((value_arg, significance_arg)) = parse_floor_formula(formula) {
    let value = parse_required_float(connection, sheet, &value_arg)?;
    let significance = parse_required_float(connection, sheet, &significance_arg)?;
    let rounded = floor_math(value, significance, 1);
    return Ok(Some(rounded.to_string()));
  }

  if let Some(sqrt_arg) = parse_sqrt_formula(formula) {
    let value = parse_required_float(connection, sheet, &sqrt_arg)?;
    if value.is_sign_negative() {
      return Ok(None);
    }
    return Ok(Some(value.sqrt().to_string()));
  }

  if let Some((base_arg, exponent_arg)) = parse_power_formula(formula) {
    let base = parse_required_float(connection, sheet, &base_arg)?;
    let exponent = parse_required_float(connection, sheet, &exponent_arg)?;
    return Ok(Some(base.powf(exponent).to_string()));
  }

  if let Some((dividend_arg, divisor_arg)) = parse_mod_formula(formula) {
    let dividend = parse_required_float(connection, sheet, &dividend_arg)?;
    let divisor = parse_required_float(connection, sheet, &divisor_arg)?;
    if divisor == 0.0 {
      return Ok(None);
    }
    let result = dividend - divisor * (dividend / divisor).floor();
    return Ok(Some(result.to_string()));
  }

  if let Some((numerator_arg, denominator_arg)) = parse_quotient_formula(formula) {
    let numerator = parse_required_float(connection, sheet, &numerator_arg)?;
    let denominator = parse_required_float(connection, sheet, &denominator_arg)?;
    if denominator == 0.0 {
      return Ok(None);
    }
    let result = (numerator / denominator).trunc();
    return Ok(Some(result.to_string()));
  }

  if let Some((value_arg, multiple_arg)) = parse_mround_formula(formula) {
    let value = parse_required_float(connection, sheet, &value_arg)?;
    let multiple = parse_required_float(connection, sheet, &multiple_arg)?;
    if multiple == 0.0 {
      return Ok(Some("0".to_string()));
    }
    if value.is_sign_positive() != multiple.is_sign_positive()
      && value.abs() > f64::EPSILON
    {
      return Ok(None);
    }
    let rounded = (value / multiple).round() * multiple;
    return Ok(Some(rounded.to_string()));
  }

  if let Some(sign_arg) = parse_sign_formula(formula) {
    let value = parse_required_float(connection, sheet, &sign_arg)?;
    let result = if value > 0.0 {
      1
    } else if value < 0.0 {
      -1
    } else {
      0
    };
    return Ok(Some(result.to_string()));
  }

  if let Some(int_arg) = parse_int_formula(formula) {
    let value = parse_required_float(connection, sheet, &int_arg)?;
    return Ok(Some(value.floor().to_string()));
  }

  if let Some(even_arg) = parse_even_formula(formula) {
    let value = resolve_scalar_operand(connection, sheet, &even_arg)?;
    let Some(parsed) = value.trim().parse::<f64>().ok() else {
      return Ok(None);
    };
    let rounded = parsed.abs().ceil() as i64;
    let candidate = if rounded % 2 == 0 { rounded } else { rounded + 1 };
    let result = if parsed.is_sign_negative() {
      -candidate
    } else {
      candidate
    };
    return Ok(Some(result.to_string()));
  }

  if let Some(odd_arg) = parse_odd_formula(formula) {
    let value = resolve_scalar_operand(connection, sheet, &odd_arg)?;
    let Some(parsed) = value.trim().parse::<f64>().ok() else {
      return Ok(None);
    };
    let rounded = parsed.abs().ceil() as i64;
    let candidate = if rounded % 2 == 1 { rounded } else { rounded + 1 };
    let result = if parsed.is_sign_negative() {
      -candidate
    } else {
      candidate
    };
    return Ok(Some(result.to_string()));
  }

  if let Some((value_arg, digits_arg)) = parse_trunc_formula(formula) {
    let value = parse_required_float(connection, sheet, &value_arg)?;
    let digits = match digits_arg {
      Some(raw_digits) => parse_required_integer(connection, sheet, &raw_digits)?,
      None => 0,
    };
    let factor = 10f64.powi(digits);
    let scaled = value * factor;
    let truncated = if scaled.is_sign_negative() {
      scaled.ceil()
    } else {
      scaled.floor()
    } / factor;
    return Ok(Some(truncated.to_string()));
  }

  if let Some((left_arg, right_arg)) = parse_exact_formula(formula) {
    let left = resolve_scalar_operand(connection, sheet, &left_arg)?;
    let right = resolve_scalar_operand(connection, sheet, &right_arg)?;
    return Ok(Some((left == right).to_string()));
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

  if let Some((text_arg, start_arg, count_arg)) = parse_mid_formula(formula) {
    let text = resolve_scalar_operand(connection, sheet, &text_arg)?;
    let start = parse_required_integer(connection, sheet, &start_arg)?;
    let count = parse_required_integer(connection, sheet, &count_arg)?;
    if start < 1 || count < 0 {
      return Ok(None);
    }
    let start_index = usize::try_from(start - 1).unwrap_or(0);
    let char_count = usize::try_from(count).unwrap_or(0);
    let value = text
      .chars()
      .skip(start_index)
      .take(char_count)
      .collect::<String>();
    return Ok(Some(value));
  }

  if let Some((text_arg, count_arg)) = parse_rept_formula(formula) {
    let text = resolve_scalar_operand(connection, sheet, &text_arg)?;
    let count = parse_required_integer(connection, sheet, &count_arg)?;
    if count < 0 {
      return Ok(None);
    }
    let repeat_count = usize::try_from(count).unwrap_or(0);
    return Ok(Some(text.repeat(repeat_count)));
  }

  if let Some((old_text_arg, start_arg, count_arg, new_text_arg)) =
    parse_replace_formula(formula)
  {
    let old_text = resolve_scalar_operand(connection, sheet, &old_text_arg)?;
    let start = parse_required_integer(connection, sheet, &start_arg)?;
    let num_chars = parse_required_integer(connection, sheet, &count_arg)?;
    let new_text = resolve_scalar_operand(connection, sheet, &new_text_arg)?;
    if start < 1 || num_chars < 0 {
      return Ok(None);
    }

    let old_chars = old_text.chars().collect::<Vec<char>>();
    let start_index = usize::try_from(start - 1).unwrap_or(0);
    let replace_count = usize::try_from(num_chars).unwrap_or(0);
    let prefix = old_chars
      .iter()
      .take(start_index.min(old_chars.len()))
      .collect::<String>();
    let suffix_start = start_index.saturating_add(replace_count).min(old_chars.len());
    let suffix = old_chars[suffix_start..].iter().collect::<String>();
    return Ok(Some(format!("{prefix}{new_text}{suffix}")));
  }

  if let Some((text_arg, old_text_arg, new_text_arg, instance_arg)) =
    parse_substitute_formula(formula)
  {
    let text = resolve_scalar_operand(connection, sheet, &text_arg)?;
    let old_text = resolve_scalar_operand(connection, sheet, &old_text_arg)?;
    let new_text = resolve_scalar_operand(connection, sheet, &new_text_arg)?;
    if old_text.is_empty() {
      return Ok(Some(text));
    }

    if let Some(raw_instance) = instance_arg {
      let instance = parse_required_integer(connection, sheet, &raw_instance)?;
      if instance <= 0 {
        return Ok(None);
      }
      let replaced = replace_nth_occurrence(
        &text,
        &old_text,
        &new_text,
        usize::try_from(instance).unwrap_or(0),
      );
      return Ok(Some(replaced));
    }

    return Ok(Some(text.replace(&old_text, &new_text)));
  }

  if let Some((find_text_arg, within_text_arg, start_num_arg)) =
    parse_search_formula(formula)
  {
    let find_text = resolve_scalar_operand(connection, sheet, &find_text_arg)?;
    let within_text = resolve_scalar_operand(connection, sheet, &within_text_arg)?;
    let start_num = match start_num_arg {
      Some(raw_start) => parse_required_integer(connection, sheet, &raw_start)?,
      None => 1,
    };
    if start_num < 1 || find_text.is_empty() {
      return Ok(None);
    }
    let start_index = usize::try_from(start_num - 1).unwrap_or(0);
    let within_chars = within_text.chars().collect::<Vec<char>>();
    if start_index >= within_chars.len() {
      return Ok(None);
    }

    let candidate = within_chars[start_index..]
      .iter()
      .collect::<String>()
      .to_lowercase();
    let needle = find_text.to_lowercase();
    let Some(byte_index) = candidate.find(&needle) else {
      return Ok(None);
    };
    let char_index = candidate[..byte_index].chars().count();
    let result_position = start_index + char_index + 1;
    return Ok(Some(result_position.to_string()));
  }

  if let Some((find_text_arg, within_text_arg, start_num_arg)) =
    parse_find_formula(formula)
  {
    let find_text = resolve_scalar_operand(connection, sheet, &find_text_arg)?;
    let within_text = resolve_scalar_operand(connection, sheet, &within_text_arg)?;
    let start_num = match start_num_arg {
      Some(raw_start) => parse_required_integer(connection, sheet, &raw_start)?,
      None => 1,
    };
    if start_num < 1 || find_text.is_empty() {
      return Ok(None);
    }
    let start_index = usize::try_from(start_num - 1).unwrap_or(0);
    let within_chars = within_text.chars().collect::<Vec<char>>();
    if start_index >= within_chars.len() {
      return Ok(None);
    }

    let candidate = within_chars[start_index..].iter().collect::<String>();
    let Some(byte_index) = candidate.find(&find_text) else {
      return Ok(None);
    };
    let char_index = candidate[..byte_index].chars().count();
    let result_position = start_index + char_index + 1;
    return Ok(Some(result_position.to_string()));
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

  if let Some((start_date_arg, month_arg)) = parse_edate_formula(formula) {
    let start_date = parse_date_operand(connection, sheet, &start_date_arg)?;
    let Some(base_date) = start_date else {
      return Ok(Some(String::new()));
    };
    let months = parse_required_integer(connection, sheet, &month_arg)?;
    let Some(shifted_date) = shift_date_by_months(base_date, months) else {
      return Ok(None);
    };
    return Ok(Some(shifted_date.to_string()));
  }

  if let Some((start_date_arg, month_arg)) = parse_eomonth_formula(formula) {
    let start_date = parse_date_operand(connection, sheet, &start_date_arg)?;
    let Some(base_date) = start_date else {
      return Ok(Some(String::new()));
    };
    let months = parse_required_integer(connection, sheet, &month_arg)?;
    let Some((target_year, target_month)) =
      shift_year_month(base_date.year(), base_date.month(), months)
    else {
      return Ok(None);
    };
    let Some(next_month_start) = shift_year_month(target_year, target_month, 1)
      .and_then(|(year, month)| NaiveDate::from_ymd_opt(year, month, 1))
    else {
      return Ok(None);
    };
    let end_of_month = next_month_start - Duration::days(1);
    return Ok(Some(end_of_month.to_string()));
  }

  if let Some((end_date_arg, start_date_arg)) = parse_days_formula(formula) {
    let end_date = parse_date_operand(connection, sheet, &end_date_arg)?;
    let start_date = parse_date_operand(connection, sheet, &start_date_arg)?;
    let (Some(end_value), Some(start_value)) = (end_date, start_date) else {
      return Ok(Some(String::new()));
    };
    let delta_days = end_value.signed_duration_since(start_value).num_days();
    return Ok(Some(delta_days.to_string()));
  }

  if let Some((start_date_arg, end_date_arg, method_arg)) = parse_days360_formula(formula) {
    let start_date = parse_date_operand(connection, sheet, &start_date_arg)?;
    let end_date = parse_date_operand(connection, sheet, &end_date_arg)?;
    let (Some(start_value), Some(end_value)) = (start_date, end_date) else {
      return Ok(None);
    };
    let use_european_method = match method_arg {
      Some(raw_method) => {
        let method_value = resolve_scalar_operand(connection, sheet, &raw_method)?;
        resolve_truthy_operand(&method_value)
      }
      None => false,
    };
    let days360 = days360_diff(start_value, end_value, use_european_method);
    return Ok(Some(days360.to_string()));
  }

  if let Some(date_value_arg) = parse_datevalue_formula(formula) {
    let parsed_date = parse_date_operand(connection, sheet, &date_value_arg)?;
    let Some(date_value) = parsed_date else {
      return Ok(None);
    };
    return Ok(Some(excel_serial_from_date(date_value).to_string()));
  }

  if let Some(time_value_arg) = parse_timevalue_formula(formula) {
    let parsed_time = parse_time_operand(connection, sheet, &time_value_arg)?;
    let Some(time_value) = parsed_time else {
      return Ok(None);
    };
    let elapsed_seconds = f64::from(time_value.num_seconds_from_midnight())
      + (f64::from(time_value.nanosecond()) / 1_000_000_000.0);
    let fraction = elapsed_seconds / 86_400.0;
    return Ok(Some(fraction.to_string()));
  }

  if let Some((hour_arg, minute_arg, second_arg)) = parse_time_formula(formula) {
    let hours = parse_required_integer(connection, sheet, &hour_arg)?;
    let minutes = parse_required_integer(connection, sheet, &minute_arg)?;
    let seconds = parse_required_integer(connection, sheet, &second_arg)?;
    if hours < 0 || minutes < 0 || seconds < 0 {
      return Ok(None);
    }
    let total_seconds = i64::from(hours) * 3_600
      + i64::from(minutes) * 60
      + i64::from(seconds);
    let normalized_seconds = total_seconds.rem_euclid(86_400) as f64;
    return Ok(Some((normalized_seconds / 86_400.0).to_string()));
  }

  if let Some((start_date_arg, end_date_arg, unit_arg)) = parse_datedif_formula(formula) {
    let start_date = parse_date_operand(connection, sheet, &start_date_arg)?;
    let end_date = parse_date_operand(connection, sheet, &end_date_arg)?;
    let (Some(start_value), Some(end_value)) = (start_date, end_date) else {
      return Ok(None);
    };
    if end_value < start_value {
      return Ok(None);
    }
    let unit = resolve_scalar_operand(connection, sheet, &unit_arg)?
      .trim()
      .to_uppercase();
    let value = match unit.as_str() {
      "D" => end_value.signed_duration_since(start_value).num_days(),
      "Y" => i64::from(datedif_complete_years(start_value, end_value)),
      "M" => i64::from(datedif_complete_months(start_value, end_value)),
      "YM" => i64::from(datedif_complete_months(start_value, end_value) % 12),
      "YD" => match datedif_year_days(start_value, end_value) {
        Some(days) => i64::from(days),
        None => return Ok(None),
      },
      "MD" => match datedif_month_days(start_value, end_value) {
        Some(days) => i64::from(days),
        None => return Ok(None),
      },
      _ => return Ok(None),
    };
    return Ok(Some(value.to_string()));
  }

  if let Some((start_date_arg, end_date_arg, holidays_arg)) =
    parse_networkdays_formula(formula)
  {
    let start_date = parse_date_operand(connection, sheet, &start_date_arg)?;
    let end_date = parse_date_operand(connection, sheet, &end_date_arg)?;
    let (Some(start_value), Some(end_value)) = (start_date, end_date) else {
      return Ok(None);
    };
    let holiday_dates = match holidays_arg {
      Some(raw_holidays) => match collect_holiday_dates(connection, sheet, &raw_holidays)? {
        Some(values) => values,
        None => return Ok(None),
      },
      None => HashSet::new(),
    };
    let weekend_mask = default_weekend_mask();
    let networkdays = count_networkdays(start_value, end_value, &holiday_dates, &weekend_mask);
    return Ok(Some(networkdays.to_string()));
  }

  if let Some((start_date_arg, day_offset_arg, holidays_arg)) =
    parse_workday_formula(formula)
  {
    let start_date = parse_date_operand(connection, sheet, &start_date_arg)?;
    let Some(start_value) = start_date else {
      return Ok(None);
    };
    let day_offset = parse_required_integer(connection, sheet, &day_offset_arg)?;
    let holiday_dates = match holidays_arg {
      Some(raw_holidays) => match collect_holiday_dates(connection, sheet, &raw_holidays)? {
        Some(values) => values,
        None => return Ok(None),
      },
      None => HashSet::new(),
    };
    let weekend_mask = default_weekend_mask();
    let result_date = workday_shift(start_value, day_offset, &holiday_dates, &weekend_mask);
    return Ok(Some(result_date.to_string()));
  }

  if let Some((start_date_arg, end_date_arg, weekend_arg, holidays_arg)) =
    parse_networkdays_intl_formula(formula)
  {
    let start_date = parse_date_operand(connection, sheet, &start_date_arg)?;
    let end_date = parse_date_operand(connection, sheet, &end_date_arg)?;
    let (Some(start_value), Some(end_value)) = (start_date, end_date) else {
      return Ok(None);
    };
    let weekend_mask = match parse_weekend_mask(connection, sheet, weekend_arg)? {
      Some(mask) => mask,
      None => return Ok(None),
    };
    let holiday_dates = match holidays_arg {
      Some(raw_holidays) => match collect_holiday_dates(connection, sheet, &raw_holidays)? {
        Some(values) => values,
        None => return Ok(None),
      },
      None => HashSet::new(),
    };
    let networkdays =
      count_networkdays(start_value, end_value, &holiday_dates, &weekend_mask);
    return Ok(Some(networkdays.to_string()));
  }

  if let Some((start_date_arg, day_offset_arg, weekend_arg, holidays_arg)) =
    parse_workday_intl_formula(formula)
  {
    let start_date = parse_date_operand(connection, sheet, &start_date_arg)?;
    let Some(start_value) = start_date else {
      return Ok(None);
    };
    let day_offset = parse_required_integer(connection, sheet, &day_offset_arg)?;
    let weekend_mask = match parse_weekend_mask(connection, sheet, weekend_arg)? {
      Some(mask) => mask,
      None => return Ok(None),
    };
    let holiday_dates = match holidays_arg {
      Some(raw_holidays) => match collect_holiday_dates(connection, sheet, &raw_holidays)? {
        Some(values) => values,
        None => return Ok(None),
      },
      None => HashSet::new(),
    };
    let result_date = workday_shift(start_value, day_offset, &holiday_dates, &weekend_mask);
    return Ok(Some(result_date.to_string()));
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

  if let Some((date_arg, return_type_arg)) = parse_weekday_formula(formula) {
    let date = parse_date_operand(connection, sheet, &date_arg)?;
    let Some(date_value) = date else {
      return Ok(Some(String::new()));
    };
    let return_type = match return_type_arg {
      Some(raw_type) => parse_required_integer(connection, sheet, &raw_type)?,
      None => 1,
    };
    let weekday = match return_type {
      1 => date_value.weekday().num_days_from_sunday() + 1,
      2 => date_value.weekday().num_days_from_monday() + 1,
      3 => date_value.weekday().num_days_from_monday(),
      11..=17 => {
        let weekday_monday = date_value.weekday().num_days_from_monday();
        let start_day = u32::try_from(return_type - 11).unwrap_or_default();
        ((weekday_monday + 7 - start_day) % 7) + 1
      }
      _ => return Ok(None),
    };
    return Ok(Some(weekday.to_string()));
  }

  if let Some((date_arg, return_type_arg)) = parse_weeknum_formula(formula) {
    let date = parse_date_operand(connection, sheet, &date_arg)?;
    let Some(date_value) = date else {
      return Ok(Some(String::new()));
    };
    let return_type = match return_type_arg {
      Some(raw_type) => parse_required_integer(connection, sheet, &raw_type)?,
      None => 1,
    };
    let week_number = if return_type == 21 {
      date_value.iso_week().week()
    } else {
      let year_start = NaiveDate::from_ymd_opt(date_value.year(), 1, 1)
        .ok_or_else(|| ApiError::internal("Invalid year for WEEKNUM".to_string()))?;
      let start_day = match return_type {
        1 | 17 => 6u32,
        2 | 11 => 0u32,
        12 => 1u32,
        13 => 2u32,
        14 => 3u32,
        15 => 4u32,
        16 => 5u32,
        _ => return Ok(None),
      };
      let year_start_weekday = year_start.weekday().num_days_from_monday();
      let day_offset = (7 + year_start_weekday - start_day) % 7;
      ((date_value.ordinal() + day_offset - 1) / 7) + 1
    };
    return Ok(Some(week_number.to_string()));
  }

  if let Some(date_arg) = parse_isoweeknum_formula(formula) {
    let date = parse_date_operand(connection, sheet, &date_arg)?;
    let Some(date_value) = date else {
      return Ok(Some(String::new()));
    };
    return Ok(Some(date_value.iso_week().week().to_string()));
  }

  if let Some(hour_arg) = parse_hour_formula(formula) {
    let time = parse_time_operand(connection, sheet, &hour_arg)?;
    return Ok(Some(time.map(|value| value.hour().to_string()).unwrap_or_default()));
  }

  if let Some(minute_arg) = parse_minute_formula(formula) {
    let time = parse_time_operand(connection, sheet, &minute_arg)?;
    return Ok(Some(
      time.map(|value| value.minute().to_string()).unwrap_or_default(),
    ));
  }

  if let Some(second_arg) = parse_second_formula(formula) {
    let time = parse_time_operand(connection, sheet, &second_arg)?;
    return Ok(Some(
      time.map(|value| value.second().to_string()).unwrap_or_default(),
    ));
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

fn collect_numeric_range_values(
  connection: &Connection,
  sheet: &str,
  start: (u32, u32),
  end: (u32, u32),
) -> Result<Vec<f64>, ApiError> {
  let bounds = normalized_range_bounds(start, end);
  let mut values = Vec::new();
  for row_offset in 0..bounds.height {
    for col_offset in 0..bounds.width {
      let row_index = bounds.start_row + row_offset;
      let col_index = bounds.start_col + col_offset;
      let value = load_cell_scalar(connection, sheet, row_index, col_index)?;
      if let Ok(parsed) = value.trim().parse::<f64>() {
        values.push(parsed);
      }
    }
  }
  Ok(values)
}

fn collect_statisticala_range_values(
  connection: &Connection,
  sheet: &str,
  start: (u32, u32),
  end: (u32, u32),
) -> Result<Vec<f64>, ApiError> {
  let bounds = normalized_range_bounds(start, end);
  let mut statement = connection
    .prepare(
      "SELECT COALESCE(evaluated_value, raw_value) FROM cells WHERE sheet = ?1 AND row_index BETWEEN ?2 AND ?3 AND col_index BETWEEN ?4 AND ?5",
    )
    .map_err(ApiError::internal)?;
  let rows = statement
    .query_map(
      params![
        sheet,
        i64::from(bounds.start_row),
        i64::from(bounds.start_row + bounds.height.saturating_sub(1)),
        i64::from(bounds.start_col),
        i64::from(bounds.start_col + bounds.width.saturating_sub(1))
      ],
      |row| row.get::<_, Option<String>>(0),
    )
    .map_err(ApiError::internal)?;

  let mut values = Vec::new();
  for value_result in rows {
    let raw_value = value_result.map_err(ApiError::internal)?.unwrap_or_default();
    let trimmed = raw_value.trim();
    if let Ok(parsed) = trimmed.parse::<f64>() {
      values.push(parsed);
    } else if trimmed.eq_ignore_ascii_case("TRUE") {
      values.push(1.0);
    } else {
      values.push(0.0);
    }
  }

  Ok(values)
}

fn collect_numeric_pairs_from_ranges(
  connection: &Connection,
  sheet: &str,
  left_start: (u32, u32),
  left_end: (u32, u32),
  right_start: (u32, u32),
  right_end: (u32, u32),
) -> Result<Option<Vec<(f64, f64)>>, ApiError> {
  let left_bounds = normalized_range_bounds(left_start, left_end);
  let right_bounds = normalized_range_bounds(right_start, right_end);
  if left_bounds.width != right_bounds.width
    || left_bounds.height != right_bounds.height
  {
    return Ok(None);
  }

  let mut pairs = Vec::new();
  for row_offset in 0..left_bounds.height {
    for col_offset in 0..left_bounds.width {
      let left_row = left_bounds.start_row + row_offset;
      let left_col = left_bounds.start_col + col_offset;
      let right_row = right_bounds.start_row + row_offset;
      let right_col = right_bounds.start_col + col_offset;
      let left_value = load_cell_scalar(connection, sheet, left_row, left_col)?;
      let right_value = load_cell_scalar(connection, sheet, right_row, right_col)?;
      if let (Ok(left_number), Ok(right_number)) = (
        left_value.trim().parse::<f64>(),
        right_value.trim().parse::<f64>(),
      ) {
        pairs.push((left_number, right_number));
      }
    }
  }

  Ok(Some(pairs))
}

fn compute_pair_deviation_sums(pairs: &[(f64, f64)]) -> Option<(f64, f64, f64, f64, f64)> {
  if pairs.is_empty() {
    return None;
  }
  let count = pairs.len() as f64;
  let mean_x = pairs.iter().map(|pair| pair.0).sum::<f64>() / count;
  let mean_y = pairs.iter().map(|pair| pair.1).sum::<f64>() / count;
  let sum_xy = pairs
    .iter()
    .map(|pair| (pair.0 - mean_x) * (pair.1 - mean_y))
    .sum::<f64>();
  let sum_xx = pairs
    .iter()
    .map(|pair| {
      let delta = pair.0 - mean_x;
      delta * delta
    })
    .sum::<f64>();
  let sum_yy = pairs
    .iter()
    .map(|pair| {
      let delta = pair.1 - mean_y;
      delta * delta
    })
    .sum::<f64>();
  Some((mean_x, mean_y, sum_xy, sum_xx, sum_yy))
}

fn interpolate_percentile_from_sorted_values(
  sorted_values: &[f64],
  percentile: f64,
) -> Option<f64> {
  if sorted_values.is_empty() {
    return None;
  }
  if sorted_values.len() == 1 {
    return Some(sorted_values[0]);
  }

  let position = percentile * (sorted_values.len() as f64 - 1.0);
  let lower_index = position.floor() as usize;
  let upper_index = position.ceil() as usize;
  if lower_index >= sorted_values.len() || upper_index >= sorted_values.len() {
    return None;
  }
  if lower_index == upper_index {
    return Some(sorted_values[lower_index]);
  }
  let fraction = position - lower_index as f64;
  Some(
    sorted_values[lower_index]
      + (sorted_values[upper_index] - sorted_values[lower_index]) * fraction,
  )
}

fn interpolate_percentile_exc_from_sorted_values(
  sorted_values: &[f64],
  percentile: f64,
) -> Option<f64> {
  if sorted_values.len() < 2 {
    return None;
  }

  let count = sorted_values.len() as f64;
  let min_percentile = 1.0 / (count + 1.0);
  let max_percentile = count / (count + 1.0);
  if percentile < min_percentile || percentile > max_percentile {
    return None;
  }

  let position = percentile * (count + 1.0) - 1.0;
  let lower_index = position.floor() as usize;
  let upper_index = position.ceil() as usize;
  if lower_index >= sorted_values.len() || upper_index >= sorted_values.len() {
    return None;
  }

  if lower_index == upper_index {
    return Some(sorted_values[lower_index]);
  }
  let fraction = position - lower_index as f64;
  Some(
    sorted_values[lower_index]
      + (sorted_values[upper_index] - sorted_values[lower_index]) * fraction,
  )
}

fn interpolate_sorted_position(sorted_values: &[f64], target: f64) -> Option<f64> {
  if sorted_values.len() < 2 {
    return None;
  }

  let first = *sorted_values.first()?;
  let last = *sorted_values.last()?;
  if target < first || target > last {
    return None;
  }

  if (target - first).abs() < f64::EPSILON {
    return Some(0.0);
  }
  if (target - last).abs() < f64::EPSILON {
    return Some((sorted_values.len() - 1) as f64);
  }

  for index in 0..(sorted_values.len() - 1) {
    let left = sorted_values[index];
    let right = sorted_values[index + 1];

    if target < left || target > right {
      continue;
    }

    if (target - left).abs() < f64::EPSILON {
      return Some(index as f64);
    }
    if (target - right).abs() < f64::EPSILON {
      return Some((index + 1) as f64);
    }

    if (right - left).abs() < f64::EPSILON {
      continue;
    }

    let fraction = (target - left) / (right - left);
    return Some(index as f64 + fraction);
  }

  None
}

fn round_to_significance(value: f64, significance: Option<u32>) -> Option<f64> {
  let Some(digits_u32) = significance else {
    return Some(value);
  };
  if digits_u32 == 0 {
    return None;
  }
  let digits = i32::try_from(digits_u32).ok()?;
  let scale = 10f64.powi(digits);
  Some((value * scale).round() / scale)
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

fn evaluate_minifs_formula(
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

  let mut minimum_value: Option<f64> = None;
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
        minimum_value = Some(match minimum_value {
          Some(existing) => existing.min(number),
          None => number,
        });
      }
    }
  }

  Ok(Some(minimum_value.unwrap_or(0.0).to_string()))
}

fn evaluate_maxifs_formula(
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

  let mut maximum_value: Option<f64> = None;
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
        maximum_value = Some(match maximum_value {
          Some(existing) => existing.max(number),
          None => number,
        });
      }
    }
  }

  Ok(Some(maximum_value.unwrap_or(0.0).to_string()))
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

  if let Some(xor_args) = parse_xor_formula(&normalized) {
    let true_count = xor_args
      .iter()
      .map(|arg| evaluate_if_condition(connection, sheet, arg))
      .collect::<Result<Vec<bool>, ApiError>>()?
      .into_iter()
      .filter(|value| *value)
      .count();
    return Ok(Some(true_count % 2 == 1));
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

fn resolve_textjoin_argument_values(
  connection: &Connection,
  sheet: &str,
  operand: &str,
) -> Result<Vec<String>, ApiError> {
  if let Some((start, end)) = parse_operand_range_bounds(operand) {
    let bounds = normalized_range_bounds(start, end);
    let mut values = Vec::new();
    for row_offset in 0..bounds.height {
      for col_offset in 0..bounds.width {
        values.push(load_cell_scalar(
          connection,
          sheet,
          bounds.start_row + row_offset,
          bounds.start_col + col_offset,
        )?);
      }
    }
    return Ok(values);
  }
  Ok(vec![resolve_scalar_operand(connection, sheet, operand)?])
}

fn parse_operand_range_bounds(operand: &str) -> Option<((u32, u32), (u32, u32))> {
  let normalized = operand.trim().replace('$', "");
  let (start, end) = normalized.split_once(':')?;
  let start_ref = parse_cell_address(start.trim())?;
  let end_ref = parse_cell_address(end.trim())?;
  Some((start_ref, end_ref))
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

fn replace_nth_occurrence(
  text: &str,
  from: &str,
  to: &str,
  instance: usize,
) -> String {
  if instance == 0 {
    return text.to_string();
  }

  let mut seen = 0usize;
  for (byte_index, matched) in text.match_indices(from) {
    if matched.is_empty() {
      continue;
    }
    seen += 1;
    if seen == instance {
      let prefix = &text[..byte_index];
      let suffix_start = byte_index + matched.len();
      let suffix = &text[suffix_start..];
      return format!("{prefix}{to}{suffix}");
    }
  }

  text.to_string()
}

fn gcd_u64(mut left: u64, mut right: u64) -> u64 {
  while right != 0 {
    let remainder = left % right;
    left = right;
    right = remainder;
  }
  left
}

fn int_to_roman(value: u32) -> Option<String> {
  if !(1..=3999).contains(&value) {
    return None;
  }

  let mut remaining = value;
  let mut output = String::new();
  let symbols: [(u32, &str); 13] = [
    (1000, "M"),
    (900, "CM"),
    (500, "D"),
    (400, "CD"),
    (100, "C"),
    (90, "XC"),
    (50, "L"),
    (40, "XL"),
    (10, "X"),
    (9, "IX"),
    (5, "V"),
    (4, "IV"),
    (1, "I"),
  ];

  for (magnitude, symbol) in symbols {
    while remaining >= magnitude {
      output.push_str(symbol);
      remaining -= magnitude;
    }
  }

  Some(output)
}

fn roman_to_int(value: &str) -> Option<u32> {
  let trimmed = value.trim().to_uppercase();
  if trimmed.is_empty() {
    return None;
  }
  let bytes = trimmed.as_bytes();
  let mut index = 0usize;
  let mut total: u32 = 0;

  while index < bytes.len() {
    let current = roman_char_value(bytes[index] as char)?;
    if index + 1 < bytes.len() {
      let next = roman_char_value(bytes[index + 1] as char)?;
      if current < next {
        total = total.checked_add(next - current)?;
        index += 2;
        continue;
      }
    }
    total = total.checked_add(current)?;
    index += 1;
  }

  if !(1..=3999).contains(&total) {
    return None;
  }

  let canonical = int_to_roman(total)?;
  if canonical == trimmed {
    return Some(total);
  }
  None
}

fn roman_char_value(value: char) -> Option<u32> {
  match value {
    'I' => Some(1),
    'V' => Some(5),
    'X' => Some(10),
    'L' => Some(50),
    'C' => Some(100),
    'D' => Some(500),
    'M' => Some(1000),
    _ => None,
  }
}

fn ceiling_math(value: f64, significance: f64, mode: i32) -> f64 {
  let significance_abs = significance.abs();
  if significance_abs < f64::EPSILON {
    return 0.0;
  }
  let quotient = value / significance_abs;
  let rounded_multiplier = if value.is_sign_negative() && mode != 0 {
    quotient.floor()
  } else {
    quotient.ceil()
  };
  rounded_multiplier * significance_abs
}

fn floor_math(value: f64, significance: f64, mode: i32) -> f64 {
  let significance_abs = significance.abs();
  if significance_abs < f64::EPSILON {
    return 0.0;
  }
  let quotient = value / significance_abs;
  let rounded_multiplier = if value.is_sign_negative() && mode != 0 {
    quotient.ceil()
  } else {
    quotient.floor()
  };
  rounded_multiplier * significance_abs
}

fn lcm_u64(left: u64, right: u64) -> Result<u64, ApiError> {
  if left == 0 || right == 0 {
    return Ok(0);
  }
  let divisor = gcd_u64(left, right);
  let scaled = left / divisor;
  scaled
    .checked_mul(right)
    .ok_or_else(|| ApiError::internal("LCM overflow".to_string()))
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

fn parse_required_float(
  connection: &Connection,
  sheet: &str,
  operand: &str,
) -> Result<f64, ApiError> {
  let resolved = resolve_scalar_operand(connection, sheet, operand)?;
  Ok(resolved.trim().parse::<f64>().unwrap_or_default())
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

fn shift_year_month(
  year: i32,
  month: u32,
  months_delta: i32,
) -> Option<(i32, u32)> {
  if !(1..=12).contains(&month) {
    return None;
  }
  let month_index = year
    .checked_mul(12)?
    .checked_add(i32::try_from(month).ok()?)?
    .checked_sub(1)?
    .checked_add(months_delta)?;
  let shifted_year = month_index.div_euclid(12);
  let shifted_month = month_index.rem_euclid(12) + 1;
  Some((shifted_year, shifted_month as u32))
}

fn shift_date_by_months(date: NaiveDate, months_delta: i32) -> Option<NaiveDate> {
  let (shifted_year, shifted_month) =
    shift_year_month(date.year(), date.month(), months_delta)?;
  let month_start = NaiveDate::from_ymd_opt(shifted_year, shifted_month, 1)?;
  let (next_year, next_month) = shift_year_month(shifted_year, shifted_month, 1)?;
  let next_month_start = NaiveDate::from_ymd_opt(next_year, next_month, 1)?;
  let month_end = next_month_start - Duration::days(1);
  let clamped_day = date.day().min(month_end.day());
  NaiveDate::from_ymd_opt(month_start.year(), month_start.month(), clamped_day)
}

fn datedif_complete_years(start: NaiveDate, end: NaiveDate) -> u32 {
  let mut years = end.year().saturating_sub(start.year());
  if (end.month(), end.day()) < (start.month(), start.day()) {
    years = years.saturating_sub(1);
  }
  years as u32
}

fn datedif_complete_months(start: NaiveDate, end: NaiveDate) -> u32 {
  let mut months = (end.year().saturating_sub(start.year()) * 12)
    + (end.month() as i32 - start.month() as i32);
  if end.day() < start.day() {
    months = months.saturating_sub(1);
  }
  months.max(0) as u32
}

fn datedif_year_days(start: NaiveDate, end: NaiveDate) -> Option<u32> {
  let mut anchor = date_with_clamped_day(end.year(), start.month(), start.day())?;
  if anchor > end {
    anchor = date_with_clamped_day(end.year().saturating_sub(1), start.month(), start.day())?;
  }
  let days = end.signed_duration_since(anchor).num_days();
  Some(days.max(0) as u32)
}

fn datedif_month_days(start: NaiveDate, end: NaiveDate) -> Option<u32> {
  if end.day() >= start.day() {
    return Some(end.day() - start.day());
  }
  let (prev_year, prev_month) = shift_year_month(end.year(), end.month(), -1)?;
  let previous_month_end = date_with_clamped_day(prev_year, prev_month, 31)?;
  Some(end.day() + previous_month_end.day() - start.day())
}

fn date_with_clamped_day(year: i32, month: u32, day: u32) -> Option<NaiveDate> {
  if !(1..=12).contains(&month) {
    return None;
  }
  let month_start = NaiveDate::from_ymd_opt(year, month, 1)?;
  let (next_year, next_month) = shift_year_month(year, month, 1)?;
  let next_month_start = NaiveDate::from_ymd_opt(next_year, next_month, 1)?;
  let month_end = next_month_start - Duration::days(1);
  let clamped_day = day.min(month_end.day()).max(month_start.day());
  NaiveDate::from_ymd_opt(year, month, clamped_day)
}

fn days360_diff(start: NaiveDate, end: NaiveDate, use_european_method: bool) -> i64 {
  let mut start_day = start.day() as i32;
  let mut end_day = end.day() as i32;
  let start_month = start.month() as i32;
  let start_year = start.year();
  let mut end_month = end.month() as i32;
  let mut end_year = end.year();

  if use_european_method {
    if start_day == 31 {
      start_day = 30;
    }
    if end_day == 31 {
      end_day = 30;
    }
  } else {
    if start_day == 31 || is_last_day_of_february(start) {
      start_day = 30;
    }
    if end_day == 31 || is_last_day_of_february(end) {
      if start_day < 30 {
        end_day = 1;
        if end_month == 12 {
          end_month = 1;
          end_year += 1;
        } else {
          end_month += 1;
        }
      } else {
        end_day = 30;
      }
    }
  }

  i64::from((end_year - start_year) * 360 + (end_month - start_month) * 30 + (end_day - start_day))
}

fn is_last_day_of_february(date: NaiveDate) -> bool {
  if date.month() != 2 {
    return false;
  }
  let Some(next_day) = date.checked_add_signed(Duration::days(1)) else {
    return false;
  };
  next_day.month() != 2
}

fn excel_serial_origin() -> Option<NaiveDate> {
  NaiveDate::from_ymd_opt(1899, 12, 30)
}

fn excel_serial_from_date(date: NaiveDate) -> i64 {
  let Some(origin) = excel_serial_origin() else {
    return 0;
  };
  date.signed_duration_since(origin).num_days()
}

fn excel_serial_to_date(serial: f64) -> Option<NaiveDate> {
  let Some(origin) = excel_serial_origin() else {
    return None;
  };
  if !serial.is_finite() {
    return None;
  }
  let whole_days = serial.trunc() as i64;
  origin.checked_add_signed(Duration::days(whole_days))
}

fn excel_serial_to_time(serial: f64) -> Option<NaiveTime> {
  if !serial.is_finite() {
    return None;
  }
  let fraction = serial.rem_euclid(1.0);
  let total_nanos = (fraction * 86_400_000_000_000.0).round() as i64;
  let normalized_nanos = total_nanos.rem_euclid(86_400_000_000_000);
  let seconds = normalized_nanos.div_euclid(1_000_000_000);
  let nanos = normalized_nanos.rem_euclid(1_000_000_000);
  NaiveTime::from_num_seconds_from_midnight_opt(seconds as u32, nanos as u32)
}

fn parse_date_text(value: &str) -> Option<NaiveDate> {
  let trimmed = value.trim();
  if trimmed.is_empty() {
    return None;
  }
  if let Ok(serial_value) = trimmed.parse::<f64>() {
    return excel_serial_to_date(serial_value);
  }
  if let Ok(parsed) = NaiveDate::parse_from_str(trimmed, "%Y-%m-%d") {
    return Some(parsed);
  }
  if let Ok(parsed) = DateTime::parse_from_rfc3339(trimmed) {
    return Some(parsed.date_naive());
  }
  if let Ok(parsed) = NaiveDateTime::parse_from_str(trimmed, "%Y-%m-%d %H:%M:%S") {
    return Some(parsed.date());
  }
  if let Ok(parsed) = NaiveDateTime::parse_from_str(trimmed, "%Y-%m-%dT%H:%M:%S") {
    return Some(parsed.date());
  }
  NaiveDate::parse_from_str(trimmed, "%m/%d/%Y").ok()
}

fn parse_date_operand(
  connection: &Connection,
  sheet: &str,
  operand: &str,
) -> Result<Option<NaiveDate>, ApiError> {
  let resolved = resolve_scalar_operand(connection, sheet, operand)?;
  Ok(parse_date_text(&resolved))
}

fn parse_time_operand(
  connection: &Connection,
  sheet: &str,
  operand: &str,
) -> Result<Option<NaiveTime>, ApiError> {
  let resolved = resolve_scalar_operand(connection, sheet, operand)?;
  let trimmed = resolved.trim();
  if trimmed.is_empty() {
    return Ok(None);
  }

  if let Ok(serial_value) = trimmed.parse::<f64>() {
    return Ok(excel_serial_to_time(serial_value));
  }

  if let Ok(parsed) = DateTime::parse_from_rfc3339(trimmed) {
    return Ok(Some(parsed.time()));
  }
  if let Ok(parsed) = NaiveDateTime::parse_from_str(trimmed, "%Y-%m-%d %H:%M:%S")
  {
    return Ok(Some(parsed.time()));
  }
  if let Ok(parsed) = NaiveDateTime::parse_from_str(trimmed, "%Y-%m-%dT%H:%M:%S")
  {
    return Ok(Some(parsed.time()));
  }
  if let Ok(parsed) = NaiveTime::parse_from_str(trimmed, "%H:%M:%S") {
    return Ok(Some(parsed));
  }
  if let Ok(parsed) = NaiveTime::parse_from_str(trimmed, "%H:%M") {
    return Ok(Some(parsed));
  }
  if NaiveDate::parse_from_str(trimmed, "%Y-%m-%d").is_ok()
    || NaiveDate::parse_from_str(trimmed, "%m/%d/%Y").is_ok()
  {
    return Ok(NaiveTime::from_hms_opt(0, 0, 0));
  }

  Ok(None)
}

fn collect_holiday_dates(
  connection: &Connection,
  sheet: &str,
  operand: &str,
) -> Result<Option<HashSet<NaiveDate>>, ApiError> {
  if let Some((start, end)) = parse_operand_range_bounds(operand) {
    let bounds = normalized_range_bounds(start, end);
    let mut holidays = HashSet::new();
    for row_offset in 0..bounds.height {
      for col_offset in 0..bounds.width {
        let cell_value = load_cell_scalar(
          connection,
          sheet,
          bounds.start_row + row_offset,
          bounds.start_col + col_offset,
        )?;
        let trimmed = cell_value.trim();
        if trimmed.is_empty() {
          continue;
        }
        let Some(parsed_date) = parse_date_text(trimmed) else {
          return Ok(None);
        };
        holidays.insert(parsed_date);
      }
    }
    return Ok(Some(holidays));
  }

  let parsed = parse_date_operand(connection, sheet, operand)?;
  let Some(date_value) = parsed else {
    return Ok(None);
  };
  Ok(Some(HashSet::from([date_value])))
}

fn count_networkdays(
  start: NaiveDate,
  end: NaiveDate,
  holidays: &HashSet<NaiveDate>,
  weekend_mask: &[bool; 7],
) -> i64 {
  let (from, to, direction) = if start <= end {
    (start, end, 1i64)
  } else {
    (end, start, -1i64)
  };

  let mut current = from;
  let mut days = 0i64;
  while current <= to {
    if is_business_day(current, holidays, weekend_mask) {
      days += 1;
    }
    current += Duration::days(1);
  }

  days * direction
}

fn is_business_day(
  date: NaiveDate,
  holidays: &HashSet<NaiveDate>,
  weekend_mask: &[bool; 7],
) -> bool {
  let weekday = date.weekday().num_days_from_monday();
  let is_weekend = weekend_mask[weekday as usize];
  !is_weekend && !holidays.contains(&date)
}

fn workday_shift(
  start: NaiveDate,
  day_offset: i32,
  holidays: &HashSet<NaiveDate>,
  weekend_mask: &[bool; 7],
) -> NaiveDate {
  if day_offset == 0 {
    return start;
  }

  let mut current = start;
  let step = if day_offset > 0 { 1 } else { -1 };
  let mut remaining = day_offset.unsigned_abs();
  while remaining > 0 {
    current += Duration::days(step.into());
    if is_business_day(current, holidays, weekend_mask) {
      remaining -= 1;
    }
  }
  current
}

fn default_weekend_mask() -> [bool; 7] {
  [false, false, false, false, false, true, true]
}

fn parse_weekend_mask(
  connection: &Connection,
  sheet: &str,
  operand: Option<String>,
) -> Result<Option<[bool; 7]>, ApiError> {
  let Some(raw_operand) = operand else {
    return Ok(Some(default_weekend_mask()));
  };
  let resolved = resolve_scalar_operand(connection, sheet, &raw_operand)?;
  let trimmed = resolved.trim();
  if trimmed.is_empty() {
    return Ok(None);
  }

  if trimmed.len() == 7 && trimmed.chars().all(|ch| ch == '0' || ch == '1') {
    let mut weekend = [false; 7];
    for (index, ch) in trimmed.chars().enumerate() {
      weekend[index] = ch == '1';
    }
    if weekend.iter().all(|is_weekend| *is_weekend) {
      return Ok(None);
    }
    return Ok(Some(weekend));
  }

  let weekend_code = trimmed.parse::<i32>().ok();
  let Some(code) = weekend_code else {
    return Ok(None);
  };
  let mapped = match code {
    1 => [false, false, false, false, false, true, true],
    2 => [true, false, false, false, false, false, true],
    3 => [true, true, false, false, false, false, false],
    4 => [false, true, true, false, false, false, false],
    5 => [false, false, true, true, false, false, false],
    6 => [false, false, false, true, true, false, false],
    7 => [false, false, false, false, true, true, false],
    11 => [false, false, false, false, false, false, true],
    12 => [true, false, false, false, false, false, false],
    13 => [false, true, false, false, false, false, false],
    14 => [false, false, true, false, false, false, false],
    15 => [false, false, false, true, false, false, false],
    16 => [false, false, false, false, true, false, false],
    17 => [false, false, false, false, false, true, false],
    _ => return Ok(None),
  };
  Ok(Some(mapped))
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

fn evaluate_hlookup_formula(
  connection: &Connection,
  sheet: &str,
  formula: &HLookupFormula,
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
  let height = end_row.saturating_sub(start_row) + 1;
  if formula.result_row_index > height {
    return Ok(Some(String::new()));
  }

  let lookup_value = resolve_scalar_operand(connection, sheet, &formula.lookup_value)?;
  let lookup_numeric = lookup_value.parse::<f64>().ok();
  let target_row = start_row + formula.result_row_index - 1;

  for col_index in start_col..=end_col {
    let candidate = load_cell_scalar(connection, sheet, start_row, col_index)?;
    if !matches_lookup_value(&candidate, &lookup_value, lookup_numeric) {
      continue;
    }

    let resolved = load_cell_scalar(connection, sheet, target_row, col_index)?;
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
  use chrono::{DateTime, NaiveDate};
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
        row: 3,
        col: 1,
        value: Some(json!("\u{0007}ok")),
        formula: None,
      },
      CellMutation {
        row: 4,
        col: 1,
        value: Some(json!(120)),
        formula: None,
      },
      CellMutation {
        row: 5,
        col: 1,
        value: Some(json!(40)),
        formula: None,
      },
      CellMutation {
        row: 6,
        col: 1,
        value: Some(json!(200)),
        formula: None,
      },
      CellMutation {
        row: 10,
        col: 20,
        value: Some(json!(1)),
        formula: None,
      },
      CellMutation {
        row: 11,
        col: 20,
        value: Some(json!(2)),
        formula: None,
      },
      CellMutation {
        row: 12,
        col: 20,
        value: Some(json!(3)),
        formula: None,
      },
      CellMutation {
        row: 13,
        col: 20,
        value: Some(json!(4)),
        formula: None,
      },
      CellMutation {
        row: 14,
        col: 20,
        value: Some(json!(5)),
        formula: None,
      },
      CellMutation {
        row: 10,
        col: 21,
        value: Some(json!(2)),
        formula: None,
      },
      CellMutation {
        row: 11,
        col: 21,
        value: Some(json!(4)),
        formula: None,
      },
      CellMutation {
        row: 12,
        col: 21,
        value: Some(json!(5)),
        formula: None,
      },
      CellMutation {
        row: 10,
        col: 22,
        value: Some(json!(1)),
        formula: None,
      },
      CellMutation {
        row: 11,
        col: 22,
        value: Some(json!(2)),
        formula: None,
      },
      CellMutation {
        row: 12,
        col: 22,
        value: Some(json!(3)),
        formula: None,
      },
      CellMutation {
        row: 13,
        col: 22,
        value: Some(json!(4)),
        formula: None,
      },
      CellMutation {
        row: 14,
        col: 22,
        value: Some(json!(6)),
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
        row: 3,
        col: 5,
        value: Some(json!(true)),
        formula: None,
      },
      CellMutation {
        row: 4,
        col: 5,
        value: Some(json!(false)),
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
      CellMutation {
        row: 1,
        col: 46,
        value: None,
        formula: Some(r#"=HLOOKUP("Northeast",E1:F2,2,FALSE)"#.to_string()),
      },
      CellMutation {
        row: 1,
        col: 47,
        value: None,
        formula: Some(r#"=HLOOKUP("missing",E1:F2,2,FALSE)"#.to_string()),
      },
      CellMutation {
        row: 1,
        col: 48,
        value: None,
        formula: Some(r#"=CHOOSE(2,"alpha",E2,"gamma")"#.to_string()),
      },
      CellMutation {
        row: 1,
        col: 49,
        value: None,
        formula: Some(r#"=CHOOSE(5,"alpha","beta","gamma")"#.to_string()),
      },
      CellMutation {
        row: 1,
        col: 50,
        value: None,
        formula: Some("=ABS(-12.5)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 51,
        value: None,
        formula: Some("=ROUND(12.345,2)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 52,
        value: None,
        formula: Some("=ROUNDUP(12.301,1)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 53,
        value: None,
        formula: Some("=ROUNDDOWN(-12.399,1)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 54,
        value: None,
        formula: Some("=SQRT(81)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 55,
        value: None,
        formula: Some("=POWER(3,4)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 56,
        value: None,
        formula: Some("=SQRT(A2)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 57,
        value: None,
        formula: Some("=CEILING(12.31,0.25)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 58,
        value: None,
        formula: Some("=FLOOR(-12.31,0.25)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 59,
        value: None,
        formula: Some("=MOD(10,3)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 60,
        value: None,
        formula: Some("=SIGN(-12.5)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 61,
        value: None,
        formula: Some(r#"=MINIFS(A1:A2,E1:E2,"south",A1:A2,">=80")"#.to_string()),
      },
      CellMutation {
        row: 1,
        col: 62,
        value: None,
        formula: Some(r#"=MAXIFS(A1:A2,E1:E2,"south",A1:A2,">=80")"#.to_string()),
      },
      CellMutation {
        row: 1,
        col: 63,
        value: None,
        formula: Some("=INT(-12.5)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 64,
        value: None,
        formula: Some("=TRUNC(12.345,2)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 65,
        value: None,
        formula: Some(r#"=EXACT("North","north")"#.to_string()),
      },
      CellMutation {
        row: 1,
        col: 66,
        value: None,
        formula: Some(r#"=EXACT("north","north")"#.to_string()),
      },
      CellMutation {
        row: 1,
        col: 67,
        value: None,
        formula: Some("=XOR(A1>=100,A2>=100)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 68,
        value: None,
        formula: Some("=NOW()".to_string()),
      },
      CellMutation {
        row: 1,
        col: 69,
        value: None,
        formula: Some(r#"=HOUR("2026-02-13T14:25:36+00:00")"#.to_string()),
      },
      CellMutation {
        row: 1,
        col: 70,
        value: None,
        formula: Some(r#"=MINUTE("2026-02-13T14:25:36+00:00")"#.to_string()),
      },
      CellMutation {
        row: 1,
        col: 71,
        value: None,
        formula: Some(r#"=SECOND("2026-02-13T14:25:36+00:00")"#.to_string()),
      },
      CellMutation {
        row: 1,
        col: 72,
        value: None,
        formula: Some("=ISEVEN(A1)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 73,
        value: None,
        formula: Some("=ISODD(A2)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 74,
        value: None,
        formula: Some(r#"=MID("spreadsheet",2,5)"#.to_string()),
      },
      CellMutation {
        row: 1,
        col: 75,
        value: None,
        formula: Some(r#"=REPT("na",4)"#.to_string()),
      },
      CellMutation {
        row: 1,
        col: 76,
        value: None,
        formula: Some(r#"=SEARCH("sheet","spreadsheet")"#.to_string()),
      },
      CellMutation {
        row: 1,
        col: 77,
        value: None,
        formula: Some(r#"=SEARCH("E","Southeast",5)"#.to_string()),
      },
      CellMutation {
        row: 1,
        col: 78,
        value: None,
        formula: Some(r#"=FIND("sheet","spreadsheet")"#.to_string()),
      },
      CellMutation {
        row: 1,
        col: 79,
        value: None,
        formula: Some(r#"=FIND("e","Southeast",5)"#.to_string()),
      },
      CellMutation {
        row: 1,
        col: 80,
        value: None,
        formula: Some(r#"=REPLACE("spreadsheet",1,6,"work")"#.to_string()),
      },
      CellMutation {
        row: 1,
        col: 81,
        value: None,
        formula: Some(r#"=SUBSTITUTE("north-north","north","south")"#.to_string()),
      },
      CellMutation {
        row: 1,
        col: 82,
        value: None,
        formula: Some(
          r#"=SUBSTITUTE("north-north-north","north","south",2)"#.to_string(),
        ),
      },
      CellMutation {
        row: 1,
        col: 83,
        value: None,
        formula: Some(r#"=VALUE("12.34")"#.to_string()),
      },
      CellMutation {
        row: 1,
        col: 84,
        value: None,
        formula: Some("=CHAR(65)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 85,
        value: None,
        formula: Some(r#"=CODE("Apple")"#.to_string()),
      },
      CellMutation {
        row: 1,
        col: 86,
        value: None,
        formula: Some("=TRUE()".to_string()),
      },
      CellMutation {
        row: 1,
        col: 87,
        value: None,
        formula: Some("=FALSE()".to_string()),
      },
      CellMutation {
        row: 1,
        col: 88,
        value: None,
        formula: Some("=N(A1)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 89,
        value: None,
        formula: Some("=T(E1)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 90,
        value: None,
        formula: Some("=N(E1)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 91,
        value: None,
        formula: Some("=T(A1)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 92,
        value: None,
        formula: Some("=UNICHAR(9731)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 93,
        value: None,
        formula: Some(r#"=UNICODE("⚡")"#.to_string()),
      },
      CellMutation {
        row: 1,
        col: 94,
        value: None,
        formula: Some("=PI()".to_string()),
      },
      CellMutation {
        row: 1,
        col: 95,
        value: None,
        formula: Some("=LN(1)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 96,
        value: None,
        formula: Some("=LOG10(1000)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 97,
        value: None,
        formula: Some("=SIN(0)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 98,
        value: None,
        formula: Some("=COS(0)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 99,
        value: None,
        formula: Some("=TAN(0)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 100,
        value: None,
        formula: Some("=ASIN(0)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 101,
        value: None,
        formula: Some("=ACOS(1)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 102,
        value: None,
        formula: Some("=ATAN(1)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 103,
        value: None,
        formula: Some("=ATAN2(0,1)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 104,
        value: None,
        formula: Some("=DEGREES(3.141592653589793)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 105,
        value: None,
        formula: Some("=RADIANS(180)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 106,
        value: None,
        formula: Some("=EXP(1)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 107,
        value: None,
        formula: Some("=LOG(100,10)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 108,
        value: None,
        formula: Some("=SINH(0)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 109,
        value: None,
        formula: Some("=COSH(0)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 110,
        value: None,
        formula: Some("=TANH(0)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 111,
        value: None,
        formula: Some("=FACT(5)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 112,
        value: None,
        formula: Some("=COMBIN(5,2)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 113,
        value: None,
        formula: Some("=GCD(24,36)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 114,
        value: None,
        formula: Some("=LCM(12,18)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 115,
        value: None,
        formula: Some("=COUNTA(A1:A3)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 116,
        value: None,
        formula: Some("=COUNTBLANK(A1:A3)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 117,
        value: None,
        formula: Some("=EVEN(-1.2)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 118,
        value: None,
        formula: Some("=ODD(1.2)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 119,
        value: None,
        formula: Some("=QUOTIENT(9,4)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 120,
        value: None,
        formula: Some("=MROUND(11,2)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 121,
        value: None,
        formula: Some("=SUMPRODUCT(A1:A2,A1:A2)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 122,
        value: None,
        formula: Some("=SUMPRODUCT(A1:A2)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 123,
        value: None,
        formula: Some("=SUMSQ(A1:A2)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 124,
        value: None,
        formula: Some("=PRODUCT(A1:A2)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 125,
        value: None,
        formula: Some("=ROW(B7:C9)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 126,
        value: None,
        formula: Some("=COLUMN(AB3:AD3)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 127,
        value: None,
        formula: Some("=ROWS(A1:C3)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 128,
        value: None,
        formula: Some("=COLUMNS(A1:C3)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 129,
        value: None,
        formula: Some("=MEDIAN(A1:A2)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 130,
        value: None,
        formula: Some("=LARGE(A1:A2,1)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 131,
        value: None,
        formula: Some("=SMALL(A1:A2,1)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 132,
        value: None,
        formula: Some("=WEEKDAY(L1)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 133,
        value: None,
        formula: Some("=WEEKDAY(L1,2)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 134,
        value: None,
        formula: Some("=WEEKNUM(L1)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 135,
        value: None,
        formula: Some("=WEEKNUM(L1,2)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 136,
        value: None,
        formula: Some("=RAND()".to_string()),
      },
      CellMutation {
        row: 1,
        col: 137,
        value: None,
        formula: Some("=RANDBETWEEN(1,6)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 138,
        value: None,
        formula: Some("=RANK(A1,A1:A2,0)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 139,
        value: None,
        formula: Some("=RANK(A2,A1:A2,1)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 140,
        value: None,
        formula: Some("=STDEV.P(A1:A2)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 141,
        value: None,
        formula: Some("=STDEV.S(A1:A2)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 142,
        value: None,
        formula: Some("=VAR.P(A1:A2)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 143,
        value: None,
        formula: Some("=VAR.S(A1:A2)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 144,
        value: None,
        formula: Some("=PERCENTILE.INC(A1:A2,0.25)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 145,
        value: None,
        formula: Some("=QUARTILE.INC(A1:A2,3)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 146,
        value: None,
        formula: Some("=PERCENTRANK.INC(A1:A2,120)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 147,
        value: None,
        formula: Some("=PERCENTRANK.EXC(A1:A2,120)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 148,
        value: None,
        formula: Some("=PERCENTILE.EXC(A1:A2,0.5)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 149,
        value: None,
        formula: Some("=QUARTILE.EXC(A1:A2,2)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 150,
        value: None,
        formula: Some("=MODE.SNGL(A1:A4)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 151,
        value: None,
        formula: Some("=GEOMEAN(A1:A2)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 152,
        value: None,
        formula: Some("=HARMEAN(A1:A2)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 153,
        value: None,
        formula: Some("=TRIMMEAN(A1:A6,0.4)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 154,
        value: None,
        formula: Some("=DEVSQ(A1:A2)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 155,
        value: None,
        formula: Some("=AVEDEV(A1:A2)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 156,
        value: None,
        formula: Some("=STDEV(A1:A2)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 157,
        value: None,
        formula: Some("=STDEVP(A1:A2)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 158,
        value: None,
        formula: Some("=VAR(A1:A2)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 159,
        value: None,
        formula: Some("=VARP(A1:A2)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 160,
        value: None,
        formula: Some("=PERCENTILE(A1:A2,0.25)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 161,
        value: None,
        formula: Some("=QUARTILE(A1:A2,3)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 162,
        value: None,
        formula: Some("=PERCENTRANK(A1:A2,120)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 163,
        value: None,
        formula: Some("=AVERAGEA(E1:E4)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 164,
        value: None,
        formula: Some("=STDEVA(E1:E4)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 165,
        value: None,
        formula: Some("=STDEVPA(E1:E4)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 166,
        value: None,
        formula: Some("=VARA(E1:E4)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 167,
        value: None,
        formula: Some("=VARPA(E1:E4)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 168,
        value: None,
        formula: Some("=COVARIANCE.P(A1:A2,A4:A5)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 169,
        value: None,
        formula: Some("=COVARIANCE.S(A1:A2,A4:A5)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 170,
        value: None,
        formula: Some("=CORREL(A1:A2,A4:A5)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 171,
        value: None,
        formula: Some("=SLOPE(A4:A5,A1:A2)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 172,
        value: None,
        formula: Some("=INTERCEPT(A4:A5,A1:A2)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 173,
        value: None,
        formula: Some("=RSQ(A4:A5,A1:A2)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 174,
        value: None,
        formula: Some("=COVAR(A1:A2,A4:A5)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 175,
        value: None,
        formula: Some("=PEARSON(A1:A2,A4:A5)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 176,
        value: None,
        formula: Some("=FORECAST.LINEAR(4,U10:U12,T10:T12)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 177,
        value: None,
        formula: Some("=FORECAST(4,U10:U12,T10:T12)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 178,
        value: None,
        formula: Some("=STEYX(U10:U12,T10:T12)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 179,
        value: None,
        formula: Some("=SUMXMY2(A1:A2,A4:A5)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 180,
        value: None,
        formula: Some("=SUMX2MY2(A1:A2,A4:A5)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 181,
        value: None,
        formula: Some("=SUMX2PY2(A1:A2,A4:A5)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 182,
        value: None,
        formula: Some("=SKEW(T10:T14)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 183,
        value: None,
        formula: Some("=KURT(T10:T14)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 184,
        value: None,
        formula: Some("=SKEW.P(V10:V14)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 185,
        value: None,
        formula: Some("=FISHER(0.75)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 186,
        value: None,
        formula: Some("=FISHERINV(0.5)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 187,
        value: None,
        formula: Some("=PERMUT(5,2)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 188,
        value: None,
        formula: Some("=PERMUTATIONA(5,2)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 189,
        value: None,
        formula: Some("=MULTINOMIAL(2,3,1)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 190,
        value: None,
        formula: Some("=FACTDOUBLE(7)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 191,
        value: None,
        formula: Some("=COMBINA(4,2)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 192,
        value: None,
        formula: Some("=COT(0.7853981633974483)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 193,
        value: None,
        formula: Some("=SEC(0)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 194,
        value: None,
        formula: Some("=CSC(1.5707963267948966)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 195,
        value: None,
        formula: Some("=ASINH(0)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 196,
        value: None,
        formula: Some("=ACOSH(1)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 197,
        value: None,
        formula: Some("=ATANH(0)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 198,
        value: None,
        formula: Some("=COTH(1)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 199,
        value: None,
        formula: Some("=SECH(0)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 200,
        value: None,
        formula: Some("=CSCH(1)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 201,
        value: None,
        formula: Some("=ACOT(1)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 202,
        value: None,
        formula: Some("=ASEC(2)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 203,
        value: None,
        formula: Some("=ACSC(2)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 204,
        value: None,
        formula: Some("=ACOTH(2)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 205,
        value: None,
        formula: Some("=ASECH(0.5)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 206,
        value: None,
        formula: Some("=ACSCH(2)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 207,
        value: None,
        formula: Some("=ROMAN(1999)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 208,
        value: None,
        formula: Some("=ARABIC(\"MCMXCIX\")".to_string()),
      },
      CellMutation {
        row: 1,
        col: 209,
        value: None,
        formula: Some("=CEILING.MATH(-12.31,0.25,1)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 210,
        value: None,
        formula: Some("=FLOOR.MATH(-12.31,0.25)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 211,
        value: None,
        formula: Some("=CEILING.MATH(12.31)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 212,
        value: None,
        formula: Some("=FLOOR.MATH(12.31)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 213,
        value: None,
        formula: Some(r#"=EDATE("2024-01-31",1)"#.to_string()),
      },
      CellMutation {
        row: 1,
        col: 214,
        value: None,
        formula: Some(r#"=EOMONTH("2024-01-15",1)"#.to_string()),
      },
      CellMutation {
        row: 1,
        col: 215,
        value: None,
        formula: Some(r#"=DAYS("2024-02-29","2024-01-31")"#.to_string()),
      },
      CellMutation {
        row: 1,
        col: 216,
        value: None,
        formula: Some(r#"=IFS(A1>=100,"bonus",A1>=80,"standard",TRUE,"low")"#.to_string()),
      },
      CellMutation {
        row: 1,
        col: 217,
        value: None,
        formula: Some(r#"=SWITCH(E1,"north","N","south","S","other")"#.to_string()),
      },
      CellMutation {
        row: 1,
        col: 218,
        value: None,
        formula: Some(r#"=DATEVALUE("2024-02-29")"#.to_string()),
      },
      CellMutation {
        row: 1,
        col: 219,
        value: None,
        formula: Some(r#"=TIMEVALUE("13:45:30")"#.to_string()),
      },
      CellMutation {
        row: 1,
        col: 220,
        value: None,
        formula: Some(r#"=TEXTJOIN(":",TRUE,A1:A2,"")"#.to_string()),
      },
      CellMutation {
        row: 1,
        col: 221,
        value: None,
        formula: Some(r#"=TEXTJOIN(":",FALSE,A1:A2,"")"#.to_string()),
      },
      CellMutation {
        row: 1,
        col: 222,
        value: None,
        formula: Some(r#"=DATEDIF("2024-01-31","2024-03-15","D")"#.to_string()),
      },
      CellMutation {
        row: 1,
        col: 223,
        value: None,
        formula: Some(r#"=DATEDIF("2024-01-31","2024-03-15","M")"#.to_string()),
      },
      CellMutation {
        row: 1,
        col: 224,
        value: None,
        formula: Some(r#"=DATEDIF("2024-01-31","2024-03-15","Y")"#.to_string()),
      },
      CellMutation {
        row: 1,
        col: 225,
        value: None,
        formula: Some(r#"=DATEDIF("2024-01-31","2024-03-15","YM")"#.to_string()),
      },
      CellMutation {
        row: 1,
        col: 226,
        value: None,
        formula: Some(r#"=DATEDIF("2024-01-31","2024-03-15","YD")"#.to_string()),
      },
      CellMutation {
        row: 1,
        col: 227,
        value: None,
        formula: Some(r#"=DATEDIF("2024-01-31","2024-03-15","MD")"#.to_string()),
      },
      CellMutation {
        row: 1,
        col: 228,
        value: None,
        formula: Some(r#"=NETWORKDAYS("2024-03-01","2024-03-10","2024-03-04")"#.to_string()),
      },
      CellMutation {
        row: 1,
        col: 229,
        value: None,
        formula: Some(r#"=NETWORKDAYS("2024-03-10","2024-03-01","2024-03-04")"#.to_string()),
      },
      CellMutation {
        row: 1,
        col: 230,
        value: None,
        formula: Some(r#"=WORKDAY("2024-03-01",5,"2024-03-04")"#.to_string()),
      },
      CellMutation {
        row: 1,
        col: 231,
        value: None,
        formula: Some(r#"=WORKDAY("2024-03-11",-5,"2024-03-04")"#.to_string()),
      },
      CellMutation {
        row: 1,
        col: 232,
        value: None,
        formula: Some(r#"=NETWORKDAYS.INTL("2024-03-01","2024-03-10",11)"#.to_string()),
      },
      CellMutation {
        row: 1,
        col: 233,
        value: None,
        formula: Some(
          r#"=NETWORKDAYS.INTL("2024-03-01","2024-03-10","0000011","2024-03-04")"#.to_string(),
        ),
      },
      CellMutation {
        row: 1,
        col: 234,
        value: None,
        formula: Some(r#"=WORKDAY.INTL("2024-03-01",1,11)"#.to_string()),
      },
      CellMutation {
        row: 1,
        col: 235,
        value: None,
        formula: Some(
          r#"=WORKDAY.INTL("2024-03-04",-1,"0000011","2024-03-01")"#.to_string(),
        ),
      },
      CellMutation {
        row: 1,
        col: 236,
        value: None,
        formula: Some(r#"=ISOWEEKNUM("2024-01-04")"#.to_string()),
      },
      CellMutation {
        row: 1,
        col: 237,
        value: None,
        formula: Some("=TIME(13,45,30)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 238,
        value: None,
        formula: Some("=WEEKDAY(L1,11)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 239,
        value: None,
        formula: Some("=WEEKDAY(L1,16)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 240,
        value: None,
        formula: Some("=WEEKNUM(L1,21)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 241,
        value: None,
        formula: Some(r#"=PROPER("hELLo woRLD")"#.to_string()),
      },
      CellMutation {
        row: 1,
        col: 242,
        value: None,
        formula: Some("=CLEAN(A3)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 243,
        value: None,
        formula: Some(r#"=DAYS360("2024-02-29","2024-03-31")"#.to_string()),
      },
      CellMutation {
        row: 1,
        col: 244,
        value: None,
        formula: Some(r#"=DAYS360("2024-02-29","2024-03-31",TRUE)"#.to_string()),
      },
    ];
    set_cells(&db_path, "Sheet1", &cells).expect("cells should upsert");

    let (updated_cells, unsupported_formulas) =
      recalculate_formulas(&db_path).expect("recalculation should work");
    assert_eq!(updated_cells, 242);
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
        end_col: 244,
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
    assert_eq!(by_position(1, 46).evaluated_value.as_deref(), Some("Southeast"));
    assert_eq!(by_position(1, 47).evaluated_value.as_deref(), Some(""));
    assert_eq!(by_position(1, 48).evaluated_value.as_deref(), Some("south"));
    assert_eq!(by_position(1, 49).evaluated_value.as_deref(), Some(""));
    assert_eq!(by_position(1, 50).evaluated_value.as_deref(), Some("12.5"));
    assert_eq!(by_position(1, 51).evaluated_value.as_deref(), Some("12.35"));
    assert_eq!(by_position(1, 52).evaluated_value.as_deref(), Some("12.4"));
    assert_eq!(by_position(1, 53).evaluated_value.as_deref(), Some("-12.3"));
    assert_eq!(by_position(1, 54).evaluated_value.as_deref(), Some("9"));
    assert_eq!(by_position(1, 55).evaluated_value.as_deref(), Some("81"));
    assert_eq!(by_position(1, 56).evaluated_value.as_deref(), Some("8.94427190999916"));
    assert_eq!(by_position(1, 57).evaluated_value.as_deref(), Some("12.5"));
    assert_eq!(by_position(1, 58).evaluated_value.as_deref(), Some("-12.25"));
    assert_eq!(by_position(1, 59).evaluated_value.as_deref(), Some("1"));
    assert_eq!(by_position(1, 60).evaluated_value.as_deref(), Some("-1"));
    assert_eq!(by_position(1, 61).evaluated_value.as_deref(), Some("80"));
    assert_eq!(by_position(1, 62).evaluated_value.as_deref(), Some("80"));
    assert_eq!(by_position(1, 63).evaluated_value.as_deref(), Some("-13"));
    assert_eq!(by_position(1, 64).evaluated_value.as_deref(), Some("12.34"));
    assert_eq!(by_position(1, 65).evaluated_value.as_deref(), Some("false"));
    assert_eq!(by_position(1, 66).evaluated_value.as_deref(), Some("true"));
    assert_eq!(by_position(1, 67).evaluated_value.as_deref(), Some("true"));
    let now_value = by_position(1, 68)
      .evaluated_value
      .as_deref()
      .expect("now formula should evaluate");
    assert!(
      DateTime::parse_from_rfc3339(now_value).is_ok(),
      "now formula should produce an RFC3339 timestamp",
    );
    assert_eq!(by_position(1, 69).evaluated_value.as_deref(), Some("14"));
    assert_eq!(by_position(1, 70).evaluated_value.as_deref(), Some("25"));
    assert_eq!(by_position(1, 71).evaluated_value.as_deref(), Some("36"));
    assert_eq!(by_position(1, 72).evaluated_value.as_deref(), Some("true"));
    assert_eq!(by_position(1, 73).evaluated_value.as_deref(), Some("false"));
    assert_eq!(by_position(1, 74).evaluated_value.as_deref(), Some("pread"));
    assert_eq!(by_position(1, 75).evaluated_value.as_deref(), Some("nananana"));
    assert_eq!(by_position(1, 76).evaluated_value.as_deref(), Some("7"));
    assert_eq!(by_position(1, 77).evaluated_value.as_deref(), Some("6"));
    assert_eq!(by_position(1, 78).evaluated_value.as_deref(), Some("7"));
    assert_eq!(by_position(1, 79).evaluated_value.as_deref(), Some("6"));
    assert_eq!(by_position(1, 80).evaluated_value.as_deref(), Some("worksheet"));
    assert_eq!(
      by_position(1, 81).evaluated_value.as_deref(),
      Some("south-south"),
    );
    assert_eq!(
      by_position(1, 82).evaluated_value.as_deref(),
      Some("north-south-north"),
    );
    assert_eq!(by_position(1, 83).evaluated_value.as_deref(), Some("12.34"));
    assert_eq!(by_position(1, 84).evaluated_value.as_deref(), Some("A"));
    assert_eq!(by_position(1, 85).evaluated_value.as_deref(), Some("65"));
    assert_eq!(by_position(1, 86).evaluated_value.as_deref(), Some("true"));
    assert_eq!(by_position(1, 87).evaluated_value.as_deref(), Some("false"));
    assert_eq!(by_position(1, 88).evaluated_value.as_deref(), Some("120"));
    assert_eq!(by_position(1, 89).evaluated_value.as_deref(), Some("north"));
    assert_eq!(by_position(1, 90).evaluated_value.as_deref(), Some("0"));
    assert_eq!(by_position(1, 91).evaluated_value.as_deref(), Some(""));
    assert_eq!(by_position(1, 92).evaluated_value.as_deref(), Some("☃"));
    assert_eq!(by_position(1, 93).evaluated_value.as_deref(), Some("9889"));
    assert_eq!(
      by_position(1, 94).evaluated_value.as_deref(),
      Some("3.141592653589793"),
    );
    assert_eq!(by_position(1, 95).evaluated_value.as_deref(), Some("0"));
    assert_eq!(by_position(1, 96).evaluated_value.as_deref(), Some("3"));
    assert_eq!(by_position(1, 97).evaluated_value.as_deref(), Some("0"));
    assert_eq!(by_position(1, 98).evaluated_value.as_deref(), Some("1"));
    assert_eq!(by_position(1, 99).evaluated_value.as_deref(), Some("0"));
    assert_eq!(by_position(1, 100).evaluated_value.as_deref(), Some("0"));
    assert_eq!(by_position(1, 101).evaluated_value.as_deref(), Some("0"));
    assert_eq!(
      by_position(1, 102).evaluated_value.as_deref(),
      Some("0.7853981633974483"),
    );
    assert_eq!(
      by_position(1, 103).evaluated_value.as_deref(),
      Some("1.5707963267948966"),
    );
    assert_eq!(by_position(1, 104).evaluated_value.as_deref(), Some("180"));
    assert_eq!(
      by_position(1, 105).evaluated_value.as_deref(),
      Some("3.141592653589793"),
    );
    assert_eq!(
      by_position(1, 106).evaluated_value.as_deref(),
      Some("2.718281828459045"),
    );
    assert_eq!(by_position(1, 107).evaluated_value.as_deref(), Some("2"));
    assert_eq!(by_position(1, 108).evaluated_value.as_deref(), Some("0"));
    assert_eq!(by_position(1, 109).evaluated_value.as_deref(), Some("1"));
    assert_eq!(by_position(1, 110).evaluated_value.as_deref(), Some("0"));
    assert_eq!(by_position(1, 111).evaluated_value.as_deref(), Some("120"));
    assert_eq!(by_position(1, 112).evaluated_value.as_deref(), Some("10"));
    assert_eq!(by_position(1, 113).evaluated_value.as_deref(), Some("12"));
    assert_eq!(by_position(1, 114).evaluated_value.as_deref(), Some("36"));
    assert_eq!(by_position(1, 115).evaluated_value.as_deref(), Some("3"));
    assert_eq!(by_position(1, 116).evaluated_value.as_deref(), Some("0"));
    assert_eq!(by_position(1, 117).evaluated_value.as_deref(), Some("-2"));
    assert_eq!(by_position(1, 118).evaluated_value.as_deref(), Some("3"));
    assert_eq!(by_position(1, 119).evaluated_value.as_deref(), Some("2"));
    assert_eq!(by_position(1, 120).evaluated_value.as_deref(), Some("12"));
    assert_eq!(by_position(1, 121).evaluated_value.as_deref(), Some("20800"));
    assert_eq!(by_position(1, 122).evaluated_value.as_deref(), Some("200"));
    assert_eq!(by_position(1, 123).evaluated_value.as_deref(), Some("20800.0"));
    assert_eq!(by_position(1, 124).evaluated_value.as_deref(), Some("9600"));
    assert_eq!(by_position(1, 125).evaluated_value.as_deref(), Some("7"));
    assert_eq!(by_position(1, 126).evaluated_value.as_deref(), Some("28"));
    assert_eq!(by_position(1, 127).evaluated_value.as_deref(), Some("3"));
    assert_eq!(by_position(1, 128).evaluated_value.as_deref(), Some("3"));
    assert_eq!(by_position(1, 129).evaluated_value.as_deref(), Some("100.0"));
    assert_eq!(by_position(1, 130).evaluated_value.as_deref(), Some("120"));
    assert_eq!(by_position(1, 131).evaluated_value.as_deref(), Some("80"));
    assert_eq!(by_position(1, 132).evaluated_value.as_deref(), Some("6"));
    assert_eq!(by_position(1, 133).evaluated_value.as_deref(), Some("5"));
    assert_eq!(by_position(1, 134).evaluated_value.as_deref(), Some("7"));
    assert_eq!(by_position(1, 135).evaluated_value.as_deref(), Some("7"));
    let rand_value = by_position(1, 136)
      .evaluated_value
      .as_deref()
      .expect("rand formula should evaluate")
      .parse::<f64>()
      .expect("rand formula should produce numeric output");
    assert!(
      (0.0..1.0).contains(&rand_value),
      "rand formula should be within [0, 1): {rand_value}",
    );
    let randbetween_value = by_position(1, 137)
      .evaluated_value
      .as_deref()
      .expect("randbetween formula should evaluate")
      .parse::<i32>()
      .expect("randbetween formula should produce numeric output");
    assert!(
      (1..=6).contains(&randbetween_value),
      "randbetween formula should be within [1, 6]: {randbetween_value}",
    );
    assert_eq!(by_position(1, 138).evaluated_value.as_deref(), Some("1"));
    assert_eq!(by_position(1, 139).evaluated_value.as_deref(), Some("1"));
    let stdev_p = by_position(1, 140)
      .evaluated_value
      .as_deref()
      .expect("stdev.p should evaluate")
      .parse::<f64>()
      .expect("stdev.p should be numeric");
    assert!(
      (stdev_p - 20.0).abs() < 1e-9,
      "stdev.p should be 20.0, got {stdev_p}",
    );
    let stdev_s = by_position(1, 141)
      .evaluated_value
      .as_deref()
      .expect("stdev.s should evaluate")
      .parse::<f64>()
      .expect("stdev.s should be numeric");
    assert!(
      (stdev_s - 28.284_271_247_461_902).abs() < 1e-9,
      "stdev.s should be sqrt(800), got {stdev_s}",
    );
    let var_p = by_position(1, 142)
      .evaluated_value
      .as_deref()
      .expect("var.p should evaluate")
      .parse::<f64>()
      .expect("var.p should be numeric");
    assert!((var_p - 400.0).abs() < 1e-9, "var.p should be 400, got {var_p}");
    let var_s = by_position(1, 143)
      .evaluated_value
      .as_deref()
      .expect("var.s should evaluate")
      .parse::<f64>()
      .expect("var.s should be numeric");
    assert!((var_s - 800.0).abs() < 1e-9, "var.s should be 800, got {var_s}");
    let percentile = by_position(1, 144)
      .evaluated_value
      .as_deref()
      .expect("percentile should evaluate")
      .parse::<f64>()
      .expect("percentile should be numeric");
    assert!(
      (percentile - 90.0).abs() < 1e-9,
      "percentile should be 90.0, got {percentile}",
    );
    let quartile = by_position(1, 145)
      .evaluated_value
      .as_deref()
      .expect("quartile should evaluate")
      .parse::<f64>()
      .expect("quartile should be numeric");
    assert!(
      (quartile - 110.0).abs() < 1e-9,
      "quartile should be 110.0, got {quartile}",
    );
    let percentrank_inc = by_position(1, 146)
      .evaluated_value
      .as_deref()
      .expect("percentrank.inc should evaluate")
      .parse::<f64>()
      .expect("percentrank.inc should be numeric");
    assert!(
      (percentrank_inc - 1.0).abs() < 1e-9,
      "percentrank.inc should be 1.0, got {percentrank_inc}",
    );
    let percentrank_exc = by_position(1, 147)
      .evaluated_value
      .as_deref()
      .expect("percentrank.exc should evaluate")
      .parse::<f64>()
      .expect("percentrank.exc should be numeric");
    assert!(
      (percentrank_exc - (2.0 / 3.0)).abs() < 1e-9,
      "percentrank.exc should be 2/3, got {percentrank_exc}",
    );
    let percentile_exc = by_position(1, 148)
      .evaluated_value
      .as_deref()
      .expect("percentile.exc should evaluate")
      .parse::<f64>()
      .expect("percentile.exc should be numeric");
    assert!(
      (percentile_exc - 100.0).abs() < 1e-9,
      "percentile.exc should be 100.0, got {percentile_exc}",
    );
    let quartile_exc = by_position(1, 149)
      .evaluated_value
      .as_deref()
      .expect("quartile.exc should evaluate")
      .parse::<f64>()
      .expect("quartile.exc should be numeric");
    assert!(
      (quartile_exc - 100.0).abs() < 1e-9,
      "quartile.exc should be 100.0, got {quartile_exc}",
    );
    assert_eq!(by_position(1, 150).evaluated_value.as_deref(), Some("120"));
    let geomean = by_position(1, 151)
      .evaluated_value
      .as_deref()
      .expect("geomean should evaluate")
      .parse::<f64>()
      .expect("geomean should be numeric");
    assert!(
      (geomean - 97.979_589_711_327_12).abs() < 1e-9,
      "geomean should be sqrt(9600), got {geomean}",
    );
    let harmean = by_position(1, 152)
      .evaluated_value
      .as_deref()
      .expect("harmean should evaluate")
      .parse::<f64>()
      .expect("harmean should be numeric");
    assert!(
      (harmean - 96.0).abs() < 1e-9,
      "harmean should be 96.0, got {harmean}",
    );
    let trimmean = by_position(1, 153)
      .evaluated_value
      .as_deref()
      .expect("trimmean should evaluate")
      .parse::<f64>()
      .expect("trimmean should be numeric");
    assert!(
      (trimmean - 106.666_666_666_666_67).abs() < 1e-9,
      "trimmean should be 106.666..., got {trimmean}",
    );
    let devsq = by_position(1, 154)
      .evaluated_value
      .as_deref()
      .expect("devsq should evaluate")
      .parse::<f64>()
      .expect("devsq should be numeric");
    assert!((devsq - 800.0).abs() < 1e-9, "devsq should be 800.0, got {devsq}");
    let avedev = by_position(1, 155)
      .evaluated_value
      .as_deref()
      .expect("avedev should evaluate")
      .parse::<f64>()
      .expect("avedev should be numeric");
    assert!(
      (avedev - 20.0).abs() < 1e-9,
      "avedev should be 20.0, got {avedev}",
    );
    let stdev_legacy = by_position(1, 156)
      .evaluated_value
      .as_deref()
      .expect("stdev should evaluate")
      .parse::<f64>()
      .expect("stdev should be numeric");
    assert!(
      (stdev_legacy - 28.284_271_247_461_902).abs() < 1e-9,
      "stdev should be sqrt(800), got {stdev_legacy}",
    );
    let stdevp_legacy = by_position(1, 157)
      .evaluated_value
      .as_deref()
      .expect("stdevp should evaluate")
      .parse::<f64>()
      .expect("stdevp should be numeric");
    assert!(
      (stdevp_legacy - 20.0).abs() < 1e-9,
      "stdevp should be 20.0, got {stdevp_legacy}",
    );
    let var_legacy = by_position(1, 158)
      .evaluated_value
      .as_deref()
      .expect("var should evaluate")
      .parse::<f64>()
      .expect("var should be numeric");
    assert!((var_legacy - 800.0).abs() < 1e-9, "var should be 800.0, got {var_legacy}");
    let varp_legacy = by_position(1, 159)
      .evaluated_value
      .as_deref()
      .expect("varp should evaluate")
      .parse::<f64>()
      .expect("varp should be numeric");
    assert!((varp_legacy - 400.0).abs() < 1e-9, "varp should be 400.0, got {varp_legacy}");
    let percentile_legacy = by_position(1, 160)
      .evaluated_value
      .as_deref()
      .expect("percentile should evaluate")
      .parse::<f64>()
      .expect("percentile should be numeric");
    assert!(
      (percentile_legacy - 90.0).abs() < 1e-9,
      "legacy percentile should be 90.0, got {percentile_legacy}",
    );
    let quartile_legacy = by_position(1, 161)
      .evaluated_value
      .as_deref()
      .expect("quartile should evaluate")
      .parse::<f64>()
      .expect("quartile should be numeric");
    assert!(
      (quartile_legacy - 110.0).abs() < 1e-9,
      "legacy quartile should be 110.0, got {quartile_legacy}",
    );
    let percentrank_legacy = by_position(1, 162)
      .evaluated_value
      .as_deref()
      .expect("percentrank should evaluate")
      .parse::<f64>()
      .expect("percentrank should be numeric");
    assert!(
      (percentrank_legacy - 1.0).abs() < 1e-9,
      "legacy percentrank should be 1.0, got {percentrank_legacy}",
    );
    let averagea = by_position(1, 163)
      .evaluated_value
      .as_deref()
      .expect("averagea should evaluate")
      .parse::<f64>()
      .expect("averagea should be numeric");
    assert!((averagea - 0.25).abs() < 1e-9, "averagea should be 0.25, got {averagea}");
    let stdeva = by_position(1, 164)
      .evaluated_value
      .as_deref()
      .expect("stdeva should evaluate")
      .parse::<f64>()
      .expect("stdeva should be numeric");
    assert!((stdeva - 0.5).abs() < 1e-9, "stdeva should be 0.5, got {stdeva}");
    let stdevpa = by_position(1, 165)
      .evaluated_value
      .as_deref()
      .expect("stdevpa should evaluate")
      .parse::<f64>()
      .expect("stdevpa should be numeric");
    assert!(
      (stdevpa - 0.433_012_701_892_219_3).abs() < 1e-9,
      "stdevpa should be sqrt(0.1875), got {stdevpa}",
    );
    let vara = by_position(1, 166)
      .evaluated_value
      .as_deref()
      .expect("vara should evaluate")
      .parse::<f64>()
      .expect("vara should be numeric");
    assert!((vara - 0.25).abs() < 1e-9, "vara should be 0.25, got {vara}");
    let varpa = by_position(1, 167)
      .evaluated_value
      .as_deref()
      .expect("varpa should evaluate")
      .parse::<f64>()
      .expect("varpa should be numeric");
    assert!((varpa - 0.1875).abs() < 1e-9, "varpa should be 0.1875, got {varpa}");
    let covariance_p = by_position(1, 168)
      .evaluated_value
      .as_deref()
      .expect("covariance.p should evaluate")
      .parse::<f64>()
      .expect("covariance.p should be numeric");
    assert!(
      (covariance_p - 800.0).abs() < 1e-9,
      "covariance.p should be 800.0, got {covariance_p}",
    );
    let covariance_s = by_position(1, 169)
      .evaluated_value
      .as_deref()
      .expect("covariance.s should evaluate")
      .parse::<f64>()
      .expect("covariance.s should be numeric");
    assert!(
      (covariance_s - 1600.0).abs() < 1e-9,
      "covariance.s should be 1600.0, got {covariance_s}",
    );
    let correl = by_position(1, 170)
      .evaluated_value
      .as_deref()
      .expect("correl should evaluate")
      .parse::<f64>()
      .expect("correl should be numeric");
    assert!((correl - 1.0).abs() < 1e-9, "correl should be 1.0, got {correl}");
    let slope = by_position(1, 171)
      .evaluated_value
      .as_deref()
      .expect("slope should evaluate")
      .parse::<f64>()
      .expect("slope should be numeric");
    assert!((slope - 2.0).abs() < 1e-9, "slope should be 2.0, got {slope}");
    let intercept = by_position(1, 172)
      .evaluated_value
      .as_deref()
      .expect("intercept should evaluate")
      .parse::<f64>()
      .expect("intercept should be numeric");
    assert!(
      (intercept + 120.0).abs() < 1e-9,
      "intercept should be -120.0, got {intercept}",
    );
    let rsq = by_position(1, 173)
      .evaluated_value
      .as_deref()
      .expect("rsq should evaluate")
      .parse::<f64>()
      .expect("rsq should be numeric");
    assert!((rsq - 1.0).abs() < 1e-9, "rsq should be 1.0, got {rsq}");
    let covar = by_position(1, 174)
      .evaluated_value
      .as_deref()
      .expect("covar should evaluate")
      .parse::<f64>()
      .expect("covar should be numeric");
    assert!((covar - 800.0).abs() < 1e-9, "covar should be 800.0, got {covar}");
    let pearson = by_position(1, 175)
      .evaluated_value
      .as_deref()
      .expect("pearson should evaluate")
      .parse::<f64>()
      .expect("pearson should be numeric");
    assert!(
      (pearson - 1.0).abs() < 1e-9,
      "pearson should be 1.0, got {pearson}",
    );
    let forecast_linear = by_position(1, 176)
      .evaluated_value
      .as_deref()
      .expect("forecast.linear should evaluate")
      .parse::<f64>()
      .expect("forecast.linear should be numeric");
    assert!(
      (forecast_linear - 6.666_666_666_666_667).abs() < 1e-9,
      "forecast.linear should be 6.666..., got {forecast_linear}",
    );
    let forecast = by_position(1, 177)
      .evaluated_value
      .as_deref()
      .expect("forecast should evaluate")
      .parse::<f64>()
      .expect("forecast should be numeric");
    assert!(
      (forecast - 6.666_666_666_666_667).abs() < 1e-9,
      "forecast should be 6.666..., got {forecast}",
    );
    let steyx = by_position(1, 178)
      .evaluated_value
      .as_deref()
      .expect("steyx should evaluate")
      .parse::<f64>()
      .expect("steyx should be numeric");
    assert!(
      (steyx - 0.408_248_290_463_863).abs() < 1e-9,
      "steyx should be sqrt(1/6), got {steyx}",
    );
    let sumxmy2 = by_position(1, 179)
      .evaluated_value
      .as_deref()
      .expect("sumxmy2 should evaluate")
      .parse::<f64>()
      .expect("sumxmy2 should be numeric");
    assert!(
      (sumxmy2 - 1600.0).abs() < 1e-9,
      "sumxmy2 should be 1600.0, got {sumxmy2}",
    );
    let sumx2my2 = by_position(1, 180)
      .evaluated_value
      .as_deref()
      .expect("sumx2my2 should evaluate")
      .parse::<f64>()
      .expect("sumx2my2 should be numeric");
    assert!(
      (sumx2my2 - 4800.0).abs() < 1e-9,
      "sumx2my2 should be 4800.0, got {sumx2my2}",
    );
    let sumx2py2 = by_position(1, 181)
      .evaluated_value
      .as_deref()
      .expect("sumx2py2 should evaluate")
      .parse::<f64>()
      .expect("sumx2py2 should be numeric");
    assert!(
      (sumx2py2 - 36800.0).abs() < 1e-9,
      "sumx2py2 should be 36800.0, got {sumx2py2}",
    );
    let skew = by_position(1, 182)
      .evaluated_value
      .as_deref()
      .expect("skew should evaluate")
      .parse::<f64>()
      .expect("skew should be numeric");
    assert!(skew.abs() < 1e-9, "skew should be 0.0, got {skew}");
    let kurt = by_position(1, 183)
      .evaluated_value
      .as_deref()
      .expect("kurt should evaluate")
      .parse::<f64>()
      .expect("kurt should be numeric");
    assert!(
      (kurt + 1.2).abs() < 1e-9,
      "kurt should be -1.2, got {kurt}",
    );
    let skew_p = by_position(1, 184)
      .evaluated_value
      .as_deref()
      .expect("skew.p should evaluate")
      .parse::<f64>()
      .expect("skew.p should be numeric");
    assert!(
      (skew_p - 0.395_870_337_343_816_44).abs() < 1e-9,
      "skew.p should be 0.395870..., got {skew_p}",
    );
    let fisher = by_position(1, 185)
      .evaluated_value
      .as_deref()
      .expect("fisher should evaluate")
      .parse::<f64>()
      .expect("fisher should be numeric");
    assert!(
      (fisher - 0.972_955_074_527_656_6).abs() < 1e-9,
      "fisher should be 0.972955..., got {fisher}",
    );
    let fisherinv = by_position(1, 186)
      .evaluated_value
      .as_deref()
      .expect("fisherinv should evaluate")
      .parse::<f64>()
      .expect("fisherinv should be numeric");
    assert!(
      (fisherinv - 0.462_117_157_260_009_74).abs() < 1e-9,
      "fisherinv should be 0.462117..., got {fisherinv}",
    );
    assert_eq!(by_position(1, 187).evaluated_value.as_deref(), Some("20"));
    assert_eq!(by_position(1, 188).evaluated_value.as_deref(), Some("25"));
    assert_eq!(by_position(1, 189).evaluated_value.as_deref(), Some("60"));
    assert_eq!(by_position(1, 190).evaluated_value.as_deref(), Some("105"));
    assert_eq!(by_position(1, 191).evaluated_value.as_deref(), Some("10"));
    let cot = by_position(1, 192)
      .evaluated_value
      .as_deref()
      .expect("cot should evaluate")
      .parse::<f64>()
      .expect("cot should be numeric");
    assert!((cot - 1.0).abs() < 1e-9, "cot should be 1.0, got {cot}");
    let sec = by_position(1, 193)
      .evaluated_value
      .as_deref()
      .expect("sec should evaluate")
      .parse::<f64>()
      .expect("sec should be numeric");
    assert!((sec - 1.0).abs() < 1e-9, "sec should be 1.0, got {sec}");
    let csc = by_position(1, 194)
      .evaluated_value
      .as_deref()
      .expect("csc should evaluate")
      .parse::<f64>()
      .expect("csc should be numeric");
    assert!((csc - 1.0).abs() < 1e-9, "csc should be 1.0, got {csc}");
    assert_eq!(by_position(1, 195).evaluated_value.as_deref(), Some("0"));
    assert_eq!(by_position(1, 196).evaluated_value.as_deref(), Some("0"));
    assert_eq!(by_position(1, 197).evaluated_value.as_deref(), Some("0"));
    let coth = by_position(1, 198)
      .evaluated_value
      .as_deref()
      .expect("coth should evaluate")
      .parse::<f64>()
      .expect("coth should be numeric");
    assert!(
      (coth - 1.313_035_285_499_331_5).abs() < 1e-9,
      "coth should be 1.313035..., got {coth}",
    );
    assert_eq!(by_position(1, 199).evaluated_value.as_deref(), Some("1"));
    let csch = by_position(1, 200)
      .evaluated_value
      .as_deref()
      .expect("csch should evaluate")
      .parse::<f64>()
      .expect("csch should be numeric");
    assert!(
      (csch - 0.850_918_128_239_321_6).abs() < 1e-9,
      "csch should be 0.850918..., got {csch}",
    );
    let acot = by_position(1, 201)
      .evaluated_value
      .as_deref()
      .expect("acot should evaluate")
      .parse::<f64>()
      .expect("acot should be numeric");
    assert!(
      (acot - 0.785_398_163_397_448_3).abs() < 1e-9,
      "acot should be pi/4, got {acot}",
    );
    let asec = by_position(1, 202)
      .evaluated_value
      .as_deref()
      .expect("asec should evaluate")
      .parse::<f64>()
      .expect("asec should be numeric");
    assert!(
      (asec - 1.047_197_551_196_597_9).abs() < 1e-9,
      "asec should be pi/3, got {asec}",
    );
    let acsc = by_position(1, 203)
      .evaluated_value
      .as_deref()
      .expect("acsc should evaluate")
      .parse::<f64>()
      .expect("acsc should be numeric");
    assert!(
      (acsc - 0.523_598_775_598_298_9).abs() < 1e-9,
      "acsc should be pi/6, got {acsc}",
    );
    let acoth = by_position(1, 204)
      .evaluated_value
      .as_deref()
      .expect("acoth should evaluate")
      .parse::<f64>()
      .expect("acoth should be numeric");
    assert!(
      (acoth - 0.549_306_144_334_054_9).abs() < 1e-9,
      "acoth should be 0.549306..., got {acoth}",
    );
    let asech = by_position(1, 205)
      .evaluated_value
      .as_deref()
      .expect("asech should evaluate")
      .parse::<f64>()
      .expect("asech should be numeric");
    assert!(
      (asech - 1.316_957_896_924_816_6).abs() < 1e-9,
      "asech should be 1.316957..., got {asech}",
    );
    let acsch = by_position(1, 206)
      .evaluated_value
      .as_deref()
      .expect("acsch should evaluate")
      .parse::<f64>()
      .expect("acsch should be numeric");
    assert!(
      (acsch - 0.481_211_825_059_603_47).abs() < 1e-9,
      "acsch should be 0.481211..., got {acsch}",
    );
    assert_eq!(
      by_position(1, 207).evaluated_value.as_deref(),
      Some("MCMXCIX"),
      "roman should evaluate to canonical numeral",
    );
    assert_eq!(
      by_position(1, 208).evaluated_value.as_deref(),
      Some("1999"),
      "arabic should evaluate to integer text",
    );
    assert_eq!(
      by_position(1, 209).evaluated_value.as_deref(),
      Some("-12.5"),
      "ceiling.math with mode 1 should round away from zero",
    );
    assert_eq!(
      by_position(1, 210).evaluated_value.as_deref(),
      Some("-12.5"),
      "floor.math should round away from zero for negative numbers by default",
    );
    assert_eq!(
      by_position(1, 211).evaluated_value.as_deref(),
      Some("13"),
      "ceiling.math should default significance to one",
    );
    assert_eq!(
      by_position(1, 212).evaluated_value.as_deref(),
      Some("12"),
      "floor.math should default significance to one",
    );
    assert_eq!(
      by_position(1, 213).evaluated_value.as_deref(),
      Some("2024-02-29"),
      "edate should shift months and clamp to end-of-month",
    );
    assert_eq!(
      by_position(1, 214).evaluated_value.as_deref(),
      Some("2024-02-29"),
      "eomonth should resolve end-of-month for shifted month",
    );
    assert_eq!(
      by_position(1, 215).evaluated_value.as_deref(),
      Some("29"),
      "days should return signed day delta",
    );
    assert_eq!(
      by_position(1, 216).evaluated_value.as_deref(),
      Some("bonus"),
      "ifs should return the first matching branch value",
    );
    assert_eq!(
      by_position(1, 217).evaluated_value.as_deref(),
      Some("N"),
      "switch should return matching branch result",
    );
    assert_eq!(
      by_position(1, 218).evaluated_value.as_deref(),
      Some("45351"),
      "datevalue should return Excel serial day number",
    );
    let timevalue = by_position(1, 219)
      .evaluated_value
      .as_deref()
      .expect("timevalue should evaluate")
      .parse::<f64>()
      .expect("timevalue should be numeric");
    assert!(
      (timevalue - 0.573_263_888_888_888_9).abs() < 1e-12,
      "timevalue should return day fraction, got {timevalue}",
    );
    assert_eq!(
      by_position(1, 220).evaluated_value.as_deref(),
      Some("120:80"),
      "textjoin should flatten ranges and ignore blanks",
    );
    assert_eq!(
      by_position(1, 221).evaluated_value.as_deref(),
      Some("120:80:"),
      "textjoin should keep blanks when ignore_empty is false",
    );
    assert_eq!(
      by_position(1, 222).evaluated_value.as_deref(),
      Some("44"),
      "datedif D should return day difference",
    );
    assert_eq!(
      by_position(1, 223).evaluated_value.as_deref(),
      Some("1"),
      "datedif M should return complete month difference",
    );
    assert_eq!(
      by_position(1, 224).evaluated_value.as_deref(),
      Some("0"),
      "datedif Y should return complete year difference",
    );
    assert_eq!(
      by_position(1, 225).evaluated_value.as_deref(),
      Some("1"),
      "datedif YM should return complete months excluding years",
    );
    assert_eq!(
      by_position(1, 226).evaluated_value.as_deref(),
      Some("44"),
      "datedif YD should return day difference excluding years",
    );
    assert_eq!(
      by_position(1, 227).evaluated_value.as_deref(),
      Some("13"),
      "datedif MD should return day difference excluding months/years",
    );
    assert_eq!(
      by_position(1, 228).evaluated_value.as_deref(),
      Some("5"),
      "networkdays should count weekdays minus holidays inclusively",
    );
    assert_eq!(
      by_position(1, 229).evaluated_value.as_deref(),
      Some("-5"),
      "networkdays should be signed when start is after end",
    );
    assert_eq!(
      by_position(1, 230).evaluated_value.as_deref(),
      Some("2024-03-11"),
      "workday should move forward across weekends and holidays",
    );
    assert_eq!(
      by_position(1, 231).evaluated_value.as_deref(),
      Some("2024-03-01"),
      "workday should move backward across weekends and holidays",
    );
    assert_eq!(
      by_position(1, 232).evaluated_value.as_deref(),
      Some("8"),
      "networkdays.intl should honor weekend code",
    );
    assert_eq!(
      by_position(1, 233).evaluated_value.as_deref(),
      Some("5"),
      "networkdays.intl should honor weekend mask and holidays",
    );
    assert_eq!(
      by_position(1, 234).evaluated_value.as_deref(),
      Some("2024-03-02"),
      "workday.intl should use weekend code for forward shifts",
    );
    assert_eq!(
      by_position(1, 235).evaluated_value.as_deref(),
      Some("2024-02-29"),
      "workday.intl should use weekend mask and holidays for reverse shifts",
    );
    assert_eq!(
      by_position(1, 236).evaluated_value.as_deref(),
      Some("1"),
      "isoweeknum should return ISO week numbers",
    );
    let time_serial = by_position(1, 237)
      .evaluated_value
      .as_deref()
      .expect("time should evaluate")
      .parse::<f64>()
      .expect("time should be numeric");
    assert!(
      (time_serial - 0.573_263_888_888_888_9).abs() < 1e-12,
      "time should return fraction-of-day serial, got {time_serial}",
    );
    assert_eq!(
      by_position(1, 238).evaluated_value.as_deref(),
      Some("5"),
      "weekday return type 11 should use Monday-based indexing",
    );
    assert_eq!(
      by_position(1, 239).evaluated_value.as_deref(),
      Some("7"),
      "weekday return type 16 should treat Saturday as day 1",
    );
    assert_eq!(
      by_position(1, 240).evaluated_value.as_deref(),
      Some("7"),
      "weeknum return type 21 should use ISO week numbers",
    );
    assert_eq!(
      by_position(1, 241).evaluated_value.as_deref(),
      Some("Hello World"),
      "proper should title-case words",
    );
    assert_eq!(
      by_position(1, 242).evaluated_value.as_deref(),
      Some("ok"),
      "clean should remove non-printable characters",
    );
    assert_eq!(
      by_position(1, 243).evaluated_value.as_deref(),
      Some("30"),
      "days360 should use US 30/360 method by default",
    );
    assert_eq!(
      by_position(1, 244).evaluated_value.as_deref(),
      Some("31"),
      "days360 should support European method when method is TRUE",
    );
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
  fn should_leave_approximate_hlookup_as_unsupported() {
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
        value: Some(json!("south")),
        formula: None,
      },
      CellMutation {
        row: 2,
        col: 1,
        value: Some(json!("Northeast")),
        formula: None,
      },
      CellMutation {
        row: 2,
        col: 2,
        value: Some(json!("Southeast")),
        formula: None,
      },
      CellMutation {
        row: 3,
        col: 1,
        value: None,
        formula: Some(r#"=HLOOKUP("south",A1:B2,2,TRUE)"#.to_string()),
      },
    ];
    set_cells(&db_path, "Sheet1", &cells).expect("cells should upsert");

    let (_updated_cells, unsupported_formulas) =
      recalculate_formulas(&db_path).expect("recalculation should work");
    assert_eq!(
      unsupported_formulas,
      vec![r#"=HLOOKUP("south",A1:B2,2,TRUE)"#.to_string()]
    );
  }

  #[test]
  fn should_leave_negative_sqrt_as_unsupported() {
    let (_temp_dir, db_path) = create_initialized_db_path();
    let cells = vec![CellMutation {
      row: 1,
      col: 1,
      value: None,
      formula: Some("=SQRT(-1)".to_string()),
    }];
    set_cells(&db_path, "Sheet1", &cells).expect("cells should upsert");

    let (_updated_cells, unsupported_formulas) =
      recalculate_formulas(&db_path).expect("recalculation should work");
    assert_eq!(unsupported_formulas, vec!["=SQRT(-1)".to_string()]);
  }

  #[test]
  fn should_leave_mod_by_zero_as_unsupported() {
    let (_temp_dir, db_path) = create_initialized_db_path();
    let cells = vec![CellMutation {
      row: 1,
      col: 1,
      value: None,
      formula: Some("=MOD(10,0)".to_string()),
    }];
    set_cells(&db_path, "Sheet1", &cells).expect("cells should upsert");

    let (_updated_cells, unsupported_formulas) =
      recalculate_formulas(&db_path).expect("recalculation should work");
    assert_eq!(unsupported_formulas, vec!["=MOD(10,0)".to_string()]);
  }

  #[test]
  fn should_leave_quotient_divide_by_zero_as_unsupported() {
    let (_temp_dir, db_path) = create_initialized_db_path();
    let cells = vec![CellMutation {
      row: 1,
      col: 1,
      value: None,
      formula: Some("=QUOTIENT(10,0)".to_string()),
    }];
    set_cells(&db_path, "Sheet1", &cells).expect("cells should upsert");

    let (_updated_cells, unsupported_formulas) =
      recalculate_formulas(&db_path).expect("recalculation should work");
    assert_eq!(unsupported_formulas, vec!["=QUOTIENT(10,0)".to_string()]);
  }

  #[test]
  fn should_leave_non_positive_logarithms_as_unsupported() {
    let (_temp_dir, db_path) = create_initialized_db_path();
    let cells = vec![
      CellMutation {
        row: 1,
        col: 1,
        value: None,
        formula: Some("=LN(0)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 2,
        value: None,
        formula: Some("=LOG10(-1)".to_string()),
      },
    ];
    set_cells(&db_path, "Sheet1", &cells).expect("cells should upsert");

    let (_updated_cells, unsupported_formulas) =
      recalculate_formulas(&db_path).expect("recalculation should work");
    assert_eq!(
      unsupported_formulas,
      vec!["=LN(0)".to_string(), "=LOG10(-1)".to_string()],
    );
  }

  #[test]
  fn should_leave_invalid_log_bases_as_unsupported() {
    let (_temp_dir, db_path) = create_initialized_db_path();
    let cells = vec![
      CellMutation {
        row: 1,
        col: 1,
        value: None,
        formula: Some("=LOG(100,1)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 2,
        value: None,
        formula: Some("=LOG(100,0)".to_string()),
      },
    ];
    set_cells(&db_path, "Sheet1", &cells).expect("cells should upsert");

    let (_updated_cells, unsupported_formulas) =
      recalculate_formulas(&db_path).expect("recalculation should work");
    assert_eq!(
      unsupported_formulas,
      vec!["=LOG(100,1)".to_string(), "=LOG(100,0)".to_string()],
    );
  }

  #[test]
  fn should_leave_invalid_weekday_weeknum_return_types_as_unsupported() {
    let (_temp_dir, db_path) = create_initialized_db_path();
    let cells = vec![
      CellMutation {
        row: 1,
        col: 1,
        value: Some(json!("2026-02-13")),
        formula: None,
      },
      CellMutation {
        row: 1,
        col: 2,
        value: None,
        formula: Some("=WEEKDAY(A1,9)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 3,
        value: None,
        formula: Some("=WEEKNUM(A1,9)".to_string()),
      },
    ];
    set_cells(&db_path, "Sheet1", &cells).expect("cells should upsert");

    let (_updated_cells, unsupported_formulas) =
      recalculate_formulas(&db_path).expect("recalculation should work");
    assert_eq!(
      unsupported_formulas,
      vec!["=WEEKDAY(A1,9)".to_string(), "=WEEKNUM(A1,9)".to_string()],
    );
  }

  #[test]
  fn should_leave_invalid_fact_and_combin_inputs_as_unsupported() {
    let (_temp_dir, db_path) = create_initialized_db_path();
    let cells = vec![
      CellMutation {
        row: 1,
        col: 1,
        value: None,
        formula: Some("=FACT(-1)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 2,
        value: None,
        formula: Some("=COMBIN(5,7)".to_string()),
      },
    ];
    set_cells(&db_path, "Sheet1", &cells).expect("cells should upsert");

    let (_updated_cells, unsupported_formulas) =
      recalculate_formulas(&db_path).expect("recalculation should work");
    assert_eq!(
      unsupported_formulas,
      vec!["=FACT(-1)".to_string(), "=COMBIN(5,7)".to_string()],
    );
  }

  #[test]
  fn should_leave_invalid_permut_family_inputs_as_unsupported() {
    let (_temp_dir, db_path) = create_initialized_db_path();
    let cells = vec![
      CellMutation {
        row: 1,
        col: 1,
        value: None,
        formula: Some("=PERMUT(5,7)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 2,
        value: None,
        formula: Some("=PERMUTATIONA(-1,2)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 3,
        value: None,
        formula: Some("=MULTINOMIAL(2,-1,3)".to_string()),
      },
    ];
    set_cells(&db_path, "Sheet1", &cells).expect("cells should upsert");

    let (_updated_cells, unsupported_formulas) =
      recalculate_formulas(&db_path).expect("recalculation should work");
    assert_eq!(
      unsupported_formulas,
      vec![
        "=PERMUT(5,7)".to_string(),
        "=PERMUTATIONA(-1,2)".to_string(),
        "=MULTINOMIAL(2,-1,3)".to_string(),
      ],
    );
  }

  #[test]
  fn should_leave_invalid_factdouble_and_combina_inputs_as_unsupported() {
    let (_temp_dir, db_path) = create_initialized_db_path();
    let cells = vec![
      CellMutation {
        row: 1,
        col: 1,
        value: None,
        formula: Some("=FACTDOUBLE(-1)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 2,
        value: None,
        formula: Some("=COMBINA(0,2)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 3,
        value: None,
        formula: Some("=COMBINA(-1,2)".to_string()),
      },
    ];
    set_cells(&db_path, "Sheet1", &cells).expect("cells should upsert");

    let (_updated_cells, unsupported_formulas) =
      recalculate_formulas(&db_path).expect("recalculation should work");
    assert_eq!(
      unsupported_formulas,
      vec![
        "=FACTDOUBLE(-1)".to_string(),
        "=COMBINA(0,2)".to_string(),
        "=COMBINA(-1,2)".to_string(),
      ],
    );
  }

  #[test]
  fn should_leave_invalid_large_small_k_as_unsupported() {
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
        formula: Some("=LARGE(A1:A2,0)".to_string()),
      },
      CellMutation {
        row: 2,
        col: 2,
        value: None,
        formula: Some("=SMALL(A1:A2,3)".to_string()),
      },
    ];
    set_cells(&db_path, "Sheet1", &cells).expect("cells should upsert");

    let (_updated_cells, unsupported_formulas) =
      recalculate_formulas(&db_path).expect("recalculation should work");
    assert_eq!(
      unsupported_formulas,
      vec!["=LARGE(A1:A2,0)".to_string(), "=SMALL(A1:A2,3)".to_string()],
    );
  }

  #[test]
  fn should_leave_invalid_percentile_quartile_as_unsupported() {
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
        formula: Some("=PERCENTILE.INC(A1:A2,1.5)".to_string()),
      },
      CellMutation {
        row: 2,
        col: 2,
        value: None,
        formula: Some("=QUARTILE.INC(A1:A2,5)".to_string()),
      },
      CellMutation {
        row: 3,
        col: 2,
        value: None,
        formula: Some("=PERCENTILE.EXC(A1:A2,0.9)".to_string()),
      },
      CellMutation {
        row: 4,
        col: 2,
        value: None,
        formula: Some("=QUARTILE.EXC(A1:A2,4)".to_string()),
      },
    ];
    set_cells(&db_path, "Sheet1", &cells).expect("cells should upsert");

    let (_updated_cells, unsupported_formulas) =
      recalculate_formulas(&db_path).expect("recalculation should work");
    assert_eq!(
      unsupported_formulas,
      vec![
        "=PERCENTILE.INC(A1:A2,1.5)".to_string(),
        "=QUARTILE.INC(A1:A2,5)".to_string(),
        "=PERCENTILE.EXC(A1:A2,0.9)".to_string(),
        "=QUARTILE.EXC(A1:A2,4)".to_string(),
      ],
    );
  }

  #[test]
  fn should_leave_invalid_percentrank_inputs_as_unsupported() {
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
        formula: Some("=PERCENTRANK.INC(A1:A2,200)".to_string()),
      },
      CellMutation {
        row: 2,
        col: 2,
        value: None,
        formula: Some("=PERCENTRANK.EXC(A1:A2,60)".to_string()),
      },
      CellMutation {
        row: 3,
        col: 2,
        value: None,
        formula: Some("=PERCENTRANK.INC(A1:A2,100,0)".to_string()),
      },
    ];
    set_cells(&db_path, "Sheet1", &cells).expect("cells should upsert");

    let (_updated_cells, unsupported_formulas) =
      recalculate_formulas(&db_path).expect("recalculation should work");
    assert_eq!(
      unsupported_formulas,
      vec![
        "=PERCENTRANK.INC(A1:A2,200)".to_string(),
        "=PERCENTRANK.EXC(A1:A2,60)".to_string(),
        "=PERCENTRANK.INC(A1:A2,100,0)".to_string(),
      ],
    );
  }

  #[test]
  fn should_leave_mode_without_duplicates_as_unsupported() {
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
        formula: Some("=MODE.SNGL(A1:A2)".to_string()),
      },
    ];
    set_cells(&db_path, "Sheet1", &cells).expect("cells should upsert");

    let (_updated_cells, unsupported_formulas) =
      recalculate_formulas(&db_path).expect("recalculation should work");
    assert_eq!(unsupported_formulas, vec!["=MODE.SNGL(A1:A2)".to_string()]);
  }

  #[test]
  fn should_leave_geomean_non_positive_input_as_unsupported() {
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
        value: Some(json!(0)),
        formula: None,
      },
      CellMutation {
        row: 1,
        col: 2,
        value: None,
        formula: Some("=GEOMEAN(A1:A2)".to_string()),
      },
    ];
    set_cells(&db_path, "Sheet1", &cells).expect("cells should upsert");

    let (_updated_cells, unsupported_formulas) =
      recalculate_formulas(&db_path).expect("recalculation should work");
    assert_eq!(unsupported_formulas, vec!["=GEOMEAN(A1:A2)".to_string()]);
  }

  #[test]
  fn should_leave_harmean_non_positive_input_as_unsupported() {
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
        value: Some(json!(0)),
        formula: None,
      },
      CellMutation {
        row: 1,
        col: 2,
        value: None,
        formula: Some("=HARMEAN(A1:A2)".to_string()),
      },
    ];
    set_cells(&db_path, "Sheet1", &cells).expect("cells should upsert");

    let (_updated_cells, unsupported_formulas) =
      recalculate_formulas(&db_path).expect("recalculation should work");
    assert_eq!(unsupported_formulas, vec!["=HARMEAN(A1:A2)".to_string()]);
  }

  #[test]
  fn should_leave_invalid_trimmean_percent_as_unsupported() {
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
        formula: Some("=TRIMMEAN(A1:A2,1)".to_string()),
      },
      CellMutation {
        row: 2,
        col: 2,
        value: None,
        formula: Some("=TRIMMEAN(A1:A2,-0.1)".to_string()),
      },
    ];
    set_cells(&db_path, "Sheet1", &cells).expect("cells should upsert");

    let (_updated_cells, unsupported_formulas) =
      recalculate_formulas(&db_path).expect("recalculation should work");
    assert_eq!(
      unsupported_formulas,
      vec![
        "=TRIMMEAN(A1:A2,1)".to_string(),
        "=TRIMMEAN(A1:A2,-0.1)".to_string(),
      ],
    );
  }

  #[test]
  fn should_leave_devsq_and_avedev_without_numeric_values_as_unsupported() {
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
        formula: Some("=DEVSQ(A1:A2)".to_string()),
      },
      CellMutation {
        row: 2,
        col: 2,
        value: None,
        formula: Some("=AVEDEV(A1:A2)".to_string()),
      },
    ];
    set_cells(&db_path, "Sheet1", &cells).expect("cells should upsert");

    let (_updated_cells, unsupported_formulas) =
      recalculate_formulas(&db_path).expect("recalculation should work");
    assert_eq!(
      unsupported_formulas,
      vec!["=DEVSQ(A1:A2)".to_string(), "=AVEDEV(A1:A2)".to_string()],
    );
  }

  #[test]
  fn should_leave_stdeva_and_vara_with_insufficient_values_as_unsupported() {
    let (_temp_dir, db_path) = create_initialized_db_path();
    let cells = vec![
      CellMutation {
        row: 1,
        col: 1,
        value: Some(json!(true)),
        formula: None,
      },
      CellMutation {
        row: 1,
        col: 2,
        value: None,
        formula: Some("=STDEVA(A1:A1)".to_string()),
      },
      CellMutation {
        row: 2,
        col: 2,
        value: None,
        formula: Some("=VARA(A1:A1)".to_string()),
      },
    ];
    set_cells(&db_path, "Sheet1", &cells).expect("cells should upsert");

    let (_updated_cells, unsupported_formulas) =
      recalculate_formulas(&db_path).expect("recalculation should work");
    assert_eq!(
      unsupported_formulas,
      vec!["=STDEVA(A1:A1)".to_string(), "=VARA(A1:A1)".to_string()],
    );
  }

  #[test]
  fn should_leave_mismatched_covariance_and_correl_ranges_as_unsupported() {
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
        row: 1,
        col: 3,
        value: None,
        formula: Some("=COVARIANCE.P(A1:A2,B1:B1)".to_string()),
      },
      CellMutation {
        row: 2,
        col: 3,
        value: None,
        formula: Some("=CORREL(A1:A2,B1:B1)".to_string()),
      },
      CellMutation {
        row: 3,
        col: 3,
        value: None,
        formula: Some("=COVAR(A1:A2,B1:B1)".to_string()),
      },
      CellMutation {
        row: 4,
        col: 3,
        value: None,
        formula: Some("=PEARSON(A1:A2,B1:B1)".to_string()),
      },
    ];
    set_cells(&db_path, "Sheet1", &cells).expect("cells should upsert");

    let (_updated_cells, unsupported_formulas) =
      recalculate_formulas(&db_path).expect("recalculation should work");
    assert_eq!(
      unsupported_formulas,
      vec![
        "=COVARIANCE.P(A1:A2,B1:B1)".to_string(),
        "=CORREL(A1:A2,B1:B1)".to_string(),
        "=COVAR(A1:A2,B1:B1)".to_string(),
        "=PEARSON(A1:A2,B1:B1)".to_string(),
      ],
    );
  }

  #[test]
  fn should_leave_correl_with_zero_variance_as_unsupported() {
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
        value: Some(json!(120)),
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
        row: 1,
        col: 3,
        value: None,
        formula: Some("=CORREL(A1:A2,B1:B2)".to_string()),
      },
    ];
    set_cells(&db_path, "Sheet1", &cells).expect("cells should upsert");

    let (_updated_cells, unsupported_formulas) =
      recalculate_formulas(&db_path).expect("recalculation should work");
    assert_eq!(unsupported_formulas, vec!["=CORREL(A1:A2,B1:B2)".to_string()]);
  }

  #[test]
  fn should_leave_mismatched_slope_intercept_rsq_ranges_as_unsupported() {
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
        value: Some(json!(120)),
        formula: None,
      },
      CellMutation {
        row: 1,
        col: 3,
        value: None,
        formula: Some("=SLOPE(B1:B2,A1:A1)".to_string()),
      },
      CellMutation {
        row: 2,
        col: 3,
        value: None,
        formula: Some("=INTERCEPT(B1:B2,A1:A1)".to_string()),
      },
      CellMutation {
        row: 3,
        col: 3,
        value: None,
        formula: Some("=RSQ(B1:B2,A1:A1)".to_string()),
      },
    ];
    set_cells(&db_path, "Sheet1", &cells).expect("cells should upsert");

    let (_updated_cells, unsupported_formulas) =
      recalculate_formulas(&db_path).expect("recalculation should work");
    assert_eq!(
      unsupported_formulas,
      vec![
        "=SLOPE(B1:B2,A1:A1)".to_string(),
        "=INTERCEPT(B1:B2,A1:A1)".to_string(),
        "=RSQ(B1:B2,A1:A1)".to_string(),
      ],
    );
  }

  #[test]
  fn should_leave_slope_intercept_rsq_with_zero_x_variance_as_unsupported() {
    let (_temp_dir, db_path) = create_initialized_db_path();
    let cells = vec![
      CellMutation {
        row: 1,
        col: 1,
        value: Some(json!(100)),
        formula: None,
      },
      CellMutation {
        row: 2,
        col: 1,
        value: Some(json!(100)),
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
        row: 1,
        col: 3,
        value: None,
        formula: Some("=SLOPE(B1:B2,A1:A2)".to_string()),
      },
      CellMutation {
        row: 2,
        col: 3,
        value: None,
        formula: Some("=INTERCEPT(B1:B2,A1:A2)".to_string()),
      },
      CellMutation {
        row: 3,
        col: 3,
        value: None,
        formula: Some("=RSQ(B1:B2,A1:A2)".to_string()),
      },
    ];
    set_cells(&db_path, "Sheet1", &cells).expect("cells should upsert");

    let (_updated_cells, unsupported_formulas) =
      recalculate_formulas(&db_path).expect("recalculation should work");
    assert_eq!(
      unsupported_formulas,
      vec![
        "=SLOPE(B1:B2,A1:A2)".to_string(),
        "=INTERCEPT(B1:B2,A1:A2)".to_string(),
        "=RSQ(B1:B2,A1:A2)".to_string(),
      ],
    );
  }

  #[test]
  fn should_leave_forecast_and_steyx_invalid_inputs_as_unsupported() {
    let (_temp_dir, db_path) = create_initialized_db_path();
    let cells = vec![
      CellMutation {
        row: 1,
        col: 1,
        value: Some(json!(100)),
        formula: None,
      },
      CellMutation {
        row: 2,
        col: 1,
        value: Some(json!(100)),
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
        row: 1,
        col: 3,
        value: None,
        formula: Some("=FORECAST.LINEAR(4,B1:B2,A1:A1)".to_string()),
      },
      CellMutation {
        row: 2,
        col: 3,
        value: None,
        formula: Some("=FORECAST(4,B1:B2,A1:A2)".to_string()),
      },
      CellMutation {
        row: 3,
        col: 3,
        value: None,
        formula: Some("=STEYX(B1:B2,A1:A2)".to_string()),
      },
    ];
    set_cells(&db_path, "Sheet1", &cells).expect("cells should upsert");

    let (_updated_cells, unsupported_formulas) =
      recalculate_formulas(&db_path).expect("recalculation should work");
    assert_eq!(
      unsupported_formulas,
      vec![
        "=FORECAST.LINEAR(4,B1:B2,A1:A1)".to_string(),
        "=FORECAST(4,B1:B2,A1:A2)".to_string(),
        "=STEYX(B1:B2,A1:A2)".to_string(),
      ],
    );
  }

  #[test]
  fn should_leave_skew_and_kurt_with_insufficient_values_as_unsupported() {
    let (_temp_dir, db_path) = create_initialized_db_path();
    let cells = vec![
      CellMutation {
        row: 1,
        col: 1,
        value: Some(json!(1)),
        formula: None,
      },
      CellMutation {
        row: 2,
        col: 1,
        value: Some(json!(2)),
        formula: None,
      },
      CellMutation {
        row: 3,
        col: 1,
        value: Some(json!(3)),
        formula: None,
      },
      CellMutation {
        row: 1,
        col: 2,
        value: None,
        formula: Some("=SKEW(A1:A2)".to_string()),
      },
      CellMutation {
        row: 2,
        col: 2,
        value: None,
        formula: Some("=KURT(A1:A3)".to_string()),
      },
    ];
    set_cells(&db_path, "Sheet1", &cells).expect("cells should upsert");

    let (_updated_cells, unsupported_formulas) =
      recalculate_formulas(&db_path).expect("recalculation should work");
    assert_eq!(
      unsupported_formulas,
      vec!["=SKEW(A1:A2)".to_string(), "=KURT(A1:A3)".to_string()],
    );
  }

  #[test]
  fn should_leave_skew_and_kurt_with_zero_variance_as_unsupported() {
    let (_temp_dir, db_path) = create_initialized_db_path();
    let cells = vec![
      CellMutation {
        row: 1,
        col: 1,
        value: Some(json!(5)),
        formula: None,
      },
      CellMutation {
        row: 2,
        col: 1,
        value: Some(json!(5)),
        formula: None,
      },
      CellMutation {
        row: 3,
        col: 1,
        value: Some(json!(5)),
        formula: None,
      },
      CellMutation {
        row: 4,
        col: 1,
        value: Some(json!(5)),
        formula: None,
      },
      CellMutation {
        row: 1,
        col: 2,
        value: None,
        formula: Some("=SKEW(A1:A4)".to_string()),
      },
      CellMutation {
        row: 2,
        col: 2,
        value: None,
        formula: Some("=KURT(A1:A4)".to_string()),
      },
      CellMutation {
        row: 3,
        col: 2,
        value: None,
        formula: Some("=SKEW.P(A1:A4)".to_string()),
      },
    ];
    set_cells(&db_path, "Sheet1", &cells).expect("cells should upsert");

    let (_updated_cells, unsupported_formulas) =
      recalculate_formulas(&db_path).expect("recalculation should work");
    assert_eq!(
      unsupported_formulas,
      vec![
        "=SKEW(A1:A4)".to_string(),
        "=KURT(A1:A4)".to_string(),
        "=SKEW.P(A1:A4)".to_string(),
      ],
    );
  }

  #[test]
  fn should_leave_fisher_out_of_domain_as_unsupported() {
    let (_temp_dir, db_path) = create_initialized_db_path();
    let cells = vec![
      CellMutation {
        row: 1,
        col: 1,
        value: None,
        formula: Some("=FISHER(1)".to_string()),
      },
      CellMutation {
        row: 2,
        col: 1,
        value: None,
        formula: Some("=FISHER(-1.2)".to_string()),
      },
    ];
    set_cells(&db_path, "Sheet1", &cells).expect("cells should upsert");

    let (_updated_cells, unsupported_formulas) =
      recalculate_formulas(&db_path).expect("recalculation should work");
    assert_eq!(
      unsupported_formulas,
      vec!["=FISHER(1)".to_string(), "=FISHER(-1.2)".to_string()],
    );
  }

  #[test]
  fn should_leave_non_numeric_lcm_input_as_unsupported() {
    let (_temp_dir, db_path) = create_initialized_db_path();
    let cells = vec![CellMutation {
      row: 1,
      col: 1,
      value: None,
      formula: Some(r#"=LCM("north",6)"#.to_string()),
    }];
    set_cells(&db_path, "Sheet1", &cells).expect("cells should upsert");

    let (_updated_cells, unsupported_formulas) =
      recalculate_formulas(&db_path).expect("recalculation should work");
    assert_eq!(unsupported_formulas, vec![r#"=LCM("north",6)"#.to_string()]);
  }

  #[test]
  fn should_leave_inverse_trig_out_of_domain_as_unsupported() {
    let (_temp_dir, db_path) = create_initialized_db_path();
    let cells = vec![
      CellMutation {
        row: 1,
        col: 1,
        value: None,
        formula: Some("=ASIN(2)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 2,
        value: None,
        formula: Some("=ACOS(-2)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 3,
        value: None,
        formula: Some("=ACOSH(0.5)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 4,
        value: None,
        formula: Some("=ATANH(1)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 5,
        value: None,
        formula: Some("=ACOTH(1)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 6,
        value: None,
        formula: Some("=ASEC(0.5)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 7,
        value: None,
        formula: Some("=ACSC(0.5)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 8,
        value: None,
        formula: Some("=ASECH(1.5)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 9,
        value: None,
        formula: Some("=ACSCH(0)".to_string()),
      },
    ];
    set_cells(&db_path, "Sheet1", &cells).expect("cells should upsert");

    let (_updated_cells, unsupported_formulas) =
      recalculate_formulas(&db_path).expect("recalculation should work");
    assert_eq!(
      unsupported_formulas,
      vec![
        "=ASIN(2)".to_string(),
        "=ACOS(-2)".to_string(),
        "=ACOSH(0.5)".to_string(),
        "=ATANH(1)".to_string(),
        "=ACOTH(1)".to_string(),
        "=ASEC(0.5)".to_string(),
        "=ACSC(0.5)".to_string(),
        "=ASECH(1.5)".to_string(),
        "=ACSCH(0)".to_string(),
      ],
    );
  }

  #[test]
  fn should_leave_reciprocal_trig_zero_denominator_as_unsupported() {
    let (_temp_dir, db_path) = create_initialized_db_path();
    let cells = vec![
      CellMutation {
        row: 1,
        col: 1,
        value: None,
        formula: Some("=COT(0)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 2,
        value: None,
        formula: Some("=SEC(1.5707963267948966)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 3,
        value: None,
        formula: Some("=CSC(0)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 4,
        value: None,
        formula: Some("=COTH(0)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 5,
        value: None,
        formula: Some("=CSCH(0)".to_string()),
      },
    ];
    set_cells(&db_path, "Sheet1", &cells).expect("cells should upsert");

    let (_updated_cells, unsupported_formulas) =
      recalculate_formulas(&db_path).expect("recalculation should work");
    assert_eq!(
      unsupported_formulas,
      vec![
        "=COT(0)".to_string(),
        "=SEC(1.5707963267948966)".to_string(),
        "=CSC(0)".to_string(),
        "=COTH(0)".to_string(),
        "=CSCH(0)".to_string(),
      ],
    );
  }

  #[test]
  fn should_leave_isodd_text_input_as_unsupported() {
    let (_temp_dir, db_path) = create_initialized_db_path();
    let cells = vec![CellMutation {
      row: 1,
      col: 1,
      value: None,
      formula: Some(r#"=ISODD("north")"#.to_string()),
    }];
    set_cells(&db_path, "Sheet1", &cells).expect("cells should upsert");

    let (_updated_cells, unsupported_formulas) =
      recalculate_formulas(&db_path).expect("recalculation should work");
    assert_eq!(unsupported_formulas, vec![r#"=ISODD("north")"#.to_string()]);
  }

  #[test]
  fn should_leave_even_non_numeric_input_as_unsupported() {
    let (_temp_dir, db_path) = create_initialized_db_path();
    let cells = vec![CellMutation {
      row: 1,
      col: 1,
      value: None,
      formula: Some(r#"=EVEN("north")"#.to_string()),
    }];
    set_cells(&db_path, "Sheet1", &cells).expect("cells should upsert");

    let (_updated_cells, unsupported_formulas) =
      recalculate_formulas(&db_path).expect("recalculation should work");
    assert_eq!(unsupported_formulas, vec![r#"=EVEN("north")"#.to_string()]);
  }

  #[test]
  fn should_leave_rows_non_range_input_as_unsupported() {
    let (_temp_dir, db_path) = create_initialized_db_path();
    let cells = vec![CellMutation {
      row: 1,
      col: 1,
      value: None,
      formula: Some(r#"=ROWS("north")"#.to_string()),
    }];
    set_cells(&db_path, "Sheet1", &cells).expect("cells should upsert");

    let (_updated_cells, unsupported_formulas) =
      recalculate_formulas(&db_path).expect("recalculation should work");
    assert_eq!(unsupported_formulas, vec![r#"=ROWS("north")"#.to_string()]);
  }

  #[test]
  fn should_leave_rept_negative_count_as_unsupported() {
    let (_temp_dir, db_path) = create_initialized_db_path();
    let cells = vec![CellMutation {
      row: 1,
      col: 1,
      value: None,
      formula: Some(r#"=REPT("na",-1)"#.to_string()),
    }];
    set_cells(&db_path, "Sheet1", &cells).expect("cells should upsert");

    let (_updated_cells, unsupported_formulas) =
      recalculate_formulas(&db_path).expect("recalculation should work");
    assert_eq!(unsupported_formulas, vec![r#"=REPT("na",-1)"#.to_string()]);
  }

  #[test]
  fn should_leave_search_without_match_as_unsupported() {
    let (_temp_dir, db_path) = create_initialized_db_path();
    let cells = vec![CellMutation {
      row: 1,
      col: 1,
      value: None,
      formula: Some(r#"=SEARCH("z","north")"#.to_string()),
    }];
    set_cells(&db_path, "Sheet1", &cells).expect("cells should upsert");

    let (_updated_cells, unsupported_formulas) =
      recalculate_formulas(&db_path).expect("recalculation should work");
    assert_eq!(unsupported_formulas, vec![r#"=SEARCH("z","north")"#.to_string()]);
  }

  #[test]
  fn should_leave_find_case_mismatch_as_unsupported() {
    let (_temp_dir, db_path) = create_initialized_db_path();
    let cells = vec![CellMutation {
      row: 1,
      col: 1,
      value: None,
      formula: Some(r#"=FIND("S","southeast")"#.to_string()),
    }];
    set_cells(&db_path, "Sheet1", &cells).expect("cells should upsert");

    let (_updated_cells, unsupported_formulas) =
      recalculate_formulas(&db_path).expect("recalculation should work");
    assert_eq!(unsupported_formulas, vec![r#"=FIND("S","southeast")"#.to_string()]);
  }

  #[test]
  fn should_leave_replace_invalid_start_as_unsupported() {
    let (_temp_dir, db_path) = create_initialized_db_path();
    let cells = vec![CellMutation {
      row: 1,
      col: 1,
      value: None,
      formula: Some(r#"=REPLACE("spreadsheet",0,2,"x")"#.to_string()),
    }];
    set_cells(&db_path, "Sheet1", &cells).expect("cells should upsert");

    let (_updated_cells, unsupported_formulas) =
      recalculate_formulas(&db_path).expect("recalculation should work");
    assert_eq!(
      unsupported_formulas,
      vec![r#"=REPLACE("spreadsheet",0,2,"x")"#.to_string()]
    );
  }

  #[test]
  fn should_leave_substitute_invalid_instance_as_unsupported() {
    let (_temp_dir, db_path) = create_initialized_db_path();
    let cells = vec![CellMutation {
      row: 1,
      col: 1,
      value: None,
      formula: Some(r#"=SUBSTITUTE("north-north","north","south",0)"#.to_string()),
    }];
    set_cells(&db_path, "Sheet1", &cells).expect("cells should upsert");

    let (_updated_cells, unsupported_formulas) =
      recalculate_formulas(&db_path).expect("recalculation should work");
    assert_eq!(
      unsupported_formulas,
      vec![r#"=SUBSTITUTE("north-north","north","south",0)"#.to_string()]
    );
  }

  #[test]
  fn should_leave_value_non_numeric_text_as_unsupported() {
    let (_temp_dir, db_path) = create_initialized_db_path();
    let cells = vec![CellMutation {
      row: 1,
      col: 1,
      value: None,
      formula: Some(r#"=VALUE("north")"#.to_string()),
    }];
    set_cells(&db_path, "Sheet1", &cells).expect("cells should upsert");

    let (_updated_cells, unsupported_formulas) =
      recalculate_formulas(&db_path).expect("recalculation should work");
    assert_eq!(unsupported_formulas, vec![r#"=VALUE("north")"#.to_string()]);
  }

  #[test]
  fn should_leave_char_out_of_range_as_unsupported() {
    let (_temp_dir, db_path) = create_initialized_db_path();
    let cells = vec![CellMutation {
      row: 1,
      col: 1,
      value: None,
      formula: Some("=CHAR(0)".to_string()),
    }];
    set_cells(&db_path, "Sheet1", &cells).expect("cells should upsert");

    let (_updated_cells, unsupported_formulas) =
      recalculate_formulas(&db_path).expect("recalculation should work");
    assert_eq!(unsupported_formulas, vec!["=CHAR(0)".to_string()]);
  }

  #[test]
  fn should_leave_code_empty_text_as_unsupported() {
    let (_temp_dir, db_path) = create_initialized_db_path();
    let cells = vec![CellMutation {
      row: 1,
      col: 1,
      value: None,
      formula: Some(r#"=CODE("")"#.to_string()),
    }];
    set_cells(&db_path, "Sheet1", &cells).expect("cells should upsert");

    let (_updated_cells, unsupported_formulas) =
      recalculate_formulas(&db_path).expect("recalculation should work");
    assert_eq!(unsupported_formulas, vec![r#"=CODE("")"#.to_string()]);
  }

  #[test]
  fn should_leave_unichar_out_of_range_as_unsupported() {
    let (_temp_dir, db_path) = create_initialized_db_path();
    let cells = vec![CellMutation {
      row: 1,
      col: 1,
      value: None,
      formula: Some("=UNICHAR(1114112)".to_string()),
    }];
    set_cells(&db_path, "Sheet1", &cells).expect("cells should upsert");

    let (_updated_cells, unsupported_formulas) =
      recalculate_formulas(&db_path).expect("recalculation should work");
    assert_eq!(unsupported_formulas, vec!["=UNICHAR(1114112)".to_string()]);
  }

  #[test]
  fn should_leave_unicode_empty_text_as_unsupported() {
    let (_temp_dir, db_path) = create_initialized_db_path();
    let cells = vec![CellMutation {
      row: 1,
      col: 1,
      value: None,
      formula: Some(r#"=UNICODE("")"#.to_string()),
    }];
    set_cells(&db_path, "Sheet1", &cells).expect("cells should upsert");

    let (_updated_cells, unsupported_formulas) =
      recalculate_formulas(&db_path).expect("recalculation should work");
    assert_eq!(unsupported_formulas, vec![r#"=UNICODE("")"#.to_string()]);
  }

  #[test]
  fn should_leave_invalid_roman_inputs_as_unsupported() {
    let (_temp_dir, db_path) = create_initialized_db_path();
    let cells = vec![
      CellMutation {
        row: 1,
        col: 1,
        value: None,
        formula: Some("=ROMAN(0)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 2,
        value: None,
        formula: Some("=ROMAN(10,1)".to_string()),
      },
      CellMutation {
        row: 1,
        col: 3,
        value: None,
        formula: Some(r#"=ARABIC("IC")"#.to_string()),
      },
    ];
    set_cells(&db_path, "Sheet1", &cells).expect("cells should upsert");

    let (_updated_cells, unsupported_formulas) =
      recalculate_formulas(&db_path).expect("recalculation should work");
    assert_eq!(
      unsupported_formulas,
      vec![
        "=ROMAN(0)".to_string(),
        "=ROMAN(10,1)".to_string(),
        r#"=ARABIC("IC")"#.to_string(),
      ],
    );
  }

  #[test]
  fn should_leave_ifs_without_matching_condition_as_unsupported() {
    let (_temp_dir, db_path) = create_initialized_db_path();
    let cells = vec![CellMutation {
      row: 1,
      col: 1,
      value: None,
      formula: Some(r#"=IFS(FALSE,"no",0>1,"still-no")"#.to_string()),
    }];
    set_cells(&db_path, "Sheet1", &cells).expect("cells should upsert");

    let (_updated_cells, unsupported_formulas) =
      recalculate_formulas(&db_path).expect("recalculation should work");
    assert_eq!(
      unsupported_formulas,
      vec![r#"=IFS(FALSE,"no",0>1,"still-no")"#.to_string()],
    );
  }

  #[test]
  fn should_leave_switch_without_default_and_match_as_unsupported() {
    let (_temp_dir, db_path) = create_initialized_db_path();
    let cells = vec![CellMutation {
      row: 1,
      col: 1,
      value: None,
      formula: Some(r#"=SWITCH("west","north","N","south","S")"#.to_string()),
    }];
    set_cells(&db_path, "Sheet1", &cells).expect("cells should upsert");

    let (_updated_cells, unsupported_formulas) =
      recalculate_formulas(&db_path).expect("recalculation should work");
    assert_eq!(
      unsupported_formulas,
      vec![r#"=SWITCH("west","north","N","south","S")"#.to_string()],
    );
  }

  #[test]
  fn should_leave_invalid_datevalue_and_timevalue_as_unsupported() {
    let (_temp_dir, db_path) = create_initialized_db_path();
    let cells = vec![
      CellMutation {
        row: 1,
        col: 1,
        value: None,
        formula: Some(r#"=DATEVALUE("not-a-date")"#.to_string()),
      },
      CellMutation {
        row: 1,
        col: 2,
        value: None,
        formula: Some(r#"=TIMEVALUE("bad-time")"#.to_string()),
      },
    ];
    set_cells(&db_path, "Sheet1", &cells).expect("cells should upsert");

    let (_updated_cells, unsupported_formulas) =
      recalculate_formulas(&db_path).expect("recalculation should work");
    assert_eq!(
      unsupported_formulas,
      vec![
        r#"=DATEVALUE("not-a-date")"#.to_string(),
        r#"=TIMEVALUE("bad-time")"#.to_string(),
      ],
    );
  }

  #[test]
  fn should_leave_invalid_time_inputs_as_unsupported() {
    let (_temp_dir, db_path) = create_initialized_db_path();
    let cells = vec![CellMutation {
      row: 1,
      col: 1,
      value: None,
      formula: Some("=TIME(-1,10,0)".to_string()),
    }];
    set_cells(&db_path, "Sheet1", &cells).expect("cells should upsert");

    let (_updated_cells, unsupported_formulas) =
      recalculate_formulas(&db_path).expect("recalculation should work");
    assert_eq!(unsupported_formulas, vec!["=TIME(-1,10,0)".to_string()]);
  }

  #[test]
  fn should_leave_invalid_datedif_inputs_as_unsupported() {
    let (_temp_dir, db_path) = create_initialized_db_path();
    let cells = vec![
      CellMutation {
        row: 1,
        col: 1,
        value: None,
        formula: Some(r#"=DATEDIF("2024-03-15","2024-01-31","D")"#.to_string()),
      },
      CellMutation {
        row: 1,
        col: 2,
        value: None,
        formula: Some(r#"=DATEDIF("2024-01-31","2024-03-15","BAD")"#.to_string()),
      },
    ];
    set_cells(&db_path, "Sheet1", &cells).expect("cells should upsert");

    let (_updated_cells, unsupported_formulas) =
      recalculate_formulas(&db_path).expect("recalculation should work");
    assert_eq!(
      unsupported_formulas,
      vec![
        r#"=DATEDIF("2024-03-15","2024-01-31","D")"#.to_string(),
        r#"=DATEDIF("2024-01-31","2024-03-15","BAD")"#.to_string(),
      ],
    );
  }

  #[test]
  fn should_leave_invalid_days360_inputs_as_unsupported() {
    let (_temp_dir, db_path) = create_initialized_db_path();
    let cells = vec![CellMutation {
      row: 1,
      col: 1,
      value: None,
      formula: Some(r#"=DAYS360("bad","2024-03-31")"#.to_string()),
    }];
    set_cells(&db_path, "Sheet1", &cells).expect("cells should upsert");

    let (_updated_cells, unsupported_formulas) =
      recalculate_formulas(&db_path).expect("recalculation should work");
    assert_eq!(
      unsupported_formulas,
      vec![r#"=DAYS360("bad","2024-03-31")"#.to_string()],
    );
  }

  #[test]
  fn should_leave_invalid_networkdays_inputs_as_unsupported() {
    let (_temp_dir, db_path) = create_initialized_db_path();
    let cells = vec![
      CellMutation {
        row: 1,
        col: 1,
        value: None,
        formula: Some(r#"=NETWORKDAYS("bad","2024-03-10")"#.to_string()),
      },
      CellMutation {
        row: 1,
        col: 2,
        value: None,
        formula: Some(r#"=NETWORKDAYS("2024-03-01","2024-03-10","not-a-date")"#.to_string()),
      },
    ];
    set_cells(&db_path, "Sheet1", &cells).expect("cells should upsert");

    let (_updated_cells, unsupported_formulas) =
      recalculate_formulas(&db_path).expect("recalculation should work");
    assert_eq!(
      unsupported_formulas,
      vec![
        r#"=NETWORKDAYS("bad","2024-03-10")"#.to_string(),
        r#"=NETWORKDAYS("2024-03-01","2024-03-10","not-a-date")"#.to_string(),
      ],
    );
  }

  #[test]
  fn should_leave_invalid_workday_inputs_as_unsupported() {
    let (_temp_dir, db_path) = create_initialized_db_path();
    let cells = vec![
      CellMutation {
        row: 1,
        col: 1,
        value: None,
        formula: Some(r#"=WORKDAY("bad",5)"#.to_string()),
      },
      CellMutation {
        row: 1,
        col: 2,
        value: None,
        formula: Some(r#"=WORKDAY("2024-03-01",5,"not-a-date")"#.to_string()),
      },
    ];
    set_cells(&db_path, "Sheet1", &cells).expect("cells should upsert");

    let (_updated_cells, unsupported_formulas) =
      recalculate_formulas(&db_path).expect("recalculation should work");
    assert_eq!(
      unsupported_formulas,
      vec![
        r#"=WORKDAY("bad",5)"#.to_string(),
        r#"=WORKDAY("2024-03-01",5,"not-a-date")"#.to_string(),
      ],
    );
  }

  #[test]
  fn should_leave_invalid_intl_weekend_patterns_as_unsupported() {
    let (_temp_dir, db_path) = create_initialized_db_path();
    let cells = vec![
      CellMutation {
        row: 1,
        col: 1,
        value: None,
        formula: Some(r#"=NETWORKDAYS.INTL("2024-03-01","2024-03-10",99)"#.to_string()),
      },
      CellMutation {
        row: 1,
        col: 2,
        value: None,
        formula: Some(
          r#"=WORKDAY.INTL("2024-03-01",5,"1111111")"#.to_string(),
        ),
      },
    ];
    set_cells(&db_path, "Sheet1", &cells).expect("cells should upsert");

    let (_updated_cells, unsupported_formulas) =
      recalculate_formulas(&db_path).expect("recalculation should work");
    assert_eq!(
      unsupported_formulas,
      vec![
        r#"=NETWORKDAYS.INTL("2024-03-01","2024-03-10",99)"#.to_string(),
        r#"=WORKDAY.INTL("2024-03-01",5,"1111111")"#.to_string(),
      ],
    );
  }

  #[test]
  fn should_leave_true_with_argument_as_unsupported() {
    let (_temp_dir, db_path) = create_initialized_db_path();
    let cells = vec![CellMutation {
      row: 1,
      col: 1,
      value: None,
      formula: Some("=TRUE(1)".to_string()),
    }];
    set_cells(&db_path, "Sheet1", &cells).expect("cells should upsert");

    let (_updated_cells, unsupported_formulas) =
      recalculate_formulas(&db_path).expect("recalculation should work");
    assert_eq!(unsupported_formulas, vec!["=TRUE(1)".to_string()]);
  }

  #[test]
  fn should_leave_randbetween_invalid_bounds_as_unsupported() {
    let (_temp_dir, db_path) = create_initialized_db_path();
    let cells = vec![CellMutation {
      row: 1,
      col: 1,
      value: None,
      formula: Some("=RANDBETWEEN(6,1)".to_string()),
    }];
    set_cells(&db_path, "Sheet1", &cells).expect("cells should upsert");

    let (_updated_cells, unsupported_formulas) =
      recalculate_formulas(&db_path).expect("recalculation should work");
    assert_eq!(unsupported_formulas, vec!["=RANDBETWEEN(6,1)".to_string()]);
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
  fn should_leave_mismatched_sumproduct_ranges_as_unsupported() {
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
        row: 3,
        col: 2,
        value: Some(json!(15)),
        formula: None,
      },
      CellMutation {
        row: 4,
        col: 1,
        value: None,
        formula: Some("=SUMPRODUCT(A1:A2,B1:B3)".to_string()),
      },
    ];
    set_cells(&db_path, "Sheet1", &cells).expect("cells should upsert");

    let (_updated_cells, unsupported_formulas) =
      recalculate_formulas(&db_path).expect("recalculation should work");
    assert_eq!(
      unsupported_formulas,
      vec!["=SUMPRODUCT(A1:A2,B1:B3)".to_string()]
    );
  }

  #[test]
  fn should_leave_mismatched_sumx_ranges_as_unsupported() {
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
        row: 3,
        col: 2,
        value: Some(json!(15)),
        formula: None,
      },
      CellMutation {
        row: 4,
        col: 1,
        value: None,
        formula: Some("=SUMXMY2(A1:A2,B1:B3)".to_string()),
      },
      CellMutation {
        row: 5,
        col: 1,
        value: None,
        formula: Some("=SUMX2MY2(A1:A2,B1:B3)".to_string()),
      },
      CellMutation {
        row: 6,
        col: 1,
        value: None,
        formula: Some("=SUMX2PY2(A1:A2,B1:B3)".to_string()),
      },
    ];
    set_cells(&db_path, "Sheet1", &cells).expect("cells should upsert");

    let (_updated_cells, unsupported_formulas) =
      recalculate_formulas(&db_path).expect("recalculation should work");
    assert_eq!(
      unsupported_formulas,
      vec![
        "=SUMXMY2(A1:A2,B1:B3)".to_string(),
        "=SUMX2MY2(A1:A2,B1:B3)".to_string(),
        "=SUMX2PY2(A1:A2,B1:B3)".to_string(),
      ]
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

  #[test]
  fn should_leave_mismatched_minifs_ranges_as_unsupported() {
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
        formula: Some(r#"=MINIFS(A1:A2,B1:B2,"south",A1:A3,">=80")"#.to_string()),
      },
    ];
    set_cells(&db_path, "Sheet1", &cells).expect("cells should upsert");

    let (_updated_cells, unsupported_formulas) =
      recalculate_formulas(&db_path).expect("recalculation should work");
    assert_eq!(
      unsupported_formulas,
      vec![r#"=MINIFS(A1:A2,B1:B2,"south",A1:A3,">=80")"#.to_string()]
    );
  }
}

