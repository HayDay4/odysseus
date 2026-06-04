"""Regression test: OpenAI-style {"name","arguments"} function-call JSON parsing.

qwen2.5:7b and many Ollama models emit tool calls as OpenAI function-call JSON
rather than the fenced ```web_search form. Before Pattern 6, the agent loop never
executed them — the model printed the call as text and stopped (web search appeared
"broken"). These tests pin the fallback's behavior, including the safety gates.
"""
import src.agent_tools  # noqa: F401  — import first to avoid the tool_parsing circular import
from src.tool_parsing import parse_tool_blocks, strip_tool_blocks


def _types(text):
    return [(b.tool_type, b.content) for b in parse_tool_blocks(text)]


def test_qwen_exact_live_output_executes():
    # The literal text qwen produced in the live UI that did NOT execute pre-fix.
    t = ('Let\'s proceed with this search.\n```\n'
         '{ "name": "web_search", "arguments": { "query": "Anthropic Claude Opus 4.8 release", '
         '"time_filter": "day" } }\n```')
    blocks = parse_tool_blocks(t)
    assert len(blocks) == 1
    assert blocks[0].tool_type == "web_search"
    assert blocks[0].content == "Anthropic Claude Opus 4.8 release"


def test_strip_removes_executed_json_call():
    t = 'Let\'s search.\n```\n{"name":"web_search","arguments":{"query":"x"}}\n```'
    assert strip_tool_blocks(t) == "Let's search."


def test_bare_json_no_fence():
    assert _types('{"name":"bash","arguments":{"command":"ls -la"}}') == [("bash", "ls -la")]


def test_function_wrapper_form():
    t = '{"type":"function","function":{"name":"bash","arguments":{"command":"pwd"}}}'
    assert _types(t) == [("bash", "pwd")]


def test_web_fetch_yields_bare_url():
    # Regression: the converter lacked a web_fetch branch, so qwen's web_fetch
    # passed {"url":…} instead of the URL → broken for local models.
    t = '```\n{"name":"web_fetch","arguments":{"url":"https://example.com/docs"}}\n```'
    assert _types(t) == [("web_fetch", "https://example.com/docs")]


def test_established_fenced_format_still_wins():
    assert _types('```web_search\nhello world\n```') == [("web_search", "hello world")]


def test_bash_block_takes_priority_over_incidental_json():
    # A real ```bash block wins; the JSON inside it is NOT a competing tool call.
    blocks = parse_tool_blocks('```bash\necho {"name":"web_search"}\n```')
    assert [b.tool_type for b in blocks] == ["bash"]


def test_non_tool_json_does_not_execute():
    # JSON that happens to have name/arguments but isn't a real tool → ignored.
    assert parse_tool_blocks('data: {"name":"Diego","arguments":{"role":"admin"}}') == []


def test_unknown_tool_name_ignored():
    assert parse_tool_blocks('{"name":"frobnicate","arguments":{"x":1}}') == []


def test_no_false_positive_on_plain_text():
    assert parse_tool_blocks("I will search the web for you now.") == []


if __name__ == "__main__":
    import pytest
    raise SystemExit(pytest.main([__file__, "-v"]))
