// Escolha do próximo card e cálculo de domínio.
//
// O estudo é infinito, por decisão dele: não existe data de revisão nem fim de
// sessão. O que existe é um sorteio ponderado, em que cada par (card, modo)
// ganha um peso. O peso sobe quando:
//   - o domínio do card naquele modo é baixo (1 - m);
//   - já faz tempo desde a última vez, relativo ao quanto ele sabe (esquecimento);
// e o sorteio evita repetir o que acabou de sair (resfriamento).
//
// m é uma média móvel das notas, de 0 a 1: Errei 0 · Quase 0,4 · Acertei 0,8 · Fácil 1.

export const MODOS = {
  rec:  { nome: "Reconhecer", desc: "Frase em inglês → você entende" },
  prod: { nome: "Produzir",   desc: "Frase em português → você diz em inglês" },
  ouv:  { nome: "Ouvir",      desc: "Só o áudio → você entende" },
  comp: { nome: "Completar",  desc: "Frase com lacuna → você completa" },
};

export const NOTAS = { errei: 0, quase: 0.4, acertei: 0.8, facil: 1 };

const PESO_NOVO = 1.2;          // card nunca visto
const PESO_NOVO_FREADO = 0.15;  // quando já há muitos em aprendizado
const LIMITE_APRENDENDO = 8;    // cards com domínio < 0,5 ao mesmo tempo
const RESFRIAMENTO = 6;         // quantos sorteios recentes ficam de fora

const recentes = []; // chaves "deckId|cardKey" dos últimos sorteios

export function estadoModo(card, modo){
  return (card.Modes && card.Modes[modo]) || { m: 0, n: 0, last: 0, ok: 0 };
}

// Domínio geral do card: média dos modos já vistos.
export function dominio(card){
  const vistos = Object.values(card.Modes || {}).filter(s => s.n > 0);
  if(!vistos.length) return null;
  return vistos.reduce((a, s) => a + s.m, 0) / vistos.length;
}

// Quantas horas a memória "aguenta" um card com domínio m e ok acertos.
function forcaHoras(s){
  return 0.5 * Math.exp(4.5 * s.m) * (1 + 0.15 * Math.min(s.ok || 0, 20));
}

function modoAplicavel(card, modo, ctx){
  // Completar só faz sentido quando a lacuna é curta e não engole a frase.
  if(modo === "comp") return card.Word.trim().split(/\s+/).length <= 3 && lacuna(card.Phrase, card.Word) !== null;
  if(modo === "ouv") return ctx.temAudio;
  return true;
}

// Monta a frase com lacuna; null se a palavra não aparece na frase.
export function lacuna(frase, palavra){
  if(!frase || !palavra) return null;
  const esc = palavra.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`\\b${esc}\\w*`, "i");
  if(!re.test(frase)) return null;
  return frase.replace(re, m => "_".repeat(Math.max(4, m.length)));
}

export function sortear(deckId, cards, modosAtivos, ctx = { temAudio: true }){
  const agora = Date.now();
  const lista = Object.entries(cards).filter(([, c]) => !c.Suspended);
  if(!lista.length) return null;

  const aprendendo = lista.filter(([, c]) => {
    const s = estadoModo(c, "rec");
    return s.n > 0 && s.m < 0.5;
  }).length;

  const cooldown = Math.min(RESFRIAMENTO, Math.floor(lista.length / 2));
  const bloqueados = new Set(recentes.slice(-cooldown));

  const pares = [];
  for(const [key, card] of lista){
    const id = `${deckId}|${key}`;
    if(bloqueados.has(id)) continue;
    const rec = estadoModo(card, "rec");
    for(const modo of modosAtivos){
      if(!modoAplicavel(card, modo, ctx)) continue;
      const s = estadoModo(card, modo);
      let w;
      if(s.n === 0){
        // Card novo entra sempre por Reconhecer; os outros modos abrem depois.
        if(modo !== "rec" && rec.n === 0) continue;
        if(modo === "rec") w = aprendendo >= LIMITE_APRENDENDO ? PESO_NOVO_FREADO : PESO_NOVO;
        else w = 0.8;
      }else{
        const horas = (agora - (s.last || 0)) / 3.6e6;
        const esquecimento = 1 - Math.exp(-horas / forcaHoras(s));
        w = 0.2 + 2.5 * (1 - s.m) + 3 * esquecimento;
      }
      pares.push({ key, modo, w });
    }
  }
  if(!pares.length){
    // Tudo em resfriamento (baralho pequeno): libera e tenta de novo.
    recentes.length = 0;
    return lista.length ? { key: lista[0][0], modo: "rec" } : null;
  }

  const total = pares.reduce((a, p) => a + p.w, 0);
  let r = Math.random() * total;
  let escolhido = pares[pares.length - 1];
  for(const p of pares){
    r -= p.w;
    if(r < 0){ escolhido = p; break; }
  }
  recentes.push(`${deckId}|${escolhido.key}`);
  if(recentes.length > 50) recentes.splice(0, recentes.length - 50);
  return { key: escolhido.key, modo: escolhido.modo };
}

// Aplica a nota ao card. Devolve o domínio de antes, para a retenção real.
export function registrarResposta(card, modo, notaKey){
  const q = NOTAS[notaKey];
  card.Modes = card.Modes || {};
  const s = Object.assign({ m: 0, n: 0, last: 0, ok: 0 }, card.Modes[modo]);
  const antes = s.m;
  const alfa = s.n < 3 ? 0.5 : 0.3;
  s.m = Math.max(0, Math.min(1, s.m + alfa * (q - s.m)));
  s.n += 1;
  s.last = Date.now();
  if(q >= 0.8) s.ok = (s.ok || 0) + 1;
  else if(q === 0) s.ok = Math.floor((s.ok || 0) / 2);
  card.Modes[modo] = s;

  // Evolução da frase: 5 "Fácil" seguidos, em qualquer modo.
  card.EasyStreak = notaKey === "facil" ? (card.EasyStreak || 0) + 1 : 0;

  const d = dominio(card);
  if(!card.LearnedAt && d !== null && d >= 0.7) card.LearnedAt = new Date().toISOString();
  return { antes, maduro: s.n > 1 && antes >= 0.7 };
}

// Data local (não UTC) no formato AAAA-MM-DD.
export function hojeLocal(d = new Date()){
  const p = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// Sequência de dias seguidos estudando, terminando hoje ou ontem.
export function sequencia(dias){
  let n = 0;
  const cursor = new Date();
  if(!(dias[hojeLocal(cursor)] && dias[hojeLocal(cursor)].r)) cursor.setDate(cursor.getDate() - 1);
  while(dias[hojeLocal(cursor)] && dias[hojeLocal(cursor)].r){
    n++;
    cursor.setDate(cursor.getDate() - 1);
  }
  return n;
}
