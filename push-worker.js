// 🔔 MyPlanner 알림 서버 (Cloudflare Worker)
//
// 하는 일
//   POST /push/subscribe  앱이 보낸 구독 정보를 저장
//   POST /push/test       테스트 알림 보내기
//   POST /push/send       원하는 내용으로 알림 보내기 (요약 알림 등)
//   GET  /push/status     구독이 등록돼 있는지 확인
//   GET  /version         지금 서버에 올라간 코드 버전 (배포 확인용)
//   GET/POST /relay/ping  단축어가 쓰는 길로 알림만 보내본다 (진단용)
//   POST /ai/{모델}       ⚠️ 기본 꺼짐. GEMINI_KEY Secret 이 없으면 503.
//                         켜기 전에 아래 'AI 중계' 주석의 1~4번을 반드시 고칠 것
//
// ─────────────────────────────────────────────────────────────
// 준비물 1 — KV 네임스페이스
//   Cloudflare 대시보드 → Storage & Databases → KV → Create
//   이름은 아무거나 (예: myplanner-push)
//   그다음 이 Worker → Settings → Bindings → KV namespace 추가
//   Variable name 은 반드시  PUSH_KV  로
//
// 준비물 2 — Secrets (Settings → Variables and Secrets)
//   VAPID_PUBLIC    npx web-push generate-vapid-keys 로 나온 Public Key
//   VAPID_PRIVATE   같은 명령으로 나온 Private Key   ← 절대 공개 금지
//   VAPID_SUBJECT   mailto:본인이메일   (예: mailto:me@example.com)
//   INBOX_TOKEN     앱의 '전송 열쇠'와 같은 값 — 아무나 알림 못 보내게 막는 용도
//
//   ※ INBOX_TOKEN 은 앱 설정의 전송 열쇠를 그대로 쓰면 됩니다.
//     (운동 탭 → 워치 연동 설정 → 앞부분 복사 안에 들어 있는 그 값)
// 준비물 3 — 워치 캡처 중계용 Secrets (선택. 도착 알림을 쓸 때만)
//   FIREBASE_PROJECT_ID   예) life-planner-a03d2
//   FIREBASE_API_KEY      Firebase 웹 API 키 (앱에 이미 쓰는 그 값)
//   MY_UID                내 로그인 UID  ← 공용 AI 에서 '주인은 무제한'을 가르는 기준도 이 값
//   → 단축어의 주소를  https://내워커주소/relay/workout  으로 바꾸면
//     Firestore 저장과 알림이 한 번에 처리된다. 본문은 그대로 두면 된다.
//
// 준비물 4 — Cron (Settings → Triggers → Cron Triggers)
//   */10 * * * *   ← 10분마다. 실제로 보낼 시각은 앱에서 정한다.
// ─────────────────────────────────────────────────────────────


// CORS 헤더를 만들 때 쓰려고 이번 요청의 env 를 잠깐 들고 있는다.
// ALLOWED_ORIGIN 은 배포마다 고정된 값이라, 요청이 겹쳐도 결과가 달라지지 않는다.
// 배포가 실제로 반영됐는지 주소창에서 확인하려고 둔다. 코드를 고칠 때마다 올린다.
const WORKER_VERSION = '2026-11-23.1';
const ROUTE_LIST = ['/push/subscribe', '/push/unsubscribe', '/push/test', '/push/send',
  '/push/plan', '/push/status', '/relay/workout', '/relay/expense', '/relay/ping', '/widget', '/version', '/keys/status', '/keys/issue', '/keys/revoke', '/account/delete', '/widget/todo'];

let ENV = null;

export default {
  async fetch(request, env) {
    ENV = env;
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors(env) });

    try {
      if (url.pathname === '/push/subscribe' && request.method === 'POST') return await handleSubscribe(request, env);
      if (url.pathname === '/push/unsubscribe' && request.method === 'POST') return await handleUnsubscribe(request, env);
      if (url.pathname === '/push/test' && request.method === 'POST') return await handleTest(request, env);
      if (url.pathname === '/push/send' && request.method === 'POST') return await handleSend(request, env);
      if (url.pathname === '/push/plan' && request.method === 'POST') return await handlePlan(request, env);
      if (url.pathname === '/relay/workout' && request.method === 'POST') return await handleRelayWorkout(request, env, url);
      if (url.pathname === '/relay/expense' && request.method === 'POST') return await handleRelayExpense(request, env, url);
      // 주소창(GET)으로도 열 수 있게 둔다 — 배포가 됐는지 눈으로 확인하는 용도
      if (url.pathname === '/relay/ping') return await handleRelayPing(request, env);
      if (url.pathname === '/account/delete' && request.method === 'POST') return await handleAccountDelete(request, env);
      if (url.pathname.startsWith('/keys/') && request.method === 'POST') return await handleKeys(request, env, url);
      if (url.pathname === '/version') return json({ version: WORKER_VERSION, routes: ROUTE_LIST, relayReady: !!env.FIREBASE_SA });
      if (url.pathname === '/widget' && request.method === 'GET') return await handleWidget(env, url);
      if (url.pathname === '/widget/todo' && request.method === 'POST') return await handleWidgetTodo(request, env, url);
      if (url.pathname.startsWith('/ai/') && request.method === 'POST') return await handleAI(request, env, url);
      if (url.pathname === '/push/status') return await handleStatus(request, env, url);
    } catch (e) {
      const msg = String(e && e.message || e);
      // 로그인·열쇠 문제는 서버 잘못이 아니므로 401 로 구분해 준다
      const isAuth = msg.includes('열쇠') || msg.includes('INBOX_TOKEN')
        || msg.includes('로그인') || msg.includes('확인되지 않');
      return json({ error: msg }, isAuth ? 401 : 500);
    }
    return json({ error: 'not found' }, 404);
  },

  // Cron 은 10분마다 돌기만 하고, 보낼 시각인지는 앱이 저장해둔 값으로 판단한다.
  //   → 알림 시각을 바꾸려고 Cloudflare 에 들어올 일이 없다.
  //   Cron 표현식은 */10 * * * * 로 걸어두면 된다.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runPlan(env));
  },
};

// ===== ✨ AI 중계 (기본 꺼짐) =====
//
// ⚠️ GEMINI_KEY Secret 을 넣지 않으면 이 라우트는 503 을 돌려주고 아무 일도 하지 않는다.
//    일부러 그렇게 뒀다. 공용 키를 열면
//      · 남이 쓴 AI 요금과 무료 한도가 전부 서버 주인에게 붙고
//      · 남의 가계부·자산·운동 사진이 이 서버를 지나간다.
//
// 켜기 전에 반드시 고쳐야 할 것 (지금 상태로 켜면 뚫린다):
//   1. 인증 — 지금은 앱 열쇠(uploadKeys)를 Firestore 에서 읽어 확인한다.
//      그러려면 uploadKeys 에 공개 읽기 권한을 열어야 하는데 그건 위험하다.
//      로그인 토큰(Firebase ID token) 검증으로 바꿔야 한다.
//      → verifyIdToken (구글 공개 서명 키로 직접 검증) 을 쓰면 된다. emailVerified 도 같이 나온다.
//   2. 가입 제한 — 지금은 이메일 인증 없이 누구나 가입할 수 있다.
//      계정을 여러 개 만들면 상한이 무의미하므로 emailVerified 를 요구해야 한다.
//   3. CORS — ALLOWED_ORIGIN 을 넣어 앱 주소로 좁히는 게 좋다.
//   4. 상한 — KV 는 읽고 쓰는 사이가 원자적이지 않고 전파도 늦다.
//      동시에 여러 번 부르면 상한을 조금 넘길 수 있다. 정확한 과금이 필요하면 KV 로는 부족하다.
//
// 아래는 그 전제로 남겨둔 배선이다. 상한 계산과 모델명 검사는 그대로 쓸 수 있다.
// 주인(MY_UID)은 자기 할당량이므로 상한을 걸지 않는다.

const AI_DAILY_LIMIT = 30;          // 손님 1인당 하루 호출 수
// 앱이 실제로 쓰는 모델만 허용한다 (모양만 보면 비싼 모델도 부를 수 있다)
const AI_ALLOWED_MODELS = ['gemini-flash-latest', 'gemini-3.5-flash', 'gemini-3.1-flash-lite', 'gemini-2.0-flash'];

// 앱 열쇠(uploadKeys/{key}) 로 누구인지 알아낸다. 없는 열쇠면 null.
// 오늘 몇 번 썼나 (자정은 한국 시간 기준)
function todayKeyKST() {
  const kst = new Date(Date.now() + 9 * 3600 * 1000);
  return kst.toISOString().slice(0, 10);
}

async function bumpAIUsage(env, uid) {
  const k = 'ai:' + uid + ':' + todayKeyKST();
  const cur = Number(await env.PUSH_KV.get(k)) || 0;
  if (cur >= AI_DAILY_LIMIT) return { ok: false, used: cur };
  // 이틀치만 남겨두면 되므로 만료를 걸어 KV 가 계속 불어나지 않게 한다
  await env.PUSH_KV.put(k, String(cur + 1), { expirationTtl: 60 * 60 * 48 });
  return { ok: true, used: cur + 1 };
}

