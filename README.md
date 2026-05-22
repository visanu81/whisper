# 🚒 Phase 0: 구급 음성 자동 기록 시스템 — 로컬 파이프라인

음성 파일 한 개를 넣으면 → STT(텍스트 변환) → LLM 구조화(두 트랙 통합 타임라인)까지
**한 명령으로** 자동 처리합니다. 구급대원의 추가 입력 없이 출동 기록물 초안이 만들어집니다.

---

## 📦 이 폴더에 들어있는 것

| 파일 | 용도 |
|------|------|
| `transcribe.py` | 음성 → 텍스트 변환 (OpenAI gpt-4o-transcribe) |
| `structure.py` | 텍스트 → 두 트랙 구조화 (OpenAI gpt-4o) |
| `pipeline.py` | 위 두 단계를 한 번에 실행 (**권장 진입점**) |
| `scenario_level1.md` | 모의 시나리오 — 조용한 1:1 환경 |
| `scenario_level2.md` | 모의 시나리오 — 다중화자·발화겹침·보호자 끼어듦 |
| `structuring_prompt.md` | (참고) 수동 구조화용 프롬프트 |
| `evaluation_checklist.md` | 변환 품질 평가 시트 |
| `requirements.txt` | Python 의존성 목록 |
| `.env.example` | API 키 설정 예시 (실제 키는 `.env`에) |
| `.gitignore` | 민감 파일 보호 설정 |

---

## 🚀 빠른 시작

### Step 1. 환경 준비 (한 번만)

```bash
# 1) OpenAI 가입 + API 키 발급 + $5 충전
#    → https://platform.openai.com/api-keys

# 2) 필요 라이브러리 설치
pip install -r requirements.txt

# 3) .env 파일 만들기
#    .env.example을 복사해서 .env로 이름 바꾸고, 실제 키 입력
#    Windows PowerShell:
copy .env.example .env
#    그 다음 .env 파일을 열어서 OPENAI_API_KEY 값 입력
```

### Step 2. 녹음

1. 스마트폰 기본 녹음앱 켜기
2. `scenario_level1.md` 또는 `scenario_level2.md` 보면서 대본 따라 녹음
3. 녹음 파일을 PC로 전송, 이 폴더에 저장
4. 파일명 예시: `scenario_level1.m4a`

### Step 3. 한 번에 실행 (권장)

```bash
python pipeline.py scenario_level1.m4a
```

이 명령 하나로 4개 결과 파일이 생성됩니다:

| 파일 | 내용 |
|------|------|
| `{이름}_transcript.txt` | 변환된 텍스트 (원본 보존) |
| `{이름}_result.json` | STT 메타데이터 + 텍스트 |
| `{이름}_structured.json` | 구조화된 JSON (재현·기록용) |
| `{이름}_report.md` | **사람이 읽기 좋은 리포트** (검토 시작점) |

### Step 4. 결과 검토

1. `{이름}_report.md` 열기
2. 7개 섹션 검토:
   - 통합 타임라인
   - 환자 발화 트랙
   - 처치 트랙
   - SAMPLE / OPQRST 추출
   - 구급일지 핵심 요약
   - **변환 품질 평가** (환각/누락/인식오류)
3. `evaluation_checklist.md` 기준으로 채점

---

## 🔧 단계별 실행 (디버깅·튜닝용)

```bash
# STT만 실행 (구조화 건너뜀)
python pipeline.py scenario_level1.m4a --stt-only

# 또는 transcribe.py 직접
python transcribe.py scenario_level1.m4a

# 기존 transcript에 구조화만 다시 실행
python structure.py scenario_level1_transcript.txt
python structure.py scenario_level1_result.json   # JSON 입력도 지원

# 모델 변경 (예: 비용 절감 테스트)
python pipeline.py scenario_level1.m4a --model gpt-4o-mini
python structure.py scenario_level1_transcript.txt --model gpt-4o-mini
```

---

## ⚠️ 주의사항

1. **API 키 보안**
   - 실제 키는 반드시 `.env` 파일에만. `.env.example`에는 절대 진짜 키 넣지 말 것
   - `.gitignore` 가 `.env`를 차단하고 있는지 확인
   - GitHub 푸시 전 항상 키 노출 여부 점검

2. **개인정보 보호**
   - **진짜 환자 음성 절대 사용 금지** (Phase 0~1은 모의 시나리오만)
   - 본인/동료 목소리만 사용
   - 응급의료법·개인정보보호법·통신비밀보호법 항상 염두

3. **비용 관리 (대략)**
   - `gpt-4o-transcribe`: 분당 약 8원
   - `gpt-4o` 구조화: 5분 분량 transcript당 약 50~150원 (텍스트 길이에 비례)
   - 5분 시나리오 1회 풀 파이프라인: 약 100~200원
   - 정확한 사용량은 OpenAI 대시보드(usage)에서 확인

4. **품질 한계 (인지하고 있을 것)**
   - STT가 잘못 인식한 단어는 LLM 구조화에서도 잘못된 상태로 들어감
   - LLM은 텍스트만 봄 → 음성 원본의 미묘함(망설임, 어조)은 손실
   - 따라서 `quality_assessment` 섹션과 **사람의 최종 검증**이 필수

---

## 📞 Phase 0 검증 끝나면

평가 체크리스트 작성 후 결과를 Claude에게 던지세요.
정확도가 충분하면 → Phase 1 (단일 사용자 웹 MVP) 진입.
아쉬우면 → `MEDICAL_DOMAIN_PROMPT`(STT) 또는
`STRUCTURING_SYSTEM_PROMPT`(LLM) 튜닝부터.

---

## 🌐 Phase 1 — 웹 MVP

이 폴더는 **프론트엔드 + 두 가지 백엔드 옵션**을 함께 포함합니다.

```
frontend/             # 정적 웹앱 (GitHub Pages 배포용)
backend/              # Python FastAPI 백엔드 (로컬 개발용)
cloudflare-worker/    # Cloudflare Worker 백엔드 (영구 배포용, GitHub+Cloudflare 패턴)
```

### 로컬 개발 (PC)

```bash
# 1) Python 백엔드 띄움 (포트 8001)
pip install -r requirements.txt
python -m uvicorn backend.main:app --port 8001 --host 127.0.0.1

# 2) 프론트엔드 띄움 (포트 8000)
python -m http.server 8000 --directory frontend

# 3) 브라우저
# http://localhost:8000
```

프론트의 `API_BASE` 가 호스트명을 보고 자동으로 백엔드를 찾습니다.

### 영구 배포 (사장님 GitHub Pages + Cloudflare 패턴)

- 프론트: `frontend/` 를 GitHub Pages 에 올림
- 백엔드: `cloudflare-worker/` 를 Cloudflare Workers 에 배포 — 상세는 `cloudflare-worker/README.md`

배포 후 첫 1회만 다음 URL 로 접속:
```
https://<github-pages>/?api=https://<worker-url>&key=<SHARED_SECRET>
```
브라우저가 URL 에서 secret 을 즉시 제거하고 `localStorage` 에 저장. 그 후로는 일반 URL 로 접근.
