// public/js/catalog.js

function renderProducts(products) {
    const container =
      document.querySelector('#productsGrid') ||
      document.querySelector('#products-grid') ||
      document.querySelector('#products') ||
      document.body;
  
    const html = (products || []).map(product => {
      const img = product.previewImageUrl || product.baseImageUrl || '';
      const price = typeof product.currentPrice === 'number' ? `$${product.currentPrice.toFixed(2)}` : '';
      return `
        <div class="product-card" data-product-id="${product.id}">
          <div class="product-image"
               style="background-image:url('${img}');background-size:cover;background-position:center;padding-top:75%;border-radius:10px;"
               role="img"
               aria-label="${(product.name || 'Product').replace(/"/g, '&quot;')}">
          </div>
          <div class="product-info">
            <div class="product-title">${product.name || ''}</div>
            <div class="product-sku">${product.sku || ''}</div>
            <div class="product-price">${price}</div>
            <div class="product-actions" style="display:flex;gap:8px;flex-wrap:wrap;">
              <button class="btn-bbox"   data-id="${product.id}">BBox</button>
              <button class="btn-mockup" data-id="${product.id}">Mockup</button>
            </div>
          </div>
        </div>
      `;
    }).join('');
  
    container.innerHTML = html;
    window.__products = products;
  
    // Background-image fallback check (preview → base)
    setTimeout(() => {
      (products || []).forEach(product => {
        const tryUrl = product.previewImageUrl || product.baseImageUrl;
        if (!tryUrl) return;
        const testImg = new Image();
        testImg.onerror = () => {
          const imgDiv = container.querySelector(`[data-product-id="${product.id}"] .product-image`);
          if (imgDiv && product.baseImageUrl) {
            imgDiv.style.backgroundImage = `url('${product.baseImageUrl}')`;
          }
        };
        testImg.src = tryUrl;
      });
    }, 0);
  
    container.addEventListener('click', async (e) => {
      const id = e.target?.dataset?.id;
      if (!id) return;
      const product = (window.__products || []).find(p => p.id === id);
      if (!product) return;
  
      if (e.target.classList.contains('btn-bbox')) {
        openBBoxModal(product);
      }
  
      if (e.target.classList.contains('btn-mockup')) {
        const email = prompt('Customer email for S3 folder (required):', localStorage.getItem('customerEmail') || '');
        if (!email) return;
        localStorage.setItem('customerEmail', email);
        const logoUrl = prompt('Logo URL (PNG recommended):', '');
        if (!logoUrl) return;
        try {
          const resp = await fetch(`/api/products/${encodeURIComponent(id)}/mockup`, {
            method: 'POST',
            headers: { 'Content-Type':'application/json' },
            body: JSON.stringify({ email, logoUrl })
          });
          const j = await resp.json();
          if (!resp.ok || !j.ok) throw new Error(j.error || 'mockup failed');
          alert('✅ Mockup generated & uploaded. Refreshing…');
          const qEmail = encodeURIComponent(email);
          fetch(`/api/products?customerEmail=${qEmail}`).then(r => r.json()).then(renderProducts);
        } catch (err) {
          console.error(err);
          alert('❌ Mockup failed: ' + err.message);
        }
      }
    }, { once: true });
  }
  
  /* ====== Minimal in-page BBox labeler (saves to Airtable) ====== */
  function openBBoxModal(product) {
    let modal = document.getElementById('bboxModal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'bboxModal';
      modal.style.cssText = 'display:none;position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:9999;align-items:center;justify-content:center;';
      modal.innerHTML = `
        <div style="background:#fff; border-radius:12px; padding:16px; max-width:90vw; max-height:90vh;">
          <div style="display:flex; align-items:center; gap:8px; margin-bottom:8px;">
            <strong id="bboxTitle">Set Bounding Box</strong>
            <span style="flex:1"></span>
            <button id="bboxClose" style="border:none;background:#eee;padding:6px 10px;border-radius:6px;cursor:pointer;">Close</button>
          </div>
          <div id="bboxCanvasWrap" style="position:relative; overflow:auto; border:1px solid #eee; border-radius:8px;">
            <img id="bboxImg" src="" alt="product" style="max-width:85vw; max-height:70vh; display:block;">
            <canvas id="bboxCanvas" style="position:absolute; left:0; top:0;"></canvas>
          </div>
          <div style="display:flex; gap:8px; margin-top:12px; align-items:center;">
            <label>Area name</label>
            <input id="bboxAreaName" type="text" value="right_chest" style="padding:6px 8px;border:1px solid #ccc;border-radius:6px;">
            <span style="flex:1"></span>
            <button id="bboxClear" style="background:#eee;border:none;padding:8px 12px;border-radius:8px;cursor:pointer;">Clear</button>
            <button id="bboxSave"  style="background:#111;color:#fff;border:none;padding:8px 12px;border-radius:8px;cursor:pointer;">Save</button>
          </div>
        </div>`;
      document.body.appendChild(modal);
    }
  
    const imgEl = document.getElementById('bboxImg');
    const canvas = document.getElementById('bboxCanvas');
    const title = document.getElementById('bboxTitle');
    const areaInput = document.getElementById('bboxAreaName');
  
    title.textContent = `Set Bounding Box — ${product.name}`;
    imgEl.src = product.baseImageUrl;
  
    let start = null;
    let rect = null;
  
    function resizeCanvas() {
      canvas.width  = imgEl.clientWidth;
      canvas.height = imgEl.clientHeight;
      canvas.style.width  = imgEl.clientWidth + 'px';
      canvas.style.height = imgEl.clientHeight + 'px';
      draw();
    }
  
    function draw() {
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0,0,canvas.width,canvas.height);
      if (!rect) return;
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#e53e3e';
      ctx.setLineDash([6,4]);
      const {x,y,w,h} = rect;
      ctx.strokeRect(x,y,w,h);
    }
  
    function toNaturalCoords(r) {
      const scaleX = imgEl.naturalWidth  / imgEl.clientWidth;
      const scaleY = imgEl.naturalHeight / imgEl.clientHeight;
      const x1 = Math.round(r.x * scaleX);
      const y1 = Math.round(r.y * scaleY);
      const x2 = Math.round((r.x + r.w) * scaleX);
      const y2 = Math.round((r.y + r.h) * scaleY);
      return { x1, y1, x2, y2 };
    }
  
    function onDown(ev) {
      const b = canvas.getBoundingClientRect();
      start = { x: ev.clientX - b.left, y: ev.clientY - b.top };
      rect = { x:start.x, y:start.y, w:0, h:0 };
      draw();
    }
    function onMove(ev) {
      if (!start) return;
      const b = canvas.getBoundingClientRect();
      const x = ev.clientX - b.left, y = ev.clientY - b.top;
      rect.w = x - rect.x; rect.h = y - rect.y;
      draw();
    }
    function onUp() { start = null; }
  
    function clearBox() { rect = null; draw(); }
  
    function saveBox() {
      if (!rect) { alert('Draw a box first.'); return; }
      const n = toNaturalCoords({
        x: Math.min(rect.x, rect.x+rect.w),
        y: Math.min(rect.y, rect.y+rect.h),
        w: Math.abs(rect.w),
        h: Math.abs(rect.h)
      });
      const payload = {
        boxes: [{ name: (areaInput.value || 'right_chest'), x1:n.x1, y1:n.y1, x2:n.x2, y2:n.y2 }]
      };
      fetch(`/api/products/${encodeURIComponent(product.id)}/boxes`, {
        method: 'POST',
        headers: { 'Content-Type':'application/json' },
        body: JSON.stringify(payload)
      }).then(r => r.json()).then(j => {
        if (!j.ok) throw new Error(j.error || 'Save failed');
        alert('✅ Saved bounding box to Airtable');
        close();
      }).catch(err => {
        console.error(err);
        alert('❌ Failed to save: ' + err.message);
      });
    }
  
    function open() {
      modal.style.display = 'flex';
      setTimeout(() => resizeCanvas(), 50);
    }
    function close() {
      modal.style.display = 'none';
      canvas.removeEventListener('mousedown', onDown);
      canvas.removeEventListener('mousemove', onMove);
      canvas.removeEventListener('mouseup',   onUp);
    }
  
    document.getElementById('bboxClose').onclick = close;
    document.getElementById('bboxClear').onclick = clearBox;
    document.getElementById('bboxSave').onclick  = saveBox;
    imgEl.onload = resizeCanvas;
    window.addEventListener('resize', resizeCanvas);
  
    canvas.addEventListener('mousedown', onDown);
    canvas.addEventListener('mousemove', onMove);
    canvas.addEventListener('mouseup',   onUp);
  
    open();
  }
  
  // --- bootstrapping (fetch and render) ---
  function getQueryParam(name) {
    const params = new URLSearchParams(window.location.search);
    return params.get(name) || '';
  }
  function sanitizeEmail(email) { return (email || '').trim(); }
  
  async function fetchAndRenderProducts(customerEmail) {
    try {
      const q = customerEmail ? `?customerEmail=${encodeURIComponent(customerEmail)}` : '';
      const resp = await fetch(`/api/products${q}`, { headers: { 'Accept': 'application/json' } });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const products = await resp.json();
      if (!Array.isArray(products)) throw new Error('Unexpected response shape');
      renderProducts(products);
    } catch (err) {
      console.error('Failed to load products:', err);
      const container =
        document.querySelector('#productsGrid') ||
        document.querySelector('#products-grid') ||
        document.querySelector('#products') ||
        document.body;
      container.innerHTML = `<div class="error">Sorry, we couldn't load products. Please try again.</div>`;
    }
  }
  
  function initCatalog() {
    const LS_KEY = 'customerEmail';
    const emailInput = document.querySelector('#customerEmail, input[name="customerEmail"]');
    const applyBtn   = document.querySelector('#applyEmail, #apply-email');
  
    let email = getQueryParam('customerEmail') || localStorage.getItem(LS_KEY) || '';
    if (emailInput) emailInput.value = email;
  
    function applyEmail(value) {
      const v = sanitizeEmail(value);
      localStorage.setItem(LS_KEY, v || '');
      const url = new URL(window.location.href);
      if (v) url.searchParams.set('customerEmail', v);
      else url.searchParams.delete('customerEmail');
      window.history.replaceState({}, '', url.toString());
      fetchAndRenderProducts(v);
    }
  
    if (applyBtn) applyBtn.addEventListener('click', () => applyEmail(emailInput?.value || ''));
    if (emailInput) {
      emailInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); applyEmail(emailInput.value); }
      });
      emailInput.addEventListener('change', () => applyEmail(emailInput.value));
    }
  
    fetchAndRenderProducts(email);
  }
  
  document.addEventListener('DOMContentLoaded', initCatalog);
  