async function handleAI(request, env, url) {
  if (!env.GEMINI_KEY) {
    return json({ error: 'Worker 에 GEMINI_KEY 가 없습니다. Secrets 에 추가하고 Deploy 하세요' }, 503);
  }

  const model = decodeURIComponent(url.pathname.slice('/ai/'.length));
  if (!AI_ALLOWED_MODELS.includes(model)) return json({ error: '허용되지 않은 모델입니다' }, 400);

  // 로그인 토큰으로만 받는다. 예전 앱 열쇠 방식은 열쇠 목록을 공개로 열어야 해서 뺐다.
  let who;
  try { who = await requireUser(request, env, {}); } catch (e) { who = null; }
  if (!who || who.via !== 'token') return json({ error: '로그인이 확인되지 않았어요. 앱을 껐다 켜주세요' }, 401);
  const uid = who.uid;

  // 주인은 무제한, 손님은 하루 상한
  const isOwner = !!env.MY_UID && uid === env.MY_UID;
  // 손님은 이메일 인증을 마쳐야 한다 — 계정을 여러 개 만들어 상한을 피하지 못하게
  if (!isOwner && !who.emailVerified) return json({ error: '이메일 인증을 마친 뒤 쓸 수 있어요' }, 403);
  if (!isOwner) {
    const quota = await bumpAIUsage(env, uid);
    if (!quota.ok) {
      return json({
        error: `오늘 AI 사용 한도(${AI_DAILY_LIMIT}회)를 다 썼어요. 내일 다시 되거나, 설정에서 내 AI 키를 넣으면 제한 없이 쓸 수 있어요.`,
        quotaExceeded: true,
      }, 429);
    }
  }

  const body = await request.text();
  if (body.length > 4 * 1024 * 1024) return json({ error: '요청이 너무 큽니다' }, 413);

  const res = await fetch(
    'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model)
      + ':generateContent?key=' + env.GEMINI_KEY,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }
  );

  // 구글 응답을 그대로 돌려준다 — 앱은 직접 부를 때와 똑같이 처리하면 된다
  return new Response(await res.text(), {
    status: res.status,
    headers: { ...cors(env), 'Content-Type': 'application/json' },
  });
}

// ===== 🔐 로그인한 사람이 누구인지 확인 =====
// 열쇠 하나를 모두가 나눠 쓰면 남의 알림을 받아볼 수 있다. 그래서 로그인 토큰으로 사람을 가른다.
// 토큰은 한 시간짜리라 잠깐 캐시해 두고 매번 검증하지는 않는다.

// 🔐 Firebase 로그인 토큰을 서버에서 직접 검증한다.
//   예전에는 구글 서버(Identity Toolkit)에 토큰을 물어봤는데, 그때 쓰는 웹 API 키에
//   웹사이트 제한이 걸려 있어 늘 거절당했다. 그래서 uid+열쇠라는 우회로가 생겼다.
//   토큰은 구글이 서명한 JWT 라서, 구글이 공개한 서명 키로 서명만 확인하면 된다.
//   API 키가 필요 없고, 이게 Firebase 가 권하는 표준 방식이다.
const FIREBASE_JWKS_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
let JWKS_MEMO = null;   // { keys, until } — 같은 Worker 인스턴스 안에서만 재사용

async function firebaseSigningKey(env, kid) {
  const now = Date.now();
  if (!JWKS_MEMO || JWKS_MEMO.until < now || !JWKS_MEMO.keys[kid]) {
    const res = await fetch(FIREBASE_JWKS_URL);
    if (!res.ok) throw new Error('구글 서명 키를 못 받았어요 (HTTP ' + res.status + ')');
    const data = await res.json();
    const keys = {};
    for (const k of (data.keys || [])) if (k && k.kid) keys[k.kid] = k;
    // 구글이 알려준 보관 기간만큼 기억한다 (없으면 1시간)
    const cc = res.headers.get('Cache-Control') || '';
    const m = cc.split(',').map(x => x.trim()).find(x => x.indexOf('max-age=') === 0);
    const maxAge = m ? Number(m.slice(8)) : 3600;
    JWKS_MEMO = { keys, until: now + Math.max(60, Math.min(maxAge, 6 * 3600)) * 1000 };
  }
  const jwk = JWKS_MEMO.keys[kid];
  if (!jwk) throw new Error('모르는 서명 키예요');
  return crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
}

async function verifyIdToken(env, idToken) {
  if (!idToken) throw new Error('로그인이 필요합니다');
  const proj = env.FIREBASE_PROJECT_ID;
  if (!proj) throw new Error('Worker 에 FIREBASE_PROJECT_ID 가 없습니다');

  // 토큰 원문을 키로 쓰지 않으려고 해시를 쓴다 (KV 목록에 토큰이 남지 않게)
  const digest = await crypto.subtle.digest('SHA-256', enc(idToken));
  const cacheKey = 'tok:' + b64url(new Uint8Array(digest));
  if (env.PUSH_KV) {
    const hit = await env.PUSH_KV.get(cacheKey);
    if (hit) return JSON.parse(hit);
  }

  const parts = String(idToken).split('.');
  if (parts.length !== 3) throw new Error('로그인 토큰 모양이 이상해요');

  let header, payload;
  try {
    header = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[0])));
    payload = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[1])));
  } catch (e) { throw new Error('로그인 토큰을 읽지 못했어요'); }

  if (header.alg !== 'RS256' || !header.kid) throw new Error('로그인 토큰 서명 방식이 이상해요');

  const key = await firebaseSigningKey(env, header.kid);
  const ok = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5', key, b64urlDecode(parts[2]), enc(parts[0] + '.' + parts[1])
  );
  if (!ok) throw new Error('로그인 토큰 서명이 맞지 않아요');

  // 서명이 맞아도 '우리 프로젝트가 발급했고, 아직 유효한' 토큰이어야 한다
  const nowSec = Math.floor(Date.now() / 1000);
  const SKEW = 300;   // 시계가 조금 어긋나도 봐준다 (5분)
  if (payload.aud !== proj) throw new Error('다른 프로젝트의 로그인 토큰이에요');
  if (payload.iss !== 'https://securetoken.google.com/' + proj) throw new Error('발급처가 맞지 않아요');
  if (!(Number(payload.exp) > nowSec - SKEW)) throw new Error('로그인이 만료됐어요. 앱을 다시 열어주세요');
  if (Number(payload.iat) > nowSec + SKEW) throw new Error('로그인 토큰 시각이 이상해요');
  if (Number(payload.auth_time) > nowSec + SKEW) throw new Error('로그인 시각이 이상해요');
  const uid = String(payload.sub || '');
  if (!uid || uid.length > 128) throw new Error('로그인 정보가 확인되지 않았어요');

  const who = { uid, email: payload.email || '', emailVerified: !!payload.email_verified, via: 'token' };
  // 토큰이 끝날 때까지, 길어도 5분만 기억한다 — 계정을 지웠는데 한참 통과되면 곤란하다
  const ttl = Math.max(60, Math.min(300, Number(payload.exp) - nowSec));
  if (env.PUSH_KV) await env.PUSH_KV.put(cacheKey, JSON.stringify(who), { expirationTtl: ttl });
  return who;
}

// 누구인지 알아낸다. 두 가지를 받아준다.
//   1) Authorization: Bearer <로그인 토큰>  ← 앱이 쓰는 방식
//   2) 본문의 key 가 INBOX_TOKEN 과 같을 때 ← 예전 방식. 주인 본인으로만 인정한다.
//
// 2번을 남겨둔 이유: 토큰 검증이 안 되는 상황(키 제한 등)에서도 주인은 알림을 계속 쓸 수 있어야 한다.
// 이건 MY_UID 한 사람으로만 매핑되므로, 여러 사람이 서로의 알림을 보던 옛 문제는 생기지 않는다.
// 앱이 본문에 넣어 보낸 uid + key 로 사람을 가른다.
//   로그인 토큰 확인은 구글 API 를 부르는데, 그 API 키에 제한이 걸려 있으면 늘 거절당한다
//   ('FIREBASE_API_KEY 가 거절당했어요'). 그러면 알림 등록 자체가 안 돼서
//   기록이 들어와도 보낼 대상이 없다 — 알림이 영영 안 온다.
//   그래서 앱이 알려준 uid 를 쓴다. 열쇠는 워치 연동에 쓰는 그 값이다.
//
//   ⚠️ 예전에는 열쇠의 '모양' 만 보고 통과시켰다. 그러면 uid 만 알면 아무 숫자나
//      열쇠 자리에 넣어 남의 알림을 받아보거나 예약을 덮어쓸 수 있었다.
//      이제는 그 열쇠가 정말 그 uid 의 것인지 Firestore 의 uploadKeys 에서 대조한다.
//      (uploadKeys/{열쇠} 는 '아이디로 하나 읽기' 만 열려 있다 — 열쇠를 아는 사람만
//       그 문서를 읽을 수 있고, 목록을 훑어볼 수는 없다)
async function keyBelongsTo(env, uid, key) {
  // 같은 짝을 매번 Firestore 에 묻지 않게 한 시간 기억한다 (열쇠 원문은 KV 키로 안 쓴다)
  const h = await hashTok(key);
  try {
    // 로그인한 앱이 '이게 내 열쇠' 라고 알려준 것과 같으면 바로 통과
    if (env.PUSH_KV && (await env.PUSH_KV.get('ukey:' + uid)) === h) return 'ok';
  } catch (e) {}
  const tag = 'keyok:' + uid + ':' + h.slice(0, 16);
  try {
    const hit = env.PUSH_KV && await env.PUSH_KV.get(tag);
    if (hit === h) return 'ok';
  } catch (e) {}

  const proj = env.FIREBASE_PROJECT_ID;
  const apiKey = env.FIREBASE_API_KEY;
  if (!proj || !apiKey) return 'unknown';

  let res;
  try {
    res = await fetch(`https://firestore.googleapis.com/v1/projects/${proj}/databases/(default)/documents/uploadKeys/${encodeURIComponent(key)}?key=${apiKey}`);
  } catch (e) { return 'unknown'; }

  if (res.status === 404) return 'no';             // 그런 열쇠 없음
  if (res.status === 403) return 'unknown';        // 규칙이 아직 '읽기' 를 안 열어줬다
  if (!res.ok) return 'unknown';

  const doc = await res.json().catch(() => null);
  const owner = doc && doc.fields && doc.fields.uid && doc.fields.uid.stringValue;
  if (owner !== uid) return 'no';                  // 남의 열쇠

  try { env.PUSH_KV && await env.PUSH_KV.put(tag, h, { expirationTtl: 3600 }); } catch (e) {}
  return 'ok';
}

async function bodyIdentity(env, body) {
  const uid = String((body && body.uid) || '').trim();
  const key = String((body && body.key) || '').trim();
  if (!uid || !key) return null;
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(uid)) return null;
  if (!/^[0-9a-f]{16,128}$/.test(key)) return null;

  // 열쇠가 정말 그 사람 것으로 확인될 때만 통과한다. 확인을 못 하면(규칙·네트워크) 거절.
  //   예전엔 확인 못 해도 통과시켰는데, 그러면 uid 만 알면 남의 알림을 조작할 수 있었다.
  //   앱은 이제 로그인 토큰으로 들어오므로(2026-11-19 확인) 이 길이 막혀도 알림은 안 끊긴다.
  const v = await keyBelongsTo(env, uid, key);
  if (v !== 'ok') {
    if (v === 'unknown') console.log('열쇠 대조 못 해서 거절:', uid.slice(0, 6));
    return null;
  }
  return { uid, email: '', emailVerified: true, viaKey: true, keyChecked: true };
}

