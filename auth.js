// Noon FM - Google sign-in + access check + FULL Firestore sync.
// Put this file next to index.html (index.html already has: <script type="module" src="auth.js"></script>)
//
// Firestore layout (one document per record):
//   users/{email}            role, name, status, at
//   requests/{id}            imported requests
//   workOrders/{id}          work orders
//   pms/{id}                 preventive maintenance
//   assets/{id}              assets  (+ "_meta" doc = sheet header info)
//   inventory/{id}           stock   (+ "_meta" doc)
//   inventoryLog/{id}        stock movements
//   vendors/{id}             vendors with their records
//   ratings/{id}             technician ratings
//   attendance/{email_date}  attendance (unchanged)

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
         doc, getDoc, setDoc, updateDoc, deleteDoc, collection, query, where, or, getDocs, onSnapshot, writeBatch }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// Firebase web config (public values)
const firebaseConfig = {
  apiKey: "AIzaSyDHsue1liHNmaPjFegHhxUpZ3UPsuNwzYk",
  authDomain: "noon-fm.firebaseapp.com",
  projectId: "noon-fm",
  storageBucket: "noon-fm.firebasestorage.app",
  messagingSenderId: "838491511025",
  appId: "1:838491511025:web:edfe9b58bcfa931eb63150"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
// local cache = fewer Firestore reads (only changes are downloaded after the first load)
let db;
try { db = initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) }); }
catch (e) { db = getFirestore(app); }
const $ = (id) => document.getElementById(id);
let myShift = "";                                   // the signed-in technician's shift (from his users doc)

// ---- message under the buttons (survives language toggle) ----
let last = null;
function say(en, ar, bad) { last = { en, ar, bad: !!bad }; showNote(); }
function showNote() {
  const n = $("gnote"); if (!n) return;
  const x = last || {
    en: "Sign in with Google. Only invited accounts can enter.",
    ar: "الدخول بحساب جوجل. المدعوّين بس يقدروا يدخلوا.",
    bad: false
  };
  n.textContent = m(x.en, x.ar);
  n.style.color = x.bad ? "#d92d20" : "";
}
const _rg = window.renderGate;
window.renderGate = function () { _rg(); showNote(); };

// ---- sign in + check the email is in users/{email} with the right role ----
async function currentUser() {
  if (auth.currentUser) return auth.currentUser;
  const r = await signInWithPopup(auth, new GoogleAuthProvider());
  return r.user;
}

async function enter(want) {            // want = "manager" | "technician"
  const b1 = $("gm"), b2 = $("gt");
  b1.disabled = b2.disabled = true;
  try {
    say("Signing in...", "جاري تسجيل الدخول...");
    const u = await currentUser();
    const email = (u.email || "").toLowerCase();
    const snap = await getDoc(doc(db, "users", email));
    const d = snap.exists() ? snap.data() : null;
    if (!d || String(d.role).trim().toLowerCase() !== want) {
      await signOut(auth);
      const why = !d ? "not in users" : "role: " + d.role;
      const whyAr = !d ? "الإيميل مش في users" : "الدور: " + d.role;
      say("No access for " + email + " (" + why + "). Contact your team manager.",
          "مفيش صلاحية لـ " + email + " (" + whyAr + "). تابع مدير التيم.", true);
      return;
    }
    last = null;
    if (want === "technician") syncMyShift(email, d.shift);
    // first successful sign-in turns "Invited" into "Active"
    if (String(d.status || "").toLowerCase() !== "active") updateDoc(doc(db, "users", email), { status: "Active" }).catch(() => {});
    if (want === "technician") {
      if (!US.some((x) => x.email === email)) {
        US.push({ email, role: "Technician", name: d.name || u.displayName || "", shift: d.shift || "", status: "Active", at: new Date().toISOString().slice(0, 10) });
        saveUS();
      }
      setRole("tech", email);
    } else {
      setRole("manager");
    }
  } catch (err) {
    const code = err.code || err.message || "error";
    say("Sign-in failed: " + code, "فشل الدخول: " + code, true);
  } finally {
    b1.disabled = b2.disabled = false;
  }
}

