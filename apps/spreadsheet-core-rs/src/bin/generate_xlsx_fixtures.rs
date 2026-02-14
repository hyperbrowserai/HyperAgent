use std::{error::Error, fs, path::PathBuf};

use rust_xlsxwriter::{DocProperties, ExcelDateTime, Formula, Workbook};

fn main() -> Result<(), Box<dyn Error>> {
  let fixtures_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("fixtures");
  fs::create_dir_all(&fixtures_dir)?;

  write_compat_baseline_fixture(&fixtures_dir)?;
  write_compat_normalization_single_fixture(&fixtures_dir)?;
  write_compat_normalization_fixture(&fixtures_dir)?;

  println!(
    "generated_xlsx_fixtures: {{\"dir\":\"{}\",\"files\":[\"compat_baseline.xlsx\",\"compat_normalization_single.xlsx\",\"compat_normalization.xlsx\"]}}",
    fixtures_dir.display(),
  );
  Ok(())
}

fn write_compat_baseline_fixture(fixtures_dir: &PathBuf) -> Result<(), Box<dyn Error>> {
  let mut workbook = Workbook::new();
  let properties = deterministic_fixture_properties()?;
  workbook.set_properties(&properties);
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

  workbook.save(fixtures_dir.join("compat_baseline.xlsx"))?;
  Ok(())
}

fn write_compat_normalization_fixture(
  fixtures_dir: &PathBuf,
) -> Result<(), Box<dyn Error>> {
  let mut workbook = Workbook::new();
  let properties = deterministic_fixture_properties()?;
  workbook.set_properties(&properties);
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

  workbook.save(fixtures_dir.join("compat_normalization.xlsx"))?;
  Ok(())
}

fn write_compat_normalization_single_fixture(
  fixtures_dir: &PathBuf,
) -> Result<(), Box<dyn Error>> {
  let mut workbook = Workbook::new();
  let properties = deterministic_fixture_properties()?;
  workbook.set_properties(&properties);
  let sheet = workbook.add_worksheet();
  sheet.set_name("Inputs")?;
  sheet.write_string(0, 0, "Region")?;
  sheet.write_string(1, 0, "North")?;
  sheet.write_string(2, 0, "South")?;
  sheet.write_string(0, 1, "Sales")?;
  sheet.write_number(1, 1, 120.0)?;
  sheet.write_number(2, 1, 80.0)?;
  sheet.write_formula(1, 2, Formula::new("=+@_xlfn.SUM(B2:B3)").set_result("200"))?;

  workbook.save(fixtures_dir.join("compat_normalization_single.xlsx"))?;
  Ok(())
}

fn deterministic_fixture_properties() -> Result<DocProperties, Box<dyn Error>> {
  let creation_time = ExcelDateTime::from_ymd(2024, 1, 1)?;
  Ok(
    DocProperties::new()
      .set_creation_datetime(&creation_time)
      .set_author("spreadsheet-core-rs fixture generator")
      .set_comment("Deterministic fixture workbook"),
  )
}

#[cfg(test)]
mod tests {
  use super::{
    write_compat_baseline_fixture, write_compat_normalization_fixture,
    write_compat_normalization_single_fixture,
  };
  use std::{collections::HashMap, fs, path::PathBuf};
  use tempfile::tempdir;

  fn fixture_file_map(fixtures_dir: &PathBuf) -> HashMap<String, Vec<u8>> {
    let fixture_names = [
      "compat_baseline.xlsx",
      "compat_normalization_single.xlsx",
      "compat_normalization.xlsx",
    ];

    fixture_names
      .iter()
      .map(|file_name| {
        let bytes = fs::read(fixtures_dir.join(file_name))
          .unwrap_or_else(|error| panic!("failed to read fixture {file_name}: {error}"));
        ((*file_name).to_string(), bytes)
      })
      .collect::<HashMap<_, _>>()
  }

  #[test]
  fn should_generate_fixture_workbooks_deterministically() {
    let first_dir = tempdir().expect("first fixture dir should create");
    let second_dir = tempdir().expect("second fixture dir should create");
    let first_fixtures_path = first_dir.path().to_path_buf();
    let second_fixtures_path = second_dir.path().to_path_buf();

    write_compat_baseline_fixture(&first_fixtures_path)
      .expect("first baseline fixture should generate");
    write_compat_normalization_single_fixture(&first_fixtures_path)
      .expect("first single-normalization fixture should generate");
    write_compat_normalization_fixture(&first_fixtures_path)
      .expect("first comprehensive fixture should generate");

    write_compat_baseline_fixture(&second_fixtures_path)
      .expect("second baseline fixture should generate");
    write_compat_normalization_single_fixture(&second_fixtures_path)
      .expect("second single-normalization fixture should generate");
    write_compat_normalization_fixture(&second_fixtures_path)
      .expect("second comprehensive fixture should generate");

    assert_eq!(
      fixture_file_map(&first_fixtures_path),
      fixture_file_map(&second_fixtures_path),
      "fixture binary output should be deterministic across repeated generation runs",
    );
  }
}
