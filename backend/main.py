"""
backend/main.py — EMS Companion Phase 1 백엔드 API

FastAPI 로 transcribe.py + structure.py 를 HTTP 엔드포인트로 감싼다.
프론트(GitHub Pages)와 통신하기 위해 CORS 를 열어둔다.

엔드포인트:
    GET  /health                 헬스체크
    POST /api/transcribe         음성 파일 → STT (transcript 텍스트 + 메타)
    POST /api/structure          transcript 텍스트 → 구조화 JSON
    POST /api/pipeline           음성 파일 → STT + 구조화 통합 JSON

실행:
    # 프로젝트 루트(위스퍼모델/)에서
    uvicorn backend.main:app --reload --port 8001

    # 또는
    python -m uvicorn backend.main:app --reload --port 8001

테스트(curl):
    # 헬스체크
    curl http://localhost:8001/health

    # 구조화만 (음성 없이 텍스트로 빠르게)
    curl -X POST http://localhost:8001/api/structure \\
        -H "Content-Type: application/json" \\
        -d '{"transcript": "14시 32분 환자 접촉. 흉통 호소..."}'

    # 풀 파이프라인 (음성 파일)
    curl -X POST http://localhost:8001/api/pipeline \\
        -F "audio=@scenario_level1.m4a"

설계 메모:
    - transcribe.py / structure.py 는 그대로 두고 함수만 import (CLI 도 계속 동작)
    - 업로드 파일은 임시 디렉토리에서 처리 후 자동 삭제 (개인정보 보호)
    - OPENAI_API_KEY 는 서버의 .env 에서만 로드. 프론트로 절대 흘리지 않음
"""

import os
import sys
import tempfile
from pathlib import Path
from typing import Optional

from dotenv import load_dotenv
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

# 프로젝트 루트를 sys.path 에 추가하여 transcribe.py / structure.py import.
# (backend/ 가 패키지가 아닌 단일 진입점이라 이 방식이 가장 단순.)
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from transcribe import transcribe_audio  # noqa: E402
from structure import structure_transcript  # noqa: E402

# 서버 기동 시 .env 로드 (루트의 .env)
load_dotenv(ROOT / ".env")

app = FastAPI(
    title="EMS Companion API",
    description="구급 음성 자동 기록 시스템 백엔드 (Phase 1)",
    version="0.1.0",
)

# CORS: 개발 단계에서는 모든 오리진 허용. 배포 시 도메인 명시로 좁힐 것.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


# =====================================================================
# 요청/응답 모델
# =====================================================================
class StructureRequest(BaseModel):
    transcript: str
    model: Optional[str] = "gpt-4o"


# =====================================================================
# 엔드포인트
# =====================================================================
@app.get("/health")
def health():
    """헬스체크. API 키 존재 여부도 함께 보고."""
    return {
        "status": "ok",
        "openai_key_configured": bool(os.getenv("OPENAI_API_KEY")),
        "service": "EMS Companion API",
    }


@app.post("/api/transcribe")
async def api_transcribe(audio: UploadFile = File(...)):
    """음성 파일을 받아 STT 결과를 반환.

    Returns:
        {
          "transcript": "...",
          "file_name": "...",
          "model": "gpt-4o-transcribe",
          ...transcribe.py 의 결과 dict 그대로
        }
    """
    if not os.getenv("OPENAI_API_KEY"):
        raise HTTPException(status_code=500, detail="OPENAI_API_KEY 가 설정되지 않았습니다.")

    if not audio.filename:
        raise HTTPException(status_code=400, detail="파일명이 없습니다.")

    # 업로드 파일을 임시 디렉토리에 저장 후 처리, 끝나면 자동 삭제
    suffix = Path(audio.filename).suffix or ".m4a"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp_path = Path(tmp.name)
        tmp.write(await audio.read())

    try:
        result = transcribe_audio(tmp_path)
        # 원본 임시 파일명이 결과에 들어가지 않도록 클라이언트가 준 이름으로 교체
        result["file_name"] = audio.filename
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"STT 실패: {type(e).__name__}: {e}")
    finally:
        try:
            tmp_path.unlink(missing_ok=True)
        except Exception:
            pass


@app.post("/api/structure")
async def api_structure(req: StructureRequest):
    """transcript 텍스트를 받아 구조화된 JSON 을 반환."""
    if not os.getenv("OPENAI_API_KEY"):
        raise HTTPException(status_code=500, detail="OPENAI_API_KEY 가 설정되지 않았습니다.")

    transcript = (req.transcript or "").strip()
    if not transcript:
        raise HTTPException(status_code=400, detail="transcript 가 비어 있습니다.")

    try:
        structured = structure_transcript(transcript, model=req.model or "gpt-4o")
        return structured
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"구조화 실패: {type(e).__name__}: {e}")


@app.post("/api/pipeline")
async def api_pipeline(
    audio: UploadFile = File(...),
    model: str = "gpt-4o",
):
    """음성 파일 → STT → 구조화 한 번에 처리.

    Returns:
        {
          "transcribe": { ...transcribe.py 결과... },
          "structured": { ...structure.py 결과... }
        }
    """
    if not os.getenv("OPENAI_API_KEY"):
        raise HTTPException(status_code=500, detail="OPENAI_API_KEY 가 설정되지 않았습니다.")

    if not audio.filename:
        raise HTTPException(status_code=400, detail="파일명이 없습니다.")

    suffix = Path(audio.filename).suffix or ".m4a"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp_path = Path(tmp.name)
        tmp.write(await audio.read())

    try:
        # Step 1. STT
        stt_result = transcribe_audio(tmp_path)
        stt_result["file_name"] = audio.filename

        transcript = stt_result.get("transcript", "").strip()
        if not transcript:
            raise HTTPException(status_code=500, detail="STT 결과가 비어 있어 구조화 불가")

        # Step 2. 구조화
        structured = structure_transcript(transcript, model=model)

        return {
            "transcribe": stt_result,
            "structured": structured,
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"파이프라인 실패: {type(e).__name__}: {e}")
    finally:
        try:
            tmp_path.unlink(missing_ok=True)
        except Exception:
            pass
