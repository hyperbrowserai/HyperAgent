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
pub struct HLookupFormula {
  pub lookup_value: String,
  pub table_start: (u32, u32),
  pub table_end: (u32, u32),
  pub result_row_index: u32,
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
    Regex::new(r"^=\s*(SUM|AVERAGE|MIN|MAX|COUNT|MEDIAN|PRODUCT|SUMSQ|STDEV|STDEVP|STDEV\.P|STDEV\.S|VAR|VARP|VAR\.P|VAR\.S)\s*\(\s*([A-Za-z]+\d+)\s*:\s*([A-Za-z]+\d+)\s*\)\s*$")
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

pub fn parse_ifs_formula(formula: &str) -> Option<Vec<(String, String)>> {
  let (function, args) = parse_function_arguments(formula)?;
  if function != "IFS" || args.len() < 2 || args.len() % 2 != 0 {
    return None;
  }

  Some(
    args
      .chunks(2)
      .map(|chunk| (chunk[0].clone(), chunk[1].clone()))
      .collect::<Vec<(String, String)>>(),
  )
}

pub fn parse_iferror_formula(formula: &str) -> Option<(String, String)> {
  let (function, args) = parse_function_arguments(formula)?;
  if function != "IFERROR" || args.len() != 2 {
    return None;
  }

  Some((args[0].clone(), args[1].clone()))
}

pub fn parse_ifna_formula(formula: &str) -> Option<(String, String)> {
  let (function, args) = parse_function_arguments(formula)?;
  if function != "IFNA" || args.len() != 2 {
    return None;
  }

  Some((args[0].clone(), args[1].clone()))
}

pub fn parse_na_formula(formula: &str) -> Option<()> {
  let (function, args) = parse_function_arguments(formula)?;
  if function == "NA" && args.is_empty() {
    return Some(());
  }
  None
}

pub fn parse_choose_formula(formula: &str) -> Option<(String, Vec<String>)> {
  let (function, args) = parse_function_arguments(formula)?;
  if function != "CHOOSE" || args.len() < 2 {
    return None;
  }

  Some((args[0].clone(), args[1..].to_vec()))
}

pub fn parse_switch_formula(
  formula: &str,
) -> Option<(String, Vec<(String, String)>, Option<String>)> {
  let (function, args) = parse_function_arguments(formula)?;
  if function != "SWITCH" || args.len() < 3 {
    return None;
  }
  let expression = args[0].clone();
  let pairs_and_default = &args[1..];
  let has_default = pairs_and_default.len() % 2 == 1;
  let pair_args_len = if has_default {
    pairs_and_default.len().saturating_sub(1)
  } else {
    pairs_and_default.len()
  };
  let pairs = pairs_and_default[..pair_args_len]
    .chunks(2)
    .map(|chunk| (chunk[0].clone(), chunk[1].clone()))
    .collect::<Vec<(String, String)>>();
  let default_value = if has_default {
    pairs_and_default.last().cloned()
  } else {
    None
  };
  Some((expression, pairs, default_value))
}

pub fn parse_concat_formula(formula: &str) -> Option<Vec<String>> {
  let (function, args) = parse_function_arguments(formula)?;
  if (function != "CONCAT" && function != "CONCATENATE") || args.is_empty() {
    return None;
  }
  Some(args)
}

pub fn parse_textjoin_formula(formula: &str) -> Option<(String, String, Vec<String>)> {
  let (function, args) = parse_function_arguments(formula)?;
  if function != "TEXTJOIN" || args.len() < 3 {
    return None;
  }
  Some((args[0].clone(), args[1].clone(), args[2..].to_vec()))
}

pub fn parse_today_formula(formula: &str) -> Option<()> {
  let (function, args) = parse_function_arguments(formula)?;
  if function == "TODAY" && args.is_empty() {
    return Some(());
  }
  None
}

pub fn parse_now_formula(formula: &str) -> Option<()> {
  let (function, args) = parse_function_arguments(formula)?;
  if function == "NOW" && args.is_empty() {
    return Some(());
  }
  None
}

pub fn parse_rand_formula(formula: &str) -> Option<()> {
  let (function, args) = parse_function_arguments(formula)?;
  if function == "RAND" && args.is_empty() {
    return Some(());
  }
  None
}

pub fn parse_randbetween_formula(formula: &str) -> Option<(String, String)> {
  let (function, args) = parse_function_arguments(formula)?;
  if function == "RANDBETWEEN" && args.len() == 2 {
    return Some((args[0].clone(), args[1].clone()));
  }
  None
}

pub fn parse_true_formula(formula: &str) -> Option<()> {
  let (function, args) = parse_function_arguments(formula)?;
  if function == "TRUE" && args.is_empty() {
    return Some(());
  }
  None
}

pub fn parse_false_formula(formula: &str) -> Option<()> {
  let (function, args) = parse_function_arguments(formula)?;
  if function == "FALSE" && args.is_empty() {
    return Some(());
  }
  None
}

pub fn parse_pi_formula(formula: &str) -> Option<()> {
  let (function, args) = parse_function_arguments(formula)?;
  if function == "PI" && args.is_empty() {
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

pub fn parse_hlookup_formula(formula: &str) -> Option<HLookupFormula> {
  let (function, args) = parse_function_arguments(formula)?;
  if function != "HLOOKUP" || !(args.len() == 3 || args.len() == 4) {
    return None;
  }
  let (table_start, table_end) = parse_range_reference(&args[1])?;
  let result_row_index = args[2].trim().parse::<u32>().ok()?;
  if result_row_index == 0 {
    return None;
  }

  Some(HLookupFormula {
    lookup_value: args[0].clone(),
    table_start,
    table_end,
    result_row_index,
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

pub fn parse_xor_formula(formula: &str) -> Option<Vec<String>> {
  let (function, args) = parse_function_arguments(formula)?;
  if function == "XOR" && !args.is_empty() {
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

pub fn parse_proper_formula(formula: &str) -> Option<String> {
  let (function, args) = parse_function_arguments(formula)?;
  if function == "PROPER" && args.len() == 1 {
    return Some(args[0].clone());
  }
  None
}

pub fn parse_clean_formula(formula: &str) -> Option<String> {
  let (function, args) = parse_function_arguments(formula)?;
  if function == "CLEAN" && args.len() == 1 {
    return Some(args[0].clone());
  }
  None
}

pub fn parse_abs_formula(formula: &str) -> Option<String> {
  let (function, args) = parse_function_arguments(formula)?;
  if function == "ABS" && args.len() == 1 {
    return Some(args[0].clone());
  }
  None
}

pub fn parse_ln_formula(formula: &str) -> Option<String> {
  let (function, args) = parse_function_arguments(formula)?;
  if function == "LN" && args.len() == 1 {
    return Some(args[0].clone());
  }
  None
}

pub fn parse_log10_formula(formula: &str) -> Option<String> {
  let (function, args) = parse_function_arguments(formula)?;
  if function == "LOG10" && args.len() == 1 {
    return Some(args[0].clone());
  }
  None
}

pub fn parse_exp_formula(formula: &str) -> Option<String> {
  let (function, args) = parse_function_arguments(formula)?;
  if function == "EXP" && args.len() == 1 {
    return Some(args[0].clone());
  }
  None
}

pub fn parse_log_formula(formula: &str) -> Option<(String, Option<String>)> {
  let (function, args) = parse_function_arguments(formula)?;
  if function != "LOG" || !(args.len() == 1 || args.len() == 2) {
    return None;
  }
  Some((args[0].clone(), args.get(1).cloned()))
}

pub fn parse_effect_formula(formula: &str) -> Option<(String, String)> {
  let (function, args) = parse_function_arguments(formula)?;
  if function == "EFFECT" && args.len() == 2 {
    return Some((args[0].clone(), args[1].clone()));
  }
  None
}

pub fn parse_nominal_formula(formula: &str) -> Option<(String, String)> {
  let (function, args) = parse_function_arguments(formula)?;
  if function == "NOMINAL" && args.len() == 2 {
    return Some((args[0].clone(), args[1].clone()));
  }
  None
}

pub fn parse_npv_formula(formula: &str) -> Option<(String, Vec<String>)> {
  let (function, args) = parse_function_arguments(formula)?;
  if function != "NPV" || args.len() < 2 {
    return None;
  }
  Some((args[0].clone(), args[1..].to_vec()))
}

pub fn parse_pv_formula(
  formula: &str,
) -> Option<(String, String, String, Option<String>, Option<String>)> {
  let (function, args) = parse_function_arguments(formula)?;
  if function != "PV" || !(args.len() == 3 || args.len() == 4 || args.len() == 5) {
    return None;
  }
  Some((
    args[0].clone(),
    args[1].clone(),
    args[2].clone(),
    args.get(3).cloned(),
    args.get(4).cloned(),
  ))
}

pub fn parse_fv_formula(
  formula: &str,
) -> Option<(String, String, String, Option<String>, Option<String>)> {
  let (function, args) = parse_function_arguments(formula)?;
  if function != "FV" || !(args.len() == 3 || args.len() == 4 || args.len() == 5) {
    return None;
  }
  Some((
    args[0].clone(),
    args[1].clone(),
    args[2].clone(),
    args.get(3).cloned(),
    args.get(4).cloned(),
  ))
}

pub fn parse_pmt_formula(
  formula: &str,
) -> Option<(String, String, String, Option<String>, Option<String>)> {
  let (function, args) = parse_function_arguments(formula)?;
  if function != "PMT" || !(args.len() == 3 || args.len() == 4 || args.len() == 5) {
    return None;
  }
  Some((
    args[0].clone(),
    args[1].clone(),
    args[2].clone(),
    args.get(3).cloned(),
    args.get(4).cloned(),
  ))
}

pub fn parse_irr_formula(formula: &str) -> Option<(Vec<String>, Option<String>)> {
  let (function, args) = parse_function_arguments(formula)?;
  if function != "IRR" || args.is_empty() {
    return None;
  }
  if args.len() >= 2 && args[0].contains(':') {
    return Some((vec![args[0].clone()], Some(args[1].clone())));
  }
  Some((args, None))
}

pub fn parse_mirr_formula(formula: &str) -> Option<(String, String, String)> {
  let (function, args) = parse_function_arguments(formula)?;
  if function != "MIRR" || args.len() != 3 {
    return None;
  }
  Some((args[0].clone(), args[1].clone(), args[2].clone()))
}

pub fn parse_nper_formula(
  formula: &str,
) -> Option<(String, String, String, Option<String>, Option<String>)> {
  let (function, args) = parse_function_arguments(formula)?;
  if function != "NPER" || !(args.len() == 3 || args.len() == 4 || args.len() == 5) {
    return None;
  }
  Some((
    args[0].clone(),
    args[1].clone(),
    args[2].clone(),
    args.get(3).cloned(),
    args.get(4).cloned(),
  ))
}

pub fn parse_rate_formula(
  formula: &str,
) -> Option<(String, String, String, Option<String>, Option<String>, Option<String>)> {
  let (function, args) = parse_function_arguments(formula)?;
  if function != "RATE" || !(args.len() == 3 || args.len() == 4 || args.len() == 5 || args.len() == 6) {
    return None;
  }
  Some((
    args[0].clone(),
    args[1].clone(),
    args[2].clone(),
    args.get(3).cloned(),
    args.get(4).cloned(),
    args.get(5).cloned(),
  ))
}

pub fn parse_ipmt_formula(
  formula: &str,
) -> Option<(String, String, String, String, Option<String>, Option<String>)> {
  let (function, args) = parse_function_arguments(formula)?;
  if function != "IPMT" || !(args.len() == 4 || args.len() == 5 || args.len() == 6) {
    return None;
  }
  Some((
    args[0].clone(),
    args[1].clone(),
    args[2].clone(),
    args[3].clone(),
    args.get(4).cloned(),
    args.get(5).cloned(),
  ))
}

pub fn parse_ppmt_formula(
  formula: &str,
) -> Option<(String, String, String, String, Option<String>, Option<String>)> {
  let (function, args) = parse_function_arguments(formula)?;
  if function != "PPMT" || !(args.len() == 4 || args.len() == 5 || args.len() == 6) {
    return None;
  }
  Some((
    args[0].clone(),
    args[1].clone(),
    args[2].clone(),
    args[3].clone(),
    args.get(4).cloned(),
    args.get(5).cloned(),
  ))
}

pub fn parse_sln_formula(formula: &str) -> Option<(String, String, String)> {
  let (function, args) = parse_function_arguments(formula)?;
  if function != "SLN" || args.len() != 3 {
    return None;
  }
  Some((args[0].clone(), args[1].clone(), args[2].clone()))
}

pub fn parse_syd_formula(formula: &str) -> Option<(String, String, String, String)> {
  let (function, args) = parse_function_arguments(formula)?;
  if function != "SYD" || args.len() != 4 {
    return None;
  }
  Some((
    args[0].clone(),
    args[1].clone(),
    args[2].clone(),
    args[3].clone(),
  ))
}

pub fn parse_db_formula(
  formula: &str,
) -> Option<(String, String, String, String, Option<String>)> {
  let (function, args) = parse_function_arguments(formula)?;
  if function != "DB" || !(args.len() == 4 || args.len() == 5) {
    return None;
  }
  Some((
    args[0].clone(),
    args[1].clone(),
    args[2].clone(),
    args[3].clone(),
    args.get(4).cloned(),
  ))
}

pub fn parse_ddb_formula(
  formula: &str,
) -> Option<(String, String, String, String, Option<String>)> {
  let (function, args) = parse_function_arguments(formula)?;
  if function != "DDB" || !(args.len() == 4 || args.len() == 5) {
    return None;
  }
  Some((
    args[0].clone(),
    args[1].clone(),
    args[2].clone(),
    args[3].clone(),
    args.get(4).cloned(),
  ))
}

pub fn parse_rri_formula(formula: &str) -> Option<(String, String, String)> {
  let (function, args) = parse_function_arguments(formula)?;
  if function != "RRI" || args.len() != 3 {
    return None;
  }
  Some((args[0].clone(), args[1].clone(), args[2].clone()))
}

pub fn parse_pduration_formula(formula: &str) -> Option<(String, String, String)> {
  let (function, args) = parse_function_arguments(formula)?;
  if function != "PDURATION" || args.len() != 3 {
    return None;
  }
  Some((args[0].clone(), args[1].clone(), args[2].clone()))
}

pub fn parse_fvschedule_formula(formula: &str) -> Option<(String, String)> {
  let (function, args) = parse_function_arguments(formula)?;
  if function != "FVSCHEDULE" || args.len() != 2 {
    return None;
  }
  Some((args[0].clone(), args[1].clone()))
}

pub fn parse_ispmt_formula(formula: &str) -> Option<(String, String, String, String)> {
  let (function, args) = parse_function_arguments(formula)?;
  if function != "ISPMT" || args.len() != 4 {
    return None;
  }
  Some((
    args[0].clone(),
    args[1].clone(),
    args[2].clone(),
    args[3].clone(),
  ))
}

pub fn parse_cumipmt_formula(
  formula: &str,
) -> Option<(String, String, String, String, String, String)> {
  let (function, args) = parse_function_arguments(formula)?;
  if function != "CUMIPMT" || args.len() != 6 {
    return None;
  }
  Some((
    args[0].clone(),
    args[1].clone(),
    args[2].clone(),
    args[3].clone(),
    args[4].clone(),
    args[5].clone(),
  ))
}

pub fn parse_cumprinc_formula(
  formula: &str,
) -> Option<(String, String, String, String, String, String)> {
  let (function, args) = parse_function_arguments(formula)?;
  if function != "CUMPRINC" || args.len() != 6 {
    return None;
  }
  Some((
    args[0].clone(),
    args[1].clone(),
    args[2].clone(),
    args[3].clone(),
    args[4].clone(),
    args[5].clone(),
  ))
}

pub fn parse_fact_formula(formula: &str) -> Option<String> {
  let (function, args) = parse_function_arguments(formula)?;
  if function == "FACT" && args.len() == 1 {
    return Some(args[0].clone());
  }
  None
}

pub fn parse_factdouble_formula(formula: &str) -> Option<String> {
  let (function, args) = parse_function_arguments(formula)?;
  if function == "FACTDOUBLE" && args.len() == 1 {
    return Some(args[0].clone());
  }
  None
}

pub fn parse_combin_formula(formula: &str) -> Option<(String, String)> {
  let (function, args) = parse_function_arguments(formula)?;
  if function == "COMBIN" && args.len() == 2 {
    return Some((args[0].clone(), args[1].clone()));
  }
  None
}

pub fn parse_combina_formula(formula: &str) -> Option<(String, String)> {
  let (function, args) = parse_function_arguments(formula)?;
  if function == "COMBINA" && args.len() == 2 {
    return Some((args[0].clone(), args[1].clone()));
  }
  None
}

pub fn parse_permut_formula(formula: &str) -> Option<(String, String)> {
  let (function, args) = parse_function_arguments(formula)?;
  if function == "PERMUT" && args.len() == 2 {
    return Some((args[0].clone(), args[1].clone()));
  }
  None
}

pub fn parse_permutationa_formula(formula: &str) -> Option<(String, String)> {
  let (function, args) = parse_function_arguments(formula)?;
  if function == "PERMUTATIONA" && args.len() == 2 {
    return Some((args[0].clone(), args[1].clone()));
  }
  None
}

pub fn parse_multinomial_formula(formula: &str) -> Option<Vec<String>> {
  let (function, args) = parse_function_arguments(formula)?;
  if function == "MULTINOMIAL" && !args.is_empty() {
    return Some(args);
  }
  None
}

pub fn parse_gcd_formula(formula: &str) -> Option<Vec<String>> {
  let (function, args) = parse_function_arguments(formula)?;
  if function == "GCD" && !args.is_empty() {
    return Some(args);
  }
  None
}

pub fn parse_lcm_formula(formula: &str) -> Option<Vec<String>> {
  let (function, args) = parse_function_arguments(formula)?;
  if function == "LCM" && !args.is_empty() {
    return Some(args);
  }
  None
}

pub fn parse_sin_formula(formula: &str) -> Option<String> {
  let (function, args) = parse_function_arguments(formula)?;
  if function == "SIN" && args.len() == 1 {
    return Some(args[0].clone());
  }
  None
}

pub fn parse_cos_formula(formula: &str) -> Option<String> {
  let (function, args) = parse_function_arguments(formula)?;
  if function == "COS" && args.len() == 1 {
    return Some(args[0].clone());
  }
  None
}

pub fn parse_tan_formula(formula: &str) -> Option<String> {
  let (function, args) = parse_function_arguments(formula)?;
  if function == "TAN" && args.len() == 1 {
    return Some(args[0].clone());
  }
  None
}

pub fn parse_cot_formula(formula: &str) -> Option<String> {
  let (function, args) = parse_function_arguments(formula)?;
  if function == "COT" && args.len() == 1 {
    return Some(args[0].clone());
  }
  None
}

pub fn parse_sec_formula(formula: &str) -> Option<String> {
  let (function, args) = parse_function_arguments(formula)?;
  if function == "SEC" && args.len() == 1 {
    return Some(args[0].clone());
  }
  None
}

pub fn parse_csc_formula(formula: &str) -> Option<String> {
  let (function, args) = parse_function_arguments(formula)?;
  if function == "CSC" && args.len() == 1 {
    return Some(args[0].clone());
  }
  None
}

pub fn parse_sinh_formula(formula: &str) -> Option<String> {
  let (function, args) = parse_function_arguments(formula)?;
  if function == "SINH" && args.len() == 1 {
    return Some(args[0].clone());
  }
  None
}

pub fn parse_cosh_formula(formula: &str) -> Option<String> {
  let (function, args) = parse_function_arguments(formula)?;
  if function == "COSH" && args.len() == 1 {
    return Some(args[0].clone());
  }
  None
}

pub fn parse_tanh_formula(formula: &str) -> Option<String> {
  let (function, args) = parse_function_arguments(formula)?;
  if function == "TANH" && args.len() == 1 {
    return Some(args[0].clone());
  }
  None
}

pub fn parse_coth_formula(formula: &str) -> Option<String> {
  let (function, args) = parse_function_arguments(formula)?;
  if function == "COTH" && args.len() == 1 {
    return Some(args[0].clone());
  }
  None
}

pub fn parse_sech_formula(formula: &str) -> Option<String> {
  let (function, args) = parse_function_arguments(formula)?;
  if function == "SECH" && args.len() == 1 {
    return Some(args[0].clone());
  }
  None
}

pub fn parse_csch_formula(formula: &str) -> Option<String> {
  let (function, args) = parse_function_arguments(formula)?;
  if function == "CSCH" && args.len() == 1 {
    return Some(args[0].clone());
  }
  None
}

pub fn parse_asinh_formula(formula: &str) -> Option<String> {
  let (function, args) = parse_function_arguments(formula)?;
  if function == "ASINH" && args.len() == 1 {
    return Some(args[0].clone());
  }
  None
}

pub fn parse_acosh_formula(formula: &str) -> Option<String> {
  let (function, args) = parse_function_arguments(formula)?;
  if function == "ACOSH" && args.len() == 1 {
    return Some(args[0].clone());
  }
  None
}

pub fn parse_atanh_formula(formula: &str) -> Option<String> {
  let (function, args) = parse_function_arguments(formula)?;
  if function == "ATANH" && args.len() == 1 {
    return Some(args[0].clone());
  }
  None
}

pub fn parse_acot_formula(formula: &str) -> Option<String> {
  let (function, args) = parse_function_arguments(formula)?;
  if function == "ACOT" && args.len() == 1 {
    return Some(args[0].clone());
  }
  None
}

pub fn parse_asec_formula(formula: &str) -> Option<String> {
  let (function, args) = parse_function_arguments(formula)?;
  if function == "ASEC" && args.len() == 1 {
    return Some(args[0].clone());
  }
  None
}

pub fn parse_acsc_formula(formula: &str) -> Option<String> {
  let (function, args) = parse_function_arguments(formula)?;
  if function == "ACSC" && args.len() == 1 {
    return Some(args[0].clone());
  }
  None
}

pub fn parse_acoth_formula(formula: &str) -> Option<String> {
  let (function, args) = parse_function_arguments(formula)?;
  if function == "ACOTH" && args.len() == 1 {
    return Some(args[0].clone());
  }
  None
}

pub fn parse_asech_formula(formula: &str) -> Option<String> {
  let (function, args) = parse_function_arguments(formula)?;
  if function == "ASECH" && args.len() == 1 {
    return Some(args[0].clone());
  }
  None
}

pub fn parse_acsch_formula(formula: &str) -> Option<String> {
  let (function, args) = parse_function_arguments(formula)?;
  if function == "ACSCH" && args.len() == 1 {
    return Some(args[0].clone());
  }
  None
}

pub fn parse_asin_formula(formula: &str) -> Option<String> {
  let (function, args) = parse_function_arguments(formula)?;
  if function == "ASIN" && args.len() == 1 {
    return Some(args[0].clone());
  }
  None
}

pub fn parse_acos_formula(formula: &str) -> Option<String> {
  let (function, args) = parse_function_arguments(formula)?;
  if function == "ACOS" && args.len() == 1 {
    return Some(args[0].clone());
  }
  None
}

pub fn parse_atan_formula(formula: &str) -> Option<String> {
  let (function, args) = parse_function_arguments(formula)?;
  if function == "ATAN" && args.len() == 1 {
    return Some(args[0].clone());
  }
  None
}

pub fn parse_atan2_formula(formula: &str) -> Option<(String, String)> {
  let (function, args) = parse_function_arguments(formula)?;
  if function == "ATAN2" && args.len() == 2 {
    return Some((args[0].clone(), args[1].clone()));
  }
  None
}

pub fn parse_degrees_formula(formula: &str) -> Option<String> {
  let (function, args) = parse_function_arguments(formula)?;
  if function == "DEGREES" && args.len() == 1 {
    return Some(args[0].clone());
  }
  None
}

pub fn parse_radians_formula(formula: &str) -> Option<String> {
  let (function, args) = parse_function_arguments(formula)?;
  if function == "RADIANS" && args.len() == 1 {
    return Some(args[0].clone());
  }
  None
}

pub fn parse_round_formula(formula: &str) -> Option<(String, String)> {
  let (function, args) = parse_function_arguments(formula)?;
  if function == "ROUND" && args.len() == 2 {
    return Some((args[0].clone(), args[1].clone()));
  }
  None
}

pub fn parse_roundup_formula(formula: &str) -> Option<(String, String)> {
  let (function, args) = parse_function_arguments(formula)?;
  if function == "ROUNDUP" && args.len() == 2 {
    return Some((args[0].clone(), args[1].clone()));
  }
  None
}

pub fn parse_rounddown_formula(formula: &str) -> Option<(String, String)> {
  let (function, args) = parse_function_arguments(formula)?;
  if function == "ROUNDDOWN" && args.len() == 2 {
    return Some((args[0].clone(), args[1].clone()));
  }
  None
}

pub fn parse_ceiling_formula(formula: &str) -> Option<(String, String)> {
  let (function, args) = parse_function_arguments(formula)?;
  if function == "CEILING" && args.len() == 2 {
    return Some((args[0].clone(), args[1].clone()));
  }
  None
}

pub fn parse_ceiling_math_formula(
  formula: &str,
) -> Option<(String, Option<String>, Option<String>)> {
  let (function, args) = parse_function_arguments(formula)?;
  if function != "CEILING.MATH" || args.is_empty() || args.len() > 3 {
    return None;
  }
  Some((args[0].clone(), args.get(1).cloned(), args.get(2).cloned()))
}

pub fn parse_floor_formula(formula: &str) -> Option<(String, String)> {
  let (function, args) = parse_function_arguments(formula)?;
  if function == "FLOOR" && args.len() == 2 {
    return Some((args[0].clone(), args[1].clone()));
  }
  None
}

pub fn parse_floor_math_formula(
  formula: &str,
) -> Option<(String, Option<String>, Option<String>)> {
  let (function, args) = parse_function_arguments(formula)?;
  if function != "FLOOR.MATH" || args.is_empty() || args.len() > 3 {
    return None;
  }
  Some((args[0].clone(), args.get(1).cloned(), args.get(2).cloned()))
}

pub fn parse_sqrt_formula(formula: &str) -> Option<String> {
  let (function, args) = parse_function_arguments(formula)?;
  if function == "SQRT" && args.len() == 1 {
    return Some(args[0].clone());
  }
  None
}

pub fn parse_power_formula(formula: &str) -> Option<(String, String)> {
  let (function, args) = parse_function_arguments(formula)?;
  if function == "POWER" && args.len() == 2 {
    return Some((args[0].clone(), args[1].clone()));
  }
  None
}

pub fn parse_mod_formula(formula: &str) -> Option<(String, String)> {
  let (function, args) = parse_function_arguments(formula)?;
  if function == "MOD" && args.len() == 2 {
    return Some((args[0].clone(), args[1].clone()));
  }
  None
}

pub fn parse_quotient_formula(formula: &str) -> Option<(String, String)> {
  let (function, args) = parse_function_arguments(formula)?;
  if function == "QUOTIENT" && args.len() == 2 {
    return Some((args[0].clone(), args[1].clone()));
  }
  None
}

pub fn parse_mround_formula(formula: &str) -> Option<(String, String)> {
  let (function, args) = parse_function_arguments(formula)?;
  if function == "MROUND" && args.len() == 2 {
    return Some((args[0].clone(), args[1].clone()));
  }
  None
}

pub fn parse_sign_formula(formula: &str) -> Option<String> {
  let (function, args) = parse_function_arguments(formula)?;
  if function == "SIGN" && args.len() == 1 {
    return Some(args[0].clone());
  }
  None
}

pub fn parse_int_formula(formula: &str) -> Option<String> {
  let (function, args) = parse_function_arguments(formula)?;
  if function == "INT" && args.len() == 1 {
    return Some(args[0].clone());
  }
  None
}

pub fn parse_trunc_formula(formula: &str) -> Option<(String, Option<String>)> {
  let (function, args) = parse_function_arguments(formula)?;
  if function != "TRUNC" || !(args.len() == 1 || args.len() == 2) {
    return None;
  }
  Some((args[0].clone(), args.get(1).cloned()))
}

pub fn parse_even_formula(formula: &str) -> Option<String> {
  let (function, args) = parse_function_arguments(formula)?;
  if function == "EVEN" && args.len() == 1 {
    return Some(args[0].clone());
  }
  None
}

pub fn parse_odd_formula(formula: &str) -> Option<String> {
  let (function, args) = parse_function_arguments(formula)?;
  if function == "ODD" && args.len() == 1 {
    return Some(args[0].clone());
  }
  None
}

pub fn parse_exact_formula(formula: &str) -> Option<(String, String)> {
  let (function, args) = parse_function_arguments(formula)?;
  if function == "EXACT" && args.len() == 2 {
    return Some((args[0].clone(), args[1].clone()));
  }
  None
}

pub fn parse_isblank_formula(formula: &str) -> Option<String> {
  let (function, args) = parse_function_arguments(formula)?;
  if function == "ISBLANK" && args.len() == 1 {
    return Some(args[0].clone());
  }
  None
}

pub fn parse_isnumber_formula(formula: &str) -> Option<String> {
  let (function, args) = parse_function_arguments(formula)?;
  if function == "ISNUMBER" && args.len() == 1 {
    return Some(args[0].clone());
  }
  None
}

pub fn parse_istext_formula(formula: &str) -> Option<String> {
  let (function, args) = parse_function_arguments(formula)?;
  if function == "ISTEXT" && args.len() == 1 {
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

pub fn parse_mid_formula(formula: &str) -> Option<(String, String, String)> {
  let (function, args) = parse_function_arguments(formula)?;
  if function == "MID" && args.len() == 3 {
    return Some((args[0].clone(), args[1].clone(), args[2].clone()));
  }
  None
}

pub fn parse_rept_formula(formula: &str) -> Option<(String, String)> {
  let (function, args) = parse_function_arguments(formula)?;
  if function == "REPT" && args.len() == 2 {
    return Some((args[0].clone(), args[1].clone()));
  }
  None
}

pub fn parse_replace_formula(
  formula: &str,
) -> Option<(String, String, String, String)> {
  let (function, args) = parse_function_arguments(formula)?;
  if function == "REPLACE" && args.len() == 4 {
    return Some((
      args[0].clone(),
      args[1].clone(),
      args[2].clone(),
      args[3].clone(),
    ));
  }
  None
}

pub fn parse_substitute_formula(
  formula: &str,
) -> Option<(String, String, String, Option<String>)> {
  let (function, args) = parse_function_arguments(formula)?;
  if function != "SUBSTITUTE" || !(args.len() == 3 || args.len() == 4) {
    return None;
  }
  Some((
    args[0].clone(),
    args[1].clone(),
    args[2].clone(),
    args.get(3).cloned(),
  ))
}

pub fn parse_value_formula(formula: &str) -> Option<String> {
  let (function, args) = parse_function_arguments(formula)?;
  if function == "VALUE" && args.len() == 1 {
    return Some(args[0].clone());
  }
  None
}

pub fn parse_n_formula(formula: &str) -> Option<String> {
  let (function, args) = parse_function_arguments(formula)?;
  if function == "N" && args.len() == 1 {
    return Some(args[0].clone());
  }
  None
}

pub fn parse_t_formula(formula: &str) -> Option<String> {
  let (function, args) = parse_function_arguments(formula)?;
  if function == "T" && args.len() == 1 {
    return Some(args[0].clone());
  }
  None
}

pub fn parse_char_formula(formula: &str) -> Option<String> {
  let (function, args) = parse_function_arguments(formula)?;
  if function == "CHAR" && args.len() == 1 {
    return Some(args[0].clone());
  }
  None
}

pub fn parse_code_formula(formula: &str) -> Option<String> {
  let (function, args) = parse_function_arguments(formula)?;
  if function == "CODE" && args.len() == 1 {
    return Some(args[0].clone());
  }
  None
}

pub fn parse_unichar_formula(formula: &str) -> Option<String> {
  let (function, args) = parse_function_arguments(formula)?;
  if function == "UNICHAR" && args.len() == 1 {
    return Some(args[0].clone());
  }
  None
}

pub fn parse_unicode_formula(formula: &str) -> Option<String> {
  let (function, args) = parse_function_arguments(formula)?;
  if function == "UNICODE" && args.len() == 1 {
    return Some(args[0].clone());
  }
  None
}

pub fn parse_roman_formula(formula: &str) -> Option<(String, Option<String>)> {
  let (function, args) = parse_function_arguments(formula)?;
  if function != "ROMAN" || !(args.len() == 1 || args.len() == 2) {
    return None;
  }
  Some((args[0].clone(), args.get(1).cloned()))
}

pub fn parse_arabic_formula(formula: &str) -> Option<String> {
  let (function, args) = parse_function_arguments(formula)?;
  if function == "ARABIC" && args.len() == 1 {
    return Some(args[0].clone());
  }
  None
}

pub fn parse_search_formula(
  formula: &str,
) -> Option<(String, String, Option<String>)> {
  let (function, args) = parse_function_arguments(formula)?;
  if function != "SEARCH" || !(args.len() == 2 || args.len() == 3) {
    return None;
  }
  Some((args[0].clone(), args[1].clone(), args.get(2).cloned()))
}

pub fn parse_find_formula(
  formula: &str,
) -> Option<(String, String, Option<String>)> {
  let (function, args) = parse_function_arguments(formula)?;
  if function != "FIND" || !(args.len() == 2 || args.len() == 3) {
    return None;
  }
  Some((args[0].clone(), args[1].clone(), args.get(2).cloned()))
}

pub fn parse_date_formula(formula: &str) -> Option<(String, String, String)> {
  let (function, args) = parse_function_arguments(formula)?;
  if function == "DATE" && args.len() == 3 {
    return Some((args[0].clone(), args[1].clone(), args[2].clone()));
  }
  None
}

pub fn parse_edate_formula(formula: &str) -> Option<(String, String)> {
  let (function, args) = parse_function_arguments(formula)?;
  if function == "EDATE" && args.len() == 2 {
    return Some((args[0].clone(), args[1].clone()));
  }
  None
}

pub fn parse_eomonth_formula(formula: &str) -> Option<(String, String)> {
  let (function, args) = parse_function_arguments(formula)?;
  if function == "EOMONTH" && args.len() == 2 {
    return Some((args[0].clone(), args[1].clone()));
  }
  None
}

pub fn parse_days_formula(formula: &str) -> Option<(String, String)> {
  let (function, args) = parse_function_arguments(formula)?;
  if function == "DAYS" && args.len() == 2 {
    return Some((args[0].clone(), args[1].clone()));
  }
  None
}

pub fn parse_days360_formula(
  formula: &str,
) -> Option<(String, String, Option<String>)> {
  let (function, args) = parse_function_arguments(formula)?;
  if function != "DAYS360" || !(args.len() == 2 || args.len() == 3) {
    return None;
  }
  Some((args[0].clone(), args[1].clone(), args.get(2).cloned()))
}

pub fn parse_yearfrac_formula(
  formula: &str,
) -> Option<(String, String, Option<String>)> {
  let (function, args) = parse_function_arguments(formula)?;
  if function != "YEARFRAC" || !(args.len() == 2 || args.len() == 3) {
    return None;
  }
  Some((args[0].clone(), args[1].clone(), args.get(2).cloned()))
}

pub fn parse_datevalue_formula(formula: &str) -> Option<String> {
  let (function, args) = parse_function_arguments(formula)?;
  if function == "DATEVALUE" && args.len() == 1 {
    return Some(args[0].clone());
  }
  None
}

pub fn parse_timevalue_formula(formula: &str) -> Option<String> {
  let (function, args) = parse_function_arguments(formula)?;
  if function == "TIMEVALUE" && args.len() == 1 {
    return Some(args[0].clone());
  }
  None
}

pub fn parse_time_formula(formula: &str) -> Option<(String, String, String)> {
  let (function, args) = parse_function_arguments(formula)?;
  if function == "TIME" && args.len() == 3 {
    return Some((args[0].clone(), args[1].clone(), args[2].clone()));
  }
  None
}

pub fn parse_datedif_formula(formula: &str) -> Option<(String, String, String)> {
  let (function, args) = parse_function_arguments(formula)?;
  if function == "DATEDIF" && args.len() == 3 {
    return Some((args[0].clone(), args[1].clone(), args[2].clone()));
  }
  None
}

pub fn parse_networkdays_formula(
  formula: &str,
) -> Option<(String, String, Option<String>)> {
  let (function, args) = parse_function_arguments(formula)?;
  if function != "NETWORKDAYS" || !(args.len() == 2 || args.len() == 3) {
    return None;
  }
  Some((args[0].clone(), args[1].clone(), args.get(2).cloned()))
}

pub fn parse_workday_formula(
  formula: &str,
) -> Option<(String, String, Option<String>)> {
  let (function, args) = parse_function_arguments(formula)?;
  if function != "WORKDAY" || !(args.len() == 2 || args.len() == 3) {
    return None;
  }
  Some((args[0].clone(), args[1].clone(), args.get(2).cloned()))
}

pub fn parse_networkdays_intl_formula(
  formula: &str,
) -> Option<(String, String, Option<String>, Option<String>)> {
  let (function, args) = parse_function_arguments(formula)?;
  if function != "NETWORKDAYS.INTL" || !(args.len() == 2 || args.len() == 3 || args.len() == 4) {
    return None;
  }
  Some((
    args[0].clone(),
    args[1].clone(),
    args.get(2).cloned(),
    args.get(3).cloned(),
  ))
}

pub fn parse_workday_intl_formula(
  formula: &str,
) -> Option<(String, String, Option<String>, Option<String>)> {
  let (function, args) = parse_function_arguments(formula)?;
  if function != "WORKDAY.INTL" || !(args.len() == 2 || args.len() == 3 || args.len() == 4) {
    return None;
  }
  Some((
    args[0].clone(),
    args[1].clone(),
    args.get(2).cloned(),
    args.get(3).cloned(),
  ))
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

pub fn parse_weekday_formula(
  formula: &str,
) -> Option<(String, Option<String>)> {
  let (function, args) = parse_function_arguments(formula)?;
  if function != "WEEKDAY" || !(args.len() == 1 || args.len() == 2) {
    return None;
  }
  Some((args[0].clone(), args.get(1).cloned()))
}

pub fn parse_weeknum_formula(
  formula: &str,
) -> Option<(String, Option<String>)> {
  let (function, args) = parse_function_arguments(formula)?;
  if function != "WEEKNUM" || !(args.len() == 1 || args.len() == 2) {
    return None;
  }
  Some((args[0].clone(), args.get(1).cloned()))
}

pub fn parse_isoweeknum_formula(formula: &str) -> Option<String> {
  let (function, args) = parse_function_arguments(formula)?;
  if function == "ISOWEEKNUM" && args.len() == 1 {
    return Some(args[0].clone());
  }
  None
}

pub fn parse_hour_formula(formula: &str) -> Option<String> {
  let (function, args) = parse_function_arguments(formula)?;
  if function == "HOUR" && args.len() == 1 {
    return Some(args[0].clone());
  }
  None
}

pub fn parse_minute_formula(formula: &str) -> Option<String> {
  let (function, args) = parse_function_arguments(formula)?;
  if function == "MINUTE" && args.len() == 1 {
    return Some(args[0].clone());
  }
  None
}

pub fn parse_second_formula(formula: &str) -> Option<String> {
  let (function, args) = parse_function_arguments(formula)?;
  if function == "SECOND" && args.len() == 1 {
    return Some(args[0].clone());
  }
  None
}

pub fn parse_iseven_formula(formula: &str) -> Option<String> {
  let (function, args) = parse_function_arguments(formula)?;
  if function == "ISEVEN" && args.len() == 1 {
    return Some(args[0].clone());
  }
  None
}

pub fn parse_isodd_formula(formula: &str) -> Option<String> {
  let (function, args) = parse_function_arguments(formula)?;
  if function == "ISODD" && args.len() == 1 {
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

pub fn parse_counta_formula(formula: &str) -> Option<((u32, u32), (u32, u32))> {
  let (function, args) = parse_function_arguments(formula)?;
  if function != "COUNTA" || args.len() != 1 {
    return None;
  }
  parse_range_reference(&args[0])
}

pub fn parse_countblank_formula(
  formula: &str,
) -> Option<((u32, u32), (u32, u32))> {
  let (function, args) = parse_function_arguments(formula)?;
  if function != "COUNTBLANK" || args.len() != 1 {
    return None;
  }
  parse_range_reference(&args[0])
}

pub fn parse_row_formula(formula: &str) -> Option<String> {
  let (function, args) = parse_function_arguments(formula)?;
  if function == "ROW" && args.len() == 1 {
    return Some(args[0].clone());
  }
  None
}

pub fn parse_column_formula(formula: &str) -> Option<String> {
  let (function, args) = parse_function_arguments(formula)?;
  if function == "COLUMN" && args.len() == 1 {
    return Some(args[0].clone());
  }
  None
}

pub fn parse_rows_formula(formula: &str) -> Option<String> {
  let (function, args) = parse_function_arguments(formula)?;
  if function == "ROWS" && args.len() == 1 {
    return Some(args[0].clone());
  }
  None
}

pub fn parse_columns_formula(formula: &str) -> Option<String> {
  let (function, args) = parse_function_arguments(formula)?;
  if function == "COLUMNS" && args.len() == 1 {
    return Some(args[0].clone());
  }
  None
}

pub fn parse_large_formula(
  formula: &str,
) -> Option<((u32, u32), (u32, u32), String)> {
  let (function, args) = parse_function_arguments(formula)?;
  if function != "LARGE" || args.len() != 2 {
    return None;
  }
  let (start, end) = parse_range_reference(&args[0])?;
  Some((start, end, args[1].clone()))
}

pub fn parse_small_formula(
  formula: &str,
) -> Option<((u32, u32), (u32, u32), String)> {
  let (function, args) = parse_function_arguments(formula)?;
  if function != "SMALL" || args.len() != 2 {
    return None;
  }
  let (start, end) = parse_range_reference(&args[0])?;
  Some((start, end, args[1].clone()))
}

pub fn parse_rank_formula(
  formula: &str,
) -> Option<(String, (u32, u32), (u32, u32), Option<String>)> {
  let (function, args) = parse_function_arguments(formula)?;
  if (function != "RANK" && function != "RANK.EQ")
    || !(args.len() == 2 || args.len() == 3)
  {
    return None;
  }
  let (start, end) = parse_range_reference(&args[1])?;
  Some((args[0].clone(), start, end, args.get(2).cloned()))
}

pub fn parse_percentile_inc_formula(
  formula: &str,
) -> Option<((u32, u32), (u32, u32), String)> {
  let (function, args) = parse_function_arguments(formula)?;
  if (function != "PERCENTILE.INC" && function != "PERCENTILE")
    || args.len() != 2
  {
    return None;
  }
  let (start, end) = parse_range_reference(&args[0])?;
  Some((start, end, args[1].clone()))
}

pub fn parse_quartile_inc_formula(
  formula: &str,
) -> Option<((u32, u32), (u32, u32), String)> {
  let (function, args) = parse_function_arguments(formula)?;
  if (function != "QUARTILE.INC" && function != "QUARTILE")
    || args.len() != 2
  {
    return None;
  }
  let (start, end) = parse_range_reference(&args[0])?;
  Some((start, end, args[1].clone()))
}

pub fn parse_percentile_exc_formula(
  formula: &str,
) -> Option<((u32, u32), (u32, u32), String)> {
  let (function, args) = parse_function_arguments(formula)?;
  if function != "PERCENTILE.EXC" || args.len() != 2 {
    return None;
  }
  let (start, end) = parse_range_reference(&args[0])?;
  Some((start, end, args[1].clone()))
}

pub fn parse_quartile_exc_formula(
  formula: &str,
) -> Option<((u32, u32), (u32, u32), String)> {
  let (function, args) = parse_function_arguments(formula)?;
  if function != "QUARTILE.EXC" || args.len() != 2 {
    return None;
  }
  let (start, end) = parse_range_reference(&args[0])?;
  Some((start, end, args[1].clone()))
}

pub fn parse_mode_sngl_formula(formula: &str) -> Option<((u32, u32), (u32, u32))> {
  let (function, args) = parse_function_arguments(formula)?;
  if function != "MODE.SNGL" || args.len() != 1 {
    return None;
  }
  parse_range_reference(&args[0])
}

pub fn parse_geomean_formula(formula: &str) -> Option<((u32, u32), (u32, u32))> {
  let (function, args) = parse_function_arguments(formula)?;
  if function != "GEOMEAN" || args.len() != 1 {
    return None;
  }
  parse_range_reference(&args[0])
}

pub fn parse_harmean_formula(formula: &str) -> Option<((u32, u32), (u32, u32))> {
  let (function, args) = parse_function_arguments(formula)?;
  if function != "HARMEAN" || args.len() != 1 {
    return None;
  }
  parse_range_reference(&args[0])
}

pub fn parse_trimmean_formula(
  formula: &str,
) -> Option<((u32, u32), (u32, u32), String)> {
  let (function, args) = parse_function_arguments(formula)?;
  if function != "TRIMMEAN" || args.len() != 2 {
    return None;
  }
  let (start, end) = parse_range_reference(&args[0])?;
  Some((start, end, args[1].clone()))
}

pub fn parse_devsq_formula(formula: &str) -> Option<((u32, u32), (u32, u32))> {
  let (function, args) = parse_function_arguments(formula)?;
  if function != "DEVSQ" || args.len() != 1 {
    return None;
  }
  parse_range_reference(&args[0])
}

pub fn parse_avedev_formula(formula: &str) -> Option<((u32, u32), (u32, u32))> {
  let (function, args) = parse_function_arguments(formula)?;
  if function != "AVEDEV" || args.len() != 1 {
    return None;
  }
  parse_range_reference(&args[0])
}

pub fn parse_averagea_formula(formula: &str) -> Option<((u32, u32), (u32, u32))> {
  let (function, args) = parse_function_arguments(formula)?;
  if function != "AVERAGEA" || args.len() != 1 {
    return None;
  }
  parse_range_reference(&args[0])
}

pub fn parse_stdeva_formula(formula: &str) -> Option<((u32, u32), (u32, u32))> {
  let (function, args) = parse_function_arguments(formula)?;
  if function != "STDEVA" || args.len() != 1 {
    return None;
  }
  parse_range_reference(&args[0])
}

pub fn parse_stdevpa_formula(formula: &str) -> Option<((u32, u32), (u32, u32))> {
  let (function, args) = parse_function_arguments(formula)?;
  if function != "STDEVPA" || args.len() != 1 {
    return None;
  }
  parse_range_reference(&args[0])
}

pub fn parse_vara_formula(formula: &str) -> Option<((u32, u32), (u32, u32))> {
  let (function, args) = parse_function_arguments(formula)?;
  if function != "VARA" || args.len() != 1 {
    return None;
  }
  parse_range_reference(&args[0])
}

pub fn parse_varpa_formula(formula: &str) -> Option<((u32, u32), (u32, u32))> {
  let (function, args) = parse_function_arguments(formula)?;
  if function != "VARPA" || args.len() != 1 {
    return None;
  }
  parse_range_reference(&args[0])
}

pub fn parse_covariance_formula(
  formula: &str,
) -> Option<(String, (u32, u32), (u32, u32), (u32, u32), (u32, u32))> {
  let (function, args) = parse_function_arguments(formula)?;
  if (function != "COVARIANCE.P" && function != "COVARIANCE.S" && function != "COVAR")
    || args.len() != 2
  {
    return None;
  }
  let (left_start, left_end) = parse_range_reference(&args[0])?;
  let (right_start, right_end) = parse_range_reference(&args[1])?;
  Some((function, left_start, left_end, right_start, right_end))
}

pub fn parse_correl_formula(
  formula: &str,
) -> Option<((u32, u32), (u32, u32), (u32, u32), (u32, u32))> {
  let (function, args) = parse_function_arguments(formula)?;
  if (function != "CORREL" && function != "PEARSON") || args.len() != 2 {
    return None;
  }
  let (left_start, left_end) = parse_range_reference(&args[0])?;
  let (right_start, right_end) = parse_range_reference(&args[1])?;
  Some((left_start, left_end, right_start, right_end))
}

pub fn parse_slope_formula(
  formula: &str,
) -> Option<((u32, u32), (u32, u32), (u32, u32), (u32, u32))> {
  let (function, args) = parse_function_arguments(formula)?;
  if function != "SLOPE" || args.len() != 2 {
    return None;
  }
  let (known_y_start, known_y_end) = parse_range_reference(&args[0])?;
  let (known_x_start, known_x_end) = parse_range_reference(&args[1])?;
  Some((known_y_start, known_y_end, known_x_start, known_x_end))
}

pub fn parse_intercept_formula(
  formula: &str,
) -> Option<((u32, u32), (u32, u32), (u32, u32), (u32, u32))> {
  let (function, args) = parse_function_arguments(formula)?;
  if function != "INTERCEPT" || args.len() != 2 {
    return None;
  }
  let (known_y_start, known_y_end) = parse_range_reference(&args[0])?;
  let (known_x_start, known_x_end) = parse_range_reference(&args[1])?;
  Some((known_y_start, known_y_end, known_x_start, known_x_end))
}

pub fn parse_rsq_formula(
  formula: &str,
) -> Option<((u32, u32), (u32, u32), (u32, u32), (u32, u32))> {
  let (function, args) = parse_function_arguments(formula)?;
  if function != "RSQ" || args.len() != 2 {
    return None;
  }
  let (known_y_start, known_y_end) = parse_range_reference(&args[0])?;
  let (known_x_start, known_x_end) = parse_range_reference(&args[1])?;
  Some((known_y_start, known_y_end, known_x_start, known_x_end))
}

pub fn parse_forecast_linear_formula(
  formula: &str,
) -> Option<(String, String, (u32, u32), (u32, u32), (u32, u32), (u32, u32))> {
  let (function, args) = parse_function_arguments(formula)?;
  if (function != "FORECAST.LINEAR" && function != "FORECAST") || args.len() != 3 {
    return None;
  }
  let (known_y_start, known_y_end) = parse_range_reference(&args[1])?;
  let (known_x_start, known_x_end) = parse_range_reference(&args[2])?;
  Some((
    function,
    args[0].clone(),
    known_y_start,
    known_y_end,
    known_x_start,
    known_x_end,
  ))
}

pub fn parse_steyx_formula(
  formula: &str,
) -> Option<((u32, u32), (u32, u32), (u32, u32), (u32, u32))> {
  let (function, args) = parse_function_arguments(formula)?;
  if function != "STEYX" || args.len() != 2 {
    return None;
  }
  let (known_y_start, known_y_end) = parse_range_reference(&args[0])?;
  let (known_x_start, known_x_end) = parse_range_reference(&args[1])?;
  Some((known_y_start, known_y_end, known_x_start, known_x_end))
}

pub fn parse_sumx_formula(
  formula: &str,
) -> Option<(String, (u32, u32), (u32, u32), (u32, u32), (u32, u32))> {
  let (function, args) = parse_function_arguments(formula)?;
  if (function != "SUMXMY2" && function != "SUMX2MY2" && function != "SUMX2PY2")
    || args.len() != 2
  {
    return None;
  }
  let (left_start, left_end) = parse_range_reference(&args[0])?;
  let (right_start, right_end) = parse_range_reference(&args[1])?;
  Some((function, left_start, left_end, right_start, right_end))
}

pub fn parse_skew_formula(formula: &str) -> Option<((u32, u32), (u32, u32))> {
  let (function, args) = parse_function_arguments(formula)?;
  if function != "SKEW" || args.len() != 1 {
    return None;
  }
  parse_range_reference(&args[0])
}

pub fn parse_skew_p_formula(formula: &str) -> Option<((u32, u32), (u32, u32))> {
  let (function, args) = parse_function_arguments(formula)?;
  if function != "SKEW.P" || args.len() != 1 {
    return None;
  }
  parse_range_reference(&args[0])
}

pub fn parse_kurt_formula(formula: &str) -> Option<((u32, u32), (u32, u32))> {
  let (function, args) = parse_function_arguments(formula)?;
  if function != "KURT" || args.len() != 1 {
    return None;
  }
  parse_range_reference(&args[0])
}

pub fn parse_fisher_formula(formula: &str) -> Option<String> {
  let (function, args) = parse_function_arguments(formula)?;
  if function != "FISHER" || args.len() != 1 {
    return None;
  }
  Some(args[0].clone())
}

pub fn parse_fisherinv_formula(formula: &str) -> Option<String> {
  let (function, args) = parse_function_arguments(formula)?;
  if function != "FISHERINV" || args.len() != 1 {
    return None;
  }
  Some(args[0].clone())
}

pub fn parse_percentrank_inc_formula(
  formula: &str,
) -> Option<((u32, u32), (u32, u32), String, Option<String>)> {
  let (function, args) = parse_function_arguments(formula)?;
  if (function != "PERCENTRANK.INC" && function != "PERCENTRANK")
    || !(args.len() == 2 || args.len() == 3)
  {
    return None;
  }
  let (start, end) = parse_range_reference(&args[0])?;
  Some((start, end, args[1].clone(), args.get(2).cloned()))
}

pub fn parse_percentrank_exc_formula(
  formula: &str,
) -> Option<((u32, u32), (u32, u32), String, Option<String>)> {
  let (function, args) = parse_function_arguments(formula)?;
  if function != "PERCENTRANK.EXC" || !(args.len() == 2 || args.len() == 3) {
    return None;
  }
  let (start, end) = parse_range_reference(&args[0])?;
  Some((start, end, args[1].clone(), args.get(2).cloned()))
}

pub fn parse_sumproduct_formula(
  formula: &str,
) -> Option<Vec<((u32, u32), (u32, u32))>> {
  let (function, args) = parse_function_arguments(formula)?;
  if function != "SUMPRODUCT" || args.is_empty() {
    return None;
  }
  let mut ranges = Vec::new();
  for argument in args {
    ranges.push(parse_range_reference(&argument)?);
  }
  Some(ranges)
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

pub fn parse_minifs_formula(
  formula: &str,
) -> Option<MultiCriteriaAggregateFormula> {
  parse_multi_criteria_aggregate_formula(formula, "MINIFS")
}

pub fn parse_maxifs_formula(
  formula: &str,
) -> Option<MultiCriteriaAggregateFormula> {
  parse_multi_criteria_aggregate_formula(formula, "MAXIFS")
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
    parse_abs_formula, parse_concat_formula, parse_textjoin_formula,
    parse_date_formula, parse_edate_formula,
    parse_eomonth_formula, parse_days_formula, parse_days360_formula,
    parse_yearfrac_formula, parse_datevalue_formula,
    parse_timevalue_formula, parse_time_formula, parse_datedif_formula,
    parse_networkdays_formula,
    parse_workday_formula, parse_networkdays_intl_formula, parse_workday_intl_formula,
    parse_day_formula,
    parse_ceiling_formula, parse_ceiling_math_formula, parse_floor_formula,
    parse_floor_math_formula,
    parse_exact_formula,
    parse_hour_formula, parse_minute_formula, parse_second_formula,
    parse_index_formula, parse_int_formula, parse_isblank_formula,
    parse_iseven_formula, parse_isodd_formula,
    parse_isnumber_formula, parse_istext_formula, parse_left_formula,
    parse_len_formula, parse_ln_formula, parse_log10_formula, parse_exp_formula,
    parse_log_formula, parse_effect_formula, parse_nominal_formula,
    parse_npv_formula, parse_pv_formula, parse_fv_formula, parse_pmt_formula,
    parse_irr_formula, parse_mirr_formula, parse_nper_formula, parse_rate_formula,
    parse_ipmt_formula, parse_ppmt_formula,
    parse_sln_formula, parse_syd_formula,
    parse_db_formula, parse_ddb_formula,
    parse_rri_formula, parse_pduration_formula,
    parse_fvschedule_formula, parse_ispmt_formula,
    parse_cumipmt_formula, parse_cumprinc_formula,
    parse_fact_formula, parse_factdouble_formula,
    parse_combin_formula, parse_combina_formula, parse_gcd_formula, parse_lcm_formula,
    parse_permut_formula, parse_permutationa_formula, parse_multinomial_formula,
    parse_sin_formula, parse_cos_formula, parse_tan_formula,
    parse_cot_formula, parse_sec_formula, parse_csc_formula,
    parse_sinh_formula, parse_cosh_formula, parse_tanh_formula,
    parse_coth_formula, parse_sech_formula, parse_csch_formula,
    parse_asinh_formula, parse_acosh_formula, parse_atanh_formula,
    parse_acot_formula, parse_asec_formula, parse_acsc_formula,
    parse_acoth_formula, parse_asech_formula, parse_acsch_formula,
    parse_asin_formula,
    parse_acos_formula, parse_atan_formula, parse_atan2_formula, parse_degrees_formula,
    parse_radians_formula, parse_lower_formula,
    parse_match_formula, parse_maxifs_formula,
    parse_minifs_formula,
    parse_month_formula,
    parse_not_formula, parse_or_formula, parse_xor_formula, parse_right_formula,
    parse_find_formula, parse_mid_formula, parse_rept_formula,
    parse_replace_formula, parse_search_formula, parse_substitute_formula,
    parse_value_formula, parse_n_formula, parse_t_formula, parse_char_formula,
    parse_code_formula, parse_unichar_formula, parse_unicode_formula,
    parse_roman_formula, parse_arabic_formula,
    parse_cell_address,
    parse_mod_formula, parse_quotient_formula, parse_mround_formula,
    parse_sign_formula,
    parse_power_formula,
    parse_round_formula, parse_rounddown_formula, parse_roundup_formula,
    parse_trunc_formula, parse_even_formula, parse_odd_formula,
    parse_sqrt_formula,
    parse_countifs_formula, parse_sumproduct_formula, parse_sumif_formula,
    parse_sumifs_formula, parse_row_formula, parse_column_formula,
    parse_rows_formula, parse_columns_formula,
    parse_large_formula, parse_small_formula, parse_rank_formula,
    parse_percentile_inc_formula, parse_quartile_inc_formula,
    parse_percentile_exc_formula, parse_quartile_exc_formula,
    parse_mode_sngl_formula, parse_geomean_formula, parse_harmean_formula,
    parse_trimmean_formula,
    parse_devsq_formula, parse_avedev_formula,
    parse_averagea_formula, parse_stdeva_formula, parse_stdevpa_formula,
    parse_vara_formula, parse_varpa_formula,
    parse_covariance_formula, parse_correl_formula,
    parse_slope_formula, parse_intercept_formula, parse_rsq_formula,
    parse_forecast_linear_formula, parse_steyx_formula,
    parse_sumx_formula,
    parse_skew_formula, parse_skew_p_formula, parse_kurt_formula,
    parse_fisher_formula, parse_fisherinv_formula,
    parse_percentrank_inc_formula, parse_percentrank_exc_formula,
    parse_counta_formula, parse_countblank_formula,
    parse_if_formula, parse_ifs_formula, parse_iferror_formula, parse_ifna_formula,
    parse_na_formula, parse_choose_formula,
    parse_switch_formula,
    parse_today_formula, parse_now_formula, parse_rand_formula,
    parse_randbetween_formula, parse_true_formula,
    parse_false_formula, parse_pi_formula, parse_vlookup_formula,
    parse_xlookup_formula, parse_countif_formula, parse_hlookup_formula,
    parse_year_formula,
    parse_weekday_formula, parse_weeknum_formula, parse_isoweeknum_formula,
    parse_upper_formula, parse_trim_formula, parse_proper_formula, parse_clean_formula,
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

    let product = parse_aggregate_formula("=PRODUCT(C1:C3)")
      .expect("product should parse");
    assert_eq!(product.0, "PRODUCT");
    assert_eq!(product.1, (1, 3));
    assert_eq!(product.2, (3, 3));

    let median = parse_aggregate_formula("=MEDIAN(D1:D4)")
      .expect("median should parse");
    assert_eq!(median.0, "MEDIAN");
    assert_eq!(median.1, (1, 4));
    assert_eq!(median.2, (4, 4));

    let stdev_pop = parse_aggregate_formula("=STDEV.P(A1:A5)")
      .expect("stdev.p should parse");
    assert_eq!(stdev_pop.0, "STDEV.P");
    assert_eq!(stdev_pop.1, (1, 1));
    assert_eq!(stdev_pop.2, (5, 1));

    let stdev_legacy = parse_aggregate_formula("=STDEV(A1:A5)")
      .expect("stdev should parse");
    assert_eq!(stdev_legacy.0, "STDEV");
    assert_eq!(stdev_legacy.1, (1, 1));
    assert_eq!(stdev_legacy.2, (5, 1));
  }

  #[test]
  fn should_parse_logical_and_text_formulas() {
    let if_formula = parse_if_formula(r#"=IF(B2>=100, "bonus", "standard")"#)
      .expect("if formula should parse");
    assert_eq!(if_formula.0, "B2>=100");
    assert_eq!(if_formula.1, r#""bonus""#);
    assert_eq!(if_formula.2, r#""standard""#);
    let ifs_formula = parse_ifs_formula(
      r#"=IFS(B2>=100,"bonus",B2>=80,"standard",TRUE,"low")"#,
    )
    .expect("ifs formula should parse");
    assert_eq!(
      ifs_formula,
      vec![
        ("B2>=100".to_string(), r#""bonus""#.to_string()),
        ("B2>=80".to_string(), r#""standard""#.to_string()),
        ("TRUE".to_string(), r#""low""#.to_string()),
      ],
    );

    let concat = parse_concat_formula(r#"=CONCAT("sales-", A2, "-", B2)"#)
      .expect("concat formula should parse");
    assert_eq!(concat, vec![r#""sales-""#, "A2", r#""-""#, "B2"]);
    let textjoin = parse_textjoin_formula(r#"=TEXTJOIN("-",TRUE,A1,A2,"done")"#)
      .expect("textjoin should parse");
    assert_eq!(textjoin.0, r#""-""#);
    assert_eq!(textjoin.1, "TRUE");
    assert_eq!(textjoin.2, vec!["A1", "A2", r#""done""#]);

    let iferror =
      parse_iferror_formula(r#"=IFERROR(VLOOKUP(A1,D1:E5,2,TRUE),"fallback")"#)
        .expect("iferror should parse");
    assert_eq!(iferror.0, "VLOOKUP(A1,D1:E5,2,TRUE)");
    assert_eq!(iferror.1, r#""fallback""#);
    let ifna =
      parse_ifna_formula(r#"=IFNA(XLOOKUP(A1,D1:D5,E1:E5),"fallback-na")"#)
        .expect("ifna should parse");
    assert_eq!(ifna.0, "XLOOKUP(A1,D1:D5,E1:E5)");
    assert_eq!(ifna.1, r#""fallback-na""#);
    assert!(parse_na_formula("=NA()").is_some());

    let choose = parse_choose_formula(r#"=CHOOSE(2,"alpha","beta","gamma")"#)
      .expect("choose should parse");
    assert_eq!(choose.0, "2");
    assert_eq!(choose.1, vec![r#""alpha""#, r#""beta""#, r#""gamma""#]);
    let switch = parse_switch_formula(
      r#"=SWITCH(B2,"north","N","south","S","fallback")"#,
    )
    .expect("switch should parse");
    assert_eq!(switch.0, "B2");
    assert_eq!(
      switch.1,
      vec![
        (r#""north""#.to_string(), r#""N""#.to_string()),
        (r#""south""#.to_string(), r#""S""#.to_string()),
      ],
    );
    assert_eq!(switch.2.as_deref(), Some(r#""fallback""#));
  }

  #[test]
  fn should_parse_today_and_vlookup_formulas() {
    assert!(parse_today_formula("=TODAY()").is_some());
    assert!(parse_today_formula("=TODAY(1)").is_none());
    assert!(parse_now_formula("=NOW()").is_some());
    assert!(parse_now_formula("=NOW(1)").is_none());
    assert!(parse_rand_formula("=RAND()").is_some());
    assert!(parse_rand_formula("=RAND(1)").is_none());
    let randbetween = parse_randbetween_formula("=RANDBETWEEN(1,6)")
      .expect("randbetween should parse");
    assert_eq!(randbetween.0, "1");
    assert_eq!(randbetween.1, "6");
    assert!(parse_true_formula("=TRUE()").is_some());
    assert!(parse_true_formula("=TRUE(1)").is_none());
    assert!(parse_false_formula("=FALSE()").is_some());
    assert!(parse_false_formula("=FALSE(1)").is_none());
    assert!(parse_pi_formula("=PI()").is_some());
    assert!(parse_pi_formula("=PI(1)").is_none());

    let parsed = parse_vlookup_formula("=VLOOKUP(A2, D2:E6, 2, FALSE)")
      .expect("vlookup formula should parse");
    assert_eq!(parsed.lookup_value, "A2");
    assert_eq!(parsed.table_start, (2, 4));
    assert_eq!(parsed.table_end, (6, 5));
    assert_eq!(parsed.result_col_index, 2);
    assert_eq!(parsed.range_lookup.as_deref(), Some("FALSE"));

    let hlookup = parse_hlookup_formula("=HLOOKUP(A2, D2:F4, 2, FALSE)")
      .expect("hlookup formula should parse");
    assert_eq!(hlookup.lookup_value, "A2");
    assert_eq!(hlookup.table_start, (2, 4));
    assert_eq!(hlookup.table_end, (4, 6));
    assert_eq!(hlookup.result_row_index, 2);
    assert_eq!(hlookup.range_lookup.as_deref(), Some("FALSE"));

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
    let xor_args = parse_xor_formula("=XOR(A1=0,B1=0,C1=0)")
      .expect("xor should parse");
    assert_eq!(xor_args, vec!["A1=0", "B1=0", "C1=0"]);

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
    let proper_arg =
      parse_proper_formula(r#"=PROPER("hELLo woRLD")"#).expect("proper should parse");
    assert_eq!(proper_arg, r#""hELLo woRLD""#);
    let clean_arg =
      parse_clean_formula(r#"=CLEAN("A B")"#).expect("clean should parse");
    assert_eq!(clean_arg, r#""A B""#);
    assert_eq!(
      parse_abs_formula("=ABS(-12.5)").as_deref(),
      Some("-12.5"),
    );
    assert_eq!(parse_ln_formula("=LN(A1)").as_deref(), Some("A1"));
    assert_eq!(parse_log10_formula("=LOG10(A1)").as_deref(), Some("A1"));
    assert_eq!(parse_exp_formula("=EXP(A1)").as_deref(), Some("A1"));
    let log_args = parse_log_formula("=LOG(A1,10)").expect("log should parse");
    assert_eq!(log_args.0, "A1");
    assert_eq!(log_args.1.as_deref(), Some("10"));
    let effect_args =
      parse_effect_formula("=EFFECT(A1,B1)").expect("effect should parse");
    assert_eq!(effect_args.0, "A1");
    assert_eq!(effect_args.1, "B1");
    let nominal_args =
      parse_nominal_formula("=NOMINAL(A1,B1)").expect("nominal should parse");
    assert_eq!(nominal_args.0, "A1");
    assert_eq!(nominal_args.1, "B1");
    let npv_args = parse_npv_formula("=NPV(A1,B1,C1:C2)").expect("npv should parse");
    assert_eq!(npv_args.0, "A1");
    assert_eq!(npv_args.1, vec!["B1", "C1:C2"]);
    let pv_args = parse_pv_formula("=PV(A1,B1,C1,D1,1)").expect("pv should parse");
    assert_eq!(pv_args.0, "A1");
    assert_eq!(pv_args.1, "B1");
    assert_eq!(pv_args.2, "C1");
    assert_eq!(pv_args.3.as_deref(), Some("D1"));
    assert_eq!(pv_args.4.as_deref(), Some("1"));
    let fv_args = parse_fv_formula("=FV(A1,B1,C1,D1,0)").expect("fv should parse");
    assert_eq!(fv_args.0, "A1");
    assert_eq!(fv_args.1, "B1");
    assert_eq!(fv_args.2, "C1");
    assert_eq!(fv_args.3.as_deref(), Some("D1"));
    assert_eq!(fv_args.4.as_deref(), Some("0"));
    let pmt_args = parse_pmt_formula("=PMT(A1,B1,C1)").expect("pmt should parse");
    assert_eq!(pmt_args.0, "A1");
    assert_eq!(pmt_args.1, "B1");
    assert_eq!(pmt_args.2, "C1");
    assert_eq!(pmt_args.3, None);
    assert_eq!(pmt_args.4, None);
    let irr_range_args = parse_irr_formula("=IRR(A1:A5,0.2)").expect("irr should parse");
    assert_eq!(irr_range_args.0, vec!["A1:A5"]);
    assert_eq!(irr_range_args.1.as_deref(), Some("0.2"));
    let irr_scalar_args = parse_irr_formula("=IRR(-100,60,70)").expect("irr should parse");
    assert_eq!(irr_scalar_args.0, vec!["-100", "60", "70"]);
    assert_eq!(irr_scalar_args.1, None);
    let mirr_args = parse_mirr_formula("=MIRR(A1:A5,0.1,0.12)").expect("mirr should parse");
    assert_eq!(mirr_args.0, "A1:A5");
    assert_eq!(mirr_args.1, "0.1");
    assert_eq!(mirr_args.2, "0.12");
    let nper_args = parse_nper_formula("=NPER(A1,B1,C1,D1,1)").expect("nper should parse");
    assert_eq!(nper_args.0, "A1");
    assert_eq!(nper_args.1, "B1");
    assert_eq!(nper_args.2, "C1");
    assert_eq!(nper_args.3.as_deref(), Some("D1"));
    assert_eq!(nper_args.4.as_deref(), Some("1"));
    let rate_args = parse_rate_formula("=RATE(A1,B1,C1,D1,0,0.2)").expect("rate should parse");
    assert_eq!(rate_args.0, "A1");
    assert_eq!(rate_args.1, "B1");
    assert_eq!(rate_args.2, "C1");
    assert_eq!(rate_args.3.as_deref(), Some("D1"));
    assert_eq!(rate_args.4.as_deref(), Some("0"));
    assert_eq!(rate_args.5.as_deref(), Some("0.2"));
    let ipmt_args = parse_ipmt_formula("=IPMT(A1,B1,C1,D1,E1,1)").expect("ipmt should parse");
    assert_eq!(ipmt_args.0, "A1");
    assert_eq!(ipmt_args.1, "B1");
    assert_eq!(ipmt_args.2, "C1");
    assert_eq!(ipmt_args.3, "D1");
    assert_eq!(ipmt_args.4.as_deref(), Some("E1"));
    assert_eq!(ipmt_args.5.as_deref(), Some("1"));
    let ppmt_args = parse_ppmt_formula("=PPMT(A1,B1,C1,D1)").expect("ppmt should parse");
    assert_eq!(ppmt_args.0, "A1");
    assert_eq!(ppmt_args.1, "B1");
    assert_eq!(ppmt_args.2, "C1");
    assert_eq!(ppmt_args.3, "D1");
    assert_eq!(ppmt_args.4, None);
    assert_eq!(ppmt_args.5, None);
    let sln_args = parse_sln_formula("=SLN(A1,B1,C1)").expect("sln should parse");
    assert_eq!(sln_args.0, "A1");
    assert_eq!(sln_args.1, "B1");
    assert_eq!(sln_args.2, "C1");
    let syd_args = parse_syd_formula("=SYD(A1,B1,C1,D1)").expect("syd should parse");
    assert_eq!(syd_args.0, "A1");
    assert_eq!(syd_args.1, "B1");
    assert_eq!(syd_args.2, "C1");
    assert_eq!(syd_args.3, "D1");
    let db_args = parse_db_formula("=DB(A1,B1,C1,D1,6)").expect("db should parse");
    assert_eq!(db_args.0, "A1");
    assert_eq!(db_args.1, "B1");
    assert_eq!(db_args.2, "C1");
    assert_eq!(db_args.3, "D1");
    assert_eq!(db_args.4.as_deref(), Some("6"));
    let ddb_args = parse_ddb_formula("=DDB(A1,B1,C1,D1)").expect("ddb should parse");
    assert_eq!(ddb_args.0, "A1");
    assert_eq!(ddb_args.1, "B1");
    assert_eq!(ddb_args.2, "C1");
    assert_eq!(ddb_args.3, "D1");
    assert_eq!(ddb_args.4, None);
    let rri_args = parse_rri_formula("=RRI(A1,B1,C1)").expect("rri should parse");
    assert_eq!(rri_args.0, "A1");
    assert_eq!(rri_args.1, "B1");
    assert_eq!(rri_args.2, "C1");
    let pduration_args =
      parse_pduration_formula("=PDURATION(A1,B1,C1)").expect("pduration should parse");
    assert_eq!(pduration_args.0, "A1");
    assert_eq!(pduration_args.1, "B1");
    assert_eq!(pduration_args.2, "C1");
    let fvschedule_args =
      parse_fvschedule_formula("=FVSCHEDULE(A1,B1:B3)").expect("fvschedule should parse");
    assert_eq!(fvschedule_args.0, "A1");
    assert_eq!(fvschedule_args.1, "B1:B3");
    let ispmt_args = parse_ispmt_formula("=ISPMT(A1,B1,C1,D1)").expect("ispmt should parse");
    assert_eq!(ispmt_args.0, "A1");
    assert_eq!(ispmt_args.1, "B1");
    assert_eq!(ispmt_args.2, "C1");
    assert_eq!(ispmt_args.3, "D1");
    let cumipmt_args =
      parse_cumipmt_formula("=CUMIPMT(A1,B1,C1,D1,E1,F1)").expect("cumipmt should parse");
    assert_eq!(cumipmt_args.0, "A1");
    assert_eq!(cumipmt_args.1, "B1");
    assert_eq!(cumipmt_args.2, "C1");
    assert_eq!(cumipmt_args.3, "D1");
    assert_eq!(cumipmt_args.4, "E1");
    assert_eq!(cumipmt_args.5, "F1");
    let cumprinc_args =
      parse_cumprinc_formula("=CUMPRINC(A1,B1,C1,D1,E1,F1)").expect("cumprinc should parse");
    assert_eq!(cumprinc_args.0, "A1");
    assert_eq!(cumprinc_args.1, "B1");
    assert_eq!(cumprinc_args.2, "C1");
    assert_eq!(cumprinc_args.3, "D1");
    assert_eq!(cumprinc_args.4, "E1");
    assert_eq!(cumprinc_args.5, "F1");
    assert_eq!(parse_fact_formula("=FACT(A1)").as_deref(), Some("A1"));
    assert_eq!(
      parse_factdouble_formula("=FACTDOUBLE(A1)").as_deref(),
      Some("A1"),
    );
    let combin_args =
      parse_combin_formula("=COMBIN(A1,B1)").expect("combin should parse");
    assert_eq!(combin_args.0, "A1");
    assert_eq!(combin_args.1, "B1");
    let combina_args =
      parse_combina_formula("=COMBINA(A1,B1)").expect("combina should parse");
    assert_eq!(combina_args.0, "A1");
    assert_eq!(combina_args.1, "B1");
    let permut_args =
      parse_permut_formula("=PERMUT(A1,B1)").expect("permut should parse");
    assert_eq!(permut_args.0, "A1");
    assert_eq!(permut_args.1, "B1");
    let permutationa_args = parse_permutationa_formula("=PERMUTATIONA(A1,B1)")
      .expect("permutationa should parse");
    assert_eq!(permutationa_args.0, "A1");
    assert_eq!(permutationa_args.1, "B1");
    let multinomial_args = parse_multinomial_formula("=MULTINOMIAL(A1,B1,C1)")
      .expect("multinomial should parse");
    assert_eq!(multinomial_args, vec!["A1", "B1", "C1"]);
    let gcd_args = parse_gcd_formula("=GCD(A1,B1,C1)").expect("gcd should parse");
    assert_eq!(gcd_args, vec!["A1", "B1", "C1"]);
    let lcm_args = parse_lcm_formula("=LCM(A1,B1,C1)").expect("lcm should parse");
    assert_eq!(lcm_args, vec!["A1", "B1", "C1"]);
    assert_eq!(parse_sin_formula("=SIN(A1)").as_deref(), Some("A1"));
    assert_eq!(parse_cos_formula("=COS(A1)").as_deref(), Some("A1"));
    assert_eq!(parse_tan_formula("=TAN(A1)").as_deref(), Some("A1"));
    assert_eq!(parse_cot_formula("=COT(A1)").as_deref(), Some("A1"));
    assert_eq!(parse_sec_formula("=SEC(A1)").as_deref(), Some("A1"));
    assert_eq!(parse_csc_formula("=CSC(A1)").as_deref(), Some("A1"));
    assert_eq!(parse_sinh_formula("=SINH(A1)").as_deref(), Some("A1"));
    assert_eq!(parse_cosh_formula("=COSH(A1)").as_deref(), Some("A1"));
    assert_eq!(parse_tanh_formula("=TANH(A1)").as_deref(), Some("A1"));
    assert_eq!(parse_coth_formula("=COTH(A1)").as_deref(), Some("A1"));
    assert_eq!(parse_sech_formula("=SECH(A1)").as_deref(), Some("A1"));
    assert_eq!(parse_csch_formula("=CSCH(A1)").as_deref(), Some("A1"));
    assert_eq!(parse_asinh_formula("=ASINH(A1)").as_deref(), Some("A1"));
    assert_eq!(parse_acosh_formula("=ACOSH(A1)").as_deref(), Some("A1"));
    assert_eq!(parse_atanh_formula("=ATANH(A1)").as_deref(), Some("A1"));
    assert_eq!(parse_acot_formula("=ACOT(A1)").as_deref(), Some("A1"));
    assert_eq!(parse_asec_formula("=ASEC(A1)").as_deref(), Some("A1"));
    assert_eq!(parse_acsc_formula("=ACSC(A1)").as_deref(), Some("A1"));
    assert_eq!(parse_acoth_formula("=ACOTH(A1)").as_deref(), Some("A1"));
    assert_eq!(parse_asech_formula("=ASECH(A1)").as_deref(), Some("A1"));
    assert_eq!(parse_acsch_formula("=ACSCH(A1)").as_deref(), Some("A1"));
    assert_eq!(parse_asin_formula("=ASIN(A1)").as_deref(), Some("A1"));
    assert_eq!(parse_acos_formula("=ACOS(A1)").as_deref(), Some("A1"));
    assert_eq!(parse_atan_formula("=ATAN(A1)").as_deref(), Some("A1"));
    let atan2 = parse_atan2_formula("=ATAN2(A1,B1)").expect("atan2 should parse");
    assert_eq!(atan2.0, "A1");
    assert_eq!(atan2.1, "B1");
    assert_eq!(parse_degrees_formula("=DEGREES(A1)").as_deref(), Some("A1"));
    assert_eq!(parse_radians_formula("=RADIANS(A1)").as_deref(), Some("A1"));
    let round = parse_round_formula("=ROUND(12.345, 2)").expect("round should parse");
    assert_eq!(round.0, "12.345");
    assert_eq!(round.1, "2");
    let roundup =
      parse_roundup_formula("=ROUNDUP(12.301, 1)").expect("roundup should parse");
    assert_eq!(roundup.0, "12.301");
    assert_eq!(roundup.1, "1");
    let rounddown = parse_rounddown_formula("=ROUNDDOWN(-12.399, 1)")
      .expect("rounddown should parse");
    assert_eq!(rounddown.0, "-12.399");
    assert_eq!(rounddown.1, "1");
    let ceiling =
      parse_ceiling_formula("=CEILING(12.31, 0.25)").expect("ceiling should parse");
    assert_eq!(ceiling.0, "12.31");
    assert_eq!(ceiling.1, "0.25");
    let ceiling_math = parse_ceiling_math_formula("=CEILING.MATH(-12.31,0.25,1)")
      .expect("ceiling math should parse");
    assert_eq!(ceiling_math.0, "-12.31");
    assert_eq!(ceiling_math.1.as_deref(), Some("0.25"));
    assert_eq!(ceiling_math.2.as_deref(), Some("1"));
    let floor = parse_floor_formula("=FLOOR(-12.31, 0.25)")
      .expect("floor should parse");
    assert_eq!(floor.0, "-12.31");
    assert_eq!(floor.1, "0.25");
    let floor_math =
      parse_floor_math_formula("=FLOOR.MATH(12.31)").expect("floor math should parse");
    assert_eq!(floor_math.0, "12.31");
    assert_eq!(floor_math.1, None);
    assert_eq!(floor_math.2, None);
    assert_eq!(
      parse_sqrt_formula("=SQRT(81)").as_deref(),
      Some("81"),
    );
    let power = parse_power_formula("=POWER(3, 4)").expect("power should parse");
    assert_eq!(power.0, "3");
    assert_eq!(power.1, "4");
    let mod_formula = parse_mod_formula("=MOD(10, 3)").expect("mod should parse");
    assert_eq!(mod_formula.0, "10");
    assert_eq!(mod_formula.1, "3");
    let quotient = parse_quotient_formula("=QUOTIENT(9, 4)")
      .expect("quotient should parse");
    assert_eq!(quotient.0, "9");
    assert_eq!(quotient.1, "4");
    let mround =
      parse_mround_formula("=MROUND(10.5, 2)").expect("mround should parse");
    assert_eq!(mround.0, "10.5");
    assert_eq!(mround.1, "2");
    assert_eq!(
      parse_sign_formula("=SIGN(-12.5)").as_deref(),
      Some("-12.5"),
    );
    assert_eq!(
      parse_int_formula("=INT(-12.5)").as_deref(),
      Some("-12.5"),
    );
    assert_eq!(parse_even_formula("=EVEN(A1)").as_deref(), Some("A1"));
    assert_eq!(parse_odd_formula("=ODD(A1)").as_deref(), Some("A1"));
    let trunc = parse_trunc_formula("=TRUNC(12.345,2)").expect("trunc should parse");
    assert_eq!(trunc.0, "12.345");
    assert_eq!(trunc.1.as_deref(), Some("2"));
    let exact = parse_exact_formula(r#"=EXACT("North","north")"#)
      .expect("exact should parse");
    assert_eq!(exact.0, r#""North""#);
    assert_eq!(exact.1, r#""north""#);
    assert_eq!(
      parse_isblank_formula("=ISBLANK(A1)").as_deref(),
      Some("A1"),
    );
    assert_eq!(
      parse_isnumber_formula("=ISNUMBER(A1)").as_deref(),
      Some("A1"),
    );
    assert_eq!(
      parse_istext_formula("=ISTEXT(A1)").as_deref(),
      Some("A1"),
    );
    assert_eq!(
      parse_iseven_formula("=ISEVEN(A1)").as_deref(),
      Some("A1"),
    );
    assert_eq!(
      parse_isodd_formula("=ISODD(A1)").as_deref(),
      Some("A1"),
    );

    let left_args =
      parse_left_formula(r#"=LEFT("spreadsheet", 6)"#).expect("left should parse");
    assert_eq!(left_args.0, r#""spreadsheet""#);
    assert_eq!(left_args.1.as_deref(), Some("6"));

    let right_args =
      parse_right_formula(r#"=RIGHT("spreadsheet", 5)"#).expect("right should parse");
    assert_eq!(right_args.0, r#""spreadsheet""#);
    assert_eq!(right_args.1.as_deref(), Some("5"));

    let mid_args =
      parse_mid_formula(r#"=MID("spreadsheet", 2, 4)"#).expect("mid should parse");
    assert_eq!(mid_args.0, r#""spreadsheet""#);
    assert_eq!(mid_args.1, "2");
    assert_eq!(mid_args.2, "4");

    let rept_args =
      parse_rept_formula(r#"=REPT("na", 4)"#).expect("rept should parse");
    assert_eq!(rept_args.0, r#""na""#);
    assert_eq!(rept_args.1, "4");

    let replace_args = parse_replace_formula(r#"=REPLACE("spreadsheet",1,6,"work")"#)
      .expect("replace should parse");
    assert_eq!(replace_args.0, r#""spreadsheet""#);
    assert_eq!(replace_args.1, "1");
    assert_eq!(replace_args.2, "6");
    assert_eq!(replace_args.3, r#""work""#);

    let substitute_args = parse_substitute_formula(
      r#"=SUBSTITUTE("north-north","north","south",2)"#,
    )
    .expect("substitute should parse");
    assert_eq!(substitute_args.0, r#""north-north""#);
    assert_eq!(substitute_args.1, r#""north""#);
    assert_eq!(substitute_args.2, r#""south""#);
    assert_eq!(substitute_args.3.as_deref(), Some("2"));
    assert_eq!(
      parse_value_formula(r#"=VALUE("12.34")"#).as_deref(),
      Some(r#""12.34""#),
    );
    assert_eq!(parse_n_formula("=N(A1)").as_deref(), Some("A1"));
    assert_eq!(parse_t_formula("=T(A1)").as_deref(), Some("A1"));
    assert_eq!(parse_char_formula("=CHAR(65)").as_deref(), Some("65"));
    assert_eq!(
      parse_code_formula(r#"=CODE("Apple")"#).as_deref(),
      Some(r#""Apple""#),
    );
    assert_eq!(
      parse_unichar_formula("=UNICHAR(9731)").as_deref(),
      Some("9731"),
    );
    assert_eq!(
      parse_unicode_formula(r#"=UNICODE("⚡")"#).as_deref(),
      Some(r#""⚡""#),
    );
    let roman_args = parse_roman_formula("=ROMAN(1999,0)").expect("roman should parse");
    assert_eq!(roman_args.0, "1999");
    assert_eq!(roman_args.1.as_deref(), Some("0"));
    assert_eq!(
      parse_arabic_formula(r#"=ARABIC("MCMXCIX")"#).as_deref(),
      Some(r#""MCMXCIX""#),
    );

    let search_args = parse_search_formula(r#"=SEARCH("sheet","spreadsheet",2)"#)
      .expect("search should parse");
    assert_eq!(search_args.0, r#""sheet""#);
    assert_eq!(search_args.1, r#""spreadsheet""#);
    assert_eq!(search_args.2.as_deref(), Some("2"));

    let find_args = parse_find_formula(r#"=FIND("sheet","spreadsheet",2)"#)
      .expect("find should parse");
    assert_eq!(find_args.0, r#""sheet""#);
    assert_eq!(find_args.1, r#""spreadsheet""#);
    assert_eq!(find_args.2.as_deref(), Some("2"));

    let date_parts = parse_date_formula("=DATE(2026,2,13)").expect("date should parse");
    assert_eq!(date_parts, ("2026".to_string(), "2".to_string(), "13".to_string()));
    let edate_args = parse_edate_formula("=EDATE(A1,2)").expect("edate should parse");
    assert_eq!(edate_args, ("A1".to_string(), "2".to_string()));
    let eomonth_args =
      parse_eomonth_formula("=EOMONTH(A1,-1)").expect("eomonth should parse");
    assert_eq!(eomonth_args, ("A1".to_string(), "-1".to_string()));
    let days_args = parse_days_formula("=DAYS(B1,A1)").expect("days should parse");
    assert_eq!(days_args, ("B1".to_string(), "A1".to_string()));
    let days360_args =
      parse_days360_formula("=DAYS360(A1,B1,TRUE)").expect("days360 should parse");
    assert_eq!(days360_args.0, "A1");
    assert_eq!(days360_args.1, "B1");
    assert_eq!(days360_args.2.as_deref(), Some("TRUE"));
    let yearfrac_args =
      parse_yearfrac_formula("=YEARFRAC(A1,B1,1)").expect("yearfrac should parse");
    assert_eq!(yearfrac_args.0, "A1");
    assert_eq!(yearfrac_args.1, "B1");
    assert_eq!(yearfrac_args.2.as_deref(), Some("1"));
    assert_eq!(
      parse_datevalue_formula(r#"=DATEVALUE("2024-02-29")"#).as_deref(),
      Some(r#""2024-02-29""#),
    );
    assert_eq!(
      parse_timevalue_formula(r#"=TIMEVALUE("13:45:30")"#).as_deref(),
      Some(r#""13:45:30""#),
    );
    let time_args = parse_time_formula("=TIME(13,45,30)").expect("time should parse");
    assert_eq!(time_args, ("13".to_string(), "45".to_string(), "30".to_string()));
    let datedif_args = parse_datedif_formula(r#"=DATEDIF(A1,B1,"D")"#)
      .expect("datedif should parse");
    assert_eq!(
      datedif_args,
      ("A1".to_string(), "B1".to_string(), r#""D""#.to_string()),
    );
    let networkdays_args = parse_networkdays_formula("=NETWORKDAYS(A1,B1,C1:C4)")
      .expect("networkdays should parse");
    assert_eq!(networkdays_args.0, "A1");
    assert_eq!(networkdays_args.1, "B1");
    assert_eq!(networkdays_args.2.as_deref(), Some("C1:C4"));
    let workday_args = parse_workday_formula("=WORKDAY(A1,5,C1:C4)")
      .expect("workday should parse");
    assert_eq!(workday_args.0, "A1");
    assert_eq!(workday_args.1, "5");
    assert_eq!(workday_args.2.as_deref(), Some("C1:C4"));
    let networkdays_intl_args = parse_networkdays_intl_formula(
      r#"=NETWORKDAYS.INTL(A1,B1,11,C1:C4)"#,
    )
    .expect("networkdays intl should parse");
    assert_eq!(networkdays_intl_args.0, "A1");
    assert_eq!(networkdays_intl_args.1, "B1");
    assert_eq!(networkdays_intl_args.2.as_deref(), Some("11"));
    assert_eq!(networkdays_intl_args.3.as_deref(), Some("C1:C4"));
    let workday_intl_args =
      parse_workday_intl_formula(r#"=WORKDAY.INTL(A1,5,"0000011",C1:C4)"#)
        .expect("workday intl should parse");
    assert_eq!(workday_intl_args.0, "A1");
    assert_eq!(workday_intl_args.1, "5");
    assert_eq!(workday_intl_args.2.as_deref(), Some(r#""0000011""#));
    assert_eq!(workday_intl_args.3.as_deref(), Some("C1:C4"));

    assert_eq!(
      parse_year_formula("=YEAR(A1)").as_deref(),
      Some("A1"),
    );
    assert_eq!(
      parse_month_formula("=MONTH(A1)").as_deref(),
      Some("A1"),
    );
    assert_eq!(parse_day_formula("=DAY(A1)").as_deref(), Some("A1"));
    let weekday =
      parse_weekday_formula("=WEEKDAY(A1,2)").expect("weekday should parse");
    assert_eq!(weekday.0, "A1");
    assert_eq!(weekday.1.as_deref(), Some("2"));
    let weeknum =
      parse_weeknum_formula("=WEEKNUM(A1,2)").expect("weeknum should parse");
    assert_eq!(weeknum.0, "A1");
    assert_eq!(weeknum.1.as_deref(), Some("2"));
    assert_eq!(
      parse_isoweeknum_formula("=ISOWEEKNUM(A1)").as_deref(),
      Some("A1"),
    );
    assert_eq!(parse_hour_formula("=HOUR(A1)").as_deref(), Some("A1"));
    assert_eq!(parse_minute_formula("=MINUTE(A1)").as_deref(), Some("A1"));
    assert_eq!(parse_second_formula("=SECOND(A1)").as_deref(), Some("A1"));

    let countif = parse_countif_formula(r#"=COUNTIF(A1:A5,">=10")"#)
      .expect("countif should parse");
    assert_eq!(countif.0, (1, 1));
    assert_eq!(countif.1, (5, 1));
    assert_eq!(countif.2, r#"">=10""#);

    let counta =
      parse_counta_formula("=COUNTA(A1:A5)").expect("counta should parse");
    assert_eq!(counta.0, (1, 1));
    assert_eq!(counta.1, (5, 1));

    let countblank = parse_countblank_formula("=COUNTBLANK(A1:A5)")
      .expect("countblank should parse");
    assert_eq!(countblank.0, (1, 1));
    assert_eq!(countblank.1, (5, 1));
    assert_eq!(parse_row_formula("=ROW(B7)").as_deref(), Some("B7"));
    assert_eq!(
      parse_column_formula("=COLUMN(AB3)").as_deref(),
      Some("AB3"),
    );
    assert_eq!(parse_rows_formula("=ROWS(A1:C3)").as_deref(), Some("A1:C3"));
    assert_eq!(
      parse_columns_formula("=COLUMNS(A1:C3)").as_deref(),
      Some("A1:C3"),
    );
    let large = parse_large_formula("=LARGE(A1:A5,2)").expect("large should parse");
    assert_eq!(large.0, (1, 1));
    assert_eq!(large.1, (5, 1));
    assert_eq!(large.2, "2");
    let small = parse_small_formula("=SMALL(A1:A5,2)").expect("small should parse");
    assert_eq!(small.0, (1, 1));
    assert_eq!(small.1, (5, 1));
    assert_eq!(small.2, "2");
    let rank =
      parse_rank_formula("=RANK(A1,A1:A5,0)").expect("rank should parse");
    assert_eq!(rank.0, "A1");
    assert_eq!(rank.1, (1, 1));
    assert_eq!(rank.2, (5, 1));
    assert_eq!(rank.3.as_deref(), Some("0"));
    let percentile = parse_percentile_inc_formula("=PERCENTILE.INC(A1:A5,0.25)")
      .expect("percentile should parse");
    assert_eq!(percentile.0, (1, 1));
    assert_eq!(percentile.1, (5, 1));
    assert_eq!(percentile.2, "0.25");
    let percentile_legacy = parse_percentile_inc_formula("=PERCENTILE(A1:A5,0.25)")
      .expect("legacy percentile should parse");
    assert_eq!(percentile_legacy.0, (1, 1));
    assert_eq!(percentile_legacy.1, (5, 1));
    assert_eq!(percentile_legacy.2, "0.25");
    let quartile = parse_quartile_inc_formula("=QUARTILE.INC(A1:A5,3)")
      .expect("quartile should parse");
    assert_eq!(quartile.0, (1, 1));
    assert_eq!(quartile.1, (5, 1));
    assert_eq!(quartile.2, "3");
    let quartile_legacy = parse_quartile_inc_formula("=QUARTILE(A1:A5,3)")
      .expect("legacy quartile should parse");
    assert_eq!(quartile_legacy.0, (1, 1));
    assert_eq!(quartile_legacy.1, (5, 1));
    assert_eq!(quartile_legacy.2, "3");
    let percentile_exc =
      parse_percentile_exc_formula("=PERCENTILE.EXC(A1:A5,0.6)")
        .expect("percentile.exc should parse");
    assert_eq!(percentile_exc.0, (1, 1));
    assert_eq!(percentile_exc.1, (5, 1));
    assert_eq!(percentile_exc.2, "0.6");
    let quartile_exc = parse_quartile_exc_formula("=QUARTILE.EXC(A1:A5,2)")
      .expect("quartile.exc should parse");
    assert_eq!(quartile_exc.0, (1, 1));
    assert_eq!(quartile_exc.1, (5, 1));
    assert_eq!(quartile_exc.2, "2");
    let mode =
      parse_mode_sngl_formula("=MODE.SNGL(A1:A5)").expect("mode should parse");
    assert_eq!(mode.0, (1, 1));
    assert_eq!(mode.1, (5, 1));
    let geomean =
      parse_geomean_formula("=GEOMEAN(A1:A5)").expect("geomean should parse");
    assert_eq!(geomean.0, (1, 1));
    assert_eq!(geomean.1, (5, 1));
    let harmean =
      parse_harmean_formula("=HARMEAN(A1:A5)").expect("harmean should parse");
    assert_eq!(harmean.0, (1, 1));
    assert_eq!(harmean.1, (5, 1));
    let trimmean = parse_trimmean_formula("=TRIMMEAN(A1:A5,0.4)")
      .expect("trimmean should parse");
    assert_eq!(trimmean.0, (1, 1));
    assert_eq!(trimmean.1, (5, 1));
    assert_eq!(trimmean.2, "0.4");
    let devsq =
      parse_devsq_formula("=DEVSQ(A1:A5)").expect("devsq should parse");
    assert_eq!(devsq.0, (1, 1));
    assert_eq!(devsq.1, (5, 1));
    let avedev =
      parse_avedev_formula("=AVEDEV(A1:A5)").expect("avedev should parse");
    assert_eq!(avedev.0, (1, 1));
    assert_eq!(avedev.1, (5, 1));
    let averagea =
      parse_averagea_formula("=AVERAGEA(A1:A5)").expect("averagea should parse");
    assert_eq!(averagea.0, (1, 1));
    assert_eq!(averagea.1, (5, 1));
    let stdeva =
      parse_stdeva_formula("=STDEVA(A1:A5)").expect("stdeva should parse");
    assert_eq!(stdeva.0, (1, 1));
    assert_eq!(stdeva.1, (5, 1));
    let stdevpa =
      parse_stdevpa_formula("=STDEVPA(A1:A5)").expect("stdevpa should parse");
    assert_eq!(stdevpa.0, (1, 1));
    assert_eq!(stdevpa.1, (5, 1));
    let vara = parse_vara_formula("=VARA(A1:A5)").expect("vara should parse");
    assert_eq!(vara.0, (1, 1));
    assert_eq!(vara.1, (5, 1));
    let varpa = parse_varpa_formula("=VARPA(A1:A5)").expect("varpa should parse");
    assert_eq!(varpa.0, (1, 1));
    assert_eq!(varpa.1, (5, 1));
    let covariance = parse_covariance_formula("=COVARIANCE.P(A1:A5,B1:B5)")
      .expect("covariance should parse");
    assert_eq!(covariance.0, "COVARIANCE.P");
    assert_eq!(covariance.1, (1, 1));
    assert_eq!(covariance.2, (5, 1));
    assert_eq!(covariance.3, (1, 2));
    assert_eq!(covariance.4, (5, 2));
    let covariance_legacy = parse_covariance_formula("=COVAR(A1:A5,B1:B5)")
      .expect("legacy covariance should parse");
    assert_eq!(covariance_legacy.0, "COVAR");
    assert_eq!(covariance_legacy.1, (1, 1));
    assert_eq!(covariance_legacy.2, (5, 1));
    assert_eq!(covariance_legacy.3, (1, 2));
    assert_eq!(covariance_legacy.4, (5, 2));
    let correl = parse_correl_formula("=CORREL(A1:A5,B1:B5)")
      .expect("correl should parse");
    assert_eq!(correl.0, (1, 1));
    assert_eq!(correl.1, (5, 1));
    assert_eq!(correl.2, (1, 2));
    assert_eq!(correl.3, (5, 2));
    let pearson = parse_correl_formula("=PEARSON(A1:A5,B1:B5)")
      .expect("pearson should parse");
    assert_eq!(pearson.0, (1, 1));
    assert_eq!(pearson.1, (5, 1));
    assert_eq!(pearson.2, (1, 2));
    assert_eq!(pearson.3, (5, 2));
    let slope = parse_slope_formula("=SLOPE(B1:B5,A1:A5)").expect("slope should parse");
    assert_eq!(slope.0, (1, 2));
    assert_eq!(slope.1, (5, 2));
    assert_eq!(slope.2, (1, 1));
    assert_eq!(slope.3, (5, 1));
    let intercept = parse_intercept_formula("=INTERCEPT(B1:B5,A1:A5)")
      .expect("intercept should parse");
    assert_eq!(intercept.0, (1, 2));
    assert_eq!(intercept.1, (5, 2));
    assert_eq!(intercept.2, (1, 1));
    assert_eq!(intercept.3, (5, 1));
    let rsq = parse_rsq_formula("=RSQ(B1:B5,A1:A5)").expect("rsq should parse");
    assert_eq!(rsq.0, (1, 2));
    assert_eq!(rsq.1, (5, 2));
    assert_eq!(rsq.2, (1, 1));
    assert_eq!(rsq.3, (5, 1));
    let forecast_linear =
      parse_forecast_linear_formula("=FORECAST.LINEAR(4,B1:B5,A1:A5)")
        .expect("forecast linear should parse");
    assert_eq!(forecast_linear.0, "FORECAST.LINEAR");
    assert_eq!(forecast_linear.1, "4");
    assert_eq!(forecast_linear.2, (1, 2));
    assert_eq!(forecast_linear.3, (5, 2));
    assert_eq!(forecast_linear.4, (1, 1));
    assert_eq!(forecast_linear.5, (5, 1));
    let forecast_legacy =
      parse_forecast_linear_formula("=FORECAST(4,B1:B5,A1:A5)")
        .expect("legacy forecast should parse");
    assert_eq!(forecast_legacy.0, "FORECAST");
    assert_eq!(forecast_legacy.1, "4");
    assert_eq!(forecast_legacy.2, (1, 2));
    assert_eq!(forecast_legacy.3, (5, 2));
    assert_eq!(forecast_legacy.4, (1, 1));
    assert_eq!(forecast_legacy.5, (5, 1));
    let steyx = parse_steyx_formula("=STEYX(B1:B5,A1:A5)")
      .expect("steyx should parse");
    assert_eq!(steyx.0, (1, 2));
    assert_eq!(steyx.1, (5, 2));
    assert_eq!(steyx.2, (1, 1));
    assert_eq!(steyx.3, (5, 1));
    let sumx = parse_sumx_formula("=SUMXMY2(A1:A5,B1:B5)")
      .expect("sumxmy2 should parse");
    assert_eq!(sumx.0, "SUMXMY2");
    assert_eq!(sumx.1, (1, 1));
    assert_eq!(sumx.2, (5, 1));
    assert_eq!(sumx.3, (1, 2));
    assert_eq!(sumx.4, (5, 2));
    let skew = parse_skew_formula("=SKEW(A1:A5)").expect("skew should parse");
    assert_eq!(skew.0, (1, 1));
    assert_eq!(skew.1, (5, 1));
    let skew_p = parse_skew_p_formula("=SKEW.P(A1:A5)").expect("skew.p should parse");
    assert_eq!(skew_p.0, (1, 1));
    assert_eq!(skew_p.1, (5, 1));
    let kurt = parse_kurt_formula("=KURT(A1:A5)").expect("kurt should parse");
    assert_eq!(kurt.0, (1, 1));
    assert_eq!(kurt.1, (5, 1));
    assert_eq!(
      parse_fisher_formula("=FISHER(0.75)").as_deref(),
      Some("0.75"),
    );
    assert_eq!(
      parse_fisherinv_formula("=FISHERINV(0.5)").as_deref(),
      Some("0.5"),
    );
    let percentrank_inc =
      parse_percentrank_inc_formula("=PERCENTRANK.INC(A1:A5,3,4)")
        .expect("percentrank inc should parse");
    assert_eq!(percentrank_inc.0, (1, 1));
    assert_eq!(percentrank_inc.1, (5, 1));
    assert_eq!(percentrank_inc.2, "3");
    assert_eq!(percentrank_inc.3.as_deref(), Some("4"));
    let percentrank_legacy =
      parse_percentrank_inc_formula("=PERCENTRANK(A1:A5,3)")
        .expect("legacy percentrank should parse");
    assert_eq!(percentrank_legacy.0, (1, 1));
    assert_eq!(percentrank_legacy.1, (5, 1));
    assert_eq!(percentrank_legacy.2, "3");
    assert_eq!(percentrank_legacy.3.as_deref(), None);
    let percentrank_exc =
      parse_percentrank_exc_formula("=PERCENTRANK.EXC(A1:A5,3)")
        .expect("percentrank exc should parse");
    assert_eq!(percentrank_exc.0, (1, 1));
    assert_eq!(percentrank_exc.1, (5, 1));
    assert_eq!(percentrank_exc.2, "3");
    assert_eq!(percentrank_exc.3.as_deref(), None);

    let sumproduct =
      parse_sumproduct_formula("=SUMPRODUCT(A1:A5,B1:B5)")
        .expect("sumproduct should parse");
    assert_eq!(sumproduct.len(), 2);
    assert_eq!(sumproduct[0], ((1, 1), (5, 1)));
    assert_eq!(sumproduct[1], ((1, 2), (5, 2)));

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

    let minifs = parse_minifs_formula(
      r#"=MINIFS(B1:B5,A1:A5,">=10",C1:C5,"east")"#,
    )
    .expect("minifs should parse");
    assert_eq!(minifs.value_range_start, Some((1, 2)));
    assert_eq!(minifs.value_range_end, Some((5, 2)));
    assert_eq!(minifs.conditions.len(), 2);

    let maxifs = parse_maxifs_formula(
      r#"=MAXIFS(B1:B5,A1:A5,">=10",C1:C5,"east")"#,
    )
    .expect("maxifs should parse");
    assert_eq!(maxifs.value_range_start, Some((1, 2)));
    assert_eq!(maxifs.value_range_end, Some((5, 2)));
    assert_eq!(maxifs.conditions.len(), 2);
  }
}
