document.getElementById('year').textContent = new Date().getFullYear();

// ── pdf.js setup ──
if (window.pdfjsLib) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
}

// ── State ──
let currentLevel = localStorage.getItem('explaintome-level') || 'eli5';
let conversationHistory = [];
let currentPageTitle = '';
let currentPageUrl = '';
let explainFab = null;
let isPdfMode = false;


// ── DOM ──
const urlInput = document.getElementById('url-input');
const goBtn = document.getElementById('go-btn');
const viewerEmpty = document.getElementById('viewer-empty');
const viewerLoading = document.getElementById('viewer-loading');
const contentFrame = document.getElementById('content-frame');
const pdfViewer = document.getElementById('pdf-viewer');
const panelEmpty = document.getElementById('panel-empty');
const panelChat = document.getElementById('panel-chat');
const selectedTextDisplay = document.getElementById('selected-text-display');
const chatMessages = document.getElementById('chat-messages');
const panelInputArea = document.getElementById('panel-input-area');
const chatInput = document.getElementById('chat-input');
const chatSend = document.getElementById('chat-send');
const panelToggle = document.getElementById('panel-toggle');
const panel = document.getElementById('panel');
const levelBtns = document.querySelectorAll('.level-btn');
const panelEmptyLevel = document.getElementById('panel-empty-level');

const levelDescriptions = {
  eli5: 'ELI5 — Simple words, fun analogies, like explaining to a 5-year-old',
  simple: 'Simple — Plain language, no jargon, clear and accessible',
  detailed: 'Detailed — Thorough explanation with proper terminology',
  expert: 'Expert — Technical deep-dive with edge cases and caveats',
};

function updateLevelDescription() {
  panelEmptyLevel.textContent = levelDescriptions[currentLevel] || '';
}

// ── Level Buttons ──
// Restore saved level on load
levelBtns.forEach(b => b.classList.remove('active'));
document.querySelector(`.level-btn[data-level="${currentLevel}"]`)?.classList.add('active');
updateLevelDescription();

levelBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    levelBtns.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentLevel = btn.dataset.level;
    localStorage.setItem('explaintome-level', currentLevel);
    updateLevelDescription();
  });
});

// ── Theme Toggle ──
const themeToggle = document.getElementById('theme-toggle');
const savedTheme = localStorage.getItem('explaintome-theme') || 'dark';
if (savedTheme === 'light') document.documentElement.classList.add('light');
updateThemeIcon();

themeToggle.addEventListener('click', () => {
  document.documentElement.classList.toggle('light');
  const isLight = document.documentElement.classList.contains('light');
  localStorage.setItem('explaintome-theme', isLight ? 'light' : 'dark');
  updateThemeIcon();
});

function updateThemeIcon() {
  const isLight = document.documentElement.classList.contains('light');
  themeToggle.querySelector('.icon-sun').classList.toggle('hidden', isLight);
  themeToggle.querySelector('.icon-moon').classList.toggle('hidden', !isLight);
}

// ── Panel Toggle ──
panelToggle.addEventListener('click', () => {
  panel.classList.toggle('collapsed');
});

// ── URL Loading ──
goBtn.addEventListener('click', loadUrl);
urlInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') loadUrl();
});

async function loadUrl() {
  let url = urlInput.value.trim();
  if (!url) return;

  // Add protocol if missing
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    url = 'https://' + url;
    urlInput.value = url;
  }

  // Reset state
  resetPanel();
  viewerEmpty.classList.add('hidden');
  contentFrame.classList.add('hidden');
  pdfViewer.classList.add('hidden');
  pdfViewer.innerHTML = '';
  viewerLoading.classList.remove('hidden');

  try {
    const res = await fetch('/api/proxy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });

    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.error || 'Failed to load page');
    }

    currentPageUrl = url;

    if (data.isPdf) {
      // PDF mode: render with pdf.js
      isPdfMode = true;
      contentFrame.classList.add('hidden');
      pdfViewer.classList.remove('hidden');
      viewerLoading.classList.add('hidden');
      currentPageTitle = url.split('/').pop() || 'PDF Document';
      await renderPdf(data.pdfBase64);
    } else {
      // HTML mode: inject into iframe via srcdoc
      isPdfMode = false;
      pdfViewer.classList.add('hidden');
      pdfViewer.innerHTML = '';

      const injectedStyles = `
        <style>
          ::selection { background: rgba(28, 105, 212, 0.35) !important; }
        </style>
      `;

      const baseTag = `<base href="${url}">`;
      let html = data.html;

      if (html.includes('<head>')) {
        html = html.replace('<head>', `<head>${baseTag}${injectedStyles}`);
      } else if (html.includes('<html>')) {
        html = html.replace('<html>', `<html><head>${baseTag}${injectedStyles}</head>`);
      } else {
        html = `<head>${baseTag}${injectedStyles}</head>${html}`;
      }

      contentFrame.srcdoc = html;
      contentFrame.classList.remove('hidden');
      viewerLoading.classList.add('hidden');

      contentFrame.onload = () => {
        setupIframeSelectionListener();
        try {
          currentPageTitle = contentFrame.contentDocument.title || '';
        } catch (e) {
          currentPageTitle = '';
        }
      };
    }

  } catch (err) {
    viewerLoading.classList.add('hidden');
    viewerEmpty.classList.remove('hidden');
    viewerEmpty.querySelector('.viewer-empty-title').textContent = 'COULDN\'T LOAD THIS PAGE';
    viewerEmpty.querySelector('.viewer-empty-sub').textContent = 'Please check that the URL is correct and the website is accessible, then try again.';
  }
}

