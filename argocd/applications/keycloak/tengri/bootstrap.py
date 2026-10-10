#!/usr/bin/env python3
"""Create, then verify the dedicated realm without replacing enrolled identities."""

import copy
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def required(name):
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"Missing {name}")
    return value


def contains(actual, expected):
    if isinstance(expected, dict):
        return isinstance(actual, dict) and all(
            key in actual and contains(actual[key], value)
            for key, value in expected.items()
        )
    if isinstance(expected, list):
        return (
            isinstance(actual, list)
            and len(actual) == len(expected)
            and all(
                any(contains(item, wanted) for item in actual) for wanted in expected
            )
        )
    return actual == expected


def bootstrap():
    root = Path(__file__).resolve().parent
    realm = json.loads((root / "realm.json").read_text())
    profile = json.loads((root / "user-profile.json").read_text())
    realm["identityProviders"][0]["config"].update(
        clientId=required("GITHUB_CLIENT_ID"),
        clientSecret=required("GITHUB_CLIENT_SECRET"),
    )
    realm["clients"][0]["secret"] = required("TENGRI_OIDC_CLIENT_SECRET")
    if len(realm["clients"][0]["secret"]) < 32:
        raise RuntimeError("OIDC client secret must have at least 32 characters")
    base = required("KEYCLOAK_ADMIN_URL").rstrip("/")
    parsed = urllib.parse.urlsplit(base)
    if parsed.scheme not in {"http", "https"} or parsed.username or parsed.password:
        raise RuntimeError("Invalid fixed administrator endpoint")
    opener = urllib.request.build_opener(NoRedirect(), urllib.request.ProxyHandler({}))

    def request(method, path, token="", data=None, form=None, expected=(200,)):
        headers = {"Accept": "application/json"}
        body = None
        if data is not None:
            body = json.dumps(data).encode()
            headers["Content-Type"] = "application/json"
        if form is not None:
            body = urllib.parse.urlencode(form).encode()
            headers["Content-Type"] = "application/x-www-form-urlencoded"
        if token:
            headers["Authorization"] = f"Bearer {token}"
        req = urllib.request.Request(base + path, body, headers, method=method)
        try:
            with opener.open(req, timeout=10) as response:
                status = response.status
                payload = response.read(2_097_153)
        except urllib.error.HTTPError as error:
            if error.code == 404 and 404 in expected:
                return None
            # Responses can contain credentials or identity data. Never print them.
            raise RuntimeError(
                f"Keycloak {method} failed with HTTP {error.code}"
            ) from None
        if status not in expected or len(payload) > 2_097_152:
            raise RuntimeError("Unexpected Keycloak administrator response")
        return json.loads(payload) if payload else None

    token = None
    for attempt in range(30):
        try:
            token = request(
                "POST",
                "/realms/master/protocol/openid-connect/token",
                form={
                    "client_id": "admin-cli",
                    "grant_type": "password",
                    "username": required("KEYCLOAK_ADMIN_USERNAME"),
                    "password": required("KEYCLOAK_ADMIN_PASSWORD"),
                },
            )["access_token"]
            break
        except (RuntimeError, urllib.error.URLError):
            if attempt == 29:
                raise RuntimeError("Keycloak administrator login unavailable") from None
            time.sleep(2)
    path = "/admin/realms/tengri"
    current = request("GET", path, token, expected=(200, 404))
    if current is None:
        creating = copy.deepcopy(realm)
        creating["enabled"] = False
        request("POST", "/admin/realms", token, creating, expected=(201,))
        request("PUT", path + "/users/profile", token, profile, expected=(200,))
    else:
        # Partial import must never overwrite passkeys, users or broker links.
        # A failed qualification leaves this new realm disabled for repair.
        current = dict(current)
        current["enabled"] = True
        scalar = {
            key: value
            for key, value in realm.items()
            if key
            not in {
                "authenticationFlows",
                "authenticatorConfig",
                "requiredActions",
                "identityProviders",
                "identityProviderMappers",
                "clients",
            }
        }
        if not contains(current, scalar):
            raise RuntimeError(
                "Dedicated realm configuration drift; explicit repair required"
            )
        actual_profile = request("GET", path + "/users/profile", token)
        expected_profile = {
            key: value
            for key, value in profile.items()
            if key != "unmanagedAttributePolicy"
        }
        if actual_profile.get("unmanagedAttributePolicy") is not None or not contains(
            actual_profile, expected_profile
        ):
            raise RuntimeError("Dedicated realm identity attribute permissions drift")

    provider = request("GET", path + "/identity-provider/instances/github", token)
    expected_provider = copy.deepcopy(realm["identityProviders"][0])
    expected_provider["config"].pop("clientSecret")
    if not contains(provider, expected_provider) or any(
        provider["config"].get(key) for key in ("baseUrl", "apiUrl", "emailUrl")
    ):
        raise RuntimeError("GitHub provider identity or flow drift")
    if not contains(
        request("GET", path + "/identity-provider/instances/github/mappers", token),
        realm["identityProviderMappers"],
    ):
        raise RuntimeError("GitHub immutable identity mapping drift")
    for expected_client in realm["clients"]:
        query = urllib.parse.urlencode({"clientId": expected_client["clientId"]})
        clients = request("GET", path + "/clients?" + query, token)
        wanted = copy.deepcopy(expected_client)
        wanted.pop("secret", None)
        if len(clients) != 1 or not contains(clients[0], wanted):
            raise RuntimeError("Dedicated realm client configuration drift")
    for flow in realm["authenticationFlows"]:
        alias = urllib.parse.quote(flow["alias"], safe="")
        executions = request(
            "GET", path + f"/authentication/flows/{alias}/executions", token
        )
        direct = [entry for entry in executions if entry["level"] == 0]
        expected = flow["authenticationExecutions"]
        if len(direct) != len(expected):
            raise RuntimeError("Dedicated authentication flow drift")
        for actual, wanted in zip(direct, expected):
            if actual["requirement"] != wanted["requirement"]:
                raise RuntimeError("Dedicated authentication requirement drift")
            if (
                wanted.get("authenticator")
                and actual.get("providerId") != wanted["authenticator"]
            ):
                raise RuntimeError("Dedicated authentication provider drift")
            if (
                wanted.get("flowAlias")
                and actual.get("displayName") != wanted["flowAlias"]
            ):
                raise RuntimeError("Dedicated authentication subflow drift")
            if wanted.get("authenticatorConfig"):
                execution = request(
                    "GET", path + "/authentication/executions/" + actual["id"], token
                )
                config = request(
                    "GET",
                    path + "/authentication/config/" + execution["authenticatorConfig"],
                    token,
                )
                wanted_config = next(
                    item
                    for item in realm["authenticatorConfig"]
                    if item["alias"] == wanted["authenticatorConfig"]
                )
                if not contains(config, wanted_config):
                    raise RuntimeError("Dedicated authentication level drift")
    actions = request("GET", path + "/authentication/required-actions", token)
    for wanted in realm["requiredActions"]:
        if not any(contains(actual, wanted) for actual in actions):
            raise RuntimeError("Dedicated passkey enrollment drift")
    request("PUT", path, token, {"enabled": True}, expected=(204,))
    print(
        "Dedicated Tengri realm, immutable GitHub identity and passkey requirements verified"
    )


if __name__ == "__main__":
    bootstrap()
