import * as fb from "./firebase.js";
import { pedir } from "./ia.js";
import * as P from "./ia-pedidos.js";
import { MODOS, sortear, registrarResposta, estadoModo, dominio, lacuna, hojeLocal, sequencia } from "./selecao.js";
import * as voz from "./voz.js";

const { IDIOMAS, NIVEIS, MAX_CARD_LEVEL, idiomaLabel } = P;
const EVOLVE_STREAK_THRESHOLD = 5;
const NOMES_CENARIO = { rh: "Entrevista de RH", tecnica: "Entrevista técnica", viagem: "Viagem", livre: "Conversa livre" };
const reduzMovimento = matchMedia("(prefers-reduced-motion: reduce)").matches;

// =========================================================
// ESTADO
// =========================================================
const state = {
  perfil: {}, decks: {}, dias: {},
  currentDeckId: null, deckId: null, statsDeckId: "all",
  atual: null, virado: false, visto: false,
  lote: [], loteDeckId: null,
  gravacaoUrl: null, ultimaFala: "",
  conversa: null, cenario: "rh",
  teste: null, juntos: {}, roteiro: null,
};
const prefs = () => Object.assign(
  { modos: ["rec", "prod", "ouv", "comp"], voz: "", lento: 0.7, autoplay: false, vibrar: true },
  state.perfil.Prefs || {}
);

// =========================================================
// DOM
// =========================================================
const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const ICONE = {
  som: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 10v4h4l5 4V6L8 10z"/><path d="M16 9a4 4 0 010 6"/></svg>',
  play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5l11 7-11 7z" fill="currentColor"/></svg>',
  rec: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="6" fill="currentColor"/></svg>',
  ok: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  x: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
};

let toastTimer = null;
function toast(msg){
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 3400);
}

// Aviso de "trabalhando" no topo, sem bloquear a tela inteira.
let ocupados = 0;
function ocupado(texto){
  ocupados++;
  $("busy-text").textContent = texto || "Carregando…";
  $("busy").classList.remove("hidden");
}
function livre(){
  ocupados = Math.max(0, ocupados - 1);
  if(!ocupados) $("busy").classList.add("hidden");
}
async function acao(texto, fn, botao){
  if(botao){ if(botao.disabled) return; botao.disabled = true; }
  ocupado(texto);
  try{ return await fn(); }
  catch(err){ console.warn(err); toast(err.message || "Algo deu errado."); }
  finally{ livre(); if(botao) botao.disabled = false; }
}

function vibrar(ms = 12){ if(prefs().vibrar) try{ navigator.vibrate?.(ms); }catch(e){} }

function marcarAlvo(frase, alvo){
  if(!frase) return "";
  const m = alvo && frase.match(reAlvo(alvo));
  if(!m) return esc(frase);
  return esc(frase.slice(0, m.index)) + `<mark>${esc(m[0])}</mark>` + esc(frase.slice(m.index + m[0].length));
}
function reAlvo(alvo){ return new RegExp(`\\b${alvo.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\w*`, "i"); }

// =========================================================
// CAMADAS: folha, conversa, subtela e modo no carro fecham com o "voltar"
// =========================================================
const camadas = [];
function abrirCamada(fechar){
  camadas.push(fechar);
  history.pushState({ camada: camadas.length }, "");
}
function fecharCamada(){ if(camadas.length) history.back(); }
addEventListener("popstate", () => { const f = camadas.pop(); if(f) f(); });

// ---------- Folha (bottom sheet) ----------
let aoFecharFolha = null;
function abrirFolha(html, { aoFechar } = {}){
  const raiz = $("sheet-root");
  const aberta = !raiz.hidden;
  $("sheet-content").innerHTML = html;
  $("sheet-content").scrollTop = 0;
  aoFecharFolha = aoFechar || null;
  if(!aberta){
    raiz.hidden = false;
    requestAnimationFrame(() => raiz.classList.add("aberta"));
    abrirCamada(fecharFolhaAgora);
  }
  return $("sheet-content");
}
function fecharFolhaAgora(){
  const raiz = $("sheet-root");
  raiz.classList.remove("aberta");
  $("sheet").style.transform = "";
  setTimeout(() => { if(!raiz.classList.contains("aberta")) raiz.hidden = true; }, 320);
  const f = aoFecharFolha; aoFecharFolha = null;
  if(f) f();
}
const fecharFolha = () => { if(!$("sheet-root").hidden) fecharCamada(); };

(function arrastarFolha(){
  const sheet = $("sheet");
  let y0 = null, dy = 0;
  const inicio = e => {
    if(e.target.closest("#sheet-grip") || ($("sheet-content").scrollTop <= 0 && e.target.closest(".sheet-title"))){
      y0 = e.clientY; dy = 0; sheet.classList.add("arrastando");
    }
  };
  sheet.addEventListener("pointerdown", inicio);
  addEventListener("pointermove", e => {
    if(y0 === null) return;
    dy = Math.max(0, e.clientY - y0);
    sheet.style.transform = `translateY(${dy}px)`;
  });
  addEventListener("pointerup", () => {
    if(y0 === null) return;
    sheet.classList.remove("arrastando");
    y0 = null;
    if(dy > 90) fecharFolha(); else sheet.style.transform = "";
  });
  $("sheet-backdrop").addEventListener("click", fecharFolha);
  addEventListener("keydown", e => { if(e.key === "Escape" && !$("sheet-root").hidden) fecharFolha(); });
})();

function confirmar({ titulo, texto, botao = "Confirmar", perigo = true }){
  return new Promise(resolve => {
    let respondido = false;
    const c = abrirFolha(`
      <h2 class="sheet-title">${esc(titulo)}</h2>
      <p class="sheet-sub">${esc(texto)}</p>
      <div class="row-2"><button class="btn btn-ghost" data-r="0">Cancelar</button><button class="btn ${perigo ? "btn-danger" : "btn-yel"}" data-r="1">${esc(botao)}</button></div>`,
      { aoFechar: () => { if(!respondido) resolve(false); } });
    c.querySelectorAll("[data-r]").forEach(b => b.addEventListener("click", () => {
      respondido = true; resolve(b.dataset.r === "1"); fecharFolha();
    }));
  });
}

// =========================================================
// LETRAS DE PAINEL DE AEROPORTO
// =========================================================
const GIRO = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
function painel(el, texto, alvo, animar = true){
  el.innerHTML = "";
  el.className = "flap" + (texto.length > 95 ? " muito-longo" : texto.length > 60 ? " longo" : "");
  let ini = -1, fim = -1;
  const m = alvo && texto.match(reAlvo(alvo));
  if(m){ ini = m.index; fim = m.index + m[0].length; }
  const tiles = [];
  let pos = 0;
  for(const palavra of texto.split(" ")){
    const w = document.createElement("span");
    w.className = "fw";
    // A lacuna do Completar vira uma peça só, de largura limitada.
    const pedacos = palavra.match(/_+|[^_]/g) || [];
    for(const ch of pedacos){
      const t = document.createElement("span");
      if(ch[0] === "_"){
        t.className = "ft gap";
        t.style.width = `${Math.min(ch.length, 9) * 0.62 + 0.4}em`;
        t.textContent = " ";
      }else{
        t.className = "ft" + (pos >= ini && pos < fim ? " al" : "");
        t.textContent = ch;
      }
      t.dataset.c = t.textContent;
      w.appendChild(t);
      tiles.push(t);
      pos += ch.length;
    }
    pos++; // o espaço
    el.appendChild(w);
  }
  if(!animar || reduzMovimento) return;
  const t0 = performance.now();
  const alvos = tiles.map((t, i) => ({ t, ate: 140 + Math.min(i * 14, 520) + Math.random() * 120, ok: false }))
    .filter(a => /[A-Za-z]/.test(a.t.dataset.c));
  alvos.forEach(a => a.t.classList.add("gira"));
  const passo = agora => {
    let faltam = 0;
    for(const a of alvos){
      if(a.ok) continue;
      if(agora - t0 >= a.ate){ a.t.textContent = a.t.dataset.c; a.t.classList.remove("gira"); a.ok = true; }
      else{ a.t.textContent = GIRO[(Math.random() * GIRO.length) | 0]; faltam++; }
    }
    if(faltam) requestAnimationFrame(passo);
  };
  requestAnimationFrame(passo);
}

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
const alvosExistentes = deck => Object.values(deck.Cards).map(c => c.Word);

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
function salvarPerfilCampo(campo, valor){
  state.perfil[campo] = valor;
  fb.dbPatch(fb.meu("/Profile"), { [campo]: valor }).catch(err => toast(err.message));
  if(campo === "Nome") publicarJuntos();
}
const hojeR = () => (state.dias[hojeLocal()] && state.dias[hojeLocal()].r) || 0;
function somarDia(campos){
  const hoje = hojeLocal();
  const d = Object.assign({ r: 0, a: 0, f: 0, rm: 0, ra: 0 }, state.dias[hoje]);
  for(const k in campos) d[k] += campos[k];
  state.dias[hoje] = d;
  fb.dbPut(fb.meu(`/Dias/${hoje}`), d).catch(() => {});
}

// ---------- Juntos: o resumo público de cada um ----------
let juntosTimer = null;
function publicarJuntos(imediato = false){
  clearTimeout(juntosTimer);
  const enviar = () => {
    const dias7 = {};
    for(let i = 0; i < 7; i++){
      const d = new Date(); d.setDate(d.getDate() - i);
      dias7[hojeLocal(d)] = (state.dias[hojeLocal(d)] && state.dias[hojeLocal(d)].r) || 0;
    }
    const deck = state.decks[state.currentDeckId] || Object.values(state.decks)[0];
    const fracas = deck ? Object.values(deck.Cards)
      .filter(c => !c.Suspended && estadoModo(c, "rec").n > 0)
      .sort((a, b) => (dominio(a) ?? 0) - (dominio(b) ?? 0))
      .slice(0, 10).map(c => c.Word) : [];
    fb.dbPatch(`${fb.RAIZ}/juntos/${fb.sessao.uid}`, {
      Nome: state.perfil.Nome || "",
      Sequencia: sequencia(state.dias),
      Hoje: { data: hojeLocal(), r: hojeR() },
      Dias7: dias7,
      Nivel: state.perfil.UltimoNivel || (deck && deck.Nivel) || "",
      Objetivo: (deck && deck.Objetivo) || "",
      Idioma: (deck && deck.Language) || "en",
      Fracas: fracas,
      Atualizado: new Date().toISOString(),
    }).catch(() => {});
  };
  if(imediato) enviar(); else juntosTimer = setTimeout(enviar, 4000);
}

// =========================================================
// NAVEGAÇÃO
// =========================================================
const ABA_DE = { "v-deck": "v-decks", "v-you": "v-together" };
const ORDEM = ["v-study", "v-talk", "v-decks", "v-together"];
let viewAtual = "v-study";

