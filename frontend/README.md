# 🖥️ Phase 1 UI 목업 — EMS Companion

두 트랙 통합 타임라인을 시각화하는 단일 페이지 웹앱.
현재는 **백엔드 미연결**, 더미 JSON(`samples/level1.json`, `samples/level2.json`)을
로드하여 화면 구조를 검증하는 단계입니다.

---

## 📦 구조

```
frontend/
  index.html           # 단일 페이지 (Tailwind CDN)
  app.js               # JSON 로드 + 렌더링 로직
  samples/
    level1.json        # 시나리오 1 더미 구조화 결과
    level2.json        # 시나리오 2 더미 구조화 결과
  README.md            # 이 문서
```

---

## 🚀 로컬에서 미리보기

`fetch()`로 JSON을 로드하기 때문에 `file://`로 직접 열면 안 됩니다.
간단히 로컬 서버를 띄우세요.

```bash
# 프로젝트 루트(위스퍼모델/)에서
python -m http.server 8000 --directory frontend

# 그 다음 브라우저에서
# http://localhost:8000
```

화면 우상단의 **레벨 1 / 레벨 2** 토글로 시나리오를 전환할 수 있습니다.

---

## 🎨 화면 구성

1. **헤더** — 시나리오 토글
2. **구급일지 핵심 요약 카드** — 주증상·의식수준·이송병원·인계사항
3. **통합 타임라인** (이 페이지의 핵심)
   - 중앙 시간축을 따라 환자/보호자 발화(왼쪽)와 처치(오른쪽)가 좌우 분리
   - 색상 구분: 환자 발화 amber, 활력징후 blue, 약물 emerald, 술기 cyan, 관찰 slate
   - 같은 시각의 이벤트는 한 줄로 묶임
   - 시간이 null 인 항목은 하단 "시간 미상" 영역에
4. **SAMPLE / OPQRST** — 항목별 추출 결과 (없으면 "추출 없음" 표시)
5. **변환 품질 평가** — 환각/누락/오류/메모 4개 분류
6. **다운로드** — 현재 시나리오의 JSON / Markdown 내보내기

---

## 🔌 백엔드 연결 (Phase 1 다음 단계)

`app.js` 의 `loadScenario()` 안에 있는 fetch URL을 API 엔드포인트로 교체하면
백엔드 연결이 완료됩니다.

```js
// 현재
const res = await fetch(`samples/${level}.json`);

// 백엔드 연결 후 (예시)
const res = await fetch(`https://api.ems-companion.example.com/sessions/${sessionId}`);
```

추가로 녹음 → 업로드 UI가 필요하지만 이는 백엔드 스펙 확정 후 작업.

---

## 🌐 GitHub Pages 배포

이 폴더 자체를 GitHub Pages로 배포 가능합니다:

1. 이 프로젝트를 GitHub 저장소로 푸시 (단, **`.env` 가 절대 포함되지 않는지** 확인)
2. 저장소 Settings → Pages → Source: `frontend/` 폴더 선택
3. 몇 분 후 `https://<유저>.github.io/<레포>/` 에서 접근 가능

---

## ⚠️ 알려진 한계

- **백엔드 미연결.** 더미 JSON 표시만.
- **녹음 UI 없음.** 현재는 시나리오 토글만.
- **Tailwind CDN 사용.** Phase 2에서 정식 빌드로 전환 권장.
- **로컬 서버 필수.** `file://`에서는 fetch가 차단됨.
- **모바일 레이아웃 최적화 미흡.** 데스크톱 우선 디자인.
