// Cliente do Claude no navegador. A chave mora no banco, em /fluencia/claudeKey,
// e as regras só deixam as contas do Guilherme e da Julia lerem.
import Anthropic from "https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@0.129.0/+esm";
import { dbGet, RAIZ } from "./firebase.js";
import { executar } from "./ia-pedidos.js";

let client = null;

async function cliente(){
  if(client) return client;
  let chave = null;
  try{ chave = await dbGet(`${RAIZ}/claudeKey`); }catch(e){ /* cai no erro abaixo */ }
  if(!chave) throw new Error("Esta conta não tem acesso à IA. Fale com o Guilherme.");
  client = new Anthropic({ apiKey: chave, dangerouslyAllowBrowser: true, maxRetries: 2 });
  return client;
}

export function esquecerCliente(){ client = null; }

export async function pedir(pedido){
  const c = await cliente();
  try{
    return await executar(c, pedido);
  }catch(err){
    if(err instanceof Anthropic.AuthenticationError) throw new Error("A chave da IA não é válida.");
    if(err instanceof Anthropic.RateLimitError) throw new Error("A IA está ocupada. Tente em alguns segundos.");
    if(err instanceof Anthropic.APIConnectionError) throw new Error("Sem conexão com a IA.");
    if(err instanceof Anthropic.APIError) throw new Error("Erro na IA: " + (err.message || err.status));
    throw err;
  }
}
