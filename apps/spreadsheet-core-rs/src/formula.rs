use regex::Regex;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VLookupFormula {
  pub lookup_value: String,
  pub table_start: (u32, u32),
  pub table_end: (u32, u32),
  pub result_col_index: u32,
  pub range_lookup: Option<String>,
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
    address_from_row_col, parse_aggregate_formula, parse_cell_address,
    parse_concat_formula, parse_if_formula, parse_today_formula, parse_vlookup_formula,
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
  }
}
