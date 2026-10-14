import * as fb from "./firebase.js";
import { pedir } from "./ia.js";
import * as P from "./ia-pedidos.js";
import { MODOS, sortear, registrarResposta, estadoModo, dominio, lacuna, hojeLocal, sequencia } from "./selecao.js";
import * as voz from "./voz.js";

const { IDIOMAS, NIVEIS, MAX_CARD_LEVEL, idiomaLabel } = P;
const EVOLVE_STREAK_THRESHOLD = 5;

// =========================================================
// ESTADO
// =========================================================
const state = {
  perfil: {},          // /Profile — Nome, Historico, Prefs
  decks: {},           // deckId -> deck
  dias: {},            // AAAA-MM-DD -> { r, a, f, rm, ra }
  currentDeckId: null,
  detailDeckId: null,
  statsDeckId: "all",
  atual: null,         // { key, modo }
  virado: false,
  lote: [],            // cards gerados esperando aprovação
  loteDeckId: null,
  editCardKey: null,
  deckModalMode: null,
  deckModalEditId: null,
  gravacaoUrl: null,
  conversa: null,
  teste: null,
  juntos: {},
};

const prefs = () => Object.assign(
  { modos: ["rec", "prod", "ouv", "comp"], voz: "", lento: 0.7, autoplay: false },
  state.perfil.Prefs || {}
);

// =========================================================
// DOM
// =========================================================
const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

let toastTimer = null;
function toast(msg){
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 3600);
}
function loading(texto){
  $("loading-text").textContent = texto || "Carregando…";
  $("loading-overlay").classList.remove("hidden");
}
function pronto(){ $("loading-overlay").classList.add("hidden"); }

// Envolve uma ação assíncrona com a tela de carregamento e o aviso de erro.
async function acao(texto, fn){
  loading(texto);
  try{ return await fn(); }
  catch(err){ console.warn(err); toast(err.message || "Algo deu errado."); }
  finally{ pronto(); }
}

function confirmar({ title, desc, confirmLabel }){
  return new Promise(resolve => {
    $("confirm-modal-title").textContent = title || "Confirmar ação";
    $("confirm-modal-desc").textContent = desc || "";
    $("confirm-modal-confirm").textContent = confirmLabel || "Confirmar";
    $("confirm-modal").classList.remove("hidden");
    const fim = r => {
      $("confirm-modal").classList.add("hidden");
      $("confirm-modal-confirm").removeEventListener("click", sim);
      $("confirm-modal-cancel").removeEventListener("click", nao);
      resolve(r);
    };
    const sim = () => fim(true), nao = () => fim(false);
    $("confirm-modal-confirm").addEventListener("click", sim);
    $("confirm-modal-cancel").addEventListener("click", nao);
  });
}

// Destaca o alvo dentro da frase, já escapando o resto.
function marcarAlvo(frase, alvo){
  if(!frase) return "";
  if(!alvo) return esc(frase);
  const re = new RegExp(`\\b${alvo.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\w*`, "i");
  const m = frase.match(re);
  if(!m) return esc(frase);
  return esc(frase.slice(0, m.index)) + `<mark>${esc(m[0])}</mark>` + esc(frase.slice(m.index + m[0].length));
}

// Som de clique, sintetizado.
let audioCtx = null;
document.addEventListener("click", e => {
  if(!e.target.closest("button, .nav-item")) return;
  try{
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const t = audioCtx.currentTime, o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.type = "sine";
    o.frequency.setValueAtTime(880, t);
    o.frequency.exponentialRampToValueAtTime(440, t + 0.05);
    g.gain.setValueAtTime(0.06, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.08);
    o.connect(g).connect(audioCtx.destination);
    o.start(t); o.stop(t + 0.09);
  }catch(err){ /* navegador bloqueou o áudio antes do 1º gesto */ }
}, true);

// =========================================================
// DADOS
// =========================================================
function chaveUnica(deck, word){
  const base = word.trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "w";
  let key = base, i = 2;
  while(deck.Cards && deck.Cards[key]) key = `${base}_${i++}`;
  return key;
}
const novoId = p => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

function novoCard(c, unit){
  return {
    Word: c.Word.trim(), Kind: c.Kind || "palavra", Phrase: c.Phrase, Translation: c.Translation,
    Unit: unit ?? null, Level: 1, EasyStreak: 0, Suspended: false,
    CreatedAt: new Date().toISOString(), Modes: {},
  };
}

async function carregarTudo(){
  const inicio = new Date(); inicio.setDate(inicio.getDate() - 70);
  const [perfil, decks, dias] = await Promise.all([
    fb.dbGet(fb.meu("/Profile")),
    fb.dbGet(fb.meu("/Decks")),
    fb.dbGet(fb.meu("/Dias"), { orderBy: '"$key"', startAt: `"${hojeLocal(inicio)}"` }),
  ]);
  state.perfil = perfil || {};
  state.decks = decks || {};
  Object.values(state.decks).forEach(d => { d.Cards = d.Cards || {}; d.Trilha = d.Trilha || []; });
  state.dias = dias || {};
  const agora = new Date().toISOString();
  const patch = { Email: fb.sessao.email, LastLogin: agora };
  if(!state.perfil.CreatedAt) patch.CreatedAt = agora;
  if(!state.perfil.Nome) patch.Nome = (fb.sessao.email || "").split("@")[0];
  Object.assign(state.perfil, patch);
  fb.dbPatch(fb.meu("/Profile"), patch).catch(() => {});
}

function salvarPrefs(mudanca){
  state.perfil.Prefs = Object.assign(prefs(), mudanca);
  fb.dbPatch(fb.meu("/Profile"), { Prefs: state.perfil.Prefs }).catch(err => toast(err.message));
}

// =========================================================
// JUNTOS — o resumo público de cada um
// =========================================================
let juntosTimer = null;
function publicarJuntos(imediato = false){
  clearTimeout(juntosTimer);
  const enviar = () => {
    const hoje = hojeLocal();
    const dias7 = {};
    for(let i = 0; i < 7; i++){
      const d = new Date(); d.setDate(d.getDate() - i);
      const k = hojeLocal(d);
      dias7[k] = (state.dias[k] && state.dias[k].r) || 0;
    }
    const deck = state.decks[state.currentDeckId] || Object.values(state.decks)[0];
    const fracas = deck ? Object.values(deck.Cards)
      .filter(c => !c.Suspended && estadoModo(c, "rec").n > 0)
      .sort((a, b) => (dominio(a) ?? 0) - (dominio(b) ?? 0))
      .slice(0, 10).map(c => c.Word) : [];
    const resumo = {
      Nome: state.perfil.Nome || "",
      Sequencia: sequencia(state.dias),
      Hoje: { data: hoje, r: (state.dias[hoje] && state.dias[hoje].r) || 0 },
      Dias7: dias7,
      Nivel: state.perfil.UltimoNivel || (deck && deck.Nivel) || "",
      Objetivo: (deck && deck.Objetivo) || "",
      Idioma: (deck && deck.Language) || "en",
      Fracas: fracas,
      Atualizado: new Date().toISOString(),
    };
    fb.dbPatch(`${fb.RAIZ}/juntos/${fb.sessao.uid}`, resumo).catch(() => {});
  };
  if(imediato) enviar(); else juntosTimer = setTimeout(enviar, 4000);
}

// =========================================================
// NAVEGAÇÃO
// =========================================================
function switchView(viewId){
  const nav = viewId === "view-deck-detail" ? "view-decks" : viewId;
  document.querySelectorAll(".view").forEach(v => v.classList.toggle("active", v.id === viewId));
  document.querySelectorAll(".nav-item").forEach(n => n.classList.toggle("active", n.dataset.view === nav));
  closeMobileSidebar();
  voz.pararFala();
  if(viewId === "view-decks") renderDecks();
  if(viewId === "view-deck-detail") renderDetalhe();
  if(viewId === "view-study"){ preencherSelectDecks($("study-deck-select"), state.currentDeckId); proximoCard(); }
  if(viewId === "view-stats"){ preencherStatsSelect(); renderStats(); }
  if(viewId === "view-settings") renderConfig();
  if(viewId === "view-talk") abrirConversar();
  if(viewId === "view-level") abrirNivel();
  if(viewId === "view-together") abrirJuntos();
  document.querySelector(".main").scrollTop = 0;
}
function openMobileSidebar(){ $("sidebar").classList.add("mobile-open"); $("sidebar-backdrop").classList.add("active"); }
function closeMobileSidebar(){ $("sidebar").classList.remove("mobile-open"); $("sidebar-backdrop").classList.remove("active"); }

function preencherSelectDecks(sel, atual){
  const ids = Object.keys(state.decks);
  sel.innerHTML = ids.length ? "" : '<option value="">Nenhum baralho</option>';
  sel.disabled = !ids.length;
  ids.forEach(id => {
    const o = document.createElement("option");
    o.value = id; o.textContent = state.decks[id].Name;
    sel.appendChild(o);
  });
  if(ids.length) sel.value = atual && state.decks[atual] ? atual : ids[0];
  return sel.value;
}

function atualizarContadorHoje(){
  const n = (state.dias[hojeLocal()] && state.dias[hojeLocal()].r) || 0;
  $("nav-hoje").textContent = n;
  $("mobile-hoje").textContent = `${n} hoje`;
}

// =========================================================
// ESTUDAR
// =========================================================
function modosAtivos(){
  const m = prefs().modos.filter(k => MODOS[k]);
  return m.length ? m : ["rec"];
}

