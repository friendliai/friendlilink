"""FriendliAI provider profile.

Friendli's serverless endpoint (``https://api.friendli.ai/serverless/v1``) is
OpenAI-compatible chat completions, so it worked through Hermes' generic
``custom`` profile before this plugin existed — with one broken corner:
disabling reasoning.

Hermes' universal "turn thinking off" signal is a request carrying
``reasoning_config = {"enabled": False}`` (desktop toggle, ``/reasoning
none``, ``reasoning_effort: none``/``false`` in config.yaml). The ``custom``
profile translates that into a top-level ``reasoning_effort: "none"`` field
(see ``plugins/model-providers/custom/__init__.py``) — the shape GLM-5.2/ARK
and vLLM-style endpoints expect.

Three candidate disable mechanisms were checked live against all 8 models on
the serverless catalog before picking one:

- top-level ``reasoning_effort: "none"`` — HTTP 422 (``invalid JSON payload:
  unknown enum value: 'none'``) on every model except GLM-5.3-Flash. Friendli's
  chat-completions API reference documents the ``reasoning_effort`` enum as
  ``minimal|low|medium|high|xhigh|max``; ``"none"`` was never a valid value,
  so the 422 is Friendli enforcing its own spec, not a bug on Friendli's side.
- ``extra_body.chat_template_kwargs.enable_thinking: false`` — returns 200 on
  every model, but does not reliably suppress reasoning: GLM-5.3 still emits
  its ``<think>...</think>`` marker in the response content (e.g.
  ``"12 * 13 = 156.</think>156"``). A 200 that leaks reasoning tokens into
  the answer is worse than a loud failure, so this is not used as the
  disable switch despite looking like the vLLM-idiomatic choice.
- top-level ``reasoning_budget: 0`` (documented as an integer field capping
  internal reasoning-token usage) — 200 on every model, reasoning genuinely
  off, immediate answer. This is Friendli's actual "reasoning off" switch and
  what this plugin sends.

So the mapping this plugin implements is:

    off  -> extra_body.reasoning_budget = 0
            extra_body.chat_template_kwargs.enable_thinking = false

``extra_body`` keys are merged into the JSON request body's top level by the
OpenAI SDK, so on the wire this is still a top-level integer field — but it
travels as an *unnamed* body key, not a named kwarg of
``chat.completions.create()``. That distinction matters: the SDK validates
kwargs against its own signature (which has ``reasoning_effort`` but no
``reasoning_budget``) and raises
``Completions.create() got an unexpected keyword argument 'reasoning_budget'``
client-side, before a single byte hits Friendli — the transport
(``agent/transports/chat_completions.py:_build_kwargs_from_profile``) merges
a profile's top-level extras directly into the ``create(**kwargs)`` call, so
returning ``reasoning_budget`` as a top-level kwarg made *every* reasoning-off
request crash. It must be returned in the ``extra_body`` slot.
    on, toggle-only model  -> extra_body.chat_template_kwargs.enable_thinking = true
    "<level>" -> top-level reasoning_effort = "<level>" (verbatim on that wire)

The "on" side still uses ``chat_template_kwargs.enable_thinking`` (the same
toggle :mod:`plugins.model_providers.zai` and ``@friendliai/dsh-llm-friendli``'s
``resolveReasoning()`` in ``src/serialize.ts`` use) because turning reasoning
*on* was not observed to have the leakage problem above — only the *off*
path was. Only ``reasoning_effort`` disable spellings (never a hardcoded
``"none"`` string on the wire) and the ``reasoning_budget`` field are new
relative to those two references.

Unlike the Z.AI profile, this plugin does **not** hardcode a per-model effort
vocabulary (no ``GLM52_EFFORTS``-style constant). Friendli's own
``GET /models`` catalog already publishes each model's reasoning shape:

    "reasoning": true,
    "reasoning_options": [
        {"type": "effort", "values": ["low", "high", "max"]},
        {"type": "toggle"},
        {"type": "budget_tokens", "min": -1, "max": 1048576}
    ]

``reasoning`` is false for non-reasoning models (never emit reasoning
fields). ``reasoning_options`` entries describe *how* a reasoning model is
controlled: an ``"effort"`` entry publishes a discrete named-level enum (the
values ``reasoning_effort`` accepts on the wire for that model); a
``"toggle"`` entry means the model has a plain on/off switch
(``enable_thinking``) with no graded levels; ``"budget_tokens"`` publishes the
range for the ``reasoning_budget`` integer field — this plugin only ever
sends ``0`` on that field (the verified disable value) and never reads its
``min``/``max`` for anything else. A model can publish more than one —
GLM-5.2 exposes both ``toggle`` and ``effort`` (its 2-level ``high``/``max``
enum), DeepSeek-V3.2 exposes only ``toggle``. This plugin fetches that
catalog lazily (never blocking a request on network I/O — see
:func:`supported_reasoning_efforts`'s docstring and the
``providers.base.ProviderProfile`` contract it implements) and drives both
the enable/disable/effort logic and the reasoning-vocabulary lookup from it,
so a new GLM/DeepSeek/MiniMax release with a different effort ladder is
picked up automatically instead of needing a code change here.
"""

