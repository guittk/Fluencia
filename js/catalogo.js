// Catálogo fixo de pontos de gramática e uso do inglês, por nível CEFR.
// É o "índice do livro de gramática": todo erro, venha de onde vier, cai num
// ponto desta lista, para os erros se somarem e a régua ter base fixa.
// A lista segue as listas de gramática usadas nas provas CEFR (conhecimento do
// modelo). Só vale para baralhos de inglês. Id sem ponto, porque o Firebase não
// aceita "." em chave.
//
// Campos: id, n (nível), nome (em português) e tip (o erro típico de quem fala português).

export const NIVEIS_REGUA = ["A1", "A2", "B1", "B2", "C1"];

export const PONTOS = [
  // ---------- A1 ----------
  { id: "A1-to-be", n: "A1", nome: "Verbo to be: am, is, are", tip: "She are a student" },
  { id: "A1-presente-simples", n: "A1", nome: "Presente simples", tip: "I drinking coffee every day" },
  { id: "A1-terceira-pessoa", n: "A1", nome: "O -s da terceira pessoa", tip: "He work, Claude write" },
  { id: "A1-pergunta-do-does", n: "A1", nome: "Pergunta e negativa com do e does", tip: "You like coffee? / He don't like" },
  { id: "A1-presente-continuo", n: "A1", nome: "Presente contínuo", tip: "He watch TV right now" },
  { id: "A1-there-is", n: "A1", nome: "There is e there are", tip: "Have two books on the table" },
  { id: "A1-artigos", n: "A1", nome: "Artigos: a, an, the", tip: "a electronic problem, the work" },
  { id: "A1-plural", n: "A1", nome: "Plural e substantivos contáveis", tip: "two book, many person" },
  { id: "A1-pronomes", n: "A1", nome: "Pronomes e possessivos, e o I maiúsculo", tip: "i am, he car, me name" },
  { id: "A1-preposicoes", n: "A1", nome: "in, on, at e by: tempo, lugar e transporte", tip: "in the bus, in Monday" },
  { id: "A1-can", n: "A1", nome: "can e can't", tip: "I can to speak" },
  { id: "A1-ordem-adjetivo", n: "A1", nome: "Adjetivo antes do substantivo", tip: "a car red" },

  // ---------- A2 ----------
  { id: "A2-passado-simples", n: "A2", nome: "Passado simples, regular e irregular", tip: "Yesterday I go to the market" },
  { id: "A2-passado-pergunta", n: "A2", nome: "Pergunta e negativa no passado (did)", tip: "Did you went? / I didn't saw" },
  { id: "A2-was-were", n: "A2", nome: "was e were (e o born)", tip: "Where did you born?" },
  { id: "A2-comparativo", n: "A2", nome: "Comparativo e superlativo", tip: "more tall, taller → tallest trocados" },
  { id: "A2-some-any", n: "A2", nome: "some, any, much e many", tip: "I don't have some money" },
  { id: "A2-futuro", n: "A2", nome: "Futuro com will e going to", tip: "I go to travel next year" },
  { id: "A2-present-perfect", n: "A2", nome: "Present perfect: have done, yet, already, ever", tip: "We don't finished yet" },
  { id: "A2-passado-continuo", n: "A2", nome: "Passado contínuo (was doing when)", tip: "I watched TV when the phone rang" },
  { id: "A2-adverbios-frequencia", n: "A2", nome: "Advérbios de frequência e a posição deles", tip: "I go always to work" },
  { id: "A2-have-to-should", n: "A2", nome: "have to, must e should", tip: "You must to go" },
  { id: "A2-verbo-to", n: "A2", nome: "to + verbo: want to, need to, e o \"para\" de finalidade", tip: "I want search a job, for make money" },
  { id: "A2-sujeito-obrigatorio", n: "A2", nome: "Sujeito obrigatório (it, there)", tip: "Is important / Don't make sense" },
  { id: "A2-genitivo", n: "A2", nome: "O 's de posse", tip: "the car of my sister" },
  { id: "A2-conectores", n: "A2", nome: "Conectores básicos: and, but, because, so, then", tip: "Them I automate (then)" },
  { id: "A2-pronome-objeto", n: "A2", nome: "Pronome objeto: me, him, her, them", tip: "I saw she yesterday" },

  // ---------- B1 ----------
  { id: "B1-perfect-for-since", n: "B1", nome: "Present perfect com for e since, e contra o passado", tip: "I live here since 2019" },
  { id: "B1-condicional-1", n: "B1", nome: "Primeira condicional", tip: "If it will rain, we stay" },
  { id: "B1-condicional-2", n: "B1", nome: "Segunda condicional", tip: "If I would have more time" },
  { id: "B1-voz-passiva", n: "B1", nome: "Voz passiva", tip: "The report finished by the team" },
  { id: "B1-discurso-indireto", n: "B1", nome: "Pergunta indireta e discurso relatado", tip: "She asked where do I live" },
  { id: "B1-relativas", n: "B1", nome: "Orações relativas: who, which, that, whose", tip: "the man who car was stolen" },
  { id: "B1-used-to", n: "B1", nome: "used to e be used to + -ing", tip: "I'm used to wake up early" },
  { id: "B1-mustnt-dont-have", n: "B1", nome: "mustn't contra don't have to", tip: "You don't have to smoke (proibido)" },
  { id: "B1-verbo-ing-ou-to", n: "B1", nome: "Verbo seguido de -ing ou de to", tip: "She suggested to take, I enjoy to read" },
  { id: "B1-phrasal-verbs", n: "B1", nome: "Phrasal verbs do dia a dia", tip: "look for, find out, give up" },
  { id: "B1-preposicao-fixa", n: "B1", nome: "Preposição que acompanha a palavra", tip: "capable for, depend of, interested on" },
  { id: "B1-incontaveis", n: "B1", nome: "Incontáveis: work, advice, information", tip: "search a work, an advice" },
  { id: "B1-falsos-cognatos", n: "B1", nome: "Falsos cognatos e palavra trocada", tip: "exterior (abroad), velocity (speed)" },
  { id: "B1-make-do", n: "B1", nome: "make contra do", tip: "do a decision, make the homework" },
  { id: "B1-say-tell", n: "B1", nome: "say contra tell", tip: "He said me that" },
  { id: "B1-too-enough", n: "B1", nome: "too, enough, so e such", tip: "It's enough big, too much expensive" },
  { id: "B1-ed-ing", n: "B1", nome: "Adjetivo com -ed e com -ing", tip: "I'm boring (entediado)" },

  // ---------- B2 ----------
  { id: "B2-wish", n: "B2", nome: "wish, would rather e it's time", tip: "I wish I can, it's time we make" },
  { id: "B2-condicional-3", n: "B2", nome: "Terceira condicional e mista", tip: "If I had known, I would call you" },
  { id: "B2-futuro-perfeito", n: "B2", nome: "Futuro perfeito e futuro contínuo", tip: "By next year she will work here ten years" },
  { id: "B2-inversao", n: "B2", nome: "Inversão depois de advérbio negativo", tip: "Hardly he opened, Not only he was" },
  { id: "B2-modais-passado", n: "B2", nome: "Modais no passado: should have, must have", tip: "I should went earlier" },
  { id: "B2-causativo", n: "B2", nome: "Causativo: have something done", tip: "I cut my hair (no barbeiro)" },
  { id: "B2-preposicao-ing", n: "B2", nome: "Preposição + -ing: despite, after, before", tip: "Despite be tired, after to finish" },
  { id: "B2-concordancia", n: "B2", nome: "Concordância com sujeito composto ou longo", tip: "The CEO, along with the directors, are" },
  { id: "B2-colocacoes", n: "B2", nome: "Colocações e escolha de palavra", tip: "implant a policy, do a decision" },
  { id: "B2-phrasal-avancados", n: "B2", nome: "Phrasal verbs de trabalho", tip: "call off, turn down, carry out" },
  { id: "B2-contraste", n: "B2", nome: "Conectores de contraste: although, however, whereas", tip: "Although it was late, but he stayed" },
  { id: "B2-artigo-zero", n: "B2", nome: "Quando não usar artigo", tip: "go to the work, the life is hard" },

  // ---------- C1 ----------
  { id: "C1-inversao-condicional", n: "C1", nome: "Condicional invertida: Had I known, Were I to", tip: "If I had known (sem inverter, no formal)" },
  { id: "C1-correlativos", n: "C1", nome: "No sooner than, scarcely when, hardly when", tip: "Scarcely had we arrived than" },
  { id: "C1-subjuntivo", n: "C1", nome: "Subjuntivo: suggest that he be, it's essential that", tip: "I suggest that he goes" },
  { id: "C1-cleft", n: "C1", nome: "Frase de ênfase: It was X that, What I need is", tip: "Is this what I need" },
  { id: "C1-participio", n: "C1", nome: "Oração reduzida: Having finished, Given that", tip: "After finish the code, I tested" },
  { id: "C1-registro", n: "C1", nome: "Registro formal e frases de cautela (hedging)", tip: "I think that maybe is good" },
  { id: "C1-idiomas", n: "C1", nome: "Expressões idiomáticas", tip: "tradução ao pé da letra de ditado" },

  // ---------- Todos os níveis ----------
  { id: "X-estrutura-pt", n: "X", nome: "Frase montada em português", tip: "my car is with a problem, for we have more velocity" },
];

