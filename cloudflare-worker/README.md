# ☁️ EMS Companion — Cloudflare Worker 백엔드

`backend/main.py` (FastAPI) 의 Cloudflare Workers 포팅 버전.
사장님 기존 GitHub Pages + Cloudflare 운영 패턴과 통합됩니다.

---

## 📦 구조

```
cloudflare-worker/
  wrangler.toml          # Cloudflare CLI 설정
  package.json           # Node 의존성 (hono, wrangler)
  src/
    index.js             # 백엔드 코드 (라우팅, OpenAI 호출, 인증)
  .dev.vars.example      # 로컬 시크릿 예시 (.dev.vars 로 복사)
  .gitignore
```

엔드포인트는 Python 백엔드와 동일:
- `GET  /health`
- `POST /api/transcribe` (multipart)
- `POST /api/structure` (JSON)
- `POST /api/pipeline` (multipart, STT + 구조화)

---

## 🚀 첫 배포 (5단계, 약 15분)

### 1) Node.js 설치 (한 번만)

이미 있으면 건너뛰세요. [nodejs.org](https://nodejs.org/) 에서 LTS 버전.

확인:
```bash
node --version    # v18 이상
npm --version
```

### 2) 의존성 설치

```bash
cd cloudflare-worker
npm install
```

### 3) Cloudflare 로그인

```bash
npx wrangler login
```

브라우저가 열리고 사장님 Cloudflare 계정으로 로그인. 한 번만.

### 4) 시크릿 등록

```bash
# OpenAI API 키 (필수)
npx wrangler secret put OPENAI_API_KEY
# → 프롬프트에서 sk-proj-... 키 붙여넣기

# 클라이언트 인증 토큰 (필수, 본인이 정한 임의의 긴 문자열)
npx wrangler secret put SHARED_SECRET
# → 예: openssl rand -hex 32 같은 명령으로 만든 64자 문자열
```

> **SHARED_SECRET 이 정해지면 프론트엔드에도 같은 값을 알려줘야 합니다.**
> 프론트는 첫 접속 시 사용자에게 토큰을 묻거나, URL `?key=xxxxx` 로 한 번만 입력받습니다 (Phase 1 단순 인증).

### 5) 배포

```bash
npx wrangler deploy
```

성공하면 다음과 같은 URL 이 출력됩니다:
```
https://ems-companion-api.<사장님-계정>.workers.dev
```

이 URL 을 프론트엔드의 `API_BASE` 로 사용하면 끝.

---

## 🧪 로컬 개발 (배포 없이 테스트)

```bash
# .dev.vars.example 을 .dev.vars 로 복사하고 실제 키 입력
cp .dev.vars.example .dev.vars
# 그 다음 .dev.vars 편집

npm run dev
# → http://localhost:8787 에 띄움
```

다른 터미널에서:
```bash
# 헬스체크 (인증 불필요)
curl http://localhost:8787/health

# 구조화 테스트 (인증 필요)
curl -X POST http://localhost:8787/api/structure \
  -H "Content-Type: application/json" \
  -H "X-API-Key: <SHARED_SECRET 값>" \
  -d '{"transcript": "14시 32분 환자 접촉. 흉통 호소."}'
```

---

## 🔐 보안 메모

- `OPENAI_API_KEY` 와 `SHARED_SECRET` 은 **반드시 시크릿으로만** 관리. `wrangler.toml` 이나 코드에 박지 말 것.
- `SHARED_SECRET` 이 미설정이면 인증 비활성 (개발 편의). 배포 시 반드시 설정.
- CORS 는 현재 `*` (모든 origin 허용). 본격 운영 시 GitHub Pages 도메인으로 좁히는 게 안전.
- 한 사람씩 시크릿을 알고 있게 — 시크릿 노출 시 즉시 `wrangler secret put` 으로 재설정.

---

## 📊 무료 티어 한도

| 항목 | 한도 | 우리 예상 사용량 |
|------|------|----------------|
| 요청 | 10만/일 | 출동 1건 = 약 3 요청. 100건/일이라도 300 요청 |
| CPU | 10ms/요청 | 외부 API 응답 대기는 미계산. OpenAI 호출은 사실상 0 CPU |
| 요청 본문 | 100MB | 5분 무손실 음성 약 30MB. OK |

→ Phase 1~2 (사장님 본인 + 동료 5명 시범) 단계에서는 **무료로 충분**.

---

## 🆘 트러블슈팅

**`wrangler: command not found`**
→ `npm install` 안 했거나, `npx wrangler` 로 호출하세요.

**401 Unauthorized**
→ `X-API-Key` 헤더 누락 또는 값 불일치. `SHARED_SECRET` 다시 등록 후 프론트에도 반영.

**500 OPENAI_API_KEY 가 설정되지 않았습니다**
→ `wrangler secret put OPENAI_API_KEY` 안 했거나, 다른 환경(production vs preview)에 등록함.

**CORS 에러 (브라우저 콘솔)**
→ 워커는 CORS `*` 허용이라 평소엔 안 남. 에러 본문이 401/500이라 브라우저가 CORS 처럼 표시하는 경우 있음. 워커 응답을 직접 확인하세요 (`curl` 또는 워커 대시보드의 로그).