from __future__ import annotations

import json
import logging
import os
import threading
import time
from pathlib import Path
from typing import Any, Optional

from providers import register_provider
from providers.base import ProviderProfile, _profile_user_agent

logger = logging.getLogger(__name__)

FRIENDLI_BASE_URL = "https://api.friendli.ai/serverless/v1"

# Curated fallback shown in the /model picker when the live catalog fetch
# fails. Snapshot of the live catalog (api.friendli.ai/serverless/v1/models,
# 2026-09-03) — every entry here supports tool calling. Kept intentionally
# short: Friendli's serverless lineup changes over time (new GLM/DeepSeek/
# MiniMax releases replace old ones), so the live fetch below is preferred
# and this is only the offline safety net.
FALLBACK_MODELS: tuple[str, ...] = (
    "zai-org/GLM-5.3",
    "zai-org/GLM-5.3-Flash",
)

# Disable spellings accepted from Hermes' reasoning config, on top of the
# canonical ``enabled: False`` — matches the zai/custom profile precedent so
# ``reasoning_effort: none``/``false``/``disabled`` in config.yaml all take
# the same path regardless of which provider profile is active.
_DISABLE_EFFORT_WORDS = frozenset({"none", "false", "disabled"})

# ---------------------------------------------------------------------------
# Live catalog cache: model id -> {"reasoning": bool, "effort": tuple[str,...],
# "toggle": bool}. Populated by fetch_models() (picker/setup/doctor) and by a
# background warmer; consulted cache-only from build_api_kwargs_extras() and
# supported_reasoning_efforts() so neither blocks a chat turn on network I/O.
# Mirrors the Ramp Router capability-cache design in
# plugins/model-providers/router/__init__.py.
# ---------------------------------------------------------------------------

_catalog_cache: Optional[dict[str, dict[str, Any]]] = None
_catalog_lock = threading.Lock()
_warm_started = False
_disk_checked = False

# Reasoning vocabularies change rarely; a stale disk mirror still beats no
# verdict at all, so it's served immediately while a background refresh runs.
_DISK_TTL_SECONDS = 24 * 60 * 60


def _resolve_api_key() -> str:
    """Resolve FRIENDLIAI_API_KEY, preferring dotenv."""
    resolvers = []
    try:
        from hermes_cli.config import get_env_value_prefer_dotenv

        resolvers.append(get_env_value_prefer_dotenv)
    except Exception:
        pass
    resolvers.append(lambda var: os.environ.get(var, ""))
    for resolve in resolvers:
        for var in ("FRIENDLIAI_API_KEY",):
            try:
                value = str(resolve(var) or "").strip()
            except Exception:
                value = ""
            if value:
                return value
    return ""


