# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

Fluência is a flashcard app for language learning, organized into **decks**. Each deck has a language, a CEFR level and an **objective** (e.g. "conseguir vaga de desenvolvedor Unity/VR no exterior"); Claude builds a **trail** of units from the objective and generates the cards of each unit. Users: Guilherme and Julia. Static site, no build step, deployed with **Firebase Hosting** (`firebase deploy --only hosting` → https://fluencia.web.app). GitHub Pages is off.

Design decisions from the owner (keep them):
- **Study is infinite.** No due dates, no end of session. The next card comes from a weighted draw (`js/selecao.js`).
- **Speaking is always optional.** Every mic feature has a button-only path.
- A card is a **target** (word, expression or ready phrase) plus a **phrase** that uses it; each new card must bring a new target.

## Running / developing

Plain HTML/CSS/ES modules. Serve the folder with any static server (`python -m http.server 5195`) — modules don't load from `file://`. No tests, no linter.

To test logged-in screens without a real account, use an import map that swaps `js/firebase.js` and `js/ia.js` for in-memory fakes (absolute URLs of the served files → fake modules, in an ignored `_teste/` folder). Don't commit the fakes.

## Architecture

- `index.html` — markup; views are `<section class="view">` toggled by `switchView()`.
- `css/styles.css` — all styling; tokens on `:root`.
- `js/app.js` — UI and state (`state` object), all screens.
- `js/firebase.js` — Firebase via REST, no SDK: login, **token refresh** (Secure Token API) with the session kept in `localStorage`, Realtime Database helpers. `meu(path)` = `/fluencia/users/{uid}` + path.
- `js/ia-pedidos.js` — every Claude request (system, messages, JSON schema, effort). Pure, no DOM: can be imported from Node to test prompts against the real API. `executar()` calls `client.beta.messages.create` with structured outputs and the server-side fallback.
- `js/ia.js` — browser Claude client (`@anthropic-ai/sdk` from jsDelivr, pinned version, `dangerouslyAllowBrowser`). Key read from `/fluencia/claudeKey`.
- `js/selecao.js` — card choice and mastery. Per card and mode: `m` (moving average of grades), `n`, `last`, `ok`. Weight = `0.2 + 2.5·(1−m) + 3·forgetting`, with a cooldown on recent cards and a brake on new cards.
- `js/voz.js` — browser speech: TTS (`speechSynthesis`), recognition (`SpeechRecognition`), own-voice recording (`MediaRecorder`), local word-level comparison.
- `sw.js` + `manifest.webmanifest` — installable PWA, network-first cache of the app shell. Bump `CACHE` when adding files.

### Database (shared project `basehub-135f5` — other apps live here too)

Everything of Fluência is under `/fluencia`. **Never touch other top-level nodes.**

- `/fluencia/claudeKey` — Claude API key (read: allowed emails only; write: console/CLI only).
- `/fluencia/users/{uid}/` — `Profile` (Nome, Historico, Prefs, UltimoNivel), `Decks/{id}` (Name, Language, Nivel, Objetivo, Contexto, Trilha[], UnidadeAtual, Cards), `Dias/{AAAA-MM-DD}` ({r, a, f, rm, ra}), `Conversas/{id}`, `Niveis/{id}`.
- `/fluencia/juntos/{uid}` — summary for the "Juntos" screen (name, streak, today, last 7 days, level, weakest targets, today's car script).

Rules: only the three emails listed in the rules can read or write `/fluencia`. The rules of the whole database are deployed from outside this repo (they include other apps' rules). To change the Fluência block, fetch the live rules first (`MSYS_NO_PATHCONV=1 firebase database:get "/.settings/rules"` in Git Bash), edit only `fluencia`, and deploy them with `firebase deploy --only database` from a scratch folder.

## UI conventions to preserve

- Confirmations use in-app modals (`confirmar()`), never `confirm()`/`alert()`.
- Async actions go through `acao(text, fn)` (loading overlay + toast on error).
- Escape every user or AI text with `esc()` before putting it in `innerHTML`.
- Fixed-height shell; only `.main` scrolls.
