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
  Internal(String),
}

impl ApiError {
  pub fn internal<E: std::fmt::Display>(err: E) -> Self {
    Self::Internal(err.to_string())
  }
}

impl IntoResponse for ApiError {
  fn into_response(self) -> Response {
    let (status, code, message) = match self {
      ApiError::NotFound(message) => (StatusCode::NOT_FOUND, "NOT_FOUND", message),
      ApiError::BadRequest(message) => (StatusCode::BAD_REQUEST, "BAD_REQUEST", message),
      ApiError::Internal(message) => (
        StatusCode::INTERNAL_SERVER_ERROR,
        "INTERNAL_ERROR",
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
