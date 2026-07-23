(function(){
  "use strict";

  // =========================================================
  // CONFIG
  // =========================================================
  const FIREBASE_API_KEY = "AIzaSyAQqB__M-gKZWHS4zQ1eIA-X6rGqzVtr0I";
  const FIREBASE_DB_URL = "https://anki-71f4f-default-rtdb.firebaseio.com";

  // Chave da OpenAI: fixada no código a seu pedido. Troque abaixo pela sua chave real.
  // O campo em Configurações sobrescreve isso apenas para a sessão atual da aba.
  let openaiApiKey = "";

  const HISTORY_CAP = 500;

  // =========================================================
  // STATE
  // =========================================================
  const state = {
    idToken: null,
    uid: null,
    email: null,
    cards: {},        // wordKey -> card object
    currentCardKey: null,
    pendingWords: [],  // [{id, value}]
    audioCache: {},    // word -> object URL
  };

  // =========================================================
  // DOM HELPERS
  // =========================================================
  const $ = (id) => document.getElementById(id);

  let toastTimer = null;
  function showToast(msg){
  console.log(msg);
    const t = $("toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(()=>t.classList.remove("show"), 3200);
  }
  function showLoading(text){
    $("loading-text").textContent = text || "Carregando…";
    $("loading-overlay").classList.remove("hidden");
  }
  function hideLoading(){
    $("loading-overlay").classList.add("hidden");
  }
  function escapeHtml(str){
    return String(str).replace(/[&<>"']/g, c => ({
      "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"
    }[c]));
  }

  // =========================================================
  // CLICK SOUND (sintetizado via Web Audio, sem arquivos externos)
  // =========================================================
  let audioCtx = null;
  function playClick(){
    try{
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const t = audioCtx.currentTime;
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(880, t);
      osc.frequency.exponentialRampToValueAtTime(440, t + 0.05);
      gain.gain.setValueAtTime(0.07, t);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.08);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(t);
      osc.stop(t + 0.09);
    }catch(e){ /* silencioso: alguns navegadores bloqueiam antes do 1º gesto do usuário */ }
  }
  document.addEventListener("click", (e) => {
    if(e.target.closest("button, .nav-item")) playClick();
  }, true);

  // =========================================================
  // FIREBASE AUTH (Identity Toolkit REST)
  // =========================================================
  async function authRequest(endpoint, body){
    const url = `https://identitytoolkit.googleapis.com/v1/accounts:${endpoint}?key=${FIREBASE_API_KEY}`;
    const res = await fetch(url, {
      method:"POST",
      headers:{ "Content-Type":"application/json" },
      body: JSON.stringify(body)
    });
    const data = await res.json();
    if(!res.ok){
      const msg = (data && data.error && data.error.message) || "Erro desconhecido";
      throw new Error(msg);
    }
    return data;
  }

  async function login(email, password){
    const data = await authRequest("signInWithPassword", { email, password, returnSecureToken:true });
    state.idToken = data.idToken;
    state.uid = data.localId;
    state.email = data.email;
  }

  async function signup(email, password){
    const data = await authRequest("signUp", { email, password, returnSecureToken:true });
    state.idToken = data.idToken;
    state.uid = data.localId;
    state.email = data.email;
  }

  async function forgotPassword(email){
    await authRequest("sendOobCode", { requestType:"PASSWORD_RESET", email });
  }

  function translateAuthError(msg){
    const map = {
      "EMAIL_NOT_FOUND":"Email não encontrado.",
      "INVALID_PASSWORD":"Senha incorreta.",
      "INVALID_LOGIN_CREDENTIALS":"Email ou senha incorretos.",
      "EMAIL_EXISTS":"Esse email já tem uma conta.",
      "WEAK_PASSWORD":"A senha precisa ter ao menos 6 caracteres.",
      "MISSING_EMAIL":"Digite um email.",
      "INVALID_EMAIL":"Email inválido."
    };
    for(const key in map){
      if(msg && msg.indexOf(key) !== -1) return map[key];
    }
    return msg || "Ocorreu um erro. Tente novamente.";
  }

  // =========================================================
  // FIREBASE REALTIME DATABASE
  //   Estrutura profissional, escopada por usuário:
  //   /users/{uid}/Profile        -> { Email, CreatedAt, LastLogin }
  //   /users/{uid}/Cards/{wordKey}-> { Word, English, Portuguese, ScoreHits, ... }
  //   Cada card já nasce dentro do usuário — nenhum dado é compartilhado
  //   entre contas, então qualquer número de pessoas pode usar o app
  //   sem que o progresso de uma afete o baralho da outra.
  //   Regra de segurança sugerida no Firebase:
  //     "users": { "$uid": { ".read/.write": "auth.uid === $uid" } }
  // =========================================================
  function authParam(){
    return state.idToken ? `auth=${state.idToken}` : "";
  }
  function buildUrl(path){
    const qs = authParam();
    return `${FIREBASE_DB_URL}${path}.json${qs ? "?" + qs : ""}`;
  }
  async function dbGet(path){
    const res = await fetch(buildUrl(path));
    if(!res.ok) throw new Error("Falha ao ler dados do Firebase.");
    return res.json();
  }
  async function dbPut(path, data){
    const res = await fetch(buildUrl(path), {
      method:"PUT",
      headers:{ "Content-Type":"application/json" },
      body: JSON.stringify(data)
    });
    if(!res.ok) throw new Error("Falha ao salvar dados no Firebase.");
    return res.json();
  }
  async function dbPatch(path, data){
    const res = await fetch(buildUrl(path), {
      method:"PATCH",
      headers:{ "Content-Type":"application/json" },
      body: JSON.stringify(data)
    });
    if(!res.ok) throw new Error("Falha ao atualizar dados no Firebase.");
    return res.json();
  }
  async function dbDelete(path){
    const res = await fetch(buildUrl(path), { method:"DELETE" });
    if(!res.ok) throw new Error("Falha ao excluir dados no Firebase.");
    return res.json();
  }

  function wordKey(word){
    return word.trim().toLowerCase()
      .normalize("NFD").replace(new RegExp("[\\u0300-\\u036f]", "g"), "")
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "") || ("w" + Date.now());
  }

  function blankCard(word, english, portuguese){
    return {
      Word: word,
      English: english,
      Portuguese: portuguese,
      ScoreHits: 0, TotalHits: 0,
      CorrectHits: 0, CorrectPlusHits: 0, WarningHits: 0, WrongHits: 0,
      CreatedAt: new Date().toISOString(),
      History: []
    };
  }

  async function loadOpenAiKey(){
    const openAiKey = await dbGet(`/openAiKey`);
    openaiApiKey = openAiKey;
  }

  async function loadUserCards(){
    const remote = await dbGet(`/users/${state.uid}/Cards`);
    state.cards = remote || {};
  }

  async function ensureProfile(){
    try{
      await dbPatch(`/users/${state.uid}/Profile`, {
        Email: state.email,
        LastLogin: new Date().toISOString()
      });
      const existing = await dbGet(`/users/${state.uid}/Profile/CreatedAt`);
      if(!existing){
        await dbPatch(`/users/${state.uid}/Profile`, { CreatedAt: new Date().toISOString() });
      }
    }catch(err){
      // não bloqueia o login por causa do perfil
      console.warn(err);
    }
  }

  // =========================================================
  // SCORING (mesma matemática do app original)
  // =========================================================
  function pickNextCard(){
    const keys = Object.keys(state.cards);
    const weights = keys.map(k => 1 / Math.max(1, state.cards[k].ScoreHits || 0));
    const total = weights.reduce((a,b)=>a+b, 0);
    const probs = weights.map(w => w/total);
    const r = Math.random();
    let cumulative = 0;
    for(let i=0;i<probs.length;i++){
      cumulative += probs[i];
      if(r < cumulative) return keys[i];
    }
    return keys[keys.length-1];
  }

  function clampCard(card){
    if(card.TotalHits < 0) card.TotalHits = 0;
    if(card.ScoreHits < 0) card.ScoreHits = 0;
    if(card.ScoreHits > card.TotalHits) card.ScoreHits = card.TotalHits;
  }

  async function answerCard(sum){
    setAnswerButtonsEnabled(false);
    const key = state.currentCardKey;
    const card = state.cards[key];

    card.ScoreHits += sum;
    card.TotalHits += sum > 1 ? sum : 1;

    if(sum === 0) card.WarningHits += 1;
    else if(sum < 0) card.WrongHits += 1;
    else if(sum === 1) card.CorrectHits += 1;
    else card.CorrectPlusHits += 1;

    clampCard(card);

    if(!card.History) card.History = [];
    card.History.push({ Date: new Date().toISOString(), Sum: sum });
    if(card.History.length > HISTORY_CAP){
      card.History.splice(0, card.History.length - HISTORY_CAP);
    }

    try{
      await dbPut(`/users/${state.uid}/Cards/${key}`, card);
    }catch(err){
      showToast(err.message);
    }

    setTimeout(() => loadNextCard(), 200);
  }

  function setAnswerButtonsEnabled(enabled){
    ["btn-wrong","btn-warning","btn-correct","btn-correct-plus","btn-sound"].forEach(id=>{
      $(id).disabled = !enabled;
    });
  }

  // =========================================================
  // ESTUDAR — render
  // =========================================================
  function loadNextCard(){
    $("flashcard-inner").classList.remove("flipped");
    $("controls-answer").classList.add("hidden");
    $("controls-turn").classList.remove("hidden");

    const keys = Object.keys(state.cards);
    $("deck-status").textContent = `Baralho: ${keys.length} card(s)`;

    if(keys.length === 0){
      state.currentCardKey = null;
      $("card-word").textContent = "Sem cards ainda";
      $("controls-turn").classList.add("hidden");
      return;
    }

    state.currentCardKey = pickNextCard();
    const card = state.cards[state.currentCardKey];
    $("card-word").textContent = card.Word;
    $("card-english").textContent = card.English;
    $("card-portuguese").textContent = card.Portuguese;
    $("postmark-badge").textContent = card.ScoreHits;
  }

  function turnCard(){
    if(!state.currentCardKey) return;
    $("flashcard-inner").classList.add("flipped");
    $("controls-turn").classList.add("hidden");
    $("controls-answer").classList.remove("hidden");
    setAnswerButtonsEnabled(true);
  }

  // =========================================================
  // OPENAI — texto
  // =========================================================
  async function openaiChat(systemPrompt){
    if(!openaiApiKey || openaiApiKey.indexOf("COLE-SUA-CHAVE") !== -1){
      loadOpenAiKey();
      showToast("Acessando OpenAI, tente novamente!");
      return;
    }
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method:"POST",
      headers:{
        "Content-Type":"application/json",
        "Authorization": "Bearer " + openaiApiKey
      },
      body: JSON.stringify({
        model:"gpt-4o-mini",
        temperature:0.7,
        messages:[{ role:"system", content: systemPrompt }]
      })
    });
    const data = await res.json();
    if(!res.ok){
      throw new Error((data.error && data.error.message) || "Erro na chamada à OpenAI.");
    }
    return data.choices[0].message.content;
  }

  function extractJson(text){
    const cleaned = text.replace(/```json/gi, "").replace(/```/g, "").trim();
    return JSON.parse(cleaned);
  }

  function promptGenerateCards(words){
    return "Pegue a lista de Palavras, gere frases simples em Inglês, depois traduza para Português, " +
      "e devolva **apenas** no seguinte formato JSON, sem explicações adicionais, sem comentários, sem texto fora do JSON:\n\n" +
      "{\n  \"Phrases\": [\n    { \"Word\": \"WORD1\", \"English\": \"ENGLISH1\", \"Portuguese\": \"PORTUGUESE1\" }\n  ]\n}\n\n" +
      "Palavras:\n" + words.join("\n");
  }

  function promptSuggestTenWords(existingWords){
    return "Analise a lista de palavras em inglês enviada, escolha as 10 palavras mais usadas em inglês que não " +
      "estejam na lista e devolva **apenas** no seguinte formato JSON, sem explicações adicionais, sem comentários " +
      "e sem texto fora do JSON:\n\n" +
      "{\n  \"Words\": [\n    \"WORD1\",\n    \"WORD2\"\n  ]\n}\n\n" +
      "Palavras:\n" + existingWords.join("\n");
  }

  function promptRefreshCard(card){
    return `Pegue a Palavra, e gere uma frase SIMPLES com a palavra "${card.Word}", mas diferente de "${card.English}", ` +
      "simples em Inglês, depois traduza para Português, e devolva **apenas** no seguinte formato JSON, sem explicações " +
      "adicionais, sem comentários, sem texto fora do JSON:\n\n" +
      "{ \"Word\": \"WORD\", \"English\": \"ENGLISH\", \"Portuguese\": \"PORTUGUESE\" }";
  }

  // =========================================================
  // OPENAI — áudio
  // =========================================================
  async function playCardAudio(card){
    if(!openaiApiKey || openaiApiKey.indexOf("COLE-SUA-CHAVE") !== -1){
      loadOpenAiKey();
      showToast("Acessando OpenAI, tente novamente!");
      return;
    }
    if(state.audioCache[card.Word]){
      new Audio(state.audioCache[card.Word]).play();
      return;
    }
    showLoading("Gerando áudio…");
    try{
      const res = await fetch("https://api.openai.com/v1/audio/speech", {
        method:"POST",
        headers:{
          "Content-Type":"application/json",
          "Authorization":"Bearer " + openaiApiKey
        },
        body: JSON.stringify({
          model:"gpt-4o-mini-tts",
          voice:"alloy",
          input: card.English,
          response_format:"mp3"
        })
      });
      if(!res.ok){
        const errText = await res.text();
        throw new Error("Erro ao gerar áudio: " + errText.slice(0,150));
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      state.audioCache[card.Word] = url;
      new Audio(url).play();
    }catch(err){
      showToast(err.message);
    }finally{
      hideLoading();
    }
  }

  // =========================================================
  // CARDS — gerenciar
  // =========================================================
  function renderManageView(){
    const keys = Object.keys(state.cards);
    $("deck-count-tag").textContent = `${keys.length} cards`;
    $("nav-card-count").textContent = keys.length;
    $("empty-msg").classList.toggle("hidden", keys.length > 0);

    const grid = $("card-grid");
    grid.innerHTML = "";
    keys.forEach(key => {
      const card = state.cards[key];
      const acc = card.TotalHits > 0 ? Math.round((card.ScoreHits / card.TotalHits) * 100) : null;
      const tile = document.createElement("div");
      tile.className = "study-card";
      tile.innerHTML = `
        <div class="study-card-title">${escapeHtml(card.Word)}</div>
        <div class="study-card-meta">${escapeHtml(card.English)}<br><em>${escapeHtml(card.Portuguese)}</em></div>
        <div class="card-metrics">
          <span>${acc === null ? "sem dados" : "precisão " + acc + "%"}</span>
          <span>${card.TotalHits} revisões</span>
        </div>
        <div style="display:flex;gap:8px;margin-top:12px;">
          <button class="btn btn-edit btn-sm" data-action="refresh">🔄 Nova frase</button>
          <button class="btn btn-reject btn-sm" data-action="delete">🗑️ Excluir</button>
        </div>
      `;
      tile.querySelector('[data-action="refresh"]').addEventListener("click", () => refreshCard(key));
      tile.querySelector('[data-action="delete"]').addEventListener("click", () => deleteCard(key));
      grid.appendChild(tile);
    });
  }

  async function refreshCard(key){
    const card = state.cards[key];
    showLoading("Gerando nova frase…");
    try{
      const raw = await openaiChat(promptRefreshCard(card));
      const refreshed = extractJson(raw);
      card.English = refreshed.English;
      card.Portuguese = refreshed.Portuguese;
      delete state.audioCache[card.Word];
      await dbPatch(`/users/${state.uid}/Cards/${key}`, { English: card.English, Portuguese: card.Portuguese });
      renderManageView();
      showToast("Frase atualizada.");
    }catch(err){
      showToast(err.message);
    }finally{
      hideLoading();
    }
  }

  async function deleteCard(key){
    const card = state.cards[key];
    if(!confirm(`Excluir o card "${card.Word}"?`)) return;
    showLoading("Excluindo…");
    try{
      delete state.cards[key];
      await dbDelete(`/users/${state.uid}/Cards/${key}`);
      renderManageView();
    }catch(err){
      showToast(err.message);
    }finally{
      hideLoading();
    }
  }

  function renderPendingList(){
    const list = $("pending-list");
    list.innerHTML = "";
    state.pendingWords.forEach(item => {
      const row = document.createElement("div");
      row.className = "inbox-item";
      row.innerHTML = `<span class="inbox-text">${escapeHtml(item.value)}</span>
        <button class="inbox-remove" title="Remover">✕</button>`;
      row.querySelector("button").addEventListener("click", () => {
        state.pendingWords = state.pendingWords.filter(p => p.id !== item.id);
        renderPendingList();
      });
      list.appendChild(row);
    });
    $("pending-count-tag").textContent = `${state.pendingWords.length} pendentes`;
    $("btn-generate-cards").classList.toggle("hidden", state.pendingWords.length === 0);
  }

  function addPendingWord(value){
    const v = (value || "").trim();
    if(!v) return;
    state.pendingWords.push({ id: Math.random().toString(36).slice(2), value: v });
    renderPendingList();
  }

  async function suggestTenWords(){
    showLoading("Pedindo sugestões para a IA…");
    try{
      const existing = Object.values(state.cards).map(c => c.Word);
      const raw = await openaiChat(promptSuggestTenWords(existing));
      const result = extractJson(raw);
      (result.Words || []).forEach(w => addPendingWord(w));
    }catch(err){
      showToast(err.message);
    }finally{
      hideLoading();
    }
  }

  async function generatePendingCards(){
    const words = state.pendingWords.map(p => p.value.trim()).filter(Boolean);
    if(words.length === 0) return;

    showLoading("Gerando frases com a IA…");
    try{
      const existingWords = Object.values(state.cards).map(c => c.Word.toLowerCase());
      const wordsToCreate = words.filter(w => !existingWords.includes(w.toLowerCase()));

      if(wordsToCreate.length === 0){
        showToast("Essas palavras já existem no seu baralho.");
        state.pendingWords = [];
        renderPendingList();
        return;
      }

      const raw = await openaiChat(promptGenerateCards(wordsToCreate));
      const result = extractJson(raw);
      const newCards = result.Phrases || [];

      const patchBody = {};
      newCards.forEach(nc => {
        const key = wordKey(nc.Word);
        const card = blankCard(nc.Word.toLowerCase(), nc.English, nc.Portuguese);
        state.cards[key] = card;
        patchBody[key] = card;
      });

      await dbPatch(`/users/${state.uid}/Cards`, patchBody);
      state.pendingWords = [];
      renderPendingList();
      renderManageView();
      showToast(`${newCards.length} card(s) adicionado(s).`);
    }catch(err){
      showToast(err.message);
    }finally{
      hideLoading();
    }
  }

  // =========================================================
  // ESTATÍSTICAS
  // =========================================================
  function renderStatsView(){
    const cards = Object.values(state.cards);
    const totalCards = cards.length;
    const totalReviews = cards.reduce((s,c) => s + (c.TotalHits || 0), 0);
    const totalCorrect = cards.reduce((s,c) => s + (c.CorrectHits || 0) + (c.CorrectPlusHits || 0), 0);
    const accuracy = totalReviews > 0 ? Math.round((totalCorrect / totalReviews) * 100) : 0;
    const mastered = cards.filter(c => c.TotalHits >= 5 && (c.ScoreHits / Math.max(1,c.TotalHits)) >= 0.8).length;

    $("stat-total-cards").textContent = totalCards;
    $("stat-total-reviews").textContent = totalReviews;
    $("stat-accuracy").textContent = accuracy + "%";
    $("mastered-tag").textContent = `${mastered} dominados`;

    // agrega histórico por dia
    const byDay = {};
    cards.forEach(c => (c.History || []).forEach(h => {
      const day = h.Date.slice(0,10);
      byDay[day] = (byDay[day] || 0) + 1;
    }));

    // sequência de dias consecutivos até hoje
    let streak = 0;
    let cursor = new Date();
    while(true){
      const key = cursor.toISOString().slice(0,10);
      if(byDay[key]){
        streak++;
        cursor.setDate(cursor.getDate() - 1);
      } else break;
    }
    $("stat-streak").textContent = streak;

    // gráfico últimos 7 dias
    const days = [];
    for(let i = 6; i >= 0; i--){
      const dt = new Date();
      dt.setDate(dt.getDate() - i);
      const key = dt.toISOString().slice(0,10);
      days.push({
        label: dt.toLocaleDateString("pt-BR", { weekday:"short" }).replace(".", ""),
        count: byDay[key] || 0
      });
    }
    const maxCount = Math.max(1, ...days.map(d => d.count));
    const chart = $("bar-chart");
    chart.innerHTML = "";
    days.forEach(d => {
      const col = document.createElement("div");
      col.className = "bar-col";
      const heightPct = Math.max(4, Math.round((d.count / maxCount) * 100));
      col.innerHTML = `<div class="bar-fill" style="height:${heightPct}%"></div><div class="bar-label">${escapeHtml(d.label)}</div>`;
      chart.appendChild(col);
    });

    // saúde por card, pior primeiro
    const keys = Object.keys(state.cards);
    const sorted = keys.slice().sort((a,b) => {
      const ca = state.cards[a], cb = state.cards[b];
      const pa = ca.TotalHits > 0 ? ca.ScoreHits/ca.TotalHits : -1;
      const pb = cb.TotalHits > 0 ? cb.ScoreHits/cb.TotalHits : -1;
      return pa - pb;
    });
    const healthList = $("health-list");
    healthList.innerHTML = "";
    if(sorted.length === 0){
      healthList.innerHTML = '<p class="empty-msg">Sem cards para mostrar ainda.</p>';
    }
    sorted.forEach(key => {
      const c = state.cards[key];
      const row = document.createElement("div");
      row.className = "health-row";
      let dotClass = "health-neutral", label = "sem dados";
      if(c.TotalHits > 0){
        const pct = Math.round((c.ScoreHits / c.TotalHits) * 100);
        label = pct + "%";
        if(pct < 40) dotClass = "health-risco";
        else if(pct < 70) dotClass = "health-atencao";
        else dotClass = "health-ok";
      }
      row.innerHTML = `<span>${escapeHtml(c.Word)}</span><span class="health-dot ${dotClass}">${label}</span>`;
      healthList.appendChild(row);
    });
  }

  // =========================================================
  // NAVEGAÇÃO
  // =========================================================
  function showApp(){
    $("screen-login").classList.add("hidden");
    $("app-shell").classList.remove("hidden");
    $("sidebar-email").textContent = state.email;
    $("settings-email").textContent = state.email;
  }

  function switchView(viewId){
    document.querySelectorAll(".view").forEach(v => v.classList.toggle("active", v.id === viewId));
    document.querySelectorAll(".nav-item").forEach(n => n.classList.toggle("active", n.dataset.view === viewId));
    closeMobileSidebar();
    if(viewId === "view-manage") renderManageView();
    if(viewId === "view-stats") renderStatsView();
    if(viewId === "view-settings") $("input-openai-key").value = "";
  }

  function openMobileSidebar(){
    $("sidebar").classList.add("mobile-open");
    $("sidebar-backdrop").classList.add("active");
  }
  function closeMobileSidebar(){
    $("sidebar").classList.remove("mobile-open");
    $("sidebar-backdrop").classList.remove("active");
  }

  async function enterApp(){
    showLoading("Carregando seu baralho…");
    try{
      await ensureProfile();
      await loadUserCards();
      showApp();
      switchView("view-study");
      loadNextCard();
      $("nav-card-count").textContent = Object.keys(state.cards).length;
    }catch(err){
      showToast(err.message);
    }finally{
      hideLoading();
    }
  }

  function logout(){
    state.idToken = null;
    state.uid = null;
    state.email = null;
    state.cards = {};
    state.currentCardKey = null;
    state.audioCache = {};
    $("app-shell").classList.add("hidden");
    $("screen-login").classList.remove("hidden");
    closeMobileSidebar();
  }

  // =========================================================
  // EVENTOS
  // =========================================================
  $("btn-login").addEventListener("click", async () => {
    const email = $("login-email").value.trim();
    const password = $("login-password").value;
    $("login-error").textContent = "";
    if(!email || !password){ $("login-error").textContent = "Preencha email e senha."; return; }
    showLoading("Entrando…");
    try{
      await login(email, password);
      await enterApp();
    }catch(err){
      $("login-error").textContent = translateAuthError(err.message);
    }finally{
      hideLoading();
    }
  });

  $("btn-signup").addEventListener("click", async () => {
    const email = $("login-email").value.trim();
    const password = $("login-password").value;
    $("login-error").textContent = "";
    if(!email || !password){ $("login-error").textContent = "Preencha email e senha."; return; }
    if(password.length < 6){ $("login-error").textContent = "A senha precisa ter ao menos 6 caracteres."; return; }
    showLoading("Criando conta…");
    try{
      await signup(email, password);
      await enterApp();
    }catch(err){
      $("login-error").textContent = translateAuthError(err.message);
    }finally{
      hideLoading();
    }
  });

  $("link-forgot").addEventListener("click", async () => {
    const email = $("login-email").value.trim();
    if(!email){ $("login-error").textContent = "Digite seu email para redefinir a senha."; return; }
    showLoading("Enviando email…");
    try{
      await forgotPassword(email);
      showToast("Email de redefinição enviado para " + email);
    }catch(err){
      $("login-error").textContent = translateAuthError(err.message);
    }finally{
      hideLoading();
    }
  });

  $("btn-logout").addEventListener("click", logout);
  $("btn-logout-2").addEventListener("click", logout);
  $("btn-mobile-logout").addEventListener("click", logout);

  document.querySelectorAll(".nav-item").forEach(item => {
    item.addEventListener("click", () => switchView(item.dataset.view));
  });

  $("btn-hamburger").addEventListener("click", openMobileSidebar);
  $("sidebar-backdrop").addEventListener("click", closeMobileSidebar);

  $("btn-turn").addEventListener("click", turnCard);
  $("btn-wrong").addEventListener("click", () => answerCard(-1));
  $("btn-warning").addEventListener("click", () => answerCard(0));
  $("btn-correct").addEventListener("click", () => answerCard(1));
  $("btn-correct-plus").addEventListener("click", () => answerCard(3));
  $("btn-sound").addEventListener("click", () => { if(state.currentCardKey) playCardAudio(state.cards[state.currentCardKey]); });

  $("btn-add-word").addEventListener("click", () => {
    addPendingWord($("input-new-word").value);
    $("input-new-word").value = "";
    $("input-new-word").focus();
  });
  $("input-new-word").addEventListener("keydown", (e) => {
    if(e.key === "Enter"){
      addPendingWord($("input-new-word").value);
      $("input-new-word").value = "";
    }
  });
  $("btn-suggest-ten").addEventListener("click", suggestTenWords);
  $("btn-generate-cards").addEventListener("click", generatePendingCards);

  $("btn-save-settings").addEventListener("click", () => {
    const val = $("input-openai-key").value.trim();
    if(val) openaiApiKey = val;
    showToast("Configurações salvas para esta sessão.");
  });

  ["login-email","login-password"].forEach(id=>{
    $(id).addEventListener("keydown", (e) => { if(e.key === "Enter") $("btn-login").click(); });
  });

})();