// ── Iframe Selection Listener ──
function setupIframeSelectionListener() {
  try {
    const iframeDoc = contentFrame.contentDocument || contentFrame.contentWindow.document;

    iframeDoc.addEventListener('mouseup', () => {
      setTimeout(() => {
        const selection = iframeDoc.getSelection();
        const text = selection ? selection.toString().trim() : '';

        removeExplainFab();

        if (text.length > 2) {
          showExplainFab(text, selection, iframeDoc);
        }
      }, 10);
    });
  } catch (e) {
    console.warn('Cannot access iframe content:', e);
  }
}

function showExplainFab(text, selection, iframeDoc) {
  removeExplainFab();

  const range = selection.getRangeAt(0);
  const rect = range.getBoundingClientRect();

  // Capture context now before selection might get cleared
  const surrounding = getSurroundingContext(range, iframeDoc);

  // For iframe content, offset by the iframe's viewport position.
  // For PDF (same document), the rect is already in viewport coordinates.
  const isIframe = iframeDoc !== document;
  const frameRect = isIframe ? contentFrame.getBoundingClientRect() : { left: 0, top: 0 };

  const fab = document.createElement('button');
  fab.className = 'explain-fab';
  fab.textContent = 'EXPLAIN';
  fab.style.left = `${frameRect.left + rect.left + rect.width / 2 - 40}px`;
  fab.style.top = `${frameRect.top + rect.bottom + 8}px`;

  fab.addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();
  });

  fab.addEventListener('click', (e) => {
    e.stopPropagation();
    removeExplainFab();
    triggerExplain(text, surrounding);
  });

  document.body.appendChild(fab);
  explainFab = fab;

  // Remove on next mousedown elsewhere (but not on the fab itself)
  const removeHandler = (e) => {
    if (!fab.contains(e.target)) {
      removeExplainFab();
      document.removeEventListener('mousedown', removeHandler, true);
      if (isIframe) {
        iframeDoc.removeEventListener('mousedown', iframeRemoveHandler, true);
      }
    }
  };
  const iframeRemoveHandler = () => {
    removeExplainFab();
    document.removeEventListener('mousedown', removeHandler, true);
    iframeDoc.removeEventListener('mousedown', iframeRemoveHandler, true);
  };
  setTimeout(() => {
    document.addEventListener('mousedown', removeHandler, true);
    if (isIframe) {
      iframeDoc.addEventListener('mousedown', iframeRemoveHandler, true);
    }
  }, 50);
}

function removeExplainFab() {
  if (explainFab) {
    explainFab.remove();
    explainFab = null;
  }
}

function getSurroundingContext(range, doc) {
  try {
    // Get the parent element and grab a chunk of surrounding text
    let container = range.commonAncestorContainer;
    if (container.nodeType === Node.TEXT_NODE) {
      container = container.parentElement;
    }

    // Walk up to get a meaningful block of context
    let contextEl = container;
    for (let i = 0; i < 3; i++) {
      if (contextEl.parentElement &&
          contextEl.parentElement.textContent.length < 3000 &&
          contextEl.parentElement !== doc.body) {
        contextEl = contextEl.parentElement;
      }
    }

    const text = contextEl.textContent || '';
    // Limit context length
    return text.substring(0, 2000);
  } catch (e) {
    return '';
  }
}

