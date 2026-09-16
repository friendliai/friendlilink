"""Tests for the Friendli provider profile — style tests/providers/test_provider_profiles.py.

Usage (from ~/.hermes/hermes-agent with the venv):
    ./venv/bin/python -m pytest ~/.hermes/plugins/model-providers/friendli/tests/ -v

Provider registry discovery scans $HERMES_HOME/plugins/model-providers/ on
the first get_provider_profile() call, so the plugin loads automatically —
no manual import needed.

No live network calls: every test seeds the module's in-memory catalog
cache directly instead of hitting api.friendli.ai/serverless/v1/models.
"""

import sys

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
    mod._catalog_cache, mod._disk_checked = None, True  # skip disk I/O in tests
    try:
        yield
    finally:
        mod._catalog_cache, mod._disk_checked = saved_cache, saved_disk_checked


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
