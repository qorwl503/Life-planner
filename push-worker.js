// 🔔 MyPlanner 알림 서버 (Cloudflare Worker)
//
// 하는 일
//   POST /push/subscribe  앱이 보낸 구독 정보를 저장
//   POST /push/test       테스트 알림 보내기
//   POST /push/send       원하는 내용으로 알림 보내기 (요약 알림 등)
//   GET  /push/status     구독이 등록돼 있는지 확인
//   POST /relay/ping      단축어가 쓰는 길로 알림만 보내본다 (진단용)
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
      if (url.pathname === '/relay/workout' && request.method === 'POST') return await handleRelayWorkout(request, env);
      if (url.pathname === '/relay/ping' && request.method === 'POST') return await handleRelayPing(request, env);
      if (url.pathname.startsWith('/ai/') && request.method === 'POST') return await handleAI(request, env, url);
      if (url.pathname === '/push/status') return await handleStatus(request, env);
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
//      → POST https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=API_KEY
//        본문 {"idToken":"..."} → users[0].localId 가 uid, emailVerified 도 같이 온다.
//   2. 가입 제한 — 지금은 이메일 인증 없이 누구나 가입할 수 있다.
//      계정을 여러 개 만들면 상한이 무의미하므로 emailVerified 를 요구해야 한다.
//   3. CORS — ALLOWED_ORIGIN 을 넣어 앱 주소로 좁히는 게 좋다.
//   4. 상한 — KV 는 읽고 쓰는 사이가 원자적이지 않고 전파도 늦다.
//      동시에 여러 번 부르면 상한을 조금 넘길 수 있다. 정확한 과금이 필요하면 KV 로는 부족하다.
//
// 아래는 그 전제로 남겨둔 배선이다. 상한 계산과 모델명 검사는 그대로 쓸 수 있다.
// 주인(MY_UID)은 자기 할당량이므로 상한을 걸지 않는다.

const AI_DAILY_LIMIT = 30;          // 손님 1인당 하루 호출 수
const AI_ALLOWED_MODELS = /^[a-zA-Z0-9.\-]+$/;   // 모델명에 경로가 섞여 들어오는 걸 막는다

// 앱 열쇠(uploadKeys/{key}) 로 누구인지 알아낸다. 없는 열쇠면 null.
async function uidFromAppKey(env, key) {
  if (!key || !/^[0-9a-f]{16,128}$/.test(key)) return null;
  if (!env.FIREBASE_PROJECT_ID || !env.FIREBASE_API_KEY) {
    throw new Error('FIREBASE_PROJECT_ID / FIREBASE_API_KEY 를 Secrets 에 넣어주세요');
  }
  const url = 'https://firestore.googleapis.com/v1/projects/' + env.FIREBASE_PROJECT_ID
    + '/databases/(default)/documents/uploadKeys/' + encodeURIComponent(key)
    + '?key=' + env.FIREBASE_API_KEY;
  const res = await fetch(url);
  if (!res.ok) return null;
  const doc = await res.json();
  return doc?.fields?.uid?.stringValue || null;
}

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
  if (!AI_ALLOWED_MODELS.test(model)) return json({ error: '모델 이름이 이상합니다' }, 400);

  const appKey = request.headers.get('X-App-Key') || '';
  const uid = await uidFromAppKey(env, appKey);
  if (!uid) return json({ error: '앱 열쇠가 확인되지 않았어요. 로그인 후 다시 시도해주세요' }, 401);

  // 주인은 무제한, 손님은 하루 상한
  const isOwner = !!env.MY_UID && uid === env.MY_UID;
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
// Worker 에는 관리자 SDK 가 없으므로 구글에게 토큰이 진짜인지 물어본다.
//   POST identitytoolkit.../accounts:lookup  { idToken }  → users[0].localId 가 uid
// 토큰은 한 시간짜리라 잠깐 캐시해 두고 매번 묻지는 않는다.

