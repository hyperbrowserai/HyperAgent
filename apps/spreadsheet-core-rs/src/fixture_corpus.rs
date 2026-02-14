use rust_xlsxwriter::{DocProperties, ExcelDateTime, Formula, Workbook, XlsxError};
use std::{
  fs,
  io::{Cursor, Read, Write},
  path::Path,
};
use zip::{read::ZipArchive, write::SimpleFileOptions, ZipWriter};

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
pub const COMPAT_ERROR_CACHED_FORMULA_FILE_NAME: &str =
  "compat_error_cached_formula.xlsx";
pub const COMPAT_FORMULA_ONLY_NORMALIZED_FILE_NAME: &str =
  "compat_formula_only_normalized.xlsx";
pub const COMPAT_FORMULA_ONLY_SHEET_FILE_NAME: &str =
  "compat_formula_only_sheet.xlsx";
pub const COMPAT_FORMULA_ONLY_OFFSET_NORMALIZED_FILE_NAME: &str =
  "compat_formula_only_offset_normalized.xlsx";
pub const FIXTURE_CORPUS_FILE_NAMES: [&str; 13] = [
  COMPAT_BASELINE_FILE_NAME,
  COMPAT_NORMALIZATION_SINGLE_FILE_NAME,
  COMPAT_NORMALIZATION_FILE_NAME,
  COMPAT_OFFSET_RANGE_FILE_NAME,
  COMPAT_UNSUPPORTED_FORMULA_FILE_NAME,
  COMPAT_MIXED_LITERAL_PREFIX_FILE_NAME,
  COMPAT_PREFIX_OPERATOR_FILE_NAME,
  COMPAT_FORMULA_MATRIX_FILE_NAME,
  COMPAT_DEFAULT_CACHED_FORMULA_FILE_NAME,
  COMPAT_ERROR_CACHED_FORMULA_FILE_NAME,
  COMPAT_FORMULA_ONLY_NORMALIZED_FILE_NAME,
  COMPAT_FORMULA_ONLY_SHEET_FILE_NAME,
  COMPAT_FORMULA_ONLY_OFFSET_NORMALIZED_FILE_NAME,
];

pub fn fixture_corpus_file_names() -> &'static [&'static str; 13] {
  &FIXTURE_CORPUS_FILE_NAMES
}

pub fn generate_fixture_corpus(
) -> Result<Vec<(&'static str, Vec<u8>)>, Box<dyn std::error::Error>> {
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
    (
      COMPAT_ERROR_CACHED_FORMULA_FILE_NAME,
      build_compat_error_cached_formula_fixture_bytes()?,
    ),
    (
      COMPAT_FORMULA_ONLY_NORMALIZED_FILE_NAME,
      build_compat_formula_only_normalized_fixture_bytes()?,
    ),
    (
      COMPAT_FORMULA_ONLY_SHEET_FILE_NAME,
      build_compat_formula_only_sheet_fixture_bytes()?,
    ),
    (
      COMPAT_FORMULA_ONLY_OFFSET_NORMALIZED_FILE_NAME,
      build_compat_formula_only_offset_normalized_fixture_bytes()?,
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

fn build_compat_error_cached_formula_fixture_bytes(
) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
  let mut workbook = Workbook::new();
  apply_deterministic_fixture_properties(&mut workbook)?;
  let sheet = workbook.add_worksheet();
  sheet.set_name("ErrorCache")?;
  sheet.write_number(0, 0, 5.0)?;
  sheet.write_number(1, 0, 0.0)?;
  sheet.write_formula(0, 1, Formula::new("=A1/A2"))?;

  let bytes = workbook.save_to_buffer()?;
  strip_formula_cached_value_from_cell(
    &bytes,
    "xl/worksheets/sheet1.xml",
    "B1",
  )
}

fn build_compat_formula_only_normalized_fixture_bytes(
) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
  let mut workbook = Workbook::new();
  apply_deterministic_fixture_properties(&mut workbook)?;
  let sheet = workbook.add_worksheet();
  sheet.set_name("FormulaOnlyNorm")?;
  sheet.write_number(0, 0, 2.0)?;
  sheet.write_number(1, 0, 3.0)?;
  sheet.write_formula(0, 1, Formula::new("=+@_xlfn.SUM(A1:A2)"))?;

  let bytes = workbook.save_to_buffer()?;
  strip_formula_cached_value_from_cell(
    &bytes,
    "xl/worksheets/sheet1.xml",
    "B1",
  )
}

fn build_compat_formula_only_sheet_fixture_bytes(
) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
  let mut workbook = Workbook::new();
  apply_deterministic_fixture_properties(&mut workbook)?;
  let sheet = workbook.add_worksheet();
  sheet.set_name("OnlyFormula")?;
  sheet.write_formula(1, 1, Formula::new("=1+1"))?;

  let bytes = workbook.save_to_buffer()?;
  strip_formula_cached_value_from_cell(
    &bytes,
    "xl/worksheets/sheet1.xml",
    "B2",
  )
}

fn build_compat_formula_only_offset_normalized_fixture_bytes(
) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
  let mut workbook = Workbook::new();
  apply_deterministic_fixture_properties(&mut workbook)?;
  let sheet = workbook.add_worksheet();
  sheet.set_name("FormulaOnlyOffset")?;
  sheet.write_formula(6, 3, Formula::new("=+@_xlfn.DELTA(1,1)"))?;

  let bytes = workbook.save_to_buffer()?;
  strip_formula_cached_value_from_cell(
    &bytes,
    "xl/worksheets/sheet1.xml",
    "D7",
  )
}

fn strip_formula_cached_value_from_cell(
  workbook_bytes: &[u8],
  worksheet_path: &str,
  cell_reference: &str,
) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
  let mut archive = ZipArchive::new(Cursor::new(workbook_bytes))?;
  let mut zip_writer = ZipWriter::new(Cursor::new(Vec::<u8>::new()));
  let mut did_strip_cached_value = false;

  for index in 0..archive.len() {
    let mut entry = archive.by_index(index)?;
    let entry_name = entry.name().to_string();
    let entry_options: SimpleFileOptions = entry.options();

    if entry.is_dir() {
      zip_writer.add_directory(entry_name, entry_options)?;
      continue;
    }

    let mut entry_bytes = Vec::new();
    entry.read_to_end(&mut entry_bytes)?;
    zip_writer.start_file(entry_name.clone(), entry_options)?;

    if entry_name == worksheet_path {
      let worksheet_xml = String::from_utf8(entry_bytes)?;
      let search_pattern = format!(
        r#"<c r="{cell_reference}"><f>([^<]*)</f><v>[^<]*</v></c>"#
      );
      let replacement_pattern =
        format!(r#"<c r="{cell_reference}"><f>$1</f></c>"#);
      let formula_cache_regex = regex::Regex::new(search_pattern.as_str())?;
      let rewritten_xml = formula_cache_regex
        .replace(worksheet_xml.as_str(), replacement_pattern.as_str())
        .to_string();
      did_strip_cached_value = rewritten_xml != worksheet_xml;
      zip_writer.write_all(rewritten_xml.as_bytes())?;
      continue;
    }

    zip_writer.write_all(entry_bytes.as_slice())?;
  }

  if !did_strip_cached_value {
    return Err(format!(
      "expected to strip cached formula value from {worksheet_path} at {cell_reference}",
    )
    .into());
  }

  let cursor = zip_writer.finish()?;
  Ok(cursor.into_inner())
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
