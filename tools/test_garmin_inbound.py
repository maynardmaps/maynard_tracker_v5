#!/usr/bin/env python3
"""Check Garmin IPC Inbound credentials with a read-only tracking-status query."""

import base64
import getpass
import json
import re
import sys
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen


ENDPOINT = "https://eur-origin.explore.garmin.com:443/ipcinbound/V1/Tracking.svc/Tracking"


def main() -> int:
    imei = input("Tracker IMEI (15 digits): ").strip()
    if not re.fullmatch(r"\d{15}", imei):
        print("Error: IMEI must be exactly 15 digits.", file=sys.stderr)
        return 2

    username = input("Garmin IPC Inbound username: ").strip()
    password = getpass.getpass("Garmin IPC Inbound password (input hidden): ")
    if not username or not password:
        print("Error: username and password are required.", file=sys.stderr)
        return 2

    credentials = base64.b64encode(
        f"{username}:{password}".encode("utf-8")
    ).decode("ascii")
    request = Request(
        f"{ENDPOINT}?{urlencode({'IMEI': imei})}",
        headers={
            "Authorization": f"Basic {credentials}",
            "Accept": "application/json",
        },
        method="GET",
    )

    print("Sending read-only tracking-status request to Garmin IPC Inbound...")
    try:
        with urlopen(request, timeout=30) as response:
            status = response.status
            body = response.read().decode("utf-8", errors="replace")
    except HTTPError as error:
        status = error.code
        body = error.read().decode("utf-8", errors="replace")
    except (URLError, TimeoutError, OSError) as error:
        print(f"Request failed before receiving an HTTP response: {error}", file=sys.stderr)
        return 1

    print(f"HTTP status: {status}")
    if body:
        try:
            print(json.dumps(json.loads(body), indent=2))
        except json.JSONDecodeError:
            print(body)
    else:
        print("(empty response body)")

    print(
        "Credentials were used only for this request and were not saved. "
        "The response may contain tracker information; review it before sharing."
    )
    return 0 if 200 <= status < 300 else 1


if __name__ == "__main__":
    raise SystemExit(main())
