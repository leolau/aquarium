from __future__ import annotations


def _coerce_timeout(raw: object) -> float | None:
    try:
        timeout = float(raw)
    except (TypeError, ValueError):
        return None
    if timeout <= 0:
        return None
    return timeout


def get_provider_request_timeout(
    provider_id: str, model: str | None = None
) -> float | None:
    """Return a configured provider request timeout in seconds, if any."""
    if not provider_id:
        return None

    try:
        from hermes_cli.config import load_config_readonly
        config = load_config_readonly()
    except Exception:
        return None

    providers = config.get("providers", {}) if isinstance(config, dict) else {}
    provider_config = (
        providers.get(provider_id, {}) if isinstance(providers, dict) else {}
    )
    if not isinstance(provider_config, dict):
        return None

    model_config = _get_model_config(provider_config, model)
    if model_config is not None:
        timeout = _coerce_timeout(model_config.get("timeout_seconds"))
        if timeout is not None:
            return timeout

    return _coerce_timeout(provider_config.get("request_timeout_seconds"))


def get_provider_stale_timeout(
    provider_id: str, model: str | None = None
) -> float | None:
    """Return a configured non-stream stale timeout in seconds, if any."""
    if not provider_id:
        return None

    try:
        from hermes_cli.config import load_config_readonly
        config = load_config_readonly()
    except Exception:
        return None

    providers = config.get("providers", {}) if isinstance(config, dict) else {}
    provider_config = (
        providers.get(provider_id, {}) if isinstance(providers, dict) else {}
    )
    if not isinstance(provider_config, dict):
        return None

    model_config = _get_model_config(provider_config, model)
    if model_config is not None:
        timeout = _coerce_timeout(model_config.get("stale_timeout_seconds"))
        if timeout is not None:
            return timeout

    return _coerce_timeout(provider_config.get("stale_timeout_seconds"))


def _get_model_config(
    provider_config: dict[str, object], model: str | None
) -> dict[str, object] | None:
    if not model:
        return None

    models = provider_config.get("models", {})
    model_config = models.get(model, {}) if isinstance(models, dict) else {}
    if isinstance(model_config, dict):
        return model_config
    return None


def resolve_model_timeout(
    provider_id: str | None,
    model: str | None = None,
    *,
    explicit: object = None,
    task_timeout: object = None,
    task_default: object = None,
    default: float | None = None,
) -> float | None:
    """The timeout in seconds for one model API call.

    Order: ``explicit`` (passed in code for this call) → ``task_timeout``
    when it differs from ``task_default`` (an ``auxiliary.<task>.timeout`` the
    user set) → ``providers.<id>.models.<model>.timeout_seconds`` →
    ``providers.<id>.request_timeout_seconds`` → the task's own timeout or
    default → ``default``.
    """
    timeout = _coerce_timeout(explicit)
    if timeout is not None:
        return timeout
    configured = _coerce_timeout(task_timeout)
    builtin = _coerce_timeout(task_default)
    if configured is not None and configured != builtin:
        return configured
    if provider_id:
        timeout = get_provider_request_timeout(provider_id, model)
        if timeout is not None:
            return timeout
    if configured is not None:
        return configured
    if builtin is not None:
        return builtin
    return default
