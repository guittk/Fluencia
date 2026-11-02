// Mapa de erros, treino de pontos e régua de nível. Puro, sem DOM e sem rede.
//
// Cada ponto do catálogo tem um registro por pessoa, em /Pontos/{id}:
//   m      domínio, média móvel das notas do treino (0 a 1)
//   n      exercícios feitos
//   ok     acertos
//   last   último treino (ms)
//   dias   { AAAA-MM-DD: 1 } dias com acerto desde o último erro
//   erros  quantos erros caíram no ponto, de qualquer tela
//   ult    último erro (ms)
//
// Estados: presumido (nível até o de partida, sem nada medido), nao-medido,
// treinando, quase (domínio bom, mas ainda não em dias diferentes) e dominado.

import { PONTOS, PONTO, NIVEIS_REGUA, META_VOCAB, ordemNivel, pontosDoNivel } from "./catalogo.js";
import { NOTAS, hojeLocal } from "./selecao.js";

const DIA = 864e5;
export const DIAS_DOMINIO = 3;     // dias diferentes com acerto
export const SEM_ERRO_DIAS = 7;    // sem errar o ponto nesse tempo
export const LIMIAR = 0.7;         // domínio e % de nível que contam como "seu"
export const MIN_FRASES_USO = 10;  // abaixo disso, o uso fica "sem medida"
export const CARDS_POR_EXERCICIO = 3;

export const NOME_ESTADO = { treinando: "Treinando", quase: "Quase lá", dominado: "Dominado", presumido: "Sabido", "nao-medido": "Não medido" };

const vazio = () => ({ m: 0, n: 0, ok: 0, last: 0, dias: {}, erros: 0, ult: 0 });

export function estadoPonto(reg, id, base){
  const p = PONTO[id];
  const medido = reg && (reg.n > 0 || reg.erros > 0);
  if(!medido){
    if(p && p.n !== "X" && base && ordemNivel(p.n) <= ordemNivel(base)) return "presumido";
    return "nao-medido";
  }
  const diasOk = Object.keys(reg.dias || {}).length;
  const errouRecente = reg.ult && Date.now() - reg.ult < SEM_ERRO_DIAS * DIA;
  if(reg.m >= LIMIAR && diasOk >= DIAS_DOMINIO && !errouRecente) return "dominado";
  if(reg.m >= LIMIAR) return "quase";
  return "treinando";
}

// Quanto o ponto vale na régua, de 0 a 1.
export function valorPonto(reg, id, base){
  const e = estadoPonto(reg, id, base);
  if(e === "presumido") return 0.85;
  if(e === "nao-medido") return 0;
  if(e === "dominado") return 1;
  return Math.max(0, Math.min(1, reg.m));
}

// Um erro novo no ponto: o domínio cai à metade e os dias de acerto zeram.
// Num ponto presumido (nível até o de partida, nunca medido), o erro parte do
// valor presumido: um deslize no básico não vale o mesmo que não saber.
export function registrarErroPonto(reg, { presumido = false } = {}){
  const s = Object.assign(vazio(), reg);
  if(presumido && !(s.n > 0 || s.erros > 0)) s.m = 0.85;
  s.m = s.m * 0.5;
  s.erros = (s.erros || 0) + 1;
  s.ult = Date.now();
  s.dias = {};
  return s;
}

// Resultado de um exercício do ponto.
export function registrarTreino(reg, notaKey){
  const s = Object.assign(vazio(), reg);
  s.dias = Object.assign({}, s.dias);
  const q = NOTAS[notaKey];
  const alfa = s.n < 3 ? 0.5 : 0.35;
  s.m = Math.max(0, Math.min(1, s.m + alfa * (q - s.m)));
  s.n += 1;
  s.last = Date.now();
  if(q >= 0.8){ s.ok = (s.ok || 0) + 1; s.dias[hojeLocal()] = 1; }
  if(q === 0){ s.erros = (s.erros || 0) + 1; s.ult = Date.now(); s.dias = {}; }
  return s;
}

// Uma questão acertada num teste mede o ponto sem treino.
export function registrarAcerto(reg, data = hojeLocal()){
  const s = Object.assign(vazio(), reg);
  s.dias = Object.assign({}, s.dias, { [data]: 1 });
  s.m = Math.max(s.m, 0.8);
  s.n += 1;
  s.ok = (s.ok || 0) + 1;
  s.last = Date.now();
  return s;
}

// ---------- Sorteio do próximo exercício ----------
const recentesPontos = [];

export function sortearPonto(regs, base, { soErros = false, so = null } = {}){
  if(so) return so;
  const agora = Date.now();
  const proximo = base ? NIVEIS_REGUA[ordemNivel(base) + 1] : "A2";
  const depois = base ? NIVEIS_REGUA[ordemNivel(base) + 2] : "B1";
  const cand = [];
  for(const p of PONTOS){
    const reg = regs[p.id];
    const e = estadoPonto(reg, p.id, base);
    let w = 0;
    if(e === "treinando") w = 3 + 2 * (1 - reg.m);
    else if(e === "quase") w = 1.2 + Math.min(2, (agora - (reg.last || 0)) / DIA);
    else if(soErros) w = 0;
    else if(e === "nao-medido") w = p.n === proximo || p.n === "X" ? 1 : p.n === depois ? 0.35 : 0;
    else if(e === "dominado") w = agora - (reg.last || 0) > 5 * DIA ? 0.3 : 0;
    if(w > 0 && !recentesPontos.slice(-2).includes(p.id)) cand.push({ id: p.id, w });
  }
  if(!cand.length) return null;
  const total = cand.reduce((a, c) => a + c.w, 0);
  let r = Math.random() * total, esc = cand[cand.length - 1];
  for(const c of cand){ r -= c.w; if(r < 0){ esc = c; break; } }
  recentesPontos.push(esc.id);
  if(recentesPontos.length > 10) recentesPontos.shift();
  return esc.id;
}

