// Pedidos ao Claude: cada função devolve { system, messages, schema, effort }.
// Puro, sem DOM e sem rede, para poder ser testado fora do navegador.
// A resposta sempre volta em JSON no formato do `schema` (structured outputs).

export const IDIOMAS = [
  { code: "en", label: "Inglês" },
  { code: "es", label: "Espanhol" },
  { code: "fr", label: "Francês" },
  { code: "de", label: "Alemão" },
  { code: "it", label: "Italiano" },
  { code: "ja", label: "Japonês" },
  { code: "zh", label: "Mandarim" },
  { code: "ko", label: "Coreano" },
  { code: "ru", label: "Russo" },
  { code: "nl", label: "Holandês" },
];
export const NIVEIS = ["A1", "A2", "B1", "B2", "C1", "C2"];
export const MAX_CARD_LEVEL = 3;

export function idiomaLabel(code){
  const l = IDIOMAS.find(l => l.code === code);
  return l ? l.label : (code || "—");
}

export const MODELO = "claude-opus-5-5";

// Executa um pedido com o cliente do SDK (@anthropic-ai/sdk) e devolve o JSON.
// O fallback do lado do servidor reroteia se o modelo recusar por segurança.
export async function executar(client, pedido){
  const msg = await client.beta.messages.create({
    model: MODELO,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: pedido.effort, format: { type: "json_schema", schema: pedido.schema } },
    system: pedido.system,
    messages: pedido.messages,
  });
  if(msg.stop_reason === "refusal") throw new Error("A IA recusou esse pedido. Tente reformular.");
  if(msg.stop_reason === "max_tokens") throw new Error("A resposta da IA ficou longa demais. Tente de novo com menos itens.");
  const texto = msg.content.filter(b => b.type === "text").map(b => b.text).join("");
  try{
    return JSON.parse(texto);
  }catch(e){
    throw new Error("A IA devolveu uma resposta fora do formato. Tente de novo.");
  }
}

// ---------- helpers de schema ----------
const str = { type: "string" };
const num = { type: "number" };
function obj(props){
  return { type: "object", properties: props, required: Object.keys(props), additionalProperties: false };
}
const arr = items => ({ type: "array", items });

const CARD = obj({
  Word: str,
  Kind: { type: "string", enum: ["palavra", "expressao", "frase"] },
  Phrase: str,
  Translation: str,
});
const CARDS = obj({ Cards: arr(CARD) });
const FRASE = obj({ Phrase: str, Translation: str });

// ---------- contexto do baralho ----------
function perfil(deck){
  const linhas = [
    `Idioma estudado: ${idiomaLabel(deck.Language)}.`,
    `Objetivo do aluno: ${deck.Objetivo || "uso geral do idioma"}.`,
  ];
  if(deck.Contexto) linhas.push(`Contexto do aluno: ${deck.Contexto}.`);
  linhas.push(`Nível atual estimado (CEFR): ${deck.Nivel || "B1"}.`);
  return linhas.join("\n");
}

const SYSTEM_BASE =
  "Você prepara material de estudo de idiomas para falantes de português do Brasil. " +
  "Todo o conteúdo serve ao objetivo declarado do aluno: escolha vocabulário e situações que ele vai realmente usar. " +
  "Explicações e traduções são em português do Brasil; o conteúdo de estudo é no idioma estudado, natural, como um falante nativo diria.";

export function regraNivel(level){
  if(level <= 1){
    return "NÍVEL 1: a frase tem no máximo 6 palavras, contando o alvo. Vocabulário básico em volta do alvo, gramática simples, " +
      "sem orações subordinadas. O foco é 100% no alvo.";
  }
  if(level >= MAX_CARD_LEVEL){
    return `NÍVEL ${MAX_CARD_LEVEL}: frase natural de falante nativo, no máximo 14 palavras, pode ter uma oração a mais e vocabulário mais rico, ` +
      "numa situação real ligada ao objetivo do aluno.";
  }
  return "NÍVEL 2: frase com no máximo 9 palavras, um pouco mais elaborada, com um complemento simples e vocabulário comum.";
}

const REGRA_CARD =
  "Cada card tem: Word (o alvo — uma palavra, uma expressão de 2 a 5 palavras, ou uma frase pronta curta), " +
  "Kind ('palavra', 'expressao' ou 'frase'), Phrase (uma frase de exemplo no idioma estudado que contém o alvo exatamente como escrito em Word) " +
  "e Translation (a tradução natural da frase para o português do Brasil). " +
  "Cada card traz um alvo NOVO: nunca repita um alvo da lista de existentes nem repita alvos entre si.";

