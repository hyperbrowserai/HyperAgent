use std::{error::Error, fs, path::PathBuf};

use rust_xlsxwriter::{Formula, Workbook};

fn main() -> Result<(), Box<dyn Error>> {
  let fixtures_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("fixtures");
  fs::create_dir_all(&fixtures_dir)?;

  write_compat_baseline_fixture(&fixtures_dir)?;
  write_compat_normalization_fixture(&fixtures_dir)?;

  println!(
    "generated_xlsx_fixtures: {{\"dir\":\"{}\",\"files\":[\"compat_baseline.xlsx\",\"compat_normalization.xlsx\"]}}",
    fixtures_dir.display(),
  );
  Ok(())
}

fn write_compat_baseline_fixture(fixtures_dir: &PathBuf) -> Result<(), Box<dyn Error>> {
  let mut workbook = Workbook::new();
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
