use serde_json::{Value, json};

#[derive(Debug, Default)]
pub struct CodexOptions {
    pub model: Option<String>,
    pub reasoning_effort: Option<String>,
}

impl CodexOptions {
    pub fn parse(model: String, reasoning_effort: String) -> Result<Self, &'static str> {
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
            model: if model.is_empty() { None } else { Some(model) },
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
    fn explicit_model_does_not_override_the_owners_reasoning() {
        let options = CodexOptions::parse("gpt-6.1-sol".into(), String::new()).unwrap();
        assert_eq!(options.model.as_deref(), Some("gpt-6.1-sol"));
        assert_eq!(options.thread_config(), None);
    }

    #[test]
    fn omitted_options_preserve_existing_guest_and_thread_settings() {
        let options = CodexOptions::parse(String::new(), String::new()).unwrap();
        assert_eq!(json!(options.model), Value::Null);
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