function proximoCard(){
  const temDecks = Object.keys(state.decks).length > 0;
  if(temDecks && !state.decks[state.currentDeckId]) state.currentDeckId = Object.keys(state.decks)[0];
  const deck = state.decks[state.currentDeckId];
  const cards = deck ? deck.Cards : {};
  const ativos = Object.values(cards).filter(c => !c.Suspended).length;

  $("study-hero").classList.toggle("hidden", !ativos);
  $("study-empty-state").classList.toggle("hidden", !!ativos);
  $("study-deck-select").classList.toggle("hidden", !temDecks);
  atualizarContadorHoje();

  if(!temDecks){
    $("deck-status").textContent = "Nenhum baralho criado ainda.";
    $("study-empty-text").textContent = "Você ainda não tem nenhum baralho. Crie um baralho para começar a estudar.";
    $("btn-goto-decks").textContent = "+ Criar meu primeiro baralho";
    $("study-evolve-notice").classList.add("hidden");
    return;
  }
  const total = Object.keys(cards).length;
  $("deck-status").textContent = `${deck.Name} · ${total} card(s) · ${idiomaLabel(deck.Language)}`;
  if(!ativos){
    $("study-empty-text").textContent = "Este baralho ainda não tem cards. Gere os cards da primeira unidade da trilha.";
    $("btn-goto-decks").textContent = "Abrir o baralho";
    $("study-evolve-notice").classList.add("hidden");
    return;
  }
  const lista = Object.values(cards);
  $("study-evolve-notice").classList.toggle("hidden", !(lista.filter(c => (c.Level || 1) > 1).length / lista.length > 0.8));

  state.atual = sortear(state.currentDeckId, cards, modosAtivos(), { temAudio: voz.temFala });
  state.virado = false;
  limparFeedback();
  mostrarFrente();
}

function cardAtual(){
  const deck = state.decks[state.currentDeckId];
  return deck && state.atual ? deck.Cards[state.atual.key] : null;
}

function mostrarFrente(){
  const deck = state.decks[state.currentDeckId];
  const card = cardAtual();
  if(!card) return;
  const modo = state.atual.modo;
  $("flashcard-inner").classList.remove("flipped");
  $("controls-answer").classList.add("hidden");
  $("controls-turn").classList.remove("hidden");
  setRespostaHabilitada(false);

  const unidade = deck.Trilha && card.Unit != null ? deck.Trilha[card.Unit] : null;
  $("study-mode-tag").textContent = MODOS[modo].nome;
  $("study-unit-tag").textContent = unidade ? unidade.Titulo : (card.Kind || "palavra");
  $("card-level-hint").textContent = `frase ${card.Level || 1}/${MAX_CARD_LEVEL}`;

  const main = $("front-main"), sub = $("front-sub");
  main.className = "english-text big";
  $("front-play").classList.add("hidden");
  sub.textContent = "";
  if(modo === "rec"){
    $("front-label").textContent = "O que quer dizer?";
    main.innerHTML = marcarAlvo(card.Phrase, card.Word);
  }else if(modo === "prod"){
    $("front-label").textContent = `Diga em ${idiomaLabel(deck.Language).toLowerCase()}`;
    main.className = "pt-text big";
    main.textContent = card.Translation;
    sub.textContent = card.Kind === "palavra" ? "" : "(use uma expressão)";
  }else if(modo === "ouv"){
    $("front-label").textContent = "Ouça e entenda";
    main.textContent = "";
    $("front-play").classList.remove("hidden");
    setTimeout(() => tocar(1), 250);
  }else if(modo === "comp"){
    $("front-label").textContent = "Complete a frase";
    main.textContent = lacuna(card.Phrase, card.Word) || card.Phrase;
    sub.textContent = card.Translation;
  }

  // Áudio no verso para modos em que ouvir entrega a resposta.
  const audioNaFrente = modo === "rec" || modo === "ouv";
  $("btn-sound").disabled = !voz.temFala || !audioNaFrente;
  $("btn-sound-slow").disabled = !voz.temFala || !audioNaFrente;
  $("btn-speak").classList.toggle("hidden", !voz.temReconhecimento);
  $("btn-speak").textContent = modo === "prod" ? "🎙️ Responder falando" : "🎙️ Ler em voz alta";
  $("btn-record").classList.toggle("hidden", !voz.temGravacao);
  $("type-row").classList.toggle("hidden", modo !== "prod" && modo !== "comp");
  $("type-answer").value = "";
  $("type-answer").placeholder = modo === "comp" ? "Opcional: escreva a palavra que falta" : "Opcional: escreva sua resposta e confira";
}

function mostrarVerso(){
  const card = cardAtual();
  if(!card || state.virado) return;
  state.virado = true;
  const modo = state.atual.modo;
  $("back-label").textContent = MODOS[modo].nome;
  $("back-main").innerHTML = marcarAlvo(card.Phrase, card.Word);
  $("back-sub").textContent = card.Translation;
  $("back-word").innerHTML = `alvo: <strong>${esc(card.Word)}</strong>`;
  const s = estadoModo(card, modo);
  $("postmark-badge").textContent = s.n ? Math.round(s.m * 100) : "novo";
  $("flashcard-inner").classList.add("flipped");
  $("controls-turn").classList.add("hidden");
  $("controls-answer").classList.remove("hidden");
  setRespostaHabilitada(true);
  $("btn-sound").disabled = $("btn-sound-slow").disabled = !voz.temFala;
  $("btn-speak").textContent = "🎙️ Repetir a frase";
  $("type-row").classList.add("hidden");
  if(prefs().autoplay && modo !== "ouv") tocar(1);
}

function setRespostaHabilitada(on){
  ["btn-wrong", "btn-warning", "btn-correct", "btn-correct-plus"].forEach(id => {
    $(id).disabled = !on;
    $(id).classList.remove("sugerido");
  });
}

function tocar(velocidade){
  const card = cardAtual();
  const deck = state.decks[state.currentDeckId];
  if(!card) return;
  voz.falar(card.Phrase, { idioma: deck.Language, voz: prefs().voz, velocidade });
}

function limparFeedback(){
  $("feedback").classList.add("hidden");
  $("feedback").innerHTML = "";
  $("btn-myvoice").classList.add("hidden");
  if(state.gravacaoUrl){ URL.revokeObjectURL(state.gravacaoUrl); state.gravacaoUrl = null; }
}

function sugerirNota(nota){
  const id = { errei: "btn-wrong", quase: "btn-warning", acertei: "btn-correct", facil: "btn-correct-plus" }[nota];
  ["btn-wrong", "btn-warning", "btn-correct", "btn-correct-plus"].forEach(b => $(b).classList.toggle("sugerido", b === id));
}

function mostrarFeedback(html){
  $("feedback").innerHTML = html;
  $("feedback").classList.remove("hidden");
}

function htmlComparacao(marcas, dito){
  const palavras = marcas.map(m => `<span class="w-${m.estado}">${esc(m.palavra)}</span>`).join(" ");
  return `<div class="fb-line"><span class="fb-label">esperado</span> ${palavras}</div>` +
    `<div class="fb-line"><span class="fb-label">você disse</span> ${esc(dito || "(nada)")}</div>`;
}

let falasHoje = 0;
async function falarResposta(){
  const card = cardAtual();
  const deck = state.decks[state.currentDeckId];
  if(!card) return;
  const modo = state.atual.modo;
  const btn = $("btn-speak");
  if(btn.classList.contains("ouvindo")){ voz.pararOuvir(); return; }
  voz.pararFala();
  btn.classList.add("ouvindo");
  const textoOriginal = btn.textContent;
  btn.textContent = "⏹ Parar";
  mostrarFeedback('<div class="fb-line muted">Ouvindo…</div>');
  let dito = "";
  try{
    dito = await voz.ouvir({ idioma: deck.Language, onParcial: t => mostrarFeedback(`<div class="fb-line muted">${esc(t)}</div>`) });
  }catch(err){
    mostrarFeedback(`<div class="fb-line muted">${esc(err.message)}</div>`);
    return;
  }finally{
    btn.classList.remove("ouvindo");
    btn.textContent = textoOriginal;
  }
  if(!dito){ mostrarFeedback('<div class="fb-line muted">Não ouvi nada. Tente de novo, ou responda pelos botões.</div>'); return; }
  falasHoje++;

  if(modo === "prod" && !state.virado){
    await avaliarProducao(dito, true);
    return;
  }
  const { sim, marcas } = voz.comparar(card.Phrase, dito);
  mostrarFeedback(htmlComparacao(marcas, dito) + `<div class="fb-line"><span class="fb-label">pronúncia</span> ${Math.round(sim * 100)}% das palavras reconhecidas</div>`);
  if(!state.virado) mostrarVerso();
  sugerirNota(voz.notaPorSimilaridade(sim));
}

async function avaliarProducao(resposta, falada){
  const card = cardAtual();
  const deck = state.decks[state.currentDeckId];
  mostrarFeedback('<div class="fb-line muted">Conferindo com a IA…</div>');
  try{
    const r = await pedir(P.pedidoAvaliarProducao(deck, card, resposta, falada));
    mostrarVerso();
    const ok = r.Nota === "facil" || r.Nota === "acertei";
    mostrarFeedback(
      `<div class="fb-line"><span class="fb-label">você ${falada ? "disse" : "escreveu"}</span> ${esc(resposta)}</div>` +
      (ok && !r.Explicacao ? "" : `<div class="fb-line"><span class="fb-label">melhor</span> ${esc(r.Correcao)}</div>`) +
      (r.Explicacao ? `<div class="fb-line muted">${esc(r.Explicacao)}</div>` : "")
    );
    sugerirNota(r.Nota);
  }catch(err){
    mostrarFeedback(`<div class="fb-line muted">${esc(err.message)}</div>`);
  }
}