// 본문의 key 가 INBOX_TOKEN 과 같으면 주인으로 본다. 아니면 null.
function legacyOwner(env, body) {
  const key = body && body.key;
  if (!key || !env.INBOX_TOKEN || key !== env.INBOX_TOKEN) return null;
  if (!env.MY_UID) throw new Error('Worker 에 MY_UID 가 없습니다. Secrets 에 추가해주세요');
  return { uid: env.MY_UID, email: '', emailVerified: true, legacy: true };
}

// 어떤 길로 확인됐는지 사람별로 남긴다 — 토큰 검증이 실제로 되는지 보고 나서
// 열쇠 길을 닫기 위해서다. 토큰·열쇠 원문은 남기지 않는다.
async function noteAuth(env, uid, via, err) {
  if (!env.PUSH_KV || !uid) return;
  try {
    await env.PUSH_KV.put('authlast:' + uid, JSON.stringify({ via, at: new Date().toISOString(), err: err || '' }),
      { expirationTtl: 30 * 86400 });
  } catch (e) {}
}

async function requireUser(request, env, body) {
  const auth = request.headers.get('Authorization') || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  let tokenErr = '';
  if (m) {
    try {
      const who = await verifyIdToken(env, m[1].trim());
      await noteAuth(env, who.uid, 'token');
      if (body && body.key) await registerUploadKey(env, who.uid, body.key);
      return who;
    } catch (e) {
      tokenErr = String(e && e.message || e).slice(0, 120);
      console.log('토큰 검증 실패:', tokenErr);
    }
  }

  // 토큰이 없거나 실패하면 예전 방식(uid + 열쇠)으로 확인한다 — 옮겨가는 동안만
  const byBody = (await bodyIdentity(env, body)) || legacyOwner(env, body);
  if (byBody) {
    await noteAuth(env, byBody.uid, byBody.legacy ? 'legacy' : 'key', tokenErr || (m ? '' : 'no-token'));
    return byBody;
  }
  throw new Error(tokenErr || '로그인이 필요합니다');
}

// ===== 🎫 단축어 전용 주소 (용도별 토큰) =====
// 예전 단축어 주소에는 uid 와 '만능 열쇠' 가 같이 들어 있었다. 하나가 새면 전부 바꿔야 했고,
// 어느 단축어에서 샜는지도 알 수 없었다.
// 이제는 워치용·카드용 주소를 따로 발급한다.
//   · 서버에는 토큰의 해시만 남는다 (KV 를 들여다봐도 토큰 원문은 없다)
//   · 새로 받으면 그 용도의 옛 주소는 바로 끊긴다
//   · 주소에 uid 가 없다 — 토큰이 누구 것인지는 서버만 안다
// 이 주소로 들어온 기록은 서버가 자기 출입증(서비스 계정)으로 Firestore 에 쓴다.
// 그래서 Firestore 규칙에서 '로그인 없이 쓰기' 를 닫을 수 있게 된다.
const RELAY_PURPOSES = ['workout', 'expense'];

async function hashTok(s) {
  const d = await crypto.subtle.digest('SHA-256', enc(String(s)));
  return b64url(new Uint8Array(d));
}

// 로그인한 앱이 보낸 '예전 열쇠' 가 누구 것인지 기억한다 (해시만).
//   Firestore 의 열쇠 목록을 공개로 열지 않고도 예전 주소의 열쇠를 확인할 수 있다.
async function registerUploadKey(env, uid, key) {
  if (!env.PUSH_KV || !uid || !/^[0-9a-f]{16,128}$/.test(String(key || ''))) return;
  try {
    const h = await hashTok(key);
    const slot = 'ukey:' + uid;
    if ((await env.PUSH_KV.get(slot)) !== h) await env.PUSH_KV.put(slot, h);
  } catch (e) {}
}

async function resolveRelayToken(env, token, purpose) {
  if (!env.PUSH_KV || !/^[0-9a-f]{40,128}$/.test(String(token || ''))) return null;
  const h = await hashTok(token);
  const raw = await env.PUSH_KV.get('rt:' + h);
  if (!raw) return null;
  let rec;
  try { rec = JSON.parse(raw); } catch (e) { return null; }
  if (!rec || !rec.uid || rec.purpose !== purpose) return null;
  // 마지막으로 쓴 날 — 하루 한 번만 고쳐 쓴다 (KV 쓰기 한도)
  const today = kstNow().date;
  if (rec.lastUsed !== today) {
    rec.lastUsed = today;
    try { await env.PUSH_KV.put('rt:' + h, JSON.stringify(rec)); } catch (e) {}
  }
  return rec;
}

// /keys/status · /keys/issue · /keys/revoke — 로그인 토큰으로만 부를 수 있다
async function handleKeys(request, env, url) {
  const body = await request.json().catch(() => ({}));
  const who = await requireUser(request, env, body);
  if (who.via !== 'token') return json({ error: '로그인이 필요해요. 앱을 껐다 켜주세요' }, 401);
  if (!env.PUSH_KV) return json({ error: 'PUSH_KV 가 없습니다' }, 500);
  const uid = who.uid;
  const op = url.pathname.slice('/keys/'.length);

  if (op === 'status') {
    const purposes = {};
    for (const p of RELAY_PURPOSES) {
      const h = await env.PUSH_KV.get('rtu:' + uid + ':' + p);
      let rec = null;
      if (h) { try { rec = JSON.parse((await env.PUSH_KV.get('rt:' + h)) || 'null'); } catch (e) {} }
      purposes[p] = rec ? { at: rec.at, lastUsed: rec.lastUsed || '' } : null;
    }
    return json({ ok: true, ready: !!env.FIREBASE_SA, purposes });
  }

  const purpose = String(body.purpose || '');
  if (!RELAY_PURPOSES.includes(purpose)) return json({ error: '어디에 쓸 주소인지 알 수 없어요' }, 400);
  const slot = 'rtu:' + uid + ':' + purpose;
  const old = await env.PUSH_KV.get(slot);

  if (op === 'revoke') {
    if (old) await env.PUSH_KV.delete('rt:' + old);
    await env.PUSH_KV.delete(slot);
    return json({ ok: true });
  }

  if (op === 'issue') {
    if (!env.FIREBASE_SA) return json({ error: '서버 준비가 아직 안 됐어요' }, 503);
    const bytes = crypto.getRandomValues(new Uint8Array(24));
    const token = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
    const h = await hashTok(token);
    await env.PUSH_KV.put('rt:' + h, JSON.stringify({ uid, purpose, at: new Date().toISOString() }));
    await env.PUSH_KV.put(slot, h);
    if (old && old !== h) await env.PUSH_KV.delete('rt:' + old);   // 새로 받으면 옛 주소는 끊긴다
    return json({ ok: true, token });
  }

  return json({ error: 'not found' }, 404);
}

// ===== 🗑️ 계정 삭제 — 이 서버에 남은 그 사람의 흔적을 전부 지운다 =====
// 앱이 Firestore 와 로그인 계정을 지우기 '전에' 부른다 (계정이 사라지면 토큰도 못 받는다).
async function handleAccountDelete(request, env) {
  const body = await request.json().catch(() => ({}));
  const who = await requireUser(request, env, body);
  if (who.via !== 'token') return json({ error: '로그인이 필요해요. 앱을 껐다 켜주세요' }, 401);
  if (!env.PUSH_KV) return json({ error: 'PUSH_KV 가 없습니다' }, 500);
  const uid = who.uid;
  const gone = [];
  const del = async (k) => { await env.PUSH_KV.delete(k); gone.push(k.split(':')[0]); };

  // 전용 주소: 해시 → 토큰 기록까지
  for (const p of RELAY_PURPOSES) {
    const slot = 'rtu:' + uid + ':' + p;
    const h = await env.PUSH_KV.get(slot);
    if (h) await del('rt:' + h);
    await del(slot);
  }
  for (const k of [subsKey(uid), planKey(uid), 'ukey:' + uid, 'authlast:' + uid,
    'relaylast:' + uid + ':workout', 'relaylast:' + uid + ':expense']) await del(k);
  // 열쇠 확인 캐시 (앞부분이 uid 인 것만)
  let cursor;
  do {
    const page = await env.PUSH_KV.list({ prefix: 'keyok:' + uid + ':', cursor });
    for (const k of page.keys) await del(k.name);
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  return json({ ok: true, removed: gone.length });
}

// ===== 🪪 서버 출입증 (Firebase 서비스 계정) =====
// FIREBASE_SA Secret 에 서비스 계정 JSON 이 통째로 들어 있다. 코드·GitHub 에는 없다.
// 그걸로 구글에서 한 시간짜리 출입증을 받아 Firestore 에 쓴다.
let SA_TOKEN = null;   // { token, until } — 같은 Worker 인스턴스 안에서만

function pemToDer(pem) {
  const b = String(pem || '').replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const bin = atob(b);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function adminAccessToken(env) {
  if (SA_TOKEN && SA_TOKEN.until > Date.now() + 60000) return SA_TOKEN.token;
  let sa;
  try { sa = JSON.parse(env.FIREBASE_SA); } catch (e) { throw new Error('FIREBASE_SA 를 읽지 못했어요'); }
  if (!sa || !sa.client_email || !sa.private_key) throw new Error('FIREBASE_SA 에 필요한 값이 없어요');
  if (sa.project_id && env.FIREBASE_PROJECT_ID && sa.project_id !== env.FIREBASE_PROJECT_ID) {
    throw new Error('FIREBASE_SA 가 다른 프로젝트 것이에요');
  }
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(enc(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const claim = b64url(enc(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/datastore',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now, exp: now + 3600,
  })));
  const key = await crypto.subtle.importKey('pkcs8', pemToDer(sa.private_key),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, enc(head + '.' + claim)));
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')
      + '&assertion=' + head + '.' + claim + '.' + b64url(sig),
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok || !d.access_token) throw new Error('서버 출입증 발급 실패 (HTTP ' + res.status + ')');
  SA_TOKEN = { token: d.access_token, until: Date.now() + (Number(d.expires_in) || 3600) * 1000 };
  return SA_TOKEN.token;
}

