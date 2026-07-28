import httpx

TIMEOUT = 30


def _headers(api_key: str) -> dict:
    return {"X-Api-Key": api_key, "Accept": "application/json"}


def _raise_for_status_with_body(resp: httpx.Response) -> None:
    """httpx's default error message drops the response body — Sonarr/Radarr's error detail
    (which field it choked on, etc.) lives there, so surface it instead of a generic message."""
    if resp.is_success:
        return
    raise httpx.HTTPStatusError(
        f"{resp.status_code} {resp.reason_phrase} for {resp.request.url}: {resp.text[:500]}",
        request=resp.request,
        response=resp,
    )


def test_connection(base_url: str, api_key: str) -> dict:
    """Confirms the base_url/api_key actually reach a Sonarr/Radarr instance."""
    resp = httpx.get(f"{base_url}/api/v3/system/status", headers=_headers(api_key), timeout=TIMEOUT)
    _raise_for_status_with_body(resp)
    return resp.json()


def _get_webhook_schema(base_url: str, api_key: str) -> dict:
    """Sonarr/Radarr expose a schema per notification type — the field layout varies by version,
    so we start from their own template rather than hand-building the payload."""
    resp = httpx.get(f"{base_url}/api/v3/notification/schema", headers=_headers(api_key), timeout=TIMEOUT)
    _raise_for_status_with_body(resp)
    for entry in resp.json():
        if entry.get("implementation") == "Webhook":
            return entry
    raise ValueError("This Sonarr/Radarr instance doesn't expose a Webhook notification type")


def _set_field(fields: list[dict], name: str, value) -> None:
    for field in fields:
        if field["name"] == name:
            field["value"] = value
            return
    fields.append({"name": name, "value": value})


def _build_webhook_payload(schema: dict, webhook_url: str) -> dict:
    fields = schema["fields"]
    _set_field(fields, "url", webhook_url)
    _set_field(fields, "method", 1)  # POST

    return {
        **schema,
        "name": "CreditEngine",
        "onGrab": False,
        "onDownload": True,
        "onUpgrade": True,
        "onRename": False,
        "onHealthIssue": False,
        "onApplicationUpdate": False,
        "fields": fields,
    }


def create_webhook_connection(base_url: str, api_key: str, webhook_url: str) -> int:
    """Creates a Webhook notification connection pointed at our /webhooks/import endpoint,
    firing on import and upgrade (both apps call this trigger 'onDownload' for historical reasons).
    Returns the notification's ID so it can be removed later.
    """
    schema = _get_webhook_schema(base_url, api_key)
    payload = _build_webhook_payload(schema, webhook_url)

    resp = httpx.post(f"{base_url}/api/v3/notification", headers=_headers(api_key), json=payload, timeout=TIMEOUT)
    _raise_for_status_with_body(resp)
    return resp.json()["id"]


def test_webhook_connection(base_url: str, api_key: str, webhook_url: str) -> None:
    """Asks Sonarr/Radarr to fire its own test ping at our webhook — same mechanism as clicking
    'Test' in their UI. Raises if Sonarr/Radarr itself reports the test failed."""
    schema = _get_webhook_schema(base_url, api_key)
    payload = _build_webhook_payload(schema, webhook_url)
    resp = httpx.post(f"{base_url}/api/v3/notification/test", headers=_headers(api_key), json=payload, timeout=TIMEOUT)
    _raise_for_status_with_body(resp)


def delete_webhook_connection(base_url: str, api_key: str, notification_id: int) -> None:
    resp = httpx.delete(
        f"{base_url}/api/v3/notification/{notification_id}", headers=_headers(api_key), timeout=TIMEOUT
    )
    if resp.status_code != 404:  # already gone is fine
        _raise_for_status_with_body(resp)
