use std::{error::Error, path::PathBuf};

#[path = "../fixture_corpus.rs"]
mod fixture_corpus;

fn main() -> Result<(), Box<dyn Error>> {
  let args = std::env::args().skip(1).collect::<Vec<_>>();
  let fixtures_dir = resolve_output_dir(&args)?;
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

fn resolve_output_dir(args: &[String]) -> Result<PathBuf, Box<dyn Error>> {
  match args {
    [] => Ok(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("fixtures")),
    [flag, dir] if flag == "--output-dir" => Ok(PathBuf::from(dir)),
    [flag] if flag == "--output-dir" => {
      Err("--output-dir requires a following directory path".into())
    }
    [unknown, ..] => Err(
      format!(
        "Unknown argument '{unknown}'. Supported args: --output-dir <path>"
      )
      .into(),
    ),
  }
}

#[cfg(test)]
mod tests {
  use super::fixture_corpus;
  use super::resolve_output_dir;
  use std::path::PathBuf;

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

  #[test]
  fn should_resolve_default_output_dir_when_no_args_provided() {
    let resolved = resolve_output_dir(&[])
      .expect("default output dir should resolve");
    assert_eq!(
      resolved,
      PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("fixtures"),
    );
  }

  #[test]
  fn should_resolve_explicit_output_dir_argument() {
    let resolved = resolve_output_dir(&[
      "--output-dir".to_string(),
      "/tmp/custom-fixtures".to_string(),
    ])
    .expect("explicit output dir should resolve");
    assert_eq!(resolved, PathBuf::from("/tmp/custom-fixtures"));
  }

  #[test]
  fn should_reject_output_dir_argument_without_value() {
    let error = resolve_output_dir(&["--output-dir".to_string()])
      .expect_err("missing output dir value should fail");
    assert!(
      error
        .to_string()
        .contains("--output-dir requires a following directory path"),
      "error should describe missing output dir path",
    );
  }

  #[test]
  fn should_reject_unknown_generator_argument() {
    let error = resolve_output_dir(&["--unexpected".to_string()])
      .expect_err("unknown arg should fail");
    assert!(
      error
        .to_string()
        .contains("Supported args: --output-dir <path>"),
      "error should describe supported args",
    );
  }
}
