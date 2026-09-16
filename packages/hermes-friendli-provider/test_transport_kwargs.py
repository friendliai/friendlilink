"""End-to-end transport tests for the Friendli profile.

Exercises the real wiring this plugin rides on inside Hermes —
``ChatCompletionsTransport._build_kwargs_from_profile`` builds ``create()``
kwargs from the profile, and those kwargs go *verbatim* into
``client.chat.completions.create(**kwargs)``. The reported bug lived exactly
there: the profile returned ``reasoning_budget`` as a top-level kwarg, and
the OpenAI SDK's client-side signature check rejected it with

    Completions.create() got an unexpected keyword argument 'reasoning_budget'

before a single byte reached Friendli. These tests therefore don't just check
the profile's return shape — they feed the transport-built kwargs to the
actual OpenAI SDK client and assert both that the call is accepted and that
the serialized wire body still carries the same top-level JSON fields Friendli
was always meant to receive.

No network: ``create()`` is pointed at an ``httpx.MockTransport`` that
captures the serialized JSON body and returns a minimal valid completion.
"""

import inspect
import json
import sys

import httpx
import openai
import pytest

from agent.transports.chat_completions import ChatCompletionsTransport
from providers import get_provider_profile

FRIENDLI_BASE_URL = "https://api.friendli.ai/serverless/v1"
EFFORT_MODEL = "zai-org/GLM-5.3"  # catalog: effort low/high/max
TOGGLE_ONLY_MODEL = "deepseek-ai/DeepSeek-V3.2"  # catalog: toggle only

CATALOG = {
    EFFORT_MODEL: {"reasoning": True, "effort": ("low", "high", "max"), "toggle": False},
    TOGGLE_ONLY_MODEL: {"reasoning": True, "effort": (), "toggle": True},
}

_SDK_PARAMS = None


def _sdk_params():
    """Named parameters chat.completions.create() actually accepts."""
    global _SDK_PARAMS
    if _SDK_PARAMS is None:
        from openai.resources.chat import completions as _oc

        _SDK_PARAMS = set(inspect.signature(_oc.Completions.create).parameters) - {
            "self"
        }
    return _SDK_PARAMS


def _profile():
    p = get_provider_profile("friendli")
    assert p is not None, "profile 'friendli' not found — is the plugin discovered?"
    return p


@pytest.fixture(autouse=True)
def _isolated_catalog_cache():
    """Each test starts from a fixed catalog cache and restores it after."""
    mod = sys.modules[type(_profile()).__module__]
    saved_cache, saved_disk_checked = mod._catalog_cache, mod._disk_checked
    mod._catalog_cache, mod._disk_checked = CATALOG, True  # fixed; skip disk I/O
    try:
        yield
    finally:
        mod._catalog_cache, mod._disk_checked = saved_cache, saved_disk_checked


def _create_capturing_client():
    """OpenAI client whose create() serializes into a captured body dict."""
    captured = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.read())
        return httpx.Response(
            200,
            json={
                "id": "chatcmpl-test",
                "object": "chat.completion",
                "created": 0,
                "model": "zai-org/GLM-5.3",
                "choices": [
                    {
                        "index": 0,
                        "finish_reason": "stop",
                        "message": {"role": "assistant", "content": "42"},
                    }
                ],
                "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
            },
        )

    client = openai.OpenAI(
        api_key="mock",  # never leaves this process: MockTransport below
        base_url=FRIENDLI_BASE_URL,
        http_client=httpx.Client(transport=httpx.MockTransport(handler)),
    )
    return client, captured


def _build_transport_kwargs(reasoning_config, model):
    """Exactly the kwargs path a live Hermes turn uses for chat_completions."""
    return ChatCompletionsTransport().build_kwargs(
        model=model,
        messages=[{"role": "user", "content": "ping"}],
        tools=None,
        provider_profile=_profile(),
        reasoning_config=reasoning_config,
        base_url=FRIENDLI_BASE_URL,
        provider_name="friendli",
    )