def _parse_catalog(items: Any) -> Optional[dict[str, dict[str, Any]]]:
    """Parse a Friendli ``/models`` ``data`` array into the reasoning-shape map.

    Returns ``None`` when the array has no usable entries, so callers treat
    that as a failed fetch rather than caching an empty verdict.
    """
    if not isinstance(items, list):
        return None
    catalog: dict[str, dict[str, Any]] = {}
    for item in items:
        if not isinstance(item, dict):
            continue
        mid = str(item.get("id") or "").strip()
        if not mid:
            continue
        reasoning = bool(item.get("reasoning"))
        effort_values: tuple[str, ...] = ()
        has_toggle = False
        for opt in item.get("reasoning_options") or []:
            if not isinstance(opt, dict):
                continue
            opt_type = opt.get("type")
            if opt_type == "effort":
                effort_values = tuple(
                    str(v).strip().lower()
                    for v in (opt.get("values") or [])
                    if str(v).strip()
                )
            elif opt_type == "toggle":
                has_toggle = True
        catalog[mid] = {
            "reasoning": reasoning,
            "effort": effort_values,
            "toggle": has_toggle,
        }
    return catalog or None


def _disk_path() -> Optional[Path]:
    try:
        from hermes_constants import get_hermes_home

        return get_hermes_home() / "cache" / "friendli_catalog.json"
    except Exception:
        return None


def _save_disk(catalog: dict[str, dict[str, Any]]) -> None:
    path = _disk_path()
    if path is None:
        return
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        serializable = {
            mid: {"reasoning": e["reasoning"], "effort": list(e["effort"]), "toggle": e["toggle"]}
            for mid, e in catalog.items()
        }
        tmp.write_text(json.dumps({"ts": time.time(), "catalog": serializable}), encoding="utf-8")
        tmp.replace(path)
    except Exception as exc:
        logger.debug("friendli: catalog disk mirror write failed: %s", exc)


def _load_disk() -> tuple[Optional[dict[str, dict[str, Any]]], float]:
    path = _disk_path()
    if path is None:
        return None, 0.0
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        raw = data.get("catalog")
        if not isinstance(raw, dict) or not raw:
            return None, 0.0
        parsed = {
            str(mid): {
                "reasoning": bool(e.get("reasoning")),
                "effort": tuple(str(v) for v in (e.get("effort") or [])),
                "toggle": bool(e.get("toggle")),
            }
            for mid, e in raw.items()
            if isinstance(e, dict)
        }
        try:
            age = max(0.0, time.time() - float(data.get("ts") or 0))
        except (TypeError, ValueError):
            age = float(_DISK_TTL_SECONDS)
        return (parsed or None), age
    except Exception:
        return None, 0.0


def _seed_catalog(items: Any) -> Optional[dict[str, dict[str, Any]]]:
    """Seed memory + disk caches from a ``/models`` payload."""
    global _catalog_cache
    parsed = _parse_catalog(items)
    if parsed is None:
        return None
    with _catalog_lock:
        _catalog_cache = parsed
    _save_disk(parsed)
    return parsed


def _fetch_catalog_items(
    *, api_key: str = "", base_url: str = "", timeout: float = 8.0
) -> Optional[list]:
    """Fetch the raw ``/models`` ``data`` array. ``None`` on any failure."""
    url = (base_url or FRIENDLI_BASE_URL).rstrip("/") + "/models"
    import urllib.request

    from hermes_cli.urllib_security import open_credentialed_url

    req = urllib.request.Request(url)
    key = api_key or _resolve_api_key()
    if key:
        req.add_header("Authorization", f"Bearer {key}")
    req.add_header("Accept", "application/json")
    req.add_header("User-Agent", _profile_user_agent())
    try:
        with open_credentialed_url(req, timeout=timeout) as resp:
            data = json.loads(resp.read().decode())
    except Exception as exc:
        logger.debug("friendli: catalog fetch failed: %s", exc)
        return None
    items = data if isinstance(data, list) else (data.get("data", []) if isinstance(data, dict) else [])
    return items if isinstance(items, list) else None