function irPara(view, { camada = false } = {}){
  const de = viewAtual;
  const para = view;
  const tras = ORDEM.indexOf(ABA_DE[para] || para) < ORDEM.indexOf(ABA_DE[de] || de) && !camada;
  document.querySelectorAll(".view").forEach(v => {
    v.classList.toggle("active", v.id === para);
    v.classList.toggle("de-tras", v.id === para && tras);
  });
  const aba = ABA_DE[para] || para;
  document.querySelectorAll(".tab").forEach(t => t.classList.toggle("active", t.dataset.view === aba));
  $("app").classList.toggle("estudando", para === "v-study");
  viewAtual = para;
  voz.pararFala();
  $("main").scrollTop = 0;
  if(para === "v-study"){ atualizarTopo(); proximoCard(false); }
  if(para === "v-decks") renderDecks();
  if(para === "v-deck") renderDeck();
  if(para === "v-talk") abrirConversar();
  if(para === "v-together") abrirJuntos();
  if(para === "v-you") abrirVoce();
  if(camada) abrirCamada(() => irPara(de));
}

function atualizarTopo(){
  const deck = state.decks[state.currentDeckId];
  $("deck-chip-name").textContent = deck ? deck.Name : "Sem baralho";
  $("stat-today-top").textContent = hojeR();
  $("stat-streak-top").textContent = sequencia(state.dias);
}

function lembrarDeck(id){ try{ localStorage.setItem("fluencia:lastDeck", id); }catch(e){} }

function escolherDeck(){
  const ids = Object.keys(state.decks);
  const c = abrirFolha(`
    <h2 class="sheet-title">Estudar qual baralho?</h2>
    <div class="menu">${ids.map(id => `<button data-id="${id}" class="${id === state.currentDeckId ? "on" : ""}">${esc(state.decks[id].Name)} <span class="tag">${esc(idiomaLabel(state.decks[id].Language))}</span></button>`).join("")}
    <button data-id="">Gerenciar baralhos</button></div>`);
  c.querySelectorAll("[data-id]").forEach(b => b.addEventListener("click", () => {
    fecharFolha();
    if(!b.dataset.id){ setTimeout(() => irPara("v-decks"), 50); return; }
    state.currentDeckId = b.dataset.id;
    lembrarDeck(b.dataset.id);
    atualizarTopo();
    proximoCard();
  }));
}

// =========================================================
// ESTUDAR
// =========================================================
function modosAtivos(){
  const m = prefs().modos.filter(k => MODOS[k]);
  return m.length ? m : ["rec"];
}
const cardAtual = () => {
  const deck = state.decks[state.currentDeckId];
  return deck && state.atual ? deck.Cards[state.atual.key] : null;
};

function proximoCard(animar = true){
  if(Object.keys(state.decks).length && !state.decks[state.currentDeckId]) state.currentDeckId = Object.keys(state.decks)[0];
  const deck = state.decks[state.currentDeckId];
  const ativos = deck ? Object.values(deck.Cards).filter(c => !c.Suspended).length : 0;
  const vazio = !ativos;
  ["ticket-stage", "tools"].forEach(id => $(id).classList.toggle("hidden", vazio));
  $("study-empty").classList.toggle("hidden", !vazio);
  $("gradebar").classList.toggle("hidden", vazio);
  atualizarTopo();
  if(vazio){
    $("type-row").classList.add("hidden");
    $("feedback").classList.add("hidden");
    const semDeck = !deck;
    $("study-empty-title").textContent = semDeck ? "Nenhum baralho ainda" : "Baralho sem cards";
    $("study-empty-text").textContent = semDeck
      ? "Crie um baralho com o seu objetivo, e a IA monta a trilha e os cards."
      : "Gere os cards da primeira unidade da trilha para começar.";
    $("btn-goto-decks").textContent = semDeck ? "Criar meu primeiro baralho" : "Abrir o baralho";
    return;
  }
  state.atual = sortear(state.currentDeckId, deck.Cards, modosAtivos(), { temAudio: voz.temFala });
  state.virado = false;
  state.visto = false;
  limparFeedback();
  mostrarFrente(animar);
}

function mostrarFrente(animar){
  const deck = state.decks[state.currentDeckId];
  const card = cardAtual();
  if(!card) return;
  const modo = state.atual.modo;
  const ticket = $("ticket");
  // Desvira sem animar: o card novo entra já de frente.
  ticket.classList.add("sem-transicao");
  ticket.classList.remove("flipped", "ok", "erro");
  void ticket.offsetWidth;
  ticket.classList.remove("sem-transicao");
  mostrarDica(0);
  setNotas(false);

  const unidade = deck.Trilha && card.Unit != null ? deck.Trilha[card.Unit] : null;
  $("tk-mode").textContent = MODOS[modo].nome;
  $("tk-unit").textContent = unidade ? unidade.Titulo : (card.Kind || "palavra");
  $("tk-level").textContent = `frase ${card.Level || 1}/${MAX_CARD_LEVEL}`;

  const corpo = $("front-body");
  corpo.innerHTML = "";
  const rotulo = txt => { const l = document.createElement("div"); l.className = "label"; l.textContent = txt; corpo.appendChild(l); };
  if(modo === "rec"){
    rotulo("O que quer dizer?");
    const f = document.createElement("div"); corpo.appendChild(f);
    painel(f, card.Phrase, card.Word, animar);
  }else if(modo === "prod"){
    rotulo(`Diga em ${idiomaLabel(deck.Language).toLowerCase()}`);
    corpo.insertAdjacentHTML("beforeend", `<div class="pt-big">${esc(card.Translation)}</div>` +
      (card.Kind === "palavra" ? "" : '<div class="pt small">use uma expressão</div>'));
  }else if(modo === "ouv"){
    rotulo("Ouça e entenda");
    const b = document.createElement("button");
    b.className = "play-big"; b.setAttribute("aria-label", "Ouvir a frase"); b.innerHTML = ICONE.play;
    b.addEventListener("pointerdown", e => e.stopPropagation());
    b.addEventListener("click", e => { e.stopPropagation(); tocar(1); });
    corpo.appendChild(b);
    setTimeout(() => tocar(1), 350);
  }else if(modo === "comp"){
    rotulo("Complete a frase");
    const f = document.createElement("div"); corpo.appendChild(f);
    painel(f, lacuna(card.Phrase, card.Word) || card.Phrase, null, animar);
    corpo.insertAdjacentHTML("beforeend", `<div class="pt small">${esc(card.Translation)}</div>`);
  }

  const audioNaFrente = modo === "rec" || modo === "ouv";
  $("btn-sound").disabled = $("btn-sound-slow").disabled = !voz.temFala || !audioNaFrente;
  $("btn-speak").classList.toggle("hidden", !voz.temReconhecimento);
  $("speak-label").textContent = modo === "prod" ? "Responder" : "Ler";
  $("type-row").classList.toggle("hidden", modo !== "prod" && modo !== "comp");
  $("type-answer").value = "";
  $("type-answer").placeholder = modo === "comp" ? "Opcional: a palavra que falta" : "Opcional: escreva e confira";

  if(animar && !reduzMovimento){
    $("ticket-stage").animate(
      [{ transform: "translateY(40px) scale(.96)", opacity: 0 }, { transform: "none", opacity: 1 }],
      { duration: 420, easing: "cubic-bezier(.34,1.4,.5,1)" });
  }
}

function renderVerso(){
  const card = cardAtual();
  const modo = state.atual.modo;
  $("tk-mode-b").textContent = MODOS[modo].nome;
  const s = estadoModo(card, modo);
  $("tk-dom").textContent = s.n ? `domínio ${Math.round(s.m * 100)}%` : "card novo";
  $("tk-alvo").textContent = `alvo: ${card.Word}`;
  const corpo = $("back-body");
  corpo.innerHTML = "";
  const f = document.createElement("div"); corpo.appendChild(f);
  painel(f, card.Phrase, card.Word, true);
  corpo.insertAdjacentHTML("beforeend", `<div class="pt">${esc(card.Translation)}</div>`);
}

function virar(){
  if(!cardAtual()) return;
  if(!state.virado){
    if(!state.visto) renderVerso();
    state.virado = true;
    const primeira = !state.visto;
    state.visto = true;
    $("ticket").classList.add("flipped");
    setNotas(true);
    $("btn-sound").disabled = $("btn-sound-slow").disabled = !voz.temFala;
    $("speak-label").textContent = "Repetir";
    $("type-row").classList.add("hidden");
    if(primeira && prefs().autoplay && state.atual.modo !== "ouv") tocar(1);
  }else{
    state.virado = false;
    $("ticket").classList.remove("flipped");
  }
}

function setNotas(on){
  document.querySelectorAll(".grade").forEach(b => { b.disabled = !on; b.classList.remove("sugerido"); });
}
function sugerirNota(nota){
  document.querySelectorAll(".grade").forEach(b => b.classList.toggle("sugerido", b.dataset.nota === nota));
}
function tocar(velocidade){
  const card = cardAtual();
  if(!card) return;
  voz.falar(card.Phrase, { idioma: state.decks[state.currentDeckId].Language, voz: prefs().voz, velocidade });
}

function limparFeedback(){
  $("feedback").classList.add("hidden");
  $("feedback").innerHTML = "";
  if(state.gravacaoUrl){ URL.revokeObjectURL(state.gravacaoUrl); state.gravacaoUrl = null; }
}
function mostrarFeedback(html, acoes = false){
  const box = $("feedback");
  box.innerHTML = html + (acoes ? `<div class="fb-actions">
      <button class="btn btn-ghost btn-sm" data-fb="ouvir">${ICONE.som} Ouvir</button>
      ${voz.temGravacao ? `<button class="btn btn-ghost btn-sm" data-fb="gravar">${ICONE.rec} Gravar minha voz</button>` : ""}
      ${state.gravacaoUrl ? `<button class="btn btn-ghost btn-sm" data-fb="minha">${ICONE.play} Minha voz</button>` : ""}
    </div>` : "");
  box.classList.remove("hidden");
  box.querySelector('[data-fb="ouvir"]')?.addEventListener("click", () => tocar(1));
  box.querySelector('[data-fb="gravar"]')?.addEventListener("click", e => gravarVoz(e.currentTarget));
  box.querySelector('[data-fb="minha"]')?.addEventListener("click", () => state.gravacaoUrl && new Audio(state.gravacaoUrl).play());
}
const ONDA = '<span class="onda"><i></i><i></i><i></i><i></i><i></i></span>';

function htmlComparacao(marcas, dito){
  const palavras = marcas.map((m, i) => `<span class="w w-${m.estado}" style="animation-delay:${i * 60}ms">${esc(m.palavra)}</span>`).join(" ");
  return `<div class="fb-line"><span class="fb-label">esperado</span>${palavras}</div>` +
    `<div class="fb-line"><span class="fb-label">você disse</span>${esc(dito || "(nada)")}</div>`;
}

