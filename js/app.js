import * as fb from "./firebase.js";
import { pedir } from "./ia.js";
import * as P from "./ia-pedidos.js";
import { MODOS, sortear, registrarResposta, estadoModo, dominio, lacuna, hojeLocal, sequencia } from "./selecao.js";
import * as voz from "./voz.js";
import { PONTOS, PONTO, NIVEIS_REGUA, META_VOCAB, SEMENTE_ES16, nomePonto, nivelPonto, ordemNivel } from "./catalogo.js";
import * as E from "./erros.js";

const { IDIOMAS, NIVEIS, MAX_CARD_LEVEL, idiomaLabel } = P;
const EVOLVE_STREAK_THRESHOLD = 5;
const NOMES_CENARIO = { rh: "Entrevista de RH", tecnica: "Entrevista técnica", viagem: "Viagem", livre: "Conversa livre", falar2: "Falar 2 minutos" };
const EMAIL_SEMENTE = "guittk@hotmail.com"; // o teste da ES-16 é dele
const FONTE_NOME = { produzir: "Produzir", conversa: "Conversa", nivel: "Teste de Nível", es16: "Nivelamento de 01/11", escrever: "Escrever", falar: "Falar 2 minutos" };
const TEMAS_FALA = [
  "Fale sobre o seu trabalho: o que você faz e com quem.",
  "Conte um problema que você resolveu no trabalho e como.",
  "Descreva o projeto de que você mais se orgulha.",
  "Fale sobre o seu dia de ontem, do começo ao fim.",
  "Explique por que você quer trabalhar no exterior.",
  "Conte como é a sua rotina num dia de semana.",
  "Fale de uma ferramenta que você usa todo dia e por quê.",
  "Descreva a sua cidade para alguém que nunca foi lá.",
  "Conte o que você faria se ganhasse um ano de férias.",
  "Fale sobre um erro que você cometeu e o que aprendeu.",
  "Explique como você aprende uma tecnologia nova.",
  "Fale sobre os seus planos para os próximos dois anos.",
];
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
  // Mapa de erros (ES-22)
  pontos: {}, erros: {}, producao: {}, exercicios: {}, aulas: {},
  entrada: "tudo", pontoTreino: null, desdeExercicio: 0, gerando: {},
  pontoId: null, errosAba: "treinando", outroUid: null, nivelSel: null,
};
const prefs = () => Object.assign(
  { modos: ["rec", "prod", "ouv", "comp"], voz: "", lento: 0.7, autoplay: false, vibrar: true },
  state.perfil.Prefs || {}
);
// O nível de partida da régua: o do nivelamento, ou o do último teste de Nível.
const nivelBase = () => (state.perfil.Base && state.perfil.Base.nivel) || (NIVEIS_REGUA.includes(state.perfil.UltimoNivel) ? state.perfil.UltimoNivel : null);

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

// ---------- Listas de escolha no desenho do app ----------
// O <select> fica escondido e continua sendo a fonte do valor e do "change".
// Até 4 opções viram botões lado a lado; mais que isso, uma lista logo abaixo
// (dentro da própria tela, porque a folha de baixo pode já estar aberta).
function enfeitar(sel){
  if(!sel) return;
  let caixa = sel.nextElementSibling;
  if(!caixa || !caixa.classList.contains("escolha")){
    caixa = document.createElement("div");
    sel.after(caixa);
    sel.classList.add("sel-nativo");
    sel.tabIndex = -1;
    sel.setAttribute("aria-hidden", "true");
    sel.addEventListener("change", () => desenharEscolha(sel, sel.nextElementSibling));
  }
  desenharEscolha(sel, caixa);
}
function desenharEscolha(sel, caixa){
  const ops = [...sel.options];
  const rotulo = sel.closest(".field")?.querySelector("span")?.textContent || sel.getAttribute("aria-label") || "";
  const escolher = v => { sel.value = v; sel.dispatchEvent(new Event("change", { bubbles: true })); };
  const off = sel.disabled ? "disabled" : "";
  if(ops.length <= 4){
    caixa.className = "escolha chips";
    caixa.setAttribute("role", "radiogroup");
    caixa.setAttribute("aria-label", rotulo);
    caixa.innerHTML = ops.map(o => `<button type="button" class="pill ${o.value === sel.value ? "on" : ""}" role="radio" aria-checked="${o.value === sel.value}" data-v="${esc(o.value)}" ${off}>${esc(o.textContent)}</button>`).join("");
    caixa.querySelectorAll("[data-v]").forEach(b => b.addEventListener("click", e => { e.preventDefault(); escolher(b.dataset.v); }));
    return;
  }
  const atual = ops.find(o => o.value === sel.value) || ops[0];
  caixa.className = "escolha lista";
  caixa.removeAttribute("role");
  caixa.innerHTML = `<button type="button" class="escolha-btn" aria-expanded="false" aria-label="${esc(rotulo)}" ${off}><span>${esc(atual ? atual.textContent : "—")}</span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 10l5 5 5-5"/></svg></button>
    <div class="escolha-ops" role="listbox" hidden>${ops.map(o => `<button type="button" role="option" aria-selected="${o.value === sel.value}" class="${o.value === sel.value ? "on" : ""}" data-v="${esc(o.value)}">${esc(o.textContent)}</button>`).join("")}</div>`;
  const btn = caixa.querySelector(".escolha-btn"), lista = caixa.querySelector(".escolha-ops");
  btn.addEventListener("click", e => {
    e.preventDefault();
    const abrir = lista.hidden;
    fecharEscolhas();
    lista.hidden = !abrir;
    btn.setAttribute("aria-expanded", String(abrir));
    if(abrir) lista.querySelector(".on")?.scrollIntoView({ block: "nearest" });
  });
  lista.querySelectorAll("[data-v]").forEach(b => b.addEventListener("click", e => { e.preventDefault(); escolher(b.dataset.v); }));
}
function fecharEscolhas(){
  document.querySelectorAll(".escolha-ops").forEach(l => { l.hidden = true; l.previousElementSibling?.setAttribute("aria-expanded", "false"); });
}
document.addEventListener("click", e => { if(!e.target.closest(".escolha")) fecharEscolhas(); });

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
// A FRASE: texto limpo, o alvo em destaque, as palavras entrando uma a uma
// =========================================================
function painel(el, texto, alvo, animar = true){
  el.innerHTML = "";
  el.className = "flap" + (texto.length > 95 ? " muito-longo" : texto.length > 60 ? " longo" : "") + (animar && !reduzMovimento ? " entra" : "");
  let ini = -1, fim = -1;
  const m = alvo && texto.match(reAlvo(alvo));
  if(m){ ini = m.index; fim = m.index + m[0].length; }
  let pos = 0;
  texto.split(" ").forEach((palavra, i) => {
    const w = document.createElement("span");
    w.className = "fw";
    w.style.animationDelay = `${Math.min(i * 35, 600)}ms`;
    // Cada palavra em pedaços: a lacuna do Completar, o trecho do alvo e o resto.
    const pedacos = palavra.match(/_+|[^_]+/g) || [];
    for(const p of pedacos){
      if(p[0] === "_"){
        const t = document.createElement("span");
        t.className = "ft gap";
        t.style.width = `${Math.min(p.length, 9) * 0.5 + 0.6}em`;
        w.appendChild(t);
        pos += p.length;
        continue;
      }
      let k = 0;
      while(k < p.length){
        const dentro = pos + k >= ini && pos + k < fim;
        let j = k;
        while(j < p.length && (pos + j >= ini && pos + j < fim) === dentro) j++;
        const t = document.createElement("span");
        if(dentro) t.className = "ft al";
        t.textContent = p.slice(k, j);
        w.appendChild(t);
        k = j;
      }
      pos += p.length;
    }
    pos++; // o espaço
    el.appendChild(w);
    el.appendChild(document.createTextNode(" "));
  });
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
  const desde = "p" + (Date.now() - 40 * 864e5).toString(36);
  const [perfil, decks, dias, pontos, erros, producao, exercicios] = await Promise.all([
    fb.dbGet(fb.meu("/Profile")),
    fb.dbGet(fb.meu("/Decks")),
    fb.dbGet(fb.meu("/Dias"), { orderBy: '"$key"', startAt: `"${hojeLocal(inicio)}"` }),
    fb.dbGet(fb.meu("/Pontos")).catch(() => null),
    fb.dbGet(fb.meu("/Erros")).catch(() => null),
    fb.dbGet(fb.meu("/Producao"), { orderBy: '"$key"', startAt: `"${desde}"` }).catch(() => null),
    fb.dbGet(fb.meu("/Exercicios")).catch(() => null),
  ]);
  state.perfil = perfil || {};
  state.decks = decks || {};
  Object.values(state.decks).forEach(d => { d.Cards = d.Cards || {}; d.Trilha = d.Trilha || []; });
  state.dias = dias || {};
  state.pontos = pontos || {};
  state.erros = erros || {};
  state.producao = producao || {};
  state.exercicios = exercicios || {};
  Object.values(state.exercicios).forEach(x => { x.itens = x.itens || []; x.i = x.i || 0; });
  try{ state.entrada = localStorage.getItem("fluencia:entrada") || "tudo"; }catch(e){}
  if(!["tudo", "deck", "erros"].includes(state.entrada)) state.entrada = "tudo";
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
  if(campo === "Nome"){ publicarJuntos(); atualizarVoce(); }
}
function atualizarVoce(){
  const ini = ((state.perfil.Nome || fb.sessao.email || "?").trim()[0] || "?").toUpperCase();
  document.querySelectorAll("[data-voce]").forEach(b => { b.textContent = ini; });
}
const hojeR = () => (state.dias[hojeLocal()] && state.dias[hojeLocal()].r) || 0;
function somarDia(campos){
  const hoje = hojeLocal();
  const d = Object.assign({ r: 0, a: 0, f: 0, rm: 0, ra: 0 }, state.dias[hoje]);
  for(const k in campos) d[k] += campos[k];
  state.dias[hoje] = d;
  fb.dbPut(fb.meu(`/Dias/${hoje}`), d).catch(() => {});
}

