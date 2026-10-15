"""Tests for the Friendli provider profile — style tests/providers/test_provider_profiles.py.

Usage (from ~/.hermes/hermes-agent with the venv):
    ./venv/bin/python -m pytest ~/.hermes/plugins/model-providers/friendli/tests/ -v

Provider registry discovery scans $HERMES_HOME/plugins/model-providers/ on
the first get_provider_profile() call, so the plugin loads automatically —
no manual import needed.

No live network calls: tests seed catalog data or exercise catalog fetching
through a local HTTP server instead of api.friendli.ai/serverless/v1/models.
"""

import json
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from providers import get_provider_profile


def _profile():
    p = get_provider_profile("friendli")
    assert p is not None, "profile 'friendli' not found — is the plugin discovered?"
    return p


def _module():
    """The plugin's own module object, however the loader named it."""
    return sys.modules[type(_profile()).__module__]


def _seed(entries):
    """Replace the live-catalog cache with a fixed reasoning-shape map.

    entries: {model_id: {"reasoning": bool, "effort": tuple[str, ...], "toggle": bool}}
    """
    _module()._catalog_cache = entries


@pytest.fixture(autouse=True)
def _isolated_catalog_cache():
    """Each test starts from a clean, empty cache and restores it after."""
    mod = _module()
    saved_cache, saved_disk_checked = mod._catalog_cache, mod._disk_checked
    saved_capabilities = _profile().model_capabilities
    _profile().model_capabilities = {}
    mod._catalog_cache, mod._disk_checked = None, True  # skip disk I/O in tests
    try:
        yield
    finally:
        mod._catalog_cache, mod._disk_checked = saved_cache, saved_disk_checked
        _profile().model_capabilities = saved_capabilities


# Catalog fixtures, shaped like the live api.friendli.ai/serverless/v1/models
# response after _parse_catalog() (see module docstring / GLM-5.3 vs. GLM-5.2
# vs. DeepSeek-V3.2 vs. MiniMax-M2.5 in the live catalog, 2026-09-03).
EFFORT_MODEL = "zai-org/GLM-5.3"  # effort: low/high/max, no toggle
TOGGLE_AND_EFFORT_MODEL = "zai-org/GLM-5.2"  # effort: high/max, also has toggle
TOGGLE_ONLY_MODEL = "deepseek-ai/DeepSeek-V3.2"  # toggle only, no effort enum
BUDGET_ONLY_MODEL = "MiniMaxAI/MiniMax-M2.5"  # neither toggle nor effort
NON_REASONING_MODEL = "codestral-mini"  # reasoning: false

CATALOG = {
    EFFORT_MODEL: {"reasoning": True, "effort": ("low", "high", "max"), "toggle": False},
    TOGGLE_AND_EFFORT_MODEL: {"reasoning": True, "effort": ("high", "max"), "toggle": True},
    TOGGLE_ONLY_MODEL: {"reasoning": True, "effort": (), "toggle": True},
    BUDGET_ONLY_MODEL: {"reasoning": True, "effort": (), "toggle": False},
    NON_REASONING_MODEL: {"reasoning": False, "effort": (), "toggle": False},
}


class TestFriendliDiscovery:
    """Provider identity (README/model-provider conventions)."""

    def test_registry_lookup(self):
        p = _profile()
        assert p.name == "friendli"
        assert p.display_name == "FriendliAI"
        assert p.signup_url
        assert p.env_vars == ("FRIENDLIAI_API_KEY",)
        assert p.base_url == "https://api.friendli.ai/serverless/v1"
        assert p.aliases == ("friendliai",)
        assert p.default_aux_model == "zai-org/GLM-5.3-Flash"

    def test_fallback_models_not_hardcoded_vocabulary(self):
        p = _profile()
        assert p.fallback_models, "fallback_models must not be empty"
        assert all(isinstance(m, str) and m for m in p.fallback_models)