let falasPendentes = 0;
async function falarResposta(){
  const card = cardAtual();
  if(!card) return;
  const deck = state.decks[state.currentDeckId];
  const modo = state.atual.modo;
  const btn = $("btn-speak");
  if(btn.classList.contains("ouvindo")){ voz.pararOuvir(); return; }
  voz.pararFala();
  btn.classList.add("ouvindo");
  const rotulo = $("speak-label").textContent;
  $("speak-label").textContent = "Parar";
  mostrarFeedback(`<div class="fb-line muted">${ONDA}Ouvindo…</div>`);
  let dito = "";
  try{
    dito = await voz.ouvir({ idioma: deck.Language, onParcial: t => mostrarFeedback(`<div class="fb-line">${ONDA}${esc(t)}</div>`) });
  }catch(err){
    mostrarFeedback(`<div class="fb-line muted">${esc(err.message)}</div>`);
    return;
  }finally{
    btn.classList.remove("ouvindo");
    $("speak-label").textContent = rotulo;
  }
  if(!dito){ mostrarFeedback('<div class="fb-line muted">Não ouvi nada. Tente de novo, ou responda pelos botões.</div>'); return; }
  falasPendentes++;
  if(modo === "prod" && !state.visto){ await avaliarProducao(dito, true); return; }
  const { sim, marcas } = voz.comparar(card.Phrase, dito);
  if(!state.virado) virar();
  mostrarFeedback(htmlComparacao(marcas, dito) + `<div class="fb-line"><span class="fb-label">pronúncia</span>${Math.round(sim * 100)}% das palavras reconhecidas</div>`, true);
  sugerirNota(voz.notaPorSimilaridade(sim));
}

async function avaliarProducao(resposta, falada){
  const card = cardAtual();
  const deck = state.decks[state.currentDeckId];
  mostrarFeedback('<div class="fb-line muted"><span class="onda"><i></i><i></i><i></i></span>Conferindo com a IA…</div>');
  try{
    const r = await pedir(P.pedidoAvaliarProducao(deck, card, resposta, falada));
    if(!state.virado) virar();
    const ok = r.Nota === "facil" || r.Nota === "acertei";
    mostrarFeedback(
      `<div class="fb-line"><span class="fb-label">você ${falada ? "disse" : "escreveu"}</span>${esc(resposta)}</div>` +
      (ok && !r.Explicacao ? "" : `<div class="fb-line"><span class="fb-label">melhor</span>${esc(r.Correcao)}</div>`) +
      (r.Explicacao ? `<div class="fb-line muted">${esc(r.Explicacao)}</div>` : ""), falada);
    sugerirNota(r.Nota);
  }catch(err){
    mostrarFeedback(`<div class="fb-line muted">${esc(err.message)}</div>`);
  }
}