async function verifyIdToken(env, idToken) {
  if (!idToken) throw new Error('로그인이 필요합니다');
  if (!env.FIREBASE_API_KEY) throw new Error('Worker 에 FIREBASE_API_KEY 가 없습니다');

  // 토큰 원문을 키로 쓰지 않으려고 해시를 쓴다 (KV 목록에 토큰이 남지 않게)
  const digest = await crypto.subtle.digest('SHA-256', enc(idToken));
  const cacheKey = 'tok:' + b64url(new Uint8Array(digest));

  if (env.PUSH_KV) {
    const hit = await env.PUSH_KV.get(cacheKey);
    if (hit) return JSON.parse(hit);
  }

  const res = await fetch(
    'https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' + env.FIREBASE_API_KEY,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken }) }
  );
  if (!res.ok) {
    // 구글이 왜 거절했는지 그대로 보여준다. 안 그러면 원인을 짐작만 하게 된다.
    // (여기 담기는 건 'API key not valid' 같은 사유일 뿐, 키 값이 아니다)
    let why = '';
    try {
      const d = await res.json();
      why = (d && d.error && (d.error.message || d.error.status)) || '';
    } catch (e) {
      why = 'HTTP ' + res.status;
    }
    if (/API_KEY|API key|referer|blocked|PERMISSION_DENIED|SERVICE_DISABLED/i.test(why)) {
      throw new Error('알림 서버의 FIREBASE_API_KEY 가 거절당했어요 (' + why + '). '
        + '키가 맞는지, 그리고 그 키에 웹사이트 제한이 걸려 있지 않은지 확인해주세요');
    }
    throw new Error('로그인 확인 실패: ' + (why || 'HTTP ' + res.status));
  }

  const data = await res.json();
  const u = data && data.users && data.users[0];
  if (!u || !u.localId) throw new Error('로그인 정보가 확인되지 않았어요');

  const who = { uid: u.localId, email: u.email || '', emailVerified: !!u.emailVerified };
  // 5분만 캐시한다 — 계정을 지웠는데 한참 동안 통과되면 곤란하다
  if (env.PUSH_KV) await env.PUSH_KV.put(cacheKey, JSON.stringify(who), { expirationTtl: 300 });
  return who;
}

// 누구인지 알아낸다. 두 가지를 받아준다.
//   1) Authorization: Bearer <로그인 토큰>  ← 앱이 쓰는 방식
//   2) 본문의 key 가 INBOX_TOKEN 과 같을 때 ← 예전 방식. 주인 본인으로만 인정한다.
//
// 2번을 남겨둔 이유: 토큰 검증이 안 되는 상황(키 제한 등)에서도 주인은 알림을 계속 쓸 수 있어야 한다.
// 이건 MY_UID 한 사람으로만 매핑되므로, 여러 사람이 서로의 알림을 보던 옛 문제는 생기지 않는다.
// 본문의 key 가 INBOX_TOKEN 과 같으면 주인으로 본다. 아니면 null.
function legacyOwner(env, body) {
  const key = body && body.key;
  if (!key || !env.INBOX_TOKEN || key !== env.INBOX_TOKEN) return null;
  if (!env.MY_UID) throw new Error('Worker 에 MY_UID 가 없습니다. Secrets 에 추가해주세요');
  return { uid: env.MY_UID, email: '', emailVerified: true, legacy: true };
}

async function requireUser(request, env, body) {
  const owner = legacyOwner(env, body);
  const auth = request.headers.get('Authorization') || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);

  if (m) {
    try {
      return await verifyIdToken(env, m[1].trim());
    } catch (e) {
      // 토큰 확인이 막히는 상황(API 키 제한 등)이라도 주인은 계속 쓸 수 있어야 한다.
      // 주인 열쇠가 함께 왔으면 그걸로 통과시킨다.
      if (owner) return owner;
      throw e;
    }
  }

  if (owner) return owner;
  throw new Error('로그인이 필요합니다');
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

async function handleStatus(request, env) {
  const who = await requireUser(request, env, null);
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
async function handleRelayWorkout(request, env) {
  const raw = await request.text();

  let parsed;
  try { parsed = JSON.parse(raw); } catch (e) { return json({ error: '본문이 JSON 이 아닙니다' }, 400); }

  // 여기서 INBOX_TOKEN 과 대조하지 않는다.
  //   그 값은 Worker 에 따로 적어둔 것이라, 앱에서 열쇠를 새로 만들면 어긋난다.
  //   어긋나면 전부 거부돼서 '아무것도 안 들어오는' 상태가 된다.
  // 대신 Firestore 규칙이 본문의 key 를 uploadKeys 로 검사한다.
  //   틀린 열쇠면 아래 저장이 거부되므로, 인증은 그쪽 한 곳에서만 하면 된다.
  if (!env.FIREBASE_PROJECT_ID || !env.FIREBASE_API_KEY || !env.MY_UID) {
    throw new Error('FIREBASE_PROJECT_ID / FIREBASE_API_KEY / MY_UID 를 Secrets 에 넣어주세요');
  }

  const endpoint = 'https://firestore.googleapis.com/v1/projects/' + env.FIREBASE_PROJECT_ID
    + '/databases/(default)/documents/users/' + encodeURIComponent(env.MY_UID) + '/workoutInbox'
    + '?key=' + env.FIREBASE_API_KEY;

  // 서버를 거쳐 왔다는 표시를 남긴다.
  // 앱이 이걸 보고 '단축어가 아직 옛 주소로 보내는지'를 알 수 있다.
  let outBody = raw;
  try {
    const withVia = JSON.parse(raw);
    withVia.fields = withVia.fields || {};
    withVia.fields.via = { stringValue: 'relay' };
    outBody = JSON.stringify(withVia);
  } catch (e) { /* 못 고치면 원본 그대로 보낸다 */ }

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: outBody,
  });

  if (!res.ok) {
    const detail = await res.text();
    const why = res.status === 403 || /PERMISSION_DENIED/i.test(detail)
      ? '열쇠가 맞지 않아 저장이 거부됐어요. 앱에서 워치 연동 설정을 다시 열어 본문을 새로 복사해주세요'
      : 'Firestore 저장 실패';
    return json({ error: why, status: res.status, detail: detail.slice(0, 300) }, 502);
  }

  // 사진은 앱이 읽어야 종목·시간을 안다. 하지만 단축어가 값으로 보낸 경우엔
  // 여기서 바로 알려줄 수 있다 — '캡처가 들어왔어요' 로는 뭐가 왔는지 모른다.
  const f = parsed?.fields || {};
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
    body = shots > 1 ? '캡처 2장이 들어왔어요. 앱을 열면 정리됩니다.' : '캡처가 들어왔어요. 앱을 열면 정리됩니다.';
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
    tag: 'workout-arrived-' + Date.now(),   // 매번 다른 태그 — 이전 알림을 덮지 않게
  };
  const pushed = await sendToOwner(env, payload);

  // 알림이 갔는지까지 알려준다. ok 만 돌려주면 '저장은 됐는데 알림이 안 온다'를 못 가린다.
  return json({ ok: true, shots, push: pushed });
}


