// Plan Be 실시간 코스 생성 API (Vercel 서버 함수)
// - 카카오 로컬: 실제 장소 후보
// - 서울 열린데이터광장 문화행사: 진행 중인 전시·행사
// - 카카오 웹검색: 팝업스토어 소식(블로그·웹 문서)
// - 언어모델: 후보 중에서 조건에 맞는 코스·플랜 B·추천 이유 작성
//     ANTHROPIC_API_KEY가 있으면 Claude(유료), 없으면 GEMINI_API_KEY로 Gemini(무료 한도),
//     둘 다 없거나 실패하면 규칙 기반으로 코스를 구성 (실시간 장소·전시 데이터는 그대로 사용)
// - 카카오 이미지 검색: 장소 대표 이미지
// API 키는 Vercel 환경변수에만 넣고, 브라우저에는 절대 넣지 않습니다.

const KAKAO = process.env.KAKAO_REST_API_KEY;
const SEOUL = process.env.SEOUL_API_KEY;
const CLAUDE = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-5-5";
const GEMINI = process.env.GEMINI_API_KEY;
const KAKAO_JS = process.env.KAKAO_JS_KEY;   // 지도 표시용 JavaScript 키 (도메인 제한이 걸린 공개용 키)
const GEMINI_MODELS = process.env.GEMINI_MODEL ? [process.env.GEMINI_MODEL] : ["gemini-flash-latest", "gemini-2.5-flash"];

const REGIONS = {
  yeonnam: { area: "홍대·연남", query: "연남동", gu: ["마포구"], center: [37.5622, 126.9256] },
  seongsu: { area: "성수", query: "성수동", gu: ["성동구"], center: [37.5446, 127.0557] },
  euljiro: { area: "을지로", query: "을지로", gu: ["중구", "종로구"], center: [37.5662, 126.9910] },
};

// 취향 태그 → 카카오 검색어
const TAG_QUERY = {
  수제버거: "수제버거", 파스타: "파스타", 브런치: "브런치", 한식: "한식 맛집", 디저트: "디저트 카페",
  인스타감성: "감성 카페", 조용한: "북카페", 산책: "산책 공원", 노포: "노포 맛집", 전시: "갤러리",
};

function withTimeout(ms) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  return { signal: c.signal, done: () => clearTimeout(t) };
}

async function getJSON(url, headers = {}, ms = 8000) {
  const t = withTimeout(ms);
  try {
    const r = await fetch(url, { headers, signal: t.signal });
    if (!r.ok) throw new Error(`${r.status} ${url.split("?")[0]}`);
    return await r.json();
  } finally { t.done(); }
}

const kakaoHeaders = () => ({ Authorization: `KakaoAK ${KAKAO}` });

async function kakaoPlaces(q, center, tag) {
  const u = new URL("https://dapi.kakao.com/v2/local/search/keyword.json");
  u.searchParams.set("query", q);
  u.searchParams.set("y", center[0]); u.searchParams.set("x", center[1]);
  u.searchParams.set("radius", "1500"); u.searchParams.set("size", "8");
  const j = await getJSON(u, kakaoHeaders());
  return (j.documents || []).map(d => ({
    name: d.place_name, category: d.category_name, address: d.road_address_name || d.address_name,
    lat: +d.y, lng: +d.x, url: d.place_url, source: "kakao", query: q, tags: tag ? [tag] : [],
  }));
}

async function kakaoImage(q) {
  try {
    const u = new URL("https://dapi.kakao.com/v2/search/image");
    u.searchParams.set("query", q); u.searchParams.set("size", "3");
    const j = await getJSON(u, kakaoHeaders(), 5000);
    const d = (j.documents || [])[0];
    return d ? { img: d.image_url, thumb: d.thumbnail_url } : {};
  } catch { return {}; }
}

async function kakaoWeb(q) {
  try {
    const u = new URL("https://dapi.kakao.com/v2/search/web");
    u.searchParams.set("query", q); u.searchParams.set("size", "10"); u.searchParams.set("sort", "recency");
    const j = await getJSON(u, kakaoHeaders(), 6000);
    return (j.documents || []).map(d => ({
      title: d.title.replace(/<[^>]+>/g, ""), snippet: d.contents.replace(/<[^>]+>/g, "").slice(0, 220),
      date: (d.datetime || "").slice(0, 10), url: d.url,
    }));
  } catch { return []; }
}