// ---------- pedidos ----------

export function pedidoTrilha(deck){
  return {
    effort: "low",
    schema: obj({ Unidades: arr(obj({ Titulo: str, Descricao: str })) }),
    system: SYSTEM_BASE,
    messages: [{ role: "user", content:
      `${perfil(deck)}\n\nMonte uma trilha de 8 a 10 unidades de estudo, em ordem, que leve esse aluno até o objetivo. ` +
      "Cada unidade é uma situação concreta de uso (ex.: apresentar-se, falar de um projeto, entrevista técnica). " +
      "Titulo curto em português (até 5 palavras); Descricao com uma frase dizendo o que o aluno consegue fazer ao terminar." }],
  };
}

export function pedidoNovosCards(deck, { unidade, existentes = [], n = 10, alvos = null }){
  const lista = existentes.length ? existentes.join("\n") : "(nenhum)";
  let tarefa;
  if(alvos && alvos.length){
    tarefa = `Crie um card para cada um destes alvos, na ordem, mantendo o alvo como foi escrito (corrija só a grafia se estiver errada):\n${alvos.join("\n")}`;
  }else{
    tarefa = `Crie ${n} cards novos` + (unidade ? ` para a unidade "${unidade.Titulo}" (${unidade.Descricao})` : "") +
      ". Misture: cerca de metade palavras, o resto expressões e frases prontas que o aluno vai dizer nessa situação. " +
      "Prefira o que é mais útil e frequente nessa situação, adequado ao nível do aluno.";
  }
  return {
    effort: "low",
    schema: CARDS,
    system: SYSTEM_BASE,
    messages: [{ role: "user", content:
      `${perfil(deck)}\n\n${tarefa}\n\n${REGRA_CARD}\nRegra da frase: ${regraNivel(1)}\n\nAlvos existentes no baralho:\n${lista}` }],
  };
}

export function pedidoExtrairTexto(deck, texto, existentes = []){
  return {
    effort: "low",
    schema: CARDS,
    system: SYSTEM_BASE,
    messages: [{ role: "user", content:
      `${perfil(deck)}\n\nO aluno colou o texto abaixo (uma vaga, um e-mail, uma transcrição). ` +
      "Extraia até 15 alvos (palavras ou expressões) do texto que valem ser estudados para o objetivo dele e que provavelmente ele ainda não domina, " +
      "priorizando o que é mais útil. Para cada alvo, a frase de exemplo pode ser tirada do texto (adaptada se for longa) ou criada no mesmo contexto.\n\n" +
      `${REGRA_CARD}\nRegra da frase: ${regraNivel(2)}\n\nAlvos existentes no baralho:\n${existentes.join("\n") || "(nenhum)"}\n\n` +
      `<texto>\n${texto}\n</texto>` }],
  };
}

export function pedidoNovaFrase(deck, card, nivel, evoluir = false){
  const pedido = evoluir
    ? `Escreva uma frase mais elaborada que a anterior ("${card.Phrase}")`
    : `Escreva uma frase diferente de "${card.Phrase}"`;
  return {
    effort: "low",
    schema: FRASE,
    system: SYSTEM_BASE,
    messages: [{ role: "user", content:
      `${perfil(deck)}\n\nAlvo: "${card.Word}". ${pedido}, contendo o alvo exatamente como escrito, ligada ao objetivo do aluno. ` +
      `Regra: ${regraNivel(nivel)}\nDevolva Phrase (no idioma estudado) e Translation (português do Brasil).` }],
  };
}

export function pedidoTrocarObjetivo(deck, cards, novoObjetivo){
  const lista = cards.map(c => `- ${c.Word} (nível ${c.Level || 1})`).join("\n");
  return {
    effort: "low",
    schema: obj({ Cards: arr(obj({ Word: str, Phrase: str, Translation: str })) }),
    system: SYSTEM_BASE,
    messages: [{ role: "user", content:
      `${perfil({ ...deck, Objetivo: novoObjetivo })}\n\nReescreva a frase de exemplo de cada alvo abaixo para o novo objetivo. ` +
      "Mantenha Word exatamente igual, a frase contendo o alvo, e respeite o nível de cada um: " +
      `nível 1 — ${regraNivel(1)} nível 2 — ${regraNivel(2)} nível 3 — ${regraNivel(3)}\n\n${lista}` }],
  };
}

