# HALO CLI

This package contains the `halo` console entry point registered in `pyproject.toml`.
It is a thin Typer wrapper around the engine API:

- Parses CLI arguments and environment-backed provider settings.
- Builds an `EngineConfig` from those arguments.
- Calls `stream_engine_async` over a JSONL trace file.
- Renders streaming text deltas and completed agent output items to stdout.

User-facing installation, usage, options, and telemetry docs live in the root
[`README.md`](../README.md).

## Code Layout

`main.py` intentionally keeps the CLI small. The engine owns behavior; the CLI only
maps shell arguments to existing config objects.

Tests for argument parsing and config wiring live in `tests/unit/test_halo_cli.py`.