// 서울 문화행사: LOT/LAT 이름이 헷갈리게 되어 있어 값 범위로 위도·경도를 판단
function toLatLng(a, b) {
  const x = parseFloat(a), y = parseFloat(b);
  if (!isFinite(x) || !isFinite(y)) return [null, null];
  return x < 90 ? [x, y] : [y, x];
}

async function seoulEvents(region) {
  if (!SEOUL) return { near: [], fests: [] };
  const j = await getJSON(`http://openapi.seoul.go.kr:8088/${SEOUL}/json/culturalEventInfo/1/1000/`, {}, 9000);
  const rows = (j.culturalEventInfo && j.culturalEventInfo.row) || [];
  const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10); // KST
  const all = rows
    .filter(r => (r.STRTDATE || "").slice(0, 10) <= today && (r.END_DATE || "9999").slice(0, 10) >= today)
    // 데이트와 맞지 않는 교육·아동·단체 프로그램은 제외
    .filter(r => !/교육|강좌|강의|초등|어린이|유아|학급|단체|아카데미|모집|청소년/.test(`${r.TITLE} ${r.CODENAME}`))
    .map(r => {
      const [lat, lng] = toLatLng(r.LAT, r.LOT);
      const fest = /축제/.test(r.CODENAME || "");
      return {
        name: r.TITLE, category: r.CODENAME, place: r.PLACE, date: r.DATE, fee: r.USE_FEE, gu: r.GUNAME,
        kind: fest ? "festival" : /전시|미술/.test(r.CODENAME || "") ? "exhibition" : "event",
        free: r.IS_FREE === "무료", img: r.MAIN_IMG, url: r.ORG_LINK || r.HMPG_ADDR, lat, lng, source: "seoul", tags: fest ? ["산책"] : ["전시"],
      };
    });
  const near = all.filter(e => region.gu.includes(e.gu));
  // 축제는 동네 밖이라도 서울 전체에서 오늘 열리는 것을 함께 보여줌
  const fests = all.filter(e => e.kind === "festival" && !region.gu.includes(e.gu)).slice(0, 6);
  // 동네 행사는 축제 → 전시 → 기타 순으로
  const rank = { festival: 0, exhibition: 1, event: 2 };
  near.sort((a, b) => rank[a.kind] - rank[b.kind]);
  return { near: near.slice(0, 12), fests };
}

// 모델 이름이 계정에서 안 되면(404) 다음 후보로 자동 재시도
const CLAUDE_MODELS = [...new Set([MODEL, "claude-sonnet-5-5", "claude-haiku-5-5", "claude-sonnet-4-5", "claude-haiku-4-5"])];
async function askClaude(prompt, maxTokens = 4000) {
  let lastErr;
  for (const m of CLAUDE_MODELS) {
    const t = withTimeout(38000);
    try {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST", signal: t.signal,
        headers: { "x-api-key": CLAUDE, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({ model: m, max_tokens: maxTokens, messages: [{ role: "user", content: prompt }] }),
      });
      if (!r.ok) {
        const body = (await r.text()).slice(0, 220);
        lastErr = new Error(`Claude ${r.status} (${m}): ${body}`);
        if (r.status === 404 || /model/i.test(body) && r.status === 400) continue;
        throw lastErr;
      }
      const j = await r.json();
      const text = (j.content || []).map(c => c.text || "").join("");
      return { data: parseJSON(text), model: m };
    } catch (e) {
      if (e.name === "AbortError") throw new Error(`Claude 응답 시간 초과 (${m})`);
      throw e;
    } finally { t.done(); }
  }
  throw lastErr || new Error("사용 가능한 Claude 모델을 찾지 못했어요");
}