// ---------- Régua ----------
// producao: lista de { d: "AAAA-MM-DD", p: { pontoId: 1 } } das frases dele.
// A "frase montada em português" (X) conta como erro a partir do B1: no A1 e
// no A2, se fazer entender já basta.
export function regua({ regs = {}, base = null, aprendidos = 0, producao = [] }){
  const limite = hojeLocal(new Date(Date.now() - 30 * DIA));
  const frases = producao.filter(f => f && f.d >= limite);
  const vocabBase = base ? META_VOCAB[base] : 0;
  const niveis = NIVEIS_REGUA.map(n => {
    const lista = pontosDoNivel(n);
    const valores = lista.map(p => valorPonto(regs[p.id], p.id, base));
    const gram = valores.reduce((a, v) => a + v, 0) / lista.length;
    const vocab = Math.min(1, (vocabBase + aprendidos) / META_VOCAB[n]);
    let uso = null;
    if(frases.length >= MIN_FRASES_USO){
      const ok = frases.filter(f => !Object.keys(f.p || {}).some(id => {
        const pn = PONTO[id] ? PONTO[id].n : null;
        if(pn === "X") return ordemNivel(n) >= ordemNivel("B1");
        return pn && ordemNivel(pn) <= ordemNivel(n);
      })).length;
      uso = ok / frases.length;
    }
    const pct = uso === null ? (gram * 0.5 + vocab * 0.25) / 0.75 : gram * 0.5 + vocab * 0.25 + uso * 0.25;
    const estados = lista.map(p => estadoPonto(regs[p.id], p.id, base));
    return {
      n, pct, gram, vocab, uso, total: lista.length,
      dominados: estados.filter(e => e === "dominado" || e === "presumido").length,
      treinando: estados.filter(e => e === "treinando" || e === "quase").length,
      naoMedidos: estados.filter(e => e === "nao-medido").length,
      metaVocab: META_VOCAB[n],
    };
  });
  let atual = null;
  for(const nv of niveis){ if(nv.pct >= LIMIAR) atual = nv.n; else break; }
  const prox = niveis[atual ? NIVEIS_REGUA.indexOf(atual) + 1 : 0] || null;
  return { niveis, atual, prox: prox ? prox.n : null, pctProx: prox ? prox.pct : 1, frases: frases.length };
}

// O que falta pra um nível contar como seu, em coisas que dá pra fazer.
// Caminho de referência: cada parte em 70% fecha o nível (uma parte acima
// compensa outra abaixo, mas este é o caminho que dá pra contar).
//   gram: quantos pontos dominar, dos que mais sobem a régua primeiro
//   vocab: quantas palavras (cards aprendidos) faltam até 70% da meta
//   uso: quantas frases faltam pro mínimo, e se a parte limpa está abaixo de 70%
export function faltaNivel(nv, { regs = {}, base = null, aprendidos = 0, frases = 0 }){
  const lista = pontosDoNivel(nv.n);
  const valores = lista.map(p => ({ id: p.id, v: valorPonto(regs[p.id], p.id, base), e: estadoPonto(regs[p.id], p.id, base) }));
  let soma = valores.reduce((a, x) => a + x.v, 0);
  const alvoSoma = LIMIAR * lista.length;
  const aDominar = [];
  for(const x of valores.filter(x => x.e !== "dominado").sort((a, b) => a.v - b.v)){
    if(soma >= alvoSoma - 1e-9) break;
    soma += 1 - x.v;
    aDominar.push(x.id);
  }
  const vocabBase = base ? META_VOCAB[base] : 0;
  const palavras = Math.min(nv.metaVocab, vocabBase + aprendidos);
  const faltaPalavras = Math.max(0, Math.ceil(LIMIAR * nv.metaVocab - (vocabBase + aprendidos)));
  const faltaFrases = Math.max(0, MIN_FRASES_USO - frases);
  return {
    pct: nv.pct, faltaPct: Math.max(0, LIMIAR - nv.pct),
    gram: { pct: nv.gram, pontos: aDominar.length, ids: aDominar, dominados: nv.dominados, total: nv.total, ok: nv.gram >= LIMIAR },
    vocab: { pct: nv.vocab, palavras, meta: nv.metaVocab, falta: faltaPalavras, ok: nv.vocab >= LIMIAR },
    uso: { pct: nv.uso, frases, faltaFrases, ok: nv.uso !== null && nv.uso >= LIMIAR },
  };
}

// Pontos com erro, do que mais pesa ao que menos pesa.
export function pontosComErro(regs, base){
  return Object.entries(regs)
    .filter(([id, r]) => PONTO[id] && r && r.erros > 0)
    .map(([id, r]) => ({ id, reg: r, estado: estadoPonto(r, id, base) }))
    .sort((a, b) => {
      const ordem = { treinando: 0, quase: 1, dominado: 2 };
      return (ordem[a.estado] - ordem[b.estado]) || (b.reg.erros - a.reg.erros) || ((b.reg.ult || 0) - (a.reg.ult || 0));
    });
}
