# Plan Be — AI 데이트 풀코스 플래너

조건(지역·예산·취향·이동 수단)을 입력하면 실제 장소와 진행 중인 전시를 찾아
AI가 시간표 형태의 데이트 코스를 짜주는 모바일 웹 프로토타입입니다.

## 폴더 구성

```
index.html      화면 전체 (모바일 UI)
api/plan.js     실시간 데이터 + AI 코스 생성 서버 함수 (Vercel)
vercel.json     서버 함수 실행 시간 설정 (최대 60초)
```

## 실시간으로 가져오는 데이터

| 데이터 | 출처 | 비용 |
|---|---|---|
| 식당·카페 등 실제 장소, 좌표, 카카오맵 링크 | 카카오 로컬 API | 무료 |
| 장소 대표 이미지 | 카카오(다음) 이미지 검색 API | 무료 |
| 오늘 진행 중인 전시·공연·행사 | 서울 열린데이터광장 문화행사 정보 | 무료 |
| 팝업스토어 소식 | 카카오(다음) 웹 검색 → AI가 정리 | 무료 |
| 코스 구성, 플랜 B, 추천 이유 (AI) | Gemini API 또는 Claude API | Gemini 무료 한도 / Claude 유료 |

AI는 아래 순서로 자동 선택됩니다.

1. `ANTHROPIC_API_KEY`가 있으면 Claude
2. 없으면 `GEMINI_API_KEY`로 Gemini (무료, 결제 없음)
3. AI 키가 없거나 AI가 실패하면 **규칙 기반**으로 코스 구성 (장소·전시 데이터는 그대로 실시간)

카카오 키가 없거나 서버 연결에 실패하면 화면은 예시 데이터로 바뀌고,
결과 화면 위쪽에 회색 점과 "예시 데이터로 보여드려요 (이유)"가 표시됩니다.

## 1. API 키 발급

1. **카카오** — developers.kakao.com 로그인 → 내 애플리케이션 → 앱 추가
   → [앱 키]의 **REST API 키** 복사
   → [카카오맵] → **사용 설정 ON** (안 켜면 장소 검색이 거부됩니다)
2. **서울시** — data.seoul.go.kr 로그인 → 인증키 신청 → **일반 인증키** 복사
3. **Gemini (무료 AI)** — aistudio.google.com 에 구글 계정으로 로그인
   → **Get API key** → Create API key → 복사 (결제 등록 없이 무료 한도 안에서 사용)
4. (선택) **Claude** — console.anthropic.com → Billing에서 충전(최소 5달러, 자동 충전은 끄기)
   → API Keys → Create Key. 넣으면 Gemini 대신 Claude를 씁니다.

## 2. 배포 (GitHub + Vercel)

1. GitHub에서 새 저장소를 만들고 이 폴더의 파일을 **폴더 구조 그대로** 올립니다
   (`api` 폴더째로 끌어다 놓기).
2. vercel.com → Add New → Project → 저장소 Import
3. Import 화면의 **Environment Variables**에 아래 키를 추가하고 Deploy (Claude는 선택)

| 이름 | 값 |
|---|---|
| `KAKAO_REST_API_KEY` | 카카오 REST API 키 (필수) |
| `SEOUL_API_KEY` | 서울시 일반 인증키 (전시·행사용) |
| `GEMINI_API_KEY` | Gemini API 키 (무료 AI) |
| `ANTHROPIC_API_KEY` | Claude API 키 (선택, 유료) |

이미 배포했다면 Settings → Environment Variables에서 추가한 뒤 Deployments → Redeploy 하세요.

> GitHub Pages는 서버 함수를 실행하지 못해 예시 데이터로만 동작합니다. 실시간 연동은 Vercel에서만 됩니다.

## 3. 연결 확인

- 브라우저에서 `https://내주소.vercel.app/api/plan` 을 열면 키 설정 상태가 보입니다.
  `"kakao":true,"seoul":true,"gemini":true` 와 `"ai":"gemini (무료)"` 가 보이면 정상입니다.
- 앱에서 코스를 만든 뒤 결과 화면 위쪽에 초록 점과 **"실시간 데이터 · … · AI 코스 구성: Gemini · …기준"** 이 보이면 성공입니다.
  "AI 미연결 · 규칙 기반 구성"이 보이면 장소 데이터는 실시간이지만 AI 키가 없거나 AI 호출이 실패한 상태입니다.
- 실패하면 회색 점과 함께 이유가 표시됩니다. Vercel → Deployments → Logs에서 자세한 오류를 볼 수 있습니다.

## 참고

- API 키는 Vercel 환경변수에만 넣고 `index.html`이나 GitHub에는 절대 올리지 마세요.
- 가격과 머무는 시간은 AI가 추정한 값이라 실제와 다를 수 있습니다.
- 팝업스토어는 공식 데이터가 없어 웹 문서를 기반으로 하므로 방문 전 확인이 필요합니다.
- 모델을 바꾸려면 환경변수 `GEMINI_MODEL` 또는 `CLAUDE_MODEL`을 추가합니다
  (기본값: Gemini `gemini-flash-latest` → 없으면 `gemini-2.5-flash`, Claude `claude-haiku-5-5`).
