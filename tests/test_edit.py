"""Tests for tools.edit — workflow injection (no server needed)."""

from __future__ import annotations

import pytest

from tools.edit import (
    _RESTORE_LORA_NAME,
    _RESTORE_PROMPT_PREFIX,
    build_workflow,
    load_workflow,
    resolve_workflow,
    EditError,
)


@pytest.fixture
def wf():
    return load_workflow()


def test_resolve_workflow_all_titles_present(wf):
    nodes = resolve_workflow(wf)
    for t in ["Load Image (URL/Path)", "Prompt", "KSampler", "Power Lora Loader (rgthree)"]:
        assert t in nodes


def test_build_workflow_edit_filename(wf):
    built, meta = build_workflow(
        wf, image="ComfyUI_prev_00001_.png", mode="edit", prompt="make it green", steps=8, seed=5
    )
    nodes = resolve_workflow(built)
    img = nodes["Load Image (URL/Path)"]["inputs"]
    assert img["source"] == "temp"
    assert img["image"] == "ComfyUI_prev_00001_.png"
    assert nodes["Prompt"]["inputs"]["value"] == "make it green"
    assert nodes["KSampler"]["inputs"]["seed"] == 5
    assert nodes["KSampler"]["inputs"]["steps"] == 8
    assert meta["mode"] == "edit"
    assert meta["restore_lora"] is False


def test_build_workflow_edit_url(wf):
    built, _ = build_workflow(
        wf, image="https://example.com/img.png", mode="edit", prompt="x"
    )
    nodes = resolve_workflow(built)
    img = nodes["Load Image (URL/Path)"]["inputs"]
    assert img["source"] == "url"
    assert img["url"] == "https://example.com/img.png"
    assert "image" not in img
    assert "Choose file to upload" not in img


def test_build_workflow_steps_default(wf):
    built, meta = build_workflow(wf, image="ComfyUI_prev_00001_.png", prompt="x", steps=0)
    nodes = resolve_workflow(built)
    # steps 0 = keep workflow default (6)
    assert nodes["KSampler"]["inputs"]["steps"] == 6
    assert meta["steps"] == 0


def test_build_workflow_restore(wf):
    built, meta = build_workflow(wf, image="ComfyUI_prev_00001_.png", mode="restore")
    nodes = resolve_workflow(built)
    # restoration prompt prefix
    assert nodes["Prompt"]["inputs"]["value"] == _RESTORE_PROMPT_PREFIX
    # restore LoRA appended last
    loader = nodes["Power Lora Loader (rgthree)"]["inputs"]
    assert loader["lora_1"]["on"] is True
    assert loader["lora_1"]["lora"] == _RESTORE_LORA_NAME
    assert meta["restore_lora"] is True


def test_build_workflow_restore_with_prompt(wf):
    built, _ = build_workflow(wf, image="ComfyUI_prev_00001_.png", mode="restore", prompt="keep the colors")
    nodes = resolve_workflow(built)
    assert nodes["Prompt"]["inputs"]["value"] == _RESTORE_PROMPT_PREFIX + " keep the colors"


def test_build_workflow_restore_loras_before_restore_lora(wf):
    built, _ = build_workflow(
        wf,
        image="ComfyUI_prev_00001_.png",
        mode="restore",
        lora_config='["user1.sft"]',
    )
    loader = resolve_workflow(built)["Power Lora Loader (rgthree)"]["inputs"]
    assert loader["lora_1"]["lora"] == "user1.sft"
    assert loader["lora_2"]["lora"] == _RESTORE_LORA_NAME
    assert loader["lora_2"]["on"] is True


def test_build_workflow_validations(wf):
    with pytest.raises(EditError):
        build_workflow(wf, image="", prompt="x")
    with pytest.raises(EditError):
        build_workflow(wf, image="a.png", mode="bogus")
    with pytest.raises(EditError):
        build_workflow(wf, image="a.png", prompt="x", steps=99)


def test_deep_copy_not_mutating_source(wf):
    built, _ = build_workflow(wf, image="ComfyUI_prev_00001_.png", prompt="x", seed=3, steps=9)
    assert wf["227"]["inputs"]["seed"] == 963880637461774  # original untouched
    assert built["227"]["inputs"]["seed"] == 3