function conferirDigitado(){
  const card = cardAtual();
  const texto = $("type-answer").value.trim();
  if(!card || !texto) return;
  if(state.atual.modo === "comp"){
    const certo = texto.toLowerCase().replace(/[^\p{L}\p{N}' ]/gu, "").trim();
    const alvo = card.Word.toLowerCase().trim();
    const nota = certo === alvo ? "facil" : (certo && alvo.startsWith(certo.slice(0, Math.max(3, certo.length - 2))) ? "quase" : "errei");
    mostrarVerso();
    mostrarFeedback(`<div class="fb-line"><span class="fb-label">você escreveu</span> ${esc(texto)}</div>`);
    sugerirNota(nota);
    return;
  }
  avaliarProducao(texto, false);
}

async function gravarVoz(){
  const btn = $("btn-record");
  if(btn.classList.contains("ouvindo")){ voz.pararGravacao(); return; }
  try{
    btn.classList.add("ouvindo");
    btn.textContent = "⏹ Parar";
    const url = await voz.gravar(12000);
    if(state.gravacaoUrl) URL.revokeObjectURL(state.gravacaoUrl);
    state.gravacaoUrl = url;
    $("btn-myvoice").classList.remove("hidden");
    new Audio(url).play();
  }catch(err){
    toast(err.message);
  }finally{
    btn.classList.remove("ouvindo");
    btn.textContent = "⏺ Gravar";
  }
}

async function responder(notaKey){
  const deckId = state.currentDeckId;
  const deck = state.decks[deckId];
  const card = cardAtual();
  if(!card || !state.virado) return;
  setRespostaHabilitada(false);
  voz.pararFala();
  const key = state.atual.key;
  const { maduro } = registrarResposta(card, state.atual.modo, notaKey);

  // Dia de hoje: revisões, acertos, faladas e a base da retenção real.
  const hoje = hojeLocal();
  const d = Object.assign({ r: 0, a: 0, f: 0, rm: 0, ra: 0 }, state.dias[hoje]);
  const acerto = notaKey === "acertei" || notaKey === "facil";
  d.r += 1;
  if(acerto) d.a += 1;
  if(maduro){ d.rm += 1; if(acerto) d.ra += 1; }
  d.f += falasHoje; falasHoje = 0;
  state.dias[hoje] = d;

  fb.dbPatch(fb.meu(`/Decks/${deckId}/Cards/${key}`), {
    Modes: card.Modes, EasyStreak: card.EasyStreak, LearnedAt: card.LearnedAt || null,
  }).catch(err => toast(err.message));
  fb.dbPut(fb.meu(`/Dias/${hoje}`), d).catch(() => {});
  publicarJuntos();

  if(card.EasyStreak >= EVOLVE_STREAK_THRESHOLD) evoluirCard(deckId, key);
  setTimeout(proximoCard, 180);
}

async function evoluirCard(deckId, key){
  const deck = state.decks[deckId];
  const card = deck && deck.Cards[key];
  if(!card) return;
  const nivel = card.Level || 1;
  if(nivel >= MAX_CARD_LEVEL){
    card.EasyStreak = 0;
    fb.dbPatch(fb.meu(`/Decks/${deckId}/Cards/${key}`), { EasyStreak: 0 }).catch(() => {});
    return;
  }
  try{
    const r = await pedir(P.pedidoNovaFrase(deck, card, nivel + 1, true));
    Object.assign(card, { Level: nivel + 1, EasyStreak: 0, Phrase: r.Phrase, Translation: r.Translation });
    await fb.dbPatch(fb.meu(`/Decks/${deckId}/Cards/${key}`), { Level: card.Level, EasyStreak: 0, Phrase: card.Phrase, Translation: card.Translation });
    toast(`📈 "${card.Word}" subiu para a frase nível ${card.Level}.`);
  }catch(err){
    console.warn("Falha ao evoluir", err); // tenta de novo no próximo Fácil
  }
}

// =========================================================
// BARALHOS
// =========================================================
function renderDecks(){
  const ids = Object.keys(state.decks);
  $("nav-deck-count").textContent = ids.length;
  $("deck-empty-msg").classList.toggle("hidden", ids.length > 0);
  const grid = $("deck-grid");
  grid.innerHTML = "";
  ids.forEach(id => {
    const deck = state.decks[id];
    const cards = Object.values(deck.Cards);
    const aprendidos = cards.filter(c => c.LearnedAt).length;
    const tile = document.createElement("div");
    tile.className = "study-card deck-card";
    tile.innerHTML = `
      <div class="study-card-title">${esc(deck.Name)}</div>
      <div class="deck-card-tags">
        <span class="tag tag-sage">${esc(idiomaLabel(deck.Language))}</span>
        <span class="tag tag-neutral">${esc(deck.Nivel || "—")}</span>
        <span class="tag tag-gold" title="${esc(deck.Objetivo)}">${esc(deck.Objetivo || "sem objetivo")}</span>
      </div>
      <div class="card-metrics"><span>${cards.length} cards · ${aprendidos} aprendidos</span></div>
      <div class="deck-card-actions">
        <button class="btn btn-primary btn-sm" data-a="study">Estudar</button>
        <button class="btn btn-edit btn-sm" data-a="open">Abrir</button>
      </div>`;
    tile.querySelector('[data-a="study"]').addEventListener("click", () => { state.currentDeckId = id; lembrarDeck(id); switchView("view-study"); });
    tile.querySelector('[data-a="open"]').addEventListener("click", () => abrirDetalhe(id));
    grid.appendChild(tile);
  });
}

function lembrarDeck(id){ try{ localStorage.setItem("fluencia:lastDeck", id); }catch(e){} }

function abrirDeckModal(modo, id){
  state.deckModalMode = modo;
  state.deckModalEditId = id || null;
  $("deck-modal-title").textContent = modo === "edit" ? "Editar baralho" : "Novo baralho";
  const d = modo === "edit" ? state.decks[id] : { Name: "", Language: "en", Nivel: "B1", Objetivo: "", Contexto: "" };
  $("deck-input-name").value = d.Name;
  $("deck-input-language").value = d.Language;
  $("deck-input-level").value = d.Nivel || "B1";
  $("deck-input-goal").value = d.Objetivo || "";
  $("deck-input-context").value = d.Contexto || "";
  $("deck-modal").classList.remove("hidden");
  $("deck-input-name").focus();
}

async function salvarDeckModal(){
  const dados = {
    Name: $("deck-input-name").value.trim(),
    Language: $("deck-input-language").value,
    Nivel: $("deck-input-level").value,
    Objetivo: $("deck-input-goal").value.trim(),
    Contexto: $("deck-input-context").value.trim(),
    UpdatedAt: new Date().toISOString(),
  };
  if(!dados.Name){ toast("Dê um nome ao baralho."); return; }
  if(!dados.Objetivo){ toast("Escreva o objetivo: é ele que guia os cards."); return; }
  $("deck-modal").classList.add("hidden");

  if(state.deckModalMode === "edit"){
    const id = state.deckModalEditId;
    await acao("Salvando…", async () => {
      Object.assign(state.decks[id], dados);
      await fb.dbPatch(fb.meu(`/Decks/${id}`), dados);
      renderDetalhe();
      toast("Baralho salvo.");
    });
    return;
  }
  const id = novoId("d");
  const deck = Object.assign(dados, { CreatedAt: dados.UpdatedAt, Cards: {}, Trilha: [], UnidadeAtual: 0 });
  await acao("Criando o baralho…", async () => {
    await fb.dbPut(fb.meu(`/Decks/${id}`), deck);
    state.decks[id] = deck;
    state.currentDeckId = id;
    lembrarDeck(id);
  });
  if(!state.decks[id]) return;
  abrirDetalhe(id);
  await gerarTrilha(id);
}

async function gerarTrilha(id){
  const deck = state.decks[id];
  await acao("Montando a trilha com a IA…", async () => {
    const r = await pedir(P.pedidoTrilha(deck));
    deck.Trilha = r.Unidades;
    deck.UnidadeAtual = 0;
    await fb.dbPatch(fb.meu(`/Decks/${id}`), { Trilha: deck.Trilha, UnidadeAtual: 0 });
  });
  if(state.detailDeckId === id) renderDetalhe();
}

async function excluirDeck(id){
  const deck = state.decks[id];
  const n = Object.keys(deck.Cards).length;
  const ok = await confirmar({ title: "Excluir baralho", desc: `Excluir "${deck.Name}" e ${n} card(s)? Não dá para desfazer.`, confirmLabel: "Excluir" });
  if(!ok) return;
  await acao("Excluindo…", async () => {
    await fb.dbDelete(fb.meu(`/Decks/${id}`));
    delete state.decks[id];
    if(state.currentDeckId === id) state.currentDeckId = null;
    switchView("view-decks");
    toast("Baralho excluído.");
  });
}

// =========================================================
// DETALHE DO BARALHO
// =========================================================
function abrirDetalhe(id){
  state.detailDeckId = id;
  switchView("view-deck-detail");
}

function renderDetalhe(){
  const deck = state.decks[state.detailDeckId];
  if(!deck){ switchView("view-decks"); return; }
  $("detail-deck-name").textContent = deck.Name;
  $("detail-deck-lang").textContent = idiomaLabel(deck.Language);
  $("detail-deck-level").textContent = deck.Nivel || "—";
  $("detail-deck-goal").textContent = deck.Objetivo || "sem objetivo";

  // Trilha
  const lista = $("trail-list");
  lista.innerHTML = "";
  const atual = deck.UnidadeAtual || 0;
  const porUnidade = {};
  Object.values(deck.Cards).forEach(c => { if(c.Unit != null) porUnidade[c.Unit] = (porUnidade[c.Unit] || 0) + 1; });
  (deck.Trilha || []).forEach((u, i) => {
    const li = document.createElement("li");
    li.className = i === atual ? "atual" : (i < atual ? "feita" : "");
    li.innerHTML = `<button class="trail-btn" data-i="${i}"><strong>${esc(u.Titulo)}</strong>` +
      `<span>${esc(u.Descricao)}</span><em>${porUnidade[i] || 0} cards</em></button>`;
    li.querySelector("button").addEventListener("click", () => escolherUnidade(i));
    lista.appendChild(li);
  });
  const temTrilha = (deck.Trilha || []).length > 0;
  $("trail-empty").classList.toggle("hidden", temTrilha);
  $("trail-progress").textContent = temTrilha ? `unidade ${atual + 1} de ${deck.Trilha.length}` : "—";
  $("btn-gen-unit").disabled = !temTrilha;
  $("btn-next-unit").disabled = !temTrilha || atual >= deck.Trilha.length - 1;
  $("btn-gen-trail").textContent = temTrilha ? "↻ Refazer trilha" : "✨ Gerar trilha";

  renderLote();
  renderCards();
}

async function escolherUnidade(i){
  const deck = state.decks[state.detailDeckId];
  deck.UnidadeAtual = i;
  fb.dbPatch(fb.meu(`/Decks/${state.detailDeckId}`), { UnidadeAtual: i }).catch(err => toast(err.message));
  renderDetalhe();
}

function alvosExistentes(deck){ return Object.values(deck.Cards).map(c => c.Word); }

// Junta o resultado da IA ao lote, tirando alvos repetidos (no baralho e no lote).
function adicionarAoLote(deckId, cards, unit){
  if(state.loteDeckId !== deckId){ state.lote = []; state.loteDeckId = deckId; }
  const deck = state.decks[deckId];
  const vistos = new Set([...alvosExistentes(deck), ...state.lote.map(c => c.Word)].map(w => w.toLowerCase().trim()));
  let novos = 0;
  for(const c of cards){
    const w = (c.Word || "").toLowerCase().trim();
    if(!w || vistos.has(w) || !c.Phrase) continue;
    vistos.add(w);
    state.lote.push({ ...c, Unit: unit ?? null, marcado: true });
    novos++;
  }
  renderLote();
  if(novos) $("batch-panel").scrollIntoView({ behavior: "smooth", block: "start" });
  else toast("A IA não trouxe nenhum alvo novo. Tente de novo.");
}

async function gerarDaUnidade(){
  const id = state.detailDeckId, deck = state.decks[id];
  const u = deck.UnidadeAtual || 0;
  await acao("Gerando cards da unidade…", async () => {
    const existentes = [...alvosExistentes(deck), ...state.lote.map(c => c.Word)];
    const r = await pedir(P.pedidoNovosCards(deck, { unidade: deck.Trilha[u], existentes, n: 10 }));
    adicionarAoLote(id, r.Cards, u);
  });
}

async function gerarDeAlvos(){
  const id = state.detailDeckId, deck = state.decks[id];
  const alvos = $("input-new-word").value.split(/[,;\n]/).map(s => s.trim()).filter(Boolean);
  if(!alvos.length) return;
  const vistos = new Set(alvosExistentes(deck).map(w => w.toLowerCase()));
  const novos = alvos.filter(a => !vistos.has(a.toLowerCase()));
  if(!novos.length){ toast("Esses alvos já estão no baralho."); return; }
  await acao("Gerando frases…", async () => {
    const r = await pedir(P.pedidoNovosCards(deck, { alvos: novos, existentes: alvosExistentes(deck) }));
    adicionarAoLote(id, r.Cards, deck.Trilha.length ? deck.UnidadeAtual || 0 : null);
    $("input-new-word").value = "";
  });
}

async function extrairTexto(){
  const id = state.detailDeckId, deck = state.decks[id];
  const texto = $("mine-text").value.trim();
  if(texto.length < 20){ toast("Cole um texto um pouco maior."); return; }
  await acao("Lendo o texto…", async () => {
    const r = await pedir(P.pedidoExtrairTexto(deck, texto.slice(0, 12000), alvosExistentes(deck)));
    adicionarAoLote(id, r.Cards, null);
    $("mine-text").value = "";
  });
}

function renderLote(){
  const mostrar = state.loteDeckId === state.detailDeckId && state.lote.length > 0;
  $("batch-panel").classList.toggle("hidden", !mostrar);
  if(!mostrar) return;
  $("batch-count").textContent = `${state.lote.filter(c => c.marcado).length} de ${state.lote.length}`;
  const box = $("batch-list");
  box.innerHTML = "";
  state.lote.forEach((c, i) => {
    const row = document.createElement("label");
    row.className = "batch-item" + (c.marcado ? "" : " off");
    row.innerHTML = `<input type="checkbox" ${c.marcado ? "checked" : ""}>
      <div><div class="batch-word">${esc(c.Word)} <span class="tag tag-neutral">${esc(c.Kind)}</span></div>
      <div class="study-card-meta">${marcarAlvo(c.Phrase, c.Word)}<br><em>${esc(c.Translation)}</em></div></div>`;
    row.querySelector("input").addEventListener("change", e => { state.lote[i].marcado = e.target.checked; renderLote(); });
    box.appendChild(row);
  });
}

async function salvarLote(){
  const id = state.loteDeckId, deck = state.decks[id];
  const escolhidos = state.lote.filter(c => c.marcado);
  if(!escolhidos.length){ toast("Nenhum card marcado."); return; }
  await acao("Adicionando…", async () => {
    const patch = {};
    for(const c of escolhidos){
      const key = chaveUnica(deck, c.Word);
      const card = novoCard(c, c.Unit);
      deck.Cards[key] = card;
      patch[key] = card;
    }
    await fb.dbPatch(fb.meu(`/Decks/${id}/Cards`), patch);
    state.lote = [];
    renderDetalhe();
    toast(`${escolhidos.length} card(s) adicionado(s).`);
  });
}

function renderCards(){
  const deck = state.decks[state.detailDeckId];
  const filtro = $("card-filter").value.trim().toLowerCase();
  const entradas = Object.entries(deck.Cards)
    .sort((a, b) => (b[1].CreatedAt || "").localeCompare(a[1].CreatedAt || ""))
    .filter(([, c]) => !filtro || `${c.Word} ${c.Phrase} ${c.Translation}`.toLowerCase().includes(filtro));
  $("deck-count-tag").textContent = `${Object.keys(deck.Cards).length} cards`;
  $("empty-msg").classList.toggle("hidden", Object.keys(deck.Cards).length > 0);
  const grid = $("card-grid");
  grid.innerHTML = "";
  for(const [key, card] of entradas.slice(0, 200)){
    const dom = dominio(card);
    const n = Object.values(card.Modes || {}).reduce((a, s) => a + (s.n || 0), 0);
    const tile = document.createElement("div");
    tile.className = "study-card" + (card.Suspended ? " suspenso" : "");
    tile.innerHTML = `
      <div class="study-card-title">${esc(card.Word)} <span class="tag tag-neutral">${esc(card.Kind || "palavra")}</span></div>
      <div class="study-card-meta">${marcarAlvo(card.Phrase, card.Word)}<br><em>${esc(card.Translation)}</em></div>
      <div class="card-metrics">
        <span class="tag tag-neutral">frase ${card.Level || 1}/${MAX_CARD_LEVEL}</span>
        <span>${dom === null ? "novo" : "domínio " + Math.round(dom * 100) + "%"} · ${n} rev.</span>
      </div>
      <div class="study-card-actions">
        <button class="btn btn-edit btn-sm" data-a="edit">✏️ Editar</button>
        <button class="btn btn-edit btn-sm" data-a="refresh">🔄 Frase</button>
        <button class="btn btn-edit btn-sm" data-a="pause">${card.Suspended ? "▶ Voltar" : "⏸ Pausar"}</button>
        <button class="btn btn-reject btn-sm" data-a="del" aria-label="Excluir">🗑️</button>
      </div>`;
    tile.querySelector('[data-a="edit"]').addEventListener("click", () => abrirEditarCard(key));
    tile.querySelector('[data-a="refresh"]').addEventListener("click", () => novaFrase(key));
    tile.querySelector('[data-a="pause"]').addEventListener("click", () => pausarCard(key));
    tile.querySelector('[data-a="del"]').addEventListener("click", () => excluirCard(key));
    grid.appendChild(tile);
  }
  if(entradas.length > 200){
    const p = document.createElement("p");
    p.className = "empty-msg";
    p.textContent = `Mostrando 200 de ${entradas.length}. Use o filtro.`;
    grid.appendChild(p);
  }
}

function abrirEditarCard(key){
  const c = state.decks[state.detailDeckId].Cards[key];
  state.editCardKey = key;
  $("card-input-word").value = c.Word;
  $("card-input-phrase").value = c.Phrase;
  $("card-input-translation").value = c.Translation;
  $("card-modal").classList.remove("hidden");
}

async function salvarEditarCard(){
  const id = state.detailDeckId, key = state.editCardKey, c = state.decks[id].Cards[key];
  const patch = {
    Word: $("card-input-word").value.trim(),
    Phrase: $("card-input-phrase").value.trim(),
    Translation: $("card-input-translation").value.trim(),
  };
  if(!patch.Word || !patch.Phrase){ toast("Alvo e frase são obrigatórios."); return; }
  $("card-modal").classList.add("hidden");
  await acao("Salvando…", async () => {
    Object.assign(c, patch);
    await fb.dbPatch(fb.meu(`/Decks/${id}/Cards/${key}`), patch);
    renderCards();
  });
}

async function novaFrase(key){
  const id = state.detailDeckId, deck = state.decks[id], c = deck.Cards[key];
  await acao("Gerando nova frase…", async () => {
    const r = await pedir(P.pedidoNovaFrase(deck, c, c.Level || 1, false));
    Object.assign(c, { Phrase: r.Phrase, Translation: r.Translation });
    await fb.dbPatch(fb.meu(`/Decks/${id}/Cards/${key}`), { Phrase: c.Phrase, Translation: c.Translation });
    renderCards();
  });
}

async function pausarCard(key){
  const id = state.detailDeckId, c = state.decks[id].Cards[key];
  c.Suspended = !c.Suspended;
  renderCards();
  fb.dbPatch(fb.meu(`/Decks/${id}/Cards/${key}`), { Suspended: c.Suspended }).catch(err => toast(err.message));
}

async function excluirCard(key){
  const id = state.detailDeckId, c = state.decks[id].Cards[key];
  if(!await confirmar({ title: "Excluir card", desc: `Excluir "${c.Word}"?`, confirmLabel: "Excluir" })) return;
  await acao("Excluindo…", async () => {
    await fb.dbDelete(fb.meu(`/Decks/${id}/Cards/${key}`));
    delete state.decks[id].Cards[key];
    renderCards();
  });
}

async function trocarObjetivo(){
  const novo = $("theme-input-new").value.trim();
  if(!novo){ toast("Escreva o novo objetivo."); return; }
  $("theme-modal").classList.add("hidden");
  const id = state.detailDeckId, deck = state.decks[id];
  const entradas = Object.entries(deck.Cards);
  await acao("Reescrevendo as frases…", async () => {
    const patch = {};
    for(let i = 0; i < entradas.length; i += 20){
      loading(`Reescrevendo as frases (${Math.min(i + 20, entradas.length)}/${entradas.length})…`);
      const fatia = entradas.slice(i, i + 20);
      try{
        const r = await pedir(P.pedidoTrocarObjetivo(deck, fatia.map(([, c]) => c), novo));
        const porWord = new Map(r.Cards.map(c => [c.Word.toLowerCase().trim(), c]));
        for(const [key, c] of fatia){
          const n = porWord.get(c.Word.toLowerCase().trim());
          if(n){ Object.assign(c, { Phrase: n.Phrase, Translation: n.Translation }); patch[`${key}/Phrase`] = n.Phrase; patch[`${key}/Translation`] = n.Translation; }
        }
      }catch(err){ console.warn("Falha numa parte", err); }
    }
    if(Object.keys(patch).length) await fb.dbPatch(fb.meu(`/Decks/${id}/Cards`), patch);
    deck.Objetivo = novo;
    await fb.dbPatch(fb.meu(`/Decks/${id}`), { Objetivo: novo, UpdatedAt: new Date().toISOString() });
  });
  renderDetalhe();
  await gerarTrilha(id);
}

// =========================================================
// CONVERSAR
// =========================================================
async function abrirConversar(){
  preencherSelectDecks($("talk-deck"), state.currentDeckId);
  const deck = state.decks[$("talk-deck").value];
  if(deck && /viag|interc|travel/i.test(deck.Objetivo || "")) $("talk-scenario").value = "viagem";
  $("btn-talk-mic").classList.toggle("hidden", !voz.temReconhecimento);
  if(!state.conversa){
    $("talk-setup").classList.remove("hidden");
    $("talk-room").classList.add("hidden");
  }
  carregarHistoricoConversas();
}

async function carregarHistoricoConversas(){
  try{
    const lista = await fb.dbGet(fb.meu("/Conversas"), { orderBy: '"$key"', limitToLast: 15 });
    const box = $("talk-history");
    const itens = Object.entries(lista || {}).reverse();
    if(!itens.length){ box.innerHTML = '<p class="empty-msg">Nenhuma conversa ainda.</p>'; return; }
    box.innerHTML = "";
    for(const [id, c] of itens){
      const row = document.createElement("button");
      row.className = "hist-row";
      const data = new Date(c.Data).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
      const nomeCenario = { rh: "Entrevista de RH", tecnica: "Entrevista técnica", viagem: "Viagem ou intercâmbio", livre: "Conversa livre" }[c.Cenario] || c.Cenario;
      row.innerHTML = `<span>${data} · ${esc(nomeCenario)}</span>` +
        `<span class="tag tag-sage">${esc(c.Relatorio?.NivelPercebido || "—")}</span>`;
      row.addEventListener("click", () => mostrarRelatorio(c.Relatorio, c.DeckId, id));
      box.appendChild(row);
    }
  }catch(err){ /* histórico é secundário */ }
}

async function comecarConversa(){
  const deckId = $("talk-deck").value;
  if(!state.decks[deckId]){ toast("Crie um baralho antes."); return; }
  state.conversa = {
    deckId, turnos: [],
    opcoes: { cenario: $("talk-scenario").value, vaga: $("talk-context").value.trim().slice(0, 6000), historico: state.perfil.Historico || "" },
  };
  $("talk-setup").classList.add("hidden");
  $("talk-report").classList.add("hidden");
  $("talk-room").classList.remove("hidden");
  renderChat();
  await turnoIA();
}

async function turnoIA(){
  const c = state.conversa;
  const deck = state.decks[c.deckId];
  c.esperando = true;
  renderChat();
  try{
    const r = await pedir(P.pedidoTurno(deck, c.opcoes, c.turnos));
    const temCorrecao = r.Correcao && r.Correcao.Melhor;
    c.turnos.push({ quem: "ia", texto: r.Fala, correcao: temCorrecao ? r.Correcao : null });
    if($("talk-autospeak").checked) voz.falar(r.Fala, { idioma: deck.Language, voz: prefs().voz });
  }catch(err){
    toast(err.message);
  }finally{
    c.esperando = false;
    renderChat();
  }
}

function renderChat(){
  const c = state.conversa;
  const box = $("chat");
  if(!c){ box.innerHTML = ""; return; }
  const deck = state.decks[c.deckId];
  box.innerHTML = "";
  c.turnos.forEach((t, i) => {
    if(t.quem === "ia" && t.correcao){
      const cor = document.createElement("div");
      cor.className = "correcao";
      cor.innerHTML = `<span class="fb-label">melhor</span> ${esc(t.correcao.Melhor)}` +
        (t.correcao.Explicacao ? `<div class="muted">${esc(t.correcao.Explicacao)}</div>` : "");
      box.appendChild(cor);
    }
    const b = document.createElement("div");
    b.className = `bubble ${t.quem === "ia" ? "ia" : "eu"}`;
    b.innerHTML = esc(t.texto);
    if(t.quem === "ia"){
      const ouvir = document.createElement("button");
      ouvir.className = "bubble-play"; ouvir.textContent = "🔊"; ouvir.setAttribute("aria-label", "Ouvir");
      ouvir.addEventListener("click", () => voz.falar(t.texto, { idioma: deck.Language, voz: prefs().voz }));
      b.appendChild(ouvir);
    }
    box.appendChild(b);
  });
  if(c.esperando){
    const d = document.createElement("div");
    d.className = "bubble ia digitando"; d.textContent = "…";
    box.appendChild(d);
  }
  $("btn-talk-send").disabled = $("btn-talk-end").disabled = !!c.esperando;
  box.scrollTop = box.scrollHeight;
}

async function enviarFala(){
  const c = state.conversa;
  const texto = $("talk-input").value.trim();
  if(!c || c.esperando || !texto) return;
  $("talk-input").value = "";
  c.turnos.push({ quem: "eu", texto });
  await turnoIA();
}

async function microfoneConversa(){
  const c = state.conversa;
  const btn = $("btn-talk-mic");
  if(btn.classList.contains("ouvindo")){ voz.pararOuvir(); return; }
  voz.pararFala();
  btn.classList.add("ouvindo"); btn.textContent = "⏹ Parar";
  const antes = $("talk-input").value.trim();
  try{
    const dito = await voz.ouvir({
      idioma: state.decks[c.deckId].Language,
      onParcial: t => { $("talk-input").value = (antes ? antes + " " : "") + t; },
    });
    if(dito){
      $("talk-input").value = (antes ? antes + " " : "") + dito;
      const hoje = hojeLocal();
      const d = Object.assign({ r: 0, a: 0, f: 0, rm: 0, ra: 0 }, state.dias[hoje]);
      d.f += 1; state.dias[hoje] = d;
      fb.dbPut(fb.meu(`/Dias/${hoje}`), d).catch(() => {});
    }
  }catch(err){ toast(err.message); }
  finally{ btn.classList.remove("ouvindo"); btn.textContent = "🎙️ Falar"; }
}

async function encerrarConversa(){
  const c = state.conversa;
  if(!c) return;
  if(!c.turnos.some(t => t.quem === "eu")){
    state.conversa = null;
    abrirConversar();
    return;
  }
  const deck = state.decks[c.deckId];
  let relatorio = null;
  await acao("Montando o relatório…", async () => {
    relatorio = await pedir(P.pedidoRelatorio(deck, c.opcoes, c.turnos, alvosExistentes(deck)));
    const id = novoId("c");
    await fb.dbPut(fb.meu(`/Conversas/${id}`), {
      Data: new Date().toISOString(), Cenario: c.opcoes.cenario, DeckId: c.deckId,
      Turnos: c.turnos.map(t => ({ quem: t.quem, texto: t.texto })), Relatorio: relatorio,
    });
  });
  if(!relatorio) return;
  state.conversa = null;
  $("talk-room").classList.add("hidden");
  $("talk-setup").classList.remove("hidden");
  mostrarRelatorio(relatorio, c.deckId);
  carregarHistoricoConversas();
}

function mostrarRelatorio(r, deckId){
  if(!r) return;
  const box = $("talk-report");
  const deck = state.decks[deckId];
  const existentes = deck ? new Set(alvosExistentes(deck).map(w => w.toLowerCase())) : new Set();
  const cards = (r.Cards || []).filter(c => !existentes.has(c.Word.toLowerCase()));
  box.innerHTML = `
    <p class="panel-title">Relatório <span class="tag tag-sage">nível percebido: ${esc(r.NivelPercebido)}</span></p>
    <p class="report-text">${esc(r.Resumo)}</p>
    ${r.Erros?.length ? `<h3 class="sub-title">Erros para treinar</h3>` + r.Erros.map(e =>
      `<div class="erro"><div><span class="fb-label">você</span> ${esc(e.Original)}</div><div><span class="fb-label">melhor</span> <strong>${esc(e.Melhor)}</strong></div><div class="muted">${esc(e.Explicacao)}</div></div>`).join("") : ""}
    ${r.FrasesUteis?.length ? `<h3 class="sub-title">Frases que ajudam</h3><ul class="frases">${r.FrasesUteis.map(f => `<li>${esc(f)}</li>`).join("")}</ul>` : ""}
    ${cards.length && deck ? `<h3 class="sub-title">Cards sugeridos</h3><div class="batch-list" id="report-cards">${cards.map((c, i) =>
      `<label class="batch-item"><input type="checkbox" data-i="${i}" checked><div><div class="batch-word">${esc(c.Word)} <span class="tag tag-neutral">${esc(c.Kind)}</span></div><div class="study-card-meta">${marcarAlvo(c.Phrase, c.Word)}<br><em>${esc(c.Translation)}</em></div></div></label>`).join("")}</div>
      <div class="btn-line"><button class="btn btn-primary btn-sm" id="btn-report-add">Adicionar os marcados a "${esc(deck.Name)}"</button></div>` : ""}`;
  box.classList.remove("hidden");
  const add = $("btn-report-add");
  if(add) add.addEventListener("click", async () => {
    const marcados = [...box.querySelectorAll("#report-cards input:checked")].map(i => cards[+i.dataset.i]);
    if(!marcados.length) return;
    await acao("Adicionando…", async () => {
      const patch = {};
      for(const c of marcados){
        const key = chaveUnica(deck, c.Word);
        deck.Cards[key] = novoCard(c, null);
        patch[key] = deck.Cards[key];
      }
      await fb.dbPatch(fb.meu(`/Decks/${deckId}/Cards`), patch);
      add.disabled = true;
      add.textContent = `${marcados.length} card(s) adicionado(s)`;
    });
  });
  box.scrollIntoView({ behavior: "smooth", block: "start" });
}

// =========================================================
// NÍVEL
// =========================================================
async function abrirNivel(){
  preencherSelectDecks($("level-deck"), state.currentDeckId);
  try{
    const lista = await fb.dbGet(fb.meu("/Niveis"), { orderBy: '"$key"', limitToLast: 12 });
    const itens = Object.values(lista || {}).reverse();
    $("level-history").innerHTML = itens.length ? itens.map(n =>
      `<div class="health-row"><span>${new Date(n.Data).toLocaleDateString("pt-BR")} · ${esc(n.Resumo).slice(0, 90)}…</span><span class="health-dot health-ok">${esc(n.Nivel)}</span></div>`).join("")
      : '<p class="empty-msg">Nenhuma avaliação ainda.</p>';
  }catch(err){ /* secundário */ }
}

async function comecarTeste(){
  const deckId = $("level-deck").value;
  const deck = state.decks[deckId];
  if(!deck){ toast("Crie um baralho antes."); return; }
  let itens = null;
  await acao("Preparando a avaliação…", async () => { itens = (await pedir(P.pedidoTesteNivel(deck))).Itens; });
  if(!itens) return;
  state.teste = { deckId, itens };
  const box = $("level-test");
  const rotulo = { traducao: "Tradução", completar: "Complete", compreensao: "Compreensão", escrita: "Escrita", fala: "Fala" };
  box.innerHTML = `<p class="panel-title">Avaliação <span class="tag tag-gold">${itens.length} itens</span></p>` +
    itens.map((it, i) => `
      <div class="test-item">
        <div class="test-head"><span class="tag tag-neutral">${i + 1} · ${rotulo[it.Tipo] || it.Tipo}</span></div>
        ${it.Texto ? `<blockquote>${esc(it.Texto)}</blockquote>` : ""}
        <p>${esc(it.Enunciado)}</p>
        <textarea class="config-input textarea" rows="${it.Tipo === "escrita" ? 3 : 2}" data-i="${i}"></textarea>
        ${it.Tipo === "fala" && voz.temReconhecimento ? `<button class="btn btn-ghost btn-sm" data-fala="${i}">🎙️ Responder falando</button>` : ""}
      </div>`).join("") +
    `<div class="btn-line"><button class="btn btn-primary" id="btn-level-send">Enviar para correção</button></div>`;
  box.querySelectorAll("[data-fala]").forEach(b => b.addEventListener("click", async () => {
    const ta = box.querySelector(`textarea[data-i="${b.dataset.fala}"]`);
    b.textContent = "Ouvindo…";
    try{ ta.value = await voz.ouvir({ idioma: deck.Language, onParcial: t => { ta.value = t; } }); }
    catch(err){ toast(err.message); }
    b.textContent = "🎙️ Responder falando";
  }));
  $("btn-level-send").addEventListener("click", corrigirTeste);
  $("level-start").classList.add("hidden");
  $("level-result").classList.add("hidden");
  box.classList.remove("hidden");
}

async function corrigirTeste(){
  const t = state.teste;
  const deck = state.decks[t.deckId];
  const respostas = [...$("level-test").querySelectorAll("textarea")].map(ta => ta.value.trim());
  let r = null;
  await acao("Corrigindo…", async () => {
    r = await pedir(P.pedidoCorrigirTeste(deck, t.itens, respostas));
    const registro = { Data: new Date().toISOString(), DeckId: t.deckId, Nivel: r.Nivel, Resumo: r.Resumo, Fortes: r.Fortes, Fracos: r.Fracos };
    await fb.dbPut(fb.meu(`/Niveis/${novoId("n")}`), registro);
    state.perfil.UltimoNivel = r.Nivel;
    fb.dbPatch(fb.meu("/Profile"), { UltimoNivel: r.Nivel }).catch(() => {});
    publicarJuntos(true);
  });
  if(!r) return;
  const box = $("level-result");
  box.innerHTML = `
    <div class="level-big">${esc(r.Nivel)}</div>
    <p class="report-text">${esc(r.Resumo)}</p>
    <div class="detail-grid">
      <div><h3 class="sub-title">Pontos fortes</h3><ul class="frases">${r.Fortes.map(f => `<li>${esc(f)}</li>`).join("")}</ul></div>
      <div><h3 class="sub-title">Para treinar</h3><ul class="frases">${r.Fracos.map(f => `<li>${esc(f)}</li>`).join("")}</ul></div>
    </div>
    <h3 class="sub-title">Item a item</h3>
    ${t.itens.map((it, i) => `<div class="health-row"><span>${i + 1}. ${esc(r.Itens[i]?.Comentario || "")}</span><span class="health-dot ${(r.Itens[i]?.Nota ?? 0) >= 0.7 ? "health-ok" : (r.Itens[i]?.Nota ?? 0) >= 0.4 ? "health-atencao" : "health-risco"}">${Math.round((r.Itens[i]?.Nota ?? 0) * 100)}%</span></div>`).join("")}
    <div class="btn-line">
      ${deck.Nivel !== r.Nivel ? `<button class="btn btn-primary btn-sm" id="btn-level-apply">Usar ${esc(r.Nivel)} no baralho "${esc(deck.Name)}"</button>` : ""}
      <button class="btn btn-ghost btn-sm" id="btn-level-again">Fechar</button>
    </div>`;
  $("level-test").classList.add("hidden");
  box.classList.remove("hidden");
  $("btn-level-again").addEventListener("click", () => { box.classList.add("hidden"); $("level-start").classList.remove("hidden"); abrirNivel(); });
  const ap = $("btn-level-apply");
  if(ap) ap.addEventListener("click", async () => {
    deck.Nivel = r.Nivel;
    await fb.dbPatch(fb.meu(`/Decks/${t.deckId}`), { Nivel: r.Nivel }).catch(err => toast(err.message));
    ap.disabled = true; ap.textContent = "Nível atualizado";
  });
  state.teste = null;
}

// =========================================================
// JUNTOS
// =========================================================
async function abrirJuntos(){
  publicarJuntos(true);
  try{ state.juntos = (await fb.dbGet(`${fb.RAIZ}/juntos`)) || {}; }
  catch(err){ toast("Não consegui ler o Juntos."); state.juntos = {}; }
  renderJuntos();
}

function renderJuntos(){
  const hoje = hojeLocal();
  const grid = $("together-grid");
  grid.innerHTML = "";
  const membros = Object.entries(state.juntos);
  if(!membros.length){ grid.innerHTML = '<p class="empty-msg">Ninguém estudou ainda.</p>'; }
  for(const [uid, m] of membros){
    const dias = [];
    for(let i = 6; i >= 0; i--){
      const d = new Date(); d.setDate(d.getDate() - i);
      dias.push({ r: (m.Dias7 && m.Dias7[hojeLocal(d)]) || 0, l: d.toLocaleDateString("pt-BR", { weekday: "narrow" }) });
    }
    const max = Math.max(1, ...dias.map(d => d.r));
    const hojeR = m.Hoje && m.Hoje.data === hoje ? m.Hoje.r : 0;
    const card = document.createElement("div");
    card.className = "panel together" + (uid === fb.sessao.uid ? " eu" : "");
    card.innerHTML = `
      <div class="together-name">${esc(m.Nome || "—")}${uid === fb.sessao.uid ? ' <span class="tag tag-neutral">você</span>' : ""}</div>
      <div class="together-goal">${esc(m.Objetivo || "")}</div>
      <div class="together-nums">
        <div><div class="stat-num">${hojeR}</div><div class="stat-label">hoje</div></div>
        <div><div class="stat-num">${m.Sequencia || 0}</div><div class="stat-label">dias seguidos</div></div>
        <div><div class="stat-num">${esc(m.Nivel || "—")}</div><div class="stat-label">nível</div></div>
      </div>
      <div class="bar-chart mini">${dias.map(d => `<div class="bar-col"><div class="bar-fill" style="height:${Math.max(4, Math.round(d.r / max * 100))}%" title="${d.r}"></div><div class="bar-label">${esc(d.l)}</div></div>`).join("")}</div>`;
    grid.appendChild(card);
  }
  // Roteiro de hoje: o mais recente entre os dois.
  const roteiros = membros.map(([, m]) => m.Roteiro).filter(r => r && r.data === hoje).sort((a, b) => (b.criado || "").localeCompare(a.criado || ""));
  $("route-date").textContent = new Date().toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
  renderRoteiro(roteiros[0]);
}

function renderRoteiro(rot){
  const box = $("route-body");
  if(!rot){ box.innerHTML = '<p class="empty-msg">Nenhum roteiro hoje ainda.</p>'; $("btn-route").textContent = "✨ Gerar o roteiro de hoje"; return; }
  const r = rot.conteudo;
  $("btn-route").textContent = "↻ Gerar outro";
  box.innerHTML = `
    <h3 class="route-theme">${esc(r.Tema)}</h3>
    <p class="muted">${esc(r.Aquecimento)}</p>
    <ol class="route-q">${r.Perguntas.map(p => `<li><span class="tag tag-sage">${esc(p.Quem)}</span> ${esc(p.Pergunta)}</li>`).join("")}</ol>
    <h3 class="sub-title">Frases que ajudam</h3>
    <ul class="frases">${r.FrasesModelo.map(f => `<li>${esc(f)}</li>`).join("")}</ul>
    <p class="muted small">Gerado por ${esc(rot.por || "")}.</p>`;
}

async function gerarRoteiro(){
  const membros = Object.values(state.juntos).map(m => ({ Nome: m.Nome, Nivel: m.Nivel, Objetivo: m.Objetivo, Fracas: m.Fracas || [] }));
  if(!membros.length) return;
  const idioma = (Object.values(state.juntos)[0] || {}).Idioma || "en";
  await acao("Montando o roteiro…", async () => {
    const conteudo = await pedir(P.pedidoRoteiro(membros, idioma));
    const rot = { data: hojeLocal(), criado: new Date().toISOString(), por: state.perfil.Nome || "", conteudo };
    await fb.dbPatch(`${fb.RAIZ}/juntos/${fb.sessao.uid}`, { Roteiro: rot });
    state.juntos[fb.sessao.uid] = Object.assign(state.juntos[fb.sessao.uid] || {}, { Roteiro: rot });
    renderRoteiro(rot);
  });
}

// =========================================================
// ESTATÍSTICAS
// =========================================================
function preencherStatsSelect(){
  const sel = $("stats-deck-select");
  const atual = state.statsDeckId;
  sel.innerHTML = '<option value="all">Todos os baralhos</option>';
  Object.entries(state.decks).forEach(([id, d]) => {
    const o = document.createElement("option"); o.value = id; o.textContent = d.Name; sel.appendChild(o);
  });
  sel.value = atual !== "all" && state.decks[atual] ? atual : "all";
  state.statsDeckId = sel.value;
}

function renderStats(){
  const cards = state.statsDeckId !== "all" && state.decks[state.statsDeckId]
    ? Object.values(state.decks[state.statsDeckId].Cards)
    : Object.values(state.decks).flatMap(d => Object.values(d.Cards));

  const hoje = hojeLocal();
  const ult30 = Object.entries(state.dias).filter(([k]) => {
    const d = new Date(); d.setDate(d.getDate() - 29); return k >= hojeLocal(d);
  }).map(([, v]) => v);
  const soma = k => ult30.reduce((a, d) => a + (d[k] || 0), 0);
  const r30 = soma("r");

  $("stat-today").textContent = (state.dias[hoje] && state.dias[hoje].r) || 0;
  $("stat-streak").textContent = sequencia(state.dias);
  $("stat-accuracy").textContent = r30 ? Math.round(soma("a") / r30 * 100) + "%" : "—";
  $("stat-retention").textContent = soma("rm") ? Math.round(soma("ra") / soma("rm") * 100) + "%" : "—";
  $("stat-total-cards").textContent = cards.length;
  $("stat-learned").textContent = cards.filter(c => c.LearnedAt).length;
  $("stat-spoken").textContent = soma("f");
  $("stat-total-reviews").textContent = r30;

  const barras = (el, itens) => {
    const max = Math.max(1, ...itens.map(d => d.n));
    el.innerHTML = itens.map(d => `<div class="bar-col"><div class="bar-fill" style="height:${Math.max(4, Math.round(d.n / max * 100))}%" title="${d.n}"></div><div class="bar-label">${esc(d.l)}</div></div>`).join("");
  };
  const dias7 = [];
  for(let i = 6; i >= 0; i--){
    const d = new Date(); d.setDate(d.getDate() - i);
    dias7.push({ n: (state.dias[hojeLocal(d)] && state.dias[hojeLocal(d)].r) || 0, l: d.toLocaleDateString("pt-BR", { weekday: "short" }).replace(".", "") });
  }
  barras($("bar-chart"), dias7);
  const semanas = [];
  for(let i = 5; i >= 0; i--){
    const fim = new Date(); fim.setDate(fim.getDate() - 7 * i);
    const ini = new Date(fim); ini.setDate(ini.getDate() - 6);
    const a = hojeLocal(ini), b = hojeLocal(fim);
    semanas.push({ n: cards.filter(c => c.LearnedAt && hojeLocal(new Date(c.LearnedAt)) >= a && hojeLocal(new Date(c.LearnedAt)) <= b).length, l: i === 0 ? "esta" : `-${i}` });
  }
  barras($("learned-chart"), semanas);

  const vistos = cards.filter(c => dominio(c) !== null).sort((a, b) => dominio(a) - dominio(b));
  $("mastered-tag").textContent = `${cards.filter(c => (dominio(c) ?? 0) >= 0.8).length} dominados`;
  const lista = $("health-list");
  lista.innerHTML = vistos.length ? "" : '<p class="empty-msg">Estude alguns cards para ver a saúde do vocabulário.</p>';
  vistos.slice(0, 150).forEach(c => {
    const pct = Math.round(dominio(c) * 100);
    const cls = pct < 40 ? "health-risco" : pct < 70 ? "health-atencao" : "health-ok";
    const row = document.createElement("div");
    row.className = "health-row";
    row.innerHTML = `<span>${esc(c.Word)}</span><span class="health-dot ${cls}">${pct}%</span>`;
    lista.appendChild(row);
  });
}

// =========================================================
// CONFIGURAÇÕES
// =========================================================
function renderConfig(){
  const p = prefs();
  $("settings-email").textContent = fb.sessao.email || "";
  $("cfg-name").value = state.perfil.Nome || "";
  $("cfg-history").value = state.perfil.Historico || "";
  $("cfg-modes").innerHTML = Object.entries(MODOS).map(([k, m]) =>
    `<label class="check mode"><input type="checkbox" value="${k}" ${p.modos.includes(k) ? "checked" : ""}><span><strong>${m.nome}</strong> — ${m.desc}</span></label>`).join("");
  $("cfg-modes").querySelectorAll("input").forEach(i => i.addEventListener("change", () => {
    const modos = [...$("cfg-modes").querySelectorAll("input:checked")].map(x => x.value);
    if(!modos.length){ i.checked = true; toast("Deixe pelo menos um modo."); return; }
    salvarPrefs({ modos });
  }));
  const sel = $("cfg-voice");
  const vozes = voz.vozesDoIdioma("en");
  sel.innerHTML = '<option value="">Automática</option>' + vozes.map(v => `<option value="${esc(v.name)}">${esc(v.name)}</option>`).join("");
  sel.value = p.voz;
  $("cfg-slow").value = String(p.lento);
  $("cfg-autoplay").checked = !!p.autoplay;
}

function salvarPerfilCampo(campo, valor){
  state.perfil[campo] = valor;
  fb.dbPatch(fb.meu("/Profile"), { [campo]: valor }).catch(err => toast(err.message));
  if(campo === "Nome") publicarJuntos();
}

// =========================================================
// ENTRAR E SAIR
// =========================================================
async function entrar(){
  loading("Carregando seus baralhos…");
  try{
    await carregarTudo();
    $("screen-login").classList.add("hidden");
    $("app-shell").classList.remove("hidden");
    $("sidebar-email").textContent = fb.sessao.email;
    $("nav-deck-count").textContent = Object.keys(state.decks).length;
    let ultimo = null;
    try{ ultimo = localStorage.getItem("fluencia:lastDeck"); }catch(e){}
    state.currentDeckId = ultimo && state.decks[ultimo] ? ultimo : Object.keys(state.decks)[0] || null;
    switchView("view-study");
    publicarJuntos(true);
  }catch(err){
    toast(err.message);
    $("screen-login").classList.remove("hidden");
  }finally{
    pronto();
  }
}

function sair(){
  fb.logout();
  Object.assign(state, { perfil: {}, decks: {}, dias: {}, currentDeckId: null, detailDeckId: null, atual: null, lote: [], conversa: null, juntos: {} });
  $("app-shell").classList.add("hidden");
  $("screen-login").classList.remove("hidden");
  closeMobileSidebar();
}

// =========================================================
// EVENTOS
// =========================================================
function ligar(id, ev, fn){ $(id).addEventListener(ev, fn); }

(function preencherSelects(){
  $("deck-input-language").innerHTML = IDIOMAS.map(l => `<option value="${l.code}">${l.label}</option>`).join("");
  $("deck-input-level").innerHTML = NIVEIS.map(n => `<option value="${n}">${n}</option>`).join("");
})();

async function autenticar(fn){
  const email = $("login-email").value.trim(), senha = $("login-password").value;
  $("login-error").textContent = "";
  if(!email || !senha){ $("login-error").textContent = "Preencha email e senha."; return; }
  loading("Entrando…");
  try{ await fn(email, senha); await entrar(); }
  catch(err){ $("login-error").textContent = fb.traduzirErroAuth(err.message); }
  finally{ pronto(); }
}
ligar("btn-login", "click", () => autenticar(fb.login));
ligar("btn-signup", "click", () => {
  if($("login-password").value.length < 6){ $("login-error").textContent = "A senha precisa ter ao menos 6 caracteres."; return; }
  autenticar(fb.signup);
});
ligar("link-forgot", "click", async () => {
  const email = $("login-email").value.trim();
  if(!email){ $("login-error").textContent = "Digite seu email para redefinir a senha."; return; }
  await acao("Enviando email…", async () => { await fb.forgotPassword(email); toast("Email de redefinição enviado para " + email); });
});
["login-email", "login-password"].forEach(id => ligar(id, "keydown", e => { if(e.key === "Enter") $("btn-login").click(); }));

ligar("btn-logout", "click", sair);
ligar("btn-logout-2", "click", sair);
document.querySelectorAll(".nav-item").forEach(n => n.addEventListener("click", () => switchView(n.dataset.view)));
ligar("btn-hamburger", "click", openMobileSidebar);
ligar("sidebar-backdrop", "click", closeMobileSidebar);

// Estudar
ligar("btn-turn", "click", mostrarVerso);
ligar("btn-wrong", "click", () => responder("errei"));
ligar("btn-warning", "click", () => responder("quase"));
ligar("btn-correct", "click", () => responder("acertei"));
ligar("btn-correct-plus", "click", () => responder("facil"));
ligar("btn-sound", "click", () => tocar(1));
ligar("btn-sound-slow", "click", () => tocar(prefs().lento));
ligar("front-play", "click", () => tocar(1));
ligar("btn-speak", "click", falarResposta);
ligar("btn-record", "click", gravarVoz);
ligar("btn-myvoice", "click", () => state.gravacaoUrl && new Audio(state.gravacaoUrl).play());
ligar("btn-check-typed", "click", conferirDigitado);
ligar("type-answer", "keydown", e => { if(e.key === "Enter"){ e.preventDefault(); conferirDigitado(); } });
ligar("study-deck-select", "change", e => { state.currentDeckId = e.target.value; lembrarDeck(state.currentDeckId); proximoCard(); });
ligar("btn-goto-decks", "click", () => {
  if(!Object.keys(state.decks).length){ switchView("view-decks"); abrirDeckModal("create"); }
  else abrirDetalhe(state.currentDeckId);
});
ligar("btn-study-evolve-goto", "click", () => state.currentDeckId && abrirDetalhe(state.currentDeckId));

document.addEventListener("keydown", e => {
  if(!$("view-study").classList.contains("active") || $("app-shell").classList.contains("hidden")) return;
  if(e.target.closest("input, textarea, select") || document.querySelector(".modal-backdrop:not(.hidden)")) return;
  if(e.key === " "){ e.preventDefault(); if(!state.virado) mostrarVerso(); }
  else if(state.virado && ["1", "2", "3", "4"].includes(e.key)) responder(["errei", "quase", "acertei", "facil"][+e.key - 1]);
});

// Baralhos
ligar("btn-new-deck", "click", () => abrirDeckModal("create"));
ligar("deck-modal-cancel", "click", () => $("deck-modal").classList.add("hidden"));
ligar("deck-modal-save", "click", salvarDeckModal);
ligar("detail-back", "click", () => switchView("view-decks"));
ligar("btn-edit-deck", "click", () => abrirDeckModal("edit", state.detailDeckId));
ligar("btn-delete-deck", "click", () => excluirDeck(state.detailDeckId));
ligar("btn-change-theme", "click", () => { $("theme-input-new").value = state.decks[state.detailDeckId].Objetivo || ""; $("theme-modal").classList.remove("hidden"); });
ligar("theme-modal-cancel", "click", () => $("theme-modal").classList.add("hidden"));
ligar("theme-modal-save", "click", trocarObjetivo);
ligar("btn-gen-trail", "click", async () => {
  const deck = state.decks[state.detailDeckId];
  if(deck.Trilha.length && !await confirmar({ title: "Refazer a trilha", desc: "A IA monta uma trilha nova. Os cards ficam, mas podem perder a ligação com as unidades antigas.", confirmLabel: "Refazer" })) return;
  gerarTrilha(state.detailDeckId);
});
ligar("btn-gen-unit", "click", gerarDaUnidade);
ligar("btn-next-unit", "click", () => escolherUnidade((state.decks[state.detailDeckId].UnidadeAtual || 0) + 1));
ligar("btn-add-word", "click", gerarDeAlvos);
ligar("input-new-word", "keydown", e => { if(e.key === "Enter") gerarDeAlvos(); });
ligar("btn-mine", "click", extrairTexto);
ligar("btn-batch-save", "click", salvarLote);
ligar("btn-batch-discard", "click", () => { state.lote = []; renderLote(); });
ligar("card-filter", "input", renderCards);
ligar("card-modal-cancel", "click", () => $("card-modal").classList.add("hidden"));
ligar("card-modal-save", "click", salvarEditarCard);

// Conversar
ligar("btn-talk-start", "click", comecarConversa);
ligar("btn-talk-send", "click", enviarFala);
ligar("btn-talk-mic", "click", microfoneConversa);
ligar("btn-talk-end", "click", encerrarConversa);
ligar("talk-input", "keydown", e => { if(e.key === "Enter" && !e.shiftKey){ e.preventDefault(); enviarFala(); } });

// Nível, Juntos, Estatísticas
ligar("btn-level-start", "click", comecarTeste);
ligar("btn-together-refresh", "click", abrirJuntos);
ligar("btn-route", "click", gerarRoteiro);
ligar("stats-deck-select", "change", e => { state.statsDeckId = e.target.value; renderStats(); });

// Configurações
let nomeTimer = null, histTimer = null;
ligar("cfg-name", "input", e => { clearTimeout(nomeTimer); nomeTimer = setTimeout(() => salvarPerfilCampo("Nome", e.target.value.trim()), 600); });
ligar("cfg-history", "input", e => { clearTimeout(histTimer); histTimer = setTimeout(() => salvarPerfilCampo("Historico", e.target.value.trim().slice(0, 3000)), 800); });
ligar("cfg-voice", "change", e => { salvarPrefs({ voz: e.target.value }); voz.falar("This is how I sound.", { voz: e.target.value }); });
ligar("cfg-slow", "change", e => salvarPrefs({ lento: Number(e.target.value) }));
ligar("cfg-autoplay", "change", e => salvarPrefs({ autoplay: e.target.checked }));

// =========================================================
// INÍCIO
// =========================================================
if("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});

(async () => {
  loading("Abrindo…");
  const ok = await fb.retomarSessao();
  pronto();
  if(ok) entrar();
  else $("screen-login").classList.remove("hidden");
})();
