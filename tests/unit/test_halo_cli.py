from __future__ import annotations

import pytest
import typer
from typer.testing import CliRunner

from halo_cli.main import _make_config, _parse_headers, cli


def test_help_exposes_provider_and_model_flags_without_no_telemetry() -> None:
    result = CliRunner().invoke(cli, ["--help"])

    assert result.exit_code == 0
    assert "--base-url" in result.output
    assert "--api-key" in result.output
    assert "-H, --header" in result.output
    assert "--default-header" not in result.output
    assert "--temperature" in result.output
    assert "--max-output-tokens" in result.output
    assert "--parallel-tool-calls / --no-parallel-tool-calls" in result.output
    assert "--telemetry" in result.output
    assert "--no-telemetry" not in result.output


def test_make_config_threads_cli_options_into_engine_config() -> None:
    cfg = _make_config(
        model="claude-opus-4-7",
        max_depth=3,
        max_turns=12,
        max_parallel=5,
        temperature=0.2,
        max_output_tokens=1024,
        parallel_tool_calls=False,
        reasoning_effort="low",
        refusal_retries=2,
        base_url="https://api.anthropic.com/v1/",
        api_key="sk-ant-test",
        default_headers={"anthropic-beta": "tools-2025-01-01"},
    )

    assert cfg.maximum_depth == 3
    assert cfg.maximum_parallel_subagents == 5
    assert cfg.root_agent.maximum_turns == 12
    assert cfg.subagent.maximum_turns == 12
    assert cfg.root_agent.refusal_retries == 2
    assert cfg.subagent.refusal_retries == 2
    assert cfg.model_provider.base_url == "https://api.anthropic.com/v1/"
    assert cfg.model_provider.api_key == "sk-ant-test"
    assert cfg.model_provider.default_headers == {"anthropic-beta": "tools-2025-01-01"}

    for model in (cfg.root_agent.model, cfg.subagent.model, cfg.synthesis_model):
        assert model.name == "claude-opus-4-7"
        assert model.temperature == 0.2
        assert model.maximum_output_tokens == 1024
        assert model.parallel_tool_calls is False
        assert model.reasoning_effort == "low"

    assert cfg.compaction_model.name == "claude-opus-4-7"
    assert cfg.compaction_model.temperature == 0.2
    assert cfg.compaction_model.maximum_output_tokens == 1024
    assert cfg.compaction_model.parallel_tool_calls is False
    assert cfg.compaction_model.reasoning_effort is None


def test_parse_headers() -> None:
    assert _parse_headers(
        [
            "HTTP-Referer: https://example.com",
            "X-Title: HALO",
        ]
    ) == {
        "HTTP-Referer": "https://example.com",
        "X-Title": "HALO",
    }


def test_parse_headers_rejects_invalid_header() -> None:
    with pytest.raises(typer.BadParameter):
        _parse_headers(["X-Title=HALO"])
