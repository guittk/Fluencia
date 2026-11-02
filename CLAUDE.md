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

- `index.html` — markup; views are `<section class="view">` toggled by `irPara()`. Six tabs, in this order (his, plus Nível since 02/11/2026): Baralhos, Estudar, Erros, Nível, Conversar, Juntos. `v-nivel` is the level screen (current level, what is missing for each level, all 64 points by level, the flowchart, and the level test). `v-deck`, `v-you` (Você: stats and settings), `v-ponto` (one grammar point: his errors and the lesson) and `v-outro` (the other person's progress, read-only) are sub-screens opened as layers. Every screen starts with a sticky `.cab` header (title, one line of what it is, and on the right the level pill `[data-nvpill]` and the round Você button `[data-voce]`). The pill opens Nível.
- `css/styles.css` — all styling; tokens on `:root`. **Visual of the Córtex (Grafite), since 02/11/2026** (ES-22, he uses the app inside the Córtex): dark neutral `#0F1115`, one steel-blue accent `#6C9EF2` for active/primary, and colour only for state — green dominated/right, yellow almost/next level, red error/training, orange missing data. Inter for text, JetBrains Mono for numbers and codes. Same building blocks as the Córtex screens: `.cab`, `.kpis/.kpi`, `.card/.card-t`, rows with a coloured left bar (`.ponto-row`), `.seg` tabs. Mobile first (bottom tab bar); from 900px the tab bar becomes a top bar. The "Embarque" airport look (14/10–01/11/2026) is gone.
- `js/app.js` — UI and state (`state` object), all screens.
- `js/firebase.js` — Firebase via REST, no SDK: login, **token refresh** (Secure Token API) with the session kept in `localStorage`, Realtime Database helpers. `meu(path)` = `/fluencia/users/{uid}` + path.
- `js/ia-pedidos.js` — every Claude request (system, messages, JSON schema, effort). Pure, no DOM: can be imported from Node to test prompts against the real API. `executar()` calls `client.beta.messages.create` with structured outputs and the server-side fallback.
- `js/ia.js` — browser Claude client (`@anthropic-ai/sdk` from jsDelivr, pinned version, `dangerouslyAllowBrowser`). Key read from `/fluencia/claudeKey`.
- `js/catalogo.js` — the **fixed catalog of grammar points** (A1–C1 plus `X-estrutura-pt`, "sentence built from Portuguese"), the vocabulary goal per level, and the ES-16 seed (his placement test of 01/11/2026). Every error, from any screen, is classified by the AI into one id of this list (enum in the schema), so errors add up. English decks only (`P.classifica(deck)`). Ids use `-`, never `.` (Firebase keys).
- `js/erros.js` — pure: point state (presumido, shown as "Sabido"; nao-medido, treinando, quase, dominado), error and training updates, the point draw for exercises, and the **régua** (per level: 50% grammar, 25% vocabulary, 25% use; a level is yours from 70% with all below also ≥ 70%). `faltaNivel()` turns a level into what is missing: points to dominate (biggest gains first), cards to learn and sentences to produce, with each part at 70% as the reference path. Dominado = m ≥ 0.7, correct on 3 different days, no error in the last 7.
- `js/selecao.js` — card choice and mastery. Per card and mode: `m` (moving average of grades), `n`, `last`, `ok`. Weight = `0.2 + 2.5·(1−m) + 3·forgetting`, with a cooldown on recent cards and a brake on new cards.
- `js/voz.js` — browser speech: TTS (`speechSynthesis`), recognition (`SpeechRecognition`), own-voice recording (`MediaRecorder`), local word-level comparison.
- `sw.js` + `manifest.webmanifest` — installable PWA, network-first cache of the app shell. Bump `CACHE` when adding files.

### Database (shared project `basehub-135f5` — other apps live here too)

Everything of Fluência is under `/fluencia`. **Never touch other top-level nodes.**

- `/fluencia/claudeKey` — Claude API key (read: allowed emails only; write: console/CLI only).
- `/fluencia/users/{uid}/` — `Profile` (Nome, Historico, Prefs, UltimoNivel), `Decks/{id}` (Name, Language, Nivel, Objetivo, Contexto, Trilha[], UnidadeAtual, Cards), `Dias/{AAAA-MM-DD}` ({r, a, f, rm, ra}), `Conversas/{id}`, `Niveis/{id}`.
- `/fluencia/users/{uid}/` (ES-22) — `Pontos/{id}` ({m, n, ok, last, dias, erros, ult}), `Erros/{id}` ({p, o, c, e, f: fonte, d}), `Producao/{id}` ({d, f, p: {pontoId: 1}}: one sentence he produced, the base of "use"; keys `p` + base36 time, queried from the last 40 days), `Exercicios/{ponto}` ({itens, i}), `Aulas/{ponto}`, `Profile.Base` (starting level of the régua) and `Profile.SementeES16`, `Dias/{d}.w` (Escrever done 1 / skipped 2).
- `/fluencia/juntos/{uid}` — summary for the "Juntos" screen (name, streak, today, last 7 days, level, weakest targets, today's car script) and, since ES-22, `Regua`, `Pontos` (errors per point, last example), `Fracos3` and `Stats`. **Each user can only read their own `users/{uid}`**, so everything the other person sees goes through here.

Rules: only the two emails listed in the rules (Guilherme and Julia) can read or write `/fluencia`. The rules of the whole database are deployed from outside this repo (they include other apps' rules). To change the Fluência block, fetch the live rules first (`MSYS_NO_PATHCONV=1 firebase database:get "/.settings/rules"` in Git Bash), edit only `fluencia`, and deploy them with `firebase deploy --only database` from a scratch folder.

## Fluência 3 (ES-22, approved 01/11/2026)

- **Estudar has three entries** (the chip): Tudo (all decks + one point exercise every 3 cards + the daily "Escrever 3 frases"), one deck, or Meus erros (only exercises). "Treinar só este" in a lesson sets `state.pontoTreino`. `state.atual` is `{tipo: "card"|"ex"|"escrever", …}`.
- Exercises come in batches of 10 per point from the AI (`pedidoExercicios`), saved and consumed in order; in Tudo, while a batch is being generated (one point at a time), a card is shown instead.
- Errors enter from Produzir, each Conversa turn, the Nível test, Escrever and "Falar 2 minutos" (a Conversar scenario, continuous speech recognition).
- Native `<select>`s stay hidden as the value source; `enfeitar(sel)` draws pills (≤ 4 options) or an inline list. Checkboxes are drawn as switches by CSS.
- The Córtex (`D:\Cortex-Pessoal-front`) opens https://fluencia.web.app/ in its sheet (Acervo group); the iframe allows the microphone.

## UI conventions to preserve

- **Layers close with the back button.** Sheets, the chat room, sub-screens and car mode go through `abrirCamada()` (pushes history) and close with `fecharCamada()`; never hide them directly.
- Bottom sheets (`abrirFolha()`) replace modals; `confirmar()` is a sheet.
- The study card: tap flips, horizontal drag (after the back was seen) answers — right Acertei, left Errei. The four grade buttons stay fixed above the tab bar.
- Phrases render through `painel()`: clean text, the target highlighted, words fading in one by one, a real space between words; animations respect `prefers-reduced-motion`.
- AI waits use the top pill (`acao()`/`ocupado()`) or skeletons, never a full-screen overlay.

- Never `confirm()`/`alert()`.
- Async actions go through `acao(text, fn, button)` (busy pill, disables the button, toast on error).
- Escape every user or AI text with `esc()` before putting it in `innerHTML`.
- Fixed-height shell; only `.main` scrolls.
