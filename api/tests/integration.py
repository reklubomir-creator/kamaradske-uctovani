#!/usr/bin/env python3
"""End-to-end API checks against a disposable CI database and PHP server."""
import json
import os
import sys
import urllib.error
import urllib.request

BASE = os.environ.get("API_BASE", "http://127.0.0.1:8080/api/index.php")


def request(method, action, payload=None, token=None, origin=None):
    headers = {}
    url = BASE
    data = None
    if origin:
        headers["Origin"] = origin
    if method == "GET":
        url += "?action=" + action + "&token=" + urllib.parse.quote(token or "")
    else:
        headers["Content-Type"] = "application/json"
        data = json.dumps({"action": action, **(payload or {})}).encode()
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=8) as response:
            raw = response.read()
            return response.status, json.loads(raw) if raw else {}
    except urllib.error.HTTPError as exc:
        raw = exc.read()
        try:
            body = json.loads(raw) if raw else {}
        except json.JSONDecodeError:
            body = {}
        return exc.code, body


def check(condition, message):
    if not condition:
        raise AssertionError(message)
    print("PASS:", message)


def main():
    allowed = "https://vyuctovani.lubarek.cz"
    status, created = request("POST", "create", {"name": "CI test group"}, origin=allowed)
    check(status == 201 and created.get("ok"), "create returns 201")
    group = created["group"]
    token, owner_key = group["token"], group["ownerKey"]
    check(bool(token) and bool(owner_key), "create returns token and owner key")

    status, read = request("GET", "read", token=token, origin=allowed)
    check(status == 200 and read["group"]["data"]["name"] == "CI test group", "read returns created group")

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
    check(status == 200 and stored.get("expenses") == data["expenses"] and stored.get("notes") == data["notes"], "read after save preserves expenses and notes")

    bad = {**data, "people": "not-an-array"}
    status, _ = request("POST", "save", {"token": token, "data": bad}, origin=allowed)
    check(status == 400, "save rejects malformed collection fields")

    status, denied = request("POST", "delete", {"token": token, "ownerKey": "wrong-key"}, origin=allowed)
    check(status == 403, "delete rejects wrong owner key")

    status, still_there = request("GET", "read", token=token, origin=allowed)
    check(status == 200 and still_there.get("ok"), "failed delete leaves group intact")

    status, denied_origin = request("GET", "read", token=token, origin="https://attacker.example")
    check(status == 403, "API rejects unapproved browser origins")

    status, deleted = request("POST", "delete", {"token": token, "ownerKey": owner_key}, origin=allowed)
    check(status == 200 and deleted.get("ok"), "delete accepts the correct owner key")

    status, missing = request("GET", "read", token=token, origin=allowed)
    check(status == 404, "deleted group can no longer be read")


if __name__ == "__main__":
    try:
        import urllib.parse
        main()
    except Exception as exc:
        print("FAIL:", exc, file=sys.stderr)
        raise
