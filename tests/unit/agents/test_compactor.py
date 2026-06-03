from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from engine.agents.agent_context_items import AgentContextItem
from engine.agents.compactor import compact
from engine.agents.prompt_templates import COMPACTION_SYSTEM_PROMPT
from engine.model_config import ModelConfig


def _stub_client_returning(text: str) -> SimpleNamespace:
    return SimpleNamespace(
        chat=SimpleNamespace(
            completions=SimpleNamespace(
                create=AsyncMock(
                    return_value=SimpleNamespace(
                        choices=[SimpleNamespace(message=SimpleNamespace(content=text))]
                    )
                )
            )
        )
    )


@pytest.mark.asyncio
async def test_compact_returns_stripped_summary_text() -> None:
    fake_client = _stub_client_returning("  compacted summary  \n")

    item = AgentContextItem(
        item_id="ctx-aaaa",
        role="user",
        content="please summarize this turn",
    )

    summary = await compact(
        client=fake_client,  # type: ignore[arg-type]
        compaction_model=ModelConfig(name="claude-haiku-4-5"),
        item=item,
    )

    assert summary == "compacted summary"
    fake_client.chat.completions.create.assert_awaited_once()


@pytest.mark.asyncio
async def test_compact_marks_system_prefix_cacheable() -> None:
    """Compaction is the highest-frequency LLM call in HALO, so its byte-
    stable system prefix must carry the Anthropic ``cache_control`` hint
    or every turn re-pays the full input-token cost (INF-3300)."""
    fake_client = _stub_client_returning("ok")

    item = AgentContextItem(
        item_id="ctx-aaaa",
        role="user",
        content="please summarize this turn",
    )

    await compact(
        client=fake_client,  # type: ignore[arg-type]
        compaction_model=ModelConfig(name="claude-opus-4-7"),
        item=item,
    )

    call_kwargs = fake_client.chat.completions.create.await_args.kwargs
    messages = call_kwargs["messages"]

    system = messages[0]
    assert system["role"] == "system"
    assert system["content"] == [
        {
            "type": "text",
            "text": COMPACTION_SYSTEM_PROMPT,
            "cache_control": {"type": "ephemeral"},
        }
    ]

    # Per-call dynamic content lives in the user message so the prefix
    # stays byte-stable across calls.
    user = messages[1]
    assert user["role"] == "user"
    assert isinstance(user["content"], str)
    assert "please summarize this turn" in user["content"]


@pytest.mark.asyncio
async def test_compact_omits_temperature_when_unset() -> None:
    """Frontier models reject ``temperature`` as deprecated; the compactor
    must forward it only when explicitly configured."""
    from openai import Omit

    fake_client = _stub_client_returning("ok")

    item = AgentContextItem(item_id="ctx-aaaa", role="user", content="x")

    await compact(
        client=fake_client,  # type: ignore[arg-type]
        compaction_model=ModelConfig(name="claude-opus-4-7"),
        item=item,
    )

    call_kwargs = fake_client.chat.completions.create.await_args.kwargs
    assert isinstance(call_kwargs["temperature"], Omit)


@pytest.mark.asyncio
async def test_compact_forwards_explicit_temperature() -> None:
    fake_client = _stub_client_returning("ok")

    item = AgentContextItem(item_id="ctx-aaaa", role="user", content="x")

    await compact(
        client=fake_client,  # type: ignore[arg-type]
        compaction_model=ModelConfig(name="claude-haiku-4-5", temperature=0.2),
        item=item,
    )

    call_kwargs = fake_client.chat.completions.create.await_args.kwargs
    assert call_kwargs["temperature"] == 0.2
