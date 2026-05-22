"""
pipeline.py — 구급 음성 자동 기록 시스템 (Phase 0)

음성 파일 한 개를 입력하면:
  1) transcribe.py 로 STT 변환  → *_transcript.txt, *_result.json
  2) structure.py 로 구조화      → *_structured.json, *_report.md
까지 한 번에 실행합니다.

사용법:
    python pipeline.py scenario_level1.m4a
    python pipeline.py "녹음파일 경로.m4a" --model gpt-4o-mini

설계 메모:
    - transcribe.py / structure.py 의 함수를 직접 import 해서 재사용
    - 두 스크립트는 독립적으로도 그대로 동작
    - 어느 한 단계가 실패해도 그 시점까지의 결과는 디스크에 남음
"""

import argparse
import os
import sys
import time
from pathlib import Path

from dotenv import load_dotenv

# 같은 폴더의 두 스크립트에서 함수를 가져옴
from transcribe import transcribe_audio, save_results as save_transcribe_results
from structure import (
    structure_transcript,
    to_markdown,
    save_results as save_structure_results,
)


def main():
    parser = argparse.ArgumentParser(
        description="음성 파일 → STT → 구조화 한 번에 처리"
    )
    parser.add_argument("audio", help="입력 음성 파일 (m4a, mp3, wav 등)")
    parser.add_argument(
        "--model",
        default="gpt-4o",
        help="구조화에 사용할 OpenAI 모델 (기본: gpt-4o)",
    )
    parser.add_argument(
        "--stt-only",
        action="store_true",
        help="STT 단계만 실행하고 구조화는 건너뜀",
    )
    args = parser.parse_args()

    load_dotenv()
    if not os.getenv("OPENAI_API_KEY"):
        print("[ERROR] OPENAI_API_KEY가 설정되지 않았습니다.")
        print("        .env.example을 .env로 복사하고 본인 API 키를 입력하세요.")
        sys.exit(1)

    audio_path = Path(args.audio)
    if not audio_path.exists():
        print(f"[ERROR] 음성 파일을 찾을 수 없습니다: {audio_path}")
        sys.exit(1)

    overall_start = time.time()

    # === Step 1. STT ===
    print()
    print("┌" + "─" * 58 + "┐")
    print("│ Step 1/2  음성 → 텍스트 (gpt-4o-transcribe)" + " " * 13 + "│")
    print("└" + "─" * 58 + "┘")
    try:
        stt_result = transcribe_audio(audio_path)
        transcript_path, result_json_path = save_transcribe_results(
            audio_path, stt_result
        )
        transcript = stt_result["transcript"]
        print(f"[저장] {transcript_path.name}")
        print(f"[저장] {result_json_path.name}")
    except Exception as e:
        print(f"[ERROR] STT 실패: {type(e).__name__}: {e}")
        sys.exit(1)

    if args.stt_only:
        print()
        print("[INFO] --stt-only 옵션으로 STT 단계만 실행. 구조화 건너뜀.")
        return

    if not transcript.strip():
        print("[ERROR] STT 결과가 비어 있어 구조화를 진행할 수 없습니다.")
        sys.exit(1)

    # === Step 2. 구조화 ===
    print()
    print("┌" + "─" * 58 + "┐")
    print(f"│ Step 2/2  텍스트 → 두 트랙 구조화 ({args.model})" + " " * max(0, 58 - 35 - len(args.model)) + "│")
    print("└" + "─" * 58 + "┘")
    try:
        structured = structure_transcript(transcript, model=args.model)
        markdown = to_markdown(structured, source_name=audio_path.name)
        structured_path, report_path = save_structure_results(
            audio_path, structured, markdown
        )
        print(f"[저장] {structured_path.name}")
        print(f"[저장] {report_path.name}")
    except Exception as e:
        print(f"[ERROR] 구조화 실패: {type(e).__name__}: {e}")
        print("[INFO] STT 결과는 디스크에 저장되었습니다. structure.py 로 재시도 가능:")
        print(f"       python structure.py {transcript_path.name}")
        sys.exit(1)

    # === 요약 ===
    total_elapsed = time.time() - overall_start
    meta = structured.get("_meta", {})

    print()
    print("=" * 60)
    print(f"[전체 완료] 총 소요 시간: {total_elapsed:.2f}초")
    print(f"  - STT: {stt_result['transcribe_elapsed_seconds']}초")
    print(f"  - 구조화: {meta.get('structure_elapsed_seconds', 'N/A')}초")
    if meta.get("input_tokens") and meta.get("output_tokens"):
        print(
            f"[구조화 토큰] 입력 {meta['input_tokens']} / "
            f"출력 {meta['output_tokens']}"
        )
    print(f"[결과 파일 4개]")
    print(f"   - {transcript_path.name}        (변환 텍스트)")
    print(f"   - {result_json_path.name}       (STT 메타데이터)")
    print(f"   - {structured_path.name}        (구조화 JSON)")
    print(f"   - {report_path.name}            (마크다운 리포트)")
    print("=" * 60)
    print()
    print("[다음 단계]")
    print(f"  1. {report_path.name} 열어서 두 트랙 타임라인 검토")
    print(f"  2. evaluation_checklist.md 기준으로 정확도 채점")
    print(f"  3. 품질 미흡 시 → MEDICAL_DOMAIN_PROMPT 또는 STRUCTURING_SYSTEM_PROMPT 튜닝")


if __name__ == "__main__":
    main()