// 전용 주소로 들어온 기록을 '그 토큰 주인의' 수신함에 쓴다. 경로는 여기서만 만든다.
async function adminInboxWrite(env, uid, coll, bodyJson) {
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(String(uid))) throw new Error('uid 가 이상해요');
  if (!['workoutInbox', 'expenseInbox', 'todoInbox'].includes(coll)) throw new Error('쓸 수 없는 곳이에요');
  const token = await adminAccessToken(env);
  return fetch('https://firestore.googleapis.com/v1/projects/' + env.FIREBASE_PROJECT_ID
    + '/databases/(default)/documents/users/' + encodeURIComponent(uid) + '/' + coll, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: bodyJson,
  });
}

// 사람마다 따로 담는다 — 남의 알림이 섞이지 않게
const subsKey = (uid) => 'subs:' + uid;
const planKey = (uid) => 'plan:' + uid;

// ── 구독 등록 ──
async function handleSubscribe(request, env) {
  const body = await request.json().catch(() => ({}));
  const who = await requireUser(request, env, body);
  const sub = body.sub;
  if (!sub || !sub.endpoint) return json({ error: '구독 정보가 없습니다' }, 400);

  const list = await loadSubs(env, who.uid);
  // 같은 기기가 다시 등록하면 갈아끼운다
  const rest = list.filter(x => x.endpoint !== sub.endpoint);
  rest.push({ endpoint: sub.endpoint, keys: sub.keys, at: Date.now() });
  await env.PUSH_KV.put(subsKey(who.uid), JSON.stringify(rest.slice(-10)));   // 기기 10대까지

  return json({ ok: true, devices: rest.length });
}

// 알림을 끄면 서버에 남은 구독도 지운다.
// 예전엔 브라우저에서만 해지해서, 서버에는 기기 정보가 계속 남아 있었다.
// endpoint 를 주면 그 기기만, 안 주면 이 계정의 기기 전부.
async function handleUnsubscribe(request, env) {
  const body = await request.json().catch(() => ({}));
  const who = await requireUser(request, env, body);

  const endpoint = body && body.endpoint;
  if (!endpoint) {
    await env.PUSH_KV.delete(subsKey(who.uid));
    // 예약해둔 요약 문구에는 어제 지출 같은 내용이 들어 있다.
    // 받을 기기가 하나도 없으면 남겨둘 이유가 없으므로 같이 지운다.
    await env.PUSH_KV.delete(planKey(who.uid));
    return json({ ok: true, removed: 'all' });
  }

  const list = await loadSubs(env, who.uid);
  const alive = list.filter(x => x.endpoint !== endpoint);
  if (alive.length === 0) await env.PUSH_KV.delete(subsKey(who.uid));
  else await env.PUSH_KV.put(subsKey(who.uid), JSON.stringify(alive));

  return json({ ok: true, removed: list.length - alive.length, left: alive.length });
}

async function handleStatus(request, env, url) {
  // GET 이라 본문이 없다 — 주소에서 받는다
  const q = url ? { uid: url.searchParams.get('uid'), key: url.searchParams.get('key') } : null;
  const who = await requireUser(request, env, q);
  const list = await loadSubs(env, who.uid);
  return json({ devices: list.length, updatedAt: list.length ? list[list.length - 1].at : null });
}

async function handleTest(request, env) {
  const body = await request.json().catch(() => ({}));
  const who = await requireUser(request, env, body);
  const result = await sendToUser(env, who.uid, {
    title: '🔔 테스트 알림',
    body: '알림이 잘 오면 설정 끝났어요.',
    tag: 'test',
  });
  return json(result);
}

async function handleSend(request, env) {
  const body = await request.json().catch(() => ({}));
  const who = await requireUser(request, env, body);
  const result = await sendToUser(env, who.uid, {
    title: body.title || 'MyPlanner',
    body: body.body || '',
    tag: body.tag || 'myplanner',
    url: body.url,
  });
  return json(result);
}

// 단축어가 보낸 Firestore 본문을 그대로 받아 Firestore 에 넣고, 곧바로 알림을 보낸다.
// 본문 형식은 앱이 만들어 준 것 그대로다 — 단축어는 주소만 바꾸면 된다.
// 단축어의 Base64 인코딩은 긴 문자열에 줄바꿈을 끼워 넣는다.
// JSON 문자열 안에 날 줄바꿈이 들어가면 형식이 깨져 Firestore 가 400 으로 거부한다.
// 올바른 JSON 에는 문자열 안에 날 줄바꿈이 올 수 없으므로, 통째로 지워도 안전하다.
function stripBreaks(text) {
  return String(text || '').replace(/[\r\n]+/g, '');
}

// 앞뒤에 뭐가 붙어 있어도 JSON 부분만 뽑아낸다. 못 뽑으면 null.
function looseJson(raw) {
  const text = String(raw || '').replace(/^﻿/, '');
  try { return JSON.parse(text); } catch (e) {}

  // 줄바꿈만 빼면 되는 경우
  try { return JSON.parse(stripBreaks(text)); } catch (e) {}

  // multipart 껍데기 안에 든 경우 — 첫 { 부터 마지막 } 까지
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  if (a >= 0 && b > a) {
    const inner = text.slice(a, b + 1);
    try { return JSON.parse(inner); } catch (e) {}
    try { return JSON.parse(stripBreaks(inner)); } catch (e) {}
  }
  return null;
}

// JSON 안에서 그 부분만 다시 꺼낸다 (저장할 때는 껍데기와 줄바꿈을 빼고 보내야 한다)
function jsonSlice(raw) {
  const text = String(raw || '').replace(/^﻿/, '');
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  return stripBreaks((a >= 0 && b > a) ? text.slice(a, b + 1) : text);
}

// 예전 주소(uid + 열쇠)로 왔어도, 그 열쇠가 그 사람 것으로 확인되면 서버 출입증으로 쓴다.
//   이러면 단축어를 하나도 안 바꿔도 Firestore 의 '로그인 없이 쓰기' 를 닫을 수 있다.
//   확인이 안 되면 예전처럼 규칙에 맡긴다 (규칙을 닫은 뒤엔 그대로 거부된다).
async function legacyKeyOk(env, uid, key) {
  if (!env.FIREBASE_SA || !uid || !key) return false;
  try { return (await keyBelongsTo(env, uid, key)) === 'ok'; } catch (e) { return false; }
}

// 어느 길로 저장됐는지 사람·용도별로 남긴다 — 규칙을 닫아도 되는지 확인하려고
async function noteRelay(env, uid, purpose, via, ok) {
  if (!env.PUSH_KV || !uid) return;
  try {
    await env.PUSH_KV.put('relaylast:' + uid + ':' + purpose,
      JSON.stringify({ via, ok: !!ok, at: new Date().toISOString() }), { expirationTtl: 60 * 86400 });
  } catch (e) {}
}

// 💳 카드 문자 중계 — 단축어가 '메시지 받았을 때' 로 보낸 문자를 수신함에 쌓는다.
//   워치 중계와 같은 구조다. 로그인 토큰 없이 uid + 열쇠로 신분을 증명하고,
//   Firestore 규칙이 그 열쇠를 uploadKeys 로 대조한다.
async function handleRelayExpense(request, env, url) {
  const raw = await request.text();
  const parsed = looseJson(raw);

  const relayTok = (url && url.searchParams.get('t')) || request.headers.get('X-Relay-Token') || '';
  let viaToken = null;
  if (relayTok) {
    viaToken = await resolveRelayToken(env, relayTok, 'expense');
    if (!viaToken) return json({ error: '이 주소는 폐기됐거나 틀렸어요. 앱의 문자 연동 설정에서 주소를 다시 복사해주세요' }, 401);
  }
  const uidFromUrl = viaToken ? viaToken.uid : ((url && url.searchParams.get('uid')) || '');
  const keyFromUrl = viaToken ? 'relay' : ((url && url.searchParams.get('key')) || '');
  let uid = uidFromUrl || env.MY_UID || '';
  if (!uid) return json({ error: '주소에 uid 가 없어요. 앱에서 주소를 다시 복사해 넣어주세요' }, 400);
  const useAdmin = !!viaToken || (await legacyKeyOk(env, uid, keyFromUrl));

  // 문자는 본문으로도, 주소(?text=)로도 올 수 있다 — 단축어 설정이 사람마다 다르다
  let text = '';
  if (parsed && parsed.fields && parsed.fields.text) text = String(parsed.fields.text.stringValue || '');
  else if (parsed && typeof parsed.text === 'string') text = parsed.text;
  else if (url && url.searchParams.get('text')) text = url.searchParams.get('text');
  else text = stripBreaks(raw).slice(0, 2000);

  text = String(text || '').trim().slice(0, 2000);
  if (!text) return json({ error: '문자 내용이 비어 있어요' }, 400);

  // ⚠️ 규칙의 hasOnly 목록에 없는 항목을 넣으면 저장이 통째로 거부된다.
  const proj = env.FIREBASE_PROJECT_ID;
  const apiKey = env.FIREBASE_API_KEY;
  const body = JSON.stringify({
    fields: {
      key: { stringValue: keyFromUrl },
      text: { stringValue: text },
      at: { integerValue: String(Date.now()) },
    },
  });

  const target = `https://firestore.googleapis.com/v1/projects/${proj}/databases/(default)/documents/users/${uid}/expenseInbox?key=${apiKey}`;
  const res = useAdmin
    ? await adminInboxWrite(env, uid, 'expenseInbox', body)
    : await fetch(target, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });

  await noteRelay(env, uid, 'expense', viaToken ? 'token' : (useAdmin ? 'key-admin' : 'rules'), res.ok);
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    const why = res.status === 403
      ? '열쇠가 등록돼 있지 않아요. 앱의 문자 연동 설정에서 주소를 다시 복사해 넣어주세요'
      : 'Firestore 저장 실패';
    return json({ error: why, status: res.status, detail: detail.slice(0, 400), uidFrom: uidFromUrl ? '주소' : 'MY_UID' }, 502);
  }

  // 저장됐으면 알림으로도 알려준다 — 앱을 안 열어도 들어온 걸 알 수 있게
  let pushed = { sent: 0 };
  try {
    pushed = await sendToUser(env, uid, {
      title: '💳 카드 내역 도착',
      body: text.slice(0, 80),
      tag: 'expense-' + kstNow().date,
    });
  } catch (e) {}

  return json({ ok: true, chars: text.length, push: pushed });
}

