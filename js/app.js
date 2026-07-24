(function(){
  "use strict";

  // =========================================================
  // CONFIG
  // =========================================================
  const FIREBASE_API_KEY = "AIzaSyAQqB__M-gKZWHS4zQ1eIA-X6rGqzVtr0I";
  const FIREBASE_DB_URL = "https://anki-71f4f-default-rtdb.firebaseio.com";

  // Chave da OpenAI: carregada do Firebase (/openAiKey) no primeiro uso.
  let openaiApiKey = "";

  const HISTORY_CAP = 500;

  const LANGUAGES = [
    { code:"en", label:"Inglês" },
    { code:"es", label:"Espanhol" },
    { code:"fr", label:"Francês" },
    { code:"de", label:"Alemão" },
    { code:"it", label:"Italiano" },
    { code:"ja", label:"Japonês" },
    { code:"zh", label:"Mandarim" },
    { code:"ko", label:"Coreano" },
    { code:"ru", label:"Russo" },
    { code:"nl", label:"Holandês" }
  ];
  function languageLabel(code){
    const l = LANGUAGES.find(l => l.code === code);
    return l ? l.label : (code || "—");
  }

  // =========================================================
  // STATE
  // =========================================================
  const state = {
    idToken: null,
    uid: null,
    email: null,
    decks: {},          // deckId -> { Name, Language, Theme, CreatedAt, UpdatedAt, Cards:{ wordKey -> card } }
    currentDeckId: null, // baralho selecionado na tela Estudar
    detailDeckId: null,  // baralho aberto na tela de detalhe (gerenciar cards)
    statsDeckId: "all",  // baralho selecionado na tela Estatísticas ("all" = todos)
    currentCardKey: null,
    pendingWords: [],    // [{id, value}]
    audioCache: {},      // "deckId::word" -> object URL
    deckModalMode: null, // "create" | "edit"
    deckModalEditId: null,
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

  function showConfirm({ title, desc, confirmLabel }){
    return new Promise((resolve) => {
      $("confirm-modal-title").textContent = title || "Confirmar ação";
      $("confirm-modal-desc").textContent = desc || "";
      $("confirm-modal-confirm").textContent = confirmLabel || "Confirmar";
      $("confirm-modal").classList.remove("hidden");

      function cleanup(result){
        $("confirm-modal").classList.add("hidden");
        $("confirm-modal-confirm").removeEventListener("click", onConfirm);
        $("confirm-modal-cancel").removeEventListener("click", onCancel);
        resolve(result);
      }
      function onConfirm(){ cleanup(true); }
      function onCancel(){ cleanup(false); }
      $("confirm-modal-confirm").addEventListener("click", onConfirm);
      $("confirm-modal-cancel").addEventListener("click", onCancel);
    });
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
  //   Estrutura, escopada por usuário:
  //   /users/{uid}/Profile                       -> { Email, CreatedAt, LastLogin }
  //   /users/{uid}/Decks/{deckId}                 -> { Name, Language, Theme, CreatedAt, UpdatedAt }
  //   /users/{uid}/Decks/{deckId}/Cards/{wordKey} -> { Word, Phrase, Translation, ScoreHits, ... }
  //   Cada baralho tem idioma e tema próprios, usados para orientar a IA
  //   na geração das frases. Nenhum dado é compartilhado entre contas.
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

  function deckKey(){
    return "d" + Date.now().toString(36) + Math.random().toString(36).slice(2,7);
  }

  function blankCard(word, phrase, translation){
    return {
      Word: word,
      Phrase: phrase,
      Translation: translation,
      ScoreHits: 0, TotalHits: 0,
      CorrectHits: 0, CorrectPlusHits: 0, WarningHits: 0, WrongHits: 0,
      CreatedAt: new Date().toISOString(),
      History: []
    };
  }

  function blankDeck(name, language, theme){
    return {
      Name: name,
      Language: language,
      Theme: theme || "",
      CreatedAt: new Date().toISOString(),
      UpdatedAt: new Date().toISOString(),
      Cards: {}
    };
  }

  async function loadOpenAiKey(){
    const openAiKey = await dbGet(`/openAiKey`);
    openaiApiKey = openAiKey;
  }

  async function ensureOpenAiKey(){
    if(openaiApiKey && openaiApiKey.indexOf("COLE-SUA-CHAVE") === -1) return openaiApiKey;
    try{
      await loadOpenAiKey();
    }catch(err){
      console.warn(err);
    }
    return openaiApiKey;
  }

  async function loadUserDecks(){
    const remote = await dbGet(`/users/${state.uid}/Decks`);
    state.decks = remote || {};
    Object.values(state.decks).forEach(d => { if(!d.Cards) d.Cards = {}; });
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
  // BARALHOS — CRUD
  // =========================================================
  async function createDeck(name, language, theme){
    const id = deckKey();
    const deck = blankDeck(name, language, theme);
    state.decks[id] = deck;
    await dbPut(`/users/${state.uid}/Decks/${id}`, deck);
    return id;
  }

  async function updateDeckMeta(id, patch){
    const payload = Object.assign({}, patch, { UpdatedAt: new Date().toISOString() });
    Object.assign(state.decks[id], payload);
    await dbPatch(`/users/${state.uid}/Decks/${id}`, payload);
  }

  async function deleteDeck(id){
    delete state.decks[id];
    await dbDelete(`/users/${state.uid}/Decks/${id}`);
  }

  function populateLanguageSelect(selectEl){
    selectEl.innerHTML = "";
    LANGUAGES.forEach(l => {
      const opt = document.createElement("option");
      opt.value = l.code;
      opt.textContent = l.label;
      selectEl.appendChild(opt);
    });
  }

  function renderDecksView(){
    const ids = Object.keys(state.decks);
    $("nav-deck-count").textContent = ids.length;
    $("deck-empty-msg").classList.toggle("hidden", ids.length > 0);

    const grid = $("deck-grid");
    grid.innerHTML = "";
    ids.forEach(id => {
      const deck = state.decks[id];
      const cardCount = Object.keys(deck.Cards || {}).length;
      const tile = document.createElement("div");
      tile.className = "study-card deck-card";
      tile.innerHTML = `
        <div class="study-card-title">${escapeHtml(deck.Name)}</div>
        <div class="deck-card-tags">
          <span class="tag tag-sage">${escapeHtml(languageLabel(deck.Language))}</span>
          <span class="tag tag-gold" title="${escapeHtml(deck.Theme || "sem tema")}">${escapeHtml(deck.Theme || "sem tema")}</span>
        </div>
        <div class="card-metrics"><span>${cardCount} card(s)</span></div>
        <div class="deck-card-actions">
          <button class="btn btn-primary btn-sm" data-action="open" title="Abrir">Abrir</button>
          <button class="btn btn-edit btn-sm" data-action="edit" title="Editar">✏️ Editar</button>
          <button class="btn btn-reject btn-sm" data-action="delete" title="Excluir">🗑️ Excluir</button>
        </div>
      `;
      tile.querySelector('[data-action="open"]').addEventListener("click", () => openDeckDetail(id));
      tile.querySelector('[data-action="edit"]').addEventListener("click", () => openDeckModal("edit", id));
      tile.querySelector('[data-action="delete"]').addEventListener("click", () => confirmDeleteDeck(id));
      grid.appendChild(tile);
    });
  }

  async function confirmDeleteDeck(id){
    const deck = state.decks[id];
    if(!deck) return;
    const cardCount = Object.keys(deck.Cards || {}).length;
    const ok = await showConfirm({
      title: "Excluir baralho",
      desc: `Excluir o baralho "${deck.Name}" e ${cardCount === 0 ? "seus cards" : `seus ${cardCount} card(s)`}? Essa ação não pode ser desfeita.`,
      confirmLabel: "Excluir baralho"
    });
    if(!ok) return;
    showLoading("Excluindo baralho…");
    try{
      await deleteDeck(id);
      if(state.currentDeckId === id) state.currentDeckId = null;
      if(state.detailDeckId === id){
        state.detailDeckId = null;
        switchView("view-decks");
      }else{
        renderDecksView();
      }
      populateStudyDeckSelect();
      populateStatsDeckSelect();
      showToast("Baralho excluído.");
    }catch(err){
      showToast(err.message);
    }finally{
      hideLoading();
    }
  }

  function openDeckModal(mode, id){
    state.deckModalMode = mode;
    state.deckModalEditId = id || null;
    $("deck-modal-title").textContent = mode === "edit" ? "Editar baralho" : "Novo baralho";
    if(mode === "edit"){
      const deck = state.decks[id];
      $("deck-input-name").value = deck.Name;
      $("deck-input-language").value = deck.Language;
      $("deck-input-theme").value = deck.Theme || "";
    }else{
      $("deck-input-name").value = "";
      $("deck-input-language").value = LANGUAGES[0].code;
      $("deck-input-theme").value = "";
    }
    $("deck-modal").classList.remove("hidden");
    $("deck-input-name").focus();
  }
  function closeDeckModal(){
    $("deck-modal").classList.add("hidden");
  }

  async function saveDeckModal(){
    const name = $("deck-input-name").value.trim();
    const language = $("deck-input-language").value;
    const theme = $("deck-input-theme").value.trim();
    if(!name){ showToast("Digite um nome para o baralho."); return; }

    showLoading(state.deckModalMode === "edit" ? "Salvando baralho…" : "Criando baralho…");
    try{
      if(state.deckModalMode === "edit"){
        await updateDeckMeta(state.deckModalEditId, { Name: name, Language: language, Theme: theme });
      }else{
        await createDeck(name, language, theme);
      }
      closeDeckModal();
      renderDecksView();
      populateStudyDeckSelect();
      populateStatsDeckSelect();
      if(state.detailDeckId) renderDeckDetailHeader();
      showToast("Baralho salvo.");
    }catch(err){
      showToast(err.message);
    }finally{
      hideLoading();
    }
  }

  // =========================================================
  // DETALHE DO BARALHO — cards
  // =========================================================
  function openDeckDetail(id){
    state.detailDeckId = id;
    state.pendingWords = [];
    switchView("view-deck-detail");
  }

  function renderDeckDetailHeader(){
    const deck = state.decks[state.detailDeckId];
    if(!deck) return;
    $("detail-deck-name").textContent = deck.Name;
    $("detail-deck-lang").textContent = languageLabel(deck.Language);
    $("detail-deck-theme").textContent = deck.Theme || "sem tema";
    $("input-new-word").placeholder = `Digite uma palavra em ${languageLabel(deck.Language)} e pressione Enter`;
  }

  function renderCardGrid(){
    const deck = state.decks[state.detailDeckId];
    if(!deck) return;
    const cards = deck.Cards || {};
    const keys = Object.keys(cards);
    $("deck-count-tag").textContent = `${keys.length} cards`;
    $("empty-msg").classList.toggle("hidden", keys.length > 0);

    const grid = $("card-grid");
    grid.innerHTML = "";
    keys.forEach(key => {
      const card = cards[key];
      const acc = card.TotalHits > 0 ? Math.round((card.ScoreHits / card.TotalHits) * 100) : null;
      const tile = document.createElement("div");
      tile.className = "study-card";
      tile.innerHTML = `
        <div class="study-card-title">${escapeHtml(card.Word)}</div>
        <div class="study-card-meta">${escapeHtml(card.Phrase)}<br><em>${escapeHtml(card.Translation)}</em></div>
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
    const deckId = state.detailDeckId;
    const deck = state.decks[deckId];
    const card = deck.Cards[key];
    showLoading("Gerando nova frase…");
    try{
      const raw = await openaiChat(promptRefreshCard(card, deck));
      const refreshed = extractJson(raw);
      card.Phrase = refreshed.Phrase;
      card.Translation = refreshed.Translation;
      delete state.audioCache[deckId + "::" + card.Word];
      await dbPatch(`/users/${state.uid}/Decks/${deckId}/Cards/${key}`, { Phrase: card.Phrase, Translation: card.Translation });
      renderCardGrid();
      showToast("Frase atualizada.");
    }catch(err){
      showToast(err.message);
    }finally{
      hideLoading();
    }
  }

  async function deleteCard(key){
    const deckId = state.detailDeckId;
    const deck = state.decks[deckId];
    const card = deck.Cards[key];
    const ok = await showConfirm({
      title: "Excluir card",
      desc: `Excluir o card "${card.Word}"?`,
      confirmLabel: "Excluir card"
    });
    if(!ok) return;
    showLoading("Excluindo…");
    try{
      delete deck.Cards[key];
      await dbDelete(`/users/${state.uid}/Decks/${deckId}/Cards/${key}`);
      renderCardGrid();
      renderDecksView();
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
    const deck = state.decks[state.detailDeckId];
    showLoading("Pedindo sugestões para a IA…");
    try{
      const existing = Object.values(deck.Cards || {}).map(c => c.Word);
      const raw = await openaiChat(promptSuggestTenWords(existing, deck));
      const result = extractJson(raw);
      (result.Words || []).forEach(w => addPendingWord(w));
    }catch(err){
      showToast(err.message);
    }finally{
      hideLoading();
    }
  }

  async function generatePendingCards(){
    const deckId = state.detailDeckId;
    const deck = state.decks[deckId];
    const words = state.pendingWords.map(p => p.value.trim()).filter(Boolean);
    if(words.length === 0) return;

    showLoading("Gerando frases com a IA…");
    try{
      deck.Cards = deck.Cards || {};
      const existingWords = Object.values(deck.Cards).map(c => c.Word.toLowerCase());
      const wordsToCreate = words.filter(w => !existingWords.includes(w.toLowerCase()));

      if(wordsToCreate.length === 0){
        showToast("Essas palavras já existem neste baralho.");
        state.pendingWords = [];
        renderPendingList();
        return;
      }

      const raw = await openaiChat(promptGenerateCards(wordsToCreate, deck));
      const result = extractJson(raw);
      const newCards = result.Phrases || [];

      const patchBody = {};
      newCards.forEach(nc => {
        const key = wordKey(nc.Word);
        const card = blankCard(nc.Word, nc.Phrase, nc.Translation);
        deck.Cards[key] = card;
        patchBody[key] = card;
      });

      await dbPatch(`/users/${state.uid}/Decks/${deckId}/Cards`, patchBody);
      state.pendingWords = [];
      renderPendingList();
      renderCardGrid();
      renderDecksView();
      showToast(`${newCards.length} card(s) adicionado(s).`);
    }catch(err){
      showToast(err.message);
    }finally{
      hideLoading();
    }
  }

  // =========================================================
  // TROCAR TEMA DO BARALHO
  // =========================================================
  function openThemeModal(){
    const deck = state.decks[state.detailDeckId];
    if(!deck) return;
    $("theme-input-new").value = deck.Theme || "";
    $("theme-modal").classList.remove("hidden");
    $("theme-input-new").focus();
  }
  function closeThemeModal(){
    $("theme-modal").classList.add("hidden");
  }

  async function applyThemeChange(){
    const newTheme = $("theme-input-new").value.trim();
    if(!newTheme){ showToast("Digite um tema."); return; }

    const deckId = state.detailDeckId;
    const deck = state.decks[deckId];
    const keys = Object.keys(deck.Cards || {});
    closeThemeModal();

    if(keys.length === 0){
      showLoading("Atualizando tema…");
      try{
        await updateDeckMeta(deckId, { Theme: newTheme });
        renderDeckDetailHeader();
        renderDecksView();
        showToast("Tema atualizado.");
      }catch(err){
        showToast(err.message);
      }finally{
        hideLoading();
      }
      return;
    }

    showLoading(`Atualizando frases (0/${keys.length})…`);
    try{
      let done = 0;
      const patchBody = {};
      for(const key of keys){
        const card = deck.Cards[key];
        try{
          const raw = await openaiChat(promptChangeTheme(card, deck, newTheme));
          const refreshed = extractJson(raw);
          card.Phrase = refreshed.Phrase;
          card.Translation = refreshed.Translation;
          patchBody[key] = { Phrase: card.Phrase, Translation: card.Translation };
          delete state.audioCache[deckId + "::" + card.Word];
        }catch(err){
          console.warn("Falha ao atualizar card", card.Word, err);
        }
        done++;
        showLoading(`Atualizando frases (${done}/${keys.length})…`);
      }
      if(Object.keys(patchBody).length > 0){
        await dbPatch(`/users/${state.uid}/Decks/${deckId}/Cards`, patchBody);
      }
      await updateDeckMeta(deckId, { Theme: newTheme });
      renderCardGrid();
      renderDeckDetailHeader();
      renderDecksView();
      showToast("Tema do baralho atualizado.");
    }catch(err){
      showToast(err.message);
    }finally{
      hideLoading();
    }
  }

  // =========================================================
  // SCORING (mesma matemática do app original)
  // =========================================================
  function pickNextCard(cards){
    const keys = Object.keys(cards);
    const weights = keys.map(k => 1 / Math.max(1, cards[k].ScoreHits || 0));
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
    const deckId = state.currentDeckId;
    const key = state.currentCardKey;
    const card = state.decks[deckId].Cards[key];

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
      await dbPut(`/users/${state.uid}/Decks/${deckId}/Cards/${key}`, card);
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
  function populateStudyDeckSelect(){
    const sel = $("study-deck-select");
    const ids = Object.keys(state.decks);
    sel.innerHTML = "";
    if(ids.length === 0){
      sel.innerHTML = '<option value="">Nenhum baralho</option>';
      sel.disabled = true;
      return;
    }
    sel.disabled = false;
    ids.forEach(id => {
      const opt = document.createElement("option");
      opt.value = id;
      opt.textContent = state.decks[id].Name;
      sel.appendChild(opt);
    });
    if(!state.currentDeckId || !state.decks[state.currentDeckId]){
      state.currentDeckId = ids[0];
    }
    sel.value = state.currentDeckId;
  }

  function loadNextCard(){
    const hasDecks = Object.keys(state.decks).length > 0;
    $("study-hero").classList.toggle("hidden", !hasDecks);
    $("study-empty-state").classList.toggle("hidden", hasDecks);
    $("study-deck-select").classList.toggle("hidden", !hasDecks);

    if(!hasDecks){
      $("deck-status").textContent = "Nenhum baralho criado ainda.";
      state.currentCardKey = null;
      return;
    }

    $("flashcard-inner").classList.remove("flipped");
    $("controls-answer").classList.add("hidden");
    $("controls-turn").classList.remove("hidden");

    const deck = state.decks[state.currentDeckId];
    $("study-deck-lang-tag").textContent = languageLabel(deck.Language);
    $("study-deck-theme-tag").textContent = deck.Theme || "sem tema";

    const cards = deck.Cards || {};
    const keys = Object.keys(cards);
    $("deck-status").textContent = `Baralho: ${deck.Name} · ${keys.length} card(s)`;

    if(keys.length === 0){
      state.currentCardKey = null;
      $("card-word").textContent = "Sem cards ainda";
      $("controls-turn").classList.add("hidden");
      return;
    }

    state.currentCardKey = pickNextCard(cards);
    const card = cards[state.currentCardKey];
    $("card-word").textContent = card.Word;
    $("card-phrase").textContent = card.Phrase;
    $("card-translation").textContent = card.Translation;
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
    const key = await ensureOpenAiKey();
    if(!key || key.indexOf("COLE-SUA-CHAVE") !== -1){
      throw new Error("Não foi possível acessar a OpenAI. Tente novamente.");
    }
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method:"POST",
      headers:{
        "Content-Type":"application/json",
        "Authorization": "Bearer " + key
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

  function promptGenerateCards(words, deck){
    const lang = languageLabel(deck.Language);
    const themePart = deck.Theme ? ` sobre o tema "${deck.Theme}"` : "";
    return `Pegue a lista de Palavras, gere frases simples no idioma ${lang}${themePart} usando cada palavra, depois traduza cada frase para Português, ` +
      "e devolva **apenas** no seguinte formato JSON, sem explicações adicionais, sem comentários, sem texto fora do JSON:\n\n" +
      "{\n  \"Phrases\": [\n    { \"Word\": \"WORD1\", \"Phrase\": \"PHRASE1\", \"Translation\": \"TRANSLATION1\" }\n  ]\n}\n\n" +
      "Palavras:\n" + words.join("\n");
  }

  function promptSuggestTenWords(existingWords, deck){
    const lang = languageLabel(deck.Language);
    const themePart = deck.Theme ? ` relacionadas ao tema "${deck.Theme}"` : "";
    return `Analise a lista de palavras em ${lang} enviada, escolha as 10 palavras mais úteis${themePart} que não ` +
      "estejam na lista e devolva **apenas** no seguinte formato JSON, sem explicações adicionais, sem comentários " +
      "e sem texto fora do JSON:\n\n" +
      "{\n  \"Words\": [\n    \"WORD1\",\n    \"WORD2\"\n  ]\n}\n\n" +
      "Palavras:\n" + existingWords.join("\n");
  }

  function promptRefreshCard(card, deck){
    const lang = languageLabel(deck.Language);
    const themePart = deck.Theme ? ` sobre o tema "${deck.Theme}"` : "";
    return `Pegue a Palavra, e gere uma frase SIMPLES no idioma ${lang} com a palavra "${card.Word}"${themePart}, mas diferente de "${card.Phrase}", ` +
      "depois traduza para Português, e devolva **apenas** no seguinte formato JSON, sem explicações " +
      "adicionais, sem comentários, sem texto fora do JSON:\n\n" +
      "{ \"Word\": \"WORD\", \"Phrase\": \"PHRASE\", \"Translation\": \"TRANSLATION\" }";
  }

  function promptChangeTheme(card, deck, newTheme){
    const lang = languageLabel(deck.Language);
    return `Pegue a Palavra "${card.Word}", e gere uma frase SIMPLES no idioma ${lang} usando essa palavra, sobre o tema "${newTheme}", ` +
      "depois traduza para Português, e devolva **apenas** no seguinte formato JSON, sem explicações " +
      "adicionais, sem comentários, sem texto fora do JSON:\n\n" +
      "{ \"Word\": \"WORD\", \"Phrase\": \"PHRASE\", \"Translation\": \"TRANSLATION\" }";
  }

  // =========================================================
  // OPENAI — áudio
  // =========================================================
  async function playCardAudio(deckId, card){
    const cacheKey = deckId + "::" + card.Word;
    if(state.audioCache[cacheKey]){
      new Audio(state.audioCache[cacheKey]).play();
      return;
    }
    showLoading("Gerando áudio…");
    try{
      const key = await ensureOpenAiKey();
      if(!key || key.indexOf("COLE-SUA-CHAVE") !== -1){
        throw new Error("Não foi possível acessar a OpenAI. Tente novamente.");
      }
      const res = await fetch("https://api.openai.com/v1/audio/speech", {
        method:"POST",
        headers:{
          "Content-Type":"application/json",
          "Authorization":"Bearer " + key
        },
        body: JSON.stringify({
          model:"gpt-4o-mini-tts",
          voice:"alloy",
          input: card.Phrase,
          response_format:"mp3"
        })
      });
      if(!res.ok){
        const errText = await res.text();
        throw new Error("Erro ao gerar áudio: " + errText.slice(0,150));
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      state.audioCache[cacheKey] = url;
      new Audio(url).play();
    }catch(err){
      showToast(err.message);
    }finally{
      hideLoading();
    }
  }

  // =========================================================
  // ESTATÍSTICAS
  // =========================================================
  function populateStatsDeckSelect(){
    const sel = $("stats-deck-select");
    const ids = Object.keys(state.decks);
    const current = sel.value || state.statsDeckId || "all";
    sel.innerHTML = '<option value="all">Todos os baralhos</option>';
    ids.forEach(id => {
      const opt = document.createElement("option");
      opt.value = id;
      opt.textContent = state.decks[id].Name;
      sel.appendChild(opt);
    });
    sel.value = (current !== "all" && ids.includes(current)) ? current : "all";
    state.statsDeckId = sel.value;
  }

  function getStatsCards(){
    if(state.statsDeckId && state.statsDeckId !== "all"){
      const deck = state.decks[state.statsDeckId];
      return deck ? Object.values(deck.Cards || {}) : [];
    }
    return Object.values(state.decks).flatMap(d => Object.values(d.Cards || {}));
  }

  function renderStatsView(){
    const cards = getStatsCards();
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
    const sorted = cards.slice().sort((a,b) => {
      const pa = a.TotalHits > 0 ? a.ScoreHits/a.TotalHits : -1;
      const pb = b.TotalHits > 0 ? b.ScoreHits/b.TotalHits : -1;
      return pa - pb;
    });
    const healthList = $("health-list");
    healthList.innerHTML = "";
    if(sorted.length === 0){
      healthList.innerHTML = '<p class="empty-msg">Sem cards para mostrar ainda.</p>';
    }
    sorted.forEach(c => {
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
    const navTargetId = viewId === "view-deck-detail" ? "view-decks" : viewId;
    document.querySelectorAll(".view").forEach(v => v.classList.toggle("active", v.id === viewId));
    document.querySelectorAll(".nav-item").forEach(n => n.classList.toggle("active", n.dataset.view === navTargetId));
    closeMobileSidebar();
    if(viewId === "view-decks") renderDecksView();
    if(viewId === "view-deck-detail"){
      renderDeckDetailHeader();
      renderPendingList();
      renderCardGrid();
    }
    if(viewId === "view-study"){
      populateStudyDeckSelect();
      loadNextCard();
    }
    if(viewId === "view-stats"){
      populateStatsDeckSelect();
      renderStatsView();
    }
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
    showLoading("Carregando seus baralhos…");
    try{
      await ensureProfile();
      await Promise.all([loadUserDecks(), ensureOpenAiKey()]);
      showApp();
      const lastDeck = localStorage.getItem("fluencia:lastDeck");
      if(lastDeck && state.decks[lastDeck]) state.currentDeckId = lastDeck;
      switchView("view-study");
      $("nav-deck-count").textContent = Object.keys(state.decks).length;
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
    state.decks = {};
    state.currentDeckId = null;
    state.detailDeckId = null;
    state.statsDeckId = "all";
    state.currentCardKey = null;
    state.audioCache = {};
    $("app-shell").classList.add("hidden");
    $("screen-login").classList.remove("hidden");
    closeMobileSidebar();
  }

  // =========================================================
  // INIT
  // =========================================================
  populateLanguageSelect($("deck-input-language"));

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
  $("btn-sound").addEventListener("click", () => {
    if(state.currentCardKey) playCardAudio(state.currentDeckId, state.decks[state.currentDeckId].Cards[state.currentCardKey]);
  });

  $("study-deck-select").addEventListener("change", (e) => {
    state.currentDeckId = e.target.value;
    localStorage.setItem("fluencia:lastDeck", state.currentDeckId);
    loadNextCard();
  });

  $("btn-goto-decks").addEventListener("click", () => {
    switchView("view-decks");
    openDeckModal("create");
  });

  $("btn-new-deck").addEventListener("click", () => openDeckModal("create"));
  $("deck-modal-cancel").addEventListener("click", closeDeckModal);
  $("deck-modal-save").addEventListener("click", saveDeckModal);

  $("detail-back").addEventListener("click", () => switchView("view-decks"));
  $("btn-edit-deck").addEventListener("click", () => openDeckModal("edit", state.detailDeckId));
  $("btn-delete-deck").addEventListener("click", () => confirmDeleteDeck(state.detailDeckId));
  $("btn-change-theme").addEventListener("click", openThemeModal);
  $("theme-modal-cancel").addEventListener("click", closeThemeModal);
  $("theme-modal-save").addEventListener("click", applyThemeChange);

  $("stats-deck-select").addEventListener("change", (e) => {
    state.statsDeckId = e.target.value;
    renderStatsView();
  });

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

  ["login-email","login-password"].forEach(id=>{
    $(id).addEventListener("keydown", (e) => { if(e.key === "Enter") $("btn-login").click(); });
  });

})();