class TestReasoningDisable:
    """The bug this plugin exists to fix: disable must never send reasoning_effort=none.

    Live-verified (2026-09-03) that chat_template_kwargs.enable_thinking=false
    returns 200 but doesn't reliably suppress reasoning (GLM-5.3 still leaks a
    trailing "</think>" marker into the answer) — reasoning_budget=0 is the
    switch that actually works on every catalog model, so that's what the
    disable path emits.

    On the wire that field is top-level JSON, but it is returned in the
    extra_body slot, never as a top-level kwarg: the transport merges
    top_level kwargs straight into chat.completions.create(**kwargs) and the
    OpenAI SDK signature has no reasoning_budget parameter (only
    reasoning_effort), so a top-level kwarg crashes every reasoning-off
    request client-side with
    `Completions.create() got an unexpected keyword argument 'reasoning_budget'`.
    """

    def test_enabled_false_emits_reasoning_budget_zero(self):
        _seed(CATALOG)
        p = _profile()
        eb, tl = p.build_api_kwargs_extras(
            reasoning_config={"enabled": False}, model=EFFORT_MODEL
        )
        assert tl == {}
        assert eb == {
            "reasoning_budget": 0,
            "chat_template_kwargs": {"enable_thinking": False},
        }
        assert "reasoning_effort" not in eb

    def test_effort_disable_words_emit_reasoning_budget_zero(self):
        _seed(CATALOG)
        p = _profile()
        for word in ("none", "false", "disabled"):
            eb, tl = p.build_api_kwargs_extras(
                reasoning_config={"enabled": True, "effort": word}, model=EFFORT_MODEL
            )
            assert tl == {}, word
            assert eb == {
                "reasoning_budget": 0,
                "chat_template_kwargs": {"enable_thinking": False},
            }, word

    def test_disable_works_before_catalog_is_warm(self):
        # Cold cache (no /models fetch has happened yet) must not block the
        # disable path — that would leave the original 422 bug intact on the
        # very first request.
        _seed(None)
        p = _profile()
        eb, tl = p.build_api_kwargs_extras(
            reasoning_config={"enabled": False}, model="some-unfetched-model"
        )
        assert tl == {}
        assert eb == {
            "reasoning_budget": 0,
            "chat_template_kwargs": {"enable_thinking": False},
        }

    def test_disable_never_returns_an_sdk_top_level_kwarg(self):
        # Regression guard for the TypeError: whatever the disable path
        # returns, any named kwarg the transport would merge into
        # chat.completions.create(**kwargs) must be an SDK-accepted parameter
        # name. reasoning_budget is not (reasoning_effort is).
        import inspect

        from openai.resources.chat import completions as _oc

        _seed(CATALOG)
        p = _profile()
        sdk_params = set(
            inspect.signature(_oc.Completions.create).parameters
        ) - {"self"}
        for model in CATALOG:
            eb, tl = p.build_api_kwargs_extras(
                reasoning_config={"enabled": False}, model=model
            )
            unknown = set(tl) - sdk_params
            assert not unknown, f"{model}: top-level kwargs {unknown} are not OpenAI SDK parameters"

    def test_non_reasoning_model_disable_emits_nothing(self):
        _seed(CATALOG)
        p = _profile()
        eb, tl = p.build_api_kwargs_extras(
            reasoning_config={"enabled": False}, model=NON_REASONING_MODEL
        )
        assert eb == {} and tl == {}