// 앱이 '언제 무슨 내용으로 보낼지'를 넣어둔다
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

  const plan = {
    at: body.at,                                  // 한국 시간 기준
    title: body.title || '📋 오늘 정리',
    body: body.body || '',
    tag: body.tag || 'daily-summary',
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
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
}

async function runPlanFor(env, uid) {
  const raw = await env.PUSH_KV.get(planKey(uid));
  if (!raw) return;

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

  // 앱이 며칠째 안 켜졌으면 내용이 낡았다 — 그대로 보내면 틀린 숫자를 보게 된다
  const stale = Date.now() - (Number(plan.savedAt) || 0) > 36 * 60 * 60 * 1000;
  const body = stale ? '앱을 열어 오늘 기록을 확인해보세요.' : (plan.body || '');

  await sendToUser(env, uid, { title: plan.title, body, tag: plan.tag });

  plan.sentOn = now.date;
  await env.PUSH_KV.put(planKey(uid), JSON.stringify(plan));
}

async function loadSubs(env, uid) {
  if (!env.PUSH_KV) throw new Error('PUSH_KV 바인딩이 없습니다 (KV 연결 필요)');
  if (!uid) throw new Error('누구의 기기인지 알 수 없습니다');
  const raw = await env.PUSH_KV.get(subsKey(uid));
  if (!raw) return [];
  try { return JSON.parse(raw) || []; } catch (e) { return []; }
}

// ── 실제 발송 ──
// 반드시 uid 를 받는다. 예전처럼 '모두에게' 보내면 남의 요약이 내 폰에 뜬다.
// 단축어가 쓰는 길 그대로 알림만 보내본다 (Firestore 는 안 건드린다).
// '저장은 되는데 알림이 안 온다'를 앱에서 한 번에 가려내기 위한 것.
async function handleRelayPing(request, env) {
  const pushed = await sendToOwner(env, {
    title: '⌚ 서버 알림 시험',
    body: '이 알림이 보이면 앱이 꺼져 있어도 알림이 옵니다.',
    tag: 'relay-ping-' + Date.now(),
  });
  return json({ ok: true, push: pushed, myUid: env.MY_UID ? '설정됨' : '없음' });
}

// 주인에게 보낸다. MY_UID 로 저장된 구독이 없으면 — 흔한 경우가 Secret 의 UID 가
// 실제 로그인 UID 와 다른 것 — 등록된 사람이 딱 한 명일 때 그 사람에게 보낸다.
// 여러 명이면 누구인지 알 수 없으므로 보내지 않는다 (남의 폰에 뜨면 안 된다).
async function sendToOwner(env, payload) {
  if (env.MY_UID) {
    const r = await sendToUser(env, env.MY_UID, payload);
    if (r.sent > 0) return { ...r, target: 'MY_UID' };
  }

  if (!env.PUSH_KV) return { sent: 0, note: 'PUSH_KV 없음' };
  const page = await env.PUSH_KV.list({ prefix: 'subs:' });
  const uids = page.keys.map(k => k.name.slice('subs:'.length));

  if (uids.length === 0) {
    return { sent: 0, note: '알림을 켠 기기가 하나도 없어요. 앱에서 알림을 먼저 켜주세요' };
  }
  if (uids.length > 1) {
    return { sent: 0, note: 'MY_UID 가 등록된 사람과 안 맞습니다. Secrets 의 MY_UID 를 확인해주세요' };
  }

  const r = await sendToUser(env, uids[0], payload);
  return { ...r, target: 'only-user', note: 'MY_UID 가 안 맞아 등록된 한 명에게 보냈습니다' };
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
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-App-Key',
    'Vary': 'Origin',
  };
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...cors(ENV) },
  });
}