async function handleRelayWorkout(request, env, url) {
  const raw = await request.text();

  // 단축어는 본문을 '파일'로 보낸다. 그러면 앞뒤에 multipart 껍데기나 BOM 이 붙어 와서
  // 그냥 JSON.parse 하면 깨진다. Firestore 는 알아서 받아주지만 여기서는 직접 벗겨야 한다.
  // 그리고 못 읽더라도 저장은 그대로 진행한다 — 읽기 실패로 기록까지 끊기면 안 된다.
  const parsed = looseJson(raw);

  // 누구의 수신함에 넣을지는 앱이 주소에 넣어 보낸다 (?uid=...).
  //   전에는 Secrets 의 MY_UID 로 정했는데, 그 값이 실제 로그인 UID 와 다르면
  //   엉뚱한 곳에 저장돼 앱이 영영 못 봤다. 앱은 자기 UID 를 아니까 앱이 알려주는 게 맞다.
  //   UID 는 비밀이 아니다 — 예전 Firestore 직행 주소에도 그대로 들어 있었다.
  // 주소에 없으면 Secrets 의 MY_UID (아주 옛날 단축어용).
  //   예전엔 '알림을 켠 사람이 한 명뿐이면 그 사람' 으로 추측했는데, 사용자가 여럿이 되면
  //   남의 수신함·남의 폰으로 갈 수 있어 뺐다.
  // 🎫 전용 주소(?t=)면 토큰이 누구 것인지로 정한다. 주소의 uid·열쇠는 보지 않는다.
  const relayTok = (url && url.searchParams.get('t')) || request.headers.get('X-Relay-Token') || '';
  let viaToken = null;
  if (relayTok) {
    viaToken = await resolveRelayToken(env, relayTok, 'workout');
    if (!viaToken) return json({ error: '이 주소는 폐기됐거나 틀렸어요. 앱의 워치 연동 설정에서 주소를 다시 복사해주세요' }, 401);
  }
  const uidFromUrl = viaToken ? viaToken.uid : ((url && url.searchParams.get('uid')) || '');
  let uid = uidFromUrl || env.MY_UID || '';
  const legacyKey = (url && url.searchParams.get('key'))
    || (parsed && parsed.fields && parsed.fields.key && parsed.fields.key.stringValue) || '';
  let useAdmin = !!viaToken || (await legacyKeyOk(env, uid, legacyKey));
  if (!uid) {
    return json({ error: '누구의 기록인지 알 수 없어요. 앱에서 알림을 한 번 켜주시거나, 워치 연동 설정에서 주소를 다시 복사해주세요' }, 400);
  }

  // 여기서 INBOX_TOKEN 과 대조하지 않는다.
  //   그 값은 Worker 에 따로 적어둔 것이라, 앱에서 열쇠를 새로 만들면 어긋난다.
  //   어긋나면 전부 거부돼서 '아무것도 안 들어오는' 상태가 된다.
  // 대신 Firestore 규칙이 본문의 key 를 uploadKeys 로 검사한다.
  //   틀린 열쇠면 아래 저장이 거부되므로, 인증은 그쪽 한 곳에서만 하면 된다.
  if (!env.FIREBASE_PROJECT_ID || !env.FIREBASE_API_KEY) {
    throw new Error('FIREBASE_PROJECT_ID / FIREBASE_API_KEY 를 Secrets 에 넣어주세요');
  }

  const endpoint = 'https://firestore.googleapis.com/v1/projects/' + env.FIREBASE_PROJECT_ID
    + '/databases/(default)/documents/users/' + encodeURIComponent(uid) + '/workoutInbox'
    + '?key=' + env.FIREBASE_API_KEY;

  // Firestore 규칙이 사진 한 장당 900,000자로 막는다. 넘으면 통째로 거부된다.
  // 두 장 중 하나만 커도 다 날아가므로, 큰 쪽은 빼고 나머지라도 넣는다.
  const PHOTO_LIMIT = 900000;
  const DOC_LIMIT = 900000;   // 문서 하나가 1MB 를 못 넘는다. 여유를 두고 잡는다.
  let dropped = '';
  let outBody = jsonSlice(raw);
  if (parsed) {
    try {
      parsed.fields = parsed.fields || {};
      // ⚠️ 여기에 항목을 추가하면 안 된다.
      //    Firestore 규칙이 hasOnly 로 허용 목록을 딱 정해두는데, 목록에 없는 항목이 하나라도
      //    끼면 저장이 통째로 거부된다. 전에 'via' 표시를 넣었다가 전부 막혔다.
      //    단축어가 보낸 것만 그대로 넘긴다.

      // 열쇠를 주소로 받았으면 그걸 쓴다.
      //   본문에 열쇠를 박아 넣으면, 앱에서 열쇠가 바뀔 때마다 단축어의 본문까지 고쳐야 한다.
      //   본문은 세 조각으로 나뉘어 있어 하나만 옛것이어도 '열쇠가 맞지 않아' 거부된다.
      //   주소 하나만 다시 복사하면 되도록 여기서 갈아 끼운다.
      const keyFromUrl = (url && url.searchParams.get('key')) || '';
      if (keyFromUrl) parsed.fields.key = { stringValue: keyFromUrl };
      if (useAdmin) {
        // 서버 출입증으로 쓰면 규칙의 허용 목록이 적용되지 않는다 — 여기서 똑같이 걸러낸다
        parsed.fields.key = { stringValue: 'relay' };
        for (const k of Object.keys(parsed.fields)) {
          if (!['key', 'photo', 'photo2', 'photoMime', 'date', 'via', 'at'].includes(k)) delete parsed.fields[k];
        }
      }

      // 사진 값 안에 남은 공백·줄바꿈을 걷어낸다 (base64 는 그런 문자를 쓰지 않는다)
      for (const k of ['photo', 'photo2']) {
        const f2 = parsed.fields[k];
        if (f2 && typeof f2.stringValue === 'string') {
          f2.stringValue = f2.stringValue.replace(/[^A-Za-z0-9+/=]/g, '');
          if (!f2.stringValue) delete parsed.fields[k];
        }
      }

      const len = (k) => String((parsed.fields[k] && parsed.fields[k].stringValue) || '').length;

      // 문서 하나가 1MB 를 넘을 수 없다. 두 장이 각각은 작아도 합치면 넘길 수 있다.
      // 그때는 둘째를 뺀다 — 워치 요약은 첫 장에 종목·시간이 다 들어 있다.
      if (len('photo') + len('photo2') > DOC_LIMIT && parsed.fields.photo2) {
        delete parsed.fields.photo2;
        dropped = '두 번째 사진';
      }

      if (len('photo2') >= PHOTO_LIMIT) { delete parsed.fields.photo2; dropped = '두 번째 사진'; }
      if (len('photo') >= PHOTO_LIMIT) {
        // 첫 장이 크면 둘째를 첫째 자리로 올린다 (규칙이 photo 를 반드시 요구한다)
        if (parsed.fields.photo2 && len('photo2') < PHOTO_LIMIT) {
          parsed.fields.photo = parsed.fields.photo2;
          delete parsed.fields.photo2;
          dropped = '첫 번째 사진';
        }
      }
      outBody = JSON.stringify(parsed);
    } catch (e) { /* 못 고치면 벗긴 원본 그대로 보낸다 */ }
  }

  if (useAdmin && !parsed) {
    if (viaToken) return json({ error: '보낸 내용을 읽지 못했어요. 단축어 본문을 확인해주세요' }, 400);
    useAdmin = false;   // 예전 주소면 예전처럼 규칙에 맡긴다
  }
  const res = useAdmin
    ? await adminInboxWrite(env, uid, 'workoutInbox', outBody)
    : await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: outBody,
    });

  await noteRelay(env, uid, 'workout', viaToken ? 'token' : (useAdmin ? 'key-admin' : 'rules'), res.ok);
  if (!res.ok) {
    const detail = await res.text();
    // 왜 거부됐는지 짐작할 수 있게 실제로 쓴 값들을 같이 돌려준다
    const photoLen = String((parsed && parsed.fields && parsed.fields.photo && parsed.fields.photo.stringValue) || '').length;
    const photo2Len = String((parsed && parsed.fields && parsed.fields.photo2 && parsed.fields.photo2.stringValue) || '').length;
    const tooBig = photoLen >= 900000 || photo2Len >= 900000
      || photoLen + photo2Len > 900000
      || /larger than|too large|1048487/i.test(detail);

    let why;
    if (tooBig) {
      why = `사진이 너무 커요 (합쳐서 ${Math.round((photoLen + photo2Len) / 1024)}KB · 한 번에 900KB 까지). `
        + '단축어에서 <최근 사진 가져오기> 뒤에 <이미지 크기 조절 — 너비 800> 을 넣어주세요. 글자는 그대로 읽히고 용량만 1/10 이 됩니다';
    } else if (!uidFromUrl) {
      why = '주소에 uid 가 없어 엉뚱한 계정에 쓰려고 했어요. '
        + '앱의 워치 연동 설정에서 주소를 다시 복사해 단축어에 넣어주세요 (…/relay/workout?uid=… 형태여야 합니다)';
    } else if (res.status === 403 || /PERMISSION_DENIED/i.test(detail)) {
      why = (url && url.searchParams.get('key'))
        ? '열쇠가 등록돼 있지 않아요. 앱의 워치 연동 설정에서 <열쇠 새로 만들기>를 누른 뒤 주소를 다시 복사해 넣어주세요'
        : '주소에 열쇠가 없어요. 앱의 워치 연동 설정에서 주소를 다시 복사해 단축어에 넣어주세요 (…?uid=…&key=… 형태여야 합니다)';
    } else {
      why = 'Firestore 저장 실패';
    }
    // 어떤 열쇠로 시도했는지 끝 6자리만 보여준다 (앱 화면의 것과 대조하려고)
    const usedKey = String(
      (url && url.searchParams.get('key'))
      || (parsed && parsed.fields && parsed.fields.key && parsed.fields.key.stringValue)
      || ''
    );
    // 저장이 안 됐어도 알림은 보낸다.
    //   알림과 저장은 별개다 — 알림은 여기서 바로 쏘고, Firestore 는 앱이 나중에 읽을 기록용이다.
    //   저장이 막혔다고 알림까지 막으면 '운동 끝난 줄도 모르는' 상태가 된다.
    //   단, 열쇠가 정말 그 사람 것일 때만 — 아니면 uid 만 아는 누구나 알림을 쏠 수 있다.
    let sos = { sent: 0 };
    try {
      if (useAdmin || (usedKey && (await keyBelongsTo(env, uid, usedKey)) === 'ok')) sos = await sendToUser(env, uid, {
        title: '⌚ 운동 기록 도착',
        body: tooBig
          ? '사진이 너무 커서 저장은 못 했어요. 앱에서 직접 넣어주세요.'
          : '들어왔지만 저장에 실패했어요. 앱을 열어 확인해주세요.',
        tag: 'workout-' + kstNow().date,
      });
    } catch (e) { /* 알림까지 실패해도 아래 응답은 돌려준다 */ }

    return json({
      error: why, status: res.status,
      push: sos,
      rawKB: Math.round(String(raw || '').length / 1024),   // 단축어가 실제로 보낸 크기
      parsed: parsed ? '읽음' : '못 읽음',
      uidFrom: uidFromUrl ? '주소' : 'MY_UID',
      keyFrom: (url && url.searchParams.get('key')) ? '주소' : '본문',
      keyTail: usedKey ? '…' + usedKey.slice(-6) : '(없음)',
      uidTail: uid ? '…' + String(uid).slice(-6) : '(없음)',
      photoKB: Math.round(photoLen / 1024), photo2KB: Math.round(photo2Len / 1024),
      detail: detail.slice(0, 300),
    }, 502);
  }

  // 사진은 앱이 읽어야 종목·시간을 안다. 하지만 단축어가 값으로 보낸 경우엔
  // 여기서 바로 알려줄 수 있다 — '캡처가 들어왔어요' 로는 뭐가 왔는지 모른다.
  // 본문을 못 읽었어도 저장은 이미 끝났다. 알림 문구만 뭉뚱그린다.
  const f = (parsed && parsed.fields) || {};
  const str = (k) => f?.[k]?.stringValue || '';
  const num = (k) => Number(f?.[k]?.integerValue ?? f?.[k]?.doubleValue ?? 0) || 0;

  const shots = str('photo2') ? 2 : (str('photo') ? 1 : 0);
  const sport = str('sport');
  const minutes = num('minutes');
  const kcal = num('kcal');
  const dist = num('dist');
  const unit = str('unit');

  let body;
  if (shots > 0) {
    body = (shots > 1 && !dropped)
      ? '캡처 2장이 들어왔어요. 앱을 열면 정리됩니다.'
      : (dropped ? `캡처가 들어왔어요 (${dropped}은 너무 커서 뺐어요). 앱을 열면 정리됩니다.` : '캡처가 들어왔어요. 앱을 열면 정리됩니다.');
  } else {
    // 값으로 온 경우 — 무엇이 들어왔는지 그대로 보여준다
    const bits = [];
    if (sport) bits.push(sport);
    if (dist > 0) bits.push(dist + (unit || ''));
    if (minutes > 0) bits.push(minutes + '분');
    if (kcal > 0) bits.push(kcal + 'kcal');
    body = bits.length ? bits.join(' · ') + ' 기록됐어요' : '운동 기록이 들어왔어요';
  }

  // 단축어는 주인 것이므로 주인에게만 보낸다 (예전엔 등록된 모든 기기로 갔다)
  const payload = {
    title: '⌚ 운동 기록 도착',
    body,
    tag: 'workout-' + kstNow().date,   // 같은 날 것은 하나로 덮는다 (매번 다르면 알림이 쌓인다)
  };
  // 저장한 그 사람에게만 보낸다 (저장이 됐다는 건 규칙이 열쇠를 확인했다는 뜻이다).
  const pushed = await sendToUser(env, uid, payload);

  // 알림이 갔는지까지 알려준다. ok 만 돌려주면 '저장은 됐는데 알림이 안 온다'를 못 가린다.
  return json({
    ok: true, shots, push: pushed, dropped: dropped || undefined,
    rawKB: Math.round(String(raw || '').length / 1024),
    photoKB: Math.round(String((parsed && parsed.fields && parsed.fields.photo && parsed.fields.photo.stringValue) || '').length / 1024),
  });
}


