use rust_xlsxwriter::{DocProperties, ExcelDateTime, Formula, Workbook, XlsxError};
use std::{fs, path::Path};

pub const COMPAT_BASELINE_FILE_NAME: &str = "compat_baseline.xlsx";
pub const COMPAT_NORMALIZATION_SINGLE_FILE_NAME: &str =
  "compat_normalization_single.xlsx";
pub const COMPAT_NORMALIZATION_FILE_NAME: &str = "compat_normalization.xlsx";
pub const COMPAT_OFFSET_RANGE_FILE_NAME: &str = "compat_offset_range.xlsx";
pub const COMPAT_UNSUPPORTED_FORMULA_FILE_NAME: &str =
  "compat_unsupported_formula.xlsx";
pub const COMPAT_MIXED_LITERAL_PREFIX_FILE_NAME: &str =
  "compat_mixed_literal_prefix.xlsx";
pub const COMPAT_PREFIX_OPERATOR_FILE_NAME: &str =
  "compat_prefix_operator.xlsx";
pub const COMPAT_FORMULA_MATRIX_FILE_NAME: &str = "compat_formula_matrix.xlsx";
pub const COMPAT_DEFAULT_CACHED_FORMULA_FILE_NAME: &str =
  "compat_default_cached_formula.xlsx";

pub fn generate_fixture_corpus(
) -> Result<Vec<(&'static str, Vec<u8>)>, XlsxError> {
  Ok(vec![
    (
      COMPAT_BASELINE_FILE_NAME,
      build_compat_baseline_fixture_bytes()?,
    ),
    (
      COMPAT_NORMALIZATION_SINGLE_FILE_NAME,
      build_compat_normalization_single_fixture_bytes()?,
    ),
    (
      COMPAT_NORMALIZATION_FILE_NAME,
      build_compat_normalization_fixture_bytes()?,
    ),
    (
      COMPAT_OFFSET_RANGE_FILE_NAME,
      build_compat_offset_range_fixture_bytes()?,
    ),
    (
      COMPAT_UNSUPPORTED_FORMULA_FILE_NAME,
      build_compat_unsupported_formula_fixture_bytes()?,
    ),
    (
      COMPAT_MIXED_LITERAL_PREFIX_FILE_NAME,
      build_compat_mixed_literal_prefix_fixture_bytes()?,
    ),
    (
      COMPAT_PREFIX_OPERATOR_FILE_NAME,
      build_compat_prefix_operator_fixture_bytes()?,
    ),
    (
      COMPAT_FORMULA_MATRIX_FILE_NAME,
      build_compat_formula_matrix_fixture_bytes()?,
    ),
    (
      COMPAT_DEFAULT_CACHED_FORMULA_FILE_NAME,
      build_compat_default_cached_formula_fixture_bytes()?,
    ),
  ])
}

pub fn write_fixture_corpus(
  fixtures_dir: &Path,
) -> Result<Vec<&'static str>, Box<dyn std::error::Error>> {
  fs::create_dir_all(fixtures_dir)?;
  let generated = generate_fixture_corpus()?;
  let mut written_files = Vec::with_capacity(generated.len());
  for (file_name, bytes) in generated {
    fs::write(fixtures_dir.join(file_name), bytes)?;
    written_files.push(file_name);
  }
  Ok(written_files)
}

fn build_compat_baseline_fixture_bytes() -> Result<Vec<u8>, XlsxError> {
  let mut workbook = Workbook::new();
  apply_deterministic_fixture_properties(&mut workbook)?;
  let inputs_sheet = workbook.add_worksheet();
  inputs_sheet.set_name("Inputs")?;
  inputs_sheet.write_string(0, 0, "Region")?;
  inputs_sheet.write_string(1, 0, "North")?;
  inputs_sheet.write_string(2, 0, "South")?;
  inputs_sheet.write_string(0, 1, "Sales")?;
  inputs_sheet.write_number(1, 1, 120.0)?;
  inputs_sheet.write_number(2, 1, 80.0)?;
  inputs_sheet.write_string(0, 2, "Total")?;
  inputs_sheet.write_formula(1, 2, Formula::new("=SUM(B2:B3)").set_result("200"))?;
  inputs_sheet.write_string(0, 3, "Active")?;
  inputs_sheet.write_boolean(1, 3, true)?;

  let notes_sheet = workbook.add_worksheet();
  notes_sheet.set_name("Notes")?;
  notes_sheet.write_string(0, 0, "Generated from fixture workbook")?;

  workbook.save_to_buffer()
}

fn build_compat_normalization_single_fixture_bytes() -> Result<Vec<u8>, XlsxError> {
  let mut workbook = Workbook::new();
  apply_deterministic_fixture_properties(&mut workbook)?;
  let sheet = workbook.add_worksheet();
  sheet.set_name("Inputs")?;
  sheet.write_string(0, 0, "Region")?;
  sheet.write_string(1, 0, "North")?;
  sheet.write_string(2, 0, "South")?;
  sheet.write_string(0, 1, "Sales")?;
  sheet.write_number(1, 1, 120.0)?;
  sheet.write_number(2, 1, 80.0)?;
  sheet.write_formula(1, 2, Formula::new("=+@_xlfn.SUM(B2:B3)").set_result("200"))?;

  workbook.save_to_buffer()
}

