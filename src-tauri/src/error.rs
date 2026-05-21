use serde::Serialize;
use serde_json::Value;

/// 结构化错误，发送给前端用于 i18n 渲染。
/// code 形如 "request.failed" / "upstream.unauthorized"；前端按 code 查 i18n key。
#[derive(Debug, Clone, Serialize)]
pub struct AppError {
    pub code: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub params: Option<Value>,
    /// 仅用于 dev/log 的英文 detail（前端不展示，DevTools 可见）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

impl AppError {
    pub fn new(code: impl Into<String>) -> Self {
        Self { code: code.into(), params: None, detail: None }
    }

    pub fn with_params(mut self, params: Value) -> Self {
        self.params = Some(params);
        self
    }

    pub fn with_detail(mut self, detail: impl Into<String>) -> Self {
        self.detail = Some(detail.into());
        self
    }
}

impl From<reqwest::Error> for AppError {
    fn from(e: reqwest::Error) -> Self {
        AppError::new("network.requestFailed").with_detail(e.to_string())
    }
}

impl From<serde_json::Error> for AppError {
    fn from(e: serde_json::Error) -> Self {
        AppError::new("parse.jsonFailed").with_detail(e.to_string())
    }
}