// 앱이 '언제 무슨 내용으로 보낼지'를 넣어둔다
// 📱 홈 화면·잠금화면 위젯이 읽는 곳 (Scriptable 앱의 스크립트가 부른다).
//   앱이 올려둔 '오늘 정리' 와 시간 일정을 짧게 내준다.
//   웹 앱은 iOS 위젯을 직접 못 만들어서, 위젯 앱이 이 주소를 읽어 그린다.
async function handleWidget(env, url) {
  const uid = String(url.searchParams.get('uid') || '');
  const key = String(url.searchParams.get('key') || '');
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(uid) || !key) return json({ error: '주소가 올바르지 않아요' }, 400);
  if (!env.PUSH_KV) return json({ error: '서버 저장소가 없어요' }, 500);

  const raw = await env.PUSH_KV.get(planKey(uid));
  if (!raw) return json({ error: '앱을 한 번 열어주세요' }, 404);
  let plan;
  try { plan = JSON.parse(raw); } catch (e) { return json({ error: '저장된 내용이 깨졌어요' }, 500); }

  // 열쇠가 다르면 아무것도 안 준다 (내용이 개인 일정이다)
  if (!plan.widgetKey || plan.widgetKey !== key) return json({ error: '열쇠가 맞지 않아요. 앱에서 위젯 스크립트를 다시 복사해주세요' }, 403);

  const now = kstNow();
  const forToday = (plan.days || []).find(d => d && d.builtFor === now.date);
  const body = forToday ? forToday.body
    : (String(plan.builtFor || '') === now.date ? plan.body : '');
  const lines = String(body || '').split('\n').map(x => x.trim()).filter(Boolean);

  // 다음 일정 — 지금 이후로 가장 이른 것
  const hhmm = `${String(Math.floor(now.minutes / 60)).padStart(2, '0')}:${String(now.minutes % 60).padStart(2, '0')}`;
  const today = ((plan.agenda || {})[now.date] || []).filter(a => a && a.at && a.title);
  const upcoming = today.filter(a => String(a.at) >= hhmm).sort((a, b) => String(a.at).localeCompare(String(b.at)));

  const saved = Number(plan.savedAt) || 0;
  const t = new Date(saved + 9 * 60 * 60 * 1000);
  const updated = saved ? `${t.getUTCMonth() + 1}/${t.getUTCDate()} ${String(t.getUTCHours()).padStart(2, '0')}:${String(t.getUTCMinutes()).padStart(2, '0')}` : '';

  return json({
    date: now.date,
    title: '📋 오늘',
    lines: lines.length ? lines : ['앱을 열면 오늘 내용이 채워져요'],
    next: upcoming.length ? `${upcoming[0].at} ${upcoming[0].title}` : '',
    agenda: today.slice(0, 8),
    updated,
    ...widgetView(plan, now.date),
  });
}

// 앱이 보낸 위젯 내용을 정리해 둔다 (길이·개수 제한 — 남이 큰 값을 밀어넣지 못하게)
function cleanWidgetData(w) {
  if (!w || typeof w !== 'object') return null;
  const str = (x, n) => String(x == null ? '' : x).slice(0, n);
  const num = (x) => { const v = Number(x); return Number.isFinite(v) ? v : 0; };
  const out = { date: /^\d{4}-\d{2}-\d{2}$/.test(String(w.date || '')) ? w.date : '' };
  out.todos = (Array.isArray(w.todos) ? w.todos : []).slice(0, 40).map(t => ({
    id: str(t && t.id, 40), t: str(t && t.t, 60),
    at: /^\d{2}:\d{2}$/.test(String(t && t.at || '')) ? t.at : '',
    done: !!(t && t.done), rep: !!(t && t.rep),
  })).filter(t => t.id && t.t);
  if (w.workout) out.workout = { done: !!w.workout.done, min: num(w.workout.min) };
  out.spent = num(w.spent);
  if (w.living) out.living = { left: num(w.living.left), perDay: num(w.living.perDay), daysLeft: num(w.living.daysLeft), total: num(w.living.total), spent: num(w.living.spent) };
  out.upcoming = (Array.isArray(w.upcoming) ? w.upcoming : []).slice(0, 10).map(u => ({
    d: str(u && u.d, 6), w: str(u && u.w, 2), at: /^\d{2}:\d{2}$/.test(String(u && u.at || '')) ? u.at : '', t: str(u && u.t, 60), n: num(u && u.n),
  })).filter(u => u.t);
  if (w.asset) out.asset = { net: num(w.asset.net), total: num(w.asset.total), debt: num(w.asset.debt), diff: w.asset.diff == null ? null : num(w.asset.diff) };
  if (w.goals) out.goals = {
    done: num(w.goals.done), total: num(w.goals.total),
    items: (Array.isArray(w.goals.items) ? w.goals.items : []).slice(0, 5).map(x => str(x, 40)),
  };
  return out;
}

// 위젯에 줄 오늘 할일 — 앱이 마지막으로 보낸 것 위에 '위젯에서 누른 것' 을 덧씌운다
function widgetView(plan, date) {
  // 미리 받아둔 날짜별 것 중 오늘 것 → 없으면 마지막으로 받은 것이 오늘 것일 때만
  const w = ((plan && plan.widgetDays) || []).find(x => x && x.date === date)
    || (plan && plan.widget && plan.widget.date === date ? plan.widget : null);
  if (!w) return { todos: null };
  const todos = w.todos.map(t => ({ ...t }));
  for (const o of (plan.pendingOps || [])) {
    if (o.date !== date) continue;
    if (o.op === 'add') {
      if (!todos.some(t => t.id === o.id)) todos.push({ id: o.id, t: o.text, at: o.time || '', done: false, rep: false, pending: true });
      continue;
    }
    const t = todos.find(x => x.id === o.id);
    if (t) t.done = o.op === 'done';
  }
  todos.sort((a, b) => (a.done - b.done) || String(a.at || '99').localeCompare(String(b.at || '99')));
  const done = todos.filter(t => t.done).length;
  return {
    todos, count: { done, total: todos.length },
    workout: w.workout || null, spent: w.spent || 0, living: w.living || null, goals: w.goals || null,
    upcoming: w.upcoming || [], asset: w.asset || null,
  };
}

