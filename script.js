const N8N_WEBHOOK_URL = 'https://loulous.app.n8n.cloud/webhook-test/jurist-query';
/* =========================================
   RÉFÉRENCES DOM
========================================= */
const micBtn     = document.getElementById('micBtn');
const micLabel   = document.getElementById('micLabel');
const pdfInput   = document.getElementById('pdfInput');
const fileName   = document.getElementById('fileName');
const statusText = document.getElementById('statusText');
const conv       = document.getElementById('conversation');

let isListening  = false;
let recognition  = null;
let currentState = 'idle'; // idle | listening | thinking | speaking

/* =========================================
   STATE MACHINE
========================================= */
const stateLabels = {
  idle:      'En attente',
  listening: 'Écoute en cours…',
  thinking:  'Analyse en cours…',
  speaking:  'Réponse en cours…',
};

function setState(state) {
  document.body.classList.remove('state-thinking', 'state-speaking', 'state-listening');
  if (state !== 'idle') document.body.classList.add(`state-${state}`);
  statusText.textContent = stateLabels[state];
  currentState = state;
}

/* =========================================
   CONVERSATION HELPERS
========================================= */
function getTime() {
  return new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}

function addMessage(html, sender = 'bot') {
  const isBot = sender === 'bot';
  const msg = document.createElement('div');
  msg.className = `message ${isBot ? 'bot-msg' : 'user-msg'}`;
  msg.innerHTML = `
    <div class="msg-avatar">${isBot ? '⚖' : 'Vous'}</div>
    <div class="msg-bubble">
      <p>${html}</p>
      <span class="msg-time">${getTime()}</span>
    </div>
  `;
  conv.appendChild(msg);
  msg.scrollIntoView({ behavior: 'smooth', block: 'end' });
  return msg;
}

function addCitations(citations) {
  if (!citations || citations.length === 0) return;
  const last = conv.querySelector('.bot-msg:last-child .msg-bubble');
  if (!last) return;
  const list = document.createElement('ul');
  list.className = 'citations';
  citations.forEach(c => {
    const li = document.createElement('li');
    li.textContent = typeof c === 'string' ? c : (c.text || c.source || JSON.stringify(c));
    list.appendChild(li);
  });
  last.appendChild(list);
}

function showTyping() {
  const indicator = document.createElement('div');
  indicator.className = 'message bot-msg typing-indicator';
  indicator.id = 'typingIndicator';
  indicator.innerHTML = `
    <div class="msg-avatar">⚖</div>
    <div class="msg-bubble">
      <div class="dots"><span></span><span></span><span></span></div>
    </div>
  `;
  conv.appendChild(indicator);
  indicator.scrollIntoView({ behavior: 'smooth', block: 'end' });
}

function removeTyping() {
  const el = document.getElementById('typingIndicator');
  if (el) el.remove();
}

function showError(msg) {
  removeTyping();
  setState('idle');
  addMessage(`<span style="color:#c94c4c">⚠ ${msg}</span>`, 'bot');
}

/* =========================================
   LECTURE AUDIO (réponse TTS ElevenLabs)
   n8n retourne audio_base64 dans la réponse JSON
========================================= */
function playAudioBase64(base64) {
  return new Promise((resolve) => {
    try {
      const binary = atob(base64);
      const bytes  = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const blob  = new Blob([bytes], { type: 'audio/mpeg' });
      const url   = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audio.onended = () => { URL.revokeObjectURL(url); resolve(); };
      audio.onerror = () => { URL.revokeObjectURL(url); resolve(); };
      audio.play().catch(() => resolve());
    } catch (e) {
      console.warn('[JuridIA] Lecture audio impossible :', e);
      resolve();
    }
  });
}

/* =========================================
   APPEL PRINCIPAL AU WEBHOOK N8N

   Payload envoyé (JSON) :
   ┌────────────────────────────────────────┐
   │ input_type : "text" | "audio"          │
   │ text       : string  (si text)         │
   │ audio_data : base64  (si audio/Whisper)│
   │ pdf_name   : string  (si PDF actif)    │
   │ pdf_data   : base64  (si nouveau PDF)  │
   └────────────────────────────────────────┘

   Réponse attendue de n8n (JSON) :
   ┌────────────────────────────────────────┐
   │ final_answer : string  — texte réponse │
   │ tts_text     : string  — texte TTS     │
   │ citations    : array   — références    │
   │ audio_base64 : string  — audio ElevenL │
   └────────────────────────────────────────┘
========================================= */
let currentPdfName = null;

