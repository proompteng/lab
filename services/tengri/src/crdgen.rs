#[path = "crd.rs"]
#[allow(dead_code)]
mod crd;

use anyhow::Context;
use crd::MicroVM;
use k8s_openapi::apiextensions_apiserver::pkg::apis::apiextensions::v1::CustomResourceDefinition;
use kube::CustomResourceExt;
use serde_json::{Value, json};

fn main() -> anyhow::Result<()> {
    let yaml = serde_saphyr::to_string(&production_crd()?).context("serialize MicroVM CRD")?;
    print!("{yaml}");

    Ok(())
}

fn production_crd() -> anyhow::Result<CustomResourceDefinition> {
    let mut crd = serde_json::to_value(MicroVM::crd()).context("convert generated CRD to JSON")?;
    insert(
        &mut crd,
        "/metadata",
        "annotations",
        json!({
            "argocd.argoproj.io/sync-wave": "-5",
            "argocd.argoproj.io/sync-options": "Prune=false,Delete=false"
        }),
    )?;
    insert(
        &mut crd,
        "/spec/versions/0",
        "additionalPrinterColumns",
        json!([
            {"name": "Phase", "type": "string", "jsonPath": ".status.phase"},
            {"name": "Node", "type": "string", "jsonPath": ".status.nodeName"},
            {"name": "Guest Ready", "type": "boolean", "jsonPath": ".status.guestReady"}
        ]),
    )?;
    insert(
        &mut crd,
        "/spec/versions/0/schema/openAPIV3Schema",
        "x-kubernetes-validations",
        json!([
            {"rule": "self.spec.reservationId == oldSelf.spec.reservationId", "message": "reservation identity is immutable"},
            {"rule": "self.spec.architecture == oldSelf.spec.architecture", "message": "the server-selected architecture is immutable"},
            {
                "rule": "self.spec.resources.workspaceGib >= oldSelf.spec.resources.workspaceGib",
                "message": "workspace size cannot shrink"
            },
            {
                "rule": "self.spec.createdAt == oldSelf.spec.createdAt",
                "message": "creation time is immutable"
            }
        ]),
    )?;

    for pointer in [
        "/spec/versions/0/schema/openAPIV3Schema/properties/spec/properties/createdAt",
        "/spec/versions/0/schema/openAPIV3Schema/properties/spec/properties/idleDeadline",
        "/spec/versions/0/schema/openAPIV3Schema/properties/status/properties/readyAt",
        "/spec/versions/0/schema/openAPIV3Schema/properties/status/properties/lastActivityAt",
        "/spec/versions/0/schema/openAPIV3Schema/properties/status/properties/podSandboxTransitionAt",
        "/spec/versions/0/schema/openAPIV3Schema/properties/status/properties/conditions/items/properties/lastTransitionAt",
    ] {
        insert(&mut crd, pointer, "format", json!("date-time"))?;
    }
    insert(
        &mut crd,
        "/spec/versions/0/schema/openAPIV3Schema/properties/spec/properties/displayName",
        "minLength",
        json!(1),
    )?;
    insert(
        &mut crd,
        "/spec/versions/0/schema/openAPIV3Schema/properties/spec/properties/displayName",
        "maxLength",
        json!(64),
    )?;
    insert(
        &mut crd,
        "/spec/versions/0/schema/openAPIV3Schema/properties/spec/properties/image",
        "pattern",
        json!(r"^[^@[:space:]]+@sha256:[a-f0-9]{64}$"),
    )?;
    insert(
        &mut crd,
        "/spec/versions/0/schema/openAPIV3Schema/properties/spec/properties/ownerHash",
        "pattern",
        json!(r"^[a-f0-9]{64}$"),
    )?;

    let slot = "/spec/versions/0/schema/openAPIV3Schema/properties/spec/properties/slot/properties";
    for field in ["name", "podUid", "pvcName", "pvcUid"] {
        insert(&mut crd, &format!("{slot}/{field}"), "minLength", json!(1))?;
        insert(&mut crd, &format!("{slot}/{field}"), "maxLength", json!(63))?;
        insert(
            &mut crd,
            &format!("{slot}/{field}"),
            "pattern",
            json!(r"^[a-z0-9]([-a-z0-9]*[a-z0-9])?$"),
        )?;
    }
    insert(&mut crd, &format!("{slot}/epoch"), "minimum", json!(1))?;
    insert(
        &mut crd,
        &format!("{slot}/epoch"),
        "maximum",
        json!(i32::MAX),
    )?;

    let resources = "/spec/versions/0/schema/openAPIV3Schema/properties/spec/properties/resources";
    insert(
        &mut crd,
        "/spec/versions/0/schema/openAPIV3Schema/properties/spec/properties/power/properties/idleTimeoutMinutes",
        "maximum",
        json!(1440),
    )?;
    for (field, allowed) in [
        ("cpuMillis", json!([crd::CPU_MILLIS])),
        ("memoryMib", json!([crd::MEMORY_MIB])),
        ("workspaceGib", json!([crd::WORKSPACE_GIB])),
    ] {
        insert(
            &mut crd,
            &format!("{resources}/properties/{field}"),
            "enum",
            allowed,
        )?;
    }
    serde_json::from_value(crd).context("deserialize production CRD")
}

