/**
 * EMS Companion — Cloudflare Worker 백엔드
 *
 * Python backend/main.py 의 포팅 버전. 동일한 3개 엔드포인트:
 *   GET  /health
 *   POST /api/transcribe   (multipart, 음성 파일 → STT)
 *   POST /api/structure    (JSON, transcript → 구조화)
 *   POST /api/pipeline     (multipart, 음성 → STT + 구조화)
 *
 * 환경(시크릿):
 *   OPENAI_API_KEY  — OpenAI API 키 (필수)
 *   SHARED_SECRET   — 클라이언트 인증용 토큰 (선택. 설정하면 X-API-Key 헤더 필수)
 *
 * 배포:
 *   cd cloudflare-worker
 *   npm install
 *   npx wrangler login
 *   npx wrangler secret put OPENAI_API_KEY
 *   npx wrangler secret put SHARED_SECRET
 *   npx wrangler deploy
 *   → 배포 후 출력되는 URL 을 프론트 API_BASE 로 사용
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';

// 의료 도메인 STT 프롬프트 (transcribe.py 와 동일)
const MEDICAL_DOMAIN_PROMPT =
  '다음은 119 구급대원의 출동 음성 기록입니다. ' +
  '활력징후(혈압, 맥박, 호흡수, 산소포화도, 체온, 의식수준), ' +
  '의료 평가도구(GCS, AVPU, SAMPLE, OPQRST, NRS), ' +
  '처치 술기(비강캐뉼라, 비재호흡 마스크, 정맥로, 18게이지, 20게이지, 심전도 모니터링), ' +
  '약물(에피네프린, 아트로핀, 50% 포도당, 생리식염수, 인슐린, 란투스, 아스피린, 니트로글리세린), ' +
  '진단(협심증, 심근경색, 저혈당, 고혈당, ST분절 변화, 의식저하), ' +
  "시각 발화는 '14시 32분', '15시 10분' 형식입니다.";

// 구조화 시스템 프롬프트 (structure.py 의 STRUCTURING_SYSTEM_PROMPT 와 동일)
const STRUCTURING_SYSTEM_PROMPT = `당신은 119 구급 출동 음성 변환 텍스트를 분석하여 구급일지에 들어갈 형태로
구조화하는 전문 시스템입니다. 의료 데이터의 책임이 무거우므로
**없는 정보를 만들어내지 말고**, 추출되지 않는 항목은 null 또는 빈 배열로 두십시오.

[입력]
119 구급 출동 모의 시나리오의 음성 변환 텍스트.

[규칙]
1. 시간 발화(예: "14시 32분", "15시 10분")가 있으면 "HH:MM" 형식 타임스탬프로 변환
2. 시간 발화가 없으면 time 필드는 null
3. 환자/보호자 발화는 patient_speech_track 으로
4. **환자의 신음·혼미·짧은 응답 발화도 반드시 포함**할 것
   예: "으…", "아파요…", "어디예요…?", "미나야…?", "죄송해요…"
   이유: 신음 → 혼미한 발화 → 정상 대화로의 변화는 **의식수준 회복의 임상 marker**임.
   이런 발화는 tags 에 "의식수준_변화" 를 포함시킬 것.
5. 활력징후·처치·약물·술기는 treatment_track 으로
6. NRS·통증 점수(예: "NRS 8점에서 5점으로 감소")가 발화되면 OPQRST 의 S(강도)에 그 변화를 기록
7. 동일한 사건은 integrated_timeline 에도 시간순으로 통합 기록
8. SAMPLE(증상/알레르기/약물/과거력/마지막식사/사건경위)은 추출되는 항목만 채움
9. OPQRST 는 통증 위주 평가용. 통증이 주증상이 아닌 케이스(저혈당, 의식저하, 호흡곤란 등)
   에서는 6개 필드 모두 null 로 두되, quality_assessment.notes 에
   "OPQRST 미적용: 통증 주증상이 아님" 같은 메모를 남길 것
10. 품질 평가는 **적극적으로** 수행. 다음을 항상 점검:
    - 시간 발화가 없는데 시간순 정렬이 모호한 구간 → omission_suspected 에 기록
    - 인식이 어색한 의료용어(약물명·술기명·수치) → terminology_errors 에 기록
    - 발화 주체가 불분명한 구간 → omission_suspected 에 기록
    - 자신 없는 추론이 들어간 항목 → hallucination_suspected 에 기록
    - 아무것도 없을 때만 빈 배열을 둘 것. 디폴트로 "없음"을 가정하지 말 것
11. **반드시** 아래 JSON 스키마를 그대로 따를 것. 임의로 키를 추가하거나 빼지 말 것.

[출력 JSON 스키마]
{
  "integrated_timeline": [
    {
      "time": "HH:MM" 또는 null,
      "type": "patient_speech" | "vitals" | "medication" | "procedure" | "observation",
      "actor": "환자" | "보호자" | "구급대원" | null,
      "content": "한 줄 설명"
    }
  ],
  "patient_speech_track": [
    {
      "time": "HH:MM" 또는 null,
      "speaker": "환자" | "보호자",
      "content": "발화 내용 (원문 보존)",
      "tags": ["주증상" | "사고경위" | "기왕력" | "복용약물" | "알레르기" | "의식수준_변화" | "기타"]
    }
  ],
  "treatment_track": [
    {
      "time": "HH:MM" 또는 null,
      "category": "vitals" | "medication" | "procedure" | "observation",
      "content": "처치/측정 내용",
      "details": {
        "bp": "수축기/이완기" 또는 null,
        "hr": 숫자 또는 null,
        "rr": 숫자 또는 null,
        "spo2": 숫자 또는 null,
        "temp": 숫자 또는 null,
        "bst": 숫자 또는 null,
        "ams": "A" | "V" | "P" | "U" 또는 null,
        "gcs": 숫자 또는 null,
        "medication_name": 문자열 또는 null,
        "medication_dose": 문자열 또는 null,
        "procedure_name": 문자열 또는 null
      }
    }
  ],
  "sample": {
    "S": 문자열 또는 null,
    "A": 문자열 또는 null,
    "M": 문자열 또는 null,
    "P": 문자열 또는 null,
    "L": 문자열 또는 null,
    "E": 문자열 또는 null
  },
  "opqrst": {
    "O": 문자열 또는 null,
    "P": 문자열 또는 null,
    "Q": 문자열 또는 null,
    "R": 문자열 또는 null,
    "S": 문자열 또는 null,
    "T": 문자열 또는 null
  },
  "report": {
    "chief_complaint": 문자열 또는 null,
    "consciousness": 문자열 또는 null,
    "hospital": 문자열 또는 null,
    "handover": 문자열 또는 null
  },
  "quality_assessment": {
    "hallucination_suspected": ["의심 구간 설명", ...],
    "omission_suspected": ["누락 의심 구간 설명", ...],
    "terminology_errors": ["인식 오류 의심 단어/구간", ...],
    "notes": ["기타 메모 (예: 'OPQRST 미적용: 통증 주증상이 아님')", ...]
  }
}

[안전 원칙]
- 추측 금지: 텍스트에 없는 수치·약물·시간을 만들어내지 말 것
- 의심되면 quality_assessment 에 명시
- 발화 원문은 가능한 한 보존 (paraphrase 최소화)
- 결과는 반드시 위 스키마에 맞는 유효한 JSON 객체`;

const app = new Hono();

// 허용되는 frontend origin 목록 (환경변수 ALLOWED_ORIGINS 로 override 가능, 쉼표 구분)
// 예: "https://whisper.visanu81.workers.dev,https://ems.example.com"
const DEFAULT_ALLOWED_ORIGINS = 'https://whisper.visanu81.workers.dev,http://localhost:8000,http://127.0.0.1:8000';

function getAllowedOrigins(env) {
  const raw = env.ALLOWED_ORIGINS || DEFAULT_ALLOWED_ORIGINS;
  return raw.split(',').map((s) => s.trim()).filter((s) => s);
}

// CORS — Origin 화이트리스트 기반.
// 등록된 origin 만 Access-Control-Allow-Origin 응답을 받음.
app.use('*', (c, next) => {
  const allowed = getAllowedOrigins(c.env);
  return cors({
    origin: (origin) => {
      if (!origin) return null; // origin 헤더 없으면 (curl 등) 허용 안 함
      return allowed.includes(origin) ? origin : null;
    },
    allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'X-API-Key', 'X-Admin-Key'],
  })(c, next);
});

// 공통 인증 미들웨어 — Origin 헤더 기반 (Phase 1 시범 단계)
//   - /health 는 누구나 허용 (모니터링용)
//   - OPTIONS (CORS preflight) 는 CORS 미들웨어가 처리
//   - 그 외: Origin (또는 Referer) 이 allowed 목록에 있어야 함
//   - 호환성: SHARED_SECRET 이 설정돼 있으면 X-API-Key 일치 시에도 허용 (기존 클라이언트 보호)
async function authMiddleware(c, next) {
  if (c.req.path === '/health') return next();
  if (c.req.method === 'OPTIONS') return next();

  const allowed = getAllowedOrigins(c.env);
  const origin = c.req.header('Origin') || '';
  const referer = c.req.header('Referer') || '';

  const originAllowed = allowed.includes(origin) ||
    allowed.some((a) => referer.startsWith(a));

  if (originAllowed) return next();

  // 폴백: 기존 SHARED_SECRET 클라이언트 호환 (있는 경우만)
  const expected = c.env.SHARED_SECRET;
  if (expected) {
    const provided = c.req.header('X-API-Key');
    if (provided === expected) return next();
  }

  return c.json({
    error: 'Forbidden',
    hint: 'This API is only callable from authorized frontends. Set ALLOWED_ORIGINS env var to whitelist your domain.',
  }, 403);
}

app.use('*', authMiddleware);

// 관리자 인증 — 특정 라우트에만 적용 (라우트 정의 시 명시적으로 호출)
//   - ADMIN_PIN (4~8자리 짧은 PIN — 사장님 편의용, 외우기 좋음)
//   - ADMIN_SECRET (64자 — 옛 방식, fallback)
//   - 둘 중 하나라도 등록돼 있으면 X-Admin-Key 헤더가 그것과 일치해야 통과
async function requireAdmin(c) {
  const expectedPin = c.env.ADMIN_PIN;
  const expectedSecret = c.env.ADMIN_SECRET;
  if (!expectedPin && !expectedSecret) {
    return c.json({ error: 'Admin endpoint not configured (ADMIN_PIN or ADMIN_SECRET missing)' }, 503);
  }
  const provided = c.req.header('X-Admin-Key');
  if (!provided) {
    return c.json({ error: 'Admin auth required' }, 403);
  }
  if (provided === expectedPin || provided === expectedSecret) {
    return null; // 통과
  }
  return c.json({ error: 'Invalid admin key' }, 403);
}

// =====================================================================
// /health
// =====================================================================
app.get('/health', (c) => {
  return c.json({
    status: 'ok',
    openai_key_configured: !!c.env.OPENAI_API_KEY,
    auth_method: 'origin',
    allowed_origins: getAllowedOrigins(c.env),
    legacy_secret_fallback: !!c.env.SHARED_SECRET,
    admin_configured: !!(c.env.ADMIN_PIN || c.env.ADMIN_SECRET),
    admin_pin_set: !!c.env.ADMIN_PIN,
    records_storage: !!c.env.EMS_RECORDS ? 'kv' : 'none',
    service: 'EMS Companion API (Cloudflare Worker)',
  });
});

// =====================================================================
// OpenAI 호출 헬퍼
// =====================================================================
async function callWhisperTranscribe(audioBlob, filename, apiKey) {
  const form = new FormData();
  form.append('file', audioBlob, filename || 'audio.webm');
  form.append('model', 'gpt-4o-transcribe');
  form.append('language', 'ko');
  form.append('prompt', MEDICAL_DOMAIN_PROMPT);
  form.append('response_format', 'json');

  const t0 = Date.now();
  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
    },
    body: form,
  });
  const elapsed = (Date.now() - t0) / 1000;

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`OpenAI Whisper API ${res.status}: ${errText}`);
  }

  const data = await res.json();
  return {
    file_name: filename,
    file_size_mb: Math.round((audioBlob.size / (1024 * 1024)) * 100) / 100,
    model: 'gpt-4o-transcribe',
    language: 'ko',
    transcribe_elapsed_seconds: Math.round(elapsed * 100) / 100,
    transcript: data.text || '',
    prompt_used: MEDICAL_DOMAIN_PROMPT,
    timestamp: new Date().toISOString(),
  };
}

async function callChatStructure(transcript, model, apiKey) {
  const t0 = Date.now();
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: model || 'gpt-4o',
      messages: [
        { role: 'system', content: STRUCTURING_SYSTEM_PROMPT },
        {
          role: 'user',
          content:
            '다음 음성 변환 텍스트를 시스템 프롬프트의 스키마대로 ' +
            '구조화하여 JSON으로만 응답하세요.\n\n' +
            `[원본 텍스트]\n${transcript}`,
        },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.2,
    }),
  });
  const elapsed = (Date.now() - t0) / 1000;

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`OpenAI Chat API ${res.status}: ${errText}`);
  }

  const data = await res.json();
  // optional chaining 대신 명시적으로 풀어 씀 (호환성)
  const firstChoice = (data.choices && data.choices[0]) || {};
  const message = firstChoice.message || {};
  const content = message.content || '';
  const usage = data.usage || {};

  let structured;
  try {
    structured = JSON.parse(content);
  } catch (e) {
    throw new Error(`모델이 유효하지 않은 JSON 반환: ${e.message}`);
  }

  structured._meta = {
    model: model || 'gpt-4o',
    structure_elapsed_seconds: Math.round(elapsed * 100) / 100,
    transcript_length: transcript.length,
    input_tokens: usage.prompt_tokens || null,
    output_tokens: usage.completion_tokens || null,
    timestamp: new Date().toISOString(),
  };
  return structured;
}

// =====================================================================
// POST /api/transcribe
// =====================================================================
app.post('/api/transcribe', async (c) => {
  if (!c.env.OPENAI_API_KEY) {
    return c.json({ error: 'OPENAI_API_KEY 가 설정되지 않았습니다.' }, 500);
  }

  let audio;
  try {
    const form = await c.req.formData();
    audio = form.get('audio');
  } catch (e) {
    return c.json({ error: `multipart 파싱 실패: ${e.message}` }, 400);
  }

  if (!audio || typeof audio === 'string') {
    return c.json({ error: 'audio 파일 필드가 없습니다.' }, 400);
  }

  try {
    const result = await callWhisperTranscribe(audio, audio.name, c.env.OPENAI_API_KEY);
    return c.json(result);
  } catch (e) {
    return c.json({ error: `STT 실패: ${e.message}` }, 500);
  }
});

// =====================================================================
// POST /api/structure
// =====================================================================
app.post('/api/structure', async (c) => {
  if (!c.env.OPENAI_API_KEY) {
    return c.json({ error: 'OPENAI_API_KEY 가 설정되지 않았습니다.' }, 500);
  }

  let body;
  try {
    body = await c.req.json();
  } catch (e) {
    return c.json({ error: `JSON 파싱 실패: ${e.message}` }, 400);
  }

  const transcript = (body.transcript || '').trim();
  if (!transcript) {
    return c.json({ error: 'transcript 가 비어 있습니다.' }, 400);
  }

  try {
    const structured = await callChatStructure(transcript, body.model, c.env.OPENAI_API_KEY);
    return c.json(structured);
  } catch (e) {
    return c.json({ error: `구조화 실패: ${e.message}` }, 500);
  }
});

// =====================================================================
// POST /api/pipeline
// =====================================================================
app.post('/api/pipeline', async (c) => {
  if (!c.env.OPENAI_API_KEY) {
    return c.json({ error: 'OPENAI_API_KEY 가 설정되지 않았습니다.' }, 500);
  }

  const model = c.req.query('model') || 'gpt-4o';

  let audio;
  try {
    const form = await c.req.formData();
    audio = form.get('audio');
  } catch (e) {
    return c.json({ error: `multipart 파싱 실패: ${e.message}` }, 400);
  }

  if (!audio || typeof audio === 'string') {
    return c.json({ error: 'audio 파일 필드가 없습니다.' }, 400);
  }

  try {
    // 1) STT
    const stt = await callWhisperTranscribe(audio, audio.name, c.env.OPENAI_API_KEY);
    const transcript = (stt.transcript || '').trim();
    if (!transcript) {
      return c.json({ error: 'STT 결과가 비어 있어 구조화 불가' }, 500);
    }
    // 2) 구조화
    const structured = await callChatStructure(transcript, model, c.env.OPENAI_API_KEY);
    return c.json({ transcribe: stt, structured });
  } catch (e) {
    return c.json({ error: `파이프라인 실패: ${e.message}` }, 500);
  }
});

// =====================================================================
// 출동 기록 KV 저장소 (관리자 통합 대시보드)
//
// 동료가 음성 처리 완료 시 자동으로 사본 저장 → 사장님(관리자)이 통합 조회.
// KV key: record:{ISO_timestamp}_{shortId}  (시간 역순 정렬에 유리)
// =====================================================================
const REC_PREFIX = 'record:';

// POST /api/records — 모든 사용자 (Origin 인증) — 출동 기록 사본 저장
app.post('/api/records', async (c) => {
  if (!c.env.EMS_RECORDS) {
    return c.json({ error: 'KV storage not configured' }, 503);
  }
  let body;
  try {
    body = await c.req.json();
  } catch (e) {
    return c.json({ error: `JSON 파싱 실패: ${e.message}` }, 400);
  }
  if (!body || !body.id || !body.saved_at || !body.data) {
    return c.json({ error: 'id, saved_at, data 필드 필수' }, 400);
  }
  const key = `${REC_PREFIX}${body.saved_at}_${body.id}`;
  try {
    await c.env.EMS_RECORDS.put(key, JSON.stringify(body));
    return c.json({ ok: true, key });
  } catch (e) {
    return c.json({ error: `저장 실패: ${e.message}` }, 500);
  }
});

// GET /api/records — 관리자만 — 모든 기록 조회 (페이징 지원)
app.get('/api/records', async (c) => {
  const adminFail = await requireAdmin(c);
  if (adminFail) return adminFail;
  if (!c.env.EMS_RECORDS) {
    return c.json({ error: 'KV storage not configured' }, 503);
  }

  const limit = Math.min(parseInt(c.req.query('limit') || '100', 10), 1000);
  const cursor = c.req.query('cursor') || undefined;

  try {
    const listResult = await c.env.EMS_RECORDS.list({ prefix: REC_PREFIX, limit, cursor });
    // 각 key 의 value 를 병렬로 가져옴
    const records = await Promise.all(
      listResult.keys.map(async (k) => {
        const raw = await c.env.EMS_RECORDS.get(k.name);
        if (!raw) return null;
        try { return JSON.parse(raw); } catch (_) { return null; }
      })
    );
    // null 제거 + 시간 역순 정렬 (가장 최신이 위)
    const sorted = records.filter(Boolean).sort((a, b) => (b.saved_at || '').localeCompare(a.saved_at || ''));
    return c.json({
      records: sorted,
      count: sorted.length,
      cursor: listResult.list_complete ? null : listResult.cursor,
    });
  } catch (e) {
    return c.json({ error: `조회 실패: ${e.message}` }, 500);
  }
});

// DELETE /api/records/:id — 관리자만 — 특정 기록 삭제
app.delete('/api/records/:id', async (c) => {
  const adminFail = await requireAdmin(c);
  if (adminFail) return adminFail;
  if (!c.env.EMS_RECORDS) {
    return c.json({ error: 'KV storage not configured' }, 503);
  }
  const id = c.req.param('id');
  if (!id) return c.json({ error: 'id 필수' }, 400);

  try {
    // record:{timestamp}_{id} key 를 찾아야 하므로 list 로 prefix 검색
    const listResult = await c.env.EMS_RECORDS.list({ prefix: REC_PREFIX });
    const matching = listResult.keys.filter((k) => k.name.endsWith(`_${id}`));
    if (matching.length === 0) {
      return c.json({ error: 'Record not found' }, 404);
    }
    await Promise.all(matching.map((k) => c.env.EMS_RECORDS.delete(k.name)));
    return c.json({ ok: true, deleted: matching.length });
  } catch (e) {
    return c.json({ error: `삭제 실패: ${e.message}` }, 500);
  }
});

export default app;