class TestDisableSurvivesTheSdk:
    """The exact reported TypeError regression, end to end.

    Profile returns reasoning_budget=0 via extra_body -> transport assembles
    kwargs -> SDK accepts them -> wire JSON is unchanged.
    """

    def test_disable_kwargs_are_accepted_and_wire_body_unchanged(self):
        kwargs = _build_transport_kwargs({"enabled": False}, EFFORT_MODEL)

        # 1) Transport produced only kwargs the SDK signature accepts.
        unknown = set(kwargs) - _sdk_params()
        assert not unknown, f"non-SDK top-level kwargs would TypeError: {unknown}"

        # 2) The SDK accepts them and serializes the disable switch onto the
        #    wire body's top level, exactly like the pre-fix *intent*.
        client, captured = _create_capturing_client()
        client.chat.completions.create(**kwargs)  # TypeError pre-fix
        body = captured["body"]
        assert body.get("reasoning_budget") == 0
        assert body.get("chat_template_kwargs") == {"enable_thinking": False}
        assert "reasoning_effort" not in body
        assert body.get("extra_body") is None

    def test_disable_words_send_reasoning_budget_not_effort_none(self):
        for word in ("none", "false", "disabled"):
            kwargs = _build_transport_kwargs(
                {"enabled": True, "effort": word}, EFFORT_MODEL
            )
            unknown = set(kwargs) - _sdk_params()
            assert not unknown, f"{word}: non-SDK kwargs {unknown}"
            client, captured = _create_capturing_client()
            client.chat.completions.create(**kwargs)
            assert captured["body"].get("reasoning_budget") == 0, word
            assert captured["body"].get("chat_template_kwargs") == {"enable_thinking": False}, word
            assert "reasoning_effort" not in captured["body"], word

    def test_positive_control_old_mapping_still_crashes(self):
        """Negative control: this suite can fail.

        Feeding reasoning_budget as a *top-level* kwarg (what the profile
        returned pre-fix) must raise the reported TypeError through the very
        SDK this suite runs against — proving the acceptance assertions
        above are not vacuously passing on an inert signature.
        """
        client, _ = _create_capturing_client()
        with pytest.raises(TypeError, match="reasoning_budget"):
            client.chat.completions.create(
                model=EFFORT_MODEL,
                messages=[{"role": "user", "content": "ping"}],
                reasoning_budget=0,
            )


class TestEffortPathThroughTransport:
    """Named effort levels keep using SDK-blessed parameter names."""

    def test_effort_reaches_top_level_kwarg(self):
        kwargs = _build_transport_kwargs(
            {"enabled": True, "effort": "high"}, EFFORT_MODEL
        )
        assert kwargs["reasoning_effort"] == "high"
        unknown = set(kwargs) - _sdk_params()
        assert not unknown, f"non-SDK top-level kwargs: {unknown}"
        client, captured = _create_capturing_client()
        client.chat.completions.create(**kwargs)
        assert captured["body"].get("reasoning_effort") == "high"

    def test_toggle_only_model_uses_extra_body_enable_thinking(self):
        kwargs = _build_transport_kwargs(
            {"enabled": True, "effort": "high"}, TOGGLE_ONLY_MODEL
        )
        assert "reasoning_effort" not in kwargs
        eb = kwargs["extra_body"]
        assert eb == {"chat_template_kwargs": {"enable_thinking": True}}, kwargs
        client, captured = _create_capturing_client()
        client.chat.completions.create(**kwargs)
        assert captured["body"].get("chat_template_kwargs") == {"enable_thinking": True}


class TestNoReasoningConfigLeavesCleanWire:
    def test_unset_reasoning_sends_no_reasoning_fields(self):
        kwargs = _build_transport_kwargs(None, EFFORT_MODEL)
        client, captured = _create_capturing_client()
        client.chat.completions.create(**kwargs)
        body = captured["body"]
        assert "reasoning_budget" not in body
        assert "reasoning_effort" not in body
        assert "extra_body" not in body
