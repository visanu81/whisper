"""
transcribe.py — 구급 음성 자동 기록 시스템 (Phase 0)

OpenAI gpt-4o-transcribe API로 음성 파일을 텍스트로 변환합니다.
의료 도메인 컨텍스트 프롬프트를 함께 전달하여
의료 전문용어·시간 발화·약물명 인식 정확도를 높입니다.

사용법:
    python transcribe.py scenario_level1.m4a
    python transcribe.py "녹음파일 경로.m4a"

출력 (같은 폴더, 같은 이름):
    {파일명}_transcript.txt  — 변환된 텍스트 (Claude에 붙여넣기용)
    {파일명}_result.json     — 메타데이터 + 텍스트 (재현·기록용)
"""

import json
import os
import sys
import time
from pathlib import Path

from dotenv import load_dotenv
from openai import OpenAI


# 의료 도메인 컨텍스트 프롬프트.
# Whisper/gpt-4o-transcribe의 `prompt` 파라미터에 전달되어
# 모델이 의료 전문용어·약물명·시간 발화 형식을 더 정확히 인식하도록 유도.
MEDICAL_DOMAIN_PROMPT = (
    "다음은 119 구급대원의 출동 음성 기록입니다. "
    "활력징후(혈압, 맥박, 호흡수, 산소포화도, 체온, 의식수준), "
    "의료 평가도구(GCS, AVPU, SAMPLE, OPQRST, NRS), "
    "처치 술기(비강캐뉼라, 비재호흡 마스크, 정맥로, 18게이지, 20게이지, 심전도 모니터링), "
    "약물(에피네프린, 아트로핀, 50% 포도당, 생리식염수, 인슐린, 란투스, 아스피린, 니트로글리세린), "
    "진단(협심증, 심근경색, 저혈당, 고혈당, ST분절 변화, 의식저하), "
    "시각 발화는 '14시 32분', '15시 10분' 형식입니다."
)


def transcribe_audio(audio_path: Path) -> dict:
    if not audio_path.exists():
        raise FileNotFoundError(f"음성 파일을 찾을 수 없습니다: {audio_path}")

    client = OpenAI()  # OPENAI_API_KEY 환경변수 자동 로드

    file_size_mb = audio_path.stat().st_size / (1024 * 1024)
    print(f"[INFO] 변환 시작: {audio_path.name} ({file_size_mb:.2f} MB)")
    print(f"[INFO] 모델: gpt-4o-transcribe, 언어: ko")

    start_time = time.time()

    with open(audio_path, "rb") as audio_file:
        response = client.audio.transcriptions.create(
            model="gpt-4o-transcribe",
            file=audio_file,
            prompt=MEDICAL_DOMAIN_PROMPT,
            language="ko",
            response_format="json",
        )

    elapsed_seconds = time.time() - start_time
    transcript_text = response.text

    return {
        "file_name": audio_path.name,
        "file_size_mb": round(file_size_mb, 2),
        "model": "gpt-4o-transcribe",
        "language": "ko",
        "transcribe_elapsed_seconds": round(elapsed_seconds, 2),
        "transcript": transcript_text,
        "prompt_used": MEDICAL_DOMAIN_PROMPT,
        "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
    }


def save_results(audio_path: Path, result: dict):
    base = audio_path.with_suffix("")
    transcript_path = Path(f"{base}_transcript.txt")
    json_path = Path(f"{base}_result.json")

    transcript_path.write_text(result["transcript"], encoding="utf-8")
    json_path.write_text(
        json.dumps(result, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return transcript_path, json_path


def main():
    if len(sys.argv) < 2:
        print("사용법: python transcribe.py <오디오파일경로>")
        print("예시: python transcribe.py scenario_level1.m4a")
        sys.exit(1)

    load_dotenv()
    if not os.getenv("OPENAI_API_KEY"):
        print("[ERROR] OPENAI_API_KEY가 설정되지 않았습니다.")
        print("        .env.example을 .env로 복사하고 본인 API 키를 입력하세요.")
        sys.exit(1)

    audio_path = Path(sys.argv[1])

    try:
        result = transcribe_audio(audio_path)
        transcript_path, json_path = save_results(audio_path, result)

        print()
        print("=" * 60)
        print(f"[완료] 변환 소요 시간: {result['transcribe_elapsed_seconds']}초")
        print(f"[비용 안내] gpt-4o-transcribe 요금은 분당 약 8원입니다.")
        print(f"           정확한 사용량은 OpenAI 대시보드(usage)에서 확인하세요.")
        print(f"[결과 파일]")
        print(f"   - {transcript_path.name}")
        print(f"   - {json_path.name}")
        print("=" * 60)
        print()
        print("[다음 단계]")
        print(f"  1. {transcript_path.name} 내용 확인")
        print(f"  2. structuring_prompt.md 양식에 transcript 내용 붙여넣기")
        print(f"  3. Claude에게 던지기 -> 두 트랙 통합 타임라인 생성")

    except FileNotFoundError as e:
        print(f"[ERROR] {e}")
        sys.exit(1)
    except Exception as e:
        print(f"[ERROR] 변환 실패: {type(e).__name__}: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