def _catalog_cache_only() -> Optional[dict[str, dict[str, Any]]]:
    """Memory, else the disk mirror. Never HTTP — safe on the hot path."""
    global _catalog_cache, _disk_checked
    with _catalog_lock:
        cached = _catalog_cache
    if cached is not None:
        return cached
    if _disk_checked:
        return None
    _disk_checked = True
    parsed, age = _load_disk()
    if parsed is None:
        return None
    with _catalog_lock:
        if _catalog_cache is None:
            _catalog_cache = parsed
        cached = _catalog_cache
    if age >= _DISK_TTL_SECONDS:
        _warm_catalog_async()
    return cached


def _warm_catalog_async() -> None:
    """Refresh the catalog cache in the background, at most once per process."""
    global _warm_started
    if os.environ.get("PYTEST_CURRENT_TEST"):
        # A mid-suite background fetch would make cache state timing-dependent
        # in tests (same guard as the Router capability warmer).
        return
    with _catalog_lock:
        if _warm_started:
            return
        _warm_started = True
    if not _resolve_api_key():
        # Without a key the fetch would 401; the first authenticated
        # fetch_models() call (picker/setup/doctor) seeds the cache instead.
        return

    def _refresh() -> None:
        items = _fetch_catalog_items()
        if items is not None:
            _seed_catalog(items)

    try:
        threading.Thread(target=_refresh, name="friendli-catalog-warm", daemon=True).start()
    except Exception as exc:
        logger.debug("friendli: catalog warmer failed to start: %s", exc)


def _catalog_entry(model: Optional[str]) -> Optional[dict[str, Any]]:
    """Cache-only lookup of the reasoning shape for *model*, or ``None``."""
    mid = str(model or "").strip()
    if not mid:
        return None
    catalog = _catalog_cache_only()
    if catalog is None:
        _warm_catalog_async()
        return None
    return catalog.get(mid)


