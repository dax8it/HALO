from __future__ import annotations

from typing import Any, cast

from engine.agents.prompt_caching import (
    CACHE_CONTROL_EPHEMERAL,
    as_cached_system_message,
)


def _as_dict(message: object) -> dict[str, Any]:
    """The helper returns a typed ``ChatCompletionSystemMessageParam`` whose
    ``cache_control`` field is intentionally not part of the OpenAI TypedDict
    schema. Tests drop back to ``dict[str, Any]`` to inspect the literal wire
    shape without fighting the type system."""
    return cast(dict[str, Any], message)


def test_as_cached_system_message_shape() -> None:
    msg = _as_dict(as_cached_system_message("hello prefix"))

    assert msg["role"] == "system"
    assert isinstance(msg["content"], list)
    assert len(msg["content"]) == 1

    block = msg["content"][0]
    assert block["type"] == "text"
    assert block["text"] == "hello prefix"
    assert block["cache_control"] == {"type": "ephemeral"}


def test_as_cached_system_message_preserves_prefix_bytes() -> None:
    """Cache hit on Anthropic requires byte-identical prefixes across calls,
    so the helper must surface ``text`` exactly as passed (no normalization,
    no trimming, no implicit join)."""
    quirky = "  line one\n\nline two\t\n"

    msg = _as_dict(as_cached_system_message(quirky))

    assert msg["content"][0]["text"] == quirky


def test_cache_control_ephemeral_constant_matches_anthropic_shape() -> None:
    """Anthropic's prompt-caching API only ships ``ephemeral`` today. Pinning
    the constant guards against accidental drift in a hot path that ships on
    every system message."""
    assert CACHE_CONTROL_EPHEMERAL == {"type": "ephemeral"}
