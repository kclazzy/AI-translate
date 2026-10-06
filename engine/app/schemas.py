"""Pydantic models mirroring packages/core/src/types.ts (camelCase on the wire)."""
from __future__ import annotations

from typing import Any, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

TextType = Literal["DIALOGUE", "NARRATION", "SFX", "SIGN", "OTHER"]


class Camel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="ignore")

    def dump(self) -> dict[str, Any]:
        return self.model_dump(by_alias=True, exclude_none=True)


class ProviderConfig(Camel):
    id: str = "provider"
    label: str = "provider"
    kind: Literal["openai-compatible", "anthropic"] = "openai-compatible"
    preset: str = "custom"
    base_url: str
    model: str
    api_key: Optional[str] = None
    vision: bool = False
    json_mode: Literal["json_object", "none"] = "none"
    price_input: Optional[float] = None
    price_output: Optional[float] = None
    timeout_ms: Optional[int] = None
    max_output_tokens: Optional[int] = None
    temperature: Optional[float] = None
    no_thinking: Optional[bool] = None


class PromptProfile(Camel):
    id: str = "natural"
    name: str = ""
    custom_prompt: str = ""
    honorifics: Literal["keep", "adapt", "drop"] = "adapt"
    names: Literal["transliterate", "keep-original", "adapt"] = "transliterate"
    sfx: Literal["translate", "keep"] = "translate"
    sfx_style: Literal["original", "translated", "small", "large", "artistic"] = "translated"
    tone: str = ""


class GlossaryEntry(Camel):
    id: str = ""
    source: str
    target: str
    match_mode: Literal["exact", "regex"] = "exact"
    case_sensitive: bool = False
    forbidden: list[str] = Field(default_factory=list)
    note: Optional[str] = None
    enabled: bool = True


class ContextEntity(Camel):
    source: str
    target: str
    kind: str = "term"
    gender: Optional[str] = None
    pronouns: Optional[str] = None
    speech_style: Optional[str] = None
    locked: bool = False


class TranslationContext(Camel):
    id: str = ""
    title: str = ""
    entities: list[ContextEntity] = Field(default_factory=list)
    summaries: list[str] = Field(default_factory=list)
    recent_lines: list[dict[str, str]] = Field(default_factory=list)
    style_notes: str = ""
    pages_seen: int = 0


class TranslateOptions(Camel):
    source_lang: str = "auto"
    target_lang: str = "ru"
    quality: Literal["fast", "balanced", "best"] = "balanced"
    privacy: Literal["local", "hybrid", "cloud"] = "hybrid"
    profile: PromptProfile = Field(default_factory=PromptProfile)
    glossary: list[GlossaryEntry] = Field(default_factory=list)
    context: Optional[TranslationContext] = None
    translate_sfx: bool = True
    sfx_style: Literal["original", "translated", "small", "large", "artistic"] = "translated"
    translator: Optional[ProviderConfig] = None
    vision: Optional[ProviderConfig] = None
    detector: Literal["auto", "classic", "ctd", "vision"] = "auto"
    ocr: Literal["auto", "vision", "manga-ocr", "paddle"] = "auto"
    inpainter: Literal["auto", "fill", "telea", "lama"] = "auto"


class BubbleInfo(Camel):
    box: list[int]
    fill: str
    safe_area: list[int]
    shape: Literal["ellipse", "rect"] = "rect"


class TextBlock(Camel):
    id: str
    text_type: TextType = "DIALOGUE"
    original_text: str = ""
    translated_text: str = ""
    confidence: float = 0.0
    language: str = "und"
    bbox: list[int]
    polygon: list[list[int]] = Field(default_factory=list)
    orientation: float = 0
    writing_direction: Literal["ltr", "ttb-rl"] = "ltr"
    font_size_estimate: int = 0
    bubble: Optional[BubbleInfo] = None
    translate: bool = True
    low_confidence: Optional[bool] = None


class Usage(Camel):
    provider: str
    model: str
    input_tokens: int = 0
    output_tokens: int = 0
    cost_usd: float = 0.0
