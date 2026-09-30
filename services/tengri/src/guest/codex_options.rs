use serde_json::{Value, json};

pub const DEFAULT_CODEX_MODEL: &str = "gpt-6.1-sol";

#[derive(Debug)]
pub struct CodexOptions {
    pub model: String,
    pub reasoning_effort: Option<String>,
}

impl Default for CodexOptions {
    fn default() -> Self {
        Self {
            model: DEFAULT_CODEX_MODEL.to_owned(),
            reasoning_effort: None,
        }
    }
}

impl CodexOptions {
    pub fn parse(model: String, reasoning_effort: String) -> Result<Self, &'static str> {
        let model = if model.is_empty() {
            DEFAULT_CODEX_MODEL.to_owned()
        } else {
            model
        };
        if model.len() > 160
            || !model.bytes().all(|byte| {
                byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':' | b'/')
            })
        {
            return Err("invalid Codex model");
        }
        let reasoning_effort = match reasoning_effort.as_str() {
            "" => None,
            "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra" => {
                Some(reasoning_effort)
            }
            _ => return Err("invalid Codex reasoning effort"),
        };
        Ok(Self {
            model,
            reasoning_effort,
        })
    }

    pub fn thread_config(&self) -> Option<Value> {
        self.reasoning_effort
            .as_ref()
            .map(|effort| json!({"model_reasoning_effort": effort}))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_to_sol_without_overriding_the_owners_reasoning() {
        let options = CodexOptions::parse(String::new(), String::new()).unwrap();
        assert_eq!(options.model, "gpt-6.1-sol");
        assert_eq!(options.thread_config(), None);
    }

    #[test]
    fn rejects_invalid_model_and_effort_values() {
        for model in ["gpt-6.1-sol\n", "gpt 6.1 sol", &"m".repeat(161)] {
            assert!(CodexOptions::parse(model.into(), "high".into()).is_err());
        }
        assert!(CodexOptions::parse("gpt-6.1-sol".into(), "unknown".into()).is_err());
    }
}