// ---------- Mapa de erros ----------
const pontoValido = id => !!(id && PONTO[id]);
function salvarPonto(id){
  fb.dbPut(fb.meu(`/Pontos/${id}`), state.pontos[id]).catch(err => toast(err.message));
}
// Guarda os erros (de qualquer tela) e soma cada um no ponto dele.
// lista: [{ Ponto, Original, Certo, Explicacao }]
function anotarErros(lista, fonte){
  const base = nivelBase();
  const validos = (lista || []).filter(e => pontoValido(e.Ponto) && (e.Original || e.Certo));
  if(!validos.length) return 0;
  const patch = {};
  for(const e of validos){
    const presumido = E.estadoPonto(state.pontos[e.Ponto], e.Ponto, base) === "presumido";
    state.pontos[e.Ponto] = E.registrarErroPonto(state.pontos[e.Ponto], { presumido });
    salvarPonto(e.Ponto);
    const k = novoId("e");
    state.erros[k] = { p: e.Ponto, o: (e.Original || "").slice(0, 300), c: (e.Certo || "").slice(0, 300), e: (e.Explicacao || "").slice(0, 400), f: fonte, d: new Date().toISOString() };
    patch[k] = state.erros[k];
  }
  fb.dbPatch(fb.meu("/Erros"), patch).catch(err => toast(err.message));
  publicarJuntos();
  return validos.length;
}
// Uma frase produzida por ele, com os pontos em que errou: é a base do "uso" na régua.
function anotarProducao(fonte, pontos = []){
  const k = novoId("p");
  const p = {};
  pontos.filter(pontoValido).forEach(id => { p[id] = 1; });
  state.producao[k] = { d: hojeLocal(), f: fonte, ...(Object.keys(p).length ? { p } : {}) };
  fb.dbPut(fb.meu(`/Producao/${k}`), state.producao[k]).catch(() => {});
}
const aprendidosIngles = () => Object.values(state.decks).filter(d => P.classifica(d))
  .reduce((a, d) => a + Object.values(d.Cards).filter(c => c.LearnedAt).length, 0);
const minhaRegua = () => E.regua({ regs: state.pontos, base: nivelBase(), aprendidos: aprendidosIngles(), producao: Object.values(state.producao) });
const errosDoPonto = id => Object.entries(state.erros).filter(([, e]) => e.p === id).sort((a, b) => (b[1].d || "").localeCompare(a[1].d || ""));
const objetivoIngles = () => (Object.values(state.decks).find(d => P.classifica(d)) || {}).Objetivo || "";

