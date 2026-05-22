"""
structure.py — 구급 음성 자동 기록 시스템 (Phase 0)

transcribe.py 가 만든 텍스트(또는 임의의 transcript)를 받아
OpenAI gpt-4o 로 두 트랙 통합 타임라인 + SAMPLE/OPQRST + 품질 평가까지
한 번에 구조화하여 JSON / Markdown 으로 저장합니다.

사용법:
    python structure.py scenario_level1_transcript.txt
    python structure.py scenario_level1_result.json

    # 옵션: 모델 변경 (기본 gpt-4o)
    python structure.py scenario_level1_transcript.txt --model gpt-4o-mini

출력 (같은 폴더, 같은 이름):
    {파일명}_structured.json  — 구조화된 데이터 (재현·기록용)
    {파일명}_report.md        — 사람이 읽기 좋은 리포트

설계 메모:
    - response_format={"type": "json_object"} 로 JSON 강제
    - temperature=0.2 (환각 최소화, 일관성 확보)
    - 모델이 임의로 키를 만들지 않도록 시스템 프롬프트에서 스키마 명시
    - JSON 받은 후 코드에서 Markdown 변환 (사람이 읽을 검증용)
"""

import argparse
import json
import os
import sys
import time
from pathlib import Path

from dotenv import load_dotenv
from openai import OpenAI


# 구조화 시스템 프롬프트.
# JSON 모드와 함께 사용하기 때문에 "JSON" 단어가 반드시 들어가야 함 (OpenAI 요구사항).
STRUCTURING_SYSTEM_PROMPT = """\
당신은 119 구급 출동 음성 변환 텍스트를 분석하여 구급일지에 들어갈 형태로
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
- 결과는 반드시 위 스키마에 맞는 유효한 JSON 객체"""


def load_transcript(input_path: Path) -> tuple[str, dict | None]:
    """입력 파일에서 transcript 텍스트를 추출.

    .txt    → 그대로 텍스트로 읽음
    .json   → transcribe.py 결과 형식 가정, 'transcript' 키 추출
    """
    if not input_path.exists():
        raise FileNotFoundError(f"입력 파일을 찾을 수 없습니다: {input_path}")

    if input_path.suffix.lower() == ".json":
        data = json.loads(input_path.read_text(encoding="utf-8"))
        transcript = data.get("transcript")
        if not transcript:
            raise ValueError(
                f"JSON 파일에 'transcript' 키가 없습니다: {input_path}\n"
                "transcribe.py가 만든 _result.json 형식이어야 합니다."
            )
        return transcript, data

    if input_path.suffix.lower() == ".txt":
        return input_path.read_text(encoding="utf-8"), None

    raise ValueError(
        f"지원하지 않는 파일 형식입니다: {input_path.suffix}\n"
        ".txt 또는 .json (transcribe.py 결과) 만 지원합니다."
    )


def structure_transcript(transcript: str, model: str = "gpt-4o") -> dict:
    """transcript 텍스트를 LLM으로 구조화."""
    client = OpenAI()

    print(f"[INFO] 구조화 시작: 모델 {model}, 텍스트 길이 {len(transcript)}자")
    start_time = time.time()

    response = client.chat.completions.create(
        model=model,
        messages=[
            {"role": "system", "content": STRUCTURING_SYSTEM_PROMPT},
            {
                "role": "user",
                "content": (
                    "다음 음성 변환 텍스트를 시스템 프롬프트의 스키마대로 "
                    "구조화하여 JSON으로만 응답하세요.\n\n"
                    f"[원본 텍스트]\n{transcript}"
                ),
            },
        ],
        response_format={"type": "json_object"},
        temperature=0.2,
    )

    elapsed = time.time() - start_time
    structured_text = response.choices[0].message.content

    try:
        structured = json.loads(structured_text)
    except json.JSONDecodeError as e:
        raise ValueError(
            f"모델이 유효하지 않은 JSON을 반환했습니다: {e}\n"
            f"원본 응답:\n{structured_text}"
        )

    # 메타 정보 부착
    structured["_meta"] = {
        "model": model,
        "structure_elapsed_seconds": round(elapsed, 2),
        "transcript_length": len(transcript),
        "input_tokens": response.usage.prompt_tokens if response.usage else None,
        "output_tokens": response.usage.completion_tokens if response.usage else None,
        "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
    }

    return structured


