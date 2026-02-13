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
