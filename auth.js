// Noon FM - Google sign-in + access check against Firestore "users" collection.
// Put this file next to index.html and add ONE line before </body> in index.html:
//   <script type="module" src="auth.js"></script>

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, doc, getDoc, setDoc, deleteDoc }
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
    if (!d || String(d.role).toLowerCase() !== want) {
      await signOut(auth);
      say("No access. Contact your team manager.", "مفيش صلاحية. تابع مدير التيم.", true);
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
    const r = s.exists() ? String(s.data().role).toLowerCase() : "";
    if (r !== (ROLE === "tech" ? "technician" : "manager")) { await signOut(auth); setRole(""); }
  } catch (e) { /* ignore */ }
});