def to_markdown(structured: dict, source_name: str) -> str:
    """구조화된 데이터를 사람이 읽을 마크다운 리포트로 변환."""
    md = []
    md.append(f"# 🚒 구급 출동 구조화 리포트")
    md.append(f"")
    md.append(f"- **원본:** `{source_name}`")
    meta = structured.get("_meta", {})
    if meta:
        md.append(f"- **모델:** {meta.get('model', 'N/A')}")
        md.append(f"- **구조화 소요:** {meta.get('structure_elapsed_seconds', 'N/A')}초")
        md.append(f"- **생성 시각:** {meta.get('timestamp', 'N/A')}")
    md.append("")

    # 1. 통합 타임라인
    md.append("## 1. 통합 타임라인")
    md.append("")
    md.append("| 시간 | 구분 | 주체 | 내용 |")
    md.append("|------|------|------|------|")
    for ev in structured.get("integrated_timeline", []):
        time_val = ev.get("time") or "-"
        type_val = ev.get("type") or "-"
        actor_val = ev.get("actor") or "-"
        content_val = (ev.get("content") or "").replace("|", "\\|")
        md.append(f"| {time_val} | {type_val} | {actor_val} | {content_val} |")
    md.append("")

    # 2. 환자 발화 트랙
    md.append("## 2. 환자 발화 트랙")
    md.append("")
    speeches = structured.get("patient_speech_track", [])
    if not speeches:
        md.append("_(추출된 발화 없음)_")
    else:
        for sp in speeches:
            t = sp.get("time") or "시간미상"
            speaker = sp.get("speaker") or "?"
            tags = sp.get("tags") or []
            tags_str = f" [{', '.join(tags)}]" if tags else ""
            content = sp.get("content") or ""
            md.append(f"- **{t} · {speaker}**{tags_str}: {content}")
    md.append("")

    # 3. 처치 트랙
    md.append("## 3. 처치 트랙")
    md.append("")
    treatments = structured.get("treatment_track", [])
    if not treatments:
        md.append("_(추출된 처치 없음)_")
    else:
        for tr in treatments:
            t = tr.get("time") or "시간미상"
            cat = tr.get("category") or "?"
            content = tr.get("content") or ""
            md.append(f"- **{t} · {cat}**: {content}")
            details = tr.get("details") or {}
            detail_pieces = []
            if details.get("bp"):
                detail_pieces.append(f"BP {details['bp']}")
            if details.get("hr") is not None:
                detail_pieces.append(f"HR {details['hr']}")
            if details.get("rr") is not None:
                detail_pieces.append(f"RR {details['rr']}")
            if details.get("spo2") is not None:
                detail_pieces.append(f"SpO2 {details['spo2']}")
            if details.get("temp") is not None:
                detail_pieces.append(f"T {details['temp']}")
            if details.get("bst") is not None:
                detail_pieces.append(f"BST {details['bst']}")
            if details.get("ams"):
                detail_pieces.append(f"AVPU {details['ams']}")
            if details.get("gcs") is not None:
                detail_pieces.append(f"GCS {details['gcs']}")
            if details.get("medication_name"):
                dose = details.get("medication_dose") or ""
                detail_pieces.append(f"약물 {details['medication_name']} {dose}".strip())
            if details.get("procedure_name"):
                detail_pieces.append(f"술기 {details['procedure_name']}")
            if detail_pieces:
                md.append(f"  - {' / '.join(detail_pieces)}")
    md.append("")

    # 4. SAMPLE
    md.append("## 4. SAMPLE 추출")
    md.append("")
    sample = structured.get("sample") or {}
    labels = {
        "S": "S (증상)",
        "A": "A (알레르기)",
        "M": "M (약물)",
        "P": "P (과거력)",
        "L": "L (마지막식사)",
        "E": "E (사건경위)",
    }
    for key, label in labels.items():
        val = sample.get(key) or "_(추출 없음)_"
        md.append(f"- **{label}**: {val}")
    md.append("")

    # 5. OPQRST
    md.append("## 5. OPQRST 추출")
    md.append("")
    opqrst = structured.get("opqrst") or {}
    op_labels = {
        "O": "O (발병)",
        "P": "P (악화/완화요인)",
        "Q": "Q (양상)",
        "R": "R (방사)",
        "S": "S (강도)",
        "T": "T (시간경과)",
    }
    for key, label in op_labels.items():
        val = opqrst.get(key) or "_(추출 없음)_"
        md.append(f"- **{label}**: {val}")
    md.append("")

    # 6. 구급일지 핵심 요약
    md.append("## 6. 구급일지 핵심 요약")
    md.append("")
    report = structured.get("report") or {}
    md.append(f"- **주증상**: {report.get('chief_complaint') or '_(미상)_'}")
    md.append(f"- **의식수준**: {report.get('consciousness') or '_(미상)_'}")
    md.append(f"- **이송 병원**: {report.get('hospital') or '_(미상)_'}")
    md.append(f"- **인계 사항**: {report.get('handover') or '_(미상)_'}")
    md.append("")

    # 7. 품질 평가
    md.append("## 7. 변환 품질 평가")
    md.append("")
    qa = structured.get("quality_assessment") or {}
    md.append("**환각 의심 구간:**")
    halls = qa.get("hallucination_suspected") or []
    if halls:
        for item in halls:
            md.append(f"- {item}")
    else:
        md.append("- _(없음)_")
    md.append("")
    md.append("**누락 의심 구간:**")
    oms = qa.get("omission_suspected") or []
    if oms:
        for item in oms:
            md.append(f"- {item}")
    else:
        md.append("- _(없음)_")
    md.append("")
    md.append("**의료용어 인식 오류:**")
    errs = qa.get("terminology_errors") or []
    if errs:
        for item in errs:
            md.append(f"- {item}")
    else:
        md.append("- _(없음)_")
    md.append("")
    md.append("**기타 메모:**")
    notes = qa.get("notes") or []
    if notes:
        for item in notes:
            md.append(f"- {item}")
    else:
        md.append("- _(없음)_")
    md.append("")

    return "\n".join(md)