class TestReasoningEffort:
    """Explicit effort levels — catalog-driven, never a hardcoded vocabulary."""

    def test_supported_effort_sent_top_level(self):
        _seed(CATALOG)
        p = _profile()
        eb, tl = p.build_api_kwargs_extras(
            reasoning_config={"enabled": True, "effort": "high"}, model=EFFORT_MODEL
        )
        assert tl == {"reasoning_effort": "high"}
        assert eb == {}

    def test_effort_clamped_onto_catalog_values(self):
        # GLM-5.3's declared enum is low/high/max: "medium" isn't in it, so it
        # clamps to the nearest weaker declared level ("low") rather than
        # forwarding an out-of-enum string that would 422.
        _seed(CATALOG)
        p = _profile()
        _, tl = p.build_api_kwargs_extras(
            reasoning_config={"enabled": True, "effort": "medium"}, model=EFFORT_MODEL
        )
        assert tl == {"reasoning_effort": "low"}

    def test_toggle_only_model_gets_enable_thinking_true_for_any_effort(self):
        # DeepSeek-V3.2 publishes no effort enum, only a toggle — a positive
        # effort ask is honored as "thinking on", not forwarded as a guess.
        _seed(CATALOG)
        p = _profile()
        eb, tl = p.build_api_kwargs_extras(
            reasoning_config={"enabled": True, "effort": "high"}, model=TOGGLE_ONLY_MODEL
        )
        assert eb == {"chat_template_kwargs": {"enable_thinking": True}}
        assert tl == {}

    def test_budget_only_model_omits_unvalidated_effort(self):
        _seed(CATALOG)
        p = _profile()
        eb, tl = p.build_api_kwargs_extras(
            reasoning_config={"enabled": True, "effort": "high"}, model=BUDGET_ONLY_MODEL
        )
        assert eb == {} and tl == {}

    def test_enabled_true_no_effort_toggle_only_model_enables_thinking(self):
        _seed(CATALOG)
        p = _profile()
        eb, tl = p.build_api_kwargs_extras(
            reasoning_config={"enabled": True}, model=TOGGLE_ONLY_MODEL
        )
        assert eb == {"chat_template_kwargs": {"enable_thinking": True}}
        assert tl == {}

    def test_enabled_true_no_effort_on_effort_model_omits_everything(self):
        # Server default applies — mirrors the zai/custom profile precedent
        # of never forcing an effort level the user didn't ask for.
        _seed(CATALOG)
        p = _profile()
        eb, tl = p.build_api_kwargs_extras(
            reasoning_config={"enabled": True}, model=EFFORT_MODEL
        )
        assert eb == {} and tl == {}

    def test_non_reasoning_model_never_gets_effort(self):
        _seed(CATALOG)
        p = _profile()
        eb, tl = p.build_api_kwargs_extras(
            reasoning_config={"enabled": True, "effort": "high"}, model=NON_REASONING_MODEL
        )
        assert eb == {} and tl == {}

    def test_model_with_both_toggle_and_effort_prefers_effort_enum(self):
        # GLM-5.2 publishes both a toggle and a 2-level (high/max) effort
        # enum — the graded enum wins, and no chat_template_kwargs is sent
        # alongside the top-level field.
        _seed(CATALOG)
        p = _profile()
        eb, tl = p.build_api_kwargs_extras(
            reasoning_config={"enabled": True, "effort": "low"},
            model=TOGGLE_AND_EFFORT_MODEL,
        )
        assert tl == {"reasoning_effort": "high"}  # "low" is below its floor -> clamps to the floor ("high")
        assert eb == {}


class TestNoReasoningConfig:
    def test_no_config_omits_everything(self):
        _seed(CATALOG)
        p = _profile()
        for rc in (None, {}):
            eb, tl = p.build_api_kwargs_extras(reasoning_config=rc, model=EFFORT_MODEL)
            assert eb == {} and tl == {}

    def test_unknown_model_is_safe(self):
        _seed(CATALOG)
        p = _profile()
        eb, tl = p.build_api_kwargs_extras(
            reasoning_config={"enabled": True, "effort": "high"}, model="future-model-xyz"
        )
        assert eb == {} and tl == {}


class TestSupportedReasoningEfforts:
    """Tri-state contract from providers.base.ProviderProfile."""

    def test_effort_model_returns_declared_values(self):
        _seed(CATALOG)
        p = _profile()
        assert p.supported_reasoning_efforts(EFFORT_MODEL) == ("low", "high", "max")

    def test_non_reasoning_model_returns_empty_tuple(self):
        _seed(CATALOG)
        p = _profile()
        assert p.supported_reasoning_efforts(NON_REASONING_MODEL) == ()

    def test_toggle_only_model_returns_none(self):
        # Reasoning-capable but no graded effort enum published -> unknown,
        # not "no reasoning at all".
        _seed(CATALOG)
        p = _profile()
        assert p.supported_reasoning_efforts(TOGGLE_ONLY_MODEL) is None

    def test_cold_cache_returns_none(self):
        _seed(None)
        p = _profile()
        assert p.supported_reasoning_efforts(EFFORT_MODEL) is None