function conferirDigitado(){
  const card = cardAtual();
  const texto = $("type-answer").value.trim();
  if(!card || !texto) return;
  $("type-answer").blur();
  if(state.atual.modo === "comp"){
    const dado = texto.toLowerCase().replace(/[^\p{L}\p{N}' ]/gu, "").trim();
    const alvo = card.Word.toLowerCase().trim();
    const nota = dado === alvo ? "facil" : (dado && alvo.startsWith(dado.slice(0, Math.max(3, dado.length - 2))) ? "quase" : "errei");
    if(!state.virado) virar();
    mostrarFeedback(`<div class="fb-line"><span class="fb-label">você escreveu</span>${esc(texto)}</div>`);
    sugerirNota(nota);
    return;
  }
  avaliarProducao(texto, false);
}

async function gravarVoz(btn){
  if(btn.classList.contains("ouvindo")){ voz.pararGravacao(); return; }
  try{
    btn.classList.add("ouvindo");
    btn.innerHTML = `${ICONE.rec} Parar`;
    const url = await voz.gravar(12000);
    if(state.gravacaoUrl) URL.revokeObjectURL(state.gravacaoUrl);
    state.gravacaoUrl = url;
    new Audio(url).play();
    const box = $("feedback");
    if(!box.querySelector('[data-fb="minha"]')){
      box.querySelector(".fb-actions")?.insertAdjacentHTML("beforeend", `<button class="btn btn-ghost btn-sm" data-fb="minha">${ICONE.play} Minha voz</button>`);
      box.querySelector('[data-fb="minha"]')?.addEventListener("click", () => state.gravacaoUrl && new Audio(state.gravacaoUrl).play());
    }
  }catch(err){ toast(err.message); }
  finally{ btn.classList.remove("ouvindo"); btn.innerHTML = `${ICONE.rec} Gravar minha voz`; }
}

let respondendo = false;
async function responder(notaKey, saida){
  const deckId = state.currentDeckId;
  const card = cardAtual();
  if(!card || !state.visto || respondendo) return;
  respondendo = true;
  setNotas(false);
  voz.pararFala();
  vibrar(notaKey === "errei" ? 30 : 12);
  const key = state.atual.key;
  const { maduro } = registrarResposta(card, state.atual.modo, notaKey);
  const acerto = notaKey === "acertei" || notaKey === "facil";
  somarDia({ r: 1, a: acerto ? 1 : 0, rm: maduro ? 1 : 0, ra: maduro && acerto ? 1 : 0, f: falasPendentes });
  falasPendentes = 0;
  fb.dbPatch(fb.meu(`/Decks/${deckId}/Cards/${key}`), {
    Modes: card.Modes, EasyStreak: card.EasyStreak, LearnedAt: card.LearnedAt || null,
  }).catch(err => toast(err.message));
  publicarJuntos();
  if(card.EasyStreak >= EVOLVE_STREAK_THRESHOLD) evoluirCard(deckId, key);

  const contador = $("stat-today-top");
  contador.textContent = hojeR();
  contador.animate?.([{ transform: "translateY(-6px)", opacity: .3 }, { transform: "none", opacity: 1 }], { duration: 300 });

  // Saída: varredura de cor e o card vai para o lado da nota.
  const ticket = $("ticket");
  ticket.classList.add(acerto ? "ok" : "erro");
  const lado = saida ?? (acerto ? 1 : -1);
  const stage = $("ticket-stage");
  if(!reduzMovimento){
    const atual = getComputedStyle(stage).transform;
    await stage.animate([
      { transform: atual === "none" ? "none" : atual, opacity: 1 },
      { transform: `translateX(${lado * 120}%) rotate(${lado * 14}deg)`, opacity: 0 },
    ], { duration: 280, easing: "cubic-bezier(.5,0,.75,0)" }).finished.catch(() => {});
  }
  stage.style.transform = "";
  mostrarDica(0);
  respondendo = false;
  proximoCard();
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
    toast(`"${card.Word}" subiu para a frase nível ${card.Level}.`);
  }catch(err){ console.warn("Falha ao evoluir", err); }
}

// ---------- Toque vira, arrastar responde ----------
function mostrarDica(dx){
  const r = Math.min(1, Math.abs(dx) / 90);
  document.querySelector(".sh-l").style.opacity = dx < 0 ? r : 0;
  document.querySelector(".sh-r").style.opacity = dx > 0 ? r : 0;
}
(function gestosDoCard(){
  const ticket = $("ticket"), stage = $("ticket-stage");
  let x0 = 0, y0 = 0, dx = 0, ativo = false, arrastando = false, id = null;
  ticket.addEventListener("pointerdown", e => {
    if(respondendo || e.button > 0) return;
    ativo = true; arrastando = false; dx = 0; x0 = e.clientX; y0 = e.clientY; id = e.pointerId;
  });
  ticket.addEventListener("pointermove", e => {
    if(!ativo || e.pointerId !== id) return;
    const mx = e.clientX - x0, my = e.clientY - y0;
    if(!arrastando){
      if(Math.abs(mx) > 10 && Math.abs(mx) > Math.abs(my) && state.visto){
        arrastando = true;
        ticket.setPointerCapture(id);
      }else return;
    }
    dx = mx;
    stage.style.transform = `translateX(${dx}px) rotate(${dx / 22}deg)`;
    mostrarDica(dx);
  });
  const fim = e => {
    if(!ativo || (e && e.pointerId !== id)) return;
    ativo = false;
    if(!arrastando){ if(e && e.type === "pointerup") virar(); return; }
    arrastando = false;
    if(Math.abs(dx) > 90){ responder(dx > 0 ? "acertei" : "errei", dx > 0 ? 1 : -1); return; }
    stage.animate([{ transform: stage.style.transform }, { transform: "none" }], { duration: 380, easing: "cubic-bezier(.34,1.4,.5,1)" });
    stage.style.transform = "";
    mostrarDica(0);
  };
  ticket.addEventListener("pointerup", fim);
  ticket.addEventListener("pointercancel", fim);
  ticket.addEventListener("keydown", e => { if(e.key === "Enter"){ e.preventDefault(); virar(); } });
})();

// =========================================================
// BARALHOS
// =========================================================
function renderDecks(){
  const ids = Object.keys(state.decks);
  const box = $("deck-list");
  if(!ids.length){
    box.innerHTML = `<div class="empty"><div class="empty-title">Nenhum destino ainda</div><p>Um baralho é um objetivo: a vaga lá fora, uma viagem, um intercâmbio. A IA monta a trilha a partir dele.</p></div>`;
    return;
  }
  box.innerHTML = "";
  ids.forEach((id, i) => {
    const d = state.decks[id];
    const cards = Object.values(d.Cards);
    const total = d.Trilha.length;
    const atual = Math.min((d.UnidadeAtual || 0) + 1, total || 1);
    const el = document.createElement("div");
    el.className = "deck-card";
    el.style.animationDelay = `${i * 60}ms`;
    el.innerHTML = `
      <div class="dc-head"><span>${esc(idiomaLabel(d.Language))} · ${esc(d.Nivel || "—")}</span><span>${total ? `unidade ${atual}/${total}` : "sem trilha"}</span></div>
      <div class="dc-body">
        <div class="dc-name">${esc(d.Name)}</div>
        <div class="dc-goal">${esc(d.Objetivo || "")}</div>
        <div class="progress"><i style="width:${total ? Math.round(atual / total * 100) : 0}%"></i></div>
        <div class="dc-foot"><span>${cards.length} cards</span><span>${cards.filter(c => c.LearnedAt).length} aprendidos</span></div>
      </div>
      <div class="dc-actions"><button class="btn btn-yel btn-sm" data-a="study">Estudar</button><button class="btn btn-ghost btn-sm" data-a="open">Abrir</button></div>`;
    el.querySelector('[data-a="study"]').addEventListener("click", () => { state.currentDeckId = id; lembrarDeck(id); irPara("v-study"); });
    el.querySelector('[data-a="open"]').addEventListener("click", () => abrirDeck(id));
    box.appendChild(el);
  });
}

function formDeck(modo, id){
  const d = modo === "edit" ? state.decks[id] : { Name: "", Language: "en", Nivel: "B1", Objetivo: "", Contexto: "" };
  const c = abrirFolha(`
    <h2 class="sheet-title">${modo === "edit" ? "Editar baralho" : "Novo baralho"}</h2>
    <p class="sheet-sub">O objetivo guia tudo: a trilha, os cards e as conversas.</p>
    <label class="field"><span>Nome</span><input id="f-name" value="${esc(d.Name)}" placeholder="Ex.: Inglês para a vaga"></label>
    <div class="row-2">
      <label class="field"><span>Idioma</span><select id="f-lang">${IDIOMAS.map(l => `<option value="${l.code}" ${l.code === d.Language ? "selected" : ""}>${l.label}</option>`).join("")}</select></label>
      <label class="field"><span>Seu nível</span><select id="f-level">${NIVEIS.map(n => `<option ${n === (d.Nivel || "B1") ? "selected" : ""}>${n}</option>`).join("")}</select></label>
    </div>
    <label class="field"><span>Objetivo</span><input id="f-goal" value="${esc(d.Objetivo || "")}" placeholder="Ex.: conseguir vaga de desenvolvedor no exterior"></label>
    <label class="field"><span>Sobre você (opcional)</span><input id="f-context" value="${esc(d.Contexto || "")}" placeholder="Ex.: desenvolvedor Unity/VR há 6 anos"></label>
    <button class="btn btn-yel btn-block" id="f-save">${modo === "edit" ? "Salvar" : "Criar e montar a trilha"}</button>`);
  c.querySelector("#f-save").addEventListener("click", () => salvarDeck(modo, id, {
    Name: c.querySelector("#f-name").value.trim(),
    Language: c.querySelector("#f-lang").value,
    Nivel: c.querySelector("#f-level").value,
    Objetivo: c.querySelector("#f-goal").value.trim(),
    Contexto: c.querySelector("#f-context").value.trim(),
    UpdatedAt: new Date().toISOString(),
  }));
}

async function salvarDeck(modo, id, dados){
  if(!dados.Name){ toast("Dê um nome ao baralho."); return; }
  if(!dados.Objetivo){ toast("Escreva o objetivo: é ele que guia os cards."); return; }
  fecharFolha();
  if(modo === "edit"){
    await acao("Salvando…", async () => {
      Object.assign(state.decks[id], dados);
      await fb.dbPatch(fb.meu(`/Decks/${id}`), dados);
      renderDeck();
      toast("Baralho salvo.");
    });
    return;
  }
  const novo = novoId("d");
  const deck = Object.assign(dados, { CreatedAt: dados.UpdatedAt, Cards: {}, Trilha: [], UnidadeAtual: 0 });
  await acao("Criando o baralho…", async () => {
    await fb.dbPut(fb.meu(`/Decks/${novo}`), deck);
    state.decks[novo] = deck;
    state.currentDeckId = novo;
    lembrarDeck(novo);
  });
  if(!state.decks[novo]) return;
  setTimeout(() => abrirDeck(novo), 60);
  await gerarTrilha(novo);
}

async function gerarTrilha(id, botao){
  const deck = state.decks[id];
  await acao("Montando a trilha com a IA…", async () => {
    const r = await pedir(P.pedidoTrilha(deck));
    deck.Trilha = r.Unidades;
    deck.UnidadeAtual = 0;
    await fb.dbPatch(fb.meu(`/Decks/${id}`), { Trilha: deck.Trilha, UnidadeAtual: 0 });
  }, botao);
  if(state.deckId === id && viewAtual === "v-deck") renderDeck();
}

function abrirDeck(id){
  state.deckId = id;
  trocarAba("deck-tabs", "trilha");
  irPara("v-deck", { camada: true });
}

function menuDeck(){
  const id = state.deckId, d = state.decks[id];
  const c = abrirFolha(`
    <h2 class="sheet-title">${esc(d.Name)}</h2>
    <div class="menu">
      <button data-m="edit">Editar baralho</button>
      <button data-m="goal">Trocar o objetivo</button>
      <button data-m="del" class="perigo">Excluir baralho</button>
    </div>`);
  c.querySelector('[data-m="edit"]').addEventListener("click", () => formDeck("edit", id));
  c.querySelector('[data-m="goal"]').addEventListener("click", () => {
    const c2 = abrirFolha(`
      <h2 class="sheet-title">Trocar o objetivo</h2>
      <p class="sheet-sub">As frases de todos os cards são reescritas para o novo objetivo, e a trilha é refeita. As palavras e o progresso ficam.</p>
      <label class="field"><span>Novo objetivo</span><input id="f-newgoal" value="${esc(d.Objetivo || "")}"></label>
      <button class="btn btn-yel btn-block" id="f-go">Trocar</button>`);
    c2.querySelector("#f-go").addEventListener("click", () => trocarObjetivo(c2.querySelector("#f-newgoal").value.trim()));
  });
  c.querySelector('[data-m="del"]').addEventListener("click", async () => {
    fecharFolha();
    await new Promise(r => setTimeout(r, 340));
    excluirDeck(id);
  });
}

async function excluirDeck(id){
  const d = state.decks[id];
  if(!await confirmar({ titulo: "Excluir baralho", texto: `Excluir "${d.Name}" e ${Object.keys(d.Cards).length} card(s)? Não dá para desfazer.`, botao: "Excluir" })) return;
  await acao("Excluindo…", async () => {
    await fb.dbDelete(fb.meu(`/Decks/${id}`));
    delete state.decks[id];
    if(state.currentDeckId === id) state.currentDeckId = null;
    fecharCamada();
    toast("Baralho excluído.");
  });
}

function trocarAba(grupo, tab){
  const seg = $(grupo);
  seg.querySelectorAll("button").forEach(b => b.classList.toggle("on", b.dataset.tab === tab));
  seg.parentElement.querySelectorAll(".tabpane").forEach(p => p.classList.toggle("hidden", p.dataset.pane !== tab));
}

function renderDeck(){
  const d = state.decks[state.deckId];
  if(!d) return;
  $("deck-name").textContent = d.Name;
  $("deck-meta").innerHTML = `<span class="tag yel">${esc(idiomaLabel(d.Language))}</span><span class="tag">${esc(d.Nivel || "—")}</span><span class="tag">${esc(d.Objetivo || "sem objetivo")}</span>`;
  $("deck-count").textContent = Object.keys(d.Cards).length;

  const lista = $("trail-list");
  lista.innerHTML = "";
  const atual = d.UnidadeAtual || 0;
  const porUnidade = {};
  Object.values(d.Cards).forEach(c => { if(c.Unit != null) porUnidade[c.Unit] = (porUnidade[c.Unit] || 0) + 1; });
  d.Trilha.forEach((u, i) => {
    const li = document.createElement("li");
    li.className = i === atual ? "atual" : (i < atual ? "feita" : "");
    li.innerHTML = `<button class="trail-btn"><span class="trail-dot">${i < atual ? "✓" : i + 1}</span>
      <span class="trail-txt"><strong>${esc(u.Titulo)}</strong><span>${esc(u.Descricao)}</span><em>${porUnidade[i] || 0} cards</em></span></button>`;
    li.querySelector("button").addEventListener("click", () => escolherUnidade(i));
    lista.appendChild(li);
  });
  const temTrilha = d.Trilha.length > 0;
  $("trail-empty").classList.toggle("hidden", temTrilha);
  $("btn-gen-unit").disabled = !temTrilha;
  $("btn-gen-unit").textContent = temTrilha ? `Gerar 10 cards · ${d.Trilha[atual].Titulo}` : "Gerar 10 cards da unidade";
  $("btn-next-unit").disabled = !temTrilha || atual >= d.Trilha.length - 1;
  $("btn-gen-trail").textContent = temTrilha ? "Refazer trilha" : "Gerar trilha";
  const lote = state.loteDeckId === state.deckId && state.lote.length;
  let verLote = $("btn-ver-lote");
  if(lote && !verLote){
    $("btn-gen-unit").insertAdjacentHTML("beforebegin", '<button class="btn btn-ghost btn-block" id="btn-ver-lote"></button>');
    verLote = $("btn-ver-lote");
    verLote.addEventListener("click", () => abrirLote());
  }
  if(verLote){ verLote.classList.toggle("hidden", !lote); verLote.textContent = `Ver o lote para aprovar (${state.lote.length})`; }
  renderCards();
}

function escolherUnidade(i){
  const d = state.decks[state.deckId];
  d.UnidadeAtual = i;
  fb.dbPatch(fb.meu(`/Decks/${state.deckId}`), { UnidadeAtual: i }).catch(err => toast(err.message));
  renderDeck();
}

// ---------- Lote para aprovar ----------
function abrirLote(carregando = false){
  const c = abrirFolha(`
    <h2 class="sheet-title">Lote para aprovar</h2>
    <p class="sheet-sub">${carregando ? "A IA está escrevendo os cards…" : "Toque para tirar ou devolver. Arrastar para a esquerda tira; para a direita, devolve."}</p>
    <div class="batch-list" id="batch-list">${carregando ? '<div class="skel"></div>'.repeat(5) : ""}</div>
    <div class="row-2 ${carregando ? "hidden" : ""}" id="batch-actions">
      <button class="btn btn-ghost" id="batch-discard">Descartar</button>
      <button class="btn btn-yel" id="batch-save">Adicionar</button>
    </div>`, { aoFechar: () => viewAtual === "v-deck" && renderDeck() });
  if(carregando) return;
  c.querySelector("#batch-discard").addEventListener("click", () => { state.lote = []; fecharFolha(); });
  c.querySelector("#batch-save").addEventListener("click", salvarLote);
  renderLote();
}

function renderLote(){
  const box = $("batch-list");
  if(!box) return;
  box.innerHTML = "";
  state.lote.forEach((c, i) => {
    const el = document.createElement("div");
    el.className = "batch-item" + (c.marcado ? "" : " off");
    el.style.animationDelay = `${i * 50}ms`;
    el.innerHTML = `<div><div class="batch-word">${esc(c.Word)} <span class="tag">${esc(c.Kind)}</span></div>
      <div class="batch-phrase">${marcarAlvo(c.Phrase, c.Word)}</div><div class="batch-phrase">${esc(c.Translation)}</div></div>
      <button class="batch-toggle" aria-label="${c.marcado ? "Tirar do lote" : "Devolver ao lote"}">${c.marcado ? ICONE.ok : ICONE.x}</button>`;
    const alternar = v => { state.lote[i].marcado = v ?? !state.lote[i].marcado; renderLote(); };
    el.querySelector(".batch-toggle").addEventListener("click", () => alternar());
    let x0 = null;
    el.addEventListener("pointerdown", e => { x0 = e.clientX; });
    el.addEventListener("pointermove", e => { if(x0 !== null) el.style.transform = `translateX(${(e.clientX - x0) * .4}px)`; });
    el.addEventListener("pointerup", e => {
      const dx = x0 === null ? 0 : e.clientX - x0; x0 = null; el.style.transform = "";
      if(dx < -60) alternar(false); else if(dx > 60) alternar(true);
    });
    el.addEventListener("pointercancel", () => { x0 = null; el.style.transform = ""; });
    box.appendChild(el);
  });
  const n = state.lote.filter(c => c.marcado).length;
  const salvar = $("batch-save");
  if(salvar){ salvar.textContent = `Adicionar ${n}`; salvar.disabled = !n; }
}

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
  if(!novos){ fecharFolha(); toast("A IA não trouxe nenhum alvo novo. Tente de novo."); return; }
  abrirLote();
}