def save_results(input_path: Path, structured: dict, markdown: str):
    """structured.json + report.md 저장."""
    # 입력이 *_transcript.txt 또는 *_result.json 이면 suffix를 적절히 처리
    stem = input_path.stem
    for suffix in ["_transcript", "_result"]:
        if stem.endswith(suffix):
            stem = stem[: -len(suffix)]
            break
    base = input_path.parent / stem

    structured_path = Path(f"{base}_structured.json")
    report_path = Path(f"{base}_report.md")

    structured_path.write_text(
        json.dumps(structured, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    report_path.write_text(markdown, encoding="utf-8")
    return structured_path, report_path


def main():
    parser = argparse.ArgumentParser(
        description="transcript 텍스트를 두 트랙 통합 타임라인으로 구조화"
    )
    parser.add_argument(
        "input",
        help="입력 파일 (*.txt 또는 transcribe.py가 만든 *_result.json)",
    )
    parser.add_argument(
        "--model",
        default="gpt-4o",
        help="OpenAI 모델 (기본: gpt-4o)",
    )
    args = parser.parse_args()

    load_dotenv()
    if not os.getenv("OPENAI_API_KEY"):
        print("[ERROR] OPENAI_API_KEY가 설정되지 않았습니다.")
        print("        .env.example을 .env로 복사하고 본인 API 키를 입력하세요.")
        sys.exit(1)

    input_path = Path(args.input)

    try:
        transcript, _ = load_transcript(input_path)
        if not transcript.strip():
            print("[ERROR] transcript가 비어 있습니다.")
            sys.exit(1)

        structured = structure_transcript(transcript, model=args.model)
        markdown = to_markdown(structured, source_name=input_path.name)
        structured_path, report_path = save_results(input_path, structured, markdown)

        meta = structured.get("_meta", {})
        print()
        print("=" * 60)
        print(f"[완료] 구조화 소요 시간: {meta.get('structure_elapsed_seconds', 'N/A')}초")
        if meta.get("input_tokens") and meta.get("output_tokens"):
            print(
                f"[토큰] 입력 {meta['input_tokens']} / 출력 {meta['output_tokens']}"
            )
        print(f"[결과 파일]")
        print(f"   - {structured_path.name}  (JSON, 기록·재현용)")
        print(f"   - {report_path.name}  (Markdown, 사람이 읽기용)")
        print("=" * 60)
        print()
        print("[다음 단계]")
        print(f"  1. {report_path.name} 열어서 두 트랙 타임라인 검토")
        print(f"  2. 품질 평가 섹션에서 환각/누락/인식오류 확인")
        print(f"  3. evaluation_checklist.md 기준으로 정확도 채점")

    except FileNotFoundError as e:
        print(f"[ERROR] {e}")
        sys.exit(1)
    except Exception as e:
        print(f"[ERROR] 구조화 실패: {type(e).__name__}: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
