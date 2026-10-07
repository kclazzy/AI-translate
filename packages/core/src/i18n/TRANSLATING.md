# Translating the interface

`keys.json` lists every interface string of AI Translate in Russian (the source language).
Each `locales/<code>.json` maps every Russian string to its translation:

```json
{ "Перевести страницу": "Translate page", "Готово {0} из {1}": "{0} of {1} done" }
```

Regenerate the list after changing the code: `node packages/core/scripts/i18n-extract.mjs`;
check that every locale is complete: `node packages/core/scripts/i18n-extract.mjs --check`.

## What the app is

A browser extension, phone app and desktop studio that translates manga, manhwa, webtoons and
comics: it finds the text on a picture with an AI model (local — Ollama, LM Studio — or cloud —
Claude, OpenAI, Gemini, DeepSeek, OpenRouter), erases the original lettering and writes the
translation into the speech bubbles. The interface is for ordinary readers, not programmers:
short, friendly, plain words.

## Rules

- Translate every key; the value must never be empty.
- Keep placeholders `{0}`, `{1}` … exactly (you may move them inside the sentence).
- Keep leading and trailing spaces, line breaks (`\n`), and the end punctuation style
  (`…`, `:`, `?`, `!`, `—`, `·`, arrows `→ ⇄ ↗`, emoji, `✓`).
- Do not translate product and model names, file formats, commands, environment variables,
  URLs and settings names typed by the user: AI Translate, Ollama, LM Studio, Claude, OpenAI,
  Gemini, DeepSeek, OpenRouter, Qwen, llama.cpp, vLLM, Chrome, Windows, GitHub, PDF, CBZ,
  EPUB, ZIP, PNG, JPG, API, JSON, CORS, VRAM, GPU, `OLLAMA_ORIGINS`, `setx`, `ollama pull` …
- Names of buttons quoted inside other strings («Сохранить», «Проверить подключение» …) must
  match how you translated those buttons; use the quotation marks normal for the language.
- «бабл» = speech bubble; «сканлейт» = scanlation; «вебтун» = webtoon; «манхва» = manhwa;
  «глава» = chapter; «модель» = AI model; «видеопамять» = video memory (VRAM);
  «движок» = engine (the optional local Python server); «студия» = studio; «глоссарий» = glossary.
- Where a Russian string says «на русский», the check is about the translation language:
  translate literally (it refers to Russian as the target).
- Short labels stay short (they sit on buttons and in narrow menus).