// O nivelamento da ES-16 entra uma vez, na conta dele: o mapa já nasce com os erros do teste.
async function aplicarSemente(){
  if(fb.sessao.email !== EMAIL_SEMENTE || state.perfil.SementeES16) return;
  const S = SEMENTE_ES16;
  const base = S.nivel;
  const pontos = {}, erros = {}, producao = {};
  const quando = new Date(S.data + "T12:00:00").toISOString();
  const anota = (id, o, c, e, f) => {
    const presumido = E.estadoPonto(pontos[id], id, base) === "presumido";
    pontos[id] = E.registrarErroPonto(pontos[id], { presumido });
    erros[novoId("e")] = { p: id, o, c, e, f, d: quando };
  };
  for(const q of S.questoes){
    if(q.ok) pontos[q.p] = E.registrarAcerto(pontos[q.p], S.data);
    else anota(q.p, q.o, q.c, q.e, "es16");
  }
  for(const r of S.redacoes) anota(r.p, r.o, r.c, r.e, "es16");
  // As 8 frases das duas redações, com os pontos em que cada uma errou.
  [[], [], ["A1-pronomes"], ["A1-preposicoes", "X-estrutura-pt", "A1-artigos"],
   ["A1-pronomes"], ["A2-sujeito-obrigatorio", "A1-terceira-pessoa"],
   ["A2-conectores", "X-estrutura-pt", "B1-falsos-cognatos"], ["A2-verbo-to", "B1-incontaveis", "B1-falsos-cognatos"]]
    .forEach(ps => { producao[novoId("p")] = { d: S.data, f: "es16", ...(ps.length ? { p: Object.fromEntries(ps.map(id => [id, 1])) } : {}) }; });
  const marca = { Base: { nivel: base, fonte: "ES-16", data: S.data }, SementeES16: new Date().toISOString() };
  await Promise.all([
    fb.dbPatch(fb.meu("/Pontos"), pontos),
    fb.dbPatch(fb.meu("/Erros"), erros),
    fb.dbPatch(fb.meu("/Producao"), producao),
    fb.dbPatch(fb.meu("/Profile"), marca),
  ]);
  Object.assign(state.pontos, pontos);
  Object.assign(state.erros, erros);
  Object.assign(state.producao, producao);
  Object.assign(state.perfil, marca);
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
    // Régua, erros e números: é o que o outro vê, só pra ver. Os dados de cada
    // um são privados no banco; o Juntos é o único lugar que os dois leem.
    const base = nivelBase();
    const r = minhaRegua();
    const comErro = E.pontosComErro(state.pontos, base);
    const resumoPontos = {};
    comErro.slice(0, 40).forEach(({ id, reg, estado }) => {
      const ult = errosDoPonto(id)[0];
      resumoPontos[id] = { e: estado, x: reg.erros, ...(ult ? { o: ult[1].o, c: ult[1].c } : {}) };
    });
    const todos = Object.values(state.decks).flatMap(d => Object.values(d.Cards));
    const lim = new Date(); lim.setDate(lim.getDate() - 29);
    const u30 = Object.entries(state.dias).filter(([k]) => k >= hojeLocal(lim)).map(([, v]) => v);
    const s30 = k => u30.reduce((a, d) => a + (d[k] || 0), 0);
    fb.dbPatch(`${fb.RAIZ}/juntos/${fb.sessao.uid}`, {
      Regua: { atual: r.atual || "", prox: r.prox || "", pct: Math.round(r.pctProx * 100), niveis: Object.fromEntries(r.niveis.map(n => [n.n, Math.round(n.pct * 100)])), base: base || "" },
      Pontos: resumoPontos,
      Fracos3: comErro.filter(x => x.estado !== "dominado").slice(0, 3).map(x => x.id),
      Stats: { precisao: s30("r") ? Math.round(s30("a") / s30("r") * 100) : -1, aprendidos: todos.filter(c => c.LearnedAt).length, total: todos.length, faladas: s30("f"), revisoes: s30("r") },
      Nome: state.perfil.Nome || "",
      Sequencia: sequencia(state.dias),
      Hoje: { data: hojeLocal(), r: hojeR() },
      Dias7: dias7,
      Nivel: r.atual || state.perfil.UltimoNivel || (deck && deck.Nivel) || "",
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
const ABA_DE = { "v-deck": "v-decks", "v-you": "v-together", "v-ponto": "v-erros", "v-outro": "v-together" };
const ORDEM = ["v-decks", "v-study", "v-erros", "v-nivel", "v-talk", "v-together"];
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
  if(para === "v-nivel") abrirNivel();
  if(para === "v-erros") renderErros();
  atualizarPilulas();
  if(para === "v-ponto") renderPonto();
  if(para === "v-outro") renderOutro();
  if(camada) abrirCamada(() => irPara(de));
}

function nomeEntrada(){
  if(state.pontoTreino) return `Treino · ${nomePonto(state.pontoTreino)}`;
  if(state.entrada === "tudo") return "Tudo";
  if(state.entrada === "erros") return "Meus erros";
  const deck = state.decks[state.currentDeckId];
  return deck ? deck.Name : "Sem baralho";
}
function atualizarTopo(){
  $("deck-chip-name").textContent = nomeEntrada();
  $("stat-today-top").textContent = hojeR();
  $("stat-streak-top").textContent = sequencia(state.dias);
  atualizarPilulas();
}

function lembrarDeck(id){ try{ localStorage.setItem("fluencia:lastDeck", id); }catch(e){} }
function lembrarEntrada(v){ state.entrada = v; try{ localStorage.setItem("fluencia:entrada", v); }catch(e){} }

// O que entra no sorteio: Tudo (todos os baralhos e os exercícios dos erros),
// um baralho só, ou só os erros. Ideia dele, aprovada em 01/11/2026.
function escolherDeck(){
  const ids = Object.keys(state.decks);
  const emTreino = E.pontosComErro(state.pontos, nivelBase()).filter(x => x.estado !== "dominado").length;
  const on = v => !state.pontoTreino && state.entrada === v;
  const c = abrirFolha(`
    <h2 class="sheet-title">Estudar o quê?</h2>
    <div class="menu">
      <button data-e="tudo" class="${on("tudo") ? "on" : ""}">Tudo <span class="tag yel">cards e erros</span></button>
      <button data-e="erros" class="${on("erros") ? "on" : ""}">Meus erros <span class="tag">${emTreino} ${emTreino === 1 ? "ponto" : "pontos"}</span></button>
    </div>
    <div class="section-title flat">Um baralho só</div>
    <div class="menu">${ids.map(id => `<button data-id="${id}" class="${on("deck") && id === state.currentDeckId ? "on" : ""}">${esc(state.decks[id].Name)} <span class="tag">${esc(idiomaLabel(state.decks[id].Language))}</span></button>`).join("")}
    <button data-id="">Gerenciar baralhos</button></div>`);
  c.querySelectorAll("[data-e]").forEach(b => b.addEventListener("click", () => {
    fecharFolha();
    state.pontoTreino = null;
    lembrarEntrada(b.dataset.e);
    atualizarTopo();
    proximoCard();
  }));
  c.querySelectorAll("[data-id]").forEach(b => b.addEventListener("click", () => {
    fecharFolha();
    if(!b.dataset.id){ setTimeout(() => irPara("v-decks"), 50); return; }
    state.pontoTreino = null;
    state.currentDeckId = b.dataset.id;
    lembrarDeck(b.dataset.id);
    lembrarEntrada("deck");
    atualizarTopo();
    proximoCard();
  }));
}

// =========================================================
// ESTUDAR
// =========================================================
// O que está na tela: { tipo: "card", deckId, key, modo }, um exercício de
// ponto { tipo: "ex", ponto, item } ou o pedido de escrever { tipo: "escrever" }.
function modosAtivos(){
  const m = prefs().modos.filter(k => MODOS[k]);
  return m.length ? m : ["rec"];
}
const deckDoAtual = () => state.atual && state.atual.deckId ? state.decks[state.atual.deckId] : null;
const cardAtual = () => {
  const deck = deckDoAtual();
  return deck && state.atual.tipo === "card" ? deck.Cards[state.atual.key] : null;
};
const exAtual = () => state.atual && state.atual.tipo === "ex" ? state.atual : null;
const temItem = () => !!(cardAtual() || exAtual());
const temIngles = () => Object.values(state.decks).some(d => P.classifica(d)) || Object.keys(state.pontos).length > 0;
const cardsAtivos = deck => deck ? Object.values(deck.Cards).filter(c => !c.Suspended).length : 0;
// A frase certa inteira de um exercício (no Completar, a lacuna preenchida).
const respostaCompleta = it => it.Tipo === "completar" ? it.Frase.replace(/_{2,}/, it.Resposta) : it.Resposta;

function sortearCard(){
  if(state.entrada === "deck"){
    const deck = state.decks[state.currentDeckId];
    if(!cardsAtivos(deck)) return null;
    const s = sortear(state.currentDeckId, deck.Cards, modosAtivos(), { temAudio: voz.temFala });
    return s && { tipo: "card", deckId: state.currentDeckId, key: s.key, modo: s.modo };
  }
  // Tudo: um sorteio só entre os cards de todos os baralhos.
  const todos = {};
  for(const [id, d] of Object.entries(state.decks)) for(const [k, c] of Object.entries(d.Cards)) todos[`${id}~${k}`] = c;
  if(!Object.values(todos).some(c => !c.Suspended)) return null;
  const s = sortear("tudo", todos, modosAtivos(), { temAudio: voz.temFala });
  if(!s) return null;
  const [deckId, key] = s.key.split("~");
  return { tipo: "card", deckId, key, modo: s.modo };
}

// O Escrever 3 frases entra no Tudo uma vez por dia, depois de alguns cards. Dá pra pular.
function escreverDevido(){
  const d = state.dias[hojeLocal()];
  return temIngles() && hojeR() >= 6 && !(d && d.w);
}
function marcarEscrita(v){
  const hoje = hojeLocal();
  state.dias[hoje] = Object.assign({ r: 0, a: 0, f: 0, rm: 0, ra: 0 }, state.dias[hoje], { w: v });
  fb.dbPatch(fb.meu(`/Dias/${hoje}`), { w: v }).catch(() => {});
}

function itemPronto(id){
  const ex = state.exercicios[id];
  return ex && ex.itens && ex.i < ex.itens.length ? ex.itens[ex.i] : null;
}
async function gerarExercicios(id){
  if(state.gerando[id]) return state.gerando[id];
  state.gerando[id] = (async () => {
    const r = await pedir(P.pedidoExercicios(id, errosDoPonto(id).map(([, e]) => e), objetivoIngles()));
    state.exercicios[id] = { itens: r.Itens, i: 0, criado: new Date().toISOString() };
    await fb.dbPut(fb.meu(`/Exercicios/${id}`), state.exercicios[id]);
  })().finally(() => { delete state.gerando[id]; });
  return state.gerando[id];
}

let sorteioN = 0;
async function proximoCard(animar = true){
  const n = ++sorteioN;
  if(Object.keys(state.decks).length && !state.decks[state.currentDeckId]) state.currentDeckId = Object.keys(state.decks)[0];
  if(state.entrada === "deck" && !state.decks[state.currentDeckId]) lembrarEntrada("tudo");
  atualizarTopo();
  const base = nivelBase();
  const soErros = !!state.pontoTreino || state.entrada === "erros";
  let prox = null;
  if(soErros){
    const id = E.sortearPonto(state.pontos, base, { soErros: true, so: state.pontoTreino });
    if(id) prox = { tipo: "ex", ponto: id };
  }else{
    if(state.entrada === "tudo" && escreverDevido()) prox = { tipo: "escrever" };
    else if(state.entrada === "tudo" && temIngles() && state.desdeExercicio >= E.CARDS_POR_EXERCICIO){
      const id = E.sortearPonto(state.pontos, base);
      if(id) prox = { tipo: "ex", ponto: id };
    }
    if(!prox) prox = sortearCard();
    if(!prox && state.entrada === "tudo" && temIngles()){
      const id = E.sortearPonto(state.pontos, base);
      if(id) prox = { tipo: "ex", ponto: id };
    }
  }
  if(prox && prox.tipo === "ex"){
    let item = itemPronto(prox.ponto);
    if(!item && soErros){
      mostrarVazio("preparando", prox.ponto);
      try{ await gerarExercicios(prox.ponto); }catch(err){ toast(err.message); }
      if(n !== sorteioN) return;
      item = itemPronto(prox.ponto);
    }else if(!item){
      // No Tudo, enquanto a IA prepara os exercícios do ponto, segue com um card.
      // Um ponto por vez, pra não pedir lotes que ainda vão demorar a ser usados.
      if(!Object.keys(state.gerando).length) gerarExercicios(prox.ponto).catch(() => {});
      prox = sortearCard();
    }
    if(prox && prox.tipo === "ex"){ if(item) prox.item = item; else prox = null; }
  }
  if(!prox){ mostrarVazio(soErros ? "erros" : "cards"); return; }
  ["ticket-stage", "tools"].forEach(id => $(id).classList.remove("hidden"));
  $("study-empty").classList.add("hidden");
  $("gradebar").classList.remove("hidden");
  state.atual = prox;
  state.virado = false;
  state.visto = false;
  limparFeedback();
  mostrarFrente(animar);
}

function mostrarVazio(tipo, ponto){
  state.atual = null;
  ["ticket-stage", "tools"].forEach(id => $(id).classList.add("hidden"));
  $("study-empty").classList.remove("hidden");
  $("gradebar").classList.add("hidden");
  $("type-row").classList.add("hidden");
  $("feedback").classList.add("hidden");
  const botao = $("btn-goto-decks");
  botao.classList.remove("hidden");
  botao.dataset.acao = "";
  if(tipo === "preparando"){
    $("study-empty-title").textContent = "Preparando o treino";
    $("study-empty-text").textContent = `A IA está escrevendo os exercícios de ${nomePonto(ponto)}. Leva alguns segundos, uma vez por ponto.`;
    botao.classList.add("hidden");
  }else if(tipo === "erros"){
    $("study-empty-title").textContent = "Nenhum erro em treino";
    $("study-empty-text").textContent = "Os erros que aparecerem no Produzir, na Conversa, no Escrever e no teste de Nível entram aqui, com aula e exercícios.";
    botao.textContent = "Estudar tudo";
    botao.dataset.acao = "tudo";
  }else{
    const semDeck = !Object.keys(state.decks).length;
    $("study-empty-title").textContent = semDeck ? "Nenhum baralho ainda" : "Baralho sem cards";
    $("study-empty-text").textContent = semDeck
      ? "Crie um baralho com o seu objetivo, e a IA monta a trilha e os cards."
      : "Gere os cards da primeira unidade da trilha para começar.";
    botao.textContent = semDeck ? "Criar meu primeiro baralho" : "Abrir o baralho";
  }
}

function mostrarFrente(animar){
  const a = state.atual;
  if(!a) return;
  const ticket = $("ticket");
  // Desvira sem animar: o card novo entra já de frente.
  ticket.classList.add("sem-transicao");
  ticket.classList.remove("flipped", "ok", "erro");
  void ticket.offsetWidth;
  ticket.classList.remove("sem-transicao");
  ticket.classList.toggle("treino", a.tipo !== "card");
  // O pedido de escrever não vira nem leva nota: some a barra de notas e o áudio.
  $("tools").classList.toggle("hidden", a.tipo === "escrever");
  $("gradebar").classList.toggle("hidden", a.tipo === "escrever");
  document.querySelector(".face.front .tk-tap").textContent = a.tipo === "escrever" ? "" : "toque para virar";
  mostrarDica(0);
  setNotas(false);
  const corpo = $("front-body");
  corpo.innerHTML = "";
  const rotulo = txt => { const l = document.createElement("div"); l.className = "label"; l.textContent = txt; corpo.appendChild(l); };

  if(a.tipo === "escrever"){
    $("tk-mode").textContent = "Escrever";
    $("tk-unit").textContent = "uma vez por dia";
    $("tk-level").textContent = "3 frases";
    rotulo("Escreva em inglês");
    corpo.insertAdjacentHTML("beforeend", `<div class="pt-big">Conte em 3 frases o que você fez hoje, ou no trabalho.</div>
      <p class="pt small">A IA corrige frase a frase, e cada erro vai pro seu mapa.</p>
      <div class="row-2"><button class="btn btn-ghost" data-w="pular">Pular hoje</button><button class="btn btn-yel" data-w="ir">Escrever</button></div>`);
    corpo.querySelectorAll("[data-w]").forEach(b => {
      b.addEventListener("pointerdown", e => e.stopPropagation());
      b.addEventListener("click", e => {
        e.stopPropagation();
        if(b.dataset.w === "pular"){ marcarEscrita(2); proximoCard(); }
        else abrirTexto({ modo: "escrever" });
      });
    });
    $("btn-sound").disabled = $("btn-sound-slow").disabled = true;
    $("btn-speak").classList.add("hidden");
    $("type-row").classList.add("hidden");
  }else if(a.tipo === "ex"){
    const it = a.item;
    const s = state.pontos[a.ponto];
    $("tk-mode").textContent = "Treino";
    $("tk-unit").textContent = nomePonto(a.ponto);
    $("tk-level").textContent = `${nivelPonto(a.ponto) === "X" ? "todos os níveis" : nivelPonto(a.ponto)} · ${E.NOME_ESTADO[E.estadoPonto(s, a.ponto, nivelBase())].toLowerCase()}`;
    rotulo(it.Instrucao || "Responda");
    if(it.Tipo === "traduzir") corpo.insertAdjacentHTML("beforeend", `<div class="pt-big">${esc(it.Frase)}</div>`);
    else{ const f = document.createElement("div"); corpo.appendChild(f); painel(f, it.Frase, null, animar); }
    $("btn-sound").disabled = $("btn-sound-slow").disabled = true;
    $("btn-speak").classList.toggle("hidden", !voz.temReconhecimento);
    $("speak-label").textContent = "Responder";
    $("type-row").classList.remove("hidden");
    $("type-answer").value = "";
    $("type-answer").placeholder = it.Tipo === "completar" ? "Opcional: o que vai na lacuna" : "Opcional: escreva e confira";
  }else{
    const deck = deckDoAtual();
    const card = cardAtual();
    if(!card) return;
    const modo = a.modo;
    const unidade = deck.Trilha && card.Unit != null ? deck.Trilha[card.Unit] : null;
    $("tk-mode").textContent = MODOS[modo].nome;
    $("tk-unit").textContent = state.entrada === "tudo" ? deck.Name : (unidade ? unidade.Titulo : (card.Kind || "palavra"));
    $("tk-level").textContent = `frase ${card.Level || 1}/${MAX_CARD_LEVEL}`;
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
  }

  if(animar && !reduzMovimento){
    $("ticket-stage").animate(
      [{ transform: "translateY(40px) scale(.96)", opacity: 0 }, { transform: "none", opacity: 1 }],
      { duration: 420, easing: "cubic-bezier(.34,1.4,.5,1)" });
  }
}

function renderVerso(){
  const corpo = $("back-body");
  corpo.innerHTML = "";
  const f = document.createElement("div"); corpo.appendChild(f);
  const ex = exAtual();
  if(ex){
    const s = state.pontos[ex.ponto];
    $("tk-mode-b").textContent = "Treino";
    $("tk-dom").textContent = s && s.n ? `domínio ${Math.round(s.m * 100)}%` : "ponto novo";
    $("tk-alvo").textContent = nomePonto(ex.ponto);
    painel(f, respostaCompleta(ex.item), ex.item.Tipo === "completar" ? ex.item.Resposta : null, true);
    if(ex.item.Explicacao) corpo.insertAdjacentHTML("beforeend", `<div class="pt small">${esc(ex.item.Explicacao)}</div>`);
    return;
  }
  const card = cardAtual();
  const modo = state.atual.modo;
  $("tk-mode-b").textContent = MODOS[modo].nome;
  const s = estadoModo(card, modo);
  $("tk-dom").textContent = s.n ? `domínio ${Math.round(s.m * 100)}%` : "card novo";
  $("tk-alvo").textContent = `alvo: ${card.Word}`;
  painel(f, card.Phrase, card.Word, true);
  corpo.insertAdjacentHTML("beforeend", `<div class="pt">${esc(card.Translation)}</div>`);
}

function virar(){
  if(!temItem()) return;
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
    if(primeira && prefs().autoplay && (exAtual() || state.atual.modo !== "ouv")) tocar(1);
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
  const ex = exAtual();
  if(ex){ voz.falar(respostaCompleta(ex.item), { idioma: "en", voz: prefs().voz, velocidade }); return; }
  const card = cardAtual();
  if(!card) return;
  voz.falar(card.Phrase, { idioma: deckDoAtual().Language, voz: prefs().voz, velocidade });
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
// Linha que diz quais erros foram pro mapa.
function htmlAnotados(lista){
  const ids = [...new Set((lista || []).map(e => e.Ponto).filter(pontoValido))];
  return ids.length ? `<div class="fb-line fb-mapa"><span class="fb-label">pro mapa</span>${ids.map(id => esc(nomePonto(id))).join(" · ")}</div>` : "";
}

let falasPendentes = 0;
async function falarResposta(){
  if(!temItem()) return;
  const ex = exAtual();
  const card = cardAtual();
  const idioma = ex ? "en" : deckDoAtual().Language;
  const btn = $("btn-speak");
  if(btn.classList.contains("ouvindo")){ voz.pararOuvir(); return; }
  voz.pararFala();
  btn.classList.add("ouvindo");
  const rotulo = $("speak-label").textContent;
  $("speak-label").textContent = "Parar";
  mostrarFeedback(`<div class="fb-line muted">${ONDA}Ouvindo…</div>`);
  let dito = "";
  try{
    dito = await voz.ouvir({ idioma, onParcial: t => mostrarFeedback(`<div class="fb-line">${ONDA}${esc(t)}</div>`) });
  }catch(err){
    mostrarFeedback(`<div class="fb-line muted">${esc(err.message)}</div>`);
    return;
  }finally{
    btn.classList.remove("ouvindo");
    $("speak-label").textContent = rotulo;
  }
  if(!dito){ mostrarFeedback('<div class="fb-line muted">Não ouvi nada. Tente de novo, ou responda pelos botões.</div>'); return; }
  falasPendentes++;
  if(ex && !state.visto){ await avaliarExercicio(dito, true); return; }
  if(!ex && state.atual.modo === "prod" && !state.visto){ await avaliarProducao(dito, true); return; }
  const { sim, marcas } = voz.comparar(ex ? respostaCompleta(ex.item) : card.Phrase, dito);
  if(!state.virado) virar();
  mostrarFeedback(htmlComparacao(marcas, dito) + `<div class="fb-line"><span class="fb-label">pronúncia</span>${Math.round(sim * 100)}% das palavras reconhecidas</div>`, true);
  sugerirNota(voz.notaPorSimilaridade(sim));
}

async function avaliarProducao(resposta, falada){
  const card = cardAtual();
  const deck = deckDoAtual();
  mostrarFeedback('<div class="fb-line muted"><span class="onda"><i></i><i></i><i></i></span>Conferindo com a IA…</div>');
  try{
    const r = await pedir(P.pedidoAvaliarProducao(deck, card, resposta, falada));
    if(!state.virado) virar();
    const ok = r.Nota === "facil" || r.Nota === "acertei";
    if(r.Erros){ anotarErros(r.Erros, "produzir"); anotarProducao("produzir", r.Erros.map(e => e.Ponto)); }
    mostrarFeedback(
      `<div class="fb-line"><span class="fb-label">você ${falada ? "disse" : "escreveu"}</span>${esc(resposta)}</div>` +
      (ok && !r.Explicacao ? "" : `<div class="fb-line"><span class="fb-label">melhor</span>${esc(r.Correcao)}</div>`) +
      (r.Explicacao ? `<div class="fb-line muted">${esc(r.Explicacao)}</div>` : "") + htmlAnotados(r.Erros), falada);
    sugerirNota(r.Nota);
  }catch(err){
    mostrarFeedback(`<div class="fb-line muted">${esc(err.message)}</div>`);
  }
}

async function avaliarExercicio(resposta, falada){
  const ex = exAtual();
  mostrarFeedback('<div class="fb-line muted"><span class="onda"><i></i><i></i><i></i></span>Conferindo com a IA…</div>');
  try{
    const r = await pedir(P.pedidoAvaliarExercicio(ex.ponto, ex.item, resposta, falada));
    if(state.atual !== ex) return;
    if(!state.virado) virar();
    mostrarFeedback(
      `<div class="fb-line"><span class="fb-label">você ${falada ? "disse" : "escreveu"}</span>${esc(resposta)}</div>` +
      `<div class="fb-line"><span class="fb-label">melhor</span>${esc(r.Correcao)}</div>` +
      (r.Explicacao ? `<div class="fb-line muted">${esc(r.Explicacao)}</div>` : ""), falada);
    sugerirNota(r.Nota);
  }catch(err){
    mostrarFeedback(`<div class="fb-line muted">${esc(err.message)}</div>`);
  }
}

const limparResposta = t => t.toLowerCase().replace(/[^\p{L}\p{N}' ]/gu, "").replace(/\s+/g, " ").trim();
function conferirDigitado(){
  const texto = $("type-answer").value.trim();
  if(!temItem() || !texto) return;
  $("type-answer").blur();
  const ex = exAtual();
  if(ex && ex.item.Tipo === "completar"){
    const nota = limparResposta(texto) === limparResposta(ex.item.Resposta) ? "facil" : "errei";
    if(!state.virado) virar();
    mostrarFeedback(`<div class="fb-line"><span class="fb-label">você escreveu</span>${esc(texto)}</div>`);
    sugerirNota(nota);
    return;
  }
  if(ex){ avaliarExercicio(texto, false); return; }
  const card = cardAtual();
  if(state.atual.modo === "comp"){
    const dado = limparResposta(texto);
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
  if(!temItem() || !state.visto || respondendo) return;
  respondendo = true;
  setNotas(false);
  voz.pararFala();
  vibrar(notaKey === "errei" ? 30 : 12);
  const acerto = notaKey === "acertei" || notaKey === "facil";
  const ex = exAtual();
  if(ex){
    state.pontos[ex.ponto] = E.registrarTreino(state.pontos[ex.ponto], notaKey);
    salvarPonto(ex.ponto);
    const lote = state.exercicios[ex.ponto];
    if(lote){ lote.i += 1; fb.dbPatch(fb.meu(`/Exercicios/${ex.ponto}`), { i: lote.i }).catch(() => {}); }
    somarDia({ r: 1, a: acerto ? 1 : 0, f: falasPendentes });
    state.desdeExercicio = 0;
    // O lote acabando: a IA prepara o próximo enquanto ele estuda.
    if(lote && lote.i >= lote.itens.length - 1) gerarExercicios(ex.ponto).catch(() => {});
  }else{
    const deckId = state.atual.deckId;
    const card = cardAtual();
    const key = state.atual.key;
    const { maduro } = registrarResposta(card, state.atual.modo, notaKey);
    somarDia({ r: 1, a: acerto ? 1 : 0, rm: maduro ? 1 : 0, ra: maduro && acerto ? 1 : 0, f: falasPendentes });
    fb.dbPatch(fb.meu(`/Decks/${deckId}/Cards/${key}`), {
      Modes: card.Modes, EasyStreak: card.EasyStreak, LearnedAt: card.LearnedAt || null,
    }).catch(err => toast(err.message));
    if(card.EasyStreak >= EVOLVE_STREAK_THRESHOLD) evoluirCard(deckId, key);
    state.desdeExercicio++;
  }
  falasPendentes = 0;
  publicarJuntos();

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
    el.querySelector('[data-a="study"]').addEventListener("click", () => { state.currentDeckId = id; state.pontoTreino = null; lembrarDeck(id); lembrarEntrada("deck"); irPara("v-study"); });
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
  enfeitar(c.querySelector("#f-lang"));
  enfeitar(c.querySelector("#f-level"));
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
  enfeitar(sel);
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
  if(state.cenario === "falar2"){ abrirTexto({ modo: "falar" }); return; }
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
    // A correção é da última fala dele: o erro vai pro mapa, e a fala conta como frase dele.
    const ultima = c.turnos[c.turnos.length - 1];
    if(ultima && ultima.quem === "eu" && P.classifica(deck)){
      const cor = r.Correcao || {};
      const ponto = cor.Melhor && pontoValido(cor.Ponto) ? cor.Ponto : "";
      if(ponto) anotarErros([{ Ponto: ponto, Original: cor.Original, Certo: cor.Melhor, Explicacao: cor.Explicacao }], "conversa");
      anotarProducao("conversa", ponto ? [ponto] : []);
    }
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
      `<div class="erro"><div><span class="fb-label">você</span>${esc(e.Original)}</div><div><span class="fb-label">melhor</span><b>${esc(e.Melhor)}</b></div><div class="muted">${esc(e.Explicacao)}</div>${pontoValido(e.Ponto) ? `<span class="tag yel">${esc(nomePonto(e.Ponto))}</span>` : ""}</div>`).join("") : ""}
    ${r.FrasesUteis?.length ? `<div class="section-title flat">Frases que ajudam</div><ul class="frases">${r.FrasesUteis.map(f => `<li>${esc(f)}</li>`).join("")}</ul>` : ""}
    ${cards.length && deck ? `<div class="section-title flat">Cards sugeridos</div><div class="batch-list" id="report-cards">${cards.map((c, i) =>
      `<label class="batch-item"><div><div class="batch-word">${esc(c.Word)} <span class="tag">${esc(c.Kind)}</span></div><div class="batch-phrase">${marcarAlvo(c.Phrase, c.Word)}</div></div><input type="checkbox" data-i="${i}" checked aria-label="Adicionar este card"></label>`).join("")}</div>
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
// ESCREVER 3 FRASES E FALAR 2 MINUTOS
// =========================================================
function temaDoDia(desvio = 0){
  const d = new Date();
  const n = Math.floor((d - new Date(d.getFullYear(), 0, 0)) / 864e5) + desvio;
  return TEMAS_FALA[((n % TEMAS_FALA.length) + TEMAS_FALA.length) % TEMAS_FALA.length];
}
const MIC = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0013 0M12 17.5V21"/></svg>';

function abrirTexto({ modo, desvio = 0 }){
  const falar = modo === "falar";
  const tema = falar ? temaDoDia(desvio) : "";
  let gravando = false, timer = null, t0 = 0;
  const parar = () => { gravando = false; voz.pararOuvir(); clearInterval(timer); };
  const c = abrirFolha(`
    <h2 class="sheet-title">${falar ? "Falar 2 minutos" : "Escrever 3 frases"}</h2>
    <p class="sheet-sub">${falar ? esc(tema) : "Conte em 3 frases o que você fez hoje, ou no trabalho."}</p>
    ${falar && voz.temReconhecimento ? `<div class="fala-box"><button class="mic-big" id="tx-mic" aria-label="Falar">${MIC}</button>
      <div><b id="tx-tempo">0:00</b><span class="hint" id="tx-status">Toque e fale por até 2 minutos. Toque de novo pra parar.</span></div></div>` : ""}
    <textarea id="tx-texto" rows="${falar ? 6 : 4}" placeholder="${falar ? "O que você falar aparece aqui. Dá pra escrever também." : "Escreva em inglês"}"></textarea>
    <div class="row-2">${falar ? '<button class="btn btn-ghost" id="tx-outro">Outro tema</button>' : '<button class="btn btn-ghost" id="tx-pular">Pular hoje</button>'}
      <button class="btn btn-yel" id="tx-ok">Corrigir</button></div>`, { aoFechar: parar });
  const area = c.querySelector("#tx-texto");
  c.querySelector("#tx-pular")?.addEventListener("click", () => { marcarEscrita(2); fecharFolha(); if(state.atual?.tipo === "escrever") proximoCard(); });
  c.querySelector("#tx-outro")?.addEventListener("click", () => { parar(); abrirTexto({ modo, desvio: desvio + 1 }); });
  const mic = c.querySelector("#tx-mic");
  mic?.addEventListener("click", async () => {
    if(gravando){ parar(); mic.classList.remove("ouvindo"); return; }
    gravando = true; t0 = Date.now(); mic.classList.add("ouvindo");
    c.querySelector("#tx-status").textContent = "Ouvindo…";
    timer = setInterval(() => {
      const s = Math.floor((Date.now() - t0) / 1000);
      const el = c.querySelector("#tx-tempo");
      if(el) el.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
      if(s >= 120){ parar(); mic.classList.remove("ouvindo"); }
    }, 250);
    // O reconhecimento para sozinho depois de um silêncio: volta a ouvir até ele parar.
    while(gravando){
      const antes = area.value.trim();
      try{
        const dito = await voz.ouvir({ idioma: "en", continuo: true, onParcial: x => { area.value = (antes ? antes + " " : "") + x; } });
        area.value = (antes ? antes + " " : "") + dito;
      }catch(err){ toast(err.message); parar(); }
    }
    mic.classList.remove("ouvindo");
    const st = c.querySelector("#tx-status"); if(st) st.textContent = "Pode corrigir, ou tocar de novo pra continuar.";
  });
  c.querySelector("#tx-ok").addEventListener("click", async e => {
    const texto = area.value.trim();
    if(texto.split(/\s+/).length < 4){ toast(falar ? "Fale um pouco mais antes de corrigir." : "Escreva pelo menos uma frase."); return; }
    parar();
    let r = null;
    await acao("Corrigindo…", async () => {
      r = await pedir(P.pedidoCorrigirTexto(texto.slice(0, 6000), { objetivo: objetivoIngles(), tema, falada: falar && !!mic }));
    }, e.currentTarget);
    if(!r) return;
    const fonte = falar ? "falar" : "escrever";
    anotarErros(r.Frases.flatMap(f => f.Erros || []), fonte);
    r.Frases.forEach(f => anotarProducao(fonte, (f.Erros || []).map(x => x.Ponto)));
    if(falar) somarDia({ f: 1 }); else marcarEscrita(1);
    mostrarCorrecaoTexto(r, falar);
  });
}

function mostrarCorrecaoTexto(r, falar){
  const c = abrirFolha(`
    <h2 class="sheet-title">Correção</h2>
    <p class="sheet-sub">${esc(r.Comentario)}</p>
    ${r.Frases.map(f => {
      const certa = !(f.Erros || []).length && f.Original.trim() === f.Certo.trim();
      return `<div class="erro ${certa ? "certa" : ""}"><div><span class="fb-label">você</span>${esc(f.Original)}</div>
        ${certa ? "" : `<div><span class="fb-label">melhor</span><b>${esc(f.Certo)}</b></div>`}
        ${(f.Erros || []).map(x => `<div class="muted">${pontoValido(x.Ponto) ? `<span class="tag yel">${esc(nomePonto(x.Ponto))}</span> ` : ""}${esc(x.Explicacao)}</div>`).join("")}</div>`;
    }).join("")}
    ${r.Melhores?.length ? `<div class="section-title flat">${falar ? "Três frases prontas pra próxima" : "Frases que ajudam"}</div><ul class="frases">${r.Melhores.map(f => `<li>${esc(f)}</li>`).join("")}</ul>` : ""}
    <button class="btn btn-yel btn-block" id="tx-fim">Continuar</button>`);
  c.querySelector("#tx-fim").addEventListener("click", () => {
    fecharFolha();
    if(state.atual?.tipo === "escrever" && viewAtual === "v-study") proximoCard();
  });
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
        ${m.Regua && m.Regua.prox ? `<div class="m-regua"><span><b>${esc(m.Regua.atual || "—")}</b> → ${esc(m.Regua.prox)} ${m.Regua.pct}% <span style="color:var(--tx3)">de 70%</span></span><div class="progress"><i style="width:${m.Regua.pct}%"></i><em></em></div></div>` : ""}
        ${(m.Fracos3 || []).filter(id => PONTO[id]).length ? `<div class="m-fracos">${m.Fracos3.filter(id => PONTO[id]).map(id => `<span>${esc(nomePonto(id))}</span>`).join("")}</div>` : ""}
      </div>
      ${eu ? '<button class="btn btn-ghost btn-sm m-you" id="btn-you">Você · números e ajustes</button>' : `<button class="btn btn-ghost btn-sm m-you" data-outro="${uid}">Ver o progresso</button>`}`;
    grid.appendChild(el);
  });
  $("btn-you")?.addEventListener("click", () => irPara("v-you", { camada: true }));
  grid.querySelectorAll("[data-outro]").forEach(b => b.addEventListener("click", () => { state.outroUid = b.dataset.outro; irPara("v-outro", { camada: true }); }));
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
  const membros = Object.values(state.juntos).map(m => ({ Nome: m.Nome, Nivel: m.Nivel, Objetivo: m.Objetivo, Fracas: m.Fracas || [], Pontos: (m.Fracos3 || []).filter(id => PONTO[id]).map(nomePonto) }));
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
// MEUS ERROS, AULA E RÉGUA (ES-22)
// =========================================================
// Abre uma aba da barra de baixo a partir de uma subtela, fechando as camadas.
function irParaAba(view){
  while(camadas.length){ camadas.pop(); history.back(); }
  if(!$("sheet-root").hidden){ $("sheet-root").classList.remove("aberta"); $("sheet-root").hidden = true; }
  irPara(view);
}
const plural = (n, um, varios) => `${n} ${n === 1 ? um : varios}`;
const dataCurta = iso => iso ? new Date(iso).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" }) : "";

function linhaPonto({ id, estado, erros = 0, o, c, m, tip }){
  const nv = nivelPonto(id);
  return `<button class="ponto-row est-${estado}" data-id="${id}">
    <span class="pr-nv">${nv === "X" ? "PT" : nv}</span>
    <span class="pr-nome">${esc(nomePonto(id))}</span>
    <span class="pr-num">${erros ? plural(erros, "erro", "erros") + " · " : ""}${(E.NOME_ESTADO[estado] || "").toLowerCase()}</span>
    ${o ? `<span class="pr-ex"><s>${esc(o)}</s> → ${esc(c)}</span>` : tip ? `<span class="pr-ex">erro comum: ${esc(tip)}</span>` : ""}
    ${m !== undefined ? `<span class="dom"><i style="width:${Math.round(m * 100)}%"></i></span>` : ""}
  </button>`;
}

function renderErros(){
  const base = nivelBase();
  const lista = E.pontosComErro(state.pontos, base);
  const por = { treinando: [], quase: [], dominado: [] };
  lista.forEach(x => por[x.estado] && por[x.estado].push(x));
  const total = lista.reduce((a, x) => a + x.reg.erros, 0);
  $("erros-resumo").textContent = lista.length ? `${plural(lista.length, "ponto", "pontos")} com erro · ${plural(total, "erro", "erros")} no total` : "cada erro cai num ponto de gramática";
  $("erros-dica").textContent = {
    treinando: "Errou há pouco. Os exercícios do Tudo puxam estes primeiro.",
    quase: "Domínio bom. Falta acertar em 3 dias diferentes, sem errar há 7.",
    dominado: "Acertou em 3 dias, sem errar há 7. Errou de novo, o ponto volta pra Treinando.",
  }[state.errosAba] || "";
  $("erros-tabs").querySelectorAll("button").forEach(b => {
    b.classList.toggle("on", b.dataset.tab === state.errosAba);
    b.querySelector("small").textContent = por[b.dataset.tab].length;
  });
  const box = $("erros-lista");
  if(!lista.length){
    box.innerHTML = `<div class="empty"><div class="empty-title">Nenhum erro ainda</div><p>Os erros do Produzir, da Conversa, do Escrever, do Falar e do teste de Nível entram aqui, cada um no ponto de gramática dele.</p></div>`;
  }else{
    const itens = por[state.errosAba];
    box.innerHTML = itens.length ? itens.map(({ id, reg, estado }) => {
      const ult = errosDoPonto(id)[0];
      return linhaPonto({ id, estado, erros: reg.erros, o: ult && ult[1].o, c: ult && ult[1].c, m: reg.m });
    }).join("") : `<p class="empty-line">${state.errosAba === "dominado" ? "Nenhum ponto dominado ainda. Um ponto é dominado quando você acerta em 3 dias diferentes, sem errar nos últimos 7." : "Nenhum ponto aqui."}</p>`;
    box.querySelectorAll(".ponto-row").forEach(b => b.addEventListener("click", () => abrirPonto(b.dataset.id)));
  }
  const emTreino = por.treinando.length + por.quase.length;
  $("btn-treinar-erros").disabled = !emTreino;
  $("btn-treinar-erros").textContent = emTreino ? `Treinar os ${plural(emTreino, "ponto", "pontos")}` : "Treinar os erros";
}

function abrirPonto(id){
  state.pontoId = id;
  irPara("v-ponto", { camada: true });
}

async function carregarAula(id, refazer = false){
  if(!refazer && state.aulas[id]) return state.aulas[id];
  if(!refazer){
    const salva = await fb.dbGet(fb.meu(`/Aulas/${id}`)).catch(() => null);
    if(salva){ state.aulas[id] = salva; return salva; }
  }
  const conteudo = await pedir(P.pedidoAula(id, errosDoPonto(id).map(([, e]) => e), objetivoIngles()));
  state.aulas[id] = { conteudo, criado: new Date().toISOString() };
  fb.dbPut(fb.meu(`/Aulas/${id}`), state.aulas[id]).catch(() => {});
  return state.aulas[id];
}

function renderPonto(){
  const id = state.pontoId;
  if(!PONTO[id]) return;
  const base = nivelBase();
  const reg = state.pontos[id];
  const estado = E.estadoPonto(reg, id, base);
  const nv = nivelPonto(id);
  $("ponto-nome").textContent = nomePonto(id);
  $("ponto-meta").innerHTML = `<span class="tag yel">${nv === "X" ? "todos os níveis" : nv}</span><span class="tag est-${estado}">${E.NOME_ESTADO[estado]}</span>` +
    (reg ? `<span class="tag">${plural(reg.erros || 0, "erro", "erros")}</span><span class="tag">domínio ${Math.round((reg.m || 0) * 100)}%</span>` : "");
  const p = PONTO[id];
  $("ponto-sobre").innerHTML = (nv === "X"
    ? "Vale pra todos os níveis, e conta como erro na régua a partir do B1."
    : `Conta na gramática do <b>${nv}</b>: é 1 dos ${PONTOS.filter(x => x.n === nv).length} pontos dele.`) +
    ` Erro comum de quem fala português: <b>${esc(p.tip)}</b>.` +
    (estado === "presumido" ? " Conta como sabido pelo nivelamento, até um erro dizer o contrário." : "");
  const erros = errosDoPonto(id);
  $("ponto-erros").innerHTML = erros.length ? erros.slice(0, 20).map(([k, e]) => `
    <div class="erro"><div><span class="fb-label">você</span>${esc(e.o)}</div><div><span class="fb-label">certo</span><b>${esc(e.c)}</b></div>
      ${e.e ? `<div class="muted">${esc(e.e)}</div>` : ""}
      <div class="erro-pe"><span>${esc(FONTE_NOME[e.f] || e.f || "")} · ${dataCurta(e.d)}</span><button class="link" data-mover="${k}">Mover de ponto</button></div></div>`).join("")
    : '<p class="empty-line">Nenhum erro seu neste ponto.</p>';
  $("ponto-erros").querySelectorAll("[data-mover]").forEach(b => b.addEventListener("click", () => moverErro(b.dataset.mover)));
  const aula = $("ponto-aula");
  aula.innerHTML = '<div class="skel"></div><div class="skel"></div><div class="skel"></div>';
  carregarAula(id).then(a => { if(state.pontoId === id) mostrarAula(a.conteudo); })
    .catch(err => { if(state.pontoId === id) aula.innerHTML = `<p class="empty-line">${esc(err.message)}</p>`; });
}

function mostrarAula(a){
  const box = $("ponto-aula");
  box.innerHTML = `
    <div class="section-title flat">Por que você erra</div><p class="aula-p">${esc(a.PorQue)}</p>
    <div class="section-title flat">Como é o certo</div><div class="regra">${esc(a.Regra)}</div>
    <div class="exemplos">${(a.Exemplos || []).map((x, i) => `<div class="exemplo"><div><b>${esc(x.En)}</b><span>${esc(x.Pt)}</span></div><button class="icon-btn" data-ouvir="${i}" aria-label="Ouvir">${ICONE.som}</button></div>`).join("")}</div>
    <div class="section-title flat">Pra não confundir</div><p class="aula-p">${esc(a.NaoConfundir)}</p>
    <button class="link" id="btn-refazer-aula">Refazer a aula</button>`;
  box.querySelectorAll("[data-ouvir]").forEach(b => b.addEventListener("click", () => voz.falar(a.Exemplos[+b.dataset.ouvir].En, { idioma: "en", voz: prefs().voz })));
  $("btn-refazer-aula").addEventListener("click", async e => {
    const id = state.pontoId;
    await acao("Refazendo a aula…", async () => { const n = await carregarAula(id, true); if(state.pontoId === id) mostrarAula(n.conteudo); }, e.currentTarget);
  });
}

function treinarPonto(){
  state.pontoTreino = state.pontoId;
  irParaAba("v-study");
}

// A IA pode pôr um erro no ponto vizinho: ele move com um toque, escolhendo da lista.
function moverErro(k){
  const e = state.erros[k];
  if(!e) return;
  const grupos = ["A1", "A2", "B1", "B2", "C1", "X"];
  const c = abrirFolha(`
    <h2 class="sheet-title">Mover pra qual ponto?</h2>
    <p class="sheet-sub"><s>${esc(e.o)}</s> → ${esc(e.c)}</p>
    ${grupos.map(g => `<div class="section-title flat">${g === "X" ? "Todos os níveis" : g}</div>
      <div class="menu">${PONTOS.filter(p => p.n === g).map(p => `<button data-p="${p.id}" class="${p.id === e.p ? "on" : ""}">${esc(p.nome)}</button>`).join("")}</div>`).join("")}`);
  c.querySelectorAll("[data-p]").forEach(b => b.addEventListener("click", () => {
    const novo = b.dataset.p;
    fecharFolha();
    if(novo === e.p) return;
    const velho = e.p;
    if(state.pontos[velho]){
      state.pontos[velho].erros = Math.max(0, (state.pontos[velho].erros || 0) - 1);
      salvarPonto(velho);
    }
    const presumido = E.estadoPonto(state.pontos[novo], novo, nivelBase()) === "presumido";
    state.pontos[novo] = E.registrarErroPonto(state.pontos[novo], { presumido });
    salvarPonto(novo);
    e.p = novo;
    fb.dbPatch(fb.meu(`/Erros/${k}`), { p: novo }).catch(err => toast(err.message));
    toast(`Erro movido para ${nomePonto(novo)}.`);
    publicarJuntos();
    renderPonto();
  }));
}

// ---------- Régua (Juntos e o progresso do outro) ----------
// niveis: [{ n, pct }] de A1 a C1, com pct de 0 a 1.
function reguaHtml(niveis, atual, interativo){
  const idx = atual ? NIVEIS_REGUA.indexOf(atual) : -1;
  return `<div class="regua">${niveis.map((nv, i) => {
    const pct = Math.round(nv.pct * 100);
    const cls = i <= idx ? "seu" : i === idx + 1 ? "prox" : "";
    return `<${interativo ? "button" : "div"} class="rg-linha ${cls}" data-nivel="${nv.n}">
      <b>${nv.n}</b><span class="rg-barra"><i style="width:${pct}%"></i><em></em></span><span class="rg-pct">${pct}%</span></${interativo ? "button" : "div"}>`;
  }).join("")}<div class="rg-legenda">a partir de ${Math.round(E.LIMIAR * 100)}%, o nível conta como seu</div></div>`;
}

// =========================================================
// NÍVEL: onde você está, quanto falta pra cada nível, os pontos e o fluxograma
// =========================================================
// O que cada nível quer dizer na prática (conhecimento do modelo, a régua CEFR).
const NOME_NIVEL = { A1: "Iniciante", A2: "Básico", B1: "Intermediário", B2: "Intermediário avançado", C1: "Avançado" };
const FAZ_NIVEL = {
  A1: "se apresentar e frases do dia a dia",
  A2: "rotina, passado e se virar numa viagem",
  B1: "falar de trabalho, planos e hipóteses simples",
  B2: "entrevista e reunião em inglês, com nuance",
  C1: "falar e escrever com naturalidade e registro",
};
const pct = x => Math.round((x || 0) * 100);
const SETA = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';
const ABRE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 10l5 5 5-5"/></svg>';

const classeNivel = (n, r) => {
  const i = NIVEIS_REGUA.indexOf(n), idx = r.atual ? NIVEIS_REGUA.indexOf(r.atual) : -1;
  return i <= idx ? "seu" : i === idx + 1 ? "prox" : "";
};
const rotuloNivel = c => c === "seu" ? "seu" : c === "prox" ? "próximo" : "depois";

// A pílula do nível, no topo de toda tela: o de agora e o próximo, com a barra até 70%.
function atualizarPilulas(){
  const pilulas = document.querySelectorAll("[data-nvpill]");
  if(!fb.sessao || !fb.sessao.uid || !temIngles()){ pilulas.forEach(p => p.classList.add("hidden")); return; }
  const r = minhaRegua();
  const html = `<b class="${r.atual ? "" : "sem"}">${r.atual || "—"}</b>` + (r.prox
    ? `<span class="nvp-bar"><i style="width:${pct(r.pctProx)}%"></i><em></em></span><span class="nvp-prox">${r.prox} ${pct(r.pctProx)}%</span>`
    : "");
  const titulo = r.prox ? `Seu nível: ${r.atual || "nenhum ainda"}. ${r.prox} em ${pct(r.pctProx)}%; conta como seu em 70%.` : `Seu nível: ${r.atual}`;
  pilulas.forEach(p => { p.classList.remove("hidden"); p.innerHTML = html; p.title = titulo; });
}

function abrirNivel(){
  preencherSelect($("level-deck"), state.currentDeckId);
  renderNivel();
  carregarNiveis();
}

function renderNivel(){
  const r = minhaRegua();
  const base = nivelBase();
  if(!state.nivelSel || !NIVEIS_REGUA.includes(state.nivelSel)) state.nivelSel = r.prox || r.atual || "A1";
  const sel = state.nivelSel;

  // O topo: o de agora, o próximo, a barra até 70% e a escada inteira
  const p = pct(r.pctProx);
  const frase = r.prox
    ? `O <b>${r.prox}</b> está em <b>${p}%</b>. ${p >= 70 ? "Já passou de 70%: confirme no teste de nível, no fim desta tela." : `Faltam <b>${70 - p} pontos</b> pra chegar a 70% e ele contar como seu.`}`
    : `Você chegou ao <b>${r.atual}</b>, o topo da régua.`;
  const leg = `<div class="nv-barra-leg">${Math.abs(p - 70) >= 13 ? `<span class="agora" style="left:${Math.max(5, Math.min(95, p))}%">${p}%</span>` : ""}<span class="m70">70%</span></div>`;
  $("nivel-hero").innerHTML = `<div class="nv-hero">
    <div class="nv-agora">
      <div class="nv-big ${r.atual ? "" : "sem"}"><b>${r.atual || "—"}</b><span>seu nível</span></div>
      ${r.prox ? `<span class="nv-seta">${SETA}</span><div class="nv-big prox"><b>${r.prox}</b><span>próximo</span></div>` : ""}
      <div class="nv-frase">${frase}${base ? "" : " A régua parte do teste de nível: faça uma vez, no fim desta tela."}</div>
    </div>
    ${r.prox ? `<div><div class="nv-barra"><i style="width:${p}%"></i><em></em></div>${leg}</div>` : ""}
    <div class="escada">${r.niveis.map(nv => {
      const c = classeNivel(nv.n, r);
      return `<button class="degrau ${c}${nv.n === sel ? " on" : ""}" data-nivel="${nv.n}" aria-pressed="${nv.n === sel}">
        <b>${nv.n}</b><span class="dg-bar"><i style="width:${pct(nv.pct)}%"></i><em></em></span><span class="dg-pct">${pct(nv.pct)}%</span><span class="dg-st">${rotuloNivel(c)}</span></button>`;
    }).join("")}</div>
  </div>`;
  $("nivel-hero").querySelectorAll(".degrau").forEach(b => b.addEventListener("click", () => {
    state.nivelSel = b.dataset.nivel;
    renderNivel();
    $("falta-titulo").scrollIntoView({ behavior: reduzMovimento ? "auto" : "smooth", block: "center" });
  }));

  renderFalta(r, sel);
  renderListaNiveis(r, sel);
  $("nivel-fluxo").innerHTML = fluxoHtml(r);
}

// O que falta pra um nível, parte por parte, em coisas que dá pra fazer.
function renderFalta(r, n){
  const nv = r.niveis.find(x => x.n === n);
  const base = nivelBase();
  const aprendidos = aprendidosIngles();
  const f = E.faltaNivel(nv, { regs: state.pontos, base, aprendidos, frases: r.frases });
  const c = classeNivel(n, r);
  $("falta-titulo").textContent = c === "seu" ? `O ${n} já é seu` : `O que falta pro ${n}`;
  $("falta-n").textContent = `${pct(nv.pct)}% de 70%`;
  const milhar = x => x.toLocaleString("pt-BR");
  const linha = (cls, nome, peso, pctTxt, barra, tem, falta, como) => `<div class="fl-linha ${cls}">
    <span class="fl-nome">${nome}<small>${peso}</small></span><span class="fl-pct">${pctTxt}</span>
    <span class="fl-barra"><i style="width:${barra}%"></i><em></em></span>
    <span class="fl-tem" style="grid-column:1 / -1">${tem}</span>
    <span class="fl-falta">${falta}</span>
    <span class="fl-como">${como}</span></div>`;
  const primeiros = f.gram.ids.slice(0, 3).map(id => esc(nomePonto(id)));
  const usoSem = f.uso.pct === null;
  $("nivel-falta").innerHTML =
    linha(f.gram.ok ? "ok" : "", "Gramática", "metade do nível", `${pct(f.gram.pct)}%`, pct(f.gram.pct),
      `${f.gram.dominados} de ${f.gram.total} pontos do ${n} dominados ou sabidos`,
      f.gram.ok ? "Já passou de 70%." : `Falta: dominar mais <b>${plural(f.gram.pontos, "ponto", "pontos")}</b>${primeiros.length ? `, começando por ${primeiros.join(", ")}` : ""}.`,
      "Toque num ponto do nível, logo abaixo, e use Treinar só este. Dominado é acertar em 3 dias diferentes, sem errar há 7.") +
    linha(f.vocab.ok ? "ok" : "", "Vocabulário", "um quarto", `${pct(f.vocab.pct)}%`, pct(f.vocab.pct),
      base ? `cerca de ${milhar(f.vocab.palavras)} de ${milhar(f.vocab.meta)} palavras: o ${base} conta como ${milhar(META_VOCAB[base])}, mais ${milhar(aprendidos)} cards aprendidos`
        : `${milhar(f.vocab.palavras)} de ${milhar(f.vocab.meta)} palavras, contando os cards aprendidos`,
      f.vocab.ok ? "Já passou de 70%." : `Falta: aprender mais <b>${milhar(f.vocab.falta)} cards</b>.`,
      "Gere os 10 cards de cada unidade em Baralhos e estude até virarem aprendidos.") +
    linha(usoSem ? "sem" : f.uso.ok ? "ok" : "", "Uso", "um quarto", usoSem ? "—" : `${pct(f.uso.pct)}%`, usoSem ? 0 : pct(f.uso.pct),
      usoSem ? `sem medida: ${plural(r.frases, "frase sua", "frases suas")} nos últimos 30 dias, de ${E.MIN_FRASES_USO} que a conta pede`
        : `${pct(f.uso.pct)}% das ${r.frases} frases dos últimos 30 dias sem erro do ${n} ou de baixo`,
      usoSem ? `Falta: escrever ou falar mais <b>${plural(f.uso.faltaFrases, "frase", "frases")}</b> pra essa parte passar a contar.`
        : f.uso.ok ? "Já passou de 70%." : `Falta: <b>7 em cada 10 frases</b> sem erro do ${n} ou de baixo.`,
      "Escrever 3 frases (aparece no Tudo uma vez por dia), Falar 2 minutos e as entrevistas do Conversar.") +
    `<div class="fl-rodape">A conta: metade gramática, um quarto vocabulário e um quarto uso.${usoSem ? " Enquanto o uso não tem medida, a conta usa só as outras duas." : ""}</div>`;
}

// Os cinco níveis, cada um com todos os pontos de gramática dele.
function renderListaNiveis(r, sel){
  const base = nivelBase();
  const aprendidos = aprendidosIngles();
  const ordem = ["dominado", "presumido", "quase", "treinando", "nao-medido"];
  const box = $("nivel-lista");
  const cartao = (n, nv) => {
    const est = PONTOS.filter(p => p.n === n).map(p => ({ p, e: E.estadoPonto(state.pontos[p.id], p.id, base) }));
    const conta = Object.fromEntries(ordem.map(o => [o, est.filter(x => x.e === o).length]));
    const linhas = est.map(({ p, e }) => {
      const reg = state.pontos[p.id];
      const ult = errosDoPonto(p.id)[0];
      return linhaPonto({ id: p.id, estado: e, erros: (reg && reg.erros) || 0, o: ult && ult[1].o, c: ult && ult[1].c, tip: p.tip });
    }).join("");
    if(!nv) return `<details class="nivel-card" data-nivel="X">
      <summary><span class="nc-cod">PT</span><span class="nc-nome"><b>Frase montada em português</b><span>vale pra todos os níveis; conta como erro a partir do B1</span></span><span class="nc-pct"></span><span class="nc-seta">${ABRE}</span></summary>
      <div class="nc-corpo"><div class="ponto-lista">${linhas}</div></div></details>`;
    const c = classeNivel(n, r);
    const f = E.faltaNivel(nv, { regs: state.pontos, base, aprendidos, frases: r.frases });
    const falta = [];
    if(!f.gram.ok) falta.push(`dominar <b>${plural(f.gram.pontos, "ponto", "pontos")}</b>`);
    if(!f.vocab.ok) falta.push(`aprender <b>${f.vocab.falta.toLocaleString("pt-BR")} cards</b>`);
    if(f.uso.pct === null) falta.push(`mais <b>${plural(f.uso.faltaFrases, "frase", "frases")}</b> suas`);
    else if(!f.uso.ok) falta.push("<b>7 em 10 frases</b> sem erro");
    const mix = ordem.filter(o => conta[o]).map(o => `<i class="est-${o}" style="flex:${conta[o]};background:var(--e)"></i>`).join("");
    return `<details class="nivel-card ${c}" data-nivel="${n}" ${n === sel ? "open" : ""}>
      <summary><span class="nc-cod">${n}</span><span class="nc-nome"><b>${NOME_NIVEL[n]}</b><span>${FAZ_NIVEL[n]}</span></span><span class="nc-pct">${pct(nv.pct)}%</span><span class="nc-seta">${ABRE}</span>
        <span class="nc-barra"><i style="width:${pct(nv.pct)}%"></i><em></em></span></summary>
      <div class="nc-corpo">
        <div class="nc-partes">
          <div><b>${pct(nv.gram)}%</b><span>gramática · ${nv.dominados} de ${nv.total} pontos</span></div>
          <div><b>${pct(nv.vocab)}%</b><span>vocabulário · meta de ${nv.metaVocab.toLocaleString("pt-BR")}</span></div>
          <div><b>${nv.uso === null ? "—" : pct(nv.uso) + "%"}</b><span>uso · ${nv.uso === null ? "sem medida" : "frases limpas"}</span></div>
        </div>
        <div class="nc-falta">${c === "seu" ? `O ${n} já é seu.` : `Pra chegar a 70%: ${falta.join(", ") || "falta pouco"}.`}</div>
        <div class="nc-mix">${mix}</div>
        <div class="nc-mix-leg">${ordem.filter(o => conta[o]).map(o => `<span class="est-${o}"><i></i>${conta[o]} ${E.NOME_ESTADO[o].toLowerCase()}</span>`).join("")}</div>
        <div class="ponto-lista">${linhas}</div>
      </div></details>`;
  };
  box.innerHTML = r.niveis.map(nv => cartao(nv.n, nv)).join("") + cartao("X", null);
  box.querySelectorAll(".ponto-row").forEach(b => b.addEventListener("click", () => abrirPonto(b.dataset.id)));
  box.querySelectorAll("details[data-nivel]").forEach(d => d.addEventListener("toggle", () => {
    if(d.open && NIVEIS_REGUA.includes(d.dataset.nivel) && d.dataset.nivel !== state.nivelSel){
      state.nivelSel = d.dataset.nivel;
      renderFalta(r, state.nivelSel);
      $("nivel-hero").querySelectorAll(".degrau").forEach(b => { const on = b.dataset.nivel === state.nivelSel; b.classList.toggle("on", on); b.setAttribute("aria-pressed", on); });
    }
  }));
}

// O fluxograma: de cada resposta até um nível novo, com os números de agora.
function fluxoHtml(r){
  const base = nivelBase();
  const est = PONTOS.map(p => E.estadoPonto(state.pontos[p.id], p.id, base));
  const emTreino = E.pontosComErro(state.pontos, base).filter(x => x.estado !== "dominado").length;
  const dominados = est.filter(e => e === "dominado").length;
  const L = (x1, y1, x2, y2) => `<path class="fx-l" d="M${x1} ${y1}L${x2} ${y2}" marker-end="url(#fx-a)"/>`;
  const caixa = (x, y, w, h, cls, linhas) => {
    const cx = x + w / 2;
    const passo = 14, y0 = y + h / 2 - (linhas.length - 1) * passo / 2 + 4;
    return `<rect class="fx-caixa ${cls}" x="${x}" y="${y}" width="${w}" height="${h}" rx="8"/>` +
      linhas.map(([t, c], i) => `<text class="${c || (i ? "fx-s" : "fx-t")}" x="${cx}" y="${y0 + i * passo}" text-anchor="middle">${esc(t)}</text>`).join("");
  };
  const losango = (cy, hw, hh, linhas) => {
    const cx = 110;
    return `<polygon class="fx-dec" points="${cx},${cy - hh} ${cx + hw},${cy} ${cx},${cy + hh} ${cx - hw},${cy}"/>` +
      linhas.map((t, i) => `<text class="fx-t" style="font-size:11.5px" x="${cx}" y="${cy + 4 - (linhas.length - 1) * 7 + i * 14}" text-anchor="middle">${esc(t)}</text>`).join("");
  };
  const R = (x, y, t, cls) => `<text class="fx-r ${cls || ""}" x="${x}" y="${y}">${t}</text>`;
  const prox = r.prox ? `${r.prox} em ${pct(r.pctProx)}%` : "no topo";
  return `<svg viewBox="-12 0 388 692" role="img" aria-label="Fluxograma: você estuda e responde; o erro vira um ponto, treinado até ficar dominado; a régua sobe e o teste confirma o nível novo.">
    <defs><marker id="fx-a" viewBox="0 0 8 8" refX="7.5" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="fx-seta" d="M0 0L8 4L0 8z"/></marker></defs>
    ${caixa(10, 8, 200, 54, "ac", [["Estudar · Tudo"], ["cards, 1 exercício a cada 3"], ["e Escrever 1 vez por dia"]])}
    ${L(110, 62, 110, 80)}
    ${caixa(10, 80, 200, 40, "", [["Você responde"], ["virando, escrevendo ou falando"]])}
    ${L(110, 120, 110, 134)}
    ${losango(164, 62, 30, ["Errou?"])}
    ${L(172, 164, 232, 164)}${R(186, 157, "sim", "sim")}
    ${caixa(232, 140, 120, 48, "bad", [["Vira erro"], ["num ponto do mapa"], [`em treino: ${emTreino}`, "fx-n bad"]])}
    ${L(292, 188, 292, 204)}
    ${caixa(232, 204, 120, 44, "", [["Aula e exercícios"], ["do ponto, mais vezes"]])}
    <path class="fx-l volta" d="M352 226H370V100H212" marker-end="url(#fx-a)"/>
    ${L(110, 194, 110, 214)}${R(118, 208, "não", "ok")}
    ${caixa(10, 214, 200, 40, "", [["O ponto ganha domínio"], ["acerto sobe, erro derruba"]])}
    ${L(110, 254, 110, 270)}
    ${losango(306, 90, 36, ["Acertou em 3 dias", "sem errar há 7?"])}
    ${L(200, 306, 232, 306)}${R(205, 299, "não")}
    ${caixa(232, 286, 120, 40, "lado", [["Segue treinando"], ["volta ao estudo"]])}
    ${L(110, 342, 110, 362)}${R(118, 356, "sim", "ok")}
    ${caixa(10, 362, 200, 44, "ok", [["Ponto dominado"], [`dominados: ${dominados}`, "fx-n ok"]])}
    ${L(110, 406, 110, 424)}
    ${caixa(10, 424, 200, 48, "", [["A régua sobe"], ["gramática + vocabulário + uso"]])}
    ${caixa(232, 420, 120, 56, "lado", [["Também sobem"], ["cards aprendidos"], ["frases sem erro"]])}
    ${L(232, 448, 212, 448)}
    ${L(110, 472, 110, 490)}
    ${losango(526, 90, 36, ["O próximo nível", "passou de 70%?"])}
    ${L(200, 526, 232, 526)}${R(205, 519, "não")}
    ${caixa(232, 504, 120, 44, "lado", [["Ainda não"], [prox, "fx-n warn"]])}
    ${L(110, 562, 110, 582)}${R(118, 576, "sim", "ok")}
    ${caixa(10, 582, 200, 40, "", [["Teste de nível"], ["confirma, aqui na aba Nível"]])}
    ${L(110, 622, 110, 640)}
    ${caixa(10, 640, 200, 44, "ac", [["Nível novo"], ["o ciclo segue no próximo"]])}
    <path class="fx-l volta" d="M10 662H-6V35H8" marker-end="url(#fx-a)"/>
  </svg>`;
}

// ---------- O progresso do outro, só pra ver ----------
function renderOutro(){
  const m = state.juntos[state.outroUid];
  if(!m) return;
  $("outro-nome").textContent = m.Nome || "—";
  const rg = m.Regua;
  $("outro-regua").innerHTML = rg && rg.niveis ? `
    <div class="route-head"><span class="section-title flat">Régua de nível</span><span class="tag yel">${rg.atual ? "Nível: " + esc(rg.atual) : "Ainda sem nível"}</span></div>
    ${reguaHtml(NIVEIS_REGUA.map(n => ({ n, pct: (rg.niveis[n] || 0) / 100 })), rg.atual, false)}`
    : '<p class="empty-line">A régua aparece aqui depois que essa pessoa abrir o Fluência novo uma vez.</p>';
  const st = m.Stats || {};
  $("outro-stats").innerHTML = `
    <div><b>${m.Sequencia || 0}</b><span>dias seguidos</span></div>
    <div><b>${st.revisoes ?? "—"}</b><span>revisões, 30 dias</span></div>
    <div><b>${st.precisao >= 0 ? st.precisao + "%" : "—"}</b><span>precisão, 30 dias</span></div>
    <div><b>${st.aprendidos ?? "—"}</b><span>cards aprendidos</span></div>
    <div><b>${st.faladas ?? "—"}</b><span>falas, 30 dias</span></div>
    <div><b>${st.total ?? "—"}</b><span>cards no total</span></div>`;
  const pts = Object.entries(m.Pontos || {});
  const ordem = { treinando: 0, quase: 1, dominado: 2 };
  pts.sort((a, b) => (ordem[a[1].e] - ordem[b[1].e]) || (b[1].x - a[1].x));
  $("outro-erros").innerHTML = pts.length ? pts.map(([id, p]) => PONTO[id] ? linhaPonto({ id, estado: p.e, erros: p.x, o: p.o, c: p.c }) : "").join("")
    : '<p class="empty-line">Nenhum erro no mapa ainda.</p>';
}

// =========================================================
// VOCÊ: estatísticas, nível e ajustes
// =========================================================
function abrirVoce(){
  preencherStatsSelect();
  renderStats();
  renderConfig();
}

function preencherStatsSelect(){
  const sel = $("stats-deck-select");
  sel.innerHTML = '<option value="all">Todos os baralhos</option>' + Object.entries(state.decks).map(([id, d]) => `<option value="${id}">${esc(d.Name)}</option>`).join("");
  sel.value = state.statsDeckId !== "all" && state.decks[state.statsDeckId] ? state.statsDeckId : "all";
  state.statsDeckId = sel.value;
  enfeitar(sel);
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
    if(P.classifica(deck)) t.itens.forEach((it, i) => {
      const errs = (r.Itens[i] && r.Itens[i].Erros) || [];
      anotarErros(errs, "nivel");
      if(it.Tipo !== "compreensao" && (t.respostas[i] || "").trim()) anotarProducao("nivel", errs.map(e => e.Ponto));
    });
    publicarJuntos(true);
    renderNivel();
    atualizarPilulas();
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
  enfeitar($("cfg-voice"));
  enfeitar($("cfg-slow"));
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
    await aplicarSemente().catch(err => console.warn("Semente da ES-16", err));
    $("login").classList.add("hidden");
    $("app").classList.remove("hidden");
    let ultimo = null;
    try{ ultimo = localStorage.getItem("fluencia:lastDeck"); }catch(e){}
    state.currentDeckId = ultimo && state.decks[ultimo] ? ultimo : Object.keys(state.decks)[0] || null;
    atualizarVoce();
    irPara("v-study");
    publicarJuntos(true);
  }catch(err){
    toast(err.message);
    $("login").classList.remove("hidden");
  }finally{ livre(); }
}

function sair(){
  fb.logout();
  Object.assign(state, { perfil: {}, decks: {}, dias: {}, currentDeckId: null, deckId: null, atual: null, lote: [], conversa: null, juntos: {},
    pontos: {}, erros: {}, producao: {}, exercicios: {}, aulas: {}, pontoTreino: null, desdeExercicio: 0 });
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
ligar("btn-goto-decks", "click", e => {
  if(e.currentTarget.dataset.acao === "tudo"){ state.pontoTreino = null; lembrarEntrada("tudo"); proximoCard(); return; }
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

// Meus erros, o ponto e o progresso do outro
$("erros-tabs").querySelectorAll("button").forEach(b => b.addEventListener("click", () => { state.errosAba = b.dataset.tab; renderErros(); }));
ligar("btn-treinar-erros", "click", () => { state.pontoTreino = null; lembrarEntrada("erros"); irPara("v-study"); });
ligar("ponto-back", "click", fecharCamada);
ligar("btn-treinar-ponto", "click", treinarPonto);
ligar("outro-back", "click", fecharCamada);
document.querySelectorAll("[data-voce]").forEach(b => b.addEventListener("click", () => irPara("v-you", { camada: true })));
document.querySelectorAll("[data-nvpill]").forEach(b => b.addEventListener("click", () => irParaAba("v-nivel")));
$("study-dica").textContent = matchMedia("(pointer: coarse)").matches ? "toque vira · arraste responde" : "espaço vira · 1 a 4 responde";

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
