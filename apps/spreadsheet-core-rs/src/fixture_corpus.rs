use rust_xlsxwriter::{DocProperties, ExcelDateTime, Formula, Workbook, XlsxError};
use std::{fs, path::Path};

pub const COMPAT_BASELINE_FILE_NAME: &str = "compat_baseline.xlsx";
pub const COMPAT_NORMALIZATION_SINGLE_FILE_NAME: &str =
  "compat_normalization_single.xlsx";
pub const COMPAT_NORMALIZATION_FILE_NAME: &str = "compat_normalization.xlsx";

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

  let notes_sheet = workbook.add_worksheet();
  notes_sheet.set_name("Notes")?;
  notes_sheet.write_string(0, 0, "Generated fixture workbook")?;

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