fn build_compat_normalization_fixture_bytes() -> Result<Vec<u8>, XlsxError> {
  let mut workbook = Workbook::new();
  apply_deterministic_fixture_properties(&mut workbook)?;
  let sheet = workbook.add_worksheet();
  sheet.set_name("Comprehensive")?;
  sheet.write_number(0, 0, 3.0)?;
  sheet.write_number(1, 0, 4.0)?;
  sheet.write_formula(0, 1, Formula::new("= +@_xlfn.SUM(A1:A2)").set_result("7"))?;
  sheet.write_formula(1, 1, Formula::new("=_xlpm.MIN(A1:A2)").set_result("3"))?;
  sheet.write_formula(
    2,
    1,
    Formula::new(r#"=+@IF(A1=3,"_xlfn.literal ""@_xlws.keep""","nope")"#)
      .set_result(r#"_xlfn.literal "@_xlws.keep""#),
  )?;

  workbook.save_to_buffer()
}

fn build_compat_offset_range_fixture_bytes() -> Result<Vec<u8>, XlsxError> {
  let mut workbook = Workbook::new();
  apply_deterministic_fixture_properties(&mut workbook)?;
  let offset_sheet = workbook.add_worksheet();
  offset_sheet.set_name("Offset")?;
  offset_sheet.write_number(3, 2, 10.0)?;
  offset_sheet.write_number(4, 2, 20.0)?;
  offset_sheet.write_formula(5, 3, Formula::new("=@SUM(C4:C5)").set_result("30"))?;

  workbook.save_to_buffer()
}

fn build_compat_unsupported_formula_fixture_bytes() -> Result<Vec<u8>, XlsxError> {
  let mut workbook = Workbook::new();
  apply_deterministic_fixture_properties(&mut workbook)?;
  let modern_sheet = workbook.add_worksheet();
  modern_sheet.set_name("Modern")?;
  modern_sheet.write_number(0, 0, 5.0)?;
  modern_sheet.write_formula(
    0,
    1,
    Formula::new("=_xlfn.LET(_xlpm.x,A1,_xlpm.x+1)").set_result("6"),
  )?;

  workbook.save_to_buffer()
}

fn build_compat_mixed_literal_prefix_fixture_bytes() -> Result<Vec<u8>, XlsxError> {
  let mut workbook = Workbook::new();
  apply_deterministic_fixture_properties(&mut workbook)?;
  let mixed_sheet = workbook.add_worksheet();
  mixed_sheet.set_name("Mixed")?;
  mixed_sheet.write_number(0, 0, 1.0)?;
  mixed_sheet.write_formula(
    0,
    1,
    Formula::new(r#"=IF(A1=1,"_xlfn.keep me",@_XLFN.BITAND(6,3))"#)
      .set_result("_xlfn.keep me"),
  )?;

  workbook.save_to_buffer()
}

fn build_compat_prefix_operator_fixture_bytes() -> Result<Vec<u8>, XlsxError> {
  let mut workbook = Workbook::new();
  apply_deterministic_fixture_properties(&mut workbook)?;
  let normalized_sheet = workbook.add_worksheet();
  normalized_sheet.set_name("Normalized")?;
  normalized_sheet.write_number(0, 0, 2.0)?;
  normalized_sheet.write_number(1, 0, 3.0)?;
  normalized_sheet.write_formula(
    0,
    1,
    Formula::new("=+@_xlws.SUM(A1:A2)").set_result("5"),
  )?;

  workbook.save_to_buffer()
}

fn build_compat_formula_matrix_fixture_bytes() -> Result<Vec<u8>, XlsxError> {
  let mut workbook = Workbook::new();
  apply_deterministic_fixture_properties(&mut workbook)?;
  let calc_sheet = workbook.add_worksheet();
  calc_sheet.set_name("Calc")?;
  calc_sheet.write_formula(0, 1, Formula::new("=BITAND(6,3)").set_result("2"))?;
  calc_sheet.write_formula(1, 1, Formula::new("=DEC2HEX(255,4)").set_result("00FF"))?;
  calc_sheet.write_formula(2, 1, Formula::new("=DOLLARDE(1.02,16)").set_result("1.125"))?;
  calc_sheet.write_formula(3, 1, Formula::new("=DELTA(5,5)").set_result("1"))?;
  calc_sheet.write_boolean(4, 0, true)?;
  calc_sheet.write_string(5, 0, "text")?;
  calc_sheet.write_number(6, 0, -2.0)?;
  calc_sheet.write_formula(4, 1, Formula::new("=MINA(A5:A7)").set_result("-2"))?;
  calc_sheet.write_formula(5, 1, Formula::new("=MAXA(A5:A7)").set_result("1"))?;

  workbook.save_to_buffer()
}

fn build_compat_default_cached_formula_fixture_bytes() -> Result<Vec<u8>, XlsxError> {
  let mut workbook = Workbook::new();
  apply_deterministic_fixture_properties(&mut workbook)?;
  let sheet = workbook.add_worksheet();
  sheet.set_name("NoCache")?;
  sheet.write_number(0, 0, 4.0)?;
  sheet.write_number(1, 0, 6.0)?;
  sheet.write_formula(0, 1, Formula::new("=SUM(A1:A2)"))?;

  workbook.save_to_buffer()
}

fn apply_deterministic_fixture_properties(
  workbook: &mut Workbook,
) -> Result<(), XlsxError> {
  let creation_time = ExcelDateTime::from_ymd(2024, 1, 1)?;
  let properties = DocProperties::new()
    .set_creation_datetime(&creation_time)
    .set_author("spreadsheet-core-rs fixture generator")
    .set_comment("Deterministic fixture workbook");
  workbook.set_properties(&properties);
  Ok(())
}