class TestInputModalities:
    """Full catalog metadata, with the native image declaration kept image-only."""

    PAYLOAD = [
        {"id": "test/vision", "input_modalities": ["text", "image"], "reasoning": False},
        {"id": "test/text", "input_modalities": ["text"], "reasoning": False},
        {"id": "test/video", "input_modalities": ["text", "image", "video"], "reasoning": False},
        {"id": "test/video-only", "input_modalities": ["text", "video"], "reasoning": False},
        {"id": "test/future", "input_modalities": ["text", "audio", "future-input"], "reasoning": False},
        {"id": "test/unknown", "reasoning": False},
    ]

    def test_fetch_models_publishes_exact_model_capabilities(self, monkeypatch, tmp_path):
        mod = _module()
        monkeypatch.setattr(mod, "_disk_path", lambda: tmp_path / "catalog.json")
        payload = self.PAYLOAD
        requests = []

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                requests.append(self.path)
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"data": payload}).encode())

            def log_message(self, *_args):
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            models = _profile().fetch_models(
                api_key="local-test-key",
                base_url=f"http://127.0.0.1:{server.server_port}/v1",
            )
        finally:
            server.shutdown()
            server.server_close()
            thread.join()

        assert models == [item["id"] for item in payload]
        assert requests == ["/v1/models"]
        assert _profile().model_capabilities == {
            "test/vision": {"supports_vision": True},
            "test/text": {"supports_vision": False},
            "test/video": {"supports_vision": True},
            "test/video-only": {"supports_vision": False},
            "test/future": {"supports_vision": False},
        }
        self._assert_routing(monkeypatch)

    def test_every_modality_round_trips_without_a_fixed_vocabulary(self, monkeypatch, tmp_path):
        mod = _module()
        path = tmp_path / "catalog.json"
        monkeypatch.setattr(mod, "_disk_path", lambda: path)
        mod._seed_catalog(self.PAYLOAD)
        expected = {
            item["id"]: tuple(item["input_modalities"])
            for item in self.PAYLOAD
            if "input_modalities" in item
        }
        assert {
            mid: entry["input_modalities"]
            for mid, entry in mod._catalog_cache.items()
            if "input_modalities" in entry
        } == expected
        disk = json.loads(path.read_text())
        assert {
            mid: tuple(entry["input_modalities"])
            for mid, entry in disk["catalog"].items()
            if "input_modalities" in entry
        } == expected
        mod._catalog_cache, mod._disk_checked = None, False
        restored = mod._catalog_cache_only()
        assert {
            mid: entry["input_modalities"]
            for mid, entry in restored.items()
            if "input_modalities" in entry
        } == expected
        assert _profile().model_capabilities["test/video-only"] == {"supports_vision": False}
        assert _profile().model_capabilities["test/video"] == {"supports_vision": True}

    @pytest.mark.parametrize("entries,expected", [
        ([("image", ["text", "image"]), ("video", ["text", "image", "video"])], "video"),
        ([("image", ["text", "image"])], "image"),
        ([("text", ["text"])], None),
        ([("image", ["text", "image"]), ("video", ["text", "video"])], None),
        ([("unknown", None)], None),
    ])
    def test_shared_media_default_requires_all_available_media(self, monkeypatch, tmp_path, entries, expected):
        from agent.auxiliary_client import _resolve_provider_vision_default

        mod = _module()
        monkeypatch.setattr(mod, "_disk_path", lambda: tmp_path / "catalog.json")
        mod._seed_catalog([
            {"id": mid, **({"input_modalities": modalities} if modalities is not None else {})}
            for mid, modalities in entries
        ])
        assert _profile().default_vision_model() == expected
        assert _resolve_provider_vision_default("friendli") == expected

    def test_auxiliary_preference_never_overrides_catalog_modalities(self, monkeypatch, tmp_path):
        mod = _module()
        monkeypatch.setattr(mod, "_disk_path", lambda: tmp_path / "catalog.json")
        preferred = _profile().default_aux_model
        mod._seed_catalog([
            {"id": "first-video", "input_modalities": ["text", "image", "video"]},
            {"id": preferred, "input_modalities": ["text", "image", "video"]},
        ])
        assert _profile().default_vision_model() == preferred
        mod._seed_catalog([
            {"id": preferred, "input_modalities": ["text", "image"]},
            {"id": "new-video", "input_modalities": ["text", "image", "video"]},
        ])
        assert _profile().default_vision_model() == "new-video"

    def test_cold_media_default_is_cache_only(self, monkeypatch):
        mod = _module()
        refreshes = []
        monkeypatch.setattr(mod, "_warm_catalog_async", lambda: refreshes.append(True))
        assert _profile().default_vision_model() is None
        assert refreshes == [True]

    @staticmethod
    def _assert_routing(monkeypatch):
        from agent import models_dev
        from agent.image_routing import decide_image_input_mode

        # Keep models.dev offline, but exercise its actual declaration merge.
        monkeypatch.setattr(models_dev, "_get_provider_models", lambda *_a, **_k: {})
        vision = models_dev.get_model_capabilities("friendli", "test/vision", config={})
        text = models_dev.get_model_capabilities("friendli", "test/text", config={})
        assert vision is not None and vision.supports_vision is True
        assert text is not None and text.supports_vision is False
        assert models_dev.get_model_capabilities("friendli", "test/unknown", config={}) is None
        assert decide_image_input_mode("friendli", "test/vision", {}) == "native"
        assert decide_image_input_mode("friendli", "test/text", {}) == "text"
        assert decide_image_input_mode("friendli", "test/unknown", {}) == "text"
        assert decide_image_input_mode("friendli", "test/video", {}) == "native"
        assert decide_image_input_mode("friendli", "test/video-only", {}) == "text"
        assert decide_image_input_mode("friendli", "test/future", {}) == "text"
        assert decide_image_input_mode("friendli", "test/vision-extra", {}) == "text"
        assert decide_image_input_mode(
            "friendli", "test/text", {"agent": {"image_input_mode": "native"}}
        ) == "native"
        assert _profile().supports_vision is False  # Separate tool-result media gate.

    @pytest.mark.parametrize("stale", [False, True])
    def test_disk_restore_preserves_vision_and_refresh_policy(self, monkeypatch, tmp_path, stale):
        mod = _module()
        path = tmp_path / "catalog.json"
        monkeypatch.setattr(mod, "_disk_path", lambda: path)
        mod._seed_catalog(self.PAYLOAD)
        if stale:
            data = json.loads(path.read_text())
            data["ts"] = 0
            path.write_text(json.dumps(data))
        mod._catalog_cache, mod._disk_checked = None, False
        _profile().model_capabilities = {}
        refreshes = []
        monkeypatch.setattr(mod, "_warm_catalog_async", lambda: refreshes.append(True))
        assert mod._catalog_cache_only() is not None
        assert refreshes == ([True] if stale else [])
        self._assert_routing(monkeypatch)

    def test_legacy_disk_cache_keeps_reasoning_and_requests_modality_refresh(self, monkeypatch, tmp_path):
        mod = _module()
        path = tmp_path / "catalog.json"
        path.write_text(json.dumps({"ts": mod.time.time(), "catalog": CATALOG}))
        monkeypatch.setattr(mod, "_disk_path", lambda: path)
        mod._catalog_cache, mod._disk_checked = None, False
        refreshes = []
        monkeypatch.setattr(mod, "_warm_catalog_async", lambda: refreshes.append(True))
        assert mod._catalog_cache_only() == CATALOG
        assert _profile().model_capabilities == {}
        assert _profile().supported_reasoning_efforts(EFFORT_MODEL) == ("low", "high", "max")
        assert refreshes == [True]

    @pytest.mark.parametrize("modalities", [None, "image", {"image": True}, [None, "image"]])
    def test_missing_or_malformed_modalities_do_not_declare_vision(self, monkeypatch, tmp_path, modalities):
        mod = _module()
        monkeypatch.setattr(mod, "_disk_path", lambda: tmp_path / "catalog.json")
        mod._seed_catalog([{"id": "unknown", "input_modalities": modalities}])
        assert _profile().model_capabilities == {}

    def test_refresh_replaces_removed_or_changed_models(self, monkeypatch, tmp_path):
        mod = _module()
        monkeypatch.setattr(mod, "_disk_path", lambda: tmp_path / "catalog.json")
        mod._seed_catalog(self.PAYLOAD)
        mod._seed_catalog([{"id": "test/vision", "input_modalities": ["text"]}])
        assert _profile().model_capabilities == {"test/vision": {"supports_vision": False}}

    def test_failed_refresh_preserves_last_known_capabilities(self, monkeypatch, tmp_path):
        mod = _module()
        monkeypatch.setattr(mod, "_disk_path", lambda: tmp_path / "catalog.json")
        mod._seed_catalog(self.PAYLOAD)
        monkeypatch.setattr(mod, "_fetch_catalog_items", lambda **_kwargs: None)
        assert _profile().fetch_models(api_key="local-test-key") is None
        self._assert_routing(monkeypatch)

    def test_explicit_user_capability_override_wins(self, monkeypatch, tmp_path):
        from agent import models_dev

        mod = _module()
        monkeypatch.setattr(mod, "_disk_path", lambda: tmp_path / "catalog.json")
        mod._seed_catalog(self.PAYLOAD)
        monkeypatch.setattr(models_dev, "_get_provider_models", lambda *_a, **_k: {})
        caps = models_dev.get_model_capabilities(
            "friendli",
            "test/vision",
            config={"model_overrides": {"friendli": {"test/vision": {"supports_vision": False}}}},
        )
        assert caps is not None and caps.supports_vision is False