async function gerarComIA(texto, botao, fazer){
  abrirLote(true);
  await acao(texto, fazer, botao);
  // Se a IA falhou, a folha ainda mostra os esqueletos: volta ao lote ou fecha.
  if($("batch-list")?.querySelector(".skel")){ if(state.lote.length) abrirLote(); else fecharFolha(); }
}

function gerarDaUnidade(){
  const id = state.deckId, d = state.decks[id], u = d.UnidadeAtual || 0;
  gerarComIA("Gerando cards da unidade…", $("btn-gen-unit"), async () => {
    const existentes = [...alvosExistentes(d), ...state.lote.map(c => c.Word)];
    const r = await pedir(P.pedidoNovosCards(d, { unidade: d.Trilha[u], existentes, n: 10 }));
    adicionarAoLote(id, r.Cards, u);
  });
}

function gerarDeAlvos(){
  const id = state.deckId, d = state.decks[id];
  const alvos = $("input-new-word").value.split(/[,;\n]/).map(s => s.trim()).filter(Boolean);
  if(!alvos.length){ toast("Escreva pelo menos um alvo."); return; }
  const vistos = new Set(alvosExistentes(d).map(w => w.toLowerCase()));
  const novos = alvos.filter(a => !vistos.has(a.toLowerCase()));
  if(!novos.length){ toast("Esses alvos já estão no baralho."); return; }
  gerarComIA("Gerando frases…", $("btn-add-word"), async () => {
    const r = await pedir(P.pedidoNovosCards(d, { alvos: novos, existentes: alvosExistentes(d) }));
    $("input-new-word").value = "";
    adicionarAoLote(id, r.Cards, d.Trilha.length ? d.UnidadeAtual || 0 : null);
  });
}

function extrairTexto(){
  const id = state.deckId, d = state.decks[id];
  const texto = $("mine-text").value.trim();
  if(texto.length < 20){ toast("Cole um texto um pouco maior."); return; }
  gerarComIA("Lendo o texto…", $("btn-mine"), async () => {
    const r = await pedir(P.pedidoExtrairTexto(d, texto.slice(0, 12000), alvosExistentes(d)));
    $("mine-text").value = "";
    adicionarAoLote(id, r.Cards, null);
  });
}

async function salvarLote(){
  const id = state.loteDeckId, d = state.decks[id];
  const escolhidos = state.lote.filter(c => c.marcado);
  if(!escolhidos.length) return;
  await acao("Adicionando…", async () => {
    const patch = {};
    for(const c of escolhidos){
      const key = chaveUnica(d, c.Word);
      d.Cards[key] = novoCard(c, c.Unit);
      patch[key] = d.Cards[key];
    }
    await fb.dbPatch(fb.meu(`/Decks/${id}/Cards`), patch);
    state.lote = [];
    fecharFolha();
    toast(`${escolhidos.length} card(s) no baralho.`);
  }, $("batch-save"));
}

// ---------- Lista de cards ----------
function renderCards(){
  const d = state.decks[state.deckId];
  const filtro = $("card-filter").value.trim().toLowerCase();
  const entradas = Object.entries(d.Cards)
    .sort((a, b) => (b[1].CreatedAt || "").localeCompare(a[1].CreatedAt || ""))
    .filter(([, c]) => !filtro || `${c.Word} ${c.Phrase} ${c.Translation}`.toLowerCase().includes(filtro));
  $("cards-empty").classList.toggle("hidden", Object.keys(d.Cards).length > 0);
  const box = $("card-list");
  box.innerHTML = "";
  entradas.slice(0, 250).forEach(([key, c], i) => {
    const dom = dominio(c);
    const cor = dom === null ? "var(--dim)" : dom < .4 ? "var(--red)" : dom < .7 ? "var(--yel)" : "var(--green)";
    const el = document.createElement("button");
    el.className = "card-row" + (c.Suspended ? " suspenso" : "");
    el.style.animationDelay = `${Math.min(i, 12) * 25}ms`;
    el.innerHTML = `<span class="cr-word">${esc(c.Word)}</span>
      <span class="dom" title="${dom === null ? "novo" : Math.round(dom * 100) + "%"}"><i style="width:${dom === null ? 0 : Math.round(dom * 100)}%;background:${cor}"></i></span>
      <span class="cr-phrase">${esc(c.Phrase)}</span>`;
    el.addEventListener("click", () => acoesCard(key));
    box.appendChild(el);
  });
}

function acoesCard(key){
  const id = state.deckId, d = state.decks[id], c = d.Cards[key];
  const dom = dominio(c);
  const n = Object.values(c.Modes || {}).reduce((a, s) => a + (s.n || 0), 0);
  const el = abrirFolha(`
    <h2 class="sheet-title">${esc(c.Word)}</h2>
    <p class="sheet-sub">${marcarAlvo(c.Phrase, c.Word)}<br>${esc(c.Translation)}</p>
    <div class="deck-meta"><span class="tag">${esc(c.Kind || "palavra")}</span><span class="tag">frase ${c.Level || 1}/${MAX_CARD_LEVEL}</span><span class="tag">${dom === null ? "novo" : "domínio " + Math.round(dom * 100) + "%"}</span><span class="tag">${n} revisões</span></div>
    <div class="menu">
      <button data-m="ouvir">Ouvir a frase</button>
      <button data-m="editar">Editar</button>
      <button data-m="frase">Gerar outra frase</button>
      <button data-m="pausa">${c.Suspended ? "Voltar a estudar" : "Pausar este card"}</button>
      <button data-m="del" class="perigo">Excluir card</button>
    </div>`);
  el.querySelector('[data-m="ouvir"]').addEventListener("click", () => voz.falar(c.Phrase, { idioma: d.Language, voz: prefs().voz }));
  el.querySelector('[data-m="editar"]').addEventListener("click", () => editarCard(key));
  el.querySelector('[data-m="frase"]').addEventListener("click", async e => {
    await acao("Gerando nova frase…", async () => {
      const r = await pedir(P.pedidoNovaFrase(d, c, c.Level || 1, false));
      Object.assign(c, { Phrase: r.Phrase, Translation: r.Translation });
      await fb.dbPatch(fb.meu(`/Decks/${id}/Cards/${key}`), { Phrase: c.Phrase, Translation: c.Translation });
      renderCards();
      acoesCard(key);
    }, e.currentTarget);
  });
  el.querySelector('[data-m="pausa"]').addEventListener("click", () => {
    c.Suspended = !c.Suspended;
    fb.dbPatch(fb.meu(`/Decks/${id}/Cards/${key}`), { Suspended: c.Suspended }).catch(err => toast(err.message));
    renderCards();
    fecharFolha();
    toast(c.Suspended ? "Card pausado." : "Card de volta ao estudo.");
  });
  el.querySelector('[data-m="del"]').addEventListener("click", async () => {
    const certeza = await confirmar({ titulo: "Excluir card", texto: `Excluir "${c.Word}"? Não dá para desfazer.`, botao: "Excluir" });
    if(!certeza) return;
    await acao("Excluindo…", async () => {
      await fb.dbDelete(fb.meu(`/Decks/${id}/Cards/${key}`));
      delete d.Cards[key];
      renderDeck();
    });
  });
}

function editarCard(key){
  const id = state.deckId, c = state.decks[id].Cards[key];
  const el = abrirFolha(`
    <h2 class="sheet-title">Editar card</h2>
    <label class="field"><span>Alvo</span><input id="e-word" value="${esc(c.Word)}"></label>
    <label class="field"><span>Frase</span><textarea id="e-phrase" rows="2">${esc(c.Phrase)}</textarea></label>
    <label class="field"><span>Tradução</span><textarea id="e-tr" rows="2">${esc(c.Translation)}</textarea></label>
    <button class="btn btn-yel btn-block" id="e-save">Salvar</button>`);
  el.querySelector("#e-save").addEventListener("click", async () => {
    const patch = { Word: el.querySelector("#e-word").value.trim(), Phrase: el.querySelector("#e-phrase").value.trim(), Translation: el.querySelector("#e-tr").value.trim() };
    if(!patch.Word || !patch.Phrase){ toast("Alvo e frase são obrigatórios."); return; }
    await acao("Salvando…", async () => {
      Object.assign(c, patch);
      await fb.dbPatch(fb.meu(`/Decks/${id}/Cards/${key}`), patch);
      fecharFolha();
      renderCards();
    });
  });
}

async function trocarObjetivo(novo){
  if(!novo){ toast("Escreva o novo objetivo."); return; }
  fecharFolha();
  const id = state.deckId, d = state.decks[id];
  const entradas = Object.entries(d.Cards);
  await acao("Reescrevendo as frases…", async () => {
    const patch = {};
    for(let i = 0; i < entradas.length; i += 20){
      $("busy-text").textContent = `Reescrevendo as frases (${Math.min(i + 20, entradas.length)}/${entradas.length})…`;
      const fatia = entradas.slice(i, i + 20);
      try{
        const r = await pedir(P.pedidoTrocarObjetivo(d, fatia.map(([, c]) => c), novo));
        const porWord = new Map(r.Cards.map(c => [c.Word.toLowerCase().trim(), c]));
        for(const [key, c] of fatia){
          const n = porWord.get(c.Word.toLowerCase().trim());
          if(n){ Object.assign(c, { Phrase: n.Phrase, Translation: n.Translation }); patch[`${key}/Phrase`] = n.Phrase; patch[`${key}/Translation`] = n.Translation; }
        }
      }catch(err){ console.warn("Falha numa parte", err); }
    }
    if(Object.keys(patch).length) await fb.dbPatch(fb.meu(`/Decks/${id}/Cards`), patch);
    d.Objetivo = novo;
    await fb.dbPatch(fb.meu(`/Decks/${id}`), { Objetivo: novo, UpdatedAt: new Date().toISOString() });
  });
  renderDeck();
  await gerarTrilha(id);
}

// =========================================================
// CONVERSAR
// =========================================================
function preencherSelect(sel, atual){
  const ids = Object.keys(state.decks);
  sel.innerHTML = ids.length ? ids.map(id => `<option value="${id}">${esc(state.decks[id].Name)}</option>`).join("") : '<option value="">Nenhum baralho</option>';
  sel.disabled = !ids.length;
  if(ids.length) sel.value = atual && state.decks[atual] ? atual : ids[0];
}

function marcarCenario(v){
  state.cenario = v;
  $("talk-scenario").querySelectorAll(".pill").forEach(p => {
    p.classList.toggle("on", p.dataset.v === v);
    p.setAttribute("aria-checked", p.dataset.v === v);
  });
}