export function pedidoAvaliarProducao(deck, card, resposta, falada){
  return {
    effort: "low",
    schema: obj({
      Nota: { type: "string", enum: ["errei", "quase", "acertei", "facil"] },
      Correcao: str,
      Explicacao: str,
    }),
    system: SYSTEM_BASE,
    messages: [{ role: "user", content:
      `O aluno viu a frase em português e precisava dizê-la em ${idiomaLabel(deck.Language)}.\n` +
      `Português: "${card.Translation}"\nReferência: "${card.Phrase}"\nAlvo do card: "${card.Word}"\n` +
      `Resposta do aluno${falada ? " (transcrita da fala; ignore pontuação e maiúsculas)" : ""}: "${resposta}"\n\n` +
      "Avalie se a resposta comunica o mesmo sentido de forma correta e natural. Variações corretas valem. " +
      "Nota: 'facil' se perfeita e com o alvo; 'acertei' se correta com detalhe pequeno; 'quase' se o sentido passa mas há erro claro ou faltou o alvo; 'errei' se não passa. " +
      "Correcao: a melhor versão da frase do aluno (ou a referência, se ele errou tudo). Explicacao: uma frase curta em português sobre o principal erro, ou vazia se não houve erro." }],
  };
}

export const CENARIOS = {
  rh: "Entrevista de emprego com o RH: trajetória, motivação, pontos fortes e fracos, expectativa, perguntas comportamentais.",
  tecnica: "Entrevista técnica: o entrevistador pergunta sobre projetos, decisões técnicas, problemas resolvidos e como o aluno trabalha em equipe.",
  viagem: "Situação de viagem ou intercâmbio: aeroporto, hospedagem, restaurante, transporte, conversa com pessoas locais.",
  livre: "Conversa livre sobre o dia a dia e o objetivo do aluno.",
};

export function systemConversa(deck, { cenario, vaga, historico }){
  return SYSTEM_BASE + "\n\n" +
    `Você conduz uma conversa de prática em ${idiomaLabel(deck.Language)}, falando só nesse idioma em Fala.\n` +
    `${perfil(deck)}\nCenário: ${CENARIOS[cenario] || cenario}\n` +
    (vaga ? `Vaga ou contexto informado pelo aluno:\n<contexto>\n${vaga}\n</contexto>\n` : "") +
    (historico ? `Histórico do aluno:\n<historico>\n${historico}\n</historico>\n` : "") +
    "Faça uma pergunta ou fala por vez, curta (até 3 frases), como numa conversa real, ajustada ao nível do aluno. " +
    "Reaja ao que ele disse antes de seguir. " +
    "Em Correcao, avalie a ÚLTIMA fala do aluno: se tiver erro de gramática, vocabulário ou algo que soe pouco natural, " +
    "preencha Original (o trecho dele), Melhor (como um nativo diria) e Explicacao (curta, em português). Se estiver boa ou se ainda não houver fala do aluno, deixe os três vazios.";
}

export const SCHEMA_TURNO = obj({
  Fala: str,
  Correcao: obj({ Original: str, Melhor: str, Explicacao: str }),
});

export function pedidoTurno(deck, opcoes, turnos){
  const messages = [{ role: "user", content: "(Comece a conversa: cumprimente e faça a primeira pergunta.)" }];
  for(const t of turnos){
    if(t.quem === "ia") messages.push({ role: "assistant", content: JSON.stringify({ Fala: t.texto, Correcao: t.correcao || { Original: "", Melhor: "", Explicacao: "" } }) });
    else messages.push({ role: "user", content: t.texto });
  }
  return { effort: "low", schema: SCHEMA_TURNO, system: systemConversa(deck, opcoes), messages };
}

