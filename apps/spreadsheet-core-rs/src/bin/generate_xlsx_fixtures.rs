use std::{error::Error, path::PathBuf};

#[path = "../fixture_corpus.rs"]
mod fixture_corpus;

fn main() -> Result<(), Box<dyn Error>> {
  let fixtures_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("fixtures");
  let written_files = fixture_corpus::write_fixture_corpus(&fixtures_dir)?;

  println!(
    "generated_xlsx_fixtures: {{\"dir\":\"{}\",\"files\":[{}]}}",
    fixtures_dir.display(),
    written_files
      .iter()
      .map(|file_name| format!("\"{file_name}\""))
      .collect::<Vec<_>>()
      .join(","),
  );
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::fixture_corpus;

  #[test]
  fn should_generate_fixture_workbooks_deterministically() {
    let first = fixture_corpus::generate_fixture_corpus()
      .expect("first fixture generation should succeed");
    let second = fixture_corpus::generate_fixture_corpus()
      .expect("second fixture generation should succeed");

    assert_eq!(
      first, second,
      "fixture binary output should be deterministic across repeated generation runs",
    );
  }
}