function abrirConversar(){
  preencherSelect($("talk-deck"), state.currentDeckId);
  const deck = state.decks[$("talk-deck").value];
  if(deck && /viag|interc|travel/i.test(deck.Objetivo || "") && state.cenario === "rh") marcarCenario("viagem");
  $("btn-talk-mic").classList.toggle("hidden", !voz.temReconhecimento);
  $("btn-talk-start").textContent = state.conversa ? "Voltar à conversa" : "Começar a conversa";
  carregarHistoricoConversas();
}

async function carregarHistoricoConversas(){
  try{
    const lista = await fb.dbGet(fb.meu("/Conversas"), { orderBy: '"$key"', limitToLast: 15 });
    const box = $("talk-history");
    const itens = Object.entries(lista || {}).reverse();
    if(!itens.length){ box.innerHTML = '<p class="empty-line">Nenhuma conversa ainda.</p>'; return; }
    box.innerHTML = "";
    for(const [, c] of itens){
      const row = document.createElement("button");
      row.className = "hist-row";
      const data = new Date(c.Data).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
      row.innerHTML = `<span>${data} · ${esc(NOMES_CENARIO[c.Cenario] || c.Cenario)}</span><span class="tag yel">${esc(c.Relatorio?.NivelPercebido || "—")}</span>`;
      row.addEventListener("click", () => mostrarRelatorio(c.Relatorio, c.DeckId));
      box.appendChild(row);
    }
  }catch(err){ /* histórico é secundário */ }
}

function abrirSala(){
  $("talk-room").classList.remove("hidden");
  $("app").classList.add("em-conversa");
  $("chat-scenario").textContent = NOMES_CENARIO[state.conversa.opcoes.cenario] || "Conversa";
  renderChat();
  abrirCamada(() => {
    $("talk-room").classList.add("hidden");
    $("app").classList.remove("em-conversa");
    voz.pararFala();
    abrirConversar();
  });
}

async function comecarConversa(){
  if(state.conversa){ abrirSala(); return; }
  const deckId = $("talk-deck").value;
  if(!state.decks[deckId]){ toast("Crie um baralho antes."); return; }
  state.conversa = {
    deckId, turnos: [],
    opcoes: { cenario: state.cenario, vaga: $("talk-context").value.trim().slice(0, 6000), historico: state.perfil.Historico || "" },
  };
  $("talk-report").classList.add("hidden");
  abrirSala();
  await turnoIA();
}

async function turnoIA(){
  const c = state.conversa;
  const deck = state.decks[c.deckId];
  c.esperando = true;
  renderChat();
  try{
    const r = await pedir(P.pedidoTurno(deck, c.opcoes, c.turnos));
    c.turnos.push({ quem: "ia", texto: r.Fala, correcao: r.Correcao && r.Correcao.Melhor ? r.Correcao : null });
    if($("talk-autospeak").checked) voz.falar(r.Fala, { idioma: deck.Language, voz: prefs().voz });
  }catch(err){ toast(err.message); }
  finally{ c.esperando = false; renderChat(); }
}

function renderChat(){
  const c = state.conversa;
  const box = $("chat");
  if(!c){ box.innerHTML = ""; return; }
  const deck = state.decks[c.deckId];
  box.innerHTML = "";
  c.turnos.forEach(t => {
    if(t.quem === "ia" && t.correcao){
      const cor = document.createElement("button");
      cor.className = "correcao";
      cor.innerHTML = `<b>melhor</b>${esc(t.correcao.Melhor)}` + (t.correcao.Explicacao ? `<div class="exp">${esc(t.correcao.Explicacao)}</div>` : "");
      cor.addEventListener("click", () => cor.classList.toggle("aberta"));
      box.appendChild(cor);
    }
    const b = document.createElement("div");
    b.className = `bubble ${t.quem === "ia" ? "ia" : "eu"}`;
    b.textContent = t.texto;
    if(t.quem === "ia"){
      const ouvir = document.createElement("button");
      ouvir.className = "bubble-play"; ouvir.innerHTML = ICONE.som; ouvir.setAttribute("aria-label", "Ouvir");
      ouvir.addEventListener("click", () => voz.falar(t.texto, { idioma: deck.Language, voz: prefs().voz }));
      b.appendChild(ouvir);
    }
    box.appendChild(b);
  });
  if(c.esperando) box.insertAdjacentHTML("beforeend", '<div class="bubble ia digitando"><i></i><i></i><i></i></div>');
  $("btn-talk-send").disabled = $("btn-talk-end").disabled = !!c.esperando;
  box.scrollTop = box.scrollHeight;
}

function ajustarComposer(){
  const t = $("talk-input");
  t.style.height = "auto";
  t.style.height = Math.min(t.scrollHeight, 140) + "px";
}

async function enviarFala(){
  const c = state.conversa;
  const texto = $("talk-input").value.trim();
  if(!c || c.esperando || !texto) return;
  $("talk-input").value = "";
  ajustarComposer();
  c.turnos.push({ quem: "eu", texto });
  vibrar();
  await turnoIA();
}

async function microfoneConversa(){
  const c = state.conversa;
  const btn = $("btn-talk-mic");
  if(btn.classList.contains("ouvindo")){ voz.pararOuvir(); return; }
  voz.pararFala();
  btn.classList.add("ouvindo");
  vibrar();
  const antes = $("talk-input").value.trim();
  try{
    const dito = await voz.ouvir({
      idioma: state.decks[c.deckId].Language,
      onParcial: t => { $("talk-input").value = (antes ? antes + " " : "") + t; ajustarComposer(); },
    });
    if(dito){
      $("talk-input").value = (antes ? antes + " " : "") + dito;
      ajustarComposer();
      somarDia({ f: 1 });
    }
  }catch(err){ toast(err.message); }
  finally{ btn.classList.remove("ouvindo"); }
}

async function encerrarConversa(){
  const c = state.conversa;
  if(!c) return;
  if(!c.turnos.some(t => t.quem === "eu")){
    state.conversa = null;
    fecharCamada();
    return;
  }
  const deck = state.decks[c.deckId];
  let relatorio = null;
  await acao("Montando o relatório…", async () => {
    relatorio = await pedir(P.pedidoRelatorio(deck, c.opcoes, c.turnos, alvosExistentes(deck)));
    await fb.dbPut(fb.meu(`/Conversas/${novoId("c")}`), {
      Data: new Date().toISOString(), Cenario: c.opcoes.cenario, DeckId: c.deckId,
      Turnos: c.turnos.map(t => ({ quem: t.quem, texto: t.texto })), Relatorio: relatorio,
    });
  }, $("btn-talk-end"));
  if(!relatorio) return;
  state.conversa = null;
  fecharCamada();
  setTimeout(() => mostrarRelatorio(relatorio, c.deckId), 80);
}

function mostrarRelatorio(r, deckId){
  if(!r) return;
  const box = $("talk-report");
  const deck = state.decks[deckId];
  const existentes = deck ? new Set(alvosExistentes(deck).map(w => w.toLowerCase())) : new Set();
  const cards = (r.Cards || []).filter(c => !existentes.has(c.Word.toLowerCase()));
  box.innerHTML = `<div class="panel report">
    <div class="route-head"><h2>Relatório</h2><span class="tag yel">nível ${esc(r.NivelPercebido)}</span></div>
    <p class="hint" style="color:var(--ink)">${esc(r.Resumo)}</p>
    ${r.Erros?.length ? `<div class="section-title flat">Erros para treinar</div>` + r.Erros.map(e =>
      `<div class="erro"><div><span class="fb-label">você</span>${esc(e.Original)}</div><div><span class="fb-label">melhor</span><b>${esc(e.Melhor)}</b></div><div class="muted">${esc(e.Explicacao)}</div></div>`).join("") : ""}
    ${r.FrasesUteis?.length ? `<div class="section-title flat">Frases que ajudam</div><ul class="frases">${r.FrasesUteis.map(f => `<li>${esc(f)}</li>`).join("")}</ul>` : ""}
    ${cards.length && deck ? `<div class="section-title flat">Cards sugeridos</div><div class="batch-list" id="report-cards">${cards.map((c, i) =>
      `<label class="batch-item"><div><div class="batch-word">${esc(c.Word)} <span class="tag">${esc(c.Kind)}</span></div><div class="batch-phrase">${marcarAlvo(c.Phrase, c.Word)}</div></div><input type="checkbox" data-i="${i}" checked style="width:22px;height:22px;accent-color:var(--yel)"></label>`).join("")}</div>
      <button class="btn btn-yel btn-block" id="btn-report-add">Adicionar os marcados a "${esc(deck.Name)}"</button>` : ""}
  </div>`;
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
      add.textContent = `${marcados.length} card(s) adicionado(s)`;
    }, add);
    add.disabled = true;
  });
  box.scrollIntoView({ behavior: reduzMovimento ? "auto" : "smooth", block: "start" });
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
  const membros = Object.entries(state.juntos).sort(([a]) => a === fb.sessao.uid ? -1 : 1);
  if(!membros.length) grid.innerHTML = '<p class="empty-line">Ninguém estudou ainda.</p>';
  membros.forEach(([uid, m], idx) => {
    const eu = uid === fb.sessao.uid;
    const dias = [];
    for(let i = 6; i >= 0; i--){
      const d = new Date(); d.setDate(d.getDate() - i);
      dias.push((m.Dias7 && m.Dias7[hojeLocal(d)]) || 0);
    }
    const max = Math.max(1, ...dias);
    const el = document.createElement("div");
    el.className = "member" + (eu ? " eu" : "");
    el.style.animationDelay = `${idx * 80}ms`;
    el.innerHTML = `
      <div class="m-head"><span>${eu ? "Você" : "Em dupla"}</span><span>${esc(m.Nivel || "—")}</span></div>
      <div class="m-body">
        <div class="m-name">${esc(m.Nome || "—")}</div>
        <div class="m-goal">${esc(m.Objetivo || "")}</div>
        <div class="m-nums">
          <div><b>${m.Hoje && m.Hoje.data === hoje ? m.Hoje.r : 0}</b><span>hoje</span></div>
          <div><b>${m.Sequencia || 0}</b><span>dias</span></div>
          <div><b>${esc(m.Nivel || "—")}</b><span>nível</span></div>
        </div>
        <div class="bars mini">${dias.map(r => `<div class="bar-col"><div class="bar-fill" style="height:${Math.max(6, Math.round(r / max * 100))}%"></div></div>`).join("")}</div>
      </div>
      ${eu ? '<button class="btn btn-ghost btn-sm m-you" id="btn-you">Você · estatísticas e ajustes</button>' : ""}`;
    grid.appendChild(el);
  });
  $("btn-you")?.addEventListener("click", () => irPara("v-you", { camada: true }));
  const roteiros = membros.map(([, m]) => m.Roteiro).filter(r => r && r.data === hoje).sort((a, b) => (b.criado || "").localeCompare(a.criado || ""));
  $("route-date").textContent = new Date().toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
  renderRoteiro(roteiros[0]);
}

