// gallery — solid-apps/gallery
//
// Photo albums on your Solid pod, using the suite's established model
// (the same one hub's Photos pane reads):
//
//   - an album is an LDP container of image resources, e.g. /public/photo/<slug>/
//   - each album is registered in your TypeIndex as a schema:ImageGallery
//     (solid:instanceContainer), so hub / pilot / gallery all discover it.
//   - public albums → /public/photo/ + solid:publicTypeIndex (default).
//     private albums → /private/photo/ + solid:privateTypeIndex.
//
// gallery is the standalone, full-screen sibling of hub's pane: browse, create
// albums, upload, lightbox, delete, and hand a photo/album to webacl (share)
// or any app via the `file` intent. `camera` writes new shots into these same
// albums.
//
// TypeIndex + gallery helpers are ported from hub/src/pod.js so behaviour and
// on-pod shape stay identical across the suite.

const LDP_NS    = 'http://www.w3.org/ns/ldp#'
const SOLID_NS  = 'http://www.w3.org/ns/solid/terms#'
const PIM_NS    = 'http://www.w3.org/ns/pim/space#'
const IMAGE_CLASSES = [
  'http://schema.org/ImageGallery', 'http://schema.org/Photograph',
  'http://schema.org/Photo', 'http://schema.org/ImageObject',
  'http://xmlns.com/foaf/0.1/Image'
]
const IMG_RE = /\.(jpe?g|png|gif|webp|avif|bmp|svg|heic|heif)$/i
// Shared thumbnail convention with camera: full <stem>.<ext> → <stem>.thumb.jpg
const THUMB_RE = /\.thumb\.jpg$/i
function thumbName(name) { return name.replace(/\.[^.]+$/, '') + '.thumb.jpg' }

const state = {
  loading: false,
  error: null,
  albums: [],          // [{ url, label, private, images:[{url,name}], loaded }]
  view: 'albums',      // 'albums' | 'album'
  active: null,        // album url
  lightbox: null,      // { albumUrl, idx } | { external: url }
  incoming: null       // a `file` intent value awaiting "save to album"
}

// --- auth + xlogin ---
function authFetch(url, opts) {
  if (window.xlogin && window.xlogin.id && window.xlogin.authFetch) return window.xlogin.authFetch(url, opts)
  return fetch(url, opts)
}
function meWebId() { return (window.xlogin && window.xlogin.id) || null }
function loggedIn() { return !!meWebId() }