function parseJSON(text) {
  const s = text.indexOf("{"), e = text.lastIndexOf("}");
  if (s < 0 || e < 0) throw new Error("AI 응답에서 JSON을 찾지 못했어요");
  try { return JSON.parse(text.slice(s, e + 1)); }
  catch (err) { throw new Error("AI 응답 JSON 형식 오류: " + String(err.message).slice(0, 80)); }
}

async function askGemini(prompt) {
  let lastErr;
  for (const m of GEMINI_MODELS) {
    const t = withTimeout(40000);
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`, {
        method: "POST", signal: t.signal,
        headers: { "x-goog-api-key": GEMINI, "content-type": "application/json" },
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: "application/json", temperature: 0.6 } }),
      });
      if (!r.ok) { lastErr = new Error(`Gemini ${r.status}: ${(await r.text()).slice(0, 160)}`); if (r.status === 404) continue; throw lastErr; }
      const j = await r.json();
      const text = ((j.candidates || [])[0]?.content?.parts || []).map(p => p.text || "").join("");
      return { data: parseJSON(text), engine: "gemini", model: m };
    } finally { t.done(); }
  }
  throw lastErr || new Error("Gemini 모델을 찾지 못했어요");
}

async function askLLM(prompt) {
  if (CLAUDE) { const o = await askClaude(prompt); return { data: o.data, engine: "claude", model: o.model }; }
  if (GEMINI) return await askGemini(prompt);
  throw new Error("AI 키 없음");
}

/* ---------- 규칙 기반 코스 구성 (AI 키가 없거나 AI가 실패했을 때) ---------- */
const d2 = (a, b) => (a.lat - b.lat) ** 2 + (a.lng - b.lng) ** 2;
function roleOf(c) {
  const k = c.category || "";
  if (c.source === "seoul") return "event";
  if (/카페|디저트|제과|베이커리/.test(k)) return "cafe";
  if (/음식점/.test(k)) return "meal";
  return "activity";
}
function emojiOf(c) {
  const k = (c.category || "") + " " + c.name;
  const map = [[/햄버거|버거/, "🍔"], [/파스타|이탈리/, "🍝"], [/브런치/, "🥞"], [/한식|국수|칼국수|국밥/, "🍚"], [/일식|초밥|라멘/, "🍣"],
    [/디저트|케이크/, "🍰"], [/베이커리|제과/, "🥐"], [/카페/, "☕"], [/전시|미술|갤러리/, "🖼"], [/공연|연극|뮤지컬|콘서트/, "🎭"],
    [/공원|산책|숲/, "🌳"], [/소품|쇼핑|문구|잡화/, "🛍"], [/영화/, "🎬"], [/서점|책/, "📚"], [/음식점/, "🍽"]];
  return (map.find(([re]) => re.test(k)) || [, "📍"])[1];
}
function estimate(c) {
  const k = c.category || "", role = roleOf(c);
  if (role === "event") {
    if (c.free) return { price: 0, dur: 80 };
    const n = parseInt(String(c.fee || "").replace(/,/g, "").match(/\d{3,6}/)?.[0] || "0", 10);
    return { price: n ? Math.min(n * 2, 80000) : 20000, dur: 80 };
  }
  if (role === "meal") return { price: /햄버거|양식|이탈리/.test(k) ? 28000 : /한식|분식|국수/.test(k) ? 22000 : 26000, dur: 70 };
  if (role === "cafe") return { price: 15000, dur: 80 };
  if (/공원|관광|명소|산책/.test(k)) return { price: 0, dur: 60 };
  return { price: 15000, dur: 90 };
}
function toStop(c, input) {
  const { price, dur } = estimate(c);
  const last = (c.category || "").split(" > ").pop();
  const role = roleOf(c);
  const label = { meal: "식사", cafe: "카페", event: "전시·행사", activity: "놀거리" }[role];
  return {
    name: c.name, cat: `${label} · ${last || label}`, emoji: emojiOf(c), dur, price,
    tags: [...new Set(c.tags || [])].filter(t => input.tags.includes(t)),
    desc: role === "event" ? `${c.place || ""}에서 ${c.date || "진행 중"}까지 열리는 행사예요.` : `${c.address}에 있어요.`,
    lat: c.lat, lng: c.lng, url: c.url, img: c.source === "seoul" ? c.img : undefined, address: c.address || c.place, role,
  };
}
function rulePlan(input, region, cands, events, web) {
  const used = new Set();
  const score = c => (c.tags || []).filter(t => input.tags.includes(t)).length;
  const best = (role, near) => cands.filter(c => roleOf(c) === role && !used.has(c.name) && c.lat)
    .sort((a, b) => (score(b) - score(a)) || (near ? d2(a, near) - d2(b, near) : 0))[0];
  const order = input.tags.includes("전시") && events.some(e => e.lat) ? ["meal", "event", "cafe"] : ["meal", "cafe", "activity"];
  const picks = [];
  for (const role of order) {
    const c = best(role, picks[picks.length - 1]) || best("activity", picks[picks.length - 1]) || best("cafe", picks[picks.length - 1]);
    if (c) { used.add(c.name); picks.push(c); }
  }
  const stops = picks.map(c => toStop(c, input));
  stops.forEach((s, i) => {
    const r = roleOf(picks[i]), sibling = { event: "activity", activity: "event", meal: "meal", cafe: "cafe" }[r];
    const alt = best(r, picks[i]) || best(sibling, picks[i]) || cands.filter(c => !used.has(c.name) && c.lat).sort((a, b) => d2(a, picks[i]) - d2(b, picks[i]))[0];
    if (alt) { used.add(alt.name); s.alt = toStop(alt, input); }
  });
  const hit = [...new Set(stops.flatMap(s => s.tags))];
  const ev = stops.find(s => s.role === "event");
  return {
    title: `${stops[0]?.name || region.area}에서 시작해\n${stops[stops.length - 1]?.name || ""}까지`,
    why: [
      hit.length ? `고른 취향 ${hit.map(t => "#" + t).join(" ")}에 맞는 곳을 먼저 골랐어요.` : `${region.area}에서 검색 결과가 좋은 곳으로 골랐어요.`,
      "앞 장소에서 가장 가까운 곳을 이어서 이동 거리를 줄였어요.",
      ev ? `오늘 진행 중인 '${ev.name}'을 코스에 넣었어요.` : "식사 → 카페 → 놀거리 순서로 하루 흐름을 맞췄어요.",
    ],
    stops,
    popups: web.filter(w => /팝업/.test(w.title)).slice(0, 3).map(w => ({ name: w.title, period: w.date ? `${w.date} 작성 글` : "", note: "웹 문서 원문 · 방문 전 확인", url: w.url })),
  };
}

function buildPrompt(input, region, cands, events, web) {
  const list = cands.map(c => `${c.id} | ${c.name} | ${c.category} | ${c.address || c.place || ""}${c.date ? " | 기간 " + c.date : ""}${c.fee ? " | 요금 " + c.fee : ""}`).join("\n");
  const news = web.map((w, i) => `W${i + 1} [${w.date}] ${w.title} — ${w.snippet}`).join("\n");
  return `너는 데이트 코스 플래너 'Plan Be'야. 아래 실제 장소 후보만 사용해서 커플 데이트 코스를 짜.

[조건]
- 지역: ${region.area}
- 시작 시간: ${input.start}
- 두 사람 총예산: ${input.budget}원
- 취향 태그: ${input.tags.join(", ") || "없음"}
- 이동 수단: ${{ walk: "도보", transit: "대중교통", car: "자가용" }[input.mode]}
- 이 사용자의 학습된 선호(0~1, 0.5가 보통): ${Object.keys(input.prefs).length ? Object.entries(input.prefs).map(([k, v]) => `${k} ${v.toFixed(2)}`).join(", ") : "아직 없음"}

[장소 후보] (id | 이름 | 분류 | 주소 | 기간 | 요금)
${list}

[최근 웹 문서] 팝업스토어 소식
${news || "없음"}

[규칙]
1. 후보 id 중에서 3곳을 골라 시간 순서대로 배치해. 첫 장소는 식사, 나머지는 카페·전시·산책 등으로 다양하게. 학습된 선호가 높은 종류를 우선해.
2. 각 장소마다 '플랜 B' 대체 장소를 후보 중에서 1곳 골라(같은 역할, 가급적 실내, 가까운 곳). 코스 장소와 겹치지 않게.
3. price는 두 사람 기준 예상 비용(원, 정수). 무료 행사는 0. 총합이 예산을 넘지 않게.
4. dur는 머무는 시간(분, 45~120).
5. desc는 해요체 한 문장, 실제 정보만 쓰고 지어내지 마.
6. tags는 조건의 취향 태그 중 이 장소에 실제로 맞는 것만.
7. 오늘 열리는 축제가 후보에 있으면 코스에 넣는 것을 우선 고려해.
8. popups는 웹 문서에서 ${region.area} 근처 팝업스토어를 최대 3개 뽑아. 확실하지 않으면 빈 배열.
9. JSON만 출력해. 설명 문장 금지.

[출력 형식]
{"title":"줄바꿈(\\n) 포함 2줄 제목","why":["추천 이유 문장","...","..."],
 "stops":[{"id":"P1","emoji":"🍔","cat":"점심 · 수제버거","dur":70,"price":28000,"tags":["수제버거"],"desc":"...",
   "alt":{"id":"P5","emoji":"🍝","cat":"점심 · 파스타","dur":70,"price":26000,"tags":[],"desc":"..."}}],
 "popups":[{"name":"...","period":"11.8 ~ 11.24","note":"W2 근거 한 줄"}]}`;
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");

  // AI 연결 테스트: /api/plan?test=ai
  if (req.method === "GET" && req.query && req.query.test === "ai") {
    try {
      if (!CLAUDE && !GEMINI) throw new Error("AI 키가 없어요");
      const o = CLAUDE ? await askClaude('{"ok":true} 이 JSON만 그대로 출력해.', 50) : await askGemini('{"ok":true} 이 JSON만 그대로 출력해.');
      return res.status(200).json({ ai: "성공", model: o.model, reply: o.data });
    } catch (e) { return res.status(200).json({ ai: "실패", error: String(e.message || e) }); }
  }
  // 상태 확인: /api/plan
  if (req.method === "GET") {
    return res.status(200).json({ ok: true, keys: { kakao: !!KAKAO, kakaoMap: !!KAKAO_JS, seoul: !!SEOUL, claude: !!CLAUDE, gemini: !!GEMINI },
      kakaoJsKey: KAKAO_JS || null,
      ai: CLAUDE ? `claude (${MODEL})` : GEMINI ? "gemini (무료)" : "없음 → 규칙 기반" });
  }
  if (req.method !== "POST") return res.status(405).json({ error: "POST만 가능해요" });
  if (!KAKAO) return res.status(503).json({ error: "카카오 API 키(KAKAO_REST_API_KEY)가 설정되지 않았어요" });

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const region = REGIONS[body.region] || REGIONS.yeonnam;
    const input = {
      start: /^\d{2}:\d{2}$/.test(body.start) ? body.start : "13:00",
      budget: Math.min(500000, Math.max(10000, +body.budget || 70000)),
      tags: (Array.isArray(body.tags) ? body.tags : []).filter(t => TAG_QUERY[t]).slice(0, 8),
      mode: ["walk", "transit", "car"].includes(body.mode) ? body.mode : "walk",
      // 앱에서 학습한 개인 선호(밴딧 보정값): {식사:0.6, 카페:0.8, ...} 0~1
      prefs: Object.fromEntries(Object.entries(body.prefs && typeof body.prefs === "object" ? body.prefs : {})
        .filter(([k, v]) => /^[가-힣·]{1,6}$/.test(k) && isFinite(v)).slice(0, 6).map(([k, v]) => [k, Math.max(0, Math.min(1, +v))])),
    };

    // 1) 후보 수집 (병렬)
    const queries = [...new Set([...input.tags.map(t => TAG_QUERY[t]), "맛집", "카페", "소품샵", "가볼만한곳"])].slice(0, 8);
    const month = new Date(Date.now() + 9 * 3600e3).getUTCMonth() + 1;
    const [placeLists, ev, web] = await Promise.all([
      Promise.all(queries.map(q => kakaoPlaces(`${region.query} ${q}`, region.center, Object.keys(TAG_QUERY).find(t => TAG_QUERY[t] === q && input.tags.includes(t))).catch(() => []))),
      seoulEvents(region).catch(() => ({ near: [], fests: [] })),
      kakaoWeb(`${region.query} 팝업스토어 ${month}월`),
    ]);
    const events = ev.near, festivals = ev.fests;
    const seen = new Set();
    const cands = [];
    for (const p of [...placeLists.flat(), ...events.filter(e => e.lat)]) {
      const dup = cands.find(c => c.name === p.name);
      if (dup) { dup.tags = [...new Set([...dup.tags, ...p.tags])]; continue; }
      if (seen.has(p.name)) continue;
      seen.add(p.name); cands.push({ ...p, tags: [...p.tags], id: "P" + (cands.length + 1) });
    }
    if (cands.length < 4) throw new Error("장소 후보를 충분히 찾지 못했어요");

    // 2) 언어모델로 코스 구성 → 실패하면 규칙 기반
    let plan, stops, engine = "rule", engineNote = "";
    try {
      const out = await askLLM(buildPrompt(input, region, cands.slice(0, 45), events, web));
      plan = out.data; engine = out.engine; engineNote = out.model;
      const byId = Object.fromEntries(cands.map(c => [c.id, c]));
      const pick = (s) => {
        const c = byId[s && s.id]; if (!c) return null;
        return {
          name: c.name, cat: s.cat || c.category.split(" > ").pop(), emoji: s.emoji || emojiOf(c),
          dur: Math.min(150, Math.max(30, +s.dur || 70)), price: Math.max(0, Math.round(+s.price || 0)),
          tags: (s.tags || []).filter(t => input.tags.includes(t)), desc: s.desc || "",
          lat: c.lat, lng: c.lng, url: c.url, img: c.source === "seoul" ? c.img : undefined, address: c.address || c.place,
        };
      };
      stops = (plan.stops || []).map(s => {
        const main = pick(s); if (!main) return null;
        const alt = pick(s.alt);
        return { ...main, alt: alt && alt.name !== main.name ? alt : null };
      }).filter(Boolean).slice(0, 4);
      if (stops.length < 2) throw new Error("AI가 코스를 구성하지 못했어요");
      // AI가 플랜 B를 못 고른 곳은, 코스에 없는 후보 중 가장 가까운 곳으로 채움
      const used = new Set(stops.flatMap(s => [s.name, s.alt && s.alt.name]));
      stops.forEach(s => {
        if (s.alt) return;
        const near = cands.filter(c => !used.has(c.name) && c.lat).sort((a, b) => d2(a, s) - d2(b, s))[0];
        if (!near) return;
        used.add(near.name); s.alt = toStop(near, input);
      });
    } catch (e) {
      if (CLAUDE || GEMINI) engineNote = String(e.message || e).slice(0, 120);
      plan = rulePlan(input, region, cands, events, web);
      stops = plan.stops; engine = "rule";
    }
    if (stops.length < 2) throw new Error("코스를 구성하지 못했어요");
    stops.forEach(s => { if (!s.alt) s.alt = { ...s, alt: undefined }; });

    // 3) 대표 이미지 (없는 것만 카카오 이미지 검색)
    const targets = stops.flatMap(s => [s, s.alt]).filter(s => s && !s.img);
    const imgs = await Promise.all(targets.map(s => kakaoImage(`${s.name} ${region.query}`)));
    targets.forEach((s, i) => { s.img = imgs[i].img; s.thumb = imgs[i].thumb; });

    return res.status(200).json({
      live: true, fetchedAt: new Date().toISOString(), engine, engineNote,
      course: { area: region.area, title: String(plan.title || `${region.area} 데이트`).replace(/\\n/g, "\n"), why: (plan.why || []).slice(0, 3), stops },
      events: events.slice(0, 8), festivals, popups: (plan.popups || []).slice(0, 3),
      sources: { places: placeLists.flat().length, events: events.length, web: web.length },
    });
  } catch (e) {
    return res.status(502).json({ error: String(e.message || e) });
  }
};