class FriendliProfile(ProviderProfile):
    """FriendliAI serverless — extra_body reasoning_budget=0 disable + catalog-driven reasoning_effort."""

    def fetch_models(
        self,
        *,
        api_key: Optional[str] = None,
        base_url: Optional[str] = None,
        timeout: float = 8.0,
    ) -> Optional[list[str]]:
        """Fetch the live catalog and seed the reasoning-capability cache.

        Friendli's ``/models`` response is already OpenAI-compatible
        (``{"data": [{"id": ..., ...}]}``), so the base implementation would
        work for the picker alone — but it only extracts ``id``. Overriding
        lets one request also warm :func:`_catalog_entry`'s cache with each
        model's ``reasoning``/``reasoning_options`` shape, at no extra
        network cost (same trick as the Ramp Router profile).
        """
        items = _fetch_catalog_items(
            api_key=api_key or "", base_url=base_url or "", timeout=timeout
        )
        if items is None:
            return None
        _seed_catalog(items)
        ids = [str(item["id"]) for item in items if isinstance(item, dict) and item.get("id")]
        return ids or None

    def supported_reasoning_efforts(self, model: Optional[str]) -> Optional[tuple[str, ...]]:
        """Catalog-declared effort vocabulary for *model* (cache-only).

        Tri-state per ``ProviderProfile.supported_reasoning_efforts``:
        ``()`` when the catalog says the model has no reasoning capability at
        all, the declared ``values`` when it publishes a graded ``"effort"``
        vocabulary, and ``None`` (unknown/undeclared — caller keeps its
        default) for a cold cache, an unrecognized model, or a
        reasoning-capable model that only exposes a ``"toggle"``/
        ``"budget_tokens"`` knob rather than named effort levels.
        """
        entry = _catalog_entry(model)
        if entry is None:
            return None
        if not entry["reasoning"]:
            return ()
        return entry["effort"] or None

    def build_api_kwargs_extras(
        self,
        *,
        reasoning_config: Optional[dict] = None,
        model: Optional[str] = None,
        **context: Any,
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        extra_body: dict[str, Any] = {}
        top_level: dict[str, Any] = {}

        if not reasoning_config or not isinstance(reasoning_config, dict):
            # No preference expressed at all -> omit both fields, let
            # Friendli's server-side default apply.
            return extra_body, top_level

        entry = _catalog_entry(model)
        if entry is not None and not entry["reasoning"]:
            # Catalog says this model has no reasoning capability at all
            # (reasoning: false) -> never emit either field, regardless of
            # what the user asked for.
            return extra_body, top_level

        enabled = reasoning_config.get("enabled", True)
        effort = str(reasoning_config.get("effort") or "").strip().lower()

        if enabled is False or effort in _DISABLE_EFFORT_WORDS:
            # The bug this plugin exists to fix: Friendli 422s on a top-level
            # reasoning_effort value outside its per-model enum, and "none" is
            # never in that enum. Live-verified (2026-09-03, all 8 catalog
            # models): chat_template_kwargs.enable_thinking=false returns 200
            # but doesn't reliably suppress reasoning (GLM-5.3 still leaks a
            # trailing "</think>" marker into the answer). The disable switch
            # that actually works everywhere is the wire's top-level integer
            # field reasoning_budget=0. Emitted unconditionally here (not
            # gated on a warm catalog) so "turn thinking off" works on the
            # very first request, before any /models fetch has run.
            #
            # Sent via extra_body, NOT as a top-level kwarg: the OpenAI SDK
            # merge in the transport puts a profile's top_level dict straight
            # into chat.completions.create(**kwargs), whose signature has no
            # reasoning_budget parameter -> TypeError before the request is
            # even built (the reported
            # `Completions.create() got an unexpected keyword argument
            # 'reasoning_budget'`). extra_body keys serialize into the JSON
            # body's top level, so Friendli still receives
            # {"reasoning_budget": 0} exactly as before.
            extra_body["reasoning_budget"] = 0
            extra_body["chat_template_kwargs"] = {"enable_thinking": False}
            return extra_body, top_level

        effort_values = entry["effort"] if entry else ()
        has_toggle = bool(entry and entry["toggle"])

        if effort:
            if effort_values:
                # Model publishes a graded effort enum (e.g. GLM-5.3:
                # low/high/max) -> clamp the request onto it and send
                # verbatim as the top-level field the wire expects. Never a
                # hardcoded vocabulary: effort_values comes straight from the
                # live catalog fetched in fetch_models()/the background warmer.
                from agent.reasoning_effort import clamp_effort

                top_level["reasoning_effort"] = clamp_effort(effort, effort_values)
            elif has_toggle:
                # No graded enum for this model, but it does have an on/off
                # switch (DeepSeek-V3.2, GLM-5.1, ...) -> the closest honest
                # translation of "some positive effort" is "thinking on".
                extra_body["chat_template_kwargs"] = {"enable_thinking": True}
            # else: catalog is cold, model is unrecognized, or the model only
            # exposes budget_tokens -> omit rather than guess; sending an
            # unvalidated reasoning_effort string risks the exact 422 this
            # plugin exists to avoid.
            return extra_body, top_level

        # enabled=True with no explicit effort.
        if has_toggle and not effort_values:
            # Toggle-only models (no graded enum) default to server-side
            # "thinking on" already, but the toggle exists precisely so an
            # explicit enable request is honored rather than assumed.
            extra_body["chat_template_kwargs"] = {"enable_thinking": True}
        # else: model has a graded effort enum (GLM-5.2/5.3) or only
        # budget_tokens, or the catalog is cold -> omit both fields and let
        # Friendli's server-side default apply, exactly like the zai/custom
        # profiles do for an unspecified effort.

        return extra_body, top_level


friendli = FriendliProfile(
    name="friendli",
    aliases=("friendliai",),
    env_vars=("FRIENDLIAI_API_KEY",),
    display_name="FriendliAI",
    description="Friendli Model APIs provide instant access to a curated set of models, powered by a proprietary inference stack called Friendli Engine for high-performance, cost-efficient inference.",
    signup_url="https://friendli.ai/",
    fallback_models=FALLBACK_MODELS,
    base_url=FRIENDLI_BASE_URL,
    auth_type="api_key",
    # Cheapest/fastest model in the live catalog (GLM-5.3-Flash) — used for
    # compaction, vision summarization, and other auxiliary tasks.
    default_aux_model="zai-org/GLM-5.3-Flash",
)

register_provider(friendli)