// --- JSON-LD helpers (ported from hub/src/pod.js) ---
const idOf = v => typeof v === 'string' ? v : (v && v['@id']) || null
function valueOf(v) {
  if (v == null) return null
  if (typeof v === 'string') return v
  if (Array.isArray(v)) return v.length ? valueOf(v[0]) : null
  return v['@id'] || v['@value'] || null
}
function isHttpUrl(s) { try { const u = new URL(s); return u.protocol === 'http:' || u.protocol === 'https:' } catch { return false } }
function parseLooseJson(s) {
  try { return JSON.parse(s) } catch {
    try { return JSON.parse(s.replace(/,(\s*[\}\]])/g, '$1')) } catch (e) { throw new Error('JSON-LD parse: ' + e.message) }
  }
}
function findSubject(doc, frag) {
  const g = Array.isArray(doc['@graph']) ? doc['@graph'] : Array.isArray(doc) ? doc : [doc]
  if (frag) { const m = g.find(n => (n['@id'] || '').endsWith('#' + frag)); if (m) return m }
  return g[0] || {}
}
async function getJsonLd(url) {
  const r = await authFetch(url, { headers: { Accept: 'application/ld+json' } })
  if (r.status === 404) return null
  if (!r.ok) throw new Error(`GET ${r.status} (${url})`)
  const ct = (r.headers.get('content-type') || '').toLowerCase()
  if (ct.includes('ld+json') || ct.includes('application/json')) return r.json()
  if (ct.includes('text/html')) {
    const html = await r.text()
    const m = html.match(/<script\s+type=["']application\/ld\+json["']\s*>([\s\S]*?)<\/script>/i)
    return m ? parseLooseJson(m[1].trim()) : null
  }
  throw new Error(`pod returned ${ct || 'unknown type'} (need JSON-LD)`)
}
async function putJsonLd(url, body) {
  const r = await authFetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/ld+json' }, body: JSON.stringify(body, null, 2) })
  if (!r.ok) throw new Error(`PUT ${r.status} (${url})`)
  return r
}
async function deleteResource(url) {
  const r = await authFetch(url, { method: 'DELETE' })
  if (!r.ok && r.status !== 404) throw new Error(`DELETE ${r.status} (${url})`)
  return r
}
async function ensureContainer(url) {
  const u = url.replace(/\/?$/, '/')
  const head = await authFetch(u, { method: 'HEAD' }).catch(() => null)
  if (head && head.ok) return
  const r = await authFetch(u, { method: 'PUT', headers: { 'Content-Type': 'text/turtle', Link: '<http://www.w3.org/ns/ldp#BasicContainer>; rel="type"' }, body: '' })
  if (!r.ok && r.status !== 409) throw new Error(`ensureContainer ${r.status}`)
}
async function listContainer(url) {
  const doc = await getJsonLd(url)
  if (!doc) return []
  const subj = findSubject(doc, null)
  const contains = subj['ldp:contains'] ?? subj[LDP_NS + 'contains'] ?? subj['contains']
  if (!contains) return []
  const arr = Array.isArray(contains) ? contains : [contains]
  return arr.map(item => {
    const id = valueOf(item) || item
    const type = (typeof item === 'object' && item['@type']) || null
    const isCont = id?.endsWith('/') || /Container/i.test(JSON.stringify(type || ''))
    return { url: id, type: isCont ? 'container' : 'resource' }
  }).filter(x => x.url && typeof x.url === 'string')
}

// --- storage + TypeIndex ---
async function discoverStorage(webid) {
  if (!isHttpUrl(webid)) return null
  try {
    const url = webid.replace(/#.*$/, '')
    const doc = await getJsonLd(url)
    if (doc) {
      const subj = findSubject(doc, webid.includes('#') ? webid.split('#')[1] : null)
      const v = subj['pim:storage'] ?? subj[PIM_NS + 'storage'] ?? subj['space:storage'] ?? subj['storage']
      const id = valueOf(v)
      if (id) { try { return new URL(id, url).href.replace(/\/?$/, '/') } catch { return id.replace(/\/?$/, '/') } }
    }
  } catch {}
  try { return new URL(webid).origin + '/' } catch { return null }
}
// which: 'public' | 'private'
async function fetchTypeIndex(webid, which = 'public') {
  if (!isHttpUrl(webid)) throw new Error('WebID is not an http(s) URL')
  const doc = await getJsonLd(webid.replace(/#.*$/, ''))
  if (!doc) throw new Error('WebID document not found')
  const subj = findSubject(doc, webid.includes('#') ? webid.split('#')[1] : null)
  const key = which === 'private' ? 'privateTypeIndex' : 'publicTypeIndex'
  const ref = subj[`solid:${key}`] ?? subj[SOLID_NS + key] ?? subj[key]
  const tiId = idOf(ref)
  if (!tiId) return null
  const tiUrl = new URL(tiId, webid).href
  const ti = await getJsonLd(tiUrl).catch(() => null)
  if (!ti) return { typeIndexUrl: tiUrl, registrations: [] }
  const nodes = []
  const collect = x => {
    if (!x || typeof x !== 'object') return
    if (Array.isArray(x)) { x.forEach(collect); return }
    if (x['solid:forClass'] || x[SOLID_NS + 'forClass']) nodes.push(x)
    for (const v of Object.values(x)) if (typeof v === 'object') collect(v)
  }
  collect(ti)
  const regs = nodes.map(n => ({
    forClass: idOf(n['solid:forClass'] ?? n[SOLID_NS + 'forClass']),
    instance: idOf(n['solid:instance'] ?? n[SOLID_NS + 'instance']),
    instanceContainer: idOf(n['solid:instanceContainer'] ?? n[SOLID_NS + 'instanceContainer'])
  })).filter(r => r.forClass && (r.instance || r.instanceContainer))
  regs.forEach(r => {
    if (r.instance && !/^https?:/.test(r.instance)) r.instance = new URL(r.instance, tiUrl).href
    if (r.instanceContainer && !/^https?:/.test(r.instanceContainer)) r.instanceContainer = new URL(r.instanceContainer, tiUrl).href
  })
  return { typeIndexUrl: tiUrl, registrations: regs }
}
async function addTypeRegistration(typeIndexUrl, { forClass, instanceContainer }) {
  const doc = await getJsonLd(typeIndexUrl)
  if (!doc) throw new Error('TypeIndex not found')
  const reg = { '@id': '#reg-' + Math.random().toString(36).slice(2, 9), '@type': 'solid:TypeRegistration', 'solid:forClass': { '@id': forClass }, 'solid:instanceContainer': { '@id': instanceContainer } }
  if (Array.isArray(doc['schema:itemListElement'])) doc['schema:itemListElement'].push(reg)
  else if (Array.isArray(doc['@graph'])) doc['@graph'].push(reg)
  else doc['schema:itemListElement'] = [reg]
  await putJsonLd(typeIndexUrl, doc)
}
async function removeTypeRegistration(typeIndexUrl, url) {
  const doc = await getJsonLd(typeIndexUrl)
  if (!doc) return false
  const matches = reg => {
    const c = idOf(reg['solid:instanceContainer'] ?? reg[SOLID_NS + 'instanceContainer'])
    const i = idOf(reg['solid:instance'] ?? reg[SOLID_NS + 'instance'])
    return c === url || i === url
  }
  let removed = false
  for (const k of ['schema:itemListElement', '@graph']) {
    if (Array.isArray(doc[k])) { const before = doc[k].length; doc[k] = doc[k].filter(r => !matches(r)); if (doc[k].length < before) removed = true }
  }
  if (removed) await putJsonLd(typeIndexUrl, doc)
  return removed
}
function slugify(s) {
  return String(s || '').toLowerCase().replace(/[^\w\s-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 60)
}

// --- discover albums ---
async function loadAlbums() {
  const webid = meWebId()
  if (!webid) { state.albums = []; return }
  const storage = await discoverStorage(webid)
  const found = new Map()  // url → {url,label,private}
  for (const which of ['public', 'private']) {
    const ti = await fetchTypeIndex(webid, which).catch(() => null)
    if (!ti) continue
    for (const r of ti.registrations) {
      if (!IMAGE_CLASSES.includes(r.forClass) || !r.instanceContainer) continue
      if (!found.has(r.instanceContainer)) {
        found.set(r.instanceContainer, { url: r.instanceContainer, label: albumLabel(r.instanceContainer), private: which === 'private' })
      }
    }
  }
  state.albums = [...found.values()].sort((a, b) => a.label.localeCompare(b.label))
  state._storage = storage
}
function albumLabel(url) {
  const name = decodeURIComponent(url.replace(/\/$/, '').split('/').pop() || 'photos')
  return name.replace(/-/g, ' ')
}
async function loadAlbumImages(album) {
  if (album.loaded) return
  const members = await listContainer(album.url).catch(() => [])
  const base = album.url.replace(/\/?$/, '/')
  // All resource basenames in the album — lets us pair a photo with its
  // thumbnail from the listing we already have (no extra requests).
  const names = new Set(members.filter(m => m.type === 'resource').map(m => decodeURIComponent(m.url.split('/').pop())))
  album.images = members
    .filter(m => m.type === 'resource' && IMG_RE.test(m.url) && !/\/\.[^/]*$/.test(m.url) && !THUMB_RE.test(m.url))
    .map(m => {
      const name = decodeURIComponent(m.url.split('/').pop())
      const tn = thumbName(name)
      return { url: m.url, name, thumb: names.has(tn) ? base + encodeURIComponent(tn) : null }
    })
  album.loaded = true
}

// --- create album + upload ---
async function createAlbum(name, isPrivate) {
  const webid = meWebId()
  const storage = await discoverStorage(webid)
  if (!storage) throw new Error("Couldn't find your pod root")
  const slug = slugify(name)
  if (!slug) throw new Error('Please enter a name')
  const base = isPrivate ? `${storage}private/photo/` : `${storage}public/photo/`
  const container = `${base}${slug}/`
  await ensureContainer(isPrivate ? `${storage}private/` : `${storage}public/`).catch(() => {})
  await ensureContainer(base).catch(() => {})
  await ensureContainer(container)
  const ti = await fetchTypeIndex(webid, isPrivate ? 'private' : 'public')
  if (ti) await addTypeRegistration(ti.typeIndexUrl, { forClass: IMAGE_CLASSES[0], instanceContainer: container })
  return container
}
async function uploadImage(albumUrl, file, name) {
  const fname = (name || file.name || `img-${Date.now()}`).replace(/[^\w.\-]/g, '_')
  const url = albumUrl.replace(/\/?$/, '/') + encodeURIComponent(fname)
  const r = await authFetch(url, { method: 'PUT', headers: { 'Content-Type': file.type || 'application/octet-stream' }, body: file })
  if (!r.ok) throw new Error(`upload ${r.status}`)
  return url
}

// =====================================================================
// Render
// =====================================================================
const $ = s => document.querySelector(s)
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])) }

function render() {
  const app = $('#app')
  if (state.error) { app.innerHTML = `<div class="card error">${esc(state.error)}</div>`; return }
  if (!loggedIn()) { app.innerHTML = signinNote(); bind(); return }
  if (state.loading) { app.innerHTML = `<div class="card muted">Loading your albums…</div>`; return }
  if (state.incoming) { app.innerHTML = incomingView(); bind(); return }
  app.innerHTML = state.view === 'album' ? albumView() : albumsView()
  bind()
  if (state.lightbox) mountLightbox()
}

function signinNote() {
  return `<div class="card welcome">
    <h2>Your photos, on your pod</h2>
    <p>Sign in to see your albums. gallery reads image collections registered in
       your TypeIndex as <code>schema:ImageGallery</code> — the same ones
       <b>hub</b> and <b>camera</b> use.</p>
    <p class="muted">Public albums live under <code>/public/photo/</code>; private
       ones under <code>/private/photo/</code>.</p>
  </div>`
}

function albumsView() {
  const cards = state.albums.map(a => `
    <button class="album" data-album="${esc(a.url)}">
      <span class="album-cover" data-cover="${esc(a.url)}">🖼️</span>
      <span class="album-name">${esc(a.label)} ${a.private ? '<span class="lock" title="private">🔒</span>' : ''}</span>
    </button>`).join('')
  return `
    <div class="bar">
      <h2 class="h">Albums</h2>
      <span class="spacer"></span>
      <button class="go" id="new-album">+ New album</button>
    </div>
    ${state.albums.length ? `<div class="album-grid">${cards}</div>`
      : `<div class="card muted">No albums yet. Create one, then add photos (or shoot them in <b>camera</b>).</div>`}`
}

function albumView() {
  const a = state.albums.find(x => x.url === state.active)
  if (!a) { state.view = 'albums'; return albumsView() }
  const imgs = (a.images || [])
  const grid = imgs.map((im, i) => `
    <button class="thumb" data-open="${i}">
      <img loading="lazy" decoding="async" src="${esc(im.thumb || im.url)}" onerror="this.onerror=null;this.src='${esc(im.url)}'" alt="${esc(im.name)}">
    </button>`).join('')
  return `
    <div class="bar">
      <button class="mini" id="back">← Albums</button>
      <h2 class="h">${esc(a.label)} ${a.private ? '🔒' : ''}</h2>
      <span class="spacer"></span>
      <button class="mini" id="album-perms" title="Share / permissions in webacl">Permissions</button>
      <button class="go" id="add-photos">+ Add photos</button>
    </div>
    <div class="drop" id="drop">
      ${imgs.length ? `<div class="thumb-grid">${grid}</div>`
        : `<div class="card muted">No photos yet. <b>+ Add photos</b> or drop files here.</div>`}
    </div>`
}

function incomingView() {
  const url = state.incoming
  const opts = state.albums.filter(a => !a.private).map(a => `<option value="${esc(a.url)}">${esc(a.label)}</option>`).join('')
  return `<div class="card">
    <div class="eyebrow">Incoming image</div>
    <img class="incoming-img" src="${esc(url)}" alt="incoming">
    <div class="bar" style="margin-top:.8rem">
      <select id="save-target">${opts || '<option value="">(no public albums — create one first)</option>'}</select>
      <button class="go" id="save-incoming" ${state.albums.some(a=>!a.private)?'':'disabled'}>Save to album</button>
      <button class="mini" id="dismiss-incoming">Dismiss</button>
    </div>
  </div>`
}

// --- lightbox ---
function mountLightbox() {
  const lb = $('#lightbox')
  const a = state.albums.find(x => x.url === state.active)
  if (!a || !a.images || !a.images.length) { lb.hidden = true; return }
  const i = Math.max(0, Math.min(state.lightbox.idx, a.images.length - 1))
  const im = a.images[i]
  lb.hidden = false
  lb.innerHTML = `
    <div class="lb-bar">
      <span class="lb-name">${esc(im.name)} <span class="muted">${i + 1}/${a.images.length}</span></span>
      <span class="spacer"></span>
      <button class="lb-btn" data-act="open">Open with…</button>
      <button class="lb-btn" data-act="perms">Permissions</button>
      <button class="lb-btn danger" data-act="del">Delete</button>
      <button class="lb-btn" data-act="close">✕</button>
    </div>
    <button class="lb-nav prev" data-act="prev" ${a.images.length<2?'hidden':''}>‹</button>
    <img class="lb-img" src="${esc(im.url)}" alt="${esc(im.name)}">
    <button class="lb-nav next" data-act="next" ${a.images.length<2?'hidden':''}>›</button>`
  lb.querySelectorAll('[data-act]').forEach(b => b.onclick = e => { e.stopPropagation(); lbAction(b.dataset.act, i, im) })
  lb.onclick = e => { if (e.target === lb) closeLightbox() }
}
function closeLightbox() { state.lightbox = null; const lb = $('#lightbox'); lb.hidden = true; lb.innerHTML = '' }
async function lbAction(act, i, im) {
  const a = state.albums.find(x => x.url === state.active)
  if (act === 'close') return closeLightbox()
  if (act === 'prev') { state.lightbox.idx = (i - 1 + a.images.length) % a.images.length; return mountLightbox() }
  if (act === 'next') { state.lightbox.idx = (i + 1) % a.images.length; return mountLightbox() }
  if (act === 'open') { if (window.intent) window.intent.open('file', im.url, im.name); else toast('Install other apps to open-with.'); return }
  if (act === 'perms') { openInWebacl(im.url); return }
  if (act === 'del') {
    if (!confirm(`Delete ${im.name}? This removes it from your pod.`)) return
    try { await deleteResource(im.url); a.images.splice(i, 1); toast('Deleted'); if (!a.images.length) closeLightbox(); else { state.lightbox.idx = Math.min(i, a.images.length - 1); mountLightbox() }; render() }
    catch (e) { toast('Delete failed: ' + e.message) }
  }
}

function openInWebacl(url) {
  // Hand the resource to webacl via the intent bus (it handles `url`).
  if (window.intent && window.intent.open) window.intent.open('url', url, 'permissions')
  else { toast('Install webacl to manage permissions.'); }
}

// --- events ---
function bind() {
  const app = $('#app')
  const nb = $('#new-album'); if (nb) nb.onclick = onNewAlbum
  const back = $('#back'); if (back) back.onclick = () => { state.view = 'albums'; state.active = null; render() }
  const add = $('#add-photos'); if (add) add.onclick = () => pickFiles(state.active)
  const ap = $('#album-perms'); if (ap) ap.onclick = () => openInWebacl(state.active)
  app.querySelectorAll('[data-album]').forEach(b => b.onclick = () => openAlbum(b.dataset.album))
  app.querySelectorAll('[data-open]').forEach(b => b.onclick = () => { state.lightbox = { idx: +b.dataset.open }; mountLightbox() })
  // album cover preview
  app.querySelectorAll('[data-cover]').forEach(async el => {
    const a = state.albums.find(x => x.url === el.dataset.cover)
    if (a) { await loadAlbumImages(a); const c = a.images && a.images[0]; if (c) el.innerHTML = `<img loading="lazy" src="${esc(c.thumb || c.url)}" onerror="this.onerror=null;this.src='${esc(c.url)}'" alt="">` }
  })
  const drop = $('#drop'); if (drop) wireDrop(drop)
  const si = $('#save-incoming'); if (si) si.onclick = saveIncoming
  const di = $('#dismiss-incoming'); if (di) di.onclick = () => { state.incoming = null; render() }
}

async function onNewAlbum() {
  const name = prompt('Album name:')
  if (!name) return
  const isPrivate = confirm('Make this album PRIVATE (owner-only, under /private/)?\n\nOK = private · Cancel = public')
  try {
    const url = await createAlbum(name, isPrivate)
    toast('Album created')
    await loadAlbums()
    openAlbum(url)
  } catch (e) { toast('Could not create: ' + e.message) }
}
async function openAlbum(url) {
  state.active = url; state.view = 'album'
  const a = state.albums.find(x => x.url === url)
  render()
  if (a) { try { await loadAlbumImages(a); render() } catch (e) { toast('Could not list album: ' + e.message) } }
}
function pickFiles(albumUrl) {
  const inp = $('#filepick')
  inp.value = ''
  inp.onchange = async () => {
    const files = [...inp.files]
    await uploadMany(albumUrl, files)
  }
  inp.click()
}
async function uploadMany(albumUrl, files) {
  if (!files.length) return
  const a = state.albums.find(x => x.url === albumUrl)
  let ok = 0
  toast(`Uploading ${files.length}…`, 60000)
  for (const f of files) {
    if (!f.type.startsWith('image/')) continue
    try { const url = await uploadImage(albumUrl, f); a.images = a.images || []; a.images.push({ url, name: decodeURIComponent(url.split('/').pop()) }); ok++ } catch (e) { console.warn(e) }
  }
  toast(`Added ${ok} photo${ok === 1 ? '' : 's'}`)
  render()
}
function wireDrop(el) {
  el.addEventListener('dragover', e => { e.preventDefault(); el.classList.add('over') })
  el.addEventListener('dragleave', () => el.classList.remove('over'))
  el.addEventListener('drop', e => { e.preventDefault(); el.classList.remove('over'); uploadMany(state.active, [...e.dataTransfer.files]) })
}
async function saveIncoming() {
  const target = $('#save-target').value
  const url = state.incoming
  if (!target || !url) return
  try {
    const r = await fetch(url); const blob = await r.blob()
    const name = decodeURIComponent(url.split('/').pop()) || `img-${Date.now()}.jpg`
    await uploadImage(target, new File([blob], name, { type: blob.type }), name)
    state.incoming = null
    toast('Saved to album')
    await loadAlbums(); openAlbum(target)
  } catch (e) { toast('Save failed: ' + e.message) }
}

// --- toast ---
let toastTimer = null
function toast(msg, ms = 3000) { const el = $('#toast'); el.textContent = msg; el.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => el.hidden = true, ms) }

// --- keyboard ---
document.addEventListener('keydown', e => {
  if (!state.lightbox) return
  if (e.key === 'Escape') closeLightbox()
  else if (e.key === 'ArrowLeft') { const b = document.querySelector('[data-act="prev"]'); if (b) b.click() }
  else if (e.key === 'ArrowRight') { const b = document.querySelector('[data-act="next"]'); if (b) b.click() }
})

// --- init ---
async function refresh() {
  state.loading = true; state.error = null; render()
  try { await loadAlbums() } catch (e) { state.error = e.message } finally { state.loading = false; render() }
}
document.addEventListener('xlogin', refresh)
document.addEventListener('xlogout', () => { state.albums = []; state.view = 'albums'; state.active = null; render() })

;(function init() {
  const i = window.intent && window.intent.receive && window.intent.receive()
  if (i && i.type === 'file' && i.value && IMG_RE.test(i.value)) state.incoming = i.value
  if (loggedIn()) refresh(); else render()
})()