async function callN8N(payload) {
  setState('thinking');
  showTyping();

  try {
    const response = await fetch(N8N_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(`Erreur serveur : ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    removeTyping();

    // Extraction des champs selon la structure n8n (Parse Orchestrator JSON1)
    const answer    = data.final_answer || data.tts_text || data.response || data.content || 'Réponse reçue.';
    const citations = data.citations || [];
    const audioB64  = data.audio_base64 || data.audio || null;

    // Afficher la réponse textuelle
    addMessage(answer, 'bot');

    // Afficher les citations juridiques si présentes
    addCitations(citations);

    // Lire l'audio ElevenLabs si disponible, sinon simulation
    setState('speaking');
    if (audioB64) {
      await playAudioBase64(audioB64);
    } else {
      const delay = Math.min(answer.length * 40, 5500);
      await new Promise(r => setTimeout(r, delay));
    }
    setState('idle');

  } catch (err) {
    console.error('[JuridIA] Erreur webhook n8n :', err);
    showError(
      `Impossible de joindre le serveur. Vérifiez que le workflow n8n est actif.<br>
       <small style="opacity:.6">${err.message}</small>`
    );
  }
}

/* =========================================
   SPEECH RECOGNITION (Chrome/Edge)
   → transcription locale → envoyé comme "text"
   → n8n reçoit input_type = "text"

   FALLBACK MediaRecorder (Firefox/autres)
   → audio base64 → n8n Whisper (Transcribe Audio1)
   → n8n reçoit input_type = "audio"
========================================= */
let mediaRecorder = null;
let audioChunks   = [];

function setupRecognition() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    startMediaRecorder(); // fallback
    return null;
  }

  const rec = new SpeechRecognition();
  rec.lang           = 'fr-FR';
  rec.interimResults = false;
  rec.maxAlternatives = 1;
  rec.continuous     = false;

  rec.onresult = (event) => {
    const transcript = event.results[0][0].transcript;
    stopListening();
    addMessage(transcript, 'user');
    const payload = { input_type: 'text', text: transcript };
    if (currentPdfName) payload.pdf_name = currentPdfName;
    callN8N(payload);
  };

  rec.onerror = (event) => {
    console.error('SpeechRecognition error :', event.error);
    stopListening();
    if (event.error === 'not-allowed') {
      showError("Accès au microphone refusé. Autorisez-le dans les paramètres du navigateur.");
    } else if (event.error !== 'aborted') {
      addMessage("Je n'ai pas capté votre voix. Veuillez réessayer.", 'bot');
    }
  };

  rec.onend = () => { if (isListening) stopListening(); };
  return rec;
}

async function startMediaRecorder() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioChunks  = [];
    mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });

    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) audioChunks.push(e.data);
    };

    mediaRecorder.onstop = () => {
      stream.getTracks().forEach(t => t.stop());
      const blob   = new Blob(audioChunks, { type: 'audio/webm' });
      const reader = new FileReader();
      reader.onloadend = () => {
        const base64 = reader.result.split(',')[1];
        addMessage('🎤 Message vocal', 'user');
        const payload = { input_type: 'audio', audio_data: base64 };
        if (currentPdfName) payload.pdf_name = currentPdfName;
        callN8N(payload);
      };
      reader.readAsDataURL(blob);
    };

    mediaRecorder.start();
    isListening = true;
    micBtn.classList.add('active');
    micLabel.textContent = 'Arrêter le micro';
    setState('listening');

  } catch (err) {
    showError("Accès au microphone refusé. Autorisez-le dans les paramètres du navigateur.");
    isListening = false;
  }
}

function startListening() {
  if (currentState === 'thinking' || currentState === 'speaking') return;
  const rec = setupRecognition();
  if (rec) {
    recognition = rec;
    isListening = true;
    micBtn.classList.add('active');
    micLabel.textContent = 'Arrêter le micro';
    setState('listening');
    recognition.start();
  }
  // Si rec === null, startMediaRecorder() a déjà été appelé
}

function stopListening() {
  isListening = false;
  micBtn.classList.remove('active');
  micLabel.textContent = 'Activer le micro';
  if (currentState === 'listening') setState('idle');

  if (recognition) {
    try { recognition.stop(); } catch(e) {}
    recognition = null;
  }
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    mediaRecorder.stop(); // → onstop → callN8N
  }
}

micBtn.addEventListener('click', () => {
  if (isListening) stopListening();
  else startListening();
});

/* =========================================
   PDF IMPORT
   Envoie le fichier en base64 vers n8n
========================================= */
pdfInput.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;

  currentPdfName = file.name;
  fileName.textContent = file.name;

  const reader = new FileReader();
  reader.onloadend = () => {
    const base64 = reader.result.split(',')[1];
    addMessage(`📄 Document importé : <strong>${file.name}</strong>`, 'user');

    const payload = {
      input_type: 'text',
      text: `[PDF importé : ${file.name}] Analyse ce document et confirme sa bonne réception.`,
      pdf_name: file.name,
      pdf_data: base64,
    };
    callN8N(payload);
  };
  reader.readAsDataURL(file);
  pdfInput.value = '';
});

/* =========================================
   RACCOURCI CLAVIER : Espace = micro
========================================= */
document.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && e.target === document.body) {
    e.preventDefault();
    if (isListening) stopListening();
    else startListening();
  }
});