export const PONTO = Object.fromEntries(PONTOS.map(p => [p.id, p]));
export const IDS_PONTOS = PONTOS.map(p => p.id);
export const nomePonto = id => (PONTO[id] && PONTO[id].nome) || id;
export const nivelPonto = id => (PONTO[id] && PONTO[id].n) || "X";
export const pontosDoNivel = n => PONTOS.filter(p => p.n === n);

// Metas de vocabulário por nível (conhecimento do modelo, aproximadas).
export const META_VOCAB = { A1: 500, A2: 1000, B1: 2000, B2: 4000, C1: 8000 };

export const ordemNivel = n => n === "X" ? -1 : NIVEIS_REGUA.indexOf(n);

// A lista no formato que vai para a IA escolher o ponto de um erro.
export function catalogoParaIA(){
  return PONTOS.map(p => `${p.id} — ${p.nome} (ex.: ${p.tip})`).join("\n");
}

// Semente: o teste de nivelamento da ES-16, feito pelo Guilherme em 01/11/2026.
// Cada questão aponta o ponto que ela mede; acertou conta como medição, errou
// conta como erro, com a frase dele e a certa.
export const SEMENTE_ES16 = {
  data: "2026-11-01",
  nivel: "A2",
  questoes: [
    { q: 1, p: "A1-to-be", ok: true }, { q: 2, p: "A1-to-be", ok: true },
    { q: 3, p: "A1-presente-simples", ok: true }, { q: 4, p: "A1-there-is", ok: true },
    { q: 5, p: "A1-pergunta-do-does", ok: true }, { q: 6, p: "A1-presente-continuo", ok: true },
    { q: 7, p: "A2-passado-simples", ok: true },
    { q: 8, p: "A2-comparativo", ok: false, o: "My sister is tallest than me.", c: "My sister is taller than me.", e: "Com than, a forma é a do comparativo (-er). O -est é do superlativo: the tallest." },
    { q: 9, p: "A2-some-any", ok: false, o: "I don't have some money.", c: "I don't have any money.", e: "Em frase negativa e em pergunta, o inglês usa any, não some." },
    { q: 10, p: "A2-was-were", ok: false, o: "Where did you born?", c: "Where were you born?", e: "Nascer é be born: o verbo é o be no passado (were), e não o did. Em português \"você nasceu\" parece ação, por isso o did escapa." },
    { q: 11, p: "B1-perfect-for-since", ok: true }, { q: 12, p: "B1-condicional-1", ok: true },
    { q: 13, p: "B1-discurso-indireto", ok: false, o: "She asked me where I am living.", c: "She asked me where I lived.", e: "No discurso relatado, o verbo recua um tempo: ela perguntou (passado) onde eu morava (lived)." },
    { q: 14, p: "B1-mustnt-dont-have", ok: true }, { q: 15, p: "B1-voz-passiva", ok: true },
    { q: 16, p: "B1-used-to", ok: false, o: "I'm used to wake up early.", c: "I'm used to waking up early.", e: "Be used to quer dizer estar acostumado, e o to aqui é preposição: vem verbo com -ing. Used to wake up (sem be) é \"eu costumava\"." },
    { q: 17, p: "B1-relativas", ok: false, o: "He's the man who car was stolen.", c: "He's the man whose car was stolen.", e: "Para posse (o carro dele), o relativo é whose, o \"cujo\" do português." },
    { q: 18, p: "A2-passado-continuo", ok: true },
    { q: 19, p: "A2-present-perfect", ok: false, o: "We don't finished the project yet.", c: "We haven't finished the project yet.", e: "Com yet e o particípio (finished), o auxiliar é have: haven't finished. O don't só vai com o verbo na forma base." },
    { q: 20, p: "B2-wish", ok: false, o: "I'd rather you not tell anyone.", c: "I'd rather you didn't tell anyone.", e: "Depois de I'd rather you, o inglês usa o passado (didn't), mesmo falando do presente. É o mesmo truque da segunda condicional." },
    { q: 21, p: "B1-condicional-2", ok: false, o: "If I would have more time, I would learn Japanese.", c: "If I had more time, I would learn Japanese.", e: "Na hipótese, o lado do if leva o passado simples (had). O would fica só do outro lado. O português usa o subjuntivo (se eu tivesse), e por isso o would escapa." },
    { q: 22, p: "B2-futuro-perfeito", ok: true },
    { q: 23, p: "B2-inversao", ok: false, o: "Hardly he opened the door when the alarm went off.", c: "Hardly had he opened the door when the alarm went off.", e: "Frase que começa com hardly inverte sujeito e auxiliar, como numa pergunta: had he opened." },
    { q: 24, p: "B2-wish", ok: false, o: "I wish I will speak French.", c: "I wish I could speak French.", e: "Desejo sobre o presente usa o passado depois de wish: could, não can nem will." },
    { q: 25, p: "B1-verbo-ing-ou-to", ok: false, o: "She suggested to take a taxi.", c: "She suggested taking a taxi.", e: "Suggest é seguido de verbo com -ing (ou de that + frase), nunca de to." },
    { q: 26, p: "B2-phrasal-avancados", ok: true }, { q: 27, p: "B2-colocacoes", ok: true },
    { q: 28, p: "B2-preposicao-ing", ok: true },
    { q: 29, p: "B1-preposicao-fixa", ok: false, o: "She is capable for solving complex problems.", c: "She is capable of solving complex problems.", e: "A preposição é fixa da palavra: capable of. Não dá para deduzir pelo português (capaz de)." },
    { q: 30, p: "B2-wish", ok: false, o: "It's high time we have made a decision.", c: "It's high time we made a decision.", e: "Depois de it's (high) time, o verbo vai no passado simples (made), falando do agora." },
    { q: 31, p: "C1-inversao-condicional", ok: true },
    { q: 32, p: "B2-inversao", ok: false, o: "Not only he is late, but he also forgot the documents.", c: "Not only was he late, but he also forgot the documents.", e: "Not only no começo inverte: was he. E o tempo segue o resto da frase, no passado." },
    { q: 33, p: "B2-phrasal-avancados", ok: true },
    { q: 34, p: "B2-concordancia", ok: false, o: "The CEO, along with the directors, were expected tomorrow.", c: "The CEO, along with the directors, is expected tomorrow.", e: "O sujeito é só The CEO; o along with... é um aposto. O verbo concorda com o sujeito: is." },
    { q: 35, p: "B2-condicional-3", ok: false, o: "I'd have called you if I would have your number.", c: "I'd have called you if I had had your number.", e: "Hipótese sobre o passado: if + had + particípio (had had). O would fica só do outro lado." },
    { q: 36, p: "C1-correlativos", ok: true },
  ],
  redacoes: [
    { p: "A1-pronomes", o: "Now i am working in the Virtual Reality Trainings.", c: "Now I am working on the Virtual Reality trainings.", e: "O pronome I é sempre maiúsculo, em qualquer lugar da frase." },
    { p: "A1-preposicoes", o: "I am going to the work in the bus.", c: "I go to work by bus.", e: "Meio de transporte usa by (by bus, by car). E go to work vai sem the." },
    { p: "X-estrutura-pt", o: "My car is with a electronic problem.", c: "My car has an electrical problem.", e: "É o \"estar com\" do português. Em inglês, o carro tem o problema: has a problem." },
    { p: "A1-artigos", o: "a electronic problem", c: "an electrical problem", e: "Antes de som de vogal, o artigo é an." },
    { p: "A2-sujeito-obrigatorio", o: "Because don't make more sense write code.", c: "Because it doesn't make sense to write code anymore.", e: "O inglês não aceita frase sem sujeito: entra o it. E depois de make sense vem to + verbo." },
    { p: "A1-terceira-pessoa", o: "when the Claude Code write all i need", c: "when Claude Code writes everything I need", e: "Com sujeito na terceira pessoa (Claude Code = it), o verbo leva -s: writes." },
    { p: "A2-conectores", o: "Them i automate some systems.", c: "Then I automate some systems.", e: "Then é \"então\"; them é \"eles\" (objeto)." },
    { p: "X-estrutura-pt", o: "for we have more velocity in development", c: "so that we can develop faster", e: "É o \"pra gente ter\" do português. Em inglês, a finalidade vem com so that we can, ou com to + verbo." },
    { p: "B1-falsos-cognatos", o: "more velocity in development", c: "more speed in development", e: "Velocity é termo de física e de Scrum. No dia a dia, rapidez é speed." },
    { p: "A2-verbo-to", o: "I want search a work for make more money.", c: "I want to look for a job to make more money.", e: "Want pede to + verbo. E o \"para\" de finalidade é to, não for." },
    { p: "B1-incontaveis", o: "search a work", c: "look for a job", e: "Work, no sentido de trabalho, é incontável: não leva a. O emprego contável é a job." },
    { p: "B1-falsos-cognatos", o: "a work in the exterior", c: "a job abroad", e: "Exterior em inglês é a parte de fora de algo. Morar ou trabalhar fora do país é abroad." },
  ],
};