fn insert(crd: &mut Value, pointer: &str, key: &str, value: Value) -> anyhow::Result<()> {
    let object = crd
        .pointer_mut(pointer)
        .and_then(Value::as_object_mut)
        .with_context(|| format!("generated CRD is missing object at {pointer}"))?;
    object.insert(key.to_owned(), value);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn production_schema_is_fixed_controller_owned_and_observable() {
        let crd = serde_json::to_value(production_crd().expect("generate production CRD"))
            .expect("serialize production CRD");
        assert_eq!(
            crd.pointer(
                "/spec/versions/0/schema/openAPIV3Schema/properties/spec/properties/resources/properties/cpuMillis/enum"
            ),
            Some(&json!([4_000]))
        );
        assert_eq!(
            crd.pointer(
                "/spec/versions/0/schema/openAPIV3Schema/properties/spec/properties/resources/properties/memoryMib/enum"
            ),
            Some(&json!([8_192]))
        );
        assert_eq!(
            crd.pointer(
                "/spec/versions/0/schema/openAPIV3Schema/properties/spec/properties/resources/properties/workspaceGib/enum"
            ),
            Some(&json!([32]))
        );
        assert_eq!(
            crd.pointer("/spec/versions/0/schema/openAPIV3Schema/x-kubernetes-validations/2/rule"),
            Some(&json!(
                "self.spec.resources.workspaceGib >= oldSelf.spec.resources.workspaceGib"
            ))
        );
        assert_eq!(
            crd.pointer(
                "/spec/versions/0/schema/openAPIV3Schema/properties/spec/properties/resources/additionalProperties"
            ),
            None,
            "Kubernetes forbids combining typed properties with additionalProperties"
        );
        assert_eq!(
            crd.pointer("/metadata/annotations/argocd.argoproj.io~1sync-wave"),
            Some(&json!("-5"))
        );
        assert_eq!(
            crd.pointer("/metadata/annotations/argocd.argoproj.io~1sync-options"),
            Some(&json!("Prune=false,Delete=false"))
        );
        assert_eq!(
            crd.pointer("/spec/versions/0/additionalPrinterColumns/2/jsonPath"),
            Some(&json!(".status.guestReady"))
        );
        assert_eq!(
            crd.pointer("/spec/versions/0/additionalPrinterColumns/3"),
            None,
            "retained agents do not expose a destructive expiry column"
        );
        assert_eq!(
            crd.pointer(
                "/spec/versions/0/schema/openAPIV3Schema/properties/spec/properties/expiresAt"
            ),
            None,
            "the single snapshot runtime has no legacy expiry field"
        );
        assert!(
            !crd.pointer("/spec/versions/0/schema/openAPIV3Schema/properties/spec/required")
                .and_then(Value::as_array)
                .is_some_and(|required| required.iter().any(|field| field == "expiresAt"))
        );
        let validations = crd
            .pointer("/spec/versions/0/schema/openAPIV3Schema/x-kubernetes-validations")
            .and_then(Value::as_array)
            .expect("production validations");
        assert!(
            validations.iter().all(|validation| {
                validation.get("rule").and_then(Value::as_str)
                    != Some("self.spec.image == oldSelf.spec.image")
            }),
            "the controller must be able to adopt a configured digest at a safe boundary"
        );
        assert!(
            validations.iter().all(|validation| {
                validation.get("rule").and_then(Value::as_str)
                    != Some("self.spec.ownerHash == oldSelf.spec.ownerHash")
            }),
            "the controller projects ownership transfers from current Ofz authority"
        );
        assert!(validations.iter().any(|validation| {
            validation.get("rule").and_then(Value::as_str)
                == Some("self.spec.reservationId == oldSelf.spec.reservationId")
        }));
        assert_eq!(
            crd.pointer(
                "/spec/versions/0/schema/openAPIV3Schema/properties/spec/properties/displayName/maxLength"
            ),
            Some(&json!(64))
        );
    }
}