$("gm").onclick = () => enter("manager");
$("gt").onclick = () => enter("technician");
showNote();

function syncMyShift(email, sh) {
  myShift = sh || "";
  const me = US.filter((x) => x.email === email)[0];
  if (me && (me.shift || "") !== myShift) { me.shift = myShift; saveUS(); }
}

// ---- sign out ----
$("nav").addEventListener("click", (e) => {
  if (e.target.closest("[data-so]")) signOut(auth).catch(() => {});
});

// ---- if a role was kept from this tab, make sure Google still agrees, then start syncing ----
onAuthStateChanged(auth, async (u) => {
  if (typeof ROLE === "undefined" || !ROLE) return;
  if (!u) { stopSync(); setRole(""); return; }
  try {
    const s = await getDoc(doc(db, "users", (u.email || "").toLowerCase()));
    const r = s.exists() ? String(s.data().role).trim().toLowerCase() : "";
    if (r !== (ROLE === "tech" ? "technician" : "manager")) { await signOut(auth); stopSync(); setRole(""); return; }
    if (ROLE === "tech") syncMyShift((u.email || "").toLowerCase(), s.data().shift);
    startSync();
  } catch (e) { /* ignore */ }
});

// =====================================================================
// SYNC ENGINE
// Every list the page keeps in localStorage is mirrored to Firestore, one document per record.
// - any local save  -> diff against what Firestore has -> write only the changed records
// - any remote change -> rebuild the local list, save it, redraw
// - first manager login: local data that Firestore does not have yet is uploaded (nothing is deleted)
// =====================================================================
const _setItem = Storage.prototype.setItem;
const lsGet = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };
const lsPut = (k, v) => { try { _setItem.call(localStorage, k, v); } catch (e) { /* full / blocked */ } };
const clean = (v) => JSON.parse(JSON.stringify(v));                       // drops undefined
const canon = (v) => JSON.stringify(v, (k, x) => x && typeof x === "object" && !Array.isArray(x)
  ? Object.keys(x).sort().reduce((o, y) => (o[y] = x[y], o), {}) : x);    // same text whatever the key order
