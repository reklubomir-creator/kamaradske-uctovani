#!/usr/bin/env python3
"""End-to-end API checks against a disposable CI database and PHP server."""
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

BASE = os.environ.get("API_BASE", "http://127.0.0.1:8080/api/index.php")


def raw_request(method, suffix="", body=None, headers=None):
    req = urllib.request.Request(
        BASE + suffix,
        data=body,
        headers=headers or {},
        method=method,
    )
    try:
        with urllib.request.urlopen(req, timeout=8) as response:
            raw = response.read()
            try:
                parsed = json.loads(raw) if raw else {}
            except json.JSONDecodeError:
                parsed = {}
            return response.status, parsed, dict(response.headers)
    except urllib.error.HTTPError as exc:
        raw = exc.read()
        try:
            parsed = json.loads(raw) if raw else {}
        except json.JSONDecodeError:
            parsed = {}
        return exc.code, parsed, dict(exc.headers)


def request(method, action, payload=None, token=None, origin=None):
    headers = {}
    if origin:
        headers["Origin"] = origin
    if method == "GET":
        suffix = "?action=" + action + "&token=" + urllib.parse.quote(token or "")
        body = None
    else:
        headers["Content-Type"] = "application/json"
        suffix = ""
        body = json.dumps({"action": action, **(payload or {})}).encode()
    status, result, _ = raw_request(method, suffix, body, headers)
    return status, result


def check(condition, message):
    if not condition:
        raise AssertionError(message)
    print("PASS:", message)


def main():
    allowed = "https://vyuctovani.lubarek.cz"

    status, preflight, headers = raw_request("OPTIONS", headers={
        "Origin": allowed,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type",
    })
    check(status == 204 and headers.get("Access-Control-Allow-Origin") == allowed,
          "approved CORS preflight succeeds")

    status, _, _ = raw_request("OPTIONS", headers={"Origin": "https://attacker.example"})
    check(status == 403, "CORS preflight rejects unapproved origins")

    status, _, _ = raw_request("POST", body=b'{"action":"create","name":"x"}',
                            headers={"Origin": allowed, "Content-Type": "text/plain"})
    check(status == 415, "POST rejects a non-JSON content type")

    status, _, _ = raw_request("POST", body=b'{"action":',
                            headers={"Origin": allowed, "Content-Type": "application/json"})
    check(status == 400, "POST rejects malformed JSON")

    status, _, _ = raw_request("POST", body=b' ' * 524289,
                            headers={"Origin": allowed, "Content-Type": "application/json"})
    check(status == 413, "POST rejects oversized request bodies")

    status, _ = request("POST", "unknown-action", {}, origin=allowed)
    check(status == 400, "API rejects unknown POST actions")

    status, _ = request("POST", "create", {"name": ["not", "text"]}, origin=allowed)
    check(status == 400, "create rejects non-text group names")

    status, created = request("POST", "create", {"name": "CI test group"}, origin=allowed)
    check(status == 201 and created.get("ok"), "create returns 201")
    group = created["group"]
    token, owner_key = group["token"], group["ownerKey"]
    check(bool(token) and bool(owner_key), "create returns token and owner key")

    status, read = request("GET", "read", token=token, origin=allowed)
    check(status == 200 and read["group"]["data"]["name"] == "CI test group",
          "read returns created group")

    status, _ = request("GET", "read", token="", origin=allowed)
    check(status == 400, "read rejects a missing token")

    data = {
        "name": "Updated CI group",
        "people": [{"id": "p1", "name": "Alex", "share": 1}],
        "expenses": [{"id": "e1", "payer": "p1", "amount": 123}],
        "notes": [{"id": "n1", "text": "Keep this note"}],
    }
    status, saved = request("POST", "save", {"token": token, "data": data}, origin=allowed)
    check(status == 200 and saved.get("ok"), "save accepts valid group data")

    status, read = request("GET", "read", token=token, origin=allowed)
    stored = read.get("group", {}).get("data", {})
    check(status == 200 and stored.get("expenses") == data["expenses"]
          and stored.get("notes") == data["notes"],
          "read after save preserves expenses and notes")

    bad = {**data, "people": "not-an-array"}
    status, _ = request("POST", "save", {"token": token, "data": bad}, origin=allowed)
    check(status == 400, "save rejects malformed collection fields")

    bad_item = {**data, "expenses": ["not-an-object"]}
    status, _ = request("POST", "save", {"token": token, "data": bad_item}, origin=allowed)
    check(status == 400, "save rejects non-object collection items")

    too_many_people = {**data, "people": [{"id": str(i)} for i in range(501)]}
    status, _ = request("POST", "save", {"token": token, "data": too_many_people}, origin=allowed)
    check(status == 413, "save rejects collections above the configured limit")

    status, denied_origin = request("GET", "read", token=token, origin="https://attacker.example")
    check(status == 403, "API rejects unapproved browser origins")

    status, denied = request("POST", "delete", {"token": token, "ownerKey": "wrong-key"}, origin=allowed)
    check(status == 403, "delete rejects wrong owner key")

    status, still_there = request("GET", "read", token=token, origin=allowed)
    check(status == 200 and still_there.get("ok"), "failed delete leaves group intact")

    status, deleted = request("POST", "delete", {"token": token, "ownerKey": owner_key}, origin=allowed)
    check(status == 200 and deleted.get("ok"), "delete accepts the correct owner key")

    status, missing = request("GET", "read", token=token, origin=allowed)
    check(status == 404, "deleted group can no longer be read")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print("FAIL:", exc, file=sys.stderr)
        raise
