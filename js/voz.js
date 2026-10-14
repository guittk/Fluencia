// Voz do navegador: fala (speechSynthesis), reconhecimento (SpeechRecognition)
// e gravação da própria voz (MediaRecorder). Tudo grátis e local ao navegador;
// nada disso passa pela IA. Falar é sempre opcional no app.

const LANG_TAG = { en: "en-US", es: "es-ES", fr: "fr-FR", de: "de-DE", it: "it-IT", ja: "ja-JP", zh: "zh-CN", ko: "ko-KR", ru: "ru-RU", nl: "nl-NL" };
export const langTag = code => LANG_TAG[code] || "en-US";

export const temFala = "speechSynthesis" in window;
const Reconhecedor = window.SpeechRecognition || window.webkitSpeechRecognition;
export const temReconhecimento = !!Reconhecedor;
export const temGravacao = !!(navigator.mediaDevices && window.MediaRecorder);

let vozes = [];
function carregarVozes(){ vozes = temFala ? speechSynthesis.getVoices() : []; }
if(temFala){
  carregarVozes();
  speechSynthesis.addEventListener?.("voiceschanged", carregarVozes);
}

export function vozesDoIdioma(code){
  const tag = langTag(code).slice(0, 2);
  return vozes.filter(v => v.lang && v.lang.toLowerCase().startsWith(tag));
}

// Preferência: a voz escolhida; senão uma "natural"/Google do idioma; senão a primeira.
function escolherVoz(code, nomePreferido){
  const lista = vozesDoIdioma(code);
  if(!lista.length) return null;
  const tagCheia = langTag(code).toLowerCase();
  return lista.find(v => v.name === nomePreferido)
    || lista.find(v => /natural|neural|online/i.test(v.name) && v.lang.toLowerCase() === tagCheia)
    || lista.find(v => /google/i.test(v.name) && v.lang.toLowerCase() === tagCheia)
    || lista.find(v => v.lang.toLowerCase() === tagCheia)
    || lista[0];
}

export function falar(texto, { idioma = "en", voz = "", velocidade = 1 } = {}){
  return new Promise(resolve => {
    if(!temFala || !texto){ resolve(); return; }
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(texto);
    u.lang = langTag(idioma);
    const v = escolherVoz(idioma, voz);
    if(v) u.voice = v;
    u.rate = velocidade;
    u.onend = u.onerror = () => resolve();
    speechSynthesis.speak(u);
  });
}

export function pararFala(){ if(temFala) speechSynthesis.cancel(); }

// Ouve uma fala e devolve o texto. onParcial recebe o texto enquanto a pessoa fala.
let ativo = null;
export function ouvir({ idioma = "en", onParcial } = {}){
  return new Promise((resolve, reject) => {
    if(!temReconhecimento){ reject(new Error("Este navegador não reconhece fala. Use o Chrome ou o Edge.")); return; }
    pararOuvir();
    const rec = new Reconhecedor();
    ativo = rec;
    rec.lang = langTag(idioma);
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    rec.continuous = false;
    let final = "";
    rec.onresult = ev => {
      let parcial = "";
      for(let i = ev.resultIndex; i < ev.results.length; i++){
        const t = ev.results[i][0].transcript;
        if(ev.results[i].isFinal) final += t; else parcial += t;
      }
      onParcial && onParcial((final + " " + parcial).trim());
    };
    rec.onerror = ev => {
      ativo = null;
      if(ev.error === "no-speech") resolve("");
      else if(ev.error === "not-allowed") reject(new Error("O navegador bloqueou o microfone."));
      else if(ev.error === "aborted") resolve(final.trim());
      else reject(new Error("Não consegui ouvir: " + ev.error));
    };
    rec.onend = () => { ativo = null; resolve(final.trim()); };
    rec.start();
  });
}
export function pararOuvir(){ if(ativo){ try{ ativo.stop(); }catch(e){} } }

// Grava a própria voz até pararGravacao() ou o limite, e devolve uma URL de áudio.
let gravador = null;
export async function gravar(limiteMs = 10000){
  if(!temGravacao) throw new Error("Este navegador não grava áudio.");
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  return new Promise(resolve => {
    const partes = [];
    gravador = new MediaRecorder(stream);
    gravador.ondataavailable = e => e.data.size && partes.push(e.data);
    gravador.onstop = () => {
      stream.getTracks().forEach(t => t.stop());
      gravador = null;
      resolve(URL.createObjectURL(new Blob(partes, { type: partes[0]?.type || "audio/webm" })));
    };
    gravador.start();
    setTimeout(() => gravador && gravador.state === "recording" && gravador.stop(), limiteMs);
  });
}
export function pararGravacao(){ if(gravador && gravador.state === "recording") gravador.stop(); }

// ---------- comparação local da fala com a frase esperada ----------
const normalizar = s => (s || "").toLowerCase()
  .normalize("NFD").replace(/[̀-ͯ]/g, "")
  .replace(/[’']/g, "'").replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim();

// Distância de edição por palavras; devolve a similaridade (0 a 1) e o
// alinhamento palavra a palavra da frase esperada (ok / faltou / trocou).
export function comparar(esperado, dito){
  const a = normalizar(esperado).split(" ").filter(Boolean);
  const b = normalizar(dito).split(" ").filter(Boolean);
  const d = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for(let i = 0; i <= a.length; i++) d[i][0] = i;
  for(let j = 0; j <= b.length; j++) d[0][j] = j;
  for(let i = 1; i <= a.length; i++){
    for(let j = 1; j <= b.length; j++){
      d[i][j] = Math.min(d[i-1][j] + 1, d[i][j-1] + 1, d[i-1][j-1] + (a[i-1] === b[j-1] ? 0 : 1));
    }
  }
  // Volta pelo caminho para marcar cada palavra esperada.
  const marcas = [];
  let i = a.length, j = b.length;
  while(i > 0){
    if(j > 0 && d[i][j] === d[i-1][j-1] + (a[i-1] === b[j-1] ? 0 : 1)){
      marcas.unshift({ palavra: a[i-1], estado: a[i-1] === b[j-1] ? "ok" : "trocou" });
      i--; j--;
    }else if(d[i][j] === d[i-1][j] + 1){
      marcas.unshift({ palavra: a[i-1], estado: "faltou" });
      i--;
    }else{
      j--;
    }
  }
  const sim = a.length || b.length ? 1 - d[a.length][b.length] / Math.max(a.length, b.length) : 1;
  return { sim, marcas };
}

export function notaPorSimilaridade(sim){
  if(sim >= 0.98) return "facil";
  if(sim >= 0.85) return "acertei";
  if(sim >= 0.6) return "quase";
  return "errei";
}