// ── PDF Rendering ──
async function renderPdf(base64Data) {
  pdfViewer.innerHTML = '';

  const binaryStr = atob(base64Data);
  const bytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) {
    bytes[i] = binaryStr.charCodeAt(i);
  }

  const pdf = await pdfjsLib.getDocument({ data: bytes }).promise;

  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const scale = 1.5;
    const viewport = page.getViewport({ scale });

    // Page container
    const pageDiv = document.createElement('div');
    pageDiv.className = 'pdf-page';
    pageDiv.style.width = `${viewport.width}px`;
    pageDiv.style.height = `${viewport.height}px`;

    // Canvas layer
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    pageDiv.appendChild(canvas);

    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport }).promise;

    // Text layer for selection
    const textLayerDiv = document.createElement('div');
    textLayerDiv.className = 'pdf-text-layer';
    pageDiv.appendChild(textLayerDiv);

    const textContent = await page.getTextContent();
    pdfjsLib.renderTextLayer({
      textContent,
      container: textLayerDiv,
      viewport,
      textDivs: [],
    });

    pdfViewer.appendChild(pageDiv);
  }

  setupPdfSelectionListener();
}

function setupPdfSelectionListener() {
  pdfViewer.addEventListener('mouseup', () => {
    setTimeout(() => {
      const selection = document.getSelection();
      const text = selection ? selection.toString().trim() : '';

      removeExplainFab();

      if (text.length > 2) {
        showExplainFab(text, selection, document);
      }
    }, 10);
  });
}

// ── Explain Flow ──
function triggerExplain(selectedText, surroundingContext) {
  // Reset conversation
  conversationHistory = [];
  chatMessages.innerHTML = '';

  // Show panel
  panelEmpty.classList.add('hidden');
  panelChat.classList.remove('hidden');
  panelInputArea.classList.remove('hidden');

  // Show selected text
  selectedTextDisplay.textContent = selectedText;

  // Add assistant message placeholder
  const msgEl = createAssistantMessage();

  // Stream the explanation
  streamExplain({
    selectedText,
    surroundingContext,
    pageTitle: currentPageTitle,
    pageUrl: currentPageUrl,
    level: currentLevel,
    conversationHistory: [],
  }, msgEl);
}

async function streamExplain(payload, msgEl) {
  try {
    const res = await fetch('/api/explain', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    await processStream(res, msgEl);

    // Save to conversation history
    let userMsg = '';
    if (payload.surroundingContext) {
      userMsg += `Context around the selection:\n"""\n${payload.surroundingContext}\n"""\n\n`;
    }
    userMsg += `Highlighted text to explain:\n"""\n${payload.selectedText}\n"""`;

    conversationHistory.push({ role: 'user', content: userMsg });
    conversationHistory.push({ role: 'assistant', content: msgEl.dataset.rawText });

  } catch (err) {
    msgEl.innerHTML = `<p style="color: #ff4444;">Error: ${err.message}</p>`;
  }
}

async function processStream(res, msgEl) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let fullText = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const data = line.slice(6);
        if (data === '[DONE]') break;

        try {
          const parsed = JSON.parse(data);
          if (parsed.text) {
            fullText += parsed.text;
            msgEl.innerHTML = marked.parse(fullText) + '<span class="typing-cursor"></span>';
            msgEl.dataset.rawText = fullText;
            scrollChatToBottom();
          }
        } catch (e) {
          // ignore parse errors
        }
      }
    }
  }

  // Final render without cursor
  msgEl.innerHTML = marked.parse(fullText);
  msgEl.dataset.rawText = fullText;
}

// ── Chat Follow-ups ──
chatSend.addEventListener('click', sendFollowUp);
chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') sendFollowUp();
});

async function sendFollowUp() {
  const message = chatInput.value.trim();
  if (!message) return;

  chatInput.value = '';

  // Add user message to UI
  const userEl = document.createElement('div');
  userEl.className = 'chat-msg user';
  userEl.textContent = message;
  chatMessages.appendChild(userEl);
  scrollChatToBottom();

  // Add assistant message placeholder
  const msgEl = createAssistantMessage();

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message,
        conversationHistory,
        pageTitle: currentPageTitle,
        pageUrl: currentPageUrl,
        level: currentLevel,
      }),
    });

    await processStream(res, msgEl);

    conversationHistory.push({ role: 'user', content: message });
    conversationHistory.push({ role: 'assistant', content: msgEl.dataset.rawText });

  } catch (err) {
    msgEl.innerHTML = `<p style="color: #ff4444;">Error: ${err.message}</p>`;
  }
}

// ── Helpers ──
function createAssistantMessage() {
  const el = document.createElement('div');
  el.className = 'chat-msg assistant';
  el.innerHTML = '<span class="typing-cursor"></span>';
  el.dataset.rawText = '';
  chatMessages.appendChild(el);
  scrollChatToBottom();
  return el;
}

function scrollChatToBottom() {
  const panelContent = document.querySelector('.panel-content');
  panelContent.scrollTop = panelContent.scrollHeight;
}

function resetPanel() {
  conversationHistory = [];
  chatMessages.innerHTML = '';
  panelEmpty.classList.remove('hidden');
  panelChat.classList.add('hidden');
  panelInputArea.classList.add('hidden');
}