function renderRoteiro(rot){
  state.roteiro = rot || null;
  const box = $("route-body");
  $("btn-carmode").disabled = !rot;
  if(!rot){ box.innerHTML = '<p class="empty-line">Nenhum roteiro hoje ainda.</p>'; $("btn-route").textContent = "Gerar o de hoje"; return; }
  const r = rot.conteudo;
  $("btn-route").textContent = "Gerar outro";
  box.innerHTML = `
    <h3 class="route-theme">${esc(r.Tema)}</h3>
    <p class="hint">${esc(r.Aquecimento)}</p>
    <ol class="route-q">${r.Perguntas.map(p => `<li><span class="tag yel">${esc(p.Quem)}</span> ${esc(p.Pergunta)}</li>`).join("")}</ol>
    <p class="hint">Gerado por ${esc(rot.por || "")}.</p>`;
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
  }, $("btn-route"));
}

// ---------- Modo no carro ----------
let carPasso = 0;
function abrirCarro(){
  if(!state.roteiro) return;
  carPasso = 0;
  $("carmode").classList.remove("hidden");
  try{ navigator.wakeLock?.request("screen").then(w => { abrirCarro.trava = w; }).catch(() => {}); }catch(e){}
  renderCarro();
  abrirCamada(() => {
    $("carmode").classList.add("hidden");
    abrirCarro.trava?.release?.().catch?.(() => {});
  });
}
function renderCarro(){
  const r = state.roteiro.conteudo;
  const total = r.Perguntas.length + 2;
  $("car-step").textContent = `${carPasso + 1} / ${total}`;
  let html;
  if(carPasso === 0) html = `<div class="car-who">Tema</div><div class="car-q">${esc(r.Tema)}</div><p class="hint">${esc(r.Aquecimento)}</p>`;
  else if(carPasso <= r.Perguntas.length){
    const p = r.Perguntas[carPasso - 1];
    html = `<div class="car-who">${esc(p.Quem)} pergunta</div><div class="car-q">${esc(p.Pergunta)}</div>`;
  }else html = `<div class="car-who">Frases que ajudam</div><ul class="frases car-q" style="font-size:24px">${r.FrasesModelo.map(f => `<li>${esc(f)}</li>`).join("")}</ul>`;
  $("car-body").innerHTML = html;
  $("car-prev").disabled = carPasso === 0;
  $("car-next").textContent = carPasso === total - 1 ? "Fechar" : "Próxima";
}
function carAvancar(d){
  const total = state.roteiro.conteudo.Perguntas.length + 2;
  if(d > 0 && carPasso === total - 1){ fecharCamada(); return; }
  carPasso = Math.max(0, Math.min(total - 1, carPasso + d));
  vibrar(8);
  renderCarro();
}

// =========================================================
// VOCÊ: estatísticas, nível e ajustes
// =========================================================
function abrirVoce(){
  preencherStatsSelect();
  renderStats();
  preencherSelect($("level-deck"), state.currentDeckId);
  carregarNiveis();
  renderConfig();
}

function preencherStatsSelect(){
  const sel = $("stats-deck-select");
  sel.innerHTML = '<option value="all">Todos os baralhos</option>' + Object.entries(state.decks).map(([id, d]) => `<option value="${id}">${esc(d.Name)}</option>`).join("");
  sel.value = state.statsDeckId !== "all" && state.decks[state.statsDeckId] ? state.statsDeckId : "all";
  state.statsDeckId = sel.value;
}

function contarAte(el, alvo, sufixo = ""){
  if(typeof alvo !== "number" || reduzMovimento){ el.textContent = alvo + (typeof alvo === "number" ? sufixo : ""); return; }
  const t0 = performance.now();
  const passo = t => {
    const p = Math.min(1, (t - t0) / 700);
    el.textContent = Math.round(alvo * (1 - Math.pow(1 - p, 3))) + sufixo;
    if(p < 1) requestAnimationFrame(passo);
  };
  requestAnimationFrame(passo);
}

