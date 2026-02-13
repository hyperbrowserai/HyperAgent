use regex::Regex;

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

#[cfg(test)]
mod tests {
  use super::{address_from_row_col, parse_aggregate_formula, parse_cell_address};

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
}