export function pedidoRelatorio(deck, opcoes, turnos, existentes = []){
  const transcricao = turnos.map(t => `${t.quem === "ia" ? "Entrevistador" : "Aluno"}: ${t.texto}`).join("\n");
  return {
    effort: "medium",
    schema: obj({
      Resumo: str,
      NivelPercebido: { type: "string", enum: NIVEIS },
      Erros: arr(obj({ Original: str, Melhor: str, Explicacao: str })),
      FrasesUteis: arr(str),
      Cards: arr(CARD),
    }),
    system: SYSTEM_BASE,
    messages: [{ role: "user", content:
      `${perfil(deck)}\nCenário: ${CENARIOS[opcoes.cenario] || opcoes.cenario}\n\nTranscrição da conversa de prática:\n<conversa>\n${transcricao}\n</conversa>\n\n` +
      "Faça o relatório para o aluno, em português: Resumo (3 a 4 frases sobre como ele se saiu e o que treinar), " +
      "NivelPercebido (CEFR, pelo que ele mostrou), Erros (os mais importantes, até 8, com o trecho dele, como um nativo diria e a explicação), " +
      "FrasesUteis (até 6 frases prontas no idioma estudado que ele poderia ter usado), " +
      `e Cards (até 8 cards novos tirados dos erros e das frases úteis). ${REGRA_CARD} Regra da frase: ${regraNivel(2)}\n\n` +
      `Alvos existentes no baralho:\n${existentes.join("\n") || "(nenhum)"}` }],
  };
}

export const TIPOS_ITEM = ["traducao", "completar", "compreensao", "escrita", "fala"];

export function pedidoTesteNivel(deck){
  return {
    effort: "medium",
    schema: obj({ Itens: arr(obj({ Tipo: { type: "string", enum: TIPOS_ITEM }, Enunciado: str, Texto: str })) }),
    system: SYSTEM_BASE,
    messages: [{ role: "user", content:
      `${perfil(deck)}\n\nMonte uma avaliação curta de nível (CEFR) em ${idiomaLabel(deck.Language)}, com 10 itens de dificuldade crescente, de A2 a C1, ` +
      "no contexto do objetivo do aluno. Distribua: 3 'traducao' (frase em português para traduzir), 2 'completar' (frase com lacuna ___), " +
      "2 'compreensao' (Texto: um parágrafo curto no idioma; Enunciado: pergunta em português sobre ele), " +
      "2 'escrita' (pedido para escrever 2 ou 3 frases sobre algo) e 1 'fala' (uma pergunta que o aluno responde falando). " +
      "Enunciado em português (menos no 'completar', que é a própria frase no idioma). Texto vazio quando não houver texto de apoio. " +
      "Não dê as respostas." }],
  };
}

export function pedidoCorrigirTeste(deck, itens, respostas){
  const blocos = itens.map((it, i) =>
    `${i + 1}. [${it.Tipo}] ${it.Enunciado}${it.Texto ? `\nTexto: ${it.Texto}` : ""}\nResposta do aluno: ${respostas[i] || "(em branco)"}`).join("\n\n");
  return {
    effort: "medium",
    schema: obj({
      Nivel: { type: "string", enum: NIVEIS },
      Resumo: str,
      Fortes: arr(str),
      Fracos: arr(str),
      Itens: arr(obj({ Nota: num, Comentario: str })),
    }),
    system: SYSTEM_BASE,
    messages: [{ role: "user", content:
      `${perfil(deck)}\n\nCorrija a avaliação de nível abaixo. Para cada item, Nota de 0 a 1 e um Comentario curto em português ` +
      "(o que estava certo ou a resposta melhor). Depois estime o Nivel CEFR do aluno pelo conjunto, com Resumo (2 a 3 frases), " +
      "Fortes e Fracos (até 3 cada). Seja honesto: em branco conta como não sabe. A resposta do item 'fala' veio de transcrição de voz.\n\n" + blocos }],
  };
}

export function pedidoRoteiro(membros, idiomaCode = "en"){
  const quem = membros.map(m => `- ${m.Nome} (nível ${m.Nivel || "?"}; objetivo: ${m.Objetivo || "geral"}): palavras a praticar — ${(m.Fracas || []).join(", ") || "nenhuma ainda"}`).join("\n");
  return {
    effort: "low",
    schema: obj({
      Tema: str,
      Aquecimento: str,
      Perguntas: arr(obj({ Quem: str, Pergunta: str })),
      FrasesModelo: arr(str),
    }),
    system: SYSTEM_BASE,
    messages: [{ role: "user", content:
      `Um casal treina ${idiomaLabel(idiomaCode)} conversando no carro, uns 20 minutos, sem tela. Monte o roteiro de hoje.\n${quem}\n\n` +
      "Tema: um assunto do dia a dia que junte os objetivos dos dois (em português, curto). Aquecimento: uma frase em português dizendo como começar. " +
      `Perguntas: 8 perguntas no idioma, alternando quem pergunta (Quem = o nome de quem faz a pergunta), puxando as palavras a praticar dos dois, ` +
      "fáceis de responder de cabeça. FrasesModelo: 5 frases no idioma que ajudam a responder." }],
  };
}