function renderStats(){
  const cards = state.statsDeckId !== "all" && state.decks[state.statsDeckId]
    ? Object.values(state.decks[state.statsDeckId].Cards)
    : Object.values(state.decks).flatMap(d => Object.values(d.Cards));
  const limite = new Date(); limite.setDate(limite.getDate() - 29);
  const ult30 = Object.entries(state.dias).filter(([k]) => k >= hojeLocal(limite)).map(([, v]) => v);
  const soma = k => ult30.reduce((a, d) => a + (d[k] || 0), 0);
  const r30 = soma("r");
  contarAte($("stat-streak"), sequencia(state.dias));
  contarAte($("stat-today"), hojeR());
  if(r30) contarAte($("stat-accuracy"), Math.round(soma("a") / r30 * 100), "%"); else $("stat-accuracy").textContent = "—";
  if(soma("rm")) contarAte($("stat-retention"), Math.round(soma("ra") / soma("rm") * 100), "%"); else $("stat-retention").textContent = "—";
  contarAte($("stat-learned"), cards.filter(c => c.LearnedAt).length);
  contarAte($("stat-spoken"), soma("f"));
  contarAte($("stat-total-cards"), cards.length);

  const barras = (el, itens) => {
    const max = Math.max(1, ...itens.map(d => d.n));
    el.innerHTML = itens.map((d, i) => `<div class="bar-col"><div class="bar-fill" style="height:${Math.max(4, Math.round(d.n / max * 100))}%;animation-delay:${i * 50}ms" title="${d.n}"></div><div class="bar-label">${esc(d.l)}</div></div>`).join("");
  };
  const dias7 = [];
  for(let i = 6; i >= 0; i--){
    const d = new Date(); d.setDate(d.getDate() - i);
    dias7.push({ n: (state.dias[hojeLocal(d)] && state.dias[hojeLocal(d)].r) || 0, l: d.toLocaleDateString("pt-BR", { weekday: "short" }).replace(".", "").slice(0, 3) });
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
  $("health-list").innerHTML = vistos.length ? vistos.slice(0, 120).map(c => {
    const pct = Math.round(dominio(c) * 100);
    const cor = pct < 40 ? "var(--red)" : pct < 70 ? "var(--yel)" : "var(--green)";
    return `<div class="h-row"><span>${esc(c.Word)}</span><span class="dom"><i style="width:${pct}%;background:${cor}"></i></span></div>`;
  }).join("") : '<p class="empty-line">Estude alguns cards para ver a saúde do vocabulário.</p>';
}

async function carregarNiveis(){
  try{
    const lista = await fb.dbGet(fb.meu("/Niveis"), { orderBy: '"$key"', limitToLast: 12 });
    const itens = Object.values(lista || {}).reverse();
    $("level-history").innerHTML = itens.length ? itens.map(n =>
      `<div class="hist-row"><span>${new Date(n.Data).toLocaleDateString("pt-BR")} · ${esc((n.Resumo || "").slice(0, 70))}…</span><span class="tag yel">${esc(n.Nivel)}</span></div>`).join("")
      : '<p class="empty-line">Nenhuma avaliação ainda.</p>';
  }catch(err){ /* secundário */ }
}

const ROTULO_ITEM = { traducao: "Tradução", completar: "Complete", compreensao: "Compreensão", escrita: "Escrita", fala: "Fala" };
async function comecarTeste(){
  const deckId = $("level-deck").value;
  const deck = state.decks[deckId];
  if(!deck){ toast("Crie um baralho antes."); return; }
  let itens = null;
  await acao("Preparando a avaliação…", async () => { itens = (await pedir(P.pedidoTesteNivel(deck))).Itens; }, $("btn-level-start"));
  if(!itens) return;
  state.teste = { deckId, itens, respostas: itens.map(() => ""), i: 0 };
  $("level-start").classList.add("hidden");
  $("level-result").classList.add("hidden");
  $("level-test").classList.remove("hidden");
  renderPergunta();
}

function renderPergunta(){
  const t = state.teste;
  const it = t.itens[t.i];
  const deck = state.decks[t.deckId];
  const ultima = t.i === t.itens.length - 1;
  $("level-test").innerHTML = `
    <div class="q-progress">${t.itens.map((_, i) => `<i class="${i <= t.i ? "done" : ""}"></i>`).join("")}</div>
    <div class="panel q-card">
      <div class="route-head"><span class="tag yel">${t.i + 1} de ${t.itens.length}</span><span class="tag">${ROTULO_ITEM[it.Tipo] || it.Tipo}</span></div>
      ${it.Texto ? `<blockquote>${esc(it.Texto)}</blockquote>` : ""}
      <p>${esc(it.Enunciado)}</p>
      <textarea id="q-resp" rows="${it.Tipo === "escrita" ? 5 : 3}" placeholder="Sua resposta">${esc(t.respostas[t.i])}</textarea>
      ${it.Tipo === "fala" && voz.temReconhecimento ? '<button class="btn btn-ghost btn-block" id="q-fala">Responder falando</button>' : ""}
      <div class="row-2"><button class="btn btn-ghost" id="q-prev" ${t.i ? "" : "disabled"}>Voltar</button><button class="btn btn-yel" id="q-next">${ultima ? "Enviar" : "Próxima"}</button></div>
    </div>`;
  const ta = $("q-resp");
  ta.addEventListener("input", () => { t.respostas[t.i] = ta.value; });
  $("q-prev").addEventListener("click", () => { t.i--; renderPergunta(); });
  $("q-next").addEventListener("click", () => { t.respostas[t.i] = ta.value.trim(); if(ultima) corrigirTeste(); else { t.i++; renderPergunta(); } });
  $("q-fala")?.addEventListener("click", async e => {
    const b = e.currentTarget;
    b.textContent = "Ouvindo…";
    try{ ta.value = await voz.ouvir({ idioma: deck.Language, onParcial: x => { ta.value = x; } }); t.respostas[t.i] = ta.value; }
    catch(err){ toast(err.message); }
    b.textContent = "Responder falando";
  });
}

async function corrigirTeste(){
  const t = state.teste;
  const deck = state.decks[t.deckId];
  let r = null;
  await acao("Corrigindo…", async () => {
    r = await pedir(P.pedidoCorrigirTeste(deck, t.itens, t.respostas));
    await fb.dbPut(fb.meu(`/Niveis/${novoId("n")}`), { Data: new Date().toISOString(), DeckId: t.deckId, Nivel: r.Nivel, Resumo: r.Resumo, Fortes: r.Fortes, Fracos: r.Fracos });
    state.perfil.UltimoNivel = r.Nivel;
    fb.dbPatch(fb.meu("/Profile"), { UltimoNivel: r.Nivel }).catch(() => {});
    publicarJuntos(true);
  }, $("q-next"));
  if(!r) return;
  const box = $("level-result");
  box.innerHTML = `<div class="panel">
    <div class="level-big">${esc(r.Nivel)}</div>
    <p style="margin:0">${esc(r.Resumo)}</p>
    <div class="section-title flat">Pontos fortes</div><ul class="frases">${r.Fortes.map(f => `<li>${esc(f)}</li>`).join("")}</ul>
    <div class="section-title flat">Para treinar</div><ul class="frases">${r.Fracos.map(f => `<li>${esc(f)}</li>`).join("")}</ul>
    <div class="section-title flat">Item a item</div>
    ${t.itens.map((it, i) => { const n = r.Itens[i]?.Nota ?? 0; const cor = n >= .7 ? "var(--green)" : n >= .4 ? "var(--yel)" : "var(--red)";
      return `<div class="h-row"><span>${i + 1}. ${esc(r.Itens[i]?.Comentario || "")}</span><b style="color:${cor}">${Math.round(n * 100)}%</b></div>`; }).join("")}
    ${deck.Nivel !== r.Nivel ? `<button class="btn btn-yel btn-block" id="btn-level-apply">Usar ${esc(r.Nivel)} no baralho "${esc(deck.Name)}"</button>` : ""}
    <button class="btn btn-ghost btn-block" id="btn-level-close">Fechar</button>
  </div>`;
  $("level-test").classList.add("hidden");
  box.classList.remove("hidden");
  $("btn-level-close").addEventListener("click", () => { box.classList.add("hidden"); $("level-start").classList.remove("hidden"); carregarNiveis(); });
  $("btn-level-apply")?.addEventListener("click", async e => {
    const b = e.currentTarget;
    deck.Nivel = r.Nivel;
    await fb.dbPatch(fb.meu(`/Decks/${t.deckId}`), { Nivel: r.Nivel }).catch(err => toast(err.message));
    b.disabled = true; b.textContent = "Nível atualizado";
  });
  state.teste = null;
}

function renderConfig(){
  const p = prefs();
  $("settings-email").textContent = fb.sessao.email || "";
  $("cfg-name").value = state.perfil.Nome || "";
  $("cfg-history").value = state.perfil.Historico || "";
  $("cfg-modes").innerHTML = Object.entries(MODOS).map(([k, m]) =>
    `<label class="check"><input type="checkbox" value="${k}" ${p.modos.includes(k) ? "checked" : ""}><span><b style="color:var(--ink)">${m.nome}</b>. ${m.desc}</span></label>`).join("");
  $("cfg-modes").querySelectorAll("input").forEach(i => i.addEventListener("change", () => {
    const modos = [...$("cfg-modes").querySelectorAll("input:checked")].map(x => x.value);
    if(!modos.length){ i.checked = true; toast("Deixe pelo menos um modo."); return; }
    salvarPrefs({ modos });
  }));
  const vozes = voz.vozesDoIdioma("en");
  $("cfg-voice").innerHTML = '<option value="">Automática</option>' + vozes.map(v => `<option value="${esc(v.name)}">${esc(v.name)}</option>`).join("");
  $("cfg-voice").value = p.voz;
  $("cfg-slow").value = String(p.lento);
  $("cfg-autoplay").checked = !!p.autoplay;
  $("cfg-haptics").checked = !!p.vibrar;
}

// =========================================================
// ENTRAR E SAIR
// =========================================================
async function entrar(){
  ocupado("Carregando seus baralhos…");
  try{
    await carregarTudo();
    $("login").classList.add("hidden");
    $("app").classList.remove("hidden");
    let ultimo = null;
    try{ ultimo = localStorage.getItem("fluencia:lastDeck"); }catch(e){}
    state.currentDeckId = ultimo && state.decks[ultimo] ? ultimo : Object.keys(state.decks)[0] || null;
    irPara("v-study");
    publicarJuntos(true);
  }catch(err){
    toast(err.message);
    $("login").classList.remove("hidden");
  }finally{ livre(); }
}

function sair(){
  fb.logout();
  Object.assign(state, { perfil: {}, decks: {}, dias: {}, currentDeckId: null, deckId: null, atual: null, lote: [], conversa: null, juntos: {} });
  while(camadas.length) camadas.pop();
  $("app").classList.add("hidden");
  $("login").classList.remove("hidden");
}

// =========================================================
// EVENTOS
// =========================================================
const ligar = (id, ev, fn) => $(id).addEventListener(ev, fn);

async function autenticar(fn){
  const email = $("login-email").value.trim(), senha = $("login-password").value;
  $("login-error").textContent = "";
  if(!email || !senha){ $("login-error").textContent = "Preencha email e senha."; return; }
  ocupado("Entrando…");
  try{ await fn(email, senha); await entrar(); }
  catch(err){ $("login-error").textContent = fb.traduzirErroAuth(err.message); }
  finally{ livre(); }
}
ligar("login-form", "submit", e => { e.preventDefault(); autenticar(fb.login); });
ligar("btn-signup", "click", () => {
  if($("login-password").value.length < 6){ $("login-error").textContent = "A senha precisa ter ao menos 6 caracteres."; return; }
  autenticar(fb.signup);
});
ligar("link-forgot", "click", async () => {
  const email = $("login-email").value.trim();
  if(!email){ $("login-error").textContent = "Digite seu email para redefinir a senha."; return; }
  await acao("Enviando email…", async () => { await fb.forgotPassword(email); toast("Email de redefinição enviado para " + email); });
});
ligar("pw-eye", "click", () => {
  const i = $("login-password"), mostra = i.type === "password";
  i.type = mostra ? "text" : "password";
  $("pw-eye").textContent = mostra ? "ocultar" : "mostrar";
  $("pw-eye").setAttribute("aria-label", mostra ? "Ocultar senha" : "Mostrar senha");
});

document.querySelectorAll(".tab").forEach(t => t.addEventListener("click", () => {
  while(camadas.length){ camadas.pop(); history.back(); }
  if(!$("sheet-root").hidden){ $("sheet-root").classList.remove("aberta"); $("sheet-root").hidden = true; }
  $("talk-room").classList.add("hidden"); $("app").classList.remove("em-conversa");
  irPara(t.dataset.view);
}));

// Estudar
document.querySelectorAll(".grade").forEach(b => b.addEventListener("click", () => responder(b.dataset.nota)));
ligar("btn-sound", "click", () => tocar(1));
ligar("btn-sound-slow", "click", () => tocar(prefs().lento));
ligar("btn-speak", "click", falarResposta);
ligar("btn-check-typed", "click", conferirDigitado);
ligar("type-answer", "keydown", e => { if(e.key === "Enter"){ e.preventDefault(); conferirDigitado(); } });
ligar("deck-chip", "click", escolherDeck);
ligar("btn-goto-decks", "click", () => {
  if(!Object.keys(state.decks).length){ irPara("v-decks"); formDeck("create"); }
  else abrirDeck(state.currentDeckId);
});
document.addEventListener("keydown", e => {
  if(viewAtual !== "v-study" || $("app").classList.contains("hidden")) return;
  if(e.target.closest("input, textarea, select") || !$("sheet-root").hidden) return;
  if(e.key === " "){ e.preventDefault(); virar(); }
  else if(state.visto && ["1", "2", "3", "4"].includes(e.key)) responder(["errei", "quase", "acertei", "facil"][+e.key - 1]);
  else if(state.visto && e.key === "ArrowRight") responder("acertei", 1);
  else if(state.visto && e.key === "ArrowLeft") responder("errei", -1);
});

// Baralhos
ligar("btn-new-deck", "click", () => formDeck("create"));
ligar("deck-back", "click", fecharCamada);
ligar("deck-menu", "click", menuDeck);
$("deck-tabs").querySelectorAll("button").forEach(b => b.addEventListener("click", () => trocarAba("deck-tabs", b.dataset.tab)));
ligar("btn-gen-unit", "click", gerarDaUnidade);
ligar("btn-next-unit", "click", () => escolherUnidade((state.decks[state.deckId].UnidadeAtual || 0) + 1));
ligar("btn-gen-trail", "click", async e => {
  const d = state.decks[state.deckId];
  const botao = e.currentTarget;
  if(d.Trilha.length && !await confirmar({ titulo: "Refazer a trilha", texto: "A IA monta uma trilha nova. Os cards ficam, mas podem perder a ligação com as unidades antigas.", botao: "Refazer", perigo: false })) return;
  gerarTrilha(state.deckId, botao);
});
ligar("btn-add-word", "click", gerarDeAlvos);
ligar("btn-mine", "click", extrairTexto);
ligar("card-filter", "input", renderCards);

// Conversar
$("talk-scenario").querySelectorAll(".pill").forEach(p => p.addEventListener("click", () => marcarCenario(p.dataset.v)));
ligar("btn-talk-start", "click", comecarConversa);
ligar("btn-talk-send", "click", enviarFala);
ligar("btn-talk-mic", "click", microfoneConversa);
ligar("btn-talk-end", "click", encerrarConversa);
ligar("btn-talk-leave", "click", fecharCamada);
ligar("talk-input", "input", ajustarComposer);
ligar("talk-input", "keydown", e => { if(e.key === "Enter" && !e.shiftKey){ e.preventDefault(); enviarFala(); } });

// Juntos e Você
ligar("btn-route", "click", gerarRoteiro);
ligar("btn-carmode", "click", abrirCarro);
ligar("car-close", "click", fecharCamada);
ligar("car-prev", "click", () => carAvancar(-1));
ligar("car-next", "click", () => carAvancar(1));
ligar("car-body", "click", () => carAvancar(1));
ligar("you-back", "click", fecharCamada);
$("you-tabs").querySelectorAll("button").forEach(b => b.addEventListener("click", () => trocarAba("you-tabs", b.dataset.tab)));
ligar("stats-deck-select", "change", e => { state.statsDeckId = e.target.value; renderStats(); });
ligar("btn-level-start", "click", comecarTeste);
ligar("btn-logout", "click", sair);

let nomeTimer = null, histTimer = null;
ligar("cfg-name", "input", e => { clearTimeout(nomeTimer); nomeTimer = setTimeout(() => salvarPerfilCampo("Nome", e.target.value.trim()), 600); });
ligar("cfg-history", "input", e => { clearTimeout(histTimer); histTimer = setTimeout(() => salvarPerfilCampo("Historico", e.target.value.trim().slice(0, 3000)), 800); });
ligar("cfg-voice", "change", e => { salvarPrefs({ voz: e.target.value }); voz.falar("This is how I sound.", { voz: e.target.value }); });
ligar("cfg-slow", "change", e => salvarPrefs({ lento: Number(e.target.value) }));
ligar("cfg-autoplay", "change", e => salvarPrefs({ autoplay: e.target.checked }));
ligar("cfg-haptics", "change", e => { salvarPrefs({ vibrar: e.target.checked }); if(e.target.checked) vibrar(20); });

// =========================================================
// INÍCIO
// =========================================================
if("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});

(async () => {
  ocupado("Abrindo…");
  const ok = await fb.retomarSessao();
  livre();
  if(ok) entrar();
  else $("login").classList.remove("hidden");
})();
