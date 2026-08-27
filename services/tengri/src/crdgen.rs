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
        json!({"argocd.argoproj.io/sync-wave": "-5"}),
    )?;
    insert(
        &mut crd,
        "/spec/versions/0",
        "additionalPrinterColumns",
        json!([
            {"name": "Phase", "type": "string", "jsonPath": ".status.phase"},
            {"name": "Node", "type": "string", "jsonPath": ".status.nodeName"},
            {"name": "Guest Ready", "type": "boolean", "jsonPath": ".status.guestReady"},
            {"name": "Expires", "type": "date", "jsonPath": ".spec.expiresAt"}
        ]),
    )?;
    insert(
        &mut crd,
        "/spec/versions/0/schema/openAPIV3Schema",
        "x-kubernetes-validations",
        json!([
            {"rule": "self.spec.ownerHash == oldSelf.spec.ownerHash", "message": "ownerHash is immutable"},
            {"rule": "self.spec.image == oldSelf.spec.image", "message": "the digest-pinned guest image is immutable"},
            {"rule": "self.spec.architecture == oldSelf.spec.architecture", "message": "the server-selected architecture is immutable"},
            {"rule": "self.spec.resources == oldSelf.spec.resources", "message": "the v1 resource profile is immutable"},
            {
                "rule": "self.spec.createdAt == oldSelf.spec.createdAt && self.spec.expiresAt == oldSelf.spec.expiresAt",
                "message": "creation and hard-expiry timestamps are immutable"
            }
        ]),
    )?;

    for pointer in [
        "/spec/versions/0/schema/openAPIV3Schema/properties/spec/properties/createdAt",
        "/spec/versions/0/schema/openAPIV3Schema/properties/spec/properties/idleDeadline",
        "/spec/versions/0/schema/openAPIV3Schema/properties/spec/properties/expiresAt",
        "/spec/versions/0/schema/openAPIV3Schema/properties/status/properties/readyAt",
        "/spec/versions/0/schema/openAPIV3Schema/properties/status/properties/lastActivityAt",
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

    let resources = "/spec/versions/0/schema/openAPIV3Schema/properties/spec/properties/resources";
    insert(&mut crd, resources, "additionalProperties", json!(false))?;
    for (field, fixed) in [
        ("cpuMillis", crd::CPU_MILLIS),
        ("memoryMib", crd::MEMORY_MIB),
        ("workspaceGib", crd::WORKSPACE_GIB),
    ] {
        insert(
            &mut crd,
            &format!("{resources}/properties/{field}"),
            "enum",
            json!([fixed]),
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
    fn production_schema_is_fixed_immutable_and_observable() {
        let crd = serde_json::to_value(production_crd().expect("generate production CRD"))
            .expect("serialize production CRD");
        assert_eq!(
            crd.pointer(
                "/spec/versions/0/schema/openAPIV3Schema/properties/spec/properties/resources/properties/cpuMillis/enum/0"
            ),
            Some(&json!(2_000))
        );
        assert_eq!(
            crd.pointer("/metadata/annotations/argocd.argoproj.io~1sync-wave"),
            Some(&json!("-5"))
        );
        assert_eq!(
            crd.pointer("/spec/versions/0/additionalPrinterColumns/2/jsonPath"),
            Some(&json!(".status.guestReady"))
        );
        assert_eq!(
            crd.pointer(
                "/spec/versions/0/schema/openAPIV3Schema/x-kubernetes-validations/1/message"
            ),
            Some(&json!("the digest-pinned guest image is immutable"))
        );
        assert_eq!(
            crd.pointer(
                "/spec/versions/0/schema/openAPIV3Schema/properties/spec/properties/displayName/maxLength"
            ),
            Some(&json!(64))
        );
    }
}
