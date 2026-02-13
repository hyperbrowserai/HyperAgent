use axum::{
  http::StatusCode,
  response::{IntoResponse, Response},
  Json,
};
use serde_json::json;

#[derive(Debug)]
pub enum ApiError {
  NotFound(String),
  BadRequest(String),
  BadRequestWithCode {
    code: String,
    message: String,
  },
  Internal(String),
}

impl ApiError {
  pub fn internal<E: std::fmt::Display>(err: E) -> Self {
    Self::Internal(err.to_string())
  }

  pub fn bad_request_with_code(
    code: impl Into<String>,
    message: impl Into<String>,
  ) -> Self {
    Self::BadRequestWithCode {
      code: code.into(),
      message: message.into(),
    }
  }
}

impl IntoResponse for ApiError {
  fn into_response(self) -> Response {
    let (status, code, message) = match self {
      ApiError::NotFound(message) => (
        StatusCode::NOT_FOUND,
        "NOT_FOUND".to_string(),
        message,
      ),
      ApiError::BadRequest(message) => (
        StatusCode::BAD_REQUEST,
        "BAD_REQUEST".to_string(),
        message,
      ),
      ApiError::BadRequestWithCode { code, message } => {
        (StatusCode::BAD_REQUEST, code, message)
      }
      ApiError::Internal(message) => (
        StatusCode::INTERNAL_SERVER_ERROR,
        "INTERNAL_ERROR".to_string(),
        message,
      ),
    };

    let body = Json(json!({
      "error": {
        "code": code,
        "message": message
      }
    }));

    (status, body).into_response()
  }
}

#[cfg(test)]
mod tests {
  use super::ApiError;
  use axum::{body::to_bytes, http::StatusCode, response::IntoResponse};
  use serde_json::Value;

  #[tokio::test]
  async fn should_encode_custom_bad_request_error_codes() {
    let response = ApiError::bad_request_with_code(
      "INVALID_SIGNATURE_FORMAT",
      "bad signature",
    )
    .into_response();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);

    let bytes = to_bytes(response.into_body(), usize::MAX)
      .await
      .expect("body should be readable");
    let payload: Value = serde_json::from_slice(&bytes)
      .expect("payload should be valid json");
    assert_eq!(
      payload["error"]["code"].as_str(),
      Some("INVALID_SIGNATURE_FORMAT"),
    );
    assert_eq!(payload["error"]["message"].as_str(), Some("bad signature"));
  }

  #[tokio::test]
  async fn should_fall_back_to_default_bad_request_code() {
    let response =
      ApiError::BadRequest("bad request".to_string()).into_response();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);

    let bytes = to_bytes(response.into_body(), usize::MAX)
      .await
      .expect("body should be readable");
    let payload: Value = serde_json::from_slice(&bytes)
      .expect("payload should be valid json");
    assert_eq!(payload["error"]["code"].as_str(), Some("BAD_REQUEST"));
  }
}