function hash(s) {                                                        // cyrb53 -> short base36 id
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677); }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}
const safe = (s) => { s = String(s == null ? "" : s).trim().replace(/\//g, "_"); return !s || s === "." || s === ".." || /^__.*__$/.test(s) || s.length > 200 ? "h" + hash(s) : s; };
function uniq(keys) { const seen = {}; return keys.map((k) => { const n = (seen[k] = (seen[k] || 0) + 1); return n > 1 ? k + "~" + n : k; }); }
// keep the sheet order: each record carries _o; only renumber when the order is broken
function order(list) {
  let prev = -1, miss = -1, ok = true;
  list.forEach((x, i) => {
    if (typeof x._o !== "number") { if (miss < 0) miss = i; }
    else { if (miss >= 0 || x._o <= prev) ok = false; prev = x._o; }
  });
  if (!ok) list.forEach((x, i) => { x._o = i; });
  else if (miss >= 0) for (let i = miss, n = prev + 1; i < list.length; i++) list[i]._o = n++;
}
function recs(arr, keyFn, map) { order(arr); const ids = uniq(arr.map(keyFn)); return arr.map((x, i) => ({ id: ids[i], data: clean(map ? map(x) : x) })); }
// every work order / PM carries the technician's EMAIL, so Firestore can hand each technician only his own
const techEmail = (name) => {
  const n = nz(name); if (!n) return "";
  const u = US.filter((x) => x.role === "Technician" && (nz(x.name) === n || String(x.email).toLowerCase() === n))[0];
  return u ? String(u.email).toLowerCase() : "";
};
const withMail = (x) => Object.assign({}, x, { assigneeEmail: ROLE === "tech" ? (x.assigneeEmail || "")
  : techEmail(x.assignee) || (S.users && S.users.applied ? "" : (x.assigneeEmail || "")) });
const cap = (s) => { s = String(s || ""); return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase(); };
const metaOf = (docs, dflt) => { const x = docs.filter((d) => d.data._meta)[0]; return x ? x.data : dflt; };

// tech:true = the technician is allowed to read and update this collection
const SPECS = {
  requests: { col: "requests", ls: "fm_requests", state: () => R,
    build: () => recs(R, (x) => safe(x.key || "t" + hash(x.title))),
    apply: (docs) => { window.R = docs.map((d) => d.data); } },

  workOrders: { col: "workOrders", ls: "fm_wo", tech: true, mine: true, state: () => WO,
    build: () => recs(WO, (w) => safe(w.uid || w.key || "t" + hash(w.title)), withMail),
    apply: (docs) => { window.WO = docs.map((d) => d.data); } },

  pms: { col: "pms", ls: "fm_pm", tech: true, mine: true, shift: true, state: () => PM,
    build: () => recs(PM, (p) => safe(p.id != null ? p.id : "t" + hash(p.title + "|" + p.location)), withMail),
    apply: (docs) => { window.PM = docs.map((d) => d.data); } },

  assets: { col: "assets", ls: "fm_assets", tech: true, state: () => ASD,
    build() {
      order(ASD.rows);
      const ids = uniq(ASD.rows.map((x) => "a" + hash(akey(ASD, x.c))));
      return (ASD.h.length ? [{ id: "_meta", data: clean({ _meta: true, h: ASD.h, ni: ASD.ni, ti: ASD.ti, li: ASD.li }) }] : [])
        .concat(ASD.rows.map((x, i) => ({ id: ids[i], data: clean(x) })));
    },
    apply(docs) {
      const b = metaOf(docs, { h: [], ni: -1, ti: -1, li: -1 });
      window.ASD = { h: b.h || [], ni: b.ni, ti: b.ti, li: b.li, rows: docs.filter((d) => !d.data._meta).map((d) => d.data) };
    } },

  inventory: { col: "inventory", ls: "fm_inventory", state: () => IV,
    build() {
      order(IV.rows);
      const skip = [IV.bi, IV.ai, IV.wi];                                  // balance columns change, so they are not part of the id
      const ids = uniq(IV.rows.map((x) => "i" + hash(x.c.filter((_, j) => skip.indexOf(j) < 0).join("|").toLowerCase())));
      return (IV.h.length ? [{ id: "_meta", data: clean({ _meta: true, h: IV.h, ni: IV.ni, bi: IV.bi, ai: IV.ai, wi: IV.wi }) }] : [])
        .concat(IV.rows.map((x, i) => ({ id: ids[i], data: clean(x) })));
    },
    apply(docs) {
      const b = metaOf(docs, { h: [], ni: -1, bi: -1, ai: -1, wi: -1 });
      window.IV = { h: b.h || [], ni: b.ni, bi: b.bi, ai: b.ai, wi: b.wi, rows: docs.filter((d) => !d.data._meta).map((d) => d.data), log: (window.IV && IV.log) || [] };
    } },

  inventoryLog: { col: "inventoryLog", ls: "fm_inventory", state: () => IV,
    build() {
      order(IV.log);
      const ids = uniq(IV.log.map((g) => { const { _o, ...rest } = g; return "g" + hash(canon(rest)); }));
      return IV.log.map((g, i) => ({ id: ids[i], data: clean(g) }));
    },
    apply(docs) { IV.log = docs.map((d) => d.data); } },

  vendors: { col: "vendors", ls: "fm_vendors", state: () => VD,
    build: () => recs(VD, (v) => safe(v.id != null ? v.id : "t" + hash(v.name))),
    apply: (docs) => { window.VD = docs.map((d) => d.data); } },

  users: { col: "users", ls: "fm_users", merge: true, dep: ["workOrders", "pms"], state: () => US,
    norm: (d) => ({ role: String(d.role || "").trim().toLowerCase(), name: d.name || "", shift: d.shift || "", status: d.status || "Invited", at: d.at || "" }),
    build: () => US.map((u) => ({ id: safe(String(u.email).toLowerCase()), data: SPECS.users.norm(u) })),
    apply(docs) {
      window.US = docs.map((d) => ({ email: d.id, role: cap(d.data.role), name: d.data.name || "", shift: d.data.shift || "", status: d.data.status || "Invited", at: d.data.at || "" }))
        .sort((a, b) => String(a.at).localeCompare(String(b.at)) || a.email.localeCompare(b.email));
    } },

  ratings: { col: "ratings", ls: "fm_techdata", state: () => TA,
    build() {
      const all = [];
      Object.keys(TA).forEach((em) => (TA[em].rate || []).forEach((r) => all.push({ email: em, date: r.date, stars: r.stars, note: r.note || "" })));
      const ids = uniq(all.map((r) => "r" + hash(canon(r))));
      return all.map((r, i) => ({ id: ids[i], data: clean(r) }));
    },
    apply(docs) {
      Object.keys(TA).forEach((em) => { TA[em].rate = []; });
      docs.forEach((d) => { tdat(d.data.email).rate.push({ date: d.data.date, stars: d.data.stars, note: d.data.note || "" }); });
    } }
};
const BYLS = {};                                                           // localStorage key -> spec names
Object.keys(SPECS).forEach((n) => { (BYLS[SPECS[n].ls] = BYLS[SPECS[n].ls] || []).push(n); });

const S = {};                                                              // running state per spec
let RUN = "", DRAWT = 0;
const allowed = (sp) => (ROLE === "tech" ? !!sp.tech : ROLE === "manager");
const rkey = (sp, d) => canon(sp.norm ? sp.norm(d) : d);
const docsOf = (snap) => snap.docs.map((d) => ({ id: d.id, data: d.data() }));
function syncErr(n, err) { window.say(m("Sync failed (" + n + "): ", "المزامنة فشلت (" + n + "): ") + ((err && (err.code || err.message)) || err)); }
function redrawSoon() { clearTimeout(DRAWT); DRAWT = setTimeout(() => { try { window.draw(); } catch (e) { /* ignore */ } }, 60); }

function startSync() {
  if (!auth.currentUser || typeof ROLE === "undefined" || !ROLE) return;
  const key = ROLE + "|" + (auth.currentUser.email || "") + "|" + (ROLE === "tech" ? myShift : "");
  if (RUN === key) return;
  stopSync(); RUN = key;
  Object.keys(SPECS).forEach((n) => { if (allowed(SPECS[n])) listen(n); });
  if (ROLE === "tech") {                                 // if the manager moves him to another shift, reload his list
    const em = (auth.currentUser.email || "").toLowerCase();
    S._me = { timer: 0, off: onSnapshot(doc(db, "users", em), (snap) => {
      const sh = ((snap.data() || {}).shift) || "";
      if (sh !== myShift) { syncMyShift(em, sh); RUN = ""; startSync(); }
    }, () => {}) };
  }
}
function stopSync() {
  Object.keys(S).forEach((n) => { clearTimeout(S[n].timer); if (S[n].off) S[n].off(); delete S[n]; });
  RUN = "";
}
function listen(n) {
  const sp = SPECS[n];
  const st = (S[n] = { rem: new Map(), snap: null, dirty: false, needApply: false, applied: false, timer: 0, off: null,
    migrate: ROLE === "manager" && !lsGet("fm_mig_" + n) });
  const base = collection(db, sp.col);
  let q = base;
  if (ROLE === "tech" && sp.mine) {                      // only his own (and, for PMs, his shift's)
    const mine = where("assigneeEmail", "==", (auth.currentUser.email || "").toLowerCase());
    q = query(base, sp.shift && myShift ? or(mine, where("shift", "==", myShift)) : mine);
  }
  st.off = onSnapshot(q, (snap) => onSnap(n, snap), (err) => syncErr(n, err));
}
function applyDocs(n, docs) {
  const sp = SPECS[n];
  docs.sort((a, b) => (a.data._o == null ? -1 : a.data._o) - (b.data._o == null ? -1 : b.data._o));
  try { sp.apply(docs); lsPut(sp.ls, JSON.stringify(sp.state())); } catch (e) { syncErr(n, e); return; }
  const first = S[n] && !S[n].applied;
  S[n] && (S[n].applied = true);
  if (ROLE === "manager") { (sp.dep || []).forEach(markDirty); if (first && sp.mine) markDirty(n); }   // keep assigneeEmail up to date
  redrawSoon();
}
function onSnap(n, snap) {
  const sp = SPECS[n], st = S[n]; if (!st) return;
  st.snap = snap;
  st.rem = new Map(); snap.docs.forEach((d) => st.rem.set(d.id, rkey(sp, d.data())));

  if (st.migrate) {                                      // first manager login: upload what Firestore does not have yet
    if (snap.metadata.fromCache) return;                 // wait for the real server answer
    st.migrate = false;
    lsPut("fm_bak_" + n, lsGet(sp.ls) || "");            // safety copy of the local data
    let add = [];
    try { add = sp.build().filter((x) => !st.rem.has(x.id)); } catch (e) { syncErr(n, e); }
    if (add.length) {
      write(n, add, [], () => lsPut("fm_mig_" + n, "1"));
      applyDocs(n, docsOf(snap).concat(add));
      return;
    }
    lsPut("fm_mig_" + n, "1");
  }
  const remoteChange = snap.docChanges().some((c) => !c.doc.metadata.hasPendingWrites);
  if (!st.applied || remoteChange || st.needApply) {
    if (st.dirty) { st.needApply = true; return; }       // local edit waiting to be saved: do not overwrite it
    st.needApply = false;
    applyDocs(n, docsOf(snap));
  }
}
function write(n, sets, dels, done) {
  const sp = SPECS[n], st = S[n], ops = [];
  sets.forEach((x) => { st.rem.set(x.id, rkey(sp, x.data)); ops.push([x.id, x.data]); });
  dels.forEach((id) => { st.rem.delete(id); ops.push([id, null]); });
  const jobs = [];
  for (let i = 0; i < ops.length; i += 400) {            // Firestore batch limit is 500
    const b = writeBatch(db);
    ops.slice(i, i + 400).forEach(([id, data]) => {
      const ref = doc(db, sp.col, id);
      if (data === null) b.delete(ref); else if (sp.merge) b.set(ref, data, { merge: true }); else b.set(ref, data);
    });
    jobs.push(b.commit());
  }
  Promise.all(jobs).then(() => { if (done) done(); }).catch((e) => syncErr(n, e));
}
function push(n) {
  const sp = SPECS[n], st = S[n]; if (!st || !st.applied) return;
  let want;
  try { want = sp.build(); } catch (e) { syncErr(n, e); st.dirty = false; return; }
  const ids = new Set(), sets = [], dels = [];
  want.forEach((x) => { ids.add(x.id); if (st.rem.get(x.id) !== rkey(sp, x.data)) sets.push(x); });
  st.rem.forEach((_, id) => { if (!ids.has(id)) dels.push(id); });
  st.dirty = false;
  if (sets.length || dels.length) write(n, sets, dels);
  else if (st.needApply && st.snap) { st.needApply = false; applyDocs(n, docsOf(st.snap)); }
}
function markDirty(n) {
  const st = S[n]; if (!st || !st.applied) return;
  st.dirty = true; clearTimeout(st.timer); st.timer = setTimeout(() => push(n), 500);
  if (ROLE === "manager") (SPECS[n].dep || []).forEach(markDirty);
}
// the page saves with localStorage.setItem("fm_...") - that is our signal that something changed
Storage.prototype.setItem = function (k, v) {
  _setItem.call(this, k, v);
  let local = false; try { local = this === window.localStorage; } catch (e) { /* ignore */ }
  if (local && BYLS[k]) BYLS[k].forEach(markDirty);
};
function flushAll() { Object.keys(S).forEach((n) => { if (S[n].dirty) { clearTimeout(S[n].timer); push(n); } }); }
document.addEventListener("visibilitychange", () => { if (document.hidden) flushAll(); });
window.addEventListener("pagehide", flushAll);

// the technician page matches by email (falls back to the name for old records)
window.techWO = (u) => WO.filter((w) => (w.assigneeEmail ? w.assigneeEmail === String(u.email).toLowerCase() : sameName(w.assignee, u.name)));
window.techPM = (u) => {                                 // mine by email/name, or still pending in my shift
  const em = String(u.email).toLowerCase();
  return PM.filter((p) => (p.assigneeEmail ? p.assigneeEmail === em : sameName(p.assignee, u.name) || nz(p.assignee) === nz(em))
    || (p.shift && p.shift === u.shift && p.status !== "Done"));
};

const _setRole = window.setRole;
window.setRole = function (r, em) { _setRole(r, em); if (r) startSync(); else stopSync(); };

// =====================================================================
// Attendance sync with Firestore: collection "attendance", doc id = email_date
// index.html keeps working on its local copy (TA); this part mirrors it to/from Firestore.
// =====================================================================
const attRef = (em, d) => doc(db, "attendance", String(em).toLowerCase() + "_" + d);
const attErr = (err) => window.say(m("Attendance sync failed: ", "مزامنة الحضور فشلت: ") + (err.code || err.message));

// manager: write one technician's record for a date (or delete it if cleared)
async function attPush(em, d) {
  if (ROLE === "tech" || !auth.currentUser) return;
  try {
    const r = atGet(em, d);
    if (r) {
      const u = techOf(em);
      await setDoc(attRef(em, d), { email: String(em).toLowerCase(), name: u ? (u.name || "") : "", date: d, status: r.status, note: r.note || "" });
    } else {
      await deleteDoc(attRef(em, d));
    }
  } catch (err) { attErr(err); }
}
document.addEventListener("change", (e) => {          // status / note edited on the Attendance page
  const s = e.target.dataset; if (!s) return;
  const em = s.ats !== undefined ? s.ats : s.atn;
  if (em !== undefined) attPush(em, atDate());
});
$("atall").addEventListener("click", () => {           // "Mark all present"
  const d = atDate(); techUsers().forEach((u) => attPush(u.email, d));
});
$("taf").addEventListener("submit", () => {            // old "+ Attendance" dialog on Technicians page
  const em = TCUR, d = $("tadt").value; if (em && d) attPush(em, d);
});
document.addEventListener("click", (e) => {            // old "x" remove button (runs before the local delete)
  const b = e.target.closest && e.target.closest("[data-tax]"); if (!b) return;
  const a = tdat(TCUR).att[+b.dataset.tax];
  if (a && auth.currentUser) deleteDoc(attRef(TCUR, a.date)).catch(attErr);
}, true);

// manager: load the selected month into the local copy
async function attLoadMonth() {
  if (ROLE === "tech" || !auth.currentUser) return;
  const ym = atDate().slice(0, 7);
  try {
    const s = await getDocs(query(collection(db, "attendance"), where("date", ">=", ym + "-01"), where("date", "<=", ym + "-31")));
    Object.keys(TA).forEach((em) => { TA[em].att = (TA[em].att || []).filter((a) => String(a.date).slice(0, 7) !== ym); });
    s.docs.forEach((x) => { const r = x.data(); tdat(r.email).att.push({ date: r.date, status: r.status, note: r.note || "" }); });
    saveTA(); renderAT(); renderTC();
  } catch (err) { attErr(err); }
}
$("nav").addEventListener("click", (e) => {
  const b = e.target.closest("[data-n]");
  if (b && (b.dataset.n === "Attendance" || b.dataset.n === "Technicians")) attLoadMonth();
});
$("atdate").addEventListener("change", attLoadMonth);

// technician: load only his own records
async function attLoadMine() {
  if (ROLE !== "tech" || !auth.currentUser) return;
  const em = (auth.currentUser.email || "").toLowerCase();
  try {
    const s = await getDocs(query(collection(db, "attendance"), where("email", "==", em)));
    tdat(em).att = s.docs.map((x) => { const r = x.data(); return { date: r.date, status: r.status, note: r.note || "" }; });
    saveTA(); renderTPAtt();
  } catch (err) { attErr(err); }
}
let _mineKey = "";
const _drawBase = window.draw;
window.draw = function () {
  _drawBase();
  if (ROLE === "tech" && auth.currentUser) {
    const k = auth.currentUser.email + "|" + today();
    if (_mineKey !== k) { _mineKey = k; attLoadMine(); }
  } else if (ROLE !== "tech") { _mineKey = ""; }
};
onAuthStateChanged(auth, (u) => { if (u) attLoadMine(); });
document.addEventListener("visibilitychange", () => { if (!document.hidden && ROLE === "tech") attLoadMine(); });
