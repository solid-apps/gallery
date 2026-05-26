// intents.js — a tiny share / open-with bus for pod apps. Works on mobile,
// desktop and web because it's pure navigation + same-origin fetch (no native
// IPC). Vendor this file into an app (copy + <script src="intents.js">), or
// load it from an installed copy.
//
// Apps declare what they accept in manifest.json:
//     "handles": ["webid", "geo", "url", "text"]
// A *source* app offers a thing:
//     window.intent.open(type, value, label)
//   → shows a chooser of installed apps that handle `type`, then navigates to
//     the chosen one with  ?intent=<type>&value=<value>
// A *target* app reads it on load:
//     const i = window.intent.receive()   // { type, value } | null
(function () {
  var APPS = new URL('../', location.href)               // .../public/apps/
  var me = location.pathname.replace(/\/$/, '').split('/').pop()

  function ldpNames(doc) {
    var c = doc['ldp:contains'] || doc['http://www.w3.org/ns/ldp#contains'] || doc.contains || []
    if (!Array.isArray(c)) c = [c]
    return c.map(function (x) { return typeof x === 'string' ? x : (x['@id'] || x.id) }).filter(Boolean)
      .filter(function (u) { return u.charAt(u.length - 1) === '/' })
      .map(function (u) { return decodeURIComponent(u.replace(/\/$/, '').split('/').pop()) })
      .filter(function (n) { return n && n.charAt(0) !== '.' && n !== me })
  }

  // Installed apps whose manifest "handles" includes `type` (excludes self).
  async function handlers(type) {
    var out = []
    try {
      var r = await fetch(APPS, { headers: { Accept: 'application/ld+json' } })
      if (!r.ok) return out
      var names = ldpNames(await r.json())
      await Promise.all(names.map(async function (n) {
        try {
          var m = await fetch(new URL(n + '/manifest.json', APPS))
          if (!m.ok) return
          var mj = await m.json()
          if ((mj.handles || []).indexOf(type) >= 0) out.push({ name: n, label: mj.short_name || mj.name || n })
        } catch (e) { /* skip */ }
      }))
    } catch (e) { /* none */ }
    out.sort(function (a, b) { return a.label.localeCompare(b.label) })
    return out
  }

  function ensureCss() {
    if (document.getElementById('intent-css')) return
    var s = document.createElement('style'); s.id = 'intent-css'
    s.textContent = '.intent-ov{position:fixed;inset:0;background:rgba(20,20,34,.5);display:flex;align-items:center;justify-content:center;z-index:99999;padding:20px;font-family:system-ui,-apple-system,sans-serif}.intent-md{background:#fff;color:#1c2230;border-radius:15px;padding:16px;width:100%;max-width:320px;box-shadow:0 22px 55px rgba(0,0,0,.32)}.intent-t{font-weight:600;font-size:15px;margin-bottom:12px}.intent-o{display:block;width:100%;text-align:left;font:600 14px system-ui;background:#5b6b8c;color:#fff;border:0;border-radius:10px;padding:12px 14px;margin-bottom:7px;cursor:pointer}.intent-o:hover{filter:brightness(1.08)}.intent-c{display:block;width:100%;font:600 13px system-ui;background:#fff;color:#6b7488;border:1px solid #e5e8ef;border-radius:10px;padding:9px;cursor:pointer;margin-top:4px}'
    document.head.appendChild(s)
  }

  function chooser(label, type, apps) {
    return new Promise(function (resolve) {
      ensureCss()
      var ov = document.createElement('div'); ov.className = 'intent-ov'
      var opts = apps.map(function (a, i) { return '<button class="intent-o" data-i="' + i + '">' + String(a.label).replace(/[<&]/g, '') + '</button>' }).join('')
      ov.innerHTML = '<div class="intent-md"><div class="intent-t">Open ' + (label ? '“' + String(label).replace(/[<&]/g, '') + '”' : 'this ' + type) + ' with…</div>' + opts + '<button class="intent-c">Cancel</button></div>'
      document.body.appendChild(ov)
      function done(v) { ov.remove(); resolve(v) }
      ov.addEventListener('click', function (e) { if (e.target === ov) done(null) })
      ov.querySelector('.intent-c').onclick = function () { done(null) }
      ov.querySelectorAll('.intent-o').forEach(function (b) { b.onclick = function () { done(apps[+b.dataset.i]) } })
    })
  }

  async function open(type, value, label) {
    var apps = await handlers(type)
    if (!apps.length) { alert('No installed app handles “' + type + '”.'); return }
    var pick = apps.length === 1 ? apps[0] : await chooser(label, type, apps)
    if (!pick) return
    location.href = new URL(pick.name + '/?intent=' + encodeURIComponent(type) + '&value=' + encodeURIComponent(value), APPS).href
  }

  function receive() {
    var p = new URLSearchParams(location.search)
    var t = p.get('intent'); if (!t) return null
    return { type: t, value: p.get('value') || '' }
  }

  window.intent = { open: open, receive: receive, handlers: handlers }
})()
