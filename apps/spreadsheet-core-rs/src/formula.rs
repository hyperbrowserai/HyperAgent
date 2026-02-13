use regex::Regex;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VLookupFormula {
  pub lookup_value: String,
  pub table_start: (u32, u32),
  pub table_end: (u32, u32),
  pub result_col_index: u32,
  pub range_lookup: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct XLookupFormula {
  pub lookup_value: String,
  pub lookup_array_start: (u32, u32),
  pub lookup_array_end: (u32, u32),
  pub return_array_start: (u32, u32),
  pub return_array_end: (u32, u32),
  pub if_not_found: Option<String>,
  pub match_mode: Option<String>,
  pub search_mode: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MatchFormula {
  pub lookup_value: String,
  pub array_start: (u32, u32),
  pub array_end: (u32, u32),
  pub match_type: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IndexFormula {
  pub array_start: (u32, u32),
  pub array_end: (u32, u32),
  pub row_num: String,
  pub col_num: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConditionalAggregateFormula {
  pub criteria_range_start: (u32, u32),
  pub criteria_range_end: (u32, u32),
  pub criteria: String,
  pub value_range_start: Option<(u32, u32)>,
  pub value_range_end: Option<(u32, u32)>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CriteriaCondition {
  pub range_start: (u32, u32),
  pub range_end: (u32, u32),
  pub criteria: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MultiCriteriaAggregateFormula {
  pub value_range_start: Option<(u32, u32)>,
  pub value_range_end: Option<(u32, u32)>,
  pub conditions: Vec<CriteriaCondition>,
}

pub fn address_from_row_col(row: u32, col: u32) -> String {
  format!("{}{}", index_to_col(col), row)
}

pub fn index_to_col(mut col: u32) -> String {
  if col == 0 {
    return "A".to_string();
  }

  let mut label = String::new();
  while col > 0 {
    let rem = ((col - 1) % 26) as u8;
    label.insert(0, (b'A' + rem) as char);
    col = (col - 1) / 26;
  }
  label
}

pub fn parse_cell_address(value: &str) -> Option<(u32, u32)> {
  let cleaned = value.trim().replace('$', "");
  let re = Regex::new(r"^([A-Za-z]+)(\d+)$").ok()?;
  let captures = re.captures(&cleaned)?;

  let col_label = captures.get(1)?.as_str().to_uppercase();
  let row = captures.get(2)?.as_str().parse::<u32>().ok()?;
  let col = col_label
    .chars()
    .fold(0u32, |acc, ch| acc * 26 + (ch as u32 - 'A' as u32 + 1));

  if row == 0 || col == 0 {
    return None;
  }

  Some((row, col))
}

pub fn parse_aggregate_formula(formula: &str) -> Option<(String, (u32, u32), (u32, u32))> {
  let re =
    Regex::new(r"^=\s*(SUM|AVERAGE|MIN|MAX|COUNT)\s*\(\s*([A-Za-z]+\d+)\s*:\s*([A-Za-z]+\d+)\s*\)\s*$")
      .ok()?;
  let captures = re.captures(formula.trim())?;
  let function = captures.get(1)?.as_str().to_uppercase();
  let start = parse_cell_address(captures.get(2)?.as_str())?;
  let end = parse_cell_address(captures.get(3)?.as_str())?;
  Some((function, start, end))
}

pub fn parse_single_ref_formula(formula: &str) -> Option<(u32, u32)> {
  let re = Regex::new(r"^=\s*([A-Za-z]+\d+)\s*$").ok()?;
  let captures = re.captures(formula.trim())?;
  parse_cell_address(captures.get(1)?.as_str())
}

pub fn parse_if_formula(formula: &str) -> Option<(String, String, String)> {
  let (function, args) = parse_function_arguments(formula)?;
  if function != "IF" || args.len() != 3 {
    return None;
  }

  Some((args[0].clone(), args[1].clone(), args[2].clone()))
}

pub fn parse_concat_formula(formula: &str) -> Option<Vec<String>> {
  let (function, args) = parse_function_arguments(formula)?;
  if (function != "CONCAT" && function != "CONCATENATE") || args.is_empty() {
    return None;
  }
  Some(args)
}

pub fn parse_today_formula(formula: &str) -> Option<()> {
  let (function, args) = parse_function_arguments(formula)?;
  if function == "TODAY" && args.is_empty() {
    return Some(());
  }
  None
}

pub fn parse_vlookup_formula(formula: &str) -> Option<VLookupFormula> {
  let (function, args) = parse_function_arguments(formula)?;
  if function != "VLOOKUP" || !(args.len() == 3 || args.len() == 4) {
    return None;
  }
  let (table_start, table_end) = parse_range_reference(&args[1])?;
  let result_col_index = args[2].trim().parse::<u32>().ok()?;
  if result_col_index == 0 {
    return None;
  }

  Some(VLookupFormula {
    lookup_value: args[0].clone(),
    table_start,
    table_end,
    result_col_index,
    range_lookup: args.get(3).cloned(),
  })
}

pub fn parse_xlookup_formula(formula: &str) -> Option<XLookupFormula> {
  let (function, args) = parse_function_arguments(formula)?;
  if function != "XLOOKUP" || !(3..=6).contains(&args.len()) {
    return None;
  }
  let (lookup_array_start, lookup_array_end) = parse_range_reference(&args[1])?;
  let (return_array_start, return_array_end) = parse_range_reference(&args[2])?;
  Some(XLookupFormula {
    lookup_value: args[0].clone(),
    lookup_array_start,
    lookup_array_end,
    return_array_start,
    return_array_end,
    if_not_found: args.get(3).cloned(),
    match_mode: args.get(4).cloned(),
    search_mode: args.get(5).cloned(),
  })
}

pub fn parse_match_formula(formula: &str) -> Option<MatchFormula> {
  let (function, args) = parse_function_arguments(formula)?;
  if function != "MATCH" || !(args.len() == 2 || args.len() == 3) {
    return None;
  }
  let (array_start, array_end) = parse_range_reference(&args[1])?;
  Some(MatchFormula {
    lookup_value: args[0].clone(),
    array_start,
    array_end,
    match_type: args.get(2).cloned(),
  })
}

pub fn parse_index_formula(formula: &str) -> Option<IndexFormula> {
  let (function, args) = parse_function_arguments(formula)?;
  if function != "INDEX" || !(args.len() == 2 || args.len() == 3) {
    return None;
  }
  let (array_start, array_end) = parse_range_reference(&args[0])?;
  Some(IndexFormula {
    array_start,
    array_end,
    row_num: args[1].clone(),
    col_num: args.get(2).cloned(),
  })
}

pub fn parse_and_formula(formula: &str) -> Option<Vec<String>> {
  let (function, args) = parse_function_arguments(formula)?;
  if function == "AND" && !args.is_empty() {
    return Some(args);
  }
  None
}

pub fn parse_or_formula(formula: &str) -> Option<Vec<String>> {
  let (function, args) = parse_function_arguments(formula)?;
  if function == "OR" && !args.is_empty() {
    return Some(args);
  }
  None
}

pub fn parse_not_formula(formula: &str) -> Option<String> {
  let (function, args) = parse_function_arguments(formula)?;
  if function == "NOT" && args.len() == 1 {
    return Some(args[0].clone());
  }
  None
}

pub fn parse_len_formula(formula: &str) -> Option<String> {
  let (function, args) = parse_function_arguments(formula)?;
  if function == "LEN" && args.len() == 1 {
    return Some(args[0].clone());
  }
  None
}

pub fn parse_upper_formula(formula: &str) -> Option<String> {
  let (function, args) = parse_function_arguments(formula)?;
  if function == "UPPER" && args.len() == 1 {
    return Some(args[0].clone());
  }
  None
}

pub fn parse_lower_formula(formula: &str) -> Option<String> {
  let (function, args) = parse_function_arguments(formula)?;
  if function == "LOWER" && args.len() == 1 {
    return Some(args[0].clone());
  }
  None
}

pub fn parse_trim_formula(formula: &str) -> Option<String> {
  let (function, args) = parse_function_arguments(formula)?;
  if function == "TRIM" && args.len() == 1 {
    return Some(args[0].clone());
  }
  None
}

pub fn parse_left_formula(formula: &str) -> Option<(String, Option<String>)> {
  let (function, args) = parse_function_arguments(formula)?;
  if function != "LEFT" || !(args.len() == 1 || args.len() == 2) {
    return None;
  }
  Some((args[0].clone(), args.get(1).cloned()))
}

pub fn parse_right_formula(formula: &str) -> Option<(String, Option<String>)> {
  let (function, args) = parse_function_arguments(formula)?;
  if function != "RIGHT" || !(args.len() == 1 || args.len() == 2) {
    return None;
  }
  Some((args[0].clone(), args.get(1).cloned()))
}

pub fn parse_date_formula(formula: &str) -> Option<(String, String, String)> {
  let (function, args) = parse_function_arguments(formula)?;
  if function == "DATE" && args.len() == 3 {
    return Some((args[0].clone(), args[1].clone(), args[2].clone()));
  }
  None
}

pub fn parse_year_formula(formula: &str) -> Option<String> {
  let (function, args) = parse_function_arguments(formula)?;
  if function == "YEAR" && args.len() == 1 {
    return Some(args[0].clone());
  }
  None
}

pub fn parse_month_formula(formula: &str) -> Option<String> {
  let (function, args) = parse_function_arguments(formula)?;
  if function == "MONTH" && args.len() == 1 {
    return Some(args[0].clone());
  }
  None
}

pub fn parse_day_formula(formula: &str) -> Option<String> {
  let (function, args) = parse_function_arguments(formula)?;
  if function == "DAY" && args.len() == 1 {
    return Some(args[0].clone());
  }
  None
}

pub fn parse_countif_formula(formula: &str) -> Option<((u32, u32), (u32, u32), String)> {
  let (function, args) = parse_function_arguments(formula)?;
  if function != "COUNTIF" || args.len() != 2 {
    return None;
  }
  let (start, end) = parse_range_reference(&args[0])?;
  Some((start, end, args[1].clone()))
}

pub fn parse_sumif_formula(formula: &str) -> Option<ConditionalAggregateFormula> {
  parse_conditional_aggregate_formula(formula, "SUMIF")
}

pub fn parse_averageif_formula(
  formula: &str,
) -> Option<ConditionalAggregateFormula> {
  parse_conditional_aggregate_formula(formula, "AVERAGEIF")
}

pub fn parse_countifs_formula(
  formula: &str,
) -> Option<MultiCriteriaAggregateFormula> {
  let (function, args) = parse_function_arguments(formula)?;
  if function != "COUNTIFS" || args.len() < 2 || args.len() % 2 != 0 {
    return None;
  }

  let mut conditions = Vec::new();
  let mut index = 0usize;
  while index + 1 < args.len() {
    let (range_start, range_end) = parse_range_reference(&args[index])?;
    conditions.push(CriteriaCondition {
      range_start,
      range_end,
      criteria: args[index + 1].clone(),
    });
    index += 2;
  }

  Some(MultiCriteriaAggregateFormula {
    value_range_start: None,
    value_range_end: None,
    conditions,
  })
}

pub fn parse_sumifs_formula(
  formula: &str,
) -> Option<MultiCriteriaAggregateFormula> {
  parse_multi_criteria_aggregate_formula(formula, "SUMIFS")
}

pub fn parse_averageifs_formula(
  formula: &str,
) -> Option<MultiCriteriaAggregateFormula> {
  parse_multi_criteria_aggregate_formula(formula, "AVERAGEIFS")
}

fn parse_conditional_aggregate_formula(
  formula: &str,
  function_name: &str,
) -> Option<ConditionalAggregateFormula> {
  let (function, args) = parse_function_arguments(formula)?;
  if function != function_name || !(args.len() == 2 || args.len() == 3) {
    return None;
  }

  let (criteria_range_start, criteria_range_end) = parse_range_reference(&args[0])?;
  let (value_range_start, value_range_end) = if args.len() == 3 {
    let (start, end) = parse_range_reference(&args[2])?;
    (Some(start), Some(end))
  } else {
    (None, None)
  };

  Some(ConditionalAggregateFormula {
    criteria_range_start,
    criteria_range_end,
    criteria: args[1].clone(),
    value_range_start,
    value_range_end,
  })
}

fn parse_multi_criteria_aggregate_formula(
  formula: &str,
  function_name: &str,
) -> Option<MultiCriteriaAggregateFormula> {
  let (function, args) = parse_function_arguments(formula)?;
  if function != function_name || args.len() < 3 || args.len() % 2 == 0 {
    return None;
  }

  let (value_range_start, value_range_end) = parse_range_reference(&args[0])?;
  let mut conditions = Vec::new();
  let mut index = 1usize;
  while index + 1 < args.len() {
    let (range_start, range_end) = parse_range_reference(&args[index])?;
    conditions.push(CriteriaCondition {
      range_start,
      range_end,
      criteria: args[index + 1].clone(),
    });
    index += 2;
  }

  Some(MultiCriteriaAggregateFormula {
    value_range_start: Some(value_range_start),
    value_range_end: Some(value_range_end),
    conditions,
  })
}

fn parse_function_arguments(formula: &str) -> Option<(String, Vec<String>)> {
  let expression = formula.trim();
  if !expression.starts_with('=') {
    return None;
  }
  let call = expression.trim_start_matches('=').trim();
  let opening_paren_index = call.find('(')?;
  if !call.ends_with(')') || opening_paren_index == 0 {
    return None;
  }

  let function = call[..opening_paren_index].trim().to_uppercase();
  if function.is_empty() {
    return None;
  }
  let args_payload = &call[(opening_paren_index + 1)..(call.len() - 1)];
  let args = split_formula_arguments(args_payload)?;
  Some((function, args))
}

fn split_formula_arguments(value: &str) -> Option<Vec<String>> {
  if value.trim().is_empty() {
    return Some(Vec::new());
  }

  let mut args = Vec::new();
  let mut current = String::new();
  let mut paren_depth = 0i32;
  let mut in_quotes = false;
  let mut chars = value.chars().peekable();

  while let Some(ch) = chars.next() {
    match ch {
      '"' => {
        current.push(ch);
        if in_quotes {
          if matches!(chars.peek(), Some('"')) {
            current.push('"');
            let _ = chars.next();
          } else {
            in_quotes = false;
          }
        } else {
          in_quotes = true;
        }
      }
      '(' if !in_quotes => {
        paren_depth += 1;
        current.push(ch);
      }
      ')' if !in_quotes => {
        if paren_depth == 0 {
          return None;
        }
        paren_depth -= 1;
        current.push(ch);
      }
      ',' if !in_quotes && paren_depth == 0 => {
        let trimmed = current.trim();
        if trimmed.is_empty() {
          return None;
        }
        args.push(trimmed.to_string());
        current.clear();
      }
      _ => current.push(ch),
    }
  }

  if in_quotes || paren_depth != 0 {
    return None;
  }

  let trailing = current.trim();
  if trailing.is_empty() {
    return None;
  }
  args.push(trailing.to_string());
  Some(args)
}

fn parse_range_reference(value: &str) -> Option<((u32, u32), (u32, u32))> {
  let cleaned = value.trim().replace('$', "");
  let (start, end) = cleaned.split_once(':')?;
  let start_ref = parse_cell_address(start.trim())?;
  let end_ref = parse_cell_address(end.trim())?;
  Some((start_ref, end_ref))
}

#[cfg(test)]
mod tests {
  use super::{
    address_from_row_col, parse_aggregate_formula, parse_and_formula,
    parse_averageif_formula, parse_averageifs_formula,
    parse_concat_formula, parse_date_formula, parse_day_formula,
    parse_index_formula,
    parse_left_formula, parse_len_formula, parse_lower_formula,
    parse_match_formula,
    parse_month_formula,
    parse_not_formula, parse_or_formula, parse_right_formula, parse_cell_address,
    parse_countifs_formula, parse_sumif_formula, parse_sumifs_formula,
    parse_if_formula, parse_today_formula, parse_vlookup_formula,
    parse_xlookup_formula, parse_countif_formula,
    parse_year_formula, parse_upper_formula, parse_trim_formula,
  };

  #[test]
  fn should_convert_cell_addresses() {
    assert_eq!(parse_cell_address("A1"), Some((1, 1)));
    assert_eq!(parse_cell_address("$C$11"), Some((11, 3)));
    assert_eq!(address_from_row_col(27, 28), "AB27");
  }

  #[test]
  fn should_parse_aggregate_formula() {
    let parsed = parse_aggregate_formula("=SUM(A1:B2)");
    assert!(parsed.is_some());
    let (function, start, end) = parsed.expect("formula should parse");
    assert_eq!(function, "SUM");
    assert_eq!(start, (1, 1));
    assert_eq!(end, (2, 2));
  }

  #[test]
  fn should_parse_logical_and_text_formulas() {
    let if_formula = parse_if_formula(r#"=IF(B2>=100, "bonus", "standard")"#)
      .expect("if formula should parse");
    assert_eq!(if_formula.0, "B2>=100");
    assert_eq!(if_formula.1, r#""bonus""#);
    assert_eq!(if_formula.2, r#""standard""#);

    let concat = parse_concat_formula(r#"=CONCAT("sales-", A2, "-", B2)"#)
      .expect("concat formula should parse");
    assert_eq!(concat, vec![r#""sales-""#, "A2", r#""-""#, "B2"]);
  }

  #[test]
  fn should_parse_today_and_vlookup_formulas() {
    assert!(parse_today_formula("=TODAY()").is_some());
    assert!(parse_today_formula("=TODAY(1)").is_none());

    let parsed = parse_vlookup_formula("=VLOOKUP(A2, D2:E6, 2, FALSE)")
      .expect("vlookup formula should parse");
    assert_eq!(parsed.lookup_value, "A2");
    assert_eq!(parsed.table_start, (2, 4));
    assert_eq!(parsed.table_end, (6, 5));
    assert_eq!(parsed.result_col_index, 2);
    assert_eq!(parsed.range_lookup.as_deref(), Some("FALSE"));

    let xlookup = parse_xlookup_formula(
      r#"=XLOOKUP("north",E1:E4,F1:F4,"missing",0,1)"#,
    )
    .expect("xlookup formula should parse");
    assert_eq!(xlookup.lookup_value, r#""north""#);
    assert_eq!(xlookup.lookup_array_start, (1, 5));
    assert_eq!(xlookup.lookup_array_end, (4, 5));
    assert_eq!(xlookup.return_array_start, (1, 6));
    assert_eq!(xlookup.return_array_end, (4, 6));
    assert_eq!(xlookup.if_not_found.as_deref(), Some(r#""missing""#));
    assert_eq!(xlookup.match_mode.as_deref(), Some("0"));
    assert_eq!(xlookup.search_mode.as_deref(), Some("1"));

    let match_formula = parse_match_formula(r#"=MATCH("south",E1:E4,0)"#)
      .expect("match formula should parse");
    assert_eq!(match_formula.lookup_value, r#""south""#);
    assert_eq!(match_formula.array_start, (1, 5));
    assert_eq!(match_formula.array_end, (4, 5));
    assert_eq!(match_formula.match_type.as_deref(), Some("0"));

    let index_formula = parse_index_formula("=INDEX(E1:F4,2,2)")
      .expect("index formula should parse");
    assert_eq!(index_formula.array_start, (1, 5));
    assert_eq!(index_formula.array_end, (4, 6));
    assert_eq!(index_formula.row_num, "2");
    assert_eq!(index_formula.col_num.as_deref(), Some("2"));
  }

  #[test]
  fn should_parse_logical_text_and_date_function_shapes() {
    let and_args = parse_and_formula("=AND(A1>0,B1<10)").expect("and should parse");
    assert_eq!(and_args, vec!["A1>0", "B1<10"]);

    let or_args = parse_or_formula("=OR(A1=0,B1=0)").expect("or should parse");
    assert_eq!(or_args, vec!["A1=0", "B1=0"]);

    let not_arg = parse_not_formula("=NOT(A1=0)").expect("not should parse");
    assert_eq!(not_arg, "A1=0");

    let len_arg = parse_len_formula(r#"=LEN("abc")"#).expect("len should parse");
    assert_eq!(len_arg, r#""abc""#);
    let upper_arg =
      parse_upper_formula(r#"=UPPER("mixed Case")"#).expect("upper should parse");
    assert_eq!(upper_arg, r#""mixed Case""#);
    let lower_arg =
      parse_lower_formula(r#"=LOWER("MIXED Case")"#).expect("lower should parse");
    assert_eq!(lower_arg, r#""MIXED Case""#);
    let trim_arg =
      parse_trim_formula(r#"=TRIM("  spaced text   ")"#).expect("trim should parse");
    assert_eq!(trim_arg, r#""  spaced text   ""#);

    let left_args =
      parse_left_formula(r#"=LEFT("spreadsheet", 6)"#).expect("left should parse");
    assert_eq!(left_args.0, r#""spreadsheet""#);
    assert_eq!(left_args.1.as_deref(), Some("6"));

    let right_args =
      parse_right_formula(r#"=RIGHT("spreadsheet", 5)"#).expect("right should parse");
    assert_eq!(right_args.0, r#""spreadsheet""#);
    assert_eq!(right_args.1.as_deref(), Some("5"));

    let date_parts = parse_date_formula("=DATE(2026,2,13)").expect("date should parse");
    assert_eq!(date_parts, ("2026".to_string(), "2".to_string(), "13".to_string()));

    assert_eq!(
      parse_year_formula("=YEAR(A1)").as_deref(),
      Some("A1"),
    );
    assert_eq!(
      parse_month_formula("=MONTH(A1)").as_deref(),
      Some("A1"),
    );
    assert_eq!(parse_day_formula("=DAY(A1)").as_deref(), Some("A1"));

    let countif = parse_countif_formula(r#"=COUNTIF(A1:A5,">=10")"#)
      .expect("countif should parse");
    assert_eq!(countif.0, (1, 1));
    assert_eq!(countif.1, (5, 1));
    assert_eq!(countif.2, r#"">=10""#);

    let sumif = parse_sumif_formula(r#"=SUMIF(A1:A5,">=10",B1:B5)"#)
      .expect("sumif should parse");
    assert_eq!(sumif.criteria_range_start, (1, 1));
    assert_eq!(sumif.criteria_range_end, (5, 1));
    assert_eq!(sumif.criteria, r#"">=10""#);
    assert_eq!(sumif.value_range_start, Some((1, 2)));
    assert_eq!(sumif.value_range_end, Some((5, 2)));

    let averageif = parse_averageif_formula(r#"=AVERAGEIF(A1:A5,">=10")"#)
      .expect("averageif should parse");
    assert_eq!(averageif.criteria_range_start, (1, 1));
    assert_eq!(averageif.criteria_range_end, (5, 1));
    assert_eq!(averageif.value_range_start, None);
    assert_eq!(averageif.value_range_end, None);

    let countifs = parse_countifs_formula(
      r#"=COUNTIFS(A1:A5,">=10",C1:C5,"east")"#,
    )
    .expect("countifs should parse");
    assert_eq!(countifs.value_range_start, None);
    assert_eq!(countifs.value_range_end, None);
    assert_eq!(countifs.conditions.len(), 2);
    assert_eq!(countifs.conditions[0].range_start, (1, 1));
    assert_eq!(countifs.conditions[0].range_end, (5, 1));
    assert_eq!(countifs.conditions[0].criteria, r#"">=10""#);
    assert_eq!(countifs.conditions[1].range_start, (1, 3));
    assert_eq!(countifs.conditions[1].range_end, (5, 3));
    assert_eq!(countifs.conditions[1].criteria, r#""east""#);

    let sumifs = parse_sumifs_formula(
      r#"=SUMIFS(B1:B5,A1:A5,">=10",C1:C5,"east")"#,
    )
    .expect("sumifs should parse");
    assert_eq!(sumifs.value_range_start, Some((1, 2)));
    assert_eq!(sumifs.value_range_end, Some((5, 2)));
    assert_eq!(sumifs.conditions.len(), 2);
    assert_eq!(sumifs.conditions[0].range_start, (1, 1));
    assert_eq!(sumifs.conditions[0].criteria, r#"">=10""#);
    assert_eq!(sumifs.conditions[1].range_start, (1, 3));
    assert_eq!(sumifs.conditions[1].criteria, r#""east""#);

    let averageifs = parse_averageifs_formula(
      r#"=AVERAGEIFS(B1:B5,A1:A5,">=10",C1:C5,"east")"#,
    )
    .expect("averageifs should parse");
    assert_eq!(averageifs.value_range_start, Some((1, 2)));
    assert_eq!(averageifs.value_range_end, Some((5, 2)));
    assert_eq!(averageifs.conditions.len(), 2);
  }
}
