# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

Fluência is a single-page flashcard app (spaced repetition) for language learning, organized into **decks** — each deck has its own study language and a theme that steers AI-generated phrases (e.g. "Inglês" + "trabalho no exterior"). It's a static site with no build step, deployed via GitHub Pages (`CNAME` → `fluencia.guilherme-oliveira.com`; pushing to the default branch is the deployment mechanism).

## Running / developing

There is no package manager, build tool, linter, or test suite — it's plain HTML/CSS/JS.

- Open `index.html` directly in a browser, or serve the directory with any static file server, to test changes.
- Verify changes manually in a browser: check the console for errors and exercise the login → decks → study → stats flows. `fetch` calls to Firebase/OpenAI need real network access, so `file://` mostly works but some flows are easier to test over `http://`.

## Architecture

The entire app is 3 files:

- `index.html` — structure/markup only.
- `css/styles.css` — all styling; theme tokens (colors, radii, fonts) are CSS custom properties on `:root`.
- `js/app.js` — all logic, wrapped in a single IIFE (`"use strict"`), no modules/bundler/framework.

**State & rendering**: all app state lives in an in-memory `state` object inside the IIFE closure (decks, current deck, pending words, audio cache, etc.). The DOM is manipulated directly via a `$(id)` helper (`document.getElementById`) and manual `innerHTML` templating — always run user-provided text through `escapeHtml()` before interpolating into a template string.

**Views**: each `<section class="view">` in `index.html` is toggled via `switchView(viewId)`, which adds `.active` and updates sidebar nav highlighting. Views: `view-study`, `view-decks`, `view-deck-detail` (reached by opening a deck, not a direct nav item), `view-stats`, `view-settings`.

**Backend — Firebase, called via raw REST (no SDK)**:
- Auth: Identity Toolkit REST endpoints for login/signup/password reset — `authRequest()`.
- Data: Realtime Database REST (`dbGet`/`dbPut`/`dbPatch`/`dbDelete`), authenticated via an `?auth={idToken}` query param appended in `buildUrl()`.
- Data model: `/users/{uid}/Profile` and `/users/{uid}/Decks/{deckId}` → `{ Name, Language, Theme, CreatedAt, UpdatedAt, Cards: { wordKey: card } }`. A card is `{ Word, Phrase, Translation, ScoreHits, TotalHits, CorrectHits, CorrectPlusHits, WarningHits, WrongHits, History[] }`.
- The OpenAI API key is **not** hardcoded — it's fetched once from `/openAiKey` in the Realtime Database on app entry (`ensureOpenAiKey()`, called in parallel with deck loading in `enterApp()`) and cached in the closure variable `openaiApiKey`. Always `await ensureOpenAiKey()` before an OpenAI call rather than reading `openaiApiKey` directly — the old fire-and-forget version had a bug where the very first AI action of a session would fail.

**OpenAI**: called directly from the client — `openaiChat()` (chat completions, for phrase generation/suggestions/theme changes) and `playCardAudio()` (TTS for pronunciation). Every prompt builder (`promptGenerateCards`, `promptSuggestTenWords`, `promptRefreshCard`, `promptChangeTheme`) takes the current `deck` and includes its `Language`/`Theme` so generated content matches the deck's context.

**Scoring**: `pickNextCard()` picks the next card with probability inversely weighted by `ScoreHits` (less-known cards shown more often). `answerCard()` updates `ScoreHits`/`TotalHits`/`History` based on which answer button was pressed (Errei / Quase / Acertei / Fácil).

**UI conventions to preserve when editing**:
- Confirmations and blocking dialogs use in-app modals (`#deck-modal`, `#theme-modal`, `#confirm-modal` + the `showConfirm()` promise-based helper) — never native `confirm()`/`alert()`.
- `#loading-overlay` has a higher `z-index` than modals on purpose, so `showLoading()`/`hideLoading()` blocks all interaction — including clicks inside an already-open modal — during any async action. Wrap async actions in `showLoading()`/`hideLoading()` rather than only disabling individual buttons.
- The app shell is a fixed-height layout (`body { height:100vh; overflow:hidden }`); only `.main` scrolls internally, so the sidebar never scrolls with page content. Don't reintroduce document-level scrolling.
- `localStorage` (`fluencia:lastDeck`) remembers the last-studied deck across sessions.
