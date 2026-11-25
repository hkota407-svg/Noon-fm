// Noon FM - Google sign-in + access check against Firestore "users" collection.
// Put this file next to index.html and add ONE line before </body> in index.html:
//   <script type="module" src="auth.js"></script>

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, doc, getDoc, setDoc, deleteDoc, collection, query, where, getDocs }
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
const db = getFirestore(app);
const $ = (id) => document.getElementById(id);

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
    if (want === "technician") {
      if (!US.some((x) => x.email === email)) {
        US.push({ email, role: "Technician", name: d.name || u.displayName || "", status: "Active", at: new Date().toISOString().slice(0, 10) });
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

// ---- Users page: inviting / removing also writes to Firestore ----
const uf = $("uf"), origInvite = uf.onsubmit;
uf.onsubmit = async (e) => {
  const em = $("uem").value.trim().toLowerCase();
  const role = $("urole").value.toLowerCase();
  const name = $("unm").value.trim();
  origInvite.call(uf, e);
  if (US.some((x) => x.email === em)) {
    try {
      await setDoc(doc(db, "users", em), { role, name, status: "Invited" }, { merge: true });
    } catch (err) {
      alert(m("Could not save to Firestore. Are you signed in as manager?", "مقدرتش أحفظ في Firestore. إنت داخل كمدير بحساب جوجل؟"));
    }
  }
};
document.addEventListener("click", (e) => {
  const b = e.target.closest && e.target.closest("[data-ux]");
  if (!b) return;
  const u = US[+b.dataset.ux];
  if (u) deleteDoc(doc(db, "users", u.email)).catch(() => {});
}, true);

// ---- sign out ----
$("nav").addEventListener("click", (e) => {
  if (e.target.closest("[data-so]")) signOut(auth).catch(() => {});
});

// ---- if a role was kept from this tab, make sure Google still agrees ----
onAuthStateChanged(auth, async (u) => {
  if (typeof ROLE === "undefined" || !ROLE) return;
  if (!u) { setRole(""); return; }
  try {
    const s = await getDoc(doc(db, "users", (u.email || "").toLowerCase()));
    const r = s.exists() ? String(s.data().role).trim().toLowerCase() : "";
    if (r !== (ROLE === "tech" ? "technician" : "manager")) { await signOut(auth); setRole(""); }
  } catch (e) { /* ignore */ }
});

// ---- Attendance sync with Firestore: collection "attendance", doc id = email_date ----
// index.html keeps working on its local copy (TA); this part mirrors it to/from Firestore.
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