// ✅ 위젯·Scriptable 에서 할일 체크·추가.
//   앱의 할일 목록을 서버가 직접 고치지 않는다 — 앱이 통째로 저장하는 구조라
//   서로 덮어쓸 수 있다. 대신 '이렇게 해달라' 를 수신함에 넣고, 앱이 열릴 때 반영한다.
//   그 사이에도 위젯에는 바로 보이도록 서버의 위젯 내용에 덧씌워 둔다.
async function handleWidgetTodo(request, env, url) {
  const body = await request.json().catch(() => ({}));
  const uid = String(url.searchParams.get('uid') || body.uid || '');
  const key = String(url.searchParams.get('key') || body.key || '');
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(uid) || !key) return json({ error: '주소가 올바르지 않아요' }, 400);
  if (!env.PUSH_KV) return json({ error: '서버 저장소가 없어요' }, 500);
  if (!env.FIREBASE_SA) return json({ error: '서버 준비가 아직 안 됐어요' }, 503);

  const raw = await env.PUSH_KV.get(planKey(uid));
  if (!raw) return json({ error: '앱을 한 번 열어주세요' }, 404);
  let plan;
  try { plan = JSON.parse(raw); } catch (e) { return json({ error: '저장된 내용이 깨졌어요' }, 500); }
  if (!plan.widgetKey || plan.widgetKey !== key) return json({ error: '열쇠가 맞지 않아요. 앱에서 위젯 스크립트를 다시 복사해주세요' }, 403);

  const op = String(body.op || '');
  if (!['done', 'undo', 'add'].includes(op)) return json({ error: '할 일을 알 수 없어요' }, 400);
  const date = kstNow().date;
  const at = Date.now();
  let id = String(body.id || '').slice(0, 40);
  const text = String(body.text || '').trim().slice(0, 60);
  const time = /^\d{2}:\d{2}$/.test(String(body.time || '')) ? String(body.time) : '';
  if (op === 'add') {
    if (!text) return json({ error: '내용을 적어주세요' }, 400);
    id = 'w' + at;   // 앱이 반영할 때 이 번호로 만든다 (두 번 들어와도 하나만)
  } else if (!id) {
    return json({ error: '어떤 할일인지 모르겠어요' }, 400);
  }

  const doc = { fields: {
    op: { stringValue: op }, id: { stringValue: id }, date: { stringValue: date },
    text: { stringValue: text }, time: { stringValue: time }, at: { integerValue: String(at) },
  } };
  const res = await adminInboxWrite(env, uid, 'todoInbox', JSON.stringify(doc));
  if (!res.ok) return json({ error: '저장하지 못했어요 (' + res.status + ')' }, 502);

  plan.pendingOps = (plan.pendingOps || []).filter(o => !(o.id === id && o.op !== 'add')).concat([{ op, id, date, text, time, at }]).slice(-60);
  await env.PUSH_KV.put(planKey(uid), JSON.stringify(plan));
  return json({ ok: true, id, ...widgetView(plan, date) });
}

async function handlePlan(request, env) {
  const body = await request.json().catch(() => ({}));
  const who = await requireUser(request, env, body);

  if (!env.PUSH_KV) throw new Error('PUSH_KV 바인딩이 없습니다 (KV 연결 필요)');

  if (body.at === 'off') {
    await env.PUSH_KV.delete(planKey(who.uid));
    return json({ ok: true, off: true });
  }
  if (!/^\d{2}:\d{2}$/.test(String(body.at || ''))) {
    return json({ error: '시각은 HH:MM 형식이어야 합니다' }, 400);
  }

  // 요약은 앱을 열 때 만들어 둔다. 그날 아침에 앱을 안 열면 낡은 것이 나가므로
  // 날짜별로 미리 담아 둔다 (오늘 + 내일). 서버는 그날에 맞는 것을 골라 보낸다.
  const days = Array.isArray(body.days) ? body.days.filter(d =>
    d && /^\d{4}-\d{2}-\d{2}$/.test(String(d.builtFor || '')) && typeof d.body === 'string'
  ).slice(0, 7) : [];

  // 정한 시각에 뜨는 할일 알림 (앱이 꺼져 있어도 온다)
  const todoAlerts = Array.isArray(body.todoAlerts) ? body.todoAlerts.filter(a =>
    a && /^\d{4}-\d{2}-\d{2}$/.test(String(a.on || '')) &&
    /^\d{2}:\d{2}$/.test(String(a.at || '')) && typeof a.title === 'string'
  ).slice(0, 300) : [];      // 앞으로 2주치를 한꺼번에 받아둔다

  const prev = await env.PUSH_KV.get(planKey(who.uid));
  let old = null;
  try { old = prev ? JSON.parse(prev) : null; } catch (e) {}

  // 📊 월말 결산 — 말일 저녁에 한 번. 매일 요약과 따로 둔다.
  const m = body.monthly;
  const monthly = (m && /^\d{4}-\d{2}-\d{2}$/.test(String(m.on || '')) &&
                   /^\d{2}:\d{2}$/.test(String(m.at || '')) && typeof m.body === 'string')
    ? { on: m.on, at: m.at, title: m.title || '📊 이번 달 정리', body: m.body }
    : null;

  const plan = {
    at: body.at,                                  // 한국 시간 기준
    title: body.title || '📋 오늘 정리',
    body: body.body || '',
    builtFor: body.builtFor || '',
    days,
    todoAlerts,
    monthly,
    sentMonthly: (old && old.sentMonthly) || '',  // 보낸 달 (YYYY-MM)
    // 📱 위젯이 읽을 때 대조할 열쇠. 위젯 주소는 내용을 그대로 내주므로,
    //    uid 만 안다고 남의 할일을 볼 수 있으면 안 된다 — 앱이 쓴 열쇠와 맞아야 준다.
    widgetKey: /^[0-9a-f]{16,128}$/.test(String(body.key || '')) ? String(body.key) : ((old && old.widgetKey) || ''),
    // 위젯에 띄울 날짜별 시간 일정 { 'YYYY-MM-DD': [{at, title}] }
    agenda: (body.agenda && typeof body.agenda === 'object') ? body.agenda : {},
    sentTodo: (old && old.sentTodo) || {},        // 이미 보낸 할일 알림 (중복 방지)
    tag: body.tag || 'daily-summary',
    // 아침 요약·할일 알림을 끈 사람도 위젯은 쓸 수 있다 — 끔 표시만 하고 내용은 받아둔다
    summaryOff: !!body.summaryOff,
    alertsOff: !!body.alertsOff,
    widget: cleanWidgetData(body.widget),
    widgetDays: (Array.isArray(body.widgetDays) ? body.widgetDays : []).slice(0, 3).map(cleanWidgetData).filter(Boolean),
    // 위젯에서 눌렀는데 앱이 아직 반영 안 한 것 — 앱이 수신함을 비운 시각 이후 것만 남긴다
    pendingOps: ((old && old.pendingOps) || []).filter(o => o && Number(o.at) > (Number(body.inboxDrainedAt) || 0)),
    savedAt: Date.now(),
  };
  await env.PUSH_KV.put(planKey(who.uid), JSON.stringify(plan));
  return json({ ok: true, at: plan.at });
}

// 한국 시간의 오늘 날짜와 분(minute of day)
function kstNow() {
  const t = new Date(Date.now() + 9 * 60 * 60 * 1000);   // Worker 는 UTC 로 돈다
  return {
    date: t.toISOString().slice(0, 10),
    minutes: t.getUTCHours() * 60 + t.getUTCMinutes(),
  };
}

