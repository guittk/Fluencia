// Firebase via REST, sem SDK: login (Identity Toolkit), renovação do token
// (Secure Token) e Realtime Database. O banco é o basehub-135f5, compartilhado
// com outros apps — tudo do Fluência mora em /fluencia.

const API_KEY = "AIzaSyAkNtMewsDzOQZLSLq4_x4yx_QXu3sPagg";
const DB_URL = "https://basehub-135f5-default-rtdb.firebaseio.com";
export const RAIZ = "/fluencia";

const SESSAO_KEY = "fluencia:sessao";

export const sessao = {
  idToken: null,
  refreshToken: null,
  expiraEm: 0, // ms epoch
  uid: null,
  email: null,
};

function salvarSessao(){
  try{
    localStorage.setItem(SESSAO_KEY, JSON.stringify({
      refreshToken: sessao.refreshToken, uid: sessao.uid, email: sessao.email
    }));
  }catch(e){ /* sem armazenamento: o login só não persiste */ }
}

function aplicarToken(data){
  sessao.idToken = data.idToken || data.id_token;
  sessao.refreshToken = data.refreshToken || data.refresh_token;
  const exp = Number(data.expiresIn || data.expires_in || 3600);
  sessao.expiraEm = Date.now() + (exp - 120) * 1000; // renova 2 min antes
  sessao.uid = data.localId || data.user_id || sessao.uid;
  if(data.email) sessao.email = data.email;
  salvarSessao();
}

async function authRequest(endpoint, body){
  const res = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:${endpoint}?key=${API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if(!res.ok) throw new Error((data.error && data.error.message) || "Erro desconhecido");
  return data;
}

export async function login(email, password){
  aplicarToken(await authRequest("signInWithPassword", { email, password, returnSecureToken: true }));
}

export async function signup(email, password){
  aplicarToken(await authRequest("signUp", { email, password, returnSecureToken: true }));
}

export async function forgotPassword(email){
  await authRequest("sendOobCode", { requestType: "PASSWORD_RESET", email });
}

export function logout(){
  sessao.idToken = sessao.refreshToken = sessao.uid = sessao.email = null;
  sessao.expiraEm = 0;
  try{ localStorage.removeItem(SESSAO_KEY); }catch(e){}
}

async function renovar(){
  const res = await fetch(`https://securetoken.googleapis.com/v1/token?key=${API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(sessao.refreshToken)}`,
  });
  const data = await res.json();
  if(!res.ok) throw new Error("Sessão expirada. Entre de novo.");
  aplicarToken(data);
}

// Tenta voltar a sessão guardada no navegador. Devolve true se deu certo.
export async function retomarSessao(){
  let salvo = null;
  try{ salvo = JSON.parse(localStorage.getItem(SESSAO_KEY) || "null"); }catch(e){}
  if(!salvo || !salvo.refreshToken) return false;
  sessao.refreshToken = salvo.refreshToken;
  sessao.uid = salvo.uid;
  sessao.email = salvo.email;
  try{
    await renovar();
    return true;
  }catch(e){
    logout();
    return false;
  }
}

let renovando = null;
async function tokenValido(){
  if(!sessao.refreshToken) throw new Error("Sem sessão.");
  if(Date.now() < sessao.expiraEm && sessao.idToken) return sessao.idToken;
  if(!renovando) renovando = renovar().finally(() => { renovando = null; });
  await renovando;
  return sessao.idToken;
}

async function dbFetch(path, opts = {}, tentativa = 0){
  const token = await tokenValido();
  const qs = new URLSearchParams(opts.query || {});
  qs.set("auth", token);
  const res = await fetch(`${DB_URL}${path}.json?${qs}`, {
    method: opts.method || "GET",
    headers: opts.body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  if(res.status === 401 && tentativa === 0){
    sessao.expiraEm = 0; // força renovar e tenta uma vez mais
    return dbFetch(path, opts, 1);
  }
  if(!res.ok) throw new Error(opts.erro || "Falha ao acessar o banco.");
  return res.json();
}

export const dbGet = (path, query) => dbFetch(path, { query, erro: "Falha ao ler dados." });
export const dbPut = (path, body) => dbFetch(path, { method: "PUT", body, erro: "Falha ao salvar dados." });
export const dbPatch = (path, body) => dbFetch(path, { method: "PATCH", body, erro: "Falha ao atualizar dados." });
export const dbDelete = (path) => dbFetch(path, { method: "DELETE", erro: "Falha ao excluir dados." });

// Caminho de dados do usuário logado.
export const meu = (sub = "") => `${RAIZ}/users/${sessao.uid}${sub}`;

export function traduzirErroAuth(msg){
  const map = {
    EMAIL_NOT_FOUND: "Email não encontrado.",
    INVALID_PASSWORD: "Senha incorreta.",
    INVALID_LOGIN_CREDENTIALS: "Email ou senha incorretos.",
    EMAIL_EXISTS: "Esse email já tem uma conta.",
    WEAK_PASSWORD: "A senha precisa ter ao menos 6 caracteres.",
    MISSING_EMAIL: "Digite um email.",
    INVALID_EMAIL: "Email inválido.",
    TOO_MANY_ATTEMPTS_TRY_LATER: "Muitas tentativas. Espere um pouco.",
  };
  for(const k in map) if(msg && msg.includes(k)) return map[k];
  return msg || "Ocorreu um erro. Tente novamente.";
}
