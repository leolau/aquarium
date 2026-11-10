"""Owner/admin editing of model API timeouts, per provider and per model.

Reads and writes ``providers.<id>.request_timeout_seconds`` and
``providers.<id>.models.<model>.timeout_seconds``. A change is written to every
profile's config.yaml so each profile's chat turns, background tasks and
fallbacks use the same timeout for that provider/model. ``GET`` also lists
the provider/model pairs the config uses (main model, fallbacks, auxiliary
tasks) so Settings can offer them.
"""

from __future__ import annotations

import logging
import re
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from hermes_cli.route_roles import ADMIN
from hermes_cli.timeouts import _coerce_timeout

logger = logging.getLogger(__name__)

router = APIRouter()

TIMEOUT_MIN_SECONDS = 5
TIMEOUT_MAX_SECONDS = 3600
MODEL_MAX_CHARS = 200
_PROVIDER_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$")
_CONTROL_RE = re.compile(r"[\x00-\x1f\x7f-\x9f]")
_AUTO_PROVIDERS = ("", "auto", "main")


def configured_timeouts(config: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Every timeout set under ``providers``; ``model`` is None for provider-wide."""
    out: List[Dict[str, Any]] = []
    providers = config.get("providers") if isinstance(config, dict) else None
    if not isinstance(providers, dict):
        return out
    for provider, pcfg in sorted(providers.items()):
        if not isinstance(pcfg, dict):
            continue
        wide = _coerce_timeout(pcfg.get("request_timeout_seconds"))
        if wide is not None:
            out.append({"provider": provider, "model": None, "timeout_seconds": wide})
        models = pcfg.get("models")
        if isinstance(models, dict):
            for model, mcfg in sorted(models.items()):
                if isinstance(mcfg, dict):
                    t = _coerce_timeout(mcfg.get("timeout_seconds"))
                    if t is not None:
                        out.append({"provider": provider, "model": model, "timeout_seconds": t})
    return out


def models_in_use(config: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Provider/model pairs the config calls, each with what uses it."""
    uses: Dict[tuple, List[str]] = {}

    def add(provider: Any, model: Any, use: str) -> None:
        provider = str(provider or "").strip()
        model = str(model or "").strip()
        if provider.lower() in _AUTO_PROVIDERS or not model:
            return
        uses.setdefault((provider, model), [])
        if use not in uses[(provider, model)]:
            uses[(provider, model)].append(use)

    model_cfg = config.get("model") if isinstance(config, dict) else None
    main_provider = ""
    main_model = ""
    if isinstance(model_cfg, dict):
        main_provider = str(model_cfg.get("provider") or "")
        main_model = str(model_cfg.get("default") or model_cfg.get("model") or "")
        add(main_provider, main_model, "chat")
    try:
        from hermes_cli.fallback_config import get_fallback_chain

        for entry in get_fallback_chain(config):
            if isinstance(entry, dict):
                add(entry.get("provider"), entry.get("model"), "fallback")
    except Exception:
        logger.debug("model timeouts: could not read fallback chain", exc_info=True)
    aux = config.get("auxiliary") if isinstance(config, dict) else None
    if isinstance(aux, dict):
        for task, tcfg in sorted(aux.items()):
            if not isinstance(tcfg, dict):
                continue
            provider = str(tcfg.get("provider") or "")
            model = str(tcfg.get("model") or "")
            if provider.lower() in _AUTO_PROVIDERS and (not model or model == main_model):
                provider, model = main_provider, main_model
            add(provider, model, task)
            chain = tcfg.get("fallback_chain")
            if isinstance(chain, list):
                for entry in chain:
                    if isinstance(entry, dict):
                        add(entry.get("provider"), entry.get("model"), f"{task} fallback")
    return [
        {"provider": p, "model": m, "used_by": used_by}
        for (p, m), used_by in sorted(uses.items())
    ]


def read_timeouts(config: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "timeouts": configured_timeouts(config),
        "in_use": models_in_use(config),
        "min_seconds": TIMEOUT_MIN_SECONDS,
        "max_seconds": TIMEOUT_MAX_SECONDS,
    }


def validate_change(provider: Any, model: Any, timeout_seconds: Any) -> tuple:
    """``(provider, model or None, seconds or None)``; ValueError when invalid."""
    if not isinstance(provider, str) or not _PROVIDER_RE.match(provider.strip()):
        raise ValueError("provider must be a provider id such as opencode-go.")
    if model is not None:
        if not isinstance(model, str) or _CONTROL_RE.search(model):
            raise ValueError("model must be text.")
        model = model.strip() or None
        if model is not None and len(model) > MODEL_MAX_CHARS:
            raise ValueError(f"model must be at most {MODEL_MAX_CHARS} characters.")
    if timeout_seconds is not None:
        if isinstance(timeout_seconds, bool) or not isinstance(timeout_seconds, (int, float)):
            raise ValueError("timeout_seconds must be a number of seconds, or null to clear it.")
        if not TIMEOUT_MIN_SECONDS <= timeout_seconds <= TIMEOUT_MAX_SECONDS:
            raise ValueError(
                f"timeout_seconds must be between {TIMEOUT_MIN_SECONDS} and {TIMEOUT_MAX_SECONDS}."
            )
        timeout_seconds = int(timeout_seconds) if float(timeout_seconds).is_integer() else float(timeout_seconds)
    return provider.strip(), model, timeout_seconds


def apply_timeout(
    config: Dict[str, Any], provider: str, model: Optional[str], timeout_seconds: Any
) -> None:
    """Set, or clear when ``timeout_seconds`` is None, one timeout in ``config``."""
    providers = config.get("providers")
    if not isinstance(providers, dict):
        if timeout_seconds is None:
            return
        providers = config["providers"] = {}
    pcfg = providers.get(provider)
    if not isinstance(pcfg, dict):
        if timeout_seconds is None:
            return
        pcfg = providers[provider] = {}
    if model is None:
        if timeout_seconds is None:
            pcfg.pop("request_timeout_seconds", None)
        else:
            pcfg["request_timeout_seconds"] = timeout_seconds
    else:
        models = pcfg.get("models")
        if not isinstance(models, dict):
            if timeout_seconds is None:
                return
            models = pcfg["models"] = {}
        mcfg = models.get(model)
        if not isinstance(mcfg, dict):
            if timeout_seconds is None:
                return
            mcfg = models[model] = {}
        if timeout_seconds is None:
            mcfg.pop("timeout_seconds", None)
            if not mcfg:
                models.pop(model, None)
            if not models:
                pcfg.pop("models", None)
        else:
            mcfg["timeout_seconds"] = timeout_seconds
    if not pcfg:
        providers.pop(provider, None)


def _profile_names() -> List[str]:
    try:
        from hermes_cli.profiles import list_profiles

        names = [p.name for p in list_profiles()]
    except Exception:
        logger.warning("model timeouts: could not list profiles", exc_info=True)
        names = []
    return names or ["default"]


class TimeoutUpdate(BaseModel):
    provider: Any = None
    model: Any = None
    timeout_seconds: Any = None


@router.get("/api/model-timeouts", dependencies=ADMIN)
async def get_model_timeouts():
    """The configured timeouts and the provider/model pairs in use. Owner/admin only."""
    from hermes_cli import web_server as ws

    with ws._profile_scope("default"):
        return read_timeouts(ws.load_config())


@router.put("/api/model-timeouts", dependencies=ADMIN)
async def put_model_timeout(body: TimeoutUpdate):
    """Set or clear one provider-wide or per-model timeout in every profile.

    ``timeout_seconds: null`` clears it (the built-in default applies again).
    """
    from hermes_cli import web_server as ws

    if "timeout_seconds" not in body.model_fields_set:
        raise HTTPException(status_code=400, detail="Give timeout_seconds (or null to clear it).")
    try:
        provider, model, seconds = validate_change(body.provider, body.model, body.timeout_seconds)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    for name in _profile_names():
        with ws._profile_scope(name):
            config = ws.load_config()
            apply_timeout(config, provider, model, seconds)
            ws.save_config(config)
    with ws._profile_scope("default"):
        return read_timeouts(ws.load_config())