// Cron 이 부를 때마다 등록된 사람을 훑는다.
// 사람마다 정한 시각이 다르므로 각자의 plan 을 따로 본다.
async function runPlan(env) {
  if (!env.PUSH_KV) return;

  let cursor;
  do {
    const page = await env.PUSH_KV.list({ prefix: 'plan:', cursor });
    for (const k of page.keys) {
      const uid = k.name.slice('plan:'.length);
      // 한 사람이 실패해도 나머지는 보내야 한다
      try { await runPlanFor(env, uid); } catch (e) { /* 다음 사람으로 */ }
      try { await runTodoAlertsFor(env, uid); } catch (e) { console.log('할일 알림 실패', uid, e && e.message); }
      try { await runMonthlyFor(env, uid); } catch (e) { console.log('월말 결산 실패', uid, e && e.message); }
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
}

async function runPlanFor(env, uid) {
  const raw = await env.PUSH_KV.get(planKey(uid));
  if (!raw) return;
  if (raw.indexOf('"summaryOff":true') >= 0) return;   // 아침 요약을 끈 사람

  let plan;
  try { plan = JSON.parse(raw); } catch (e) { return; }
  if (!plan || !plan.at) return;

  const now = kstNow();
  const [hh, mm] = plan.at.split(':').map(Number);
  const target = hh * 60 + mm;

  // Cron 간격(10분)을 감안해 지정 시각부터 10분 안이면 보낸다
  const diff = now.minutes - target;
  if (diff < 0 || diff > 10) return;

  // 하루 한 번만
  if (plan.sentOn === now.date) return;

  // 요약은 '만들어진 그 날'의 내용이다. 어제 만든 것을 오늘 아침에 보내면
  // 어제의 할일·목표·환율이 오늘 것인 양 뜬다 — 날짜로 고른다.
  // 앱이 오늘·내일 것을 미리 담아 두므로, 아침에 앱을 안 열어도 내용이 나온다.
  const forToday = (plan.days || []).find(d => d && d.builtFor === now.date);
  const body = forToday
    ? (forToday.body || '')
    : (String(plan.builtFor || '') === now.date
        ? (plan.body || '')
        : '앱을 열면 오늘 할일·목표·시세를 정리해드릴게요.');

  await sendToUser(env, uid, {
    title: plan.title,
    body,
    tag: plan.tag,
    url: './index.html?open=summary',   // 누르면 오늘 것으로 새로 만들어 보여준다
    kind: 'summary',
  });

  plan.sentOn = now.date;
  await env.PUSH_KV.put(planKey(uid), JSON.stringify(plan));
}

// 월말 결산. 말일 그 시각이 지나면 한 번 보낸다.
async function runMonthlyFor(env, uid) {
  const raw = await env.PUSH_KV.get(planKey(uid));
  if (!raw) return;

  let plan;
  try { plan = JSON.parse(raw); } catch (e) { return; }
  const m = plan && plan.monthly;
  if (!m || !m.on) return;

  const now = kstNow();
  if (m.on !== now.date) return;                  // 말일이 아니다

  const month = now.date.slice(0, 7);
  if (plan.sentMonthly === month) return;         // 이번 달은 이미 보냈다

  const [hh, mm] = String(m.at).split(':').map(Number);
  const diff = now.minutes - (hh * 60 + mm);
  if (diff < 0 || diff > 60) return;              // 아직이거나 너무 늦음

  await sendToUser(env, uid, {
    title: m.title || '📊 이번 달 정리',
    body: m.body || '',
    tag: 'monthly-' + month,
    url: './index.html',
    requireInteraction: true,
  });

  plan.sentMonthly = month;
  await env.PUSH_KV.put(planKey(uid), JSON.stringify(plan));
}

// 시각을 정해둔 할일은 그 시각에 알린다. 앱이 꺼져 있어도 온다.
// Cron 간격만큼(10분) 늦을 수 있어, 지난 30분 안의 것까지 훑어 놓치지 않게 한다.
async function runTodoAlertsFor(env, uid) {
  const raw = await env.PUSH_KV.get(planKey(uid));
  if (!raw) return;
  if (raw.indexOf('"alertsOff":true') >= 0) return;    // 알림을 끈 사람

  let plan;
  try { plan = JSON.parse(raw); } catch (e) { return; }
  const list = (plan && plan.todoAlerts) || [];
  if (!Array.isArray(list) || list.length === 0) return;

  const now = kstNow();
  if (!plan.sentTodo || typeof plan.sentTodo !== 'object') plan.sentTodo = {};

  const due = [];
  for (const a of list) {
    if (!a || a.on !== now.date) continue;
    const [hh, mm] = String(a.at).split(':').map(Number);
    const target = hh * 60 + mm;
    const diff = now.minutes - target;
    if (diff < 0 || diff > 30) continue;          // 아직이거나 너무 늦음
    const key = `${a.on} ${a.at} ${a.title}`;
    if (plan.sentTodo[key]) continue;             // 이미 보냄
    due.push({ a, key });
  }
  if (due.length === 0) return;

  for (const { a, key } of due) {
    await sendToUser(env, uid, {
      title: `⏰ ${a.at} ${a.title}`,
      body: a.note || '지금 할 시간이에요',
      tag: 'todo-' + key,                          // 같은 할일은 하나로
      url: './index.html',
      // 눌러서 치울 때까지 화면에 남긴다. 잠깐 떴다 사라지면 놓친다.
      requireInteraction: true,
      renotify: true,
      vibrate: [200, 100, 200, 100, 200],
    });
    plan.sentTodo[key] = 1;
  }

  // 지난 날짜 기록은 버린다 (KV 값이 무한정 커지지 않게)
  const keep = {};
  for (const k of Object.keys(plan.sentTodo)) {
    if (String(k).slice(0, 10) >= now.date) keep[k] = 1;
  }
  plan.sentTodo = keep;
  await env.PUSH_KV.put(planKey(uid), JSON.stringify(plan));
}

async function loadSubs(env, uid) {
  if (!env.PUSH_KV) throw new Error('PUSH_KV 바인딩이 없습니다 (KV 연결 필요)');
  if (!uid) throw new Error('누구의 기기인지 알 수 없습니다');

  const raw = await env.PUSH_KV.get(subsKey(uid));
  if (raw) {
    try { return JSON.parse(raw) || []; } catch (e) { return []; }
  }

  // 예전엔 옛 공용 칸('subscriptions')을 여기로 옮겨 왔는데, 기기가 없는 사람 누구에게나
  // 주인의 기기를 붙여줄 수 있어 뺐다. 주인 기기는 이미 옮겨졌다 (2026-11-19 확인).
  return [];
}

// ── 실제 발송 ──
// 반드시 uid 를 받는다. 예전처럼 '모두에게' 보내면 남의 요약이 내 폰에 뜬다.
// 단축어가 쓰는 길 그대로 알림만 보내본다 (Firestore 는 안 건드린다).
// '저장은 되는데 알림이 안 온다'를 앱에서 한 번에 가려내기 위한 것.
async function handleRelayPing(request, env) {
  // 예전엔 아무나 부를 수 있었고 주인 폰으로 갔다 — 이제는 로그인한 본인에게만.
  const body = await request.json().catch(() => ({}));
  let who;
  try { who = await requireUser(request, env, body); }
  catch (e) { return json({ error: String(e.message || e) }, 401); }
  const pushed = await sendToUser(env, who.uid, {
    title: '⌚ 서버 알림 시험',
    body: '이 알림이 보이면 앱이 꺼져 있어도 알림이 옵니다.',
    tag: 'relay-ping',
  });
  return json({ ok: true, push: pushed });
}

async function sendToUser(env, uid, payload) {
  const subs = await loadSubs(env, uid);
  if (subs.length === 0) return { sent: 0, note: '등록된 기기가 없습니다' };

  const body = JSON.stringify(payload);
  let sent = 0;
  const dead = [];

  for (const sub of subs) {
    try {
      const res = await sendOne(env, sub, body);
      if (res.ok) sent++;
      // 410/404 = 구독이 만료됐거나 앱이 지워짐 → 목록에서 뺀다
      else if (res.status === 404 || res.status === 410) dead.push(sub.endpoint);
    } catch (e) {
      // 네트워크 실패는 다음에 다시 시도
    }
  }

  if (dead.length > 0) {
    const alive = subs.filter(x => !dead.includes(x.endpoint));
    await env.PUSH_KV.put(subsKey(uid), JSON.stringify(alive));
  }
  return { sent, total: subs.length, removed: dead.length };
}

async function sendOne(env, sub, plaintext) {
  const endpoint = new URL(sub.endpoint);
  const audience = endpoint.origin;

  const jwt = await makeVapidJwt(env, audience);
  const encrypted = await encryptPayload(sub, plaintext);

  return fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      'Authorization': `vapid t=${jwt}, k=${env.VAPID_PUBLIC}`,
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      'TTL': '86400',
    },
    body: encrypted,
  });
}

// ── VAPID 서명 (ES256) ──
async function makeVapidJwt(env, audience) {
  const header = { typ: 'JWT', alg: 'ES256' };
  const claims = {
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
    sub: env.VAPID_SUBJECT || 'mailto:admin@example.com',
  };
  const unsigned = b64url(enc(JSON.stringify(header))) + '.' + b64url(enc(JSON.stringify(claims)));

  const key = await importVapidPrivateKey(env.VAPID_PRIVATE, env.VAPID_PUBLIC);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc(unsigned));
  return unsigned + '.' + b64url(new Uint8Array(sig));
}

async function importVapidPrivateKey(privB64, pubB64) {
  const d = b64urlDecode(privB64);
  const pub = b64urlDecode(pubB64);          // 65바이트 (0x04 + x + y)
  if (pub.length !== 65) throw new Error('VAPID_PUBLIC 형식이 이상합니다');
  const jwk = {
    kty: 'EC', crv: 'P-256', ext: true,
    d: b64url(d),
    x: b64url(pub.slice(1, 33)),
    y: b64url(pub.slice(33, 65)),
  };
  return crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
}

// ── 본문 암호화 (RFC 8291, aes128gcm) ──
async function encryptPayload(sub, plaintext) {
  const clientPub = b64urlDecode(sub.keys.p256dh);   // 65바이트
  const auth = b64urlDecode(sub.keys.auth);          // 16바이트

  // 보낼 때마다 새 키 한 쌍을 만든다
  const server = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const serverPubRaw = new Uint8Array(await crypto.subtle.exportKey('raw', server.publicKey));

  const clientKey = await crypto.subtle.importKey('raw', clientPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: clientKey }, server.privateKey, 256));

  const salt = crypto.getRandomValues(new Uint8Array(16));

  // PRK = HKDF(auth, shared, "WebPush: info" || clientPub || serverPub)
  const info = concat(enc('WebPush: info\0'), clientPub, serverPubRaw);
  const ikm = await hkdf(auth, shared, info, 32);

  const cek = await hkdf(salt, ikm, enc('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc('Content-Encoding: nonce\0'), 12);

  const aesKey = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['encrypt']);
  // 본문 끝에 패딩 구분자 0x02 를 붙인다 (마지막 레코드라는 뜻)
  const padded = concat(enc(plaintext), new Uint8Array([0x02]));
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, padded));

  // 헤더: salt(16) + recordSize(4) + keyIdLen(1) + serverPub(65)
  const header = new Uint8Array(16 + 4 + 1 + 65);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = 65;
  header.set(serverPubRaw, 21);

  return concat(header, cipher);
}

async function hkdf(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey('raw', ikm, { name: 'HKDF' }, false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8);
  return new Uint8Array(bits);
}

// ── 자잘한 도구들 ──
function enc(str) { return new TextEncoder().encode(str); }

function concat(...arrays) {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const a of arrays) { out.set(a, at); at += a.length; }
  return out;
}

function b64url(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(str) {
  const base64 = String(str || '').replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

// ALLOWED_ORIGIN 에 앱 주소를 넣으면 그 주소에서만 브라우저가 응답을 읽을 수 있다.
// 안 넣어도 큰 구멍은 아니다 — 모든 요청이 로그인 토큰을 요구하고,
// 그 토큰은 다른 사이트에서 가져갈 수 없기 때문이다. 넣으면 한 겹 더 막힌다.
function cors(env) {
  const allow = String((env && env.ALLOWED_ORIGIN) || '').trim();
  return {
    'Access-Control-Allow-Origin': allow || '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-App-Key, X-Relay-Token',
    'Vary': 'Origin',
  };
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...cors(ENV) },
  });
}